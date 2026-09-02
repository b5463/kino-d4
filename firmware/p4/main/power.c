#include "power.h"

#include "board_d4v1.h"
#include "config_store.h"
#include "display.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "klog.h"
#include "taskmon.h"
#include "usb_link.h"

static const char *TAG = "power";

static volatile int64_t s_last_activity;
/* Bumped on every activity. power_task samples it before deciding and checks
 * it again before acting - see the note in power_task. */
static volatile uint32_t s_activity_seq;
static power_stage_t s_stage = POWER_AWAKE;
static bool s_cam_bank = true;
static bool s_ready;

static volatile bool s_wake_gesture;

bool power_wake_gesture(void) { return s_wake_gesture; }
void power_end_wake_gesture(void) { s_wake_gesture = false; }

/**
 * Drive the backlight, with or without a working panel.
 *
 * power_init() no longer waits for display_init() to succeed, so this can run
 * on a unit whose panel never came up. That is safe and deliberate:
 * display_backlight() configures and sets BOARD_LCD_BACKLIGHT and touches
 * neither the panel handle nor s_ready, so it is a GPIO write that does not
 * care whether anything is drawable.
 *
 * Gating this on display_ready() would be actively wrong rather than merely
 * cautious: on a panel-failed unit it would leave the backlight latched on
 * for the life of the battery, which is the opposite of what a power manager
 * is for. The stage is still tracked and reported either way, so the failure
 * is visible in GET_POWER_STATUS instead of being silently absorbed.
 */
static void backlight(bool on) { display_backlight(on); }

/**
 * Report activity, and wake here rather than leaving it to the housekeeping
 * task.
 *
 * Resetting the idle clock and letting power_task notice on its next 500 ms
 * pass made waking take up to half a second and put the decision in a
 * different task from the one that saw the touch. Doing it on the spot makes
 * the screen come back on the same 15 ms poll that felt the finger.
 */
void power_activity(void) {
  const power_stage_t was = s_stage;
  s_last_activity = esp_timer_get_time();
  s_activity_seq++;
  if (was == POWER_AWAKE) return;

  backlight(true);
  s_stage = POWER_AWAKE;

  /* Only a screen that was actually DARK swallows the press that woke it.
   *
   * This used to fire for DIM as well, on the reasonable-sounding grounds
   * that DIM is "not awake". On this board it is: the backlight is a plain
   * GPIO with no PWM, so dim and awake are the same pixels and the same
   * brightness - the stage is tracked and reported, and changes nothing you
   * can see. A person looking at a dim screen is looking at a perfectly
   * readable one, and throwing away their press is not protecting them from
   * anything. It is just losing input.
   *
   * The symptom was thirty seconds of autoDimS turning the next tap into
   * nothing, on a screen that was lit the whole time - which reads exactly
   * like a camera that has stopped responding, and is why this looked like a
   * sleep bug when sleep had nothing to do with it. */
  if (was == POWER_ASLEEP) {
    s_wake_gesture = true;
    ESP_LOGI(TAG, "woke from sleep");
    klog("P4", "woke from sleep");
  }
}

void power_wake(void) { power_activity(); }

void power_get(power_state_t *out) {
  if (out == NULL) return;
  const int64_t idle_us = esp_timer_get_time() - s_last_activity;
  out->stage = s_stage;
  out->idle_s = (uint32_t)(idle_us / 1000000);
  out->display_on = s_stage != POWER_ASLEEP;
  out->cam_bank_on = s_cam_bank;
  /* The only rail fact this board can establish: whether a USB host has
   * enumerated us. It does not distinguish USB power from battery power -
   * the SW6106 feeds the same 5 V rail either way - so it is reported as
   * "a host is attached", not as "running on USB". */
  out->usb_attached = usb_link_connected();
}

/* The camera bank's power switch. Held on until camIdleTimeoutS elapses,
 * which is what makes four idle XIAOs stop costing the battery anything.
 *
 * BOARD_CAM_PWR_EN is GPIO31 on JP1 pin 10 (board_d4v1.h, ECN-0002). This
 * comment said the line was BOARD_GPIO_NONE and that no GPIO was touched;
 * that was true of the pin map before the header was measured, and it is not
 * true now - the idle path below really does drop the rail on a wired unit.
 *
 * s_cam_pwr_ready still gates the write, because the pin is only configured
 * if power_init()'s gpio_config succeeded, and a build whose board header
 * leaves the line unassigned has to keep working. Whether every channel hangs
 * off this one line or each gets its own is still an M2 question. */
static bool s_cam_pwr_ready;

static void cam_bank(bool on) {
  if (s_cam_bank == on) return;
  s_cam_bank = on;
  if (s_cam_pwr_ready) {
    gpio_set_level((gpio_num_t)BOARD_CAM_PWR_EN, on ? 1 : 0);
    /* Driving the pin proves nothing about the AO4407 channels downstream;
     * that row is earned on the bench with a meter, not here. */
  }
  ESP_LOGI(TAG, "camera bank %s%s", on ? "on" : "off", s_cam_pwr_ready ? "" : " (no CAM_PWR_EN pin)");
  klog("P4", "cam bank %s", on ? "on" : "off");
}

static void power_task(void *arg) {
  (void)arg;
  for (;;) {
    /* Read the thresholds every pass rather than caching them: Studio can
     * change them at any moment over SET_CONFIG, and a cached copy would mean
     * a setting that only takes effect after a reboot. */
    const int dim_s = config_int("body.autoDimS", 30);
    const int sleep_s = config_int("body.sleepS", 120);
    const int cam_s = config_int("body.camIdleTimeoutS", 300);

    /* Sample the activity counter before deciding anything.
     *
     * Deciding and acting are not one operation, and a touch can land between
     * them. It did: this task would sample a long idle, decide ASLEEP, be
     * preempted by the touch task turning the backlight on and setting the
     * stage to AWAKE, then resume, see that its decision disagreed with the
     * stage, and turn the backlight straight back off. The screen lit up and
     * died again in the same gesture - which is what "touch after sleep does
     * not work" looks like from the outside.
     *
     * If anything happened while we were thinking, this pass is stale: drop it
     * and decide again with the new idle time. */
    const uint32_t seq_before = s_activity_seq;
    const uint32_t idle = (uint32_t)((esp_timer_get_time() - s_last_activity) / 1000000);

    power_stage_t want = POWER_AWAKE;
    if (sleep_s > 0 && idle >= (uint32_t)sleep_s) want = POWER_ASLEEP;
    else if (dim_s > 0 && idle >= (uint32_t)dim_s) want = POWER_DIM;

    if (s_activity_seq != seq_before) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (want != s_stage) {
      /* Dim and awake look the same on this board.
       *
       * The backlight is a plain GPIO, not an LEDC channel - display.c is
       * explicit that driving it as PWM is how you get a dark panel that
       * looks like a dead one. So `brightness` and the dim stage have no
       * hardware to act on, and pretending otherwise would be a setting that
       * silently does nothing. The stage is still tracked and reported, so
       * Studio can show where the timeout has got to, and it is one line to
       * make it real if the backlight ever gets a transistor. */
      if (want == POWER_ASLEEP) {
        backlight(false);
        s_stage = POWER_ASLEEP;
        /* The check above closed the gap between SAMPLING and DECIDING. This
         * closes the one between deciding and ACTING, which is the gap a
         * finger actually lands in: power_activity() runs on the touch task,
         * turns the backlight on and sets AWAKE, and then this task - already
         * committed to sleeping - put it straight back to sleep. The screen
         * lit and died inside one gesture, and the press that did it was
         * swallowed as a wake gesture, so the camera looked deaf.
         *
         * Undoing it here rather than waiting for the next pass matters: the
         * next pass is 500 ms away, which is long enough to feel like the
         * touch was ignored rather than delayed. */
        if (s_activity_seq != seq_before) {
          backlight(true);
          s_stage = POWER_AWAKE;
          ESP_LOGI(TAG, "sleep raced a touch and was undone in the same pass");
          klog("P4", "sleep raced a touch, stayed awake");
          vTaskDelay(pdMS_TO_TICKS(100));
          continue;
        }
      } else {
        if (s_stage == POWER_ASLEEP) backlight(true);
        s_stage = want;
      }
      ESP_LOGI(TAG, "stage %s after %lus idle",
               want == POWER_AWAKE ? "awake" : want == POWER_DIM ? "dim" : "asleep",
               (unsigned long)idle);
    }

    /* This really cuts the camera rail on a wired unit - GPIO31 is routed, so
     * four booted nodes go away here. It is safe to do so because capture.c
     * does not assume the bank is up: cams_powered() calls power_activity(),
     * waits up to a second for this task's next pass to bring the rail back,
     * then pays what is left of the nodes' boot settle before the first frame
     * (capture.c:529-559). So the cost of an idle cut is a slower first press,
     * not a failed capture. */
    if (cam_s > 0) cam_bank(idle < (uint32_t)cam_s);
    else cam_bank(true);

    vTaskDelay(pdMS_TO_TICKS(500));
  }
}

esp_err_t power_init(void) {
  if (s_ready) return ESP_OK;

  /* Through a variable, not the macro: `1ULL << -1` as a constant expression
   * is a compile error even inside a branch that never runs. */
  const int pwr_pin = BOARD_CAM_PWR_EN;
  if (pwr_pin != BOARD_GPIO_NONE) {
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << pwr_pin,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&cfg) == ESP_OK) {
      gpio_set_level((gpio_num_t)pwr_pin, 1);
      s_cam_pwr_ready = true;
    } else {
      ESP_LOGE(TAG, "cannot drive CAM_PWR_EN GPIO%d", pwr_pin);
    }
  } else {
    ESP_LOGW(TAG, "CAM_PWR_EN unassigned: no JP1 pin, camera bank stays powered");
  }
  s_cam_bank = true;

  power_activity();
  s_ready = true;
  ESP_LOGI(TAG, "POWER_READY dim %ds, sleep %ds, cam idle %ds, cam power %s",
           config_int("body.autoDimS", 30), config_int("body.sleepS", 120),
           config_int("body.camIdleTimeoutS", 300),
           s_cam_pwr_ready ? "pin driven" : "unassigned");
  klog("P4", "power up");
  TaskHandle_t h = NULL;
  /* Checked, because power_init() returning ESP_OK with no task behind it is
   * a camera that never dims, never sleeps and never drops the camera rail -
   * on a 3000 mAh cell, and with nothing in the log to say why. */
  /* 4096, up from 3072 - the smallest stack in the system, running config_int()
   * (a cJSON walk) three times a pass plus klog's vsnprintf. The canary abort is
   * an instant reboot; 1 KB of headroom is cheaper than that. */
  if (xTaskCreate(power_task, "power", 4096, NULL, 2, &h) != pdPASS) {
    ESP_LOGE(TAG, "power task would not start: no heap; nothing will dim or sleep");
    klog("P4", "power task failed to start");
    /* s_ready was set above; clear it so a later retry actually retries
     * instead of returning ESP_OK for a manager that does not exist. */
    s_ready = false;
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("power", h);
  return ESP_OK;
}
