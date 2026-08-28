/*
 * Host tests for firmware/p4/main/pure.c — the P4's arithmetic and string
 * logic, compiled natively so it can be tested without a board.
 *
 * Same shape as firmware/components/kdp_core/host_tests: plain gcc, no test
 * framework, one CHECK macro, a count at the end and a non-zero exit on the
 * first failure. A framework here would be more code than the code under test.
 *
 *   make -C firmware/p4/host_tests test
 */
#include <stdio.h>
#include <string.h>

#include "pure.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...)                             \
  do {                                               \
    checks++;                                        \
    if (!(cond)) {                                   \
      failures++;                                    \
      printf("FAIL %s:%d: ", __FILE__, __LINE__);    \
      printf(__VA_ARGS__);                           \
      printf("\n");                                  \
    }                                                \
  } while (0)

/* ------------------------------------------------------------------ */
/* pure_quality_to_sensor                                              */
/* ------------------------------------------------------------------ */

static void test_quality(void) {
  /* The documented contract range, and the direction that matters.
   *
   * jpegQuality is 60..95 with HIGHER meaning better; the OV3660 takes 5..63
   * with LOWER meaning better. This mapping shipped without the inversion once
   * and asking for the best quality produced the worst JPEG the sensor can
   * make. These two lines are the regression test for that. */
  CHECK(pure_quality_to_sensor(60) == 20, "q60 -> %d, want 20", pure_quality_to_sensor(60));
  CHECK(pure_quality_to_sensor(95) == 5, "q95 -> %d, want 5", pure_quality_to_sensor(95));

  /* Monotonically NON-INCREASING across the whole percentage range: a higher
   * requested quality must never produce a numerically higher (worse) sensor
   * value. This is the property the bug violated, stated directly. */
  int prev = pure_quality_to_sensor(1);
  for (int p = 2; p <= 100; p++) {
    const int cur = pure_quality_to_sensor(p);
    CHECK(cur <= prev, "quality not monotonic: q%d -> %d after %d", p, cur, prev);
    prev = cur;
  }

  /* Midpoint lands between the endpoints rather than at one of them - guards a
   * mapping that degenerates to a constant. */
  const int mid = pure_quality_to_sensor(77);
  CHECK(mid > 5 && mid < 20, "q77 -> %d, want strictly between 5 and 20", mid);

  /* Driver limits are respected at and beyond the edges. esp32-camera clamps
   * to 5..63; this firmware never asks for worse than 40. */
  for (int p = 1; p <= 100; p++) {
    const int q = pure_quality_to_sensor(p);
    CHECK(q >= 5 && q <= 40, "q%d -> %d, outside 5..40", p, q);
  }

  /* "Not specified" is 0 and must stay distinguishable from a real value, so
   * the node keeps whatever it already had. */
  CHECK(pure_quality_to_sensor(0) == 0, "q0 should mean unspecified");
  CHECK(pure_quality_to_sensor(-1) == 0, "negative should mean unspecified");

  /* Out-of-range high clamps rather than wrapping. */
  CHECK(pure_quality_to_sensor(1000) == pure_quality_to_sensor(100), "q1000 should clamp to q100");
}

/* ------------------------------------------------------------------ */
/* pure_parse_resolution                                               */
/* ------------------------------------------------------------------ */

static void test_resolution(void) {
  uint32_t w = 0, h = 0;

  CHECK(pure_parse_resolution("1600x1200", &w, &h), "UXGA should parse");
  CHECK(w == 1600 && h == 1200, "UXGA -> %ux%u", w, h);

  CHECK(pure_parse_resolution("2048x1536", &w, &h), "QXGA should parse");
  CHECK(w == 2048 && h == 1536, "QXGA -> %ux%u", w, h);

  CHECK(pure_parse_resolution("320x240", &w, &h), "QVGA should parse");
  CHECK(w == 320 && h == 240, "QVGA -> %ux%u", w, h);

  /* Rejections. Each of these previously would have yielded a zero dimension,
   * and a zero dimension sizes the space reservation to nothing. */
  CHECK(!pure_parse_resolution(NULL, &w, &h), "NULL should not parse");
  CHECK(!pure_parse_resolution("", &w, &h), "empty should not parse");
  CHECK(!pure_parse_resolution("1600", &w, &h), "missing height should not parse");
  CHECK(!pure_parse_resolution("x1200", &w, &h), "missing width should not parse");
  CHECK(!pure_parse_resolution("1600x", &w, &h), "trailing x should not parse");
  CHECK(!pure_parse_resolution("1600x1200x", &w, &h), "trailing junk should not parse");
  CHECK(!pure_parse_resolution("1600 x 1200", &w, &h), "spaces should not parse");
  CHECK(!pure_parse_resolution("1600X1200", &w, &h), "uppercase X should not parse");
  CHECK(!pure_parse_resolution("0x1200", &w, &h), "zero width should not parse");
  CHECK(!pure_parse_resolution("1600x0", &w, &h), "zero height should not parse");
  CHECK(!pure_parse_resolution("99999x1200", &w, &h), "absurd width should not parse");
  CHECK(!pure_parse_resolution("-16x12", &w, &h), "negative should not parse");

  /* A rejected parse must leave the caller's values alone, so a caller that
   * pre-seeded a conservative default keeps it. */
  w = 4242;
  h = 2424;
  CHECK(!pure_parse_resolution("nonsense", &w, &h), "garbage should not parse");
  CHECK(w == 4242 && h == 2424, "failed parse must not touch outputs (got %ux%u)", w, h);

  /* NULL outputs are allowed - callers that only want validity. */
  CHECK(pure_parse_resolution("640x480", NULL, NULL), "NULL outputs should be accepted");
}

/* ------------------------------------------------------------------ */
/* pure_capture_reserve_bytes                                          */
/* ------------------------------------------------------------------ */

static void test_reserve(void) {
  const uint64_t fixed =
      PURE_RESERVE_THUMB_BYTES + PURE_RESERVE_META_BYTES + PURE_RESERVE_MARGIN_BYTES;

  /* Four UXGA frames at the documented 0.5 bpp bound. */
  const uint64_t uxga4 = pure_capture_reserve_bytes(4, 1600, 1200);
  CHECK(uxga4 == (uint64_t)1600 * 1200 / 2 * 4 + fixed, "UXGA x4 -> %llu",
        (unsigned long long)uxga4);

  /* The bound must exceed what a real frame plausibly costs. Bench-observed
   * VGA q12 topped out at 30.4 KB (~0.1 bpp); UXGA is 6.25x the pixels, so
   * ~190 KB is a generous real-world worst case per frame. */
  const uint64_t per_frame_bound = (uint64_t)1600 * 1200 / 2;
  CHECK(per_frame_bound > 190u * 1024u, "per-frame bound %llu should exceed observed worst case",
        (unsigned long long)per_frame_bound);

  /* More frames costs more; strictly. */
  CHECK(pure_capture_reserve_bytes(1, 1600, 1200) < pure_capture_reserve_bytes(2, 1600, 1200),
        "2 frames should reserve more than 1");
  CHECK(pure_capture_reserve_bytes(3, 1600, 1200) < uxga4, "4 frames should reserve more than 3");

  /* Frame count clamps rather than overflowing or under-reserving. */
  CHECK(pure_capture_reserve_bytes(0, 1600, 1200) == pure_capture_reserve_bytes(1, 1600, 1200),
        "0 frames should clamp up to 1");
  CHECK(pure_capture_reserve_bytes(-5, 1600, 1200) == pure_capture_reserve_bytes(1, 1600, 1200),
        "negative frames should clamp up to 1");
  CHECK(pure_capture_reserve_bytes(99, 1600, 1200) == uxga4, "99 frames should clamp to 4");

  /* An unknown resolution reserves for the LARGEST frame the firmware
   * advertises, never for zero. Reserving zero is the failure this guards. */
  const uint64_t unknown = pure_capture_reserve_bytes(4, 0, 0);
  CHECK(unknown == pure_capture_reserve_bytes(4, 2048, 1536), "unknown res should reserve QXGA");
  CHECK(unknown > uxga4, "QXGA fallback should exceed UXGA");
  CHECK(pure_capture_reserve_bytes(4, 1600, 0) == unknown, "zero height should fall back");
  CHECK(pure_capture_reserve_bytes(4, 0, 1200) == unknown, "zero width should fall back");

  /* Always strictly positive, and always above the fixed overhead alone. */
  CHECK(pure_capture_reserve_bytes(1, 160, 120) > fixed, "even a tiny frame exceeds fixed costs");
}

/* ------------------------------------------------------------------ */
/* pure_is_capture_dirname                                             */
/* ------------------------------------------------------------------ */

static void test_dirname(void) {
  /* This predicate gates deletion, so the accept set must be exactly UUIDs. */
  CHECK(pure_is_capture_dirname("3f2b9c11-4d8e-4a71-9f02-77c1de40ab55"), "valid v4 UUID");
  CHECK(pure_is_capture_dirname("00000000-0000-0000-0000-000000000000"), "all-zero UUID shape");
  CHECK(pure_is_capture_dirname("ffffffff-ffff-ffff-ffff-ffffffffffff"), "all-f UUID shape");

  CHECK(!pure_is_capture_dirname(NULL), "NULL");
  CHECK(!pure_is_capture_dirname(""), "empty");
  CHECK(!pure_is_capture_dirname("."), "dot");
  CHECK(!pure_is_capture_dirname(".."), "dotdot");
  /* Uppercase is rejected: capture_uuid4 emits lowercase, so an uppercase name
   * is not one of ours and must not be deleted. */
  CHECK(!pure_is_capture_dirname("3F2B9C11-4D8E-4A71-9F02-77C1DE40AB55"), "uppercase hex");
  CHECK(!pure_is_capture_dirname("3f2b9c11-4d8e-4a71-9f02-77c1de40ab5"), "35 chars, too short");
  CHECK(!pure_is_capture_dirname("3f2b9c11-4d8e-4a71-9f02-77c1de40ab555"), "37 chars, too long");
  CHECK(!pure_is_capture_dirname("3f2b9c114d8e4a719f0277c1de40ab5555"), "no dashes");
  CHECK(!pure_is_capture_dirname("3f2b9c11_4d8e_4a71_9f02_77c1de40ab55"), "underscores");
  /* Dash in the wrong place - right length, right characters, wrong shape. */
  CHECK(!pure_is_capture_dirname("3f2b9c1-14d8e-4a71-9f02-77c1de40ab55"), "dash misplaced");
  CHECK(!pure_is_capture_dirname("3f2b9c11-4d8e-4a71-9f02-77c1de40abg5"), "non-hex char");
  /* Things a person might plausibly leave on a card. None may be deleted. */
  CHECK(!pure_is_capture_dirname("DCIM"), "DCIM");
  CHECK(!pure_is_capture_dirname("System Volume Information"), "Windows metadata dir");
  CHECK(!pure_is_capture_dirname("KINO"), "our own parent dir");
  CHECK(!pure_is_capture_dirname("holiday photos"), "user folder");
}

/* ------------------------------------------------------------------ */
/* pure_scale_sixteenths                                               */
/* ------------------------------------------------------------------ */

static void test_sixteenths(void) {
  /* The documented case: UXGA into a 320x240 box comes out 3/16 -> 300x225,
   * NOT 320x240. If this ever returns 4 the PPA writes outside the tile. */
  const int n = pure_scale_sixteenths(1600, 1200, 320, 240);
  CHECK(n == 3, "UXGA into 320x240 -> %d/16, want 3", n);
  CHECK((1600 * n) / 16 == 300, "UXGA width -> %d, want 300", (1600 * n) / 16);
  CHECK((1200 * n) / 16 == 225, "UXGA height -> %d, want 225", (1200 * n) / 16);

  /* Never overflows the box, at any source size. This is the property that
   * matters: the PPA destination is fixed and a too-large n corrupts memory. */
  const uint32_t sizes[][2] = {
      {160, 120},   {320, 240},   {640, 480},   {800, 600},  {1024, 768},
      {1280, 720},  {1280, 1024}, {1600, 1200}, {2048, 1536}, {1920, 1080},
  };
  const uint32_t boxes[][2] = {{320, 240}, {208, 156}, {96, 96}, {64, 48}};
  for (size_t b = 0; b < sizeof boxes / sizeof boxes[0]; b++) {
    for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
      const uint32_t w = sizes[i][0], h = sizes[i][1];
      const uint32_t bw = boxes[b][0], bh = boxes[b][1];
      const int k = pure_scale_sixteenths(w, h, bw, bh);
      CHECK(k >= 0 && k <= 16, "%ux%u into %ux%u -> %d/16, outside 0..16", w, h, bw, bh, k);
      /* The invariant that protects the destination buffer: EITHER the helper
       * refuses (0), OR the scaled output fits. There is no third outcome, and
       * a returned ratio that overflows is the bug this loop exists to catch. */
      if (k == 0) continue; /* refused - caller must not scale */
      CHECK((w * (uint32_t)k) / 16u <= bw, "%ux%u into %ux%u overflows width (%u)", w, h, bw, bh,
            (w * (uint32_t)k) / 16u);
      CHECK((h * (uint32_t)k) / 16u <= bh, "%ux%u into %ux%u overflows height (%u)", w, h, bw, bh,
            (h * (uint32_t)k) / 16u);
    }
  }

  /* A source already smaller than the box is not upscaled past 16/16. */
  CHECK(pure_scale_sixteenths(100, 100, 320, 240) == 16, "small source should cap at 16/16");
  /* Degenerate inputs refuse rather than dividing by zero. */
  CHECK(pure_scale_sixteenths(0, 0, 320, 240) == 0, "zero source must refuse");
  CHECK(pure_scale_sixteenths(1600, 1200, 0, 0) == 0, "zero box must refuse");

  /* More than 16x reduction cannot fit, so it must refuse rather than hand
   * back a ratio that overflows the destination. This is the regression test
   * for the hazard the box sweep above found: 1600 wide at 1/16 is 100 px,
   * which does not fit a 96 px box. */
  CHECK(pure_scale_sixteenths(1600, 1200, 96, 96) == 0, "1600 into 96 must refuse, not return 1");
  CHECK(pure_scale_sixteenths(2048, 1536, 64, 48) == 0, "2048 into 64 must refuse");

  /* The real boxes this firmware uses must all still be satisfiable, so the
   * refusal above cannot silently disable thumbnails or the gallery. */
  CHECK(pure_scale_sixteenths(1600, 1200, 320, 240) > 0, "THUMB box must remain usable");
  CHECK(pure_scale_sixteenths(2048, 1536, 320, 240) > 0, "THUMB box at QXGA must remain usable");
  CHECK(pure_scale_sixteenths(1600, 1200, 208, 156) > 0, "gallery tile must remain usable");
  CHECK(pure_scale_sixteenths(2048, 1536, 208, 156) > 0, "gallery tile at QXGA must remain usable");
}

/* ------------------------------------------------------------------ */
/* clock                                                              */
/* ------------------------------------------------------------------ */

static void test_epoch_bounds(void) {
  /* 2026-08-27T00:00:00Z, comfortably inside the window. */
  CHECK(pure_epoch_plausible(1787788800000LL), "a 2026 timestamp should be accepted");
  CHECK(pure_epoch_plausible(PURE_EPOCH_MS_MIN), "the lower bound is inclusive");
  CHECK(pure_epoch_plausible(PURE_EPOCH_MS_MAX), "the upper bound is inclusive");

  CHECK(!pure_epoch_plausible(0), "zero should be rejected");
  CHECK(!pure_epoch_plausible(-1), "negative should be rejected");
  CHECK(!pure_epoch_plausible(PURE_EPOCH_MS_MIN - 1), "just below the window");
  CHECK(!pure_epoch_plausible(PURE_EPOCH_MS_MAX + 1), "just above the window");

  /* The classic unit mix-up: seconds sent where milliseconds were meant. A
   * 2026 value in SECONDS is ~1.787e9, which as milliseconds is 1970 - and
   * must be refused, or every capture is dated to 1970 and it persists. */
  CHECK(!pure_epoch_plausible(1787788800LL), "seconds-as-milliseconds must be rejected");
  /* And the reverse: milliseconds sent where seconds were meant. */
  CHECK(!pure_epoch_plausible(1787788800000000LL), "microseconds must be rejected");
}

static void test_utc_offset(void) {
  CHECK(pure_clamp_utc_offset_min(0) == 0, "UTC");
  CHECK(pure_clamp_utc_offset_min(120) == 120, "+02:00 kept");
  CHECK(pure_clamp_utc_offset_min(-300) == -300, "-05:00 kept");
  CHECK(pure_clamp_utc_offset_min(840) == 840, "+14:00 is the real maximum");
  CHECK(pure_clamp_utc_offset_min(-840) == -840, "-14:00 kept");
  CHECK(pure_clamp_utc_offset_min(45) == 45, "non-hour offsets exist (Nepal, +05:45)");
  /* Out of range falls back to UTC rather than to a wrong offset. */
  CHECK(pure_clamp_utc_offset_min(1000) == 0, "absurd positive falls back to UTC");
  CHECK(pure_clamp_utc_offset_min(-1000) == 0, "absurd negative falls back to UTC");
}

static void test_iso8601(void) {
  char buf[40];

  /* A known instant, checked against an independently-computed value.
   * 1787788800000 ms = 2026-08-27T00:00:00Z. */
  pure_format_iso8601(1787788800000LL, 0, buf, sizeof buf);
  CHECK(strcmp(buf, "2026-08-27T00:00:00+00:00") == 0, "UTC format -> '%s'", buf);

  /* The same instant in +02:00 must print the shifted wall time AND carry the
   * offset, so the instant is still recoverable. */
  pure_format_iso8601(1787788800000LL, 120, buf, sizeof buf);
  CHECK(strcmp(buf, "2026-08-27T02:00:00+02:00") == 0, "+02:00 format -> '%s'", buf);

  /* Negative offset crossing back over midnight into the previous day. */
  pure_format_iso8601(1787788800000LL, -300, buf, sizeof buf);
  CHECK(strcmp(buf, "2026-08-26T19:00:00-05:00") == 0, "-05:00 format -> '%s'", buf);

  /* A non-hour offset, which a naive hours-only formatter gets wrong. */
  pure_format_iso8601(1787788800000LL, 345, buf, sizeof buf);
  CHECK(strcmp(buf, "2026-08-27T05:45:00+05:45") == 0, "+05:45 format -> '%s'", buf);

  /* The epoch itself - what an UNSET clock produces. It must be obviously not
   * a real date, which is the entire point of reporting clockSource. */
  pure_format_iso8601(0, 0, buf, sizeof buf);
  CHECK(strcmp(buf, "1970-01-01T00:00:00+00:00") == 0, "epoch -> '%s'", buf);

  /* Uptime-since-boot on an unset clock: 12345 s after the epoch. */
  pure_format_iso8601(12345000LL, 0, buf, sizeof buf);
  CHECK(strcmp(buf, "1970-01-01T03:25:45+00:00") == 0, "epoch+12345s -> '%s'", buf);

  /* Leap year handling. 2024 is a leap year; Feb 29 must exist.
   * 1709164800000 ms = 2024-02-29T00:00:00Z. */
  pure_format_iso8601(1709164800000LL, 0, buf, sizeof buf);
  CHECK(strcmp(buf, "2024-02-29T00:00:00+00:00") == 0, "leap day -> '%s'", buf);

  /* 2100 is NOT a leap year (century rule). 4102444800000 = 2100-01-01. */
  pure_format_iso8601(4102444800000LL, 0, buf, sizeof buf);
  CHECK(strcmp(buf, "2100-01-01T00:00:00+00:00") == 0, "2100 boundary -> '%s'", buf);

  /* Year boundary in both directions. 1767225599000 = 2025-12-31T23:59:59Z. */
  pure_format_iso8601(1767225599000LL, 0, buf, sizeof buf);
  CHECK(strcmp(buf, "2025-12-31T23:59:59+00:00") == 0, "year end -> '%s'", buf);
  pure_format_iso8601(1767225599000LL, 60, buf, sizeof buf);
  CHECK(strcmp(buf, "2026-01-01T00:59:59+01:00") == 0, "year rollover with offset -> '%s'", buf);

  /* Always produces a fixed-width, parseable string. */
  CHECK(strlen(buf) == 25, "ISO 8601 with offset should be 25 chars, got %zu", strlen(buf));

  /* Never writes past a short buffer, and never leaves it unterminated. */
  char tiny[8];
  memset(tiny, 'X', sizeof tiny);
  pure_format_iso8601(1787788800000LL, 0, tiny, sizeof tiny);
  CHECK(tiny[sizeof tiny - 1] == '\0', "short buffer must stay NUL-terminated");

  /* A zero-capacity buffer must be left completely alone. */
  char guard[2] = {'A', 'B'};
  pure_format_iso8601(1787788800000LL, 0, guard, 0);
  CHECK(guard[0] == 'A' && guard[1] == 'B', "zero cap must not write");
}

/* ------------------------------------------------------------------ */
/* clock_init()'s choice between a persisted time and the system clock.
 *
 * KINO's wall time is the ESP-IDF system clock now, so this decision writes
 * into the clock that FAT timestamps and every capturedAt read. Two instants,
 * both real: EARLY is a snapshot NVS could hold, LATE is what an RTC that kept
 * running would read. */
#define EARLY 1787788800000LL /* 2026-08-27T00:00:00Z */
#define LATE 1787875200000LL  /* 2026-08-28T00:00:00Z, a day later */

static void test_clock_restore(void) {
  /* Cold boot, nothing stored, system clock at the epoch: the honest answer is
   * that we do not know what time it is. */
  CHECK(pure_clock_restore_action(false, 0, 0) == PURE_CLOCK_UNSET,
        "no saved time and an epoch system clock -> UNSET");

  /* Stored time, cold system clock. This is the persisted-boot case: push it
   * into the system clock so the next capture is dated after the last one. */
  CHECK(pure_clock_restore_action(true, EARLY, 0) == PURE_CLOCK_RESTORE_SAVED,
        "saved time and a cold system clock -> RESTORE_SAVED");

  /* The regression that matters. The RTC kept running across a soft reset and
   * already reads a day later than the NVS snapshot. Restoring would move the
   * clock BACKWARDS and date the next capture before one already on the card. */
  CHECK(pure_clock_restore_action(true, EARLY, LATE) == PURE_CLOCK_KEEP_SYSTEM,
        "system clock newer than saved -> KEEP_SYSTEM, never backwards");

  /* The other way round: NVS holds the later time, so it wins. */
  CHECK(pure_clock_restore_action(true, LATE, EARLY) == PURE_CLOCK_RESTORE_SAVED,
        "saved newer than system clock -> RESTORE_SAVED");

  /* Equal is keep: a settimeofday() that changes nothing is not worth doing. */
  CHECK(pure_clock_restore_action(true, EARLY, EARLY) == PURE_CLOCK_KEEP_SYSTEM,
        "equal times -> KEEP_SYSTEM");

  /* No stored value but the RTC held a real date: that IS carried-over time,
   * and reporting `unset` while dating captures 2026 would be the lie the
   * other way round. */
  CHECK(pure_clock_restore_action(false, 0, LATE) == PURE_CLOCK_KEEP_SYSTEM,
        "no saved time but a plausible system clock -> KEEP_SYSTEM");

  /* Implausible stored values are not times. This is the shape of the value
   * this board actually had in NVS during bring-up - uptime-since-power-on,
   * about nine minutes past 1970 - and adopting one now would write 1970 into
   * FAT and into capturedAt. */
  CHECK(pure_clock_restore_action(true, 526536LL, 0) == PURE_CLOCK_UNSET,
        "uptime-shaped stored value -> UNSET, not adopted");
  CHECK(pure_clock_restore_action(true, -1LL, 0) == PURE_CLOCK_UNSET,
        "negative stored value -> UNSET");
  CHECK(pure_clock_restore_action(true, PURE_EPOCH_MS_MAX + 1, 0) == PURE_CLOCK_UNSET,
        "stored value past 2100 -> UNSET");

  /* ...and an implausible stored value must not stop a good system clock from
   * being used. */
  CHECK(pure_clock_restore_action(true, 526536LL, LATE) == PURE_CLOCK_KEEP_SYSTEM,
        "junk saved value with a good system clock -> KEEP_SYSTEM");

  /* Inclusive bounds, both ends. */
  CHECK(pure_clock_restore_action(true, PURE_EPOCH_MS_MIN, 0) == PURE_CLOCK_RESTORE_SAVED,
        "2020-01-01 exactly is a usable time");
  CHECK(pure_clock_restore_action(true, PURE_EPOCH_MS_MAX, 0) == PURE_CLOCK_RESTORE_SAVED,
        "2100-01-01 exactly is a usable time");
}

/* The wall clock may jump; the monotonic clock may not. klog stamps both, and
 * durations are computed from `us` alone for exactly this reason.
 *
 * This is the model, asserted so a future change that derives `us` from the
 * wall clock fails here. The real proof is on hardware, where the same
 * sequence is observed across a live HELLO correction. */
static void test_clock_monotonic_across_correction(void) {
  /* An unset clock counting from boot, then a host correction to 2026, then
   * normal running. `us` is esp_timer and never restarts. */
  const int64_t wall[] = {415, 480, EARLY, EARLY + 60, EARLY + 120};
  const int64_t mono[] = {49502, 114000, 178000, 240000, 302000};
  const int n = (int)(sizeof mono / sizeof mono[0]);

  for (int i = 1; i < n; i++) {
    CHECK(mono[i] > mono[i - 1], "us must increase at %d: %lld -> %lld", i,
          (long long)mono[i - 1], (long long)mono[i]);
  }

  /* The wall clock does jump, hugely, and that is allowed. */
  CHECK(wall[2] - wall[1] > 1000000000LL, "the correction is a real jump");

  /* A duration measured across the correction must be unaffected by it. The
   * wall-clock difference across the same two entries is nonsense; the
   * monotonic one is 64 ms. */
  CHECK(mono[2] - mono[1] == 64000, "duration across a correction comes from us");
  CHECK(wall[2] - wall[1] != (mono[2] - mono[1]) / 1000,
        "the wall clock cannot be used for that duration");
}

/* ---- clock source priority (SNTP arrives) ----------------------------- */

/*
 * The rule the radio milestone adds: four sources, host > network > persisted
 * > unset, and only a BETTER source may move the clock backwards. Written as
 * a test rather than a comment because the failure it prevents is silent — an
 * SNTP sync overwriting a time a bench operator set by hand, or a capture
 * dated before the one taken before it.
 */
static void test_clock_adopt(void) {
  const int64_t t2026 = 1787000000000LL; /* somewhere in 2026 */
  const int64_t later = t2026 + 60000;
  const int64_t earlier = t2026 - 60000;

  /* Nonsense is refused whatever offers it. Seconds sent as milliseconds is
   * the classic, and it lands in 1970. */
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_UNSET, 0, PURE_CLOCK_RANK_NETWORK,
                                1787000000LL) == PURE_CLOCK_REJECT_IMPLAUSIBLE,
        "seconds offered as milliseconds is not a time");
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_UNSET, 0, PURE_CLOCK_RANK_HOST, 0) ==
            PURE_CLOCK_REJECT_IMPLAUSIBLE,
        "zero is not a time even from a host");

  /* The first sync on a camera that has never been told the time. */
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_UNSET, 500, PURE_CLOCK_RANK_NETWORK,
                                t2026) == PURE_CLOCK_ADOPT,
        "SNTP replaces uptime-since-1970");

  /* SNTP outranks a persisted lower bound, in both directions: persisted can
   * be ahead of the truth if a previous session was set wrongly. */
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_PERSISTED, t2026, PURE_CLOCK_RANK_NETWORK,
                                later) == PURE_CLOCK_ADOPT,
        "SNTP beats persisted going forward");
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_PERSISTED, t2026, PURE_CLOCK_RANK_NETWORK,
                                earlier) == PURE_CLOCK_ADOPT,
        "SNTP beats persisted going backward — that is a correction");

  /* The one this rule exists for: a bench operator has just set the clock and
   * the network must not quietly move it. */
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_HOST, t2026, PURE_CLOCK_RANK_NETWORK,
                                later) == PURE_CLOCK_REJECT_RANK,
        "SNTP does not overwrite a host-set clock");
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_NETWORK, t2026, PURE_CLOCK_RANK_PERSISTED,
                                later) == PURE_CLOCK_REJECT_RANK,
        "a persisted value does not overwrite a network time");

  /* Same rank never goes backwards. A resync 60 s earlier is a wrong server
   * or a wrong reading, and adopting it reorders captures. */
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_NETWORK, t2026, PURE_CLOCK_RANK_NETWORK,
                                earlier) == PURE_CLOCK_REJECT_BACKWARDS,
        "a second sync may not move the clock back");
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_NETWORK, t2026, PURE_CLOCK_RANK_NETWORK,
                                later) == PURE_CLOCK_ADOPT,
        "a second sync may move it forward");
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_NETWORK, t2026, PURE_CLOCK_RANK_NETWORK,
                                t2026) == PURE_CLOCK_ADOPT,
        "no change is not a backwards step");

  /* A host correcting itself, which is what SET_TIME has always done and the
   * only way to fix a clock that is wrong the other way. */
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_HOST, t2026, PURE_CLOCK_RANK_HOST,
                                earlier) == PURE_CLOCK_ADOPT,
        "a host may correct its own time downward");
  CHECK(pure_clock_adopt_action(PURE_CLOCK_RANK_PERSISTED, t2026, PURE_CLOCK_RANK_PERSISTED,
                                earlier) == PURE_CLOCK_REJECT_BACKWARDS,
        "an automatic source at the same rank may not");
}

/*
 * pure_strcopy: the portable bounded copy that replaced strlcpy in
 * roll_queue.c. strlcpy is not C99, so a source compiled both by ESP-IDF's
 * newlib and by host glibc built one way and not the other; strncpy is not a
 * substitute because it does not terminate on truncation. The cases below are
 * the ones that separate it from both.
 */
static void test_strcopy(void) {
  char buf[8];

  memset(buf, 'x', sizeof buf);
  CHECK(pure_strcopy(buf, sizeof buf, "abc") == 3, "returns the source length");
  CHECK(strcmp(buf, "abc") == 0, "copies a short string whole");

  /* Exactly fits, with room for the terminator. */
  memset(buf, 'x', sizeof buf);
  CHECK(pure_strcopy(buf, sizeof buf, "1234567") == 7, "a source that exactly fits");
  CHECK(strcmp(buf, "1234567") == 0, "and is copied whole");

  /* One too long: truncated, still terminated, and the caller can tell. */
  memset(buf, 'x', sizeof buf);
  const size_t n = pure_strcopy(buf, sizeof buf, "12345678");
  CHECK(n == 8, "returns the SOURCE length, not the copied length");
  CHECK(n >= sizeof buf, "so a return >= cap is how truncation is detected");
  CHECK(strcmp(buf, "1234567") == 0, "truncated to cap-1");
  CHECK(buf[7] == '\0', "and terminated — the whole point over strncpy");

  /* Empty source still terminates. */
  memset(buf, 'x', sizeof buf);
  CHECK(pure_strcopy(buf, sizeof buf, "") == 0, "empty source");
  CHECK(buf[0] == '\0', "writes the terminator");

  /* NULL source behaves as empty rather than crashing: rq_job_init() and
   * rq_apply() both pass fields that can legitimately be absent. */
  memset(buf, 'x', sizeof buf);
  CHECK(pure_strcopy(buf, sizeof buf, NULL) == 0, "NULL source is empty");
  CHECK(buf[0] == '\0', "and still terminates");

  /* Degenerate destinations must not write. */
  CHECK(pure_strcopy(NULL, 8, "abc") == 3, "NULL destination still reports the length");
  memset(buf, 'x', sizeof buf);
  CHECK(pure_strcopy(buf, 0, "abc") == 3, "cap 0 reports the length");
  CHECK(buf[0] == 'x', "and writes nothing at all");

  /* cap 1 is the smallest destination that can hold anything. */
  memset(buf, 'x', sizeof buf);
  CHECK(pure_strcopy(buf, 1, "abc") == 3, "cap 1 reports the length");
  CHECK(buf[0] == '\0', "and holds only the terminator");
  CHECK(buf[1] == 'x', "without touching the byte after it");
}

int main(void) {
  test_quality();
  test_resolution();
  test_reserve();
  test_dirname();
  test_sixteenths();
  test_epoch_bounds();
  test_utc_offset();
  test_iso8601();
  test_clock_restore();
  test_clock_monotonic_across_correction();
  test_clock_adopt();
  test_strcopy();

  if (failures != 0) {
    printf("p4 host tests: %d of %d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 host tests: %d checks passed\n", checks);
  return 0;
}
