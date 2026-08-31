#include "audio.h"

#include <math.h>
#include <string.h>

#include "board_d4v1.h"
#include "board_i2c.h"
#include "config_store.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "taskmon.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "kdp_sounds.h"
#include "klog.h"
#include "storage.h"
#include "wav_probe.h"

static const char *TAG = "audio";

#define SAMPLE_RATE 16000
#define CHANNELS 2

/* Codec volume, 0-100. esp_codec_dev maps it linearly to dB with a 2-point
 * default curve: dB = -50 + vol/2 (esp_codec_dev.c, _get_default_vol_curve).
 * So this is -20 dB, which is the value Espressif's own ESP32-P4 board
 * example uses for the same ES8311 + NS4150 pairing.
 *
 * It was briefly 78 (-11 dB), i.e. 9 dB hotter than the reference for stock
 * hardware, on the mistaken theory that a quiet press tick needed more master
 * volume. It did not - it needed a slower decay - and running the whole
 * device hot to fix one sound made everything else too loud. Balance belongs
 * in the per-sound levels below; this sets the ceiling they sit under. */
#define AUDIO_VOLUME 60

/* Mic gain for the calibration path, in dB. Fixed, because measurements are
 * only comparable to each other if the input gain never moves.
 *
 * The clipping that made this look too high was never acoustic - it was the
 * codec's digital feedback path (reg 0x44) returning the signal we had just
 * sent, at full digital level. With that turned off this is a real analog
 * mic through a PGA, where 0 dB is near-useless: everything came back at the
 * noise floor. */
#define AUDIO_MIC_GAIN_DB 30.0f

/* Ignore this much of the front of each recording.
 *
 * open() asserts the amp enable and starts the ADC, and both land in the
 * first few milliseconds as a transient that has nothing to do with the sound
 * being measured - it read as a full-scale peak even when the buffer played
 * was pure silence. The synthesised sound does not begin until LEAD_MS, so
 * discarding slightly less than that removes the artefact without clipping
 * the attack, which is the loudest part of what we actually want to measure. */
#define CAL_SKIP_MS 25

static i2s_chan_handle_t s_tx;
static i2s_chan_handle_t s_rx;
static esp_codec_dev_handle_t s_dev;
static bool s_ready;

/* Playback happens on its own task; see the queue section below for why. */
typedef enum { SND_SHUTTER, SND_TICK, SND_WARNING } sound_t;
static QueueHandle_t s_queue;
static void audio_task(void *arg);
static void post(sound_t which);

/* The two sounds, rendered once at init and kept.
 *
 * They were synthesised on every press: ~33 KB of internal DRAM allocated and
 * freed, and about 2000 expf() and sinf() calls, to produce a buffer that is
 * bit-identical each time - the noise generator is reseeded to a constant at
 * the top of the loop precisely so that it is. Nothing about a click depends
 * on when it is played, so it is rendered once.
 *
 * PSRAM, not internal. esp_codec_dev_write() hands the buffer to
 * i2s_channel_write(), which copies it into the DMA descriptors; the pointer
 * itself is never given to the DMA engine, so it does not have to be
 * DMA-capable. Together the two are about 30 KB, which is worth keeping out
 * of internal memory on a device whose framebuffers already live in PSRAM. */
static int16_t *s_shutter_pcm;
static size_t s_shutter_bytes;
static int16_t *s_tick_pcm;
static size_t s_tick_bytes;
/* body.sounds.warning: something did not work. Rendered once like the rest. */
static int16_t *s_warn_pcm;
static size_t s_warn_bytes;
/* The other three built-in shutter sounds the contract names
 * (BUILTIN_SHUTTER_SOUNDS in packages/kdp/src/protocol/types.ts). "silent" is
 * the fifth and needs no buffer. Same reasoning as the two above: rendered
 * once at init, kept in PSRAM, never allocated on a press.
 *
 * All four together are about 60 KB. Rendering only the selected one would
 * halve that and cost a card-free setting change a render on the audio task
 * mid-press, which is the stall this whole file is arranged to avoid. */
static int16_t *s_digi_pcm;
static size_t s_digi_bytes;
static int16_t *s_beep_pcm;
static size_t s_beep_bytes;
static int16_t *s_mech_pcm;
static size_t s_mech_bytes;
static void audio_render_sounds(void);

bool audio_ready(void) { return s_ready; }

esp_err_t audio_init(void) {
  if (s_ready) return ESP_OK;

  i2c_master_bus_handle_t bus = NULL;
  esp_err_t err = board_i2c_bus(&bus);
  if (err != ESP_OK) return err;

  /* I2S in master mode: the P4 generates MCLK, BCLK and LRCK, and the codec
   * follows. use_mclk below has to agree with actually routing MCLK here.
   *
   * Full duplex. The ES8311 is a codec, not a DAC, and this board wires an
   * MSM381 analog mic into its ADC, so the same I2S port carries playback out
   * on DOUT and the mic back in on DIN. That is what makes audio_calibrate()
   * below possible: the camera can hear its own speaker. */
  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  /* Zero the DMA buffer once it has been sent.
   *
   * Without this the channel keeps transmitting whatever was last in the
   * buffer, forever: one shutter click became a click repeating several times
   * a second into the speaker until the board was unplugged. An I2S TX
   * channel does not stop when you stop feeding it, it just runs out of new
   * data - so the safe default is that running out of data means silence. */
  chan_cfg.auto_clear = true;
  /* RX only for calibration builds. The mic costs a powered ADC and a running
   * RX channel for the whole session, and on a battery camera that is not
   * worth paying for a path nothing currently reads. */
  err = i2s_new_channel(&chan_cfg, &s_tx, KINO_AUDIO_CALIBRATE ? &s_rx : NULL);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "i2s channel failed: %s", esp_err_to_name(err));
    return err;
  }

  i2s_std_config_t std_cfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
      .slot_cfg =
          I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg = {
          .mclk = BOARD_I2S_MCLK,
          .bclk = BOARD_I2S_BCLK,
          .ws = BOARD_I2S_LRCK,
          .dout = BOARD_I2S_DOUT,
          .din = BOARD_I2S_DIN,
          .invert_flags = {0},
      },
  };
  err = i2s_channel_init_std_mode(s_tx, &std_cfg);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "i2s tx std mode failed: %s", esp_err_to_name(err));
    return err;
  }
  if (s_rx != NULL) {
    err = i2s_channel_init_std_mode(s_rx, &std_cfg);
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "i2s rx std mode failed: %s", esp_err_to_name(err));
      return err;
    }
  }
  /* The channels are deliberately left disabled here. esp_codec_dev's I2S
   * data interface enables them on open and disables them on close; enabling
   * them here as well meant every close tried to disable an already-disabled
   * channel and logged an error pair for it. Ownership of the channel state
   * belongs to whoever opens the device. */

  audio_codec_i2s_cfg_t i2s_if_cfg = {.tx_handle = s_tx, .rx_handle = s_rx};
  const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_if_cfg);

  audio_codec_i2c_cfg_t i2c_cfg = {.addr = BOARD_ES8311_ADDR_8BIT, .bus_handle = bus};
  const audio_codec_ctrl_if_t *ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
  const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();
  if (data_if == NULL || ctrl_if == NULL || gpio_if == NULL) {
    ESP_LOGE(TAG, "codec interfaces unavailable (ES8311 at 0x%02x?)", BOARD_ES8311_ADDR_7BIT);
    return ESP_FAIL;
  }

  es8311_codec_cfg_t es_cfg = {
      /* DAC only unless a calibration build needs the mic. Note the ADC path
       * is NOT usable as-is even when enabled: the ES8311's analog input
       * still needs mic bias, PGA input selection and the ADC high-pass
       * configured, without which it returns DC offset and PGA noise that
       * pins the converter at full scale on silence. */
      .codec_mode =
          KINO_AUDIO_CALIBRATE ? ESP_CODEC_DEV_WORK_MODE_BOTH : ESP_CODEC_DEV_WORK_MODE_DAC,
      .ctrl_if = ctrl_if,
      .gpio_if = gpio_if,
      /* The amp enable, driven by the codec driver. R19 pulls it down, so the
       * NS4150 comes up muted and stays silent until this is asserted - a
       * connected speaker that makes no sound is this pin before it is
       * anything else. */
      .pa_pin = BOARD_AUDIO_PA_EN,
      .use_mclk = true,
  };
  const audio_codec_if_t *codec_if = es8311_codec_new(&es_cfg);
  if (codec_if == NULL) {
    ESP_LOGE(TAG, "ES8311 did not answer at 0x%02x on SDA%d/SCL%d", BOARD_ES8311_ADDR_7BIT,
             BOARD_I2C_SDA, BOARD_I2C_SCL);
    return ESP_FAIL;
  }

  esp_codec_dev_cfg_t dev_cfg = {
      .codec_if = codec_if,
      .data_if = data_if,
      .dev_type = KINO_AUDIO_CALIBRATE ? ESP_CODEC_DEV_TYPE_IN_OUT : ESP_CODEC_DEV_TYPE_OUT,
  };
  s_dev = esp_codec_dev_new(&dev_cfg);
  if (s_dev == NULL) {
    ESP_LOGE(TAG, "codec dev creation failed");
    return ESP_FAIL;
  }

  /* Deliberately NOT opened here.
   *
   * esp_codec_dev asserts the amp enable while the device is open, so
   * holding it open leaves an amplifier powered and a speaker connected to
   * an idle DAC for the whole session - audible as hiss at best, and current
   * drawn from the battery rail for nothing. Each sound opens, plays and
   * closes, so the amp is live only while something is actually playing. */
  s_ready = true;
  /* The codec answered on the shared bus at its 8-bit address. Not the same
   * claim as "a speaker made a sound" - that is HWV_AUDIO_AMP_GPIO11, marked
   * only once samples have actually been clocked out. */
  hwv_mark_validated(HWV_AUDIO_ES8311, "answered at 0x18 on the shared bus");
  hwv_mark_validated(HWV_I2C_SHARED_BUS, "GT911 and ES8311 both answered");
  /* Length 2: one sound playing and one waiting is as much backlog as is ever
   * useful. */
  s_queue = xQueueCreate(2, sizeof(sound_t));
  if (s_queue == NULL) {
    ESP_LOGE(TAG, "no room for the sound queue");
    s_ready = false;
    return ESP_ERR_NO_MEM;
  }
  /* Both sounds, before the task that plays them exists. Rendering here
   * rather than on first press also means a failure is reported at boot,
   * next to the rest of the audio bring-up, instead of at the first tap. */
  audio_render_sounds();

  TaskHandle_t h = NULL;
  /* Checked. Without the task nothing ever drains the queue, so every sound
   * is posted, accepted and silently dropped - "no sound" that looks
   * identical to a disconnected speaker. */
  if (xTaskCreate(audio_task, "audio", 4096, NULL, 3, &h) != pdPASS) {
    ESP_LOGE(TAG, "no room for the audio task - the camera will be silent");
    /* s_ready was set above; leaving it true would make audio_ready() answer
     * for a task that does not exist. */
    s_ready = false;
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("audio", h);

  ESP_LOGI(TAG, "AUDIO_READY es8311 at 0x%02x, %d Hz, vol %d (%.1f dB), amp GPIO%d, mic DIN%d",
           BOARD_ES8311_ADDR_7BIT, SAMPLE_RATE, AUDIO_VOLUME, -50.0 + AUDIO_VOLUME / 2.0,
           BOARD_AUDIO_PA_EN, BOARD_I2S_DIN);
  klog("P4", "audio up es8311");

  /* body.sounds.startup, the boot chime. The tick rather than the shutter:
   * the shutter is a photograph being taken and a camera that appears to take
   * one every time it is switched on is a camera nobody trusts.
   *
   * Posted, not played - audio_init() runs on the boot task and play_click()
   * blocks for the length of a sound. config_init() is called well before
   * this in main.c (line 181 against 305), so the setting is loaded by now;
   * without that ordering this would read the default rather than what
   * someone chose. */
  if (config_bool("body.sounds.startup", true)) post(SND_TICK);
  return ESP_OK;
}

/* xorshift32 - deterministic noise, so the shutter sounds the same every
 * time. A shutter that varies run to run sounds like a fault. */
static uint32_t s_rng = 0x1234567u;
static inline float noise(void) {
  s_rng ^= s_rng << 13;
  s_rng ^= s_rng >> 17;
  s_rng ^= s_rng << 5;
  return (float)((int32_t)s_rng) / 2147483648.0f;
}

/* One sound's shape.
 *
 * Named fields because the previous positional form hid the two parameters
 * that actually decide how loud something sounds - the decay rate and the
 * thump amplitude were both hardcoded, so tuning the arguments moved
 * everything except what needed to move. */
typedef struct {
  int total_ms;    /* buffer length; the decay below sets audible length */
  int spacing_ms;  /* 0 for a single transient */
  float bright;    /* one-pole coefficient on the noise; higher is hissier */
  float decay;     /* transient decay, 1/s. SMALLER RINGS LONGER. */
  float thump_hz;  /* body frequency, 0 for none */
  float thump_amp; /* body amplitude relative to the transient */
  float level;     /* target peak, 0..1 of full scale - see render_click() */
} click_t;

/* A tail of silence is part of the sound, not padding: it pushes the last of
 * the click out of the DMA buffer so nothing is left to repeat, and it gives
 * the amp a quiet moment before it is switched off, which is what stops the
 * shutdown itself becoming an audible thump. */
#define TAIL_MS 40
/* Silence first, so the amp is awake before the sound arrives.
 *
 * open() asserts the amp enable and the NS4150 takes a moment to come out of
 * shutdown. A short sound played immediately into that is partly or entirely
 * lost - which is exactly what happened to the 45 ms press tick while the
 * 200 ms shutter came through fine. Leading silence also gives the amp's own
 * turn-on transient somewhere harmless to land. */
#define LEAD_MS 30

/**
 * Render a synthesised click into an interleaved stereo buffer.
 *
 * A mechanical shutter is two short broadband transients - blades parting,
 * blades landing - over a low thump of body. `spacing_ms` at 0 gives the
 * single tick used for presses.
 *
 * The result is peak-normalised to `level`, so `level` is an absolute target
 * rather than a multiplier on whatever the synthesis happened to sum to. That
 * matters: the old gain was applied to an unnormalised mix, so the tick at
 * "gain 1.0" peaked around 18000 of 32767 while the shutter clipped, and the
 * two numbers could not be compared with each other at all.
 */
static esp_err_t render_click(const click_t *c, int16_t **out, size_t *out_bytes) {
  const int lead = SAMPLE_RATE * LEAD_MS / 1000;
  const int frames = SAMPLE_RATE * (LEAD_MS + c->total_ms + TAIL_MS) / 1000;
  const int voiced = SAMPLE_RATE * c->total_ms / 1000;
  const size_t bytes = (size_t)frames * CHANNELS * sizeof(int16_t);

  /* Rendered in float first, because the peak is not known until the whole
   * sound exists and normalising needs it. Internal, and freed before this
   * returns - it is scratch, not the result. */
  float *mono = heap_caps_calloc((size_t)voiced, sizeof(float), MALLOC_CAP_DEFAULT);
  /* PSRAM: the result is kept for the life of the device, and the codec copies
   * it rather than pointing the DMA at it. See the retained buffers above. */
  int16_t *buf = heap_caps_calloc(1, bytes, MALLOC_CAP_SPIRAM);
  if (mono == NULL || buf == NULL) {
    free(mono);
    free(buf);
    return ESP_ERR_NO_MEM;
  }

  const int second = c->spacing_ms > 0 ? SAMPLE_RATE * c->spacing_ms / 1000 : -1;
  /* One-pole low-pass state, to take the hiss off raw noise: an unfiltered
   * burst sounds like static, not a mechanism. */
  float lp = 0.0f;
  float peak = 0.0f;

  s_rng = 0x1234567u; /* same click every time */
  for (int i = 0; i < voiced; i++) {
    const float t = (float)i / (float)SAMPLE_RATE;

    /* Transients: fast attack, exponential decay. */
    float env = expf(-t * c->decay);
    if (second > 0 && i >= second) {
      const float t2 = (float)(i - second) / (float)SAMPLE_RATE;
      env += 0.8f * expf(-t2 * c->decay * 0.78f);
    }

    const float n = noise();
    lp += (n - lp) * c->bright;
    float s = lp * env;

    /* Body: a short low sine so the click has weight through a small
     * speaker, where the transient alone is thin. */
    if (c->thump_hz > 0.0f)
      s += c->thump_amp * sinf(6.2831853f * c->thump_hz * t) * expf(-t * 26.0f);

    mono[i] = s;
    const float a = fabsf(s);
    if (a > peak) peak = a;
  }

  /* 32000 rather than 32767: a little room so normalisation itself never
   * lands on the rail. */
  const float scale = peak > 1e-4f ? (c->level * 32000.0f) / peak : 0.0f;
  for (int i = 0; i < voiced; i++) {
    float v = mono[i] * scale;
    if (v > 32000.0f) v = 32000.0f;
    if (v < -32000.0f) v = -32000.0f;
    buf[(lead + i) * CHANNELS] = (int16_t)v;
    buf[(lead + i) * CHANNELS + 1] = (int16_t)v;
  }
  free(mono);

  *out = buf;
  *out_bytes = bytes;
  return ESP_OK;
}

/** Open, play, close. The amp is enabled by the open and muted by the close,
 *  so it is powered for the length of one sound and no longer.
 *
 *  Takes finished PCM rather than a click_t: the samples are rendered once at
 *  init and this only clocks them out. */
static void play_click(const int16_t *pcm, size_t bytes) {
  if (!s_ready) return;
  if (pcm == NULL || bytes == 0) {
    /* The render failed at boot and audio_render_sounds() said so there. Said
     * again here because a play_click() that returns without a word is the
     * exact ambiguity the open-failure branch below exists to prevent. */
    ESP_LOGW(TAG, "no rendered samples; sound skipped");
    return;
  }

  esp_codec_dev_sample_info_t fs = {
      .sample_rate = SAMPLE_RATE,
      .channel = CHANNELS,
      .bits_per_sample = 16,
  };
  int rc = esp_codec_dev_open(s_dev, &fs);
  if (rc != 0) {
    /* Never silent. An earlier version skipped playback on a failed open
     * without a word, which makes "no sound" indistinguishable from "the
     * codec refused to start" - the exact ambiguity this firmware keeps
     * being bitten by. */
    ESP_LOGW(TAG, "codec open failed (%d); sound skipped", rc);
    return;
  }

  /* shoot.volume is 0..10 in the contract. Map it around the stock working
   * point rather than across the codec's whole range: 0 is silence, and the
   * rest spans -30 dB to -10 dB, which brackets the -20 dB that Espressif's
   * own example uses for this codec and amp. Handing a 0..100 codec scale
   * straight to a 0..10 setting would make step 10 painfully loud and steps
   * 1-3 inaudible. */
  const int want = config_int("shoot.volume", 6);
  const int vol = want <= 0 ? 0 : 40 + want * 2;
  esp_codec_dev_set_out_vol(s_dev, vol);
  if (want <= 0) {
    /* Muted: still open and close so the amp state machine stays identical,
     * but send nothing. */
    esp_codec_dev_close(s_dev);
    return;
  }
  /* The const is cast off because esp_codec_dev_write takes a plain void*,
   * and that is only safe because it leaves the buffer alone here: it applies
   * software volume IN PLACE (esp_codec_dev.c, the dev->sw_vol branch), and
   * sw_vol is created only when the codec has no set_vol of its own. The
   * ES8311 has one (es8311.c sets base.set_vol), so sw_vol stays NULL and the
   * samples go straight to i2s_channel_write, which copies them. Fit a codec
   * without hardware volume and this buffer would be attenuated on every
   * play until it decayed to silence - render per call again if that day
   * comes. */
  int written = esp_codec_dev_write(s_dev, (void *)pcm, bytes);
  if (written != 0) ESP_LOGW(TAG, "codec write returned %d", written);
  else hwv_mark_validated(HWV_AUDIO_AMP_GPIO11, "samples clocked out with the amp enabled");

  /* Wait for the DMA to actually clock the samples out before muting.
   *
   * esp_codec_dev_write returns once the data is queued, not once it has been
   * played, so closing straight afterwards switched the amp off before the
   * sound reached the speaker - silence, with every call reporting success.
   * The tail already in the buffer covers the amp's own switch-off click;
   * this covers the sound itself. */
  vTaskDelay(pdMS_TO_TICKS(TAIL_MS + 80));
  esp_codec_dev_close(s_dev);
}

/* Deliberately restrained, and the body is gone rather than merely reduced.
 *
 * Three rounds of cutting the level failed to stop this reading as "too
 * strong": measured, it was already 9 dB below the press tick that was being
 * called too soft at the same time. Level was never the problem. A 95 Hz
 * impulse into a small speaker in a plastic body is felt as a thud however
 * quiet it is, so the thump is removed and the shutter is now purely the two
 * mechanical transients it is supposed to be. */
static const click_t CLICK_SHUTTER = {.total_ms = 200,
                                      .spacing_ms = 55,
                                      .bright = 0.55f,
                                      .decay = 90.0f,
                                      .thump_hz = 0.0f,
                                      .thump_amp = 0.0f,
                                      .level = 0.24f};

/* Full scale at the master volume above, and rings more than twice as long as
 * the first attempt.
 *
 * decay 40 rather than 90 is what actually made this audible - at 90 the tick
 * was gone within 35 ms no matter how long the buffer was, which is why
 * stretching total_ms from 45 to 110 ms changed nothing at all. 170 Hz for
 * the body: high enough to be radiated by a small speaker rather than
 * rattling the case the way the shutter's 95 Hz did. */
static const click_t CLICK_TICK = {.total_ms = 130,
                                   .spacing_ms = 0,
                                   .bright = 0.7f,
                                   .decay = 40.0f,
                                   .thump_hz = 170.0f,
                                   .thump_amp = 0.25f,
                                   .level = 0.60f};

/*
 * Something did not work: two low pulses, 200 ms apart.
 *
 * It has one job, which is to be unmistakable for the other two sounds the
 * camera makes at the same moments. It differs from both on every axis that
 * carries at arm's length through a small speaker:
 *
 *   pitch    220 Hz, an octave below the tick's 170 Hz body is not available
 *            through this speaker, so it goes the other way and is the only
 *            sound with a sustained low TONE rather than a transient.
 *   texture  bright 0.15 against the shutter's 0.55 and the tick's 0.7 - the
 *            noise is filtered down to a dull thud, so there is no click in
 *            it at all.
 *   length   two pulses 200 ms apart over 460 ms, against the shutter's 55 ms
 *            spacing. Nobody hears this as one mechanism operating twice.
 *
 * Deliberately below the tick's 0.60 level. A warning has to be heard, not
 * to be the loudest thing the camera does - the tick fires on every press and
 * this fires when a photograph was lost.
 */
static const click_t CLICK_WARNING = {.total_ms = 460,
                                      .spacing_ms = 200,
                                      .bright = 0.15f,
                                      .decay = 22.0f,
                                      .thump_hz = 220.0f,
                                      .thump_amp = 1.4f,
                                      .level = 0.45f};

/* The three alternative shutter sounds, built from the same click_t fields.
 *
 * Each is a shape, not a measurement: nothing here has been through
 * audio_calibrate(), and the levels are the shipping shutter's 0.24 give or
 * take, so none of them can be louder than the sound already judged right.
 * What they have to be is TELLABLE APART - someone picking one on the SOUND
 * screen is choosing between four things that must not all sound like the
 * click.
 *
 * The thump voice is one sine at thump_hz decaying over about 40 ms
 * (render_click's fixed exp(-t*26)), so raising it into the audible band is
 * how a click_t makes a tone at all. That is what the first two do; the third
 * goes the other way and leans on the body.
 *
 * All three stay under 250 ms of voiced length, so a burst of presses still
 * sounds like a camera keeping up. */

/* Thin and electronic: two very short bright transients over a 1.2 kHz tone.
 * decay 260 kills each transient inside 10 ms, which is what makes it read as
 * a cheap digital camera rather than a mechanism. */
static const click_t CLICK_CHEAP_DIGI = {.total_ms = 150,
                                         .spacing_ms = 70,
                                         .bright = 0.9f,
                                         .decay = 260.0f,
                                         .thump_hz = 1200.0f,
                                         .thump_amp = 1.2f,
                                         .level = 0.28f};

/* A single short high beep. decay 500 leaves the noise transient as barely an
 * onset, so what is left is the 1.8 kHz tone - the only one of the four with
 * no mechanical character at all. */
static const click_t CLICK_TINY_BEEP = {.total_ms = 120,
                                        .spacing_ms = 0,
                                        .bright = 0.5f,
                                        .decay = 500.0f,
                                        .thump_hz = 1800.0f,
                                        .thump_amp = 2.5f,
                                        .level = 0.26f};

/* Heavier than the shipping shutter: two duller transients 90 ms apart with a
 * 110 Hz body under them. This is the one place the thump is deliberately
 * kept - a small speaker in a plastic body turns 110 Hz into a thud, which is
 * exactly what someone choosing "mechanical" is asking for, and it is opt-in
 * rather than what every shutter does. */
static const click_t CLICK_MECHANICAL = {.total_ms = 240,
                                         .spacing_ms = 90,
                                         .bright = 0.35f,
                                         .decay = 55.0f,
                                         .thump_hz = 110.0f,
                                         .thump_amp = 0.45f,
                                         .level = 0.26f};

/**
 * Render both sounds, once, at init.
 *
 * Never fatal - a camera with no sound is a camera - but never silent about
 * it either. A NULL buffer here is the only reason play_click() can do
 * nothing, so the reason is logged at the moment it happens rather than left
 * to be guessed at from a speaker that never clicks.
 */
static void audio_render_sounds(void) {
  if (render_click(&CLICK_SHUTTER, &s_shutter_pcm, &s_shutter_bytes) != ESP_OK) {
    s_shutter_pcm = NULL;
    s_shutter_bytes = 0;
    ESP_LOGW(TAG, "shutter render failed - the shutter will be silent");
  }
  if (render_click(&CLICK_TICK, &s_tick_pcm, &s_tick_bytes) != ESP_OK) {
    s_tick_pcm = NULL;
    s_tick_bytes = 0;
    ESP_LOGW(TAG, "tick render failed - presses will be silent");
  }
  if (render_click(&CLICK_WARNING, &s_warn_pcm, &s_warn_bytes) != ESP_OK) {
    s_warn_pcm = NULL;
    s_warn_bytes = 0;
    ESP_LOGW(TAG, "warning render failed - failed captures will be silent");
  }
  /* The alternatives fail the same way and cost the same nothing: a NULL
   * buffer here makes shutter_pcm_for() fall back to the click, which is a
   * shutter someone did not choose rather than a camera that went quiet. */
  if (render_click(&CLICK_CHEAP_DIGI, &s_digi_pcm, &s_digi_bytes) != ESP_OK) {
    s_digi_pcm = NULL;
    s_digi_bytes = 0;
    ESP_LOGW(TAG, "cheap-digi render failed - it will fall back to the click");
  }
  if (render_click(&CLICK_TINY_BEEP, &s_beep_pcm, &s_beep_bytes) != ESP_OK) {
    s_beep_pcm = NULL;
    s_beep_bytes = 0;
    ESP_LOGW(TAG, "tiny-beep render failed - it will fall back to the click");
  }
  if (render_click(&CLICK_MECHANICAL, &s_mech_pcm, &s_mech_bytes) != ESP_OK) {
    s_mech_pcm = NULL;
    s_mech_bytes = 0;
    ESP_LOGW(TAG, "mechanical render failed - it will fall back to the click");
  }
  ESP_LOGI(TAG,
           "sounds rendered once: shutter %u B, tick %u B, warn %u B, digi %u B, beep %u B, "
           "mech %u B",
           (unsigned)s_shutter_bytes, (unsigned)s_tick_bytes, (unsigned)s_warn_bytes,
           (unsigned)s_digi_bytes, (unsigned)s_beep_bytes, (unsigned)s_mech_bytes);
}

/* ------------------------------------------------------------------ */
/* Custom clips from the card                                          */
/*                                                                     */
/* A custom shutter sound is a 16 kHz mono 16-bit WAV under             */
/* /sdcard/KINO/SOUNDS, validated on upload by kdp_sounds.c. Playback   */
/* needs interleaved stereo at the same rate, so the file is expanded    */
/* once into PSRAM and kept - the whole point of the retained buffers    */
/* above is that pressing the shutter allocates nothing and touches no   */
/* card, and a clip re-read on every press would give that up.           */
/* ------------------------------------------------------------------ */

/* 128 KB is the cap kdp_sounds.c enforces on upload, so nothing on the card
 * can be larger. Repeated here as the read's own bound rather than trusted
 * from the other module: this reads a file, and a file can be replaced by
 * hand on the card. */
#define CUSTOM_MAX_BYTES (128 * 1024)

/* How long a shutter press waits for the card. Deliberately short: the sound
 * is late or missing either way, and the alternative is the audio task
 * sitting behind a four-frame capture with a press to answer. */
#define CUSTOM_CARD_WAIT_MS 300

static char s_custom_id[KDP_SOUND_ID_MAX];
static int16_t *s_custom_pcm;
static size_t s_custom_bytes;
/* Set by audio_forget_custom() when the file behind the cached id changed.
 * The id alone is not a key: a re-upload keeps the id and replaces the WAV, so
 * without this the old samples played until the next reboot. Written from the
 * KDP task, read on the audio task, and it only ever forces a re-read - so a
 * flag is the whole exclusion this needs. */
static volatile bool s_custom_stale;

/**
 * Load `id` from the card, or answer from the cache.
 *
 * The cache holds one clip, keyed by id: the shutter sound is a setting, so
 * the same clip plays until someone changes it, and a second buffer would
 * only help a camera whose shutter sound alternates. Changing the setting
 * frees the old buffer here, on the audio task, rather than wherever the
 * setting was written.
 *
 * False means play something else. Every reason is logged once - a card that
 * was busy, a file that is gone, a header that stopped parsing - because a
 * shutter that quietly plays the wrong sound is the report this firmware
 * would then get instead.
 */
static bool custom_pcm(const char *id, const int16_t **out, size_t *out_bytes) {
  if (!s_custom_stale && s_custom_pcm != NULL && strcmp(s_custom_id, id) == 0) {
    *out = s_custom_pcm;
    *out_bytes = s_custom_bytes;
    return true;
  }
  /* A different id, or the same id whose file changed under us: the old clip
   * can never be wanted again without another load, so it goes now rather than
   * at the next successful one. The free is HERE, on the audio task, and not in
   * audio_forget_custom() - these samples may be clocking out of the codec on
   * this task, and freeing them from the KDP task would be a use-after-free at
   * the exact moment someone re-uploads a clip during a shutter press. */
  free(s_custom_pcm);
  s_custom_pcm = NULL;
  s_custom_bytes = 0;
  s_custom_id[0] = '\0';
  s_custom_stale = false;

  char path[128];
  if (!kdp_sounds_path(id, path, sizeof path)) {
    ESP_LOGW(TAG, "shutter sound '%s' is not a stored clip - playing the click", id);
    return false;
  }

  /* The card lock, not just fopen(): a capture writing four frames owns the
   * SDMMC bus, and reading 128 KB across it widens the frame spread. */
  if (!storage_acquire(STORAGE_USER_UI, CUSTOM_CARD_WAIT_MS)) {
    ESP_LOGW(TAG, "card busy - '%s' not loaded, playing the click", id);
    return false;
  }
  uint8_t *raw = NULL;
  size_t raw_len = 0;
  FILE *f = fopen(path, "rb");
  if (f != NULL) {
    fseek(f, 0, SEEK_END);
    const long size = ftell(f);
    if (size > 0 && size <= CUSTOM_MAX_BYTES) {
      raw = heap_caps_malloc((size_t)size, MALLOC_CAP_SPIRAM);
      if (raw != NULL) {
        fseek(f, 0, SEEK_SET);
        raw_len = fread(raw, 1, (size_t)size, f);
      }
    } else {
      ESP_LOGW(TAG, "'%s' is %ld bytes - past the %d KB cap", id, size, CUSTOM_MAX_BYTES / 1024);
    }
    fclose(f);
  }
  storage_release(STORAGE_USER_UI);

  if (raw == NULL || raw_len < WAV_HEADER_MIN) {
    free(raw);
    ESP_LOGW(TAG, "'%s' could not be read from the card - playing the click", id);
    return false;
  }

  /* Probed again on the way in, not trusted from upload time. The file has
   * been through a rename, a reboot and possibly someone's card reader since
   * SOUND_END looked at it. */
  wav_info_t info;
  char why[96];
  if (!wav_probe(raw, raw_len, &info, why, sizeof why)) {
    free(raw);
    ESP_LOGW(TAG, "'%s' is not playable: %s - playing the click", id, why);
    return false;
  }

  const size_t pcm_avail = raw_len - info.data_offset;
  const size_t pcm_bytes = info.data_bytes < pcm_avail ? info.data_bytes : pcm_avail;
  const size_t samples = pcm_bytes / sizeof(int16_t);
  if (samples == 0) {
    free(raw);
    ESP_LOGW(TAG, "'%s' has no samples - playing the click", id);
    return false;
  }

  /* The same LEAD_MS/TAIL_MS envelope render_click() puts around a synthesised
   * sound, for exactly the same two reasons: the NS4150 needs to be out of
   * shutdown before the first sample, and the tail keeps the amp's switch-off
   * out of the sound. A clip played without them loses its attack and clicks
   * at the end. */
  const size_t lead = (size_t)SAMPLE_RATE * LEAD_MS / 1000;
  const size_t tail = (size_t)SAMPLE_RATE * TAIL_MS / 1000;
  const size_t frames = lead + samples + tail;
  const size_t bytes = frames * CHANNELS * sizeof(int16_t);
  int16_t *buf = heap_caps_calloc(1, bytes, MALLOC_CAP_SPIRAM);
  if (buf == NULL) {
    free(raw);
    ESP_LOGW(TAG, "no PSRAM for '%s' - playing the click", id);
    return false;
  }
  /* Mono to interleaved stereo. The I2S slot config is stereo and the codec
   * is opened with CHANNELS, so a mono buffer handed straight over would play
   * at half rate down one channel.
   *
   * No gain is applied here. shoot.volume is set on the codec in
   * play_click() (esp_codec_dev_set_out_vol), and the ES8311 has hardware
   * volume, so scaling the samples as well would attenuate twice and make
   * step 10 quieter than the built-ins at the same setting. */
  const uint8_t *src = raw + info.data_offset;
  for (size_t i = 0; i < samples; i++) {
    const int16_t v = (int16_t)((uint16_t)src[i * 2] | ((uint16_t)src[i * 2 + 1] << 8));
    buf[(lead + i) * CHANNELS] = v;
    buf[(lead + i) * CHANNELS + 1] = v;
  }
  free(raw);

  snprintf(s_custom_id, sizeof s_custom_id, "%s", id);
  s_custom_pcm = buf;
  s_custom_bytes = bytes;
  ESP_LOGI(TAG, "shutter sound '%s' loaded: %u samples, %u ms, %u B in PSRAM", id,
           (unsigned)samples, (unsigned)info.duration_ms, (unsigned)bytes);
  *out = buf;
  *out_bytes = bytes;
  return true;
}

void audio_forget_custom(const char *id) {
  if (id == NULL || s_custom_pcm == NULL) return;
  /* Any forget while a load is in progress also lands here as a mismatch and
   * is harmless: the worst case is one re-read of a file that had not been
   * replaced. The cache holds exactly one clip, so an id that does not match
   * is nothing to drop. */
  if (strcmp(s_custom_id, id) != 0) return;
  s_custom_stale = true;
  ESP_LOGI(TAG, "cached clip '%s' dropped - it is re-read from the card on the next press", id);
}

/**
 * Which samples this shutter press plays.
 *
 * Read at play time rather than cached at init, because shoot.shutterSound
 * changes from three places - the SOUND screen, SET_CONFIG from Studio, and
 * kdp_sounds.c resetting it when the selected clip is deleted - and none of
 * them should have to tell audio.c. It runs on the audio task, so the
 * config_str_copy() and the card read are off the UI's path.
 *
 * Returns false for "silent", which is a selection and not a failure.
 */
static bool shutter_pcm_for(const int16_t **out, size_t *out_bytes) {
  char id[KDP_SOUND_ID_MAX];
  if (config_str_copy("shoot.shutterSound", id, sizeof id) == 0) snprintf(id, sizeof id, "click");

  if (strcmp(id, "silent") == 0) return false;

  const int16_t *pcm = s_shutter_pcm;
  size_t bytes = s_shutter_bytes;
  if (strcmp(id, "click") == 0) {
    /* the default; already selected above */
  } else if (strcmp(id, "cheap-digi") == 0) {
    if (s_digi_pcm != NULL) { pcm = s_digi_pcm; bytes = s_digi_bytes; }
  } else if (strcmp(id, "tiny-beep") == 0) {
    if (s_beep_pcm != NULL) { pcm = s_beep_pcm; bytes = s_beep_bytes; }
  } else if (strcmp(id, "mechanical") == 0) {
    if (s_mech_pcm != NULL) { pcm = s_mech_pcm; bytes = s_mech_bytes; }
  } else {
    const int16_t *custom = NULL;
    size_t custom_bytes = 0;
    if (custom_pcm(id, &custom, &custom_bytes)) {
      pcm = custom;
      bytes = custom_bytes;
    }
    /* custom_pcm() said why on the way out; the click below is the fallback. */
  }
  *out = pcm;
  *out_bytes = bytes;
  return true;
}

/* ------------------------------------------------------------------ */
/* Playback runs on its own task                                       */
/*                                                                     */
/* play_click() opens the codec, queues the samples, waits for the DMA  */
/* to clock them out and closes again - the best part of 200 ms. Called */
/* straight from the UI task, as it was, that froze the interface for   */
/* the length of every sound: the touch controller went unread, presses */
/* were missed and releases arrived late, which is what "the touch      */
/* controls do not work correctly" actually was. A sound is not         */
/* something the UI should ever wait for.                              */
/* ------------------------------------------------------------------ */

static void audio_task(void *arg) {
  (void)arg;
  for (;;) {
    sound_t which;
    if (xQueueReceive(s_queue, &which, portMAX_DELAY) != pdTRUE) continue;
    if (which == SND_SHUTTER) {
      /* Resolved here, on this task: shutter_pcm_for() may read the config,
       * take the card lock and decode a WAV, and none of that may happen on
       * whichever task pressed the button. */
      const int16_t *pcm = NULL;
      size_t bytes = 0;
      if (shutter_pcm_for(&pcm, &bytes)) play_click(pcm, bytes);
    } else if (which == SND_WARNING) {
      play_click(s_warn_pcm, s_warn_bytes);
    } else {
      play_click(s_tick_pcm, s_tick_bytes);
    }
  }
}

/* Non-blocking, and deliberately drops rather than waits.
 *
 * A queue that blocks when full would reintroduce exactly the stall this
 * exists to remove, and a backlog of ticks is worse than a missing one: taps
 * arriving faster than the speaker can answer should sound like a camera
 * keeping up, not like a delayed rattle finishing after the finger has gone. */
static void post(sound_t which) {
  if (s_queue == NULL) return;
  (void)xQueueSend(s_queue, &which, 0);
}

void audio_shutter(void) { post(SND_SHUTTER); }

void audio_tick(void) { post(SND_TICK); }

/*
 * The setting is checked HERE, not at the call site, which is the opposite of
 * how the shutter and the tick are gated in ui.c.
 *
 * Those two have one caller each. This one has several - a failed report, a
 * partial report, and every refusal that ends in a toast - and a gate repeated
 * at each of them is a gate that will eventually be forgotten at one of them,
 * which is a camera that beeps at someone who switched the beeping off.
 *
 * shoot.volume needs nothing here: play_click() sets it on the codec for
 * every sound, so this obeys it the same way the shutter does.
 */
void audio_warning(void) {
  if (!config_bool("body.sounds.warning", true)) return;
  post(SND_WARNING);
}

/* ---------------------------------------------------------------------- */
/* Calibration: the camera listening to itself.                           */
/* ---------------------------------------------------------------------- */

typedef struct {
  uint8_t *buf;
  size_t bytes;
  size_t got;
  TaskHandle_t parent;
} rec_ctx_t;

/* Runs alongside the write below. Safe because esp_codec_dev takes no lock -
 * read and write go straight to independent I2S RX and TX channels. */
static void rec_task(void *arg) {
  rec_ctx_t *c = (rec_ctx_t *)arg;
  size_t got = 0;
  while (got < c->bytes) {
    size_t chunk = c->bytes - got;
    if (chunk > 2048) chunk = 2048;
    if (esp_codec_dev_read(s_dev, c->buf + got, (int)chunk) != 0) break;
    got += chunk;
  }
  c->got = got;
  xTaskNotifyGive(c->parent);
  vTaskDelete(NULL);
}

static float db_of(float amplitude) {
  return amplitude > 1e-6f ? 20.0f * log10f(amplitude / 32767.0f) : -99.0f;
}

/**
 * Play one sound and record what the onboard mic hears of it.
 *
 * Reports the measured level rather than the commanded one, which is the
 * whole point: the commanded level says what was sent to the DAC, and every
 * wrong guess so far has been about what the speaker actually does with it.
 */
static void measure_one(const char *name, const click_t *c, int vol) {
  int16_t *buf = NULL;
  size_t bytes = 0;
  if (render_click(c, &buf, &bytes) != ESP_OK) {
    ESP_LOGW(TAG, "CAL %-22s render failed", name);
    return;
  }

  uint8_t *rec = heap_caps_calloc(1, bytes, MALLOC_CAP_SPIRAM);
  if (rec == NULL) {
    free(buf);
    ESP_LOGW(TAG, "CAL %-22s no record buffer", name);
    return;
  }

  esp_codec_dev_sample_info_t fs = {
      .sample_rate = SAMPLE_RATE,
      .channel = CHANNELS,
      .bits_per_sample = 16,
  };
  int rc = esp_codec_dev_open(s_dev, &fs);
  if (rc != 0) {
    ESP_LOGW(TAG, "CAL %-22s open failed (%d)", name, rc);
    free(buf);
    free(rec);
    return;
  }
  esp_codec_dev_set_out_vol(s_dev, vol);
  esp_codec_dev_set_in_gain(s_dev, AUDIO_MIC_GAIN_DB);
  /* Force ASDOUT to carry real ADC data.
   *
   * ES8311 reg 0x44 ADCDAT_SEL (bits 6:4) picks what leaves the chip on
   * ASDOUT: 0 is ADC+ADC, but 4/5/6 mix or replace it with DAC data - the
   * chip's "digital feedback" mode for echo cancellation. If the board or the
   * driver leaves it in one of those, recording returns the signal we just
   * sent, which is exactly what the first runs looked like: output identical
   * across a 40 dB volume sweep and tracking the digital level 1:1.
   * Rewritten after every open because open() reapplies the codec config. */
  esp_codec_dev_write_reg(s_dev, 0x44, 0x00);
  int dac_reg = 0;
  esp_codec_dev_read_reg(s_dev, 0x32, &dac_reg);

  rec_ctx_t ctx = {.buf = rec, .bytes = bytes, .got = 0, .parent = xTaskGetCurrentTaskHandle()};
  if (xTaskCreate(rec_task, "audcal_rec", 4096, &ctx, 6, NULL) != pdPASS) {
    ESP_LOGW(TAG, "CAL %-22s no record task", name);
    esp_codec_dev_close(s_dev);
    free(buf);
    free(rec);
    return;
  }

  esp_codec_dev_write(s_dev, buf, bytes);
  /* The recorder stops on its own once it has as many bytes as the playback
   * was long; the timeout is only so a stalled RX cannot hang the boot. */
  ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(2000));
  vTaskDelay(pdMS_TO_TICKS(TAIL_MS + 40));
  esp_codec_dev_close(s_dev);

  const int16_t *r = (const int16_t *)rec;
  const size_t n = ctx.got / sizeof(int16_t);
  const size_t skip = (size_t)(SAMPLE_RATE * CAL_SKIP_MS / 1000) * CHANNELS;
  double sum = 0.0;
  int peak = 0;
  size_t counted = 0;
  for (size_t i = skip; i < n; i++) {
    const int v = r[i] < 0 ? -r[i] : r[i];
    if (v > peak) peak = v;
    sum += (double)r[i] * (double)r[i];
    counted++;
  }
  const float rms = counted ? (float)sqrt(sum / (double)counted) : 0.0f;

  /* Reg 0x32 is the DAC volume the driver actually wrote. Logged next to the
   * measurement so "volume changed nothing" can be split into "the register
   * never moved" and "the register moved but this path does not see it". */
  ESP_LOGI(TAG,
           "CAL %-22s vol%3d (reg32=0x%02x) lvl%.2f thump%.2f/%3.0fHz decay%3.0f -> rms %6.1f peak "
           "%6.1f dBFS",
           name, vol, dac_reg, c->level, c->thump_amp, c->thump_hz, c->decay, db_of(rms),
           db_of((float)peak));

  free(buf);
  free(rec);
}

void audio_calibrate(void) {
  if (!s_ready) {
    ESP_LOGW(TAG, "CAL skipped, audio not ready");
    return;
  }
  ESP_LOGI(TAG, "CAL ==== begin: mic gain %.0f dB, room must be quiet ====", AUDIO_MIC_GAIN_DB);

  /* What the codec is actually configured to do, rather than what the driver
   * was asked to do. Reg 0x44 in particular decides whether recording returns
   * the microphone or an echo of playback. */
  esp_codec_dev_sample_info_t probe_fs = {
      .sample_rate = SAMPLE_RATE, .channel = CHANNELS, .bits_per_sample = 16};
  if (esp_codec_dev_open(s_dev, &probe_fs) == 0) {
    int v = 0;
    esp_codec_dev_read_reg(s_dev, 0x44, &v);
    ESP_LOGI(TAG, "CAL reg0x44 ADCDAT_SEL = 0x%02x (sel %d; 0=ADC+ADC, 4/5/6 feed back DAC)", v,
             (v >> 4) & 0x7);
    esp_codec_dev_read_reg(s_dev, 0x17, &v);
    ESP_LOGI(TAG, "CAL reg0x17 ADC volume = 0x%02x", v);
    esp_codec_dev_read_reg(s_dev, 0x32, &v);
    ESP_LOGI(TAG, "CAL reg0x32 DAC volume = 0x%02x", v);
    esp_codec_dev_read_reg(s_dev, 0x0A, &v);
    ESP_LOGI(TAG, "CAL reg0x0A SDPOUT = 0x%02x", v);
    esp_codec_dev_close(s_dev);
  }

  /* Noise floor first. Every number below is only meaningful relative to
   * this, and if the floor is high the whole run is worthless. */
  static const click_t silence = {
      .total_ms = 200, .spacing_ms = 0, .bright = 0.5f, .decay = 90.0f, .level = 0.0f};
  measure_one("floor(silence)", &silence, AUDIO_VOLUME);

  /* The anchors: the exact two sounds that were judged "too strong on both".
   * Everything else is chosen relative to these. */
  static const click_t r3_shutter = {.total_ms = 200,
                                     .spacing_ms = 55,
                                     .bright = 0.55f,
                                     .decay = 90.0f,
                                     .thump_hz = 95.0f,
                                     .thump_amp = 0.12f,
                                     .level = 0.34f};
  static const click_t r3_tick = {.total_ms = 130,
                                  .spacing_ms = 0,
                                  .bright = 0.7f,
                                  .decay = 40.0f,
                                  .thump_hz = 170.0f,
                                  .thump_amp = 0.40f,
                                  .level = 1.0f};
  measure_one("ANCHOR shutter TOOSTRG", &r3_shutter, 78);
  measure_one("ANCHOR tick    TOOSTRG", &r3_tick, 78);

  /* Candidates: the shipping pair, then a level sweep around it so the
   * measured curve is known rather than assumed. */
  measure_one("ship shutter", &CLICK_SHUTTER, AUDIO_VOLUME);
  measure_one("ship tick", &CLICK_TICK, AUDIO_VOLUME);

  click_t sweep;
  const float shutter_lv[3] = {0.35f, 0.55f, 0.8f};
  for (int i = 0; i < 3; i++) {
    sweep = CLICK_SHUTTER;
    sweep.level = shutter_lv[i];
    measure_one("sweep shutter", &sweep, AUDIO_VOLUME);
  }
  const float tick_lv[3] = {0.5f, 0.75f, 1.0f};
  for (int i = 0; i < 3; i++) {
    sweep = CLICK_TICK;
    sweep.level = tick_lv[i];
    measure_one("sweep tick", &sweep, AUDIO_VOLUME);
  }

  /* Does removing the 95 Hz body actually change what the mic hears, or only
   * what the ear objects to? Worth knowing which. */
  click_t thumped = CLICK_SHUTTER;
  thumped.thump_hz = 95.0f;
  thumped.thump_amp = 0.35f;
  measure_one("shutter WITH 95Hz body", &thumped, AUDIO_VOLUME);

  /* Is the codec volume even in the path being measured?
   *
   * Two sounds 9 dB apart in commanded volume came back 0.2 dB apart, while
   * the recorded peak tracked the digital level 1:1 - the signature of the
   * ADC seeing DAC data directly rather than hearing a speaker. If this sweep
   * is flat, the recording is a digital loopback and every acoustic
   * conclusion drawn from it is worthless. Level kept well clear of the rail
   * so a flat result cannot be blamed on clipping. */
  click_t probe = CLICK_TICK;
  probe.level = 0.35f;
  const int vols[5] = {20, 40, 60, 80, 100};
  for (int i = 0; i < 5; i++) measure_one("VOLSWEEP probe", &probe, vols[i]);

  /* Floor again at the end. The first one is taken on a codec that has never
   * been opened, which is the least representative moment there is; if the
   * two disagree the first was measuring startup, not the room. */
  measure_one("floor(silence) again", &silence, AUDIO_VOLUME);

  ESP_LOGI(TAG, "CAL ==== end ====");
}
