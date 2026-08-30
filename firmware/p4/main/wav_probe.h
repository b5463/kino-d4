/*
 * Reads the header of a RIFF/WAVE file and says whether the camera can play
 * it: PCM, mono, 16-bit, 16 kHz - the device sound format Studio writes
 * (packages/test-fixtures/src/deviceAudio.ts). Pure C, no ESP-IDF:
 * host-tested in firmware/p4/host_tests/test_wav_probe.c.
 */
#ifndef P4_WAV_PROBE_H
#define P4_WAV_PROBE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WAV_SAMPLE_RATE 16000
#define WAV_HEADER_MIN 44

typedef struct {
  uint32_t sample_rate;
  uint16_t channels;
  uint16_t bits;
  uint32_t data_offset; /* first PCM byte */
  uint32_t data_bytes;  /* PCM byte count from the data chunk */
  uint32_t duration_ms; /* derived */
} wav_info_t;

/**
 * Parse the first `len` bytes of a file. True when the format is playable
 * here; `why` (cap `why_cap`) gets a one-line reason otherwise.
 *
 * `len` is normally a few KB of header, not the whole clip, so `data_bytes`
 * is what the file DECLARES and the caller clamps it against the real file
 * length. That one case also writes `why` on a true return - a declared data
 * size past the end of the buffer is worth naming, and is not a refusal.
 */
bool wav_probe(const uint8_t *head, size_t len, wav_info_t *out, char *why, size_t why_cap);

#endif
