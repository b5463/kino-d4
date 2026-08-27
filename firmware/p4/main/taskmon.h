/**
 * A register of the firmware's long-lived tasks, so GET_RUNTIME_STATS can
 * report how close each one came to overflowing its stack.
 *
 * ## Why a registry
 *
 * `uxTaskGetSystemState()` would enumerate every task without anyone
 * registering anything, but it needs `configUSE_TRACE_FACILITY`, which is
 * **not set** in this project's sdkconfig. Turning it on costs RAM in every
 * TCB and changes FreeRTOS configuration in a build that is about to be
 * flashed for a first hardware bring-up — the wrong moment to alter the
 * scheduler's own footprint. `INCLUDE_uxTaskGetStackHighWaterMark` is already
 * 1, so the per-task query works today given a handle; a handle is all this
 * provides.
 *
 * One line at each `xTaskCreate` site, no change to any task's structure.
 *
 * ## The unit, derived rather than assumed
 *
 * `uxTaskGetStackHighWaterMark()` returns the smallest amount of free stack
 * the task has ever had. FreeRTOS's own header says the unit is *words*:
 *
 *     "@return The smallest amount of free stack space there has been (in
 *      words, so actual spaces on the stack rather than bytes)"
 *
 * On this target it is **bytes**, and that is worth spelling out because the
 * two differ by 4x and a wrong label turns a comfortable margin into an
 * apparent near-overflow:
 *
 *   - `prvTaskCheckFreeStackSpace()` in `tasks.c` counts untouched stack
 *     BYTES, then does `ulCount /= sizeof(StackType_t)`.
 *   - The ESP-IDF RISC-V port defines `portSTACK_TYPE uint8_t`, so
 *     `sizeof(StackType_t) == 1` and that division is by one.
 *
 * Therefore words == bytes here. It would NOT be true on a port where
 * `StackType_t` is 32-bit, so the field is named for the unit and this note
 * exists so nobody has to re-derive it.
 */
#ifndef P4_TASKMON_H
#define P4_TASKMON_H

#include <stdbool.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* Enough for the thirteen long-lived tasks plus room for the bench-only ones
 * that come and go. Registration past this is dropped and reported rather
 * than overwriting a slot. */
#define TASKMON_MAX 20

/**
 * Record a task so its stack can be reported later.
 *
 * `name` should match the name given to xTaskCreate so a reader can line the
 * report up against the source. Safe to call before any of this is used, from
 * any task, and safe to call with a NULL handle — which is what xTaskCreate
 * leaves when a caller passes NULL for the handle argument, and is recorded as
 * an explicit omission rather than silently skipped.
 */
void taskmon_register(const char *name, TaskHandle_t handle);

/**
 * Take a registered task's last reading and stop tracking its handle.
 *
 * A task that ends with `vTaskDelete(NULL)` leaves the registry holding a
 * handle to a freed TCB, and `uxTaskGetStackHighWaterMark()` on that handle is
 * a use-after-free: it reported `icons` at 0 free bytes on the first P4 bring-up,
 * which reads as a task that all but overflowed. The number was freed memory.
 *
 * So a self-deleting task calls this immediately BEFORE `vTaskDelete(NULL)`,
 * while its own stack is still valid. The reading is frozen and reported
 * afterwards as a finished measurement rather than dropped — what the icon
 * builder peaked at is worth keeping — and `exited` marks it so nobody reads a
 * boot-time number as live telemetry.
 */
void taskmon_task_done(const char *name);

/** One row of the report. */
typedef struct {
  const char *name;
  /** Minimum free stack the task has ever had, in BYTES on this target — see
   * the header note. 0 when no handle was retained for this task. */
  uint32_t min_free_bytes;
  /** False when the task registered without a handle, so the row exists and
   * says it has no measurement rather than reporting a plausible zero. */
  bool measured;
  /** The task has finished and deleted itself; `min_free_bytes` is its final
   * reading, taken before it went, and will not change again. */
  bool exited;
} taskmon_row_t;

/** Fills `rows` (up to `cap`) and returns how many were written. */
int taskmon_snapshot(taskmon_row_t *rows, int cap);

/** Registered tasks that could not be measured, for the report's honesty. */
int taskmon_unmeasured(void);

#endif
