/*
 * Host tests for firmware/p4/main/upload_store.c — the UPLOAD.JSON record.
 *
 * These exercise the REAL production functions against the REAL cJSON the
 * firmware links (ESP-IDF's copy, supplied by the Makefile). Nothing here
 * reimplements the encoding: a test that duplicated it would agree with a wrong
 * encoding.
 *
 *   make -C firmware/p4/host_tests test-store    # needs cJSON
 *
 * Only the encode/decode pair is tested, not the file I/O — the split in
 * upload_store.h exists precisely so the part that can be wrong needs no card.
 * Three things are worth a test and they are the three below:
 *
 *   round-trip     a record written by this firmware and read back by it must
 *                  mean the same thing, field for field. Per-frame progress is
 *                  the field whose misreading uploads a frame twice.
 *   corrupt        a record that cannot be trusted must be REFUSED, not
 *                  partially believed. Refusal is what makes reconciliation
 *                  rebuild it; a half-parsed job would resume from a lie.
 *   future version a NEWER formatVersion is refused for the same reason, and
 *                  this is the only place that behaviour is checked before a
 *                  future firmware writes one.
 */
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "upload_store.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...)                          \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      failures++;                                 \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                        \
      printf("\n");                               \
    }                                             \
  } while (0)

static const char *UUID = "3f2b9c11-4d8e-4a71-9f02-77c1de40ab55";

/** A job with every field set to something distinguishable, so a round-trip
 * that drops or crosses a field shows up rather than passing by luck. */
static rq_job_t sample_job(void) {
  rq_job_t j;
  memset(&j, 0, sizeof j);
  snprintf(j.uuid, sizeof j.uuid, "%s", UUID);
  snprintf(j.capture_id, sizeof j.capture_id, "cap_9f0217de");
  snprintf(j.roll_id, sizeof j.roll_id, "roll_2026_08_27_a");
  j.state = RQ_ORIGINALS_UPLOADING;
  j.frame_count = 4;
  j.thumb_present = true;
  j.thumb_done = true;
  j.frame_done[0] = true;
  j.frame_done[1] = false;
  j.frame_done[2] = true;
  j.frame_done[3] = false;
  j.attempts = 3;
  j.reread_attempts = 1;
  j.next_attempt_ms = 1787839331000LL;
  snprintf(j.last_error, sizeof j.last_error, "502 from the asset host");
  return j;
}

/** encode() then decode(), which is the reboot the queue has to survive. */
static bool round_trip(const rq_job_t *in, rq_job_t *out) {
  char *text = upload_store_encode(in);
  if (text == NULL) return false;
  const bool ok = upload_store_decode(text, strlen(text), in->uuid, out);
  cJSON_free(text);
  return ok;
}

/* ------------------------------------------------------------------ */
/* Round-trip                                                          */
/* ------------------------------------------------------------------ */

static void test_round_trip(void) {
  const rq_job_t in = sample_job();
  rq_job_t out;
  memset(&out, 0xAA, sizeof out); /* poisoned, so a field never written shows */
  CHECK(round_trip(&in, &out), "a record we wrote must read back as valid");

  CHECK(strcmp(out.uuid, in.uuid) == 0, "uuid: %s", out.uuid);
  CHECK(strcmp(out.capture_id, in.capture_id) == 0, "captureId: %s", out.capture_id);
  CHECK(strcmp(out.roll_id, in.roll_id) == 0, "rollId: %s", out.roll_id);
  CHECK(strcmp(out.last_error, in.last_error) == 0, "lastError: %s", out.last_error);
  CHECK(out.state == in.state, "state: %d", (int)out.state);
  CHECK(out.frame_count == in.frame_count, "frameCount: %d", out.frame_count);
  CHECK(out.thumb_present == in.thumb_present, "thumbPresent");
  CHECK(out.thumb_done == in.thumb_done, "thumbDone");
  CHECK(out.attempts == in.attempts, "attempts: %u", (unsigned)out.attempts);
  CHECK(out.reread_attempts == in.reread_attempts, "rereadAttempts");
  CHECK(out.next_attempt_ms == in.next_attempt_ms, "nextAttemptMs");
}

/** Per-frame progress, on its own, because this is the field whose misreading
 * costs a duplicate upload. The pattern is deliberately not all-true. */
static void test_round_trip_frame_progress(void) {
  const rq_job_t in = sample_job();
  rq_job_t out;
  CHECK(round_trip(&in, &out), "decode");
  for (int i = 0; i < in.frame_count; i++) {
    CHECK(out.frame_done[i] == in.frame_done[i], "frameDone[%d]", i);
  }
  /* Frames past frameCount are not written and must not come back set. */
  for (int i = in.frame_count; i < RQ_MAX_FRAMES; i++) {
    CHECK(out.frame_done[i] == false, "frameDone[%d] past frameCount", i);
  }
}

/** Every state has to survive the trip. rq_next_step() switches on this value,
 * so a state that decoded to a neighbour would resume in the wrong place. */
static void test_round_trip_every_state(void) {
  for (int st = RQ_QUEUED; st <= RQ_FAILED; st++) {
    rq_job_t in = sample_job();
    in.state = (rq_state_t)st;
    rq_job_t out;
    CHECK(round_trip(&in, &out), "state %d must round-trip", st);
    CHECK(out.state == (rq_state_t)st, "state %d came back as %d", st, (int)out.state);
  }
}

/** The record carries the version it was written with, and the state name for
 * whoever reads the card in a card reader. */
static void test_encoded_shape(void) {
  const rq_job_t in = sample_job();
  char *text = upload_store_encode(&in);
  CHECK(text != NULL, "encode");
  if (text == NULL) return;

  cJSON *j = cJSON_Parse(text);
  CHECK(j != NULL, "our own output must parse");
  const cJSON *ver = cJSON_GetObjectItem(j, "formatVersion");
  CHECK(cJSON_IsNumber(ver) && (int)ver->valuedouble == RQ_FORMAT_VERSION,
        "formatVersion must be written");
  const cJSON *name = cJSON_GetObjectItem(j, "stateName");
  CHECK(cJSON_IsString(name) && strcmp(name->valuestring, rq_state_name(in.state)) == 0,
        "stateName travels beside the number");
  const cJSON *uuid = cJSON_GetObjectItem(j, "captureUuid");
  CHECK(cJSON_IsString(uuid) && strcmp(uuid->valuestring, UUID) == 0, "captureUuid");

  /* The bound in upload_store.h has to hold for a full record, or a
   * legitimately-large job would be refused as "not ours". */
  CHECK(strlen(text) < UPLOAD_STORE_MAX_BYTES, "a full record is %u B, bound is %u",
        (unsigned)strlen(text), (unsigned)UPLOAD_STORE_MAX_BYTES);

  cJSON_Delete(j);
  cJSON_free(text);
}

/* ------------------------------------------------------------------ */
/* Corrupt records                                                     */
/* ------------------------------------------------------------------ */

static void reject(const char *text, const char *why) {
  rq_job_t out;
  memset(&out, 0, sizeof out);
  const size_t len = text != NULL ? strlen(text) : 0;
  CHECK(!upload_store_decode(text, len, UUID, &out), "must be refused: %s", why);
}

static void test_corrupt_records(void) {
  reject("", "empty file");
  reject("{", "truncated object");
  reject("\xff\xfe binary junk", "not JSON at all");
  reject("[1,2,3]", "an array is not a record");
  reject("null", "JSON null");
  reject("{\"captureUuid\":\"x\"}", "no formatVersion");
  reject("{\"formatVersion\":1}", "no state");
  reject("{\"formatVersion\":\"1\",\"state\":0}", "formatVersion as a string");
  reject("{\"formatVersion\":1,\"state\":\"0\"}", "state as a string");
  reject("{\"formatVersion\":1,\"state\":-1}", "state below the enum");
  reject("{\"formatVersion\":1,\"state\":99}", "state above the enum");

  /* A record cut off halfway through the frameDone array. This is the shape a
   * power cut used to be able to leave before the temp-then-rename write, and
   * the one whose partial belief would be worst. */
  reject("{\"formatVersion\":1,\"state\":4,\"frameCount\":4,\"frameDone\":[true,fal",
         "truncated mid-array");
}

static void test_oversized_record(void) {
  /* A file bigger than any record we write is not ours, whatever it contains.
   * Valid JSON, so only the bound can refuse it. */
  static char big[UPLOAD_STORE_MAX_BYTES + 64];
  const int head = snprintf(big, sizeof big, "{\"formatVersion\":1,\"state\":0,\"lastError\":\"");
  size_t i = (size_t)head;
  while (i < sizeof big - 3) big[i++] = 'x';
  big[i++] = '"';
  big[i++] = '}';
  big[i] = '\0';

  rq_job_t out;
  CHECK(!upload_store_decode(big, strlen(big), UUID, &out), "%u B record must be refused",
        (unsigned)strlen(big));
}

static void test_refuses_null_args(void) {
  rq_job_t out;
  const rq_job_t in = sample_job();
  CHECK(!upload_store_decode(NULL, 10, UUID, &out), "NULL text");
  CHECK(!upload_store_decode("{}", 2, NULL, &out), "NULL uuid");
  CHECK(!upload_store_decode("{}", 2, UUID, NULL), "NULL job");
  CHECK(upload_store_encode(NULL) == NULL, "encode(NULL)");
  (void)in;
}

/** A refused record is what makes reconciliation REPAIR the directory, which is
 * how a photograph with an unreadable job file still gets uploaded. That chain
 * is the reason refusal is the right answer, so it is asserted here. */
static void test_refusal_means_repair(void) {
  rq_job_t out;
  const bool valid = upload_store_decode("{oops", 5, UUID, &out);
  CHECK(!valid, "unparseable record");
  CHECK(rq_reconcile_action(true, true, valid, NULL) == RQ_REC_REPAIR,
        "a committed capture with an unreadable record must be rebuilt, not stranded");
}

/* ------------------------------------------------------------------ */
/* Format versions                                                     */
/* ------------------------------------------------------------------ */

static char *record_with_version(int version, char *buf, size_t cap) {
  snprintf(buf, cap,
           "{\"formatVersion\":%d,\"captureUuid\":\"%s\",\"captureId\":\"cap_1\","
           "\"rollId\":\"roll_1\",\"state\":4,\"frameCount\":4,"
           "\"frameDone\":[true,true,false,false],\"thumbPresent\":true,"
           "\"thumbDone\":true,\"attempts\":0,\"rereadAttempts\":0,"
           "\"nextAttemptMs\":0,\"lastError\":\"\"}",
           version, UUID);
  return buf;
}

static void test_future_version_is_refused(void) {
  char buf[512];
  rq_job_t out;
  memset(&out, 0, sizeof out);

  /* The version we write is readable. */
  record_with_version(RQ_FORMAT_VERSION, buf, sizeof buf);
  CHECK(upload_store_decode(buf, strlen(buf), UUID, &out), "the current version must read");
  CHECK(out.frame_done[0] && out.frame_done[1] && !out.frame_done[2],
        "and its per-frame progress must be believed");

  /* The next one is not. Read with today's field names, a newer schema's
   * frameDone would be taken for this one's, and that is the misreading that
   * uploads a frame twice. Rebuilding costs one redundant registration. */
  record_with_version(RQ_FORMAT_VERSION + 1, buf, sizeof buf);
  rq_job_t future;
  memset(&future, 0, sizeof future);
  CHECK(!upload_store_decode(buf, strlen(buf), UUID, &future),
        "formatVersion %d must be refused", RQ_FORMAT_VERSION + 1);
  CHECK(rq_reconcile_action(true, true, false, NULL) == RQ_REC_REPAIR,
        "and a future record must reconcile as REPAIR");

  /* Far future, in case a bump ever skips a number. */
  record_with_version(RQ_FORMAT_VERSION + 100, buf, sizeof buf);
  CHECK(!upload_store_decode(buf, strlen(buf), UUID, &future), "formatVersion +100");
}

/* ------------------------------------------------------------------ */
/* Records that parse but lie                                          */
/* ------------------------------------------------------------------ */

/** frameCount past RQ_MAX_FRAMES is clamped rather than refused: the number is
 * advisory, the files on the card are not, and clamping keeps the read inside
 * frame_done[]. */
static void test_clamps_frame_count(void) {
  char buf[256];
  snprintf(buf, sizeof buf,
           "{\"formatVersion\":1,\"state\":4,\"frameCount\":99,"
           "\"frameDone\":[true,true,true,true,true,true,true,true,true,true,true]}");
  rq_job_t out;
  CHECK(upload_store_decode(buf, strlen(buf), UUID, &out), "decode");
  CHECK(out.frame_count == RQ_MAX_FRAMES, "frameCount clamped to %d, got %d", RQ_MAX_FRAMES,
        out.frame_count);

  snprintf(buf, sizeof buf, "{\"formatVersion\":1,\"state\":0,\"frameCount\":-7}");
  CHECK(upload_store_decode(buf, strlen(buf), UUID, &out), "decode");
  CHECK(out.frame_count == 0, "a negative frameCount reads as 0, got %d", out.frame_count);
}

/** The UUID comes from the directory, never from the file. The directory name is
 * where the bytes are read from, so a captureUuid field that disagreed with it
 * would point the uploader at the wrong capture. */
static void test_uuid_comes_from_the_directory(void) {
  const char *lying = "{\"formatVersion\":1,\"state\":0,"
                      "\"captureUuid\":\"00000000-0000-4000-8000-000000000000\"}";
  rq_job_t out;
  CHECK(upload_store_decode(lying, strlen(lying), UUID, &out), "decode");
  CHECK(strcmp(out.uuid, UUID) == 0, "uuid must be the directory's, got %s", out.uuid);
}

/** Over-long strings are truncated into the fixed fields, not overrun. */
static void test_long_strings_are_bounded(void) {
  char buf[1400];
  char longtext[900];
  memset(longtext, 'e', sizeof longtext - 1);
  longtext[sizeof longtext - 1] = '\0';
  const int n = snprintf(buf, sizeof buf,
                         "{\"formatVersion\":1,\"state\":0,\"lastError\":\"%s\"}", longtext);
  rq_job_t out;
  /* Past the bound, so refused — which is itself the answer we want, and the
   * one that keeps the fixed-size fields out of it. */
  CHECK((size_t)n > UPLOAD_STORE_MAX_BYTES, "the fixture must exceed the bound");
  CHECK(!upload_store_decode(buf, strlen(buf), UUID, &out), "oversized record refused");

  /* Inside the bound, a long-but-legal string is truncated to the field. */
  longtext[200] = '\0';
  snprintf(buf, sizeof buf, "{\"formatVersion\":1,\"state\":0,\"lastError\":\"%s\"}", longtext);
  CHECK(upload_store_decode(buf, strlen(buf), UUID, &out), "decode");
  CHECK(strlen(out.last_error) == RQ_ERROR_LEN - 1, "lastError truncated to the field, got %u",
        (unsigned)strlen(out.last_error));
}

/*
 * A full-width lastError of escape-heavy bytes must still produce a record
 * that reads back.
 *
 * cJSON escapes one control byte as `\u00XX` — six characters for one — so a
 * 95-byte lastError of them is 570 bytes on its own, and with the two ids
 * beside it the record went past UPLOAD_STORE_MAX_BYTES. A record past the
 * bound is one upload_store_decode() refuses, so the job could never be read
 * again: every boot rebuilt it from the card and re-registered its capture.
 * roll_http.c sanitises the text before it becomes an error; this is the
 * encoder's own backstop for every other path into the field.
 */
static void test_escape_heavy_error_still_fits(void) {
  rq_job_t j = sample_job();
  /* 95 bytes, the whole field, each one six characters once escaped. */
  memset(j.last_error, 0x01, sizeof j.last_error - 1);
  j.last_error[sizeof j.last_error - 1] = '\0';
  CHECK(strlen(j.last_error) == RQ_ERROR_LEN - 1, "the fixture fills the field, got %u",
        (unsigned)strlen(j.last_error));

  char *text = upload_store_encode(&j);
  CHECK(text != NULL, "encode");
  if (text == NULL) return;
  const size_t n = strlen(text);
  CHECK(n <= UPLOAD_STORE_MAX_BYTES, "encoded record fits the bound, got %u bytes",
        (unsigned)n);

  /* And it round-trips: everything that decides whether a photograph is
   * uploaded twice is still there. The error text is the one field that gave
   * way, because it is the only one that is a diagnostic. */
  rq_job_t out;
  CHECK(upload_store_decode(text, n, UUID, &out), "the record reads back");
  CHECK(out.state == j.state, "state survives");
  CHECK(out.frame_count == j.frame_count, "frameCount survives");
  CHECK(out.thumb_done == j.thumb_done, "thumbDone survives");
  CHECK(out.frame_done[0] == j.frame_done[0] && out.frame_done[1] == j.frame_done[1],
        "per-frame progress survives");
  CHECK(strcmp(out.capture_id, j.capture_id) == 0, "captureId survives, got %s",
        out.capture_id);
  CHECK(strcmp(out.roll_id, j.roll_id) == 0, "rollId survives, got %s", out.roll_id);
  CHECK(strlen(out.last_error) < strlen(j.last_error),
        "and the error text is what was shortened, got %u bytes",
        (unsigned)strlen(out.last_error));
  cJSON_free(text);
}

int main(void) {
  test_round_trip();
  test_round_trip_frame_progress();
  test_round_trip_every_state();
  test_encoded_shape();

  test_corrupt_records();
  test_oversized_record();
  test_refuses_null_args();
  test_refusal_means_repair();

  test_future_version_is_refused();

  test_clamps_frame_count();
  test_uuid_comes_from_the_directory();
  test_long_strings_are_bounded();
  test_escape_heavy_error_still_fits();

  if (failures != 0) {
    printf("p4 upload store tests: %d of %d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 upload store tests: %d checks passed\n", checks);
  return 0;
}
