#include "wav_probe.h"

#include <stdio.h>
#include <string.h>

/* Little-endian readers. RIFF is little-endian everywhere, and the P4 is too,
 * but byte-at-a-time keeps this honest on a host test compiled anywhere and
 * costs nothing on a header read once per upload. */
static uint16_t rd16(const uint8_t *p) { return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8)); }

static uint32_t rd32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static bool tag_is(const uint8_t *p, const char *four) { return memcmp(p, four, 4) == 0; }

/* fmt is 16 bytes for PCM; the extensible form is longer and the extra bytes
 * are not read here. wFormatTag 0, nChannels 2, nSamplesPerSec 4,
 * nAvgBytesPerSec 8, nBlockAlign 12, wBitsPerSample 14. */
#define FMT_MIN 16

bool wav_probe(const uint8_t *head, size_t len, wav_info_t *out, char *why, size_t why_cap) {
  if (why && why_cap) why[0] = '\0';
  if (out) memset(out, 0, sizeof *out);

  /* Every read below is bounds-checked against `len` rather than against the
   * sizes the file declares. A WAV that says its data chunk is 400 MB is a
   * file someone can put on the card, and the header parse must not follow it
   * off the end of the buffer. */
  if (head == NULL || len < 12 || !tag_is(head, "RIFF") || !tag_is(head + 8, "WAVE")) {
    if (why && why_cap) snprintf(why, why_cap, "not a RIFF/WAVE file");
    return false;
  }

  bool have_fmt = false;
  uint16_t format = 0, channels = 0, bits = 0;
  uint32_t rate = 0;
  uint32_t data_offset = 0, data_bytes = 0;
  bool have_data = false;
  bool data_past_buffer = false;

  size_t pos = 12;
  while (pos + 8 <= len) {
    const uint32_t size = rd32(head + pos + 4);
    const size_t body = pos + 8;
    const size_t avail = len - body;

    if (tag_is(head + pos, "fmt ")) {
      if (size < FMT_MIN || avail < FMT_MIN) {
        if (why && why_cap) snprintf(why, why_cap, "header ends inside the fmt chunk");
        return false;
      }
      format = rd16(head + body);
      channels = rd16(head + body + 2);
      rate = rd32(head + body + 4);
      bits = rd16(head + body + 14);
      have_fmt = true;
    } else if (tag_is(head + pos, "data")) {
      data_offset = (uint32_t)body;
      data_bytes = size;
      /* `head` is normally only the first few KB of the file, so a data size
       * past the end of THIS buffer says nothing about the file. The caller
       * clamps against the real file length; recorded here only so the
       * pathological case has a name. */
      data_past_buffer = size > avail;
      have_data = true;
      break; /* nothing after the samples matters to playback */
    }

    /* Chunks are word-aligned: an odd size carries one pad byte that is not
     * counted in it. Skipping without the pad lands one byte short and every
     * following tag reads as garbage. */
    /* 64-bit: a declared size of 0xFFFFFFFF plus its pad byte wraps a 32-bit
     * size_t to zero, and the comparison below would then pass. */
    const uint64_t step = (uint64_t)size + (size & 1u);
    if (step > avail) break; /* a chunk that runs past the buffer ends the walk */
    pos = body + (size_t)step;
  }

  if (!have_fmt) {
    if (why && why_cap) snprintf(why, why_cap, "no fmt chunk");
    return false;
  }
  if (format != 1) {
    if (why && why_cap) snprintf(why, why_cap, "not PCM (format %u)", (unsigned)format);
    return false;
  }
  if (bits != 16) {
    if (why && why_cap) snprintf(why, why_cap, "not 16-bit PCM");
    return false;
  }
  if (channels != 1) {
    if (why && why_cap) snprintf(why, why_cap, "not mono");
    return false;
  }
  if (rate != WAV_SAMPLE_RATE) {
    if (why && why_cap)
      snprintf(why, why_cap, "sample rate is %u Hz, need %u", (unsigned)rate,
               (unsigned)WAV_SAMPLE_RATE);
    return false;
  }
  if (!have_data) {
    if (why && why_cap) snprintf(why, why_cap, "no data chunk");
    return false;
  }

  if (out) {
    out->sample_rate = rate;
    out->channels = channels;
    out->bits = bits;
    out->data_offset = data_offset;
    out->data_bytes = data_bytes;
    /* Mono 16-bit at 16 kHz is 32 bytes per millisecond, which is exact. In
     * 64-bit so the multiply cannot wrap on a 128 KB clip's declared size. */
    out->duration_ms = (uint32_t)(((uint64_t)data_bytes * 1000ull) / (WAV_SAMPLE_RATE * 2ull));
  }
  /* Playable, with a note: the format is right and the declared length is not
   * something this buffer can confirm. The reason is filled in on a TRUE
   * return here, which is the one case where `why` is not a refusal. */
  if (data_past_buffer && why && why_cap)
    snprintf(why, why_cap, "data chunk claims %u bytes, past the %u read here",
             (unsigned)data_bytes, (unsigned)(len - data_offset));
  return true;
}
