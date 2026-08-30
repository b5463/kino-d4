#include "buttons.h"

#include "board_d4v1.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "hardware_validation.h"
#include "taskmon.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "klog.h"
#include "power.h"

static const char *TAG = "buttons";

/* Long enough to reject contact bounce, short enough that a deliberate press
 * still feels immediate. A cheap tactile switch settles well inside this. */
#define DEBOUNCE_MS 25
/* Held longer than this and the press is reported as a long one. */
#define LONG_PRESS_MS 600
#define POLL_MS 15

typedef struct {
  int pin;
  const char *name;
  bool level_when_pressed; /* false for the usual switch-to-ground wiring */
  bool stable;             /* debounced state */
  bool raw;
  int64_t changed_us;
  int64_t pressed_us;
  bool long_fired;
} button_t;

static button_t s_btn[BTN_COUNT] = {
    {BOARD_BTN_SHUTTER, "shutter", false, false, false, 0, 0, false},
    {BOARD_BTN_FN, "fn", false, false, false, 0, 0, false},
};

static button_handler_t s_handler;
static bool s_fitted;
/* One NVS write, not one per press. hwv_mark_validated returns early on an
 * already-validated row, but only after taking its mutex, and this flag keeps
 * the whole thing out of the poll loop for good after the first press. */
static bool s_shutter_marked;

bool buttons_fitted(void) { return s_fitted; }
void buttons_on_press(button_handler_t handler) { s_handler = handler; }

bool button_held(button_id_t id) {
  return id < BTN_COUNT && s_btn[id].pin != BOARD_BTN_NONE && s_btn[id].stable;
}

static void buttons_task(void *arg) {
  (void)arg;
  for (;;) {
    const int64_t now = esp_timer_get_time();
    for (int i = 0; i < BTN_COUNT; i++) {
      button_t *b = &s_btn[i];
      if (b->pin == BOARD_BTN_NONE) continue;

      const bool raw = gpio_get_level(b->pin) == (b->level_when_pressed ? 1 : 0);
      if (raw != b->raw) {
        b->raw = raw;
        b->changed_us = now;
        continue; /* still bouncing */
      }
      if (raw == b->stable) continue;
      if ((now - b->changed_us) / 1000 < DEBOUNCE_MS) continue;

      b->stable = raw;
      if (raw) {
        b->pressed_us = now;
        b->long_fired = false;
        /* A press is activity even when the screen is dark, and it wakes the
         * panel — but unlike a touch it is NOT swallowed. Someone pressing a
         * physical shutter means to take a picture, whether or not they can
         * see the screen; a touch on dark glass means nothing in particular. */
        power_activity();
        klog("P4", "%s pressed", b->name);
        /*
         * The shutter row, earned once. A debounced low on GPIO28 that held
         * for 25 ms is the switch on JP1 21 doing its job — the pull-up is
         * internal, so nothing else on the board can produce that edge.
         *
         * Before the handler, not after, and once per device. hwv_mark_validated
         * writes NVS, and an ESP-IDF flash write runs
         * spi_flash_disable_interrupts_caches_and_other_cpu(): interrupts on
         * both cores are off for 0.5-0.8 ms on a page write and 30-45 ms on a
         * sector erase, which is long enough to eat bytes out of a camera
         * transfer (capture.c says the same thing at its own marks). At this
         * point the press has not reached the handler, so no capture has been
         * requested and nothing is on the UARTs. The cost is up to ~45 ms of
         * extra latency on the first shutter press this unit ever sees.
         */
        if (i == BTN_SHUTTER && !s_shutter_marked) {
          s_shutter_marked = true;
          hwv_mark_validated(HWV_BTN_SHUTTER, "GPIO28 pressed on JP1 21");
        }
        if (s_handler) s_handler((button_id_t)i, false);
      } else if (!b->long_fired) {
        /* released before the long-press threshold: nothing more to do */
      }
    }

    /* Long press is reported while the button is still down, so holding the
     * shutter can start something rather than only finishing it. */
    for (int i = 0; i < BTN_COUNT; i++) {
      button_t *b = &s_btn[i];
      if (b->pin == BOARD_BTN_NONE || !b->stable || b->long_fired) continue;
      if ((now - b->pressed_us) / 1000 >= LONG_PRESS_MS) {
        b->long_fired = true;
        klog("P4", "%s held", b->name);
        if (s_handler) s_handler((button_id_t)i, true);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(POLL_MS));
  }
}

esp_err_t buttons_init(void) {
  uint64_t mask = 0;
  for (int i = 0; i < BTN_COUNT; i++) {
    if (s_btn[i].pin != BOARD_BTN_NONE) mask |= 1ULL << s_btn[i].pin;
  }
  if (mask == 0) {
    /* Nothing fitted. Said out loud, because "the shutter button does
     * nothing" and "there is no shutter button pin yet" look identical from
     * the outside and only one of them is a fault. */
    ESP_LOGW(TAG, "no button pins assigned in board_d4v1.h - physical controls inactive");
    return ESP_OK;
  }

  gpio_config_t cfg = {
      .pin_bit_mask = mask,
      .mode = GPIO_MODE_INPUT,
      /* Pulled up, switch to ground: the idle state is then driven rather
       * than floating, so an unpressed button cannot read as pressed. */
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  const esp_err_t err = gpio_config(&cfg);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "gpio config failed: %s", esp_err_to_name(err));
    return err;
  }

  s_fitted = true;
  for (int i = 0; i < BTN_COUNT; i++) {
    if (s_btn[i].pin != BOARD_BTN_NONE)
      ESP_LOGI(TAG, "%s on GPIO%d, active low, %d ms debounce", s_btn[i].name, s_btn[i].pin,
               DEBOUNCE_MS);
  }
  TaskHandle_t h = NULL;
  /* Checked: without this task the pins are configured and nothing ever polls
   * them, so a fitted shutter button is dead and buttons_init() said it was
   * fine. s_fitted is cleared again so buttons_fitted() reports the truth. */
  /* 4096, not 3072: the task now calls hwv_mark_validated on the first shutter
   * press, which opens an NVS handle and writes a string. Every other task
   * that marks runs on 4096 or more. */
  if (xTaskCreate(buttons_task, "buttons", 4096, NULL, 5, &h) != pdPASS) {
    ESP_LOGE(TAG, "buttons task would not start: no heap; physical controls inactive");
    s_fitted = false;
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("buttons", h);
  return ESP_OK;
}
