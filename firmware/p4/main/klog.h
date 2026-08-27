// Structured device log (contract LogEntry): a bounded ring served by
// GET_LOGS and pushed live as Evt.LOG once the KDP transport registers its
// emitter.
//
// TWO CLOCKS, deliberately, because they answer different questions.
//
//   t  — epoch milliseconds, the contract's LogEntry.t. Unset (1970-era)
//        until the device is ever told the real time, which is honest rather
//        than a bug; clock.c reports which of host/persisted/unset it is.
//        Wall-clock, so it can jump backwards when a host sets the clock.
//        Use it to say WHEN something happened.
//
//   us — monotonic microseconds since boot, from esp_timer_get_time(). Never
//        jumps, never adjusted, no epoch shared with anything. Use it to say
//        in WHAT ORDER things happened, and how far apart.
//
// The second one exists for the first camera bring-up. Reconstructing what
// happened between the P4's tasks and a camera-link event needs sub-millisecond
// ordering: a UART command going out, a node answering, and a worker being
// released can all land inside the same millisecond, and at millisecond
// resolution the log says they were simultaneous when they were not. Attributing
// a stalled transfer to the wrong stage is how a bring-up day gets spent.
//
// `us` is ADDITIVE and optional on the wire. `t` keeps its name, its unit and
// its meaning; nothing that reads LogEntry today notices. The key is two
// characters rather than `timestampUs` on purpose — the ring already fights
// the 16 KB KDP payload cap (see klog_entries_json), and at 200 entries a
// long key name costs about 2 KB of the budget in key names alone, which
// would evict real log lines to describe the field.
#ifndef P4_KLOG_H
#define P4_KLOG_H

#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"

/**
 * src is a contract LogSource: P4 | C1..C4 | PWR | SD | PROTO.
 *
 * `t_ms` is epoch milliseconds and `t_us` is monotonic microseconds since
 * boot — see the header note. Both are passed so the live EVT_LOG stream
 * carries the same ordering information the ring does.
 */
typedef void (*klog_emit_fn)(int64_t t_ms, int64_t t_us, const char *src, const char *msg);

void klog_init(void);
/** Registered by the KDP server; entries logged earlier only buffer. */
void klog_set_emitter(klog_emit_fn fn);
void klog(const char *src, const char *fmt, ...);
void klog_clear(void);

/**
 * Monotonic microseconds since boot, the same source the ring stamps entries
 * with.
 *
 * Exposed so a caller can put a timing figure INTO a message on the same clock
 * the entry itself is stamped with — a duration measured against esp_timer and
 * a log line stamped against esp_timer can be compared; one measured against
 * the wall clock cannot.
 */
int64_t klog_now_us(void);

/**
 * The last entries (oldest first) as a cJSON array of {t, us, src, msg}, capped
 * to `budget` serialized bytes. A full 200-entry ring encodes past the
 * 16 KB KDP payload cap, and an unsendable reply is a client timeout — so
 * the newest entries that fit win and the oldest are dropped (issue #80).
 */
cJSON *klog_entries_json(size_t budget);

#endif
