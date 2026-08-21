// Structured device log (contract LogEntry): a bounded ring served by
// GET_LOGS and pushed live as Evt.LOG once the KDP transport registers its
// emitter. Timestamps are epoch ms from the device clock — unset (1970-era)
// until the device ever learns real time, which is honest, not a bug.
#ifndef P4_KLOG_H
#define P4_KLOG_H

#include <stdint.h>

#include "cJSON.h"

/** src is a contract LogSource: P4 | C1..C4 | PWR | SD | PROTO. */
typedef void (*klog_emit_fn)(int64_t t_ms, const char *src, const char *msg);

void klog_init(void);
/** Registered by the KDP server; entries logged earlier only buffer. */
void klog_set_emitter(klog_emit_fn fn);
void klog(const char *src, const char *fmt, ...);
void klog_clear(void);
/** The last entries (oldest first) as a cJSON array of {t, src, msg}. */
cJSON *klog_entries_json(void);

#endif
