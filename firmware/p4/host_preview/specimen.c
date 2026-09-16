/*
 * The specimen sheet: the four guest screens, in three candidate registers.
 *
 * firmware/D4_INTERACTION.md settles what the camera is - a party camera
 * passed between strangers, with an owner's half behind a physical lock
 * switch - and deliberately does not settle what it looks like. Four previous
 * attempts at that were written as whole products and judged after they were
 * built. This is the correction: twelve screens, at the panel's real size,
 * drawn with the firmware's own primitives, judged before anything else is
 * touched.
 *
 * The four guest screens are AIM, TAKING, TAKEN and WRONG. They are the whole
 * guest half of the product, so if a register cannot carry these four it
 * cannot carry the camera.
 *
 * The three registers are three different answers to the only question a
 * party camera has to answer, which is how it tells a stranger what to do:
 *
 *   A  SAYS NOTHING     the picture, and four ticks. The object teaches by
 *                       being a camera: you point it and you press the button.
 *   B  SAYS ONE THING   the picture, and one enormous readout that changes
 *                       with the state. Nothing is ever second.
 *   C  SHOWS ITS WORK   the four ARE the interface. The screen is divided by
 *                       the lenses at all times and the state is what they do.
 *
 * Nothing here is firmware. It is included by preview.c after ui.c so it can
 * use the same fill, the same faces and the same four_mark the camera draws
 * with - a specimen in a different renderer would be a picture of a design
 * rather than the design.
 */

/* One ground for all three: a party is a dark room, and a stranger at arm's
 * length needs the contrast before it needs anything else. */
#define SP_INK RGB(0xf2, 0xf4, 0xf7)
#define SP_DIM RGB(0x7a, 0x86, 0x94)
#define SP_GROUND RGB(0x0c, 0x0e, 0x11)
#define SP_HOT RGB(0xff, 0xd2, 0x2a) /* the one accent: a photographic event */
#define SP_BAD RGB(0xe0, 0x4b, 0x3c)

typedef enum { SP_AIM = 0, SP_TAKING, SP_TAKEN, SP_WRONG } sp_screen_t;

/* The picture, scaled to any rectangle by nearest neighbour. The camera's own
 * finder does this with prebuilt maps; a specimen can afford the divides. */
static void sp_pic(const uint16_t *tile, int dx, int dy, int dw, int dh) {
  if (tile == NULL) {
    fill(dx, dy, dw, dh, RGB(0x1a, 0x1e, 0x24));
    return;
  }
  for (int y = 0; y < dh; y++) {
    const uint16_t *src = tile + (size_t)(y * VF_H / dh) * VF_W;
    uint16_t *dst = s_cv + (size_t)(dy + y) * UI_W + dx;
    for (int x = 0; x < dw; x++) dst[x] = src[x * VF_W / dw];
  }
}

/* The four, as ticks on the top edge of a photograph: one per lens, each over
 * the quarter of the picture its camera made. `len[4]` in pixels, 0 to skip. */
static void sp_ticks(const int *len, const uint16_t *ink) {
  for (int i = 0; i < 4; i++) {
    if (len[i] <= 0) continue;
    const int cx = UI_W / 8 + i * (UI_W / 4);
    fill(cx - 3, 0, 6, len[i] + 2, RGB(0x00, 0x00, 0x00));
    fill(cx - 2, 0, 4, len[i], ink[i]);
  }
}

/* ---------------------------------------------------------------- */
/* A — SAYS NOTHING                                                  */

static void sp_a(sp_screen_t s) {
  fill(0, 0, UI_W, UI_H, SP_GROUND);
  sp_pic(viewfinder_tile(1), 0, 0, UI_W, UI_H);

  int len[4] = {10, 10, 10, 10};
  uint16_t ink[4] = {SP_INK, SP_INK, SP_INK, SP_INK};
  if (s == SP_TAKING) {
    len[0] = len[1] = 26;
    ink[0] = ink[1] = SP_HOT;
  } else if (s == SP_TAKEN) {
    for (int i = 0; i < 4; i++) { len[i] = 26; ink[i] = SP_HOT; }
  } else if (s == SP_WRONG) {
    for (int i = 0; i < 4; i++) { len[i] = 26; ink[i] = SP_BAD; }
  }
  sp_ticks(len, ink);

  if (s == SP_WRONG) {
    /* The one screen that speaks. Over the picture, because the picture is
     * what did not happen. */
    fill(0, UI_H / 2 - 44, UI_W, 88, RGB(0x00, 0x00, 0x00));
    fill(0, UI_H / 2 - 44, UI_W, 3, SP_BAD);
    text_scaled_mid(&UI_FONT_M, UI_W / 2, UI_H / 2 - 28, "NO ROOM", 2, SP_INK);
    return;
  }
  /* The only chrome: how many are left, bottom left, and nothing else. */
  if (s == SP_AIM) text_scaled(&UI_FONT_M, 24, UI_H - 68, "128", 2, SP_INK);
}

/* ---------------------------------------------------------------- */
/* B — SAYS ONE THING                                                */

static void sp_b(sp_screen_t s) {
  fill(0, 0, UI_W, UI_H, SP_GROUND);
  sp_pic(viewfinder_tile(1), 0, 0, UI_W, UI_H);
  /* The picture is dimmed under the readout rather than beside it: one thing
   * is the screen, and the photograph is its ground. */
  for (int y = 0; y < UI_H; y++)
    for (int x = 0; x < UI_W; x++) {
      uint16_t *p = &s_cv[(size_t)y * UI_W + x];
      const int r = ((*p >> 11) & 31) / 2, g = ((*p >> 5) & 63) / 2, b = (*p & 31) / 2;
      *p = (uint16_t)((r << 11) | (g << 5) | b);
    }

  const char *big = "128";
  const char *under = "PHOTOGRAPHS LEFT";
  uint16_t ink = SP_INK;
  switch (s) {
    case SP_TAKING: big = "2"; under = "OF FOUR"; ink = SP_HOT; break;
    case SP_TAKEN: big = "4"; under = "GOT IT"; ink = SP_HOT; break;
    case SP_WRONG: big = "0"; under = "NO ROOM ON THE CARD"; ink = SP_BAD; break;
    default: break;
  }
  text_scaled_mid(&UI_FONT_M, UI_W / 2, 96, big, 6, ink);
  text_mid(&UI_FONT_M, UI_W / 2, UI_H - 96, under, SP_DIM);
}

/* ---------------------------------------------------------------- */
/* C — SHOWS ITS WORK                                                */

static void sp_c(sp_screen_t s) {
  fill(0, 0, UI_W, UI_H, SP_GROUND);
  /* Four panes, always. The lenses are the interface and they never go away;
   * what changes is what each of them is doing. */
  const int pw = UI_W / 2, ph = UI_H / 2;
  for (int i = 0; i < 4; i++) {
    const int px = (i % 2) * pw, py = (i / 2) * ph;
    bool lit = true;
    if (s == SP_TAKING) lit = i < 2;
    if (s == SP_WRONG) lit = false;
    if (lit) sp_pic(viewfinder_tile(i), px, py, pw, ph);
    else fill(px, py, pw, ph, RGB(0x16, 0x19, 0x1e));

    /* The seam is the product: four cameras a few millimetres apart. */
    fill(px, py, pw, 2, SP_GROUND);
    fill(px, py, 2, ph, SP_GROUND);

    /* Each pane says which lens it is, and only that. */
    char n[4];
    snprintf(n, sizeof n, "%d", i + 1);
    text(&UI_FONT_M, px + 14, py + 10, n, lit ? SP_INK : SP_DIM);
    if (s == SP_TAKING && lit) fill(px + 14, py + ph - 20, 40, 6, SP_HOT);
    if (s == SP_WRONG) fill(px + 14, py + ph - 20, 40, 6, SP_BAD);
  }
  if (s == SP_TAKEN) {
    /* The four become one: the wigglegram, full bleed, for two seconds. */
    sp_pic(viewfinder_tile(2), 0, 0, UI_W, UI_H);
    const int len[4] = {26, 26, 26, 26};
    const uint16_t ink[4] = {SP_HOT, SP_HOT, SP_HOT, SP_HOT};
    sp_ticks(len, ink);
  }
  if (s == SP_WRONG) {
    fill(0, UI_H / 2 - 30, UI_W, 60, RGB(0x00, 0x00, 0x00));
    text_scaled_mid(&UI_FONT_M, UI_W / 2, UI_H / 2 - 18, "NO ROOM", 1, SP_BAD);
  }
}

static void specimen_sheet(void) {
  static const char *const REG[3] = {"a_says_nothing", "b_says_one_thing", "c_shows_its_work"};
  static const char *const SCR[4] = {"1_aim", "2_taking", "3_taken", "4_wrong"};
  for (int r = 0; r < 3; r++)
    for (int s = 0; s < 4; s++) {
      if (r == 0) sp_a((sp_screen_t)s);
      else if (r == 1) sp_b((sp_screen_t)s);
      else sp_c((sp_screen_t)s);
      char name[64];
      snprintf(name, sizeof name, "spec_%s_%s", REG[r], SCR[s]);
      shot(name);
    }
}
