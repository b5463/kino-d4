// KINO D4 bench tool — look at one camera module over USB-C, before any
// harness exists to look at it through.
//
// This is not product firmware and never ships in a camera. `camnode` serves
// the P4 over UART1 and captures one JPEG when asked, which is the wrong shape
// for judging a module you are holding: focus, the OV3660's colour cast,
// framing and dropped frames are things you watch, not things you sample. So
// the board presents itself as a plain USB webcam and any camera app on the
// host is the viewer. No host tooling, no Wi-Fi, no P4.
//
// Two consequences of TinyUSB owning the one USB PHY, both deliberate:
//   * The console is on UART0 (GPIO43/44), not USB-Serial-JTAG. Plugging this
//     board in gives you a camera, not a serial port.
//   * Reflashing needs the ROM download mode — hold BOOT, tap RESET. The
//     README spells this out; it is the first thing that catches people.
// The LED is therefore the only feedback you get without a UART adapter, so it
// carries the boot verdict.

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "board_xiao_s3.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "usb_device_uvc.h"

/* The XIAO's BOOT button. Held at startup it selects console mode below. */
#define BOOT_BUTTON_GPIO 0

static const char *TAG = "uvc-preview";

/**
 * One JPEG frame has to fit here whole. A VGA frame at quality 12 runs
 * 20-40 KB and an HD frame can pass 100 KB, so this is sized for the largest
 * resolution the descriptors offer rather than the default one — a frame that
 * does not fit is dropped by the driver, which on a bench reads as "this
 * module is bad".
 */
#define UVC_BUFFER_SIZE (160 * 1024)

/* Seeed wires the user LED active-low. */
#define LED_ON 0
#define LED_OFF 1

static camera_fb_t *s_cam_fb; /* held between fb_get and fb_return */
static uvc_fb_t s_uvc_fb;
static uint32_t s_frames;
static uint32_t s_empty;
static int64_t s_started_us;

static void led_init(void) {
  gpio_config_t cfg = {
      .pin_bit_mask = 1ULL << BOARD_LED,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  gpio_config(&cfg);
  gpio_set_level(BOARD_LED, LED_OFF);
}

static void led_blink(int times, int period_ms) {
  for (int i = 0; i < times; i++) {
    gpio_set_level(BOARD_LED, LED_ON);
    vTaskDelay(pdMS_TO_TICKS(period_ms / 2));
    gpio_set_level(BOARD_LED, LED_OFF);
    vTaskDelay(pdMS_TO_TICKS(period_ms / 2));
  }
}

/**
 * The board has no console on the port you just plugged in, so the LED is the
 * verdict: a fast blink forever means the sensor never answered, and no amount
 * of staring at a camera app tells you that. Never returns, by design — there
 * is nothing else useful for this firmware to do.
 */
static void led_fault_forever(void) {
  for (;;) led_blink(1, 200);
}

/* Defined below, next to the reasoning for each value it sets. */
static void tune_sensor(sensor_t *s);

static framesize_t framesize_for(int width, int height) {
  if (width <= 320) return FRAMESIZE_QVGA;
  if (width <= 480) return FRAMESIZE_HVGA;
  if (width <= 640) return FRAMESIZE_VGA;
  if (width <= 800) return FRAMESIZE_SVGA;
  if (height <= 720) return FRAMESIZE_HD;
  return FRAMESIZE_FHD;
}

/* Host opened the stream. It picks from the descriptors, so honour what it
 * asked for rather than whatever the last session left behind. */
static esp_err_t on_stream_start(uvc_format_t format, int width, int height, int rate,
                                 void *cb_ctx) {
  (void)cb_ctx;
  if (format != UVC_FORMAT_JPEG) {
    ESP_LOGE(TAG, "host asked for a format this build does not produce (%d)", (int)format);
    return ESP_ERR_NOT_SUPPORTED;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_FAIL;
  if (sensor->set_framesize(sensor, framesize_for(width, height)) != 0) {
    ESP_LOGE(TAG, "sensor refused %dx%d", width, height);
    return ESP_FAIL;
  }
  /* A framesize change rewrites the sensor's window, so the tuning goes on
   * after it and not once at boot — otherwise the first stream looks right
   * and every resolution change after it looks untuned. */
  tune_sensor(sensor);

  s_frames = 0;
  s_empty = 0;
  s_started_us = esp_timer_get_time();
  gpio_set_level(BOARD_LED, LED_ON);
  ESP_LOGI(TAG, "stream open: %dx%d @ %d fps, mjpeg", width, height, rate);
  return ESP_OK;
}

static uvc_fb_t *on_frame_get(void *cb_ctx) {
  (void)cb_ctx;
  s_cam_fb = esp_camera_fb_get();
  if (s_cam_fb == NULL) {
    /* Counted rather than ignored: an empty frame buffer while the host is
     * still asking is the signature of a sensor or a DVP bus struggling, and
     * the count at stream close is the only place it surfaces. */
    s_empty++;
    return NULL;
  }
  s_uvc_fb.buf = s_cam_fb->buf;
  s_uvc_fb.len = s_cam_fb->len;
  s_uvc_fb.width = s_cam_fb->width;
  s_uvc_fb.height = s_cam_fb->height;
  s_uvc_fb.format = UVC_FORMAT_JPEG;
  s_uvc_fb.timestamp = s_cam_fb->timestamp;
  s_frames++;
  return &s_uvc_fb;
}

static void on_frame_return(uvc_fb_t *fb, void *cb_ctx) {
  (void)fb;
  (void)cb_ctx;
  if (s_cam_fb != NULL) {
    esp_camera_fb_return(s_cam_fb);
    s_cam_fb = NULL;
  }
}

/* The numbers a bench run wants, logged where a UART adapter can read them.
 * "It looked fine" is not a result; 15.0 fps with 0 empty frames is. */
static void on_stream_stop(void *cb_ctx) {
  (void)cb_ctx;
  gpio_set_level(BOARD_LED, LED_OFF);
  int64_t elapsed_ms = (esp_timer_get_time() - s_started_us) / 1000;
  uint32_t fps_x10 =
      elapsed_ms > 0 ? (uint32_t)((uint64_t)s_frames * 10000 / (uint64_t)elapsed_ms) : 0;
  ESP_LOGI(TAG, "stream closed: %lu frames in %lld ms (%lu.%lu fps), %lu empty",
           (unsigned long)s_frames, (long long)elapsed_ms, (unsigned long)(fps_x10 / 10),
           (unsigned long)(fps_x10 % 10), (unsigned long)s_empty);
}

static esp_err_t camera_start(void) {
  camera_config_t config = {
      .pin_pwdn = -1,
      .pin_reset = -1,
      .pin_xclk = BOARD_CAM_XCLK,
      .pin_sccb_sda = BOARD_CAM_SIOD,
      .pin_sccb_scl = BOARD_CAM_SIOC,
      .pin_d7 = BOARD_CAM_Y9,
      .pin_d6 = BOARD_CAM_Y8,
      .pin_d5 = BOARD_CAM_Y7,
      .pin_d4 = BOARD_CAM_Y6,
      .pin_d3 = BOARD_CAM_Y5,
      .pin_d2 = BOARD_CAM_Y4,
      .pin_d1 = BOARD_CAM_Y3,
      .pin_d0 = BOARD_CAM_Y2,
      .pin_vsync = BOARD_CAM_VSYNC,
      .pin_href = BOARD_CAM_HREF,
      .pin_pclk = BOARD_CAM_PCLK,
      /* Back to the board header, which now carries the measured 16 MHz and
       * the reason for it. This tool is what measured it; it should not then
       * disagree with the product about the value. */
      .xclk_freq_hz = BOARD_CAM_XCLK_HZ,
      .ledc_timer = LEDC_TIMER_0,
      .ledc_channel = LEDC_CHANNEL_0,
      .pixel_format = PIXFORMAT_JPEG,
      /* The host resets this in on_stream_start; this is only what the sensor
       * boots into, so reading a PID costs no PSRAM it does not need. */
      .frame_size = FRAMESIZE_VGA,
      /* 12, measured. Dropping to 10 for a nicer-looking preview put a
       * 4-pixel green band at x=496 — exactly a 16-pixel JPEG MCU boundary,
       * which is corrupt compressed data rather than anything optical. The
       * band was absent on every quality-12 frame and present on every
       * quality-10 one, so the extra bytes are not free on this sensor. A
       * bench tool that invents artifacts cannot be used to judge modules. */
      .jpeg_quality = 12,
      /* Two buffers, newest served: a preview that lags is worse than one
       * that skips, because lag looks like the module is slow. */
      .fb_count = 2,
      .fb_location = CAMERA_FB_IN_PSRAM,
      .grab_mode = CAMERA_GRAB_LATEST,
  };
  return esp_camera_init(&config);
}

/**
 * Apply one sensor setting, tolerating both ways it can be unavailable.
 *
 * The driver fills in only the setters a sensor model actually implements, so
 * the rest are NULL function pointers — `set_denoise` is not an OV3660
 * feature, for one. Calling one unguarded panics before TinyUSB ever claims
 * the USB PHY, which presents as a board that enumerates as a serial port and
 * never appears as a camera at all. A setting that is missing or refused is
 * information about the part in front of you; it is not a reason to take the
 * whole tool down.
 */
#define TUNE(setter, ...)                                                 \
  do {                                                                    \
    if (s->setter == NULL) {                                              \
      ESP_LOGW(TAG, "sensor has no %s", #setter);                         \
    } else if (s->setter(s, __VA_ARGS__) != 0) {                          \
      ESP_LOGW(TAG, "sensor rejected %s", #setter);                       \
    }                                                                     \
  } while (0)

/**
 * Explicit image tuning. Without this the sensor runs on whatever the driver
 * left in its registers, which on an OV3660 produces exactly the picture that
 * makes a good module look faulty: flat, washed-out colour and visible
 * speckle in the shadows.
 *
 * Every value is set rather than assumed. A bench tool whose image depends on
 * driver defaults cannot be used to compare two modules, because the
 * comparison would include the defaults.
 */
static void tune_sensor(sensor_t *s) {
  /* Colour. All figures from the same lit white wall, 40 frames each:
   *
   *   untuned driver defaults      G +1.9%   artifact  0/40
   *   tuned, awb_gain on           G +6.6%   artifact  0/40   0/40
   *   tuned, awb_gain off          G +8.9%   artifact 30/40
   *
   * awb_gain is not what casts this sensor green — turning it off made the
   * cast worse and coincided with the artifact returning. It stays on. The
   * cast arrived with the tuning as a whole, and the untuned near-neutral
   * baseline says the sensor's own balance is fine, so the suspect is the
   * saturation lift below amplifying a small bias into a visible one. */
  TUNE(set_whitebal, 1);
  TUNE(set_awb_gain, 1);
  TUNE(set_wb_mode, 0); /* auto, not one of the presets */

  /* Exposure. aec2 is the DSP-assisted metering; without it a scene with a
   * bright window and a dim room meters for neither. */
  TUNE(set_exposure_ctrl, 1);
  TUNE(set_aec2, 1);
  /* Aim a little bright. An indoor scene metered neutral comes out muddy on
   * a sensor this small, and a preview that is too dark to judge is useless
   * even if it is technically correctly exposed. */
  TUNE(set_ae_level, 1);

  /* Gain, generously capped. 4x was measured on our own module and was
   * wrong: AEC compensated for the missing gain by lengthening exposure,
   * which cost both brightness and frame rate — 9.3 fps against a
   * configured 15, and a picture too dark to judge. 16x costs noise, and
   * noise you can see through beats darkness you cannot. */
  TUNE(set_gain_ctrl, 1);
  TUNE(set_gainceiling, GAINCEILING_16X);

  /* Corrections. bpc/wpc map out dead and hot pixels — those are the single
   * pixels that read as static. raw_gma is the gamma curve and the main
   * reason an untuned frame looks washed out. lenc corrects the lens
   * falloff, which on these small modules darkens the corners. */
  TUNE(set_bpc, 1);
  TUNE(set_wpc, 1);
  TUNE(set_raw_gma, 1);
  TUNE(set_lenc, 1);
  /* No set_dcw. It changes the downsize/crop path and was enabled for no
   * reason beyond "the vendor example does it" — which is not a reason, and
   * it was one of two suspects for the MCU-boundary artifact above. */

  /* Modest lifts, measured against our own modules rather than copied from
   * the vendor example — which lowers saturation for a differently mounted
   * board. Sharpening stays at 0 on purpose: it amplifies exactly the noise
   * the gain ceiling is there to hold down. denoise is an OV5640 feature and
   * is expected to be absent here; the guard reports it and moves on. */
  /* brightness +1 and saturation -2 are Espressif's own OV3660 values from
   * the CameraWebServer example, whose comment is that these sensors ship
   * "a bit saturated". I had the sign backwards: +1, then 0, while the part
   * is known to need pulling DOWN. Measured cast ran G +6.6% to +12.0%
   * against an untuned baseline of +1.9%, which is what over-saturated
   * chroma on a slight bias looks like.
   *
   * No vflip, unlike that example: it flips because of how the sensor sits
   * on an AI-Thinker board, and on the XIAO Sense the frame already arrives
   * upright. Copying it would put the preview upside down. */
  TUNE(set_brightness, 1);
  TUNE(set_contrast, 1);
  TUNE(set_saturation, -2);
  TUNE(set_sharpness, 0);
  TUNE(set_denoise, 1);

  /* No vflip/hmirror. The vendor OV3660 example flips because of how the
   * sensor sits on an AI-Thinker board; on the XIAO Sense the frame already
   * arrives the right way up, and flipping it here would make the preview
   * disagree with what camnode captures. */
}

/* Whatever this board is, on the record, before anything else happens. */
static void log_sensor_identity(void) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) {
    ESP_LOGE(TAG, "no sensor handle after a successful init");
    return;
  }
  camera_sensor_info_t *info = esp_camera_sensor_get_info(&sensor->id);
  ESP_LOGI(TAG, "sensor %s pid 0x%04x ver 0x%02x midh 0x%02x midl 0x%02x",
           info != NULL ? info->name : "UNKNOWN", sensor->id.PID, sensor->id.VER,
           sensor->id.MIDH, sensor->id.MIDL);
  if (sensor->id.PID != OV3660_PID) {
    /* Not fatal — the tool still works — but a D4 build wants OV3660s, and a
     * mixed bag of modules is worth knowing at the bench rather than after
     * four of them are inside a body. */
    ESP_LOGW(TAG, "expected an OV3660 (pid 0x%04x) on a D4 module", OV3660_PID);
  }
}

/* ---------------------------------------------------------------- console mode
 *
 * Everything above is invisible in normal operation: TinyUSB owns the one USB
 * PHY, so there is no serial port on the cable you plugged in, and the
 * console is on UART0 pins nobody has an adapter on. A whole debugging
 * session was spent inferring firmware behaviour from rendered video frames
 * because of that, which is a bad way to work.
 *
 * Hold BOOT at startup and this runs instead: no UVC, the USB-Serial-JTAG
 * peripheral kept for itself, ESP_LOG redirected onto it, and a loop that
 * reports what each captured frame actually is. It answers the questions the
 * host cannot: which sensor setters this model implements, what the JPEG
 * sizes are, and whether frames arrive already malformed — SOI/EOI markers
 * checked on the device, before USB has touched anything.
 */

static int jtag_vprintf(const char *fmt, va_list args) {
  char line[256];
  int n = vsnprintf(line, sizeof line, fmt, args);
  if (n > 0) usb_serial_jtag_write_bytes(line, n > (int)sizeof line ? (int)sizeof line : n, portMAX_DELAY);
  return n;
}

static bool boot_button_held(void) {
  gpio_config_t cfg = {
      .pin_bit_mask = 1ULL << BOOT_BUTTON_GPIO,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  gpio_config(&cfg);
  /* Active low, and settle first: the pull-up needs a moment after config. */
  vTaskDelay(pdMS_TO_TICKS(20));
  return gpio_get_level(BOOT_BUTTON_GPIO) == 0;
}

static void console_mode(void) {
  usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
  usb_serial_jtag_driver_install(&cfg);
  esp_log_set_vprintf(jtag_vprintf);
  vTaskDelay(pdMS_TO_TICKS(1500)); /* let the host open the port */

  ESP_LOGI(TAG, "==== KINO uvc-preview %s CONSOLE MODE ====", KINO_FW_VERSION);
  ESP_LOGI(TAG, "no UVC this boot; sensor diagnostics only");

  if (camera_start() != ESP_OK) {
    ESP_LOGE(TAG, "camera init FAILED — nothing further is meaningful");
    led_fault_forever();
  }
  log_sensor_identity();

  sensor_t *s = esp_camera_sensor_get();
  ESP_LOGI(TAG, "-- applying tuning, unsupported setters reported below --");
  if (s != NULL) tune_sensor(s);
  ESP_LOGI(TAG, "-- tuning done --");

  ESP_LOGI(TAG, "capturing frames; SOI/EOI are checked here, before USB");
  uint32_t n = 0, bad = 0, minb = UINT32_MAX, maxb = 0;
  for (;;) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb == NULL) {
      ESP_LOGW(TAG, "frame %lu: NULL frame buffer", (unsigned long)++n);
      continue;
    }
    n++;
    if (fb->len < minb) minb = fb->len;
    if (fb->len > maxb) maxb = fb->len;
    /* A JPEG the sensor handed over must start FFD8 and end FFD9. Anything
     * else is already broken on the device, which rules USB out entirely. */
    bool soi = fb->len > 3 && fb->buf[0] == 0xFF && fb->buf[1] == 0xD8;
    bool eoi = fb->len > 3 && fb->buf[fb->len - 2] == 0xFF && fb->buf[fb->len - 1] == 0xD9;
    if (!soi || !eoi) {
      bad++;
      ESP_LOGE(TAG, "frame %lu: MALFORMED len %u soi=%d eoi=%d  (tail %02x %02x)",
               (unsigned long)n, (unsigned)fb->len, soi, eoi,
               fb->buf[fb->len - 2], fb->buf[fb->len - 1]);
    }
    if (n % 15 == 0) {
      ESP_LOGI(TAG, "%lu frames, %lu malformed, jpeg %u-%u B, heap %u, psram %u",
               (unsigned long)n, (unsigned long)bad, (unsigned)minb, (unsigned)maxb,
               (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
               (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
    esp_camera_fb_return(fb);
    vTaskDelay(pdMS_TO_TICKS(60));
  }
}

void app_main(void) {
  led_init();

  if (boot_button_held()) {
    console_mode(); /* never returns */
  }

  esp_err_t err = camera_start();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "camera init failed: %s", esp_err_to_name(err));
    ESP_LOGE(TAG, "check the FPC seating first — it is the usual answer");
    led_fault_forever();
  }
  log_sensor_identity();

  /**
   * Internal RAM, deliberately, and not PSRAM.
   *
   * Putting this in PSRAM to save internal memory looked free and was not:
   * the artifact rate went from 0 frames in 80 to 40 frames in 40, appearing
   * as green bands at fixed columns. USB DMA streams straight out of this
   * buffer, and out of PSRAM it reads corrupt. Measured, not theorised — and
   * the reason a bench tool needs an artifact count rather than an opinion,
   * because by eye this was "the line is back sometimes".
   */
  uint8_t *uvc_buffer = heap_caps_malloc(UVC_BUFFER_SIZE, MALLOC_CAP_DEFAULT);
  if (uvc_buffer == NULL) {
    ESP_LOGE(TAG, "no %d B for the UVC transfer buffer (free %u internal, %u psram)",
             UVC_BUFFER_SIZE, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    led_fault_forever();
  }

  uvc_device_config_t uvc = {
      .uvc_buffer = uvc_buffer,
      .uvc_buffer_size = UVC_BUFFER_SIZE,
      .start_cb = on_stream_start,
      .fb_get_cb = on_frame_get,
      .fb_return_cb = on_frame_return,
      .stop_cb = on_stream_stop,
      .cb_ctx = NULL,
  };
  ESP_ERROR_CHECK(uvc_device_config(0, &uvc));
  ESP_ERROR_CHECK(uvc_device_init());

  /* Three slow blinks: sensor answered, USB device up, waiting for a host to
   * open the stream. Distinguishable at a glance from the fault blink. */
  led_blink(3, 600);

  /* Tuning goes AFTER the USB device is up, deliberately. Anything that
   * misbehaves while writing sensor registers — a missing setter, an SCCB
   * write that stalls — would otherwise take the board off the bus entirely,
   * and a board that does not enumerate cannot be diagnosed. Enumerate
   * first, then tune; on_stream_start tunes again per stream anyway. */
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor != NULL) tune_sensor(sensor);
  ESP_LOGI(TAG, "kino uvc-preview %s ready — open the camera in any viewer",
           KINO_FW_VERSION);
}
