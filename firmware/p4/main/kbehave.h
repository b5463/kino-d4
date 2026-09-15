// KINO behaviour: what the camera does about what happened.
//
//   camera state / event  ->  behaviour controller  ->  choreography  ->  scene
//
// The camera logic reports events (kb_event); it never chooses a clip. This
// layer picks one behaviour from the event's authored set (behaviors/*.json ->
// kmo_data.h) by weight, subject to rules - a minimum interval, once per boot,
// once per session, avoid the last N, a cap on repeats, rarity - and to
// conditions on the real state the caller passes in (shots this session,
// flash, sync, mode, idle, hour). It keeps the history that makes "not the
// same thing three times" possible. What a behaviour looks like is entirely
// the clip's; what the camera did is entirely the caller's; this is the seam
// between them, and the personality lives in the data on the other side.
//
// Nothing here is shown to the user: no achievements, no list, no unlock.
#pragma once

/* Events. The names are the data's too (KMO_EVENTS[]). */
enum {
  KEV_CAPTURE_SUCCESS = 0,
  KEV_CAPTURE_FAIL,
  KEV_CAPTURE_PARTIAL,
  KEV_LINK_CONNECTED,
  KEV_LINK_LOST,
  KEV_TRANSFER_COMPLETE,
  KEV_SYNC_GOOD,
  KEV_BOOT,
  KEV_FIRST_BOOT,
  KEV_WAKE,
  KEV_WAKE_LONG_IDLE,
  KEV_CARD_IN,
  KEV_CARD_OUT,
  KEV_CARD_LOW,
  KEV_USB_ATTACH,
  KEV_USB_DETACH,
  KEV_LOOK_CHANGE,
  KEV_MODE_CHANGE,
  KEV_COUNT
};

/* The caller's account of the world at the moment of the event. */
typedef struct {
  int shots_session;
  int flash_on;
  int sync_ok;
  int quad;
  int idle_s;
  int hour;       /* -1 unknown */
  int first_boot;
} kb_ctx_t;

typedef struct {
  int variant;    /* index into KMO_VARIANTS, -1 none */
  int clip;
  const char *text;
} kb_pick_t;

#define KB_HISTORY 12
static struct { int16_t variant; int64_t t_us; } s_kb_hist[KB_HISTORY];
static int s_kb_hist_n;
static bool s_kb_fired_boot[KMO_VARIANT_COUNT > 0 ? KMO_VARIANT_COUNT : 1];
static bool s_kb_fired_session[KMO_VARIANT_COUNT > 0 ? KMO_VARIANT_COUNT : 1];
static int64_t s_kb_last_us[KMO_VARIANT_COUNT > 0 ? KMO_VARIANT_COUNT : 1];
static int s_kb_last_text[KMO_VARIANT_COUNT > 0 ? KMO_VARIANT_COUNT : 1];
static uint32_t s_kb_rng = 0x2545f491u;

static inline uint32_t kb_rand(void) {
  s_kb_rng ^= s_kb_rng << 13; s_kb_rng ^= s_kb_rng >> 17; s_kb_rng ^= s_kb_rng << 5;
  return s_kb_rng;
}
static inline void kb_seed(uint32_t s) { s_kb_rng = s ? s : 0x2545f491u; }

/** A new session: the once-per-session marks clear. Called on a long-idle wake. */
static void kb_new_session(void) { memset(s_kb_fired_session, 0, sizeof s_kb_fired_session); }

static bool kb_conditions(const kb_variant_t *v, const kb_ctx_t *c) {
  if (v->shots_eq > 0 && c->shots_session != v->shots_eq) return false;
  if (v->shots_min > 0 && c->shots_session < v->shots_min) return false;
  if (v->flash >= 0 && c->flash_on != v->flash) return false;
  if (v->sync_ok >= 0 && c->sync_ok != v->sync_ok) return false;
  if (v->quad >= 0 && c->quad != v->quad) return false;
  if (v->idle_min_s > 0 && c->idle_s < v->idle_min_s) return false;
  if (v->hour_lt >= 0 && !(c->hour >= 0 && c->hour < v->hour_lt)) return false;
  if (v->first_boot > 0 && !c->first_boot) return false;
  return true;
}

static bool kb_rules(int vi, const kb_variant_t *v, int64_t now_us) {
  if (v->once_per_boot && s_kb_fired_boot[vi]) return false;
  if (v->once_per_session && s_kb_fired_session[vi]) return false;
  if (v->min_interval_s && s_kb_last_us[vi] && now_us - s_kb_last_us[vi] < (int64_t)v->min_interval_s * 1000000) return false;
  if (v->avoid_prev_n)
    for (int i = 0; i < v->avoid_prev_n && i < s_kb_hist_n && i < KB_HISTORY; i++)
      if (s_kb_hist[(s_kb_hist_n - 1 - i) % KB_HISTORY].variant == vi) return false;
  if (v->max_repeats) {
    int run = 0;
    for (int i = 0; i < s_kb_hist_n && i < KB_HISTORY; i++) {
      if (s_kb_hist[(s_kb_hist_n - 1 - i) % KB_HISTORY].variant == vi) run++;
      else break;
    }
    if (run >= v->max_repeats) return false;
  }
  return true;
}

/**
 * Choose what to do about `ev`. Conditioned variants with weight 0 fire when
 * their condition holds and their rules allow (a milestone); otherwise the
 * weighted draw over what qualifies. Returns variant -1 when the answer is
 * nothing, which for many events is the common and correct answer.
 */
static kb_pick_t kb_event(int ev, const kb_ctx_t *ctx, int64_t now_us) {
  kb_pick_t out = {-1, -1, NULL};
  const char *name = KMO_EVENT_NAMES[ev];
  /* Milestones first. */
  for (int i = 0; i < KMO_VARIANT_COUNT; i++) {
    const kb_variant_t *v = &KMO_VARIANTS[i];
    if (strcmp(v->event, name) != 0 || v->weight != 0) continue;
    if (kb_conditions(v, ctx) && kb_rules(i, v, now_us)) { out.variant = i; break; }
  }
  if (out.variant < 0) {
    int total = 0, cand[32], wts[32], n = 0;
    for (int i = 0; i < KMO_VARIANT_COUNT && n < 32; i++) {
      const kb_variant_t *v = &KMO_VARIANTS[i];
      if (strcmp(v->event, name) != 0 || v->weight == 0) continue;
      if (!kb_conditions(v, ctx) || !kb_rules(i, v, now_us)) continue;
      int w = v->weight;
      if (v->rare) w = w / 8 > 0 ? w / 8 : 1;
      cand[n] = i; wts[n] = w; total += w; n++;
    }
    if (n > 0) {
      int r = (int)(kb_rand() % (uint32_t)total);
      for (int i = 0; i < n; i++) { if (r < wts[i]) { out.variant = cand[i]; break; } r -= wts[i]; }
    }
  }
  if (out.variant < 0) return out;
  const kb_variant_t *v = &KMO_VARIANTS[out.variant];
  out.clip = v->clip;
  if (v->ntexts > 0) {
    /* A line the variant did not just say. */
    int pick = (int)(kb_rand() % v->ntexts);
    if (v->ntexts > 1 && pick == s_kb_last_text[out.variant]) pick = (pick + 1) % v->ntexts;
    s_kb_last_text[out.variant] = pick;
    out.text = v->texts[pick];
  }
  s_kb_hist[s_kb_hist_n % KB_HISTORY].variant = (int16_t)out.variant;
  s_kb_hist[s_kb_hist_n % KB_HISTORY].t_us = now_us;
  s_kb_hist_n++;
  s_kb_fired_boot[out.variant] = true;
  s_kb_fired_session[out.variant] = true;
  s_kb_last_us[out.variant] = now_us;
  return out;
}
