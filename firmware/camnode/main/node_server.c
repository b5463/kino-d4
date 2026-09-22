// Node-link server: answers the P4 over UART using KDP framing with the
// node_link command namespace. Single-threaded — one request at a time is
// the link's design; the P4 correlates by sequence id.
#include "node_server.h"

#include <string.h>

#include "board_xiao_s3.h"
#include "camera.h"
#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/temperature_sensor.h"
#include "driver/uart.h"
#include "esp_attr.h"
#include "esp_chip_info.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "kdp/crc32.h"
#include "kdp/decoder.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"
#include "mbedtls/sha256.h"
#include "node_link/node_link.h"

static const char *TAG = "node_server";

#define LINK_RX_BUF 4096
#define LINK_TX_BUF 0 /* blocking writes */

/*
 * Everything one CAPTURE may spend chasing a fresh frame, including the first
 * fetch.
 *
 * The P4's product path gives a CAPTURE 4000 ms (capture.c,
 * NODE_CAPTURE_TIMEOUT_MS) and its bench default gives 12000 (cam_link.c,
 * CAPTURE_TIMEOUT_MS). Whatever this node spends has to fit the SMALLER of
 * those, with room left for the CRC over the JPEG and the cJSON print - a few
 * hundred milliseconds for 240 KB at -O2. 3000 ms leaves ~1000 ms of the
 * 4000 for that and the wire.
 *
 * Sized as a deadline rather than as a retry count because a retry count does
 * not know what a fetch costs: at esp32-camera's FB_GET_TIMEOUT of 4000 ms,
 * three retries plus the first fetch plus the discard is 20 s.
 */
#define CAPTURE_BUDGET_MS 3000

/* Second bound, for the case where fetches are fast and the sensor simply
 * never produces a frame armed after the command. Unchanged at 3; the
 * deadline above is what makes the worst case finite. */
#define FRESHNESS_RETRIES_MAX 3

/*
 * Largest offset or length a READ may name.
 *
 * The node holds exactly one JPEG in PSRAM and the biggest this sensor makes
 * at QXGA q95 is under 512 KB, so 16 MiB is far above any legitimate value.
 * It exists so a garbled or negative number is rejected as an argument
 * instead of becoming a size_t by an undefined conversion.
 */
#define READ_ARG_MAX (16 * 1024 * 1024)

static char s_session_id[16];
static const char *s_state = NL_STATE_BOOTING;

// The held frame: one capture lives in PSRAM until the P4 releases it or
// requests the next capture.
static camera_fb_t *s_fb;
/*
 * Frame ids, scoped to this boot.
 *
 * This started at 0 on every boot, so after a node reset the ids ALIASED: a
 * P4 that had reached frame 7, and a node that rebooted and reached 7 again,
 * agree on an id that names two different frames. A READ for the P4's frame 7
 * would then be answered out of the new one, and handle_release's BAD_ID
 * check - the whole point of which is that a late RELEASE must not free a
 * later frame - passes.
 *
 * The seed is the session id the P4 gets in HELLO, so the two ends are talking
 * about the same generation, and the low bits are cleared so an id is still
 * short in a log. A reboot mid-session therefore produces ids the P4 cannot
 * mistake for the ones it already holds.
 */
static uint32_t s_frame_id;

/*
 * Inbound frames only, and they are small.
 *
 * KDP_MAX_FRAME is 16402 bytes because the KDP payload cap is 16 KB, but the
 * P4 never sends the node anything of that shape. The largest request on this
 * link is READ - {"frameId":N,"offset":N,"length":N} - which cam_link.c builds
 * in a 96-byte buffer; CAPTURE with a resolution and a quality is about 50
 * bytes. 256 bytes of payload is four times the largest request and leaves
 * room for a field being added without a resize. The decoder contract
 * (decoder.h, kdp_decoder_init) is explicit that the storage may be smaller
 * than KDP_MAX_FRAME: "a smaller buffer still runs, but any frame whose total
 * size exceeds cap is resynced past like a corrupt length", and a resync shows
 * up in the STATUS counters rather than running off the end of this array.
 */
/* Plus a firmware chunk: NL_CMD_FW_CHUNK is the one request that carries
 * data, 4 bytes of offset and up to NL_FW_CHUNK_MAX of image. */
#define LINK_DECODE_PAYLOAD_MAX (NL_FW_CHUNK_MAX + 4 + 256)
static uint8_t s_decode_buf[KDP_HEADER_LEN + LINK_DECODE_PAYLOAD_MAX + KDP_CRC_LEN];
static kdp_decoder_t s_decoder;

// Reply frames: header + chunk + CRC is the largest we ever send.
static uint8_t s_tx_buf[KDP_HEADER_LEN + NL_CHUNK_MAX + KDP_CRC_LEN];

/*
 * The link's speed, and the deadline a provisional one lives under.
 *
 * s_baud is what the UART is set to now. s_baud_revert_us is non-zero while a
 * switch is unconfirmed: the first frame that decodes at the new rate clears
 * it, and the loop putting the baud back is what happens if none does. See
 * NL_CMD_SET_BAUD in node_link.h for why a link with two wires has to be able
 * to change its mind alone.
 */
static uint32_t s_baud = NL_DEFAULT_BAUD;
static int64_t s_baud_revert_us;
/* Larger than any preview-sized JPEG this sensor makes (a 320x240 frame at the
 * finder's quality is 2-8 KB), smaller than any photograph (90 KB up). */
#define NL_PREVIEW_STALE_BYTES (32 * 1024)

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

/* Replies the UART would not take. A short or failed write is why the P4 sees
 * a timeout, so it has to be visible as something other than the node being
 * slow; STATUS publishes it. */
static uint32_t s_tx_write_errors;

/* Inbound frames dropped for carrying RESPONSE/ERROR framing on a link that
 * only ever receives requests. */
static uint32_t s_rx_bad_framing;

static void send_frame(uint8_t type, uint8_t flags, uint32_t seq, const uint8_t *payload,
                       uint32_t len) {
  size_t total = kdp_encode_frame(s_tx_buf, sizeof s_tx_buf, NL_PROTOCOL_VERSION, type,
                                  flags, seq, payload, len);
  if (total == 0) {
    ESP_LOGE(TAG, "encode failed (len %lu)", (unsigned long)len);
    return;
  }
  /* The return was discarded. LINK_TX_BUF is 0, so writes are blocking and a
   * short return means the driver refused - the P4 then waits out its whole
   * budget and charges the silence to this node, with nothing on either end
   * recording that the reply was never sent. */
  const int written = uart_write_bytes(BOARD_LINK_UART_NUM, s_tx_buf, total);
  if (written < 0 || (size_t)written != total) {
    s_tx_write_errors++;
    ESP_LOGE(TAG, "uart write %d of %u B for type 0x%02x", written, (unsigned)total, type);
  }
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

/*
 * The sync edge, observed - measurement only (#165).
 *
 * The P4 pulses SYNC_OUT (200 us high) at every grouped shutter, before the
 * four capture commands go out. Until 0.4.30 no node read it. Now the rising
 * edge on BOARD_SYNC_IN is timestamped in this node's esp_timer domain and
 * counted, and the CAPTURE reply reports the last edge beside the frame's own
 * DMA-arm time. (frameStartUs - syncEdgeUs) is then comparable across nodes
 * with no shared clock, because every node measures its own frame against the
 * same physical edge.
 *
 * What the edge does NOT do: it does not start an exposure, arm the sensor, or
 * change which frame the driver hands back. The OV3660 free-runs and the
 * capture below still returns the frame in flight when the command arrives.
 * This is the instrument, not the mechanism; it exists so the spread can be
 * measured before anything is tuned.
 *
 * ISR discipline: timestamp and count, nothing else. Both are read under a
 * critical section in handle_capture so seq and edge are one snapshot. The
 * counter is the generation id the P4 attributes replies by - each grouped
 * shutter must advance it by exactly one on every node.
 */
/*
 * Dead time after an accepted edge, in which further rising edges are counted
 * but not taken as a new pulse.
 *
 * The P4 fires one 200 us pulse per grouped shutter and shutters are seconds
 * apart, so two pulses can never legitimately be 10 ms apart - SYNC_BENCH is
 * held to >= 20 ms for the same reason. Against that, the baseline measured
 * eleven extra rising edges in 733 pulses on an unterminated 28 AWG fan-out to
 * four inputs (deltas of 2, and once 4 and once 6), and never a missed one:
 * the line rings, most visibly on cam2 and cam4. 10 ms is fifty times the
 * pulse width and five hundred times any ringing, so one pulse-event becomes
 * exactly one counted edge without a component change. The raw count is kept
 * beside the accepted one so the ringing stays visible instead of being
 * silently filtered away (#165 edge audit).
 */
#define SYNC_DEADTIME_US 10000

static volatile int64_t s_sync_edge_us;   /* last ACCEPTED edge */
static volatile uint32_t s_sync_seq;      /* accepted edges: the generation id */
static volatile uint32_t s_sync_raw;      /* every rising edge the pin produced */
static volatile uint32_t s_sync_rejected; /* raw edges inside the dead time */
static bool s_sync_input_ready;
/* The ISR can run on either core, so the snapshot below needs a spinlock and
 * not just this core's interrupt mask. */
static portMUX_TYPE s_sync_mux = portMUX_INITIALIZER_UNLOCKED;

static void IRAM_ATTR sync_isr(void *arg) {
  (void)arg;
  const int64_t now = esp_timer_get_time();
  portENTER_CRITICAL_ISR(&s_sync_mux);
  s_sync_raw++;
  if (s_sync_seq == 0 || now - s_sync_edge_us >= SYNC_DEADTIME_US) {
    s_sync_edge_us = now;
    s_sync_seq++;
  } else {
    s_sync_rejected++;
  }
  portEXIT_CRITICAL_ISR(&s_sync_mux);
}

static void sync_input_init(void) {
  const gpio_config_t io = {
      .pin_bit_mask = 1ULL << BOARD_SYNC_IN,
      .mode = GPIO_MODE_INPUT,
      /* The P4 idles the line low and pulses high; an unwired input must read
       * low too, so a node with no sync wire reports no edges instead of the
       * mains hum on a floating pin. */
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_ENABLE,
      .intr_type = GPIO_INTR_POSEDGE,
  };
  if (gpio_config(&io) != ESP_OK) return;
  /* The camera driver does not own the GPIO ISR service; if something else
   * installed it first that is fine, only a real failure leaves the input
   * unarmed. IRAM so the edge is still seen while the cache is off. */
  esp_err_t err = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return;
  if (gpio_isr_handler_add(BOARD_SYNC_IN, sync_isr, NULL) != ESP_OK) return;
  s_sync_input_ready = true;
}

/* One consistent set of counters. Taken under the ISR's own spinlock, so a
 * reply can never carry a sequence from one edge and a timestamp from the
 * next. */
static void sync_snapshot(uint32_t *seq, int64_t *edge_us, uint32_t *raw, uint32_t *rejected) {
  portENTER_CRITICAL(&s_sync_mux);
  *seq = s_sync_seq;
  *edge_us = s_sync_edge_us;
  if (raw != NULL) *raw = s_sync_raw;
  if (rejected != NULL) *rejected = s_sync_rejected;
  portEXIT_CRITICAL(&s_sync_mux);
}

/* The sync counters on every reply that describes the node, so the P4 knows
 * the count before the first shutter, can hold the node to one accepted edge
 * per pulse it fired, and can see the raw edge rate underneath. */
static void add_sync_seq(cJSON *json) {
  uint32_t seq, raw, rejected;
  int64_t edge;
  sync_snapshot(&seq, &edge, &raw, &rejected);
  cJSON_AddNumberToObject(json, "syncSeq", (double)seq);
  cJSON_AddNumberToObject(json, "syncRawEdges", (double)raw);
  cJSON_AddNumberToObject(json, "syncRejected", (double)rejected);
  if (seq > 0) {
    cJSON_AddNumberToObject(json, "syncEdgeUs", (double)edge);
  } else {
    cJSON_AddNullToObject(json, "syncEdgeUs");
  }
  cJSON_AddNumberToObject(json, "syncDeadtimeUs", SYNC_DEADTIME_US);
  cJSON_AddBoolToObject(json, "syncInput", s_sync_input_ready);
}

static void fw_confirm_running(void);

static void handle_hello(uint32_t seq) {
  fw_confirm_running();
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "product", "KINO-CAMNODE");
  cJSON_AddNumberToObject(json, "protocol", NL_PROTOCOL_VERSION);
  cJSON_AddStringToObject(json, "firmware", KINO_FW_VERSION);
  /* Which OTA slot is running, for the P4's FW_QUERY and the bench. */
  {
    const esp_partition_t *run = esp_ota_get_running_partition();
    cJSON_AddStringToObject(json, "slot", run != NULL ? run->label : "");
  }
  cJSON_AddStringToObject(json, "sessionId", s_session_id);
  cJSON_AddStringToObject(json, "resetReason", reset_reason_str());
  esp_chip_info_t chip;
  esp_chip_info(&chip);
  cJSON_AddNumberToObject(json, "chipRevision", chip.revision);
  cJSON_AddNumberToObject(json, "heapKB", heap_kb());
  cJSON_AddNumberToObject(json, "psramKB", psram_kb());
  cJSON_AddNumberToObject(json, "baud", NL_DEFAULT_BAUD);
  add_sync_seq(json);
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

/**
 * Add `sensor` / `applied` to a reply: the fields the node has actually
 * written, and only those.
 *
 * The object is omitted entirely rather than filled with zeros, because every
 * field here has a meaningful zero - aeLevel 0 is the sensor's own metering
 * target, denoise 0 is denoise off - so a zeroed object would read as a set of
 * deliberate settings and end up in a photograph's META.JSON as one.
 */
static void add_sensor_object(cJSON *parent, const char *key) {
  camsensor_settings_t s;
  camsensor_applied(&s);
  if (!s.has_ae_level && !s.has_gain_ceiling && !s.has_denoise && !s.has_sharpness &&
      !s.has_quality) {
    return;
  }
  cJSON *o = cJSON_AddObjectToObject(parent, key);
  if (o == NULL) return;
  if (s.has_ae_level) cJSON_AddNumberToObject(o, "aeLevel", s.ae_level);
  if (s.has_gain_ceiling) cJSON_AddNumberToObject(o, "gainCeiling", s.gain_ceiling);
  if (s.has_denoise) cJSON_AddNumberToObject(o, "denoise", s.denoise);
  if (s.has_sharpness) cJSON_AddNumberToObject(o, "sharpness", s.sharpness);
  if (s.has_quality) cJSON_AddNumberToObject(o, "quality", s.quality);
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
  /* Replies the UART refused, and inbound frames dropped for carrying reply
   * framing. Both used to be invisible: the P4 saw a timeout either way and
   * charged it to a slow node. */
  cJSON_AddNumberToObject(json, "txWriteErrors", (double)s_tx_write_errors);
  cJSON_AddNumberToObject(json, "rxBadFraming", (double)s_rx_bad_framing);
  add_sync_seq(json);
  /* What NL_CMD_SENSOR has got into the sensor since this node booted. Absent
   * when nothing has, which is how the P4 sees that a node reset underneath
   * its change-only cache and re-sends. */
  add_sensor_object(json, "sensor");
  send_json(NL_CMD_STATUS, seq, json);
}

static void handle_sensor(uint32_t seq, cJSON *req) {
  if (!camsensor_detected()) {
    send_nack(NL_CMD_SENSOR, seq, "HARDWARE_ERROR", "No sensor detected");
    return;
  }
  /* Every field optional: an absent one leaves that knob alone. That is what
   * lets the P4 send only what changed since its last apply, so a capture with
   * nothing new to say costs no round trip at all. */
  camsensor_settings_t want;
  memset(&want, 0, sizeof want);
  const cJSON *v;
  v = cJSON_GetObjectItem(req, "aeLevel");
  if (cJSON_IsNumber(v)) {
    want.has_ae_level = true;
    want.ae_level = v->valueint;
  }
  v = cJSON_GetObjectItem(req, "gainCeiling");
  if (cJSON_IsNumber(v)) {
    want.has_gain_ceiling = true;
    want.gain_ceiling = v->valueint;
  }
  v = cJSON_GetObjectItem(req, "denoise");
  if (cJSON_IsNumber(v)) {
    want.has_denoise = true;
    want.denoise = v->valueint;
  }
  v = cJSON_GetObjectItem(req, "sharpness");
  if (cJSON_IsNumber(v)) {
    want.has_sharpness = true;
    want.sharpness = v->valueint;
  }
  v = cJSON_GetObjectItem(req, "quality");
  if (cJSON_IsNumber(v)) {
    want.has_quality = true;
    want.quality = v->valueint;
  }

  if (camsensor_apply(&want, NULL) != ESP_OK) {
    send_nack(NL_CMD_SENSOR, seq, "HARDWARE_ERROR", "Sensor did not answer");
    return;
  }

  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  /* The node's whole last-applied set, after clamping and snapping - not an
   * echo of the request. The P4 writes this into META.JSON, so a photograph
   * says what the sensor was told rather than what someone asked for. */
  add_sensor_object(json, "applied");
  send_json(NL_CMD_SENSOR, seq, json);
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
  /*
   * Photographs get a fresh frame; previews take whatever is queued.
   *
   * The driver keeps capturing, so it can already be holding a frame exposed
   * right after the last release; without this a stored capture is a picture
   * of the moment after the PREVIOUS readout (SYNC_FEASIBILITY.md, "Stale
   * frames"; confirmed on the bench). camsensor_discard_queued only fetches
   * when the driver says a frame is queued, so this costs the readout of one
   * waiting frame and never a whole empty-queue wait. It is paid only on the
   * sizes a capture is stored at: a viewfinder frame a hundred milliseconds
   * old is what a viewfinder shows anyway, and paying a frame period per
   * preview would halve its rate. A request that names no resolution is
   * treated as a photograph.
   */
  const bool preview = cJSON_IsString(res) && res->valuestring != NULL &&
                       camsensor_is_preview_resolution(res->valuestring);
  const uint32_t discard_ms = preview ? 0 : camsensor_discard_queued();
  uint32_t duration_ms = 0;
  camsensor_timing_t timing;
  /* The sync edge as it stands when this command is acted on: taken before the
   * capture so a pulse for the NEXT shutter, arriving during a slow transfer,
   * cannot be booked against this frame. */
  uint32_t sync_seq;
  int64_t sync_edge_us;
  sync_snapshot(&sync_seq, &sync_edge_us, NULL, NULL);
  const int64_t cmd_us = esp_timer_get_time();
  camera_fb_t *fb = camsensor_capture(&duration_ms, &timing);
  /*
   * A preview that comes back photograph-sized is the frame the sensor was
   * exposing when the mode changed: camsensor_set_resolution drains the
   * queue, but the buffer the DMA was filling at that moment lands after the
   * drain, at the old size. The P4 refused it by size and blinked the pane.
   * Take the next one instead, once - it is the first frame at the new size.
   */
  if (preview && fb != NULL && fb->len > NL_PREVIEW_STALE_BYTES) {
    ESP_LOGI(TAG, "preview frame is %u B, the photograph's size; taking the next", (unsigned)fb->len);
    camsensor_release(fb);
    fb = camsensor_capture(&duration_ms, &timing);
  }
  /*
   * A photograph must be armed AFTER the command that asked for it, and encoded
   * wholly under the settings that were just applied. One predicate, two
   * reasons, because the remedy for both is the same: release the frame and
   * take the next one.
   *
   * The encoding half: the sensor encodes while it free-runs, so the frame in
   * flight when NL_CMD_SENSOR rewrote quality has its bottom quantised under
   * the wrong tables (bench CAP_000611/612: valid EOI, matching CRC, bottom
   * 15% noise). discard_queued above cannot help - it drains what is FINISHED,
   * and the damaged frame finishes after the drain.
   *
   * The freshness half, added after the 0.4.37 sync baseline measured it: with
   * the live viewfinder running, 0 of 397 frames started before their own
   * shutter's sync edge; with the finder idle, 385 of 393 did. The sensor
   * streams unconditionally either way, so what differs is whether the P4's
   * preview pump has drained the one-deep frame queue by shutter time. When it
   * has not, discard_queued() drops the finished frame and the next one to
   * complete was ALREADY IN FLIGHT when the discard ran - armed before the
   * command, and by up to a frame period. One discard is one frame short of a
   * guarantee, and the missing drain was being supplied, incidentally, by
   * whether a UI happened to be asking for previews. That is not a property to
   * rest a photograph on, so the requirement moves here where it can be stated:
   * the frame must have been armed after cmd_us.
   *
   * Cost is paid only when it is owed. Finder live: the queue was already empty,
   * the first frame is fresh, no retry. Finder idle: one extra frame period
   * (~112 ms), which is what it costs to photograph the moment asked for
   * instead of the one before it. Bounded at 3 as before, so a sensor that
   * never produces a fresh frame fails rather than blocking the node. Previews
   * still skip the whole thing on purpose - a preview frame a hundred
   * milliseconds old is what a viewfinder shows anyway.
   */
  bool frame_fresh = true;
  uint32_t freshness_retries = 0;
  if (!preview) {
    const int64_t encoding_us = camsensor_encoding_changed_us();
    const int64_t must_start_after = encoding_us > cmd_us ? encoding_us : cmd_us;
    /*
     * Bounded by the CLOCK, not only by a retry count.
     *
     * This was `retry < 3` against esp32-camera's FB_GET_TIMEOUT of 4000 ms
     * per fb_get, so the worst case was the first fetch plus three retries
     * plus the discard: five fb_gets, 20 s. The P4's product path allows
     * NODE_CAPTURE_TIMEOUT_MS 4000 (capture.c) and its default allows
     * CAPTURE_TIMEOUT_MS 12000 (cam_link.c). The node could therefore spend
     * 20 s on a capture the P4 abandoned at 4, and go on holding the frame -
     * which is the state that made a camera read offline on the NEXT capture.
     *
     * A retry count cannot bound this because it does not know what a fetch
     * costs. A deadline can. CAPTURE_BUDGET_MS is the whole freshness
     * sequence; the P4's 4000 ms has to cover that plus the CRC over the JPEG
     * and the cJSON print, measured at a few hundred milliseconds for 240 KB
     * at -O2, so 3000 leaves ~1000 ms of the product path's budget for the
     * reply and the wire. The retry cap stays as a second bound for the case
     * where fetches are fast and the sensor simply never produces a fresh
     * frame.
     *
     * Do not raise the P4 side to make room here: the audit that found this
     * requires a node-side p99 before that number moves.
     */
    const int64_t deadline_us = cmd_us + (int64_t)CAPTURE_BUDGET_MS * 1000;
    while (fb != NULL && timing.frame_start_us <= must_start_after) {
      if (freshness_retries >= FRESHNESS_RETRIES_MAX) break;
      if (esp_timer_get_time() >= deadline_us) break;
      camsensor_release(fb);
      fb = camsensor_capture(&duration_ms, &timing);
      freshness_retries++;
    }
    /*
     * Whether the guarantee actually held, SAID OUT LOUD.
     *
     * The loop used to fall out after three attempts and the reply was
     * ok:true either way, with nothing set - so a photograph armed before its
     * own shutter was indistinguishable from a good one, on the wire and on
     * the card. It is still ok:true, deliberately: the frame is a real
     * photograph and throwing it away would lose the moment outright. It is
     * now labelled.
     */
    frame_fresh = fb != NULL && timing.frame_start_us > must_start_after;
    if (!frame_fresh && fb != NULL) {
      ESP_LOGW(TAG,
               "frame not fresh: DMA armed %lld us before the command, after %lu retries",
               (long long)(must_start_after - timing.frame_start_us),
               (unsigned long)freshness_retries);
    }
  }
  if (fb == NULL) {
    s_state = NL_STATE_ERROR;
    send_nack(NL_CMD_CAPTURE, seq, "HARDWARE_ERROR", "Capture failed");
    return;
  }
  /*
   * The frame is a whole JPEG, checked HERE, before the CRC is taken over it.
   *
   * Nothing on this node validated what the driver returned - no format
   * check, no SOI, no EOI, no length sanity - and the CRC below is computed
   * over whatever it was, so a partially encoded frame reached the P4 with a
   * matching checksum: "verified" truncation. The P4 checks SOI (capture.c)
   * and nothing checked EOI, which is the marker a truncated encode loses.
   *
   * NACKed rather than sent: the P4 retries a whole capture, and a frame that
   * is not a JPEG cannot be repaired downstream.
   */
  const char *bad = NULL;
  if (!camsensor_jpeg_valid(fb, &bad)) {
    ESP_LOGE(TAG, "capture rejected: %s (%u B)", bad != NULL ? bad : "invalid",
             (unsigned)fb->len);
    camsensor_release(fb);
    s_state = camsensor_detected() ? NL_STATE_READY : NL_STATE_ERROR;
    send_nack(NL_CMD_CAPTURE, seq, "JPEG_INVALID", bad != NULL ? bad : "not a whole JPEG");
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
  /* What the discard-fetch above cost. Non-zero means a stale frame WAS
   * waiting and was thrown away; zero means the queue was empty (or this was
   * a preview, which does not discard). Either way durationMs is the returned
   * frame's own cost. */
  cJSON_AddNumberToObject(json, "discardMs", discard_ms);
  /* The freshness verdict and what it cost. `frameFresh` false means this
   * frame's DMA began before the command that asked for it and the bounded
   * retry above could not get a later one - a photograph of the instant
   * before the shutter, labelled rather than hidden. Always true for a
   * preview, which does not ask for freshness. */
  cJSON_AddBoolToObject(json, "frameFresh", frame_fresh);
  cJSON_AddNumberToObject(json, "freshnessRetries", (double)freshness_retries);
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
  /*
   * The common edge, and this frame against it (#165). syncSeq is the number
   * of rising edges this node has seen since boot - the generation the P4
   * attributes this reply to. syncEdgeUs is the last one, node esp_timer, null
   * until the first edge ever arrives (a node with no sync wire says null for
   * ever, never 0). syncToCmdUs = cmd - edge: how long after the pulse this
   * command was acted on. syncToFrameUs = frameStart - edge: where this
   * frame's DMA arm sits relative to the pulse - NEGATIVE means the frame was
   * already in flight when the pulse came, which with a free-running sensor
   * is the expected case, and the P4 marks such a frame stale for timing.
   * None of these is exposure time.
   */
  cJSON_AddNumberToObject(json, "syncSeq", (double)sync_seq);
  cJSON_AddNumberToObject(json, "syncRawEdges", (double)s_sync_raw);
  if (sync_seq > 0) {
    cJSON_AddNumberToObject(json, "syncEdgeUs", (double)sync_edge_us);
    cJSON_AddNumberToObject(json, "syncToCmdUs", (double)(cmd_us - sync_edge_us));
    cJSON_AddNumberToObject(json, "syncToFrameUs", (double)(timing.frame_start_us - sync_edge_us));
  } else {
    cJSON_AddNullToObject(json, "syncEdgeUs");
    cJSON_AddNullToObject(json, "syncToCmdUs");
    cJSON_AddNullToObject(json, "syncToFrameUs");
  }
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
  /*
   * Range-checked BEFORE the cast.
   *
   * These were cast straight from valuedouble. A negative offset - or a NaN,
   * which cJSON accepts nothing of, but a garbled digit run can produce a
   * value beyond 2^32 - converts to size_t by wrapping, so `-1` became
   * 0xFFFFFFFF (or 2^64-1) and `off >= s_fb->len` then took the len=0 branch
   * by luck rather than by check. Undefined conversion is not a bounds test.
   */
  const double off_raw = offset->valuedouble;
  const double len_raw = length->valuedouble;
  if (off_raw < 0 || off_raw > (double)READ_ARG_MAX || len_raw < 0 ||
      len_raw > (double)READ_ARG_MAX) {
    send_nack(NL_CMD_READ, seq, "INVALID_ARGUMENT", "offset and length must be in range");
    return;
  }
  size_t off = (size_t)off_raw;
  size_t len = (size_t)len_raw;
  if (len > NL_CHUNK_MAX) len = NL_CHUNK_MAX;
  /* Past EOF reads return short, not an error - that zero-length reply is how
   * the P4 learns the transfer is done. Send the base pointer for it: s_fb->buf
   * + off with off past the end is a pointer outside the object, which is
   * undefined even though nothing is read through it at len 0. */
  const uint8_t *src = s_fb->buf;
  if (off >= s_fb->len) {
    len = 0;
  } else {
    if (off + len > s_fb->len) len = s_fb->len - off;
    src += off;
  }

  s_state = NL_STATE_TRANSFERRING;
  send_frame(NL_CMD_READ, KDP_FLAG_RESPONSE | KDP_FLAG_BINARY, seq, src, (uint32_t)len);
  /* Back to holding a frame. TRANSFERRING describes a chunk in flight, and
   * uart_write_bytes has returned, so leaving it set made STATUS report a
   * transfer that had finished - the last chunk of every capture left the node
   * looking busy until the next command changed the state. */
  s_state = NL_STATE_JPEG_READY;
}

static void handle_release(uint32_t seq, cJSON *req) {
  /* RELEASE carries frameId (node_link.h) and it has to be checked, the same
   * way handle_read checks it. A late RELEASE for frame N - a retry, or a
   * reply the P4 had already given up waiting for - arriving after capture
   * N+1 would otherwise free N+1, and the READ that follows answers BAD_ID on
   * a transfer that was healthy.
   *
   * Compared against s_frame_id, not against s_fb: a repeat RELEASE for the
   * frame just released names the current id with nothing held, and that is
   * the idempotent case, not an error. A request that names no frameId at all
   * keeps the old unconditional behaviour. */
  const cJSON *frame_id = cJSON_GetObjectItem(req, "frameId");
  if (cJSON_IsNumber(frame_id) && (uint32_t)frame_id->valuedouble != s_frame_id) {
    send_nack(NL_CMD_RELEASE, seq, "BAD_ID", "No such frame held");
    return;
  }
  if (s_fb != NULL) {
    camsensor_release(s_fb);
    s_fb = NULL;
  }
  s_state = camsensor_detected() ? NL_STATE_READY : NL_STATE_ERROR;
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  send_json(NL_CMD_RELEASE, seq, json);
}

/* ------------------------------------------------------------------ */
/* Firmware update over the link                                       */
/* ------------------------------------------------------------------ */

static struct {
  bool open;
  esp_ota_handle_t handle;
  const esp_partition_t *part;
  uint32_t size;
  uint32_t received;
  uint8_t want[32];
  mbedtls_sha256_context sha;
} s_fw;

static bool fw_hex32(const char *hex, uint8_t out[32]) {
  if (hex == NULL || strlen(hex) != 64) return false;
  for (int i = 0; i < 32; i++) {
    unsigned v = 0;
    for (int k = 0; k < 2; k++) {
      const char c = hex[i * 2 + k];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
      else return false;
    }
    out[i] = (uint8_t)v;
  }
  return true;
}

static void fw_drop(void) {
  if (!s_fw.open) return;
  esp_ota_abort(s_fw.handle);
  mbedtls_sha256_free(&s_fw.sha);
  s_fw.open = false;
}

/*
 * The running image is good once the P4 has spoken to it. With rollback on,
 * a new image boots in PENDING_VERIFY and is rolled back on the next reset
 * unless something confirms it; the first HELLO answered is that something,
 * because a node the P4 can talk to is a node that works.
 */
static void fw_confirm_running(void) {
  static bool done;
  if (done) return;
  done = true;
  const esp_partition_t *run = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  if (run != NULL && esp_ota_get_state_partition(run, &st) == ESP_OK &&
      st == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "new image in %s confirmed on first HELLO", run->label);
  }
}

static void handle_fw_begin(uint32_t seq, cJSON *req) {
  const cJSON *size = cJSON_GetObjectItem(req, "size");
  const cJSON *sha = cJSON_GetObjectItem(req, "sha256");
  uint8_t want[32];
  if (!cJSON_IsNumber(size) || size->valuedouble < 1 || size->valuedouble > 4.0 * 1024 * 1024) {
    send_nack(NL_CMD_FW_BEGIN, seq, "BAD_SIZE", "Image size must be 1 byte to 4 MB");
    return;
  }
  if (!cJSON_IsString(sha) || !fw_hex32(sha->valuestring, want)) {
    send_nack(NL_CMD_FW_BEGIN, seq, "INVALID_ARGUMENT", "sha256 must be 64 hex characters");
    return;
  }
  if (s_fb != NULL) {
    send_nack(NL_CMD_FW_BEGIN, seq, "BUSY", "A frame is held; release it first");
    return;
  }
  fw_drop(); /* a new BEGIN supersedes a stale session */
  const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);
  if (next == NULL) {
    send_nack(NL_CMD_FW_BEGIN, seq, "HARDWARE_ERROR",
              "No OTA slot: this node is on the single-app partition table");
    return;
  }
  const uint32_t bytes = (uint32_t)size->valuedouble;
  if (bytes > next->size) {
    send_nack(NL_CMD_FW_BEGIN, seq, "BAD_SIZE", "Image is larger than the OTA slot");
    return;
  }
  const esp_err_t err = esp_ota_begin(next, bytes, &s_fw.handle);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "esp_ota_begin: %s", esp_err_to_name(err));
    send_nack(NL_CMD_FW_BEGIN, seq, "FLASH_WRITE", "Could not open the OTA slot");
    return;
  }
  s_fw.open = true;
  s_fw.part = next;
  s_fw.size = bytes;
  s_fw.received = 0;
  memcpy(s_fw.want, want, sizeof want);
  mbedtls_sha256_init(&s_fw.sha);
  mbedtls_sha256_starts(&s_fw.sha, 0);
  ESP_LOGI(TAG, "firmware update: %lu B into %s", (unsigned long)bytes, next->label);

  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddNumberToObject(json, "chunkSize", NL_FW_CHUNK_MAX);
  cJSON_AddStringToObject(json, "slot", next->label);
  send_json(NL_CMD_FW_BEGIN, seq, json);
}

static void handle_fw_chunk(uint32_t seq, const uint8_t *payload, size_t len) {
  if (!s_fw.open) {
    send_nack(NL_CMD_FW_CHUNK, seq, "NO_SESSION", "No update session is open");
    return;
  }
  if (len < 5) {
    send_nack(NL_CMD_FW_CHUNK, seq, "INVALID_ARGUMENT", "A chunk is 4 bytes of offset and data");
    return;
  }
  const uint32_t offset = (uint32_t)payload[0] | ((uint32_t)payload[1] << 8) |
                          ((uint32_t)payload[2] << 16) | ((uint32_t)payload[3] << 24);
  const uint8_t *data = payload + 4;
  const size_t n = len - 4;
  if (offset != s_fw.received) {
    send_nack(NL_CMD_FW_CHUNK, seq, "BAD_OFFSET", "Chunks must arrive in order");
    return;
  }
  if (s_fw.received + n > s_fw.size) {
    send_nack(NL_CMD_FW_CHUNK, seq, "BAD_SIZE", "Chunk runs past the image size");
    return;
  }
  const esp_err_t err = esp_ota_write(s_fw.handle, data, n);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "esp_ota_write at %lu: %s", (unsigned long)offset, esp_err_to_name(err));
    fw_drop();
    send_nack(NL_CMD_FW_CHUNK, seq, "FLASH_WRITE", "Flash write failed");
    return;
  }
  mbedtls_sha256_update(&s_fw.sha, data, n);
  s_fw.received += (uint32_t)n;
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddNumberToObject(json, "received", (double)n);
  send_json(NL_CMD_FW_CHUNK, seq, json);
}

static void handle_fw_end(uint32_t seq) {
  if (!s_fw.open) {
    send_nack(NL_CMD_FW_END, seq, "NO_SESSION", "No update session is open");
    return;
  }
  if (s_fw.received < s_fw.size) {
    fw_drop();
    send_nack(NL_CMD_FW_END, seq, "SHORT_IMAGE", "Not every byte of the image arrived");
    return;
  }
  uint8_t got[32];
  mbedtls_sha256_finish(&s_fw.sha, got);
  if (memcmp(got, s_fw.want, sizeof got) != 0) {
    fw_drop();
    send_nack(NL_CMD_FW_END, seq, "CHECKSUM_FAILED", "SHA-256 of the received image does not match");
    return;
  }
  mbedtls_sha256_free(&s_fw.sha);
  s_fw.open = false;
  esp_err_t err = esp_ota_end(s_fw.handle);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "esp_ota_end: %s", esp_err_to_name(err));
    send_nack(NL_CMD_FW_END, seq,
              err == ESP_ERR_OTA_VALIDATE_FAILED ? "CHECKSUM_FAILED" : "FLASH_WRITE",
              err == ESP_ERR_OTA_VALIDATE_FAILED ? "Image failed validation"
                                                 : "Could not finish the OTA write");
    return;
  }
  err = esp_ota_set_boot_partition(s_fw.part);
  if (err != ESP_OK) {
    send_nack(NL_CMD_FW_END, seq, "FLASH_WRITE", "Could not select the new slot");
    return;
  }
  ESP_LOGI(TAG, "firmware verified into %s; restarting", s_fw.part->label);
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddBoolToObject(json, "verified", true);
  send_json(NL_CMD_FW_END, seq, json);
  uart_wait_tx_done(BOARD_LINK_UART_NUM, pdMS_TO_TICKS(500));
  vTaskDelay(pdMS_TO_TICKS(50));
  esp_restart();
}

static void handle_fw_abort(uint32_t seq) {
  fw_drop();
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  send_json(NL_CMD_FW_ABORT, seq, json);
}

static void handle_set_baud(uint32_t seq, const cJSON *req) {
  static const uint32_t supported[NL_BAUD_SUPPORTED_N] = NL_BAUD_SUPPORTED_LIST;
  const cJSON *want = cJSON_GetObjectItem(req, "baud");
  if (!cJSON_IsNumber(want)) {
    send_nack(NL_CMD_SET_BAUD, seq, "INVALID_ARGUMENT", "baud must be a number");
    return;
  }
  const double asked = want->valuedouble;
  uint32_t baud = 0;
  for (int i = 0; i < NL_BAUD_SUPPORTED_N; i++) {
    if (asked == (double)supported[i]) baud = supported[i];
  }
  if (baud == 0) {
    send_nack(NL_CMD_SET_BAUD, seq, "INVALID_ARGUMENT", "Unsupported baud");
    return;
  }
  /* Not while a photograph is being read out of this node: the body would be
   * mid-transfer and a rate change under it loses the frame. */
  if (s_fb != NULL) {
    send_nack(NL_CMD_SET_BAUD, seq, "BUSY", "A frame is held; release it first");
    return;
  }

  cJSON *json = cJSON_CreateObject();
  if (json == NULL) {
    send_nack(NL_CMD_SET_BAUD, seq, "INTERNAL_ERROR", "Out of memory");
    return;
  }
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddNumberToObject(json, "baud", (double)baud);
  cJSON_AddNumberToObject(json, "revertMs", (double)NL_BAUD_PROBE_MS);
  send_json(NL_CMD_SET_BAUD, seq, json);

  if (baud == s_baud) return;

  /*
   * The reply leaves at the OLD rate, and the switch waits for it.
   *
   * uart_wait_tx_done returns when the last bit has left the shift register,
   * not when the driver has accepted the bytes. Switching before that would
   * corrupt the tail of the one message that tells the body what is about to
   * happen.
   */
  uart_wait_tx_done(BOARD_LINK_UART_NUM, pdMS_TO_TICKS(500));
  if (uart_set_baudrate(BOARD_LINK_UART_NUM, baud) != ESP_OK) {
    ESP_LOGE(TAG, "baud %lu refused by the driver", (unsigned long)baud);
    return;
  }
  /* Whatever was mid-flight at the old rate is now noise. */
  uart_flush_input(BOARD_LINK_UART_NUM);
  s_baud = baud;
  s_baud_revert_us = esp_timer_get_time() + (int64_t)NL_BAUD_PROBE_MS * 1000;
  ESP_LOGI(TAG, "link at %lu baud, reverting in %d ms unless something arrives",
           (unsigned long)baud, NL_BAUD_PROBE_MS);
}

/** Put the link back on the default after a switch nothing confirmed. */
static void baud_revert_if_unconfirmed(void) {
  if (s_baud_revert_us == 0) return;
  if (esp_timer_get_time() < s_baud_revert_us) return;
  s_baud_revert_us = 0;
  if (s_baud == NL_DEFAULT_BAUD) return;
  uart_wait_tx_done(BOARD_LINK_UART_NUM, pdMS_TO_TICKS(100));
  uart_set_baudrate(BOARD_LINK_UART_NUM, NL_DEFAULT_BAUD);
  uart_flush_input(BOARD_LINK_UART_NUM);
  ESP_LOGW(TAG, "nothing arrived at %lu baud; back to %d", (unsigned long)s_baud,
           NL_DEFAULT_BAUD);
  s_baud = NL_DEFAULT_BAUD;
}

/* A frame that decoded at the current rate is the only confirmation a baud
 * switch can have on a link with two wires, so it is taken here rather than in
 * any one handler - a STATUS confirms as well as a HELLO does. */
static void on_frame(const kdp_frame_t *frame, void *ctx) {
  (void)ctx;
  if (frame->version != NL_PROTOCOL_VERSION) {
    send_nack(frame->type, frame->seq, "BAD_VERSION", "Unsupported link version");
    return;
  }
  /*
   * Requests only. The P4 is the only initiator on this link and the node
   * sends no events, so a frame arriving with RESPONSE or ERROR set is either
   * this node's own reply looped back on a miswired harness or a stray from
   * another channel. Dispatching it ran a real command - a looped-back
   * RELEASE reply would free the held frame mid-transfer.
   *
   * Silently dropped, not NACKed: answering a response with a response is how
   * a loop becomes a storm. kdp_server.c rejects the mirror case on the host
   * link for the same reason.
   */
  if ((frame->flags & (KDP_FLAG_RESPONSE | KDP_FLAG_ERROR)) != 0) {
    s_rx_bad_framing++;
    return;
  }

  /*
   * A real request, of the right version, with a CRC that checked: the only
   * confirmation a baud switch can have on a link with two wires. Taken here
   * rather than in any one handler, so a STATUS confirms as well as a HELLO
   * does - and taken after the guards above, so a looped-back reply or a
   * frame from another protocol version cannot vouch for a rate.
   */
  s_baud_revert_us = 0;

  cJSON *req = NULL;
  if (frame->payload_len > 0 && (frame->flags & KDP_FLAG_BINARY) == 0) {
    req = cJSON_ParseWithLength((const char *)frame->payload, frame->payload_len);
  }

  switch (frame->type) {
    case NL_CMD_HELLO: handle_hello(frame->seq); break;
    case NL_CMD_FW_BEGIN: handle_fw_begin(frame->seq, req); break;
    case NL_CMD_FW_CHUNK: handle_fw_chunk(frame->seq, frame->payload, frame->payload_len); break;
    case NL_CMD_FW_END: handle_fw_end(frame->seq); break;
    case NL_CMD_FW_ABORT: handle_fw_abort(frame->seq); break;
    case NL_CMD_STATUS: handle_status(frame->seq); break;
    case NL_CMD_CAPTURE: handle_capture(frame->seq, req); break;
    case NL_CMD_READ: handle_read(frame->seq, req); break;
    case NL_CMD_RELEASE: handle_release(frame->seq, req); break;
    case NL_CMD_SENSOR: handle_sensor(frame->seq, req); break;
    case NL_CMD_SET_BAUD: handle_set_baud(frame->seq, req); break;
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
     * Block in the UART driver for ONE byte, then take the rest with no wait.
     *
     * Asking for a full buffer is what this replaced: uart_read_bytes blocks
     * until `length` bytes are read or the timeout expires, so a 60-byte
     * request against a 512-byte read cost this task the whole timeout before
     * it was even seen.
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
    baud_revert_if_unconfirmed();
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
  /* Session-scoped frame ids: see s_frame_id. The session id is a random
   * string minted once per boot, so hashing it gives a per-boot base that no
   * previous boot's ids can collide with. The top bits are left clear so
   * s_frame_id++ can run for the life of a session without wrapping into
   * another session's range. */
  uint32_t seed = 0x811C9DC5u;
  for (const char *p = s_session_id; *p != '\0'; p++) {
    seed = (seed ^ (uint32_t)(unsigned char)*p) * 16777619u;
  }
  s_frame_id = (seed & 0x00FFFF00u) | 0x00000100u;

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

  /* The sync-edge witness (#165): measurement only, never in the capture path. */
  sync_input_init();
  if (!s_sync_input_ready) ESP_LOGW(TAG, "sync input GPIO%d not armed", BOARD_SYNC_IN);

  kdp_decoder_init(&s_decoder, s_decode_buf, sizeof s_decode_buf);
  s_state = camsensor_detected() ? NL_STATE_READY : NL_STATE_ERROR;

  BaseType_t ok = xTaskCreate(server_task, "node_server", 6144, NULL, 10, NULL);
  return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
