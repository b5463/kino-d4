#include "thumb.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h> /* fsync */

#include "driver/jpeg_decode.h"
#include "driver/jpeg_encode.h"
#include "driver/ppa.h"
#include "esp_cache.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "klog.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "pure.h"

static const char *TAG = "thumb";

/* Largest frame this firmware will try to reduce. GET_CAPABILITIES advertises
 * 2048x1536 as the maximum resolution, so that is what the decode buffer has
 * to be able to hold. */
#define MAX_SRC_W 2048
#define MAX_SRC_H 1536

/* Held back from the buffer size declared to the JPEG encoder — see the call.
 * A baseline header is SOI, APP0, two DQT, four DHT, SOF0 and SOS, a little
 * over 600 bytes, and the driver pads it with a COM marker to the next 64-byte
 * cache line. One kilobyte covers it with room to spare. */
#define ENC_HEADER_SLACK 1024u

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

/** Grow a lazily-held codec OUTPUT buffer to `want`, keeping whatever is
 * already big enough. Both codec allocators round an output request up to the
 * cache line and return the pointer on one, because a 2D-DMA write has to
 * invalidate whole lines. */
static bool ensure(uint8_t **buf, size_t *cap, size_t want, bool for_encode) {
  if (*buf != NULL && *cap >= want) return true;
  if (*buf != NULL) {
    free(*buf);
    *buf = NULL;
    *cap = 0;
  }
  size_t got = 0;
  if (for_encode) {
    jpeg_encode_memory_alloc_cfg_t cfg = {.buffer_direction = JPEG_ENC_ALLOC_OUTPUT_BUFFER};
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
 * Grow the PPA destination to hold `w` x `h` RGB565.
 *
 * This deliberately does not use jpeg_alloc_encoder_mem. That call only rounds
 * and aligns for JPEG_ENC_ALLOC_OUTPUT_BUFFER; for an INPUT buffer it is a
 * plain heap_caps_calloc and it reports the unrounded request back as the
 * allocated size, because the encoder only ever READS the buffer and a 2D-DMA
 * read needs no alignment at all.
 *
 * The PPA WRITES it, and ppa_do_scale_rotate_mirror checks both halves:
 *
 *   out.buffer & (cache_line - 1) == 0  &&  out.buffer_size & (cache_line - 1) == 0
 *
 * A PSRAM heap block lands on 64 bytes about one time in sixteen, so
 * thumb_write returned ESP_ERR_INVALID_ARG on essentially every capture this
 * firmware has ever taken. Same 64-byte rule and same macro as the gallery
 * tiles that thumb_load has been scaling into successfully all along.
 */
static bool ensure_ppa_dst(uint32_t w, uint32_t h) {
  const size_t want = THUMB_TILE_BYTES(w, h);
  if (s_small != NULL && s_small_cap >= want) return true;
  free(s_small);
  s_small = heap_caps_aligned_calloc(THUMB_CACHE_LINE, 1, want, MALLOC_CAP_SPIRAM);
  s_small_cap = (s_small != NULL) ? want : 0;
  return s_small != NULL;
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
  return pure_scale_sixteenths(w, h, THUMB_MAX_W, THUMB_MAX_H);
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
  if (!ensure(&s_full, &s_full_cap, (size_t)pad_w * pad_h * 2, false)) {
    klog("P4", "thumb load %s: no %lu KB decode buffer for %lux%lu", path,
             (unsigned long)((size_t)pad_w * pad_h * 2 / 1024), (unsigned long)info.width,
             (unsigned long)info.height);
    goto out;
  }

  jpeg_decode_cfg_t dcfg = {
      .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
        /* BGR, which in this enum means LITTLE endian, not blue-first. ESP-IDF:
   *
   *   "Enumeration for jpeg big/small endian output."
   *   JPEG_DEC_RGB_ELEMENT_ORDER_BGR  "the color component in small endian"
   *   JPEG_DEC_RGB_ELEMENT_ORDER_RGB  "the color component in big endian"
   *
   * The name reads like a channel swap and is a byte swap. With _RGB the
   * decoder wrote big-endian RGB565 into a pipeline that is little-endian
   * everywhere else - the panel is LCD_COLOR_PIXEL_FORMAT_RGB565 with
   * LCD_RGB_ELEMENT_ORDER_RGB, the PPA is PPA_SRM_COLOR_MODE_RGB565 and
   * every UI draw is a native uint16_t. Swapping the two bytes of an
   * RGB565 pixel moves the green LSBs into red and the red MSBs into
   * blue, so smooth gradients came out as hard rainbow contours over
   * correct geometry. The stored JPEG was always fine; only the screen
   * was wrong. */
      .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_BGR,
  };
  uint32_t decoded = 0;
  err = jpeg_decoder_process(s_dec, &dcfg, jpeg, (uint32_t)len, s_full, (uint32_t)s_full_cap,
                             &decoded);
  if (err != ESP_OK) {
    klog("P4", "thumb load %s: decode failed %s (%lux%lu, %lu B in, cap %lu KB)", path,
             esp_err_to_name(err), (unsigned long)info.width, (unsigned long)info.height,
             (unsigned long)len, (unsigned long)(s_full_cap / 1024));
    goto out;
  }

  /* Same sixteenths rule as thumb_write, against the tile rather than the
   * thumbnail box. */
  const uint32_t n16 =
      (uint32_t)pure_scale_sixteenths(info.width, info.height, (uint32_t)tile_w, (uint32_t)tile_h);
  const uint32_t out_w = (info.width * n16) / 16;
  const uint32_t out_h = (info.height * n16) / 16;
  if (out_w < 4 || out_h < 4 || out_w > (uint32_t)tile_w || out_h > (uint32_t)tile_h) {
    klog("P4", "thumb load %s: %lux%lu at %lu/16 gives %lux%lu, tile is %dx%d", path,
             (unsigned long)info.width, (unsigned long)info.height, (unsigned long)n16,
             (unsigned long)out_w, (unsigned long)out_h, tile_w, tile_h);
    goto out;
  }

  /* Pad first, then place the picture in the middle of the tile. The PPA
   * writes a rectangle, so the border has to already be there. */
  for (int i = 0; i < tile_w * tile_h; i++) tile[i] = pad;
  /*
   * Flush the pad before the PPA touches this buffer.
   *
   * The loop above is a CPU write, so it leaves dirty cache lines over the
   * WHOLE tile. The PPA then DMA-writes the picture into the middle of it. If
   * those dirty pad lines are evicted afterwards they land on top of the
   * picture, and the screen shows bands of flat pad colour torn through the
   * photograph - which is exactly what the bench saw once the alignment was
   * fixed and the operation started succeeding.
   *
   * C2M: cache to memory, i.e. write back what the CPU just wrote.
   */
  esp_cache_msync(tile, THUMB_TILE_BYTES(tile_w, tile_h),
                  ESP_CACHE_MSYNC_FLAG_DIR_C2M);
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
              .buffer_size = THUMB_TILE_BYTES(tile_w, tile_h),
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
  const esp_err_t perr = ppa_do_scale_rotate_mirror(s_srm, &srm);
  if (perr == ESP_OK) {
    /* M2C: memory to cache, i.e. drop what the CPU thinks is here so the
     * caller's blit reads what the DMA engine actually wrote. */
    esp_cache_msync(tile, THUMB_TILE_BYTES(tile_w, tile_h),
                    ESP_CACHE_MSYNC_FLAG_DIR_M2C);
    result = ESP_OK;
  }
  else
    klog("P4", "thumb PPA fail %s %lux%lu->%lux%lu n=%lu tile %dx%d",
         esp_err_to_name(perr), (unsigned long)pad_w, (unsigned long)pad_h,
         (unsigned long)out_w, (unsigned long)out_h, (unsigned long)n16, tile_w, tile_h);

out:
  xSemaphoreGive(s_lock);
  free(jpeg);
  return result;
}

static int align_round(double v) { return (int)(v >= 0.0 ? v + 0.5 : v - 0.5); }

esp_err_t thumb_load_aligned(const char *path, uint16_t *tile, int tile_w, int tile_h, uint16_t pad,
                             const pure_cam_offset_t *offsets, int cam) {
  if (!thumb_ready() || tile == NULL || tile_w < 8 || tile_h < 8 || offsets == NULL) {
    return ESP_ERR_INVALID_STATE;
  }
  if (cam < 0 || cam >= PURE_WIGGLE_FRAMES_MAX) return ESP_ERR_INVALID_ARG;

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

  /* Same decode as thumb_load - the endianness note there applies here too. */
  const uint32_t pad_w = (info.width + 15) & ~15u;
  const uint32_t pad_h = (info.height + 15) & ~15u;
  if (!ensure(&s_full, &s_full_cap, (size_t)pad_w * pad_h * 2, false)) {
    klog("P4", "thumb align %s: no decode buffer for %lux%lu", path, (unsigned long)info.width,
         (unsigned long)info.height);
    goto out;
  }
  jpeg_decode_cfg_t dcfg = {
      .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
      .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_BGR,
  };
  uint32_t decoded = 0;
  err = jpeg_decoder_process(s_dec, &dcfg, jpeg, (uint32_t)len, s_full, (uint32_t)s_full_cap,
                             &decoded);
  if (err != ESP_OK) {
    klog("P4", "thumb align %s: decode failed %s", path, esp_err_to_name(err));
    goto out;
  }

  /* The plan against the ACTUAL decoded size, so the crop is inside the pixels
   * that really exist. crop is the common overlap; this camera's shift moves the
   * source window the crop is read from - shift the window the OPPOSITE way from
   * the frame's own move, so the subject lands in the same place the worker's
   * shifted-then-cropped frame puts it. */
  pure_frame_xform_t xf[PURE_WIGGLE_FRAMES_MAX];
  const pure_crop_t crop =
      pure_align_plan((int)info.width, (int)info.height, offsets, PURE_WIGGLE_FRAMES_MAX, xf);
  if (crop.w < 8 || crop.h < 8) goto out;

  int sx = crop.x - align_round(xf[cam].dx);
  int sy = crop.y - align_round(xf[cam].dy);
  if (sx < 0) sx = 0;
  if (sy < 0) sy = 0;
  if (sx + crop.w > (int)info.width) sx = (int)info.width - crop.w;
  if (sy + crop.h > (int)info.height) sy = (int)info.height - crop.h;
  if (sx < 0 || sy < 0) goto out; /* a crop larger than the frame - refuse */

  /* Fill the whole tile with pad and flush it, exactly as thumb_load does and
   * for the same reason: the PPA DMA-writes over the middle, and dirty pad lines
   * evicted afterwards would tear bands through the picture. Here the crop scales
   * to fill the tile, so the pad shows only in the sub-pixel the fill rounds
   * off - but the flush rule is the same. */
  for (int i = 0; i < tile_w * tile_h; i++) tile[i] = pad;
  esp_cache_msync(tile, THUMB_TILE_BYTES(tile_w, tile_h), ESP_CACHE_MSYNC_FLAG_DIR_C2M);

  ppa_srm_oper_config_t srm = {
      .in = {.buffer = s_full,
             .pic_w = pad_w,
             .pic_h = pad_h,
             .block_w = (uint32_t)crop.w,
             .block_h = (uint32_t)crop.h,
             .block_offset_x = (uint32_t)sx,
             .block_offset_y = (uint32_t)sy,
             .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .out = {.buffer = tile,
              .buffer_size = THUMB_TILE_BYTES(tile_w, tile_h),
              .pic_w = (uint32_t)tile_w,
              .pic_h = (uint32_t)tile_h,
              .block_offset_x = 0,
              .block_offset_y = 0,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .rotation_angle = PPA_SRM_ROTATION_ANGLE_0,
      /* Fill the tile from the crop. The crop is ~4:3 and the tile is 4:3, so
       * the two scales are within rounding of each other; the calibration's
       * rotation term is NOT applied here - the SRM PPA rotates only in 90 deg
       * steps, and a degree or two of lens-mount rotation is folded into the
       * crop's slack rather than turned into pixels. */
      .scale_x = (float)tile_w / (float)crop.w,
      .scale_y = (float)tile_h / (float)crop.h,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  const esp_err_t perr = ppa_do_scale_rotate_mirror(s_srm, &srm);
  if (perr == ESP_OK) {
    esp_cache_msync(tile, THUMB_TILE_BYTES(tile_w, tile_h), ESP_CACHE_MSYNC_FLAG_DIR_M2C);
    result = ESP_OK;
  } else {
    klog("P4", "thumb align PPA fail %s crop %dx%d@%d,%d tile %dx%d", esp_err_to_name(perr), crop.w,
         crop.h, sx, sy, tile_w, tile_h);
  }

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
  if (!ensure(&s_full, &s_full_cap, (size_t)pad_w * pad_h * 2, false)) {
    klog("P4", "thumb: no room to decode %lux%lu", (unsigned long)pad_w, (unsigned long)pad_h);
    goto done;
  }

  jpeg_decode_cfg_t dcfg = {
      .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
      .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_BGR,
  };
  uint32_t decoded = 0;
  err = jpeg_decoder_process(s_dec, &dcfg, jpeg, (uint32_t)len, s_full,
                             (uint32_t)s_full_cap, &decoded);
  if (err != ESP_OK) {
    klog("P4", "thumb: decode failed: %s", esp_err_to_name(err));
    goto done;
  }

  const int n = scale_sixteenths(info.width, info.height);
  /*
   * Trimmed to whole MCUs, because the encoder does not check and does not pad.
   *
   * jpeg_encoder_process is configured JPEG_DOWN_SAMPLING_YUV420, whose MCU is
   * 16x16, and IDF passes the dimensions straight to the hardware with no
   * validation: a picture that is not a multiple of 16 in both axes produces a
   * data-unit count that disagrees with the configured resolution, not a clean
   * ESP_ERR_INVALID_ARG. 2048x1536 reduces to 256x192 and is already whole,
   * which is the only reason this has not bitten - the other configured
   * capture size, 1600x1200, reduces to 300x225 and is whole in neither.
   *
   * Rounding down costs at most 15 px off each edge of a ~300 px thumbnail and
   * keeps the scale factor exact; the PPA writes the smaller block and the
   * encoder is handed dimensions it can actually represent.
   */
  const uint32_t out_w = ((info.width * (uint32_t)n) / 16) & ~15u;
  const uint32_t out_h = ((info.height * (uint32_t)n) / 16) & ~15u;
  if (out_w < 16 || out_h < 16) goto done;

  /*
   * Crop the SOURCE block to match the trimmed output, not just the output.
   *
   * The PPA checks the scaled block against the destination picture:
   * new_block_w = (uint32_t)(scale_x * in.block_w) must be <= out.pic_w. Trim
   * only the output and that check fails - 1600x1200 at 3/16 scales the full
   * 1600-wide block to 300, which no longer fits the 288 the MCU rounding left,
   * and the call comes back ESP_ERR_INVALID_ARG. Measured exactly that: the
   * 2048x1536 thumbnail wrote and the 1600x1200 one did not.
   *
   * Reading a slightly smaller rectangle of the source instead keeps both
   * rules satisfied. Integer division can leave the scaled height a pixel
   * under out_h, which is legal - the check is <=, not == - and costs at most
   * one row of a 224-row thumbnail.
   */
  uint32_t blk_w = (out_w * 16u) / (uint32_t)n;
  uint32_t blk_h = (out_h * 16u) / (uint32_t)n;
  if (blk_w > info.width) blk_w = info.width;
  if (blk_h > info.height) blk_h = info.height;

  if (!ensure_ppa_dst(out_w, out_h)) goto done;

  ppa_srm_oper_config_t srm = {
      .in =
          {
              .buffer = s_full,
              .pic_w = pad_w,
              .pic_h = pad_h,
              .block_w = blk_w,
              .block_h = blk_h,
              .block_offset_x = 0,
              .block_offset_y = 0,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .out =
          {
              .buffer = s_small,
              /* The rounded-up size, not out_w*out_h*2: the driver wants a
               * whole number of cache lines here, and 300x225 - what a 1600
               * wide frame reduces to - is 135000 bytes, 2109.375 lines. The
               * picture itself stays out_w x out_h, so the encoder that reads
               * this buffer next still sees an out_w stride. */
              .buffer_size = THUMB_TILE_BYTES(out_w, out_h),
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
    klog("P4", "thumb: scale failed: %s", esp_err_to_name(err));
    goto done;
  }

  /* A quarter of the raw size is far more than a 300x225 JPEG needs and still
   * only 33 KB — cheap insurance against a noisy frame that compresses badly
   * and would otherwise fail at the last step. */
  if (!ensure(&s_out, &s_out_cap, (size_t)out_w * out_h / 2 + ENC_HEADER_SLACK, true)) goto done;

  jpeg_encode_cfg_t ecfg = {
      .src_type = JPEG_ENCODE_IN_FORMAT_RGB565,
      .sub_sample = JPEG_DOWN_SAMPLING_YUV420,
      .image_quality = 80,
      .width = out_w,
      .height = out_h,
  };
  uint32_t out_size = 0;
  /* s_out_cap - ENC_HEADER_SLACK, not s_out_cap. The encoder writes the header
   * itself with the CPU and then points its output DMA at s_out + header_len,
   * but sizes that descriptor with the whole outbuf_size it was handed - so a
   * stream that fills the buffer runs header_len bytes past the end of the
   * allocation. Holding the slack back keeps that overrun inside our own. */
  err = jpeg_encoder_process(s_enc, &ecfg, s_small, (uint32_t)(out_w * out_h * 2), s_out,
                             (uint32_t)(s_out_cap - ENC_HEADER_SLACK), &out_size);
  if (err != ESP_OK || out_size == 0) {
    klog("P4", "thumb: encode failed: %s", esp_err_to_name(err));
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
