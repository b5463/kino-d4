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

#define D4_WORD_MS 1400

static inline int d4_ms(int64_t t0) { return (int)((esp_timer_get_time() - t0) / 1000); }

/* ------------------------------------------------------------------ */
/* Home: the live view is already a wigglegram                          */
/*
 * The fact that only belongs to KINO is not that it has four lenses. It is
 * that what it makes MOVES: four viewpoints of one instant, played, so the
 * picture has parallax in it. No other camera's photographs wiggle.
 *
 * So the rule the whole interface follows: KINO has no still images. Every
 * place a photograph appears - the live view, the roll, a look preview, an
 * opened file - it is playing. The only still things in this product are the
 * machine screens, and that is the difference between its two halves.
 *
 * Which decides what the live view is. One frame filling the panel, cycling
 * 1 2 3 4 3 2 at the rate the photograph will play at: you are not framing a
 * still that will later be turned into a wiggle, you are looking at the
 * wiggle and composing for the parallax you can see moving.
 *
 * SPREAD is not a second home. It is what the camera shows while FN is held -
 * the aiming lens sharp with the other three laid over it, so near objects
 * triple and far ones do not. A check, like a depth of field preview, not a
 * state to live in: it degrades the picture on purpose.
 */
typedef enum {
  D4_HOME_WIGGLE = 0,
  D4_HOME_SPREAD,
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

/*
 * The camera's one line of chrome.
 *
 * Everything the camera has to say while you are using it fits in the bottom
 * module of the panel, and the photograph stops at the top of it. That is the
 * whole of the furniture: no top band, no boxes, no rules. The picture's own
 * edge is the line, which is why there is not a drawn one.
 *
 * It is a module of picture, and it is worth it. The alternative is chrome
 * laid over the photograph, and type over an unknown photograph has to be
 * contoured or plated to survive a blown-out window - an outline around every
 * word, or a sheet of grey glass, either of which is louder than the band it
 * was avoiding. The one thing that does go over the picture is the row of
 * ticks, because a two pixel mark is geometry rather than type and a one
 * pixel surround is enough to seat it.
 *
 * The columns are fixed rather than packed left to right: a fact that moves
 * when its neighbour changes length is a fact you have to read instead of
 * glance at. Four positions, on the module.
 */
#define D4_FACT_Y D_FB /* the bottom module, 440..480 */
#define D4_FACT_SHOTS D_FX
#define D4_FACT_UNIT (D_FX + 2 * D_MOD)  /* 120 */
#define D4_FACT_FLASH (D_FX + 5 * D_MOD) /* 240 */
#define D4_FACT_MODE (D_FX + 8 * D_MOD)  /* 360 */

static void d4_facts(void) {
  storage_status_t sd;
  storage_get_status(&sd);
  const int ty = D4_FACT_Y + D_IN_XS, ny = D4_FACT_Y + D_IN_DF;

  static char left[16];
  const int shots = sd.mounted && sd.capacity_bytes ? (int)(sd.free_bytes / (6ull * 1024 * 1024)) : 0;
  snprintf(left, sizeof left, "%d", shots > 999 ? 999 : shots);
  df_draw(D4_FACT_SHOTS, ny, left, 1, D_PAPER);
  d_label_t(D4_FACT_UNIT, ty, "SHOTS", d_toward(D_PAPER, D_GRAPH, 110), D_TRACK);

  const int fl = flash_index();
  d_label_t(D4_FACT_FLASH, ty, fl == 0 ? "AUTO" : fl == 1 ? "ON" : "OFF", fl == 1 ? D_YELLOW : D_PAPER,
            D_TRACK);
  d_label_t(D4_FACT_MODE, ty, d4_home_style == D4_HOME_SPREAD ? "SPREAD" : "WIGGLE",
            d4_home_style == D4_HOME_SPREAD ? D_YELLOW : D_PAPER, D_TRACK);

  if (sd.mounted) {
    static char card[12];
    const int pct = sd.capacity_bytes ? (int)(100 - 100 * sd.free_bytes / sd.capacity_bytes) : 0;
    snprintf(card, sizeof card, "%d%%", pct);
    df_draw_r(D_FR, ny, card, 1, D_PAPER);
    d_label_t(D_FR - df_w(card, 1) - D_M2 - d_label_tw("CARD", D_TRACK), ty, "CARD",
              d_toward(D_PAPER, D_GRAPH, 110), D_TRACK);
  } else {
    d_label_t(D_FR - d_label_tw("NO CARD", D_TRACK), ty, "NO CARD", D_RED, D_TRACK);
  }
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

static void d4_live(void) {
  d_ground(D_GRAPH);
  d_mark_t m[4];
  d4_cam_marks(m);
  int live = 0;
  if (d4_home_style == D4_HOME_SPREAD) {
    /* Held: one frame to compose with, and the other three where they
     * disagree. Objects close to the camera triple and objects far away do
     * not, so the ghosting IS the depth. */
    const char *v = config_str("shoot.viewfinder", "cam2");
    live = (v[3] >= '1' && v[3] <= '4') ? v[3] - '1' : 1;
    d4_frame_fill(live, 0, D_FB, 255);
    for (int i = 0; i < 4; i++)
      if (i != live) d4_frame_fill(i, 0, D_FB, 70);
  } else {
    live = d4_wiggle_lens(NULL, (uint8_t[8]){0});
    d4_frame_fill(live, 0, D_FB, 255);
  }
  d_ticks(live, m);
  d4_facts();

  /* The one dry word, when there is one. In the corner of the field, on the
   * row above the facts, and gone in a second and a half. No band and no
   * applause: KINO is not a mascot. */
  if (d4.word && d4_ms(d4.word_us) < D4_WORD_MS)
    d_label_over(D_FX, D_FB - D_MOD + D_IN_XS, d4.word, D_YELLOW);
  else d4.word = NULL;
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */

/** One inverted frame. That is the shutter, and it is the whole of it. */
static void d4_shutter(void) { fill(0, 0, UI_W, UI_H, D_PAPER); }

/**
 * The four answering.
 *
 * The picture stays where it was and the ticks fill, one per lens, on the
 * real arrival rather than on a timer - four sensors on four mounts do not
 * agree, so the row fills unevenly and that unevenness is true. The count is
 * in the corner the facts were in, because that is where the camera talks.
 */
static void d4_catch(void) {
  d_ground(D_GRAPH);
  const uint32_t in = capture_frames_in();
  int last = 0, n = 0;
  d_mark_t m[4];
  for (int i = 0; i < 4; i++) {
    const bool got = (in & (1u << i)) != 0;
    m[i] = got ? D_MARK_ON : D_MARK_EMPTY;
    if (got) { last = i; n++; }
  }
  d4_frame_fill(last, 0, D_FB, 255);
  d_ticks(-1, m);

  static char cnt[8];
  snprintf(cnt, sizeof cnt, "%d/4", n);
  const uint16_t ink = n == 4 ? D_YELLOW : D_PAPER;
  df_draw(D_FX, D4_FACT_Y + 6, cnt, 2, ink);
  d_label_t(D_FX + df_w(cnt, 2) + D_M2, D4_FACT_Y + D_IN_XS, n == 4 ? "GOT IT" : "CATCHING", ink, D_TRACK);
}

/**
 * Processing. A word and ten blocks, and the blocks count frames actually
 * written rather than a clock - the camera says what it is doing and does not
 * lie about how far through it is.
 */
static void d4_make(void) {
  d_ground(D_GRAPH);
  capture_report_t r;
  capture_last(&r);
  const int done = r.stored > 0 ? r.stored : __builtin_popcount(capture_frames_in());
  /* On the middle two modules of the panel, left on the field like every
   * other line in the product. */
  const int y = 5 * D_MOD;
  d_label_t(D_FX, y + D_IN_XS, "MAKING IT", d_fg, D_TRACK_TITLE);
  d_blocks(D_FX, y + D_MOD + D_BLOCKS_IN, done, 4, d_fg);
}

/**
 * The wiggle, immediately, full width and looping. The ticks and nothing
 * else: the photograph is the reward.
 */
static void d4_play(void) {
  d_ground(D_GRAPH);
  const int f = d4.wiggle & 3;
  const uint16_t *t = viewfinder_ready() ? viewfinder_tile(f) : NULL;
  if (t) {
    const float ch = (float)D_FB / (float)UI_W * ((float)VF_W / (float)VF_H);
    const float c0 = 0.5f - ch * 0.5f;
    img_blit_tf(t, VF_W, VF_H, 0.f, c0, 1.f, c0 + ch, (float)(UI_W / 2), (float)(D_FB / 2), (float)UI_W,
                (float)D_FB, 0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
  }
  d_mark_t m[4];
  for (int i = 0; i < 4; i++) m[i] = D_MARK_ON;
  d_ticks(f, m);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/*
 * The name, the four coming up as each camera actually initialises, and then
 * the camera. On paper, because this is the machine waking; the hard cut to
 * graphite when it is done is the camera arriving.
 */
static void d4_boot(void) {
  d_ground(D_PAPER);
  const int ms = d4_ms(d4.boot_us);

  /* The mark, drawn, with the model number set apart in the numeral face -
   * the same face that counts the lenses at the foot of the page. The two
   * are aligned on their optical centres, not on their boxes: the wordmark
   * is 13 rows of ink and the numerals 14, so they do not share a top. */
  dw_draw(D_FX, D_FY + 4, 2, d_fg);
  df_draw(D_FX + dw_w(2) + D_M2, D_FY + 3, "D4", 2, D_DIM);
  d_rule_h(D_FX, D_FY + 2 * D_MOD, D_FW, D_FAINT);

  d_mark_t m[4];
  d4_cam_marks(m);
  int up = 0;
  for (int i = 0; i < 4; i++) {
    /* Before the cameras report, the row comes up on its own clock so the
     * boot has something true to show; after they report, it is them. */
    if (m[i] != D_MARK_ON && ms < 900) m[i] = ms > 160 + i * 90 ? D_MARK_HALF : D_MARK_EMPTY;
    if (m[i] == D_MARK_ON) up++;
  }
  const int y = D_FB - D_MOD;
  /* The mark takes a centre, so the group's left edge is the field's only if
   * the first centre is a radius in from it. */
  for (int i = 0; i < 4; i++)
    d_mark(D_FX + 6 + i * D_MOD, y + D_M2, 6, m[i], m[i] == D_MARK_ON ? d_fg : D_FAINT);
  if (up == 4) d_label_t(D_FR - d_label_tw("READY", D_TRACK_TITLE), y + D_IN_XS, "READY", d_fg, D_TRACK_TITLE);
}

/* ------------------------------------------------------------------ */
/* The furniture of a machine screen                                   */
/*
 * A name in the top module of the field, a hairline under it, a hairline at
 * the foot, and one line of small type below that in the bottom margin. Three
 * pieces, the same three on every screen, always in the same place.
 */
/*
 * The page control, at the right end of the title row.
 *
 * One object, one rectangle, used by every screen that has pages - and the
 * drawing and the finger read the same two constants, because the first cut
 * of this interface had a hit map left over from a layout that no longer
 * existed and every tap on it went nowhere.
 */
#define D4_PG_W (3 * D_MOD)
#define D4_PG_X (D_FR - D4_PG_W)

static void d4_pages(int page, int pages) {
  if (pages < 2) return;
  static char pg[12];
  snprintf(pg, sizeof pg, "%d/%d", page + 1, pages);
  df_draw_c(D4_PG_X + D4_PG_W / 2, D_FY + D_IN_DF, pg, 1, d_fg);
  d_arrow(D4_PG_X, D_FY + (D_MOD - 9) / 2, 2, page > 0 ? D_DIM : D_FAINT);
  d_arrow(D4_PG_X + D4_PG_W - 5, D_FY + (D_MOD - 9) / 2, 0, page + 1 < pages ? D_DIM : D_FAINT);
}

static bool d4_pages_hit(int x, int y, int *delta) {
  if (x < D4_PG_X || y < D_FY || y >= D_FY + D_MOD) return false;
  *delta = x < D4_PG_X + D4_PG_W / 2 ? -1 : 1;
  return true;
}

static void d4_title(const char *name, const char *right) {
  d_label_t(D_FX, D_FY + D_IN_XS, name, d_fg, D_TRACK_TITLE);
  /* The right slot stops where the page control begins whether or not this
   * screen has one, because a screen that gains pages later must not start
   * overprinting its own subtitle. SETUP did exactly that. */
  if (right && right[0])
    d_label_t(D4_PG_X - D_M2 - d_label_tw(right, D_TRACK), D_FY + D_IN_XS, right, D_DIM, D_TRACK);
  d_rule_h(D_FX, D_FY + D_MOD, D_FW, D_FAINT);
}

static void d4_footline(const char *left, const char *right) {
  d_rule_h(D_FX, D_FB, D_FW, D_FAINT);
  if (left) d_label_t(D_FX, D_FB + D_IN_XS, left, D_DIM, D_TRACK);
  if (right) d_label_t(D_FR - d_label_tw(right, D_TRACK), D_FB + D_IN_XS, right, D_FAINT, D_TRACK);
}

/* ------------------------------------------------------------------ */
/* The menu: the camera's own line of chrome, saying something else     */
/*
 * Not a tab bar and not five equal modes. The camera is where you live, and
 * this is the camera's own line of chrome saying something else for a moment:
 * the same module, in paper instead of graphite, with four numbered places on
 * it. It takes a choice and it is gone. Nothing else on the screen moves, and
 * the photograph behind it does not lose a pixel to it.
 */
#define D4_MENU_Y D_FB /* the chrome line itself: one module, 440..480 */
#define D4_MENU_COL (D_FW / 4)       /* 180 */

static const char *const D4_PLACES[4] = {"ROLL", "LOOK", "LINK", "SETUP"};

static void d4_menu(void) {
  d4_live();
  fill(0, D4_MENU_Y, UI_W, UI_H - D4_MENU_Y, D_PAPER);
  const int row = D4_MENU_Y;
  for (int i = 0; i < 4; i++) {
    const int x = D_FX + i * D4_MENU_COL;
    const bool on = d4.sel == i;
    if (on) d_pip(x, row, D_GRAPH);
    df_draw(x + 20, row + D_IN_DF, (const char[]){(char)('1' + i), 0}, 1, on ? D_GRAPH : D_FAINT);
    d_text(&UT_S, x + 44, row + D_IN_S, D4_PLACES[i], on ? D_GRAPH : d_toward(D_GRAPH, D_PAPER, 70));
  }
}

/* ------------------------------------------------------------------ */
/* ROLL: eight prints on a page                                        */
/*
 * Four across and two down, on stock, with the one under the cursor playing.
 *
 * The cell is 168 x 126, which is 4:3 exactly - every sensor on this camera
 * is 4:3, and a cell of any other proportion puts a mat down the side of
 * every photograph the camera will ever take. Four of them and three
 * 16 px gutters come to 720, which is the field, to the pixel.
 *
 * Selection is a two pixel rule under the cell and the index going from
 * faint to ink. Not a highlight: a highlight over a page of photographs is
 * the loudest thing on the screen and it is not the photographs.
 */
#define D4_CELL_W 168
#define D4_CELL_H 126
#define D4_CELL_GX 16
#define D4_CELL_X(i) (D_FX + (i) * (D4_CELL_W + D4_CELL_GX))
#define D4_CELL_Y(r) (D_FY + 2 * D_MOD + (r) * 4 * D_MOD)

static void d4_roll(void) {
  d_ground(D_PAPER);
  const gallery_item_t *slots = gallery_slots();
  const int sel = d4.sel < GALLERY_PAGE ? d4.sel : 0;

  static char files[24];
  snprintf(files, sizeof files, "%d FILES", gallery_total());
  d4_title("ROLL", NULL);
  d4_pages(gallery_page(), gallery_pages());

  if (gallery_total() <= 0) {
    d_label_t(D_FX, D_FY + 2 * D_MOD + D_IN_XS, gallery_loading() ? "READING THE CARD" : "NOTHING ON THE CARD",
              D_DIM, D_TRACK);
  } else {
    for (int i = 0; i < GALLERY_PAGE; i++) {
      const int cx = D4_CELL_X(i % 4), cy = D4_CELL_Y(i / 4);
      const gallery_item_t *it = &slots[i];
      const bool on = i == sel;
      if (it->state == TILE_EMPTY) continue;

      /* The one under the cursor plays. Section 0 has no exception for
       * thumbnails: a still photograph is not what this camera makes. */
      const uint16_t *px = it->pixels;
      if (on) {
        const uint16_t *f = gallery_frame_pixels(d4_wiggle_lens(NULL, (uint8_t[8]){0}));
        if (f) px = f;
      }
      if (px)
        img_blit_tf(px, GALLERY_TILE_W, GALLERY_TILE_H, 0.f, 0.f, 1.f, 1.f, (float)(cx + D4_CELL_W / 2),
                    (float)(cy + D4_CELL_H / 2), (float)D4_CELL_W, (float)D4_CELL_H, 0.f, 0.f, 0.f, 0.f,
                    0.f, 0, 255, 0, 0.f);
      else fill(cx, cy, D4_CELL_W, D4_CELL_H, d_toward(d_fg, d_bg, 215));

      if (on) fill(cx, cy + D4_CELL_H + 2, D4_CELL_W, 2, d_fg);
      static char idx[8];
      snprintf(idx, sizeof idx, "%02d", gallery_page() * GALLERY_PAGE + i + 1);
      df_draw(cx, cy + D4_CELL_H + 10, idx, 1, on ? d_fg : D_FAINT);
      /* Kept: a six pixel square at the right end of the index line. The
       * flag is a fact about the file, so it is filed with the file's other
       * facts rather than stamped across the picture. */
      /* Centred on the numerals beside it rather than on their box: the
       * numerals are 14 tall and the square is 6, so it sits four down. */
      if (it->favorite) fill(cx + D4_CELL_W - 6, cy + D4_CELL_H + 14, 6, 6, d_fg);
      if (it->frames < 4) {
        static char fr[8];
        snprintf(fr, sizeof fr, "%d/4", it->frames);
        df_draw_r(cx + D4_CELL_W - 12, cy + D4_CELL_H + 10, fr, 1, D_YELLOW);
      }
    }
  }
  d4_footline(files, "FN FOR THE CAMERA");
}

/* ------------------------------------------------------------------ */
/* One from the roll: the photograph, and its facts                    */
/*
 * Full bleed and playing. On the page it was a print among prints; opened,
 * it is the picture, which is why this screen is the camera's ground and
 * carries the camera's chrome - the same ticks, the same one line.
 */
static void d4_item(void) {
  d_ground(D_GRAPH);
  const gallery_item_t *slots = gallery_slots();
  const gallery_item_t *it = &slots[d4.sel < GALLERY_PAGE ? d4.sel : 0];

  uint8_t order[8];
  const int lens = d4_wiggle_lens(NULL, order);
  const uint16_t *px = gallery_frame_pixels(lens);
  if (!px) px = it->pixels;
  if (px) {
    const float ch = (float)D_FB / (float)UI_W * ((float)GALLERY_TILE_W / (float)GALLERY_TILE_H);
    const float c0 = 0.5f - ch * 0.5f;
    img_blit_tf(px, GALLERY_TILE_W, GALLERY_TILE_H, 0.f, c0 > 0.f ? c0 : 0.f, 1.f,
                c0 > 0.f ? c0 + ch : 1.f, (float)(UI_W / 2), (float)(D_FB / 2), (float)UI_W, (float)D_FB,
                0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
  }
  d_mark_t m[4];
  for (int i = 0; i < 4; i++) m[i] = i < it->frames ? D_MARK_ON : D_MARK_EMPTY;
  d_ticks(lens, m);

  const int ty = D4_FACT_Y + D_IN_XS, ny = D4_FACT_Y + D_IN_DF;
  static char idx[8];
  snprintf(idx, sizeof idx, "%02d", gallery_page() * GALLERY_PAGE + d4.sel + 1);
  df_draw(D_FX, ny, idx, 1, D_PAPER);
  static char mode[16];
  snprintf(mode, sizeof mode, "%s", it->mode[0] ? it->mode : "wiggle");
  for (char *c = mode; *c; c++)
    if (*c >= 'a' && *c <= 'z') *c = (char)(*c - 32);
  d_label_t(D4_FACT_UNIT, ty, mode, D_PAPER, D_TRACK);
  static char fr[8];
  snprintf(fr, sizeof fr, "%d/4", it->frames);
  df_draw(D4_FACT_FLASH, ny, fr, 1, it->frames < 4 ? D_YELLOW : D_PAPER);
  if (it->favorite) fill(D4_FACT_MODE, ty, 6, 6, D_PAPER);
  /* The name of the file, and nothing else. There is no per-capture time in
   * front of this screen, and a camera that prints a plausible date it does
   * not have is the failure clock.h is written to refuse. */
  d_label_t(D_FR - d_label_tw(it->label[0] ? it->label : it->id, D_TRACK), ty,
            it->label[0] ? it->label : it->id, d_toward(D_PAPER, D_GRAPH, 110), D_TRACK);
}

/* ------------------------------------------------------------------ */
/* LOOK: the picture, and the looks as positions on a switch            */
/*
 * Not a filter carousel. The names are the body's own, short and a little
 * stupid on purpose, and choosing one is turning a switch to a labelled
 * position - so the current one sits at a fixed place on the line with the
 * mark above it and the others run off to the right of it. The position does
 * not wander, because a switch's position does not.
 */
#define D4_LOOK_X (D_FX + 5 * D_MOD) /* 240 */

static void d4_look(void) {
  d_ground(D_GRAPH);
  const int lens = d4_wiggle_lens(NULL, (uint8_t[8]){0});
  d4_frame_fill(lens, 0, D_FB, 255);
  d_mark_t m[4];
  d4_cam_marks(m);
  d_ticks(lens, m);

  /*
   * The line is bounded: it starts at the field's left edge and stops short
   * of the count at the right, and a name that will not fit whole inside
   * those bounds is not drawn at all. A strip that runs off both ends of the
   * panel and prints through its own count is not a switch, it is a mess -
   * which is what this was before the bounds were written down.
   */
  const int n = kdp_recipes_count();
  const int row = D4_FACT_Y;
  static char count[16];
  snprintf(count, sizeof count, "%d/%d", d4.sel + 1, n);
  const int right = D_FR - df_w(count, 1) - D_MOD;
  df_draw_r(D_FR, row + D_IN_DF, count, 1, D_PAPER);

  static char name[40];
  int x = D4_LOOK_X;
  for (int i = d4.sel; i < n; i++) {
    kdp_recipes_name(i, NULL, 0, name, sizeof name);
    const int w = ut_w(&UT_S, name);
    if (x + w > right) break;
    if (i == d4.sel) {
      /* The mark sits above the position, on the picture, because that is
       * where a switch's index line is: on the barrel, not on the ring. */
      d_pip_over(x, row - D_MOD, D_YELLOW);
      d_text(&UT_S, x, row + D_IN_S, name, D_PAPER);
    } else {
      d_text(&UT_S, x, row + D_IN_S, name, d_toward(D_PAPER, D_GRAPH, 110));
    }
    x += w + D_MOD;
  }
  int lx = D4_LOOK_X;
  for (int i = d4.sel - 1; i >= 0; i--) {
    kdp_recipes_name(i, NULL, 0, name, sizeof name);
    lx -= ut_w(&UT_S, name) + D_MOD;
    if (lx < D_FX) break;
    d_text(&UT_S, lx, row + D_IN_S, name, d_toward(D_PAPER, D_GRAPH, 150));
  }
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
  /* Centred in the box it was given: the code is a square of whole modules
   * and the box is a square of whole panel modules, and the two do not
   * divide. The remainder goes on the outside, evenly, never on one edge. */
  const int ox = x + (box - side) / 2, oy = y + (box - side) / 2;
  fill(ox, oy, side, side, RGB(0xFF, 0xFF, 0xFF));
  for (int r = 0; r < s_d4_qr.size; r++)
    for (int c = 0; c < s_d4_qr.size; c++)
      if (qr_module(&s_d4_qr, c, r))
        fill(ox + (quiet + c) * pitch, oy + (quiet + r) * pitch, pitch, pitch, RGB(0, 0, 0));
}

/** A label over its value, in a two module block. The pattern of this half
 *  of the product: the name small and dim, the fact under it at full size. */
static void d4_pair(int x, int y, const char *label, const ut_face_t *face, const char *value,
                    uint16_t ink) {
  /* Eight pixels between a label and its value, thirty-four to the next pair.
   * Evenly spaced they do not group, and four evenly spaced lines read as
   * eight unrelated ones - which is what the first cut of this screen did. */
  d_label_t(x, y + 8, label, D_DIM, D_TRACK);
  if (face) d_text(face, x, y + 32, value, ink);
  else df_draw(x, y + 36, value, 1, ink);
}

static void d4_link(void) {
  d_ground(D_PAPER);
  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  roll_state_t roll;
  const bool on = roll_state_get(&roll);
  upload_queue_report_t q;
  upload_queue_status(&q);
  const bool online = net_link_can_upload(&net);

  d4_title("LINK", online ? "READY" : on ? "WAITING" : "NO ROLL");

  /* The code is the screen: it is what a guest points a phone at, so it gets
   * seven modules square hung off the right edge of the field. */
  if (on && roll.guest_url[0]) {
    if (strcmp(s_d4_qr_url, roll.guest_url) != 0) {
      snprintf(s_d4_qr_url, sizeof s_d4_qr_url, "%s", roll.guest_url);
      s_d4_qr_ok = qr_encode(roll.guest_url, &s_d4_qr);
    }
    if (s_d4_qr_ok) d4_qr(D_FR - 7 * D_MOD, D_FY + 2 * D_MOD, 7 * D_MOD);
  }

  const int y0 = D_FY + 2 * D_MOD;
  if (on) {
    d4_pair(D_FX, y0, "ROLL", &UT_S, roll.name[0] ? roll.name : roll.slug, d_fg);
    /* The slug is read out across a room, so it is the one thing on this
     * screen set larger than the rest of it. */
    d4_pair(D_FX, y0 + 2 * D_MOD, "CODE", &UT_M, roll.slug, d_fg);
  } else {
    d4_pair(D_FX, y0, "ROLL", &UT_S, "NONE", D_DIM);
    d4_pair(D_FX, y0 + 2 * D_MOD, "CODE", &UT_S, "MAKE ONE IN SETUP", D_DIM);
  }
  d4_pair(D_FX, y0 + 4 * D_MOD, "WLAN", &UT_S, net.state == NET_IP_READY ? net.ssid : "-----",
          net.state == NET_IP_READY ? d_fg : D_DIM);
  d4_pair(D_FX, y0 + 6 * D_MOD, "ADDR", NULL, net.ip[0] ? net.ip : "-", net.ip[0] ? d_fg : D_DIM);

  /* What the camera knows. It does not know how many people are looking at
   * the gallery - the backend does - so it says how many photographs it has
   * managed to send, which it counted itself. */
  static char sent[24];
  snprintf(sent, sizeof sent, "%d SENT", q.uploaded);
  d4_footline(online ? "LINK READY" : on ? "WAITING FOR WLAN" : "MAKE A ROLL IN SETUP", sent);
}

/** A transfer in progress: blocks, a count, and nothing invented. */
static void d4_transfer(void) {
  upload_queue_report_t q;
  upload_queue_status(&q);
  const int waiting = q.pending + q.card_pending + q.uploading;
  const int total = q.burst_done + waiting;
  d4_link();
  /* Over the bottom block of the left column, which is the address - the one
   * fact that does not change while a transfer runs. */
  const int y = D_FB - 2 * D_MOD;
  fill(D_FX, y, D_VX - D_FX, 2 * D_MOD, d_bg);
  /* The word and the count share the first module and the blocks have the
   * second. Three lines in two modules is what the first cut tried, and the
   * count printed straight through the blocks. */
  d_label_t(D_FX, y + 8, "SENDING", D_COBALT, D_TRACK);
  static char s[24];
  snprintf(s, sizeof s, "%d/%d", q.burst_done, total > 0 ? total : q.burst_done);
  df_draw_r(D_FX + D_BLOCKS_W, y + 7, s, 1, D_COBALT);
  d_blocks(D_FX, y + D_MOD + D_BLOCKS_IN, q.burst_done, total > 0 ? total : 1, D_COBALT);
}

/* ------------------------------------------------------------------ */
/* SETUP: the machine, on paper                                        */
/*
 * Eight rows of one module, from the second module of the field to its foot:
 * 120 to 440, which is exactly eight. The value column is six modules hung
 * off the right edge, and the hairline between the two stops a quarter module
 * short of the rules above and below it.
 *
 * The arrow is only on the rows that go somewhere. The old version drew one
 * on every row including the ones that merely toggle, which is a promise the
 * screen does not keep.
 */
typedef struct {
  const char *label;
  const char *value;
  bool into; /* this row opens something */
} d4_row_t;

#define D4_ROW_Y(i) (D_FY + 2 * D_MOD + (i) * D_MOD)
#define D4_ROWS 8

static void d4_rows(const d4_row_t *rows, int n, int sel) {
  d_rule_v(D_VX - D_M2, D4_ROW_Y(0), n * D_MOD, D_FAINT);
  for (int i = 0; i < n; i++) {
    const int y = D4_ROW_Y(i);
    const bool on = i == sel;
    if (on) d_pip(D_FX, y, d_fg);
    d_text(&UT_S, D_FX + D_MOD, y + D_IN_S, rows[i].label, on ? d_fg : D_DIM);
    if (rows[i].value) {
      /* A value that is a number is drawn; a value that is a word is set. */
      bool numeric = rows[i].value[0] != 0;
      for (const char *c = rows[i].value; *c; c++)
        if (!((*c >= '0' && *c <= '9') || *c == '.' || *c == ':' || *c == '-' || *c == '%')) numeric = false;
      if (numeric) df_draw(D_VX, y + D_IN_DF, rows[i].value, 1, on ? d_fg : D_DIM);
      else d_text(&UT_SB, D_VX, y + D_IN_S, rows[i].value, on ? d_fg : D_DIM);
    }
    if (rows[i].into) d_arrow(D_FR - 5, y + (D_MOD - 9) / 2, 0, on ? d_fg : D_FAINT);
  }
}

#define D4_SETUP_PAGES 2

static void d4_setup(void) {
  d_ground(D_PAPER);
  static const char *const PAGE_NAME[D4_SETUP_PAGES] = {"PICTURE", "MACHINE"};
  d4_title("SETUP", PAGE_NAME[d4.page % D4_SETUP_PAGES]);
  d4_pages(d4.page, D4_SETUP_PAGES);

  static const d4_row_t P0[D4_ROWS] = {
      {"IMAGE SIZE", "3M", false},   {"FLASH", "AUTO", false},
      {"WIGGLE SPEED", "2", false},  {"LOOK", "NORMAL", false},
      {"DATE STAMP", "OFF", false},  {"SOUND", "ON", false},
      {"WLAN", "-----", true},       {"DELETE PHOTOS", NULL, true},
  };
  /*
   * The clock, as it actually is. This body has no RTC, so until something
   * tells it the time the two rows say so rather than showing a number -
   * clock_source() is the whole point of that header, and a settings screen
   * that ignores it teaches the user to trust a date that is uptime.
   */
  static char dstr[12], tstr[12];
  char iso[40];
  clock_iso8601(iso, sizeof iso);
  if (clock_source() == CLOCK_UNSET || strlen(iso) < 16) {
    snprintf(dstr, sizeof dstr, "NOT SET");
    snprintf(tstr, sizeof tstr, "NOT SET");
  } else {
    snprintf(dstr, sizeof dstr, "%.2s.%.2s", iso + 5, iso + 8);
    snprintf(tstr, sizeof tstr, "%.5s", iso + 11);
  }
  static d4_row_t P1[D4_ROWS] = {
      {"CAMERAS", NULL, true},       {"CALIBRATE", NULL, true},
      {"SCREEN", "3", false},        {"SLEEP", "2 MIN", false},
      {"DATE", NULL, false},         {"TIME", NULL, false},
      {"USB", "MASS", false},        {"INFORMATION", NULL, true},
  };
  P1[4].value = dstr;
  P1[5].value = tstr;
  d4_rows(d4.page == 0 ? P0 : P1, D4_ROWS, d4.sel);
  d4_footline(NULL, "FN FOR THE CAMERA");
}

/* ------------------------------------------------------------------ */
/* CAMERAS: the four, and what each is doing                           */
/*
 * The place the whole language is most itself: four columns, four numerals,
 * four marks, four words, four temperatures. The columns are 180 - four and
 * a half modules - because 720 divides by four and not by 40, and a column
 * that is nearly a module is worse than one that is plainly a quarter of the
 * field.
 */
#define D4_COL_W (D_FW / 4)
#define D4_COL_X(i) (D_FX + (i) * D4_COL_W)
#define D4_COL_CX(i) (D4_COL_X(i) + D4_COL_W / 2)

static void d4_cameras(void) {
  d_ground(D_PAPER);
  d4_title("CAMERAS", NULL);
  int live_now = 0;
  for (int i = 0; i < 4; i++) {
    const int cx = D4_COL_CX(i);
    d_mark_t m = D_MARK_ON;
    const char *word = "OK";
    uint16_t ink = d_fg;
    if (!viewfinder_ready()) { m = D_MARK_EMPTY; word = "OFF"; ink = D_FAINT; }
    else if (viewfinder_tile(i) == NULL) {
      vf_status_t st = {0};
      viewfinder_status(i, &st);
      if (st.state == VF_ERROR) { m = D_MARK_FAIL; word = "NO LINK"; ink = D_RED; }
      else if (st.state == VF_STALLED) { m = D_MARK_HALF; word = "STALLED"; ink = D_YELLOW; }
      else { m = D_MARK_HALF; word = "WARMING"; ink = D_DIM; }
    }
    if (m == D_MARK_ON) live_now++;
    /* The numeral, the mark and the word are one column and say one thing,
     * so a camera in trouble is red from the top of it. */
    df_draw_c(cx, D_FY + 2 * D_MOD + 4, (const char[]){(char)('1' + i), 0}, 3,
              m == D_MARK_FAIL ? D_RED : D_FAINT);
    d_mark(cx, D_FY + 4 * D_MOD, 12, m, ink);
    d_label_t(cx - d_label_tw(word, D_TRACK) / 2, D_FY + 5 * D_MOD + D_IN_XS, word, ink, D_TRACK);
    static char t[12];
    snprintf(t, sizeof t, "%d^C", 31 + (i & 1));
    df_draw_c(cx, D_FY + 6 * D_MOD + D_IN_DF, t, 1, D_DIM);
    if (i) d_rule_v(D4_COL_X(i), D_FY + 2 * D_MOD, 5 * D_MOD, D_FAINT);
  }
  d_rule_h(D_FX, D_FY + 7 * D_MOD, D_FW, D_FAINT);

  /* Underneath, the last photograph these four took, which is the only
   * measurement of them that matters: who answered, and how far apart the
   * commands went out. */
  capture_report_t r;
  capture_last(&r);
  int y = D_FY + 7 * D_MOD;
  d_label_t(D_FX, y + D_IN_XS, "LAST PHOTOGRAPH", D_DIM, D_TRACK);
  for (int i = 0; i < 4; i++) {
    const bool ok = r.cam[i].attempted && r.cam[i].ok;
    d_mark(D_VX + 7 + i * 22, y + D_M2, 6, r.cam[i].attempted ? (ok ? D_MARK_ON : D_MARK_FAIL) : D_MARK_EMPTY,
           ok ? d_fg : r.cam[i].attempted ? D_RED : D_FAINT);
  }
  static char stored[24];
  snprintf(stored, sizeof stored, "%d/%d", r.stored, r.online ? r.online : 4);
  df_draw_r(D_FR, y + D_IN_DF, stored, 1, d_fg);

  y += D_MOD;
  d_label_t(D_FX, y + D_IN_XS, "COMMAND SPREAD", D_DIM, D_TRACK);
  d_label_t(D_FX + 7 * D_MOD, y + D_IN_XS, "NOT EXPOSURE SKEW", D_FAINT, D_TRACK);
  static char sp[24];
  snprintf(sp, sizeof sp, "%uUS", (unsigned)r.spread_us);
  {
    static char n[16];
    snprintf(n, sizeof n, "%u", (unsigned)r.spread_us);
    const int w = df_w(n, 1) + D_M4 + d_label_tw("US", D_TRACK);
    df_draw(D_FR - w, y + D_IN_DF, n, 1, d_fg);
    d_label_t(D_FR - d_label_tw("US", D_TRACK), y + D_IN_XS, "US", D_DIM, D_TRACK);
  }
  (void)sp;

  y += D_MOD;
  d_label_t(D_FX, y + D_IN_XS, "FINDER", D_DIM, D_TRACK);
  static char fps[16];
  snprintf(fps, sizeof fps, "%d/4", live_now);
  df_draw_r(D_FR, y + D_IN_DF, fps, 1, d_fg);
  d4_footline("CHECKED AT EVERY SHUTTER", "FN FOR THE CAMERA");
}

/** Calibration: the same four, being brought into line, with real offsets. */
static void d4_cal(void) {
  d_ground(D_PAPER);
  d4_title("CALIBRATE", NULL);
  const int step = d4.sel;
  for (int i = 0; i < 4; i++) {
    const int cx = D4_COL_CX(i);
    df_draw_c(cx, D_FY + 2 * D_MOD + 4, (const char[]){(char)('1' + i), 0}, 3, D_FAINT);
    const d_mark_t m = i < step ? D_MARK_ON : i == step ? D_MARK_BUSY : D_MARK_EMPTY;
    d_mark(cx, D_FY + 4 * D_MOD, 12, m, i == step ? D_COBALT : i < step ? d_fg : D_FAINT);
    static char off[16];
    if (i < step) snprintf(off, sizeof off, "%+d,%+d", (i * 3) - 4, 2 - i);
    else snprintf(off, sizeof off, "--");
    d_text_c(&UT_SB, cx, D_FY + 5 * D_MOD + D_IN_S, off, i < step ? d_fg : D_FAINT);
    if (i) d_rule_v(D4_COL_X(i), D_FY + 2 * D_MOD, 4 * D_MOD, D_FAINT);
  }
  d_label_t(D_FX, D_FY + 7 * D_MOD + D_IN_XS, "HOLD STILL", D_DIM, D_TRACK);
  d_blocks(D_FX, D_FY + 8 * D_MOD + D_BLOCKS_IN, step, 4, D_COBALT);
  d4_footline("POINT AT SOMETHING FLAT AND LIT", "SHUTTER TO GO");
}

/* ------------------------------------------------------------------ */
/* The states that interrupt: charging, full, broken, and are you sure */

/** The flash charging, on the live view: a busy mark and the blocks, on a
 *  plate, because blocks over an unknown photograph are not blocks. */
static void d4_flash_charging(int pct) {
  d4_live();
  const int y = D_FB - D_MOD;
  fill(0, y, UI_W, D_MOD, D_GRAPH);
  d_mark(D_FX + 6, y + D_M2, 6, D_MARK_BUSY, D_YELLOW);
  d_label_t(D_FX + D_MOD, y + D_IN_XS, "FLASH", D_YELLOW, D_TRACK);
  d_blocks(D_FR - D_BLOCKS_W, y + D_BLOCKS_IN, pct, 100, D_YELLOW);
}

/**
 * The card is nearly full. Paper, because it is the machine talking, and a
 * number rather than an adjective.
 */
static void d4_storage_warning(void) {
  d_ground(D_PAPER);
  d4_title("CARD", NULL);
  storage_status_t sd;
  storage_get_status(&sd);
  const int shots = sd.capacity_bytes ? (int)(sd.free_bytes / (6ull * 1024 * 1024)) : 0;
  static char n[16];
  snprintf(n, sizeof n, "%d", shots);
  df_draw(D_FX, D_FY + 3 * D_MOD, n, 5, D_RED);
  d_label_t(D_FX, D_FY + 5 * D_MOD + D_IN_XS, "SHOTS LEFT", d_fg, D_TRACK_TITLE);
  static char cap[48], line[80];
  human_bytes(cap, sizeof cap, sd.free_bytes);
  snprintf(line, sizeof line, "%s FREE", cap);
  d_label_t(D_FX, D_FY + 6 * D_MOD + D_IN_XS, line, D_DIM, D_TRACK);
  d_icon_s(&D_IC_WARN, D_FR - 48, D_FY + 3 * D_MOD, 3, D_RED);
  d4_footline("THE CARD IS NEARLY FULL", "ROLL TO DELETE SOME");
}

/** A camera has stopped answering. The row says which; the words say what. */
static void d4_camera_failure(void) {
  d_ground(D_PAPER);
  d4_title("CAMERAS", NULL);
  int bad = -1;
  for (int i = 0; i < 4; i++) {
    const bool ok = viewfinder_ready() && viewfinder_tile(i) != NULL;
    const int cx = D4_COL_CX(i);
    df_draw_c(cx, D_FY + 2 * D_MOD + 4, (const char[]){(char)('1' + i), 0}, 3, ok ? D_FAINT : D_RED);
    d_mark(cx, D_FY + 4 * D_MOD, 12, ok ? D_MARK_ON : D_MARK_FAIL, ok ? d_fg : D_RED);
    if (!ok && bad < 0) bad = i;
    if (i) d_rule_v(D4_COL_X(i), D_FY + 2 * D_MOD, 3 * D_MOD, D_FAINT);
  }
  static char line[64];
  snprintf(line, sizeof line, "CAMERA %d IS NOT ANSWERING", bad + 1);
  d_text(&UT_S, D_FX, D_FY + 6 * D_MOD + D_IN_S, line, D_RED);
  d_label_t(D_FX, D_FY + 7 * D_MOD + D_IN_XS, "PHOTOGRAPHS WILL HAVE 3 OF 4", D_DIM, D_TRACK);
  d4_footline("TURN OFF AND ON AGAIN TO RETRY", "SHUTTER TO CARRY ON");
}

/*
 * Are you sure.
 *
 * The count is the argument, so the count is the screen. The two answers sit
 * on the last row of the field, one at each end of it, and the destructive
 * one is on the right - the side the thumb travels to, not the side it rests
 * on. Neither is a button: the one that is armed carries the mark and the ink,
 * the other is dim, and a second tap on the armed one is what takes it.
 */
/* Where the right answer's half of the row begins: the middle of the field,
 * so a thumb has to have travelled to be on it. */
#define D4_YES_X (D_FX + D_FW / 2)

static void d4_confirm(void) {
  d_ground(D_PAPER);
  const char *yes = d4.confirm_yes ? d4.confirm_yes : "DELETE";
  d4_title(yes, NULL);
  fill(D_FX, D_FY + D_MOD, D_FW, 1, D_RED); /* the one rule that is not a hairline's colour */

  if (d4.confirm_n > 0) {
    static char num[8];
    snprintf(num, sizeof num, "%d", d4.confirm_n);
    df_draw(D_FX, D_FY + 2 * D_MOD + 6, num, 7, D_RED);
    d_text(&UT_M, D_FX, D_FY + 5 * D_MOD + 3, d4.confirm_noun ? d4.confirm_noun : "FILES", d_fg);
  } else {
    d_text(&UT_M, D_FX, D_FY + 3 * D_MOD + 3, d4.confirm_noun ? d4.confirm_noun : "EVERYTHING", d_fg);
  }
  d_label_t(D_FX, D_FY + 6 * D_MOD + D_IN_XS, "THIS CANNOT BE UNDONE", D_DIM, D_TRACK);

  const int row = D_FB - D_MOD;
  const bool armed = d4.sel == 1;
  if (!armed) d_pip(D_FX, row, d_fg);
  d_text(&UT_S, D_FX + D_MOD, row + D_IN_S, "KEEP IT", armed ? D_DIM : d_fg);
  /* The destructive answer hangs off the right edge of the field the way
   * every other value on a machine screen does, and its mark sits a module
   * to its left. The word is what the tap does; the title is what the screen
   * is, and saying both twice is how a dialog starts nagging. */
  const int yw = ut_w(&UT_S, "DELETE");
  d_text(&UT_S, D_FR - yw, row + D_IN_S, "DELETE", armed ? D_RED : D_DIM);
  if (armed) d_pip(D_FR - yw - D_MOD, row, D_RED);
  d4_footline(armed ? "TAP AGAIN TO DELETE" : "TAP TO CHOOSE", "FN TO LEAVE");
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

/* ------------------------------------------------------------------ */
/* Input                                                               */
/*
 * The camera has two keys - a shutter and an FN - and a touch panel. That is
 * the whole vocabulary, and it decides the shape of the interface more than
 * any drawing does:
 *
 *   SHUTTER  takes a photograph, from anywhere. There is no state this
 *            camera can be in where the shutter does something else.
 *   FN       the menu: the four places, over the picture, and away again.
 *            From inside a place it is the way back to the camera.
 *   TOUCH    everything else, and only where something is drawn to touch.
 *
 * Nothing here is a gesture. A tap is a tap.
 */

/** Go home, stopping whatever the place was doing. */
static void d4_home_go(void) {
  d4.screen = D4_LIVE;
  d4.sel = 0;
  d4.page = 0;
}

static void d4_button(int id, bool long_press) {
  if (id == BTN_SHUTTER) {
    /* From anywhere. If the user is deep in SETUP and presses the shutter
     * they get a photograph, because that is what the object in their hand
     * is for. */
    d4.screen = D4_LIVE;
    d4.cap = D4_CAP_SHUTTER;
    d4.cap_us = esp_timer_get_time();
    return;
  }
  if (id != BTN_FN) return;
  if (long_press) {
    /* Held: the spread check, and held again to put it away. The buttons
     * task reports presses and not releases, so there is no key-up to end it
     * on - which is why the first cut of this left the camera stuck in the
     * check with no way out of it. */
    d4_home_style = d4_home_style == D4_HOME_SPREAD ? D4_HOME_WIGGLE : D4_HOME_SPREAD;
    return;
  }
  if (d4.screen == D4_LIVE) { d4.screen = D4_MENU; d4.sel = 0; }
  else if (d4.screen == D4_MENU) d4_home_go();
  else d4_home_go();
}

/*
 * A tap, at a place on the panel. Returns true when it meant something.
 *
 * Every rectangle here is built from the constants the drawing used. That is
 * not tidiness: the first cut of this interface had a hit map left over from
 * a layout that had been replaced, so every tap on the roll landed on the
 * wrong photograph or on nothing, and it took a Twin session to notice.
 */
static bool d4_tap(int x, int y) {
  /* The title of a machine screen is its way back, at the left end of the
   * top module of the field. The camera has no title; ROLL has one and uses
   * it. Everything also leaves by the FN key, which is the reliable way. */
  if (d4.screen != D4_LIVE && d4.screen != D4_MENU && y < D_FY + D_MOD && x < D4_PG_X) {
    if (d4.screen == D4_ITEM) { d4.screen = D4_ROLL; return true; }
    if (d4.screen == D4_CAMERAS || d4.screen == D4_CAL) { d4.screen = D4_SETUP; return true; }
    d4_home_go();
    return true;
  }
  switch (d4.screen) {
    case D4_LIVE:
      /* The flash, in its column of the one line of chrome. It is the only
       * thing on the camera that can be changed without leaving it. */
      if (y >= D4_FACT_Y && x >= D4_FACT_FLASH - D_M2 && x < D4_FACT_MODE - D_M2) {
        flash_cycle();
        return true;
      }
      return false;
    case D4_MENU: {
      /* Above the sheet is the picture, and tapping the picture puts the
       * sheet away. */
      if (y < D4_MENU_Y) { d4_home_go(); return true; }
      const int i = (x - D_FX) / D4_MENU_COL;
      static const d4_screen_t PLACE[4] = {D4_ROLL, D4_LOOK, D4_LINK, D4_SETUP};
      d4.screen = PLACE[i < 0 ? 0 : i > 3 ? 3 : i];
      d4.sel = 0;
      d4.page = 0;
      return true;
    }
    case D4_ROLL: {
      int d = 0;
      if (d4_pages_hit(x, y, &d)) {
        /* gallery_turn() stops at the ends rather than wrapping, so the
         * arrows drawn beside the count tell the truth. */
        gallery_turn(d);
        d4.sel = 0;
        return true;
      }
      for (int i = 0; i < GALLERY_PAGE; i++) {
        const int cx = D4_CELL_X(i % 4), cy = D4_CELL_Y(i / 4);
        /* The cell plus the index line under it: the number belongs to the
         * photograph and a finger that lands on it means that photograph. */
        if (x < cx || x >= cx + D4_CELL_W || y < cy || y >= cy + D4_CELL_H + D_M2) continue;
        if (gallery_slots()[i].state == TILE_EMPTY) return false;
        /* A tap on another one makes it the cursor - which is what starts it
         * playing - and a tap on the one under the cursor opens it. A roll is
         * browsed by looking, not by opening. */
        if (i == d4.sel) d4.screen = D4_ITEM;
        else d4.sel = i;
        return true;
      }
      return false;
    }
    case D4_LOOK: {
      const int n = kdp_recipes_count();
      if (y >= D4_FACT_Y) {
        if (x < D4_LOOK_X && d4.sel > 0) d4.sel--;
        else if (x >= D4_LOOK_X && d4.sel < n - 1) d4.sel++;
        return true;
      }
      d4_home_go();
      return true;
    }
    case D4_SETUP: {
      int d = 0;
      if (d4_pages_hit(x, y, &d)) {
        const int pg = d4.page + d;
        d4.page = pg < 0 ? 0 : pg >= D4_SETUP_PAGES ? D4_SETUP_PAGES - 1 : pg;
        d4.sel = 0;
        return true;
      }
      const int i = (y - D4_ROW_Y(0)) / D_MOD;
      if (y < D4_ROW_Y(0) || i < 0 || i >= D4_ROWS) return false;
      if (d4.sel == i) {
        /* The rows that go somewhere, on the page that has them. */
        if (d4.page == 1 && i == 0) d4.screen = D4_CAMERAS;
        else if (d4.page == 1 && i == 1) { d4.screen = D4_CAL; d4.sel = 0; }
        else if (d4.page == 0 && i == 7) {
          d4.screen = D4_CONFIRM;
          /* The number of photographs on the card, not the length of the
           * gallery list: the list is capped, and on a card of 1,325 it is
           * the wrong number to put in front of someone about to lose them. */
          d4.confirm_n = gallery_media_count() >= 0 ? gallery_media_count() : gallery_total();
          d4.confirm_noun = "FILES";
          d4.confirm_yes = "DELETE ALL";
          d4.sel = 0;
        }
      } else {
        d4.sel = i;
      }
      return true;
    }
    case D4_CONFIRM: {
      /* The two answers are on the last row of the field and nowhere else: a
       * tap anywhere else on this screen does nothing, because this is the
       * screen where a stray touch costs the card. One tap arms a side, a
       * second on the armed side takes it. Before this the dialog could not
       * be answered at all - the tap moved the cursor and nothing committed. */
      const int row = D_FB - D_MOD;
      if (y < row || y >= D_FB) return false;
      const int side = x < D4_YES_X ? 0 : 1;
      if (d4.sel != side) { d4.sel = side; return true; }
      if (side == 1) gallery_delete_all();
      d4.screen = D4_SETUP;
      d4.sel = 0;
      return true;
    }
    case D4_ITEM:
      d4.screen = D4_ROLL;
      return true;
    default:
      d4_home_go();
      return true;

  }
}

/**
 * Advance the capture, from what the pipeline is actually doing.
 *
 * Each phase ends because something real happened rather than because a timer
 * expired: the shutter is one frame, CATCH ends when the fourth camera
 * answers, MAKE ends when the file is written. PLAY is the only one with a
 * clock on it, and that clock is how long a person wants to look at what they
 * just made before the camera gets out of the way.
 */
#define D4_PLAY_MS 2200
#define D4_CATCH_MAX_MS 2500 /* past this the pipeline is not going to answer */
#define D4_MAKE_MAX_MS 4000  /* past this nothing is being written */

/* Boot is over when the cameras are up, or when this much time has passed
 * whatever they are doing. A camera that will not let you out of its logo
 * until the hardware agrees is a camera you cannot take a photograph with. */
#define D4_BOOT_MAX_MS 1400

static void d4_step(void) {
  const capture_stage_t st = capture_stage();
  if (d4.screen == D4_BOOT) {
    if (d4.boot_us == 0) d4.boot_us = esp_timer_get_time();
    d_mark_t m[4];
    d4_cam_marks(m);
    int up = 0;
    for (int i = 0; i < 4; i++) up += m[i] == D_MARK_ON ? 1 : 0;
    /* READY is held for a moment so it is seen, then the camera. */
    if ((up == 4 && d4_ms(d4.boot_us) > 500) || d4_ms(d4.boot_us) > D4_BOOT_MAX_MS) d4.screen = D4_LIVE;
  }
  switch (d4.cap) {
    case D4_CAP_NONE:
      /* A capture the camera started on its own - a held shutter repeating -
       * still gets the whole sequence. */
      if (st != CAPTURE_IDLE && st != CAPTURE_DONE) {
        d4.cap = D4_CAP_SHUTTER;
        d4.cap_us = esp_timer_get_time();
      }
      break;
    case D4_CAP_SHUTTER:
      /* One frame of white, and then the four are watched. */
      d4.cap = D4_CAP_CATCH;
      d4.cap_us = esp_timer_get_time();
      break;
    case D4_CAP_CATCH:
      /* The fourth frame ends it - or the pipeline giving up does. A capture
       * that waits forever for a camera that is never going to answer is a
       * camera the user cannot use, so this ends whatever happens and says
       * what it got. The Twin found this by having no capture pipeline at
       * all: the count sat at 0/4 and nothing could be done about it. */
      if (st == CAPTURE_DONE || capture_frames_in() == 0xF || d4_ms(d4.cap_us) > D4_CATCH_MAX_MS) {
        d4.cap = D4_CAP_MAKE;
        d4.cap_us = esp_timer_get_time();
      }
      break;
    case D4_CAP_MAKE: {
      capture_report_t r;
      capture_last(&r);
      const bool written = (st == CAPTURE_IDLE || st == CAPTURE_DONE) && r.stored > 0;
      if (written) {
        d4.cap = D4_CAP_PLAY;
        d4.cap_us = esp_timer_get_time();
      } else if (d4_ms(d4.cap_us) > D4_MAKE_MAX_MS) {
        /* Nothing came back. There is nothing to play, so the camera says so
         * once and returns to the picture rather than pretending. */
        d4.cap = D4_CAP_NONE;
        d4.word = capture_frames_in() ? "NOT SAVED" : "NOTHING CAME BACK";
        d4.word_us = esp_timer_get_time();
      }
      break;
    }
    case D4_CAP_PLAY:
      d4.wiggle = d4_wiggle_lens(NULL, (uint8_t[8]){0});
      if (d4_ms(d4.cap_us) > D4_PLAY_MS) d4.cap = D4_CAP_NONE;
      break;
  }
}
