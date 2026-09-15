// KINO motion: the animation runtime under the interface.
//
// Not a transition library. Objects (kscene.h nodes) own CHANNELS - x, y,
// scale, rotation, opacity, anchor, skew, tracking, mask, crop, colour
// separation, strip deformation, line width, radius, position along a path,
// and four free parameters - and every channel is driven, independently in
// time, by TRACKS: multi-keyframe curves authored as data (behaviors/*.json ->
// kmo_data.h), evaluated as pure functions of clip time. A CLIP is a set of
// tracks over a set of ROLES, plus sound markers and an optional time warp;
// an INSTANCE binds roles to real nodes and runs the clip from a moment.
//
// Three things make this different from "start -> end with an ease":
//
//   Keyframes.  A track may have any number of keys; each segment chooses
//               its own interpolation - linear, a Bezier or sampled curve,
//               hold, stepped, Catmull-Rom smooth, an analytic underdamped
//               spring, exponential smoothing. A snap is a hold followed by
//               a key. Nothing forces motion to be smooth.
//
//   Continuity. A channel's value is the driven value plus a CONTINUITY
//               OFFSET. Whenever the driven value would jump - a clip starts,
//               one interrupts another, a clip ends, the screen moves an
//               object's resting pose - the offset absorbs the jump and its
//               velocity and decays critically damped. The object therefore
//               continues from where it is, at the speed it had, into
//               whatever comes next. The user can change mode three times in
//               a second and it still reads as one thing.
//
//   Layers.     value = pose (the screen's) or track (absolute), + additive
//               tracks, + continuity, + impulses, + procedural modifiers
//               (noise, damped oscillation, follow). Several sources move one
//               object at once and the sum is the pose.
//
// Everything here is time-stateless where it can be (tracks, curves, paths,
// noise) so a host film is exactly what the camera shows, and stateful only
// where state IS the point (continuity, impulses, followers).
#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* Channels                                                            */

enum {
  KC_X = 0, KC_Y, KC_SX, KC_SY, KC_ROT, KC_ALPHA, KC_AX, KC_AY, KC_SKEW, KC_TRACK,
  KC_MX0, KC_MY0, KC_MX1, KC_MY1,   /* mask rect, node space, 0/0/0/0 = none */
  KC_CX0, KC_CY0, KC_CX1, KC_CY1,   /* image crop, fractions 0..1; all 0 = full */
  KC_RGB,                           /* colour separation, px */
  KC_STRIP_AMP, KC_STRIP_FREQ, KC_STRIP_PH, /* per-row x offset: amp*sin(row*freq+ph) */
  KC_LINE_W, KC_R, KC_PATH_U,
  KC_P0, KC_P1, KC_P2, KC_P3,
  KC_COUNT
};

/* One channel's state. `pose` is the screen's resting value, set every pass;
 * `drv` is what an absolute track says this pass (valid when `driven`);
 * `add` sums additive tracks; `off`/`off_v` is the continuity spring; `mod`
 * is the procedural layer. `v` is the result; `vel` its velocity. */
typedef struct {
  float pose;
  float drv;
  float add;
  float off, off_v;
  float mod;
  float v, vel;
  float prev_drv_or_pose; /* what the object was following last pass, for the join */
  bool driven, was_driven;
} kch_t;

/* How fast a continuity offset dies, per channel kind: position and rotation
 * take longer than opacity, which should not visibly lag. Critically damped,
 * omega = 2*pi*f. */
static inline float kch_omega(int ch) {
  switch (ch) {
    case KC_ALPHA: return 2.f * 3.14159265f * 7.f;
    case KC_SX: case KC_SY: return 2.f * 3.14159265f * 5.f;
    default: return 2.f * 3.14159265f * 3.5f;
  }
}

static inline float kch_default(int ch) {
  switch (ch) {
    case KC_SX: case KC_SY: return 1.f;
    case KC_ALPHA: return 255.f;
    case KC_CX1: case KC_CY1: return 1.f;
    case KC_LINE_W: return 1.f;
    case KC_R: return 4.f;
    default: return 0.f;
  }
}

/* ------------------------------------------------------------------ */
/* Baked data types (kmo_data.h fills the arrays)                       */

enum { KI_LIN = 0, KI_CURVE, KI_HOLD, KI_STEP, KI_SMOOTH, KI_SPRING, KI_EXP };
enum { KCV_BEZIER = 0, KCV_SAMPLES, KCV_POW };
enum { KP_POLY = 0, KP_QUAD };
enum { KM_NONE = 0, KM_NOISE, KM_OSC, KM_BOIL, KM_FOLLOW };
enum { KS_NONE = 0, KS_SYNC, KS_DONE, KS_TICK, KS_SHUTTER, KS_WARN };

typedef struct {
  uint16_t t;      /* ms into the clip */
  float v;
  uint8_t interp;  /* KI_*, for the segment that starts here */
  uint8_t curve;   /* KI_CURVE: curve index; KI_STEP: step count */
  uint8_t pm;      /* 0 none, else v *= params[pm - 1] */
  float p0, p1;    /* KI_SPRING: f Hz, zeta; KI_EXP: tau ms */
} kmo_key_t;

typedef struct {
  uint8_t role;    /* index into KMO_ROLES */
  uint8_t ch;      /* KC_* */
  uint8_t add;     /* 1 = additive on top of the pose */
  uint8_t path;    /* 0 none, else path index + 1: the track drives PATH_U and x/y follow */
  uint16_t key0, nkeys;
} kmo_track_t;

typedef struct {
  uint16_t t;
  uint8_t cue;     /* KS_* */
} kmo_sound_t;

typedef struct {
  uint8_t role, kind;      /* KM_* */
  uint16_t from, to;       /* ms window within the clip; to = 0 means the clip's end */
  float a[4];              /* NOISE/BOIL: amp x, y, rot, scale; OSC: amp, f Hz, zeta, ch; FOLLOW: target role, lag ms */
  float freq;              /* NOISE/BOIL: Hz */
} kmo_mod_t;

typedef struct {
  const char *name;
  uint16_t dur;
  uint16_t track0, ntracks;
  uint16_t sound0, nsounds;
  uint16_t mod0, nmods;
  uint8_t warp;            /* 0 none, else curve index + 1: u -> u' */
  uint8_t hold_end;        /* 1 = the last values stay until the instance is stopped */
} kmo_clip_t;

typedef struct {
  uint8_t kind;    /* KCV_* */
  float p[4];      /* BEZIER: x1 y1 x2 y2; POW: exponent; SAMPLES: sample0 index, count */
} kmo_curve_t;

typedef struct {
  uint8_t kind;    /* KP_* */
  uint16_t pt0, npts;
} kmo_path_t;

/* A behaviour variant (kbehave.h): rules and conditions live in the baked table. */
typedef struct {
  const char *event;     /* name, matched to KEV_* by KMO_EVENT_NAMES */
  uint16_t clip;
  uint16_t weight;       /* 0 = only by condition */
  uint16_t min_interval_s;
  uint8_t once_per_boot, once_per_session, avoid_prev_n, max_repeats;
  uint8_t rare;          /* 1 = weight divided by 8 unless nothing else qualifies */
  /* conditions; 0 / -1 = don't care */
  int16_t shots_eq, shots_min;
  int8_t flash;          /* -1 any, 0 off, 1 on */
  int8_t sync_ok;        /* -1 any, 0 not all four, 1 all four in sync */
  int8_t quad;           /* -1 any, 0 wiggle, 1 quad */
  int16_t idle_min_s;    /* the idle that preceded this event, at least */
  int8_t hour_lt;        /* -1 any, else local hour < this (late night) */
  int8_t first_boot;     /* -1 any, 1 only on the first boot ever */
  const char *const *texts; /* strings the clip's "label" role may show; NULL = none */
  uint8_t ntexts;
} kb_variant_t;


#include "kmo_data.h"

/* ------------------------------------------------------------------ */
/* Curves                                                              */

static float kmo_bezier_y(float x1, float y1, float x2, float y2, float x) {
  /* Cubic ease as CSS defines it: solve t for x, return y(t). Newton, 6 steps. */
  float t = x;
  for (int i = 0; i < 6; i++) {
    const float mt = 1.f - t;
    const float bx = 3.f * mt * mt * t * x1 + 3.f * mt * t * t * x2 + t * t * t;
    const float dx = 3.f * mt * mt * x1 + 6.f * mt * t * (x2 - x1) + 3.f * t * t * (1.f - x2);
    if (dx < 1e-5f) break;
    t -= (bx - x) / dx;
    if (t < 0.f) t = 0.f;
    if (t > 1.f) t = 1.f;
  }
  const float mt = 1.f - t;
  return 3.f * mt * mt * t * y1 + 3.f * mt * t * t * y2 + t * t * t;
}

static float kmo_curve(int idx, float s) {
  if (s <= 0.f) return 0.f;
  if (s >= 1.f) return 1.f;
  if (idx < 0 || idx >= KMO_CURVE_COUNT) return s;
  const kmo_curve_t *c = &KMO_CURVES[idx];
  switch (c->kind) {
    case KCV_BEZIER: return kmo_bezier_y(c->p[0], c->p[1], c->p[2], c->p[3], s);
    case KCV_POW: return powf(s, c->p[0]);
    case KCV_SAMPLES: {
      const int n = (int)c->p[1];
      const float f = s * (float)(n - 1);
      int i = (int)f;
      if (i >= n - 1) i = n - 2;
      const float k = f - (float)i;
      const float *sm = &KMO_SAMPLES[(int)c->p[0]];
      return sm[i] + (sm[i + 1] - sm[i]) * k;
    }
    default: return s;
  }
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */

/** Position and tangent (degrees) at u in [0, 1]. */
static void kmo_path_eval(int idx, float u, float *x, float *y, float *tan_deg) {
  const kmo_path_t *p = &KMO_PATHS[idx];
  const float *pt = &KMO_PATH_PTS[p->pt0 * 2];
  if (u < 0.f) u = 0.f;
  if (u > 1.f) u = 1.f;
  float dx = 1.f, dy = 0.f;
  if (p->kind == KP_QUAD && p->npts >= 3) {
    const int nseg = (p->npts - 1) / 2;
    const float f = u * (float)nseg;
    int s = (int)f;
    if (s >= nseg) s = nseg - 1;
    const float t = f - (float)s, mt = 1.f - t;
    const float *a = pt + s * 4, *c = a + 2, *b = a + 4;
    *x = mt * mt * a[0] + 2.f * mt * t * c[0] + t * t * b[0];
    *y = mt * mt * a[1] + 2.f * mt * t * c[1] + t * t * b[1];
    dx = 2.f * mt * (c[0] - a[0]) + 2.f * t * (b[0] - c[0]);
    dy = 2.f * mt * (c[1] - a[1]) + 2.f * t * (b[1] - c[1]);
  } else {
    const int nseg = p->npts - 1;
    if (nseg <= 0) { *x = pt[0]; *y = pt[1]; if (tan_deg) *tan_deg = 0.f; return; }
    const float f = u * (float)nseg;
    int s = (int)f;
    if (s >= nseg) s = nseg - 1;
    const float t = f - (float)s;
    const float *a = pt + s * 2, *b = a + 2;
    *x = a[0] + (b[0] - a[0]) * t;
    *y = a[1] + (b[1] - a[1]) * t;
    dx = b[0] - a[0];
    dy = b[1] - a[1];
  }
  if (tan_deg) *tan_deg = atan2f(dy, dx) * 180.f / 3.14159265f;
}

/* ------------------------------------------------------------------ */
/* Tracks                                                              */

static inline float kmo_key_v(const kmo_key_t *k, const float *params) {
  return (k->pm && params) ? k->v * params[k->pm - 1] : k->v;
}

/** The track's value at clip time t (ms). Pure. */
static float kmo_track_eval(const kmo_track_t *tr, float t, const float *params) {
  const kmo_key_t *k = &KMO_KEYS[tr->key0];
  const int n = tr->nkeys;
  if (n == 0) return 0.f;
  if (t <= (float)k[0].t) return kmo_key_v(&k[0], params);
  if (t >= (float)k[n - 1].t) {
    /* Past the end: a spring or exp segment on the last key keeps ringing
     * toward its own value (already there), so the last value it is. */
    return kmo_key_v(&k[n - 1], params);
  }
  int i = 0;
  while (i < n - 2 && t >= (float)k[i + 1].t) i++;
  const kmo_key_t *a = &k[i], *b = &k[i + 1];
  const float va = kmo_key_v(a, params), vb = kmo_key_v(b, params);
  const float seg = (float)(b->t - a->t);
  const float s = seg > 0.f ? (t - (float)a->t) / seg : 1.f;
  const float since = t - (float)a->t; /* ms into the segment */
  switch (a->interp) {
    case KI_HOLD: return va;
    case KI_STEP: {
      const int steps = a->curve > 0 ? a->curve : 4;
      const float q = floorf(s * (float)steps) / (float)steps;
      return va + (vb - va) * q;
    }
    case KI_CURVE: return va + (vb - va) * kmo_curve(a->curve, s);
    case KI_SMOOTH: {
      /* Catmull-Rom through the neighbours, clamped at the ends. */
      const float v0 = i > 0 ? kmo_key_v(&k[i - 1], params) : va;
      const float v3 = i + 2 < n ? kmo_key_v(&k[i + 2], params) : vb;
      const float s2 = s * s, s3 = s2 * s;
      return 0.5f * ((2.f * va) + (-v0 + vb) * s + (2.f * v0 - 5.f * va + 4.f * vb - v3) * s2 +
                     (-v0 + 3.f * va - 3.f * vb + v3) * s3);
    }
    case KI_SPRING: {
      /* Underdamped response from va toward vb, at rest at the key, over the
       * real time since it. f in Hz, zeta < 1. Analytic, so no state. */
      const float f = a->p0 > 0.f ? a->p0 : 4.f, z = a->p1 > 0.f ? a->p1 : 0.4f;
      const float w = 2.f * 3.14159265f * f;
      const float ts = since / 1000.f;
      if (z >= 1.f) {
        const float e = expf(-w * ts);
        return vb + (va - vb) * e * (1.f + w * ts);
      }
      const float wd = w * sqrtf(1.f - z * z);
      const float e = expf(-z * w * ts);
      return vb + (va - vb) * e * (cosf(wd * ts) + (z * w / wd) * sinf(wd * ts));
    }
    case KI_EXP: {
      const float tau = a->p0 > 0.f ? a->p0 : 80.f;
      return vb + (va - vb) * expf(-since / tau);
    }
    default: return va + (vb - va) * s;
  }
}

/* ------------------------------------------------------------------ */
/* Noise: deterministic value noise, so a host film equals the camera.  */

static inline uint32_t kmo_hash(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
/** -1..1 at time t seconds, `hz` cells per second, per `seed`. C1-continuous. */
static float kmo_noise(uint32_t seed, float hz, float t) {
  const float f = t * hz;
  const int i = (int)floorf(f);
  const float k = f - (float)i;
  const float sm = k * k * (3.f - 2.f * k);
  const float a = (float)(kmo_hash(seed * 7919u + (uint32_t)i) & 0xffff) / 32767.5f - 1.f;
  const float b = (float)(kmo_hash(seed * 7919u + (uint32_t)(i + 1)) & 0xffff) / 32767.5f - 1.f;
  return a + (b - a) * sm;
}

/* ------------------------------------------------------------------ */
/* Clip instances                                                      */

#define KMO_MAX_INST 12
#define KMO_MAX_BIND 8

struct ks_node; /* kscene.h */

typedef struct {
  bool active;
  uint16_t clip;
  int64_t t0_us;
  float params[4];
  struct ks_node *bind[KMO_MAX_BIND]; /* by role slot */
  uint8_t bind_role[KMO_MAX_BIND];
  uint8_t nbind;
  uint32_t sounds_fired;
  const char *tag;                     /* who started it, for stopping by tag */
} kmo_inst_t;

static kmo_inst_t s_kmo_inst[KMO_MAX_INST];
static int64_t s_kmo_now_us;
static float s_kmo_dt_ms = 16.f;
static int s_kmo_live; /* instances that moved something this pass */

/* The sound hook: ui.c points this at the audio. */
static void (*s_kmo_sound)(int cue);

/** Clip time in ms for an instance at the current pass, after the warp. */
static float kmo_inst_time(const kmo_inst_t *in) {
  const kmo_clip_t *c = &KMO_CLIPS[in->clip];
  float t = (float)(s_kmo_now_us - in->t0_us) / 1000.f;
  if (c->warp && c->dur > 0) {
    const float u = t / (float)c->dur;
    t = kmo_curve(c->warp - 1, u) * (float)c->dur;
  }
  return t;
}

static int kmo_role_index(const char *name) {
  for (int i = 0; i < KMO_ROLE_COUNT; i++)
    if (strcmp(KMO_ROLES[i], name) == 0) return i;
  return -1;
}

