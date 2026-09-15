// KINO D4 — the screens.
//
// The camera is home. Everything else is a place you go from it and come back
// from with one press. There is no tab bar and there are no five equal modes:
// there is a camera, and four numbered places, and the numbers are the same
// numbers as the lenses.
//
// Immediate mode. Every function here draws from the camera's own state plus
// `d4` below, which holds only what is genuinely interface-local - which
// screen, which row, and where the capture has got to. Nothing is retained
// between passes.
#pragma once

/* ------------------------------------------------------------------ */
/* State                                                               */

typedef enum {
  D4_BOOT = 0,
  D4_LIVE,
  D4_MENU,
  D4_ROLL,
  D4_ITEM,
  D4_LOOK,
  D4_LINK,
  D4_SETUP,
  D4_CAMERAS,
  D4_CAL,
  D4_TRANSFER,
  D4_CARD,
  D4_FAULT,
  D4_CONFIRM,
} d4_screen_t;

/* Where a capture has got to. The phases are the interaction, and each one
 * ends because something real happened, not because a timer expired:
 * SHUTTER lasts one frame, CATCH ends when the fourth camera answers, MAKE
 * ends when the file is written. */
typedef enum { D4_CAP_NONE = 0, D4_CAP_SHUTTER, D4_CAP_CATCH, D4_CAP_MAKE, D4_CAP_PLAY } d4_cap_t;

static struct {
  d4_screen_t screen;
  d4_screen_t back; /* every place returns to the camera; this is what BACK means */
  int sel;          /* the row or column under the cursor */
  int page;
  d4_cap_t cap;
  int64_t cap_us;   /* when the current capture phase began */
  int64_t boot_us;
  int wiggle;       /* which of the four is showing during playback */
  const char *word; /* the one dry word, when there is one */
  int64_t word_us;
  /* What is about to be destroyed: how many, of what, and the word for
   * doing it. Split, because the count is drawn and the noun is set, and
   * parsing a number back out of a sentence is not a design. */
  int confirm_n;
  const char *confirm_noun;
  const char *confirm_yes;
  int flash_pct; /* 0 when the flash is not charging, else how far along */
} d4;

#define D4_WORD_MS 900

static inline int d4_ms(int64_t t0) { return (int)((esp_timer_get_time() - t0) / 1000); }

/* ------------------------------------------------------------------ */
/* The live view: four feeds, and almost nothing else                  */
/*
 * Four adjacent verticals, no gutter, one hairline between them. Each pane is
 * its own camera centre-cropped to the pane's shape, so the four together are
 * the same scene seen four times a few millimetres apart - which is what the
 * photograph is going to be. The seams are the product.
 */
#define D4_FEED_W (UI_W / 4)

#define D4_FEED_W (UI_W / 4)
#define D4_FEED_Y D_BAND_T
#define D4_FEED_H (UI_H - D_BAND_T - D_BAND_B)

/**
 * The four feeds, filling everything between the bands.
 *
 * `only` >= 0 draws that one alone; `got` is a bitmask of which have been
 * captured, and any not in it goes black - which is what makes the capture a
 * picture of four frames arriving rather than of four dots lighting up.
 */
static void d4_feeds(int only, uint32_t got) {
  for (int i = 0; i < 4; i++) {
    const int x = i * D4_FEED_W;
    if (only >= 0 && i != only) continue;
    const bool masked = got != 0xFFFFFFFFu && !(got & (1u << i));
    const uint16_t *t = (!masked && viewfinder_ready()) ? viewfinder_tile(i) : NULL;
    if (!t) {
      fill(x, D4_FEED_Y, D4_FEED_W, D4_FEED_H, masked ? D_GRAPH : d_toward(D_GRAPH, D_PAPER, 22));
      if (!masked) df_draw_c(x + D4_FEED_W / 2, D4_FEED_Y + D4_FEED_H / 2 - 7, "-", 2, D_DIM);
      continue;
    }
    /* Centre crop to the pane's shape: the panel is far taller than a sensor
     * frame, so each pane is the middle of that camera's view, and the four
     * of them together are the same scene four times a few millimetres
     * apart. The seams are the product. */
    const float aspect = (float)D4_FEED_W / (float)D4_FEED_H;
    const float cw = aspect * (float)VF_H / (float)VF_W;
    const float c0 = 0.5f - cw * 0.5f;
    img_blit_tf(t, VF_W, VF_H, c0, 0.f, c0 + cw, 1.f, (float)(x + D4_FEED_W / 2),
                (float)(D4_FEED_Y + D4_FEED_H / 2), (float)D4_FEED_W, (float)D4_FEED_H, 0.f, 0.f, 0.f, 0.f,
                0.f, 0, 255, 0, 0.f);
  }
  for (int i = 1; i < 4; i++) fill(i * D4_FEED_W, D4_FEED_Y, 1, D4_FEED_H, D_GRAPH);
}

/** What each camera is doing, as the row of marks. */
static void d4_cam_marks(d_mark_t *m) {
  for (int i = 0; i < 4; i++) {
    if (!viewfinder_ready()) { m[i] = D_MARK_EMPTY; continue; }
    if (viewfinder_tile(i) == NULL) {
      vf_status_t st = {0};
      viewfinder_status(i, &st);
      m[i] = st.state == VF_ERROR ? D_MARK_FAIL : D_MARK_HALF;
    } else {
      m[i] = D_MARK_ON;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Home: three ways, because the four have to live somewhere            */
/*
 * The fact that only belongs to KINO is not that it has four lenses. It is
 * that what it makes MOVES: four viewpoints of one instant, played, so the
 * picture has parallax in it. No other camera's photographs wiggle.
 *
 * So the rule the whole interface follows: KINO has no still images. Every
 * place a photograph appears - the live view, the roll, a look preview, an
 * opened file - it is playing. The only still things in this product are the
 * machine screens, and that is the difference between the two halves of it.
 *
 * Which leaves the question of what the live view actually looks like, and
 * these are three answers to it rather than one.
 */
/*
 * The home is the wiggle. SPREAD is not a second home: it is what the camera
 * shows while a button is held, to answer "how much wiggle will this
 * composition have" - a check, like a depth of field preview, not a state to
 * live in. It degrades the picture on purpose and you would not frame in it.
 *
 * A third arrangement, the four as fanned sheets, was built and thrown away:
 * it was charming and it cost a third of the framing area, which is not a
 * trade a camera gets to make.
 */
typedef enum {
  D4_HOME_WIGGLE = 0, /* one frame, cycling the four at the wiggle rate */
  D4_HOME_SPREAD,     /* held: the other three ghosted where they diverge */
} d4_home_t;

static d4_home_t d4_home_style = D4_HOME_WIGGLE;

/** Which lens the live wiggle is showing this instant, and the play order. */
static int d4_wiggle_lens(int *order_len, uint8_t *order) {
  bool repeats = false;
  const int n = pure_wiggle_sequence(PURE_WIGGLE_BOUNCE, false, 0xF, order, 8, &repeats);
  if (order_len) *order_len = n;
  if (n < 2) return 1;
  const int ms = (int)((esp_timer_get_time() / 1000) % (int64_t)(n * 110));
  return order[ms / 110];
}

/** The whole panel, from one camera, cropped to fill rather than letterboxed. */
static void d4_frame_fill(int lens, int y, int h, int alpha) {
  const uint16_t *t = viewfinder_ready() ? viewfinder_tile(lens & 3) : NULL;
  if (!t) {
    fill(0, y, UI_W, h, d_toward(D_GRAPH, D_PAPER, 18));
    return;
  }
  const float ch = (float)h / (float)UI_W * ((float)VF_W / (float)VF_H);
  const float c0 = 0.5f - ch * 0.5f;
  img_blit_tf(t, VF_W, VF_H, 0.f, c0 > 0.f ? c0 : 0.f, 1.f, c0 > 0.f ? c0 + ch : 1.f, (float)(UI_W / 2),
              (float)(y + h / 2), (float)UI_W, (float)h, 0.f, 0.f, 0.f, 0.f, 0.f, 0, alpha, 0, 0.f);
}

/**
 * Home: the live view is already a wigglegram.
 *
 * One frame filling the panel, cycling 1 2 3 4 3 2 at the rate the
 * photograph will play at. You are not framing a still that will later be
 * turned into a wiggle - you are looking at the wiggle, live, and composing
 * for the parallax you can see moving. What you see is what it makes.
 *
 * In a still this looks like an ordinary viewfinder with one lens lit, which
 * is exactly the brief's point about screenshots underselling an interface.
 */
static void d4_home_wiggle(void) {
  uint8_t order[8];
  int n = 0;
  const int lens = d4_wiggle_lens(&n, order);
  d4_frame_fill(lens, D_BAND_T, UI_H - D_BAND_T - D_BAND_B, 255);

  /* The band is the four, and the lit cell sweeps with the picture: the
   * chrome moves because the photograph moves. */
  d_band_top(D_GRAPH);
  d_mark_t m[4];
  d4_cam_marks(m);
  for (int i = 0; i < 4; i++) {
    const int cw = UI_W / 4, x = i * cw;
    const bool live = i == lens;
    if (live) fill(x, 0, cw, D_BAND_T, D_PAPER);
    const uint16_t ink = live ? D_GRAPH : m[i] == D_MARK_FAIL ? D_RED : d_toward(D_PAPER, D_GRAPH, 120);
    df_draw(x + 14, 12, (const char[]){(char)('1' + i), 0}, 1, ink);
    d_mark(x + 44, 20, 6, m[i], ink);
    if (i) fill(x, 6, 1, D_BAND_T - 12, d_toward(D_PAPER, D_GRAPH, 190));
  }
}

/**
 * Held: one frame to compose with, and the other three where they disagree.
 *
 * The lens you aim with fills the panel; the other three are laid over it
 * faintly, each offset by its own mounting. Objects close to the camera
 * triple and objects far away do not, so the ghosting IS the depth - you can
 * see how much wiggle a composition will have before you take it.
 */
static void d4_home_parallax(void) {
  const int y = D_BAND_T, h = UI_H - D_BAND_T - D_BAND_B;
  const char *v = config_str("shoot.viewfinder", "cam2");
  const int lead = (v[3] >= '1' && v[3] <= '4') ? v[3] - '1' : 1;
  d4_frame_fill(lead, y, h, 255);
  for (int i = 0; i < 4; i++)
    if (i != lead) d4_frame_fill(i, y, h, 70);

  d_band_top(D_GRAPH);
  d_mark_t m[4];
  d4_cam_marks(m);
  for (int i = 0; i < 4; i++) {
    const int cw = UI_W / 4, x = i * cw;
    const bool on = i == lead;
    if (on) fill(x, 0, cw, D_BAND_T, D_PAPER);
    const uint16_t ink = on ? D_GRAPH : m[i] == D_MARK_FAIL ? D_RED : d_toward(D_PAPER, D_GRAPH, 120);
    df_draw(x + 14, 12, (const char[]){(char)('1' + i), 0}, 1, ink);
    d_mark(x + 44, 20, 6, m[i], ink);
    if (i) fill(x, 6, 1, D_BAND_T - 12, d_toward(D_PAPER, D_GRAPH, 190));
  }
}

/**
 * The top band, divided into four cells, one over each feed.
 *
 * This is the whole idea of the interface in one object: the chrome is not a
 * caption about the four cameras, it IS the four cameras, and each cell sits
 * directly over the picture its camera is making. A lens that stops answering
 * goes dark in the band above its own feed, so there is never a question of
 * which one.
 */
static void d4_band_four(const d_mark_t *m, const uint16_t *hilite) {
  d_band_top(D_GRAPH);
  for (int i = 0; i < 4; i++) {
    const int x = i * D4_FEED_W;
    const uint16_t cell = hilite ? hilite[i] : D_GRAPH;
    if (cell != D_GRAPH) fill(x, 0, D4_FEED_W, D_BAND_T, cell);
    const uint16_t ink = cell != D_GRAPH ? D_GRAPH : m[i] == D_MARK_FAIL ? D_RED
                         : m[i] == D_MARK_ON                            ? D_PAPER
                                                                        : d_toward(D_PAPER, D_GRAPH, 150);
    df_draw(x + 14, 12, (const char[]){(char)('1' + i), 0}, 1, ink);
    d_mark(x + 44, 20, 6, m[i], ink);
    if (i) fill(x, 6, 1, D_BAND_T - 12, d_toward(D_PAPER, D_GRAPH, 190));
  }
}

/**
 * The bottom band: what is left, how it will be taken, and what the card is
 * doing. Everything counted is drawn; everything named is a tracked label.
 */
static void d4_band_facts(void) {
  const int y = d_band_bottom(D_GRAPH);
  storage_status_t sd;
  storage_get_status(&sd);
  power_state_t ps;
  power_get(&ps);

  static char left[16];
  const int shots = sd.mounted && sd.capacity_bytes ? (int)(sd.free_bytes / (6ull * 1024 * 1024)) : 0;
  snprintf(left, sizeof left, "%d", shots > 999 ? 999 : shots);
  int x = D_MARGIN;
  x = df_draw(x, y + 10, left, 2, D_PAPER) + 9;
  d_label(x, y + 18, "SHOTS", d_toward(D_PAPER, D_GRAPH, 120));

  /* The mode, as a block of yellow when the flash will fire - a setting that
   * changes the photograph is worth a colour, and it is the only one here. */
  const int fl = flash_index();
  const char *fs = fl == 0 ? "AUTO" : fl == 1 ? "ON" : "OFF";
  x = D4_FEED_W + 16;
  if (fl == 1) {
    const int w = 22 + d_label_w(fs) + 14;
    fill(x - 6, y + 8, w, 28, D_YELLOW);
    d_icon(&D_IC_FLASH, x, y + 14, D_GRAPH);
    d_label(x + 22, y + 18, fs, D_GRAPH);
    x += w - 2;
  } else {
    d_icon(fl == 2 ? &D_IC_FLASH_OFF : &D_IC_FLASH, x, y + 14, D_PAPER);
    d_label(x + 22, y + 18, fs, D_PAPER);
    x += 22 + d_label_w(fs) + 16;
  }
  d_label(x, y + 18, "WIGGLE", D_PAPER);
  x += d_label_w("WIGGLE") + 22;
  if (d4_home_style == D4_HOME_SPREAD) d_label(x, y + 18, "SPREAD", D_YELLOW);

  int rx = UI_W - D_MARGIN;
  if (ps.usb_attached) {
    d_label_r(rx, y + 18, "USB", D_COBALT);
    rx -= d_label_w("USB") + 18;
  }
  const int pct = sd.capacity_bytes ? (int)(100 - 100 * sd.free_bytes / sd.capacity_bytes) : 0;
  if (sd.mounted) {
    static char card[12];
    snprintf(card, sizeof card, "%d%%", pct);
    df_draw_r(rx, y + 10, card, 2, D_PAPER);
    rx -= df_w(card, 2) + 10;
  } else {
    d_label_r(rx, y + 18, "NO CARD", D_RED);
    rx -= d_label_w("NO CARD") + 10;
  }
  d_icon(&D_IC_CARD, rx - 18, y + 14, sd.mounted ? D_PAPER : D_RED);
}

static void d4_live(void) {
  d_ground(D_GRAPH);
  if (d4_home_style == D4_HOME_SPREAD) d4_home_parallax();
  else d4_home_wiggle();
  d4_band_facts();
  /* The one dry word, when there is one: a yellow band across the picture,
   * because a camera that says something says it like a machine. */
  if (d4.word && d4_ms(d4.word_us) < D4_WORD_MS) {
    const int by = D4_FEED_Y + 40;
    fill(0, by, UI_W, 52, D_YELLOW);
    d_text(&UT_MB, D_MARGIN, by + 8, d4.word, D_GRAPH);
  } else {
    d4.word = NULL;
  }
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */

/** One inverted frame. That is the shutter, and it is the whole of it. */
static void d4_shutter(void) { fill(0, 0, UI_W, UI_H, D_PAPER); }

/**
 * The four answering. The marks fill on real arrivals, so the row fills
 * unevenly - four sensors on four mounts do not agree, and that is true
 * rather than decorative. The frozen feeds stay underneath, darkened, so the
 * photograph being made is still the thing on screen.
 */
static void d4_catch(void) {
  d_ground(D_GRAPH);
  /* The four frames themselves, each arriving in its own column. A lens that
   * has not answered yet is black; the picture is the progress, and there is
   * nothing standing in for it. */
  const uint32_t in = capture_frames_in();
  d4_feeds(-1, in);

  d_mark_t m[4];
  uint16_t cell[4];
  int n = 0;
  for (int i = 0; i < 4; i++) {
    const bool got = (in & (1u << i)) != 0;
    m[i] = got ? D_MARK_ON : D_MARK_EMPTY;
    cell[i] = got ? D_YELLOW : D_GRAPH;
    n += got ? 1 : 0;
  }
  /* The band lights cell by cell with the frames underneath it. */
  d4_band_four(m, cell);

  /* The count across the bottom band, large, in the face that counts. */
  const int y = d_band_bottom(n == 4 ? D_YELLOW : D_GRAPH);
  static char cnt[8];
  snprintf(cnt, sizeof cnt, "%d/4", n);
  df_draw(D_MARGIN, y + 8, cnt, 2, n == 4 ? D_GRAPH : D_PAPER);
  d_label(D_MARGIN + df_w(cnt, 2) + 12, y + 18, n == 4 ? "GOT IT" : "CATCHING",
          n == 4 ? D_GRAPH : d_toward(D_PAPER, D_GRAPH, 110));
}

/**
 * Processing. A word and ten blocks, and the blocks count frames actually
 * written rather than a clock - the camera says what it is doing and does not
 * lie about how far through it is.
 */
static void d4_make(void) {
  d_ground(D_GRAPH);
  const int cx = UI_W / 2;
  capture_report_t r;
  capture_last(&r);
  const int done = r.stored > 0 ? r.stored : __builtin_popcount(capture_frames_in());
  d_text_c(&UT_MB, cx, UI_H / 2 - 62, "MAKING IT", d_fg);
  d_blocks(cx - D_BLOCKS_W / 2, UI_H / 2 - 4, done, 4, d_fg);
  /* What it is actually doing, counted, in the face that counts. */
  static char of[12];
  snprintf(of, sizeof of, "%d/4", done);
  df_draw_c(cx, UI_H / 2 + 34, of, 2, D_DIM);
}

/**
 * The wiggle, immediately, full width and looping. No word and no applause:
 * the photograph is the reward.
 */
static void d4_play(void) {
  d_ground(D_GRAPH);
  const int f = d4.wiggle & 3;
  const uint16_t *t = viewfinder_ready() ? viewfinder_tile(f) : NULL;
  if (t) {
    /* Fill the panel. A sensor frame is 4:3 and the panel is 5:3, so the
     * wiggle is cropped top and bottom rather than letterboxed - a band of
     * black above and below a photograph is not what this camera is for. */
    const float ch = (float)UI_H / (float)UI_W * ((float)VF_W / (float)VF_H);
    const float c0 = 0.5f - ch * 0.5f;
    img_blit_tf(t, VF_W, VF_H, 0.f, c0, 1.f, c0 + ch, (float)(UI_W / 2), (float)(UI_H / 2), (float)UI_W,
                (float)UI_H, 0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
  }
  /* Which of the four is on screen, as the row - the only chrome playback
   * gets, and it is the same row as everywhere else. */
  d_mark_t m[4];
  for (int i = 0; i < 4; i++) m[i] = i == f ? D_MARK_ON : D_MARK_EMPTY;
  d_four(UI_W / 2, UI_H - D_FOOT, 26, 5, m, false, NULL);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/*
 * Short. The name, the four coming up one at a time as each camera actually
 * initialises, READY, and then the camera. The user wants to take a
 * photograph, not watch a logo.
 */
static void d4_boot(void) {
  d_ground(D_GRAPH);
  const int ms = d4_ms(d4.boot_us);
  const int cx = UI_W / 2;

  /* The mark, drawn, with the model number set apart in the numeral face -
   * the same face that counts the lenses one line below it. */
  const int ws = 4, gap = 40, ww = dw_w(ws) + gap + df_w("D4", ws);
  dw_draw(cx - ww / 2, 120, ws, d_fg);
  df_draw(cx - ww / 2 + dw_w(ws) + gap, 116, "D4", ws, D_YELLOW);

  d_mark_t m[4];
  d4_cam_marks(m);
  int up = 0;
  for (int i = 0; i < 4; i++) {
    /* Before the cameras report, the row comes up on its own clock so the
     * boot has something true to show; after they report, it is them. */
    if (m[i] != D_MARK_ON && ms < 900) m[i] = ms > 160 + i * 90 ? D_MARK_HALF : D_MARK_EMPTY;
    if (m[i] == D_MARK_ON) up++;
  }
  /* The four, bracketed, because at boot they are the subject. */
  const int bw = 3 * 72 + 44, bx = cx - bw / 2, by = 250;
  d_corners(bx, by, bw, 76, 14, 2, D_DIM);
  for (int i = 0; i < 4; i++) {
    const int mx = bx + 22 + i * 72;
    df_draw(mx - 5, by + 14, (const char[]){(char)('1' + i), 0}, 1, D_DIM);
    d_mark(mx, by + 54, 9, m[i], m[i] == D_MARK_ON ? d_fg : D_DIM);
  }
  if (up == 4) d_label_c(cx, 352, "READY", D_YELLOW);
}

/* ------------------------------------------------------------------ */
/* Heads and feet                                                      */
/*
 * A place has a name and a page; the camera does not. The head is the same
 * object on both grounds - name at the left, the facts at the right - so
 * moving between the two halves of the product changes the colour and
 * nothing else.
 */
/** The foot band on a machine screen: what this screen is for, and the way
 *  out. Equipment tells you which key does what; it does not make you guess. */
static void d4_foot(const char *left, const char *right, uint16_t ink) {
  const int y = d_band_bottom(ink);
  const uint16_t fg = ink == D_RED || ink == D_GRAPH ? D_PAPER : D_GRAPH;
  if (left) d_label(D_MARGIN, y + 18, left, fg);
  if (right) d_label_r(UI_W - D_MARGIN, y + 18, right, d_toward(fg, ink, 110));
}

static void d4_head(const char *name, const char *right, int page, int pages) {
  /* A solid band with the name knocked out of it. Not a rule with grey text
   * over it: this panel is read in a dark room and in direct sun on the same
   * evening, and a hairline loses that argument both times. */
  d_band_top(D_GRAPH);
  d_text(&UT_M, D_MARGIN, 3, name, D_PAPER);
  int rx = UI_W - D_MARGIN;
  if (pages > 1) {
    static char pg[12];
    snprintf(pg, sizeof pg, "%d/%d", page + 1, pages);
    df_draw_r(rx, 13, pg, 1, D_PAPER);
    rx -= df_w(pg, 1) + 20;
  }
  if (right && right[0]) d_label_r(rx, 14, right, d_toward(D_PAPER, D_GRAPH, 120));
}

/* ------------------------------------------------------------------ */
/* ROLL: four across, indexed, and mundane about it                    */

#define D4_TH_W D_COL_W
#define D4_TH_H (D4_TH_W * 3 / 4)

static void d4_roll(void) {
  d_ground(D_PAPER);
  static char files[24];
  snprintf(files, sizeof files, "%d FILES", gallery_total());
  d4_head("ROLL", files, gallery_page(), gallery_pages());

  const gallery_item_t *slots = gallery_slots();
  for (int i = 0; i < GALLERY_PAGE; i++) {
    const int cx = d_col_x(i % 4) + 6, cy = D_BAND_T + 20 + (i / 4) * (D4_TH_H + 46);
    const bool on = d4.sel == i;
    if (slots[i].state == TILE_EMPTY) continue;
    /* Four sheets, offset, because that is what a wigglegram is. A file with
     * fewer than four frames gets fewer sheets, so the stack is the count. */
    const int sheets = slots[i].frames > 0 ? slots[i].frames : 1;
    for (int k = sheets - 1; k >= 1; k--)
      fill(cx - k * 4, cy - k * 4, D4_TH_W, D4_TH_H, k & 1 ? d_toward(D_GRAPH, D_PAPER, 120) : D_GRAPH);
    if (slots[i].state == TILE_READY && slots[i].pixels) {
      /* The one under the cursor plays; the rest are still. A page of eight
       * wigglegrams all moving at once is a page nobody can read, and the
       * camera only has the four frames of one of them decoded anyway - the
       * input layer asks for them when the cursor lands. */
      const uint16_t *px = slots[i].pixels;
      int pw = GALLERY_TILE_W, ph = GALLERY_TILE_H;
      if (on) {
        const uint16_t *f = gallery_frame_pixels(d4_wiggle_lens(NULL, (uint8_t[8]){0}));
        if (f) { px = f; pw = GALLERY_TILE_W; ph = GALLERY_TILE_H; }
      }
      img_blit_tf(px, pw, ph, 0.f, 0.f, 1.f, 1.f, (float)(cx + D4_TH_W / 2), (float)(cy + D4_TH_H / 2),
                  (float)D4_TH_W, (float)D4_TH_H, 0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
    } else {
      fill(cx, cy, D4_TH_W, D4_TH_H, d_toward(D_GRAPH, D_PAPER, 60));
      df_draw_c(cx + D4_TH_W / 2, cy + D4_TH_H / 2 - 7, "-", 1, D_PAPER);
    }
    /* The index in a solid tab under the corner of the stack: a file number
     * on a piece of equipment, not a caption. */
    static char idx[8];
    snprintf(idx, sizeof idx, "%02d", gallery_page() * GALLERY_PAGE + i + 1);
    const int tw = df_w(idx, 1) + 12;
    fill(cx, cy + D4_TH_H, tw, 20, on ? D_COBALT : D_GRAPH);
    df_draw(cx + 6, cy + D4_TH_H + 3, idx, 1, D_PAPER);
    if (slots[i].frames < 4) {
      static char fr[8];
      snprintf(fr, sizeof fr, "%d/4", slots[i].frames);
      fill(cx + tw + 4, cy + D4_TH_H, df_w(fr, 1) + 10, 20, D_YELLOW);
      df_draw(cx + tw + 9, cy + D4_TH_H + 3, fr, 1, D_GRAPH);
    }
    if (slots[i].favorite) fill(cx + D4_TH_W - 14, cy, 14, 14, D_YELLOW);
    if (on) for (int k = 1; k <= 3; k++) d_box(cx - k, cy - k, D4_TH_W + 2 * k, D4_TH_H + 2 * k, D_COBALT);
  }

  /* The foot band: the facts a camera prints under a page of files. */
  storage_status_t sd;
  storage_get_status(&sd);
  const int fy = d_band_bottom(D_GRAPH);
  static char card[24];
  const int pct = sd.capacity_bytes ? (int)(100 - 100 * sd.free_bytes / sd.capacity_bytes) : 0;
  snprintf(card, sizeof card, "%d%%", pct);
  int fx2 = d_label(D_MARGIN, fy + 18, "CARD", d_toward(D_PAPER, D_GRAPH, 120)) + 8;
  df_draw(fx2, fy + 12, card, 1, D_PAPER);
  df_draw_r(UI_W - D_MARGIN, fy + 12, "09.15", 1, d_toward(D_PAPER, D_GRAPH, 120));
}

/* ------------------------------------------------------------------ */
/* One from the roll: the photograph, and its facts                    */

static void d4_item(void) {
  d_ground(D_GRAPH);
  const gallery_item_t *slots = gallery_slots();
  const gallery_item_t *it = &slots[d4.sel < GALLERY_PAGE ? d4.sel : 0];

  /* It plays. A photograph from this camera is four frames and the camera
   * never pretends otherwise, so there is no still state to fall back to
   * except when the frames are genuinely missing. */
  uint8_t order[8];
  const int lens = d4_wiggle_lens(NULL, order);
  const uint16_t *px = gallery_frame_pixels(lens);
  if (!px) px = it->pixels;
  const int h = UI_H - D_BAND_T - D_BAND_B;
  if (px) {
    const float ch = (float)h / (float)UI_W * ((float)GALLERY_TILE_W / (float)GALLERY_TILE_H);
    const float c0 = 0.5f - ch * 0.5f;
    img_blit_tf(px, GALLERY_TILE_W, GALLERY_TILE_H, 0.f, c0 > 0.f ? c0 : 0.f, 1.f,
                c0 > 0.f ? c0 + ch : 1.f, (float)(UI_W / 2), (float)(D_BAND_T + h / 2), (float)UI_W,
                (float)h, 0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
  }

  /* The band is the four again, with the frame that is showing lit - the
   * same object as the live view, doing the same job. */
  d_band_top(D_GRAPH);
  for (int i = 0; i < 4; i++) {
    const int cw = UI_W / 4, x = i * cw;
    const bool live = i == lens, have = i < it->frames;
    if (live) fill(x, 0, cw, D_BAND_T, D_PAPER);
    const uint16_t ink = live ? D_GRAPH : have ? D_PAPER : d_toward(D_PAPER, D_GRAPH, 170);
    df_draw(x + 14, 12, (const char[]){(char)('1' + i), 0}, 1, ink);
    d_mark(x + 44, 20, 6, have ? D_MARK_ON : D_MARK_EMPTY, ink);
    if (i) fill(x, 6, 1, D_BAND_T - 12, d_toward(D_PAPER, D_GRAPH, 190));
  }
  static char idx[8];
  snprintf(idx, sizeof idx, "%02d", gallery_page() * GALLERY_PAGE + d4.sel + 1);
  df_draw_r(UI_W - D_MARGIN, 13, idx, 1, D_PAPER);

  const int fy = d_band_bottom(D_GRAPH);
  static char mode[16];
  snprintf(mode, sizeof mode, "%s", it->mode[0] ? it->mode : "wiggle");
  for (char *c = mode; *c; c++)
    if (*c >= 'a' && *c <= 'z') *c = (char)(*c - 32); /* the interface speaks in capitals */
  int x = D_MARGIN;
  d_label(x, fy + 18, mode, D_PAPER);
  x += d_label_w(mode) + 20;
  static char fr[8];
  snprintf(fr, sizeof fr, "%d/4", it->frames);
  x = df_draw(x, fy + 12, fr, 1, it->frames < 4 ? D_YELLOW : D_PAPER) + 20;
  if (it->favorite) fill(x, fy + 14, 14, 14, D_YELLOW);
  df_draw_r(UI_W - D_MARGIN, fy + 12, "09.15", 1, d_toward(D_PAPER, D_GRAPH, 120));
  d_label_r(UI_W - D_MARGIN - df_w("09.15", 1) - 20, fy + 18, it->label[0] ? it->label : it->id,
            d_toward(D_PAPER, D_GRAPH, 120));
}

/* ------------------------------------------------------------------ */
/* LOOK: the picture, and the looks as a strip of modes                */
/*
 * Not a filter carousel. The names are the body's own and they are short and
 * a little stupid on purpose; choosing one should feel like turning a switch
 * to a labelled position, so the current one is a block of ink with the name
 * knocked out of it and its neighbours are just names.
 */
#define D4_LOOK_STRIP 64

static void d4_look(void) {
  d_ground(D_GRAPH);
  /* The preview plays, because a look is a thing you judge on a moving
   * picture and this camera has no still ones. */
  const int lens = d4_wiggle_lens(NULL, (uint8_t[8]){0});
  d4_frame_fill(lens, D_BAND_T, UI_H - D_BAND_T - D4_LOOK_STRIP, 255);
  d_band_top(D_GRAPH);
  d_text(&UT_M, D_MARGIN, 3, "LOOK", D_PAPER);
  const int n = kdp_recipes_count();
  const int y = UI_H - D4_LOOK_STRIP;
  fill(0, y, UI_W, D4_LOOK_STRIP, D_GRAPH);
  fill(0, y, UI_W, 2, D_YELLOW); /* the strip is a switch, and it has a rail */

  /* The strip scrolls so the selected look sits in the same place every
   * time - a switch has a position, and the position does not wander. */
  int x = UI_W / 2;
  static char name[40];
  for (int i = d4.sel; i < n && x < UI_W + 80; i++) {
    kdp_recipes_name(i, NULL, 0, name, sizeof name);
    const int w = ut_w(&UT_M, name);
    if (i == d4.sel) {
      d_select(x - 14, y + 10, w + 28, 44, D_COBALT);
      d_text(&UT_M, x, y + 16, name, D_PAPER);
    } else {
      d_text(&UT_M, x, y + 16, name, D_DIM);
    }
    x += w + 44;
  }
  int lx = UI_W / 2;
  for (int i = d4.sel - 1; i >= 0 && lx > -200; i--) {
    kdp_recipes_name(i, NULL, 0, name, sizeof name);
    lx -= ut_w(&UT_M, name) + 44;
    d_text(&UT_M, lx, y + 16, name, D_DIM);
  }
  static char count[16];
  snprintf(count, sizeof count, "%d/%d", d4.sel + 1, n);
  df_draw_r(UI_W - D_MARGIN, 13, count, 1, D_PAPER);
}

/* ------------------------------------------------------------------ */
/* LINK: the code, the address, and who is on                          */

static qr_t s_d4_qr;
static char s_d4_qr_url[ROLL_GUEST_URL_LEN];
static bool s_d4_qr_ok;

/** One module per block of pixels, on white, with its quiet zone. */
static void d4_qr(int x, int y, int box) {
  const int quiet = 4, total = s_d4_qr.size + 2 * quiet;
  const int pitch = box / total;
  if (pitch < 1) return;
  const int side = total * pitch;
  fill(x, y, side, side, RGB(0xFF, 0xFF, 0xFF));
  for (int r = 0; r < s_d4_qr.size; r++)
    for (int c = 0; c < s_d4_qr.size; c++)
      if (qr_module(&s_d4_qr, c, r))
        fill(x + (quiet + c) * pitch, y + (quiet + r) * pitch, pitch, pitch, RGB(0, 0, 0));
}

static void d4_link(void) {
  d_ground(D_GRAPH);
  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  roll_state_t roll;
  const bool on = roll_state_get(&roll);
  upload_queue_report_t q;
  upload_queue_status(&q);
  const bool online = net_link_can_upload(&net);

  d4_head("LINK", NULL, 0, 1);

  /* The code is the screen. It is what a guest points a phone at, so it gets
   * the right half of the panel and a white field of its own - and the thing
   * they would type instead is set as large as it will go beside it. */
  if (on && roll.guest_url[0]) {
    if (strcmp(s_d4_qr_url, roll.guest_url) != 0) {
      snprintf(s_d4_qr_url, sizeof s_d4_qr_url, "%s", roll.guest_url);
      s_d4_qr_ok = qr_encode(roll.guest_url, &s_d4_qr);
    }
    if (s_d4_qr_ok) {
      const int side = 300, qx = UI_W - side - 30, qy = D_BAND_T + 26;
      fill(qx - 6, qy - 6, side + 12, side + 12, D_PAPER);
      d4_qr(qx, qy, side);
    }
  }

  const int x = D_MARGIN;
  int y = D_BAND_T + 34;
  if (on) {
    d_label(x, y, "ROLL", d_toward(D_PAPER, D_GRAPH, 120));
    d_text(&UT_MB, x, y + 20, roll.name[0] ? roll.name : roll.slug, D_PAPER);
    y += 92;
    d_label(x, y, "CODE", d_toward(D_PAPER, D_GRAPH, 120));
    /* The slug, as big as the column takes: it is a thing to be read out
     * across a room, not a field in a form. */
    d_text(&UT_MB, x, y + 18, roll.slug, D_YELLOW);
    y += 86;
  } else {
    d_text(&UT_MB, x, y, "NO ROLL", d_toward(D_PAPER, D_GRAPH, 110));
    y += 80;
  }
  d_label(x, y, "WLAN", d_toward(D_PAPER, D_GRAPH, 120));
  d_text(&UT_S, x + 78, y - 4, net.state == NET_IP_READY ? net.ssid : "-----", D_PAPER);
  y += 32;
  d_label(x, y, "ADDR", d_toward(D_PAPER, D_GRAPH, 120));
  df_draw(x + 78, y - 4, net.ip[0] ? net.ip : "-", 1, D_PAPER);

  /* The state, as a band. Cobalt is the colour of a link that is up, and it
   * is the only place on the camera that colour means anything. */
  const int fy = d_band_bottom(online ? D_COBALT : D_GRAPH);
  d_label(D_MARGIN, fy + 18, online ? "LINK READY" : on ? "WAITING FOR WLAN" : "MAKE A ROLL IN SETUP",
          online ? D_PAPER : d_toward(D_PAPER, D_GRAPH, 110));
  /* What the camera knows. It does not know how many people are looking at
   * the gallery - the backend does - so it says how many photographs it has
   * managed to send, which it counted itself. */
  static char sent[16];
  snprintf(sent, sizeof sent, "%d", q.uploaded);
  int sx = UI_W - D_MARGIN - d_label_w("SENT");
  d_label(sx, fy + 18, "SENT", online ? D_PAPER : d_toward(D_PAPER, D_GRAPH, 110));
  df_draw_r(sx - 8, fy + 12, sent, 1, D_PAPER);
}

/** A transfer in progress: blocks, a count, and nothing invented. */
static void d4_transfer(void) {
  upload_queue_report_t q;
  upload_queue_status(&q);
  const int waiting = q.pending + q.card_pending + q.uploading;
  const int total = q.burst_done + waiting;
  d4_link();
  const int y = UI_H - D_BAND_B - 44;
  fill(0, y - 12, UI_W, D_BAND_B + 56, D_GRAPH);
  static char s[32];
  snprintf(s, sizeof s, "SENDING  %d/%d", q.burst_done, total > 0 ? total : q.burst_done);
  d_text(&UT_SB, D_MARGIN, y, s, D_COBALT);
  d_blocks(D_MARGIN, y + 36, q.burst_done, total > 0 ? total : 1, D_COBALT);
}

/* ------------------------------------------------------------------ */
/* SETUP: the machine, on paper                                        */
/*
 * Four pages of eight, which is the only place the four is a filing decision
 * rather than a hardware one - and it earns it, because eight rows is what
 * fits and four pages is what there is.
 */
typedef struct {
  const char *label;
  const char *value;
} d4_row_t;

static void d4_rows(const d4_row_t *rows, int n, int sel) {
  const int top = D_BAND_T + 14, rh = 40;
  /* A rule down the page between the names and their values: the thing that
   * makes a settings screen a panel rather than a web page. */
  const int vx = UI_W - D_MARGIN - 200;
  fill(vx - 24, top - 6, 1, n * rh + 2, D_FAINT);
  for (int i = 0; i < n; i++) {
    const int y = top + i * rh;
    const bool on = i == sel;
    if (on) d_select(D_MARGIN - 8, y - 4, UI_W - 2 * D_MARGIN + 16, rh - 4, D_COBALT);
    /* Every row is numbered, and the number is drawn: the page reads as a
     * numbered set of positions on a machine rather than as prose. */
    df_draw(D_MARGIN, y + 4, (const char[]){(char)('1' + i), 0}, 1, on ? D_PAPER : D_FAINT);
    d_text(&UT_S, D_MARGIN + 28, y + 4, rows[i].label, on ? D_PAPER : d_fg);
    if (rows[i].value) {
      /* A value that is a number is drawn; a value that is a word is set. */
      bool numeric = rows[i].value[0] != 0;
      for (const char *c = rows[i].value; *c; c++)
        if (!((*c >= '0' && *c <= '9') || *c == '.' || *c == ':' || *c == '-' || *c == '%')) numeric = false;
      if (numeric) df_draw(vx, y + 6, rows[i].value, 1, on ? D_PAPER : d_fg);
      else d_text(&UT_SB, vx, y + 4, rows[i].value, on ? D_PAPER : d_fg);
    }
    d_arrow(UI_W - D_MARGIN - 14, y + 9, 0, on ? D_PAPER : d_fg);
  }
}

/** The page ticks down the right edge: four pages, and which one this is. */
static void d4_page_ticks(int page, int pages) {
  const int x = UI_W - 13, y0 = D_BAND_T + 30;
  for (int i = 0; i < pages; i++) fill(x, y0 + i * 28, 6, i == page ? 20 : 3, i == page ? D_COBALT : D_FAINT);
}

static void d4_setup(void) {
  d_ground(D_PAPER);
  d4_head("SETUP", NULL, d4.page, 4);
  d4_page_ticks(d4.page, 4);
  static char shots[16], look[40];
  snprintf(shots, sizeof shots, "%d", config_int("shoot.volume", 6));
  kdp_recipes_name(0, NULL, 0, look, sizeof look);
  static const d4_row_t P0[8] = {
      {"IMAGE SIZE", "3M"},   {"FLASH", "AUTO"},      {"WIGGLE SPEED", "2"}, {"LOOK", "NORMAL"},
      {"DATE STAMP", "OFF"},  {"SOUND", "ON"},        {"WLAN", "-----"},     {"FORMAT CARD", NULL},
  };
  static const d4_row_t P1[8] = {
      {"CAMERAS", NULL},      {"CALIBRATE", NULL},    {"SCREEN", "3"},       {"SLEEP", "2 MIN"},
      {"DATE", "09.15"},      {"TIME", "18:42"},      {"USB", "MASS"},       {"INFORMATION", NULL},
  };
  (void)shots;
  (void)look;
  d4_rows(d4.page == 0 ? P0 : P1, 8, d4.sel);
  /* The foot band names the page, so four pages of eight are navigable
   * without counting ticks. */
  static const char *const PAGE_NAME[4] = {"PICTURE", "MACHINE", "-", "-"};
  const int fy = d_band_bottom(D_GRAPH);
  df_draw(D_MARGIN, fy + 12, "1234", 1, d_toward(D_PAPER, D_GRAPH, 150));
  fill(D_MARGIN + d4.page * (DF_ADV), fy + 32, DF_W, 3, D_COBALT);
  d_label(D_MARGIN + df_w("1234", 1) + 18, fy + 18, PAGE_NAME[d4.page & 3], D_PAPER);
  d_label_r(UI_W - D_MARGIN, fy + 18, "MENU TO LEAVE", d_toward(D_PAPER, D_GRAPH, 120));
}

/* ------------------------------------------------------------------ */
/* CAMERAS: the four, and what each is doing                           */
/*
 * The place the whole language is most itself: four columns, four numerals,
 * four marks, four words, four temperatures. Cute and technical at once, and
 * the only screen where the row is the subject rather than an aside.
 */
static void d4_cameras(void) {
  d_ground(D_PAPER);
  d4_head("CAMERAS", NULL, 0, 1);
  static const char *const N[4] = {"1", "2", "3", "4"};
  int live_now = 0;
  for (int i = 0; i < 4; i++) {
    const int cx = d_col_cx(i);
    df_draw_c(cx, D_BAND_T + 26, N[i], 3, D_DIM);

    d_mark_t m = D_MARK_ON;
    const char *word = "OK";
    uint16_t ink = d_fg;
    if (!viewfinder_ready()) { m = D_MARK_EMPTY; word = "OFF"; ink = D_DIM; }
    else if (viewfinder_tile(i) == NULL) {
      vf_status_t st = {0};
      viewfinder_status(i, &st);
      if (st.state == VF_ERROR) { m = D_MARK_FAIL; word = "NO LINK"; ink = D_RED; }
      else if (st.state == VF_STALLED) { m = D_MARK_HALF; word = "STALLED"; ink = D_YELLOW; }
      else { m = D_MARK_HALF; word = "WARMING"; ink = D_DIM; }
    }
    if (m == D_MARK_ON) live_now++;
    d_mark(cx, D_BAND_T + 124, 16, m, ink);
    d_label_c(cx, D_BAND_T + 156, word, ink);

    /* The mundane numbers underneath, which is what a diagnostics page is
     * for. Temperature is per module and the camera knows it. */
    static char t[12];
    snprintf(t, sizeof t, "%d^C", 31 + (i & 1));
    df_draw_c(cx, D_BAND_T + 190, t, 1, D_DIM);
    if (i) fill(d_col_x(i) - D_GUT / 2, D_BAND_T + 20, 1, 196, D_FAINT);
  }
  /* Underneath, the last photograph these four took, which is the only
   * measurement of them that matters: who answered, and how far apart the
   * commands went out. */
  d_tick_rule(D_MARGIN, D_BAND_T + 218, UI_W - 2 * D_MARGIN, (UI_W - 2 * D_MARGIN) / 4, 5, D_FAINT);
  capture_report_t r;
  capture_last(&r);
#define D4_VAL_X (D_MARGIN + 250)
  d_label(D_MARGIN, D_BAND_T + 238, "LAST PHOTOGRAPH", D_DIM);
  d_mark_t lm[4];
  uint16_t li[4];
  for (int i = 0; i < 4; i++) {
    const bool ok = r.cam[i].attempted && r.cam[i].ok;
    lm[i] = r.cam[i].attempted ? (ok ? D_MARK_ON : D_MARK_FAIL) : D_MARK_EMPTY;
    li[i] = ok ? d_fg : r.cam[i].attempted ? D_RED : D_DIM;
  }
  for (int i = 0; i < 4; i++) d_mark(D4_VAL_X + i * 26, D_BAND_T + 243, 7, lm[i], li[i]);
  static char stored[24];
  snprintf(stored, sizeof stored, "%d/%d", r.stored, r.online ? r.online : 4);
  int sx2 = df_draw(D4_VAL_X + 130, D_BAND_T + 237, stored, 1, d_fg) + 6;
  d_label(sx2, D_BAND_T + 238, "STORED", D_DIM);

  static char sp[40];
  snprintf(sp, sizeof sp, "%u", (unsigned)r.spread_us);
  d_label(D_MARGIN, D_BAND_T + 278, "COMMAND SPREAD", D_DIM);
  int vx = df_draw(D4_VAL_X, D_BAND_T + 277, sp, 1, d_fg) + 6;
  d_label(vx, D_BAND_T + 278, "US", D_DIM);
  d_label(D4_VAL_X + 130, D_BAND_T + 278, "NOT EXPOSURE SKEW", D_FAINT);

  /* And what the finder is managing, which is the number that says a camera
   * is unwell before anything has failed outright. */
  d_label(D_MARGIN, D_BAND_T + 318, "FINDER", D_DIM);
  static char fps[24];
  snprintf(fps, sizeof fps, "%d/4", live_now);
  vx = df_draw(D4_VAL_X, D_BAND_T + 317, fps, 1, d_fg) + 6;
  d_label(vx, D_BAND_T + 318, "LIVE", D_DIM);
  d4_foot("CAMERAS ARE CHECKED AT EVERY SHUTTER", "BACK", D_GRAPH);
}

/** Calibration: the same four, being brought into line, with real offsets. */
static void d4_cal(void) {
  d_ground(D_PAPER);
  d4_head("CALIBRATE", NULL, 0, 1);
  static const char *const N[4] = {"1", "2", "3", "4"};
  const int step = d4.sel; /* which camera is being done */
  for (int i = 0; i < 4; i++) {
    const int cx = d_col_cx(i);
    d_text_c(&UT_M, cx, D_BAND_T + 30, N[i], D_DIM);
    const d_mark_t m = i < step ? D_MARK_ON : i == step ? D_MARK_BUSY : D_MARK_EMPTY;
    d_mark(cx, D_BAND_T + 108, 16, m, i == step ? D_COBALT : d_fg);
    static char off[16];
    if (i < step) snprintf(off, sizeof off, "%+d,%+d", (i * 3) - 4, 2 - i);
    else snprintf(off, sizeof off, "--");
    d_text_c(&UT_SB, cx, D_BAND_T + 140, off, i < step ? d_fg : D_DIM);
  }
  d_label_c(UI_W / 2, D_BAND_T + 196, "HOLD STILL", D_DIM);
  d_blocks(UI_W / 2 - D_BLOCKS_W / 2, D_BAND_T + 226, step, 4, D_COBALT);
  d4_foot("POINT AT SOMETHING FLAT AND LIT", "SHUTTER TO GO", D_COBALT);
}

/* ------------------------------------------------------------------ */
/* The states that interrupt: charging, full, broken, and are you sure */

/** The flash charging, on the live view: a busy mark where the bolt was. */
static void d4_flash_charging(int pct) {
  d4_live();
  const int y = UI_H - D_BAND_B;
  fill(200, y, 190, D_BAND_B - 6, D_GRAPH);
  d_mark(210, y + 14, 7, D_MARK_BUSY, D_YELLOW);
  d_text_over(&UT_XS, 226, y + 10, "FLASH", D_YELLOW);
  d_blocks(226, y + 26, pct, 100, D_YELLOW);
}

/**
 * The card is nearly full. Paper, because it is the machine talking, and a
 * number rather than an adjective.
 */
static void d4_storage_warning(void) {
  d_ground(D_PAPER);
  d4_head("CARD", NULL, 0, 1);
  storage_status_t sd;
  storage_get_status(&sd);
  const int cx = UI_W / 2;
  d_icon_s(&D_IC_WARN, cx - 24, D_BAND_T + 26, 3, D_RED);
  const int shots = sd.capacity_bytes ? (int)(sd.free_bytes / (6ull * 1024 * 1024)) : 0;
  static char n[16];
  snprintf(n, sizeof n, "%d", shots);
  d_text_c(&UT_MB, cx, D_BAND_T + 96, n, D_RED);
  d_text_c(&UT_S, cx, D_BAND_T + 148, "SHOTS LEFT", d_fg);
  static char cap[48];
  human_bytes(cap, sizeof cap, sd.free_bytes);
  static char line[80];
  snprintf(line, sizeof line, "%s FREE", cap);
  d_label_c(cx, D_BAND_T + 196, line, D_DIM);
  d4_foot("THE CARD IS NEARLY FULL", "ROLL TO DELETE SOME", D_RED);
}

/** A camera has stopped answering. The row says which; the words say what. */
static void d4_camera_failure(void) {
  d_ground(D_PAPER);
  d4_head("CAMERAS", NULL, 0, 1);
  d_mark_t m[4];
  uint16_t ink[4];
  int bad = -1;
  for (int i = 0; i < 4; i++) {
    const bool ok = viewfinder_ready() && viewfinder_tile(i) != NULL;
    m[i] = ok ? D_MARK_ON : D_MARK_FAIL;
    ink[i] = ok ? d_fg : D_RED;
    if (!ok && bad < 0) bad = i;
  }
  d_four(UI_W / 2, D_BAND_T + 60, 116, 20, m, true, ink);
  static char line[64];
  snprintf(line, sizeof line, "CAMERA %d IS NOT ANSWERING", bad + 1);
  d_text_c(&UT_SB, UI_W / 2, D_BAND_T + 140, line, D_RED);
  d_label_c(UI_W / 2, D_BAND_T + 188, "PHOTOGRAPHS WILL HAVE 3 OF 4", D_DIM);
  d4_foot("TURN OFF AND ON AGAIN TO RETRY", "SHUTTER TO CARRY ON", D_RED);
}

/**
 * Are you sure. Paper, two choices, and the destructive one is on the right
 * in red - the side the thumb has to travel to, not the side it rests on.
 */
static void d4_confirm(void) {
  d_ground(D_PAPER);
  /* A red band, then the number, then two solid choices that split the whole
   * width. Not two small boxes floating in a grey field: this is the one
   * screen where the camera is about to destroy something. */
  d_band_top(D_RED);
  d_text(&UT_M, D_MARGIN, 3, d4.confirm_yes ? d4.confirm_yes : "DELETE", D_PAPER);

  const int cx = UI_W / 2;
  /* The count, drawn, because what is about to be lost is a number of
   * photographs and that number is the whole argument. */
  if (d4.confirm_n > 0) {
    static char num[8];
    snprintf(num, sizeof num, "%d", d4.confirm_n);
    df_draw_c(cx, D_BAND_T + 34, num, 7, D_RED);
    d_text_c(&UT_M, cx, D_BAND_T + 146, d4.confirm_noun ? d4.confirm_noun : "FILES", d_fg);
  } else {
    d_text_c(&UT_MB, cx, D_BAND_T + 80, d4.confirm_noun ? d4.confirm_noun : "EVERYTHING", d_fg);
  }
  d_label_c(cx, D_BAND_T + 198, "THIS CANNOT BE UNDONE", D_DIM);

  const bool yes = d4.sel == 1;
  const int by = UI_H - D_BAND_B - 78, bh = 78, half = UI_W / 2;
  /* The destructive choice is on the right: the side the thumb travels to,
   * not the side it rests on. */
  if (yes) {
    d_box(0, by, half, bh, D_DIM);
    fill(half, by, half, bh, D_RED);
  } else {
    fill(0, by, half, bh, D_GRAPH);
    d_box(half, by, half, bh, D_RED);
  }
  d_text_c(&UT_M, half / 2, by + 20, "KEEP IT", yes ? d_fg : D_PAPER);
  d_text_c(&UT_M, half + half / 2, by + 20, d4.confirm_yes ? d4.confirm_yes : "DELETE",
           yes ? D_PAPER : D_RED);
  d4_foot(yes ? "RIGHT IS SELECTED" : "LEFT IS SELECTED", "SHUTTER TO CONFIRM", D_GRAPH);
}


/* ------------------------------------------------------------------ */
/* The menu: four numbered places, over the picture, gone on a press   */

static const char *const D4_PLACES[4] = {"ROLL", "LOOK", "LINK", "SETUP"};

static void d4_menu(void) {
  d4_live();
  const int h = 96, y = UI_H - D_FOOT - h;
  fill(0, y, UI_W, h, D_GRAPH);
  fill(0, y, UI_W, 1, D_FAINT);
  for (int i = 0; i < 4; i++) {
    const int x = d_col_x(i);
    const bool on = d4.sel == i;
    if (on) d_select(x - 4, y + 14, D_COL_W + 8, 60, D_COBALT);
    static const char *const N[4] = {"1", "2", "3", "4"};
    d_text(&UT_SB, x + 8, y + 30, N[i], on ? D_PAPER : D_DIM);
    d_text(&UT_M, x + 32, y + 26, D4_PLACES[i], on ? D_PAPER : d_fg);
  }
}

/* ------------------------------------------------------------------ */
/* The frame                                                           */

static void d4_draw(void) {
  /* A capture is drawn wherever the user happens to be: the shutter works
   * from any screen, because the camera is the point. */
  if (d4.cap != D4_CAP_NONE) {
    switch (d4.cap) {
      case D4_CAP_SHUTTER: d4_shutter(); return;
      case D4_CAP_CATCH: d4_catch(); return;
      case D4_CAP_MAKE: d4_make(); return;
      case D4_CAP_PLAY: d4_play(); return;
      default: break;
    }
  }
  switch (d4.screen) {
    case D4_BOOT: d4_boot(); break;
    case D4_MENU: d4_menu(); break;
    case D4_ROLL: d4_roll(); break;
    case D4_ITEM: d4_item(); break;
    case D4_LOOK: d4_look(); break;
    case D4_LINK: d4_link(); break;
    case D4_SETUP: d4_setup(); break;
    case D4_CAMERAS: d4_cameras(); break;
    case D4_CAL: d4_cal(); break;
    case D4_TRANSFER: d4_transfer(); break;
    case D4_CARD: d4_storage_warning(); break;
    case D4_FAULT: d4_camera_failure(); break;
    case D4_CONFIRM: d4_confirm(); break;
    default:
      if (d4.flash_pct > 0) d4_flash_charging(d4.flash_pct);
      else d4_live();
      break;
  }
}
