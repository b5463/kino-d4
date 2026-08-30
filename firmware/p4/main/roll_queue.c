/*
 * KINO Roll upload queue logic. See roll_queue.h for the durability model and
 * why this is a separate translation unit from the task that does the I/O.
 *
 * C99, no ESP-IDF, no allocation, no I/O, no globals.
 */
#include "roll_queue.h"

#include <string.h>

#include "pure.h"

/* ------------------------------------------------------------------ */
/* Policy                                                             */
/* ------------------------------------------------------------------ */

uint32_t rq_backoff_ms(uint32_t attempts) {
  if (attempts == 0) return 0;
  /* 1 s doubling. Shift is bounded before it runs: 1u << 31 is already far
   * past the cap, and shifting by >= 32 is undefined rather than large. */
  uint32_t shift = attempts - 1u;
  if (shift >= 16u) return RQ_BACKOFF_CAP_MS;
  uint32_t ms = 1000u << shift;
  return ms > RQ_BACKOFF_CAP_MS ? RQ_BACKOFF_CAP_MS : ms;
}

rq_disposition_t rq_classify_step(int status, bool card_yielded) {
  if (card_yielded) return RQ_DISP_YIELD;
  return rq_classify_status(status);
}

rq_disposition_t rq_classify_status(int status) {
  /* No response at all: DNS, TLS, connect, timeout, or the C6 link dropping
   * mid-request. Always transient — the bytes were never judged. */
  if (status <= 0) return RQ_DISP_RETRY;

  if (status >= 200 && status < 300) return RQ_DISP_OK;

  switch (status) {
    case 401: /* bad or revoked device token */
    case 403: /* DEVICE_NOT_IN_ROLL, or scope refused */
      /* Fails every job identically. Halting keeps the queue intact and
       * actionable instead of walking it into FAILED one job at a time. */
      return RQ_DISP_HALT;

    case 409: /* UPLOAD_IN_PROGRESS — another init is open for this asset */
      return RQ_DISP_RETRY;

    case 422: /* CHECKSUM_MISMATCH — stored object did not re-hash */
      return RQ_DISP_REREAD;

    case 429: /* rate limited; the contract says honour the backoff */
      return RQ_DISP_RETRY;

    case 400: /* malformed capture document — will never be accepted */
    case 404: /* capture or roll gone server-side */
    case 413: /* asset larger than the server accepts */
      return RQ_DISP_PARK;

    default:
      break;
  }

  /* 5xx is the server's problem and is expected to pass. */
  if (status >= 500) return RQ_DISP_RETRY;

  /* Any other 4xx is a contract disagreement, not a transient fault:
   * repeating it produces the same answer. Park rather than loop. */
  if (status >= 400) return RQ_DISP_PARK;

  /* 1xx/3xx: the HTTP client should have resolved these. Treat as transient
   * rather than parking a photograph on a redirect we failed to follow. */
  return RQ_DISP_RETRY;
}

bool rq_retry_due(const rq_job_t *job, int64_t now_ms) {
  if (job == NULL) return false;
  if (job->state != RQ_RETRY_WAIT) return true;
  return now_ms >= job->next_attempt_ms;
}

void rq_job_boot_resume(rq_job_t *job) {
  if (job == NULL) return;
  if (job->state == RQ_RETRY_WAIT) job->next_attempt_ms = 0;
}

void rq_job_network_restored(rq_job_t *job) {
  if (job == NULL) return;
  if (job->state == RQ_RETRY_WAIT) job->next_attempt_ms = 0;
}

/* ------------------------------------------------------------------ */
/* Job lifecycle                                                      */
/* ------------------------------------------------------------------ */

void rq_job_init(rq_job_t *job, const char *uuid, const char *roll_id, int frame_count,
                 bool thumb_present) {
  if (job == NULL) return;
  memset(job, 0, sizeof *job);
  if (uuid != NULL) {
    pure_strcopy(job->uuid, sizeof job->uuid, uuid);
  }
  if (roll_id != NULL) {
    pure_strcopy(job->roll_id, sizeof job->roll_id, roll_id);
  }
  if (frame_count < 0) frame_count = 0;
  if (frame_count > RQ_MAX_FRAMES) frame_count = RQ_MAX_FRAMES;
  job->frame_count = frame_count;
  job->thumb_present = thumb_present;
  job->state = RQ_QUEUED;
}

bool rq_job_settled(const rq_job_t *job) {
  if (job == NULL) return true;
  return job->state == RQ_COMPLETE || job->state == RQ_FAILED;
}

/* First frame, 1-based, that has not been confirmed. 0 when all are done. */
static int first_pending_frame(const rq_job_t *job) {
  for (int i = 0; i < job->frame_count && i < RQ_MAX_FRAMES; i++) {
    if (!job->frame_done[i]) return i + 1;
  }
  return 0;
}

rq_step_t rq_next_step(const rq_job_t *job, int64_t now_ms) {
  rq_step_t step = {RQ_STEP_NOTHING, 0};
  if (job == NULL) return step;

  if (job->state == RQ_COMPLETE || job->state == RQ_FAILED) return step;

  if (job->state == RQ_RETRY_WAIT && !rq_retry_due(job, now_ms)) {
    step.kind = RQ_STEP_WAIT_BACKOFF;
    return step;
  }

  /* From here the decision is made from the completion flags alone, never
   * from the state. That is what makes resume-after-reboot and carry-on the
   * same path: RETRY_WAIT re-enters wherever the flags say it left off, and
   * a state that disagreed with its flags could not strand a photograph. */

  if (job->capture_id[0] == '\0') {
    step.kind = RQ_STEP_REGISTER;
    return step;
  }

  /* Thumb before originals. Not an optimisation: it is what puts a tile on
   * the guest's phone before four full JPEGs travel. */
  if (job->thumb_present && !job->thumb_done) {
    step.kind = RQ_STEP_UPLOAD_THUMB;
    return step;
  }

  int frame = first_pending_frame(job);
  if (frame > 0) {
    step.kind = RQ_STEP_UPLOAD_FRAME;
    step.frame_index = frame;
    return step;
  }

  /* Everything we hold is on the server; tell it so. A capture with no
   * frames at all still gets completed rather than parked — the server
   * decides whether zero frames is `partial` or `failed`, not the camera. */
  step.kind = RQ_STEP_COMPLETE_CAPTURE;
  return step;
}

/* Copy `detail` into the job, truncating. Callers pass rq_redact()ed text. */
static void set_error(rq_job_t *job, const char *detail) {
  if (detail == NULL) {
    job->last_error[0] = '\0';
    return;
  }
  pure_strcopy(job->last_error, sizeof job->last_error, detail);
  job->last_error[sizeof job->last_error - 1] = '\0';
}

/* The state a job sits in while a given step is the next thing to do. Keeps
 * UPLOAD_QUEUE_STATUS and the ROLL screen describing the actual position
 * rather than a generic "uploading". */
static rq_state_t state_for_step(const rq_job_t *job, rq_step_kind_t kind) {
  switch (kind) {
    case RQ_STEP_REGISTER: return RQ_REGISTERING;
    case RQ_STEP_UPLOAD_THUMB: return RQ_THUMB_UPLOADING;
    case RQ_STEP_UPLOAD_FRAME: return RQ_ORIGINALS_UPLOADING;
    case RQ_STEP_COMPLETE_CAPTURE: return RQ_VERIFYING;
    default: return job->state;
  }
}

bool rq_apply(rq_job_t *job, rq_step_t step, rq_disposition_t disp, const char *detail) {
  if (job == NULL) return false;
  if (job->state == RQ_COMPLETE || job->state == RQ_FAILED) return false;

  switch (disp) {
    case RQ_DISP_OK: {
      /* A successful step clears the transient counters: backoff is about
       * consecutive failures, and a job that fails, succeeds, then fails
       * again should not inherit the first failure's delay. */
      job->attempts = 0;
      set_error(job, NULL);

      switch (step.kind) {
        case RQ_STEP_REGISTER:
          /* capture_id is written by the caller from the response body; it is
           * the caller's proof the step landed. Advancing state here without
           * it would loop, which the assertion in the host tests covers. */
          job->state = job->thumb_present ? RQ_THUMB_UPLOADING : RQ_ORIGINALS_UPLOADING;
          break;

        case RQ_STEP_UPLOAD_THUMB:
          job->thumb_done = true;
          job->reread_attempts = 0;
          job->state = RQ_THUMB_READY;
          break;

        case RQ_STEP_UPLOAD_FRAME:
          if (step.frame_index >= 1 && step.frame_index <= RQ_MAX_FRAMES) {
            job->frame_done[step.frame_index - 1] = true;
          }
          job->reread_attempts = 0;
          job->state = RQ_ORIGINALS_UPLOADING;
          break;

        case RQ_STEP_COMPLETE_CAPTURE:
          job->state = RQ_COMPLETE;
          break;

        case RQ_STEP_NOTHING:
        case RQ_STEP_WAIT_BACKOFF:
          return false;
      }
      return true;
    }

    case RQ_DISP_RETRY: {
      job->attempts++;
      set_error(job, detail);
      if (job->attempts >= RQ_MAX_ATTEMPTS) {
        /* Bounded, per the contract: stop hammering. The capture is still on
         * the card and UPLOAD_QUEUE_RETRY can revive it deliberately. */
        job->state = RQ_FAILED;
      } else {
        job->state = RQ_RETRY_WAIT;
      }
      return true;
    }

    case RQ_DISP_YIELD: {
      /* Photography won the card; the upload steps aside and comes back. Not a
       * failure of the network, the server or the file, so `attempts` is not
       * touched - a burst of shutters must not park a photograph. The state is
       * RETRY_WAIT only so the caller can schedule the short wait; the record
       * on the card is not worth rewriting for it. */
      set_error(job, detail);
      job->state = RQ_RETRY_WAIT;
      return false;
    }

    case RQ_DISP_REREAD: {
      /* The server rejected the stored bytes. Re-reading the card is the one
       * thing that can fix that, and it is bounded so a genuinely corrupt
       * file parks instead of looping. Note this does NOT touch `attempts`:
       * a checksum mismatch is not a network failure and must not inherit or
       * contribute to the network backoff. */
      job->reread_attempts++;
      set_error(job, detail);
      if (job->reread_attempts > RQ_MAX_REREADS) {
        job->state = RQ_FAILED;
      } else {
        job->state = RQ_RETRY_WAIT;
        job->next_attempt_ms = 0; /* re-read immediately; nothing to wait for */
      }
      return true;
    }

    case RQ_DISP_PARK:
      set_error(job, detail);
      job->state = RQ_FAILED;
      return true;

    case RQ_DISP_HALT:
      /* The job itself is fine — the device's credentials or association are
       * not. Leave it where it is so it resumes untouched once the fault is
       * fixed; the caller stops the queue. Recording the state the step was
       * at keeps the display honest about where it stopped. */
      set_error(job, detail);
      job->state = state_for_step(job, step.kind);
      return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                     */
/* ------------------------------------------------------------------ */

rq_reconcile_t rq_reconcile_action(bool has_meta, const char *meta_roll_id, bool has_job,
                                   bool job_valid, const rq_job_t *job) {
  /* No META.JSON means the commit was interrupted and this is not yet a
   * capture. storage.c's sweep owns that folder; the queue must not adopt a
   * capture the camera never claimed to have taken. */
  if (!has_meta) return RQ_REC_IGNORE;

  const bool on_roll = meta_roll_id != NULL && meta_roll_id[0] != '\0';

  /* Never queued. Queued now only if the photograph was taken on a Roll -
   * the Roll META names, decided at the shutter. A capture taken off any Roll
   * is a local photograph and stays one, however active a Roll is today. */
  if (!has_job) return on_roll ? RQ_REC_ENQUEUE : RQ_REC_IGNORE;

  /* Unreadable, or written by a format we do not understand. Rebuild rather
   * than ignore when the capture is on a Roll: the photograph is still on the
   * card and the server is idempotent on captureUuid. Off a Roll there is
   * nothing to rebuild toward. */
  if (!job_valid || job == NULL) return on_roll ? RQ_REC_REPAIR : RQ_REC_RETIRE;

  if (job->state == RQ_COMPLETE) return RQ_REC_IGNORE;

  /* The record's Roll must be the capture's Roll. Measured on the bench card:
   * 34 records naming the current Roll beside 102 METAs naming none - every
   * one stamped by an earlier boot, none by a shutter. */
  if (!on_roll || strcmp(job->roll_id, meta_roll_id) != 0) return RQ_REC_RETIRE;

  /* FAILED is resumed, not ignored. A parked job is a job the user can see
   * and retry; leaving it out of the queue would remove the only place that
   * fact is reported. rq_next_step() still returns NOTHING for it, so this
   * costs nothing but visibility. */
  return RQ_REC_RESUME;
}

/* ------------------------------------------------------------------ */
/* Naming and safety                                                  */
/* ------------------------------------------------------------------ */

const char *rq_state_name(rq_state_t state) {
  switch (state) {
    case RQ_QUEUED: return "QUEUED";
    case RQ_REGISTERING: return "REGISTERING";
    case RQ_THUMB_UPLOADING: return "THUMB_UPLOADING";
    case RQ_THUMB_READY: return "THUMB_READY";
    case RQ_ORIGINALS_UPLOADING: return "ORIGINALS_UPLOADING";
    case RQ_VERIFYING: return "VERIFYING";
    case RQ_COMPLETE: return "COMPLETE";
    case RQ_RETRY_WAIT: return "RETRY_WAIT";
    case RQ_FAILED: return "FAILED";
  }
  return "UNKNOWN";
}

/* True for characters that can appear inside a bearer token or a URL. Used to
 * find the end of a secret once its prefix has been recognised. */
static bool token_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' ||
         c == '_' || c == '.' || c == '=' || c == '+' || c == '/' || c == '%';
}

/* Case-insensitive prefix match. */
static bool starts_with_ci(const char *s, const char *prefix) {
  for (size_t i = 0; prefix[i] != '\0'; i++) {
    char a = s[i];
    char b = prefix[i];
    if (a == '\0') return false;
    if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
    if (a != b) return false;
  }
  return true;
}

/* Bytes a UTF-8 sequence starting with `c` must have in total, or 0 when `c`
 * cannot start one. C0/C1 are overlong two-byte forms and F5..FF encode past
 * U+10FFFF, so neither is a lead byte. */
static int utf8_seq_len(unsigned char c) {
  if (c >= 0xc2 && c <= 0xdf) return 2;
  if (c >= 0xe0 && c <= 0xef) return 3;
  if (c >= 0xf0 && c <= 0xf4) return 4;
  return 0;
}

/* The second byte is narrower than 80..BF for four lead bytes: E0 would be an
 * overlong three-byte form below A0, ED would encode a UTF-16 surrogate above
 * 9F, F0 an overlong four-byte form below 90, and F4 a code point past
 * U+10FFFF above 8F. */
static bool utf8_second_ok(unsigned char lead, unsigned char second) {
  if (second < 0x80 || second > 0xbf) return false;
  if (lead == 0xe0) return second >= 0xa0;
  if (lead == 0xed) return second <= 0x9f;
  if (lead == 0xf0) return second >= 0x90;
  if (lead == 0xf4) return second <= 0x8f;
  return true;
}

char *rq_sanitise_detail(char *dst, size_t dst_size, const char *src) {
  if (dst == NULL || dst_size == 0) return dst;
  if (src == NULL) {
    dst[0] = '\0';
    return dst;
  }

  size_t out = 0;
  size_t i = 0;
  while (src[i] != '\0' && out + 1 < dst_size) {
    const unsigned char c = (unsigned char)src[i];

    if (c < 0x20 || c == 0x7f) {
      /* A control byte. One '?' rather than dropping it, so a message that was
       * nothing but control bytes still reads as something arrived. */
      dst[out++] = '?';
      i++;
      continue;
    }
    if (c < 0x80) {
      dst[out++] = src[i++];
      continue;
    }

    const int len = utf8_seq_len(c);
    int have = 1;
    if (len > 0 && utf8_second_ok(c, (unsigned char)src[i + 1])) {
      have = 2;
      /* src[i + have] is at worst the terminator, which fails the range test,
       * so this never reads past the end of the string. */
      while (have < len) {
        const unsigned char cc = (unsigned char)src[i + have];
        if (cc < 0x80 || cc > 0xbf) break;
        have++;
      }
    }
    if (len == 0 || have != len) {
      /* A stray continuation byte, a lead with too few continuations, or an
       * overlong or out-of-range form. One '?' for the offending byte and
       * carry on at the next: the rest of the message is still worth reading.
       */
      dst[out++] = '?';
      i++;
      continue;
    }
    if (out + (size_t)len + 1 > dst_size) {
      /* The whole sequence does not fit. Stopping is the point: half a
       * sequence at the end of the buffer is exactly the invalid UTF-8 this
       * function exists to keep out of a cJSON string. */
      break;
    }
    for (int k = 0; k < len; k++) dst[out++] = src[i++];
  }

  dst[out] = '\0';
  return dst;
}

char *rq_redact(char *dst, size_t dst_size, const char *src) {
  if (dst == NULL || dst_size == 0) return dst;
  if (src == NULL) {
    dst[0] = '\0';
    return dst;
  }

  /* Anything whose prefix marks it as a secret. `kdt_` is the device token
   * (ROLL_DEVICE_CONTRACT.md: "Token is `kdt_` + 43 base64url chars"); the
   * others are the ordinary ways one arrives inside an error string. */
  static const char *const secrets[] = {"kdt_", "bearer ", "authorization: ", "password=",
                                        "token=", "passphrase="};
  static const size_t secret_count = sizeof secrets / sizeof secrets[0];
  static const char redacted[] = "[redacted]";

  size_t out = 0;
  size_t i = 0;
  while (src[i] != '\0' && out + 1 < dst_size) {
    bool matched = false;
    for (size_t s = 0; s < secret_count; s++) {
      if (!starts_with_ci(&src[i], secrets[s])) continue;

      size_t plen = strlen(secrets[s]);
      /* Keep the marker so the message still says what was elided, then
       * swallow the value. For the `kdt_` form the marker IS the prefix, so
       * emitting it would leak nothing but is also useless — emit the
       * placeholder alone and skip the whole run. */
      bool keep_marker = secrets[s][plen - 1] == '=' || secrets[s][plen - 1] == ' ' ||
                         secrets[s][plen - 1] == ':';
      if (keep_marker) {
        for (size_t k = 0; k < plen && out + 1 < dst_size; k++) dst[out++] = src[i + k];
      }
      for (size_t k = 0; k < sizeof redacted - 1 && out + 1 < dst_size; k++) {
        dst[out++] = redacted[k];
      }
      i += plen;
      while (src[i] != '\0' && token_char(src[i])) i++;
      matched = true;
      break;
    }
    if (!matched) dst[out++] = src[i++];
  }

  dst[out] = '\0';
  return dst;
}
