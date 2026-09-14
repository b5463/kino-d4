// The motion layer: animated objects with state, stepped by the clock.
//
// Every moving thing on the screen is an object with a position, a velocity,
// a target, a scale, a rotation, an opacity and a timing offset. The pass
// loop steps them by elapsed time (never by frame count), asks whether any
// is still live, and if one is, comes back in MO_FRAME_MS instead of idling.
// Nothing in here draws; it only decides where things are.
//
// Two kinds of motion, chosen by what the thing is doing:
//
//   - A SPRING for anything that goes to a place. Critically damped settles
//     without crossing; under-damped overshoots and comes back, which is what
//     an entrance wants. A retarget mid-flight keeps the velocity, so a
//     second input never waits for the first sequence to finish - the
//     object simply bends toward the new target from wherever it is.
//   - A TIMELINE for an event with a start and an end - a reaction that
//     enters, holds and leaves - read through an ease.
//
// Parent/child timing is a delay on the child: a sequence starts everything
// together and each object waits out its own offset, so the primary reacts
// at once and dependents follow 40-100 ms later without any per-frame
// choreography code.
//
// Header-only and static: included by ui.c after esp_timer is available.
// Floats, because the P4 has an FPU and the wasm build does not care; the
// per-pass cost is a few dozen multiply-adds.
#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "esp_timer.h"

/** The pass cadence while anything is moving. */
#define MO_FRAME_MS 16

/* A spring preset: angular frequency in rad/ms and damping ratio. A period of
 * ~140 ms (w = 0.045) with zeta 0.75 overshoots by a few percent and is still
 * inside 250 ms; zeta 1.0 is the same reach with no crossing. */
typedef struct {
  float w;    /* rad/ms */
  float zeta; /* damping ratio: <1 overshoots, 1 settles, >1 drags */
} mo_preset_t;

/* Tuned on the film strips (host_preview film_*): the time constant is
 * 1/(zeta*w) ms and a move is over in about three of them. */
static const mo_preset_t MO_SNAP = {0.045f, 1.00f};   /* ~70 ms, no overshoot: the acknowledgement */
static const mo_preset_t MO_SETTLE = {0.028f, 1.00f}; /* ~120 ms: a considered arrival */
static const mo_preset_t MO_BOUNCE = {0.019f, 0.68f}; /* ~250 ms: an entrance that overshoots and settles */
static const mo_preset_t MO_LAZY = {0.018f, 0.85f};   /* ~200 ms: the secondary word following the title */

typedef struct {
  float v;      /* where it is */
  float target; /* where it is going */
  float vel;    /* per ms */
} mo_val_t;

static int s_mo_live_count;
static int s_mo_live_prev;

/** Start of a pass: what was live last pass is remembered, this pass starts at nothing. */
static inline void mo_begin_pass(void) {
  s_mo_live_prev = s_mo_live_count;
  s_mo_live_count = 0;
}

/**
 * True when something is moving. Objects are stepped where they are drawn,
 * so a pass that has not drawn yet knows nothing - it asks what the LAST
 * pass found, draws, and the draw recounts. A pass that draws and finds
 * nothing live ends the run; the next pass then sees a zero on both sides.
 */
static inline bool mo_any_live(void) { return s_mo_live_count > 0 || s_mo_live_prev > 0; }

/** Put a value somewhere with no motion. */
static inline void mo_set(mo_val_t *m, float v) {
  m->v = v;
  m->target = v;
  m->vel = 0.f;
}

/** Aim a value; it keeps whatever velocity it has. */
static inline void mo_to(mo_val_t *m, float target) { m->target = target; }

/** Aim a value and give it a kick, for entrances that should arrive with momentum. */
static inline void mo_launch(mo_val_t *m, float from, float target, float vel) {
  m->v = from;
  m->target = target;
  m->vel = vel;
}

/**
 * Step a spring by dt ms. Semi-implicit Euler, sub-stepped so a long pass
 * (a card read stalled the loop for 200 ms) cannot make it explode. Returns
 * true while the value is still visibly moving; on settling it snaps to the
 * target so nothing is left a fraction of a pixel out.
 */
static inline bool mo_spring(mo_val_t *m, float dt_ms, mo_preset_t p) {
  if (dt_ms <= 0.f) dt_ms = 0.f;
  if (dt_ms > 200.f) dt_ms = 200.f;
  const float k = p.w * p.w;
  const float c = 2.f * p.zeta * p.w;
  float remaining = dt_ms;
  while (remaining > 0.f) {
    const float h = remaining > 4.f ? 4.f : remaining;
    const float a = -k * (m->v - m->target) - c * m->vel;
    m->vel += a * h;
    m->v += m->vel * h;
    remaining -= h;
  }
  const bool live = fabsf(m->v - m->target) > 0.35f || fabsf(m->vel) > 0.01f;
  if (!live) {
    m->v = m->target;
    m->vel = 0.f;
  } else {
    s_mo_live_count++;
  }
  return live;
}

/* ------------------------------------------------------------------ */
/* Eases, for timelines. t in 0..1, result in 0..1 (back eases overshoot). */

static inline float ease_clamp01(float t) { return t < 0.f ? 0.f : (t > 1.f ? 1.f : t); }
static inline float ease_out_cubic(float t) { t = ease_clamp01(t); const float u = 1.f - t; return 1.f - u * u * u; }
static inline float ease_in_quart(float t) { t = ease_clamp01(t); return t * t * t * t; }
static inline float ease_out_quint(float t) { t = ease_clamp01(t); const float u = 1.f - t; return 1.f - u * u * u * u * u; }
/** Overshoots past 1 by ~10% around t=0.7 and returns: the arcade entry. */
static inline float ease_out_back(float t) {
  t = ease_clamp01(t);
  const float c1 = 1.70158f, c3 = c1 + 1.f;
  const float u = t - 1.f;
  return 1.f + c3 * u * u * u + c1 * u * u;
}
static inline float ease_lerp(float a, float b, float t) { return a + (b - a) * t; }

/**
 * A timeline: started at a moment, `dur_ms` long, with an optional delay
 * before it counts. `mo_tl_t()` gives 0..1 (0 while waiting, 1 after the end)
 * and marks the pass live while inside.
 */
typedef struct {
  int64_t start_us; /* 0 = not running */
  int dur_ms;
  int delay_ms;
} mo_tl_t;

static inline void mo_tl_start(mo_tl_t *t, int64_t now_us, int dur_ms, int delay_ms) {
  t->start_us = now_us;
  t->dur_ms = dur_ms;
  t->delay_ms = delay_ms;
}
static inline void mo_tl_stop(mo_tl_t *t) { t->start_us = 0; }
static inline bool mo_tl_running(const mo_tl_t *t, int64_t now_us) {
  return t->start_us != 0 && now_us < t->start_us + (int64_t)(t->delay_ms + t->dur_ms) * 1000;
}
static inline float mo_tl_at(const mo_tl_t *t, int64_t now_us) {
  if (t->start_us == 0) return 1.f;
  const int64_t rel = (now_us - t->start_us) / 1000 - t->delay_ms;
  if (rel < 0) {
    s_mo_live_count++;
    return 0.f;
  }
  if (rel >= t->dur_ms) return 1.f;
  s_mo_live_count++;
  return (float)rel / (float)t->dur_ms;
}

/* ------------------------------------------------------------------ */
/* An animated object: the six properties the brief names, plus a delay. */

typedef struct {
  mo_val_t x, y;     /* px */
  mo_val_t scale;    /* 1.0 = natural size */
  mo_val_t rot;      /* degrees */
  mo_val_t alpha;    /* 0..255 */
  int delay_ms;      /* waits this long after mo_obj_go() before moving */
  int64_t go_us;     /* when the current move was issued */
} mo_obj_t;

static inline void mo_obj_place(mo_obj_t *o, float x, float y) {
  mo_set(&o->x, x);
  mo_set(&o->y, y);
  mo_set(&o->scale, 1.f);
  mo_set(&o->rot, 0.f);
  mo_set(&o->alpha, 255.f);
  o->delay_ms = 0;
  o->go_us = 0;
}

/** Issue a move: from now, after the object's delay, it springs to its targets. */
static inline void mo_obj_go(mo_obj_t *o, int64_t now_us) { o->go_us = now_us; }

/** Step all six with one preset. Honours the delay; returns live. */
static inline bool mo_obj_step(mo_obj_t *o, int64_t now_us, float dt_ms, mo_preset_t p) {
  if (o->go_us != 0 && now_us < o->go_us + (int64_t)o->delay_ms * 1000) {
    s_mo_live_count++;
    return true; /* waiting its turn counts as live: a frame is owed soon */
  }
  bool live = false;
  live |= mo_spring(&o->x, dt_ms, p);
  live |= mo_spring(&o->y, dt_ms, p);
  live |= mo_spring(&o->scale, dt_ms, p);
  live |= mo_spring(&o->rot, dt_ms, p);
  live |= mo_spring(&o->alpha, dt_ms, MO_SETTLE);
  return live;
}

/* ------------------------------------------------------------------ */
/* Variation: a small deterministic generator for picking reactions. Seeded
 * from the clock and the shot count at boot so two cameras do not agree. */

static uint32_t s_mo_rng = 0x9e3779b9u;
static inline void mo_seed(uint32_t s) { s_mo_rng = s ? s : 0x9e3779b9u; }
static inline uint32_t mo_rand(void) {
  uint32_t x = s_mo_rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  s_mo_rng = x;
  return x;
}
/** 0..n-1 */
static inline int mo_rand_n(int n) { return n <= 1 ? 0 : (int)(mo_rand() % (uint32_t)n); }
/** -range..+range as a float, for the rotation and placement of a reaction. */
static inline float mo_rand_pm(float range) { return ((float)(mo_rand() & 0xffff) / 32767.5f - 1.f) * range; }
