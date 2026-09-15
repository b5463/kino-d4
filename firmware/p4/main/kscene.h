// KINO scene: the objects on the screen, and how they are drawn.
//
// A retained scene graph over the immediate-mode canvas. Screens do not draw;
// each pass they ACQUIRE the nodes they need by id (ks_get), set their POSE
// (the resting values of the channels) and content, and the runtime does the
// rest: clips drive channels, continuity joins the moves, modifiers add their
// layer, and the renderer draws the tree in z order through the primitives.
//
// Because a node with the same id is the same object from pass to pass and
// from mode to mode, the interface is one continuously running system rather
// than a set of pages: the title that leaves SHOOT and the one that arrives on
// ROLL are one node retargeted, and nothing is unloaded.
//
// Kinds: TEXT (a string in a face, optionally set one glyph at a time with a
// stagger), IMAGE (source pixels drawn into a box through crop, asymmetric
// scale, rotation, skew, strip deformation, colour separation and ghosts),
// DISC, LINE (an anti-aliased capsule, with boil when asked), RECT, GROUP.
//
// Included by ui.c after kmo.h and the primitives (fill, mix, disc, ut_*) and
// the clip rect (s_clip) they honour.
#pragma once

#define KS_MAX_NODES 160
#define KS_MAX_MODS 3
/* An id is copied into the node rather than pointed at, so a screen may name
 * an object after the thing it is showing - "ph:CAP_000042" - instead of only
 * after the slot it happens to occupy. That is what lets one photograph stay
 * one object from the roll into the full screen and back. */
#define KS_ID_MAX 28

enum { KS_GROUP = 0, KS_TEXT, KS_IMAGE, KS_DISC, KS_LINE, KS_RECT };

typedef struct {
  float x, y, sx, sy, rot;
  bool valid;
} ks_hist_t;

typedef struct ks_node {
  char id[KS_ID_MAX];
  uint32_t idh;     /* hash of the id: the lookup compares this before strcmp */
  uint8_t kind;
  bool used;        /* slot taken */
  bool shown;       /* acquired this pass */
  bool shown_prev;  /* acquired last pass */
  bool visible_prev;/* drawn last pass (shown and alpha > 0) */
  bool retarget;    /* content changed this pass: a different word or picture is a different object, no join */
  uint16_t idle;    /* passes since anything asked for this node; the pool reclaims the oldest */
  int16_t parent;   /* node index or -1 */
  int16_t z;
  kch_t ch[KC_COUNT];
  /* content */
  const char *text;
  const ut_face_t *face;
  uint16_t ink;
  bool shadow;
  const uint16_t *img;
  uint16_t img_w, img_h;
  float w, h;                 /* natural box: text measured, image/rect as set */
  /* one glyph at a time */
  int16_t char_clip;          /* -1 none */
  int16_t stagger_ms;
  int64_t char_t0_us;
  /* procedural layer */
  kmo_mod_t mods[KS_MAX_MODS];
  int64_t mod_t0_us[KS_MAX_MODS];
  int16_t mod_target[KS_MAX_MODS]; /* FOLLOW: node index */
  bool mod_on[KS_MAX_MODS];
  uint32_t seed;
  /* persistence */
  uint8_t ghost;              /* 0..2 previous transforms drawn under the current */
  ks_hist_t hist[2];
} ks_node_t;

typedef struct {
  float x, y, sx, sy, rot, skew, alpha;
  int cx0, cy0, cx1, cy1;     /* clip rect, screen px */
} ks_xf_t;

typedef struct {
  uint32_t render_us, step_us, interval_us;
  uint32_t nodes_drawn, clips_active, pixels_tf;
  uint32_t missed;            /* passes that took longer than a frame */
  uint32_t frames;
  uint32_t worst_render_us;
} ks_perf_t;

static ks_node_t *s_ks;        /* KS_MAX_NODES, PSRAM */
static int s_ks_count;
static int64_t s_ks_now_us, s_ks_prev_us;
static ks_perf_t s_ks_perf;
static int s_ks_order[KS_MAX_NODES];

/* ------------------------------------------------------------------ */
/* Nodes                                                               */

/** FNV-1a over the id: the lookup's fast reject, and the node's own seed. */
static inline uint32_t ks_hash_id(const char *s) {
  uint32_t h = 0x811c9dc5u;
  for (; *s; s++) h = (h ^ (uint32_t)(unsigned char)*s) * 16777619u;
  return h;
}

static void ks_node_reset(ks_node_t *n, const char *id, int kind) {
  memset(n, 0, sizeof *n);
  snprintf(n->id, sizeof n->id, "%s", id);
  n->idh = ks_hash_id(n->id);
  n->kind = (uint8_t)kind;
  n->used = true;
  n->parent = -1;
  n->char_clip = -1;
  n->face = &UT_M;
  n->ink = 0xffff;
  n->seed = kmo_hash(n->idh ^ 0x9e37u);
  for (int c = 0; c < KC_COUNT; c++) {
    n->ch[c].pose = n->ch[c].v = n->ch[c].prev_drv_or_pose = kch_default(c);
  }
}

static bool ks_init(void) {
  if (s_ks) return true;
  s_ks = heap_caps_malloc(sizeof(ks_node_t) * KS_MAX_NODES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!s_ks) s_ks = malloc(sizeof(ks_node_t) * KS_MAX_NODES);
  if (!s_ks) return false;
  memset(s_ks, 0, sizeof(ks_node_t) * KS_MAX_NODES);
  return true;
}

static bool ks_bound(const ks_node_t *n);

/* A node nothing has asked for in this many passes is forgotten when the pool
 * needs the slot. Long enough that leaving a screen and coming straight back
 * finds the same objects with their continuity intact, short enough that a
 * card full of photographs cannot exhaust the pool: the ids are per capture,
 * so the set of possible nodes is as large as the card is. */
#define KS_IDLE_DEAD 180

/**
 * Take the slot of the node that has been forgotten longest.
 *
 * Never one a clip is driving, never one that is still somebody's parent -
 * parents are held as indices, so handing that slot to a new object would
 * silently reparent whatever pointed at it. Returns NULL when every slot is
 * genuinely in use, which is the case the pool size is supposed to cover.
 */
static ks_node_t *ks_reclaim(void) {
  int best = -1;
  for (int i = 0; i < s_ks_count; i++) {
    ks_node_t *n = &s_ks[i];
    if (!n->used || n->idle < KS_IDLE_DEAD || ks_bound(n)) continue;
    bool parented = false;
    for (int j = 0; j < s_ks_count && !parented; j++)
      if (s_ks[j].used && s_ks[j].parent == (int16_t)i && s_ks[j].idle < KS_IDLE_DEAD) parented = true;
    if (parented) continue;
    if (best < 0 || n->idle > s_ks[best].idle) best = i;
  }
  return best < 0 ? NULL : &s_ks[best];
}

/** The node called `id`, created on first sight; marked as in use this pass. */
static ks_node_t *ks_get(const char *id, int kind) {
  const uint32_t h = ks_hash_id(id);
  for (int i = 0; i < s_ks_count; i++) {
    ks_node_t *n = &s_ks[i];
    if (n->used && n->idh == h && strcmp(n->id, id) == 0) {
      n->shown = true;
      n->idle = 0;
      return n;
    }
  }
  ks_node_t *n;
  if (s_ks_count < KS_MAX_NODES) {
    n = &s_ks[s_ks_count++];
  } else {
    n = ks_reclaim();
    if (n == NULL) return &s_ks[0]; /* every slot alive at once: the pool is undersized */
  }
  ks_node_reset(n, id, kind);
  n->shown = true;
  return n;
}

/** Acquire without showing: for a node another node follows, or a clip binds. */
static ks_node_t *ks_peek(const char *id) {
  const uint32_t h = ks_hash_id(id);
  for (int i = 0; i < s_ks_count; i++)
    if (s_ks[i].used && s_ks[i].idh == h && strcmp(s_ks[i].id, id) == 0) return &s_ks[i];
  return NULL;
}


static inline int ks_index(const ks_node_t *n) { return (int)(n - s_ks); }
static inline void ks_pose(ks_node_t *n, int ch, float v) { n->ch[ch].pose = v; }
static inline float ks_val(const ks_node_t *n, int ch) { return n->ch[ch].v; }
static inline void ks_parent(ks_node_t *n, const ks_node_t *p) { n->parent = p ? (int16_t)ks_index(p) : -1; }

/** Place: pose x, y, and the anchor as fractions of the natural box. */
static inline void ks_place(ks_node_t *n, float x, float y, float ax, float ay) {
  ks_pose(n, KC_X, x);
  ks_pose(n, KC_Y, y);
  ks_pose(n, KC_AX, ax);
  ks_pose(n, KC_AY, ay);
}

static inline void ks_text(ks_node_t *n, const char *s, const ut_face_t *f, uint16_t ink) {
  if (n->text != s && (n->text == NULL || s == NULL || strcmp(n->text, s) != 0)) n->retarget = true;
  n->text = s;
  n->face = f;
  n->ink = ink;
  n->w = (float)ut_w(f, s);
  n->h = (float)f->em;
}

/**
 * The same photograph at a different level of detail: the thumbnail the roll
 * decoded and the full-size read of the same capture are one object, so
 * swapping one for the other must NOT count as a change of subject.
 */
static inline void ks_image_lod(ks_node_t *n, const uint16_t *px, int w, int h, float box_w, float box_h) {
  n->img = px;
  n->img_w = (uint16_t)w;
  n->img_h = (uint16_t)h;
  n->w = box_w;
  n->h = box_h;
}

static inline void ks_image(ks_node_t *n, const uint16_t *px, int w, int h, float box_w, float box_h) {
  if (n->img != px) n->retarget = true;
  n->img = px;
  n->img_w = (uint16_t)w;
  n->img_h = (uint16_t)h;
  n->w = box_w;
  n->h = box_h;
}

/** Forget continuity: the next value is taken as is. For a node that is re-purposed. */
static void ks_snap(ks_node_t *n) {
  for (int c = 0; c < KC_COUNT; c++) {
    n->ch[c].off = n->ch[c].off_v = 0.f;
    n->ch[c].vel = 0.f;
    n->ch[c].v = n->ch[c].prev_drv_or_pose = n->ch[c].pose;
    n->ch[c].was_driven = false;
  }
  n->visible_prev = false;
  n->hist[0].valid = n->hist[1].valid = false;
}

/** Add velocity to a channel: a push the continuity spring then damps. */
static inline void ks_impulse(ks_node_t *n, int ch, float vel_per_ms) { n->ch[ch].off_v += vel_per_ms; }

/** Set one glyph at a time: `clip` drives role "char" with time offset stagger*i. */
static void ks_text_stagger(ks_node_t *n, int clip, int stagger_ms, int64_t now_us) {
  n->char_clip = (int16_t)clip;
  n->stagger_ms = (int16_t)stagger_ms;
  n->char_t0_us = now_us;
}

/** Install a procedural modifier on a node, from now, for `dur_ms` (0 = until removed). */
static void ks_mod(ks_node_t *n, const kmo_mod_t *m, int64_t now_us, int target_node) {
  for (int i = 0; i < KS_MAX_MODS; i++) {
    if (n->mod_on[i] && n->mods[i].kind == m->kind && n->mods[i].a[3] == m->a[3]) {
      n->mods[i] = *m; n->mod_t0_us[i] = now_us; n->mod_target[i] = (int16_t)target_node; return;
    }
  }
  for (int i = 0; i < KS_MAX_MODS; i++) {
    if (!n->mod_on[i]) {
      n->mods[i] = *m; n->mod_t0_us[i] = now_us; n->mod_target[i] = (int16_t)target_node; n->mod_on[i] = true;
      return;
    }
  }
}

/** Take every modifier off a node: what set them is no longer the case. */
static void ks_mod_clear(ks_node_t *n) {
  for (int i = 0; i < KS_MAX_MODS; i++) n->mod_on[i] = false;
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */

/** Start `clip` with the given params and role bindings. Returns the instance or NULL. */
static kmo_inst_t *ks_play(int clip, const char *tag, const float *params, ks_node_t *const *nodes,
                           const char *const *roles, int nbind) {
  if (clip < 0 || clip >= KMO_CLIP_COUNT) return NULL;
  /* A free slot, or - when every one is running - the oldest, which gives
   * way. Continuity makes that survivable: whatever it was driving carries
   * on from where it is. Written as an index so the pointer is never NULL. */
  int slot = -1;
  for (int i = 0; i < KMO_MAX_INST; i++)
    if (!s_kmo_inst[i].active) { slot = i; break; }
  if (slot < 0) {
    slot = 0;
    for (int i = 1; i < KMO_MAX_INST; i++)
      if (s_kmo_inst[i].t0_us < s_kmo_inst[slot].t0_us) slot = i;
  }
  kmo_inst_t *in = &s_kmo_inst[slot];
  memset(in, 0, sizeof *in);
  in->active = true;
  in->clip = (uint16_t)clip;
  in->t0_us = s_ks_now_us;
  in->holding = -1;
  in->tag = tag;
  if (params) memcpy(in->params, params, sizeof in->params);
  for (int i = 0; i < nbind && i < KMO_MAX_BIND; i++) {
    const int r = kmo_role_index(roles[i]);
    if (r < 0 || nodes[i] == NULL) continue;
    in->bind[in->nbind] = nodes[i];
    in->bind_role[in->nbind] = (uint8_t)r;
    in->nbind++;
  }
  /* Its modifiers go on the bound nodes now, windowed by the clip's own clock. */
  const kmo_clip_t *c = &KMO_CLIPS[clip];
  for (int m = 0; m < c->nmods; m++) {
    const kmo_mod_t *md = &KMO_MODS[c->mod0 + m];
    for (int b = 0; b < in->nbind; b++) {
      if (in->bind_role[b] != md->role) continue;
      int target = -1;
      if (md->kind == KM_FOLLOW)
        for (int t = 0; t < in->nbind; t++)
          if (in->bind_role[t] == (uint8_t)(int)md->a[0]) target = ks_index(in->bind[t]);
      ks_mod(in->bind[b], md, in->t0_us, target);
    }
  }
  return in;
}

/** Convenience: one role, one node. */
static kmo_inst_t *ks_play1(int clip, const char *tag, ks_node_t *n, const char *role, const float *params) {
  ks_node_t *ns[1] = {n};
  const char *rs[1] = {role};
  return ks_play(clip, tag, params, ns, rs, 1);
}

static void ks_stop_tag(const char *tag) {
  for (int i = 0; i < KMO_MAX_INST; i++)
    if (s_kmo_inst[i].active && s_kmo_inst[i].tag && strcmp(s_kmo_inst[i].tag, tag) == 0) s_kmo_inst[i].active = false;
}

/**
 * Tell every instance started under `tag` that `gate` has happened. The real
 * event, not a timer: the choreography was waiting for exactly this.
 */
static void ks_open_gate(const char *tag, const char *gate) {
  int gi = -1;
  for (int i = 0; i < KMO_GATE_COUNT; i++)
    if (strcmp(KMO_GATE_NAMES[i], gate) == 0) { gi = i; break; }
  if (gi < 0) return;
  for (int i = 0; i < KMO_MAX_INST; i++) {
    kmo_inst_t *in = &s_kmo_inst[i];
    if (!in->active) continue;
    if (tag && (in->tag == NULL || strcmp(in->tag, tag) != 0)) continue;
    const kmo_clip_t *c = &KMO_CLIPS[in->clip];
    for (int g = 0; g < c->ngates; g++)
      if (KMO_GATES[c->gate0 + g].gate == (uint8_t)gi) in->gates_open |= 1u << g;
  }
}

/** True while any instance under `tag` is waiting for something real. */
static bool ks_holding_tag(const char *tag) {
  for (int i = 0; i < KMO_MAX_INST; i++) {
    const kmo_inst_t *in = &s_kmo_inst[i];
    if (!in->active || in->holding < 0) continue;
    if (tag == NULL || (in->tag && strcmp(in->tag, tag) == 0)) return true;
  }
  return false;
}

static bool ks_playing_tag(const char *tag) {
  for (int i = 0; i < KMO_MAX_INST; i++)
    if (s_kmo_inst[i].active && s_kmo_inst[i].tag && strcmp(s_kmo_inst[i].tag, tag) == 0) return true;
  return false;
}

static bool ks_bound(const ks_node_t *n) {
  for (int i = 0; i < KMO_MAX_INST; i++) {
    const kmo_inst_t *in = &s_kmo_inst[i];
    if (!in->active) continue;
    for (int b = 0; b < in->nbind; b++)
      if (in->bind[b] == n) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The step: tracks -> channels, continuity, modifiers                  */

static void ks_begin(int64_t now_us) {
  s_ks_prev_us = s_ks_now_us ? s_ks_now_us : now_us - 16000;
  s_ks_now_us = now_us;
  s_kmo_now_us = now_us;
  s_kmo_dt_ms = (float)(now_us - s_ks_prev_us) / 1000.f;
  if (s_kmo_dt_ms > 50.f) s_kmo_dt_ms = 50.f;
  if (s_kmo_dt_ms < 1.f) s_kmo_dt_ms = 1.f;
  for (int i = 0; i < s_ks_count; i++) {
    s_ks[i].shown_prev = s_ks[i].shown;
    s_ks[i].shown = false;
    if (s_ks[i].shown_prev) s_ks[i].idle = 0;
    else if (s_ks[i].idle < 0xffff) s_ks[i].idle++;
  }
}

/** Critically damped decay of a continuity offset, sub-stepped. */
static inline void ks_decay(kch_t *c, float omega, float dt_ms) {
  float remaining = dt_ms;
  while (remaining > 0.f) {
    const float h = remaining > 4.f ? 4.f : remaining;
    const float hs = h / 1000.f;
    const float acc = -2.f * omega * c->off_v - omega * omega * c->off;
    c->off_v += acc * hs;
    c->off += c->off_v * hs;
    remaining -= h;
  }
  if (fabsf(c->off) < 0.02f && fabsf(c->off_v) < 0.5f) { c->off = 0.f; c->off_v = 0.f; }
}

static void ks_apply_tracks(void) {
  /* Instances in start order, so a later clip on the same channel wins. */
  int order[KMO_MAX_INST], n = 0;
  for (int i = 0; i < KMO_MAX_INST; i++) if (s_kmo_inst[i].active) order[n++] = i;
  for (int a = 1; a < n; a++)
    for (int b = a; b > 0 && s_kmo_inst[order[b - 1]].t0_us > s_kmo_inst[order[b]].t0_us; b--) {
      const int t = order[b]; order[b] = order[b - 1]; order[b - 1] = t;
    }
  s_ks_perf.clips_active = (uint32_t)n;
  for (int oi = 0; oi < n; oi++) {
    kmo_inst_t *in = &s_kmo_inst[order[oi]];
    const kmo_clip_t *c = &KMO_CLIPS[in->clip];
    kmo_inst_advance(in);
    const float t = kmo_inst_time(in);
    const float raw_ms = (float)(s_kmo_now_us - in->t0_us - in->held_us) / 1000.f;
    /* Sounds land on the frame their marker is crossed. */
    for (int s = 0; s < c->nsounds && s < 32; s++) {
      if (in->sounds_fired & (1u << s)) continue;
      if (t >= (float)KMO_SOUNDS[c->sound0 + s].t) {
        in->sounds_fired |= 1u << s;
        if (s_kmo_sound) s_kmo_sound(KMO_SOUNDS[c->sound0 + s].cue);
      }
    }
    if (raw_ms > (float)c->dur && !c->hold_end) { in->active = false; continue; }
    s_kmo_live++;
    for (int ti = 0; ti < c->ntracks; ti++) {
      const kmo_track_t *tr = &KMO_TRACKS[c->track0 + ti];
      ks_node_t *node = NULL;
      for (int b = 0; b < in->nbind; b++) if (in->bind_role[b] == tr->role) { node = in->bind[b]; break; }
      if (!node) continue;
      const float v = kmo_track_eval(tr, t, in->params);
      if (tr->path) {
        float px, py, tan;
        kmo_path_eval(tr->path - 1, v, &px, &py, &tan);
        node->ch[KC_X].add += px * s_kmo_vigour;
        node->ch[KC_Y].add += py * s_kmo_vigour;
        if (tr->add == 2) node->ch[KC_ROT].add += tan;
        node->ch[KC_PATH_U].drv = v; node->ch[KC_PATH_U].driven = true;
      } else if (tr->add) {
        node->ch[tr->ch].add += v * s_kmo_vigour;
      } else {
        node->ch[tr->ch].drv = v;
        node->ch[tr->ch].driven = true;
      }
    }
  }
}

static void ks_apply_mods(ks_node_t *n) {
  for (int i = 0; i < KS_MAX_MODS; i++) {
    if (!n->mod_on[i]) continue;
    const kmo_mod_t *m = &n->mods[i];
    const float ms = (float)(s_ks_now_us - n->mod_t0_us[i]) / 1000.f;
    if (ms < (float)m->from) continue;
    if (m->to && ms > (float)m->to) { n->mod_on[i] = false; continue; }
    const float ts = ms / 1000.f;
    /* Fade in over the first 60 ms and out over the last 120 so a modifier
     * never switches on or off as a step. */
    float g = 1.f;
    if (ms - (float)m->from < 60.f) g = (ms - (float)m->from) / 60.f;
    if (m->to && (float)m->to - ms < 120.f) g *= ((float)m->to - ms) / 120.f;
    switch (m->kind) {
      case KM_NOISE:
        n->ch[KC_X].mod += g * m->a[0] * kmo_noise(n->seed + 1, m->freq, ts);
        n->ch[KC_Y].mod += g * m->a[1] * kmo_noise(n->seed + 2, m->freq, ts);
        n->ch[KC_ROT].mod += g * m->a[2] * kmo_noise(n->seed + 3, m->freq, ts);
        n->ch[KC_SX].mod += g * m->a[3] * kmo_noise(n->seed + 4, m->freq, ts);
        n->ch[KC_SY].mod += g * m->a[3] * kmo_noise(n->seed + 5, m->freq * 1.3f, ts);
        s_kmo_live++;
        break;
      case KM_BOIL:
        /* Line ends wander independently, a little, at a few Hz: the drawn
         * line, not the whole object. */
        n->ch[KC_X].mod += g * m->a[0] * kmo_noise(n->seed + 11, m->freq, ts);
        n->ch[KC_Y].mod += g * m->a[1] * kmo_noise(n->seed + 12, m->freq, ts);
        n->ch[KC_P0].mod += g * m->a[0] * kmo_noise(n->seed + 13, m->freq, ts);
        n->ch[KC_P1].mod += g * m->a[1] * kmo_noise(n->seed + 14, m->freq, ts);
        n->ch[KC_LINE_W].mod += g * m->a[2] * kmo_noise(n->seed + 15, m->freq * 0.7f, ts);
        s_kmo_live++;
        break;
      case KM_OSC: {
        /* amp, f, zeta, channel: a damped oscillation from the moment it was set. */
        const float f = m->a[1] > 0.f ? m->a[1] : 3.f, z = m->a[2];
        const float w = 2.f * 3.14159265f * f;
        const float tt = (ms - (float)m->from) / 1000.f;
        const float val = m->a[0] * expf(-z * w * tt) * sinf(w * tt);
        const int ch = (int)m->a[3];
        if (ch >= 0 && ch < KC_COUNT) n->ch[ch].mod += g * val;
        if (fabsf(m->a[0] * expf(-z * w * tt)) < 0.05f) n->mod_on[i] = false;
        s_kmo_live++;
        break;
      }
      case KM_FOLLOW: {
        /* Inherit the target's departure from its pose, late: an exponential
         * approach with time constant a[1] ms, on x, y and rotation. */
        const int ti = n->mod_target[i];
        if (ti < 0 || ti >= s_ks_count) break;
        const ks_node_t *t = &s_ks[ti];
        const float k = 1.f - expf(-s_kmo_dt_ms / (m->a[1] > 0.f ? m->a[1] : 60.f));
        n->ch[KC_P2].v += ((t->ch[KC_X].v - t->ch[KC_X].pose) - n->ch[KC_P2].v) * k; /* P2/P3: the follower's own memory */
        n->ch[KC_P3].v += ((t->ch[KC_Y].v - t->ch[KC_Y].pose) - n->ch[KC_P3].v) * k;
        n->ch[KC_X].mod += n->ch[KC_P2].v * g;
        n->ch[KC_Y].mod += n->ch[KC_P3].v * g;
        if (fabsf(n->ch[KC_P2].v) > 0.05f || fabsf(n->ch[KC_P3].v) > 0.05f) s_kmo_live++;
        break;
      }
      default: break;
    }
  }
}

static void ks_step_node(ks_node_t *n) {
  const bool live = n->shown || ks_bound(n);
  ks_apply_mods(n);
  for (int c = 0; c < KC_COUNT; c++) {
    kch_t *ch = &n->ch[c];
    if (c == KC_P2 || c == KC_P3) {
      /* followers keep their memory here; a plain pose otherwise */
      if (!n->mod_on[0] && !n->mod_on[1] && !n->mod_on[2]) ch->v = ch->pose;
      ch->driven = false; ch->add = 0.f; ch->mod = 0.f;
      continue;
    }
    const float target = ch->driven ? ch->drv : ch->pose;
    if (!live || !n->visible_prev || n->retarget) {
      /* Off screen, or just arriving: taken as is. */
      ch->off = 0.f; ch->off_v = 0.f;
      ch->vel = 0.f;
    } else {
      /* The join: whatever the object was following, it now follows this.
       * The difference and its speed go into the offset, which decays. */
      const float jump = ch->prev_drv_or_pose - target;
      if (fabsf(jump) > 1e-4f && (c != KC_ALPHA || fabsf(jump) > 8.f)) {
        ch->off += jump;
        if (ch->driven != ch->was_driven) ch->off_v += ch->vel; /* a clip starting or ending keeps the speed */
      }
      ks_decay(ch, kch_omega(c), s_kmo_dt_ms);
      if (fabsf(ch->off) > 0.05f) s_kmo_live++;
    }
    const float v = target + ch->add + ch->off + ch->mod;
    ch->vel = (v - ch->v) / s_kmo_dt_ms;
    ch->v = v;
    ch->prev_drv_or_pose = target;
    ch->was_driven = ch->driven;
    ch->driven = false;
    ch->add = 0.f;
    ch->mod = 0.f;
  }
  n->retarget = false;
}

/* ------------------------------------------------------------------ */
/* World transforms                                                    */

static void ks_world(const ks_node_t *n, ks_xf_t *out) {
  ks_xf_t w;
  if (n->parent >= 0 && n->parent < s_ks_count) ks_world(&s_ks[n->parent], &w);
  else { w.x = 0; w.y = 0; w.sx = 1; w.sy = 1; w.rot = 0; w.skew = 0; w.alpha = 1.f; w.cx0 = 0; w.cy0 = 0; w.cx1 = UI_W; w.cy1 = UI_H; }
  const float lx = n->ch[KC_X].v * w.sx, ly = n->ch[KC_Y].v * w.sy;
  const float r = w.rot * 3.14159265f / 180.f, cs = cosf(r), sn = sinf(r);
  out->x = w.x + lx * cs - ly * sn;
  out->y = w.y + lx * sn + ly * cs;
  out->sx = w.sx * n->ch[KC_SX].v;
  out->sy = w.sy * n->ch[KC_SY].v;
  out->rot = w.rot + n->ch[KC_ROT].v;
  out->skew = w.skew + n->ch[KC_SKEW].v;
  float a = n->ch[KC_ALPHA].v;
  if (a < 0.f) a = 0.f;
  if (a > 255.f) a = 255.f;
  out->alpha = w.alpha * (a / 255.f);
  out->cx0 = w.cx0; out->cy0 = w.cy0; out->cx1 = w.cx1; out->cy1 = w.cy1;
  const float mx0 = n->ch[KC_MX0].v, my0 = n->ch[KC_MY0].v, mx1 = n->ch[KC_MX1].v, my1 = n->ch[KC_MY1].v;
  if (mx1 > mx0 || my1 > my0) {
    const int x0 = (int)floorf(out->x + mx0 * out->sx), y0 = (int)floorf(out->y + my0 * out->sy);
    const int x1 = (int)ceilf(out->x + mx1 * out->sx), y1 = (int)ceilf(out->y + my1 * out->sy);
    if (x0 > out->cx0) out->cx0 = x0;
    if (y0 > out->cy0) out->cy0 = y0;
    if (x1 < out->cx1) out->cx1 = x1;
    if (y1 < out->cy1) out->cy1 = y1;
  }
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */

/** The centre of the natural box, given the anchor point is at (x, y) in world. */
static inline void ks_box_centre(const ks_node_t *n, const ks_xf_t *w, float *cx, float *cy) {
  const float ox = (0.5f - n->ch[KC_AX].v) * n->w * w->sx, oy = (0.5f - n->ch[KC_AY].v) * n->h * w->sy;
  const float r = w->rot * 3.14159265f / 180.f, cs = cosf(r), sn = sinf(r);
  *cx = w->x + ox * cs - oy * sn;
  *cy = w->y + ox * sn + oy * cs;
}

static void ks_draw_text(ks_node_t *n, const ks_xf_t *w) {
  if (!n->text || !n->text[0]) return;
  const int alpha = (int)(w->alpha * 255.f + 0.5f);
  if (alpha <= 0) return;
  const float track = n->ch[KC_TRACK].v;
  const float rgb = n->ch[KC_RGB].v;
  /* The fast path is a direct glyph blit with no mask behind it, so it cannot
   * draw a contour. Text that says it is over a picture therefore does not
   * take it - which is most of the text that needs the contour, since the
   * words in the finder sit still at their natural size. This was silently
   * dropping every shadow the interface asked for. */
  const bool plain = !n->shadow && fabsf(w->sx - 1.f) < 0.002f && fabsf(w->sy - 1.f) < 0.002f &&
                     fabsf(w->rot) < 0.01f && fabsf(w->skew) < 0.01f && fabsf(rgb) < 0.1f &&
                     n->char_clip < 0 && fabsf(track) < 0.1f;
  const float tw = n->w + track * (float)(ut_len(n->text) - 1);
  float cx, cy;
  {
    const float ox = (0.5f - n->ch[KC_AX].v) * tw * w->sx, oy = (0.5f - n->ch[KC_AY].v) * n->h * w->sy;
    const float r = w->rot * 3.14159265f / 180.f, cs = cosf(r), sn = sinf(r);
    cx = w->x + ox * cs - oy * sn;
    cy = w->y + ox * sn + oy * cs;
  }
  if (plain) {
    ut_draw_a(n->face, (int)lroundf(cx - tw * 0.5f), (int)lroundf(cy - n->h * 0.5f), n->text, n->ink, alpha);
    return;
  }
  if (n->char_clip < 0 && fabsf(track) < 0.1f) {
    ut_fx2(n->face, cx, cy, n->text, w->sx, w->sy, w->rot, w->skew, n->ink, alpha, n->shadow, (int)rgb);
    return;
  }
  /* One glyph at a time: pen along the (rotated, scaled) baseline, each
   * glyph with its own offsets from the char clip at its own time. */
  const float r = w->rot * 3.14159265f / 180.f, cs = cosf(r), sn = sinf(r);
  float pen = -tw * 0.5f * w->sx; /* along the box, from its centre */
  const char *s = n->text;
  int i = 0;
  char one[8];
  float cv[KC_COUNT];
  while (*s) {
    const char *at = s;
    const uint32_t cp = utf8_next(&s);
    (void)cp;
    const size_t nb = (size_t)(s - at);
    memcpy(one, at, nb);
    one[nb] = 0;
    const float adv = (float)ut_w(n->face, one);
    float dx = 0.f, dy = 0.f, drot = 0.f, dsx = 1.f, dsy = 1.f, dal = 1.f;
    if (n->char_clip >= 0) {
      const float t = (float)(s_ks_now_us - n->char_t0_us) / 1000.f - (float)i * (float)n->stagger_ms;
      const kmo_clip_t *c = &KMO_CLIPS[n->char_clip];
      for (int k = 0; k < KC_COUNT; k++) cv[k] = kch_default(k);
      const int role_char = kmo_role_index("char");
      for (int ti = 0; ti < c->ntracks; ti++) {
        const kmo_track_t *tr = &KMO_TRACKS[c->track0 + ti];
        if (tr->role != role_char || tr->path) continue;
        const float v = kmo_track_eval(tr, t < 0.f ? 0.f : t, NULL);
        if (tr->add) cv[tr->ch] += v; else cv[tr->ch] = v;
      }
      if (t < (float)c->dur) s_kmo_live++;
      dx = cv[KC_X]; dy = cv[KC_Y]; drot = cv[KC_ROT]; dsx = cv[KC_SX]; dsy = cv[KC_SY]; dal = cv[KC_ALPHA] / 255.f;
    }
    const float gx = pen + (adv * 0.5f) * w->sx + dx * w->sx, gy = dy * w->sy;
    const float px = cx + gx * cs - gy * sn, py = cy + gx * sn + gy * cs;
    const int a = (int)(alpha * dal);
    if (a > 0)
      ut_fx2(n->face, px, py, one, w->sx * dsx, w->sy * dsy, w->rot + drot, w->skew, n->ink, a, n->shadow, (int)rgb);
    pen += (adv + track) * w->sx;
    i++;
  }
}

/** The image node's box through its transform. */
static void ks_draw_image(ks_node_t *n, const ks_xf_t *w, float ax, float ay, float sx, float sy, float rot, float alpha) {
  if (!n->img || n->w <= 0.f || n->h <= 0.f) return;
  const float ox = (0.5f - n->ch[KC_AX].v) * n->w * sx, oy = (0.5f - n->ch[KC_AY].v) * n->h * sy;
  const float r = rot * 3.14159265f / 180.f, cs = cosf(r), sn = sinf(r);
  const float cx = ax + ox * cs - oy * sn, cy = ay + ox * sn + oy * cs;
  const float c0x = n->ch[KC_CX0].v, c0y = n->ch[KC_CY0].v;
  float c1x = n->ch[KC_CX1].v, c1y = n->ch[KC_CY1].v;
  if (c1x <= c0x) c1x = 1.f;
  if (c1y <= c0y) c1y = 1.f;
  img_blit_tf(n->img, n->img_w, n->img_h, c0x, c0y, c1x, c1y, cx, cy, n->w * sx, n->h * sy, rot, w->skew,
              n->ch[KC_STRIP_AMP].v, n->ch[KC_STRIP_FREQ].v, n->ch[KC_STRIP_PH].v, (int)n->ch[KC_RGB].v,
              (int)(alpha * 255.f + 0.5f), (int)n->ch[KC_P0].v, n->ch[KC_P1].v);
}

static void ks_draw_node(ks_node_t *n) {
  ks_xf_t w;
  ks_world(n, &w);
  if (w.alpha <= 0.002f) return;
  if (w.cx0 >= w.cx1 || w.cy0 >= w.cy1) return;
  const int save[4] = {s_clip_x0, s_clip_y0, s_clip_x1, s_clip_y1};
  s_clip_x0 = w.cx0 > 0 ? w.cx0 : 0;
  s_clip_y0 = w.cy0 > 0 ? w.cy0 : 0;
  s_clip_x1 = w.cx1 < UI_W ? w.cx1 : UI_W;
  s_clip_y1 = w.cy1 < UI_H ? w.cy1 : UI_H;
  /* Below this the blend cannot move a 5-bit channel, so the draw is cost
   * without a picture - and a pile of them used to be a picture. */
  if (w.alpha < 0.008f) { s_clip_x0 = save[0]; s_clip_y0 = save[1]; s_clip_x1 = save[2]; s_clip_y1 = save[3]; return; }
  switch (n->kind) {
    case KS_TEXT: ks_draw_text(n, &w); break;
    case KS_IMAGE: {
      /* A trace is of THIS movement. An object that was not on screen last
       * pass has no trace, whatever is left in its history: without this, the
       * first frame of a capture drags a ghost of where these panes were in
       * some other state entirely, which reads as a rectangle from nowhere. */
      if (!n->visible_prev) { n->hist[0].valid = false; n->hist[1].valid = false; }
      /* Ghosts first: where the object was, fainter. */
      for (int g = n->ghost; g >= 1; g--) {
        const ks_hist_t *h = &n->hist[g - 1];
        if (h->valid) ks_draw_image(n, &w, h->x, h->y, h->sx, h->sy, h->rot, w.alpha * (g == 1 ? 0.35f : 0.18f));
      }
      ks_draw_image(n, &w, w.x, w.y, w.sx, w.sy, w.rot, w.alpha);
      break;
    }
    case KS_DISC: disc(w.x, w.y, n->ch[KC_R].v * w.sx, n->ink, (int)(w.alpha * 255.f + 0.5f)); break;
    case KS_LINE: {
      const float ex = n->ch[KC_P0].v * w.sx, ey = n->ch[KC_P1].v * w.sy;
      const float r = w.rot * 3.14159265f / 180.f, cs = cosf(r), sn = sinf(r);
      line_aa(w.x, w.y, w.x + ex * cs - ey * sn, w.y + ex * sn + ey * cs, n->ch[KC_LINE_W].v, n->ink,
              (int)(w.alpha * 255.f + 0.5f));
      break;
    }
    case KS_RECT: {
      const float bw = n->w * w.sx, bh = n->h * w.sy;
      const int x = (int)lroundf(w.x - n->ch[KC_AX].v * bw), y = (int)lroundf(w.y - n->ch[KC_AY].v * bh);
      fill_a(x, y, (int)lroundf(bw), (int)lroundf(bh), n->ink, (int)(w.alpha * 255.f + 0.5f));
      break;
    }
    default: break;
  }
  s_clip_x0 = save[0]; s_clip_y0 = save[1]; s_clip_x1 = save[2]; s_clip_y1 = save[3];
  s_ks_perf.nodes_drawn++;
  if (n->ghost) {
    n->hist[1] = n->hist[0];
    n->hist[0] = (ks_hist_t){w.x, w.y, w.sx, w.sy, w.rot, true};
  }
}

/** Step every node and draw the tree. Call once per pass after the screens have posed. */
static void ks_render(void) {
  const int64_t t0 = esp_timer_get_time();
  s_ks_perf.nodes_drawn = 0;
  s_kd_pixels = 0;
  /* Tracks first (they set drv/add), then each node's step. */
  ks_apply_tracks();
  for (int i = 0; i < s_ks_count; i++) {
    ks_node_t *n = &s_ks[i];
    if (!n->used) continue;
    ks_step_node(n);
  }
  const int64_t t1 = esp_timer_get_time();
  /* z order, stable. */
  int cnt = 0;
  for (int i = 0; i < s_ks_count; i++) if (s_ks[i].used && (s_ks[i].shown || ks_bound(&s_ks[i]))) s_ks_order[cnt++] = i;
  for (int a = 1; a < cnt; a++)
    for (int b = a; b > 0 && s_ks[s_ks_order[b - 1]].z > s_ks[s_ks_order[b]].z; b--) {
      const int t = s_ks_order[b]; s_ks_order[b] = s_ks_order[b - 1]; s_ks_order[b - 1] = t;
    }
  for (int i = 0; i < cnt; i++) ks_draw_node(&s_ks[s_ks_order[i]]);
  for (int i = 0; i < s_ks_count; i++) {
    ks_node_t *n = &s_ks[i];
    const bool drawn = n->used && (n->shown || ks_bound(n)) && n->ch[KC_ALPHA].v > 0.5f;
    n->visible_prev = drawn;
    if (!drawn) { n->hist[0].valid = n->hist[1].valid = false; }
  }
  const int64_t t2 = esp_timer_get_time();
  s_ks_perf.pixels_tf = s_kd_pixels;
  s_ks_perf.step_us = (uint32_t)(t1 - t0);
  s_ks_perf.render_us = (uint32_t)(t2 - t1);
  s_ks_perf.interval_us = (uint32_t)(s_ks_now_us - s_ks_prev_us);
  s_ks_perf.frames++;
  if (s_ks_perf.render_us + s_ks_perf.step_us > s_ks_perf.worst_render_us) s_ks_perf.worst_render_us = s_ks_perf.render_us + s_ks_perf.step_us;
  if (s_ks_perf.render_us + s_ks_perf.step_us > 16000) s_ks_perf.missed++;
}
