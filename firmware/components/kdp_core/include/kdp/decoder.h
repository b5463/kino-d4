// KDP stream decoder. Byte-exact port of FrameDecoder in
// packages/kdp/src/protocol/packet.ts: scans for magic, tolerates boot spew,
// split and coalesced frames, rejects CRC failures, and resyncs without ever
// clearing the buffer or dropping the connection. Counters match
// DecoderStats so GET_RUNTIME_STATS can report them.
#ifndef KDP_DECODER_H
#define KDP_DECODER_H

#include <stddef.h>
#include <stdint.h>

#include "kdp/packet.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint8_t version;
  uint8_t type;
  uint8_t flags;
  uint32_t seq;
  /** Points into the decoder buffer. Valid only inside the callback — copy
   * anything that must outlive it. */
  const uint8_t *payload;
  uint32_t payload_len;
} kdp_frame_t;

typedef struct {
  uint32_t frames;
  uint32_t crc_failures;
  uint32_t resyncs;
  uint32_t discarded_bytes;
} kdp_decoder_stats_t;

typedef void (*kdp_frame_cb_t)(const kdp_frame_t *frame, void *ctx);

typedef struct {
  uint8_t *buf;
  size_t cap;
  size_t len;
  kdp_decoder_stats_t stats;
} kdp_decoder_t;

/**
 * buf/cap: caller-owned working buffer. Use cap >= KDP_MAX_FRAME to accept
 * every legal frame; a smaller buffer still runs, but any frame whose total
 * size exceeds cap is resynced past like a corrupt length.
 */
void kdp_decoder_init(kdp_decoder_t *d, uint8_t *buf, size_t cap);

void kdp_decoder_reset(kdp_decoder_t *d);

/**
 * Feed raw bytes; invokes cb once per complete, CRC-valid frame, in order.
 * Never assumes one read equals one frame. Returns the number of frames
 * emitted by this call.
 */
size_t kdp_decoder_push(kdp_decoder_t *d, const uint8_t *data, size_t len,
                        kdp_frame_cb_t cb, void *ctx);

#ifdef __cplusplus
}
#endif

#endif
