// The presentation: what KINO shows, built on the runtime.
//
// Included by ui.c after the camera-side plumbing (config, capture, gallery,
// photo, look and storage helpers) and before the hit tests and the loop. It
// owns every visible thing: the scene nodes each screen poses, the mode
// strip, the notes, the boot, and the bridge from camera events to behaviour
// (ui_event -> kb_event -> clips bound to nodes). Nothing here decides what
// the camera does; nothing in ui.c decides how anything looks.
//
// Screens are SYNC functions, not draw functions: each pass, the current
// screen acquires its nodes by id and sets their resting pose and content
// from state. Motion is never written here - it is the clips' (behaviors/
// kino.json), and continuity's. A screen that wants something to move
// starts a clip or reports an event.
#pragma once

/* ------------------------------------------------------------------ */
/* Names                                                               */

static const char *const MODE_NAME[MODE_COUNT] = {"SHOOT", "ROLL", "LOOK", "LINK", "SETUP"};
static const char *const SCREEN_NAME[SCR_COUNT] = {
    [SCR_MENU] = "", [SCR_SHOOT] = "SHOOT", [SCR_LOOK] = "LOOK", [SCR_GALLERY] = "ROLL",
    [SCR_PHOTO] = "PHOTO", [SCR_ROLL] = "LINK", [SCR_SETTINGS] = "SETUP", [SCR_DISPLAY] = "DISPLAY",
    [SCR_SOUND] = "SOUND", [SCR_CONNECTION] = "LINK", [SCR_STORAGE] = "CARD", [SCR_ABOUT] = "INFO",
    [SCR_POWER] = "POWER",
};

#define HDR_X 24
#define HDR_Y 14
#define HDR_GROUND C_GROUND
#define HDR_INK C_INK
#define HDR_DIM RGB(0x80, 0x88, 0x94)
#define C_FAINT RGB(0x50, 0x56, 0x60)
#define MO_FRAME_MS 16

/* Anything still moving this pass: instances, continuity, modifiers. */
static bool mo_any_live(void) { return s_kmo_live > 0; }
static void draw_screen(void);
static void sync_brand_leaving(void);

/*
 * A swipe is not a threshold that fires a canned transition. The world is
 * displaced by the finger as it travels, so at a fifth of the way across the
 * scene is already a fifth of the way into the next state, and a gesture
 * abandoned halfway simply comes back. On release the pose snaps to whichever
 * state was chosen and continuity absorbs the difference, carrying the
 * finger's own speed into the settle - which is why a flick and a drag do not
 * land the same way.
 */
#define DRAG_FULL 220.f   /* px of travel that is a whole state change */
#define HDR_TRAVEL 170.f  /* how far the mode's word travels across a change */
static float s_drag_dx;   /* the live displacement, 0 when nothing is dragging */
static int s_drag_dir;    /* which way the world would go if released now */

/** -1..1: how far the world has been taken toward the next state. */
static float drag_u(void) {
  float u = s_drag_dx / DRAG_FULL;
  if (u < -1.f) u = -1.f;
  if (u > 1.f) u = 1.f;
  return u;
}

#define SH_SHOW_FIRST_MS 2600
#define SH_SHOW_MS 1600
static int s_sh_show_ms = SH_SHOW_FIRST_MS;

/* ------------------------------------------------------------------ */
/* Sound is a channel                                                  */

static void kmo_sound_cb(int cue) {
  switch (cue) {
    case KS_SYNC: audio_sync(); break;
    case KS_DONE: audio_done(); break;
    case KS_TICK: if (config_bool("body.sounds.ui", true)) audio_tick(); break;
    case KS_SHUTTER: audio_shutter(); break;
    case KS_WARN: audio_warning(); break;
    default: break;
  }
}

/* ------------------------------------------------------------------ */
/* Shared objects                                                      */

static ks_node_t *nd(const char *id, int kind) { return ks_get(id, kind); }

/* Text at a point with an anchor, in a face and ink; the common pose. */
static ks_node_t *nd_text(const char *id, const char *s, const ut_face_t *f, uint16_t ink, float x, float y, float ax,
                          float ay, int z, bool shadow) {
  ks_node_t *n = nd(id, KS_TEXT);
  ks_text(n, s, f, ink);
  ks_place(n, x, y, ax, ay);
  n->z = (int16_t)z;
  n->shadow = shadow;
  return n;
}

/* The same, but a node that already has a word keeps it: for the label
 * nodes an event writes into (the note, the capture's word). */
static ks_node_t *nd_label(const char *id, const ut_face_t *f, uint16_t ink, float x, float y, float ax, float ay,
                           int z, bool shadow) {
  ks_node_t *n = nd(id, KS_TEXT);
  const char *keep = n->text ? n->text : "";
  ks_text(n, keep, f, ink);
  ks_place(n, x, y, ax, ay);
  n->z = (int16_t)z;
  n->shadow = shadow;
  return n;
}

static ks_node_t *nd_disc(const char *id, float x, float y, float r, uint16_t ink, int z) {
  ks_node_t *n = nd(id, KS_DISC);
  ks_place(n, x, y, 0.5f, 0.5f);
  ks_pose(n, KC_R, r);
  n->ink = ink;
  n->z = (int16_t)z;
  return n;
}

static ks_node_t *nd_rect(const char *id, float x, float y, float w, float h, uint16_t ink, int z) {
  ks_node_t *n = nd(id, KS_RECT);
  ks_place(n, x, y, 0.f, 0.f);
  n->w = w;
  n->h = h;
  n->ink = ink;
  n->z = (int16_t)z;
  return n;
}

/* ------------------------------------------------------------------ */
/* Events -> behaviour -> nodes                                        */

static uint32_t s_session_shots;
static int64_t s_idle_before_us; /* how long the panel was dark before the last wake */
static bool s_first_boot;
static char s_cap_fail_why[64];
static int s_live_cams = -1;      /* what the finder counted live on its last sync */
static bool s_visited[SCR_COUNT]; /* screens seen this boot: the finder's words stay longer the first time */

/* Where an event's roles land depends on where the camera is. Capture words
 * go to the centre of the finder; everything else is said in the corner. */
static ks_node_t *role_node(const char *role, int ev) {
  const bool cap = ev == KEV_CAPTURE_SUCCESS || ev == KEV_CAPTURE_FAIL || ev == KEV_CAPTURE_PARTIAL;
  if (strcmp(role, "label") == 0) return cap ? ks_peek("cap.label") : ks_peek("note");
  if (strcmp(role, "sub") == 0) return ks_peek("cap.sub");
  if (strcmp(role, "big") == 0) return ks_peek("cap.big");
  if (strcmp(role, "black") == 0) return ks_peek("cap.black");
  if (strcmp(role, "white") == 0) return ks_peek("cap.white");
  if (strcmp(role, "result") == 0 || strcmp(role, "finder") == 0) return ks_peek("finder");
  if (strcmp(role, "image") == 0) {
    /* The look's transitions act on whichever live view is filling the
     * screen, because that IS the picture being graded. */
    static const char *const PANE[4] = {"pane0", "pane1", "pane2", "pane3"};
    const char *v = config_str("shoot.viewfinder", "cam2");
    const int cam = (v[3] >= '1' && v[3] <= '4') ? v[3] - '1' : 1;
    return ks_peek(PANE[cam]);
  }
  if (strcmp(role, "line") == 0) return ks_peek("words");
  if (role[0] == 'f' && role[2] == 0) { static const char *const P[4] = {"pane0", "pane1", "pane2", "pane3"}; return ks_peek(P[role[1] - '0']); }
  if (role[0] == 'g' && role[2] == 0) { static const char *const P[4] = {"frag0", "frag1", "frag2", "frag3"}; return ks_peek(P[role[1] - '0']); }
  if (role[0] == 'm' && role[2] == 0) {
    static const char *const F[4] = {"m0", "m1", "m2", "m3"};
    static const char *const NM[4] = {"note.m0", "note.m1", "note.m2", "note.m3"};
    return s_screen == SCR_SHOOT ? ks_peek(F[role[1] - '0']) : ks_peek(NM[role[1] - '0']);
  }
  return NULL;
}

static kb_ctx_t ui_ctx(void) {
  kb_ctx_t c;
  c.shots_session = (int)s_session_shots;
  c.flash_on = flash_index() != 2;
  c.quad = mode_is_quad();
  c.sync_ok = 0;
  c.idle_s = (int)(s_idle_before_us / 1000000);
  c.hour = clock_local_hour();
  c.first_boot = s_first_boot;
  /* Mood, as bands a variant can ask for. */
  c.energy = (int)(s_kmood.energy * 100.f);
  c.calm = (int)(s_kmood.calm * 100.f);
  c.confidence = (int)(s_kmood.confidence * 100.f);
  c.strain = (int)(s_kmood.strain * 100.f);
  c.burst = s_kmood.recent_shots;
  /* What the cameras see. */
  c.lum = s_ksense.live ? (int)(s_ksense.lum_mean * 100.f) : -1;
  c.motion = s_ksense.live ? (int)(s_ksense.motion_mean * 100.f) : 0;
  c.framing_ms = 0;
  c.sync_spread_ms = -1;
  return c;
}

/**
 * Report that something happened. The controller picks a behaviour (or
 * nothing), the clip's roles are bound to the nodes that exist for this
 * screen, its text lands on the label, and it runs.
 */
/** Run `clip` as the answer to `ev`, its text on the label: the binding half of ui_event. */
static void ui_run_clip(int ev, int clip, const char *text) {
  const int64_t now = esp_timer_get_time();
  const kmo_clip_t *c = &KMO_CLIPS[clip];
  ks_node_t *nodes[KMO_MAX_BIND];
  const char *roles[KMO_MAX_BIND];
  int n = 0;
  /* Every role the clip's tracks and mods name, once. */
  for (int ti = 0; ti < c->ntracks + c->nmods && n < KMO_MAX_BIND; ti++) {
    const int r = ti < c->ntracks ? KMO_TRACKS[c->track0 + ti].role : KMO_MODS[c->mod0 + (ti - c->ntracks)].role;
    const char *name = KMO_ROLES[r];
    bool seen = false;
    for (int k = 0; k < n; k++) if (roles[k] == name) seen = true;
    if (seen) continue;
    ks_node_t *node = role_node(name, ev);
    if (!node) continue;
    roles[n] = name;
    nodes[n] = node;
    n++;
  }
  for (int k = 0; k < n; k++) {
    if (strcmp(roles[k], "label") == 0 && text) {
      ks_text(nodes[k], text, nodes[k]->face, nodes[k]->ink);
      /* CONNECTED-style words come in one letter at a time. */
      if (clip == KCLIP_LINK_CONNECTED) ks_text_stagger(nodes[k], KCLIP_NOTE_CHAR, 38, now);
      else nodes[k]->char_clip = -1;
    }
    if (strcmp(roles[k], "big") == 0) { nodes[k]->text = "100"; nodes[k]->w = (float)ut_w(nodes[k]->face, "100"); }
  }
  ks_stop_tag(KMO_EVENT_NAMES[ev]);
  ks_play(clip, KMO_EVENT_NAMES[ev], NULL, nodes, roles, n);
}

/**
 * Report that something happened. The controller picks a behaviour (or
 * nothing), the clip's roles are bound to the nodes that exist for this
 * screen, its text lands on the label, and it runs.
 */
/* What the word standing in the corner is about, so that a fact which stops
 * being true can take its own word down rather than leaving it to time out. */
static int s_note_ev = -1;

static void ui_event_ctx(int ev, const kb_ctx_t *ctx) {
  const kb_pick_t p = kb_event(ev, ctx, esp_timer_get_time());
  if (p.variant < 0) return;
  if (p.text) s_note_ev = ev;
  ui_run_clip(ev, p.clip, p.text);
}

/**
 * Retire the standing word if it was about `ev`, whose news is now stale.
 *
 * Stopping the clip is the whole of it: sync_note() poses the word's alpha
 * from whether anything is still driving it, so a word nothing is saying any
 * more is not on screen.
 */
static void ui_note_retire(int ev) {
  if (s_note_ev != ev) return;
  s_note_ev = -1;
  ks_stop_tag(KMO_EVENT_NAMES[ev]);
}
static void ui_event(int ev) {
  const kb_ctx_t c = ui_ctx();
  ui_event_ctx(ev, &c);
}

/** A plain remark in the corner, outside the behaviour tables: for the few
 * things ui.c says directly (a refusal, a fact). */
static void ui_note(const char *text) {
  ks_node_t *n = ks_peek("note");
  if (!n) return;
  s_note_ev = -1; /* the corner is about something else now */
  n->text = text;
  n->w = (float)ut_w(n->face, text);
  n->char_clip = -1;
  ks_stop_tag("note");
  ks_play1(KCLIP_NOTE_PLAIN, "note", n, "label", NULL);
}
static void toast(const char *s) { ui_note(s); }

/* ------------------------------------------------------------------ */
/* The corner note and its four marks (always present, mostly at alpha 0) */

static void sync_note(bool over_picture) {
  ks_node_t *n = nd_label("note", &UT_MB, C_INK, UI_W - 24.f, HDR_Y, 1.f, 0.f, 80, over_picture);
  if (!ks_bound(n)) ks_pose(n, KC_ALPHA, 0.f); else ks_pose(n, KC_ALPHA, 255.f);
  n->ink = C_INK;
  for (int i = 0; i < 4; i++) {
    static const char *const ID[4] = {"note.m0", "note.m1", "note.m2", "note.m3"};
    ks_node_t *m = nd_disc(ID[i], UI_W - 24.f - 3 * 22.f + i * 22.f, HDR_Y + UT_MB.em * 0.5f + 48.f, 6.f, C_COBALT, 80);
    ks_pose(m, KC_ALPHA, ks_bound(m) ? 255.f : 0.f);
  }
}

/* ------------------------------------------------------------------ */
/* The title and the mode strip                                        */

static bool s_row_open;
#define MROW_Y HEAD_H
#define MROW_H 72
static int row_col_x(int i) { return HDR_X + i * ((UI_W - 2 * HDR_X) / MODE_COUNT); }
static int row_hit(int x, int y) {
  if (!s_row_open || y < MROW_Y || y >= MROW_Y + MROW_H) return -1;
  const int cw = (UI_W - 2 * HDR_X) / MODE_COUNT;
  for (int i = 0; i < MODE_COUNT; i++)
    if (x >= row_col_x(i) - 8 && x < row_col_x(i) + cw) return i;
  return -1;
}

static const char *const STRIP_ROLE[MODE_COUNT] = {"n0", "n1", "n2", "n3", "n4"};
static const char *const STRIP_ID[MODE_COUNT] = {"strip.n0", "strip.n1", "strip.n2", "strip.n3", "strip.n4"};

static void row_open(int64_t now_us) {
  (void)now_us;
  s_row_open = true;
  ks_node_t *ns[MODE_COUNT];
  for (int i = 0; i < MODE_COUNT; i++) ns[i] = nd(STRIP_ID[i], KS_TEXT);
  ks_stop_tag("strip");
  ks_play(KCLIP_STRIP_OPEN, "strip", NULL, ns, STRIP_ROLE, MODE_COUNT);
}
static void row_close(void) {
  if (!s_row_open) return;
  s_row_open = false;
  ks_node_t *ns[MODE_COUNT];
  for (int i = 0; i < MODE_COUNT; i++) ns[i] = ks_peek(STRIP_ID[i]);
  ks_stop_tag("strip");
  ks_play(KCLIP_STRIP_CLOSE, "strip", NULL, ns, STRIP_ROLE, MODE_COUNT);
}

/** The title: the mode's word on a home, the child's word after an up-mark. */
static void sync_title(bool over_picture, ks_node_t *parent) {
  const kmode_t m = mode_of(s_screen);
  const bool home = MODES[m].home == s_screen;
  /* The word leads the finger and travels further than the picture does. */
  const float lead = home ? drag_u() * HDR_TRAVEL : 0.f;
  ks_node_t *t = nd_text("title", home ? MODE_NAME[m] : SCREEN_NAME[s_screen], &UT_MB, C_INK,
                         (home ? (float)HDR_X : (float)HDR_X + 44.f) + lead, (float)HDR_Y, 0.f, 0.f, 70, over_picture);
  ks_parent(t, parent);
  ks_pose(t, KC_ALPHA, 255.f);
  if (!home) {
    ks_node_t *b = nd_text("title.back", "←", &UT_M, HDR_DIM, (float)HDR_X, (float)HDR_Y, 0.f, 0.f, 70, over_picture);
    ks_parent(b, parent);
  }
  /* The strip, when open (or leaving). */
  if (s_row_open || ks_playing_tag("strip")) {
    ks_node_t *plate = nd_rect("strip.plate", 0.f, (float)MROW_Y, (float)UI_W, (float)MROW_H, HDR_GROUND, 60);
    ks_pose(plate, KC_ALPHA, s_row_open ? 255.f : 0.f);
    for (int i = 0; i < MODE_COUNT; i++) {
      ks_node_t *n = nd_text(STRIP_ID[i], MODE_NAME[i], &UT_MB, i == (int)m ? C_INK : HDR_DIM, (float)row_col_x(i),
                             (float)MROW_Y + 18.f, 0.f, 0.f, 61, false);
      ks_pose(n, KC_ALPHA, s_row_open ? 255.f : 0.f);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Navigation: the finger moves the world, and the release finishes it  */

static void sh_reveal(void);
static void look_show_id(void);

/** Move to a screen. A cut: the words that move carry the change. */
/* Set when LINK's code has played its entry this visit; cleared on leaving. */
static bool s_qr_opened;

static void go(screen_t s, int dissolve_ms) {
  (void)dissolve_ms;
  if (s == SCR_GALLERY) gallery_refresh();
  if (s_screen == SCR_PHOTO && s != SCR_PHOTO) photo_release();
  /* A clip still running holds its nodes on screen wherever the camera goes
   * next, because a bound node is drawn whether or not the screen asked for
   * it. What belonged to the state being left is stopped with it. */
  if (s_screen == SCR_LOOK && s != SCR_LOOK) {
    ks_stop_tag("lookid");
    ks_stop_tag("look_change");
  }
  /* The code opens once a visit, not once a pass. LINK is reachable under
   * two screen ids and they are the same place to the user. */
  if (s != SCR_CONNECTION && s != SCR_ROLL) s_qr_opened = false;
  const bool first = !s_visited[s];
  s_visited[s] = true;
  s_screen = s;
  s_pressed = -1;
  if (s == SCR_SHOOT) { s_sh_show_ms = first ? SH_SHOW_FIRST_MS : SH_SHOW_MS; }
  draw_screen();
  if (s == SCR_SHOOT) sh_reveal();
  if (s == SCR_LOOK) look_show_id();
  draw_screen();
  gfx_present();
}

/**
 * Move to another mode. `vel` is the finger's speed at release in px/ms, 0
 * when nothing was dragged.
 *
 * A mode change the finger already performed does not play the canned clip:
 * the world is where the gesture left it, the pose becomes the new state's,
 * and continuity carries it the rest of the way with the release velocity
 * pushed into it. A mode change from a tap has no such momentum to inherit,
 * so it gets the authored move instead.
 */
static void mode_go_vel(kmode_t to, int dir, float vel) {
  const kmode_t from = mode_of(s_screen);
  if (to == from) return;
  ks_node_t *t = ks_peek("title");
  if (vel == 0.f) {
    /* The word that leaves is a second object with the old name; the title
     * itself becomes the new word and arrives with momentum. Interrupting
     * this mid-flight retargets both through continuity. */
    ks_node_t *out = nd_text("title.out", MODE_NAME[from], &UT_MB, C_INK, (float)HDR_X, (float)HDR_Y, 0.f, 0.f, 70,
                             to == MODE_SHOOT || from == MODE_SHOOT);
    ks_snap(out);
    ks_node_t *ns[2] = {t, out};
    const char *rs[2] = {"title", "out"};
    const float params[4] = {(float)dir, 0, 0, 0};
    ks_stop_tag("mode");
    ks_play(KCLIP_MODE_MOVE, "mode", params, ns, rs, 2);
  } else {
    /* Whatever the canned move was doing, the finger has superseded it. */
    ks_stop_tag("mode");
    if (t) ks_impulse(t, KC_X, -vel * 0.9f);
    ks_node_t *g = ks_peek("finder");
    if (g) ks_impulse(g, KC_X, -vel * 0.35f);
    ks_node_t *gr = ks_peek("grid");
    if (gr) ks_impulse(gr, KC_X, -vel * 0.45f);
  }
  go(MODES[to].home, 0);
}

static void mode_go(kmode_t to, int dir) { mode_go_vel(to, dir, 0.f); }

/** One step along the row of modes; `vel` is the finger's speed, 0 for a tap. */
static void mode_swipe_vel(int dir, float vel) {
  const int cur = (int)mode_of(s_screen);
  const int next = cur + dir;
  if (next < 0 || next >= MODE_COUNT) return;
  mode_go_vel((kmode_t)next, dir, vel);
}

/* ------------------------------------------------------------------ */
/* SHOOT                                                               */

#define SH_IT_MODE 1
#define SH_IT_FLASH 2
static int s_sh_mode_x0, s_sh_mode_x1, s_sh_flash_x0, s_sh_flash_x1;
static const char *const FLASH_WORD[3] = {"FLASH AUTO", "FLASH ON", "FLASH OFF"};

/* The finder's words show themselves when there is a reason and let go. */
static int64_t s_sh_reveal_us;
static bool s_sh_words_up;

static void sh_reveal(void) {
  s_sh_reveal_us = esp_timer_get_time();
  ks_node_t *w = ks_peek("words");
  if (!w) return;
  if (!s_sh_words_up || !ks_playing_tag("words")) {
    ks_stop_tag("words");
    ks_play1(KCLIP_WORDS_SHOW, "words", w, "line", NULL);
  }
  s_sh_words_up = true;
}

static bool sh_words_showing(void) { return s_sh_words_up; }

static const char *shoot_look_word(char *buf, size_t cap) {
  char num[16], jp[LOOK_TEXT_MAX + 4], en[LOOK_TEXT_MAX + 4];
  fl_current(num, sizeof num, jp, sizeof jp, en, sizeof en, NULL, 0);
  snprintf(buf, cap, "%s %s", num, en);
  return buf;
}

/*
 * The four live views, as one object.
 *
 * This is the product's fundamental visual body, and it is the same four
 * nodes in every state that shows it. In SHOOT they are the four quarters of
 * the screen. In LOOK one of them fills the screen and the other three
 * collapse behind it. Nothing is destroyed and nothing is built: the surface
 * changes shape and continuity carries it, which is why the four cameras are
 * seen to BECOME the photograph rather than being replaced by it.
 *
 * `dominant` is -1 for the quad, the camera that fills the screen, or
 * KSURF_RULE: the four flattened side by side into a rule a few pixels tall.
 * That is how SETUP strips the photographic world away without throwing it
 * out - the pictures leave, and what is left to organise the settings is made
 * of them, the colour of the room the camera is actually in.
 *
 * Returns how many answered, and fills `has` with which.
 */
#define KSURF_RULE (-2)
#define KSURF_RULE_W (UI_W - 48)   /* the rows' own margin, NR_X, defined further down */
#define KSURF_RULE_H 3.f
static int sync_camera_surface(ks_node_t *g, int dominant, bool has[4]) {
  /* While the capture is running the panes leave a trace of where they were.
   * The four frames arrive out of place and correct, and the trace is what
   * makes that read as one surface being assembled rather than as four
   * rectangles twitching. */
  const uint8_t trace = ks_playing_tag("cap") ? 2 : 0;
  /* Which cameras were answering last pass. A camera that starts answering is
   * a real event - the first frame off a sensor that was asleep or busy - and
   * the surface it belongs to arrives on it rather than on a clock. Waking
   * needs no special case for this: the panel goes dark, the cameras stop, so
   * every one of them is news again when the camera is picked up. */
  static bool ks_had[4];
  static const char *const PANE[4] = {"pane0", "pane1", "pane2", "pane3"};
  static const char *const PLATE[4] = {"pane0.plate", "pane1.plate", "pane2.plate", "pane3.plate"};
  static const char *const NUM[4] = {"pane0.n", "pane1.n", "pane2.n", "pane3.n"};
  static const char *const WHY[4] = {"pane0.why", "pane1.why", "pane2.why", "pane3.why"};
  static const char *const DIGIT[4] = {"1", "2", "3", "4"};
  int live = 0;
  for (int i = 0; i < 4; i++) {
    /* Where this pane sits and how big it is, in the surface's own space. */
    const bool lead = dominant >= 0 && i == dominant;
    const bool rule = dominant == KSURF_RULE;
    const float qx = (i % 2 ? 1.f : -1.f) * SH_PANE_W * 0.5f, qy = (i / 2 ? 1.f : -1.f) * SH_PANE_H * 0.5f;
    /* Four abreast in reading order when they are a rule; the quad's own
     * order otherwise. */
    const float rx = ((float)i - 1.5f) * (KSURF_RULE_W * 0.25f);
    const float cx = rule ? rx : (dominant < 0 ? qx : (lead ? 0.f : qx));
    const float cy = rule ? 0.f : (dominant < 0 ? qy : (lead ? 0.f : qy));
    /* The box never changes; the scale does, so the growth is animatable. */
    const float sc = dominant < 0 && !rule ? 1.f : (lead ? 2.f : 0.08f);
    const float scx = rule ? (KSURF_RULE_W * 0.25f) / (float)SH_PANE_W : sc;
    const float scy = rule ? KSURF_RULE_H / (float)SH_PANE_H : sc;
    const float alpha = rule || dominant < 0 || lead ? 255.f : 0.f;

    const uint16_t *tile = viewfinder_ready() ? viewfinder_tile(i) : NULL;
    vf_status_t st = {0};
    if (viewfinder_ready()) viewfinder_status(i, &st);
    if (tile) {
      ks_node_t *p = nd(PANE[i], KS_IMAGE);
      ks_image(p, tile, VF_W, VF_H, (float)SH_PANE_W, (float)SH_PANE_H);
      ks_pose(p, KC_CY0, (float)SH_CROP / VF_H);
      ks_pose(p, KC_CY1, (float)(VF_H - SH_CROP) / VF_H);
      ks_place(p, cx, cy, 0.5f, 0.5f);
      ks_pose(p, KC_SX, scx);
      ks_pose(p, KC_SY, scy);
      ks_pose(p, KC_ALPHA, alpha);
      ks_parent(p, g);
      p->ghost = trace;
      p->z = (int16_t)(lead ? 2 : 1);
      /* This camera has just started answering: the surface springs up into
       * its place rather than being there already. After a sleep the four do
       * this a few tens of milliseconds apart, which is the world coming back
       * in the order the hardware actually comes back. */
      if (!ks_had[i]) {
        ks_impulse(p, KC_SX, -2.4f);
        ks_impulse(p, KC_SY, -2.4f);
      }
      live++;
      has[i] = true;
      continue;
    }
    has[i] = false;
    if (dominant >= 0 && !lead) continue; /* a dark quarter has nothing to say here */
    ks_node_t *pl = nd_rect(PLATE[i], cx, cy, (float)SH_PANE_W, (float)SH_PANE_H,
                            rule ? RGB(0x2a, 0x30, 0x38) : C_GROUND, 1);
    ks_place(pl, cx, cy, 0.5f, 0.5f);
    ks_pose(pl, KC_SX, scx);
    ks_pose(pl, KC_SY, scy);
    ks_parent(pl, g);
    /* This camera has just stopped answering. The quarter does not fade
     * politely: the picture falls out of it, which is what happened. */
    if (ks_had[i] && !rule) ks_impulse(pl, KC_SY, -1.9f);
    if (rule) continue; /* a rule says which camera is dark by being dark there */
    const char *why = st.state == VF_ERROR ? "NO PICTURE" : st.state == VF_STALLED ? "NO RECENT FRAME" : "NO CAMERA";
    ks_node_t *n = nd_text(NUM[i], DIGIT[i], &UT_M, RGB(0x3a, 0x42, 0x4c), cx, cy - 30.f * sc, 0.5f, 0.5f, 2, false);
    ks_parent(n, g);
    ks_node_t *w = nd_text(WHY[i], why, &UT_S, RGB(0x3a, 0x42, 0x4c), cx, cy + 12.f * sc, 0.5f, 0.5f, 2, false);
    ks_parent(w, g);
  }
  for (int i = 0; i < 4; i++) ks_had[i] = has[i];
  return live;
}


#define G_TILE_W GALLERY_TILE_W
#define G_TILE_H GALLERY_TILE_H

/**
 * A photograph's name in the scene. Named after the capture rather than the
 * slot it happens to occupy, so the same picture is the same object in the
 * roll, on its own screen, and on the way between them.
 */
static const char *photo_node_id(char *buf, size_t cap, const char *label, const char *id) {
  /* The label when there is one, because it is short and readable on the
   * bench; the capture's own id otherwise, cut to fit. Cutting is deliberate
   * and safe here: the name only has to tell six tiles and one open
   * photograph apart, and captures differ well inside the first few
   * characters. Written as a bounded copy rather than an snprintf of a longer
   * string so that the truncation is the stated intent. */
  const char *src = (label && label[0]) ? label : (id ? id : "");
  size_t n = 0;
  if (cap >= 4) {
    buf[0] = 'p'; buf[1] = 'h'; buf[2] = ':';
    n = 3;
    while (src[n - 3] && n < cap - 1) { buf[n] = src[n - 3]; n++; }
  }
  buf[n] = 0;
  return buf;
}

/* ------------------------------------------------------------------ */
/* The latest photograph                                               */
/*
 * A photograph does not stop existing when the shutter sequence ends. For a
 * few seconds after a capture the thing that was just made is still in the
 * hand: it stays in the corner of the finder, and opening the roll in that
 * window carries that same object into the first tile rather than drawing a
 * new one there.
 *
 * The card has the real picture; the decode has not happened yet and will not
 * until the roll is opened. So the object is born from what actually made it,
 * which is the four live views, assembled the way the thumbnail will be. When
 * the real thumbnail does arrive the pixels are swapped under the node with
 * ks_image_lod - same subject, sharper - and nothing moves.
 */
#define LATEST_HOLD_MS 5200   /* still in the hand this long */
#define LATEST_FADE_MS 700    /* the last of it */
#define LATEST_X 86.f
#define LATEST_Y (UI_H - 104.f)   /* clear of the settings row along the bottom */
#define LATEST_SCALE 0.42f

static uint16_t *s_latest_px;
static char s_latest_id[KS_ID_MAX];
static int64_t s_latest_us;
static bool s_latest_born;

/** Nearest-neighbour copy of one viewfinder tile into a box of the buffer. */
static void latest_blit(const uint16_t *src, int dx, int dy, int dw, int dh) {
  if (!src) return;
  /* The finder crops the tile top and bottom; the photograph is the same
   * framing, so the copy reads the same rows. */
  const int sy0 = SH_CROP, sh = VF_H - 2 * SH_CROP;
  for (int y = 0; y < dh; y++) {
    const uint16_t *row = src + (size_t)(sy0 + y * sh / dh) * VF_W;
    uint16_t *out = s_latest_px + (size_t)(dy + y) * G_TILE_W + dx;
    for (int x = 0; x < dw; x++) out[x] = row[x * VF_W / dw];
  }
}

/**
 * Freeze what the cameras are looking at into the latest photograph.
 *
 * Four frames stored means the picture is the four of them, so the placeholder
 * is the same 2x2 the tile will be. Fewer, and it is the one view that led.
 * Returns false when there is nothing to freeze, and then no object is born:
 * an invented photograph would be worse than none.
 */
static bool latest_build(const char *label, const char *uuid, int stored, int dominant) {
  if (!viewfinder_ready()) return false;
  if (s_latest_px == NULL) {
    s_latest_px = heap_caps_malloc((size_t)G_TILE_W * G_TILE_H * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_latest_px == NULL) s_latest_px = malloc((size_t)G_TILE_W * G_TILE_H * 2);
    if (s_latest_px == NULL) return false;
  }
  memset(s_latest_px, 0, (size_t)G_TILE_W * G_TILE_H * 2);
  bool any = false;
  if (stored >= 4) {
    const int hw = G_TILE_W / 2, hh = G_TILE_H / 2;
    for (int i = 0; i < 4; i++) {
      const uint16_t *t = viewfinder_tile(i);
      if (!t) continue;
      latest_blit(t, (i % 2) * hw, (i / 2) * hh, hw, hh);
      any = true;
    }
  } else {
    const int cam = dominant >= 0 && dominant < 4 ? dominant : 0;
    const uint16_t *t = viewfinder_tile(cam);
    if (t) { latest_blit(t, 0, 0, G_TILE_W, G_TILE_H); any = true; }
  }
  if (!any) return false;
  photo_node_id(s_latest_id, sizeof s_latest_id, label, uuid);
  s_latest_us = esp_timer_get_time();
  s_latest_born = false;
  return true;
}

/** How much of the latest photograph is still there, 0..255. */
static float latest_alpha(int64_t now) {
  if (s_latest_id[0] == 0) return 0.f;
  const int ms = (int)((now - s_latest_us) / 1000);
  if (ms >= LATEST_HOLD_MS) return 0.f;
  const int left = LATEST_HOLD_MS - ms;
  return left >= LATEST_FADE_MS ? 255.f : 255.f * (float)left / (float)LATEST_FADE_MS;
}

/**
 * Hold the latest photograph in the corner of whatever the camera is showing.
 *
 * It is born where it was made - the size and place of the capture result,
 * which is the whole screen - and from the next pass on it is posed small and
 * to the side. Nothing animates it: the join between those two poses is the
 * animation, and it is the same join that carries the object on into the roll
 * if the user opens it before the picture has finished settling.
 */
static void sync_latest(void) {
  if (s_latest_id[0] == 0) return;
  const int64_t now = esp_timer_get_time();
  const float a = latest_alpha(now);
  if (a <= 0.f) { s_latest_id[0] = 0; return; }
  ks_node_t *n = nd(s_latest_id, KS_IMAGE);
  ks_image_lod(n, s_latest_px, G_TILE_W, G_TILE_H, (float)G_TILE_W, (float)G_TILE_H);
  if (!s_latest_born) {
    /* One pass at the size of the thing that was on screen a moment ago. */
    s_latest_born = true;
    ks_snap(n);
    ks_place(n, UI_W * 0.5f, UI_H * 0.5f, 0.5f, 0.5f);
    ks_pose(n, KC_SX, (float)UI_W / (float)G_TILE_W);
    ks_pose(n, KC_SY, (float)UI_W / (float)G_TILE_W);
    ks_pose(n, KC_ALPHA, 255.f);
    /* A print does not land square. */
    ks_impulse(n, KC_ROT, -5.f);
  } else {
    ks_place(n, LATEST_X, LATEST_Y, 0.5f, 0.5f);
    ks_pose(n, KC_SX, LATEST_SCALE);
    ks_pose(n, KC_SY, LATEST_SCALE);
    ks_pose(n, KC_ALPHA, a);
  }
  /* Above the four views it was made from, below the words about it. */
  n->z = 46;
  s_kmo_live++; /* it is on its way somewhere */
}

static void sync_shoot(void) {
  const int64_t now = esp_timer_get_time();
  /* The picture: four panes as children of one group centred on the screen,
   * so the group's scale and rotation - the result landing - act about the
   * centre and the panes inherit them. */
  ks_node_t *g = nd("finder", KS_GROUP);
  /* The picture follows the finger at a fraction of it: the world moves, but
   * the thing you are looking through moves least. */
  ks_place(g, UI_W * 0.5f + drag_u() * 90.f, UI_H * 0.5f, 0.f, 0.f);
  g->z = 0;
  int live = 0;
  bool has[4] = {false, false, false, false};
  live = sync_camera_surface(g, -1, has);
  s_live_cams = live;

  /* The words: title and reading line in one group the clips fade. */
  ks_node_t *words = nd("words", KS_GROUP);
  ks_place(words, 0.f, 0.f, 0.f, 0.f);
  if (!ks_bound(words) && !s_sh_words_up) ks_pose(words, KC_ALPHA, 0.f);
  else if (!ks_bound(words)) ks_pose(words, KC_ALPHA, s_sh_words_up ? 255.f : 0.f);
  sync_title(true, words);
  if (s_sh_words_up && s_sh_reveal_us && (now - s_sh_reveal_us) / 1000 > s_sh_show_ms) {
    s_sh_words_up = false;
    ks_stop_tag("words");
    ks_play1(KCLIP_WORDS_HIDE, "words", words, "line", NULL);
  }
  {
    static char line[LOOK_TEXT_MAX + 64];
    static char look[LOOK_TEXT_MAX + 24];
    shoot_look_word(look, sizeof look);
    const char *mode_w = mode_is_quad() ? "QUAD" : "WIGGLE";
    const char *flash_w = FLASH_WORD[flash_index()];
    snprintf(line, sizeof line, "%s   %s   %s", mode_w, look, flash_w);
    const float top = UI_H - 24.f - UT_M.em;
    ks_node_t *l = nd_text("line", line, &UT_M, C_INK, (float)HDR_X, top, 0.f, 0.f, 71, true);
    ks_parent(l, words);
    /* Where the two decisions sit, for the hit test. */
    s_sh_mode_x0 = HDR_X;
    s_sh_mode_x1 = HDR_X + ut_w(&UT_M, mode_w);
    s_sh_flash_x0 = HDR_X + ut_w(&UT_M, line) - ut_w(&UT_M, flash_w);
    s_sh_flash_x1 = HDR_X + ut_w(&UT_M, line);
    if (s_sh_words_up && (s_pressed == SH_IT_MODE || s_pressed == SH_IT_FLASH)) {
      const int x0 = s_pressed == SH_IT_MODE ? s_sh_mode_x0 : s_sh_flash_x0;
      const int x1 = s_pressed == SH_IT_MODE ? s_sh_mode_x1 : s_sh_flash_x1;
      ks_node_t *u = nd_rect("line.under", (float)x0, top + UT_M.em + 2.f, (float)(x1 - x0), 2.f, C_INK, 72);
      ks_parent(u, words);
    }
  }

  /* The four marks: one per camera, lit when it answers. A camera arriving
   * gives its mark a push, which continuity turns into a small overshoot. */
  static bool had[4];
  static const char *const MARK[4] = {"m0", "m1", "m2", "m3"};
  for (int i = 0; i < 4; i++) {
    ks_node_t *m = nd_disc(MARK[i], UI_W - 24.f - 3 * 18.f - 5.f + i * 18.f, UI_H - 29.f, has[i] ? 5.f : 3.f,
                           has[i] ? C_INK : HDR_DIM, 75);
    ks_pose(m, KC_ALPHA, has[i] ? 230.f : 200.f);
    if (has[i] && !had[i]) ks_impulse(m, KC_R, 0.09f);
    if (!has[i] && had[i]) ks_impulse(m, KC_R, -0.12f);
    had[i] = has[i];
  }

  /* Capture objects: present always so a clip can bind them, at rest unseen. */
  {
    ks_node_t *wh = nd_rect("cap.white", 0.f, 0.f, (float)UI_W, (float)UI_H, RGB(0xff, 0xff, 0xff), 40);
    ks_pose(wh, KC_ALPHA, 0.f);
    ks_node_t *bk = nd_rect("cap.black", 0.f, 0.f, (float)UI_W, (float)UI_H, RGB(0x00, 0x00, 0x00), 41);
    ks_pose(bk, KC_ALPHA, 0.f);
    static const char *const FRAG[4] = {"frag0", "frag1", "frag2", "frag3"};
    for (int i = 0; i < 4; i++) {
      ks_node_t *f = nd(FRAG[i], KS_IMAGE);
      const uint16_t *tile = viewfinder_ready() ? viewfinder_tile(i) : NULL;
      ks_image(f, tile, VF_W, VF_H, (float)SH_PANE_W, (float)SH_PANE_H);
      ks_pose(f, KC_CY0, (float)SH_CROP / VF_H);
      ks_pose(f, KC_CY1, (float)(VF_H - SH_CROP) / VF_H);
      ks_place(f, UI_W * 0.5f, UI_H * 0.5f, 0.5f, 0.5f);
      ks_pose(f, KC_ALPHA, 0.f);
      f->z = 45;
      f->ghost = 1;
    }
    ks_node_t *lb = nd_label("cap.label", &UT_MB, C_INK, UI_W * 0.5f, UI_H * 0.46f, 0.5f, 0.5f, 50, true);
    if (!ks_bound(lb)) ks_pose(lb, KC_ALPHA, 0.f);
    ks_pose(lb, KC_SX, 1.8f);
    ks_pose(lb, KC_SY, 1.8f);
    ks_node_t *sb = nd_text("cap.sub", s_cap_fail_why, &UT_S, C_INK, UI_W * 0.5f, UI_H * 0.46f + 60.f, 0.5f, 0.5f, 50, true);
    if (!ks_bound(sb)) ks_pose(sb, KC_ALPHA, 0.f);
    ks_node_t *bg = nd_text("cap.big", "100", &UT_MB, C_INK, -30.f, UI_H * 0.5f, 0.f, 0.5f, 49, true);
    if (!ks_bound(bg)) ks_pose(bg, KC_ALPHA, 0.f);
    ks_pose(bg, KC_SX, 4.4f);
    ks_pose(bg, KC_SY, 4.4f);
  }
  sync_note(true);
}

/* ------------------------------------------------------------------ */
/* The capture, as events                                              */

typedef struct {
  bool armed;
  int64_t t0_us;
  bool reported;
  uint32_t seen_in;
  /* What the shot itself was like, for the behaviour context. */
  int framing_ms;       /* how long the scene was held before the shutter */
  int64_t first_in_us;  /* the first source frame back */
  int64_t last_in_us;   /* the last */
} cap_watch_t;
static cap_watch_t s_capw;

static void cap_watch(void) {
  const capture_stage_t st = capture_stage();
  const int64_t now = esp_timer_get_time();
  if (st == CAPTURE_IDLE) {
    s_capw.armed = false;
    return;
  }
  if (!s_capw.armed) {
    /* The shutter: the response is in the pass that saw it. */
    s_capw.armed = true;
    s_capw.reported = false;
    s_capw.seen_in = 0;
    s_capw.t0_us = now;
    /* Held still for how long before this was taken: a deliberate frame and
     * the fifth of a burst are not the same shot. */
    s_capw.framing_ms = ksense_still_ms();
    s_capw.first_in_us = 0;
    s_capw.last_in_us = 0;
    kmood_shot(now);
    ks_node_t *ns[6] = {ks_peek("cap.white"), ks_peek("cap.black"), ks_peek("pane0"), ks_peek("pane1"), ks_peek("pane2"), ks_peek("pane3")};
    const char *rs[6] = {"white", "black", "f0", "f1", "f2", "f3"};
    ks_stop_tag("cap");
    ks_play(KCLIP_CAP_FRAMES, "cap", NULL, ns, rs, 6);
  }
  /* Each frame that lands pushes its mark. */
  const uint32_t in = capture_frames_in();
  for (int i = 0; i < 4; i++) {
    if ((in & (1u << i)) && !(s_capw.seen_in & (1u << i))) {
      static const char *const MARK[4] = {"m0", "m1", "m2", "m3"};
      ks_node_t *m = ks_peek(MARK[i]);
      if (m) { ks_impulse(m, KC_R, 0.14f); }
      /* The choreography was waiting for exactly this frame. */
      static const char *const GATE[4] = {"f0", "f1", "f2", "f3"};
      ks_open_gate("cap", GATE[i]);
      /* The spread between the first frame back and the last is the sync
       * quality the behaviour can actually condition on. */
      if (s_capw.first_in_us == 0) s_capw.first_in_us = now;
      s_capw.last_in_us = now;
    }
  }
  s_capw.seen_in = in;
  if (st == CAPTURE_DONE && !s_capw.reported) {
    s_capw.reported = true;
    capture_report_t r;
    capture_last(&r);
    kb_ctx_t c = ui_ctx();
    if (r.ok) s_session_shots++;
    c.shots_session = (int)s_session_shots;
    bool synced = r.stored == 4;
    for (int i = 0; i < 4 && synced; i++) synced = r.cam[i].attempted && r.cam[i].ok && r.cam[i].sync_class == PURE_SYNC_OK;
    c.sync_ok = synced;
    c.framing_ms = s_capw.framing_ms;
    c.sync_spread_ms = s_capw.first_in_us ? (int)((s_capw.last_in_us - s_capw.first_in_us) / 1000) : -1;
    /* The camera notices how it did: a clean four-way lands as confidence,
     * a lost photograph as strain, and both colour what comes next. */
    if (!r.ok) kmood_trouble(0.6f);
    else if (r.stored < r.online) kmood_trouble(0.25f);
    else if (synced) kmood_reward(0.3f);
    if (r.ok) {
      /* The photograph that was just made stays in the world. Built from the
       * four views that made it, because the card's own thumbnail has not been
       * decoded yet and will not be until the roll is opened. */
      const char *v = config_str("shoot.viewfinder", "cam2");
      const int dom = (v[3] >= '1' && v[3] <= '4') ? v[3] - '1' : 1;
      latest_build(r.id, r.uuid, r.stored, dom);
    }
    if (!r.ok) {
      snprintf(s_cap_fail_why, sizeof s_cap_fail_why, "%s", r.stored == 0 ? "NOTHING CAME BACK" : "NOT SAVED");
      ui_event_ctx(KEV_CAPTURE_FAIL, &c);
    } else if (r.stored < r.online) {
      ui_event_ctx(KEV_CAPTURE_PARTIAL, &c);
    } else {
      ui_event_ctx(KEV_CAPTURE_SUCCESS, &c);
    }
  }
}

/* ------------------------------------------------------------------ */
/* LOOK                                                                */

#define FL_IT_PREV 0
#define FL_IT_NEXT 1
#define FL_IT_MONO 2
#define FL_IT_TARGET 3
#define FL_IT_COUNT 8
#define FL_ID_X 24
#define FL_ID_SCALE 2.f
#define FL_ID_Y (UI_H - 24 - 68)
#define FL_FOOT_TOP (UI_H - 24 - 34)
#define FL_TARGET_TOP HDR_Y

typedef struct { int x0, x1; } span_t;
static void fl_spans(span_t *mono, span_t targets[5]) {
  static const char *const T[5] = {"ALL", "1", "2", "3", "4"};
  mono->x1 = UI_W - 24;
  mono->x0 = mono->x1 - ut_w(&UT_M, "MONO");
  int right = UI_W - 24;
  for (int i = 4; i >= 0; i--) {
    targets[i].x1 = right;
    targets[i].x0 = right - ut_w(&UT_M, T[i]);
    right = targets[i].x0 - 26;
  }
}

static void look_show_id(void) {
  ks_node_t *ns[2] = {ks_peek("look.num"), ks_peek("look.name")};
  const char *rs[2] = {"num", "name"};
  if (!ns[0] || !ns[1]) return;
  ks_stop_tag("lookid");
  ks_play(KCLIP_LOOK_ID, "lookid", NULL, ns, rs, 2);
}

/** Step the preset and let the picture react. */
static void fl_change(int dir) {
  look_step(dir);
  ui_event(KEV_LOOK_CHANGE);
  look_show_id();
}

static void sync_look(void) {
  const char *v = config_str("shoot.viewfinder", "cam2");
  const int cam = (v[3] >= '1' && v[3] <= '4') ? v[3] - '1' : 1;
  nd_rect("look.under", 0.f, 0.f, (float)UI_W, (float)UI_H, C_GROUND, 0);
  /* The same four views SHOOT shows, with this one filling the screen and
   * the other three collapsing behind it. Coming from SHOOT, the quad is
   * seen to resolve into the single image rather than being replaced by a
   * picture that was built somewhere else. */
  ks_node_t *g = nd("finder", KS_GROUP);
  ks_place(g, UI_W * 0.5f + drag_u() * 90.f, UI_H * 0.5f, 0.f, 0.f);
  g->z = 0;
  bool has[4] = {false, false, false, false};
  sync_camera_surface(g, cam, has);
  sync_title(true, NULL);

  char num[16], jp[LOOK_TEXT_MAX + 4], en[LOOK_TEXT_MAX + 4];
  static char s_num[16], s_en[LOOK_TEXT_MAX + 4];
  fl_current(num, sizeof num, jp, sizeof jp, en, sizeof en, NULL, 0);
  snprintf(s_num, sizeof s_num, "%s", num);
  snprintf(s_en, sizeof s_en, "%s", en);
  const float y = FL_ID_Y + UT_MB.em * FL_ID_SCALE * 0.5f;
  ks_node_t *nn = nd_text("look.num", s_num, &UT_MB, C_INK, (float)FL_ID_X, y, 0.f, 0.5f, 50, true);
  ks_pose(nn, KC_SX, FL_ID_SCALE);
  ks_pose(nn, KC_SY, FL_ID_SCALE);
  if (!ks_bound(nn)) ks_pose(nn, KC_ALPHA, 0.f);
  const float nx = FL_ID_X + ut_w(&UT_MB, s_num) * FL_ID_SCALE + 28.f;
  ks_node_t *nm = nd_text("look.name", s_en, &UT_MB, C_INK, nx, y, 0.f, 0.5f, 50, true);
  ks_pose(nm, KC_SX, FL_ID_SCALE);
  ks_pose(nm, KC_SY, FL_ID_SCALE);
  if (!ks_bound(nm)) ks_pose(nm, KC_ALPHA, 0.f);

  /* MONO at the foot's right; in QUAD, which camera the next choice lands on,
   * on the header's line. Words, lit when live; a line under the live one. */
  span_t mono, tg[5];
  fl_spans(&mono, tg);
  const bool is_mono = look_is_mono();
  ks_node_t *mo = nd_text("look.mono", "MONO", &UT_M, is_mono ? C_INK : HDR_DIM, (float)mono.x1, (float)FL_FOOT_TOP, 1.f, 0.f, 50, true);
  (void)mo;
  if (is_mono) nd_rect("look.mono.u", (float)mono.x0, FL_FOOT_TOP + UT_M.em + 2.f, (float)(mono.x1 - mono.x0), 2.f, C_INK, 50);
  if (mode_is_quad()) {
    static const char *const T[5] = {"ALL", "1", "2", "3", "4"};
    static const char *const ID[5] = {"look.t0", "look.t1", "look.t2", "look.t3", "look.t4"};
    for (int i = 0; i < 5; i++) {
      const bool on = s_look_target == i;
      nd_text(ID[i], T[i], &UT_M, on ? C_INK : HDR_DIM, (float)tg[i].x1, (float)FL_TARGET_TOP, 1.f, 0.f, 50, true);
      if (on) nd_rect("look.t.u", (float)tg[i].x0, FL_TARGET_TOP + UT_M.em + 2.f, (float)(tg[i].x1 - tg[i].x0), 2.f, C_INK, 50);
    }
  }
  sync_note(true);
}

/* ------------------------------------------------------------------ */
/* ROLL: the grid                                                      */

#define G_COLS GALLERY_COLS
#define G_GAP 14
#define G_X0 ((UI_W - (G_COLS * G_TILE_W + (G_COLS - 1) * G_GAP)) / 2)
#define G_Y0 (HEAD_H + 9)
#define G_PITCH (G_TILE_H + G_GAP)
_Static_assert(G_Y0 + G_PITCH + G_TILE_H <= UI_H, "the bottom row runs off the screen");

/* The photograph's box is always the thumbnail's, so growing to full screen
 * is a scale and not a rebuild; the pixels behind it are whatever resolution
 * has been decoded. */
#define PH_GROW ((float)PH_W / (float)G_TILE_W)


static void gal_origin(int slot, int *x, int *y) {
  *x = G_X0 + (slot % G_COLS) * (G_TILE_W + G_GAP);
  *y = G_Y0 + (slot / G_COLS) * G_PITCH;
}

static bool s_gal_turning;

/** Turn the page with the grid sliding: +1 up (next), -1 down (previous). */
static void gal_turn(int dir) {
  const int pages = gallery_pages();
  const int page = gallery_page();
  if ((dir > 0 && page >= pages - 1) || (dir < 0 && page <= 0)) return;
  gallery_turn(dir);
  ks_node_t *grid = ks_peek("grid");
  if (grid) {
    const float params[4] = {(float)dir, 0, 0, 0};
    ks_stop_tag("page");
    ks_play1(KCLIP_PAGE_TURN, "page", grid, "grid", params);
  }
}

static void sync_gallery(void) {
  storage_status_t sd;
  storage_get_status(&sd);
  const int total = gallery_total();
  sync_title(false, NULL);
  s_gal_turning = ks_playing_tag("page");

  if (total == 0) {
    const bool counting = sd.mounted && gallery_loading();
    const int walked = gallery_scan_progress();
    static char h1[48];
    if (!sd.mounted) snprintf(h1, sizeof h1, "NO CARD");
    else if (counting && walked > 0) snprintf(h1, sizeof h1, "READING %d", walked);
    else if (counting) snprintf(h1, sizeof h1, "READING");
    else snprintf(h1, sizeof h1, "NO PHOTOS");
    const char *h2 = !sd.mounted ? "INSERT A CARD" : counting ? "" : "PRESS THE SHUTTER";
    ks_node_t *a = nd_text("roll.empty", h1, &UT_MB, C_INK, UI_W * 0.5f, UI_H * 0.5f - 12.f, 0.5f, 0.5f, 10, false);
    ks_pose(a, KC_SX, 1.5f);
    ks_pose(a, KC_SY, 1.5f);
    if (h2[0]) nd_text("roll.hint", h2, &UT_S, HDR_DIM, UI_W * 0.5f, UI_H * 0.5f + 34.f, 0.5f, 0.5f, 10, false);
    sync_note(false);
    return;
  }

  ks_node_t *grid = nd("grid", KS_GROUP);
  ks_place(grid, drag_u() * 110.f, 0.f, 0.f, 0.f);
  /* The grid is clipped to below the header, so a turning page slides in
   * under the title rather than across it. */
  ks_pose(grid, KC_MX0, 0.f);
  ks_pose(grid, KC_MY0, (float)HEAD_H);
  ks_pose(grid, KC_MX1, (float)UI_W);
  ks_pose(grid, KC_MY1, (float)UI_H);
  const gallery_item_t *slots = gallery_slots();
  static const char *const PLATE[GALLERY_PAGE] = {"tile0.p", "tile1.p", "tile2.p", "tile3.p", "tile4.p", "tile5.p"};
  static const char *const FAV[GALLERY_PAGE] = {"tile0.fav", "tile1.fav", "tile2.fav", "tile3.fav", "tile4.fav", "tile5.fav"};
  static const char *const PART[GALLERY_PAGE] = {"tile0.n", "tile1.n", "tile2.n", "tile3.n", "tile4.n", "tile5.n"};
  static char partial[GALLERY_PAGE][8];
  for (int i = 0; i < GALLERY_PAGE; i++) {
    if (slots[i].state == TILE_EMPTY) continue;
    int x, y;
    gal_origin(i, &x, &y);
    const bool down = s_pressed == i;
    if (slots[i].state == TILE_READY && slots[i].pixels) {
      char nid[KS_ID_MAX];
      photo_node_id(nid, sizeof nid, slots[i].label, slots[i].id);
      ks_node_t *t = nd(nid, KS_IMAGE);
      ks_image_lod(t, slots[i].pixels, G_TILE_W, G_TILE_H, (float)G_TILE_W, (float)G_TILE_H);
      ks_place(t, x + G_TILE_W * 0.5f, y + G_TILE_H * 0.5f, 0.5f, 0.5f);
      ks_pose(t, KC_SX, down ? 0.95f : 1.f);
      ks_pose(t, KC_SY, down ? 0.95f : 1.f);
      ks_pose(t, KC_ALPHA, 255.f);
      ks_parent(t, grid);
      t->z = 5;
    } else {
      ks_node_t *p = nd_rect(PLATE[i], (float)x, (float)y, (float)G_TILE_W, (float)G_TILE_H, RGB(0x1a, 0x1e, 0x24), 5);
      ks_parent(p, grid);
    }
    if (slots[i].favorite) {
      ks_node_t *f = nd_disc(FAV[i], x + G_TILE_W - 16.f, y + 16.f, 6.f, C_YELLOW, 6);
      ks_parent(f, grid);
    }
    if (slots[i].partial) {
      snprintf(partial[i], sizeof partial[i], "%d/4", slots[i].frames);
      ks_node_t *n = nd_text(PART[i], partial[i], &UT_S, C_YELLOW, x + 10.f, y + G_TILE_H - 10.f - UT_S.em, 0.f, 0.f, 6, true);
      ks_parent(n, grid);
    }
  }
  {
    const int pages = gallery_pages();
    static char pos[64];
    if (gallery_loading()) {
      const int walked = gallery_scan_progress();
      if (walked > 0) snprintf(pos, sizeof pos, "READING %d", walked);
      else snprintf(pos, sizeof pos, "READING");
    } else if (pages > 1) {
      snprintf(pos, sizeof pos, "%d / %d   %d", gallery_page() + 1, pages, total);
    } else {
      snprintf(pos, sizeof pos, "%d", total);
    }
    ks_node_t *c = nd_text("roll.count", pos, &UT_M, HDR_DIM, UI_W - 24.f, (float)HDR_Y, 1.f, 0.f, 70, false);
    ks_pose(c, KC_ALPHA, ks_bound(ks_peek("note")) ? 0.f : 255.f);
  }
  sync_note(false);
}

/* ------------------------------------------------------------------ */
/* PHOTO                                                               */

#define P_IT_DELETE 0
#define P_IT_FAV 1
#define P_IT_ROLL 2
static int s_ph_fav_x0, s_ph_fav_x1, s_ph_del_x0, s_ph_del_x1;

/**
 * Opening a photograph needs no clip any more.
 *
 * It used to play a move authored from the tile's rectangle to the picture's,
 * with the offset and scale passed in as parameters. There is nothing left
 * for that to do: the roll's tile and the full-screen photograph are the same
 * scene object, so posing it at its new place is the whole animation and
 * continuity carries it there at the speed it already had.
 */
static void sync_photo(void) {
  ks_node_t *g = nd("photo.g", KS_GROUP);
  ks_place(g, PH_X0 + PH_W * 0.5f, PH_TOP + PH_H * 0.5f, 0.f, 0.f);
  g->z = 5;
  const uint16_t *src = s_quad_ready ? NULL : photo_pixels();
  if (s_quad_ready) {
    static const char *const Q[4] = {"photo.q0", "photo.q1", "photo.q2", "photo.q3"};
    static const char *const QP[4] = {"photo.q0.p", "photo.q1.p", "photo.q2.p", "photo.q3.p"};
    static const char *const QN[4] = {"photo.q0.n", "photo.q1.n", "photo.q2.n", "photo.q3.n"};
    static const char *const DIGIT[4] = {"1", "2", "3", "4"};
    const float qw = PH_W * 0.5f, qh = PH_H * 0.5f;
    for (int i = 0; i < GALLERY_FRAME_MAX; i++) {
      const float cx = (i & 1 ? 0.5f : -0.5f) * qw, cy = (i >> 1 ? 0.5f : -0.5f) * qh;
      const uint16_t *fp = (s_wig_have & (1u << i)) ? gallery_frame_pixels(i) : NULL;
      if (fp) {
        ks_node_t *q = nd(Q[i], KS_IMAGE);
        ks_image(q, fp, (int)qw, (int)qh, qw - 1.f, qh - 1.f);
        ks_place(q, cx, cy, 0.5f, 0.5f);
        ks_parent(q, g);
        q->z = 5;
      } else {
        ks_node_t *p = nd_rect(QP[i], cx, cy, qw - 1.f, qh - 1.f, RGB(0x1a, 0x1e, 0x24), 5);
        ks_place(p, cx, cy, 0.5f, 0.5f);
        ks_parent(p, g);
        ks_node_t *n = nd_text(QN[i], DIGIT[i], &UT_M, RGB(0x3a, 0x42, 0x4c), cx, cy, 0.5f, 0.5f, 6, false);
        ks_parent(n, g);
      }
    }
  } else if (src) {
    /* The photograph the roll was showing, grown into the screen. Same node,
     * same subject, better pixels, and - critically - the same parent, so the
     * pose it is travelling from and the pose it is travelling to are in one
     * space and continuity can join them. A photograph that changed parent
     * between the two states would appear to jump, because the offset the
     * continuity spring is holding means something different on each side. */
    ks_node_t *sheet = nd("grid", KS_GROUP);
    ks_place(sheet, 0.f, 0.f, 0.f, 0.f);
    ks_pose(sheet, KC_MX0, 0.f);
    ks_pose(sheet, KC_MY0, 0.f);
    ks_pose(sheet, KC_MX1, (float)UI_W);
    ks_pose(sheet, KC_MY1, (float)UI_H);
    char nid[KS_ID_MAX];
    photo_node_id(nid, sizeof nid, s_photo_label, s_photo_id);
    ks_node_t *p = nd(nid, KS_IMAGE);
    ks_image_lod(p, src, PH_W, PH_H, (float)G_TILE_W, (float)G_TILE_H);
    ks_place(p, PH_X0 + PH_W * 0.5f, PH_TOP + PH_H * 0.5f, 0.5f, 0.5f);
    ks_pose(p, KC_SX, PH_GROW);
    ks_pose(p, KC_SY, PH_GROW);
    ks_pose(p, KC_ALPHA, 255.f);
    ks_parent(p, sheet);
    p->z = 6;
    /* Its neighbours reorganise around it: still here, pushed outward from
     * the centre and let go, so they are seen to leave rather than to vanish. */
    const gallery_item_t *slots = gallery_slots();
    for (int i = 0; i < GALLERY_PAGE; i++) {
      if (slots[i].state != TILE_READY || !slots[i].pixels) continue;
      char oid[KS_ID_MAX];
      photo_node_id(oid, sizeof oid, slots[i].label, slots[i].id);
      if (strcmp(oid, nid) == 0) continue;
      ks_node_t *o = ks_peek(oid);
      if (!o) continue;
      int ox, oy;
      gal_origin(i, &ox, &oy);
      const float cx2 = ox + G_TILE_W * 0.5f, cy2 = oy + G_TILE_H * 0.5f;
      ks_get(oid, KS_IMAGE);
      ks_place(o, UI_W * 0.5f + (cx2 - UI_W * 0.5f) * 2.4f, UI_H * 0.5f + (cy2 - UI_H * 0.5f) * 2.4f, 0.5f, 0.5f);
      ks_pose(o, KC_ALPHA, 0.f);
      ks_parent(o, sheet);
      o->z = 4;
    }
  } else {
    ks_node_t *pl = nd_rect("photo.none", 0.f, 0.f, (float)PH_W, (float)PH_H, RGB(0x1a, 0x1e, 0x24), 5);
    ks_place(pl, 0.f, 0.f, 0.5f, 0.5f);
    ks_parent(pl, g);
    ks_node_t *n = nd_text("photo.none.t", "NO IMAGE", &UT_M, HDR_DIM, 0.f, 0.f, 0.5f, 0.5f, 6, false);
    ks_parent(n, g);
  }
  sync_title(true, NULL);

  /* The one line under the picture: how many frames when fewer than four, and
   * the two words that act. */
  static char facts[24];
  facts[0] = 0;
  if ((s_wig_len >= 2 || s_quad_ready) && s_wig_count > 0 && s_wig_count < GALLERY_FRAME_MAX)
    snprintf(facts, sizeof facts, "%d/4", s_wig_count);
  else if (s_photo_frames > 0 && s_photo_frames < GALLERY_FRAME_MAX)
    snprintf(facts, sizeof facts, "%d/4", s_photo_frames);
  if (facts[0]) nd_text("photo.facts", facts, &UT_S, HDR_DIM, (float)PH_X0, (float)PH_LINE_Y, 0.f, 0.f, 50, false);
  const char *fav = s_photo_fav ? "★ FAVOURITE" : "☆ FAVOURITE";
  const char *del = "DELETE";
  const int fw = ut_w(&UT_S, fav), dw = ut_w(&UT_S, del);
  s_ph_del_x1 = PH_X0 + PH_W;
  s_ph_del_x0 = s_ph_del_x1 - dw;
  s_ph_fav_x1 = s_ph_del_x0 - 36;
  s_ph_fav_x0 = s_ph_fav_x1 - fw;
  nd_text("photo.fav", fav, &UT_S, s_photo_fav ? C_YELLOW : C_INK, (float)s_ph_fav_x0, (float)PH_LINE_Y, 0.f, 0.f, 50, false);
  nd_text("photo.del", del, &UT_S, C_INK, (float)s_ph_del_x0, (float)PH_LINE_Y, 0.f, 0.f, 50, false);
  if (s_pressed == P_IT_FAV) nd_rect("photo.u", (float)s_ph_fav_x0, PH_LINE_Y + UT_S.em, (float)fw, 2.f, C_INK, 51);
  if (s_pressed == P_IT_DELETE) nd_rect("photo.u", (float)s_ph_del_x0, PH_LINE_Y + UT_S.em, (float)dw, 2.f, C_RED, 51);
  sync_note(true);
}

/* ------------------------------------------------------------------ */
/* Rows: SETUP and its children, LINK, INFO                            */

#define NR_X 24
#define NR_W (UI_W - 2 * NR_X)
#define NR_Y0 (HEAD_H + 12)
#define NR_H 58
#define NR_TITLE_TOP(y) ((y) + (NR_H - 34) / 2)
#define NR_VALUE_TOP(y) ((y) + (NR_H - 22) / 2 + 3)
#define NR_MAX 8
static const char *const ROW_ID[NR_MAX] = {"row0", "row1", "row2", "row3", "row4", "row5", "row6", "row7"};
static const char *const VAL_ID[NR_MAX] = {"val0", "val1", "val2", "val3", "val4", "val5", "val6", "val7"};

/** A row: a name on the left, its value on the right, on the ground. A press
 * underlines it; a row that cannot act right now is dim. Settings are plain
 * on purpose: clarity, the same type, restraint. */
static void nrow(int i, const char *title, const char *value, bool acts, bool enabled, bool pressed) {
  (void)acts;
  const int y = NR_Y0 + i * NR_H;
  const uint16_t ink = enabled ? C_INK : HDR_DIM;
  nd_text(ROW_ID[i], title, &UT_M, ink, (float)NR_X, (float)NR_TITLE_TOP(y), 0.f, 0.f, 10, false);
  if (value && value[0])
    nd_text(VAL_ID[i], value, &UT_S, enabled ? HDR_DIM : C_FAINT, (float)(NR_X + NR_W), (float)NR_VALUE_TOP(y), 1.f, 0.f, 10, false);
  if (pressed) nd_rect("row.under", (float)NR_X, (float)(y + NR_H - 4), (float)NR_W, 2.f, C_INK, 11);
}
static int nrow_hit(int x, int y, int rows) {
  (void)x;
  if (y < NR_Y0 || y >= NR_Y0 + rows * NR_H) return -1;
  return (y - NR_Y0) / NR_H;
}
static void nnote(const char *s, int after_rows) {
  nd_text("rows.note", s, &UT_S, C_FAINT, (float)NR_X, (float)(NR_Y0 + after_rows * NR_H + 12), 0.f, 0.f, 10, false);
}

/**
 * The rule SETUP hangs its rows from.
 *
 * SETUP is the one state that is allowed to break the photographic world, and
 * it does not do that by throwing the world away: the four live surfaces
 * flatten into a line a few pixels tall above the first row. Continuity
 * carries them there from whatever shape they were in, so the pictures are
 * seen to leave rather than being cut. The line is the colour of the room the
 * camera is standing in, which is the whole of the personality this state
 * gets - the rest is text, selection and restraint.
 */
static void sync_rule(void) {
  ks_node_t *g = nd("finder", KS_GROUP);
  ks_place(g, UI_W * 0.5f, (float)(NR_Y0 - 14), 0.f, 0.f);
  g->z = 0;
  /* A hairline under the four, for the same reason type over a picture gets a
   * contour: a rule made of a dark room is black on black, and the structure
   * the settings hang from cannot be allowed to depend on the lighting. */
  ks_node_t *e = nd_rect("rule.edge", -(KSURF_RULE_W * 0.5f) - 1.f, -(KSURF_RULE_H * 0.5f) - 1.f,
                         KSURF_RULE_W + 2.f, KSURF_RULE_H + 2.f, RGB(0x2a, 0x30, 0x38), -1);
  ks_parent(e, g);
  bool has[4] = {false, false, false, false};
  sync_camera_surface(g, KSURF_RULE, has);
}

static const char *const SET_ROWS[5] = {"DISPLAY", "SOUND", "CARD", "POWER", "INFO"};
static const screen_t SET_DEST[5] = {SCR_DISPLAY, SCR_SOUND, SCR_STORAGE, SCR_POWER, SCR_ABOUT};

static void sync_settings(void) {
  sync_title(false, NULL);
  for (int i = 0; i < 5; i++) nrow(i, SET_ROWS[i], NULL, true, true, s_pressed == i);
  sync_note(false);
}

static const char *const DSP_TITLE[DSP_ROWS] = {"DIM AFTER", "SLEEP AFTER", "AFTER A SHOT", "CAMERAS IDLE"};
static void sync_display(void) {
  sync_title(false, NULL);
  for (int r = 0; r < DSP_ROWS; r++) {
    const int sel = dsp_selected(r);
    nrow(r, DSP_TITLE[r], sel >= 0 ? DSP_ROW[r].names[sel] : "-", true, true,
         band_rel(s_pressed, DSP_ROW[r].base, DSP_ROW[r].count) >= 0);
  }
  sync_note(false);
}

static void sync_sound(void) {
  sync_title(false, NULL);
  static char clip[KDP_SOUND_NAME_MAX];
  snd_display(clip, sizeof clip);
  static const char *const VOL[3] = {"LOW", "MEDIUM", "HIGH"};
  static const int VOLV[3] = {3, 6, 9};
  const bool audio = audio_ready();
  nrow(0, "SHUTTER", clip, true, audio, s_pressed == SN_IT_NEXT || s_pressed == SN_IT_PREV);
  nrow(1, "SAVE SOUND", config_bool("body.sounds.save", true) ? "ON" : "OFF", true, audio, s_pressed == SN_IT_SHUTTER);
  nrow(2, "INTERFACE SOUND", config_bool("body.sounds.ui", true) ? "ON" : "OFF", true, audio, s_pressed == SN_IT_BUTTON);
  nrow(3, "VOLUME", VOL[nearest_idx(config_int("shoot.volume", 6), VOLV)], true, audio, band_rel(s_pressed, SN_IT_VOL, 3) >= 0);
  if (!audio) nnote("NO AUDIO OUTPUT", 4);
  sync_note(false);
}

static void sync_storage(void) {
  sync_title(false, NULL);
  storage_status_t sd;
  storage_get_status(&sd);
  static char freeb[24], capb[24], cnt[48], freerow[40];
  human_bytes(freeb, sizeof freeb, sd.free_bytes);
  human_bytes(capb, sizeof capb, sd.capacity_bytes);
  const int media = gallery_media_count();
  if (gallery_deleting()) {
    int done = 0, total = 0;
    gallery_delete_progress(&done, &total);
    snprintf(cnt, sizeof cnt, "DELETING %d / %d", done, total);
  } else if (media < 0) snprintf(cnt, sizeof cnt, "-");
  else snprintf(cnt, sizeof cnt, "%d", media);
  const bool low = sd.mounted && sd.free_bytes < (512ull << 20);
  snprintf(freerow, sizeof freerow, "%s%s", sd.mounted ? freeb : "-", low ? "  LOW" : "");
  nrow(0, "CARD", sd.mounted ? capb : (sd.present ? "NOT MOUNTED" : "NONE"), false, true, false);
  nrow(1, "FREE", freerow, false, true, false);
  nrow(2, "PHOTOS", cnt, false, true, false);
  nrow(3, "DELETE ALL", "", true, sd.mounted && !gallery_deleting() && media > 0, s_pressed == ST_IT_DELETE_ALL);
  if (sd.mounted) {
    /* How full, as a line: the whole width is the card. */
    const int y = NR_Y0 + 4 * NR_H + 24;
    const int used_w = sd.capacity_bytes ? (int)((uint64_t)NR_W * (sd.capacity_bytes - sd.free_bytes) / sd.capacity_bytes) : 0;
    nd_rect("card.line", (float)NR_X, (float)y, (float)NR_W, 2.f, RGB(0x2a, 0x30, 0x38), 10);
    nd_rect("card.used", (float)NR_X, (float)y, (float)used_w, 2.f, low ? C_YELLOW : C_INK, 11);
  }
  sync_note(false);
}

static void sync_power(void) {
  sync_title(false, NULL);
  nrow(0, "RESTART", NULL, true, true, s_pressed == 1);
  nnote("POWER IS USB-C. UNPLUG TO SWITCH OFF.", 1);
  sync_note(false);
}

static void sync_about(void) {
  sync_title(false, NULL);
  static char name[32], card[64], up[16], proto[16];
  config_str_copy("body.name", name, sizeof name);
  storage_status_t sd;
  storage_get_status(&sd);
  if (sd.mounted) {
    char freeb[24], capb[24];
    human_bytes(freeb, sizeof freeb, sd.free_bytes);
    human_bytes(capb, sizeof capb, sd.capacity_bytes);
    snprintf(card, sizeof card, "%s / %s", freeb, capb);
  } else {
    snprintf(card, sizeof card, "%s", sd.present ? "NOT MOUNTED" : "NONE");
  }
  about_uptime(up, sizeof up);
  snprintf(proto, sizeof proto, "KDP %d", KDP_PROTOCOL_VERSION);
  const char *serial = kdp_device_serial();
  const struct { const char *title; const char *value; } ROWS[] = {
      {"MODEL", name[0] ? name : "KINO D4"}, {"FIRMWARE", KINO_FW_VERSION}, {"SERIAL", serial[0] ? serial : "-"},
      {"HARDWARE", KDP_HARDWARE_REV},        {"PROTOCOL", proto},           {"CARD", card},
      {"UPTIME", up},
  };
  /* The engineering surface: dense, small, none of it a control. */
  for (int i = 0; i < (int)(sizeof ROWS / sizeof ROWS[0]); i++) {
    const int y = NR_Y0 + i * 44;
    nd_text(ROW_ID[i], ROWS[i].title, &UT_S, HDR_DIM, (float)NR_X, (float)(y + 10), 0.f, 0.f, 10, false);
    nd_text(VAL_ID[i], ROWS[i].value, &UT_S, C_INK, (float)(NR_X + NR_W), (float)(y + 10), 1.f, 0.f, 10, false);
  }
  /* The bench rows: the renderer, what the cameras see, and the mood. The
   * mood is never shown anywhere else and never will be - this page exists to
   * expose the machine, which is the one place it belongs. */
  static char perf[80], scene[80], mood[80];
  /* Grouped so each line is one thing: what the renderer costs and what mood
   * is doing to it, what the cameras see, and the mood itself. */
  snprintf(perf, sizeof perf, "SCENE %lu us  WORST %lu us  MISSED %lu  NODES %d/%d  TEMPO %d  VIGOUR %d",
           (unsigned long)(s_ks_perf.render_us + s_ks_perf.step_us), (unsigned long)s_ks_perf.worst_render_us,
           (unsigned long)s_ks_perf.missed, s_ks_count, KS_MAX_NODES,
           (int)(kmood_tempo() * 100.f), (int)(kmood_vigour() * 100.f));
  if (s_ksense.live)
    snprintf(scene, sizeof scene, "LUM %d  MOTION %d  SPREAD %d  STILL %d ms  CAMS %d",
             (int)(s_ksense.lum_mean * 100.f), (int)(s_ksense.motion_mean * 100.f),
             (int)(s_ksense.spread * 100.f), ksense_still_ms(), s_ksense.live);
  else snprintf(scene, sizeof scene, "NO CAMERA SIGNAL");
  snprintf(mood, sizeof mood, "ENERGY %d  CALM %d  CONF %d  STRAIN %d  BURST %d%s",
           (int)(s_kmood.energy * 100.f), (int)(s_kmood.calm * 100.f), (int)(s_kmood.confidence * 100.f),
           (int)(s_kmood.strain * 100.f), s_kmood.recent_shots, ks_holding_tag(NULL) ? "  GATED" : "");
  const int by = NR_Y0 + 7 * 44 + 10;
  nd_text("about.perf", perf, &UT_S, C_FAINT, (float)NR_X, (float)by, 0.f, 0.f, 10, false);
  nd_text("about.scene", scene, &UT_S, C_FAINT, (float)NR_X, (float)(by + 26), 0.f, 0.f, 10, false);
  nd_text("about.mood", mood, &UT_S, C_FAINT, (float)NR_X, (float)(by + 52), 0.f, 0.f, 10, false);
  s_kmo_live++; /* these numbers move; keep the page drawing */
  sync_note(false);
}

/* ------------------------------------------------------------------ */
/* LINK: the world opens itself to KINO ROLL                            */

/*
 * The code is an object in the scene, not something painted over it.
 *
 * It is rendered once into a buffer at one pixel per module and drawn as an
 * image like any photograph, so it can grow into the space the roll makes for
 * it and move with everything else. Nearest sampling is not a compromise
 * here: a QR scaled by whole-ish numbers with no interpolation is exactly
 * what a scanner wants, and the quiet zone comes along in the buffer.
 *
 * 65 modules a side covers version 10 with its quiet zone, which is more than
 * a Roll's guest URL has ever needed.
 */
/* The quiet zone is part of the symbol: a code with no white margin does not
 * scan. Four modules is the specified minimum. */
#define QR_QUIET 4
#define QR_IMG_MAX (57 + 2 * QR_QUIET)
static uint16_t s_qr_img[QR_IMG_MAX * QR_IMG_MAX];
static int s_qr_img_side;

/** Paint the symbol into the buffer. Returns its side in modules, 0 on failure. */
static int qr_to_image(const qr_t *qr) {
  const int total = qr->size + 2 * QR_QUIET;
  if (total > QR_IMG_MAX) return 0;
  for (int i = 0; i < total * total; i++) s_qr_img[i] = RGB(0xff, 0xff, 0xff);
  for (int y = 0; y < qr->size; y++)
    for (int x = 0; x < qr->size; x++)
      if (qr_module(qr, x, y))
        s_qr_img[(y + QR_QUIET) * total + (x + QR_QUIET)] = RGB(0x00, 0x00, 0x00);
  s_qr_img_side = total;
  return total;
}

/*
 * Where the roll's photographs go when the world opens itself outward.
 *
 * They are not cleared and they are not redrawn somewhere else: the same
 * objects compress into a column down the left, overlapping, in the order
 * they sit in the grid. That is the roll becoming shareable, and it is why
 * the space on the right is somewhere the code can grow into rather than a
 * region that was always empty.
 */
#define LINK_STACK_X 96.f
#define LINK_STACK_Y0 150.f
#define LINK_STACK_STEP 46.f
#define LINK_STACK_SCALE 0.42f

static qr_t s_qr;
static char s_qr_url[ROLL_GUEST_URL_LEN];
static bool s_qr_ok;
static int s_qr_x, s_qr_y, s_qr_box;

static void sync_connection(void) {
  sync_title(false, NULL);
  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  roll_state_t roll;
  const bool active = roll_state_get(&roll);
  upload_queue_report_t q;
  upload_queue_status(&q);
  const bool online = net_link_can_upload(&net);

  static char wifi[64];
  if (!net.radio_routed) snprintf(wifi, sizeof wifi, "NONE");
  else switch (net.state) {
    case NET_IP_READY: snprintf(wifi, sizeof wifi, "%s  %d dBm", net.ssid, net.rssi); break;
    case NET_WIFI_ASSOCIATED: case NET_IP_WAIT: snprintf(wifi, sizeof wifi, "GETTING ADDRESS"); break;
    case NET_WIFI_CONNECTING: snprintf(wifi, sizeof wifi, "CONNECTING"); break;
    case NET_WIFI_SCANNING: snprintf(wifi, sizeof wifi, "SCANNING"); break;
    default: snprintf(wifi, sizeof wifi, "NOT CONNECTED"); break;
  }
  /* With a roll on, the facts move right to leave the left edge to the
   * photographs: the connection resolves around the pictures rather than
   * replacing them. */
  const int left_w = active ? 350 : NR_W; /* values stop clear of the code */
  const int rows_x = active ? NR_X + 150 : NR_X;
  static char rollname[64];
  snprintf(rollname, sizeof rollname, "%s", active ? (roll.name[0] ? roll.name : roll.slug) : "NONE");
  const struct { const char *t; const char *v; bool lit; } ROWS[] = {
      {"USB", usb_attached() ? "CONNECTED" : "NOT CONNECTED", usb_attached()},
      {"WIFI", wifi, net.state == NET_IP_READY},
      {"ADDRESS", net.ip[0] ? net.ip : "-", net.ip[0] != '\0'},
      {"ROLL", rollname, active},
  };
  /* With the roll on, the facts are not the subject any more: they step down
   * a size as well as across, which is what makes room for the value beside
   * the label in half the width. */
  const ut_face_t *row_face = active ? &UT_S : &UT_M;
  for (int i = 0; i < 4; i++) {
    const int y = NR_Y0 + i * NR_H;
    const int ty = active ? NR_VALUE_TOP(y) : NR_TITLE_TOP(y);
    nd_text(ROW_ID[i], ROWS[i].t, row_face, ROWS[i].lit ? C_INK : HDR_DIM, (float)rows_x, (float)ty, 0.f, 0.f, 10, false);
    nd_text(VAL_ID[i], ROWS[i].v, &UT_S, ROWS[i].lit ? C_INK : HDR_DIM, (float)(rows_x + left_w), (float)NR_VALUE_TOP(y), 1.f, 0.f, 10, false);
  }
  if (!net.radio_routed && !active) nnote("NO RADIO. PHOTOS GO OVER USB-C.", 4);

  if (active) {
    if (strcmp(s_qr_url, roll.guest_url) != 0) {
      snprintf(s_qr_url, sizeof s_qr_url, "%s", roll.guest_url);
      s_qr_ok = roll.guest_url[0] != '\0' && qr_encode(roll.guest_url, &s_qr) && qr_to_image(&s_qr) > 0;
      if (!s_qr_ok) klog("P4", "roll guest url did not encode as a QR (%u chars)", (unsigned)strlen(roll.guest_url));
    }
    s_qr_x = 560; s_qr_y = NR_Y0 + 6; s_qr_box = 236;
    static char slug[ROLL_SLUG_LEN];
    snprintf(slug, sizeof slug, "%s", roll.slug);

    /* The roll itself, compressed into a column. The same photograph objects
     * the grid was showing, so what the user sees being offered is these
     * pictures rather than a page about networking. */
    /* What the queue is actually doing, which is all the interface is allowed
     * to say. The queue reports counts and the moment one landed; it does not
     * report which capture is in flight, so nothing here singles a photograph
     * out. The pile is being worked, and it settles when one leaves. */
    const bool working = online && !q.halted && q.draining && (q.uploading > 0 || q.pending > 0);
    static int64_t s_sent_at_ms;
    const bool landed = q.last_upload_ms != 0 && q.last_upload_ms != s_sent_at_ms;
    s_sent_at_ms = q.last_upload_ms;

    const gallery_item_t *slots = gallery_slots();
    ks_node_t *sheet = nd("grid", KS_GROUP);
    ks_place(sheet, 0.f, 0.f, 0.f, 0.f);
    ks_pose(sheet, KC_MX0, 0.f);
    ks_pose(sheet, KC_MY0, 0.f);
    ks_pose(sheet, KC_MX1, (float)UI_W);
    ks_pose(sheet, KC_MY1, (float)UI_H);
    int stacked = 0;
    for (int i = 0; i < GALLERY_PAGE; i++) {
      if (slots[i].state != TILE_READY || !slots[i].pixels) continue;
      char oid[KS_ID_MAX];
      photo_node_id(oid, sizeof oid, slots[i].label, slots[i].id);
      ks_node_t *o = nd(oid, KS_IMAGE);
      ks_image_lod(o, slots[i].pixels, G_TILE_W, G_TILE_H, (float)G_TILE_W, (float)G_TILE_H);
      ks_place(o, LINK_STACK_X, LINK_STACK_Y0 + stacked * LINK_STACK_STEP, 0.5f, 0.5f);
      ks_pose(o, KC_SX, LINK_STACK_SCALE);
      ks_pose(o, KC_SY, LINK_STACK_SCALE);
      ks_pose(o, KC_ALPHA, q.halted ? 120.f : 255.f);
      ks_parent(o, sheet);
      o->z = (int16_t)(20 - stacked); /* the next one out is on top of the pile */
      /* Restless while the worker is working, still when it is not. Each
       * photograph has its own seed, so the pile is unsettled rather than
       * sliding about as one piece. */
      if (working) {
        const kmo_mod_t m = {0, KM_NOISE, 0, 0, {1.4f, 3.4f, 0.9f, 0.f}, 0.6f};
        ks_mod(o, &m, s_kmo_now_us, -1);
      } else {
        ks_mod_clear(o);
      }
      stacked++;
    }

    if (s_qr_ok) {
      /* The code grows into the space the roll made for it. Nearest sampling
       * is not a compromise for a symbol made of squares. */
      ks_node_t *qn = nd("link.qr", KS_IMAGE);
      ks_image_lod(qn, s_qr_img, s_qr_img_side, s_qr_img_side, (float)s_qr_img_side, (float)s_qr_img_side);
      ks_place(qn, s_qr_x + s_qr_box * 0.5f, s_qr_y + s_qr_box * 0.5f, 0.5f, 0.5f);
      const float qs = (float)s_qr_box / (float)s_qr_img_side;
      ks_pose(qn, KC_SX, qs);
      ks_pose(qn, KC_SY, qs);
      ks_pose(qn, KC_ALPHA, 255.f);
      qn->z = 12;
      ks_node_t *sn = nd_text("link.slug", slug, &UT_S, C_INK,
                              s_qr_x + s_qr_box * 0.5f, (float)(s_qr_y + s_qr_box + 14), 0.5f, 0.f, 12, false);
      if (!s_qr_opened) {
        s_qr_opened = true;
        ks_node_t *ns[2] = {qn, sn};
        static const char *const RS[2] = {"code", "slug"};
        const float params[4] = {qs, 0.f, 0.f, 0.f};
        ks_play(KCLIP_LINK_CODE, "qr", params, ns, RS, 2);
      }
    } else {
      /* No code: the slug is what the guest types instead, so it is set as
       * large as the code's own square allows and no larger. */
      ks_node_t *b = nd_text("link.slug", slug, &UT_MB, C_INK, s_qr_x + s_qr_box * 0.5f, s_qr_y + s_qr_box * 0.5f, 0.5f, 0.5f, 12, false);
      const float w = ut_w(&UT_MB, slug);
      const float bs = w > 1.f ? (float)s_qr_box / w : 1.f;
      ks_pose(b, KC_SX, bs > 1.8f ? 1.8f : bs);
      ks_pose(b, KC_SY, bs > 1.8f ? 1.8f : bs);
    }

    /* One landed: a real, discrete thing happened, so the pile acknowledges it
     * once. Nothing counts up, nothing interpolates toward a finish line. */
    if (landed) ks_impulse(sheet, KC_Y, -26.f);

    const int waiting = q.pending + q.card_pending;
    const bool server_quiet = online && q.server_state == UPLOAD_SERVER_UNREACHABLE;
    const bool sending = online && !server_quiet && !q.halted && (waiting > 0 || q.uploading > 0);
    static char l1[64], l2[64];
    l2[0] = 0;
    /* The count is the headline in every state, so the line stays the same
     * width whatever has gone wrong and never reaches the code. */
    if (q.halted) { snprintf(l1, sizeof l1, "%d WAITING", waiting); snprintf(l2, sizeof l2, "STOPPED. SEE STUDIO"); }
    else if (sending) { snprintf(l1, sizeof l1, "%d SENDING", waiting + q.uploading); }
    else if (waiting > 0) { snprintf(l1, sizeof l1, "%d WAITING", waiting); snprintf(l2, sizeof l2, "%s", server_quiet ? "KINO ROLL IS NOT ANSWERING" : "SENDS WHEN WIFI RETURNS"); }
    else if (!q.scan_complete) snprintf(l1, sizeof l1, "CHECKING CARD");
    else snprintf(l1, sizeof l1, "ALL SENT");
    const int ly = NR_Y0 + 4 * NR_H + 18;
    nd_text("link.status", l1, &UT_MB, sending ? C_COBALT : C_INK, (float)rows_x, (float)ly, 0.f, 0.f, 10, false);
    if (l2[0]) nd_text("link.sub", l2, &UT_S, HDR_DIM, (float)rows_x, (float)(ly + 44), 0.f, 0.f, 10, false);
    /* There used to be four points here lit by how far the burst had got: a
     * progress bar with the bar taken off. The queue cannot say which
     * photograph is in flight or how far through it is, so a fraction was
     * never anything but a shape. The photographs carry it instead - they are
     * unsettled while the worker works and settle when one lands - and the
     * only number shown is the one the queue really has, which is how many
     * are still owed. */
    if (sending) s_kmo_live++; /* the counts move; keep drawing */
  }
  sync_note(false);
}

/* ------------------------------------------------------------------ */
/* Dialog: the darkened screen, a question, two words                  */

#define DLG_Q_Y (UI_H * 0.40f)
#define DLG_WORD_Y (UI_H * 0.66f)
#define DLG_X1 (UI_W * 0.36f)
#define DLG_X2 (UI_W * 0.64f)
#define DLG_BAND_H 72
#define DLG_HIT_W 200

/** The dialog is gone: its held clip with it, or its words would linger, bound. */
static void dialog_close(void) {
  s_dialog = DLG_NONE;
  ks_stop_tag("dialog");
}

static void dialog_open(dialog_t d) {
  s_dialog = d;
  s_dlg_focus = 0;
  ks_node_t *ns[3] = {nd("dlg.q", KS_TEXT), nd("dlg.a", KS_TEXT), nd("dlg.b", KS_TEXT)};
  const char *rs[3] = {"q", "a", "b"};
  for (int i = 0; i < 3; i++) ks_snap(ns[i]);
  ks_stop_tag("dialog");
  ks_play(KCLIP_DIALOG_IN, "dialog", NULL, ns, rs, 3);
}

static void sync_dialog(void) {
  dlg_spec_t d;
  dialog_spec(&d);
  ks_node_t *sc = nd_rect("dlg.scrim", 0.f, 0.f, (float)UI_W, (float)UI_H, RGB(0x04, 0x05, 0x07), 90);
  ks_pose(sc, KC_ALPHA, 225.f);
  ks_node_t *q = nd_text("dlg.q", d.body, &UT_MB, C_INK, UI_W * 0.5f, DLG_Q_Y, 0.5f, 0.5f, 91, false);
  ks_pose(q, KC_SX, 1.3f);
  ks_pose(q, KC_SY, 1.3f);
  if (d.sub) nd_text("dlg.sub", d.sub, &UT_S, HDR_DIM, UI_W * 0.5f, DLG_Q_Y + 40.f, 0.5f, 0.f, 91, false);
  const uint16_t go_ink = d.destructive ? C_RED : C_INK;
  const float top = DLG_WORD_Y - UT_M.em * 0.5f;
  nd_text("dlg.a", "CANCEL", &UT_M, s_pressed == 0 ? C_INK : HDR_DIM, DLG_X1, top, 0.5f, 0.f, 91, false);
  nd_text("dlg.b", d.go, &UT_M, go_ink, DLG_X2, top, 0.5f, 0.f, 91, false);
  const int w1 = ut_w(&UT_M, "CANCEL"), w2 = ut_w(&UT_M, d.go);
  if (s_pressed == 0) nd_rect("dlg.u", DLG_X1 - w1 * 0.5f, top + UT_M.em + 4.f, (float)w1, 2.f, C_INK, 92);
  if (s_pressed == 1) nd_rect("dlg.u", DLG_X2 - w2 * 0.5f, top + UT_M.em + 4.f, (float)w2, 2.f, go_ink, 92);
}

/* A capture seen from any other screen: the four marks in a band at the foot. */
static void sync_capture_banner(void) {
  if (s_screen == SCR_SHOOT || !s_capw.armed) return;
  const int h = 60, y = UI_H - h;
  nd_rect("cap.band", 0.f, (float)y, (float)UI_W, (float)h, HDR_GROUND, 85);
  const uint32_t in = capture_frames_in();
  const uint32_t asked = capture_asked_cams();
  static const char *const M[4] = {"band.m0", "band.m1", "band.m2", "band.m3"};
  for (int i = 0; i < 4; i++) {
    const bool got = in & (1u << i);
    const bool ask = asked == 0 || (asked & (1u << i));
    nd_disc(M[i], UI_W * 0.5f - 1.5f * 36.f + i * 36.f, y + 30.f, got ? 7.f : 3.f, got ? C_INK : (ask ? HDR_DIM : C_FAINT), 86);
  }
  s_kmo_live++;
}

/* ------------------------------------------------------------------ */
/* What the camera notices: edges on real state, reported as events    */

static void events_watch(void) {
  static bool primed;
  static bool p_mounted, p_usb, p_low, p_online, p_sending;
  static net_state_t p_net;
  static int p_live;
  static int64_t q_last_us;
  static upload_queue_report_t q;

  storage_status_t sd;
  storage_get_status(&sd);
  power_state_t ps;
  power_get(&ps);
  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  const bool low = sd.mounted && sd.free_bytes < 300ull * 1024 * 1024;
  const bool online = net_link_can_upload(&net);
  const int64_t now = esp_timer_get_time();
  if (!primed || now - q_last_us >= 500000) {
    upload_queue_status(&q);
    q_last_us = now;
  }
  const int waiting = q.pending + q.card_pending;
  const bool sending = online && q.server_state != UPLOAD_SERVER_UNREACHABLE && !q.halted && (waiting > 0 || q.uploading > 0);

  if (!primed) {
    primed = true;
    p_mounted = sd.mounted; p_usb = ps.usb_attached; p_net = net.state; p_low = low; p_live = s_live_cams;
    p_online = online; p_sending = sending;
    return;
  }
  if (sd.mounted != p_mounted) { ui_event(sd.mounted ? KEV_CARD_IN : KEV_CARD_OUT); p_mounted = sd.mounted; }
  if (ps.usb_attached != p_usb) { ui_event(ps.usb_attached ? KEV_USB_ATTACH : KEV_USB_DETACH); p_usb = ps.usb_attached; }
  const bool linked_now = online && !p_online;
  if (net.radio_routed && net.state != p_net) {
    if (net.state == NET_IP_READY) { if (!linked_now) ui_note("WIFI OK"); }
    else if (p_net == NET_IP_READY) ui_note("NO WIFI");
    p_net = net.state;
  }
  if (online != p_online) { ui_event(online ? KEV_LINK_CONNECTED : KEV_LINK_LOST); p_online = online; }
  if (p_sending && !sending && waiting == 0 && q.uploading == 0 && !q.halted) ui_event(KEV_TRANSFER_COMPLETE);
  p_sending = sending;
  if (low != p_low) { if (low) ui_event(KEV_CARD_LOW); p_low = low; }
  if (s_live_cams != p_live) {
    /* Back to four: CAMERA OFF is no longer the case, and a word about a
     * camera that is visibly answering again is a small lie left running. */
    if (s_live_cams == 4) ui_note_retire(KEV_CAMERA_LOST);
    if (s_live_cams == 4 && p_live >= 0 && p_live < 4) ui_event(KEV_SYNC_GOOD);
    /* A camera dropped out. Every camera stopping at once is not that - it is
     * the finder being turned off, on the way to sleep or out of a mode - and
     * the interface has nothing to complain about there. */
    else if (s_live_cams > 0 && s_live_cams < p_live) ui_event(KEV_CAMERA_LOST);
    p_live = s_live_cams;
  }
}

/* ------------------------------------------------------------------ */
/* The frame                                                           */

static void draw_screen(void) {
  const int64_t now = esp_timer_get_time();
  /* What the cameras see, then what sort of state that puts the camera in,
   * then what that does to the timing and the travel of everything below. */
  ksense_step();
  kmood_step(now);
  s_kmo_tempo = kmood_tempo();
  s_kmo_vigour = kmood_vigour();
  s_kmo_live = 0;
  ks_begin(now);
  s_clip_x0 = 0; s_clip_y0 = 0; s_clip_x1 = UI_W; s_clip_y1 = UI_H;
  fill(0, 0, UI_W, UI_H, C_GROUND);
  switch (s_screen) {
    case SCR_SHOOT: sync_shoot(); break;
    case SCR_LOOK: sync_look(); break;
    case SCR_GALLERY: sync_gallery(); break;
    case SCR_PHOTO: sync_photo(); break;
    case SCR_ROLL: case SCR_CONNECTION: sync_connection(); break;
    /* The SETUP family, every one of which hangs from the same rule. */
    case SCR_SETTINGS: sync_rule(); sync_settings(); break;
    case SCR_DISPLAY: sync_rule(); sync_display(); break;
    case SCR_SOUND: sync_rule(); sync_sound(); break;
    case SCR_STORAGE: sync_rule(); sync_storage(); break;
    case SCR_ABOUT: sync_rule(); sync_about(); break;
    case SCR_POWER: sync_rule(); sync_power(); break;
    default: break;
  }
  /* The roll and the open photograph pose this object themselves, and where
   * they put it is where it belongs; everywhere else it is the thing still in
   * the hand, in the corner. */
  if (s_screen != SCR_GALLERY && s_screen != SCR_PHOTO) sync_latest();
  sync_capture_banner();
  if (s_dialog != DLG_NONE) sync_dialog();
  sync_brand_leaving();
  ks_render();
}

/* ------------------------------------------------------------------ */
/* Boot and wake                                                       */

/**
 * Black, then the name. A first boot ever sets it one letter at a time; a
 * normal cold boot lands it on one spring. Then the finder is posed under it
 * and the name lets go through continuity - no dissolve, no second screen.
 */
/** This unit's own character, from its serial and its cameras' disagreement. */
static void ui_identity(void) {
  /* The spread is quantised so a shade of drift between boots does not make
   * the camera a different character every time it is switched on. */
  const uint32_t spread = (uint32_t)(s_ksense.spread * 20.f);
  kmood_identity(kdp_device_serial(), spread);
}

static void boot_show(bool first) {
  ks_node_t *b = nd_text("brand", "KINO D4", &UT_MB, C_INK, UI_W * 0.5f, UI_H * 0.5f, 0.5f, 0.5f, 95, false);
  ks_pose(b, KC_SX, 2.f);
  ks_pose(b, KC_SY, 2.f);
  ks_snap(b);
  const int64_t t0 = esp_timer_get_time();
  if (first) {
    ks_text_stagger(b, KCLIP_BOOT_CHAR, 55, t0);
    ks_play1(KCLIP_BOOT_FIRST, "boot", b, "title", NULL);
  } else {
    ks_play1(KCLIP_BOOT_COLD, "boot", b, "title", NULL);
  }
  const int hold_ms = first ? 1900 : 1150;
  for (;;) {
    const int64_t now = esp_timer_get_time();
    s_kmo_live = 0;
    ks_begin(now);
    fill(0, 0, UI_W, UI_H, RGB(0x00, 0x00, 0x00));
    ks_node_t *bb = nd("brand", KS_TEXT);
    (void)bb;
    ks_render();
    gfx_present();
    if ((now - t0) / 1000 > hold_ms) break;
    vTaskDelay(pdMS_TO_TICKS(16));
  }
  ks_stop_tag("boot");
}

/** The name lets go over the finder: shown for a few more passes at a pose of 0. */
static void sync_brand_leaving(void) {
  ks_node_t *b = ks_peek("brand");
  if (!b || !b->visible_prev) return;
  ks_node_t *bb = nd("brand", KS_TEXT);
  ks_pose(bb, KC_ALPHA, 0.f);
  ks_pose(bb, KC_Y, UI_H * 0.5f - 14.f);
}
