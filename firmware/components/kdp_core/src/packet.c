#include "kdp/packet.h"

#include <string.h>

#include "kdp/crc32.h"

static void put_u32le(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xFFu);
  p[1] = (uint8_t)((v >> 8) & 0xFFu);
  p[2] = (uint8_t)((v >> 16) & 0xFFu);
  p[3] = (uint8_t)((v >> 24) & 0xFFu);
}

size_t kdp_encode_frame(uint8_t *out, size_t out_cap, uint8_t version, uint8_t type,
                        uint8_t flags, uint32_t seq, const uint8_t *payload,
                        uint32_t payload_len) {
  if (payload_len > KDP_MAX_PAYLOAD) return 0;
  size_t total = KDP_HEADER_LEN + payload_len + KDP_CRC_LEN;
  if (out_cap < total) return 0;

  out[0] = KDP_MAGIC0;
  out[1] = KDP_MAGIC1;
  out[2] = version;
  out[3] = type;
  out[4] = flags;
  out[5] = 0; /* RESERVED */
  put_u32le(out + 6, seq);
  put_u32le(out + 10, payload_len);
  if (payload_len > 0) memcpy(out + KDP_HEADER_LEN, payload, payload_len);
  put_u32le(out + KDP_HEADER_LEN + payload_len,
            kdp_crc32(out, KDP_HEADER_LEN + payload_len));
  return total;
}
