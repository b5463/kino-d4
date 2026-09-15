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
  const char *confirm_q;
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

static void d4_feeds(int frozen_frame) {
  for (int i = 0; i < 4; i++) {
    const uint16_t *t = viewfinder_ready() ? viewfinder_tile(i) : NULL;
    const int x = i * D4_FEED_W;
    if (!t) {
      fill(x, 0, D4_FEED_W, UI_H, d_toward(d_bg, D_PAPER, 24));
      d_text_c(&UT_S, x + D4_FEED_W / 2, UI_H / 2 - 12, "--", D_FAINT);
      continue;
    }
    /* Centre crop to the pane's aspect: the panel is much taller than a
     * sensor frame, so what is shown is the middle of each view. */
    const float aspect = (float)D4_FEED_W / (float)UI_H;
    const float cw = aspect * (float)VF_H / (float)VF_W;
    const float c0 = 0.5f - cw * 0.5f;
    (void)frozen_frame;
    img_blit_tf(t, VF_W, VF_H, c0, 0.f, c0 + cw, 1.f, (float)(x + D4_FEED_W / 2), (float)(UI_H / 2),
                (float)D4_FEED_W, (float)UI_H, 0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
    /* One hairline per seam, so the four are visibly four rather than one
     * wide picture that happens to be slightly wrong three times. */
    if (i) fill(x, 0, 1, UI_H, D_GRAPH);
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

/**
 * The strip along the bottom, and the marks that make the picture a frame.
 *
 * Everything counted is in the drawn face; everything named is in tracked
 * small caps. That split is the whole typographic rule of this interface -
 * numbers are objects, words are labels, and they never look like each other.
 */
#define D4_STRIP 46

static void d4_live_strip(void) {
  const int y = UI_H - D4_STRIP;
  storage_status_t sd;
  storage_get_status(&sd);
  power_state_t ps;
  power_get(&ps);

  /* A hairline over the strip with a tick at each feed seam: the strip
   * belongs to the four columns above it. */
  fill(0, y - 1, UI_W, 1, d_toward(D_PAPER, D_GRAPH, 120));
  for (int i = 1; i < 4; i++) fill(i * D4_FEED_W, y - 5, 1, 5, d_toward(D_PAPER, D_GRAPH, 120));

  /* Left: what is left. The number is drawn; the unit is a label. */
  static char left[16];
  const int shots = sd.mounted && sd.capacity_bytes ? (int)(sd.free_bytes / (6ull * 1024 * 1024)) : 0;
  snprintf(left, sizeof left, "%d", shots > 999 ? 999 : shots);
  int x = D_MARGIN;
  x = df_draw_over(x, y + 12, left, 2, d_fg) + 8;
  d_text_over(&UT_XS, x, y + 18, "SHOTS", D_DIM);

  /* Then how it is going to take it, in a cell, because a mode is a setting
   * and a setting has a position. */
  const int fl = flash_index();
  const char *fs = fl == 0 ? "AUTO" : fl == 1 ? "ON" : "OFF";
  x = D4_FEED_W + 14;
  d_icon(fl == 2 ? &D_IC_FLASH_OFF : &D_IC_FLASH, x, y + 13, fl == 1 ? D_YELLOW : d_fg);
  x += 20;
  d_cell(x, y + 10, d_label_w(fs) + 14, 24, fl == 1 ? D_YELLOW : D_DIM);
  d_label(x + 7, y + 16, fs, fl == 1 ? D_YELLOW : d_fg);
  x += d_label_w(fs) + 14 + 14;
  d_cell(x, y + 10, d_label_w("WIGGLE") + 14, 24, D_DIM);
  d_label(x + 7, y + 16, "WIGGLE", d_fg);

  /* The four, under their own numerals, because this is the row the whole
   * interface is built from and the live view is where it is learned. */
  d_mark_t m[4];
  d4_cam_marks(m);
  uint16_t ink[4];
  for (int i = 0; i < 4; i++) ink[i] = m[i] == D_MARK_FAIL ? D_RED : m[i] == D_MARK_ON ? d_fg : D_DIM;
  const int fx = 2 * D4_FEED_W + 30;
  for (int i = 0; i < 4; i++) {
    df_draw_over(fx + i * 26, y + 8, (const char[]){(char)('1' + i), 0}, 1, D_DIM);
    d_mark(fx + i * 26 + 5, y + 33, 5, m[i], ink[i]);
  }

  /* Right: the card, and the mains when there is one. No battery: this camera
   * has no fuel gauge, and four bars that were not measured are worse than no
   * symbol at all. d_battery() waits in d4_style.h for when it can. */
  int rx = UI_W - D_MARGIN;
  if (ps.usb_attached) {
    d_label_r(rx, y + 20, "USB", D_COBALT);
    rx -= d_label_w("USB") + 18;
  }
  const int pct = sd.capacity_bytes ? (int)(100 - 100 * sd.free_bytes / sd.capacity_bytes) : 0;
  if (sd.mounted) {
    static char card[12];
    snprintf(card, sizeof card, "%d%%", pct);
    df_draw_over_r(rx, y + 12, card, 2, d_fg);
    rx -= df_w(card, 2) + 10;
  } else {
    d_label_r(rx, y + 20, "NO CARD", D_RED);
    rx -= d_label_w("NO CARD") + 8;
  }
  d_icon(&D_IC_CARD, rx - 18, y + 13, sd.mounted ? d_fg : D_RED);
}

static void d4_live(void) {
  d_ground(D_GRAPH);
  d4_feeds(-1);
  /* Framing marks on the picture, and a numeral at the head of each feed.
   * A camera tells you where the frame is; a photo viewer does not. */
  d_corners(6, 6, UI_W - 12, UI_H - D4_STRIP - 12, 22, 2, d_toward(D_PAPER, D_GRAPH, 40));
  for (int i = 0; i < 4; i++)
    df_draw_over(i * D4_FEED_W + 12, 12, (const char[]){(char)('1' + i), 0}, 1, D_PAPER);
  d4_live_strip();
  /* The one dry word, when there is one, in the corner and gone. */
  if (d4.word && d4_ms(d4.word_us) < D4_WORD_MS) {
    const int w = ut_w(&UT_MB, d4.word);
    d_select(D_MARGIN, 40, w + 28, 46, D_PAPER);
    d_text(&UT_MB, D_MARGIN + 14, 46, d4.word, D_GRAPH);
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
  d4_feeds(-1);
  fill_a(0, 0, UI_W, UI_H, D_GRAPH, 210); /* the picture is still there, under it */

  const uint32_t in = capture_frames_in();
  d_mark_t m[4];
  uint16_t ink[4];
  int n = 0;
  for (int i = 0; i < 4; i++) {
    const bool got = (in & (1u << i)) != 0;
    m[i] = got ? D_MARK_ON : D_MARK_EMPTY;
    ink[i] = got ? D_YELLOW : D_DIM;
    n += got ? 1 : 0;
  }
  /* The row, bracketed, each lens's numeral over its mark, and the count
   * beside it in the same face - so what is filling and what is counted are
   * visibly the same thing. */
  const int cx = UI_W / 2, cy = UI_H / 2;
  const int pitch = 84, bw = 3 * pitch + 76, bx = cx - bw / 2 - 46, by = cy - 62;
  d_corners(bx, by, bw, 124, 20, 2, D_DIM);
  for (int i = 0; i < 4; i++) {
    const int mx = bx + 38 + i * pitch;
    df_draw(mx - 5, by + 20, (const char[]){(char)('1' + i), 0}, 1, m[i] == D_MARK_ON ? D_YELLOW : D_DIM);
    d_mark(mx, by + 84, 14, m[i], ink[i]);
  }
  static char cnt[8];
  snprintf(cnt, sizeof cnt, "%d/4", n);
  df_draw(bx + bw + 32, by + 36, cnt, 4, n == 4 ? D_YELLOW : D_DIM);
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
static void d4_head(const char *name, const char *right, int page, int pages) {
  d_text(&UT_M, D_MARGIN, 8, name, d_fg);
  int rx = UI_W - D_MARGIN;
  if (pages > 1) {
    static char pg[12];
    snprintf(pg, sizeof pg, "%d/%d", page + 1, pages);
    d_text_r(&UT_SB, rx, 14, pg, d_fg);
    rx -= ut_w(&UT_SB, pg) + 20;
  }
  if (right && right[0]) d_text_r(&UT_XS, rx, 18, right, D_DIM);
  d_rule(D_MARGIN, D_HEAD + 6, UI_W - 2 * D_MARGIN);
}

/* ------------------------------------------------------------------ */
/* ROLL: four across, indexed, and mundane about it                    */

#define D4_TH_W D_COL_W
#define D4_TH_H (D4_TH_W * 3 / 4)

static void d4_roll(void) {
  d_ground(D_GRAPH);
  static char files[24];
  snprintf(files, sizeof files, "%d FILES", gallery_total());
  d4_head("ROLL", files, gallery_page(), gallery_pages());

  const gallery_item_t *slots = gallery_slots();
  for (int i = 0; i < GALLERY_PAGE; i++) {
    const int cx = d_col_x(i % 4), cy = D_HEAD + 24 + (i / 4) * (D4_TH_H + 40);
    const bool on = d4.sel == i;
    if (slots[i].state == TILE_READY && slots[i].pixels) {
      img_blit_tf(slots[i].pixels, GALLERY_TILE_W, GALLERY_TILE_H, 0.f, 0.f, 1.f, 1.f,
                  (float)(cx + D4_TH_W / 2), (float)(cy + D4_TH_H / 2), (float)D4_TH_W, (float)D4_TH_H,
                  0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
    } else if (slots[i].state != TILE_EMPTY) {
      fill(cx, cy, D4_TH_W, D4_TH_H, d_toward(d_bg, D_PAPER, 20));
      d_text_c(&UT_XS, cx + D4_TH_W / 2, cy + D4_TH_H / 2 - 8, "...", D_FAINT);
    } else {
      continue;
    }
    /* The index under the picture, and how many of the four it has. A
     * photograph missing a frame says so here and nowhere else. */
    static char idx[8], frames[8];
    snprintf(idx, sizeof idx, "%02d", gallery_page() * GALLERY_PAGE + i + 1);
    df_draw(cx, cy + D4_TH_H + 8, idx, 1, on ? d_fg : D_DIM);
    if (slots[i].frames < 4) {
      snprintf(frames, sizeof frames, "%d/4", slots[i].frames);
      df_draw_r(cx + D4_TH_W, cy + D4_TH_H + 8, frames, 1, D_YELLOW);
    }
    if (slots[i].favorite) d_mark(cx + D4_TH_W - 9, cy + 9, 5, D_MARK_ON, D_YELLOW);
    /* Selection is a frame, because the thing selected is a picture and ink
     * over it would hide the only useful part. */
    if (on) {
      for (int k = 1; k <= 3; k++) d_box(cx - k, cy - k, D4_TH_W + 2 * k, D4_TH_H + 2 * k, D_COBALT);
    }
  }

  /* The foot: the facts a camera prints under a page of files. */
  storage_status_t sd;
  storage_get_status(&sd);
  const int fy = UI_H - D4_STRIP;
  d_rule(D_MARGIN, fy - 8, UI_W - 2 * D_MARGIN);
  static char card[24];
  const int pct = sd.capacity_bytes ? (int)(100 - 100 * sd.free_bytes / sd.capacity_bytes) : 0;
  snprintf(card, sizeof card, "%d%%", pct);
  int fx2 = d_label(D_MARGIN, fy + 16, "CARD", D_DIM) + 8;
  df_draw(fx2, fy + 10, card, 1, d_fg);
  df_draw_r(UI_W - D_MARGIN, fy + 10, "09.15", 1, D_DIM);
}

/* ------------------------------------------------------------------ */
/* One from the roll: the photograph, and its facts                    */

static void d4_item(void) {
  d_ground(D_GRAPH);
  const gallery_item_t *slots = gallery_slots();
  const gallery_item_t *it = &slots[d4.sel < GALLERY_PAGE ? d4.sel : 0];
  if (it->pixels) {
    const float ch = (float)(UI_H - D4_STRIP) / (float)UI_W * ((float)GALLERY_TILE_W / (float)GALLERY_TILE_H);
    const float c0 = 0.5f - ch * 0.5f;
    img_blit_tf(it->pixels, GALLERY_TILE_W, GALLERY_TILE_H, 0.f, c0 > 0.f ? c0 : 0.f, 1.f,
                c0 > 0.f ? c0 + ch : 1.f, (float)(UI_W / 2), (float)((UI_H - D4_STRIP) / 2), (float)UI_W,
                (float)(UI_H - D4_STRIP), 0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
  }
  static char idx[8];
  snprintf(idx, sizeof idx, "%02d", gallery_page() * GALLERY_PAGE + d4.sel + 1);
  d_text_over(&UT_MB, D_MARGIN, D_MARGIN, idx, d_fg);
  d_text_over_r(&UT_XS, UI_W - D_MARGIN, D_MARGIN + 8, "09.15  18:42", d_fg);

  /* The facts, on the graphite strip rather than over the picture. */
  const int y = UI_H - D4_STRIP;
  fill(0, y, UI_W, D4_STRIP, D_GRAPH);
  static char mode[16];
  snprintf(mode, sizeof mode, "%s", it->mode[0] ? it->mode : "wiggle");
  for (char *c = mode; *c; c++)
    if (*c >= 'a' && *c <= 'z') *c = (char)(*c - 32); /* the interface speaks in capitals */
  int x = D_MARGIN;
  d_text(&UT_SB, x, y + 10, mode, d_fg);
  x += ut_w(&UT_SB, mode) + 24;
  d_mark_t m[4];
  for (int i = 0; i < 4; i++) m[i] = i < it->frames ? D_MARK_ON : D_MARK_EMPTY;
  d_four(x + 36, y + 14, 24, 5, m, false, NULL);
  d_text_r(&UT_XS, UI_W - D_MARGIN, y + 15, it->label[0] ? it->label : it->id, D_DIM);
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
  const uint16_t *t = viewfinder_ready() ? viewfinder_tile(1) : NULL;
  if (t) {
    const float ch = (float)(UI_H - D4_LOOK_STRIP) / (float)UI_W * ((float)VF_W / (float)VF_H);
    const float c0 = 0.5f - ch * 0.5f;
    img_blit_tf(t, VF_W, VF_H, 0.f, c0, 1.f, c0 + ch, (float)(UI_W / 2), (float)((UI_H - D4_LOOK_STRIP) / 2),
                (float)UI_W, (float)(UI_H - D4_LOOK_STRIP), 0.f, 0.f, 0.f, 0.f, 0.f, 0, 255, 0, 0.f);
  }
  const int n = kdp_recipes_count();
  const int y = UI_H - D4_LOOK_STRIP;
  fill(0, y, UI_W, D4_LOOK_STRIP, D_GRAPH);

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
  d_text_over_r(&UT_XS, UI_W - D_MARGIN, y - 28, count, D_PAPER);
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

  if (on && roll.guest_url[0]) {
    if (strcmp(s_d4_qr_url, roll.guest_url) != 0) {
      snprintf(s_d4_qr_url, sizeof s_d4_qr_url, "%s", roll.guest_url);
      s_d4_qr_ok = qr_encode(roll.guest_url, &s_d4_qr);
    }
    if (s_d4_qr_ok) d4_qr(UI_W - D_MARGIN - 300, D_HEAD + 30, 300);
  }

  const int x = D_MARGIN;
  int y = D_HEAD + 40;
  d_text(&UT_MB, x, y, online ? "LINK READY" : on ? "LINK OFF" : "NO ROLL", online ? D_COBALT : D_DIM);
  y += 52;
  if (on) {
    d_text(&UT_XS, x, y, "ROLL", D_DIM);
    d_text(&UT_SB, x + 80, y - 4, roll.name[0] ? roll.name : roll.slug, d_fg);
    y += 34;
    d_text(&UT_XS, x, y, "CODE", D_DIM);
    d_text(&UT_SB, x + 80, y - 4, roll.slug, d_fg);
    y += 34;
  }
  d_text(&UT_XS, x, y, "WLAN", D_DIM);
  d_text(&UT_SB, x + 80, y - 4, net.state == NET_IP_READY ? net.ssid : "-----", d_fg);
  y += 34;
  d_text(&UT_XS, x, y, "ADDR", D_DIM);
  d_text(&UT_SB, x + 80, y - 4, net.ip[0] ? net.ip : "-----", d_fg);

  /* What the camera knows. It does not know how many people are looking at
   * the gallery - the backend does - so it does not say "3 PEOPLE"; it says
   * how many photographs it has managed to send, which it counted itself. */
  y += 42;
  d_text(&UT_XS, x, y, "SENT", D_DIM);
  static char sent[32];
  snprintf(sent, sizeof sent, "%d", q.uploaded);
  d_text(&UT_SB, x + 80, y - 4, sent, d_fg);
}

/** A transfer in progress: blocks, a count, and nothing invented. */
static void d4_transfer(void) {
  upload_queue_report_t q;
  upload_queue_status(&q);
  const int waiting = q.pending + q.card_pending + q.uploading;
  const int total = q.burst_done + waiting;
  d4_link();
  const int y = UI_H - D4_STRIP - 44;
  fill(0, y - 12, UI_W, D4_STRIP + 56, D_GRAPH);
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
  const int top = D_HEAD + 20, rh = 42;
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
  const int x = UI_W - 13, y0 = D_HEAD + 30;
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
    df_draw_c(cx, D_HEAD + 26, N[i], 3, D_DIM);

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
    d_mark(cx, D_HEAD + 124, 16, m, ink);
    d_label_c(cx, D_HEAD + 156, word, ink);

    /* The mundane numbers underneath, which is what a diagnostics page is
     * for. Temperature is per module and the camera knows it. */
    static char t[12];
    snprintf(t, sizeof t, "%d^C", 31 + (i & 1));
    df_draw_c(cx, D_HEAD + 190, t, 1, D_DIM);
    if (i) fill(d_col_x(i) - D_GUT / 2, D_HEAD + 20, 1, 196, D_FAINT);
  }
  /* Underneath, the last photograph these four took, which is the only
   * measurement of them that matters: who answered, and how far apart the
   * commands went out. */
  d_tick_rule(D_MARGIN, D_HEAD + 218, UI_W - 2 * D_MARGIN, (UI_W - 2 * D_MARGIN) / 4, 5, D_FAINT);
  capture_report_t r;
  capture_last(&r);
#define D4_VAL_X (D_MARGIN + 250)
  d_label(D_MARGIN, D_HEAD + 238, "LAST PHOTOGRAPH", D_DIM);
  d_mark_t lm[4];
  uint16_t li[4];
  for (int i = 0; i < 4; i++) {
    const bool ok = r.cam[i].attempted && r.cam[i].ok;
    lm[i] = r.cam[i].attempted ? (ok ? D_MARK_ON : D_MARK_FAIL) : D_MARK_EMPTY;
    li[i] = ok ? d_fg : r.cam[i].attempted ? D_RED : D_DIM;
  }
  for (int i = 0; i < 4; i++) d_mark(D4_VAL_X + i * 26, D_HEAD + 243, 7, lm[i], li[i]);
  static char stored[24];
  snprintf(stored, sizeof stored, "%d/%d", r.stored, r.online ? r.online : 4);
  int sx2 = df_draw(D4_VAL_X + 130, D_HEAD + 237, stored, 1, d_fg) + 6;
  d_label(sx2, D_HEAD + 238, "STORED", D_DIM);

  static char sp[40];
  snprintf(sp, sizeof sp, "%u", (unsigned)r.spread_us);
  d_label(D_MARGIN, D_HEAD + 278, "COMMAND SPREAD", D_DIM);
  int vx = df_draw(D4_VAL_X, D_HEAD + 277, sp, 1, d_fg) + 6;
  d_label(vx, D_HEAD + 278, "US", D_DIM);
  d_label(D4_VAL_X + 130, D_HEAD + 278, "NOT EXPOSURE SKEW", D_FAINT);

  /* And what the finder is managing, which is the number that says a camera
   * is unwell before anything has failed outright. */
  d_label(D_MARGIN, D_HEAD + 318, "FINDER", D_DIM);
  static char fps[24];
  snprintf(fps, sizeof fps, "%d/4", live_now);
  vx = df_draw(D4_VAL_X, D_HEAD + 317, fps, 1, d_fg) + 6;
  d_label(vx, D_HEAD + 318, "LIVE", D_DIM);
}

/** Calibration: the same four, being brought into line, with real offsets. */
static void d4_cal(void) {
  d_ground(D_PAPER);
  d4_head("CALIBRATE", NULL, 0, 1);
  static const char *const N[4] = {"1", "2", "3", "4"};
  const int step = d4.sel; /* which camera is being done */
  for (int i = 0; i < 4; i++) {
    const int cx = d_col_cx(i);
    d_text_c(&UT_M, cx, D_HEAD + 30, N[i], D_DIM);
    const d_mark_t m = i < step ? D_MARK_ON : i == step ? D_MARK_BUSY : D_MARK_EMPTY;
    d_mark(cx, D_HEAD + 108, 16, m, i == step ? D_COBALT : d_fg);
    static char off[16];
    if (i < step) snprintf(off, sizeof off, "%+d,%+d", (i * 3) - 4, 2 - i);
    else snprintf(off, sizeof off, "--");
    d_text_c(&UT_SB, cx, D_HEAD + 140, off, i < step ? d_fg : D_DIM);
  }
  d_text_c(&UT_XS, UI_W / 2, D_HEAD + 190, "HOLD STILL", D_DIM);
  d_blocks(UI_W / 2 - D_BLOCKS_W / 2, D_HEAD + 220, step, 4, D_COBALT);
}

/* ------------------------------------------------------------------ */
/* The states that interrupt: charging, full, broken, and are you sure */

/** The flash charging, on the live view: a busy mark where the bolt was. */
static void d4_flash_charging(int pct) {
  d4_live();
  const int y = UI_H - D4_STRIP;
  fill(200, y, 190, D4_STRIP - 6, D_GRAPH);
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
  d_icon_s(&D_IC_WARN, cx - 24, D_HEAD + 26, 3, D_RED);
  const int shots = sd.capacity_bytes ? (int)(sd.free_bytes / (6ull * 1024 * 1024)) : 0;
  static char n[16];
  snprintf(n, sizeof n, "%d", shots);
  d_text_c(&UT_MB, cx, D_HEAD + 96, n, D_RED);
  d_text_c(&UT_S, cx, D_HEAD + 148, "SHOTS LEFT", d_fg);
  static char cap[48];
  human_bytes(cap, sizeof cap, sd.free_bytes);
  static char line[80];
  snprintf(line, sizeof line, "%s FREE", cap);
  d_text_c(&UT_XS, cx, D_HEAD + 190, line, D_DIM);
  d_text_c(&UT_XS, cx, D_HEAD + 222, "MOVE OR DELETE SOME", D_DIM);
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
  d_four(UI_W / 2, D_HEAD + 60, 116, 20, m, true, ink);
  static char line[64];
  snprintf(line, sizeof line, "CAMERA %d IS NOT ANSWERING", bad + 1);
  d_text_c(&UT_SB, UI_W / 2, D_HEAD + 140, line, D_RED);
  d_text_c(&UT_XS, UI_W / 2, D_HEAD + 182, "PHOTOGRAPHS WILL HAVE 3 OF 4", D_DIM);
  d_text_c(&UT_XS, UI_W / 2, D_HEAD + 210, "TURN OFF AND ON AGAIN TO RETRY", D_DIM);
}

/**
 * Are you sure. Paper, two choices, and the destructive one is on the right
 * in red - the side the thumb has to travel to, not the side it rests on.
 */
static void d4_confirm(void) {
  d_ground(D_PAPER);
  const int cx = UI_W / 2;
  d_text_c(&UT_MB, cx, 150, d4.confirm_q ? d4.confirm_q : "ARE YOU SURE", d_fg);
  d_text_c(&UT_XS, cx, 202, "THIS CANNOT BE UNDONE", D_DIM);
  /* Two choices, and the destructive one is on the right - the side the thumb
   * has to travel to, not the side it rests on. Whichever is under the cursor
   * is a block of ink; the other is an outline. Red only ever appears on the
   * one that cannot be undone. */
  const int by = 268, bw = 236, bh = 64, gap = 24;
  const bool yes = d4.sel == 1;
  const int lx = cx - gap / 2 - bw, rx = cx + gap / 2;
  if (yes) {
    d_box(lx, by, bw, bh, d_fg);
    d_select(rx, by, bw, bh, D_RED);
  } else {
    d_select(lx, by, bw, bh, D_COBALT);
    d_box(rx, by, bw, bh, D_RED);
  }
  d_text_c(&UT_S, lx + bw / 2, by + 19, "KEEP IT", yes ? d_fg : D_PAPER);
  d_text_c(&UT_S, rx + bw / 2, by + 19, d4.confirm_yes ? d4.confirm_yes : "DELETE",
           yes ? D_PAPER : D_RED);
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
