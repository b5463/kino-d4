#include "kdp/decoder.h"

#include <string.h>

#include "kdp/crc32.h"

static uint32_t get_u32le(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

void kdp_decoder_init(kdp_decoder_t *d, uint8_t *buf, size_t cap) {
  d->buf = buf;
  d->cap = cap;
  d->len = 0;
  memset(&d->stats, 0, sizeof d->stats);
}

void kdp_decoder_reset(kdp_decoder_t *d) { d->len = 0; }

/* One scan pass over the buffered bytes. Mirrors FrameDecoder.push()'s loop;
 * every exit path leaves the retained bytes compacted to the buffer start. */
static size_t scan(kdp_decoder_t *d, kdp_frame_cb_t cb, void *ctx) {
  size_t emitted = 0;
  size_t offset = 0;

  for (;;) {
    /* Scan for magic. */
    size_t start = (size_t)-1;
    for (size_t i = offset; i + 1 < d->len; i++) {
      if (d->buf[i] == KDP_MAGIC0 && d->buf[i + 1] == KDP_MAGIC1) {
        start = i;
        break;
      }
    }
    if (start == (size_t)-1) {
      /* Keep at most the final byte (could be the first half of a magic). */
      size_t keep = (d->len > 0 && d->buf[d->len - 1] == KDP_MAGIC0) ? 1 : 0;
      if (d->len > offset + keep) d->stats.discarded_bytes += (uint32_t)(d->len - keep - offset);
      if (keep) d->buf[0] = KDP_MAGIC0;
      d->len = keep;
      return emitted;
    }
    if (start > offset) {
      d->stats.discarded_bytes += (uint32_t)(start - offset);
      d->stats.resyncs++;
    }

    if (d->len - start < KDP_HEADER_LEN) {
      memmove(d->buf, d->buf + start, d->len - start);
      d->len -= start;
      return emitted;
    }

    uint32_t payload_len = get_u32le(d->buf + start + 10);
    size_t total = (size_t)KDP_HEADER_LEN + payload_len + KDP_CRC_LEN;

    /* Corrupt length — skip past this magic and rescan. A frame larger than
     * the working buffer can never complete, so it takes the same path. */
    if (payload_len > KDP_MAX_PAYLOAD || total > d->cap) {
      d->stats.resyncs++;
      d->stats.discarded_bytes += 2;
      offset = start + 2;
      continue;
    }

    if (d->len - start < total) {
      memmove(d->buf, d->buf + start, d->len - start);
      d->len -= start;
      return emitted;
    }

    uint32_t expected = get_u32le(d->buf + start + KDP_HEADER_LEN + payload_len);
    uint32_t actual = kdp_crc32(d->buf + start, KDP_HEADER_LEN + payload_len);
    if (expected != actual) {
      d->stats.crc_failures++;
      d->stats.resyncs++;
      offset = start + 2; /* resync just past the magic */
      continue;
    }

    kdp_frame_t frame = {
        .version = d->buf[start + 2],
        .type = d->buf[start + 3],
        .flags = d->buf[start + 4],
        .seq = get_u32le(d->buf + start + 6),
        .payload = d->buf + start + KDP_HEADER_LEN,
        .payload_len = payload_len,
    };
    d->stats.frames++;
    emitted++;
    if (cb) cb(&frame, ctx);

    offset = start + total;
    if (offset >= d->len) {
      d->len = 0;
      return emitted;
    }
  }
}

size_t kdp_decoder_push(kdp_decoder_t *d, const uint8_t *data, size_t len,
                        kdp_frame_cb_t cb, void *ctx) {
  size_t emitted = 0;
  size_t consumed = 0;

  do {
    size_t space = d->cap - d->len;
    size_t take = len - consumed < space ? len - consumed : space;
    if (take > 0) {
      memcpy(d->buf + d->len, data + consumed, take);
      d->len += take;
      consumed += take;
    }
    emitted += scan(d, cb, ctx);
    /* scan() always frees space when the buffer is full: a full buffer either
     * holds a complete frame (consumed), an over-cap claim (resynced past),
     * or garbage (discarded). The one exception is cap < KDP_HEADER_LEN,
     * where a header can never complete — drop a byte so push cannot stall. */
    if (consumed < len && d->len == d->cap) {
      memmove(d->buf, d->buf + 1, --d->len);
      d->stats.discarded_bytes++;
    }
  } while (consumed < len);

  return emitted;
}
