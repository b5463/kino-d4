#include "pure.h"

#include <stdio.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

int pure_quality_to_sensor(int percent) {
  if (percent <= 0) return 0; /* "not specified" - let the node keep its own */
  if (percent > 100) percent = 100;
  const int q = 20 - ((percent - 60) * 15) / 35;
  if (q < 5) return 5;
  if (q > 40) return 40;
  return q;
}

void pure_frame_quality(bool sensor_owns, int applied_quality, int mode_quality,
                        int *cap_quality, int *record_quality) {
  int carry = 0;   /* what NL_CMD_CAPTURE sends */
  int record = 0;  /* what the register holds at exposure */

  if (sensor_owns && applied_quality > 0) {
    /* NL_CMD_SENSOR wrote it and still owns it: the CAPTURE must not carry a
     * quality, or it would overwrite the look's value an instant before the
     * exposure. What is recorded is what the node said it accepted. */
    record = applied_quality;
  } else if (mode_quality > 0) {
    /* Nothing stands in the register that we know of, so the CAPTURE carries
     * the mode default and the node writes it. Recorded after the node's own
     * clamp, because the clamp is what lands in the sensor. */
    carry = mode_quality;
    record = mode_quality;
    if (record < PURE_SENSOR_QUALITY_MIN) record = PURE_SENSOR_QUALITY_MIN;
    if (record > PURE_SENSOR_QUALITY_MAX) record = PURE_SENSOR_QUALITY_MAX;
  }
  /* Both zero: no quality was ever established for this camera. Say nothing.
   * A capture still happens - the sensor keeps whatever its driver left. */

  if (cap_quality != NULL) *cap_quality = carry;
  if (record_quality != NULL) *record_quality = record;
}

int pure_ev_to_ae_level(double ev) {
  /* NaN first, and without math.h: isnan() would drag libm into a test binary
   * the Makefile links without -lm, and every comparison below is false for a
   * NaN anyway, so it would fall through the clamps to the cast. */
  if (ev != ev) return 0;
  /* The clamps come BEFORE the cast, which is what makes the cast safe: a
   * look document can carry 1e300, and converting that to int is undefined
   * behaviour, not a large number. Both bounds are inclusive because a
   * half-step rounds away from zero - exactly -1.5 is -2. */
  if (ev >= 1.5) return 2;
  if (ev <= -1.5) return -2;
  /* Round half away from zero on a value now known to be within +/-1.5, so
   * the addition cannot leave the int range. */
  return (int)(ev + (ev >= 0.0 ? 0.5 : -0.5));
}

int pure_gain_to_ceiling(const char *gain) {
  if (gain == NULL) return 0;
  if (strcmp(gain, "low") == 0) return 4;
  if (strcmp(gain, "high") == 0) return 32;
  /* "auto" and anything unrecognised both mean "send no gainCeiling". They
   * are deliberately the same answer: a slot carrying a word this firmware
   * does not know must leave the AGC alone rather than pick a number for it. */
  return 0;
}

bool pure_parse_resolution(const char *s, uint32_t *width, uint32_t *height) {
  if (s == NULL) return false;
  const uint32_t MAX_DIM = 4096;

  uint32_t w = 0, h = 0;
  size_t i = 0;
  int digits = 0;
  for (; s[i] >= '0' && s[i] <= '9'; i++, digits++) {
    w = w * 10u + (uint32_t)(s[i] - '0');
    if (w > MAX_DIM) return false;
  }
  if (digits == 0 || s[i] != 'x') return false;
  i++;

  digits = 0;
  for (; s[i] >= '0' && s[i] <= '9'; i++, digits++) {
    h = h * 10u + (uint32_t)(s[i] - '0');
    if (h > MAX_DIM) return false;
  }
  /* Trailing characters mean we did not understand the whole string. */
  if (digits == 0 || s[i] != '\0') return false;
  if (w == 0 || h == 0) return false;

  if (width != NULL) *width = w;
  if (height != NULL) *height = h;
  return true;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

uint64_t pure_capture_reserve_bytes(int frames, uint32_t width, uint32_t height) {
  if (frames < 1) frames = 1;
  if (frames > 4) frames = 4;
  if (width == 0 || height == 0) {
    width = 2048;
    height = 1536;
  }
  const uint64_t per_frame = ((uint64_t)width * height) / 2u; /* 0.5 bpp bound */
  return per_frame * (uint64_t)frames + PURE_RESERVE_THUMB_BYTES + PURE_RESERVE_META_BYTES +
         PURE_RESERVE_MARGIN_BYTES;
}

bool pure_is_capture_dirname(const char *name) {
  if (name == NULL) return false;
  size_t n = 0;
  while (name[n] != '\0') {
    if (n > 36) return false; /* longer than a UUID; stop early */
    n++;
  }
  if (n != 36) return false;
  for (int i = 0; i < 36; i++) {
    const char c = name[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
      continue;
    }
    const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    if (!hex) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/* ------------------------------------------------------------------ */

int pure_scale_sixteenths(uint32_t w, uint32_t h, uint32_t box_w, uint32_t box_h) {
  if (w == 0u || h == 0u || box_w == 0u || box_h == 0u) return 0;
  const uint32_t by_w = (box_w * 16u) / w;
  const uint32_t by_h = (box_h * 16u) / h;
  uint32_t n = by_w < by_h ? by_w : by_h;
  /* Below 1/16 the picture cannot be made to fit at all. Returning 1 here -
   * which this did - hands back a ratio whose output is LARGER than the
   * destination, and the PPA then writes outside the tile it was given. The
   * host test caught it: 1600 wide at 1/16 is 100 px into a 96 px box.
   *
   * No caller is currently reducing by more than 16x (UXGA into 320x240 is
   * 2.5x, into a 208x156 gallery tile is 7.7x), so nothing overflows today.
   * That is luck, not a guarantee, and the next box size someone picks is
   * where the luck runs out. 0 means "cannot fit" and both callers already
   * treat a zero output size as a refusal. */
  if (n < 1u) return 0;
  if (n > 16u) n = 16u;
  return (int)n;
}

/* ------------------------------------------------------------------ */
/* Clock                                                              */
/* ------------------------------------------------------------------ */

bool pure_epoch_plausible(int64_t epoch_ms) {
  return epoch_ms >= PURE_EPOCH_MS_MIN && epoch_ms <= PURE_EPOCH_MS_MAX;
}

int pure_clamp_utc_offset_min(int offset_min) {
  if (offset_min < -840 || offset_min > 840) return 0;
  return offset_min;
}

pure_clock_action_t pure_clock_restore_action(bool have_saved, int64_t saved_ms,
                                             int64_t system_now_ms) {
  const bool saved_ok = have_saved && pure_epoch_plausible(saved_ms);
  const bool system_ok = pure_epoch_plausible(system_now_ms);

  if (saved_ok && system_ok) {
    /* Both are real times, so take the later one. Equal counts as keep: there
     * is nothing to gain from a settimeofday() that changes nothing. */
    return saved_ms > system_now_ms ? PURE_CLOCK_RESTORE_SAVED : PURE_CLOCK_KEEP_SYSTEM;
  }
  if (saved_ok) return PURE_CLOCK_RESTORE_SAVED;
  if (system_ok) return PURE_CLOCK_KEEP_SYSTEM;
  return PURE_CLOCK_UNSET;
}

pure_clock_adopt_t pure_clock_adopt_action(int current_rank, int64_t current_ms,
                                           int incoming_rank, int64_t incoming_ms) {
  if (!pure_epoch_plausible(incoming_ms)) return PURE_CLOCK_REJECT_IMPLAUSIBLE;
  if (incoming_rank < current_rank) return PURE_CLOCK_REJECT_RANK;
  if (incoming_rank > current_rank) {
    /* A better source is allowed to move the clock backwards. Refusing here
     * would leave a unit that once had a wrong time permanently unable to be
     * corrected, which is worse than one backwards step. */
    return PURE_CLOCK_ADOPT;
  }
  if (incoming_rank == PURE_CLOCK_RANK_HOST) {
    /* A host at the same rank is a person typing a time in, which is what
     * SET_TIME has always been and what the bench uses to fix a clock that is
     * wrong the other way. The backwards guard is for automatic sources. */
    return PURE_CLOCK_ADOPT;
  }
  if (incoming_ms < current_ms) return PURE_CLOCK_REJECT_BACKWARDS;
  return PURE_CLOCK_ADOPT;
}

/*
 * Days-from-civil / civil-from-days, after Howard Hinnant's public-domain
 * chrono algorithms. Used instead of gmtime_r so the device and the host test
 * run identical arithmetic with no libc or timezone involvement — a formatter
 * that agreed with the test only because both called the same libc would be
 * testing libc.
 *
 * Era-based: shifts the year so March is month 1, which makes the leap day the
 * last day of the year and removes every special case from the month-length
 * table.
 */
static void civil_from_days(int64_t z, int *y_out, unsigned *m_out, unsigned *d_out) {
  z += 719468; /* shift epoch from 1970-01-01 to 0000-03-01 */
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = (unsigned)(z - era * 146097);                    /* 0..146096 */
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; /* 0..399 */
  const int64_t y = (int64_t)yoe + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);         /* 0..365 */
  const unsigned mp = (5 * doy + 2) / 153;                              /* 0..11 */
  const unsigned d = doy - (153 * mp + 2) / 5 + 1;                      /* 1..31 */
  const unsigned m = mp < 10 ? mp + 3 : mp - 9;                         /* 1..12 */

  *y_out = (int)(y + (m <= 2 ? 1 : 0));
  *m_out = m;
  *d_out = d;
}

void pure_format_iso8601(int64_t epoch_ms, int offset_min, char *out, size_t cap) {
  if (out == NULL || cap == 0) return;

  const int64_t local_ms = epoch_ms + (int64_t)offset_min * 60000;
  /* Floor division, so instants before the epoch still land on the right day
   * rather than rounding toward zero into the wrong one. */
  int64_t secs = local_ms / 1000;
  if (local_ms % 1000 != 0 && local_ms < 0) secs -= 1;

  int64_t days = secs / 86400;
  int64_t rem = secs % 86400;
  if (rem < 0) {
    rem += 86400;
    days -= 1;
  }

  int year = 0;
  unsigned month = 0, day = 0;
  civil_from_days(days, &year, &month, &day);

  const unsigned hh = (unsigned)(rem / 3600);
  const unsigned mm = (unsigned)((rem % 3600) / 60);
  const unsigned ss = (unsigned)(rem % 60);

  const int off = offset_min;
  const int abs_off = off < 0 ? -off : off;
  snprintf(out, cap, "%04d-%02u-%02uT%02u:%02u:%02u%c%02d:%02d", year, month, day, hh, mm, ss,
           off < 0 ? '-' : '+', abs_off / 60, abs_off % 60);
}

/* ------------------------------------------------------------------ */
/* Wi-Fi credentials                                                  */
/* ------------------------------------------------------------------ */

bool pure_wifi_ssid_valid(const char *ssid) {
  if (ssid == NULL) return false;
  size_t n = strlen(ssid);
  if (n == 0 || n > PURE_SSID_MAX) return false;
  for (size_t i = 0; i < n; i++) {
    const unsigned char c = (unsigned char)ssid[i];
    /* Reject C0 controls and DEL. Everything above 0x7f is left alone: an AP
     * named in UTF-8 is an AP the camera has to be able to join, and this
     * value is also an NVS key suffix, so rewriting it would save a network
     * that can never match the scan result it came from. */
    if (c < 0x20 || c == 0x7f) return false;
  }
  return true;
}

bool pure_wifi_passphrase_ok(const char *passphrase, bool is_open, bool keeps_stored) {
  const size_t n = passphrase == NULL ? 0 : strlen(passphrase);

  if (is_open) {
    /* An open network takes no passphrase. Accepting one and then not using
     * it would store a secret the radio never presents, which is worse than
     * refusing: it reads on the display as a protected network. */
    return n == 0;
  }

  /* The keep-what-is-stored case, checked BEFORE the length rule. Reversing
   * these two makes editing a saved network's autoJoin impossible, because
   * the host has only ever been given the mask. */
  if (n == 0) return keeps_stored;

  return n >= PURE_WPA_PASSPHRASE_MIN && n <= PURE_WPA_PASSPHRASE_MAX;
}

bool pure_api_base_ok(const char *url) {
  if (url == NULL) return false;
  const char *host;
  if (strncmp(url, "https://", 8) == 0) {
    host = url + 8;
  } else if (strncmp(url, "http://", 7) == 0) {
    host = url + 7;
  } else {
    return false;
  }
  if (*host == '\0') return false;
  size_t n = 0;
  for (const char *c = url; *c != '\0'; c++) {
    if (++n > PURE_API_BASE_MAX) return false;
    if ((unsigned char)*c <= 0x20 || (unsigned char)*c >= 0x7f) return false;
    if (*c == '@' || *c == '?' || *c == '#') return false;
  }
  /* Nothing after host[:port]: no path, no trailing slash. */
  for (const char *c = host; *c != '\0'; c++) {
    if (*c == '/') return false;
  }
  /* A port, if present, is digits only. */
  const char *colon = strchr(host, ':');
  if (colon != NULL) {
    if (colon == host || colon[1] == '\0') return false;
    for (const char *c = colon + 1; *c != '\0'; c++) {
      if (*c < '0' || *c > '9') return false;
    }
  }
  return true;
}


ui_health_report_t ui_health_step(ui_health_t *h, bool present_due, bool frames_advanced,
                                  bool input_latched) {
  if (h == NULL) return UI_HEALTH_QUIET;

  if (input_latched) {
    /* Saturating: at one tick a second this is 18 hours, and a wrap would let
     * a permanently stuck latch look briefly un-stuck. */
    if (h->latch_ticks < UINT16_MAX) h->latch_ticks++;
  } else {
    h->latch_ticks = 0;
  }

  /* The cause before the symptom - see the header note. */
  if (!h->latch_stuck && h->latch_ticks >= PURE_UI_LATCH_TICKS) {
    h->latch_stuck = true;
    return UI_HEALTH_LATCH_STUCK;
  }
  if (h->latch_stuck && h->latch_ticks == 0) {
    h->latch_stuck = false;
    return UI_HEALTH_LATCH_CLEARED;
  }

  if (!h->stalled) {
    if (present_due && !frames_advanced) {
      h->stalled = true;
      return UI_HEALTH_STALLED;
    }
    return UI_HEALTH_QUIET;
  }

  /* Two ways out, and they are not the same news. A frame arriving means the
   * compositor recovered. Work draining without one means the screen stopped
   * needing a frame it never drew - the episode is over and something was
   * dropped - and saying "presenting again" there would be a fresh lie of
   * exactly the kind this function exists to remove. */
  if (frames_advanced) {
    h->stalled = false;
    return UI_HEALTH_PRESENTING;
  }
  if (!present_due) {
    h->stalled = false;
    return UI_HEALTH_STALL_ENDED;
  }
  return UI_HEALTH_QUIET;
}

const char *capture_unavailable_reason(bool card_mounted, bool any_camera_ready) {
  /* capture_fire()'s own order. The first blocking fact is the useful one. */
  if (!card_mounted) return "No card to write the capture to";
  if (!any_camera_ready) return "No camera node answered";
  return NULL;
}
