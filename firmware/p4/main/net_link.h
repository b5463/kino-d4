/**
 * The P4's view of the ESP32-C6 radio: link state, radio state, and why the
 * last thing that failed, failed.
 *
 * ## Why this module can report NOT ROUTED
 *
 * The C6 is fitted to the Guition JC4880P443C-I-W carrier and its routing is
 * now recorded — SDMMC slot 1 on GPIO14-19 with EN on GPIO54, evidence chain
 * in `firmware/C6_HARDWARE_MAP.md`, pins in `board_d4v1.h`. Nothing has been
 * driven: the routing is corroborated, not bench-proven, and GPIO54's
 * polarity is unconfirmed.
 *
 * So the radio is a BUILD-TIME OPT-IN and the default build has no transport
 * at all. Enabling ESP-Hosted drives GPIO14-19 and GPIO54 on every boot, and
 * shipping that on unproven routing would drive unproven pins on every
 * power-up of every unit. `firmware/p4/sdkconfig.radio` is the opt-in;
 * `C6_BRINGUP.md` step 4 is the command.
 *
 * This module holds the state vocabulary either way. It does not know which
 * build it is in: `net_link_set_driver()` is what makes the difference, and
 * with no driver registered `net_link_status()` reports `NET_C6_NOT_ROUTED`
 * with reason `NET_REASON_TRANSPORT_UNKNOWN`. Every caller above it is
 * already written against the full state set.
 *
 * ## Why a state enum and not a boolean
 *
 * `wifi = true` cannot tell a user which of eight things to go and fix. The
 * distinction that matters most on this board is the one a boolean destroys:
 * the radio hardware is *fitted* but the firmware has *no route to it*. A
 * boolean would report that as "no Wi-Fi", which reads as a missing part and
 * sends someone looking for a component that is already soldered on.
 *
 * ## Time
 *
 * Every function that needs the clock takes `now_ms`. That keeps this file
 * free of `esp_timer` — it reaches only `esp_err.h` — so the host tests
 * exercise the real state machine rather than a copy of it. Same discipline
 * as roll_queue.c, for the same reason.
 *
 * ## Locking
 *
 * Every function below is safe to call from any task. The module holds one
 * mutex over its state, because the writers are four different tasks — the
 * IDF event loop, the c6link supervisor, the SNTP callback and whichever task
 * moved the transport bytes — and the readers are the UI while it draws, the
 * upload worker and the KDP server. `net_link_status()` returns a consistent
 * snapshot rather than a mixture of two moments, which is what stops an
 * address from the network that just went away being reported beside the SSID
 * of the one that has not arrived.
 *
 * The mutex is created by `net_link_init()` and by `net_link_set_driver()`,
 * and is NULL-tolerant before that: a report during boot never faults. On the
 * host, where this file is compiled with nothing but `shim/esp_err.h` on the
 * include path, the lock compiles to nothing and there is one thread.
 *
 * ## Where the radio actually lives
 *
 * `net_hosted.c` owns esp_hosted and esp_wifi_remote and exists only in the
 * radio build. It pushes facts DOWN here through `net_link_report_*()` and
 * receives commands UP through the `net_link_driver_t` it registers. That is
 * why this file still reaches nothing but `esp_err.h`: an `esp_wifi_scan_start()`
 * in here would take the whole state machine out of the host tests, and the
 * state machine is the part that has to be right before a board exists.
 */
#ifndef P4_NET_LINK_H
#define P4_NET_LINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Longest SSID the 802.11 standard allows, plus a terminator. */
#define NET_SSID_LEN 33
/** Dotted-quad, plus a terminator. */
#define NET_IP_LEN 16
/** BSSID as `aa:bb:cc:dd:ee:ff`. */
#define NET_BSSID_LEN 18
/** Longest detail string kept for diagnostics. Never holds a secret. */
#define NET_DETAIL_LEN 96
/** Scan results held at once. A party flat has a dozen APs; more than this
 * and the list on a 480x800 panel is unreadable anyway. Bounded because the
 * radio decides how many it found and this side has to survive the answer. */
#define NET_SCAN_MAX 20
/** Longest version string kept for the host, the coprocessor and the RPC
 * protocol. `esp_hosted_app_desc_t.version` is 32 bytes; a semver plus a
 * terminator fits in far less and the field is a diagnostic, not a parse. */
#define NET_VERSION_LEN 24

/**
 * Where the radio subsystem is. Ordered from "no hardware conversation at
 * all" up to "usable", so a caller can ask `>= NET_IP_READY` rather than
 * enumerating.
 *
 * `NET_C6_NOT_ROUTED` is deliberately distinct from `NET_C6_ABSENT`:
 *
 *   ABSENT      — a transport exists and the C6 did not answer on it.
 *   NOT_ROUTED  — this firmware has no transport to try. The chip is fitted;
 *                 we cannot reach it. This is the D4 V1's state today.
 *
 * Collapsing those two would report a wiring question as a missing part.
 */
typedef enum {
  NET_C6_NOT_ROUTED = 0, /* no transport pins known — see C6_HARDWARE_MAP.md */
  NET_C6_ABSENT,         /* transport exists; nothing answered */
  NET_C6_BOOTING,        /* reset released, waiting for the slave image */
  NET_C6_LINK_READY,     /* transport handshake done, versions exchanged */
  NET_RADIO_READY,       /* Wi-Fi stack initialised on the C6 */
  NET_WIFI_IDLE,         /* radio up, not attempting anything */
  NET_WIFI_SCANNING,
  NET_WIFI_CONNECTING,
  NET_WIFI_ASSOCIATED, /* associated but no address — NOT usable yet */
  NET_IP_WAIT,         /* DHCP in flight */
  NET_IP_READY,        /* the only state from which an upload may start */
  NET_ERROR,           /* see net_link_status()->reason */
} net_state_t;

/**
 * Why the last transition failed. Kept separate from the state because
 * "NET_ERROR" alone sends someone to the wrong place, and because a reason
 * outlives the state it caused — a reconnect that clears the state should not
 * erase what went wrong last time.
 */
typedef enum {
  NET_REASON_NONE = 0,
  NET_REASON_TRANSPORT_UNKNOWN, /* no P4->C6 routing recorded (V1 today) */
  NET_REASON_C6_NO_RESPONSE,
  NET_REASON_C6_BAD_FIRMWARE, /* slave answered with an incompatible version */
  NET_REASON_C6_LINK_LOST,
  NET_REASON_RADIO_FAILURE,
  NET_REASON_AUTH_FAILED,
  NET_REASON_NETWORK_NOT_FOUND,
  NET_REASON_ASSOC_FAILED,
  NET_REASON_DHCP_TIMEOUT,
  NET_REASON_DNS_FAILURE,
  NET_REASON_NO_CREDENTIALS, /* nothing saved to try */
  /* Appended after NO_CREDENTIALS on purpose: the host test walks the range
   * up to NO_CREDENTIALS, so appending leaves that suite untouched. */
  NET_REASON_CLOCK_UNTRUSTED, /* no trustworthy wall time, so no TLS */
} net_reason_t;

/** Security of a scanned or saved network. Matches `WifiSecurity` in
 * apps/studio/src/roll/rollTypes.ts — `'wpa2' | 'wpa3' | 'open'`. */
typedef enum {
  NET_SEC_OPEN = 0,
  NET_SEC_WPA2,
  NET_SEC_WPA3,
} net_security_t;

/** One scan result. */
typedef struct {
  char ssid[NET_SSID_LEN];
  char bssid[NET_BSSID_LEN];
  int rssi;    /* dBm, negative */
  int channel; /* 1..14 for 2.4 GHz; the C6 is 2.4 GHz only */
  net_security_t security;
  bool hidden; /* the AP advertised an empty SSID */
} net_scan_entry_t;

/** Everything `NETWORK_STATUS` and the RADIO/WI-FI screens need. */
typedef struct {
  net_state_t state;
  net_reason_t reason;
  /** True when the C6 is fitted to this carrier. A build-time fact about the
   * board, not a runtime measurement — the chip is on the module. Reported
   * separately from `state` precisely so the UI can say "fitted, not
   * reachable" instead of "absent", the way `flashControl` is reported
   * separately from `flashHardware`. */
  bool radio_fitted;
  /** True when this firmware has a transport it can attempt: a radio driver
   * has registered itself. False in the default build, which links none.
   * The pair (fitted, routed) is the distinction a boolean would lose. */
  bool radio_routed;
  /** True once the coprocessor has answered on the transport. Distinct from
   * `radio_routed`: routed says we can try, present says something replied. */
  bool c6_present;
  /** True while the SDIO link is up. Goes false on a transport failure before
   * the state machine has finished deciding what that means. */
  bool sdio_link_up;
  char ssid[NET_SSID_LEN];
  char ip[NET_IP_LEN];
  int rssi;    /* dBm; 0 when not associated */
  int channel; /* 0 when not associated */
  /** Milliseconds the current state has held, or 0 if never entered. */
  int64_t since_ms;
  /** Coprocessor image version, empty until a version exchange has happened. */
  char c6_version[NET_VERSION_LEN];
  /** ESP-Hosted version this host links. A build-time fact, reported beside
   * the coprocessor's so a mismatch is readable without a second command. */
  char host_version[NET_VERSION_LEN];
  /** RPC/protocol version the two agreed on, empty until they have. */
  char protocol_version[NET_VERSION_LEN];
  /** Transport framing errors since boot. 0 while NOT_ROUTED. */
  uint32_t transport_errors;
  /** Times the C6 has been held in reset and released since boot. */
  uint32_t c6_resets;
  /** Times the link has been re-established since boot. */
  uint32_t reconnects;
  /** Times the radio was recovered after the C6 went away, without a P4
   * reboot: teardown, reset, re-enumeration, version gate, Wi-Fi, address. */
  uint32_t recoveries;
  /** Times the radio was recovered after the C6 went away, without a P4
   * reboot: teardown, reset, re-enumeration, version gate, Wi-Fi, address. */
  /** Bytes over the transport since boot, both directions. Gate F wants a
   * number for "the radio was actually doing something" during a capture,
   * and "associated" is not that number. */
  uint64_t transport_rx_bytes;
  uint64_t transport_tx_bytes;
  /** Redacted. Never holds a passphrase or a token — see rq_redact(). */
  char detail[NET_DETAIL_LEN];
} net_status_t;

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/**
 * Bring the networking subsystem to its honest initial state. Cheap,
 * non-blocking, and safe to call before the card is mounted.
 *
 * On D4 V1 this settles immediately on `NET_C6_NOT_ROUTED`. It does NOT
 * probe, reset, or drive any pin, because there is no pin to drive.
 *
 * Must never block the boot path. `main.c` calls it after the UI is already
 * usable: the camera has to be able to take a photograph whether or not the
 * radio ever comes up, so networking is started last and asynchronously.
 */
void net_link_init(int64_t now_ms);

/** Current status. Never fails; a caller always gets a complete answer. */
void net_link_status(net_status_t *out, int64_t now_ms);

/**
 * True when an upload may be attempted. The only state that qualifies is
 * `NET_IP_READY`.
 *
 * Association is deliberately not enough. A device that reports "connected"
 * on association and then cannot resolve a name produces a queue that
 * retries against a network it never actually joined, and a display that
 * says it is online while nothing works.
 */
bool net_link_can_upload(const net_status_t *status);

/* ------------------------------------------------------------------ */
/* Operations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Start a scan. Returns false and sets the reason when the radio cannot be
 * reached, which on D4 V1 is always.
 *
 * A scan must never contend with a capture. When the transport lands, this
 * runs on the network task at a priority below the capture workers, and the
 * capture path does not wait on it.
 */
bool net_link_scan_start(int64_t now_ms);

/**
 * Copy up to `cap` scan results out. Returns the number written.
 *
 * Callers must tolerate 0 without treating it as an error: an empty result is
 * a real answer from a radio in a shielded room, and on D4 V1 it is the only
 * answer there is.
 */
size_t net_link_scan_results(net_scan_entry_t *out, size_t cap);

/**
 * Attempt to join `ssid` using the stored passphrase.
 *
 * The passphrase is NOT a parameter. It is read from the credential store at
 * the moment of use so it exists in one place only, and so nothing above this
 * line ever holds it — see wifi_creds.h.
 */
bool net_link_connect(const char *ssid, int64_t now_ms);

/** Drop the association and stop auto-joining until asked again. */
bool net_link_disconnect(int64_t now_ms);

/* ------------------------------------------------------------------ */
/* Naming                                                             */
/* ------------------------------------------------------------------ */

/** Stable identifier for diagnostics and KDP. Never a sentence. */
const char *net_state_name(net_state_t state);

/** Stable identifier for the failure reason. `NET_REASON_NONE` is "NONE". */
const char *net_reason_name(net_reason_t reason);

/**
 * The three-value `state` string `NETWORK_STATUS` reports, which is the
 * vocabulary `NetworkStatus` in apps/studio/src/roll/rollTypes.ts already
 * uses: `'connected' | 'connecting' | 'disconnected'`.
 *
 * Only `NET_IP_READY` maps to `connected`, for the reason
 * net_link_can_upload() gives. The richer `net_state_name()` travels beside
 * it so Studio and the camera can show which of eight things is true without
 * the coarse field lying.
 */
const char *net_wire_state(net_state_t state);

/** Wire name for a security mode: `wpa2`, `wpa3`, `open`. */
const char *net_security_name(net_security_t security);

/** Parse a wire security name. Unknown text is WPA2, the safe assumption:
 * treating an unknown network as open would attempt an unencrypted join. */
net_security_t net_security_parse(const char *name);


/* ------------------------------------------------------------------ */
/* The radio seam                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a radio implementation offers this module.
 *
 * Registered by `net_hosted.c`, which exists only in the radio build. A NULL
 * registration — or none at all — is what makes `radio_routed` false and the
 * state `NET_C6_NOT_ROUTED`, so the default build needs no `#ifdef` here and
 * the host tests exercise the real state machine either way.
 *
 * Every member returns false on refusal and is expected to be asynchronous:
 * the answer arrives later through `net_link_report_*()`. Nothing on this
 * interface may block a caller, because `NETWORK_LIST` runs on the KDP task.
 */
typedef struct {
  bool (*scan_start)(void);
  bool (*connect)(const char *ssid);
  bool (*disconnect)(void);
} net_link_driver_t;

/**
 * Register (or, with NULL, withdraw) the radio driver.
 *
 * Registering clears `NET_REASON_TRANSPORT_UNKNOWN` and moves the state to
 * `NET_C6_BOOTING`: from this point the firmware has a transport to try, and
 * saying NOT_ROUTED would be false. Call it before driving a pin, so a status
 * read during bring-up cannot claim there is no route while one is opening.
 */
void net_link_set_driver(const net_link_driver_t *driver, int64_t now_ms);

/* ------------------------------------------------------------------ */
/* Reporting — called from the radio task, never from a caller above  */
/* ------------------------------------------------------------------ */

/**
 * Record a state transition and, when it failed, why.
 *
 * `detail` may be NULL to leave the previous detail alone. It must already be
 * safe to display: this module does not redact, and a passphrase or a bearer
 * token in here reaches `NETWORK_STATUS`, `GET_LOGS` and a crash dump.
 */
void net_link_report_state(net_state_t state, net_reason_t reason, const char *detail,
                           int64_t now_ms);

/**
 * Release the TLS hold `NET_REASON_CLOCK_UNTRUSTED` represents.
 *
 * net_time.c reports `NET_IP_READY` with that reason when the network is up
 * but the wall clock cannot be believed, so nothing attempts a certificate
 * check that would fail identically forever. Once the clock IS trustworthy
 * something has to take the reason away again, and this is it.
 *
 * The test and the write are one operation under this module's lock, which is
 * why it is a function here rather than a status read and a report back in the
 * caller. Between those two the event task can report a disconnect, and a
 * caller writing IP_READY back over it would claim an address the radio has
 * just given up. Does nothing unless the state is still IP_READY AND the
 * reason is still CLOCK_UNTRUSTED.
 */
void net_link_clear_clock_hold(int64_t now_ms);

/** The three versions the link handshake produces. Any may be NULL to leave
 * that field as it was. Recorded before the compatibility decision is taken,
 * so a refused link still says what it refused. */
void net_link_report_versions(const char *host_version, const char *c6_version,
                              const char *protocol_version);

/** Replace the scan list. `count` above NET_SCAN_MAX is truncated, not
 * refused: a truncated list is usable and an empty one is not. */
void net_link_report_scan(const net_scan_entry_t *entries, size_t count);

/** Association facts. Called on the association event, before an address
 * exists — which is why it does not touch the state. */
void net_link_report_association(const char *ssid, const char *bssid, int rssi, int channel);

/** An address. Moves the state to `NET_IP_READY`, which is the only state
 * `net_link_can_upload()` accepts. Pass NULL or "" to clear it. */
void net_link_report_ip(const char *ip, int64_t now_ms);

/** Transport counters and link state, for `NETWORK_STATUS` and Gate F. */
void net_link_report_transport(uint64_t rx_bytes, uint64_t tx_bytes, uint32_t errors,
                               bool link_up);

/** The C6 was held in reset and released. Counted separately from
 * `reconnects`: a reset is something this firmware did, a reconnect is
 * something the link did. */
void net_link_report_reset(void);

/** The link came back after having been lost. Bumps `reconnects`. */
void net_link_report_reconnect(void);

/** The radio was recovered end to end after the C6 went away. Bumps
 * `recoveries`. */
void net_link_report_recovery(void);


#endif /* P4_NET_LINK_H */
