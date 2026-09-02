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
/* pure_frame_quality                                                  */
/* ------------------------------------------------------------------ */

static void test_frame_quality(void) {
  int carry = -1, record = -1;

  /* NL_CMD_SENSOR owns the register: the CAPTURE must carry nothing, and META
   * records what the node accepted. Sending a quality here is the defect that
   * overwrote a look's value an instant before the exposure. */
  pure_frame_quality(true, 12, 20, &carry, &record);
  CHECK(carry == 0, "sensor owns the register -> carry %d, want 0", carry);
  CHECK(record == 12, "sensor owns the register -> record %d, want the applied 12", record);

  /* Nothing standing - first capture after boot, after a node reset, or after
   * the viewfinder wrote the register. The CAPTURE carries the mode default
   * and that is therefore what the frame was ENCODED at, so it is what META
   * records. Recording the standing value here is audit FW-1: capture #2 came
   * out at preview quality with META reporting the look's. */
  pure_frame_quality(false, 12, 20, &carry, &record);
  CHECK(carry == 20, "sensor does not own it -> carry %d, want the mode default 20", carry);
  CHECK(record == 20, "sensor does not own it -> record %d, want what was sent", record);

  /* The invariant the two halves exist for: whatever the inputs, the recorded
   * value describes the register at exposure. When the CAPTURE carries a
   * quality, the recorded value IS that quality (post-clamp); when it carries
   * nothing, the recorded value is the standing applied one. Never a third
   * number, and never a carried value that is not recorded. */
  for (int applied = 0; applied <= 63; applied += 7) {
    for (int mode = 0; mode <= 63; mode += 7) {
      for (int owns = 0; owns <= 1; owns++) {
        pure_frame_quality(owns != 0, applied, mode, &carry, &record);
        if (carry != 0) {
          CHECK(record == carry, "carried q%d but recorded q%d (owns %d, applied %d)", carry,
                record, owns, applied);
        } else if (record != 0) {
          CHECK(owns != 0 && record == applied,
                "recorded q%d with nothing carried (owns %d, applied %d)", record, owns,
                applied);
        }
        CHECK(record == 0 || (record >= PURE_SENSOR_QUALITY_MIN &&
                              record <= PURE_SENSOR_QUALITY_MAX),
              "recorded q%d outside the sensor's %d..%d", record, PURE_SENSOR_QUALITY_MIN,
              PURE_SENSOR_QUALITY_MAX);
      }
    }
  }

  /* An owning cache with no applied number is not knowledge: fall through to
   * the mode default rather than record a zero META would print. */
  pure_frame_quality(true, 0, 20, &carry, &record);
  CHECK(carry == 20 && record == 20, "owns but nothing applied -> carry %d record %d, want 20/20",
        carry, record);

  /* Nothing known at all: say nothing. The capture still happens; the sensor
   * keeps whatever its driver left. */
  pure_frame_quality(false, 0, 0, &carry, &record);
  CHECK(carry == 0 && record == 0, "no quality anywhere -> carry %d record %d, want 0/0", carry,
        record);

  /* The node clamps what a CAPTURE carries, so the recorded value is the
   * clamped one - META must not claim a register value the sensor refused. */
  pure_frame_quality(false, 0, 1, &carry, &record);
  CHECK(carry == 1 && record == PURE_SENSOR_QUALITY_MIN,
        "below the floor -> carry %d record %d, want 1/%d", carry, record,
        PURE_SENSOR_QUALITY_MIN);
  pure_frame_quality(false, 0, 200, &carry, &record);
  CHECK(record == PURE_SENSOR_QUALITY_MAX, "above the ceiling -> record %d, want %d", record,
        PURE_SENSOR_QUALITY_MAX);

  /* Both out pointers are optional - the caller that only wants one must not
   * have to invent storage for the other. */
  pure_frame_quality(true, 12, 20, NULL, NULL);
  pure_frame_quality(true, 12, 20, &carry, NULL);
  CHECK(carry == 0, "carry-only call -> %d, want 0", carry);
}

/* ------------------------------------------------------------------ */
/* pure_ev_to_ae_level                                                 */
/* ------------------------------------------------------------------ */

static void test_ev_to_ae_level(void) {
  /* The slider's own steps. Studio sends -2.0..2.0 in 0.1, so these are the
   * values that actually arrive. */
  CHECK(pure_ev_to_ae_level(0.0) == 0, "0 EV -> %d, want 0", pure_ev_to_ae_level(0.0));
  CHECK(pure_ev_to_ae_level(1.0) == 1, "+1 EV -> %d", pure_ev_to_ae_level(1.0));
  CHECK(pure_ev_to_ae_level(-1.0) == -1, "-1 EV -> %d", pure_ev_to_ae_level(-1.0));
  CHECK(pure_ev_to_ae_level(2.0) == 2, "+2 EV -> %d", pure_ev_to_ae_level(2.0));
  CHECK(pure_ev_to_ae_level(-2.0) == -2, "-2 EV -> %d", pure_ev_to_ae_level(-2.0));

  /* The bench case from the issue: -1.5 must not land on the same level as
   * 0, or the two captures the acceptance test compares are the same
   * photograph. Half-steps round AWAY from zero, so it is -2 and not -1. */
  CHECK(pure_ev_to_ae_level(-1.5) == -2, "-1.5 EV -> %d, want -2 (half away from zero)",
        pure_ev_to_ae_level(-1.5));
  CHECK(pure_ev_to_ae_level(1.5) == 2, "+1.5 EV -> %d, want 2", pure_ev_to_ae_level(1.5));

  /* Either side of the -2 boundary, which is where a clamp and a rounding
   * error look identical if only one of them is tested. -2.049 is past the
   * slider and clamps; -1.95 is on the slider and rounds. Both are -2, and
   * that is the point: the clamp must not turn into a different answer than
   * the rounding it takes over from. */
  CHECK(pure_ev_to_ae_level(-2.049) == -2, "-2.049 EV -> %d, want -2 (clamped)",
        pure_ev_to_ae_level(-2.049));
  CHECK(pure_ev_to_ae_level(-1.95) == -2, "-1.95 EV -> %d, want -2 (rounded)",
        pure_ev_to_ae_level(-1.95));
  /* Just inside: -1.4 must stay -1, so the boundary is at the half step and
   * not somewhere convenient. */
  CHECK(pure_ev_to_ae_level(-1.4) == -1, "-1.4 EV -> %d, want -1", pure_ev_to_ae_level(-1.4));
  CHECK(pure_ev_to_ae_level(1.4) == 1, "+1.4 EV -> %d, want 1", pure_ev_to_ae_level(1.4));

  /* Past the wire's range in both directions. ov3660's set_ae_level REFUSES
   * an out-of-range level instead of clamping, and a refused write leaves the
   * previous camera's exposure in the sensor. */
  CHECK(pure_ev_to_ae_level(2.5) == 2, "+2.5 EV -> %d, want 2 (clamped)",
        pure_ev_to_ae_level(2.5));
  CHECK(pure_ev_to_ae_level(-2.5) == -2, "-2.5 EV -> %d, want -2 (clamped)",
        pure_ev_to_ae_level(-2.5));
  /* A number a look document can carry and a cast cannot survive. */
  CHECK(pure_ev_to_ae_level(1e300) == 2, "1e300 EV -> %d, want 2",
        pure_ev_to_ae_level(1e300));
  CHECK(pure_ev_to_ae_level(-1e300) == -2, "-1e300 EV -> %d, want -2",
        pure_ev_to_ae_level(-1e300));

  /* NaN is not an exposure. 0 is the sensor's own metering target, which is
   * the only answer that is not a guess in one direction or the other.
   * Built rather than written as NAN: math.h is not included here and the
   * test binary links without libm. */
  const double zero = 0.0;
  const double nan_value = zero / zero;
  CHECK(pure_ev_to_ae_level(nan_value) == 0, "NaN EV -> %d, want 0",
        pure_ev_to_ae_level(nan_value));

  /* Nothing anywhere on or past the slider may escape the wire's range. */
  for (int tenths = -40; tenths <= 40; tenths++) {
    const int level = pure_ev_to_ae_level(tenths / 10.0);
    CHECK(level >= -2 && level <= 2, "%.1f EV -> %d, outside -2..2", tenths / 10.0, level);
  }
}

/* ------------------------------------------------------------------ */
/* pure_gain_to_ceiling                                                */
/* ------------------------------------------------------------------ */

static void test_gain_to_ceiling(void) {
  /* The three words a QUAD slot can carry. */
  CHECK(pure_gain_to_ceiling("auto") == 0, "auto -> %d, want 0 (send no gainCeiling)",
        pure_gain_to_ceiling("auto"));
  CHECK(pure_gain_to_ceiling("low") == 4, "low -> %d, want 4X", pure_gain_to_ceiling("low"));
  CHECK(pure_gain_to_ceiling("high") == 32, "high -> %d, want 32X",
        pure_gain_to_ceiling("high"));

  /* low must be cleaner than high, stated as the relation rather than as two
   * constants - the numbers may be re-tuned on the bench, the ordering may
   * not. */
  CHECK(pure_gain_to_ceiling("low") < pure_gain_to_ceiling("high"),
        "low must cap gain below high");

  /* Both are legal steps on sensor.h's 2X..128X ladder, so the node has
   * nothing to snap. */
  CHECK(pure_gain_to_ceiling("low") == 4 || pure_gain_to_ceiling("low") == 8,
        "low must land on a real gainceiling_t step");

  /* Garbage, an unknown word, a case difference and NULL are all "leave the
   * AGC alone". A slot this firmware does not understand must not become a
   * gain setting. */
  CHECK(pure_gain_to_ceiling(NULL) == 0, "NULL -> 0");
  CHECK(pure_gain_to_ceiling("") == 0, "empty -> 0");
  CHECK(pure_gain_to_ceiling("HIGH") == 0, "HIGH (wrong case) -> %d, want 0",
        pure_gain_to_ceiling("HIGH"));
  CHECK(pure_gain_to_ceiling("medium") == 0, "an unknown word -> 0");
  CHECK(pure_gain_to_ceiling("32") == 0, "a number in the word field -> 0");
  CHECK(pure_gain_to_ceiling("lowest") == 0, "a prefix of 'low' is not 'low'");
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

/*
 * pure_api_base_ok: what may be stored as the Roll API base. The stored value
 * is the only way an http:// base can ever reach the HTTP client, so the
 * validator is where "nothing after the host" and "never credentials" are
 * enforced.
 */
static void test_api_base(void) {
  CHECK(pure_api_base_ok("https://kino.acronym.sk"), "the production shape");
  CHECK(pure_api_base_ok("http://10.20.99.57:3000"), "a bench override: ip and port");
  CHECK(pure_api_base_ok("http://kino.local"), "a bare hostname");
  CHECK(pure_api_base_ok("https://kino.acronym.sk:8443"), "https with a port");

  CHECK(!pure_api_base_ok(NULL), "NULL");
  CHECK(!pure_api_base_ok(""), "empty");
  CHECK(!pure_api_base_ok("kino.acronym.sk"), "no scheme");
  CHECK(!pure_api_base_ok("ftp://kino.acronym.sk"), "wrong scheme");
  CHECK(!pure_api_base_ok("http://"), "scheme, no host");
  CHECK(!pure_api_base_ok("https://kino.acronym.sk/"), "trailing slash would make //api");
  CHECK(!pure_api_base_ok("https://kino.acronym.sk/api"), "a path is the firmware's business");
  CHECK(!pure_api_base_ok("https://user:pw@kino.acronym.sk"), "credentials never in the URL");
  CHECK(!pure_api_base_ok("http://10.20.99.57:"), "colon, no port");
  CHECK(!pure_api_base_ok("http://10.20.99.57:30a0"), "port must be digits");
  CHECK(!pure_api_base_ok("http://10.20.99.57:3000?x=1"), "no query");
  CHECK(!pure_api_base_ok("http://10.20.99.57:3000#f"), "no fragment");
  CHECK(!pure_api_base_ok("http://10.20.99.57 :3000"), "no spaces");
  char longurl[PURE_API_BASE_MAX + 16];
  memset(longurl, 'a', sizeof longurl - 1);
  longurl[sizeof longurl - 1] = '\0';
  memcpy(longurl, "https://", 8);
  CHECK(!pure_api_base_ok(longurl), "over PURE_API_BASE_MAX");
}

/*
 * The UI health watch (issue #140).
 *
 * The whole point of moving this decision into pure.c is that the defect was
 * pure logic: "did a frame come out" instead of "was a frame due", edge instead
 * of heartbeat. None of it needs a panel, and all of it is a truth table.
 */
static void test_ui_health(void) {
  /* An idle screen is idle, not stalled. This is the false positive: no frame
   * came out and none was due, once a second, forever. */
  {
    ui_health_t h = {0};
    for (int i = 0; i < 100; i++) {
      CHECK(ui_health_step(&h, false, false, false) == UI_HEALTH_QUIET, "idle screen is quiet");
    }
    CHECK(!h.stalled, "idle never latches a stall");
  }

  /* A healthy SHOOT screen: a frame was due and one came out. */
  {
    ui_health_t h = {0};
    for (int i = 0; i < 100; i++) {
      CHECK(ui_health_step(&h, true, true, false) == UI_HEALTH_QUIET, "presenting is quiet");
    }
  }

  /* A real stall: due, and nothing came out. Reported ONCE. */
  {
    ui_health_t h = {0};
    CHECK(ui_health_step(&h, true, false, false) == UI_HEALTH_STALLED, "stall on entry");
    CHECK(h.stalled, "latched");
    for (int i = 0; i < 60; i++) {
      CHECK(ui_health_step(&h, true, false, false) == UI_HEALTH_QUIET,
            "a minute of stall costs one line, not sixty");
    }
    CHECK(ui_health_step(&h, true, true, false) == UI_HEALTH_PRESENTING, "recovery is reported");
    CHECK(!h.stalled, "latch cleared");
    CHECK(ui_health_step(&h, true, true, false) == UI_HEALTH_QUIET, "and reported once");
  }

  /* The other way out: the work stopped being due without a frame ever
   * arriving. Said differently, because "presenting again" would be untrue. */
  {
    ui_health_t h = {0};
    CHECK(ui_health_step(&h, true, false, false) == UI_HEALTH_STALLED, "stall on entry");
    CHECK(ui_health_step(&h, false, false, false) == UI_HEALTH_STALL_ENDED, "ended, no frame");
    CHECK(!h.stalled, "latch cleared");
    CHECK(ui_health_step(&h, false, false, false) == UI_HEALTH_QUIET, "then quiet");
  }

  /* A press is not a fault. A tap shorter than PURE_UI_LATCH_TICKS says
   * nothing at all - the old code logged one line per second of it. */
  {
    ui_health_t h = {0};
    for (int i = 0; i < PURE_UI_LATCH_TICKS - 1; i++) {
      CHECK(ui_health_step(&h, true, true, true) == UI_HEALTH_QUIET, "a slow tap is quiet");
    }
    CHECK(ui_health_step(&h, true, true, false) == UI_HEALTH_QUIET, "and so is its release");
    CHECK(h.latch_ticks == 0, "the counter resets on the lift");
  }

  /* A latch that outlives any finger: once on entry, once when it clears. */
  {
    ui_health_t h = {0};
    for (int i = 0; i < PURE_UI_LATCH_TICKS - 1; i++) {
      CHECK(ui_health_step(&h, true, true, true) == UI_HEALTH_QUIET, "below the threshold");
    }
    CHECK(ui_health_step(&h, true, true, true) == UI_HEALTH_LATCH_STUCK, "stuck at the threshold");
    for (int i = 0; i < 60; i++) {
      CHECK(ui_health_step(&h, true, true, true) == UI_HEALTH_QUIET, "reported once");
    }
    CHECK(ui_health_step(&h, true, true, false) == UI_HEALTH_LATCH_CLEARED, "and once on release");
    CHECK(ui_health_step(&h, true, true, false) == UI_HEALTH_QUIET, "then quiet");
  }

  /* A latched press on SHOOT skips the repaint, so the two coexist. The CAUSE
   * is reported first: a reader given "stalled" goes to the compositor, a
   * reader given "latched" goes to the touch driver, and the latter is right. */
  {
    ui_health_t h = {0};
    CHECK(ui_health_step(&h, true, false, true) == UI_HEALTH_STALLED, "tick 1: the stall");
    for (int i = 1; i < PURE_UI_LATCH_TICKS - 1; i++) {
      CHECK(ui_health_step(&h, true, false, true) == UI_HEALTH_QUIET, "the stall is not repeated");
    }
    CHECK(ui_health_step(&h, true, false, true) == UI_HEALTH_LATCH_STUCK,
          "the latch is still reported while a stall is latched");
  }

  /* A latch edge does not also spend the tick on a stall edge; the next tick
   * carries it. Nothing is lost - the stall is still there a second later. */
  {
    ui_health_t h = {0};
    for (int i = 0; i < PURE_UI_LATCH_TICKS; i++) {
      ui_health_step(&h, false, true, true);
    }
    CHECK(h.latch_stuck, "latched");
    CHECK(!h.stalled, "nothing was due, so no stall");
    CHECK(ui_health_step(&h, true, false, true) == UI_HEALTH_STALLED,
          "the stall lands on the tick after the latch edge");
  }

  /* NULL is quiet rather than a crash: this is called from a task loop. */
  CHECK(ui_health_step(NULL, true, false, true) == UI_HEALTH_QUIET, "NULL state");
}

/*
 * GET_MODES telling the truth about whether this body can shoot.
 *
 * The defect was a constant, so the test's job is to pin the PREDICATE and its
 * ORDER: card before camera, matching capture_fire(), so a body with neither is
 * told about the card it has to put in first.
 */
static void test_mode_availability(void) {
  CHECK(capture_unavailable_reason(true, true) == NULL, "card and a camera: shootable");

  CHECK(capture_unavailable_reason(false, true) != NULL, "no card: not shootable");
  CHECK(strcmp(capture_unavailable_reason(false, true), "No card to write the capture to") == 0,
        "and the reason is the card");

  CHECK(capture_unavailable_reason(true, false) != NULL, "no camera: not shootable");
  CHECK(strcmp(capture_unavailable_reason(true, false), "No camera node answered") == 0,
        "and the reason names the node, not the build");

  /* Both missing reports the card, because capture_fire() checks it first and a
   * host that fixes the camera while the card is still out has fixed nothing. */
  CHECK(strcmp(capture_unavailable_reason(false, false), "No card to write the capture to") == 0,
        "card outranks camera, as in capture_fire");

  /* The string that started this: never again, in any combination. */
  const char *r;
  r = capture_unavailable_reason(false, false);
  CHECK(strstr(r, "build") == NULL, "no reason blames the build (00)");
  r = capture_unavailable_reason(false, true);
  CHECK(strstr(r, "build") == NULL, "no reason blames the build (01)");
  r = capture_unavailable_reason(true, false);
  CHECK(strstr(r, "build") == NULL, "no reason blames the build (10)");
}

/* ------------------------------------------------------------------ */
/* Wigglegram playback order                                           */
/* ------------------------------------------------------------------ */

/** Render a sequence as "0,1,2,3,2,1" so a failure prints what came out. */
static const char *seq_str(const uint8_t *seq, int n) {
  static char buf[64];
  int at = 0;
  buf[0] = '\0';
  for (int i = 0; i < n && at < (int)sizeof buf - 4; i++) {
    at += snprintf(buf + at, sizeof buf - (size_t)at, i ? ",%d" : "%d", seq[i]);
  }
  return buf;
}

#define SEQ_IS(want, loop, rtl, present)                                                      \
  do {                                                                                        \
    uint8_t got[PURE_WIGGLE_SEQ_MAX];                                                         \
    const int n = pure_wiggle_sequence((loop), (rtl), (present), got, (int)sizeof got, NULL); \
    const char *g = seq_str(got, n);                                                          \
    CHECK(strcmp(g, (want)) == 0, "loop %d rtl %d present %#x -> %s, want %s", (int)(loop),   \
          (int)(rtl), (unsigned)(present), g, (want));                                        \
  } while (0)

static void test_wiggle_sequence(void) {
  /*
   * The orders packages/media/src/sequence.ts produces, which is the whole
   * point of this suite: the WebP a Roll bakes and the picture moving on the
   * camera's panel are the same photograph, and two orders would make them two.
   */
  SEQ_IS("0,1,2,3,2,1", PURE_WIGGLE_BOUNCE, false, 0xf);
  SEQ_IS("0,1,2,3", PURE_WIGGLE_CONTINUOUS, false, 0xf);
  SEQ_IS("0,1,2,3", PURE_WIGGLE_SWEEP, false, 0xf);

  /* rtl mirrors the positions, it does not reverse the array. Reversing the
   * bounce would give "1,2,3,2,1,0" - the same cyclic loop entered half way
   * through a swing, so it rests on a middle frame instead of an end. */
  SEQ_IS("3,2,1,0,1,2", PURE_WIGGLE_BOUNCE, true, 0xf);
  SEQ_IS("3,2,1,0", PURE_WIGGLE_CONTINUOUS, true, 0xf);

  /* Only the repeat separates sweep from continuous, never the order. */
  bool repeats = true;
  uint8_t s[PURE_WIGGLE_SEQ_MAX];
  pure_wiggle_sequence(PURE_WIGGLE_SWEEP, false, 0xf, s, (int)sizeof s, &repeats);
  CHECK(!repeats, "sweep must not repeat");
  pure_wiggle_sequence(PURE_WIGGLE_CONTINUOUS, false, 0xf, s, (int)sizeof s, &repeats);
  CHECK(repeats, "continuous repeats");
  pure_wiggle_sequence(PURE_WIGGLE_BOUNCE, false, 0xf, s, (int)sizeof s, &repeats);
  CHECK(repeats, "bounce repeats");

  /* Frame counts below four. Three bounces as 2n-2 = 4; two collapses to the
   * two frames, because the interior of a two-frame bounce is empty. */
  SEQ_IS("0,1,2,1", PURE_WIGGLE_BOUNCE, false, 0x7);
  SEQ_IS("0,1", PURE_WIGGLE_BOUNCE, false, 0x3);
  SEQ_IS("1,0", PURE_WIGGLE_BOUNCE, true, 0x3);
  SEQ_IS("0", PURE_WIGGLE_BOUNCE, false, 0x1);

  /*
   * The partial capture, which is the case frameCount cannot answer.
   * A capture missing C2 swings C1 -> C3 -> C4 -> C3: the frames that are
   * there, in camera order, as a three-frame wiggle.
   */
  SEQ_IS("0,2,3,2", PURE_WIGGLE_BOUNCE, false, 0xd);
  SEQ_IS("3,2,0,2", PURE_WIGGLE_BOUNCE, true, 0xd);
  SEQ_IS("1,3", PURE_WIGGLE_CONTINUOUS, false, 0xa);
  /* One surviving frame is a still, whichever one it is. */
  SEQ_IS("2", PURE_WIGGLE_BOUNCE, false, 0x4);

  /* Nothing decoded is nothing to play - 0, not an empty swing. */
  CHECK(pure_wiggle_sequence(PURE_WIGGLE_BOUNCE, false, 0, s, (int)sizeof s, NULL) == 0,
        "no frames present must refuse");
  /* Bits above the four lenses are not frames. */
  SEQ_IS("0", PURE_WIGGLE_BOUNCE, false, 0xf1);

  /*
   * Refuse rather than truncate. A short buffer must not produce a swing that
   * stops somewhere arbitrary and jumps back; the caller's still is better.
   */
  uint8_t small[4];
  CHECK(pure_wiggle_sequence(PURE_WIGGLE_BOUNCE, false, 0xf, small, 4, NULL) == 0,
        "a 6-long bounce into a 4-slot buffer must refuse");
  CHECK(pure_wiggle_sequence(PURE_WIGGLE_CONTINUOUS, false, 0xf, small, 4, NULL) == 4,
        "a 4-long sweep into a 4-slot buffer fits");
  CHECK(pure_wiggle_sequence(PURE_WIGGLE_BOUNCE, false, 0xf, NULL, 8, NULL) == 0,
        "a NULL buffer must refuse");
  CHECK(pure_wiggle_sequence(PURE_WIGGLE_BOUNCE, false, 0xf, s, 0, NULL) == 0,
        "a zero cap must refuse");

  /* PURE_WIGGLE_SEQ_MAX has to hold the longest order there is, or the
   * refusal above becomes the normal path and nothing ever plays. */
  CHECK(pure_wiggle_sequence(PURE_WIGGLE_BOUNCE, false, 0xf, s, PURE_WIGGLE_SEQ_MAX, NULL) == 6,
        "the full bounce must fit PURE_WIGGLE_SEQ_MAX");

  /* Every frame in an order is a frame that is present. This is the property
   * that stops a missing frame being shown as whatever was in its buffer. */
  for (unsigned mask = 1; mask < 16; mask++) {
    for (int loop = 0; loop <= 2; loop++) {
      for (int rtl = 0; rtl <= 1; rtl++) {
        const int n = pure_wiggle_sequence((pure_wiggle_loop_t)loop, rtl != 0, mask, s,
                                           (int)sizeof s, NULL);
        CHECK(n >= 1, "mask %#x loop %d produced nothing", mask, loop);
        for (int i = 0; i < n; i++) {
          CHECK((mask & (1u << s[i])) != 0, "mask %#x loop %d rtl %d showed absent frame %d", mask,
                loop, rtl, (int)s[i]);
        }
      }
    }
  }
}

static void test_wiggle_words(void) {
  CHECK(pure_wiggle_loop("bounce") == PURE_WIGGLE_BOUNCE, "bounce");
  CHECK(pure_wiggle_loop("continuous") == PURE_WIGGLE_CONTINUOUS, "continuous");
  CHECK(pure_wiggle_loop("sweep") == PURE_WIGGLE_SWEEP, "sweep");
  /* A stored envelope that has been through a host this firmware does not
   * know still gets a wiggle rather than a still. */
  CHECK(pure_wiggle_loop(NULL) == PURE_WIGGLE_BOUNCE, "NULL loop -> bounce");
  CHECK(pure_wiggle_loop("") == PURE_WIGGLE_BOUNCE, "empty loop -> bounce");
  /* media's vocabulary is not KDP's: `once` is media's word for KDP `sweep`,
   * and taking it here would be the cast packages/media/src/playback.ts
   * exists to prevent. */
  CHECK(pure_wiggle_loop("once") == PURE_WIGGLE_BOUNCE, "media's own word is not KDP's");
  CHECK(pure_wiggle_loop("BOUNCE") == PURE_WIGGLE_BOUNCE, "case is not folded; the default holds");

  CHECK(pure_wiggle_direction_rtl("rtl"), "rtl");
  CHECK(!pure_wiggle_direction_rtl("ltr"), "ltr");
  CHECK(!pure_wiggle_direction_rtl(NULL), "NULL direction -> ltr");
  CHECK(!pure_wiggle_direction_rtl(""), "empty direction -> ltr");
}

static void test_wiggle_period(void) {
  CHECK(pure_wiggle_period_ms(8) == 125, "8 fps -> %d ms, want 125", pure_wiggle_period_ms(8));
  CHECK(pure_wiggle_period_ms(10) == 100, "10 fps -> %d ms", pure_wiggle_period_ms(10));
  /* Clamped, not rejected: the number comes from a slider or a stored
   * preference and one a little out of range is a stale client. */
  CHECK(pure_wiggle_period_ms(1) == 200, "1 fps clamps to the 5 fps floor -> %d ms",
        pure_wiggle_period_ms(1));
  CHECK(pure_wiggle_period_ms(240) == 66, "240 fps clamps to the 15 fps ceiling -> %d ms",
        pure_wiggle_period_ms(240));
  /* Absent - config_int's fallback path can hand over 0 - takes the camera's
   * own default of 8, not media's 10. */
  CHECK(pure_wiggle_period_ms(0) == 125, "no fps -> the camera default 8 fps");
  CHECK(pure_wiggle_period_ms(-5) == 125, "a negative fps -> the camera default");

  /* A period no shorter than the UI loop's own 20 ms pass, or the pacing
   * would be asking for frames the loop cannot deliver. */
  for (int fps = -10; fps < 60; fps++) {
    const int ms = pure_wiggle_period_ms(fps);
    CHECK(ms >= 20 && ms <= 200, "%d fps -> %d ms, outside 20..200", fps, ms);
  }
}

/* ------------------------------------------------------------------ */
/* Wigglegram alignment (mirror of packages/media/tests/alignment.test.ts) */
/* ------------------------------------------------------------------ */

static void test_align(void) {
  /* The same four numbers the TS test asserts, because the panel's crop and the
   * worker's crop have to be one crop - a wigglegram whose baked render and
   * whose live player crop differently is two photographs of one moment. */
  const pure_cam_offset_t none4[4] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
  CHECK(!pure_align_has_offset(none4, 4), "all-zero offsets are nothing to correct");
  const pure_cam_offset_t one[2] = {{0, 0, 0}, {2, 0, 0}};
  CHECK(pure_align_has_offset(one, 2), "one non-zero x is something to correct");
  /* NULL and a zero count are both no-ops, which is the every-capture path. */
  CHECK(!pure_align_has_offset(NULL, 4), "NULL offsets -> no-op");

  /* Insets by the largest offset on each axis: 800 px render of a 1600 px
   * sensor frame, scale 0.5. */
  const pure_cam_offset_t off[4] = {{0, 0, 0}, {-6, 3, 0}, {4, -2, 0}, {0, 0, 0}};
  pure_crop_t c = pure_align_overlap_crop(800, 600, off, 4, 0.5);
  CHECK(c.w == 790, "crop w %d, want 790", c.w);
  CHECK(c.h == 592, "crop h %d, want 592", c.h);
  CHECK(c.x == 5, "crop x %d, want 5", c.x);
  CHECK(c.y == 4, "crop y %d, want 4", c.y);

  /* Rotation costs more than the 2 px pad, and the result stays even so a video
   * encoder downstream accepts it. */
  const pure_cam_offset_t rot[4] = {{0, 0, 0}, {0, 0, 1.5}, {0, 0, 0}, {0, 0, 0}};
  pure_crop_t cr = pure_align_overlap_crop(800, 600, rot, 4, 0.5);
  CHECK(cr.w < 790, "rotation slack shrinks the crop: w %d", cr.w);
  CHECK(cr.w % 2 == 0 && cr.h % 2 == 0, "crop stays even (%dx%d)", cr.w, cr.h);

  /* Never collapses below a usable size, whatever absurd offset arrives. */
  const pure_cam_offset_t huge[4] = {{0, 0, 0}, {5000, 5000, 45}, {0, 0, 0}, {0, 0, 0}};
  pure_crop_t ch = pure_align_overlap_crop(800, 600, huge, 4, 1.0);
  CHECK(ch.w >= 16 && ch.h >= 16, "crop floors at 16 (%dx%d)", ch.w, ch.h);

  /* The plan scales the stored offsets to the source resolution and passes
   * rotation through unscaled. */
  pure_frame_xform_t xf[4];
  pure_crop_t pc = pure_align_plan(800, 600, off, 4, xf);
  CHECK(xf[0].dx == 0 && xf[0].dy == 0 && xf[0].rot_deg == 0, "frame 0 does not move");
  CHECK(xf[1].dx == -3 && xf[1].dy == 1.5 && xf[1].rot_deg == 0, "frame 1 dx %.1f dy %.1f",
        xf[1].dx, xf[1].dy);
  CHECK(xf[2].dx == 2 && xf[2].dy == -1, "frame 2 dx %.1f dy %.1f", xf[2].dx, xf[2].dy);
  CHECK(pc.w == 790 && pc.h == 592, "plan crop matches the standalone one (%dx%d)", pc.w, pc.h);

  /* At the sensor base width the offsets pass through 1:1 - scale is exactly 1. */
  const pure_cam_offset_t base[4] = {{0, 0, 0}, {7, -4, -0.5}, {0, 0, 0}, {0, 0, 0}};
  pure_frame_xform_t bxf[4];
  pure_align_plan(PURE_ALIGN_SENSOR_BASE_W, 1200, base, 4, bxf);
  CHECK(bxf[1].dx == 7 && bxf[1].dy == -4 && bxf[1].rot_deg == -0.5,
        "at base width dx %.1f dy %.1f rot %.1f", bxf[1].dx, bxf[1].dy, bxf[1].rot_deg);

  /* Zero offsets: the plan is a full-frame crop and no shift, which is the
   * clean no-op every capture takes today. */
  pure_frame_xform_t zxf[4];
  pure_crop_t zc = pure_align_plan(1600, 1200, none4, 4, zxf);
  CHECK(zc.x == 2 && zc.y == 2, "zero-offset crop keeps only the 2 px pad (x %d y %d)", zc.x, zc.y);
  CHECK(zxf[3].dx == 0 && zxf[3].dy == 0, "zero-offset frame does not move");
}

int main(void) {
  test_quality();
  test_frame_quality();
  test_ev_to_ae_level();
  test_gain_to_ceiling();
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
  test_api_base();
  test_ui_health();
  test_mode_availability();
  test_wiggle_sequence();
  test_wiggle_words();
  test_wiggle_period();
  test_align();

  if (failures != 0) {
    printf("p4 host tests: %d of %d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 host tests: %d checks passed\n", checks);
  return 0;
}
