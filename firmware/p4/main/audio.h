// Sound on the camera body: ES8311 codec into an NS4150 class-D amp, speaker
// on CN1.
//
// Failure is never fatal here either. A camera with no sound is a camera; a
// camera that will not boot because its speaker is unplugged is a fault.
#ifndef P4_AUDIO_H
#define P4_AUDIO_H

#include <stdbool.h>

#include "esp_err.h"

/** Bring up I2S and the codec. Safe to call once, after board_i2c_bus(). */
esp_err_t audio_init(void);

/** True once the codec answered and the output is open. */
bool audio_ready(void);

/**
 * The shutter, as `shoot.shutterSound` selects it.
 *
 * Four of the five built-ins are synthesised rather than sampled: a
 * mechanical click is a couple of noise transients with a low thump under
 * them, which is a few lines of arithmetic against a WAV on the card that
 * would have to be read, decoded, and kept in sync with the card being
 * present at all. "silent" is the fifth and plays nothing.
 *
 * Any other id names a custom clip uploaded over KDP (kdp_sounds.c), which
 * IS a WAV on the card - read once into PSRAM and cached by id, so the card
 * is touched when the setting changes and not when the shutter is pressed. A
 * clip that cannot be read falls back to the built-in click and logs why.
 *
 * Non-blocking: the sound is queued and played on the audio task. Called from
 * the boot animation as the blades part.
 */
void audio_shutter(void);

/** A brief tick, for tile presses. */
void audio_tick(void);

/**
 * Something did not work: two low 220 Hz pulses, 200 ms apart.
 *
 * Synthesised and rendered once at init like the shutter and the tick, and
 * deliberately unlike either - it is a sustained low tone with no click in it,
 * where those two are transients. A camera that reports a lost photograph with
 * a sound anyone could mistake for a shutter has reported nothing.
 *
 * Gated on `body.sounds.warning` INSIDE this function, not at the call sites,
 * because there are several of them; `shoot.volume` applies as it does to
 * every other sound. Non-blocking: queued and played on the audio task.
 */
void audio_warning(void);

/* Bench calibration. 1 makes the boot run audio_calibrate(); 0 for normal
 * builds. Kept as a switch rather than deleted because the levels below will
 * need re-measuring the moment the speaker, its enclosure, or the amp rail
 * changes - which all three will, when V1 stops being a 3D-printed body. */
#ifndef KINO_AUDIO_CALIBRATE
#define KINO_AUDIO_CALIBRATE 0
#endif

/**
 * Play a sweep of candidate sounds and measure each through the onboard
 * MSM381 mic, printing the levels the speaker actually produced.
 *
 * The ES8311 is a codec, not a DAC, so the camera can hear itself. That
 * turns sound tuning from an exchange of opinions into a measurement: what
 * reaches the DAC has never been the uncertain part, what the speaker and
 * the case do with it is.
 *
 * Blocking, several seconds, and loud. Bench use only.
 */
void audio_calibrate(void);

#endif
