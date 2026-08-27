#include "thumb.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h> /* fsync */

#include "driver/jpeg_decode.h"
#include "driver/jpeg_encode.h"
#include "driver/ppa.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "thumb";

/* Largest frame this firmware will try to reduce. GET_CAPABILITIES advertises
 * 2048x1536 as the maximum resolution, so that is what the decode buffer has
 * to be able to hold. */
#define MAX_SRC_W 2048
#define MAX_SRC_H 1536

static jpeg_decoder_handle_t s_dec;
static jpeg_encoder_handle_t s_enc;
static ppa_client_handle_t s_srm;
static SemaphoreHandle_t s_lock;

/* Allocated on the first thumbnail and kept. Six megabytes is a lot to hold
 * before anyone has taken a picture, and a lot to allocate and release on
 * every shutter press for thousands of presses - PSRAM fragments like any
 * other heap. Once, lazily, is the shape that avoids both. */
static uint8_t *s_full;   /* decoded source, RGB565 */
static size_t s_full_cap;
static uint8_t *s_small;  /* scaled result, RGB565 */
static size_t s_small_cap;
static uint8_t *s_out;    /* encoded JPEG */
static size_t s_out_cap;

esp_err_t thumb_init(void) {
  if (s_lock != NULL) return ESP_OK;
  s_lock = xSemaphoreCreateMutex();
  if (s_lock == NULL) return ESP_ERR_NO_MEM;

  /* 200 ms: a UXGA decode is a few milliseconds, so this only bounds a codec
   * that has stopped answering rather than one that is working hard. */
  const jpeg_decode_engine_cfg_t dcfg = {.timeout_ms = 200};
  esp_err_t err = jpeg_new_decoder_engine(&dcfg, &s_dec);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "no JPEG decoder: %s", esp_err_to_name(err));
    return err;
  }
  const jpeg_encode_engine_cfg_t ecfg = {.timeout_ms = 200};
  err = jpeg_new_encoder_engine(&ecfg, &s_enc);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "no JPEG encoder: %s", esp_err_to_name(err));
    return err;
  }
  const ppa_client_config_t pcfg = {.oper_type = PPA_OPERATION_SRM};
  err = ppa_register_client(&pcfg, &s_srm);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "no PPA client: %s", esp_err_to_name(err));
    return err;
  }
  ESP_LOGI(TAG, "ready — thumbnails fit %dx%d", THUMB_MAX_W, THUMB_MAX_H);
  return ESP_OK;
}

bool thumb_ready(void) { return s_enc != NULL && s_dec != NULL && s_srm != NULL; }

/** Grow a lazily-held buffer to `want`, keeping whatever is already big
 * enough. Uses the codec allocator so cache and 2D-DMA alignment are right. */
static bool ensure(uint8_t **buf, size_t *cap, size_t want, bool for_encode, bool input) {
  if (*buf != NULL && *cap >= want) return true;
  if (*buf != NULL) {
    free(*buf);
    *buf = NULL;
    *cap = 0;
  }
  size_t got = 0;
  if (for_encode) {
    jpeg_encode_memory_alloc_cfg_t cfg = {.buffer_direction = input
                                                                  ? JPEG_ENC_ALLOC_INPUT_BUFFER
                                                                  : JPEG_ENC_ALLOC_OUTPUT_BUFFER};
    *buf = jpeg_alloc_encoder_mem(want, &cfg, &got);
  } else {
    jpeg_decode_memory_alloc_cfg_t cfg = {.buffer_direction = JPEG_DEC_ALLOC_OUTPUT_BUFFER};
    *buf = jpeg_alloc_decoder_mem(want, &cfg, &got);
  }
  if (*buf == NULL) return false;
  *cap = got;
  return true;
}

/**
 * The largest sixteenth that keeps the picture inside the box.
 *
 * The PPA scales by n/16. Rounding to the nearest would sometimes overflow
 * the box by a few pixels, so this always rounds down, and never returns 0 —
 * a frame more than sixteen times too big still gets its smallest possible
 * reduction rather than a division by zero.
 */
static int scale_sixteenths(uint32_t w, uint32_t h) {
  const uint32_t by_w = (THUMB_MAX_W * 16) / (w ? w : 1);
  const uint32_t by_h = (THUMB_MAX_H * 16) / (h ? h : 1);
  uint32_t n = by_w < by_h ? by_w : by_h;
  if (n < 1) n = 1;
  if (n > 16) n = 16;
  return (int)n;
}

/** Read a whole file into a codec-aligned buffer. */
static uint8_t *slurp(const char *path, size_t *out_len, size_t *out_cap) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return NULL;
  }
  const long size = ftell(f);
  rewind(f);
  /* A capture frame is a few hundred KB; anything past two megabytes is not
   * one of ours and is refused rather than allocated for. */
  if (size <= 4 || size > 2 * 1024 * 1024) {
    fclose(f);
    return NULL;
  }
  jpeg_decode_memory_alloc_cfg_t cfg = {.buffer_direction = JPEG_DEC_ALLOC_INPUT_BUFFER};
  size_t cap = 0;
  uint8_t *buf = jpeg_alloc_decoder_mem((size_t)size, &cfg, &cap);
  if (buf == NULL) {
    fclose(f);
    return NULL;
  }
  const size_t got = fread(buf, 1, (size_t)size, f);
  fclose(f);
  if (got != (size_t)size) {
    free(buf);
    return NULL;
  }
  *out_len = got;
  *out_cap = cap;
  return buf;
}

esp_err_t thumb_load(const char *path, uint16_t *tile, int tile_w, int tile_h, uint16_t pad) {
  if (!thumb_ready() || tile == NULL || tile_w < 8 || tile_h < 8) return ESP_ERR_INVALID_STATE;

  size_t len = 0, cap = 0;
  uint8_t *jpeg = slurp(path, &len, &cap);
  if (jpeg == NULL) return ESP_ERR_NOT_FOUND;

  jpeg_decode_picture_info_t info;
  esp_err_t err = jpeg_decoder_get_info(jpeg, (uint32_t)len, &info);
  if (err != ESP_OK || info.width == 0 || info.height == 0 || info.width > MAX_SRC_W ||
      info.height > MAX_SRC_H) {
    free(jpeg);
    return err != ESP_OK ? err : ESP_ERR_INVALID_SIZE;
  }

  xSemaphoreTake(s_lock, portMAX_DELAY);
  esp_err_t result = ESP_FAIL;

  const uint32_t pad_w = (info.width + 15) & ~15u;
  const uint32_t pad_h = (info.height + 15) & ~15u;
  if (!ensure(&s_full, &s_full_cap, (size_t)pad_w * pad_h * 2, false, false)) goto out;

  jpeg_decode_cfg_t dcfg = {
      .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
      .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_RGB,
  };
  uint32_t decoded = 0;
  err = jpeg_decoder_process(s_dec, &dcfg, jpeg, (uint32_t)len, s_full, (uint32_t)s_full_cap,
                             &decoded);
  if (err != ESP_OK) goto out;

  /* Same sixteenths rule as thumb_write, against the tile rather than the
   * thumbnail box. */
  const uint32_t by_w = ((uint32_t)tile_w * 16) / info.width;
  const uint32_t by_h = ((uint32_t)tile_h * 16) / info.height;
  uint32_t n16 = by_w < by_h ? by_w : by_h;
  if (n16 < 1) n16 = 1;
  if (n16 > 16) n16 = 16;
  const uint32_t out_w = (info.width * n16) / 16;
  const uint32_t out_h = (info.height * n16) / 16;
  if (out_w < 4 || out_h < 4 || out_w > (uint32_t)tile_w || out_h > (uint32_t)tile_h) goto out;

  /* Pad first, then place the picture in the middle of the tile. The PPA
   * writes a rectangle, so the border has to already be there. */
  for (int i = 0; i < tile_w * tile_h; i++) tile[i] = pad;
  const uint32_t ox = ((uint32_t)tile_w - out_w) / 2;
  const uint32_t oy = ((uint32_t)tile_h - out_h) / 2;

  ppa_srm_oper_config_t srm = {
      .in = {.buffer = s_full,
             .pic_w = pad_w,
             .pic_h = pad_h,
             .block_w = info.width,
             .block_h = info.height,
             .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .out = {.buffer = tile,
              .buffer_size = (size_t)tile_w * tile_h * 2,
              .pic_w = (uint32_t)tile_w,
              .pic_h = (uint32_t)tile_h,
              .block_offset_x = ox,
              .block_offset_y = oy,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .rotation_angle = PPA_SRM_ROTATION_ANGLE_0,
      .scale_x = (float)n16 / 16.0f,
      .scale_y = (float)n16 / 16.0f,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  if (ppa_do_scale_rotate_mirror(s_srm, &srm) == ESP_OK) result = ESP_OK;

out:
  xSemaphoreGive(s_lock);
  free(jpeg);
  return result;
}

esp_err_t thumb_write(const uint8_t *jpeg, size_t len, const char *path) {
  if (!thumb_ready() || jpeg == NULL || len < 4 || path == NULL) return ESP_ERR_INVALID_STATE;

  jpeg_decode_picture_info_t info;
  esp_err_t err = jpeg_decoder_get_info(jpeg, (uint32_t)len, &info);
  if (err != ESP_OK) return err;
  if (info.width == 0 || info.height == 0 || info.width > MAX_SRC_W ||
      info.height > MAX_SRC_H) {
    ESP_LOGW(TAG, "source is %lux%lu — outside what this build reduces",
             (unsigned long)info.width, (unsigned long)info.height);
    return ESP_ERR_INVALID_SIZE;
  }

  xSemaphoreTake(s_lock, portMAX_DELAY);
  const int64_t t0 = esp_timer_get_time();
  esp_err_t result = ESP_FAIL;

  /* The decoder pads to a 16-pixel boundary, so the buffer has to hold the
   * padded picture even though only the visible part is scaled. Getting this
   * wrong writes past the end of the buffer, not merely a wrong picture. */
  const uint32_t pad_w = (info.width + 15) & ~15u;
  const uint32_t pad_h = (info.height + 15) & ~15u;
  if (!ensure(&s_full, &s_full_cap, (size_t)pad_w * pad_h * 2, false, false)) {
    ESP_LOGW(TAG, "no room to decode %lux%lu", (unsigned long)pad_w, (unsigned long)pad_h);
    goto done;
  }

  jpeg_decode_cfg_t dcfg = {
      .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
      .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_RGB,
  };
  uint32_t decoded = 0;
  err = jpeg_decoder_process(s_dec, &dcfg, jpeg, (uint32_t)len, s_full,
                             (uint32_t)s_full_cap, &decoded);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "decode failed: %s", esp_err_to_name(err));
    goto done;
  }

  const int n = scale_sixteenths(info.width, info.height);
  const uint32_t out_w = (info.width * (uint32_t)n) / 16;
  const uint32_t out_h = (info.height * (uint32_t)n) / 16;
  if (out_w < 8 || out_h < 8) goto done;

  if (!ensure(&s_small, &s_small_cap, (size_t)out_w * out_h * 2, true, true)) goto done;

  ppa_srm_oper_config_t srm = {
      .in =
          {
              .buffer = s_full,
              .pic_w = pad_w,
              .pic_h = pad_h,
              .block_w = info.width,
              .block_h = info.height,
              .block_offset_x = 0,
              .block_offset_y = 0,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .out =
          {
              .buffer = s_small,
              .buffer_size = s_small_cap,
              .pic_w = out_w,
              .pic_h = out_h,
              .block_offset_x = 0,
              .block_offset_y = 0,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .rotation_angle = PPA_SRM_ROTATION_ANGLE_0,
      .scale_x = (float)n / 16.0f,
      .scale_y = (float)n / 16.0f,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  err = ppa_do_scale_rotate_mirror(s_srm, &srm);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "scale failed: %s", esp_err_to_name(err));
    goto done;
  }

  /* A quarter of the raw size is far more than a 300x225 JPEG needs and still
   * only 33 KB — cheap insurance against a noisy frame that compresses badly
   * and would otherwise fail at the last step. */
  if (!ensure(&s_out, &s_out_cap, (size_t)out_w * out_h / 2, true, false)) goto done;

  jpeg_encode_cfg_t ecfg = {
      .src_type = JPEG_ENCODE_IN_FORMAT_RGB565,
      .sub_sample = JPEG_DOWN_SAMPLING_YUV420,
      .image_quality = 80,
      .width = out_w,
      .height = out_h,
  };
  uint32_t out_size = 0;
  err = jpeg_encoder_process(s_enc, &ecfg, s_small, (uint32_t)(out_w * out_h * 2), s_out,
                             (uint32_t)s_out_cap, &out_size);
  if (err != ESP_OK || out_size == 0) {
    ESP_LOGW(TAG, "encode failed: %s", esp_err_to_name(err));
    goto done;
  }

  FILE *f = fopen(path, "wb");
  if (f == NULL) goto done;
  int failed = fwrite(s_out, 1, out_size, f) != out_size;
  failed |= fflush(f) != 0;
  failed |= fsync(fileno(f)) != 0;
  failed |= fclose(f) != 0;
  if (failed) {
    /* A truncated thumbnail is worse than none: it renders as a grey band in
     * a gallery and looks like the photograph is damaged. */
    remove(path);
    goto done;
  }

  ESP_LOGI(TAG, "%lux%lu -> %lux%lu, %lu B in %lu ms", (unsigned long)info.width,
           (unsigned long)info.height, (unsigned long)out_w, (unsigned long)out_h,
           (unsigned long)out_size, (unsigned long)((esp_timer_get_time() - t0) / 1000));
  result = ESP_OK;

done:
  xSemaphoreGive(s_lock);
  return result;
}
