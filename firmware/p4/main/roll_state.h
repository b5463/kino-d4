/**
 * Which KINO Roll this camera belongs to, and the device credential it would
 * upload with.
 *
 * Two kinds of data, deliberately kept apart, in two NVS namespaces that are
 * both separate from the config envelope:
 *
 *   - **Membership** (`"kino_roll"`): rollId, slug, guestUrl, name, role,
 *     joinedAt. Not secret. `ROLL_STATUS` reports all of it and the display
 *     renders `guestUrl` as the JOIN THIS ROLL QR code.
 *   - **Credential** (`"kino_rollsec"`): deviceId and deviceToken. The token
 *     is a bearer secret and gets the same treatment as a Wi-Fi passphrase.
 *
 * ## Why not config_store.c
 *
 * Same reason as wifi_creds.h, and it applies to both halves. `GET_CONFIG`
 * returns the whole `"kino"`/`"config"` document verbatim, so a token placed
 * anywhere in it is a token in every config reply, export and backup. There is
 * no code path from the config document to either namespace here, which is a
 * structural guarantee rather than a redaction list somebody has to keep
 * maintaining.
 *
 * Membership is not secret, so it could have lived in the config document. It
 * does not, for a different reason: it is not a setting. It is state the
 * server owns and the camera caches. A `SET_CONFIG` merge that dropped a
 * `roll` object in would let a host reassign the camera to another Roll
 * through the generic settings path, with no validation and no audit line.
 *
 * ## The token never comes back out
 *
 * `POST /api/studio/devices/register` returns `{deviceId, deviceToken}` once
 * and stores only its SHA-256 — the server cannot re-issue it, so losing the
 * stored copy means re-registering. See docs/roll/ROLL_DEVICE_CONTRACT.md.
 * Accordingly there is no accessor in this header that returns the token.
 * `roll_state_has_credential()` answers the only question callers actually
 * have, and `roll_state_apply_credential_to()` hands the token to the HTTP
 * client in one frame and wipes it before returning. Exactly the shape of
 * `wifi_creds_apply_to()`, for exactly the same reason: "who can see the
 * secret" should have one answer, and it should be the function that gives it
 * to the code that needs it.
 *
 * ## The credential slot is empty today, and this says so
 *
 * Getting a token requires an HTTPS POST to the API. `net_link.h` explains
 * why this firmware has no route to the C6 radio, so the camera cannot make
 * that call. Nothing in this repository fills the credential; the setter
 * exists for the milestone that adds the radio, and `roll_state_init()` on a
 * shipped 0.1.0 unit finds nothing. That is the honest state, not an
 * oversight.
 *
 * ## Membership, however, is reachable now
 *
 * Studio has internet. It resolves a Roll against the API itself and writes
 * the resolved assignment to the camera over KDP `ROLL_JOIN` as a
 * `PublishedRollJoinRequest` (apps/studio/src/roll/rollTypes.ts). The camera
 * validates and stores it. No radio involved on this side, which is why this
 * half is worth building before the other one.
 *
 * ## What is NOT protected
 *
 * `CONFIG_NVS_ENCRYPTION` is off in this firmware's sdkconfig, so the token is
 * plaintext in flash to anyone who can read the chip. Same limitation as
 * wifi_creds.h and recorded for the same reason: the threat handled here is
 * accidental disclosure through the protocol, the logs and the backups — the
 * one that happens by itself.
 */
#ifndef P4_ROLL_STATE_H
#define P4_ROLL_STATE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/** `rolls.id` as the API prints it. 64 covers a UUID, a `roll_<slug>` and any
 * opaque id the server might switch to. */
#define ROLL_ID_LEN 64

/** Longest slug either accepted form allows, plus a terminator. The reference
 * device's pattern caps at 48 characters; the API's short code is 6. */
#define ROLL_SLUG_LEN 49

/** `guestUrl` is a QR payload, not a link the firmware parses. 256 characters
 * is well past what a version-10 QR at this display size can carry legibly,
 * so the limit is generosity rather than a constraint. */
#define ROLL_GUEST_URL_LEN 257

/** Roll title as shown on the display. */
#define ROLL_NAME_LEN 64

/** `deviceId` from the register call. Not secret. */
#define ROLL_DEVICE_ID_LEN 64

/** `kdt_` + 43 base64url characters = 47, plus a terminator. Exact rather
 * than padded: the length is part of the contract, so a stored value of any
 * other length is a bug worth catching rather than tolerating. */
#define ROLL_DEVICE_TOKEN_LEN 48

/** Who the camera is on this Roll. `ROLL_CREATE` makes it the host,
 * `ROLL_JOIN` makes it a guest — the same two values as `RollInfo.role`. */
typedef enum {
  ROLL_ROLE_HOST = 0,
  ROLL_ROLE_GUEST = 1,
} roll_role_t;

/** `"host"` or `"guest"`, for the KDP reply and the log line. */
const char *roll_role_name(roll_role_t role);

/** Parse `"host"`/`"guest"`. Returns false for anything else rather than
 * defaulting, because guessing wrong here decides who owns the Roll. */
bool roll_role_parse(const char *s, roll_role_t *out);

/**
 * The camera's Roll membership. Mirrors `RollInfo` in
 * apps/studio/src/roll/rollTypes.ts field for field.
 *
 * Note what is absent: no deviceToken. A caller handed this struct cannot
 * serialise a secret it was never given.
 */
typedef struct {
  char roll_id[ROLL_ID_LEN];
  char slug[ROLL_SLUG_LEN];
  char guest_url[ROLL_GUEST_URL_LEN];
  char name[ROLL_NAME_LEN];
  roll_role_t role;
  /** Epoch ms, or 0 when the assignment carried no plausible timestamp.
   * Trustworthy only as far as clock.c's `clockSource` says it is. */
  int64_t joined_at_ms;
} roll_state_t;

/* ------------------------------------------------------------------ */
/* Slug shapes                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which of the two slug forms in this tree a string matches.
 *
 * There really are two, and the camera has to live with both:
 *
 *   - `ROLL_SLUG_SHORT_CODE` — `apps/api/src/rolls/slug.ts`: exactly 6
 *     characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. No `0 O 1 I L`,
 *     because every excluded character is one a guest mistypes off a phone
 *     screen. The server stores it upper case.
 *   - `ROLL_SLUG_REFERENCE` — `packages/test-fixtures/src/MockKinoDevice.ts`:
 *     `/^[a-z0-9][a-z0-9-]{2,47}$/`, e.g. `amber-001`. Looser and lower case.
 *     Every host test and every Studio integration test drives this shape, so
 *     a camera that rejected it would fail the suite that proves the KDP
 *     group works.
 *
 * Both are accepted and the slug is stored **verbatim**. The API normalises
 * with trim-and-uppercase at every resolve site, but doing that here would be
 * wrong: this module is not resolving anything, it is caching an assignment
 * Studio already resolved. Upper-casing `amber-001` into `AMBER-001` would
 * store a slug that no longer matches the server's row, and the mismatch
 * would only show up as a 404 on the next join — far from the code that
 * caused it. So a slug that is not already in one of the two canonical forms
 * is rejected, and Studio gets an `INVALID_ARGUMENT` it can act on.
 */
typedef enum {
  ROLL_SLUG_INVALID = 0,
  ROLL_SLUG_SHORT_CODE = 1,
  ROLL_SLUG_REFERENCE = 2,
} roll_slug_form_t;

/** Which form `slug` is in, or `ROLL_SLUG_INVALID`. */
roll_slug_form_t roll_slug_form(const char *slug);

/** True when `roll_slug_form()` recognises `slug`. */
bool roll_slug_valid(const char *slug);

/* ------------------------------------------------------------------ */
/* Membership                                                         */
/* ------------------------------------------------------------------ */

/**
 * Load the stored membership into RAM. Safe to call once at boot; failure
 * means the camera has forgotten which Roll it is on, not that it cannot take
 * pictures.
 */
esp_err_t roll_state_init(void);

/** True when the camera is on a Roll. This is the cheap question the UI asks
 * every frame, so it reads the RAM copy and never touches NVS. */
bool roll_state_active(void);

/** Copy the membership into `out`. Returns false and leaves `out` zeroed when
 * the camera is not on a Roll — matching `RollView.roll === null`. */
bool roll_state_get(roll_state_t *out);

/**
 * Adopt a Roll assignment Studio has already resolved against the API.
 *
 * This is the `PublishedRollJoinRequest` path: `rollId`, `slug`, `guestUrl`,
 * `name` and `role` all come from the server's answer, so the camera's job is
 * to validate the shapes and persist, not to second-guess the values.
 * Validation is strict and returns `ESP_ERR_INVALID_ARG` so the KDP layer can
 * name the offending field:
 *
 *   - `roll_id` non-empty and under ROLL_ID_LEN;
 *   - `slug` in one of the two forms above, stored verbatim;
 *   - `guest_url` an `http://` or `https://` URL under ROLL_GUEST_URL_LEN,
 *     because it is a QR payload and an unusable payload is a QR code that
 *     wastes a guest's time at the party rather than failing here;
 *   - `role` host or guest.
 *
 * `name` may be empty; the display falls back to the slug. `joined_at_ms` is
 * kept only when pure_epoch_plausible() accepts it, and stored as 0 otherwise
 * — an implausible timestamp dates the membership wrongly for every later
 * reboot.
 *
 * Persists immediately. A camera assigned to a Roll and then powered off must
 * still be on it, because the alternative is a camera that leaves the party's
 * Roll every time the battery runs down.
 */
esp_err_t roll_state_assign(const char *roll_id, const char *slug, const char *guest_url,
                            const char *name, roll_role_t role, int64_t joined_at_ms);

/**
 * Forget the Roll membership. Keeps the device credential: the token
 * identifies the camera, not the Roll, and it cannot be re-read from the
 * server — throwing it away on `ROLL_LEAVE` would force a re-registration to
 * join the next Roll. Use roll_state_erase() for the other behaviour.
 *
 * Returns `ESP_ERR_NOT_FOUND` when there was no membership, so `ROLL_LEAVE`
 * can say so rather than claiming a success that removed nothing.
 */
esp_err_t roll_state_leave(void);

/**
 * Wipe membership and credential both. This is the `FACTORY_RESET` door: a
 * camera handed to someone else must not keep the previous owner's Roll or a
 * bearer token that still authorises uploads to it.
 */
esp_err_t roll_state_erase(void);

/* ------------------------------------------------------------------ */
/* Device credential                                                  */
/* ------------------------------------------------------------------ */

/**
 * Store the answer to `POST /api/studio/devices/register`.
 *
 * `device_token` must be `kdt_` followed by 43 base64url characters, which is
 * checked rather than trusted: a truncated token fails every upload with a
 * 401 the contract says not to retry, and finding that out at the party is
 * worse than finding it out here.
 *
 * No caller in this firmware reaches this function yet — see the header
 * comment on why registration needs a radio the camera does not have.
 */
esp_err_t roll_state_set_credential(const char *device_id, const char *device_token);

/** The `deviceId`, which is not secret and goes in every capture document.
 * Returns false when no credential is stored. */
bool roll_state_device_id(char *out, size_t cap);

/** True when a device token is stored. This is the only thing a caller may
 * learn about the token, and it is enough: `ROLL_STATUS` needs to say whether
 * uploading is possible, not what the token is. */
bool roll_state_has_credential(void);

/**
 * Hand the device token to the code that makes the HTTP call.
 *
 * The token is passed to `sink` and the buffer holding it is wiped before
 * this function returns, so it never lives in a caller's frame and cannot be
 * logged by accident. This is the ONLY way out of the store. Build the
 * `Authorization: Bearer` header inside `sink` and do not copy the token
 * anywhere that outlives the callback.
 *
 * Returns `ESP_ERR_NOT_FOUND` when no credential is stored.
 */
esp_err_t roll_state_apply_credential_to(esp_err_t (*sink)(const char *device_id,
                                                           const char *device_token, void *ctx),
                                         void *ctx);

/** Drop the credential and keep the membership. For the case where the server
 * has answered 401: the token is dead, and keeping it only produces more
 * 401s. */
esp_err_t roll_state_clear_credential(void);

#endif /* P4_ROLL_STATE_H */
