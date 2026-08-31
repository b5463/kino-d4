#include "gallery_index.h"

#include <stdio.h>
#include <string.h>

/* Longest line the renderer can produce, plus the newline. Kept next to the
 * arithmetic it bounds; GIDX_LINE_MAX in the header is the buffer a reader
 * needs and is deliberately larger. */
#define GIDX_LINE_BOUND 61u

size_t gidx_max_bytes(int max_entries) {
  if (max_entries < 0) max_entries = 0;
  return 64u + (size_t)max_entries * GIDX_LINE_BOUND;
}

static char lower(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c; }

static bool same_name(const char *a, const char *b) {
  while (*a != '\0' && *b != '\0') {
    if (lower(*a) != lower(*b)) return false;
    a++;
    b++;
  }
  return *a == *b;
}

bool gidx_is_index_file(const char *name) {
  if (name == NULL) return false;
  return same_name(name, GIDX_FILE) || same_name(name, GIDX_TMP_FILE);
}

/*
 * What may appear in a stored directory name.
 *
 * This is not cosmetic validation. Every name that comes back out of this
 * index is snprintf'd into a path under /sdcard/KINO/CAPTURES and then opened,
 * and the file it comes from lives on a removable card that anyone can edit in
 * a PC. A name holding '/' or starting with '.' would let a hand-edited index
 * point the gallery at a file outside the captures directory. Capture folders
 * are UUIDs, so alphanumerics, '-', '_' and '.' cover everything this firmware
 * ever writes with room to spare.
 *
 * A leading '.' is refused for the same reason gallery.c's readdir loop skips
 * one: it is either a dot entry or a hidden file, and neither is a capture.
 */
static bool name_ok(const char *s, size_t len);

bool gidx_name_ok(const char *name) {
  if (name == NULL) return false;
  return name_ok(name, strlen(name));
}

static bool name_ok(const char *s, size_t len) {
  if (s == NULL || len == 0 || len >= GIDX_NAME_MAX) return false;
  if (s[0] == '.') return false;
  for (size_t i = 0; i < len; i++) {
    const char c = s[i];
    const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                    (c >= 'A' && c <= 'Z') || c == '-' || c == '_' || c == '.';
    if (!ok) return false;
  }
  return true;
}

size_t gidx_render_header(char *out, size_t cap, int entries, int total_seen) {
  if (out == NULL || cap == 0) return 0;
  out[0] = '\0';
  /* total_seen < entries is not a header this reader would ever accept, so it
   * is refused at the writer too rather than written and rejected later. */
  if (entries < 0 || total_seen < entries) return 0;
  const int n = snprintf(out, cap, "%s %u %d %d\n", GIDX_MAGIC, GIDX_VERSION, entries, total_seen);
  if (n < 0 || (size_t)n >= cap) {
    out[0] = '\0';
    return 0;
  }
  return (size_t)n;
}

size_t gidx_render_line(char *out, size_t cap, uint64_t captured_at_ms, const char *name) {
  if (out == NULL || cap == 0) return 0;
  out[0] = '\0';
  if (name == NULL || !name_ok(name, strlen(name))) return 0;
  const int n = snprintf(out, cap, "%llu %s\n", (unsigned long long)captured_at_ms, name);
  if (n < 0 || (size_t)n >= cap) {
    out[0] = '\0';
    return 0;
  }
  return (size_t)n;
}

/**
 * One unsigned decimal field, then either a single space or the end of line.
 *
 * Bounded at 9 digits: these are counts, not timestamps, and a card cannot
 * hold 10^9 captures. The bound is what stops a hand-edited header from
 * overflowing the accumulator into a small plausible number.
 */
static bool take_u(const char **pp, unsigned long *out) {
  const char *p = *pp;
  if (*p < '0' || *p > '9') return false;
  unsigned long v = 0;
  int digits = 0;
  while (*p >= '0' && *p <= '9') {
    if (digits >= 9) return false;
    v = v * 10u + (unsigned long)(*p - '0');
    p++;
    digits++;
  }
  if (*p == ' ') p++;
  else if (*p != '\0') return false;
  *pp = p;
  *out = v;
  return true;
}

bool gidx_parse_header(const char *line, gidx_header_t *out) {
  if (line == NULL || out == NULL) return false;
  const size_t mlen = sizeof GIDX_MAGIC - 1;
  if (strncmp(line, GIDX_MAGIC, mlen) != 0 || line[mlen] != ' ') return false;
  const char *p = line + mlen + 1;
  unsigned long version = 0, entries = 0, seen = 0;
  if (!take_u(&p, &version) || !take_u(&p, &entries) || !take_u(&p, &seen)) return false;
  /* Nothing after the third field. A header with a fourth column is a file
   * from a firmware this one does not understand, whatever it says its version
   * is. */
  if (*p != '\0') return false;
  if (version != GIDX_VERSION) return false;
  if (seen < entries) return false;
  out->version = (unsigned)version;
  out->entries = (int)entries;
  out->total_seen = (int)seen;
  return true;
}

bool gidx_parse_line(const char *line, gidx_entry_t *out) {
  if (line == NULL || out == NULL) return false;
  const char *p = line;
  if (*p < '0' || *p > '9') return false;
  uint64_t ms = 0;
  int digits = 0;
  while (*p >= '0' && *p <= '9') {
    /* 19 digits is the most that cannot overflow a uint64: 10^19-1 is
     * 9.99e18 against UINT64_MAX 1.84e19. A capture's timestamp is 13. */
    if (digits >= 19) return false;
    ms = ms * 10u + (uint64_t)(*p - '0');
    p++;
    digits++;
  }
  if (*p != ' ') return false;
  p++;
  const size_t len = strlen(p);
  if (!name_ok(p, len)) return false;
  out->captured_at_ms = ms;
  memcpy(out->name, p, len + 1);
  return true;
}

/**
 * Copy the next newline-terminated line into `buf`, return the rest.
 *
 * NULL means there is no complete line left — which is how a file cut short
 * by a power cut loses its last line instead of contributing half a name.
 * A line too long for `buf` yields an empty string rather than a truncated
 * one, so the caller counts it as malformed and skips it.
 */
static const char *take_line(const char *p, char *buf, size_t cap) {
  const char *nl = strchr(p, '\n');
  if (nl == NULL) return NULL;
  size_t len = (size_t)(nl - p);
  /* A card that has been through a Windows editor comes back CRLF. */
  if (len > 0 && p[len - 1] == '\r') len--;
  if (len >= cap) {
    buf[0] = '\0';
  } else {
    memcpy(buf, p, len);
    buf[len] = '\0';
  }
  return nl + 1;
}

int gidx_parse(const char *text, gidx_entry_t *out, int max, gidx_header_t *hdr, int *skipped) {
  if (skipped != NULL) *skipped = 0;
  if (text == NULL || out == NULL || hdr == NULL || max <= 0) return -1;

  char line[GIDX_LINE_MAX];
  const char *p = take_line(text, line, sizeof line);
  if (p == NULL || !gidx_parse_header(line, hdr)) return -1;

  int n = 0;
  while ((p = take_line(p, line, sizeof line)) != NULL) {
    if (line[0] == '\0' || n >= max || !gidx_parse_line(line, &out[n])) {
      if (skipped != NULL) (*skipped)++;
      continue;
    }
    n++;
  }
  return n;
}

int gidx_oldest(const uint64_t *ms, int n) {
  if (ms == NULL || n <= 0) return -1;
  int oldest = 0;
  for (int i = 1; i < n; i++) {
    if (ms[i] < ms[oldest]) oldest = i;
  }
  return oldest;
}
