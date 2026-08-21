#include "camera.h"

#include <string.h>

#include "board_xiao_s3.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "camera";

static bool s_detected;
static uint16_t s_pid;
static char s_name[16];
static char s_max_res[16];

esp_err_t camsensor_init(void) {
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
      .frame_size = FRAMESIZE_UXGA, /* 1600x1200 default, see start plan */
      .jpeg_quality = 12,
      .fb_count = 1,
      .fb_location = CAMERA_FB_IN_PSRAM,
      .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
  };

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "sensor init failed: %s", esp_err_to_name(err));
    return err;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_FAIL;

  camera_sensor_info_t *info = esp_camera_sensor_get_info(&sensor->id);
  if (info != NULL) {
    strncpy(s_name, info->name, sizeof s_name - 1);
    s_pid = sensor->id.PID;
    s_detected = true;
    switch (info->max_size) {
      case FRAMESIZE_QSXGA: strcpy(s_max_res, "2592x1944"); break;
      case FRAMESIZE_QXGA: strcpy(s_max_res, "2048x1536"); break;
      case FRAMESIZE_UXGA: strcpy(s_max_res, "1600x1200"); break;
      default: s_max_res[0] = '\0'; break;
    }
    ESP_LOGI(TAG, "sensor detected: %s (PID 0x%04x)", s_name, sensor->id.PID);
  }
  return ESP_OK;
}

const char *camsensor_name(void) { return s_detected ? s_name : NULL; }
bool camsensor_detected(void) { return s_detected; }
uint16_t camsensor_pid(void) { return s_detected ? s_pid : 0; }
bool camsensor_autofocus_capable(void) { return s_detected && s_pid == OV5640_PID; }
const char *camsensor_max_resolution(void) { return s_max_res[0] ? s_max_res : NULL; }

esp_err_t camsensor_set_quality(int quality) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_ERR_INVALID_STATE;
  if (quality < 5) quality = 5;
  if (quality > 63) quality = 63;
  return sensor->set_quality(sensor, quality) == 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t camsensor_set_resolution(const char *resolution) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == NULL) return ESP_ERR_INVALID_STATE;
  framesize_t size;
  if (strcmp(resolution, "1600x1200") == 0) size = FRAMESIZE_UXGA;
  else if (strcmp(resolution, "2048x1536") == 0) size = FRAMESIZE_QXGA;
  else return ESP_ERR_INVALID_ARG;
  return sensor->set_framesize(sensor, size) == 0 ? ESP_OK : ESP_FAIL;
}

camera_fb_t *camsensor_capture(uint32_t *duration_ms) {
  int64_t start = esp_timer_get_time();
  camera_fb_t *fb = esp_camera_fb_get();
  if (duration_ms != NULL) {
    *duration_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
  }
  return fb;
}

void camsensor_release(camera_fb_t *fb) {
  if (fb != NULL) esp_camera_fb_return(fb);
}
