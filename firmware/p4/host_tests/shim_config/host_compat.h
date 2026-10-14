/* Host shim, force-included: strlcpy is in ESP-IDF's newlib and not in every
 * host libc. */
#pragma once

#include <stddef.h>
#include <string.h>

static inline size_t kino_host_strlcpy(char *dst, const char *src, size_t cap) {
  const size_t n = strlen(src);
  if (cap > 0) {
    const size_t k = n < cap - 1 ? n : cap - 1;
    memcpy(dst, src, k);
    dst[k] = '\0';
  }
  return n;
}
#define strlcpy kino_host_strlcpy
