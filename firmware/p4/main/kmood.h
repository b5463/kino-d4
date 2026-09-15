// Mood: what kind of state the camera is in, and how that colours everything.
//
// The behaviour controller answers "something happened, what do I do about
// it". This answers the question underneath: what sort of mood is the camera
// in right now. Four continuous values, each pulled toward a target computed
// from real signals (ksense.h) and real events, each decaying back with its
// own time constant. Nothing here is ever displayed. There is no mood
// indicator, no status word, no face. If the user can name it, it is wrong.
//
//   energy      shot cadence, motion in the frame, how fast gestures are
//               tens of seconds
//   calm        the scene held still, long framing, time idle
//               a minute or two
//   confidence  clean four-camera sync, transfers that landed
//               minutes
//   strain      failed captures, dropped frames, card and link trouble
//               minutes
//
// Two things read it. Behaviour selection conditions on mood bands, so what
// qualifies is decided by context and the weighted draw only chooses within
// that (kbehave.h). And motion reads it as tempo and vigour, so the same clip
// plays differently at rest and in the middle of a burst - one clip, many
// readings, rather than one clip per mood.
//
// Per-unit identity lives here too. Two KINOs should not be identical, and
// the difference should come from the hardware rather than from a skin
// picker: the serial number and the cameras' own measured disagreement seed
// a small permanent bias in tempo, in which camera leads a convergence, and
// in the RNG behind behaviour selection.
#pragma once

typedef struct {
  float energy, calm, confidence, strain;  /* 0..1 */
  int64_t last_us;
  /* What feeds them, kept here so the decay has something to aim at. */
  int64_t last_shot_us;
  int recent_shots;        /* shots in the last KMOOD_BURST_MS, decayed */
  int64_t recent_since_us;
  float gesture_speed;     /* px/ms of the last release, decayed */
  bool primed;
} kmood_t;

static kmood_t s_kmood;

#define KMOOD_BURST_MS 6000     /* shots inside this window count as a burst */
#define KMOOD_TAU_ENERGY 14.f   /* seconds to fall back toward rest */
#define KMOOD_TAU_CALM 40.f
#define KMOOD_TAU_CONF 90.f
#define KMOOD_TAU_STRAIN 120.f

/* ------------------------------------------------------------------ */
/* Per-unit identity                                                   */

typedef struct {
  uint32_t seed;        /* behaviour RNG, and anything else that wants variety */
  float tempo_bias;     /* 0.97 .. 1.03: this unit runs a shade fast or slow */
  uint8_t lead_cam;     /* which camera leads a four-way convergence */
  float skew_bias;      /* a degree or so of permanent asymmetry */
} kident_t;

static kident_t s_kident = {0x9e3779b9u, 1.f, 0, 0.f};

/**
 * Seed this unit's character from its serial and from what its cameras
 * actually do. The cameras differ in timing, framing and colour; that is not
 * a defect to be calibrated away before the interface can use it, it is the
 * only per-unit material the hardware gives us for free.
 *
 * Called once the serial is known and the finder has run long enough to have
 * measured something. Deterministic: the same unit is the same character
 * every boot, which is the point.
 */
/* The motion RNG is only compiled in with the playground; elsewhere the
 * behaviour RNG is the only one that needs this unit's seed. */
static inline void mo_seed_if_available(uint32_t s) { (void)s; }

static void kmood_identity(const char *serial, uint32_t cam_spread) {
  uint32_t h = 0x811c9dc5u;
  for (const char *p = serial; p && *p; p++) h = (h ^ (uint32_t)(unsigned char)*p) * 16777619u;
  h ^= cam_spread * 2654435761u;
  h = kmo_hash(h);
  s_kident.seed = h ? h : 0x9e3779b9u;
  s_kident.tempo_bias = 0.97f + (float)(h & 0xff) / 255.f * 0.06f;
  s_kident.lead_cam = (uint8_t)((h >> 8) & 3);
  s_kident.skew_bias = -1.f + (float)((h >> 16) & 0xff) / 255.f * 2.f;
  kb_seed(s_kident.seed);
  mo_seed_if_available(s_kident.seed);
}

/* ------------------------------------------------------------------ */
/* The state                                                           */

/** Exponential approach toward `target` with time constant `tau` seconds. */
static inline void kmood_toward(float *v, float target, float tau_s, float dt_s) {
  const float k = 1.f - expf(-dt_s / (tau_s > 0.01f ? tau_s : 0.01f));
  *v += (target - *v) * k;
  if (*v < 0.f) *v = 0.f;
  if (*v > 1.f) *v = 1.f;
}

/** A shot was taken: cadence feeds energy, and a burst suppresses decoration. */
static void kmood_shot(int64_t now_us) {
  if (s_kmood.recent_since_us == 0 || now_us - s_kmood.last_shot_us > KMOOD_BURST_MS * 1000) {
    s_kmood.recent_shots = 1;
    s_kmood.recent_since_us = now_us;
  } else {
    s_kmood.recent_shots++;
  }
  s_kmood.last_shot_us = now_us;
  /* An immediate lift rather than waiting for the next step: the shot that
   * starts a burst should already be read as a burst by what follows it. */
  s_kmood.energy += 0.22f;
  if (s_kmood.energy > 1.f) s_kmood.energy = 1.f;
  s_kmood.calm *= 0.75f;
}

/** Something went wrong. `weight` 0..1: a dropped frame is not a lost photograph. */
static void kmood_trouble(float weight) {
  s_kmood.strain += weight;
  if (s_kmood.strain > 1.f) s_kmood.strain = 1.f;
  s_kmood.confidence *= 1.f - 0.4f * weight;
}

/** Something went right: four cameras in sync, a burst that landed. */
static void kmood_reward(float weight) {
  s_kmood.confidence += weight;
  if (s_kmood.confidence > 1.f) s_kmood.confidence = 1.f;
  s_kmood.strain *= 1.f - 0.3f * weight;
}

/** A gesture was released at this speed, in px/ms. Feeds energy. */
static void kmood_gesture(float px_per_ms) {
  const float s = px_per_ms < 0.f ? -px_per_ms : px_per_ms;
  s_kmood.gesture_speed = s;
  s_kmood.energy += s * 0.12f > 0.3f ? 0.3f : s * 0.12f;
  if (s_kmood.energy > 1.f) s_kmood.energy = 1.f;
}

/**
 * Step the mood. Called once a pass, after ksense_step().
 *
 * Each value is pulled toward a target the signals imply and decays back on
 * its own clock. Nothing snaps: a camera that has just been put down stays
 * energetic for a few seconds, which is what makes the next shot read as part
 * of the same burst rather than as a fresh event.
 */
static void kmood_step(int64_t now_us) {
  if (!s_kmood.primed) {
    s_kmood.primed = true;
    s_kmood.last_us = now_us;
    s_kmood.calm = 0.5f;
    s_kmood.confidence = 0.5f;
    return;
  }
  float dt_s = (float)(now_us - s_kmood.last_us) / 1000000.f;
  s_kmood.last_us = now_us;
  if (dt_s <= 0.f) return;
  if (dt_s > 1.f) dt_s = 1.f; /* after a sleep, step as if one second passed */

  /* The burst window closes on its own. */
  if (s_kmood.recent_since_us && now_us - s_kmood.last_shot_us > KMOOD_BURST_MS * 1000) {
    s_kmood.recent_shots = 0;
    s_kmood.recent_since_us = 0;
  }

  /* Energy: what is moving, and how recently something happened. */
  float e_target = s_ksense.motion_mean * 0.8f;
  if (s_kmood.recent_shots >= 3) e_target = e_target > 0.75f ? e_target : 0.75f;
  else if (s_kmood.recent_shots == 2) e_target = e_target > 0.5f ? e_target : 0.5f;
  kmood_toward(&s_kmood.energy, e_target, KMOOD_TAU_ENERGY, dt_s);

  /* Calm: the scene held still, and nothing asked for attention. */
  const int still_ms = ksense_still_ms();
  float c_target = still_ms > 3000 ? 1.f : (float)still_ms / 3000.f;
  if (s_kmood.recent_shots >= 2) c_target *= 0.3f;
  kmood_toward(&s_kmood.calm, c_target, KMOOD_TAU_CALM, dt_s);

  /* Confidence and strain have no signal target of their own: they are moved
   * by what actually happened and drift back to the middle and to nothing. */
  kmood_toward(&s_kmood.confidence, 0.5f, KMOOD_TAU_CONF, dt_s);
  kmood_toward(&s_kmood.strain, 0.f, KMOOD_TAU_STRAIN, dt_s);

  s_kmood.gesture_speed *= expf(-dt_s / 2.f);
}

/* ------------------------------------------------------------------ */
/* What motion reads                                                   */

/**
 * How fast clips run. Energy speeds the interface up, calm slows it; the
 * unit's own bias is a permanent shade either side. Bounded so that a mood
 * can colour the timing without ever making the camera feel broken.
 */
static float kmood_tempo(void) {
  const float t = 1.f + s_kmood.energy * 0.22f - s_kmood.calm * 0.10f;
  return t * s_kident.tempo_bias;
}

/**
 * How far the expressive motion travels. Additive tracks - the overshoots,
 * the throws, the travel - are scaled by this, so a tired or strained camera
 * moves less rather than differently, and a confident one commits.
 */
static float kmood_vigour(void) {
  const float v = 0.82f + s_kmood.energy * 0.20f + s_kmood.confidence * 0.12f - s_kmood.strain * 0.25f;
  return v < 0.5f ? 0.5f : v > 1.3f ? 1.3f : v;
}
