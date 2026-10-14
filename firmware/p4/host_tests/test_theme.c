/*
 * The on-glass palette, measured: ui_theme.h and the generated ui_palette.h.
 *
 *   make -C firmware/p4/host_tests test-theme
 *
 * What it proves, each on the RGB565 code the panel is sent, expanded the way
 * ui.c's rel_lum() expands it:
 *
 *   - every pair in K_PAIRS clears its floor (4.5:1 text, 3:1 edges, marks and
 *     the XL face), once per launch shade;
 *   - every launch shade: K_ACCENT_INK on it >= 7:1, it on K_GROUND >= 7:1,
 *     K_ACCENT_INK on its pressed variant >= 4.5:1, the pressed variant darker
 *     than the shade, and all eight shades distinct codes;
 *   - nothing is yellow: no palette colour, launch shade, pressed shade or
 *     boot-field ink;
 *   - the greys are neutral in their code (G6 = 2 R5 = 2 B5);
 *   - no launch shade or pressed shade packs to the code of a palette colour.
 *
 * The exemption list is empty. A pair that fails is fixed, not excused.
 */
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

/* ui_theme.h reads the launch shade from these two, as ui.c does. The test
 * sets them to each row of K_LAUNCH / K_LAUNCH_DOWN in turn. */
static uint16_t s_accent, s_accent_down;

#include "ui_theme.h"

static int g_fail, g_checks;

static void check(bool ok, const char *what) {
  g_checks++;
  if (!ok) {
    g_fail++;
    printf("FAIL %s\n", what);
  }
}

/* ui.c's rel_lum(), byte for byte: the integer expansion is part of the
 * figure, and a test that rounds differently is measuring another panel. */
static float rel_lum(uint16_t c) {
  const float r = (float)(((c >> 11) & 0x1F) * 255 / 31) / 255.0f;
  const float g = (float)(((c >> 5) & 0x3F) * 255 / 63) / 255.0f;
  const float b = (float)((c & 0x1F) * 255 / 31) / 255.0f;
  const float lr = r <= 0.03928f ? r / 12.92f : powf((r + 0.055f) / 1.055f, 2.4f);
  const float lg = g <= 0.03928f ? g / 12.92f : powf((g + 0.055f) / 1.055f, 2.4f);
  const float lb = b <= 0.03928f ? b / 12.92f : powf((b + 0.055f) / 1.055f, 2.4f);
  return 0.2126f * lr + 0.7152f * lg + 0.0722f * lb;
}

static float contrast(uint16_t a, uint16_t b) {
  const float la = rel_lum(a) + 0.05f, lb = rel_lum(b) + 0.05f;
  return la > lb ? la / lb : lb / la;
}

/*
 * Yellow, on the expanded 8-bit value: red leads blue by 32 or more, green is
 * at least 65 % of red, and blue is at most 80 % of green. Amber E8C070 and peach F7B58C
 * are yellow by this; the pinks, the reds, the warm inks and the greys are
 * not. KINO's rule is no yellow anywhere, MAO's own yellow included.
 */
static bool yellow(uint16_t c) {
  const int r = ((c >> 11) & 0x1F) * 255 / 31;
  const int g = ((c >> 5) & 0x3F) * 255 / 63;
  const int b = (c & 0x1F) * 255 / 31;
  return r - b >= 32 && g * 100 >= 65 * r && b * 100 <= 80 * g;
}

static bool neutral(uint16_t c) {
  const int r5 = (c >> 11) & 0x1F, g6 = (c >> 5) & 0x3F, b5 = c & 0x1F;
  return g6 == 2 * r5 && r5 == b5;
}

typedef struct {
  uint16_t ink, fill;
  int min10;
  const char *pair, *where;
} pair_t;

static void pairs_for_shade(int row) {
  s_accent = K_LAUNCH[row];
  s_accent_down = K_LAUNCH_DOWN[row];
#define X(ink, fill, min10, where) {ink, fill, min10, #ink " on " #fill, where},
  const pair_t pairs[] = {K_PAIRS(X)};
#undef X
  for (size_t i = 0; i < sizeof pairs / sizeof pairs[0]; i++) {
    const float c = contrast(pairs[i].ink, pairs[i].fill);
    char what[200];
    snprintf(what, sizeof what, "shade %d: %s %.2f < %.1f (%s)", row, pairs[i].pair, (double)c,
             pairs[i].min10 / 10.0, pairs[i].where);
    check(c * 10.0f >= (float)pairs[i].min10, what);
  }
}

static void test_pairs(void) {
  for (int row = 0; row < K_LAUNCH_N; row++) pairs_for_shade(row);
}

static void test_arc(void) {
  char what[160];
  for (int i = 0; i < K_LAUNCH_N; i++) {
    const uint16_t s = K_LAUNCH[i], d = K_LAUNCH_DOWN[i];
    snprintf(what, sizeof what, "shade %d %04X: accent ink on it %.2f < 7", i, s,
             (double)contrast(K_ACCENT_INK, s));
    check(contrast(K_ACCENT_INK, s) >= 7.0f, what);
    snprintf(what, sizeof what, "shade %d %04X: on the ground %.2f < 7", i, s, (double)contrast(s, K_GROUND));
    check(contrast(s, K_GROUND) >= 7.0f, what);
    snprintf(what, sizeof what, "shade %d pressed %04X: accent ink on it %.2f < 4.5", i, d,
             (double)contrast(K_ACCENT_INK, d));
    check(contrast(K_ACCENT_INK, d) >= 4.5f, what);
    snprintf(what, sizeof what, "shade %d: pressed %04X is not darker than %04X", i, d, s);
    check(rel_lum(d) < rel_lum(s), what);
    for (int j = 0; j < i; j++) {
      snprintf(what, sizeof what, "shades %d and %d share code %04X", j, i, s);
      check(K_LAUNCH[j] != s, what);
    }
  }
}

static void test_no_yellow(void) {
  char what[120];
#define X(name)                                                                  \
  snprintf(what, sizeof what, "%s %04X is yellow", #name, (unsigned)(name));     \
  check(!yellow(name), what);
  K_COLOURS(X)
#undef X
  for (int i = 0; i < K_LAUNCH_N; i++) {
    snprintf(what, sizeof what, "K_LAUNCH[%d] %04X is yellow", i, K_LAUNCH[i]);
    check(!yellow(K_LAUNCH[i]), what);
    snprintf(what, sizeof what, "K_LAUNCH_DOWN[%d] %04X is yellow", i, K_LAUNCH_DOWN[i]);
    check(!yellow(K_LAUNCH_DOWN[i]), what);
  }
}

static void test_greys(void) {
  /* The greys by name. K_INK, K_INK_QUIET and K_EDGE are MAO's warm inks on
   * purpose and are not on this list. */
  static const struct {
    uint16_t c;
    const char *name;
  } GREYS[] = {
      {K_GROUND, "K_GROUND"}, {K_SCRIM, "K_SCRIM"}, {K_SURFACE, "K_SURFACE"},
      {K_ROW, "K_ROW"},       {K_RULE, "K_RULE"},   {K_OFF, "K_OFF"},
  };
  char what[120];
  for (size_t i = 0; i < sizeof GREYS / sizeof GREYS[0]; i++) {
    snprintf(what, sizeof what, "%s %04X is not code-neutral", GREYS[i].name, GREYS[i].c);
    check(neutral(GREYS[i].c), what);
  }
}

static void test_distinct(void) {
  /* The generator already refuses two colours on one code. Here: a launch
   * shade or its pressed variant must not land on a palette colour either,
   * or a press would be indistinguishable from something at rest. */
  static const uint16_t COLOURS[] = {
#define X(name) name,
      K_COLOURS(X)
#undef X
  };
  char what[120];
  for (size_t c = 0; c < sizeof COLOURS / sizeof COLOURS[0]; c++) {
    for (int i = 0; i < K_LAUNCH_N; i++) {
      snprintf(what, sizeof what, "K_LAUNCH[%d] packs to palette colour %04X", i, COLOURS[c]);
      check(K_LAUNCH[i] != COLOURS[c], what);
      snprintf(what, sizeof what, "K_LAUNCH_DOWN[%d] packs to palette colour %04X", i, COLOURS[c]);
      check(K_LAUNCH_DOWN[i] != COLOURS[c], what);
    }
    for (size_t d = 0; d < c; d++) {
      snprintf(what, sizeof what, "two palette colours share %04X", COLOURS[c]);
      check(COLOURS[c] != COLOURS[d], what);
    }
  }
}

int main(void) {
  test_pairs();
  test_arc();
  test_no_yellow();
  test_greys();
  test_distinct();
  if (g_fail) {
    printf("test_theme: %d of %d checks failed\n", g_fail, g_checks);
    return 1;
  }
  printf("test_theme: %d checks passed\n", g_checks);
  return 0;
}
