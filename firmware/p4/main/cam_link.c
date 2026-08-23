#include "cam_link.h"

#include <string.h>

#include "board_d4v1.h"
#include "cJSON.h"
#include "driver/uart.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "hardware_validation.h"
#include "kdp/decoder.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"
#include "node_link/node_link.h"

#define LINK_RX_BUF (2 * (NL_CHUNK_MAX + 64))
#define DEFAULT_TIMEOUT_MS 3000
#define CAPTURE_TIMEOUT_MS 8000

static SemaphoreHandle_t s_lock;
static uint32_t s_seq;
static camlink_info_t s_info = {
    .chip_revision = -1, .heap_kb = -1, .psram_kb = -1, .temp_c = CAMLINK_TEMP_UNKNOWN};
static camlink_stats_t s_stats;

static uint8_t s_decode_storage[KDP_MAX_FRAME];
static kdp_decoder_t s_decoder;
static uint8_t s_tx[512];

typedef struct {
  uint32_t seq;
  bool got;
  bool nack;
  uint8_t *dst;
  size_t dst_cap;
  size_t len;
  char err_code[24];
} pending_t;

static pending_t s_pending;

static void set_last_error(const char *code) {
  strncpy(s_stats.last_error, code, sizeof s_stats.last_error - 1);
  s_stats.last_error[sizeof s_stats.last_error - 1] = '\0';
}

static void on_frame(const kdp_frame_t *frame, void *ctx) {
  pending_t *p = (pending_t *)ctx;
  s_stats.rx_frames++;
  if ((frame->flags & KDP_FLAG_RESPONSE) == 0) return; /* node sends no events in M1B */
  if (frame->seq != p->seq || p->got) {
    // A response we no longer wait for: a late reply to a timed-out request
    // or a genuine duplicate. Counted, never delivered.
    s_stats.duplicates++;
    return;
  }

  p->len = frame->payload_len < p->dst_cap ? frame->payload_len : p->dst_cap;
  memcpy(p->dst, frame->payload, p->len);
  p->nack = (frame->flags & KDP_FLAG_ERROR) != 0;
  if (p->nack) {
    cJSON *err = cJSON_ParseWithLength((const char *)p->dst, p->len);
    const cJSON *code = err != NULL ? cJSON_GetObjectItem(err, "code") : NULL;
    if (cJSON_IsString(code)) strncpy(p->err_code, code->valuestring, sizeof p->err_code - 1);
    cJSON_Delete(err);
  }
  p->got = true;
}

/* Serialized request/response. Returns ESP_OK on a positive response,
 * ESP_ERR_INVALID_RESPONSE on a NACK, ESP_ERR_TIMEOUT on silence. */
static esp_err_t request(uint8_t cmd, const char *json, uint8_t *resp, size_t resp_cap,
                         size_t *resp_len, uint32_t timeout_ms) {
  xSemaphoreTake(s_lock, portMAX_DELAY);

  memset(&s_pending, 0, sizeof s_pending);
  s_seq = kdp_next_seq(s_seq);
  s_pending.seq = s_seq;
  s_pending.dst = resp;
  s_pending.dst_cap = resp_cap;
  s_stats.last_sequence = s_seq;

  const char *payload = json != NULL ? json : "{}";
  size_t total = kdp_encode_frame(s_tx, sizeof s_tx, NL_PROTOCOL_VERSION, cmd,
                                  KDP_FLAG_NONE, s_pending.seq,
                                  (const uint8_t *)payload, strlen(payload));
  if (total == 0) {
    xSemaphoreGive(s_lock);
    return ESP_ERR_INVALID_ARG;
  }

  int64_t start = esp_timer_get_time();
  uart_flush_input(BOARD_CAM1_UART_NUM);
  kdp_decoder_reset(&s_decoder);
  uart_write_bytes(BOARD_CAM1_UART_NUM, s_tx, total);
  s_stats.tx_frames++;
  s_stats.tx_bytes += (uint32_t)total;

  uint8_t rx[512];
  while (!s_pending.got) {
    int64_t elapsed_ms = (esp_timer_get_time() - start) / 1000;
    if (elapsed_ms >= timeout_ms) break;
    int n = uart_read_bytes(BOARD_CAM1_UART_NUM, rx, sizeof rx, pdMS_TO_TICKS(50));
    if (n > 0) {
      s_stats.rx_bytes += (uint32_t)n;
      kdp_decoder_push(&s_decoder, rx, (size_t)n, on_frame, &s_pending);
    }
  }

  esp_err_t result;
  if (!s_pending.got) {
    s_stats.timeouts++;
    set_last_error("TIMEOUT");
    result = ESP_ERR_TIMEOUT;
  } else if (s_pending.nack) {
    set_last_error(s_pending.err_code[0] != '\0' ? s_pending.err_code : "NACK");
    result = ESP_ERR_INVALID_RESPONSE;
  } else {
    s_info.latency_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
    result = ESP_OK;
  }
  s_stats.crc_errors += s_decoder.stats.crc_failures;
  s_stats.resyncs += s_decoder.stats.resyncs;
  s_decoder.stats.crc_failures = 0;
  s_decoder.stats.resyncs = 0;
  if (resp_len != NULL) *resp_len = s_pending.len;

  xSemaphoreGive(s_lock);
  return result;
}

esp_err_t camlink_init(void) {
  s_lock = xSemaphoreCreateMutex();
  if (s_lock == NULL) return ESP_ERR_NO_MEM;

  const uart_config_t config = {
      .baud_rate = NL_DEFAULT_BAUD,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .source_clk = UART_SCLK_DEFAULT,
  };
  ESP_ERROR_CHECK(uart_driver_install(BOARD_CAM1_UART_NUM, LINK_RX_BUF, 0, 0, NULL, 0));
  ESP_ERROR_CHECK(uart_param_config(BOARD_CAM1_UART_NUM, &config));
  ESP_ERROR_CHECK(uart_set_pin(BOARD_CAM1_UART_NUM, BOARD_CAM1_TX, BOARD_CAM1_RX,
                               UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

  kdp_decoder_init(&s_decoder, s_decode_storage, sizeof s_decode_storage);
  return ESP_OK;
}

void camlink_get_info(camlink_info_t *out) {
  xSemaphoreTake(s_lock, portMAX_DELAY);
  *out = s_info;
  xSemaphoreGive(s_lock);
}

void camlink_get_stats(camlink_stats_t *out) {
  xSemaphoreTake(s_lock, portMAX_DELAY);
  *out = s_stats;
  xSemaphoreGive(s_lock);
}

void camlink_reset_stats(void) {
  xSemaphoreTake(s_lock, portMAX_DELAY);
  uint32_t keep_seq = s_stats.last_sequence;
  memset(&s_stats, 0, sizeof s_stats);
  s_stats.last_sequence = keep_seq;
  xSemaphoreGive(s_lock);
}

static void copy_str(char *dst, size_t cap, const cJSON *item) {
  dst[0] = '\0';
  if (cJSON_IsString(item)) strncpy(dst, item->valuestring, cap - 1);
}

esp_err_t camlink_hello(void) {
  uint8_t resp[768];
  size_t len = 0;
  esp_err_t err = request(NL_CMD_HELLO, NULL, resp, sizeof resp - 1, &len,
                          DEFAULT_TIMEOUT_MS);

  xSemaphoreTake(s_lock, portMAX_DELAY);
  if (err != ESP_OK) {
    s_info.online = false;
    xSemaphoreGive(s_lock);
    return err;
  }
  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json == NULL) {
    s_info.online = false;
    xSemaphoreGive(s_lock);
    return ESP_ERR_INVALID_RESPONSE;
  }
  s_info.online = true;
  copy_str(s_info.firmware, sizeof s_info.firmware, cJSON_GetObjectItem(json, "firmware"));
  copy_str(s_info.sensor, sizeof s_info.sensor, cJSON_GetObjectItem(json, "sensor"));
  copy_str(s_info.sensor_pid, sizeof s_info.sensor_pid, cJSON_GetObjectItem(json, "sensorPid"));
  copy_str(s_info.session, sizeof s_info.session, cJSON_GetObjectItem(json, "sessionId"));
  copy_str(s_info.reset_reason, sizeof s_info.reset_reason,
           cJSON_GetObjectItem(json, "resetReason"));
  s_info.sensor_detected = cJSON_IsTrue(cJSON_GetObjectItem(json, "sensorDetected"));
  s_info.autofocus = cJSON_IsTrue(cJSON_GetObjectItem(json, "autofocus"));
  const cJSON *rev = cJSON_GetObjectItem(json, "chipRevision");
  s_info.chip_revision = cJSON_IsNumber(rev) ? rev->valueint : -1;
  const cJSON *heap = cJSON_GetObjectItem(json, "heapKB");
  s_info.heap_kb = cJSON_IsNumber(heap) ? (int32_t)heap->valuedouble : -1;
  const cJSON *psram = cJSON_GetObjectItem(json, "psramKB");
  s_info.psram_kb = cJSON_IsNumber(psram) ? (int32_t)psram->valuedouble : -1;
  cJSON_Delete(json);
  xSemaphoreGive(s_lock);

  // A decoded node HELLO on this unit proves the harness pins and the baud.
  hwv_mark_validated(HWV_CAM1_TX_GPIO52, "node HELLO answered");
  hwv_mark_validated(HWV_CAM1_RX_GPIO51, "node HELLO answered");
  hwv_mark_validated(HWV_CAM1_BAUD_921600, "node HELLO at 921600");
  hwv_mark_validated(HWV_CAM1_NODE_LINK, "node HELLO answered");
  if (s_info.sensor_detected) {
    hwv_mark_validated(HWV_CAM1_SENSOR_DETECT, s_info.sensor);
  }
  return ESP_OK;
}

esp_err_t camlink_ping(uint32_t *rtt_ms) {
  uint8_t resp[512];
  size_t len = 0;
  int64_t start = esp_timer_get_time();
  esp_err_t err = request(NL_CMD_STATUS, NULL, resp, sizeof resp - 1, &len,
                          DEFAULT_TIMEOUT_MS);
  if (rtt_ms != NULL) *rtt_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
  if (err != ESP_OK) return err;

  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json != NULL) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    copy_str(s_info.state, sizeof s_info.state, cJSON_GetObjectItem(json, "state"));
    const cJSON *heap = cJSON_GetObjectItem(json, "heapKB");
    if (cJSON_IsNumber(heap)) s_info.heap_kb = (int32_t)heap->valuedouble;
    const cJSON *psram = cJSON_GetObjectItem(json, "psramKB");
    if (cJSON_IsNumber(psram)) s_info.psram_kb = (int32_t)psram->valuedouble;
    const cJSON *temp = cJSON_GetObjectItem(json, "tempC");
    s_info.temp_c = cJSON_IsNumber(temp) ? (int32_t)temp->valuedouble : CAMLINK_TEMP_UNKNOWN;
    xSemaphoreGive(s_lock);
    cJSON_Delete(json);
  }
  return ESP_OK;
}

esp_err_t camlink_capture(const char *resolution, int jpeg_quality,
                          camlink_capture_result_t *out) {
  char req_json[96];
  if (resolution != NULL && jpeg_quality > 0) {
    snprintf(req_json, sizeof req_json, "{\"resolution\":\"%s\",\"quality\":%d}",
             resolution, jpeg_quality);
  } else if (resolution != NULL) {
    snprintf(req_json, sizeof req_json, "{\"resolution\":\"%s\"}", resolution);
  } else {
    strcpy(req_json, "{}");
  }

  uint8_t resp[512];
  size_t len = 0;
  esp_err_t err = request(NL_CMD_CAPTURE, req_json, resp, sizeof resp - 1, &len,
                          CAPTURE_TIMEOUT_MS);
  if (err != ESP_OK) return err;

  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json == NULL) return ESP_ERR_INVALID_RESPONSE;
  const cJSON *id = cJSON_GetObjectItem(json, "frameId");
  const cJSON *size = cJSON_GetObjectItem(json, "size");
  if (!cJSON_IsNumber(id) || !cJSON_IsNumber(size)) {
    cJSON_Delete(json);
    return ESP_ERR_INVALID_RESPONSE;
  }
  memset(out, 0, sizeof *out);
  out->frame_id = (uint32_t)id->valuedouble;
  out->size = (uint32_t)size->valuedouble;
  const cJSON *dur = cJSON_GetObjectItem(json, "durationMs");
  out->duration_ms = cJSON_IsNumber(dur) ? (uint32_t)dur->valuedouble : 0;
  copy_str(out->crc32, sizeof out->crc32, cJSON_GetObjectItem(json, "crc32"));
  const cJSON *heap = cJSON_GetObjectItem(json, "heapKB");
  out->heap_kb = cJSON_IsNumber(heap) ? (int32_t)heap->valuedouble : -1;
  const cJSON *psram = cJSON_GetObjectItem(json, "psramKB");
  out->psram_kb = cJSON_IsNumber(psram) ? (int32_t)psram->valuedouble : -1;
  cJSON_Delete(json);
  return ESP_OK;
}

esp_err_t camlink_read(uint32_t frame_id, uint32_t offset, uint8_t *buf, size_t want,
                       size_t *got) {
  char req_json[96];
  snprintf(req_json, sizeof req_json,
           "{\"frameId\":%lu,\"offset\":%lu,\"length\":%lu}", (unsigned long)frame_id,
           (unsigned long)offset, (unsigned long)want);
  return request(NL_CMD_READ, req_json, buf, want, got, DEFAULT_TIMEOUT_MS);
}

esp_err_t camlink_release(uint32_t frame_id) {
  char req_json[48];
  snprintf(req_json, sizeof req_json, "{\"frameId\":%lu}", (unsigned long)frame_id);
  uint8_t resp[128];
  return request(NL_CMD_RELEASE, req_json, resp, sizeof resp, NULL, DEFAULT_TIMEOUT_MS);
}
