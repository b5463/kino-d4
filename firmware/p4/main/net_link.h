/**
 * The P4's view of the ESP32-C6 radio: link state, radio state, and why the
 * last thing that failed, failed.
 *
 * ## Why this module reports NOT ROUTED
 *
 * The C6 is fitted to the Guition JC4880P443C-I-W carrier. The P4 has no
 * route to it that this repository can name: the only C6-facing header pins
 * on record are `C6_U0RXD`, `C6_U0TXD`, `C6_IO9` and `C6_CHIP_PU`, and none of
 * them has a P4-side GPIO number anywhere in the tree. No SDIO or SPI
 * transport pin is recorded at all. `firmware/C6_HARDWARE_MAP.md` holds the
 * evidence and the four places the repo already says a schematic is required.
 *
 * So this firmware does not drive a transport. A guessed SDIO bus in that pin
 * region contends with lines `capture.c` already drives and with the C6's own
 * boot straps; the failure mode is not "no Wi-Fi", it is a board that stops
 * booting predictably. That is a worse outcome than no radio.
 *
 * What this module therefore is: the seam, the state vocabulary, and the
 * honest answer. `net_link_status()` reports `NET_C6_NOT_ROUTED` with reason
 * `NET_REASON_TRANSPORT_UNKNOWN`, every caller above it is already written
 * against the full state set, and closing the gate is adding a pin block plus
 * a transport — not a redesign. `C6_BRINGUP.md` is the procedure.
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
  /** True when this firmware has a transport it can attempt. False on D4 V1.
   * The pair (fitted, routed) is the distinction a boolean would lose. */
  bool radio_routed;
  char ssid[NET_SSID_LEN];
  char ip[NET_IP_LEN];
  int rssi;    /* dBm; 0 when not associated */
  int channel; /* 0 when not associated */
  /** Milliseconds the current state has held, or 0 if never entered. */
  int64_t since_ms;
  /** Slave image version, empty until a link handshake has happened. */
  char c6_version[24];
  /** Transport framing errors since boot. 0 while NOT_ROUTED. */
  uint32_t transport_errors;
  /** Times the link has been re-established since boot. */
  uint32_t reconnects;
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

#endif /* P4_NET_LINK_H */
