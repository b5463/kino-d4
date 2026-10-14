#include "maint.h"

#include <stdint.h>

#include "capture.h"
#include "config_store.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "klog.h"
#include "power.h"
#include "pure.h"

/* How long ENTER_MAINTENANCE waits for a capture or a bench command to let
 * go of the capture lock before it answers INVALID_STATE. Inside the host's
 * 3 s default request timeout with room for the reply. */
#define MAINT_LOCK_WAIT_MS 2000

/*
 * The whole state: a flag, a deadline and a spinlock, about 20 bytes. A
 * spinlock and not a mutex, because maint_exit() runs from two tasks and the
 * test-and-clear has to be one step: two exits must not give the capture
 * lock back twice (capture_unlock() also tells the node scheduler, and its
 * counts would go wrong).
 */
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static volatile bool s_active;
static int64_t s_deadline_us;

bool maint_active(void) { return s_active; }

void maint_touch(void) {
  const int64_t deadline = pure_maint_deadline(esp_timer_get_time());
  taskENTER_CRITICAL(&s_mux);
  const bool active = s_active;
  if (active) s_deadline_us = deadline;
  taskEXIT_CRITICAL(&s_mux);
  /* An update is activity. KDP traffic alone is not (power.c), so without
   * this a body idle past body.camIdleTimeoutS cuts the camera bank under a
   * node mid-image, and the screen sleeps over the UPDATING strip. */
  if (active) power_activity();
}

esp_err_t maint_enter(void) {
  if (s_active) {
    /* Studio's updater re-enters on a retry: same answer, fresh deadline. */
    maint_touch();
    return ESP_OK;
  }
  /* Held until maint_exit(). Binary-semaphore semantics (capture.h), so the
   * UI task's maint_poll() may give it back. A running capture or a bench
   * command keeps it past the wait: the host hears INVALID_STATE. */
  if (!capture_lock(MAINT_LOCK_WAIT_MS)) return ESP_ERR_INVALID_STATE;
  const int64_t deadline = pure_maint_deadline(esp_timer_get_time());
  taskENTER_CRITICAL(&s_mux);
  s_deadline_us = deadline;
  s_active = true; /* the upload worker stops starting work from here */
  taskEXIT_CRITICAL(&s_mux);
  power_activity(); /* the camera bank on, the screen awake: see maint_touch() */
  /* A settings save in flight lands before any flash is erased for the
   * image. Nothing is pending while saves are immediate (config_store.h). */
  const esp_err_t ferr = config_flush(true);
  klog("P4", "maintenance entered: shutter and uploads held, ends by itself after %d s quiet",
       PURE_MAINT_HOLD_MS / 1000);
  if (ferr != ESP_OK) klog("P4", "maintenance: config flush failed (%d)", (int)ferr);
  return ESP_OK;
}

void maint_exit(const char *why) {
  taskENTER_CRITICAL(&s_mux);
  const bool was = s_active;
  s_active = false;
  taskEXIT_CRITICAL(&s_mux);
  if (!was) return;
  capture_unlock();
  klog("P4", "maintenance ended: %s", why != NULL ? why : "?");
}

void maint_poll(void) {
  if (!s_active) return;
  const int64_t now = esp_timer_get_time();
  taskENTER_CRITICAL(&s_mux);
  const bool expired = pure_maint_expired(s_active, s_deadline_us, now);
  taskEXIT_CRITICAL(&s_mux);
  if (expired) maint_exit("no command for 600 s");
}
