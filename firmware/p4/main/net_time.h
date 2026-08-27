/**
 * SNTP: the camera's only way to learn what time it is without a host.
 *
 * The D4 has no RTC. `clock.c` owns the wall clock and the priority between
 * its four sources; this module is the one that fetches the `network` source
 * and hands it over. It decides nothing about whether the answer is adopted —
 * `pure_clock_adopt_action()` does, and it is host-tested.
 *
 * ## Why this exists before TLS and not after
 *
 * A certificate cannot be validated against a clock that is wrong by years,
 * and disabling verification to get past that is not an option. So the HTTP
 * client asks `clock_trustworthy_for_tls()` first and the upload queue reports
 * `NET_REASON_CLOCK_UNTRUSTED` rather than looping against a wall it cannot
 * climb. This module is what makes that answer become true.
 *
 * Radio build only — see net_hosted.h.
 */
#ifndef P4_NET_TIME_H
#define P4_NET_TIME_H

#include <stdbool.h>

#ifdef KINO_RADIO

/** Configure SNTP. Does not resolve anything: there is no address yet when
 * this is called, and a resolver started before DHCP just fails once. */
void net_time_start(void);

/** An address has arrived. Kick a sync, or restart one after a reconnect. */
void net_time_sync_now(void);

#else /* !KINO_RADIO */

static inline void net_time_start(void) {}
static inline void net_time_sync_now(void) {}

#endif /* KINO_RADIO */

#endif /* P4_NET_TIME_H */
