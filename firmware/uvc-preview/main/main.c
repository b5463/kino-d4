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

#include <string.h>

#include "board_xiao_s3.h"
#include "driver/gpio.h"
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "usb_device_uvc.h"

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
      .xclk_freq_hz = BOARD_CAM_XCLK_HZ,
      .ledc_timer = LEDC_TIMER_0,
      .ledc_channel = LEDC_CHANNEL_0,
      .pixel_format = PIXFORMAT_JPEG,
      /* The host resets this in on_stream_start; this is only what the sensor
       * boots into, so reading a PID costs no PSRAM it does not need. */
      .frame_size = FRAMESIZE_VGA,
      .jpeg_quality = 12,
      /* Two buffers, newest served: a preview that lags is worse than one
       * that skips, because lag looks like the module is slow. */
      .fb_count = 2,
      .fb_location = CAMERA_FB_IN_PSRAM,
      .grab_mode = CAMERA_GRAB_LATEST,
  };
  return esp_camera_init(&config);
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

void app_main(void) {
  led_init();

  esp_err_t err = camera_start();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "camera init failed: %s", esp_err_to_name(err));
    ESP_LOGE(TAG, "check the FPC seating first — it is the usual answer");
    led_fault_forever();
  }
  log_sensor_identity();

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
  ESP_LOGI(TAG, "kino uvc-preview %s ready — open the camera in any viewer",
           KINO_FW_VERSION);
}
