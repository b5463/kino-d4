// CRC-32 IEEE 802.3, reflected, poly 0xEDB88320, init/final-XOR 0xFFFFFFFF.
// Identical to ESP-IDF crc32_le() and zlib crc32(). Self-contained so the
// same bytes run under host gcc and on target.
#ifndef KDP_CRC32_H
#define KDP_CRC32_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t kdp_crc32(const uint8_t *data, size_t len);

/* Streaming form for payloads that arrive in chunks (JPEG transfers):
 *   uint32_t s = kdp_crc32_begin();
 *   s = kdp_crc32_update(s, chunk, len);  // repeat per chunk
 *   uint32_t crc = kdp_crc32_final(s);
 * kdp_crc32(d, n) == kdp_crc32_final(kdp_crc32_update(kdp_crc32_begin(), d, n)). */
uint32_t kdp_crc32_begin(void);
uint32_t kdp_crc32_update(uint32_t state, const uint8_t *data, size_t len);
uint32_t kdp_crc32_final(uint32_t state);

#ifdef __cplusplus
}
#endif

#endif
