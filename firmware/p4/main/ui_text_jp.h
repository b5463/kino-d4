// The Shinonome pixel faces, as the fallback under ui_type.h: the glyph
// lookup for any code point the baked interface type does not carry, drawn
// on the interface type's own baseline by ui_type.h.
//
// Included by ui.c after its drawing primitives: this file calls draw_bits()
// and px_set() and reads s_cv, and exists as a header so the host preview
// and the Twin build see exactly the code the camera runs, the way the rest
// of the UI is built.
//
// Two faces, one baseline: JIS X 0208 glyphs are 16 wide, the half-width set
// is 8, both 16 rows with the baseline JP16_DESCENT rows up. A string may mix
// them freely - "C02 白黒" is one call - and advances 16 or 8 cells times the
// scale. Scale is a whole number: these are pixel glyphs and a fraction of one
// is a smudge.
//
#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "ui_font_jp.h"

/** Decode one UTF-8 code point; advances *s. Malformed bytes yield U+FFFD and advance one byte. */
static uint32_t utf8_next(const char **s) {
  const unsigned char *p = (const unsigned char *)*s;
  uint32_t cp;
  int n;
  if (p[0] < 0x80) { cp = p[0]; n = 1; }
  else if ((p[0] & 0xe0) == 0xc0 && (p[1] & 0xc0) == 0x80) { cp = ((p[0] & 0x1f) << 6) | (p[1] & 0x3f); n = 2; }
  else if ((p[0] & 0xf0) == 0xe0 && (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80) {
    cp = ((p[0] & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f); n = 3;
  } else if ((p[0] & 0xf8) == 0xf0 && (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80 && (p[3] & 0xc0) == 0x80) {
    cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3f) << 12) | ((p[2] & 0x3f) << 6) | (p[3] & 0x3f); n = 4;
  } else { cp = 0xfffd; n = 1; }
  *s += n;
  return cp;
}

static int cp_find(const uint16_t *table, int count, uint32_t cp) {
  if (cp > 0xffff) return -1;
  int lo = 0, hi = count - 1;
  while (lo <= hi) {
    const int mid = (lo + hi) >> 1;
    if (table[mid] == cp) return mid;
    if (table[mid] < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* One glyph, resolved: its bitmap, stride and cell width. Half-width first
 * for anything it has (ASCII, Latin-1, half katakana), the 0208 set for the
 * rest. A code point neither has draws as a 0208 tofu box so a missing glyph
 * is visible on the bench instead of silently shortening a word. */
typedef struct {
  const uint8_t *bits;
  int w;      /* 8 or 16 */
  int stride; /* 1 or 2 */
} jglyph_t;

static const uint8_t JP_TOFU[32] = {
    0x7f, 0xfe, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02,
    0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x40, 0x02, 0x7f, 0xfe, 0x00, 0x00, 0x00, 0x00,
};

static jglyph_t jglyph(uint32_t cp) {
  int i = cp_find(HW16_CP, HW16_COUNT, cp);
  if (i >= 0) return (jglyph_t){HW16_BITS[i], 8, 1};
  i = cp_find(JP16_CP, JP16_COUNT, cp);
  if (i >= 0) return (jglyph_t){JP16_BITS[i], 16, 2};
  return (jglyph_t){JP_TOFU, 16, 2};
}
