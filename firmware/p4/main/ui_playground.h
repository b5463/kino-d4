// The animation playground: the engine's test surface, not the product.
//
// Compiled into the host preview and the Twin (KINO_PLAYGROUND), never the
// camera. Each scene poses a few nodes with the playground roles and starts
// one of the pg_* clips (behaviors/playground.json); the caller steps the
// clock and renders. What a scene exercises is in its comment; the films the
// preview writes (pg_<scene>_<ms>.ppm) are the proof.
#pragma once

enum {
  PG_KEYS = 0, PG_CURVES, PG_SPRING, PG_PATH, PG_PARENT, PG_MASK, PG_CHAR, PG_TRACKING, PG_DEFORM, PG_RGB,
  PG_NOISE, PG_BOIL, PG_OSC, PG_WARP, PG_SOUND, PG_INTERRUPT, PG_LAYERS, PG_COUNT
};
static const char *const PG_NAME[PG_COUNT] = {
    "keys", "curves", "spring", "path", "parent", "mask", "char", "tracking", "deform", "rgb",
    "noise", "boil", "osc", "warp", "sound", "interrupt", "layers",
};

/** Take a node's procedural modifiers off: between scenes, so noise from one
 * does not follow the word into the next. */
/* The picture the image scenes use: whatever the finder has for camera 1. */
static const uint16_t *pg_picture(void) { return viewfinder_ready() ? viewfinder_tile(1) : NULL; }

static ks_node_t *pg_word(const char *id, const char *s, float x, float y, uint16_t ink) {
  ks_node_t *n = ks_get(id, KS_TEXT);
  ks_text(n, s, &UT_MB, ink);
  ks_place(n, x, y, 0.5f, 0.5f);
  ks_pose(n, KC_MX0, 0.f); ks_pose(n, KC_MY0, 0.f); ks_pose(n, KC_MX1, 0.f); ks_pose(n, KC_MY1, 0.f);
  ks_pose(n, KC_TRACK, 0.f); ks_pose(n, KC_RGB, 0.f);
  n->z = 10;
  return n;
}

static ks_node_t *pg_image(const char *id, float x, float y, float w, float h) {
  ks_node_t *n = ks_get(id, KS_IMAGE);
  ks_image(n, pg_picture(), VF_W, VF_H, w, h);
  ks_pose(n, KC_CY0, (float)SH_CROP / VF_H);
  ks_pose(n, KC_CY1, (float)(VF_H - SH_CROP) / VF_H);
  ks_place(n, x, y, 0.5f, 0.5f);
  n->z = 5;
  return n;
}

/** Pose this scene's nodes for the pass. Called every frame; starts nothing. */
static void pg_pose(int which) {
  const float cx = UI_W * 0.5f, cy = UI_H * 0.5f;
  ks_get("pg.title", KS_TEXT);
  ks_node_t *t = ks_get("pg.title", KS_TEXT);
  ks_text(t, PG_NAME[which], &UT_S, RGB(0x80, 0x88, 0x94));
  ks_place(t, 24.f, 14.f, 0.f, 0.f);
  t->z = 90;
  switch (which) {
    case PG_KEYS: case PG_WARP: pg_word("pg.a", "KEYFRAMES", cx, cy, C_INK); break;
    case PG_CURVES: {
      static const char *const ID[5] = {"pg.a", "pg.b", "pg.c", "pg.d", "pg.e"};
      static const char *const W[5] = {"LINEAR", "SNAP", "RUSH", "STALL", "POW3"};
      for (int i = 0; i < 5; i++) pg_word(ID[i], W[i], cx, 90.f + i * 76.f, C_INK);
      break;
    }
    case PG_SPRING: {
      pg_word("pg.a", "SPRING 3.5 / 0.18", cx, cy - 90.f, C_INK);
      pg_word("pg.b", "EXP 110 ms", cx, cy, C_INK);
      pg_word("pg.c", "SPRING 6 / 0.55", cx, cy + 90.f, C_INK);
      break;
    }
    case PG_PATH: {
      pg_word("pg.a", "ARC", cx, cy, C_COBALT);
      pg_word("pg.b", "ZIG", cx, cy + 140.f, C_INK);
      break;
    }
    case PG_PARENT: {
      ks_node_t *a = pg_image("pg.a", cx, cy - 20.f, 400.f, 240.f);
      ks_node_t *b = pg_word("pg.b", "CAPTION FOLLOWS", 0.f, 150.f, C_YELLOW);
      ks_parent(b, a);
      break;
    }
    case PG_MASK: {
      ks_node_t *a = pg_word("pg.a", "REVEALED BY A MASK", cx, 80.f, C_INK);
      ks_pose(a, KC_AX, 0.5f);
      /* The mask is in node space around the anchor: the clip drives mx1. */
      ks_pose(a, KC_MX0, -300.f); ks_pose(a, KC_MY0, -30.f); ks_pose(a, KC_MY1, 30.f);
      static const char *const S[4] = {"pg.s0", "pg.s1", "pg.s2", "pg.s3"};
      for (int i = 0; i < 4; i++) {
        ks_node_t *s = pg_image(S[i], cx, 170.f + i * 60.f + 30.f, 400.f, 60.f);
        ks_pose(s, KC_CY0, (float)SH_CROP / VF_H + (float)i * (1.f - 2.f * SH_CROP / VF_H) / 4.f);
        ks_pose(s, KC_CY1, (float)SH_CROP / VF_H + (float)(i + 1) * (1.f - 2.f * SH_CROP / VF_H) / 4.f);
      }
      break;
    }
    case PG_CHAR: pg_word("pg.a", "ONE GLYPH AT A TIME", cx, cy, C_INK); break;
    case PG_TRACKING: pg_word("pg.a", "CONNECTED", cx, cy, C_COBALT); break;
    case PG_DEFORM: case PG_RGB: {
      pg_image("pg.img", cx, cy - 30.f, 400.f, 240.f);
      if (which == PG_RGB) pg_word("pg.a", "SEPARATED", cx, cy + 150.f, C_INK);
      break;
    }
    case PG_NOISE: pg_word("pg.a", "NOISE", cx, cy, C_INK); break;
    case PG_BOIL: {
      ks_node_t *l = ks_get("pg.l", KS_LINE);
      ks_place(l, cx - 200.f, cy, 0.f, 0.f);
      ks_pose(l, KC_P0, 400.f);
      ks_pose(l, KC_P1, 0.f);
      ks_pose(l, KC_LINE_W, 3.f);
      l->ink = C_INK;
      l->z = 5;
      pg_word("pg.a", "LINE BOIL", cx, cy - 60.f, RGB(0x80, 0x88, 0x94));
      break;
    }
    case PG_OSC: pg_word("pg.a", "OSCILLATION", cx, cy, C_INK); break;
    case PG_SOUND: {
      static const char *const M[4] = {"pg.m0", "pg.m1", "pg.m2", "pg.m3"};
      for (int i = 0; i < 4; i++) {
        ks_node_t *m = ks_get(M[i], KS_DISC);
        ks_place(m, cx, cy, 0.5f, 0.5f);
        ks_pose(m, KC_R, 7.f);
        m->ink = C_INK;
        m->z = 5;
      }
      break;
    }
    case PG_INTERRUPT: pg_word("pg.a", "INTERRUPTED", cx, cy, C_INK); break;
    case PG_LAYERS: pg_word("pg.a", "LAYERS", cx, cy, C_INK); break;
    default: break;
  }
}

/** Start the scene's clip(s). */
static void pg_start(int which, int64_t now_us) {
  ks_stop_tag("pg");
  ks_node_t *a = ks_peek("pg.a"), *b = ks_peek("pg.b"), *c = ks_peek("pg.c"), *d = ks_peek("pg.d"), *e = ks_peek("pg.e");
  switch (which) {
    case PG_KEYS: ks_play1(KCLIP_PG_KEYS, "pg", a, "a", NULL); break;
    case PG_CURVES: {
      ks_node_t *ns[5] = {a, b, c, d, e};
      const char *rs[5] = {"a", "b", "c", "d", "e"};
      ks_play(KCLIP_PG_CURVES, "pg", NULL, ns, rs, 5);
      break;
    }
    case PG_SPRING: {
      ks_node_t *ns[3] = {a, b, c};
      const char *rs[3] = {"a", "b", "c"};
      ks_play(KCLIP_PG_SPRING, "pg", NULL, ns, rs, 3);
      break;
    }
    case PG_PATH: {
      ks_node_t *ns[2] = {a, b};
      const char *rs[2] = {"a", "b"};
      ks_play(KCLIP_PG_PATH, "pg", NULL, ns, rs, 2);
      break;
    }
    case PG_PARENT: {
      ks_node_t *ns[2] = {a, b};
      const char *rs[2] = {"a", "b"};
      ks_play(KCLIP_PG_PARENT, "pg", NULL, ns, rs, 2);
      break;
    }
    case PG_MASK: {
      ks_node_t *ns[5] = {a, ks_peek("pg.s0"), ks_peek("pg.s1"), ks_peek("pg.s2"), ks_peek("pg.s3")};
      const char *rs[5] = {"a", "s0", "s1", "s2", "s3"};
      ks_play(KCLIP_PG_MASK, "pg", NULL, ns, rs, 5);
      break;
    }
    case PG_CHAR: ks_text_stagger(a, KCLIP_PG_CHAR, 40, now_us); break;
    case PG_TRACKING: ks_text_stagger(a, KCLIP_PG_CHAR, 28, now_us); ks_play1(KCLIP_PG_TRACKING, "pg", a, "a", NULL); break;
    case PG_DEFORM: ks_play1(KCLIP_PG_DEFORM, "pg", ks_peek("pg.img"), "img", NULL); break;
    case PG_RGB: {
      ks_node_t *ns[2] = {ks_peek("pg.img"), a};
      const char *rs[2] = {"img", "a"};
      ks_play(KCLIP_PG_RGB, "pg", NULL, ns, rs, 2);
      break;
    }
    case PG_NOISE: ks_play1(KCLIP_PG_NOISE, "pg", a, "a", NULL); break;
    case PG_BOIL: ks_play1(KCLIP_PG_BOIL, "pg", ks_peek("pg.l"), "l", NULL); break;
    case PG_OSC: ks_play1(KCLIP_PG_OSC, "pg", a, "a", NULL); break;
    case PG_WARP: ks_play1(KCLIP_PG_WARP, "pg", a, "a", NULL); break;
    case PG_SOUND: {
      ks_node_t *ns[4] = {ks_peek("pg.m0"), ks_peek("pg.m1"), ks_peek("pg.m2"), ks_peek("pg.m3")};
      const char *rs[4] = {"m0", "m1", "m2", "m3"};
      ks_play(KCLIP_PG_SOUND, "pg", NULL, ns, rs, 4);
      break;
    }
    case PG_INTERRUPT: ks_play1(KCLIP_PG_MOVE_A, "pg", a, "a", NULL); break;
    case PG_LAYERS: {
      /* Base pose + a move + noise + an impulse from the side, all on one word. */
      ks_play1(KCLIP_PG_KEYS, "pg", a, "a", NULL);
      kmo_mod_t m = {0, KM_NOISE, 0, 0, {1.5f, 1.f, 0.8f, 0.01f}, 8.f};
      ks_mod(a, &m, now_us, -1);
      ks_impulse(a, KC_Y, -0.9f);
      break;
    }
    default: break;
  }
}

/** The interruption test's second act: a move back, from wherever the word is. */
static void pg_interrupt(void) {
  ks_node_t *a = ks_peek("pg.a");
  if (!a) return;
  ks_stop_tag("pg");
  ks_play1(KCLIP_PG_MOVE_B, "pg", a, "a", NULL);
}

/** One playground frame: pose, step, draw. */
static void pg_frame(int which, int64_t now_us) {
  s_kmo_live = 0;
  ks_begin(now_us);
  s_clip_x0 = 0; s_clip_y0 = 0; s_clip_x1 = UI_W; s_clip_y1 = UI_H;
  fill(0, 0, UI_W, UI_H, C_GROUND);
  pg_pose(which);
  ks_render();
}
