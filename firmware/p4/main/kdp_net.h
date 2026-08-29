/**
 * The `NETWORK_*`, `ROLL_*` and `UPLOAD_*` KDP handlers (0xa0..0xaa).
 *
 * Separate from kdp_server.c for two reasons. That file is already 2100 lines
 * against a 500-line house rule, and — more usefully — building a reply is
 * pure enough to host-test against the real cJSON the device links, the way
 * meta.c is. The wire shapes for this command group live in Studio
 * (`apps/studio/src/roll/rollTypes.ts`) rather than in `@kino/kdp`, so there
 * is no TypeScript contract a compiler can check the firmware against. A host
 * test is the only thing that can.
 *
 * Each handler returns a reply rather than sending one. kdp_server.c owns the
 * transport, the framing and the NACK encoding; this file owns the meaning.
 *
 * ## What answers for real today, and what refuses
 *
 * The C6 is fitted but the P4 has no route to it (`C6_HARDWARE_MAP.md`). That
 * splits this command group in three, and the split is deliberate — a command
 * that can do its job does it, and one that cannot says so:
 *
 *   REAL, no radio needed:
 *     NETWORK_LIST / SET / DELETE   — credentials persist in NVS. Storing a
 *                                     passphrase does not need a radio, and
 *                                     the camera should already know the
 *                                     party's Wi-Fi before it can use it.
 *     NETWORK_STATUS                — reports the true radio state, including
 *                                     the fitted/routed distinction.
 *     ROLL_STATUS                   — real membership, real queue counts.
 *     ROLL_JOIN (published form)    — Studio has internet: it resolves the
 *                                     Roll against the API itself and writes
 *                                     the assignment over USB. See below.
 *     ROLL_LEAVE                    — clears persisted membership.
 *     UPLOAD_ENQUEUE                — writes a durable job to the card.
 *     UPLOAD_QUEUE_STATUS / RETRY   — real queue state.
 *
 *   REFUSES, because it needs the radio:
 *     ROLL_CREATE                   — POST /api/device/rolls
 *     ROLL_JOIN (slug-only form)    — POST /api/device/rolls/join, which
 *                                     resolves a slug the camera cannot
 *                                     resolve itself.
 *
 * Refusals carry `NETWORK_UNAVAILABLE` and a message naming the actual reason
 * from net_link, so Studio can tell "no route to the C6" from "wrong
 * passphrase". Failing closed with a reason is the contract; pretending
 * success is the one thing that is not allowed.
 *
 * ## Why ROLL_JOIN works without a radio
 *
 * `PublishedRollJoinRequest` in rollTypes.ts is documented as a
 * "Server-published Roll assignment written to the camera over ROLL_JOIN": it
 * carries `slug`, `rollId`, `guestUrl`, `name`, `role` and `uploadScope`
 * already resolved. Studio is the party with an internet connection, so it can
 * create or look up the Roll and hand the camera the answer. The camera
 * persists it, shows the QR from `guestUrl`, and queues captures against it.
 *
 * That is most of the product working over USB while the radio question is
 * still open — the camera holds a real Roll, guests can join it by QR, and the
 * queue fills durably. Only the upload itself waits for the transport.
 */
#ifndef P4_KDP_NET_H
#define P4_KDP_NET_H

#include <stdbool.h>

#include "cJSON.h"

/** Longest NACK message a handler produces. */
#define KDP_NET_MSG_LEN 128

/**
 * One handler's answer. Exactly one of `json` and `code` is set.
 *
 * `json` ownership transfers to the caller, which must `cJSON_Delete` it or
 * hand it to `send_json()` (which deletes it). A handler that fails never
 * allocates, so there is nothing to leak on the error path.
 */
typedef struct {
  bool ok;
  cJSON *json;                   /* response body when ok */
  const char *code;              /* NACK code when !ok; a string literal */
  char message[KDP_NET_MSG_LEN]; /* NACK message when !ok */
} kdp_net_reply_t;

/* Network. `req` may be NULL for the commands that take no arguments. */
/* `{ "scan": true }` runs one bounded scan on the radio before answering and
 * adds `available[]` to the reply. Without it the reply is unchanged. */
kdp_net_reply_t kdp_net_list(const cJSON *req);
kdp_net_reply_t kdp_net_set(const cJSON *req);
kdp_net_reply_t kdp_net_delete(const cJSON *req);
kdp_net_reply_t kdp_net_status(void);

/* Roll. */
kdp_net_reply_t kdp_net_roll_status(void);
kdp_net_reply_t kdp_net_roll_create(const cJSON *req);
kdp_net_reply_t kdp_net_roll_join(const cJSON *req);
kdp_net_reply_t kdp_net_roll_leave(void);

/* Upload queue. */
kdp_net_reply_t kdp_net_upload_status(void);
kdp_net_reply_t kdp_net_upload_retry(void);
kdp_net_reply_t kdp_net_upload_enqueue(const cJSON *req);

#endif /* P4_KDP_NET_H */
