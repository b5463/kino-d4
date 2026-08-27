#include "taskmon.h"

#include <string.h>

#include "esp_log.h"

static const char *TAG = "taskmon";

typedef struct {
  char name[configMAX_TASK_NAME_LEN];
  TaskHandle_t handle;
  /** Final reading kept after the task deleted itself; see taskmon_task_done. */
  uint32_t final_free_bytes;
  bool exited;
} slot_t;

static slot_t s_slots[TASKMON_MAX];
static int s_count;
static int s_dropped;

/* A plain critical section rather than a mutex: registration happens once per
 * task at boot, the snapshot is a read, and taking a mutex from a context that
 * may be very early in startup is a worse trade than a few microseconds with
 * interrupts held. */
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

/* Caller holds s_mux. -1 when absent. */
static int find_slot(const char *name) {
  for (int i = 0; i < s_count; i++) {
    if (strncmp(s_slots[i].name, name, sizeof s_slots[i].name) == 0) return i;
  }
  return -1;
}

void taskmon_register(const char *name, TaskHandle_t handle) {
  if (name == NULL) return;
  portENTER_CRITICAL(&s_mux);
  const int existing = find_slot(name);
  if (existing >= 0) {
    /* A task that outranks its creator can finish, and report its final
     * reading, before the xTaskCreate call site gets to register it — which is
     * exactly what the icon builder does: priority 3 against a lower-priority
     * caller, see the note at its creation in ui.c. Registering then would
     * store a handle to a freed TCB and every later snapshot would read freed
     * memory, drifting as the heap is reused. An exited slot is final. */
    if (!s_slots[existing].exited) s_slots[existing].handle = handle;
    portEXIT_CRITICAL(&s_mux);
    return;
  }
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

void taskmon_task_done(const char *name) {
  if (name == NULL) return;
  /* Read the watermark BEFORE taking the lock and before the handle is
   * cleared: the caller is the task itself, still running on the stack being
   * measured, which is the only moment this value can be had safely. */
  const uint32_t final_free = (uint32_t)uxTaskGetStackHighWaterMark(NULL);
  portENTER_CRITICAL(&s_mux);
  int i = find_slot(name);
  if (i < 0) {
    /* Finished before its creator registered it. Claim the slot now and mark
     * it exited, so the registration that arrives afterwards — carrying a
     * handle that is about to be freed — is refused rather than believed. */
    if (s_count >= TASKMON_MAX) {
      s_dropped++;
      portEXIT_CRITICAL(&s_mux);
      return;
    }
    i = s_count++;
    strncpy(s_slots[i].name, name, sizeof s_slots[i].name - 1);
    s_slots[i].name[sizeof s_slots[i].name - 1] = '\0';
  }
  s_slots[i].final_free_bytes = final_free;
  s_slots[i].exited = true;
  s_slots[i].handle = NULL;
  portEXIT_CRITICAL(&s_mux);
}

int taskmon_snapshot(taskmon_row_t *rows, int cap) {
  if (rows == NULL || cap <= 0) return 0;
  int n = 0;
  for (int i = 0; i < s_count && n < cap; i++) {
    const slot_t *s = &s_slots[i];
    rows[n].name = s->name;
    rows[n].exited = s->exited;
    if (s->exited) {
      /* Frozen before the task deleted itself. Querying the handle now would
       * be the use-after-free this flag exists to prevent. */
      rows[n].min_free_bytes = s->final_free_bytes;
      rows[n].measured = true;
    } else if (s->handle != NULL) {
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
    /* An exited task carries a real final reading, so it is not unmeasured. */
    if (s_slots[i].handle == NULL && !s_slots[i].exited) n++;
  }
  return n + s_dropped;
}
