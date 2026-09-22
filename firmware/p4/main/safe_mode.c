#include "safe_mode.h"

#include "esp_system.h"
#include "esp_timer.h"
#include "klog.h"
#include "nvs.h"

/* Crashes in a row before the radio and the uploads stay off. */
#define SAFE_MODE_AFTER 3
/* Up this long counts as a healthy boot and clears the count. Longer than
 * anything the boot does on a timer: the C6 recovery, the first upload, the
 * first calibration. */
#define SAFE_MODE_HEALTHY_MS 180000

static bool s_active;
static int s_crashes;
static bool s_brownout;

static void write_count(uint32_t n) {
  nvs_handle_t nvs;
  if (nvs_open("kino", NVS_READWRITE, &nvs) != ESP_OK) return;
  nvs_set_u32(nvs, "crashes", n);
  nvs_commit(nvs);
  nvs_close(nvs);
}

static void healthy_cb(void *arg) {
  (void)arg;
  write_count(0);
  klog("P4", "up %d s after %d crash%s: count cleared", SAFE_MODE_HEALTHY_MS / 1000, s_crashes,
       s_crashes == 1 ? "" : "es");
}

void safe_mode_boot(void) {
  const esp_reset_reason_t why = esp_reset_reason();
  const bool crash = why == ESP_RST_PANIC || why == ESP_RST_INT_WDT || why == ESP_RST_TASK_WDT ||
                     why == ESP_RST_WDT;
  /* Not a crash: the supply fell out from under a running body. The cells
   * are the only thing a person can do something about, so it is said. */
  s_brownout = why == ESP_RST_BROWNOUT;
  if (s_brownout) klog("P4", "boot after a brownout: the supply dropped while running");
  uint32_t n = 0;
  nvs_handle_t nvs;
  if (nvs_open("kino", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_get_u32(nvs, "crashes", &n);
    nvs_close(nvs);
  }
  if (crash) {
    n++;
    write_count(n);
  } else if (n != 0) {
    n = 0;
    write_count(0);
  }
  s_crashes = (int)n;
  s_active = n >= SAFE_MODE_AFTER;
  if (crash) {
    klog("P4", "boot after a crash, %d in a row%s", (int)n,
         s_active ? "; safe mode: no radio, no uploads" : "");
  }
  if (n > 0) {
    const esp_timer_create_args_t args = {.callback = healthy_cb, .name = "healthy"};
    esp_timer_handle_t t = NULL;
    if (esp_timer_create(&args, &t) == ESP_OK) {
      esp_timer_start_once(t, (uint64_t)SAFE_MODE_HEALTHY_MS * 1000);
    }
  }
}

bool safe_mode_active(void) { return s_active; }
bool safe_mode_brownout(void) { return s_brownout; }
int safe_mode_crashes(void) { return s_crashes; }
