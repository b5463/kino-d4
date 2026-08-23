// Host-side contract tests for kdp_core. Fixtures come from
// firmware-contract/kdp-framing.md; the CRC values were independently
// verified against zlib crc32 before this C existed. Build and run:
//   make -C firmware/components/kdp_core/host_tests test
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "kdp/crc32.h"
#include "kdp/decoder.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"

static int checks;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);   \
      return 1;                                                         \
    }                                                                   \
    checks++;                                                           \
  } while (0)

static const char HELLO_JSON[] =
    "{\"protocolMin\":1,\"protocolMax\":1,\"nonce\":1,\"client\":null}";

// Collects decoded frames for assertions.
#define MAX_CAPTURED 8
static struct {
  kdp_frame_t frames[MAX_CAPTURED];
  uint8_t payloads[MAX_CAPTURED][256];
  size_t count;
} cap;

static void reset_capture(void) { cap.count = 0; }

static void on_frame(const kdp_frame_t *f, void *ctx) {
  (void)ctx;
  if (cap.count >= MAX_CAPTURED) return;
  cap.frames[cap.count] = *f;
  if (f->payload_len <= sizeof cap.payloads[0]) {
    memcpy(cap.payloads[cap.count], f->payload, f->payload_len);
    cap.frames[cap.count].payload = cap.payloads[cap.count];
  }
  cap.count++;
}

static size_t make_hello_frame(uint8_t *out, size_t out_cap) {
  return kdp_encode_frame(out, out_cap, KDP_PROTOCOL_VERSION, KDP_CMD_HELLO,
                          KDP_FLAG_NONE, 1, (const uint8_t *)HELLO_JSON,
                          (uint32_t)strlen(HELLO_JSON));
}

static int test_crc_fixtures(void) {
  uint8_t frame[128];
  size_t n = make_hello_frame(frame, sizeof frame);
  CHECK(n == 75);
  CHECK(kdp_crc32(frame, 71) == 0x149bdd86u);
  // Header bytes from the contract's worked example.
  static const uint8_t hello_head[14] = {0x4b, 0x49, 0x01, 0x01, 0x00, 0x00, 0x01,
                                         0x00, 0x00, 0x00, 0x39, 0x00, 0x00, 0x00};
  CHECK(memcmp(frame, hello_head, 14) == 0);
  static const uint8_t hello_crc[4] = {0x86, 0xdd, 0x9b, 0x14};
  CHECK(memcmp(frame + 71, hello_crc, 4) == 0);

  // Minimum-size frame: SAVE_CONFIG, empty payload, sequence 7, 18 bytes.
  static const uint8_t min_frame[18] = {0x4b, 0x49, 0x01, 0x12, 0x00, 0x00,
                                        0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00, 0x00, 0xe4, 0x16, 0xd8, 0x82};
  uint8_t enc[18];
  size_t m = kdp_encode_frame(enc, sizeof enc, KDP_PROTOCOL_VERSION,
                              KDP_CMD_SAVE_CONFIG, KDP_FLAG_NONE, 7, NULL, 0);
  CHECK(m == 18);
  CHECK(memcmp(enc, min_frame, 18) == 0);
  CHECK(kdp_crc32(min_frame, 14) == 0x82d816e4u);
  return 0;
}

static int test_streaming_crc(void) {
  uint8_t frame[128];
  size_t n = make_hello_frame(frame, sizeof frame);

  // Incremental over uneven chunk sizes must equal the one-shot result.
  uint32_t oneshot = kdp_crc32(frame, n);
  uint32_t state = kdp_crc32_begin();
  size_t offset = 0;
  const size_t chunks[] = {1, 7, 13, 2, 64, 128};
  for (size_t i = 0; offset < n; i++) {
    size_t take = chunks[i % 6];
    if (take > n - offset) take = n - offset;
    state = kdp_crc32_update(state, frame + offset, take);
    offset += take;
  }
  CHECK(kdp_crc32_final(state) == oneshot);
  CHECK(kdp_crc32_final(kdp_crc32_begin()) == 0); /* empty input -> CRC 0 */
  return 0;
}

static int test_encoder_limits(void) {
  uint8_t out[64];
  static uint8_t big[KDP_MAX_PAYLOAD + 1];
  CHECK(kdp_encode_frame(out, sizeof out, 1, 1, 0, 1, big, sizeof big) == 0);
  CHECK(kdp_encode_frame(out, 10, 1, 1, 0, 1, NULL, 0) == 0); /* cap too small */
  return 0;
}

static int test_byte_at_a_time(void) {
  uint8_t frame[128];
  size_t n = make_hello_frame(frame, sizeof frame);

  uint8_t buf[KDP_MAX_FRAME];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  reset_capture();
  size_t emitted = 0;
  for (size_t i = 0; i < n; i++) emitted += kdp_decoder_push(&d, frame + i, 1, on_frame, NULL);

  // Contract: one frame, zero resyncs.
  CHECK(emitted == 1);
  CHECK(cap.count == 1);
  CHECK(d.stats.frames == 1);
  CHECK(d.stats.resyncs == 0);
  CHECK(d.stats.crc_failures == 0);
  CHECK(cap.frames[0].type == KDP_CMD_HELLO);
  CHECK(cap.frames[0].seq == 1);
  CHECK(cap.frames[0].payload_len == strlen(HELLO_JSON));
  CHECK(memcmp(cap.frames[0].payload, HELLO_JSON, strlen(HELLO_JSON)) == 0);
  return 0;
}

static int test_boot_spew_and_coalesced(void) {
  uint8_t frame[128];
  size_t n = make_hello_frame(frame, sizeof frame);

  // Contract: 25 bytes of boot spew + two back-to-back copies in a single
  // push yields two frames and one resync.
  uint8_t stream[25 + 2 * 128];
  memcpy(stream, "I (31) boot: ESP-ROM spew", 25);
  memcpy(stream + 25, frame, n);
  memcpy(stream + 25 + n, frame, n);

  uint8_t buf[KDP_MAX_FRAME];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  reset_capture();
  size_t emitted = kdp_decoder_push(&d, stream, 25 + 2 * n, on_frame, NULL);

  CHECK(emitted == 2);
  CHECK(d.stats.frames == 2);
  CHECK(d.stats.resyncs == 1);
  CHECK(d.stats.discarded_bytes == 25);
  return 0;
}

static int test_crc_corruption_resync(void) {
  uint8_t good[128], bad[128];
  size_t n = make_hello_frame(good, sizeof good);
  memcpy(bad, good, n);
  bad[20] ^= 0xFF; /* corrupt payload; CRC now fails */

  uint8_t stream[256];
  memcpy(stream, bad, n);
  memcpy(stream + n, good, n);

  uint8_t buf[KDP_MAX_FRAME];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  reset_capture();
  size_t emitted = kdp_decoder_push(&d, stream, 2 * n, on_frame, NULL);

  // The corrupt frame is dropped, the following good frame still decodes.
  CHECK(emitted == 1);
  CHECK(d.stats.crc_failures == 1);
  CHECK(d.stats.resyncs >= 1);
  CHECK(cap.frames[0].seq == 1);
  return 0;
}

static int test_oversized_length_resync(void) {
  uint8_t junk[18] = {0x4b, 0x49, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
                      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  // Declared payload length 20000 > MAX_PAYLOAD.
  junk[10] = 0x20;
  junk[11] = 0x4e;

  uint8_t good[128];
  size_t n = make_hello_frame(good, sizeof good);

  uint8_t stream[256];
  memcpy(stream, junk, sizeof junk);
  memcpy(stream + sizeof junk, good, n);

  uint8_t buf[KDP_MAX_FRAME];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  reset_capture();
  size_t emitted = kdp_decoder_push(&d, stream, sizeof junk + n, on_frame, NULL);

  // A garbled length must not stall the stream waiting for bytes that will
  // never come.
  CHECK(emitted == 1);
  CHECK(d.stats.resyncs >= 1);
  CHECK(cap.frames[0].type == KDP_CMD_HELLO);
  return 0;
}

static int test_trailing_magic_kept(void) {
  uint8_t frame[128];
  size_t n = make_hello_frame(frame, sizeof frame);

  // Garbage that ends in 'K' — the decoder must keep that byte as the
  // possible first half of a split magic.
  uint8_t part1[6] = {0xde, 0xad, 0xbe, 0xef, 0x00, 0x4b};

  uint8_t buf[KDP_MAX_FRAME];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  reset_capture();
  size_t emitted = kdp_decoder_push(&d, part1, sizeof part1, on_frame, NULL);
  CHECK(emitted == 0);
  // Rest of the frame, without its leading 'K'.
  emitted = kdp_decoder_push(&d, frame + 1, n - 1, on_frame, NULL);
  CHECK(emitted == 1);
  CHECK(cap.frames[0].type == KDP_CMD_HELLO);
  return 0;
}

static int test_split_mid_second_frame(void) {
  uint8_t frame[128];
  size_t n = make_hello_frame(frame, sizeof frame);

  uint8_t stream[256];
  memcpy(stream, frame, n);
  memcpy(stream + n, frame, n);

  uint8_t buf[KDP_MAX_FRAME];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  reset_capture();
  // First push ends mid-way through frame two.
  size_t cut = n + n / 2;
  size_t emitted = kdp_decoder_push(&d, stream, cut, on_frame, NULL);
  CHECK(emitted == 1);
  emitted = kdp_decoder_push(&d, stream + cut, 2 * n - cut, on_frame, NULL);
  CHECK(emitted == 1);
  CHECK(d.stats.frames == 2);
  CHECK(d.stats.resyncs == 0);
  return 0;
}

static int test_empty_payload_frame(void) {
  uint8_t frame[32];
  size_t n = kdp_encode_frame(frame, sizeof frame, KDP_PROTOCOL_VERSION,
                              KDP_CMD_SAVE_CONFIG, KDP_FLAG_NONE, 7, NULL, 0);
  uint8_t buf[KDP_MAX_FRAME];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  reset_capture();
  size_t emitted = kdp_decoder_push(&d, frame, n, on_frame, NULL);
  CHECK(emitted == 1);
  CHECK(cap.frames[0].payload_len == 0);
  CHECK(cap.frames[0].seq == 7);
  return 0;
}

static int test_tiny_buffer_never_stalls(void) {
  // cap < KDP_HEADER_LEN is a misconfiguration; push must still terminate.
  uint8_t frame[128];
  size_t n = make_hello_frame(frame, sizeof frame);
  uint8_t buf[8];
  kdp_decoder_t d;
  kdp_decoder_init(&d, buf, sizeof buf);
  size_t emitted = kdp_decoder_push(&d, frame, n, on_frame, NULL);
  CHECK(emitted == 0); /* nothing decodable, but no hang either */
  return 0;
}

// Sequence 0 is the events' sentinel, so the request counter wraps to 1.
// The host does the same thing in packet.ts; this is the half that has to
// agree with it.
static int test_sequence_wrap(void) {
  CHECK(kdp_next_seq(0) == 1);
  CHECK(kdp_next_seq(1) == 2);
  CHECK(kdp_next_seq(KDP_MAX_SEQ - 1) == KDP_MAX_SEQ);
  CHECK(kdp_next_seq(KDP_MAX_SEQ) == 1);
  return 0;
}

int main(void) {
  if (test_crc_fixtures()) return 1;
  if (test_streaming_crc()) return 1;
  if (test_encoder_limits()) return 1;
  if (test_byte_at_a_time()) return 1;
  if (test_boot_spew_and_coalesced()) return 1;
  if (test_crc_corruption_resync()) return 1;
  if (test_oversized_length_resync()) return 1;
  if (test_trailing_magic_kept()) return 1;
  if (test_split_mid_second_frame()) return 1;
  if (test_empty_payload_frame()) return 1;
  if (test_tiny_buffer_never_stalls()) return 1;
  if (test_sequence_wrap()) return 1;
  printf("kdp_core host tests: %d checks passed\n", checks);
  return 0;
}
