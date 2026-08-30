#pragma once
/*
 * Radio recovery: what the P4 does when the C6 goes away under a live link.
 *
 * Measured on KD4-D121BC, 2026-08-30 (firmware 0.4.5): a C6 reset with the P4
 * running left NETWORK_STATUS at C6_BOOTING / C6_LINK_LOST for as long as
 * anyone watched. The C6 rebooted fine (its own console said so); the host
 * side - ESP-Hosted transport, the remote Wi-Fi stack, the netif - kept the
 * state of a coprocessor that no longer existed, and nothing re-established
 * anything. Only a P4 reboot did, which costs the photograph in flight.
 *
 * This file is the decision, kept free of ESP-IDF so it is host-tested. The
 * doing is net_hosted.c: it feeds observations in, gets one action out per
 * step, performs it, and reports how it went. The order is the one the
 * pinned components tolerate (esp_hosted 3.0.6, esp_wifi_remote 1.6.4),
 * found on the bench rather than in a document:
 *
 *   TEARDOWN      quiesce first - stop wanting an association, tell the netif
 *                 it is disconnected AND stopped, ignore events, send no RPC
 *                 to a coprocessor that cannot answer - then
 *                 esp_hosted_deinit(). The transport has to come down and up:
 *                 the component's RX/TX byte counters reset only there, and a
 *                 rebooted slave restarts its own at zero (measured: every
 *                 frame read as ~979 KB until then). The deinit was safe once
 *                 nothing had been sent into the dead slave first
 *   RESET_C6      the enable line, bring-up's own 20 ms
 *   HOSTED_UP     free the recovery reserve (two 16 KiB internal DMA blocks
 *                 held since bring-up: the P4's PSRAM heap carries no
 *                 MALLOC_CAP_DMA, and the component asserts when its 15,872 B
 *                 SW_AGGR buffer cannot be allocated), then esp_hosted_init()
 *                 and esp_hosted_connect_to_slave() as at first boot
 *   SDIO_WAIT     rx_ready - enumeration actually happened
 *   HANDSHAKE     rx_ready && tx_ready - usable both ways
 *   VERSION_GATE  the real version RPC over the restored transport, same
 *                 policy as first boot; incompatible parks, fail closed
 *   WIFI_INIT     esp_wifi_init / storage / STA / start, over RPC again
 *   WIFI_JOIN     stored credentials, through net_link as always
 *   DHCP_WAIT     an address the existing lease rules accept
 *   -> RECOVERED  once, then HEALTHY; the upload queue is told once
 *
 * Every wait is bounded. A failure counts an attempt and backs off (2 s
 * doubling, 60 s cap); RR_MAX_ATTEMPTS failures park the radio with the
 * reason on the record - no reboot, no tight loop. A wrong passphrase parks
 * too, for the same reason the first boot does not retry one. Each attempt
 * carries a generation; an observation stamped with an older generation is
 * ignored, so nothing left over from the previous coprocessor can mark the
 * new one ready or down.
 *
 * Nothing here reboots the P4. There is no such action in rr_action_t, which
 * is the property the host test checks by enumeration.
 */

#include <stdbool.h>
#include <stdint.h>

typedef enum {
  RR_HEALTHY = 0,   /* nothing to recover; the link is up or never was */
  RR_TEARDOWN,      /* quiesce, then esp_hosted_deinit; no RPC to the dead slave */
  RR_RESET_C6,      /* one enable-line pulse */
  RR_HOSTED_UP,     /* reserve freed, esp_hosted_init + connect_to_slave */
  RR_SDIO_WAIT,     /* waiting for rx_ready */
  RR_HANDSHAKE_WAIT,/* rx_ready, waiting for tx_ready */
  RR_VERSION_GATE,  /* the version RPC is in flight */
  RR_WIFI_INIT,     /* remote Wi-Fi stack coming up */
  RR_WIFI_JOIN,     /* stored credentials applied, waiting for association */
  RR_DHCP_WAIT,     /* associated, waiting for an address */
  RR_BACKOFF,       /* an attempt failed; waiting before the next */
  RR_PARKED,        /* gave up; reason in detail; a new loss event restarts */
} rr_state_t;

typedef enum {
  RR_ACT_NONE = 0,
  RR_ACT_TEARDOWN,
  RR_ACT_RESET_C6,
  RR_ACT_HOSTED_UP,
  RR_ACT_VERSION_RPC,
  RR_ACT_WIFI_INIT,
  RR_ACT_WIFI_JOIN,
  RR_ACT_RECOVERED, /* returned exactly once per recovery: wake dependents */
} rr_action_t;

/** Result of the version RPC, passed to rr_action_done() for RR_ACT_VERSION_RPC. */
typedef enum {
  RR_VER_UNKNOWN = 0,
  RR_VER_OK,
  RR_VER_NO_RESPONSE,
  RR_VER_INCOMPATIBLE,
} rr_version_t;

/** What the glue can see right now. Read fresh before every step. */
typedef struct {
  bool rx_ready;    /* eh_host_mcu_transport_state_is_rx_ready() */
  bool tx_ready;    /* eh_host_mcu_transport_state_is_tx_ready() */
  bool associated;  /* net_link state >= NET_WIFI_ASSOCIATED */
  bool has_ip;      /* net_link state == NET_IP_READY */
  bool auth_failed; /* net_link reason == NET_REASON_AUTH_FAILED */
} rr_obs_t;

#define RR_MAX_ATTEMPTS 6u
#define RR_SDIO_TIMEOUT_MS 5000
#define RR_HANDSHAKE_TIMEOUT_MS 3000
#define RR_ASSOC_TIMEOUT_MS 20000
#define RR_DHCP_TIMEOUT_MS 15000
#define RR_BACKOFF_BASE_MS 2000u
#define RR_BACKOFF_CAP_MS 60000u
#define RR_DETAIL_LEN 80

typedef struct {
  rr_state_t state;
  uint32_t generation;  /* bumped on every attempt; stale observations are ignored */
  uint32_t attempts;    /* failed attempts in the current recovery */
  uint32_t recoveries;  /* recoveries completed since boot */
  bool action_pending;  /* an action was issued and not yet reported done */
  int64_t deadline_ms;  /* bound on the current wait, 0 when none */
  /* Diagnostic timing of the current/last recovery, ms on the caller's clock. */
  int64_t t_lost, t_release, t_rx, t_tx, t_version, t_assoc, t_ip;
  char detail[RR_DETAIL_LEN];
} rr_t;

void rr_init(rr_t *r);

/** The link that was up is gone. Starts a recovery from HEALTHY or PARKED;
 * ignored while one is already running. */
void rr_link_lost(rr_t *r, int64_t now_ms);

/**
 * One step. Returns at most one action to perform now, or RR_ACT_NONE.
 * `obs_generation` is the generation the observation was taken under; an
 * observation from an older generation is ignored and yields RR_ACT_NONE.
 * Timeouts are evaluated against `now_ms`.
 */
rr_action_t rr_step(rr_t *r, const rr_obs_t *obs, uint32_t obs_generation, int64_t now_ms);

/**
 * Report the outcome of the action last returned by rr_step(). `rc` is 0 for
 * success and non-zero for failure, except for RR_ACT_VERSION_RPC where it is
 * an rr_version_t. Ignored when no action is pending or `action` is not the
 * pending one.
 */
void rr_action_done(rr_t *r, rr_action_t action, int rc, int64_t now_ms);

/** 2 s doubling from the first failure, capped at RR_BACKOFF_CAP_MS. */
uint32_t rr_backoff_ms(uint32_t attempts);

/** True while a recovery is in progress (not HEALTHY, not PARKED). */
bool rr_active(const rr_t *r);

const char *rr_state_name(rr_state_t s);
const char *rr_action_name(rr_action_t a);
