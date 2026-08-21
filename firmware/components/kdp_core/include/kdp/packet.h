// KDP frame encoder and layout constants. Byte-exact port of
// packages/kdp/src/protocol/packet.ts (see firmware-contract/kdp-framing.md).
#ifndef KDP_PACKET_H
#define KDP_PACKET_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define KDP_MAGIC0 0x4Bu /* 'K' */
#define KDP_MAGIC1 0x49u /* 'I' */
#define KDP_HEADER_LEN 14u
#define KDP_CRC_LEN 4u
#define KDP_MAX_PAYLOAD 16384u
#define KDP_MAX_FRAME (KDP_HEADER_LEN + KDP_MAX_PAYLOAD + KDP_CRC_LEN)

/**
 * Encode one frame into out. Returns the total frame length
 * (KDP_HEADER_LEN + payload_len + KDP_CRC_LEN), or 0 when payload_len exceeds
 * KDP_MAX_PAYLOAD or out_cap is too small. payload may be NULL when
 * payload_len is 0. A JSON request with no body must be encoded as "{}" by
 * the caller, not as an empty payload.
 */
size_t kdp_encode_frame(uint8_t *out, size_t out_cap, uint8_t version, uint8_t type,
                        uint8_t flags, uint32_t seq, const uint8_t *payload,
                        uint32_t payload_len);

#ifdef __cplusplus
}
#endif

#endif
