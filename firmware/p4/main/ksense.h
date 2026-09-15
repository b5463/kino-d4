// What the four cameras can tell the interface, cheaply.
//
// KINO has four image sensors and used them for nothing behavioural. This
// reads the viewfinder tiles the finder is already decoding and derives a
// handful of continuous signals: how bright the room is, how fast it is
// changing, how much is moving, how long it has been still, and how much the
// four cameras disagree with each other. kmood.h turns those into a mood; the
// interface never shows any of it.
//
// No computer vision, no models. A sparse grid of samples per camera, a
// luminance approximation in shifts, and a difference against the previous
// grid. At KS_STEP 8 that is 40x30 samples a camera, 4800 a sweep, and the
// sweep runs at KS_HZ rather than every pass - the viewfinder itself only
// produces about 17 frames a second.
//
// Included by ui.c after viewfinder.h and the runtime headers.
#pragma once

#define KS_STEP 8                        /* sample every 8th pixel of every 8th row */
#define KS_GW (VF_W / KS_STEP)           /* 40 */
#define KS_GH (VF_H / KS_STEP)           /* 30 */
#define KS_GRID (KS_GW * KS_GH)          /* 1200 samples a camera */
#define KS_HZ 12                         /* sweeps a second */
#define KS_PERIOD_US (1000000 / KS_HZ)

/* One camera's last grid, for the difference. Kept as 8-bit luma. */
static uint8_t *s_ksense_prev[4];
static bool s_ksense_have[4];

typedef struct {
  /* Per camera, 0..1, valid where `live` has the bit set. */
  float lum[4];
  float motion[4];
  uint8_t live_mask;
  int live;

  /* Across the cameras that answered. */
  float lum_mean;      /* 0 dark .. 1 bright */
  float lum_rate;      /* change per second, signed */
  float motion_mean;   /* 0 still .. 1 a lot is moving */
  float contrast;      /* 0 flat wall .. 1 full range */
  float spread;        /* how much the four disagree about brightness, 0..1 */

  /* Derived over time. */
  int64_t still_since_us;  /* when motion last fell below KS_STILL, 0 = not still */
  int64_t moved_since_us;  /* when motion last rose above KS_STILL */
  int64_t last_sweep_us;
  bool primed;
} ksense_t;

static ksense_t s_ksense;

#define KS_STILL 0.06f   /* below this the scene counts as held */

/** RGB565 to 8-bit luma, in shifts: (r + 2g + b) / 4 on expanded channels. */
static inline uint8_t ks_luma(uint16_t c) {
  const int r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
  return (uint8_t)(((r << 3) + ((g << 2) << 1) + (b << 3)) >> 2);
}

/** How long the scene has been held still, in ms; 0 when something is moving. */
static int ksense_still_ms(void) {
  if (s_ksense.still_since_us == 0) return 0;
  return (int)((esp_timer_get_time() - s_ksense.still_since_us) / 1000);
}

/**
 * Sweep the live tiles and update the signals. Call once per pass; it rate
 * limits itself to KS_HZ and returns immediately the rest of the time.
 *
 * Costs one pass over a sparse grid per live camera. The previous grid is
 * kept per camera so the difference is against that camera's own last look
 * at the room, not against its neighbour.
 */
static void ksense_step(void) {
  const int64_t now = esp_timer_get_time();
  if (s_ksense.last_sweep_us && now - s_ksense.last_sweep_us < KS_PERIOD_US) return;
  const float dt_s = s_ksense.last_sweep_us ? (float)(now - s_ksense.last_sweep_us) / 1000000.f : 0.f;
  s_ksense.last_sweep_us = now;

  if (!viewfinder_ready()) {
    s_ksense.live_mask = 0;
    s_ksense.live = 0;
    return;
  }

  float sum_lum = 0.f, sum_motion = 0.f, sum_contrast = 0.f;
  float lo_lum = 1.f, hi_lum = 0.f;
  int live = 0;
  uint8_t mask = 0;

  for (int cam = 0; cam < 4; cam++) {
    const uint16_t *tile = viewfinder_tile(cam);
    if (tile == NULL) {
      s_ksense_have[cam] = false;
      continue;
    }
    if (s_ksense_prev[cam] == NULL) {
      s_ksense_prev[cam] = heap_caps_malloc(KS_GRID, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (s_ksense_prev[cam] == NULL) s_ksense_prev[cam] = malloc(KS_GRID);
      if (s_ksense_prev[cam] == NULL) continue;
      s_ksense_have[cam] = false;
    }
    uint8_t *prev = s_ksense_prev[cam];
    const bool had = s_ksense_have[cam];

    uint32_t acc = 0, diff = 0;
    uint8_t lo = 255, hi = 0;
    int i = 0;
    for (int y = 0; y < VF_H; y += KS_STEP) {
      const uint16_t *row = tile + (size_t)y * VF_W;
      for (int x = 0; x < VF_W; x += KS_STEP, i++) {
        const uint8_t y8 = ks_luma(row[x]);
        acc += y8;
        if (y8 < lo) lo = y8;
        if (y8 > hi) hi = y8;
        if (had) {
          const int d = (int)y8 - (int)prev[i];
          diff += (uint32_t)(d < 0 ? -d : d);
        }
        prev[i] = y8;
      }
    }
    s_ksense_have[cam] = true;
    const float lum = (float)acc / (float)(i * 255);
    /* A difference of 24 levels on every sample is as much motion as this
     * ever needs to report; beyond that the number stops meaning anything. */
    const float motion = had ? (float)diff / (float)(i * 24) : 0.f;
    s_ksense.lum[cam] = lum;
    s_ksense.motion[cam] = motion > 1.f ? 1.f : motion;
    mask |= (uint8_t)(1u << cam);
    live++;
    sum_lum += lum;
    sum_motion += s_ksense.motion[cam];
    sum_contrast += (float)(hi - lo) / 255.f;
    if (lum < lo_lum) lo_lum = lum;
    if (lum > hi_lum) hi_lum = lum;
  }

  s_ksense.live_mask = mask;
  s_ksense.live = live;
  if (live == 0) return;

  const float lum_mean = sum_lum / (float)live;
  s_ksense.lum_rate = (dt_s > 0.f && s_ksense.primed) ? (lum_mean - s_ksense.lum_mean) / dt_s : 0.f;
  s_ksense.lum_mean = lum_mean;
  s_ksense.motion_mean = sum_motion / (float)live;
  s_ksense.contrast = sum_contrast / (float)live;
  /* The four cameras look at the same room from slightly different places,
   * so they never quite agree. How much they disagree is itself a signal. */
  s_ksense.spread = live > 1 ? hi_lum - lo_lum : 0.f;
  s_ksense.primed = true;

  if (s_ksense.motion_mean < KS_STILL) {
    if (s_ksense.still_since_us == 0) s_ksense.still_since_us = now;
    s_ksense.moved_since_us = 0;
  } else {
    if (s_ksense.moved_since_us == 0) s_ksense.moved_since_us = now;
    s_ksense.still_since_us = 0;
  }
}

/** Forget the grids: the cameras were off, so the next difference is meaningless. */
static void ksense_reset(void) {
  for (int i = 0; i < 4; i++) s_ksense_have[i] = false;
  s_ksense.still_since_us = 0;
  s_ksense.moved_since_us = 0;
  s_ksense.primed = false;
}
