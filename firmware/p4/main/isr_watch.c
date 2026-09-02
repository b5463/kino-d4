#include "isr_watch.h"

#include <string.h>

#include "driver/gptimer.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

/* The handler below is deliberately in flash. With this option the driver
 * refuses a non-IRAM callback (ESP_ERR_INVALID_ARG) and the watch would
 * silently stop measuring; an IRAM handler would measure the wrong thing. */
#ifdef CONFIG_GPTIMER_ISR_IRAM_SAFE
#error "isr_watch measures the flash-resident ISR's fate; CONFIG_GPTIMER_ISR_IRAM_SAFE defeats it"
#endif

typedef struct {
  int64_t at_us;
  uint32_t gap_us;
  TaskHandle_t core0;
  TaskHandle_t core1;
} slot_t;

static gptimer_handle_t s_timer;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static int64_t s_last_us;
static slot_t s_slot[ISR_WATCH_SLOTS];
static int s_count;
static uint32_t s_dropped;
static uint32_t s_total;

/* Not IRAM_ATTR, and the gptimer driver is not built IRAM-safe either, on
 * purpose: this handler has to be held off by the same things that hold the
 * UART ISR off, or it measures nothing. */
static bool on_alarm(gptimer_handle_t timer, const gptimer_alarm_event_data_t *edata,
                     void *user) {
  (void)timer;
  (void)edata;
  (void)user;
  const int64_t now = esp_timer_get_time();
  const int64_t last = s_last_us;
  s_last_us = now;
  if (last == 0) return false;
  const int64_t gap = now - last;
  if (gap <= ISR_WATCH_GAP_US) return false;

  portENTER_CRITICAL_ISR(&s_mux);
  s_total++;
  if (s_count < ISR_WATCH_SLOTS) {
    slot_t *s = &s_slot[s_count++];
    s->at_us = now;
    s->gap_us = (uint32_t)gap;
    s->core0 = xTaskGetCurrentTaskHandleForCore(0);
    s->core1 = xTaskGetCurrentTaskHandleForCore(1);
  } else {
    s_dropped++;
  }
  portEXIT_CRITICAL_ISR(&s_mux);
  return false;
}

esp_err_t isr_watch_init(void) {
  if (s_timer != NULL) return ESP_OK;
  const gptimer_config_t cfg = {
      .clk_src = GPTIMER_CLK_SRC_DEFAULT,
      .direction = GPTIMER_COUNT_UP,
      .resolution_hz = 1000000,
  };
  esp_err_t err = gptimer_new_timer(&cfg, &s_timer);
  if (err != ESP_OK) return err;
  const gptimer_event_callbacks_t cbs = {.on_alarm = on_alarm};
  err = gptimer_register_event_callbacks(s_timer, &cbs, NULL);
  if (err == ESP_OK) {
    const gptimer_alarm_config_t alarm = {
        .alarm_count = 1000,
        .reload_count = 0,
        .flags.auto_reload_on_alarm = true,
    };
    err = gptimer_set_alarm_action(s_timer, &alarm);
  }
  if (err == ESP_OK) err = gptimer_enable(s_timer);
  if (err == ESP_OK) err = gptimer_start(s_timer);
  if (err != ESP_OK) {
    gptimer_del_timer(s_timer);
    s_timer = NULL;
  }
  return err;
}

int isr_watch_take(isr_watch_gap_t *out, int cap, uint32_t *dropped) {
  slot_t local[ISR_WATCH_SLOTS];
  int n;
  uint32_t over;
  if (out == NULL || cap < 0) cap = 0;
  portENTER_CRITICAL(&s_mux);
  n = s_count;
  memcpy(local, s_slot, sizeof local);
  over = s_dropped;
  s_count = 0;
  s_dropped = 0;
  portEXIT_CRITICAL(&s_mux);

  /* Gaps the caller has no room for are dropped too, and counted as such. */
  if (n > cap) {
    over += (uint32_t)(n - cap);
    n = cap;
  }
  if (dropped != NULL) *dropped = over;
  for (int i = 0; i < n; i++) {
    out[i].at_us = local[i].at_us;
    out[i].gap_us = local[i].gap_us;
    /* Resolved here, in task context, from handles the ISR stored: every task
     * this firmware creates lives for the boot, so a stale handle is not a
     * concern this side of a reboot. */
    const char *n0 = local[i].core0 != NULL ? pcTaskGetName(local[i].core0) : "?";
    const char *n1 = local[i].core1 != NULL ? pcTaskGetName(local[i].core1) : "?";
    strlcpy(out[i].core0, n0 != NULL ? n0 : "?", sizeof out[i].core0);
    strlcpy(out[i].core1, n1 != NULL ? n1 : "?", sizeof out[i].core1);
  }
  return n;
}

uint32_t isr_watch_total(void) { return s_total; }
