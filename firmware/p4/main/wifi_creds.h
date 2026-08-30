/**
 * Saved Wi-Fi networks, and the passphrases that go with them.
 *
 * ## Why this is not in config_store.c
 *
 * `config_store.c` keeps the whole `KinoConfig` envelope as one JSON string
 * in NVS namespace `"kino"`, key `"config"`, and `GET_CONFIG` returns that
 * string verbatim. A passphrase placed anywhere in that document is a
 * passphrase in every `GET_CONFIG` reply, every Studio config export, and
 * every backup file — and the config envelope is deliberately generic, so a
 * future key added by someone who has never read this comment would leak too.
 *
 * Credentials therefore live in their own NVS namespace, `"kino_wifi"`, which
 * `config_store.c` never opens and `GET_CONFIG` cannot reach. That is a
 * structural guarantee rather than a filter: there is no code path from the
 * config document to this namespace, so the leak cannot be reintroduced by
 * adding a field. A redaction list would have to be maintained forever and
 * would fail the first time someone forgot.
 *
 * ## What leaves the device
 *
 * The passphrase never does. `wifi_creds_list()` returns metadata only, and
 * the `NETWORK_LIST` reply carries the mask `"••••"` in the
 * `password` field with `hasPassword` beside it — the shape Studio already
 * expects (`NetworkView` / `MASKED_PASSWORD` in
 * apps/studio/src/roll/rollTypes.ts). There is deliberately no read accessor
 * in this header that returns a passphrase to application code:
 * `wifi_creds_apply_to()` hands it straight to the radio driver instead, so
 * it exists in one frame and is wiped before that frame returns.
 *
 * ## What is NOT protected
 *
 * NVS encryption is not enabled in this firmware's sdkconfig, so a passphrase
 * is plaintext in flash to anyone who can read the chip. That is a real
 * limitation and it is recorded here rather than implied away: the threat this
 * module addresses is accidental disclosure through the protocol, the logs and
 * the backups, which is the one that happens by itself. Physical flash
 * readout needs `CONFIG_NVS_ENCRYPTION` and a key partition. Since 0.4.9 the
 * table (firmware/p4/partitions.csv, issue #143) leaves 9.6 MB unallocated,
 * so there is room; turning encryption on is its own decision, because the
 * key partition changes the flash-and-recover procedure for every unit.
 */
#ifndef P4_WIFI_CREDS_H
#define P4_WIFI_CREDS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "net_link.h"

/** How many networks the camera remembers. Small on purpose: this is a
 * camera, not a laptop, and each entry costs an NVS blob. */
#define WIFI_CREDS_MAX 8

/**
 * One saved network, as reported outward. Note what is absent: there is no
 * passphrase field, so no caller can accidentally serialise one.
 *
 * Mirrors `NetworkView` in apps/studio/src/roll/rollTypes.ts minus the mask,
 * which the KDP layer adds.
 */
typedef struct {
  char ssid[NET_SSID_LEN];
  bool has_password;
  net_security_t security;
  bool auto_join;
  /** Epoch ms of the last successful association, or 0 if never. Trustworthy
   * only as far as clock.c's `clockSource` says it is. */
  int64_t last_connected_ms;
} wifi_cred_view_t;

/** Open the credential namespace. Safe to call once at boot; failure means
 * the camera cannot remember networks, not that it cannot take pictures. */
esp_err_t wifi_creds_init(void);

/**
 * Save or update one network.
 *
 * `passphrase` may be NULL or empty to keep whatever is already stored — see
 * pure_wifi_passphrase_ok() for why that is the normal case and not a
 * malformed request. Validation is the caller's job via that predicate, so
 * the KDP layer can return a specific `INVALID_ARGUMENT` message.
 *
 * Persists immediately. A network saved and then powered off must still be
 * there, because the alternative is a camera that forgets the party's Wi-Fi
 * every time the battery runs down.
 */
esp_err_t wifi_creds_set(const char *ssid, const char *passphrase, net_security_t security,
                         bool auto_join);

/** Forget one network, passphrase included. Returns ESP_ERR_NOT_FOUND when
 * `ssid` was not stored, so `NETWORK_DELETE` can say so rather than claiming
 * a success that removed nothing. */
esp_err_t wifi_creds_delete(const char *ssid);

/** Metadata for every saved network. Returns the count written. */
size_t wifi_creds_list(wifi_cred_view_t *out, size_t cap);

/** How many networks are stored. */
size_t wifi_creds_count(void);

/** True when `ssid` is stored and has a passphrase. Lets the KDP layer
 * compute `keeps_stored` for pure_wifi_passphrase_ok() without reading the
 * secret. */
bool wifi_creds_has_password(const char *ssid);

/** Record a successful association, for the `lastConnectedAt` metadata. */
void wifi_creds_mark_connected(const char *ssid, int64_t epoch_ms);

/** The network the camera should try on its own, or false when there is
 * none. Metadata only — no passphrase. */
bool wifi_creds_auto_join_target(char *ssid_out, size_t cap);

/**
 * Hand the passphrase for `ssid` to a radio driver.
 *
 * The passphrase is passed to `sink` and the buffer holding it is wiped
 * before this function returns, so it never lives in a caller's frame and
 * cannot be logged by accident. This is the ONLY way out of the store, and
 * it exists in this shape so that "who can see the passphrase" has exactly
 * one answer: the function that gives it to the radio.
 *
 * Returns ESP_ERR_NOT_FOUND when nothing is stored for `ssid`.
 */
esp_err_t wifi_creds_apply_to(const char *ssid,
                              esp_err_t (*sink)(const char *ssid, const char *passphrase,
                                                net_security_t security, void *ctx),
                              void *ctx);

/** Remove every saved network. Called by `FACTORY_RESET`, which must not
 * leave the previous owner's Wi-Fi passphrase on the device. */
esp_err_t wifi_creds_erase_all(void);

#endif /* P4_WIFI_CREDS_H */
