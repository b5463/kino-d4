// KINO's own display face — drawn, not licensed.
//
// The numerals are the recurring objects in this interface: the four lenses,
// the counts, the page, the index, the temperature, the time. Setting them in
// a downloaded text font is what makes an embedded interface look like a
// website, so they are drawn here instead, on a grid, with decisions in them:
//
//   - a diagonal through the zero, the way instruments draw it
//   - a flat-topped one with a full base, so it cannot be mistaken for I
//   - a square-shouldered seven with a crossbar
//   - flat terminals everywhere; no curves that a 217 ppi panel cannot hold
//   - a single stroke weight, because the panel is small and contrast is not
//
// Authored as pictures rather than as hex, because a bitmap face that cannot
// be read in its own source cannot be edited. '#' is ink.
//
// One size, drawn at 14 rows, and integer-scaled for everything larger. A
// drawn face scaled by two is still drawn; a text face scaled by two is a
// blurry text face.
#pragma once

#define DF_W 10
#define DF_H 14
#define DF_ADV 12 /* the pitch: numerals are tabular, always */

/* 0123456789 then: / % . - + : ° x, a space, and D - the one letter in here,
 * because D4 is the model number and a model number is an object like the
 * rest of them, not a word. Every other letter belongs to the label face. */
#define DF_GLYPHS 20

static const char *const DF_ROWS[DF_GLYPHS][DF_H] = {
    {/* 0 */
     "..######..", ".##....##.", "##......##", "##.....###", "##....####", "##...##.##", "##..##..##",
     "##.##..###", "####...###", "###....###", "##......##", ".##....##.", "..######..", ".........."},
    {/* 1 - the flag is on the left only and the foot is narrower than the
        cap of an I, because a tabular 1 that can be read as a letter is no
        use to a camera that prints 1 2 3 4 everywhere. */
     "....##....", "...###....", "..####....", ".##.##....", "....##....", "....##....", "....##....",
     "....##....", "....##....", "....##....", "....##....", "..######..", "..######..", ".........."},
    {/* 2 */
     ".#######..", "###...###.", "##.....###", ".......###", "......####", ".....####.", "....####..",
     "...####...", "..####....", ".####.....", "####......", "##########", "##########", ".........."},
    {/* 3 */
     ".#######..", "###...###.", "##.....###", ".......###", "....#####.", "....#####.", ".......###",
     ".......###", "##.....###", "##.....###", "###...###.", ".#######..", "..........", ".........."},
    {/* 4 */
     ".....###..", "....####..", "...##.##..", "..##..##..", ".##...##..", "##....##..", "##....##..",
     "##########", "##########", "......##..", "......##..", "......##..", "......##..", ".........."},
    {/* 5 */
     "##########", "##########", "##........", "##........", "########..", "##....###.", ".......###",
     ".......###", ".......###", "##.....###", "###...###.", ".#######..", "..........", ".........."},
    {/* 6 */
     "...#####..", "..###.###.", ".###......", "##........", "##........", "########..", "###...###.",
     "##.....###", "##.....###", "##.....###", "###...###.", ".#######..", "..........", ".........."},
    {/* 7 */
     "##########", "##########", ".......###", "......###.", ".....###..", "....###...", ".########.",
     ".########.", "...###....", "..###.....", "..###.....", "..###.....", "..........", ".........."},
    {/* 8 */
     ".#######..", "###...###.", "##.....###", "##.....###", "###...###.", ".#######..", "###...###.",
     "##.....###", "##.....###", "##.....###", "###...###.", ".#######..", "..........", ".........."},
    {/* 9 */
     ".#######..", "###...###.", "##.....###", "##.....###", "##.....###", "###...###.", "..########",
     ".......###", ".......###", "......###.", ".###.###..", "..#####...", "..........", ".........."},
    {/* / */
     ".......##.", ".......##.", "......##..", "......##..", ".....##...", ".....##...", "....##....",
     "....##....", "...##.....", "...##.....", "..##......", "..##......", "..........", ".........."},
    {/* % */
     "###....##.", "#.#...##..", "###..##...", "....##....", "...##.....", "..##...###", "..##...#.#",
     ".##....###", ".##.......", "##........", "##........", "..........", "..........", ".........."},
    {/* . */
     "..........", "..........", "..........", "..........", "..........", "..........", "..........",
     "..........", "..........", "..........", "...###....", "...###....", "..........", ".........."},
    {/* - */
     "..........", "..........", "..........", "..........", "..........", "..######..", "..######..",
     "..........", "..........", "..........", "..........", "..........", "..........", ".........."},
    {/* + */
     "..........", "..........", "....##....", "....##....", "....##....", ".########.", ".########.",
     "....##....", "....##....", "....##....", "..........", "..........", "..........", ".........."},
    {/* : */
     "..........", "..........", "...###....", "...###....", "..........", "..........", "..........",
     "..........", "...###....", "...###....", "..........", "..........", "..........", ".........."},
    {/* ° */
     ".####.....", "##..##....", "##..##....", ".####.....", "..........", "..........", "..........",
     "..........", "..........", "..........", "..........", "..........", "..........", ".........."},
    {/* x */
     "..........", "..........", "..##...##.", "...##.##..", "....###...", "....###...", "...##.##..",
     "..##...##.", "..........", "..........", "..........", "..........", "..........", ".........."},
    {/* space */
     "..........", "..........", "..........", "..........", "..........", "..........", "..........",
     "..........", "..........", "..........", "..........", "..........", "..........", ".........."},
    {/* D */
     "########..", "#########.", "##.....##.", "##......##", "##......##", "##......##", "##......##",
     "##......##", "##......##", "##......##", "##.....##.", "#########.", "########..", ".........."},
};

static int df_index(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  switch (c) {
    case '/': return 10;
    case '%': return 11;
    case '.': return 12;
    case '-': return 13;
    case '+': return 14;
    case ':': return 15;
    case '^': return 16; /* the degree mark, as plain ASCII in the source */
    case 'x': case 'X': return 17;
    case 'D': case 'd': return 19;
    default: return 18;
  }
}

/** Width of `s` drawn at `scale`. Tabular, so it is just a count. */
static int df_w(const char *s, int scale) {
  int n = 0;
  for (const char *p = s; *p; p++) n++;
  return n > 0 ? (n * DF_ADV - (DF_ADV - DF_W)) * scale : 0;
}

/**
 * Draw `s` with its top-left at (x, y), `scale` panel pixels per drawn pixel.
 * No antialiasing and no subpixel placement: this face is a grid of squares
 * and putting it anywhere but on the grid is what makes drawn type look like
 * a mistake.
 */
static int df_draw(int x, int y, const char *s, int scale, uint16_t ink) {
  for (const char *p = s; *p; p++) {
    const char *const *g = DF_ROWS[df_index(*p)];
    for (int r = 0; r < DF_H; r++)
      for (int c = 0; c < DF_W; c++)
        if (g[r][c] == '#') fill(x + c * scale, y + r * scale, scale, scale, ink);
    x += DF_ADV * scale;
  }
  return x;
}

/**
 * The same, over a photograph: the glyph dilated by one panel pixel in dark
 * underneath it. A bitmap face has no antialiased edge to lose, so one pixel
 * is enough here where the text face needed two.
 */
static int df_draw_over(int x, int y, const char *s, int scale, uint16_t ink) {
  static const int OX[4] = {-1, 1, 0, 0}, OY[4] = {0, 0, -1, 1};
  for (int k = 0; k < 4; k++) df_draw(x + OX[k], y + OY[k], s, scale, RGB(0x08, 0x08, 0x0A));
  return df_draw(x, y, s, scale, ink);
}
static void df_draw_over_r(int right, int y, const char *s, int scale, uint16_t ink) {
  df_draw_over(right - df_w(s, scale), y, s, scale, ink);
}

static void df_draw_r(int right, int y, const char *s, int scale, uint16_t ink) {
  df_draw(right - df_w(s, scale), y, s, scale, ink);
}
static void df_draw_c(int cx, int y, const char *s, int scale, uint16_t ink) {
  df_draw(cx - df_w(s, scale) / 2, y, s, scale, ink);
}

/* ------------------------------------------------------------------ */
/* The wordmark                                                        */
/*
 * Drawn, for the same reason the numerals are. It appears at boot and nowhere
 * else - a camera that puts its own name on the screen while you are trying
 * to use it is a camera that thinks it is the point.
 *
 * KINO in a squared face with the O drawn as the lens it is, and D4 set apart
 * in the numeral face. 16 rows.
 */
#define DW_H 16
static const char *const DW_KINO[DW_H] = {
    "##.....##....#######....####...##......#####..",
    "##....##.....#######....####...##.....#######.",
    "##...##........###......####...##....##.....##",
    "##..##.........###......##.##..##....##.....##",
    "##.##..........###......##.##..##....##.....##",
    "####...........###......##.##..##....##.....##",
    "####...........###......##..##.##....##.....##",
    "##.##..........###......##..##.##....##.....##",
    "##..##.........###......##...####....##.....##",
    "##...##........###......##...####....##.....##",
    "##....##.......###......##...####....##.....##",
    "##.....##....#######....##....###.....#######.",
    "##.....##....#######....##....###......#####..",
    "..............................................",
    "..............................................",
    "..............................................",
};

static void dw_draw(int x, int y, int scale, uint16_t ink) {
  for (int r = 0; r < DW_H; r++)
    for (int c = 0; DW_KINO[r][c]; c++)
      if (DW_KINO[r][c] == '#') fill(x + c * scale, y + r * scale, scale, scale, ink);
}
static int dw_w(int scale) {
  int n = 0;
  while (DW_KINO[0][n]) n++;
  return n * scale;
}
