#pragma once
/*
 * Interrupt-blackout watch (#158).
 *
 * The camera links have no flow control and a 128-byte RX FIFO: 1.39 ms at
 * 921600 baud. Any window in which the link ISR cannot run for longer than
 * that loses the tail of whatever chunk is in flight, on every camera that is
 * receiving, with a clean CRC because the frame never finishes. Two such
 * windows have been found by arithmetic and fixed (the compositor's cache
 * writeback, 2026-08-29); a third resisted two fixes aimed by reasoning. This
 * measures instead.
 *
 * A general-purpose timer fires every millisecond on the core that owns the
 * link interrupts, with an ordinary (non-IRAM) handler, so it is held off by
 * exactly what holds the UART ISR off: a critical section on that core, a
 * flash write with the cache disabled, a stalled cache. Each gap longer than
 * ISR_WATCH_GAP_US is recorded with its time and the task running on each
 * core when the interrupt finally landed - which is the task that was
 * running when the blackout ended, and usually the one that caused it.
 *
 * Costs one timer and one short ISR per millisecond. The report is pulled by
 * whoever wants it (the capture path, after its transfers) and logged there,
 * never from the ISR.
 */
#include <stdint.h>

#include "esp_err.h"

#define ISR_WATCH_GAP_US 1300
#define ISR_WATCH_SLOTS 8

typedef struct {
  int64_t at_us;      /* when the late tick landed */
  uint32_t gap_us;    /* how late: spacing between this tick and the previous */
  char core0[16];     /* task on core 0 at that moment */
  char core1[16];     /* task on core 1 */
} isr_watch_gap_t;

/** Start the watch on the calling core. Idempotent. */
esp_err_t isr_watch_init(void);

/** Copy out and clear the recorded gaps (at most ISR_WATCH_SLOTS). Returns
 * how many were recorded since the last call; `dropped` is how many more
 * happened than fit. */
int isr_watch_take(isr_watch_gap_t *out, int cap, uint32_t *dropped);

/** Total gaps since boot. */
uint32_t isr_watch_total(void);
