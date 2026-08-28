// Node-link server: answers the P4 over UART using KDP framing with the
// node_link command namespace. Single-threaded — one request at a time is
// the link's design; the P4 correlates by sequence id.
#include "node_server.h"

#include <string.h>

#include "board_xiao_s3.h"
#include "camera.h"
#include "cJSON.h"
#include "driver/temperature_sensor.h"
#include "driver/uart.h"
#include "esp_chip_info.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "kdp/crc32.h"
#include "kdp/decoder.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"
#include "node_link/node_link.h"

static const char *TAG = "node_server";

#define LINK_RX_BUF 4096
#define LINK_TX_BUF 0 /* blocking writes */

static char s_session_id[16];
static const char *s_state = NL_STATE_BOOTING;

// The held frame: one capture lives in PSRAM until the P4 releases it or
// requests the next capture.
static camera_fb_t *s_fb;
static uint32_t s_frame_id;

static uint8_t s_decode_buf[KDP_MAX_FRAME];
static kdp_decoder_t s_decoder;

// Reply frames: header + chunk + CRC is the largest we ever send.
static uint8_t s_tx_buf[KDP_HEADER_LEN + NL_CHUNK_MAX + KDP_CRC_LEN];

void node_server_set_state(const char *state) { s_state = state; }

static const char *reset_reason_str(void) {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int-wdt";
    case ESP_RST_TASK_WDT: return "task-wdt";
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_DEEPSLEEP: return "deep-sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    case ESP_RST_USB: return "usb";
    case ESP_RST_JTAG: return "jtag";
    default: return "unknown";
  }
}

static uint32_t heap_kb(void) { return (uint32_t)(esp_get_free_heap_size() / 1024); }
static uint32_t psram_kb(void) {
  return (uint32_t)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024);
}

static temperature_sensor_handle_t s_tsens;

/** Adds "tempC" as a real reading or null — never a fabricated number. */
static void add_temp(cJSON *json) {
  float celsius = 0;
  if (s_tsens != NULL && temperature_sensor_get_celsius(s_tsens, &celsius) == ESP_OK) {
    cJSON_AddNumberToObject(json, "tempC", (double)((int)(celsius + 0.5f)));
  } else {
    cJSON_AddNullToObject(json, "tempC");
  }
}

static void send_frame(uint8_t type, uint8_t flags, uint32_t seq, const uint8_t *payload,
                       uint32_t len) {
  size_t total = kdp_encode_frame(s_tx_buf, sizeof s_tx_buf, NL_PROTOCOL_VERSION, type,
                                  flags, seq, payload, len);
  if (total == 0) {
    ESP_LOGE(TAG, "encode failed (len %lu)", (unsigned long)len);
    return;
  }
  uart_write_bytes(BOARD_LINK_UART_NUM, s_tx_buf, total);
}

static void send_json(uint8_t type, uint32_t seq, cJSON *json) {
  char *text = cJSON_PrintUnformatted(json);
  cJSON_Delete(json);
  if (text == NULL) return;
  send_frame(type, KDP_FLAG_RESPONSE, seq, (const uint8_t *)text, strlen(text));
  cJSON_free(text);
}

static void send_nack(uint8_t type, uint32_t seq, const char *code, const char *message) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "code", code);
  cJSON_AddStringToObject(json, "message", message);
  char *text = cJSON_PrintUnformatted(json);
  cJSON_Delete(json);
  if (text == NULL) return;
  send_frame(type, KDP_FLAG_RESPONSE | KDP_FLAG_ERROR, seq, (const uint8_t *)text,
             strlen(text));
  cJSON_free(text);
}

static void handle_hello(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "product", "KINO-CAMNODE");
  cJSON_AddNumberToObject(json, "protocol", NL_PROTOCOL_VERSION);
  cJSON_AddStringToObject(json, "firmware", KINO_FW_VERSION);
  cJSON_AddStringToObject(json, "sessionId", s_session_id);
  cJSON_AddStringToObject(json, "resetReason", reset_reason_str());
  esp_chip_info_t chip;
  esp_chip_info(&chip);
  cJSON_AddNumberToObject(json, "chipRevision", chip.revision);
  cJSON_AddNumberToObject(json, "heapKB", heap_kb());
  cJSON_AddNumberToObject(json, "psramKB", psram_kb());
  cJSON_AddNumberToObject(json, "baud", NL_DEFAULT_BAUD);
  if (camsensor_detected()) {
    char pid[8];
    snprintf(pid, sizeof pid, "0x%04x", camsensor_pid());
    cJSON_AddStringToObject(json, "sensor", camsensor_name());
    cJSON_AddStringToObject(json, "sensorPid", pid);
  } else {
    cJSON_AddNullToObject(json, "sensor");
    cJSON_AddNullToObject(json, "sensorPid");
  }
  cJSON_AddBoolToObject(json, "sensorDetected", camsensor_detected());
  // Sensor-model AF support only; whether the module's VCM is powered
  // (AFVDD) is a bench fact this node cannot know.
  cJSON_AddBoolToObject(json, "autofocus", camsensor_autofocus_capable());
  if (camsensor_max_resolution() != NULL) {
    cJSON_AddStringToObject(json, "maxResolution", camsensor_max_resolution());
  } else {
    cJSON_AddNullToObject(json, "maxResolution");
  }
  send_json(NL_CMD_HELLO, seq, json);
}

static void handle_status(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "state", s_state);
  if (s_fb != NULL) {
    cJSON_AddNumberToObject(json, "frameId", s_frame_id);
    cJSON_AddNumberToObject(json, "frameSize", (double)s_fb->len);
  } else {
    cJSON_AddNullToObject(json, "frameId");
  }
  cJSON_AddNumberToObject(json, "heapKB", heap_kb());
  cJSON_AddNumberToObject(json, "psramKB", psram_kb());
  add_temp(json);
  cJSON_AddNumberToObject(json, "crcFailures", s_decoder.stats.crc_failures);
  cJSON_AddNumberToObject(json, "resyncs", s_decoder.stats.resyncs);
  send_json(NL_CMD_STATUS, seq, json);
}

static void handle_capture(uint32_t seq, cJSON *req) {
  if (!camsensor_detected()) {
    send_nack(NL_CMD_CAPTURE, seq, "HARDWARE_ERROR", "No sensor detected");
    return;
  }
  const cJSON *res = cJSON_GetObjectItem(req, "resolution");
  if (cJSON_IsString(res) && camsensor_set_resolution(res->valuestring) != ESP_OK) {
    send_nack(NL_CMD_CAPTURE, seq, "INVALID_ARGUMENT", "Unsupported resolution");
    return;
  }
  const cJSON *quality = cJSON_GetObjectItem(req, "quality");
  if (cJSON_IsNumber(quality) && camsensor_set_quality(quality->valueint) != ESP_OK) {
    send_nack(NL_CMD_CAPTURE, seq, "INVALID_ARGUMENT", "Quality not accepted");
    return;
  }

  // A new capture implicitly releases the previous held frame.
  if (s_fb != NULL) {
    camsensor_release(s_fb);
    s_fb = NULL;
  }

  s_state = NL_STATE_EXPOSING;
  uint32_t duration_ms = 0;
  camsensor_timing_t timing;
  const int64_t cmd_us = esp_timer_get_time();
  camera_fb_t *fb = camsensor_capture(&duration_ms, &timing);
  if (fb == NULL) {
    s_state = NL_STATE_ERROR;
    send_nack(NL_CMD_CAPTURE, seq, "HARDWARE_ERROR", "Capture failed");
    return;
  }
  s_fb = fb;
  s_frame_id++;
  s_state = NL_STATE_JPEG_READY;

  // JPEG integrity: the node's checksum is the reference the P4 verifies
  // the transfer and the stored file against.
  char crc_hex[12];
  snprintf(crc_hex, sizeof crc_hex, "%08lx", (unsigned long)kdp_crc32(fb->buf, fb->len));

  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddNumberToObject(json, "frameId", s_frame_id);
  cJSON_AddNumberToObject(json, "size", (double)fb->len);
  cJSON_AddNumberToObject(json, "durationMs", duration_ms);
  /* Stale-frame diagnostics. All microseconds in THIS node's esp_timer domain,
   * which shares no epoch with the P4 or with any other node - only
   * differences within one node are meaningful. See camsensor_timing_t.
   *
   * `frameStartUs` is the driver's DMA-arm timestamp for the returned frame.
   * It is NOT exposure time and must never be reported as one. */
  cJSON_AddNumberToObject(json, "cmdUs", (double)cmd_us);
  cJSON_AddNumberToObject(json, "fbGetStartUs", (double)timing.fb_get_start_us);
  cJSON_AddNumberToObject(json, "fbGetEndUs", (double)timing.fb_get_end_us);
  cJSON_AddNumberToObject(json, "fbGetUs", (double)timing.fb_get_us);
  cJSON_AddNumberToObject(json, "frameStartUs", (double)timing.frame_start_us);
  /* frame_start - cmd: negative means the frame's DMA began BEFORE this
   * command arrived, which is the stale-frame signature stated directly
   * rather than left for a reader to subtract. */
  cJSON_AddNumberToObject(json, "frameAgeUs", (double)(cmd_us - timing.frame_start_us));
  cJSON_AddStringToObject(json, "crc32", crc_hex);
  cJSON_AddNumberToObject(json, "heapKB", heap_kb());
  cJSON_AddNumberToObject(json, "psramKB", psram_kb());
  send_json(NL_CMD_CAPTURE, seq, json);
}

static void handle_read(uint32_t seq, cJSON *req) {
  const cJSON *frame_id = cJSON_GetObjectItem(req, "frameId");
  const cJSON *offset = cJSON_GetObjectItem(req, "offset");
  const cJSON *length = cJSON_GetObjectItem(req, "length");
  if (!cJSON_IsNumber(frame_id) || !cJSON_IsNumber(offset) || !cJSON_IsNumber(length)) {
    send_nack(NL_CMD_READ, seq, "INVALID_ARGUMENT", "frameId, offset, length required");
    return;
  }
  if (s_fb == NULL || (uint32_t)frame_id->valuedouble != s_frame_id) {
    send_nack(NL_CMD_READ, seq, "BAD_ID", "No such frame held");
    return;
  }
  size_t off = (size_t)offset->valuedouble;
  size_t len = (size_t)length->valuedouble;
  if (len > NL_CHUNK_MAX) len = NL_CHUNK_MAX;
  if (off >= s_fb->len) len = 0; /* past EOF reads return short, not an error */
  else if (off + len > s_fb->len) len = s_fb->len - off;

  s_state = NL_STATE_TRANSFERRING;
  send_frame(NL_CMD_READ, KDP_FLAG_RESPONSE | KDP_FLAG_BINARY, seq, s_fb->buf + off,
             (uint32_t)len);
}

static void handle_release(uint32_t seq) {
  if (s_fb != NULL) {
    camsensor_release(s_fb);
    s_fb = NULL;
  }
  s_state = camsensor_detected() ? NL_STATE_READY : NL_STATE_ERROR;
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  send_json(NL_CMD_RELEASE, seq, json);
}

static void on_frame(const kdp_frame_t *frame, void *ctx) {
  (void)ctx;
  if (frame->version != NL_PROTOCOL_VERSION) {
    send_nack(frame->type, frame->seq, "BAD_VERSION", "Unsupported link version");
    return;
  }

  cJSON *req = NULL;
  if (frame->payload_len > 0 && (frame->flags & KDP_FLAG_BINARY) == 0) {
    req = cJSON_ParseWithLength((const char *)frame->payload, frame->payload_len);
  }

  switch (frame->type) {
    case NL_CMD_HELLO: handle_hello(frame->seq); break;
    case NL_CMD_STATUS: handle_status(frame->seq); break;
    case NL_CMD_CAPTURE: handle_capture(frame->seq, req); break;
    case NL_CMD_READ: handle_read(frame->seq, req); break;
    case NL_CMD_RELEASE: handle_release(frame->seq); break;
    case NL_CMD_REBOOT: {
      cJSON *json = cJSON_CreateObject();
      cJSON_AddBoolToObject(json, "ok", true);
      send_json(NL_CMD_REBOOT, frame->seq, json);
      uart_wait_tx_done(BOARD_LINK_UART_NUM, pdMS_TO_TICKS(500));
      esp_restart();
      break;
    }
    default:
      send_nack(frame->type, frame->seq, "UNSUPPORTED_COMMAND", "Unknown node command");
      break;
  }

  cJSON_Delete(req);
}

static void server_task(void *arg) {
  (void)arg;
  uint8_t rx[512];
  for (;;) {
    /*
     * Take what has arrived rather than waiting for a full buffer.
     *
     * uart_read_bytes blocks until `length` bytes are read or the timeout
     * expires, and a request is about 60 bytes against the 512 asked for
     * here, so every single request used to cost this task the whole 100 ms
     * before it was even seen. Three exchanges per preview frame made that
     * 300 ms of sleep per frame on the node alone.
     */
    /*
     * Block in the UART driver for ONE byte, then take the rest with no wait.
     *
     * The obvious "poll what is buffered, sleep 1 ms otherwise" is a busy-wait
     * on this build: CONFIG_FREERTOS_HZ is 100, so a tick is 10 ms and
     * pdMS_TO_TICKS(1) rounds to ZERO ticks. vTaskDelay(0) does not block, so
     * the loop span at task priority for the whole timeout. Three unfitted
     * cameras spinning out a 900 ms viewfinder timeout starved IDLE0 into a
     * task watchdog and starved the UI task that feeds the panel - felt on the
     * bench as stutter and a flat blue flash on the one camera that IS there.
     *
     * Asking for 1 byte returns the instant a byte lands, so this keeps the
     * zero-latency behaviour the poll was written for, and an idle channel
     * genuinely sleeps instead of burning the core.
     */
    int n = uart_read_bytes(BOARD_LINK_UART_NUM, rx, 1, pdMS_TO_TICKS(10));
    if (n > 0) {
      size_t avail = 0;
      uart_get_buffered_data_len(BOARD_LINK_UART_NUM, &avail);
      if (avail > sizeof rx - 1) avail = sizeof rx - 1;
      if (avail > 0) {
        const int more = uart_read_bytes(BOARD_LINK_UART_NUM, rx + 1, avail, 0);
        if (more > 0) n += more;
      }
      kdp_decoder_push(&s_decoder, rx, (size_t)n, on_frame, NULL);
    }
  }
}

esp_err_t node_server_start(const char *session_id) {
  strncpy(s_session_id, session_id, sizeof s_session_id - 1);

  const uart_config_t config = {
      .baud_rate = NL_DEFAULT_BAUD,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .source_clk = UART_SCLK_DEFAULT,
  };
  ESP_ERROR_CHECK(uart_driver_install(BOARD_LINK_UART_NUM, LINK_RX_BUF, LINK_TX_BUF, 0,
                                      NULL, 0));
  ESP_ERROR_CHECK(uart_param_config(BOARD_LINK_UART_NUM, &config));
  ESP_ERROR_CHECK(uart_set_pin(BOARD_LINK_UART_NUM, BOARD_LINK_TX, BOARD_LINK_RX,
                               UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

  temperature_sensor_config_t tsens_config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
  if (temperature_sensor_install(&tsens_config, &s_tsens) == ESP_OK) {
    if (temperature_sensor_enable(s_tsens) != ESP_OK) s_tsens = NULL;
  } else {
    s_tsens = NULL; /* STATUS then reports tempC null, never a guess */
  }

  kdp_decoder_init(&s_decoder, s_decode_buf, sizeof s_decode_buf);
  s_state = camsensor_detected() ? NL_STATE_READY : NL_STATE_ERROR;

  BaseType_t ok = xTaskCreate(server_task, "node_server", 6144, NULL, 10, NULL);
  return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
