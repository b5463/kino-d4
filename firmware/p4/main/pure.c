#include "pure.h"

#include <stdio.h>

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
