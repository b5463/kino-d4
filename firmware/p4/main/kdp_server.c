// Studio-facing KDP server, Milestone 1B surface. Contract rules honored
// here: never silently time out (every request gets a response or a NACK);
// capability flags and the dispatcher agree; REBOOT answers before
// restarting; HELLO tolerates a payload carrying only {nonce}; job events
// carry sequence 0 and are batched (~10%), never per unit of work.
#include "kdp_server.h"

#include <stdarg.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "cam_link.h"
#include "cJSON.h"
#include "driver/temperature_sensor.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "kdp/crc32.h"
#include "kdp/decoder.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"
#include "klog.h"
#include "node_link/node_link.h"
#include "storage.h"
#include "usb_link.h"

static const char *TAG = "kdp_server";

static kdp_identity_t s_id;
static kdp_decoder_t s_decoder;
static uint8_t s_decode_buf[KDP_MAX_FRAME];
static uint8_t s_tx[KDP_MAX_FRAME];
static SemaphoreHandle_t s_tx_lock;
static bool s_usb_seen; /* first decoded host frame marks USB validated */

// One capture pipeline at a time: CAMERA_TEST, STORAGE_SELF_TEST and the
// soak job all contend for the camera UART, the PSRAM staging buffer and
// the SD write path. Held for a whole soak run — concurrent starts get BUSY.
static SemaphoreHandle_t s_capture_lock;

static uint32_t s_job_counter;
static volatile bool s_soak_running;
static volatile bool s_selftest_running;
static temperature_sensor_handle_t s_tsens;

// ---- small helpers ----

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

static void iso8601_utc(char *out, size_t cap) {
  time_t now = time(NULL);
  struct tm tm_utc;
  gmtime_r(&now, &tm_utc);
  strftime(out, cap, "%Y-%m-%dT%H:%M:%S+00:00", &tm_utc);
}

static void uuid4(char *out, size_t cap) {
  uint8_t b[16];
  esp_fill_random(b, sizeof b);
  b[6] = (b[6] & 0x0F) | 0x40;
  b[8] = (b[8] & 0x3F) | 0x80;
  snprintf(out, cap,
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11],
           b[12], b[13], b[14], b[15]);
}

static uint32_t elapsed_ms(int64_t since_us) {
  return (uint32_t)((esp_timer_get_time() - since_us) / 1000);
}

// ---- send helpers ----

static void send_raw(uint8_t type, uint8_t flags, uint32_t seq, const uint8_t *payload,
                     uint32_t len) {
  xSemaphoreTake(s_tx_lock, portMAX_DELAY);
  size_t total = kdp_encode_frame(s_tx, sizeof s_tx, KDP_PROTOCOL_VERSION, type, flags,
                                  seq, payload, len);
  if (total > 0) usb_link_write(s_tx, total);
  xSemaphoreGive(s_tx_lock);
}

static void send_nack(uint8_t type, uint32_t seq, const char *code, const char *message);

static void send_json(uint8_t type, uint32_t seq, cJSON *json) {
  char *text = cJSON_PrintUnformatted(json);
  cJSON_Delete(json);
  if (text == NULL) return;
  /* An oversized reply would be dropped by kdp_encode_frame — the client
   * would see only a timeout. A NACK is the honest failure (issue #80). */
  if (strlen(text) > KDP_MAX_PAYLOAD) {
    cJSON_free(text);
    send_nack(type, seq, "INTERNAL_ERROR", "Reply exceeds the frame payload cap");
    return;
  }
  send_raw(type, KDP_FLAG_RESPONSE, seq, (const uint8_t *)text, strlen(text));
  cJSON_free(text);
}

static void send_event(uint8_t evt, cJSON *json) {
  char *text = cJSON_PrintUnformatted(json);
  cJSON_Delete(json);
  if (text == NULL) return;
  /* Events carry no meaningful sequence — the reference device writes 0. */
  send_raw(evt, KDP_FLAG_EVENT, 0, (const uint8_t *)text, strlen(text));
  cJSON_free(text);
}

static void send_nack(uint8_t type, uint32_t seq, const char *code, const char *message) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "code", code);
  cJSON_AddStringToObject(json, "message", message);
  char *text = cJSON_PrintUnformatted(json);
  cJSON_Delete(json);
  if (text == NULL) return;
  send_raw(type, KDP_FLAG_RESPONSE | KDP_FLAG_ERROR, seq, (const uint8_t *)text,
           strlen(text));
  cJSON_free(text);
}

// ---- capture core ----
// The measured single-camera path: ping -> node capture -> chunked transfer
// into PSRAM (verified against the node's CRC) -> SD write -> stored-file
// read-back CRC. Timing buckets are wall-clock on the P4 side; none of them
// is exposure timing and none may ever be reported as skew.

typedef struct {
  bool ok;
  const char *err_code; /* one of the §14 codes when !ok */
  char err_msg[96];
  char capture_uuid[40];
  char capture_id[16];
  char dir[64];
  uint32_t jpeg_bytes;
  uint32_t t_request_to_node_ms;
  uint32_t t_capture_ms;
  uint32_t t_transfer_ms;
  uint32_t t_sd_ms;
  uint32_t t_total_ms;
  char crc_node[12];
  char crc_transfer[12];
  char crc_stored[12];
  bool crc_match;
  uint32_t p4_heap_before, p4_heap_after;
  uint32_t p4_psram_before, p4_psram_after;
  int32_t node_heap_kb, node_psram_kb;
} capture_result_t;

static const char *CAPTURE_RESOLUTION = "1600x1200";

static char *build_meta_json(const capture_result_t *r, const char *node_fw) {
  // kino.capture v1. Diagnostic figures ride as passthrough fields; the
  // reserved `timing` skew block stays absent — no telemetry exists yet and
  // faking keys is worse than absence (contract D6).
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "schema", "kino.capture");
  cJSON_AddNumberToObject(json, "version", 1);
  cJSON_AddStringToObject(json, "id", r->capture_id);
  cJSON_AddStringToObject(json, "captureUuid", r->capture_uuid);
  cJSON_AddStringToObject(json, "deviceId", s_id.device_id);
  cJSON_AddStringToObject(json, "mode", "single");
  char stamp[40];
  iso8601_utc(stamp, sizeof stamp);
  cJSON_AddStringToObject(json, "capturedAt", stamp);
  cJSON_AddBoolToObject(json, "clockUnset", true);
  cJSON_AddNumberToObject(json, "frameCount", 1);
  cJSON_AddStringToObject(json, "resolution", CAPTURE_RESOLUTION);
  cJSON_AddStringToObject(json, "status", "ready");
  cJSON_AddBoolToObject(json, "visible", true);

  cJSON_AddNumberToObject(json, "cameraCount", 1);
  cJSON_AddNumberToObject(json, "cameraIndex", 1);
  cJSON_AddNumberToObject(json, "jpegBytes", r->jpeg_bytes);
  cJSON_AddStringToObject(json, "p4Firmware", KINO_FW_VERSION);
  cJSON_AddStringToObject(json, "nodeFirmware", node_fw);

  cJSON *bench = cJSON_AddObjectToObject(json, "benchTiming");
  cJSON_AddNumberToObject(bench, "requestToNodeMs", r->t_request_to_node_ms);
  cJSON_AddNumberToObject(bench, "captureCommandToJpegReadyMs", r->t_capture_ms);
  cJSON_AddNumberToObject(bench, "jpegTransferMs", r->t_transfer_ms);
  cJSON_AddNumberToObject(bench, "sdWriteMs", r->t_sd_ms);

  cJSON *sums = cJSON_AddObjectToObject(json, "checksums");
  cJSON_AddStringToObject(sums, "nodeJpegCrc32", r->crc_node);
  cJSON_AddStringToObject(sums, "transferCrc32", r->crc_transfer);
  cJSON_AddStringToObject(sums, "storedFileCrc32", r->crc_stored);

  char *text = cJSON_PrintUnformatted(json);
  cJSON_Delete(json);
  return text;
}

static void fail(capture_result_t *r, const char *code, const char *msg) {
  r->ok = false;
  r->err_code = code;
  strncpy(r->err_msg, msg, sizeof r->err_msg - 1);
  r->err_msg[sizeof r->err_msg - 1] = '\0';
}

/**
 * fail() with the numbers in it. A bench failure that reports only what went
 * wrong costs another run to find out how far it got; these carry the
 * measurement with them so the first run is also the diagnostic one. The
 * code stays a fixed contract string — only the human message varies.
 */
static void failf(capture_result_t *r, const char *code, const char *fmt, ...) {
  r->ok = false;
  r->err_code = code;
  va_list args;
  va_start(args, fmt);
  vsnprintf(r->err_msg, sizeof r->err_msg, fmt, args);
  va_end(args);
}

/* Caller must hold s_capture_lock. */
static void run_capture(int jpeg_quality, bool keep_files, capture_result_t *r) {
  memset(r, 0, sizeof *r);
  r->node_heap_kb = -1;
  r->node_psram_kb = -1;
  r->p4_heap_before = heap_kb();
  r->p4_psram_before = psram_kb();
  int64_t t0 = esp_timer_get_time();

  camlink_info_t info;
  camlink_get_info(&info);
  if (!info.online) {
    fail(r, "CAMERA_OFFLINE", "Camera node not connected");
    return;
  }
  if (!info.sensor_detected) {
    fail(r, "SENSOR_NOT_DETECTED", "Node answers but reports no sensor");
    return;
  }
  if (!storage_present()) {
    fail(r, "SD_NOT_MOUNTED", "No durable storage path");
    return;
  }

  // Link health probe — the request-to-node bucket.
  uint32_t rtt = 0;
  if (camlink_ping(&rtt) != ESP_OK) {
    camlink_stats_t s;
    camlink_get_stats(&s);
    failf(r, "NODE_BOOT_TIMEOUT", "Node stopped answering: %lu timeouts, %lu crc, last %s",
          (unsigned long)s.timeouts, (unsigned long)s.crc_errors,
          s.last_error[0] != '\0' ? s.last_error : "-");
    return;
  }
  r->t_request_to_node_ms = rtt;

  // Node capture.
  int64_t t_cap = esp_timer_get_time();
  camlink_capture_result_t cap;
  esp_err_t err = camlink_capture(CAPTURE_RESOLUTION, jpeg_quality, &cap);
  if (err == ESP_ERR_TIMEOUT) {
    failf(r, "TRANSFER_TIMEOUT", "Capture command timed out after %lu ms",
          (unsigned long)elapsed_ms(t_cap));
    return;
  }
  if (err != ESP_OK) {
    fail(r, "CAPTURE_FAILED", "Node rejected or failed the capture");
    return;
  }
  r->t_capture_ms = elapsed_ms(t_cap);
  r->jpeg_bytes = cap.size;
  strncpy(r->crc_node, cap.crc32, sizeof r->crc_node - 1);
  r->node_heap_kb = cap.heap_kb;
  r->node_psram_kb = cap.psram_kb;
  if (cap.size < 4) {
    camlink_release(cap.frame_id);
    failf(r, "JPEG_INVALID", "Node reported an implausible JPEG size: %lu B",
          (unsigned long)cap.size);
    return;
  }

  // Transfer into PSRAM, CRC on the fly.
  uint8_t *jpeg = heap_caps_malloc(cap.size, MALLOC_CAP_SPIRAM);
  if (jpeg == NULL) jpeg = malloc(cap.size);
  if (jpeg == NULL) {
    camlink_release(cap.frame_id);
    /* How short we were is the whole point: a 40 KB miss is a tuning
     * problem and a 400 KB miss is a design one. */
    failf(r, "OUT_OF_MEMORY", "JPEG staging wants %lu B, free %lu KB psram / %lu KB heap",
          (unsigned long)cap.size, (unsigned long)psram_kb(), (unsigned long)heap_kb());
    return;
  }

  int64_t t_xfer = esp_timer_get_time();
  uint32_t crc_state = kdp_crc32_begin();
  uint32_t offset = 0;
  while (offset < cap.size) {
    size_t want = cap.size - offset;
    if (want > NL_CHUNK_MAX) want = NL_CHUNK_MAX;
    size_t got = 0;
    esp_err_t rerr = camlink_read(cap.frame_id, offset, jpeg + offset, want, &got);
    if (rerr != ESP_OK || got == 0) {
      /* Where it died is the measurement. Failing at the first chunk is a
       * link fault; failing at 80% is a throughput or timeout budget the
       * bench can retune. */
      failf(r, "TRANSFER_TIMEOUT", "Chunk read failed at %lu/%lu B (%lu%%) after %lu ms",
            (unsigned long)offset, (unsigned long)cap.size,
            (unsigned long)(cap.size == 0 ? 0 : (uint64_t)offset * 100 / cap.size),
            (unsigned long)elapsed_ms(t_xfer));
      free(jpeg);
      camlink_release(cap.frame_id);
      return;
    }
    crc_state = kdp_crc32_update(crc_state, jpeg + offset, got);
    offset += got;
  }
  r->t_transfer_ms = elapsed_ms(t_xfer);
  camlink_release(cap.frame_id);

  snprintf(r->crc_transfer, sizeof r->crc_transfer, "%08lx",
           (unsigned long)kdp_crc32_final(crc_state));
  if (r->crc_node[0] != '\0' && strcmp(r->crc_node, r->crc_transfer) != 0) {
    free(jpeg);
    failf(r, "TRANSFER_CRC_MISMATCH", "Checksums disagree over %lu B: node %s, transfer %s",
          (unsigned long)cap.size, r->crc_node, r->crc_transfer);
    return;
  }
  // JPEG sanity: SOI marker.
  if (jpeg[0] != 0xFF || jpeg[1] != 0xD8) {
    free(jpeg);
    fail(r, "JPEG_INVALID", "Payload does not start with a JPEG SOI marker");
    return;
  }
  hwv_mark_validated(HWV_CAM1_CAPTURE, "checksummed capture");
  hwv_mark_validated(HWV_CAM1_JPEG_TRANSFER, "transfer CRC matched node CRC");

  // SD write.
  uuid4(r->capture_uuid, sizeof r->capture_uuid);
  int64_t t_sd = esp_timer_get_time();
  storage_capture_t capture;
  if (storage_capture_begin(&capture, r->capture_uuid) != ESP_OK) {
    free(jpeg);
    fail(r, "SD_WRITE_FAILED", "Could not open the capture folder");
    return;
  }
  strncpy(r->capture_id, capture.id, sizeof r->capture_id - 1);
  strncpy(r->dir, capture.dir, sizeof r->dir - 1);
  if (storage_capture_append(&capture, jpeg, cap.size) != ESP_OK) {
    storage_capture_abort(&capture);
    free(jpeg);
    fail(r, "SD_WRITE_FAILED", "JPEG write failed");
    return;
  }
  free(jpeg);

  camlink_info_t node;
  camlink_get_info(&node);
  char *meta = build_meta_json(r, node.firmware);
  esp_err_t committed = meta != NULL ? storage_capture_commit(&capture, meta) : ESP_FAIL;
  if (meta != NULL) cJSON_free(meta);
  if (committed != ESP_OK) {
    storage_capture_abort(&capture);
    fail(r, "SD_WRITE_FAILED", "Commit failed");
    return;
  }
  r->t_sd_ms = elapsed_ms(t_sd);

  // Stored-file read-back — the third checksum.
  char path[80];
  snprintf(path, sizeof path, "%s/C1.JPG", capture.dir);
  uint32_t stored_crc = 0, stored_bytes = 0;
  if (storage_file_crc32(path, &stored_crc, &stored_bytes) != ESP_OK) {
    fail(r, "SD_VERIFY_FAILED", "Stored file could not be read back");
    return;
  }
  snprintf(r->crc_stored, sizeof r->crc_stored, "%08lx", (unsigned long)stored_crc);
  if (stored_bytes != cap.size || strcmp(r->crc_stored, r->crc_transfer) != 0) {
    fail(r, "SD_VERIFY_FAILED", "Stored file checksum disagrees with transfer");
    return;
  }
  hwv_mark_validated(HWV_CAM1_SD_WRITE, "stored file checksum verified");

  r->crc_match = true;
  r->ok = true;
  r->t_total_ms = elapsed_ms(t0);
  r->p4_heap_after = heap_kb();
  r->p4_psram_after = psram_kb();

  klog("C1", "capture %s ok — %lu KB in %lu ms, crc %s verified", r->capture_id,
       (unsigned long)(r->jpeg_bytes / 1024), (unsigned long)r->t_total_ms,
       r->crc_transfer);

  if (!keep_files) {
    storage_capture_delete(r->dir);
    r->dir[0] = '\0';
  }
}

// ---- handlers ----

static void handle_hello(uint32_t seq, cJSON *req) {
  int proto_min = KDP_PROTOCOL_VERSION;
  int proto_max = KDP_PROTOCOL_VERSION;
  const cJSON *min = cJSON_GetObjectItem(req, "protocolMin");
  const cJSON *max = cJSON_GetObjectItem(req, "protocolMax");
  if (cJSON_IsNumber(min)) proto_min = min->valueint;
  if (cJSON_IsNumber(max)) proto_max = max->valueint;
  if (KDP_PROTOCOL_VERSION < proto_min || KDP_PROTOCOL_VERSION > proto_max) {
    send_nack(KDP_CMD_HELLO, seq, "BAD_VERSION", "No common protocol version");
    return;
  }

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "product", "KINO");
  cJSON_AddNumberToObject(json, "protocol", KDP_PROTOCOL_VERSION);
  const cJSON *nonce = cJSON_GetObjectItem(req, "nonce");
  if (cJSON_IsNumber(nonce)) cJSON_AddNumberToObject(json, "nonce", nonce->valuedouble);
  cJSON_AddStringToObject(json, "deviceId", s_id.device_id);
  cJSON_AddStringToObject(json, "sessionId", s_id.session_id);
  send_json(KDP_CMD_HELLO, seq, json);
}

static void handle_capabilities(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "protocol", KDP_PROTOCOL_VERSION);
  cJSON_AddStringToObject(json, "hardware", "kino-v1");
  cJSON_AddStringToObject(json, "firmware", KINO_FW_VERSION);

  // Every flag false until the feature exists; benchDiagnostics is the one
  // Milestone 1B surface this build actually implements.
  cJSON *caps = cJSON_AddObjectToObject(json, "capabilities");
  cJSON_AddNumberToObject(caps, "cameraCount", 4);
  const char *flags[] = {"wiggle", "quad",           "gallery",     "flashControl",
                         "vsyncTelemetry", "phaseCalibration", "xiaoProxyUpdate",
                         "linkBench",      "customSounds"};
  for (size_t i = 0; i < sizeof flags / sizeof flags[0]; i++) {
    cJSON_AddBoolToObject(caps, flags[i], false);
  }
  cJSON_AddBoolToObject(caps, "benchDiagnostics", true);

  cJSON *limits = cJSON_AddObjectToObject(json, "limits");
  cJSON_AddNumberToObject(limits, "maxUartBaud", NL_DEFAULT_BAUD);
  cJSON_AddNumberToObject(limits, "currentUartBaud", NL_DEFAULT_BAUD);
  cJSON_AddStringToObject(limits, "maxResolution", "2048x1536");
  cJSON_AddNumberToObject(limits, "maxGalleryPageSize", 100);

  cJSON_AddNumberToObject(json, "configSchemaVersion", 1);
  send_json(KDP_CMD_GET_CAPABILITIES, seq, json);
}

static void handle_device_info(uint32_t seq) {
  camlink_info_t cam1;
  camlink_get_info(&cam1);
  storage_status_t sd;
  storage_get_status(&sd);

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "product", "KINO");
  cJSON_AddStringToObject(json, "hardware", "V1");
  cJSON_AddStringToObject(json, "serial", s_id.serial);
  cJSON_AddNumberToObject(json, "protocol", KDP_PROTOCOL_VERSION);
  cJSON_AddStringToObject(json, "p4Firmware", KINO_FW_VERSION);

  cJSON *fw = cJSON_AddArrayToObject(json, "cameraFirmware");
  cJSON *sensors = cJSON_AddArrayToObject(json, "sensors");
  for (int i = 0; i < 4; i++) {
    bool is_cam1 = i == 0 && cam1.online;
    cJSON_AddItemToArray(fw, cJSON_CreateString(is_cam1 ? cam1.firmware : ""));
    cJSON_AddItemToArray(sensors, cJSON_CreateString(is_cam1 ? cam1.sensor : ""));
  }

  cJSON_AddBoolToObject(json, "sdPresent", sd.present);
  cJSON_AddNumberToObject(json, "sdFreeMB", (double)(sd.free_bytes / (1024 * 1024)));
  cJSON_AddStringToObject(json, "activeMode", "wiggle");
  cJSON_AddStringToObject(json, "activeRecipe", "");
  send_json(KDP_CMD_GET_DEVICE_INFO, seq, json);
}

static void handle_storage_status(uint32_t seq) {
  storage_status_t sd;
  storage_get_status(&sd);
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "present", sd.present);
  cJSON_AddNumberToObject(json, "totalMB", (double)(sd.capacity_bytes / (1024 * 1024)));
  cJSON_AddNumberToObject(json, "freeMB", (double)(sd.free_bytes / (1024 * 1024)));
  cJSON_AddBoolToObject(json, "mounted", sd.mounted);
  if (sd.filesystem != NULL) cJSON_AddStringToObject(json, "filesystem", sd.filesystem);
  else cJSON_AddNullToObject(json, "filesystem");
  cJSON_AddNumberToObject(json, "capacityBytes", (double)sd.capacity_bytes);
  cJSON_AddNumberToObject(json, "freeBytes", (double)sd.free_bytes);
  if (sd.last_error != NULL) cJSON_AddStringToObject(json, "lastError", sd.last_error);
  else cJSON_AddNullToObject(json, "lastError");
  cJSON_AddNumberToObject(json, "mountAttempts", sd.mount_attempts);
  cJSON_AddStringToObject(json, "writeTestStatus", sd.write_test);
  send_json(KDP_CMD_GET_STORAGE_STATUS, seq, json);
}

static void handle_storage_self_test(uint32_t seq) {
  if (xSemaphoreTake(s_capture_lock, 0) != pdTRUE) {
    send_nack(KDP_CMD_STORAGE_SELF_TEST, seq, "BUSY", "A capture or soak run is active");
    return;
  }
  storage_selftest_result_t result;
  storage_self_test(&result);
  xSemaphoreGive(s_capture_lock);

  if (result.ok) {
    storage_status_t sd;
    storage_get_status(&sd);
    char detail[40];
    snprintf(detail, sizeof detail, "self-test pass, %lu KB verified",
             (unsigned long)(result.bytes_tested / 1024));
    (void)sd;
    hwv_mark_validated(HWV_SD_LDO_CH4, detail);
  }

  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", result.ok);
  if (result.ok) cJSON_AddNullToObject(json, "failedPhase");
  else cJSON_AddStringToObject(json, "failedPhase",
                               storage_selftest_phase_str(result.failed_phase));
  cJSON_AddNumberToObject(json, "durationMs", result.duration_ms);
  cJSON_AddNumberToObject(json, "bytesTested", result.bytes_tested);
  send_json(KDP_CMD_STORAGE_SELF_TEST, seq, json);
}

static const char *kdp_camera_state(const camlink_info_t *info) {
  if (!info->online) return "offline";
  if (strcmp(info->state, NL_STATE_ERROR) == 0) return "error";
  if (strcmp(info->state, NL_STATE_EXPOSING) == 0) return "capturing";
  if (strcmp(info->state, NL_STATE_JPEG_READY) == 0 ||
      strcmp(info->state, NL_STATE_TRANSFERRING) == 0) {
    return "busy";
  }
  return "ready";
}

static cJSON *build_camera_info(int index) {
  static const char *ids[] = {"cam1", "cam2", "cam3", "cam4"};
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "id", ids[index]);

  if (index == 0) {
    camlink_info_t info;
    camlink_get_info(&info);
    camlink_stats_t stats;
    camlink_get_stats(&stats);
    cJSON_AddBoolToObject(json, "online", info.online);
    if (info.online && info.sensor_detected) {
      cJSON_AddStringToObject(json, "sensor", info.sensor);
    } else {
      cJSON_AddNullToObject(json, "sensor");
    }
    cJSON_AddBoolToObject(json, "sensorDetected", info.online && info.sensor_detected);
    cJSON_AddStringToObject(json, "firmware", info.firmware);
    cJSON_AddStringToObject(json, "state", kdp_camera_state(&info));
    cJSON_AddNumberToObject(json, "latencyMs", info.latency_ms);
    cJSON_AddNumberToObject(json, "uartErrors", stats.crc_errors + stats.timeouts);
    // Node identity for the bench (passthrough fields, benchDiagnostics).
    if (info.online) {
      cJSON *node = cJSON_AddObjectToObject(json, "node");
      cJSON_AddStringToObject(node, "session", info.session);
      cJSON_AddStringToObject(node, "resetReason", info.reset_reason);
      if (info.chip_revision >= 0) cJSON_AddNumberToObject(node, "chipRevision", info.chip_revision);
      if (info.heap_kb >= 0) cJSON_AddNumberToObject(node, "heapKB", info.heap_kb);
      if (info.psram_kb >= 0) cJSON_AddNumberToObject(node, "psramKB", info.psram_kb);
      if (info.sensor_pid[0] != '\0') cJSON_AddStringToObject(node, "sensorPid", info.sensor_pid);
      cJSON_AddBoolToObject(node, "autofocus", info.autofocus);
      cJSON_AddNumberToObject(node, "baud", NL_DEFAULT_BAUD);
    }
  } else {
    // CAM2-4 links land in milestone 2; reported offline, never faked.
    cJSON_AddBoolToObject(json, "online", false);
    cJSON_AddNullToObject(json, "sensor");
    cJSON_AddBoolToObject(json, "sensorDetected", false);
    cJSON_AddStringToObject(json, "firmware", "");
    cJSON_AddStringToObject(json, "state", "offline");
    cJSON_AddNumberToObject(json, "latencyMs", 0);
    cJSON_AddNumberToObject(json, "uartErrors", 0);
  }
  cJSON_AddNullToObject(json, "lastCapture"); /* no synchronized captures yet */
  return json;
}

static void handle_camera_info(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON *cameras = cJSON_AddArrayToObject(json, "cameras");
  for (int i = 0; i < 4; i++) cJSON_AddItemToArray(cameras, build_camera_info(i));
  send_json(KDP_CMD_GET_CAMERA_INFO, seq, json);
}

static int cam_index_from_request(cJSON *req) {
  const cJSON *cam = cJSON_GetObjectItem(req, "cam");
  if (!cJSON_IsString(cam)) return -1;
  static const char *ids[] = {"cam1", "cam2", "cam3", "cam4"};
  for (int i = 0; i < 4; i++) {
    if (strcmp(cam->valuestring, ids[i]) == 0) return i;
  }
  return -1;
}

static void handle_camera_status(uint32_t seq, cJSON *req) {
  int index = cam_index_from_request(req);
  if (index < 0) {
    send_nack(KDP_CMD_CAMERA_STATUS, seq, "INVALID_ARGUMENT", "cam must be cam1..cam4");
    return;
  }
  send_json(KDP_CMD_CAMERA_STATUS, seq, build_camera_info(index));
}

static void handle_link_stats(uint32_t seq, cJSON *req) {
  int index = cam_index_from_request(req);
  if (index < 0) {
    send_nack(KDP_CMD_CAMERA_LINK_STATS, seq, "INVALID_ARGUMENT", "cam must be cam1..cam4");
    return;
  }
  if (index != 0) {
    send_nack(KDP_CMD_CAMERA_LINK_STATS, seq, "CAMERA_OFFLINE",
              "Only cam1 has a link driver in Milestone 1B");
    return;
  }
  camlink_info_t info;
  camlink_get_info(&info);
  camlink_stats_t stats;
  camlink_get_stats(&stats);

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "cam", "cam1");
  cJSON_AddNumberToObject(json, "baud", NL_DEFAULT_BAUD);
  cJSON_AddBoolToObject(json, "connected", info.online);
  cJSON_AddNumberToObject(json, "rxFrames", stats.rx_frames);
  cJSON_AddNumberToObject(json, "txFrames", stats.tx_frames);
  cJSON_AddNumberToObject(json, "rxBytes", stats.rx_bytes);
  cJSON_AddNumberToObject(json, "txBytes", stats.tx_bytes);
  cJSON_AddNumberToObject(json, "crcErrors", stats.crc_errors);
  cJSON_AddNumberToObject(json, "decoderResyncs", stats.resyncs);
  cJSON_AddNumberToObject(json, "timeouts", stats.timeouts);
  cJSON_AddNumberToObject(json, "retries", stats.retries);
  cJSON_AddNumberToObject(json, "duplicateFrames", stats.duplicates);
  cJSON_AddNumberToObject(json, "lastSequence", stats.last_sequence);
  cJSON_AddNumberToObject(json, "latencyMaxMs", stats.latency_max_ms);
  if (info.reset_reason[0] != '\0') {
    cJSON_AddStringToObject(json, "lastNodeBootReason", info.reset_reason);
  } else {
    cJSON_AddNullToObject(json, "lastNodeBootReason");
  }
  if (stats.last_error[0] != '\0') cJSON_AddStringToObject(json, "lastError", stats.last_error);
  else cJSON_AddNullToObject(json, "lastError");
  send_json(KDP_CMD_CAMERA_LINK_STATS, seq, json);
}

static void handle_link_stats_reset(uint32_t seq, cJSON *req) {
  int index = cam_index_from_request(req);
  if (index < 0) {
    send_nack(KDP_CMD_CAMERA_LINK_STATS_RESET, seq, "INVALID_ARGUMENT", "cam must be cam1..cam4");
    return;
  }
  /* Same condition, same code as handle_link_stats — a valid cam id with no
   * link driver is offline, not malformed (issue #90). */
  if (index != 0) {
    send_nack(KDP_CMD_CAMERA_LINK_STATS_RESET, seq, "CAMERA_OFFLINE",
              "Only cam1 has a link driver in Milestone 1B");
    return;
  }
  camlink_reset_stats();
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  send_json(KDP_CMD_CAMERA_LINK_STATS_RESET, seq, json);
}

/** Live LOG events for every klog() line, contract LogEntry shape. */
static void log_emitter(int64_t t_ms, const char *src, const char *msg) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "t", (double)t_ms);
  cJSON_AddStringToObject(json, "src", src);
  cJSON_AddStringToObject(json, "msg", msg);
  send_event(KDP_EVT_LOG, json);
}

static void handle_get_logs(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  /* 64 B of headroom for the {"entries":[...]} envelope. */
  cJSON_AddItemToObject(json, "entries", klog_entries_json(KDP_MAX_PAYLOAD - 64));
  send_json(KDP_CMD_GET_LOGS, seq, json);
}

static void handle_clear_logs(uint32_t seq) {
  klog_clear();
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  send_json(KDP_CMD_CLEAR_LOGS, seq, json);
}

static void handle_runtime_stats(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "uptimeS", (double)(esp_timer_get_time() / 1000000));
  cJSON_AddStringToObject(json, "resetReason", reset_reason_str());
  cJSON_AddNumberToObject(json, "freeHeapKB", heap_kb());
  cJSON_AddNumberToObject(json, "freePsramKB", psram_kb());

  // Real die temperatures or null — never a fabricated number. CAM2-4 gain
  // readings when their links land in milestone 2.
  cJSON *temp = cJSON_AddObjectToObject(json, "tempC");
  float celsius = 0;
  if (s_tsens != NULL && temperature_sensor_get_celsius(s_tsens, &celsius) == ESP_OK) {
    cJSON_AddNumberToObject(temp, "p4", (double)((int)(celsius + 0.5f)));
  } else {
    cJSON_AddNullToObject(temp, "p4");
  }
  camlink_info_t info;
  camlink_get_info(&info);
  cJSON *cams = cJSON_AddArrayToObject(temp, "cams");
  if (info.online && info.temp_c != CAMLINK_TEMP_UNKNOWN) {
    cJSON_AddItemToArray(cams, cJSON_CreateNumber(info.temp_c));
  } else {
    cJSON_AddItemToArray(cams, cJSON_CreateNull());
  }
  for (int i = 1; i < 4; i++) cJSON_AddItemToArray(cams, cJSON_CreateNull());

  camlink_stats_t link;
  camlink_get_stats(&link);
  cJSON *protocol = cJSON_AddObjectToObject(json, "protocol");
  cJSON_AddNumberToObject(protocol, "droppedPackets", s_decoder.stats.resyncs);
  cJSON_AddNumberToObject(protocol, "crcFailures", s_decoder.stats.crc_failures);
  cJSON_AddNumberToObject(protocol, "cameraTimeouts", link.timeouts);
  cJSON_AddNumberToObject(protocol, "sdErrors", storage_sd_errors());
  send_json(KDP_CMD_GET_RUNTIME_STATS, seq, json);
}

// ---- self test ----

#define SELFTEST_TOTAL 6

static void selftest_emit(int index, const char *name, const char *status,
                          const char *detail, cJSON *results) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "index", index);
  cJSON_AddNumberToObject(json, "total", SELFTEST_TOTAL);
  cJSON_AddStringToObject(json, "name", name);
  cJSON_AddStringToObject(json, "status", status);
  if (detail != NULL) cJSON_AddStringToObject(json, "detail", detail);
  if (results != NULL) {
    cJSON_AddBoolToObject(json, "done", true);
    cJSON_AddItemToObject(json, "results", results);
  }
  send_event(KDP_EVT_SELF_TEST, json);
}

/* Only checks this hardware actually implements: six today, never a faked
 * display/touch/speaker row. The count grows with the milestones. */
static void selftest_task(void *arg) {
  (void)arg;
  static const char *NAMES[SELFTEST_TOTAL] = {"P4 heap",  "PSRAM",     "SD card",
                                              "SD write", "CAM1 link", "CAM1 sensor"};
  cJSON *results = cJSON_CreateArray();
  int passed = 0;

  for (int i = 0; i < SELFTEST_TOTAL; i++) {
    selftest_emit(i, NAMES[i], "running", NULL, NULL);
    const char *status = "fail";
    char detail[64] = "";

    switch (i) {
      case 0: {
        uint32_t heap = heap_kb();
        snprintf(detail, sizeof detail, "%lu KB free", (unsigned long)heap);
        status = heap > 32 ? "pass" : "fail";
        break;
      }
      case 1: {
        size_t total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
        if (total > 0) {
          snprintf(detail, sizeof detail, "%u MB", (unsigned)(total / (1024 * 1024)));
          status = "pass";
        } else {
          snprintf(detail, sizeof detail, "not detected");
        }
        break;
      }
      case 2: {
        storage_status_t sd;
        storage_get_status(&sd);
        if (sd.present) {
          snprintf(detail, sizeof detail, "%lu MB free",
                   (unsigned long)(sd.free_bytes / (1024 * 1024)));
          status = "pass";
        } else {
          snprintf(detail, sizeof detail, "no card");
        }
        break;
      }
      case 3: {
        if (!storage_present()) {
          status = "skip";
          snprintf(detail, sizeof detail, "no card");
        } else if (xSemaphoreTake(s_capture_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
          status = "skip";
          snprintf(detail, sizeof detail, "capture busy");
        } else {
          storage_selftest_result_t st;
          storage_self_test(&st);
          xSemaphoreGive(s_capture_lock);
          if (st.ok) {
            status = "pass";
            snprintf(detail, sizeof detail, "%lu KB verified",
                     (unsigned long)(st.bytes_tested / 1024));
          } else {
            status = "fail";
            snprintf(detail, sizeof detail, "%s",
                     storage_selftest_phase_str(st.failed_phase));
          }
        }
        break;
      }
      case 4: {
        if (camlink_hello() == ESP_OK) {
          camlink_info_t info;
          camlink_get_info(&info);
          snprintf(detail, sizeof detail, "answered in %lu ms",
                   (unsigned long)info.latency_ms);
          status = "pass";
        } else {
          snprintf(detail, sizeof detail, "no answer at %d baud", NL_DEFAULT_BAUD);
        }
        break;
      }
      case 5: {
        camlink_info_t info;
        camlink_get_info(&info);
        if (!info.online) {
          status = "skip";
          snprintf(detail, sizeof detail, "link down");
        } else if (info.sensor_detected) {
          snprintf(detail, sizeof detail, "%s (%s)", info.sensor, info.sensor_pid);
          status = "pass";
        } else {
          snprintf(detail, sizeof detail, "node answers, no sensor");
        }
        break;
      }
    }

    if (strcmp(status, "pass") == 0) passed++;
    cJSON *row = cJSON_CreateObject();
    cJSON_AddStringToObject(row, "name", NAMES[i]);
    cJSON_AddStringToObject(row, "status", status);
    cJSON_AddStringToObject(row, "detail", detail);
    cJSON_AddItemToArray(results, row);
    selftest_emit(i, NAMES[i], status, detail, i == SELFTEST_TOTAL - 1 ? results : NULL);
  }

  klog("P4", "self-test done — %d/%d pass", passed, SELFTEST_TOTAL);
  s_selftest_running = false;
  vTaskDelete(NULL);
}

static void handle_self_test(uint32_t seq) {
  if (s_selftest_running) {
    send_nack(KDP_CMD_SELF_TEST, seq, "BUSY", "Self test already running");
    return;
  }
  s_selftest_running = true;
  if (xTaskCreate(selftest_task, "selftest", 6144, NULL, 5, NULL) != pdPASS) {
    s_selftest_running = false;
    send_nack(KDP_CMD_SELF_TEST, seq, "OUT_OF_MEMORY", "Could not start self-test task");
    return;
  }
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "started", true);
  send_json(KDP_CMD_SELF_TEST, seq, json);
}

static void handle_hw_validation(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "p4ResetReason", reset_reason_str());
  cJSON *items = cJSON_AddArrayToObject(json, "items");
  for (int i = 0; i < HWV_COUNT; i++) {
    cJSON *item = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "id", hwv_item_id((hwv_item_t)i));
    cJSON_AddStringToObject(item, "status", hwv_status_str(hwv_status((hwv_item_t)i)));
    const char *detail = hwv_detail((hwv_item_t)i);
    if (detail[0] != '\0') cJSON_AddStringToObject(item, "detail", detail);
    cJSON_AddItemToArray(items, item);
  }
  send_json(KDP_CMD_GET_HW_VALIDATION, seq, json);
}

static void capture_result_json(const capture_result_t *r, cJSON *json) {
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddStringToObject(json, "cam", "cam1");
  cJSON_AddStringToObject(json, "captureUuid", r->capture_uuid);
  cJSON_AddStringToObject(json, "captureId", r->capture_id);
  cJSON_AddStringToObject(json, "resolution", CAPTURE_RESOLUTION);
  cJSON_AddNumberToObject(json, "jpegBytes", r->jpeg_bytes);
  cJSON_AddNumberToObject(json, "jpegKB", (double)(r->jpeg_bytes / 1024));
  cJSON_AddNumberToObject(json, "durationMs", r->t_total_ms);

  cJSON *timing = cJSON_AddObjectToObject(json, "timing");
  cJSON_AddNumberToObject(timing, "requestToNodeMs", r->t_request_to_node_ms);
  cJSON_AddNumberToObject(timing, "captureCommandToJpegReadyMs", r->t_capture_ms);
  cJSON_AddNumberToObject(timing, "jpegTransferMs", r->t_transfer_ms);
  cJSON_AddNumberToObject(timing, "sdWriteMs", r->t_sd_ms);
  cJSON_AddNumberToObject(timing, "totalMs", r->t_total_ms);

  cJSON *sums = cJSON_AddObjectToObject(json, "checksums");
  cJSON_AddStringToObject(sums, "nodeJpegCrc32", r->crc_node);
  cJSON_AddStringToObject(sums, "transferCrc32", r->crc_transfer);
  cJSON_AddStringToObject(sums, "storedFileCrc32", r->crc_stored);
  cJSON_AddBoolToObject(sums, "match", r->crc_match);

  cJSON *mem = cJSON_AddObjectToObject(json, "memory");
  cJSON_AddNumberToObject(mem, "p4HeapKBBefore", r->p4_heap_before);
  cJSON_AddNumberToObject(mem, "p4HeapKBAfter", r->p4_heap_after);
  cJSON_AddNumberToObject(mem, "p4PsramKBBefore", r->p4_psram_before);
  cJSON_AddNumberToObject(mem, "p4PsramKBAfter", r->p4_psram_after);
  if (r->node_heap_kb >= 0) cJSON_AddNumberToObject(mem, "nodeHeapKB", r->node_heap_kb);
  else cJSON_AddNullToObject(mem, "nodeHeapKB");
  if (r->node_psram_kb >= 0) cJSON_AddNumberToObject(mem, "nodePsramKB", r->node_psram_kb);
  else cJSON_AddNullToObject(mem, "nodePsramKB");
}

static void handle_camera_test(uint32_t seq, cJSON *req) {
  int index = cam_index_from_request(req);
  if (index < 0) {
    send_nack(KDP_CMD_CAMERA_TEST, seq, "INVALID_ARGUMENT", "cam must be cam1..cam4");
    return;
  }
  if (index != 0) {
    send_nack(KDP_CMD_CAMERA_TEST, seq, "CAMERA_OFFLINE", "Camera node not connected");
    return;
  }
  if (xSemaphoreTake(s_capture_lock, 0) != pdTRUE) {
    send_nack(KDP_CMD_CAMERA_TEST, seq, "BUSY", "A capture or soak run is active");
    return;
  }
  capture_result_t result;
  run_capture(-1, true, &result);
  xSemaphoreGive(s_capture_lock);

  if (!result.ok) {
    klog("C1", "capture FAILED — %s: %s", result.err_code, result.err_msg);
    send_nack(KDP_CMD_CAMERA_TEST, seq, result.err_code, result.err_msg);
    return;
  }
  cJSON *json = cJSON_CreateObject();
  capture_result_json(&result, json);
  send_json(KDP_CMD_CAMERA_TEST, seq, json);
}

// ---- soak test job ----

typedef struct {
  char job_id[16];
  uint32_t captures;
  uint32_t delay_ms;
  int jpeg_quality;
  bool keep_all;
} soak_args_t;

typedef struct {
  uint32_t count;
  uint64_t sum;
  uint32_t min, max;
} bucket_t;

static void bucket_add(bucket_t *b, uint32_t v) {
  if (b->count == 0 || v < b->min) b->min = v;
  if (b->count == 0 || v > b->max) b->max = v;
  b->sum += v;
  b->count++;
}

static void bucket_json(cJSON *json, const char *base, const bucket_t *b) {
  char key[32];
  snprintf(key, sizeof key, "min%s", base);
  if (b->count > 0) cJSON_AddNumberToObject(json, key, b->min);
  else cJSON_AddNullToObject(json, key);
  snprintf(key, sizeof key, "max%s", base);
  if (b->count > 0) cJSON_AddNumberToObject(json, key, b->max);
  else cJSON_AddNullToObject(json, key);
  snprintf(key, sizeof key, "avg%s", base);
  if (b->count > 0) cJSON_AddNumberToObject(json, key, (double)(b->sum / b->count));
  else cJSON_AddNullToObject(json, key);
}

#define SOAK_ERROR_KINDS 8

static void soak_task(void *arg) {
  soak_args_t *args = (soak_args_t *)arg;

  uint32_t successful = 0, failed = 0, crc_errors = 0, timeouts = 0, sd_errors = 0;
  uint32_t node_resets = 0;
  bucket_t jpeg = {0}, ready = {0}, transfer = {0}, sd = {0};
  char first_uuid[40] = "", last_uuid[40] = "";
  char kept_last_dir[64] = "";
  struct { char code[28]; uint32_t count; } errors[SOAK_ERROR_KINDS] = {0};

  uint32_t heap_start = heap_kb();
  uint32_t psram_start = psram_kb();

  camlink_info_t node0;
  camlink_get_info(&node0);
  char node_session[16];
  strncpy(node_session, node0.session, sizeof node_session);

  uint32_t batch = args->captures / 10;
  if (batch == 0) batch = 1;

  for (uint32_t i = 0; i < args->captures; i++) {
    capture_result_t r;
    run_capture(args->jpeg_quality, true, &r);

    if (r.ok) {
      successful++;
      bucket_add(&jpeg, r.jpeg_bytes);
      bucket_add(&ready, r.t_capture_ms);
      bucket_add(&transfer, r.t_transfer_ms);
      bucket_add(&sd, r.t_sd_ms);
      if (first_uuid[0] == '\0') {
        strncpy(first_uuid, r.capture_uuid, sizeof first_uuid);
      } else if (!args->keep_all) {
        // Keep first and current last; drop the previous middle capture.
        if (kept_last_dir[0] != '\0') storage_capture_delete(kept_last_dir);
        strncpy(kept_last_dir, r.dir, sizeof kept_last_dir);
      }
      strncpy(last_uuid, r.capture_uuid, sizeof last_uuid);
    } else {
      failed++;
      if (strcmp(r.err_code, "TRANSFER_CRC_MISMATCH") == 0) crc_errors++;
      if (strcmp(r.err_code, "TRANSFER_TIMEOUT") == 0 ||
          strcmp(r.err_code, "NODE_BOOT_TIMEOUT") == 0) {
        timeouts++;
      }
      if (strncmp(r.err_code, "SD_", 3) == 0) sd_errors++;
      for (int e = 0; e < SOAK_ERROR_KINDS; e++) {
        if (errors[e].count == 0 || strcmp(errors[e].code, r.err_code) == 0) {
          if (errors[e].count == 0) strncpy(errors[e].code, r.err_code, sizeof errors[e].code - 1);
          errors[e].count++;
          break;
        }
      }
      // Node reset detection: did the node come back with a new session?
      if (camlink_hello() == ESP_OK) {
        camlink_info_t now;
        camlink_get_info(&now);
        if (now.session[0] != '\0' && strcmp(now.session, node_session) != 0) {
          node_resets++;
          strncpy(node_session, now.session, sizeof node_session);
        }
      }
    }

    if ((i + 1) % batch == 0 || i + 1 == args->captures) {
      cJSON *progress = cJSON_CreateObject();
      cJSON_AddStringToObject(progress, "jobId", args->job_id);
      cJSON_AddNumberToObject(progress, "progress", (double)(i + 1) / args->captures);
      cJSON_AddStringToObject(progress, "step", "capture");
      char msg[48];
      snprintf(msg, sizeof msg, "%lu/%lu captures, %lu failed", (unsigned long)(i + 1),
               (unsigned long)args->captures, (unsigned long)failed);
      cJSON_AddStringToObject(progress, "message", msg);
      send_event(KDP_EVT_JOB_PROGRESS, progress);
    }

    if (i + 1 < args->captures) vTaskDelay(pdMS_TO_TICKS(args->delay_ms));
  }

  cJSON *result = cJSON_CreateObject();
  cJSON_AddStringToObject(result, "cam", "cam1");
  cJSON_AddNumberToObject(result, "attempted", args->captures);
  cJSON_AddNumberToObject(result, "successful", successful);
  cJSON_AddNumberToObject(result, "failed", failed);
  cJSON_AddNumberToObject(result, "crcErrors", crc_errors);
  cJSON_AddNumberToObject(result, "timeouts", timeouts);
  cJSON_AddNumberToObject(result, "nodeResets", node_resets);
  /* A completed job proves the P4 did not reset during it. */
  cJSON_AddNumberToObject(result, "p4Resets", 0);
  cJSON_AddNumberToObject(result, "sdErrors", sd_errors);
  bucket_json(result, "JpegBytes", &jpeg);
  bucket_json(result, "CaptureReadyMs", &ready);
  bucket_json(result, "TransferMs", &transfer);
  bucket_json(result, "SdWriteMs", &sd);
  cJSON_AddNumberToObject(result, "heapDeltaKB", (double)((int64_t)heap_kb() - heap_start));
  cJSON_AddNumberToObject(result, "psramDeltaKB", (double)((int64_t)psram_kb() - psram_start));
  if (first_uuid[0] != '\0') cJSON_AddStringToObject(result, "firstCaptureUuid", first_uuid);
  else cJSON_AddNullToObject(result, "firstCaptureUuid");
  if (last_uuid[0] != '\0') cJSON_AddStringToObject(result, "lastCaptureUuid", last_uuid);
  else cJSON_AddNullToObject(result, "lastCaptureUuid");
  cJSON *errs = cJSON_AddArrayToObject(result, "errors");
  for (int e = 0; e < SOAK_ERROR_KINDS; e++) {
    if (errors[e].count == 0) continue;
    cJSON *entry = cJSON_CreateObject();
    cJSON_AddStringToObject(entry, "code", errors[e].code);
    cJSON_AddNumberToObject(entry, "count", errors[e].count);
    cJSON_AddItemToArray(errs, entry);
  }

  cJSON *complete = cJSON_CreateObject();
  cJSON_AddStringToObject(complete, "jobId", args->job_id);
  cJSON_AddItemToObject(complete, "result", result);
  send_event(KDP_EVT_JOB_COMPLETE, complete);

  klog("P4", "soak %s done — %lu/%lu ok, %lu failed", args->job_id,
       (unsigned long)successful, (unsigned long)args->captures,
       (unsigned long)failed);

  s_soak_running = false;
  xSemaphoreGive(s_capture_lock);
  free(args);
  vTaskDelete(NULL);
}

static void handle_soak_test(uint32_t seq, cJSON *req) {
  int index = cam_index_from_request(req);
  if (index != 0) {
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq,
              index < 0 ? "INVALID_ARGUMENT" : "CAMERA_OFFLINE",
              "Soak test runs on cam1 in Milestone 1B");
    return;
  }
  camlink_info_t info;
  camlink_get_info(&info);
  if (!info.online) {
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "CAMERA_OFFLINE", "Camera node not connected");
    return;
  }
  if (!storage_present()) {
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "SD_NOT_MOUNTED", "No durable storage path");
    return;
  }
  if (xSemaphoreTake(s_capture_lock, 0) != pdTRUE) {
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "BUSY", "A capture or soak run is active");
    return;
  }

  soak_args_t *args = calloc(1, sizeof *args);
  if (args == NULL) {
    xSemaphoreGive(s_capture_lock);
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "OUT_OF_MEMORY", "No memory for soak state");
    return;
  }

  const cJSON *captures = cJSON_GetObjectItem(req, "captures");
  const cJSON *delay = cJSON_GetObjectItem(req, "delayMs");
  const cJSON *quality = cJSON_GetObjectItem(req, "jpegQuality");
  const cJSON *keep = cJSON_GetObjectItem(req, "keepAll");
  long want = cJSON_IsNumber(captures) ? (long)captures->valuedouble : 100;
  if (want < 1) want = 1;
  if (want > 1000) want = 1000;
  args->captures = (uint32_t)want;
  long d = cJSON_IsNumber(delay) ? (long)delay->valuedouble : 1000;
  if (d < 100) d = 100;
  if (d > 60000) d = 60000;
  args->delay_ms = (uint32_t)d;
  args->jpeg_quality = cJSON_IsNumber(quality) ? quality->valueint : -1;
  args->keep_all = cJSON_IsTrue(keep);
  snprintf(args->job_id, sizeof args->job_id, "job_%lu", (unsigned long)++s_job_counter);

  s_soak_running = true;
  if (xTaskCreate(soak_task, "soak", 8192, args, 5, NULL) != pdPASS) {
    s_soak_running = false;
    free(args);
    xSemaphoreGive(s_capture_lock);
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "OUT_OF_MEMORY", "Could not start soak task");
    return;
  }

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "jobId", args->job_id);
  cJSON_AddBoolToObject(json, "accepted", true);
  send_json(KDP_CMD_CAMERA_SOAK_TEST, seq, json);
}

static void handle_reboot(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  send_json(KDP_CMD_REBOOT, seq, json); /* answer first, reboot after */
  vTaskDelay(pdMS_TO_TICKS(200));
  esp_restart();
}

// ---- dispatch ----

static void on_frame(const kdp_frame_t *frame, void *ctx) {
  (void)ctx;
  if (frame->flags & (KDP_FLAG_RESPONSE | KDP_FLAG_EVENT)) return; /* host requests only */
  if (!s_usb_seen) {
    s_usb_seen = true;
    hwv_mark_validated(HWV_USB_SERIAL_JTAG, "host frame decoded over USB-Serial-JTAG");
  }
  if (frame->version != KDP_PROTOCOL_VERSION) {
    send_nack(frame->type, frame->seq, "BAD_VERSION", "Unsupported protocol version");
    return;
  }

  cJSON *req = NULL;
  if (frame->payload_len > 0 && (frame->flags & KDP_FLAG_BINARY) == 0) {
    req = cJSON_ParseWithLength((const char *)frame->payload, frame->payload_len);
  }

  switch (frame->type) {
    case KDP_CMD_HELLO: handle_hello(frame->seq, req); break;
    case KDP_CMD_GET_DEVICE_INFO: handle_device_info(frame->seq); break;
    case KDP_CMD_GET_CAPABILITIES: handle_capabilities(frame->seq); break;
    case KDP_CMD_GET_STORAGE_STATUS: handle_storage_status(frame->seq); break;
    case KDP_CMD_GET_CAMERA_INFO: handle_camera_info(frame->seq); break;
    case KDP_CMD_CAMERA_STATUS: handle_camera_status(frame->seq, req); break;
    case KDP_CMD_CAMERA_TEST: handle_camera_test(frame->seq, req); break;
    case KDP_CMD_STORAGE_SELF_TEST: handle_storage_self_test(frame->seq); break;
    case KDP_CMD_CAMERA_LINK_STATS: handle_link_stats(frame->seq, req); break;
    case KDP_CMD_CAMERA_LINK_STATS_RESET: handle_link_stats_reset(frame->seq, req); break;
    case KDP_CMD_CAMERA_SOAK_TEST: handle_soak_test(frame->seq, req); break;
    case KDP_CMD_GET_HW_VALIDATION: handle_hw_validation(frame->seq); break;
    case KDP_CMD_GET_RUNTIME_STATS: handle_runtime_stats(frame->seq); break;
    case KDP_CMD_GET_LOGS: handle_get_logs(frame->seq); break;
    case KDP_CMD_CLEAR_LOGS: handle_clear_logs(frame->seq); break;
    case KDP_CMD_SELF_TEST: handle_self_test(frame->seq); break;
    case KDP_CMD_REBOOT: handle_reboot(frame->seq); break;
    default: {
      // Never silently time out (contract §NACK).
      char message[64];
      snprintf(message, sizeof message, "Command 0x%02x not implemented in firmware %s",
               frame->type, KINO_FW_VERSION);
      send_nack(frame->type, frame->seq, "UNSUPPORTED_COMMAND", message);
      break;
    }
  }

  cJSON_Delete(req);
}

static void server_task(void *arg) {
  (void)arg;
  uint8_t rx[512];
  for (;;) {
    int n = usb_link_read(rx, sizeof rx, 100);
    if (n > 0) kdp_decoder_push(&s_decoder, rx, (size_t)n, on_frame, NULL);
  }
}

esp_err_t kdp_server_start(const kdp_identity_t *identity) {
  s_id = *identity;
  s_tx_lock = xSemaphoreCreateMutex();
  s_capture_lock = xSemaphoreCreateMutex();
  if (s_tx_lock == NULL || s_capture_lock == NULL) return ESP_ERR_NO_MEM;

  esp_err_t err = usb_link_init();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "USB_TRANSPORT init FAILED: %s — Studio link unavailable this boot",
             esp_err_to_name(err));
    return err;
  }
  ESP_LOGI(TAG, "USB_TRANSPORT_READY: KDP on USB-Serial-JTAG, session %s",
           s_id.session_id);
  klog_set_emitter(log_emitter);

  temperature_sensor_config_t tsens_config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
  s_tsens = NULL;
  temperature_sensor_handle_t tsens = NULL;
  if (temperature_sensor_install(&tsens_config, &tsens) == ESP_OK &&
      temperature_sensor_enable(tsens) == ESP_OK) {
    s_tsens = tsens; /* otherwise GET_RUNTIME_STATS reports tempC.p4 null */
  }

  kdp_decoder_init(&s_decoder, s_decode_buf, sizeof s_decode_buf);
  BaseType_t ok = xTaskCreate(server_task, "kdp_server", 8192, NULL, 9, NULL);
  return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
