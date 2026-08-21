#include "kdp/crc32.h"

static uint32_t table[256];
static int table_ready;

static void build_table(void) {
  for (uint32_t i = 0; i < 256; i++) {
    uint32_t c = i;
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (~(c & 1u) + 1u));
    table[i] = c;
  }
  table_ready = 1;
}

uint32_t kdp_crc32_begin(void) {
  // ponytail: benign-race lazy init — concurrent builders write identical values
  if (!table_ready) build_table();
  return 0xFFFFFFFFu;
}

uint32_t kdp_crc32_update(uint32_t state, const uint8_t *data, size_t len) {
  if (!table_ready) build_table();
  for (size_t i = 0; i < len; i++) state = (state >> 8) ^ table[(state ^ data[i]) & 0xFFu];
  return state;
}

uint32_t kdp_crc32_final(uint32_t state) { return state ^ 0xFFFFFFFFu; }

uint32_t kdp_crc32(const uint8_t *data, size_t len) {
  return kdp_crc32_final(kdp_crc32_update(kdp_crc32_begin(), data, len));
}
