/*
 * Host tests for firmware/p4/main/wav_probe.c - the RIFF/WAVE header read
 * that decides whether an uploaded clip can be played by this camera.
 *
 *   make -C firmware/p4/host_tests test-wav      # no dependencies
 *
 * The probe runs on bytes a host sent, so every case here is a header that
 * arrived over the wire rather than one this firmware wrote: truncated,
 * stereo, 44.1 kHz, a LIST chunk in front of the samples, a data chunk that
 * claims more than the file holds. A probe that walked off the end of the
 * buffer on any of them would be a remote read past a heap allocation.
 */
#include <stdio.h>
#include <string.h>

#include "wav_probe.h"

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

/* ---- header builders, the same layout deviceAudio.ts writes ---- */

static void put16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)(v & 0xff);
  p[1] = (uint8_t)(v >> 8);
}
static void put32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xff);
  p[1] = (uint8_t)((v >> 8) & 0xff);
  p[2] = (uint8_t)((v >> 16) & 0xff);
  p[3] = (uint8_t)((v >> 24) & 0xff);
}

/* The canonical 44-byte header, with each field a parameter so a test can
 * move exactly one of them. `data_bytes` is what the header DECLARES, which
 * is not always what follows it. */
static size_t make_header(uint8_t *buf, uint16_t format, uint16_t channels, uint32_t rate,
                          uint16_t bits, uint32_t data_bytes) {
  const uint16_t block = (uint16_t)(channels * (bits / 8));
  memcpy(buf, "RIFF", 4);
  put32(buf + 4, 36 + data_bytes);
  memcpy(buf + 8, "WAVE", 4);
  memcpy(buf + 12, "fmt ", 4);
  put32(buf + 16, 16);
  put16(buf + 20, format);
  put16(buf + 22, channels);
  put32(buf + 24, rate);
  put32(buf + 28, rate * block);
  put16(buf + 32, block);
  put16(buf + 34, bits);
  memcpy(buf + 36, "data", 4);
  put32(buf + 40, data_bytes);
  return 44;
}

/** The shape the camera accepts: 16 kHz mono 16-bit PCM. */
static size_t make_ok(uint8_t *buf, uint32_t data_bytes) {
  return make_header(buf, 1, 1, 16000, 16, data_bytes);
}

/* ------------------------------------------------------------------ */

static void test_accepts_device_format(void) {
  uint8_t buf[44 + 320];
  const uint32_t pcm = 320; /* 160 samples = 10 ms */
  size_t n = make_ok(buf, pcm);
  memset(buf + n, 0, pcm);

  wav_info_t info;
  char why[96];
  CHECK(wav_probe(buf, n + pcm, &info, why, sizeof why), "44-byte header rejected: %s", why);
  CHECK(why[0] == '\0', "clean header left a reason: %s", why);
  CHECK(info.sample_rate == 16000, "sample_rate %u", (unsigned)info.sample_rate);
  CHECK(info.channels == 1, "channels %u", (unsigned)info.channels);
  CHECK(info.bits == 16, "bits %u", (unsigned)info.bits);
  CHECK(info.data_offset == 44, "data_offset %u", (unsigned)info.data_offset);
  CHECK(info.data_bytes == pcm, "data_bytes %u", (unsigned)info.data_bytes);
  /* 320 bytes / 32 bytes per ms */
  CHECK(info.duration_ms == 10, "duration_ms %u", (unsigned)info.duration_ms);
}

static void test_rejects_stereo(void) {
  uint8_t buf[44];
  size_t n = make_header(buf, 1, 2, 16000, 16, 0);
  char why[96];
  CHECK(!wav_probe(buf, n, NULL, why, sizeof why), "stereo accepted");
  CHECK(strcmp(why, "not mono") == 0, "stereo reason: %s", why);
}

static void test_rejects_8_bit(void) {
  uint8_t buf[44];
  size_t n = make_header(buf, 1, 1, 16000, 8, 0);
  char why[96];
  CHECK(!wav_probe(buf, n, NULL, why, sizeof why), "8-bit accepted");
  CHECK(strcmp(why, "not 16-bit PCM") == 0, "8-bit reason: %s", why);
}

static void test_rejects_44100(void) {
  uint8_t buf[44];
  size_t n = make_header(buf, 1, 1, 44100, 16, 0);
  char why[96];
  CHECK(!wav_probe(buf, n, NULL, why, sizeof why), "44100 Hz accepted");
  CHECK(strcmp(why, "sample rate is 44100 Hz, need 16000") == 0, "rate reason: %s", why);
}

static void test_rejects_non_pcm(void) {
  /* Format 3 is IEEE float: the right rate and channel count, samples this
   * playback path cannot read. */
  uint8_t buf[44];
  size_t n = make_header(buf, 3, 1, 16000, 16, 0);
  char why[96];
  CHECK(!wav_probe(buf, n, NULL, why, sizeof why), "float WAV accepted");
  CHECK(why[0] != '\0', "float WAV gave no reason");
}

/* A header cut short at three places: inside the fmt chunk, after it, and one
 * byte short of the data chunk header. None may read past `len`. */
static void test_rejects_truncated(void) {
  uint8_t buf[44];
  make_ok(buf, 4096);
  const size_t cuts[] = {0, 4, 11, 20, 40, 43};
  for (size_t i = 0; i < sizeof cuts / sizeof cuts[0]; i++) {
    wav_info_t info;
    char why[96];
    CHECK(!wav_probe(buf, cuts[i], &info, why, sizeof why), "accepted a %u-byte header",
          (unsigned)cuts[i]);
    CHECK(why[0] != '\0', "%u-byte header gave no reason", (unsigned)cuts[i]);
  }
}

static void test_rejects_wrong_magic(void) {
  uint8_t buf[44];
  make_ok(buf, 0);
  memcpy(buf, "RIFX", 4);
  char why[96];
  CHECK(!wav_probe(buf, 44, NULL, why, sizeof why), "RIFX accepted");
  CHECK(strcmp(why, "not a RIFF/WAVE file") == 0, "magic reason: %s", why);

  make_ok(buf, 0);
  memcpy(buf + 8, "AVI ", 4);
  CHECK(!wav_probe(buf, 44, NULL, why, sizeof why), "RIFF/AVI accepted");
  CHECK(strcmp(why, "not a RIFF/WAVE file") == 0, "form reason: %s", why);
}

static void test_no_data_chunk(void) {
  /* fmt, then a "fact" chunk, then nothing. Everything about the format is
   * right and there are no samples. */
  uint8_t buf[52];
  make_ok(buf, 0);
  memcpy(buf + 36, "fact", 4);
  put32(buf + 40, 4);
  put32(buf + 44, 0);
  char why[96];
  CHECK(!wav_probe(buf, 48, NULL, why, sizeof why), "header with no data chunk accepted");
  CHECK(strcmp(why, "no data chunk") == 0, "no-data reason: %s", why);
}

/* Audacity and ffmpeg both put a LIST/INFO chunk between fmt and data. A
 * probe that assumed data starts at byte 36 would find "LIST" there and call
 * the file unplayable. */
static void test_list_chunk_before_data(void) {
  uint8_t buf[128];
  size_t pos = 0;
  memcpy(buf + 0, "RIFF", 4);
  memcpy(buf + 8, "WAVE", 4);
  memcpy(buf + 12, "fmt ", 4);
  put32(buf + 16, 16);
  put16(buf + 20, 1);
  put16(buf + 22, 1);
  put32(buf + 24, 16000);
  put32(buf + 28, 32000);
  put16(buf + 32, 2);
  put16(buf + 34, 16);
  pos = 36;
  memcpy(buf + pos, "LIST", 4);
  put32(buf + pos + 4, 10); /* odd-ish body, plus the pad byte below */
  memset(buf + pos + 8, 'x', 10);
  pos += 8 + 10;
  memcpy(buf + pos, "data", 4);
  put32(buf + pos + 4, 64);
  const uint32_t data_at = (uint32_t)(pos + 8);
  memset(buf + data_at, 0, 64);
  const size_t total = data_at + 64;
  put32(buf + 4, (uint32_t)total - 8);

  wav_info_t info;
  char why[96];
  CHECK(wav_probe(buf, total, &info, why, sizeof why), "LIST before data rejected: %s", why);
  CHECK(info.data_offset == data_at, "data_offset %u, expected %u", (unsigned)info.data_offset,
        (unsigned)data_at);
  CHECK(info.data_bytes == 64, "data_bytes %u", (unsigned)info.data_bytes);
}

/* An odd LIST body carries a pad byte that its size does not count. Skipping
 * without it lands one byte short and "data" reads as garbage. */
static void test_odd_chunk_is_padded(void) {
  uint8_t buf[128];
  make_ok(buf, 0);
  size_t pos = 36;
  memcpy(buf + pos, "LIST", 4);
  put32(buf + pos + 4, 5);
  memset(buf + pos + 8, 'x', 5);
  buf[pos + 13] = 0; /* the pad */
  pos += 8 + 6;
  memcpy(buf + pos, "data", 4);
  put32(buf + pos + 4, 32);
  const uint32_t data_at = (uint32_t)(pos + 8);
  memset(buf + data_at, 0, 32);

  wav_info_t info;
  char why[96];
  CHECK(wav_probe(buf, data_at + 32, &info, why, sizeof why), "odd LIST body rejected: %s", why);
  CHECK(info.data_offset == data_at, "data_offset %u, expected %u", (unsigned)info.data_offset,
        (unsigned)data_at);
}

/* The firmware probes the first 4 KB of the temp file, so a longer clip
 * always declares more data than the probe was handed. That is normal and
 * must be accepted; the reason says so, and the caller clamps. */
static void test_data_larger_than_buffer(void) {
  uint8_t buf[44 + 16];
  size_t n = make_ok(buf, 65536);
  memset(buf + n, 0, 16);

  wav_info_t info;
  char why[96];
  CHECK(wav_probe(buf, n + 16, &info, why, sizeof why), "over-long data chunk rejected: %s", why);
  CHECK(info.data_bytes == 65536, "data_bytes %u", (unsigned)info.data_bytes);
  CHECK(info.duration_ms == 2048, "duration_ms %u", (unsigned)info.duration_ms);
  CHECK(why[0] != '\0', "over-long data chunk left no note");
}

/* The whole probe runs with no output buffers at all - the SOUND_BEGIN path
 * only wants the verdict. */
static void test_null_outputs(void) {
  uint8_t buf[44];
  make_ok(buf, 0);
  CHECK(wav_probe(buf, 44, NULL, NULL, 0), "probe with no out/why args failed");
  CHECK(!wav_probe(NULL, 0, NULL, NULL, 0), "NULL head accepted");
}

int main(void) {
  test_accepts_device_format();
  test_rejects_stereo();
  test_rejects_8_bit();
  test_rejects_44100();
  test_rejects_non_pcm();
  test_rejects_truncated();
  test_rejects_wrong_magic();
  test_no_data_chunk();
  test_list_chunk_before_data();
  test_odd_chunk_is_padded();
  test_data_larger_than_buffer();
  test_null_outputs();

  if (failures != 0) {
    printf("p4 wav probe tests: %d of %d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 wav probe tests: %d checks passed\n", checks);
  return 0;
}
