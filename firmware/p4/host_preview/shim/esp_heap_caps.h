// Host shim. There is one heap here, so every capability maps to malloc.
#pragma once
#include <stdlib.h>

#define MALLOC_CAP_DEFAULT 0
#define MALLOC_CAP_INTERNAL 0
#define MALLOC_CAP_SPIRAM 0
#define MALLOC_CAP_8BIT 0

static inline void *heap_caps_malloc(size_t n, int caps) {
  (void)caps;
  return malloc(n);
}
static inline void *heap_caps_calloc(size_t c, size_t n, int caps) {
  (void)caps;
  return calloc(c, n);
}
static inline void *heap_caps_realloc(void *p, size_t n, int caps) {
  (void)caps;
  return realloc(p, n);
}
static inline void *heap_caps_aligned_calloc(size_t align, size_t c, size_t n, int caps) {
  (void)align;
  (void)caps;
  return calloc(c, n);
}
