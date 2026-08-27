#include "taskmon.h"

#include <string.h>

#include "esp_log.h"

static const char *TAG = "taskmon";

typedef struct {
  char name[configMAX_TASK_NAME_LEN];
  TaskHandle_t handle;
} slot_t;

static slot_t s_slots[TASKMON_MAX];
static int s_count;
static int s_dropped;

/* A plain critical section rather than a mutex: registration happens once per
 * task at boot, the snapshot is a read, and taking a mutex from a context that
 * may be very early in startup is a worse trade than a few microseconds with
 * interrupts held. */
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

void taskmon_register(const char *name, TaskHandle_t handle) {
  if (name == NULL) return;
  portENTER_CRITICAL(&s_mux);
  if (s_count >= TASKMON_MAX) {
    s_dropped++;
    portEXIT_CRITICAL(&s_mux);
    /* Logged outside the lock would be tidier, but this branch means the
     * registry is misconfigured and saying so immediately is worth more than
     * the style point. */
    ESP_LOGW(TAG, "no slot for '%s'; raise TASKMON_MAX", name);
    return;
  }
  slot_t *s = &s_slots[s_count++];
  strncpy(s->name, name, sizeof s->name - 1);
  s->name[sizeof s->name - 1] = '\0';
  s->handle = handle;
  portEXIT_CRITICAL(&s_mux);
}

int taskmon_snapshot(taskmon_row_t *rows, int cap) {
  if (rows == NULL || cap <= 0) return 0;
  int n = 0;
  for (int i = 0; i < s_count && n < cap; i++) {
    const slot_t *s = &s_slots[i];
    rows[n].name = s->name;
    if (s->handle != NULL) {
      /* Bytes on this target. The division inside FreeRTOS is by
       * sizeof(StackType_t), which is 1 on the ESP-IDF RISC-V port — see
       * taskmon.h for the derivation. */
      rows[n].min_free_bytes = (uint32_t)uxTaskGetStackHighWaterMark(s->handle);
      rows[n].measured = true;
    } else {
      rows[n].min_free_bytes = 0;
      rows[n].measured = false;
    }
    n++;
  }
  return n;
}

int taskmon_unmeasured(void) {
  int n = 0;
  for (int i = 0; i < s_count; i++) {
    if (s_slots[i].handle == NULL) n++;
  }
  return n + s_dropped;
}
