#include "lid.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "klog.h"
#include "power.h"
#include "pure.h"
#include "taskmon.h"
#include "viewfinder.h"

static const char *TAG = "lid";

/*
 * How often the tiles are sampled.
 *
 * Sampling is a strided read over memory the viewfinder already produced, so
 * the rate is set by how fast the dwells in pure.h should resolve rather than
 * by what it costs. At 250 ms the 1500 ms close dwell settles in seven samples
 * and the 300 ms open dwell in two.
 */
#define LID_POLL_MS 250

/*
 * Older than this and a tile is not evidence about now.
 *
 * A stalled pane keeps handing back its last good frame, so without this a
 * frozen picture of a lit room would hold the state open with the cover down -
 * which is the one direction that must never be got wrong by inertia.
 */
#define LID_FRAME_MAX_AGE_MS 1500

/* How often the readings themselves go in the log while the thresholds are
 * still being calibrated. Four seconds is fast enough to catch a cover going
 * on and off at the bench without evicting the rest of a 200-entry ring. */
#define LID_LOG_EVERY (4000 / LID_POLL_MS)

static pure_lid_t s_lid;
static lid_state_t s_pub;
static bool s_acting; /* false: observe and log, change nothing. See lid.h. */
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

/*
 * Mean luminance of one viewfinder tile, 0..255, or -1 for "that camera did
 * not answer" - which is what pure_lid_update expects for a camera it should
 * leave out of the vote entirely.
 *
 * The green channel stands in for luminance. It carries about 59% of it, and
 * in RGB565 it is the channel with the extra bit, so it is both the closest
 * single channel and the most precise one. A proper weighted sum would cost
 * three shifts and two multiplies per sample to move a threshold that has to
 * be measured on the bench regardless.
 *
 * Every eighth pixel in each direction: 1200 samples out of 76800. The
 * quantity being measured is a whole-frame average, and 1200 samples of it is
 * already far past the precision the thresholds are quoted to.
 */
static int tile_mean(int cam) {
  vf_status_t st;
  viewfinder_status(cam, &st);
  if (st.state != VF_LIVE || st.last_ms > LID_FRAME_MAX_AGE_MS) return -1;
  const uint16_t *px = viewfinder_tile(cam);
  if (px == NULL) return -1;

  uint32_t sum = 0, n = 0;
  for (int y = 0; y < VF_H; y += 8) {
    const uint16_t *row = px + (size_t)y * VF_W;
    for (int x = 0; x < VF_W; x += 8) {
      sum += (uint32_t)((row[x] >> 5) & 0x3Fu); /* green, 0..63 */
      n++;
    }
  }
  if (n == 0) return -1;
  return (int)((sum * 255u) / (n * 63u));
}

static void lid_task(void *arg) {
  (void)arg;
  uint32_t since_log = 0;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(LID_POLL_MS));

    int means[PURE_LID_CAMS];
    for (int c = 0; c < PURE_LID_CAMS; c++) means[c] = tile_mean(c);

    const int before = s_lid.state;
    const int now = pure_lid_update(&s_lid, means, PURE_LID_CAMS, LID_POLL_MS);

    taskENTER_CRITICAL(&s_mux);
    s_pub.state = now;
    for (int c = 0; c < PURE_LID_CAMS; c++) s_pub.mean[c] = means[c];
    s_pub.answered = s_lid.answered;
    taskEXIT_CRITICAL(&s_mux);

    if (now != before) {
      if (now == PURE_LID_CLOSED) {
        s_pub.closes++;
        klog("P4", "lens cover closed (%d %d %d %d)%s", means[0], means[1], means[2], means[3],
             s_acting ? "" : ", observing only");
        ESP_LOGI(TAG, "cover closed");
        if (s_acting) {
          /* Ask for sleep rather than performing it: power.c owns the panel,
           * the stage and the race against a finger arriving in the same pass,
           * and there is no reason for a second module to learn any of that. */
          power_sleep_now();
          s_pub.slept++;
        }
      } else if (now == PURE_LID_OPEN) {
        s_pub.opens++;
        klog("P4", "lens cover open (%d %d %d %d)%s", means[0], means[1], means[2], means[3],
             s_acting ? "" : ", observing only");
        ESP_LOGI(TAG, "cover open");
        if (s_acting) power_activity();
      }
    }

    /* The chatty half is the calibration half: while nothing is acting on this
     * signal, put the numbers somewhere a person can read them, because the
     * two thresholds cannot be worked out any other way. Once acting is on,
     * only the edges are logged. */
    if (!s_acting && ++since_log >= LID_LOG_EVERY) {
      since_log = 0;
      if (s_lid.answered > 0) {
        klog("P4", "lid %s (%d %d %d %d), %d of %d answering",
             pure_lid_state_name(now), means[0], means[1], means[2], means[3], s_lid.answered,
             PURE_LID_CAMS);
      }
    }
  }
}

esp_err_t lid_init(void) {
  memset(&s_lid, 0, sizeof s_lid);
  memset(&s_pub, 0, sizeof s_pub);
  s_pub.state = PURE_LID_UNKNOWN;
  for (int c = 0; c < PURE_LID_CAMS; c++) s_pub.mean[c] = -1;

  TaskHandle_t h = NULL;
  /* 4096 for the same reason the power task carries it: klog's vsnprintf on
   * the smallest stack in the system is how you find out about a canary abort
   * by watching the camera reboot. */
  if (xTaskCreate(lid_task, "lid", 4096, NULL, 2, &h) != pdPASS) {
    ESP_LOGE(TAG, "lid task would not start: no heap; the cover will not be watched");
    klog("P4", "lid task failed to start");
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("lid", h);
  ESP_LOGI(TAG, "LID_READY dark<=%d lit>=%d, %d of %d cameras must agree, acting %s",
           PURE_LID_DARK, PURE_LID_LIT, PURE_LID_MIN_CAMS, PURE_LID_CAMS,
           s_acting ? "on" : "off (thresholds not measured)");
  return ESP_OK;
}

void lid_set_acting(bool on) {
  if (s_acting == on) return;
  s_acting = on;
  klog("P4", "lid detection %s", on ? "acting" : "observing only");
}

bool lid_acting(void) { return s_acting; }

void lid_get(lid_state_t *out) {
  if (out == NULL) return;
  taskENTER_CRITICAL(&s_mux);
  *out = s_pub;
  taskEXIT_CRITICAL(&s_mux);
}
