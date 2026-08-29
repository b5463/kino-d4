#include "cam_link.h"

#include <string.h>

#include "board_d4v1.h"
#include "board_d4v1_checks.h"
#include "cJSON.h"
#include "driver/uart.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "hardware_validation.h"
#include "kdp/decoder.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"
#include "klog.h"
#include "node_link/node_link.h"

/* Four frames deep, not two.
 *
 * The ESP-IDF UART driver DROPS bytes when this ring overflows, and it is
 * installed with a NULL event queue so the overflow is silent. At the
 * sensor's ceiling - QXGA q95, a 90-240 KB frame in 8 KB chunks - the bench
 * saw a chunk arrive 8120 bytes of the 8210 it needed and stop: raising the
 * read timeout from 1500 ms to 4000 ms bought 45 more bytes and never
 * completed a frame, which is what a dropped tail looks like rather than a
 * slow one. crcErrors stayed 0 throughout because the frame never finished to
 * be checked.
 *
 * Two frames of headroom is not much when the UI is compositing at the same
 * time and the reader can be descheduled for tens of milliseconds. */
/*
 * Four chunks deep. Eight was tried and made no difference to the overrun
 * rate, which is what rules out "the reader is being outrun" and leaves the
 * ISR being held off as the explanation.
 */
#define LINK_RX_BUF (4 * (NL_CHUNK_MAX + 64))

/*
 * Decoder storage per channel.
 *
 * KDP_MAX_FRAME is 16402 bytes because the KDP payload cap is 16 KB, but this
 * is the NODE link, not the host link, and NL_CHUNK_MAX is 8192 - a node
 * cannot send a larger frame than that. Four channels at KDP_MAX_FRAME was
 * 66 KB of .bss to hold frames that cannot arrive; sized to what the node
 * link actually permits it is half that. The header and CRC are added back
 * because a full chunk still has to fit with its framing.
 */
/* Plus slack. Sized exactly to one frame, a single stray byte ahead of a
 * full-size chunk - node boot spew, the tail of a resync - leaves no room for
 * the frame behind it to be assembled. 64 bytes costs nothing and removes a
 * cliff that only appears at the maximum chunk size. */
#define LINK_DECODE_BUF (KDP_HEADER_LEN + NL_CHUNK_MAX + KDP_CRC_LEN + 64)

#define DEFAULT_TIMEOUT_MS 3000
#define CAPTURE_TIMEOUT_MS 8000

typedef struct channel_s channel_t;

typedef struct {
  uint32_t seq;
  bool got;
  bool nack;
  uint8_t *dst;
  size_t dst_cap;
  size_t len;
  char err_code[24];
  channel_t *ch; /* so the frame callback can reach its own counters */
} pending_t;

/* One camera's entire link. Nothing here is shared with another channel -
 * that separation is what allows two transfers to be in flight at once. */
struct channel_s {
  uart_port_t uart;
  int tx_pin;
  int rx_pin;
  const char *tag; /* "C1".."C4", the klog source for this node */
  SemaphoreHandle_t lock;
  uint32_t seq;
  camlink_info_t info;
  camlink_stats_t stats;
  uint8_t decode_storage[LINK_DECODE_BUF];
  kdp_decoder_t decoder;
  uint8_t tx[512];
  pending_t pending;
  /* Timeout log throttling. An absent node is a permanent condition, and the
   * viewfinder asks each camera for a frame several times a second - so an
   * unwired channel produced three log lines a second forever, filling the
   * ring and burying everything that mattered. The first failure keeps its
   * full detail because that is the one that diagnoses the fault; the
   * repeats are counted instead of printed. */
  uint32_t timeout_run;
  int64_t timeout_logged_us;
};

/* How long a channel stays quiet about a fault it has already reported. */
#define TIMEOUT_LOG_QUIET_US (30 * 1000000)

static channel_t s_ch[CAMLINK_CAMS];

static bool valid_cam(int cam) { return cam >= 0 && cam < CAMLINK_CAMS && s_ch[cam].lock != NULL; }

static void set_last_error(channel_t *ch, const char *code) {
  strlcpy(ch->stats.last_error, code, sizeof ch->stats.last_error);
  ch->stats.last_error[sizeof ch->stats.last_error - 1] = '\0';
}

static void on_frame(const kdp_frame_t *frame, void *ctx) {
  pending_t *p = (pending_t *)ctx;
  channel_t *ch = p->ch;
  ch->stats.rx_frames++;
  if ((frame->flags & KDP_FLAG_RESPONSE) == 0) return; /* node sends no events in M1B */
  if (frame->seq != p->seq || p->got) {
    // A response we no longer wait for: a late reply to a timed-out request
    // or a genuine duplicate. Counted, never delivered.
    ch->stats.duplicates++;
    return;
  }

  p->len = frame->payload_len < p->dst_cap ? frame->payload_len : p->dst_cap;
  memcpy(p->dst, frame->payload, p->len);
  p->nack = (frame->flags & KDP_FLAG_ERROR) != 0;
  if (p->nack) {
    cJSON *err = cJSON_ParseWithLength((const char *)p->dst, p->len);
    const cJSON *code = err != NULL ? cJSON_GetObjectItem(err, "code") : NULL;
    if (cJSON_IsString(code)) strlcpy(p->err_code, code->valuestring, sizeof p->err_code);
    cJSON_Delete(err);
  }
  p->got = true;
}

/* Serialized request/response. Returns ESP_OK on a positive response,
 * ESP_ERR_INVALID_RESPONSE on a NACK, ESP_ERR_TIMEOUT on silence. */
static esp_err_t request(int cam, uint8_t cmd, const char *json, uint8_t *resp,
                         size_t resp_cap, size_t *resp_len, uint32_t timeout_ms) {
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  channel_t *ch = &s_ch[cam];
  xSemaphoreTake(ch->lock, portMAX_DELAY);

  memset(&ch->pending, 0, sizeof ch->pending);
  ch->pending.ch = ch;
  ch->seq = kdp_next_seq(ch->seq);
  ch->pending.seq = ch->seq;
  ch->pending.dst = resp;
  ch->pending.dst_cap = resp_cap;
  ch->stats.last_sequence = ch->seq;

  const char *payload = json != NULL ? json : "{}";
  size_t total = kdp_encode_frame(ch->tx, sizeof ch->tx, NL_PROTOCOL_VERSION, cmd,
                                  KDP_FLAG_NONE, ch->pending.seq,
                                  (const uint8_t *)payload, strlen(payload));
  if (total == 0) {
    xSemaphoreGive(ch->lock);
    return ESP_ERR_INVALID_ARG;
  }

  /* Counter snapshot so a timeout can report what arrived during THIS
   * request. Without it a stalled 400 KB transfer and a dead cable produce
   * the same log line, and the first bench run cannot tell them apart. */
  const uint32_t rx_bytes_before = ch->stats.rx_bytes;
  const uint32_t rx_frames_before = ch->stats.rx_frames;
  const uint32_t dups_before = ch->stats.duplicates;
  const uint32_t crc_before = ch->stats.crc_errors + ch->decoder.stats.crc_failures;

  int64_t start = esp_timer_get_time();
  uart_flush_input(ch->uart);
  kdp_decoder_reset(&ch->decoder);
  uart_write_bytes(ch->uart, ch->tx, total);
  ch->stats.tx_frames++;
  ch->stats.tx_bytes += (uint32_t)total;

  uint8_t rx[512];
  while (!ch->pending.got) {
    int64_t elapsed_ms = (esp_timer_get_time() - start) / 1000;
    if (elapsed_ms >= timeout_ms) break;
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
    int n = uart_read_bytes(ch->uart, rx, 1, pdMS_TO_TICKS(10));
    if (n > 0) {
      /* Drain whatever else arrived with it, without waiting for more. */
      size_t avail = 0;
      uart_get_buffered_data_len(ch->uart, &avail);
      if (avail > sizeof rx - 1) avail = sizeof rx - 1;
      if (avail > 0) {
        const int more = uart_read_bytes(ch->uart, rx + 1, avail, 0);
        if (more > 0) n += more;
      }
      ch->stats.rx_bytes += (uint32_t)n;
      kdp_decoder_push(&ch->decoder, rx, (size_t)n, on_frame, &ch->pending);
    }
  }

  esp_err_t result;
  if (!ch->pending.got) {
    /* A timeout that prints only "TIMEOUT" wastes the run it happened on.
     * Silence, a partial transfer and a reply to a request we already gave
     * up on all need different fixes, and these four counters separate
     * them. The budget is here too because it is a guess made before any
     * hardware existed: the interesting case is elapsed at the budget with
     * bytes still arriving. */
    uint32_t ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
    ch->stats.timeouts++;
    set_last_error(ch, "TIMEOUT");
    const int64_t now_us = esp_timer_get_time();
    ch->timeout_run++;
    if (ch->timeout_run == 1 || now_us - ch->timeout_logged_us >= TIMEOUT_LOG_QUIET_US) {
      /* The counters are per-request on purpose: silence, a stalled transfer
       * and a reply to a request already given up on all look the same
       * without them. `run` says how many failed since the last line, so a
       * throttled channel still reports its rate. */
      klog(ch->tag, "TIMEOUT cmd 0x%02x seq %lu %lu/%lums %luB %luf %lud %luc run %lu", cmd,
           (unsigned long)ch->pending.seq, (unsigned long)ms, (unsigned long)timeout_ms,
           (unsigned long)(ch->stats.rx_bytes - rx_bytes_before),
           (unsigned long)(ch->stats.rx_frames - rx_frames_before),
           (unsigned long)(ch->stats.duplicates - dups_before),
           (unsigned long)(ch->stats.crc_errors + ch->decoder.stats.crc_failures - crc_before),
           (unsigned long)ch->timeout_run);
      ch->timeout_logged_us = now_us;
    }
    result = ESP_ERR_TIMEOUT;
  } else if (ch->pending.nack) {
    set_last_error(ch, ch->pending.err_code[0] != '\0' ? ch->pending.err_code : "NACK");
    result = ESP_ERR_INVALID_RESPONSE;
  } else {
    ch->info.latency_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
    if (ch->info.latency_ms > ch->stats.latency_max_ms)
      ch->stats.latency_max_ms = ch->info.latency_ms;
    if (ch->timeout_run > 0) {
      /* Recovery is worth a line: a node that came back after a run of
       * failures is the interesting half of an intermittent link. */
      klog(ch->tag, "recovered after %lu timeouts", (unsigned long)ch->timeout_run);
      ch->timeout_run = 0;
    }
    result = ESP_OK;
  }
  ch->stats.crc_errors += ch->decoder.stats.crc_failures;
  ch->stats.resyncs += ch->decoder.stats.resyncs;
  ch->decoder.stats.crc_failures = 0;
  ch->decoder.stats.resyncs = 0;
  if (resp_len != NULL) *resp_len = ch->pending.len;

  xSemaphoreGive(ch->lock);
  return result;
}

esp_err_t camlink_init(void) {
  static const struct {
    uart_port_t uart;
    int tx;
    int rx;
    const char *tag;
  } WIRING[CAMLINK_CAMS] = {
      {BOARD_CAM1_UART_NUM, BOARD_CAM1_TX, BOARD_CAM1_RX, "C1"},
      {BOARD_CAM2_UART_NUM, BOARD_CAM2_TX, BOARD_CAM2_RX, "C2"},
      {BOARD_CAM3_UART_NUM, BOARD_CAM3_TX, BOARD_CAM3_RX, "C3"},
      {BOARD_CAM4_UART_NUM, BOARD_CAM4_TX, BOARD_CAM4_RX, "C4"},
  };

  const uart_config_t config = {
      .baud_rate = NL_DEFAULT_BAUD,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .source_clk = UART_SCLK_DEFAULT,
  };

  for (int i = 0; i < CAMLINK_CAMS; i++) {
    channel_t *ch = &s_ch[i];
    ch->uart = WIRING[i].uart;
    ch->tx_pin = WIRING[i].tx;
    ch->rx_pin = WIRING[i].rx;
    ch->tag = WIRING[i].tag;
    ch->info.chip_revision = -1;
    ch->info.heap_kb = -1;
    ch->info.psram_kb = -1;
    ch->info.temp_c = CAMLINK_TEMP_UNKNOWN;

    /* A port that will not install is a channel that stays absent, not a
     * boot failure: three unwired nodes must never stop the one that is
     * wired from working. */
    /*
     * An event queue, because installing with queue size 0 discards exactly
     * the events that explain a lost byte. UART_FIFO_OVF and UART_BUFFER_FULL
     * are how the driver reports that data arrived and could not be kept, and
     * without them an overrun is indistinguishable from a node that went
     * quiet: no CRC error, no resync, just a frame that never completes.
     * ESP_INTR_FLAG_IRAM pairs with CONFIG_UART_ISR_IN_IRAM so the handler
     * survives a disabled flash cache.
     */
    /* No event queue, and no IRAM interrupt flag. Both were tried on
     * 2026-08-29 and both are worse - see sdkconfig.defaults for the bisect
     * that settled the IRAM one. */
    esp_err_t err = uart_driver_install(ch->uart, LINK_RX_BUF, 0, 0, NULL, 0);
    if (err == ESP_OK) err = uart_param_config(ch->uart, &config);
    if (err == ESP_OK)
      err = uart_set_pin(ch->uart, ch->tx_pin, ch->rx_pin, UART_PIN_NO_CHANGE,
                         UART_PIN_NO_CHANGE);
    if (err != ESP_OK) {
      klog(ch->tag, "uart%d unavailable: %s", (int)ch->uart, esp_err_to_name(err));
      continue;
    }

    ch->lock = xSemaphoreCreateMutex();
    if (ch->lock == NULL) return ESP_ERR_NO_MEM;
    kdp_decoder_init(&ch->decoder, ch->decode_storage, sizeof ch->decode_storage);
  }
  return ESP_OK;
}

void camlink_get_info_ch(int cam, camlink_info_t *out) {
  if (out == NULL) return;
  if (!valid_cam(cam)) {
    /* An unwired channel is reported as an offline node rather than as an
     * error: to everything upstream those are the same situation. */
    memset(out, 0, sizeof *out);
    out->chip_revision = -1;
    out->heap_kb = -1;
    out->psram_kb = -1;
    out->temp_c = CAMLINK_TEMP_UNKNOWN;
    return;
  }
  channel_t *ch = &s_ch[cam];
  xSemaphoreTake(ch->lock, portMAX_DELAY);
  *out = ch->info;
  xSemaphoreGive(ch->lock);
}

void camlink_get_info(camlink_info_t *out) { camlink_get_info_ch(0, out); }

void camlink_get_stats_ch(int cam, camlink_stats_t *out) {
  if (out == NULL) return;
  if (!valid_cam(cam)) {
    memset(out, 0, sizeof *out);
    return;
  }
  channel_t *ch = &s_ch[cam];
  xSemaphoreTake(ch->lock, portMAX_DELAY);
  *out = ch->stats;
  xSemaphoreGive(ch->lock);
}

void camlink_get_stats(camlink_stats_t *out) { camlink_get_stats_ch(0, out); }

void camlink_reset_stats_ch(int cam) {
  if (!valid_cam(cam)) return;
  channel_t *ch = &s_ch[cam];
  xSemaphoreTake(ch->lock, portMAX_DELAY);
  uint32_t keep_seq = ch->stats.last_sequence;
  memset(&ch->stats, 0, sizeof ch->stats);
  ch->stats.last_sequence = keep_seq;
  xSemaphoreGive(ch->lock);
}

void camlink_reset_stats(void) { camlink_reset_stats_ch(0); }

static void copy_str(char *dst, size_t cap, const cJSON *item) {
  dst[0] = '\0';
  if (cJSON_IsString(item)) strlcpy(dst, item->valuestring, cap);
}

esp_err_t camlink_hello_ch(int cam) {
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  channel_t *ch = &s_ch[cam];
  uint8_t resp[768];
  size_t len = 0;
  esp_err_t err = request(cam, NL_CMD_HELLO, NULL, resp, sizeof resp - 1, &len,
                          DEFAULT_TIMEOUT_MS);

  xSemaphoreTake(ch->lock, portMAX_DELAY);
  if (err != ESP_OK) {
    ch->info.online = false;
    xSemaphoreGive(ch->lock);
    return err;
  }
  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json == NULL) {
    ch->info.online = false;
    xSemaphoreGive(ch->lock);
    return ESP_ERR_INVALID_RESPONSE;
  }
  ch->info.online = true;
  copy_str(ch->info.firmware, sizeof ch->info.firmware, cJSON_GetObjectItem(json, "firmware"));
  copy_str(ch->info.sensor, sizeof ch->info.sensor, cJSON_GetObjectItem(json, "sensor"));
  copy_str(ch->info.sensor_pid, sizeof ch->info.sensor_pid, cJSON_GetObjectItem(json, "sensorPid"));
  copy_str(ch->info.session, sizeof ch->info.session, cJSON_GetObjectItem(json, "sessionId"));
  copy_str(ch->info.reset_reason, sizeof ch->info.reset_reason,
           cJSON_GetObjectItem(json, "resetReason"));
  ch->info.sensor_detected = cJSON_IsTrue(cJSON_GetObjectItem(json, "sensorDetected"));
  ch->info.autofocus = cJSON_IsTrue(cJSON_GetObjectItem(json, "autofocus"));
  const cJSON *rev = cJSON_GetObjectItem(json, "chipRevision");
  ch->info.chip_revision = cJSON_IsNumber(rev) ? rev->valueint : -1;
  const cJSON *heap = cJSON_GetObjectItem(json, "heapKB");
  ch->info.heap_kb = cJSON_IsNumber(heap) ? (int32_t)heap->valuedouble : -1;
  const cJSON *psram = cJSON_GetObjectItem(json, "psramKB");
  ch->info.psram_kb = cJSON_IsNumber(psram) ? (int32_t)psram->valuedouble : -1;
  cJSON_Delete(json);
  const bool sensor_seen = ch->info.sensor_detected;
  char sensor_name[sizeof ch->info.sensor];
  memcpy(sensor_name, ch->info.sensor, sizeof sensor_name);
  xSemaphoreGive(ch->lock);

  /* A decoded node HELLO on this unit proves the harness pins and the baud.
   * Every channel now has registry rows, not just CAM1. They were CAM1-only
   * while one node was all the harness had; the four-camera bring-up needs
   * somewhere to record channels 2-4, and an UNVALIDATED row is the honest
   * state for a channel nobody has jumpered rather than clutter. */
  {
    hwv_mark_validated(hwv_cam_item(cam, HWV_CAM1_TX_GPIO52), "node HELLO answered");
    hwv_mark_validated(hwv_cam_item(cam, HWV_CAM1_RX_GPIO51), "node HELLO answered");
    hwv_mark_validated(hwv_cam_item(cam, HWV_CAM1_BAUD_921600), "node HELLO at 921600");
    hwv_mark_validated(hwv_cam_item(cam, HWV_CAM1_NODE_LINK), "node HELLO answered");
    if (sensor_seen) hwv_mark_validated(hwv_cam_item(cam, HWV_CAM1_SENSOR_DETECT), sensor_name);
  }
  return ESP_OK;
}

esp_err_t camlink_hello(void) { return camlink_hello_ch(0); }

esp_err_t camlink_ping_ch(int cam, uint32_t *rtt_ms) {
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  channel_t *ch = &s_ch[cam];
  uint8_t resp[512];
  size_t len = 0;
  int64_t start = esp_timer_get_time();
  esp_err_t err = request(cam, NL_CMD_STATUS, NULL, resp, sizeof resp - 1, &len,
                          DEFAULT_TIMEOUT_MS);
  if (rtt_ms != NULL) *rtt_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
  if (err != ESP_OK) return err;

  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json != NULL) {
    xSemaphoreTake(ch->lock, portMAX_DELAY);
    copy_str(ch->info.state, sizeof ch->info.state, cJSON_GetObjectItem(json, "state"));
    const cJSON *heap = cJSON_GetObjectItem(json, "heapKB");
    if (cJSON_IsNumber(heap)) ch->info.heap_kb = (int32_t)heap->valuedouble;
    const cJSON *psram = cJSON_GetObjectItem(json, "psramKB");
    if (cJSON_IsNumber(psram)) ch->info.psram_kb = (int32_t)psram->valuedouble;
    const cJSON *temp = cJSON_GetObjectItem(json, "tempC");
    ch->info.temp_c = cJSON_IsNumber(temp) ? (int32_t)temp->valuedouble : CAMLINK_TEMP_UNKNOWN;
    xSemaphoreGive(ch->lock);
    cJSON_Delete(json);
  }
  return ESP_OK;
}

esp_err_t camlink_ping(uint32_t *rtt_ms) { return camlink_ping_ch(0, rtt_ms); }

esp_err_t camlink_capture_ch(int cam, const char *resolution, int jpeg_quality,
                             uint32_t timeout_ms, camlink_capture_result_t *out) {
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
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
  esp_err_t err = request(cam, NL_CMD_CAPTURE, req_json, resp, sizeof resp - 1, &len,
                          timeout_ms);
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
  /* Optional: a node built before these fields existed simply omits them and
   * they stay zero, which reads as "not reported" rather than as a real zero. */
  const cJSON *fb_us = cJSON_GetObjectItem(json, "fbGetUs");
  if (cJSON_IsNumber(fb_us)) out->fb_get_us = (int64_t)fb_us->valuedouble;
  const cJSON *fstart = cJSON_GetObjectItem(json, "frameStartUs");
  if (cJSON_IsNumber(fstart)) out->frame_start_us = (int64_t)fstart->valuedouble;
  const cJSON *fage = cJSON_GetObjectItem(json, "frameAgeUs");
  if (cJSON_IsNumber(fage)) out->frame_age_us = (int64_t)fage->valuedouble;
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

esp_err_t camlink_capture(const char *resolution, int jpeg_quality,
                          camlink_capture_result_t *out) {
  return camlink_capture_ch(0, resolution, jpeg_quality, CAPTURE_TIMEOUT_MS, out);
}

esp_err_t camlink_read_ch(int cam, uint32_t frame_id, uint32_t offset, uint8_t *buf,
                          size_t want, uint32_t timeout_ms, size_t *got) {
  char req_json[96];
  snprintf(req_json, sizeof req_json,
           "{\"frameId\":%lu,\"offset\":%lu,\"length\":%lu}", (unsigned long)frame_id,
           (unsigned long)offset, (unsigned long)want);
  return request(cam, NL_CMD_READ, req_json, buf, want, got, timeout_ms);
}

esp_err_t camlink_read(uint32_t frame_id, uint32_t offset, uint8_t *buf, size_t want,
                       size_t *got) {
  return camlink_read_ch(0, frame_id, offset, buf, want, DEFAULT_TIMEOUT_MS, got);
}

esp_err_t camlink_release_ch(int cam, uint32_t frame_id) {
  char req_json[48];
  snprintf(req_json, sizeof req_json, "{\"frameId\":%lu}", (unsigned long)frame_id);
  uint8_t resp[128];
  return request(cam, NL_CMD_RELEASE, req_json, resp, sizeof resp, NULL, DEFAULT_TIMEOUT_MS);
}

esp_err_t camlink_release(uint32_t frame_id) { return camlink_release_ch(0, frame_id); }
