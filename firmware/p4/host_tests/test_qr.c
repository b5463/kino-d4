/*
 * Host tests for firmware/p4/main/qr.c.
 *
 * A QR that is subtly wrong looks correct on the camera's screen and cannot be
 * read by any phone. Nothing on the device can detect that, and the person it
 * fails is a guest at a party holding up a phone. So this file does not check
 * the encoder against itself: every module of every symbol below is compared
 * against a matrix produced by an unrelated encoder.
 *
 * ## Where the reference data came from
 *
 * The npm package "qrcode", version 1.5.4 - already a dependency of
 * apps/roll-web, which is the other end of this exact URL. Generated with a
 * throwaway Node script equivalent to:
 *
 *     import QRCode from 'qrcode';
 *     const qr = QRCode.create([{ data: text, mode: 'byte' }],
 *                              { errorCorrectionLevel: 'M' });
 *     // qr.modules.data[y * qr.modules.size + x] is 1 when the module is dark
 *
 * mode 'byte' is explicit because the package otherwise picks the narrowest
 * mode that fits, and a numeric- or alphanumeric-mode symbol would be a
 * different bit stream that qr.c is not written to produce.
 *
 * The strings are named above each matrix. They were chosen to reach the parts
 * of the encoder a single happy-path string leaves untested: the version-1 to
 * version-2 boundary, multi-block Reed-Solomon interleaving, the version-7
 * threshold where version-information blocks appear, and version 10's mixed
 * block sizes. The masks the eight-way search settles on across the seven cases
 * are 2, 3, 0, 3, 6, 1 and 1 - so a hardcoded mask 0 fails six of them.
 *
 * ## One known divergence, and the wider check that bounds it
 *
 * qrcode 1.5.4 computes penalty rule 4 as |ceil(dark% / 5) - 10| * 10,
 * which is not what ISO/IEC 18004 says (floor(|dark% - 50| / 5) * 10) and
 * differs from it whenever the dark proportion is above 50%. qr.c implements
 * the standard, so the two can disagree about which mask is best - and that is
 * the one thing exact-equality assertions cannot tolerate.
 *
 * It was measured rather than assumed. A throwaway harness ran 713 strings
 * through both encoders: every length from 1 to 213 bytes, plus 500 random
 * printable-ASCII strings and Roll-shaped URLs.
 *
 *   - 705 matched qrcode module for module, mask included.
 *   - the other 8 matched qrcode exactly at a DIFFERENT mask, so the bit
 *     stream, the Reed-Solomon parity, the interleave and every function
 *     pattern agreed in all 713 cases; only the mask choice moved.
 *   - all 713 agreed with an argmin scored independently under the ISO rule 4,
 *     which puts the 8 on qrcode's side of the divergence, not on qr.c's.
 *
 * None of the 8 is a string below. If one is added later and the mask
 * disagrees, that is the expected divergence and the reference is the
 * non-standard one - do not "fix" the scoring to match it.
 *
 *   make -C firmware/p4/host_tests test-qr
 */
#include <stdio.h>
#include <string.h>

#include "qr.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...) \
  do { \
    checks++; \
    if (!(cond)) { \
      failures++; \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__); \
      printf("\n"); \
    } \
  } while (0)

/* ------------------------------------------------------------------ */
/* Reference matrices - qrcode 1.5.4, level M, byte mode       */
/* ------------------------------------------------------------------ */

/* the shortest thing worth encoding at all.
 * 2 bytes -> version 1, 21x21, mask 2. */
static const char ref_short_text[] = "HI";
static const char *const ref_short[] = {
    "111111100011101111111",
    "100000100000101000001",
    "101110101011001011101",
    "101110101110101011101",
    "101110101001101011101",
    "100000101110101000001",
    "111111101010101111111",
    "000000001111100000000",
    "101111100110101111100",
    "011010001000100100000",
    "101100101011010011110",
    "010001000000000110100",
    "011100100001010010101",
    "000000001001111001000",
    "111111100000101100010",
    "100000101001111001001",
    "101110101100100100100",
    "101110101100100100100",
    "101110101011010011100",
    "100000100010000110100",
    "111111101111010011110",
};

/* a real Roll guestUrl - the case that actually ships.
 * 32 bytes -> version 3, 29x29, mask 3. */
static const char ref_guest_text[] = "https://kino.acronym.sk/r/K7M2QP";
static const char *const ref_guest[] = {
    "11111110111111110111101111111",
    "10000010100101001000001000001",
    "10111010000110001010001011101",
    "10111010101000110110101011101",
    "10111010010010101001001011101",
    "10000010011011011111001000001",
    "11111110101010101010101111111",
    "00000000101010011111000000000",
    "10110111001001010110001001011",
    "01011100000001110001011010001",
    "00001010101111001000011010110",
    "01101001000100001001100110001",
    "11011011001110110111000001100",
    "00000100111000101001001000111",
    "10111111010101011111101010111",
    "11001000010100101000000100010",
    "00000111010110110111010111010",
    "00011001010100101100100101110",
    "10011010001111110110010110100",
    "00001101010001100111011110100",
    "01110010010001100100111111100",
    "00000000100000011000100011111",
    "11111110100000101011101011010",
    "10000010111011101010100011001",
    "10111010001100011000111110110",
    "10111010101010001001010111001",
    "10111010101110101010110100101",
    "10000010011111100000110101010",
    "11111110110101101001101110010",
};

/* 14 bytes: exactly version 1 at level M.
 * 14 bytes -> version 1, 21x21, mask 0. */
static const char ref_v1max_text[] = "KINO-R-K7M2QP0";
static const char *const ref_v1max[] = {
    "111111100010101111111",
    "100000101001001000001",
    "101110100010101011101",
    "101110100101101011101",
    "101110101110101011101",
    "100000100001001000001",
    "111111101010101111111",
    "000000000011000000000",
    "101010100000100010010",
    "100110000000111101110",
    "000111100110110111111",
    "001101001001010000001",
    "000110100010110100100",
    "000000001010000110110",
    "111111100111110010011",
    "100000100100000110011",
    "101110101010101010110",
    "101110100110001000110",
    "101110101011111111001",
    "100000100101110001010",
    "111111101010110100011",
};

/* 15 bytes: one more, so the version must bump.
 * 15 bytes -> version 2, 25x25, mask 3. */
static const char ref_v2min_text[] = "KINO-R-K7M2QP01";
static const char *const ref_v2min[] = {
    "1111111011101111001111111",
    "1000001011101100101000001",
    "1011101000101000101011101",
    "1011101011000011001011101",
    "1011101000101010101011101",
    "1000001000100101101000001",
    "1111111010101010101111111",
    "0000000011110001100000000",
    "1011011101110101101001011",
    "0000110101110111001100101",
    "1000101111101100101100100",
    "1111010011010000110001110",
    "0010001011001011101111000",
    "0101000001111011001011110",
    "0101011000110100100011010",
    "1010100010010011000011010",
    "0011011001001010111110111",
    "0000000011100011100011000",
    "1111111011100110101010011",
    "1000001011010110100011001",
    "1011101000100110111111111",
    "1011101010000001011001001",
    "1011101011000010000110110",
    "1000001000111111100000100",
    "1111111010010000011111111",
};

/* version 5: two EC blocks, so the interleave is exercised.
 * 64 bytes -> version 5, 37x37, mask 6. */
static const char ref_v5_text[] = "https://kino.acronym.sk/r/K7M2QP?t=1787788800000&g=Alexander&n=4";
static const char *const ref_v5[] = {
    "1111111010010111110111110110001111111",
    "1000001010001100100101011010001000001",
    "1011101010011010001101110101001011101",
    "1011101000100101011001110100001011101",
    "1011101011001111100101000010101011101",
    "1000001000101100000010110010001000001",
    "1111111010101010101010101010101111111",
    "0000000001111100011000110101000000000",
    "1001111110000011000001110011110010111",
    "1010000011100100111001001101001110110",
    "1100101010010101110110110101010111001",
    "1111000101101110110110011011000110111",
    "1011011101100001001001011000101100001",
    "0010110010100111000011011111100011010",
    "1010101010010001101100000001001011101",
    "0000000011011110100011111010111101101",
    "1011111010000000011001101111001100111",
    "0011010110100000010001110101010000100",
    "1100011111000010111100101001010001101",
    "1000000110010011100110110110011010001",
    "1111111111100000011110111011111110000",
    "0100000000100011110000010001000010110",
    "0101111110010011100001010101000101011",
    "1101110010101101001000001001011111111",
    "0111001101110111010111111000101100010",
    "1110110001010010001100101011100010000",
    "1101101000001111010000001101110111111",
    "1001000100110110100100000000100110101",
    "1001001100100011101101110100111110111",
    "0000000011100001110011100100100010100",
    "1111111010111111011110011000101010011",
    "1000001011100011100011010110100010001",
    "1011101011101101101111010001111110000",
    "1011101010101110010011111101011000101",
    "1011101000110000011001110000110011001",
    "1000001001100101011000010011001010111",
    "1111111010110110001100101010101101001",
};

/* version 7: the first version carrying version-information blocks, and four EC blocks.
 * 122 bytes -> version 7, 45x45, mask 1. */
static const char ref_v7_text[] = "https://kino.acronym.sk/r/K7M2QP?k=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
static const char *const ref_v7[] = {
    "111111101111001110001100001100101000101111111",
    "100000100001010010101011011010100001001000001",
    "101110101111011001010010010001000101001011101",
    "101110100110110111000111101100110101101011101",
    "101110100001110100001111101100110011101011101",
    "100000101001010010101000111011101100001000001",
    "111111101010101010101010101010101010101111111",
    "000000000011110010111000111010111010100000000",
    "101000110110001100101111101011001000000100101",
    "011110000101000001110011100101001101000110011",
    "010000111000010100000100110100010101000111101",
    "011011010000001111010100101110111010101110000",
    "110010101010110101110001010011001100010010010",
    "011101010011110101101011110011001101010010111",
    "011100101100101011000100100100010001000101001",
    "101111011001101100110100101110001010101111001",
    "011111111110001100110001010010001101010010010",
    "111011011011010111101001110011001101010010111",
    "001011111001101011000100100100000000000101001",
    "101000011101100010110000101110111011101111001",
    "101111111001111110111111110011001100111110010",
    "100010001011000111111000110011001101100011010",
    "100010101111011001011010100100010000101011101",
    "000110001110101010111000111110111010100011010",
    "001111111000101111101111110011001011111110011",
    "100101011000111000010010110011001101001101101",
    "101000101100000000010101000000010100001010001",
    "011100011000100010010010001110111011111111001",
    "100010100011011000000010010011001101110001010",
    "010111001111000111111110110011001101001100111",
    "010000100001010101011100000100010000011111001",
    "111101001110101100110011001110001011101001001",
    "111001101101110111000011010011011101110000010",
    "111110010010101001011110110011011101001100111",
    "000010111011110011011100000101000000101101001",
    "011110011110111101010011001110111011011011001",
    "100110101010101000001111110011001101111110010",
    "000000001001100010011000110011001101100011010",
    "111111101001100111101010100100010000101011101",
    "100000100101111010111000100010111111100011001",
    "101110100010101011011111100011001100111110011",
    "101110100111011001101100110111001101101110111",
    "101110101111101001010001010000010100110010001",
    "100000100010001100100111101110111010110010000",
    "111111101001010001101000110011001101000100001",
};

/* 213 bytes: the longest string that fits version 10 at level M, and the only supported version with mixed block sizes (4x43 + 1x44).
 * 213 bytes -> version 10, 57x57, mask 1. */
static const char ref_v10max_text[] = "https://kino.acronym.sk/r/K7M2QP?k=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
static const char *const ref_v10max[] = {
    "111111101010110100010000101100101011001100110011001111111",
    "100000100001010011111010111011000110111011101001001000001",
    "101110101111010011100101010001000100000001010111001011101",
    "101110100000001011100101101100110011010100110101001011101",
    "101110100001110100000000111111110011011100101001001011101",
    "100000101000001011011010111000101110101011100110001000001",
    "111111101010101010101010101010101010101010101010101111111",
    "000000000001010100110010111000111010101110111010100000000",
    "101000110110100000011010001111101101110011001000000100101",
    "010001011110011111011111001101001100110011001101010010111",
    "111110111111111000100101010000010001100100010101000101001",
    "000111001000101010110010110110111111101110111010101111001",
    "001110110110101000011110000011001000110011001100010010010",
    "011011011110001001011001001011001100110011001101010010101",
    "111101111001111100100001010100010111000100010001000101001",
    "000100001010111010110110110110111011101010011010100111010",
    "000001110110110000000110000011001100110010001100000010001",
    "010010011110001101000011001011001100110101001101000010111",
    "110010111111111001010101010100010001000100010001000101001",
    "001011010000111101001100110110110011101110111010101111001",
    "000001111011010000011000000011001100110011001101010010010",
    "010011011010101101011001001011001100110011001101010000111",
    "010010100111111000111101010100011001000100010000000111101",
    "011011010011111100101100110110011011111110101011101111001",
    "000001111111010001111000000011101100110011001100010010010",
    "110011011100101100010001001010001100110011001101010010111",
    "100011111111100001011101001111110001000100000001111111001",
    "111010001010100100010100101000111011101110111011100011001",
    "000010101110010000011000011010101100110011001011101010010",
    "111110001100101101010001011000101101110011001101100010111",
    "110111111111100111011101001111110000000100010100111111001",
    "001101010011010110010010111011111011101110111011111011001",
    "010000100110011010011000001001001000110011001101110000010",
    "101010010100100111010101000000101000110011001101001100110",
    "111100110111100001011011000000110001000100010000001101000",
    "000101001111010110010010111011111011101110011011111011000",
    "010000100000011010011000001001001100110011001101110000011",
    "100010010000100101000101000100101100110011001101001100111",
    "110100110101100110110001000100110001000001010000001101001",
    "001011001011010110110000111011111011101110111011111011001",
    "010010100011111010100110001001011100110011001101110000010",
    "100010010010000101011101000100110100110011001101001101011",
    "110110110010000110010001000100100001000100010000111101101",
    "011010001011010111101000111011111011100110101011001011001",
    "100001101100111011001110001001001100100011011101010000010",
    "100010001011000101011101000100101100110011011101101100111",
    "101001110011000111100001000100110001010100000000001111001",
    "111110000011011110001000111011111010101110111111111101001",
    "000000111101001111101110011111101101110011001101111110010",
    "000000001011001111011101011000101101110011001100100010111",
    "111111101011110001100001011010110001000100010100101011001",
    "100000100011000100001000101000111101101110111010100011001",
    "101110100101010111101000001111101000110011001100111110010",
    "101110100011010101011101011111101100110011001101101110100",
    "101110101011101001100101010010010111000100010000110011011",
    "100000100111000010001100101011011011101011111010110011000",
    "111111101101001011101010001101001100110010001101000100001",
};

/* ------------------------------------------------------------------ */
/* Every module of every reference                                     */
/* ------------------------------------------------------------------ */

static const struct {
  const char *text;
  const char *const *ref;
  int version;
  const char *name;
} kRefs[] = {
    {ref_short_text, ref_short, 1, "short"},
    {ref_guest_text, ref_guest, 3, "guest"},
    {ref_v1max_text, ref_v1max, 1, "v1max"},
    {ref_v2min_text, ref_v2min, 2, "v2min"},
    {ref_v5_text, ref_v5, 5, "v5"},
    {ref_v7_text, ref_v7, 7, "v7"},
    {ref_v10max_text, ref_v10max, 10, "v10max"},
};

static void test_against_reference(void) {
  for (size_t c = 0; c < sizeof kRefs / sizeof kRefs[0]; c++) {
    qr_t qr;
    const char *const name = kRefs[c].name;

    CHECK(qr_encode(kRefs[c].text, &qr), "%s: encode failed", name);
    if (qr.version == 0) continue; /* nothing left to compare */

    /* Version selection first. A symbol that is right module-for-module at the
     * wrong version is not a thing, so a mismatch here explains whatever the
     * module comparison reports afterwards. */
    CHECK(qr.version == kRefs[c].version, "%s: version %d, reference says %d", name, qr.version,
          kRefs[c].version);
    const int size = 17 + 4 * kRefs[c].version;
    CHECK(qr.size == size, "%s: size %d, want %d", name, qr.size, size);
    if (qr.version != kRefs[c].version) continue;

    /* Then every module. Counted as one check per symbol rather than one per
     * module: 8991 passing lines would bury everything else in the output,
     * and only the first mismatch is worth reading. */
    int wrong = 0, first_x = 0, first_y = 0;
    for (int y = 0; y < size; y++) {
      const char *const row = kRefs[c].ref[y];
      CHECK(strlen(row) == (size_t)size, "%s: reference row %d is %zu wide, want %d", name, y,
            strlen(row), size);
      for (int x = 0; x < size; x++) {
        if (qr_module(&qr, x, y) != (row[x] == '1')) {
          if (wrong == 0) {
            first_x = x;
            first_y = y;
          }
          wrong++;
        }
      }
    }
    CHECK(wrong == 0, "%s: %d of %d modules differ, first at (%d,%d) - got %s, reference says %s",
          name, wrong, size * size, first_x, first_y,
          qr_module(&qr, first_x, first_y) ? "dark" : "light",
          kRefs[c].ref[first_y][first_x] == '1' ? "dark" : "light");
  }
}

/* ------------------------------------------------------------------ */
/* Rejections                                                          */
/* ------------------------------------------------------------------ */

static void test_rejections(void) {
  /* A caller that draws a failed symbol puts an unreadable QR-shaped rectangle
   * on the screen, so version == 0 has to survive every rejection path - which
   * is why each case starts from a struct pre-filled with garbage. */
  qr_t qr;

  memset(&qr, 0xAA, sizeof qr);
  CHECK(!qr_encode(NULL, &qr), "NULL text must be refused");
  CHECK(qr.version == 0, "NULL text must leave version 0, got %d", qr.version);

  memset(&qr, 0xAA, sizeof qr);
  CHECK(!qr_encode("", &qr), "empty text must be refused");
  CHECK(qr.version == 0, "empty text must leave version 0, got %d", qr.version);

  /* 214 bytes: one past what version 10 at level M holds. The boundary is worth
   * pinning because 271 - the level-L figure - is the number that gets
   * misremembered for this one. */
  char over[215];
  memset(over, 'K', sizeof over - 1);
  over[sizeof over - 1] = '\0';
  memset(&qr, 0xAA, sizeof qr);
  CHECK(!qr_encode(over, &qr), "214 bytes must be refused");
  CHECK(qr.version == 0, "over-long must leave version 0, got %d", qr.version);

  /* And 213 must still be accepted, or the check above is only evidence of a
   * broken encoder rather than of a boundary. */
  over[213] = '\0';
  CHECK(qr_encode(over, &qr), "213 bytes must still encode");
  CHECK(qr.version == QR_MAX_VERSION, "213 bytes -> version %d, want %d", qr.version,
        QR_MAX_VERSION);

  /* Far longer than any table entry, in case a length check indexes a capacity
   * table out of range instead of refusing. */
  char huge[4000];
  memset(huge, 'x', sizeof huge - 1);
  huge[sizeof huge - 1] = '\0';
  memset(&qr, 0xAA, sizeof qr);
  CHECK(!qr_encode(huge, &qr), "4000 bytes must be refused");
  CHECK(qr.version == 0, "4000 bytes must leave version 0, got %d", qr.version);

  /* A failed symbol reads as all-light, so a caller that ignores the return
   * value draws nothing rather than noise. */
  CHECK(!qr_module(&qr, 0, 0), "a failed symbol must read light");
  CHECK(!qr_module(NULL, 0, 0), "NULL symbol must read light");
}

/* ------------------------------------------------------------------ */
/* Out-of-range reads and the fixed patterns                           */
/* ------------------------------------------------------------------ */

static void test_bounds(void) {
  /* The header promises out-of-range reads are light, so a caller drawing a
   * quiet zone needs no bounds check of its own. */
  qr_t qr;
  CHECK(qr_encode(ref_guest_text, &qr), "guest URL should encode");
  CHECK(!qr_module(&qr, -1, 0), "x = -1");
  CHECK(!qr_module(&qr, 0, -1), "y = -1");
  CHECK(!qr_module(&qr, -4, -4), "the whole quiet-zone corner");
  CHECK(!qr_module(&qr, qr.size, 0), "x = size");
  CHECK(!qr_module(&qr, 0, qr.size), "y = size");
  CHECK(!qr_module(&qr, QR_MAX_SIZE + 10, QR_MAX_SIZE + 10), "well past the buffer");

  /* The top-left finder is the one part of every symbol whose value is fixed,
   * and it is what a decoder locks onto first. Worth asserting directly and not
   * only through the matrices, because a transposed x/y would still satisfy a
   * symmetric matrix comparison. */
  for (int i = 0; i < 7; i++) {
    CHECK(qr_module(&qr, i, 0), "finder top edge at x=%d", i);
    CHECK(qr_module(&qr, 0, i), "finder left edge at y=%d", i);
  }
  CHECK(!qr_module(&qr, 1, 1), "finder inner ring is light");
  CHECK(qr_module(&qr, 3, 3), "finder core is dark");
  CHECK(!qr_module(&qr, 7, 0), "separator right of the finder is light");
  CHECK(!qr_module(&qr, 0, 7), "separator below the finder is light");
}

int main(void) {
  test_against_reference();
  test_rejections();
  test_bounds();

  if (failures != 0) {
    printf("p4 qr tests: %d of %d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 qr tests: %d checks passed\n", checks);
  return 0;
}
