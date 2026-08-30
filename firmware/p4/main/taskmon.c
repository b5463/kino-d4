#include "taskmon.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

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

/* A mutex, not a critical section.
 *
 * The first version used portENTER_CRITICAL, on the argument that every
 * operation here is a few register reads. The snapshot is not: it calls
 * uxTaskGetStackHighWaterMark() once per task, and that walks the unused
 * stack byte by byte looking for the 0xa5 fill — cost proportional to free
 * stack, tens of kilobytes across 20 tasks, on the order of a millisecond.
 * The camera UARTs have 1.39 ms of slack at 921600 baud with a 128-byte FIFO
 * and no flow control (capture.c), and GET_RUNTIME_STATS can arrive from
 * Studio mid-capture. Interrupts stay enabled here; the mutex only keeps the
 * exited flag and the handle consistent, which is all the lock was ever for.
 *
 * Every caller is a task after the scheduler has started (registration
 * follows an xTaskCreate), so a mutex is legal. It is created lazily under a
 * spinlock so the first two registrations cannot race to create it. */
static SemaphoreHandle_t s_lock;
static StaticSemaphore_t s_lock_buf;
static portMUX_TYPE s_create_mux = portMUX_INITIALIZER_UNLOCKED;

static void lock(void) {
  if (s_lock == NULL) {
    portENTER_CRITICAL(&s_create_mux);
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutexStatic(&s_lock_buf);
    portEXIT_CRITICAL(&s_create_mux);
  }
  xSemaphoreTake(s_lock, portMAX_DELAY);
}

static void unlock(void) { xSemaphoreGive(s_lock); }

/* Caller holds s_mux. -1 when absent. */
static int find_slot(const char *name) {
  for (int i = 0; i < s_count; i++) {
    if (strncmp(s_slots[i].name, name, sizeof s_slots[i].name) == 0) return i;
  }
  return -1;
}

void taskmon_register(const char *name, TaskHandle_t handle) {
  if (name == NULL) return;
  lock();
  const int existing = find_slot(name);
  if (existing >= 0) {
    /* A task that outranks its creator can finish, and report its final
     * reading, before the xTaskCreate call site gets to register it — which is
     * exactly what the icon builder does: priority 3 against a lower-priority
     * caller, see the note at its creation in ui.c. Registering then would
     * store a handle to a freed TCB and every later snapshot would read freed
     * memory, drifting as the heap is reused. An exited slot is final. */
    if (!s_slots[existing].exited) s_slots[existing].handle = handle;
    unlock();
    return;
  }
  if (s_count >= TASKMON_MAX) {
    s_dropped++;
    unlock();
    /* Logged outside the lock would be tidier, but this branch means the
     * registry is misconfigured and saying so immediately is worth more than
     * the style point. */
    ESP_LOGW(TAG, "no slot for '%s'; raise TASKMON_MAX", name);
    return;
  }
  /* Fill the slot, then publish it by bumping s_count LAST.
   *
   * `&s_slots[s_count++]` published an empty slot and filled it afterwards.
   * The KDP task runs GET_RUNTIME_STATS at priority 9 and preempts a
   * lower-priority caller mid-registration — viewfinder_init() registers four
   * tasks in a row, so the window is four slots wide at boot — and the
   * snapshot then read a name that was not there yet and a handle field
   * holding whatever the array was last used for. s_count is the release
   * point: a slot the reader can see is a slot that is complete. */
  slot_t *s = &s_slots[s_count];
  strlcpy(s->name, name, sizeof s->name);
  s->name[sizeof s->name - 1] = '\0';
  s->handle = handle;
  s->final_free_bytes = 0;
  s->exited = false;
  s_count++;
  unlock();
}

void taskmon_task_done(const char *name) {
  if (name == NULL) return;
  /* Read the watermark BEFORE taking the lock and before the handle is
   * cleared: the caller is the task itself, still running on the stack being
   * measured, which is the only moment this value can be had safely. */
  const uint32_t final_free = (uint32_t)uxTaskGetStackHighWaterMark(NULL);
  lock();
  int i = find_slot(name);
  if (i < 0) {
    /* Finished before its creator registered it. Claim the slot now and mark
     * it exited, so the registration that arrives afterwards — carrying a
     * handle that is about to be freed — is refused rather than believed. */
    if (s_count >= TASKMON_MAX) {
      s_dropped++;
      unlock();
      return;
    }
    /* Same publish-last order as taskmon_register: fill the row, then let
     * s_count expose it. */
    i = s_count;
    strlcpy(s_slots[i].name, name, sizeof s_slots[i].name);
    s_slots[i].name[sizeof s_slots[i].name - 1] = '\0';
    s_slots[i].final_free_bytes = final_free;
    s_slots[i].exited = true;
    s_slots[i].handle = NULL;
    s_count++;
    unlock();
    return;
  }
  s_slots[i].final_free_bytes = final_free;
  s_slots[i].exited = true;
  s_slots[i].handle = NULL;
  unlock();
}

int taskmon_snapshot(taskmon_row_t *rows, int cap) {
  if (rows == NULL || cap <= 0) return 0;
  int n = 0;
  /* Under the same lock the writers take.
   *
   * Reading s_count and the slots unlocked let taskmon_task_done clear a
   * handle between the NULL check below and the query on the next line, which
   * is precisely the freed-TCB read the exited flag exists to prevent — the
   * flag only helps if the two are looked at together. The stack walks inside
   * are why this is a mutex and not a critical section — see the note at
   * s_lock. rows[].name points into the slot array, which is static and never
   * reused, so it stays valid after the lock is dropped. */
  lock();
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
  unlock();
  return n;
}

int taskmon_unmeasured(void) {
  int n = 0;
  lock();
  for (int i = 0; i < s_count; i++) {
    /* An exited task carries a real final reading, so it is not unmeasured. */
    if (s_slots[i].handle == NULL && !s_slots[i].exited) n++;
  }
  const int dropped = s_dropped;
  unlock();
  return n + dropped;
}
