/*
 * QR encoding for the Roll join code. Byte mode, level M, versions 1 to 10.
 *
 * Structured after ISO/IEC 18004 section by section: pick a version, build the
 * bit stream, block it up and add Reed-Solomon parity, draw the function
 * patterns, thread the codewords through the free modules, then try all eight
 * data masks and keep the one the penalty rules like best.
 *
 * The mask search is not decoration. Every mask produces a decodable symbol, so
 * a fixed mask still scans on the bench and then fails in the field on the one
 * URL that happens to lay a large blank field or a finder-lookalike across the
 * symbol. That is a worse failure than not drawing a QR at all, because nothing
 * on the camera can tell it happened. It is why the penalty scoring is here in
 * full rather than approximated.
 *
 * No allocation and no ESP-IDF: the working grids are two 456-byte bitfields
 * and the codeword buffers are 562 bytes, all on the caller's stack. That keeps
 * it host-testable, which is where its correctness is actually established -
 * firmware/p4/host_tests/test_qr.c checks every module of every test symbol
 * against matrices produced by an unrelated encoder.
 */
#include "qr.h"

#include <string.h>

/* ------------------------------------------------------------------ */
/* Version tables (level M only)                                       */
/* ------------------------------------------------------------------ */

#define QR_MAX_BLOCKS 5 /* version 10 at level M: 4 + 1 */
#define QR_MAX_ECC 26   /* EC codewords per block, version 10 */
#define QR_MAX_DATA_CW 216
#define QR_MAX_TOTAL_CW 346

/* ISO/IEC 18004 Table 9, level-M rows. Group-2 blocks always hold exactly one
 * data codeword more than a group-1 block - that is the only shape the standard
 * uses - so their size needs no column of its own. */
static const struct {
  uint16_t data_cw;  /* data codewords across all blocks */
  uint8_t ec_cw;     /* EC codewords per block */
  uint8_t g1_blocks; /* blocks holding g1_cw data codewords */
  uint8_t g1_cw;
  uint8_t g2_blocks; /* blocks holding g1_cw + 1 */
} kVer[QR_MAX_VERSION + 1] = {
    {0, 0, 0, 0, 0}, /* version 0 does not exist */
    {16, 10, 1, 16, 0},  {28, 16, 1, 28, 0},  {44, 26, 1, 44, 0},
    {64, 18, 2, 32, 0},  {86, 24, 2, 43, 0},  {108, 16, 4, 27, 0},
    {124, 18, 4, 31, 0}, {154, 22, 2, 38, 2}, {182, 22, 3, 36, 2},
    {216, 26, 4, 43, 1},
};

/* Alignment-pattern centre coordinates: two up to version 6, three from version
 * 7, none at all at version 1. */
static const uint8_t kAlign[QR_MAX_VERSION + 1][3] = {
    {0, 0, 0},  {0, 0, 0},   {6, 18, 0},  {6, 22, 0},  {6, 26, 0}, {6, 30, 0},
    {6, 34, 0}, {6, 22, 38}, {6, 24, 42}, {6, 26, 46}, {6, 28, 50},
};

/* ------------------------------------------------------------------ */
/* Bit grids                                                           */
/* ------------------------------------------------------------------ */

/* Two grids are live at once - module colour, and "this belongs to a function
 * pattern, do not mask it" - so both are bitfields. A byte per module would be
 * 3.2 KB each at version 10 and the UI task's stack is not that generous. */
typedef uint8_t grid_t[QR_MAX_SIZE][QR_ROW_BYTES];

static bool gget(uint8_t g[][QR_ROW_BYTES], int x, int y) {
  return (g[y][x >> 3] >> (7 - (x & 7))) & 1;
}

static void gset(uint8_t g[][QR_ROW_BYTES], int x, int y, bool v) {
  const uint8_t m = (uint8_t)(0x80u >> (x & 7));
  if (v) {
    g[y][x >> 3] |= m;
  } else {
    g[y][x >> 3] = (uint8_t)(g[y][x >> 3] & (uint8_t)~m);
  }
}

/* ------------------------------------------------------------------ */
/* GF(256) and Reed-Solomon                                            */
/* ------------------------------------------------------------------ */

/* Carry-less multiply reduced by the QR field polynomial x^8+x^4+x^3+x^2+1.
 * Computed rather than table-driven: 768 bytes of log/antilog tables buy
 * nothing when the largest block needs 26 parity bytes over 44 data bytes. */
static uint8_t gf_mul(uint8_t x, uint8_t y) {
  uint8_t z = 0;
  for (int i = 7; i >= 0; i--) {
    z = (uint8_t)((z << 1) ^ ((z >> 7) * 0x11D));
    z = (uint8_t)(z ^ (((y >> i) & 1) * x));
  }
  return z;
}

/* Coefficients of the degree-`degree` generator polynomial, highest power
 * first, with the implicit monic leading term dropped. */
static void rs_divisor(int degree, uint8_t *out) {
  memset(out, 0, (size_t)degree);
  out[degree - 1] = 1;
  uint8_t root = 1;
  for (int i = 0; i < degree; i++) {
    for (int j = 0; j < degree; j++) {
      out[j] = gf_mul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gf_mul(root, 0x02);
  }
}

static void rs_remainder(const uint8_t *data, int len, const uint8_t *div, int degree,
                         uint8_t *out) {
  memset(out, 0, (size_t)degree);
  for (int i = 0; i < len; i++) {
    const uint8_t factor = (uint8_t)(data[i] ^ out[0]);
    memmove(out, out + 1, (size_t)(degree - 1));
    out[degree - 1] = 0;
    for (int j = 0; j < degree; j++) out[j] ^= gf_mul(div[j], factor);
  }
}

/* ------------------------------------------------------------------ */
/* Function patterns                                                   */
/* ------------------------------------------------------------------ */

static void mark(uint8_t base[][QR_ROW_BYTES], uint8_t rsv[][QR_ROW_BYTES], int size, int x, int y,
                 bool dark) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  gset(base, x, y, dark);
  gset(rsv, x, y, true);
}

static void draw_function_patterns(uint8_t base[][QR_ROW_BYTES], uint8_t rsv[][QR_ROW_BYTES],
                                   int version, int size) {
  /* Finder patterns and their separators in one 9x9 sweep per corner. The
   * separator is a light ring; reserving it is what keeps the mask off it. */
  const int corners[3][2] = {{0, 0}, {size - 7, 0}, {0, size - 7}};
  for (int c = 0; c < 3; c++) {
    for (int dy = -1; dy <= 7; dy++) {
      for (int dx = -1; dx <= 7; dx++) {
        const bool inner = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const bool ring = dx == 0 || dx == 6 || dy == 0 || dy == 6;
        const bool core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        mark(base, rsv, size, corners[c][0] + dx, corners[c][1] + dy, inner && (ring || core));
      }
    }
  }

  /* Timing patterns: row 6 and column 6, dark on even coordinates. */
  for (int i = 0; i < size; i++) {
    if (!gget(rsv, i, 6)) mark(base, rsv, size, i, 6, i % 2 == 0);
    if (!gget(rsv, 6, i)) mark(base, rsv, size, 6, i, i % 2 == 0);
  }

  /* Alignment patterns at every pair of centres except the three that would sit
   * on a finder. The skip is by index, not by "is it already reserved": from
   * version 7 the centre on the timing line at (6, a) is a real alignment
   * pattern, and a reservation test would wrongly drop it. */
  const int n = version >= 7 ? 3 : (version >= 2 ? 2 : 0);
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      if ((i == 0 && j == 0) || (i == 0 && j == n - 1) || (i == n - 1 && j == 0)) continue;
      const int cx = kAlign[version][i], cy = kAlign[version][j];
      for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
          const bool edge = dx == -2 || dx == 2 || dy == -2 || dy == 2;
          mark(base, rsv, size, cx + dx, cy + dy, edge || (dx == 0 && dy == 0));
        }
      }
    }
  }

  /* Format-information area. The bits depend on the mask, so only the
   * reservation happens here and the values are written per candidate. The
   * module at (8, size-8) is dark in every symbol.
   *
   * Coordinate 6 is skipped in both directions: that module belongs to the
   * timing pattern, not to the format word, and clearing it here silently
   * breaks a decoder's row/column sampling grid. */
  for (int i = 0; i <= 8; i++) {
    if (i == 6) continue;
    mark(base, rsv, size, 8, i, false);
    mark(base, rsv, size, i, 8, false);
  }
  for (int i = 0; i < 8; i++) mark(base, rsv, size, size - 1 - i, 8, false);
  for (int i = 0; i < 7; i++) mark(base, rsv, size, 8, size - 1 - i, false);
  mark(base, rsv, size, 8, size - 8, true);

  /* Version information from version 7 up: an 18-bit Golay word in two 3x6
   * blocks. Independent of the mask, so it is drawn once. */
  if (version >= 7) {
    uint32_t rem = (uint32_t)version;
    for (int i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1F25u);
    const uint32_t bits = ((uint32_t)version << 12) | (rem & 0xFFFu);
    for (int i = 0; i < 18; i++) {
      const bool b = (bits >> i) & 1;
      mark(base, rsv, size, size - 11 + i % 3, i / 3, b);
      mark(base, rsv, size, i / 3, size - 11 + i % 3, b);
    }
  }
}

/* Level M is error-correction value 0, so the 5-bit BCH input is just the mask
 * number. Both copies of the 15-bit word are written. */
static void draw_format(uint8_t g[][QR_ROW_BYTES], int size, int mask) {
  uint32_t rem = (uint32_t)mask;
  for (int i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537u);
  const uint32_t bits = (((uint32_t)mask << 10) | (rem & 0x3FFu)) ^ 0x5412u;

  for (int i = 0; i <= 5; i++) gset(g, 8, i, (bits >> i) & 1);
  gset(g, 8, 7, (bits >> 6) & 1);
  gset(g, 8, 8, (bits >> 7) & 1);
  gset(g, 7, 8, (bits >> 8) & 1);
  for (int i = 9; i < 15; i++) gset(g, 14 - i, 8, (bits >> i) & 1);

  for (int i = 0; i < 8; i++) gset(g, size - 1 - i, 8, (bits >> i) & 1);
  for (int i = 8; i < 15; i++) gset(g, 8, size - 15 + i, (bits >> i) & 1);
  gset(g, 8, size - 8, true);
}

/* ------------------------------------------------------------------ */
/* Masking and penalty scoring                                         */
/* ------------------------------------------------------------------ */

static bool mask_at(int m, int x, int y) {
  switch (m) {
    case 0: return (y + x) % 2 == 0;
    case 1: return y % 2 == 0;
    case 2: return x % 3 == 0;
    case 3: return (y + x) % 3 == 0;
    case 4: return (y / 2 + x / 3) % 2 == 0;
    case 5: return (y * x) % 2 + (y * x) % 3 == 0;
    case 6: return ((y * x) % 2 + (y * x) % 3) % 2 == 0;
    default: return ((y + x) % 2 + (y * x) % 3) % 2 == 0;
  }
}

/* ISO/IEC 18004 section 8.8.2, all four rules. Lower is better. */
static int penalty(uint8_t g[][QR_ROW_BYTES], int size) {
  int p = 0;
  int dark = 0;

  /* Rules 1 and 3 in one sweep, horizontal and vertical together. The 11-bit
   * windows 10111010000 and 00001011101 are the 1:1:3:1:1 finder ratio with its
   * four-module light margin on one side or the other - a decoder that latches
   * onto one of those inside the data area mislocates the whole symbol. */
  for (int a = 0; a < size; a++) {
    bool prev_h = gget(g, 0, a), prev_v = gget(g, a, 0);
    int run_h = 0, run_v = 0;
    unsigned win_h = 0, win_v = 0;
    for (int b = 0; b < size; b++) {
      const bool h = gget(g, b, a), v = gget(g, a, b);
      if (h == prev_h) {
        run_h++;
      } else {
        if (run_h >= 5) p += 3 + run_h - 5;
        prev_h = h;
        run_h = 1;
      }
      if (v == prev_v) {
        run_v++;
      } else {
        if (run_v >= 5) p += 3 + run_v - 5;
        prev_v = v;
        run_v = 1;
      }
      win_h = ((win_h << 1) & 0x7FFu) | (unsigned)(h ? 1 : 0);
      win_v = ((win_v << 1) & 0x7FFu) | (unsigned)(v ? 1 : 0);
      if (b >= 10) {
        if (win_h == 0x5D0u || win_h == 0x05Du) p += 40;
        if (win_v == 0x5D0u || win_v == 0x05Du) p += 40;
      }
      dark += h ? 1 : 0; /* the horizontal sweep visits every module once */
    }
    if (run_h >= 5) p += 3 + run_h - 5;
    if (run_v >= 5) p += 3 + run_v - 5;
  }

  /* Rule 2: every 2x2 block of a single colour. */
  for (int y = 0; y + 1 < size; y++) {
    for (int x = 0; x + 1 < size; x++) {
      const int s = (gget(g, x, y) ? 1 : 0) + (gget(g, x + 1, y) ? 1 : 0) +
                    (gget(g, x, y + 1) ? 1 : 0) + (gget(g, x + 1, y + 1) ? 1 : 0);
      if (s == 0 || s == 4) p += 3;
    }
  }

  /* Rule 4: deviation of the dark proportion from 50% in 5% steps. Kept in
   * integers - floor(|dark*100/total - 50| / 5) with no float anywhere. */
  const int total = size * size;
  int dev = dark * 100 - total * 50;
  if (dev < 0) dev = -dev;
  p += (dev / (5 * total)) * 10;

  return p;
}

/* ------------------------------------------------------------------ */
/* Bit stream                                                          */
/* ------------------------------------------------------------------ */

static void put_bits(uint8_t *buf, int *pos, uint32_t val, int n) {
  for (int i = n - 1; i >= 0; i--) {
    if ((val >> i) & 1) buf[*pos >> 3] |= (uint8_t)(0x80u >> (*pos & 7));
    (*pos)++;
  }
}

/* Byte-mode capacity in characters. Derived rather than tabulated so the two
 * numbers cannot disagree: total data bits, less the 4-bit mode indicator and
 * the character-count indicator, which widens from 8 to 16 bits at version 10.
 * At version 10 that is 213 bytes, not the 271 that level L holds. */
static int byte_capacity(int version) {
  const int bits = kVer[version].data_cw * 8 - 4 - (version <= 9 ? 8 : 16);
  return bits / 8;
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/* Renders `base` into `out` with mask `m` applied to the free modules, then
 * writes the format information for that mask. */
static void render(qr_t *out, uint8_t base[][QR_ROW_BYTES], uint8_t rsv[][QR_ROW_BYTES], int size,
                   int m) {
  memcpy(out->modules, base, sizeof out->modules);
  for (int y = 0; y < size; y++) {
    for (int x = 0; x < size; x++) {
      if (gget(rsv, x, y)) continue;
      if (mask_at(m, x, y)) gset(out->modules, x, y, !gget(out->modules, x, y));
    }
  }
  draw_format(out->modules, size, m);
}

bool qr_encode(const char *text, qr_t *out) {
  if (out == NULL) return false;
  memset(out, 0, sizeof *out);
  if (text == NULL) return false;

  const size_t len = strlen(text);
  if (len == 0) return false;

  int version = 0;
  for (int v = 1; v <= QR_MAX_VERSION; v++) {
    if (len <= (size_t)byte_capacity(v)) {
      version = v;
      break;
    }
  }
  if (version == 0) return false; /* longer than version 10 at level M holds */

  const int size = 17 + 4 * version;
  const int data_cw = kVer[version].data_cw;

  /* Mode indicator, character count, payload, terminator, then the alternating
   * 0xEC / 0x11 pad the standard specifies. */
  uint8_t data[QR_MAX_DATA_CW];
  memset(data, 0, sizeof data);
  int pos = 0;
  put_bits(data, &pos, 0x4, 4);
  put_bits(data, &pos, (uint32_t)len, version <= 9 ? 8 : 16);
  for (size_t i = 0; i < len; i++) put_bits(data, &pos, (uint8_t)text[i], 8);
  /* The buffer starts zeroed, so the four terminator bits and the padding up to
   * the byte boundary need an advance, not a write. */
  const int cap_bits = data_cw * 8;
  pos = pos + 4 < cap_bits ? pos + 4 : cap_bits;
  pos = (pos + 7) & ~7;
  for (int i = pos / 8; i < data_cw; i++) data[i] = ((i - pos / 8) % 2 == 0) ? 0xEC : 0x11;

  /* Parity per block, then interleave. The shorter blocks come first, which is
   * what makes a mixed-size version's interleave recoverable. */
  const int nb1 = kVer[version].g1_blocks;
  const int nb = nb1 + kVer[version].g2_blocks;
  const int c1 = kVer[version].g1_cw, necc = kVer[version].ec_cw;
  uint8_t div[QR_MAX_ECC];
  uint8_t ecc[QR_MAX_BLOCKS][QR_MAX_ECC];
  rs_divisor(necc, div);
  int off = 0;
  for (int b = 0; b < nb; b++) {
    const int blen = b < nb1 ? c1 : c1 + 1;
    rs_remainder(data + off, blen, div, necc, ecc[b]);
    off += blen;
  }

  uint8_t all[QR_MAX_TOTAL_CW];
  int n = 0;
  for (int i = 0; i <= c1; i++) {
    off = 0;
    for (int b = 0; b < nb; b++) {
      const int blen = b < nb1 ? c1 : c1 + 1;
      if (i < blen) all[n++] = data[off + i];
      off += blen;
    }
  }
  for (int i = 0; i < necc; i++) {
    for (int b = 0; b < nb; b++) all[n++] = ecc[b][i];
  }

  /* Function patterns, then the codewords threaded up and down the free modules
   * in two-wide columns from the right. Column 6 is skipped: it is the vertical
   * timing pattern, not a data column. */
  grid_t base, rsv;
  memset(base, 0, sizeof base);
  memset(rsv, 0, sizeof rsv);
  draw_function_patterns(base, rsv, version, size);

  int bit = 0;
  const int total_bits = n * 8;
  for (int right = size - 1; right >= 1; right -= 2) {
    if (right == 6) right = 5;
    for (int vert = 0; vert < size; vert++) {
      /* Direction alternates per column PAIR, so it is keyed on `right` and not
       * on x. The two differ only for the pair left of the timing column, where
       * the 6 -> 5 skip makes `right` odd - which is exactly the region that
       * comes out wrong if this reads x instead. */
      const bool upward = ((right + 1) & 2) == 0;
      for (int j = 0; j < 2; j++) {
        const int x = right - j;
        const int y = upward ? size - 1 - vert : vert;
        if (gget(rsv, x, y) || bit >= total_bits) continue;
        gset(base, x, y, (all[bit >> 3] >> (7 - (bit & 7))) & 1);
        bit++;
      }
    }
  }

  /* All eight masks, lowest penalty wins. Nine renders of a 57x57 grid is a
   * few hundred microseconds on the P4 and happens once per Roll, so there is
   * no reason to shortcut it. */
  int best_mask = 0, best_score = 0;
  for (int m = 0; m < 8; m++) {
    render(out, base, rsv, size, m);
    const int s = penalty(out->modules, size);
    if (m == 0 || s < best_score) {
      best_score = s;
      best_mask = m;
    }
  }
  if (best_mask != 7) render(out, base, rsv, size, best_mask);

  out->version = version;
  out->size = size;
  return true;
}

bool qr_module(const qr_t *qr, int x, int y) {
  if (qr == NULL || qr->version == 0) return false;
  if (x < 0 || y < 0 || x >= qr->size || y >= qr->size) return false;
  return (qr->modules[y][x >> 3] >> (7 - (x & 7))) & 1;
}
