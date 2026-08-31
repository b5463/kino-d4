// Studio-facing KDP server, Milestone 1B surface. Contract rules honored
// here: never silently time out (every request gets a response or a NACK);
// capability flags and the dispatcher agree; REBOOT answers before
// restarting; HELLO tolerates a payload carrying only {nonce}; job events
// carry sequence 0 and are batched (~10%), never per unit of work.
#include "kdp_server.h"

#include <stdarg.h>
#include <stdatomic.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "bench_c6.h"
#include "cam_link.h"
#include "capture.h"
#include "viewfinder.h"
#include "clock.h"
#include <dirent.h>
#include <sys/stat.h>

#include "config_store.h"
#include "cJSON.h"
#include "gallery.h"
#include "gallery_index.h"
#include "driver/temperature_sensor.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "kdp_net.h"
#include "kdp_recipes.h"
#include "kdp_sounds.h"
#include "kdp/crc32.h"
#include "kdp/decoder.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"
#include "klog.h"
#include "meta.h"
#include "net_link.h"
#if KINO_RADIO && KINO_C6_RESET_BENCH
#include "net_hosted.h"
#endif
#include "node_link/node_link.h"
#include "power.h"
#include "pure.h"
#include "storage.h"
#include "upload_store.h"
#include "taskmon.h"
#include "usb_link.h"

static const char *TAG = "kdp_server";

static kdp_identity_t s_id;
static kdp_decoder_t s_decoder;
/* The two KDP frame buffers, KDP_MAX_FRAME (16 KiB) each. In PSRAM, not
 * internal RAM: nothing here needs DMA-capable memory (the USB-Serial-JTAG
 * driver copies into its own ring), and internal RAM is what the P4 is short
 * of - ESP-Hosted's SDIO buffers can only live there, and a radio recovery
 * has to find 16 KiB of it twice (net_hosted.c, the recovery reserve). Kept
 * static until 0.4.6, which cost 32 KiB of the scarcest memory on the board. */
static uint8_t *s_decode_buf;
static uint8_t *s_tx;
static SemaphoreHandle_t s_tx_lock;
static bool s_usb_seen; /* first decoded host frame marks USB validated */

// One capture pipeline at a time: CAMERA_TEST, STORAGE_SELF_TEST, STORAGE_BENCH
// and the soak job all contend for the camera UART, the PSRAM staging buffer
// and the SD write path - and so does the product capture in capture.c. They
// share capture_lock()/capture_unlock() (capture.h), which used to be a second
// mutex here that capture_fire() never looked at. Held for a whole soak run;
// concurrent starts, including a shutter press, get BUSY.

/* Events this device could not put on the wire, reported by GET_RUNTIME_STATS
 * as droppedLogEvents. Written from klog()'s caller - the UI task, the
 * capture workers, the radio supervisor - and from the log drain task, so
 * atomic: a plain ++ on this is a read-modify-write those tasks interleave. */
static _Atomic uint32_t s_log_dropped;

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

static uint32_t elapsed_ms(int64_t since_us) {
  return (uint32_t)((esp_timer_get_time() - since_us) / 1000);
}

/**
 * One numeric request argument, clamped to [lo, hi] before it becomes an
 * integer. `dflt` is the answer when the field is absent or not a number.
 *
 * The clamp used to run after the cast - `(long)j->valuedouble`, then a range
 * check on the long. cJSON hands back a double, and a host is free to write
 * 1e400, which parses to infinity; casting that to long is undefined, not
 * saturating. NaN takes the same path here as a value below lo.
 */
static long clamp_num(const cJSON *n, double lo, double hi, long dflt) {
  if (!cJSON_IsNumber(n)) return dflt;
  const double v = n->valuedouble;
  if (!(v >= lo)) return (long)lo; /* negated so NaN lands here too */
  if (v > hi) return (long)hi;
  return (long)v;
}

// ---- send helpers ----

/*
 * Every wait on this path is bounded, and that is the whole fix.
 *
 * RESPONSE_WRITE_TIMEOUT_MS is a response's budget on the wire. It used to be
 * portMAX_DELAY: a host that opened the port and stopped reading parked the KDP
 * task inside usb_link_write() forever, holding s_tx_lock, and the log drain
 * task then blocked in xSemaphoreTake(portMAX_DELAY) - so the event path's
 * 250 ms deadline, which exists precisely so nothing waits on a dead host,
 * could not be reached. Both tasks wedged until the cable moved.
 *
 * 1500 ms, not 250: a response is what the host asked for and is worth waiting
 * for. The USB-Serial-JTAG TX ring is 4096 bytes and a reply is now up to
 * 16 KiB in 1024-byte slices, so a host reading slowly - a debugger stepping,
 * a busy event loop - must not lose its reply to an impatient deadline. A host
 * that has taken nothing for a second and a half is not reading.
 *
 * TX_LOCK_TIMEOUT_MS is the wait for the lock itself, and it is longer than one
 * write can take so that a queued sender fails only when the holder is itself
 * failing. A response charges either give-up to s_tx_dropped; an event's
 * give-ups are counted once, by send_event(), in s_log_dropped.
 */
#define RESPONSE_WRITE_TIMEOUT_MS 1500
#define TX_LOCK_TIMEOUT_MS 2000

/* How long an event may hold the TX lock. Long enough that a host between
 * two reads never loses one, short enough that server_task's next response
 * waits a quarter second rather than until a cable is plugged back in. */
#define EVENT_WRITE_TIMEOUT_MS 250

/* RESPONSES this device could not put on the wire: the lock was held past
 * TX_LOCK_TIMEOUT_MS, or the host did not take the whole frame in time.
 * Responses only - an event that fails either way is send_event()'s to count,
 * in s_log_dropped. Reported beside it (GET_RUNTIME_STATS, droppedTxFrames)
 * because the two answer different questions and must not overlap: a dropped
 * log event costs a line in Studio's console, a dropped response is a command
 * the host will report as a timeout. */
static _Atomic uint32_t s_tx_dropped;

/* Requests and responses: the host asked, so this waits for the wire - but
 * with a deadline. A short write leaves a partial frame the host's decoder
 * resyncs past on the next KI magic (usb_link.h), which the host sees as the
 * command timing out. That is the same outcome as before for the host, and
 * unlike before it does not take the rest of the server with it. */
static void send_raw(uint8_t type, uint8_t flags, uint32_t seq, const uint8_t *payload,
                     uint32_t len) {
  if (xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(TX_LOCK_TIMEOUT_MS)) != pdTRUE) {
    atomic_fetch_add(&s_tx_dropped, 1);
    return;
  }
  size_t total = kdp_encode_frame(s_tx, KDP_MAX_FRAME, KDP_PROTOCOL_VERSION, type, flags,
                                  seq, payload, len);
  if (total > 0 &&
      usb_link_write_timeout(s_tx, total, RESPONSE_WRITE_TIMEOUT_MS) != (int)total) {
    atomic_fetch_add(&s_tx_dropped, 1);
  }
  xSemaphoreGive(s_tx_lock);
}

/**
 * One event frame, with a deadline. Returns false when the host did not take
 * all of it and the event is lost.
 *
 * The lock and the wire were both blocking: send_raw() takes s_tx_lock with
 * portMAX_DELAY and usb_link_write() waits forever on a TX FIFO nobody is
 * draining. The drain task is allowed to wait there - that is its job - but
 * it holds s_tx_lock while it does, and server_task needs the same lock to
 * answer the next request. One unplugged cable and a full FIFO wedged the
 * whole server behind an event nobody was reading.
 */
static bool send_raw_event(uint8_t evt, uint32_t seq, const uint8_t *payload, uint32_t len) {
  /* Bounded here too. The deadline on the write is no use while the wait for
   * the lock is unbounded: a response ahead of this one owns the lock for up to
   * RESPONSE_WRITE_TIMEOUT_MS, and an event that queues behind it forever is
   * the drain task stalled again, one level up. */
  if (xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(TX_LOCK_TIMEOUT_MS)) != pdTRUE) {
    /* Not charged to s_tx_dropped: send_event() counts every false return in
     * s_log_dropped, and charging both would make droppedTxFrames overlap the
     * counter it exists to be distinguished from. s_tx_dropped is responses
     * only. */
    return false;
  }
  const size_t total = kdp_encode_frame(s_tx, KDP_MAX_FRAME, KDP_PROTOCOL_VERSION, evt,
                                        KDP_FLAG_EVENT, seq, payload, len);
  bool sent = false;
  if (total > 0) sent = usb_link_write_timeout(s_tx, total, EVENT_WRITE_TIMEOUT_MS) == (int)total;
  xSemaphoreGive(s_tx_lock);
  return sent;
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
  if (!send_raw_event(evt, 0, (const uint8_t *)text, strlen(text))) {
    /* Same counter and the same trade as a full log queue: the ring in
     * klog.c still has the line, GET_LOGS still serves it, and
     * GET_RUNTIME_STATS says how many went missing on the wire. */
    atomic_fetch_add(&s_log_dropped, 1);
  }
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

/**
 * Send one kdp_net.c reply: the body on success, a NACK with its code and
 * message otherwise.
 *
 * The point of the split is that the refusals stay specific. A command that
 * needs the radio answers `NETWORK_UNAVAILABLE` naming the actual radio state
 * rather than falling through to the dispatch default's
 * `UNSUPPORTED_COMMAND` — "this firmware cannot do that" and "this body has
 * no route to its radio" send someone to different places.
 */
static void send_net(uint8_t type, uint32_t seq, kdp_net_reply_t reply) {
  if (reply.ok) {
    send_json(type, seq, reply.json); /* takes ownership */
    return;
  }
  send_nack(type, seq, reply.code, reply.message);
}

/* The same idea for the feature modules (kdp_module.h): JSON, raw bytes, or
 * a NACK, decided by the module and sent here. */
static void send_module(uint8_t type, uint32_t seq, kdp_module_reply_t reply) {
  if (!reply.ok) {
    send_nack(type, seq, reply.code, reply.message);
    return;
  }
  if (reply.json != NULL) {
    send_json(type, seq, reply.json); /* takes ownership */
    return;
  }
  send_raw(type, KDP_FLAG_RESPONSE | KDP_FLAG_BINARY, seq, reply.bytes, reply.bytes_len);
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
  clock_iso8601(stamp, sizeof stamp);
  cJSON_AddStringToObject(json, "capturedAt", stamp);
  cJSON_AddNumberToObject(json, "capturedAtMs", (double)clock_now_ms());
  cJSON_AddStringToObject(json, "clockSource", clock_source_str());
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
  strlcpy(r->err_msg, msg, sizeof r->err_msg);
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

/* Caller must hold capture_lock(). */
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
  /* snprintf, not strncpy: at -O2 GCC proves the strncpy form can leave the
   * field unterminated and -Werror=stringop-truncation stops the build. */
  snprintf(r->crc_node, sizeof r->crc_node, "%s", cap.crc32);
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
      /* Say what the link said. This used to be hardcoded TRANSFER_TIMEOUT,
       * which is a lie when the node answered BAD_ID - and it did, because a
       * viewfinder frame had replaced the frame being transferred. An hour
       * went into timeout budgets and signal integrity before the real NACK
       * surfaced from CAMERA_LINK_STATS instead of from the error itself. */
      camlink_stats_t xs;
      camlink_get_stats(&xs);
      const bool timed_out = strcmp(xs.last_error, "TIMEOUT") == 0;
      failf(r, timed_out ? "TRANSFER_TIMEOUT" : "TRANSFER_FAILED",
            "Chunk read failed at %lu/%lu B (%lu%%) after %lu ms; link reports %s",
            (unsigned long)offset, (unsigned long)cap.size,
            (unsigned long)(cap.size == 0 ? 0 : (uint64_t)offset * 100 / cap.size),
            (unsigned long)elapsed_ms(t_xfer),
            xs.last_error[0] != '\0' ? xs.last_error : "nothing");
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
  capture_uuid4(r->capture_uuid, sizeof r->capture_uuid);
  int64_t t_sd = esp_timer_get_time();
  storage_capture_t capture;
  if (storage_capture_begin(&capture, r->capture_uuid) != ESP_OK) {
    free(jpeg);
    fail(r, "SD_WRITE_FAILED", "Could not open the capture folder");
    return;
  }
  snprintf(r->capture_id, sizeof r->capture_id, "%s", capture.id);
  snprintf(r->dir, sizeof r->dir, "%s", capture.dir);
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

  /* Take the host's clock if it offered one.
   *
   * The D4 has no RTC and no network, so this is the only way it ever learns
   * the date. HELLO is the right carrier because it is the first thing every
   * host sends and the only one guaranteed to arrive before a capture can.
   * Both fields are optional and additive: a host that omits them gets the
   * same reply it always did, and the camera keeps saying its timestamps are
   * unset rather than pretending otherwise. */
  const cJSON *host_ms = cJSON_GetObjectItem(req, "hostEpochMs");
  if (cJSON_IsNumber(host_ms)) {
    const cJSON *off = cJSON_GetObjectItem(req, "hostUtcOffsetMin");
    clock_set((int64_t)host_ms->valuedouble, cJSON_IsNumber(off) ? off->valueint : 0);
  }

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "product", "KINO");
  cJSON_AddNumberToObject(json, "protocol", KDP_PROTOCOL_VERSION);
  const cJSON *nonce = cJSON_GetObjectItem(req, "nonce");
  if (cJSON_IsNumber(nonce)) cJSON_AddNumberToObject(json, "nonce", nonce->valuedouble);
  cJSON_AddStringToObject(json, "deviceId", s_id.device_id);
  cJSON_AddStringToObject(json, "sessionId", s_id.session_id);
  /* So a host can see whether its clock was taken, and whether this camera
   * needs one at all. */
  cJSON_AddStringToObject(json, "clockSource", clock_source_str());
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
  const char *flags[] = {"vsyncTelemetry", "phaseCalibration", "xiaoProxyUpdate", "linkBench"};
  for (size_t i = 0; i < sizeof flags / sizeof flags[0]; i++) {
    cJSON_AddBoolToObject(caps, flags[i], false);
  }
  /* Owned by their modules, so the flag and the handler cannot disagree:
   * each is true exactly when the module answers its commands. */
  cJSON_AddBoolToObject(caps, "recipes", kdp_recipes_capable());
  cJSON_AddBoolToObject(caps, "customSounds", kdp_sounds_capable());
  /* benchDiagnostics gates the Milestone 1B group: STORAGE_SELF_TEST,
   * CAMERA_LINK_STATS(_RESET), CAMERA_SOAK_TEST, GET_HW_VALIDATION and
   * STORAGE_BENCH. All six now have handlers - STORAGE_BENCH was the one that
   * did not, and a host trusting this flag got a NACK for it. */
  cJSON_AddBoolToObject(caps, "benchDiagnostics", true);
  /* Settings round-trip and persist as of this build. */
  cJSON_AddBoolToObject(caps, "configStore", true);
  /* Listing, inspecting, deleting and favouriting work. MEDIA_READ and
   * MEDIA_THUMB do not exist yet, so `gallery` stays false: a client that
   * needs pixels cannot get them. */
  cJSON_AddBoolToObject(caps, "mediaIndex", true);
  /* MEDIA_READ and MEDIA_THUMB return bytes now, so a client can actually
   * get pixels off the camera. */
  cJSON_AddBoolToObject(caps, "gallery", true);
  /*
   * One shutter press captures every online camera into one folder. Both modes
   * use the same four sensors and differ in how a host presents frames it
   * already has, so both are true together or not at all.
   *
   * THESE MEAN "the device supports this capture mode", NOT "the mode has been
   * hardware-validated", and the distinction is unresolved in the contract
   * rather than in this firmware.
   *
   * The roadmap (Gate C) suggested gating them behind measured exposure skew,
   * on the reasoning that a host reading `wiggle: true` may reasonably expect
   * usable wigglegrams and this body has never been shown to produce one.
   * That was checked against Studio and rejected: App.tsx and Sidebar.tsx gate
   * NAVIGATION on supports('wiggle'), so reporting false would remove the
   * Wiggle page and make working, configurable settings unreachable — a worse
   * lie than the one it was meant to fix, and a functional regression for a
   * mode the firmware genuinely implements.
   *
   * So they stay true and the ambiguity is recorded here and in
   * firmware-contract/README.md rather than papered over with an invented
   * flag. What a consumer must NOT infer from them is synchronization:
   * `vsyncTelemetry` is false, all three kino.capture skews are null with a
   * reason, and CAMERA_CAPTURE refuses `action: "timing-test"`. Those three
   * are the honest signal and they are unambiguous.
   */
  cJSON_AddBoolToObject(caps, "wiggle", true);
  cJSON_AddBoolToObject(caps, "quad", true);
  /* The control path: the flash window is held across the exposure, the mode
   * is configurable, and the window is bounded and released on every path.
   * True because the command works. BOARD_FLASH_EN is BOARD_GPIO_NONE since
   * ECN-0003 took GPIO28 for the shutter button, so the window drives no pin
   * (capture.c). */
  cJSON_AddBoolToObject(caps, "flashControl", true);
  /*
   * ...and what it drives. Additive and optional, because `flashControl` alone
   * cannot distinguish "the firmware can fire a flash" from "there is a flash
   * to fire", and today only the first is true. FLASH_EN has no P4 pin at all
   * since ECN-0003 (2026-08-30): the built-in flash is out of D4-V1 and the
   * replacement is a separate external module that does not exist yet. A host
   * that shows a flash control because flashControl is true would otherwise be
   * promising the user light that does not exist.
   *
   * Stays false until that module is fitted AND validated (M5, Gate D) - never
   * because a driver was written.
   */
  cJSON_AddBoolToObject(caps, "flashHardware", false);
  /* Idle dim/sleep and camera-bank power-down are implemented; battery
   * telemetry is not, and cannot be until the hardware carries a sense
   * divider or a gauge. Two flags, because a client that wants to show a
   * battery and a client that wants to set a sleep timeout are asking
   * different questions. */
  cJSON_AddBoolToObject(caps, "powerManagement", true);
  cJSON_AddBoolToObject(caps, "powerTelemetry", false);
  /* False on D4-V1 and not because the driver is missing: contract D11 - the
   * backlight is a plain GPIO with no PWM behind it, so body.brightness has
   * nothing to move. Studio reads this to grey its slider out instead of
   * offering a control that does nothing. */
  cJSON_AddBoolToObject(caps, "brightnessControl", false);

  /*
   * Networking and Roll. Four flags rather than two, for the same reason
   * `flashControl` and `flashHardware` are two: "the firmware can" and "the
   * hardware is reachable" are different questions, and one boolean answering
   * both is what produced the old `NETWORK: NOT FITTED` display.
   *
   *   radioFitted  — an ESP32-C6 is on the Guition carrier. It is.
   *   radioRouted  — this firmware has a transport to it. Read from net_link,
   *                  which is what NETWORK_STATUS reads, because the two used
   *                  to disagree: this said false while NETWORK_STATUS said
   *                  true on the same radio build, and Studio consumes this
   *                  one. A registered driver is the route (net_link.h), so
   *                  the default build answers false and the radio build
   *                  answers true without a second constant to keep in step.
   *
   * `network` and `roll` stay FALSE, and that is deliberate even though the
   * whole 0xa0..0xaa surface now has handlers. Studio's supports() gate is
   * fail-closed: setting these true makes Studio render the Roll and Network
   * pages and issue commands that must then refuse, so the user gets a broken
   * panel instead of an absent one. Issue #133 states the rule directly —
   * these gain the flags "only once each command answers for real", and
   * ROLL_CREATE cannot, because it is an HTTP POST to a server this body has
   * no route to.
   *
   * What the handlers being present buys in the meantime is not this flag: it
   * is that a host asking gets a specific NETWORK_UNAVAILABLE naming the radio
   * state, instead of an UNSUPPORTED_COMMAND that cannot distinguish an
   * unimplemented command from an unrouted chip.
   */
  cJSON_AddBoolToObject(caps, "radioFitted", true);
  {
    net_status_t net;
    net_link_status(&net, esp_timer_get_time() / 1000);
    cJSON_AddBoolToObject(caps, "radioRouted", net.radio_routed);
  }
  cJSON_AddBoolToObject(caps, "network", false);
  cJSON_AddBoolToObject(caps, "roll", false);
  /* Not in Studio's Capabilities interface, but it is the flag
   * supportsRollUpload() reads off the raw object, and it gates the Roll page.
   * False until a capture has actually reached a Roll from this body. */
  cJSON_AddBoolToObject(caps, "rollUpload", false);

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
  cJSON_AddStringToObject(json, "hardware", KDP_HARDWARE_REV);
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
  cJSON_AddStringToObject(json, "activeMode", config_str("mode", "wiggle"));
  cJSON_AddStringToObject(json, "activeRecipe", config_str("wiggle.recipeId", ""));
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

/**
 * Power status.
 *
 * The contract's required fields are batteryV and batteryPct, and this build
 * cannot measure either: there is no sense divider to the P4 and no fuel
 * gauge on the SW6106 carrier, so nothing in the camera knows the cell's
 * voltage. They are reported as null rather than as 0, because 0 is a number
 * a client will draw as a flat battery - a wrong reading is worse than an
 * absent one. `powerTelemetry` in GET_CAPABILITIES is false so a client can
 * know before it asks. The deviation is recorded in
 * firmware-contract/README.md.
 *
 * What IS knowable is reported: whether a host is talking to us, and where
 * the idle timeouts have got to.
 */
static void handle_power_status(uint32_t seq) {
  power_state_t p;
  power_get(&p);

  cJSON *json = cJSON_CreateObject();
  cJSON_AddNullToObject(json, "batteryV");
  cJSON_AddNullToObject(json, "batteryPct");
  cJSON_AddBoolToObject(json, "batteryMeasured", false);
  /* No way to tell a charging cell from a discharging one either, so the
   * state reports the only distinction the board supports. */
  cJSON_AddStringToObject(json, "state", p.usb_attached ? "usb" : "battery");
  cJSON_AddBoolToObject(json, "charging", false);

  /* Beyond the contract, and useful: this is the half of power management
   * that does work. */
  cJSON_AddStringToObject(json, "displayStage",
                          p.stage == POWER_AWAKE  ? "awake"
                          : p.stage == POWER_DIM ? "dim"
                                                 : "asleep");
  cJSON_AddNumberToObject(json, "idleSeconds", p.idle_s);
  cJSON_AddBoolToObject(json, "displayOn", p.display_on);
  cJSON_AddBoolToObject(json, "cameraBankPowered", p.cam_bank_on);
  send_json(KDP_CMD_GET_POWER_STATUS, seq, json);
}

/* The envelope, minus anything that is write-only. */
static cJSON *config_envelope(void) {
  cJSON *json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "schemaVersion", 1);
  cJSON_AddStringToObject(json, "device", s_id.device_id);
  cJSON_AddNumberToObject(json, "configRevision", config_revision());

  cJSON *copy = cJSON_Duplicate(config_get(), true);
  if (copy != NULL) {
    /* deviceToken is write-only by contract: it may be set, never read back,
     * and never lands in a Studio backup. What is safe to report is whether
     * one exists. */
    cJSON *roll = cJSON_GetObjectItem(copy, "roll");
    cJSON *creds = roll ? cJSON_GetObjectItem(roll, "credentials") : NULL;
    if (creds != NULL) {
      const cJSON *tok = cJSON_GetObjectItem(creds, "deviceToken");
      const bool has = cJSON_IsString(tok) && tok->valuestring && tok->valuestring[0];
      cJSON_DeleteItemFromObject(creds, "deviceToken");
      cJSON_AddBoolToObject(creds, "hasDeviceToken", has);
    }
    cJSON_AddItemToObject(json, "config", copy);
  }
  return json;
}

/**
 * What every image on this body is running.
 *
 * Read-only, and deliberately the ONLY part of the `FW_*` group that is
 * implemented: `FW_BEGIN`/`CHUNK`/`END`/`ABORT`/`STATUS`/`ROLLBACK` still fail
 * closed, because there is one `factory` partition and no OTA slots (M8). A
 * query is not an update path, and `GET_CAPABILITIES` advertises no update
 * capability, so a host cannot mistake this for one.
 *
 * It exists now because the D4 gained a sixth image. Issue #133 requires the
 * C6 slave version to be reportable alongside the P4 and the nodes: a C6
 * running a stale hosted image is a second thing that can be out of date in
 * the field, and a version model that cannot name it cannot diagnose it.
 *
 * An empty `version` means "could not read one", never version zero — a node
 * that has never answered, or a C6 with no transport to it. `state` describes
 * an update in progress, so an unreachable target is `idle`: nothing failed,
 * nothing was attempted. Reporting `error` there would send someone to
 * re-flash a chip that is merely unwired.
 */
static void handle_fw_query(uint32_t seq) {
  cJSON *json = cJSON_CreateObject();
  cJSON *targets = cJSON_AddObjectToObject(json, "targets");

  cJSON *p4 = cJSON_AddObjectToObject(targets, "p4");
  cJSON_AddStringToObject(p4, "version", KINO_FW_VERSION);
  cJSON_AddStringToObject(p4, "state", "idle");

  for (int cam = 1; cam <= 4; cam++) {
    camlink_info_t info;
    camlink_get_info_ch(cam, &info);
    char key[8];
    snprintf(key, sizeof key, "cam%d", cam);
    cJSON *t = cJSON_AddObjectToObject(targets, key);
    /* A node that has never answered reports "", not a guess. No camera node
     * has ever been connected to a P4 (HARDWARE_VALIDATION.md), so this is
     * the ordinary case rather than the exceptional one. */
    cJSON_AddStringToObject(t, "version", info.online ? info.firmware : "");
    cJSON_AddStringToObject(t, "state", "idle");
  }

  net_status_t net;
  net_link_status(&net, esp_timer_get_time() / 1000);
  cJSON *c6 = cJSON_AddObjectToObject(targets, "c6");
  cJSON_AddStringToObject(c6, "version", net.c6_version);
  cJSON_AddStringToObject(c6, "state", "idle");
  /* Additive, and the field that makes the empty version above readable: the
   * chip is fitted and this firmware has no route to it, which is neither
   * "absent" nor "broken". Without this a host sees an empty version and
   * cannot tell which. */
  cJSON_AddBoolToObject(c6, "fitted", net.radio_fitted);
  cJSON_AddBoolToObject(c6, "reachable", net.radio_routed);

  send_json(KDP_CMD_FW_QUERY, seq, json);
}

static void handle_get_config(uint32_t seq) {
  send_json(KDP_CMD_GET_CONFIG, seq, config_envelope());
}

/**
 * Merge a patch into the live config.
 *
 * A merge, not a replace: Studio sends the branch it changed, and replacing
 * would make writing one field clear every other. Not persisted here -
 * SAVE_CONFIG does that, which is what lets a client try a setting and walk
 * away without it surviving a power cycle.
 */
static void handle_set_config(uint32_t seq, const cJSON *req) {
  const cJSON *patch = cJSON_GetObjectItem(req, "config");
  if (!cJSON_IsObject(patch)) patch = req; /* a bare config object is fine too */
  if (!cJSON_IsObject(patch)) {
    send_nack(KDP_CMD_SET_CONFIG, seq, "BAD_REQUEST", "Expected a config object");
    return;
  }
  /*
   * body.name is 0..24 characters, and that limit is enforced here because
   * this is the only place it is ever written - config_merge() takes whatever
   * document it is handed by design.
   *
   * Refused rather than truncated. A camera that silently shortens the name
   * someone just typed shows a different name from the one that was saved and
   * gives the host nothing to explain it with; a NACK naming the limit is a
   * thing Studio can put next to the field.
   */
  const cJSON *body = cJSON_GetObjectItem(patch, "body");
  const cJSON *name = body ? cJSON_GetObjectItem(body, "name") : NULL;
  if (name != NULL &&
      (!cJSON_IsString(name) || name->valuestring == NULL || strlen(name->valuestring) > 24)) {
    send_nack(KDP_CMD_SET_CONFIG, seq, "BAD_REQUEST",
              "body.name is a string of at most 24 characters");
    return;
  }
  if (config_merge(patch) != ESP_OK) {
    send_nack(KDP_CMD_SET_CONFIG, seq, "BAD_REQUEST", "Config could not be merged");
    return;
  }
  klog("P4", "config set rev %lu", (unsigned long)config_revision());
  send_json(KDP_CMD_SET_CONFIG, seq, config_envelope());
}

static void handle_save_config(uint32_t seq) {
  const esp_err_t err = config_save();
  if (err == ESP_ERR_INVALID_SIZE) {
    /* The merged document no longer fits nvs_set_str's 4000-byte ceiling
     * (config_store.h). The merge is already live in RAM, so the host must
     * hear that it will not survive a reboot rather than a generic failure. */
    send_nack(KDP_CMD_SAVE_CONFIG, seq, "STORAGE_ERROR",
              "config document exceeds the 4000-byte NVS limit; not persisted");
    return;
  }
  if (err != ESP_OK) {
    send_nack(KDP_CMD_SAVE_CONFIG, seq, "STORAGE_ERROR", "NVS write failed");
    return;
  }
  send_json(KDP_CMD_SAVE_CONFIG, seq, config_envelope());
}

static void handle_reset_config(uint32_t seq) {
  if (config_reset() != ESP_OK) {
    send_nack(KDP_CMD_RESET_CONFIG, seq, "STORAGE_ERROR", "NVS write failed");
    return;
  }
  send_json(KDP_CMD_RESET_CONFIG, seq, config_envelope());
}

/**
 * The shooting modes this body knows about, and which is selected.
 *
 * `available` is false for both, and that is not a placeholder: the capture
 * pipeline does not exist in this build, so neither mode can actually be
 * shot. Selecting one is still meaningful - it is stored, it survives a
 * reboot, and it is what the camera will do the moment capture lands - so
 * the command answers rather than refusing.
 */
static void handle_get_modes(uint32_t seq) {
  static const struct {
    const char *id;
    const char *name;
  } MODES[] = {{"wiggle", "Wiggle"}, {"quad", "Quad"}};

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "active", config_str("mode", "wiggle"));
  cJSON *arr = cJSON_AddArrayToObject(json, "modes");
  for (size_t i = 0; i < sizeof MODES / sizeof MODES[0]; i++) {
    cJSON *m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "id", MODES[i].id);
    cJSON_AddStringToObject(m, "name", MODES[i].name);
    cJSON_AddBoolToObject(m, "available", false);
    cJSON_AddStringToObject(m, "unavailableReason", "No capture pipeline in this build");
    cJSON_AddItemToArray(arr, m);
  }
  send_json(KDP_CMD_GET_MODES, seq, json);
}

static void handle_set_mode(uint32_t seq, const cJSON *req) {
  const cJSON *mode = cJSON_GetObjectItem(req, "mode");
  if (!cJSON_IsString(mode) || mode->valuestring == NULL) {
    send_nack(KDP_CMD_SET_MODE, seq, "BAD_REQUEST", "Expected {\"mode\":\"wiggle\"|\"quad\"}");
    return;
  }
  if (strcmp(mode->valuestring, "wiggle") != 0 && strcmp(mode->valuestring, "quad") != 0) {
    send_nack(KDP_CMD_SET_MODE, seq, "BAD_REQUEST", "Unknown mode");
    return;
  }
  cJSON *patch = cJSON_CreateObject();
  cJSON_AddStringToObject(patch, "mode", mode->valuestring);
  const esp_err_t err = config_merge(patch);
  cJSON_Delete(patch);
  if (err != ESP_OK) {
    send_nack(KDP_CMD_SET_MODE, seq, "BAD_REQUEST", "Mode could not be stored");
    return;
  }
  klog("P4", "mode %s", mode->valuestring);
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "active", config_str("mode", "wiggle"));
  cJSON_AddNumberToObject(json, "configRevision", config_revision());
  send_json(KDP_CMD_SET_MODE, seq, json);
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/*                                                                     */
/* Captures live at /sdcard/KINO/CAPTURES/<uuid>/ with C1.JPG and       */
/* META.JSON inside, which storage.c already writes. The card is the    */
/* only index there is - no database is kept, deliberately: a card      */
/* pulled and edited on a laptop is a normal thing to do to a camera,   */
/* and an index would then be a lie that survives reboots.              */
/* ------------------------------------------------------------------ */

#define CAPTURES_DIR "/sdcard/KINO/CAPTURES"
#define MEDIA_MAX_LIST 512

/* Directory names, sorted, so paging is stable between calls. A capture id
 * sorts lexicographically the same way it sorts by time because the sequence
 * is zero-padded, so this is also newest-last. */
/*
 * When a capture was taken, straight out of its META.JSON.
 *
 * The obvious key is the directory mtime, and it does not work here: stat()
 * on both the folder and its META.JSON came back with times that sorted every
 * capture equal, so the list stayed in readdir order - which for UUID names is
 * meaningless. capturedAtMs is written by the capture itself and is visibly
 * correct in MEDIA_LIST output, so it is the key that actually orders.
 *
 * Read with a bounded fread and a strstr rather than a cJSON parse: this runs
 * once per capture on the card just to sort them, and the page a client
 * actually receives still gets a full parse. 512 bytes covers it - the key
 * sits in the first hundred or so of every META.JSON this firmware writes.
 */
static char s_taken_path[200];
static char s_taken_head[512];

static uint64_t capture_taken_ms(const char *dir_name) {
  /* .bss, same reason as media_meta above: one command at a time on one task. */
  char *const path = s_taken_path;
  snprintf(path, sizeof s_taken_path, "%s/%s/META.JSON", CAPTURES_DIR, dir_name);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return 0;
  char *const head = s_taken_head;
  const size_t got = fread(head, 1, sizeof s_taken_head - 1, f);
  fclose(f);
  head[got] = '\0';
  const char *k = strstr(head, "\"capturedAtMs\"");
  if (k == NULL) return 0;
  k = strchr(k, ':');
  if (k == NULL) return 0;
  return strtoull(k + 1, NULL, 10);
}

/**
 * Fill `names` with the newest `cap` capture directories, newest first.
 *
 * Returns how many rows were written; `*on_card` gets how many capture
 * directories the walk actually saw, which is the larger number past
 * MEDIA_MAX_LIST. The caller needs both and they are not the same figure:
 * MEDIA_LIST reports the walked count as `total` and pages over the returned
 * rows. Returning only the row count made `total` the page bound, so a card
 * holding 700 captures reported 512 and a client that trusted `total` stopped
 * asking there.
 */
static int media_scan(char (*names)[64], int cap, int *on_card) {
  *on_card = 0;
  DIR *d = opendir(CAPTURES_DIR);
  if (d == NULL) return 0;
  /*
   * Timestamps collected during the walk, not after it, so a full card can
   * evict its oldest instead of dropping whatever readdir happened to hand
   * over last. This used to stop dead at `cap`, which meant that past
   * MEDIA_MAX_LIST captures the NEWEST could be the ones omitted - the exact
   * failure the sort was added to fix. gallery.c solved the same problem the
   * same way.
   */
  uint64_t *when = calloc((size_t)cap, sizeof *when);
  int count = 0;
  int total = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (e->d_name[0] == '.') continue;
    /* The gallery's order index lives in this directory, so readdir hands it
     * back here too. Listed as a capture it would make MEDIA_LIST report one
     * more photograph than the card holds, and MEDIA_INFO on it would answer
     * with an empty summary. */
    if (gidx_is_index_file(e->d_name)) continue;
    /* Anything that will not fit is not one of ours: capture directories are
     * UUID-shaped and well under this. Skipping is better than truncating,
     * which would produce an id that maps to no directory. */
    const size_t len = strlen(e->d_name);
    if (len == 0 || len >= 64) continue;
    total++;

    if (count < cap) {
      memcpy(names[count], e->d_name, len + 1);
      if (when != NULL) when[count] = capture_taken_ms(e->d_name);
      count++;
      continue;
    }
    if (when == NULL) continue; /* no timestamps: keep the first `cap`, as before */

    const uint64_t taken = capture_taken_ms(e->d_name);
    int oldest = 0;
    for (int i = 1; i < cap; i++) {
      if (when[i] < when[oldest]) oldest = i;
    }
    if (taken > when[oldest]) {
      memcpy(names[oldest], e->d_name, len + 1);
      when[oldest] = taken;
    }
  }
  closedir(d);

  /*
   * Newest first, by directory mtime.
   *
   * This sorted by strcmp on the folder name, and the names are UUIDs, so the
   * list came back alphabetical: 007f5d03, 049c0c3e, 05089a35. A client asking
   * for the first page got the oldest pictures on the card, and a shot just
   * taken could be a hundred entries down. Sorting by name is stable and
   * meaningless; a gallery wants the last thing photographed at the top.
   *
   * capturedAtMs from each META.JSON, read with a bounded fread rather than a
   * full parse. Directory mtime was tried first and sorted everything equal.
   */

  /* Insertion sort: a card holds hundreds of captures, not millions, and this
   * avoids dragging qsort's comparator indirection in for it. Falls back to
   * name order if the mtime allocation failed - a wrong order beats no list. */
  for (int i = 1; i < count; i++) {
    char key[64];
    memcpy(key, names[i], 64);
    const uint64_t key_when = when != NULL ? when[i] : 0;
    int j = i - 1;
    /* memcpy, not snprintf: the source and destination are rows of the same
     * array, and snprintf is not defined for overlapping objects. */
    while (j >= 0 && (when != NULL ? when[j] < key_when : strcmp(names[j], key) > 0)) {
      memcpy(names[j + 1], names[j], 64);
      if (when != NULL) when[j + 1] = when[j];
      j--;
    }
    memcpy(names[j + 1], key, 64);
    if (when != NULL) when[j + 1] = key_when;
  }
  free(when);
  if (total > count) {
    klog("P4", "media list: %d captures on the card, returning the newest %d", total, count);
  }
  *on_card = total;
  return count;
}

/* Read <dir>/META.JSON. Returns NULL when absent or unparseable - a capture
 * whose metadata is gone is still listed, just with less to say about it. */
/*
 * Scratch in .bss, not on the stack.
 *
 * 160 + 1024 bytes of locals sat on the deepest branch this task has:
 * handle_media_list -> media_summary -> media_meta -> cJSON_Parse, once per
 * item for up to 100 items, with the fopen chain and cJSON's recursion on top
 * - about 3.4 KB of the 8192 this task gets. That is the same shape as the
 * frame that just overflowed the UI task's 8192 opening the gallery, so it is
 * moved for the same reason, before it becomes the same bug.
 *
 * Safe as file statics because the KDP server dispatches one command at a
 * time on one task, and nothing outside this file calls these.
 */
static char s_meta_path[160];
static char s_meta_buf[1024];

static cJSON *media_meta(const char *id) {
  char *const path = s_meta_path;
  char *const buf = s_meta_buf;
  snprintf(path, sizeof s_meta_path, "%s/%s/META.JSON", CAPTURES_DIR, id);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  const size_t got = fread(buf, 1, sizeof s_meta_buf - 1, f);
  fclose(f);
  buf[got] = '\0';
  return cJSON_Parse(buf);
}

static long media_file_size(const char *id, const char *name) {
  char path[160];
  snprintf(path, sizeof path, "%s/%s/%s", CAPTURES_DIR, id, name);
  struct stat st;
  if (stat(path, &st) != 0) return -1;
  return (long)st.st_size;
}

/* One CaptureSummary. Fields the metadata does not carry are reported as the
 * contract's own neutral values rather than guessed at. */
static cJSON *media_summary(const char *id) {
  cJSON *meta = media_meta(id);
  cJSON *item = cJSON_CreateObject();
  cJSON_AddStringToObject(item, "id", id);

  /* The META.JSON -> CaptureSummary mapping lives in meta.c so it can be
   * host-tested. This read keys the document never contained and reported
   * every capture as a wiggle at the epoch; the tests in
   * firmware/p4/host_tests now pin it. */
  meta_capture_summary(meta, item);

  long total = 0;
  static const char *FILES[4] = {"C1.JPG", "C2.JPG", "C3.JPG", "C4.JPG"};
  for (int i = 0; i < 4; i++) {
    const long sz = media_file_size(id, FILES[i]);
    if (sz > 0) total += sz;
  }
  cJSON_AddNumberToObject(item, "totalKB", (double)(total / 1024));

  if (meta) cJSON_Delete(meta);
  return item;
}

/*
 * Which files inside a capture folder a host may ask for.
 *
 * An allow-list, not a sanitiser. media_id_ok() has already pinned the id to
 * a UUID, but the file name is attacker-chosen too and "..\\" or a device
 * name on a FAT volume would walk out of the folder just as effectively.
 *
 * The names are STORAGE_CAPTURE_FILES, the same array storage.c deletes a
 * capture with. There used to be a second copy here, and a seventh file added
 * to a capture would have been written by one list and unreachable through
 * the other.
 */
static bool media_file_allowed(const char *name) {
  for (int i = 0; i < STORAGE_CAPTURE_FILE_COUNT; i++) {
    if (strcmp(name, STORAGE_CAPTURE_FILES[i]) == 0) return true;
  }
  /* The upload record beside the capture. Readable so a bench can back up and
   * audit the queue over KDP before touching it; it is not a capture file, so
   * it stays out of STORAGE_CAPTURE_FILES and out of the delete path. */
  return strcmp(name, UPLOAD_STORE_RECORD) == 0;
}

/*
 * Whether a host-supplied capture id may be pasted into a path.
 *
 * Every MEDIA_* handler builds "/sdcard/KINO/CAPTURES/<id>/..." from this
 * string. MEDIA_INFO, MEDIA_DELETE and MEDIA_FAVORITE only rejected '/', so
 * {"id":".."} named the CAPTURES directory itself and MEDIA_DELETE walked it:
 * storage_capture_delete() unlinked C1..C4.JPG and META.JSON out of the
 * parent of every capture on the card.
 *
 * So all six ask the same question, and it is the strict one the orphan sweep
 * already uses: a v4 UUID, exactly the shape storage.c writes. ".." fails it
 * on the first character. pure.c is host-tested (test_pure.c) precisely so
 * this check has a test that runs on every build.
 */
static bool media_id_ok(const char *id) { return id != NULL && pure_is_capture_dirname(id); }

/* One response carries at most this much file. KDP_MAX_PAYLOAD is 16 KB and
 * the frame's own header and CRC have to fit alongside it. */
#define MEDIA_READ_MAX 8192

/* Upper bound for a read offset. fseek() takes a long, which is 32-bit here,
 * and FAT32 caps a file at 4 GB anyway; 2^31-1 is exactly representable as a
 * double, so clamping to it cannot round past LONG_MAX on the way back. */
#define MEDIA_OFFSET_MAX 2147483647.0

/**
 * Stream bytes out of one file in a capture.
 *
 * The reply is raw file bytes with KDP_FLAG_BINARY set - no JSON envelope,
 * because a 300 KB JPEG through base64 would cost a third again in transfer
 * for nothing. The caller asked for an offset and a length, so it already
 * knows what it is looking at; a short reply means end of file. Errors come
 * back as JSON with the ERROR flag, so the two are never ambiguous.
 */
static void handle_media_read(uint32_t seq, const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  const cJSON *jfile = cJSON_GetObjectItem(req, "file");
  if (!cJSON_IsString(jid) || !media_id_ok(jid->valuestring)) {
    send_nack(KDP_CMD_MEDIA_READ, seq, "BAD_REQUEST", "Expected a capture id");
    return;
  }
  const char *file = (cJSON_IsString(jfile) && jfile->valuestring) ? jfile->valuestring : "C1.JPG";
  if (!media_file_allowed(file)) {
    send_nack(KDP_CMD_MEDIA_READ, seq, "BAD_REQUEST", "Not a file a capture contains");
    return;
  }

  const cJSON *joff = cJSON_GetObjectItem(req, "offset");
  const cJSON *jlen = cJSON_GetObjectItem(req, "length");
  const long offset = clamp_num(joff, 0, MEDIA_OFFSET_MAX, 0);
  const long length = clamp_num(jlen, 1, MEDIA_READ_MAX, MEDIA_READ_MAX);

  char path[200];
  snprintf(path, sizeof path, "%s/%s/%s", CAPTURES_DIR, jid->valuestring, file);
  FILE *f = fopen(path, "rb");
  if (f == NULL) {
    send_nack(KDP_CMD_MEDIA_READ, seq, "NOT_FOUND", "No such capture file");
    return;
  }
  if (fseek(f, offset, SEEK_SET) != 0) {
    fclose(f);
    send_nack(KDP_CMD_MEDIA_READ, seq, "BAD_REQUEST", "Offset is past the end of the file");
    return;
  }
  uint8_t *buf = malloc((size_t)length);
  if (buf == NULL) {
    fclose(f);
    send_nack(KDP_CMD_MEDIA_READ, seq, "BUSY", "Out of memory");
    return;
  }
  const size_t got = fread(buf, 1, (size_t)length, f);
  fclose(f);
  /* A zero-length reply is the honest answer for a read that starts exactly
   * at the end of the file, and is how a client knows it has everything. */
  send_raw(KDP_CMD_MEDIA_READ, KDP_FLAG_RESPONSE | KDP_FLAG_BINARY, seq, buf, got);
  free(buf);
}

/* THUMB.JPG is written at capture time, so this is a read with a fixed name
 * rather than a decode-and-scale on demand. A capture taken by firmware older
 * than this one has no thumbnail and says so instead of inventing one. */
static void handle_media_thumb(uint32_t seq, const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  if (!cJSON_IsString(jid) || !media_id_ok(jid->valuestring)) {
    send_nack(KDP_CMD_MEDIA_THUMB, seq, "BAD_REQUEST", "Expected a capture id");
    return;
  }
  char path[200];
  snprintf(path, sizeof path, "%s/%s/THUMB.JPG", CAPTURES_DIR, jid->valuestring);
  FILE *f = fopen(path, "rb");
  if (f == NULL) {
    send_nack(KDP_CMD_MEDIA_THUMB, seq, "NOT_FOUND",
              "This capture has no thumbnail; read C1.JPG instead");
    return;
  }
  const cJSON *joff = cJSON_GetObjectItem(req, "offset");
  const cJSON *jlen = cJSON_GetObjectItem(req, "length");
  const long offset = clamp_num(joff, 0, MEDIA_OFFSET_MAX, 0);
  const long length = clamp_num(jlen, 1, MEDIA_READ_MAX, MEDIA_READ_MAX);
  if (fseek(f, offset, SEEK_SET) != 0) {
    fclose(f);
    send_nack(KDP_CMD_MEDIA_THUMB, seq, "BAD_REQUEST", "Offset is past the end of the file");
    return;
  }
  uint8_t *buf = malloc((size_t)length);
  if (buf == NULL) {
    fclose(f);
    send_nack(KDP_CMD_MEDIA_THUMB, seq, "BUSY", "Out of memory");
    return;
  }
  const size_t got = fread(buf, 1, (size_t)length, f);
  fclose(f);
  send_raw(KDP_CMD_MEDIA_THUMB, KDP_FLAG_RESPONSE | KDP_FLAG_BINARY, seq, buf, got);
  free(buf);
}

static void handle_media_list(uint32_t seq, const cJSON *req) {
  storage_status_t sd;
  storage_get_status(&sd);
  if (!sd.mounted) {
    send_nack(KDP_CMD_MEDIA_LIST, seq, "NO_CARD", "No card mounted");
    return;
  }

  const cJSON *jc = cJSON_GetObjectItem(req, "cursor");
  const cJSON *jl = cJSON_GetObjectItem(req, "limit");
  const int cursor = (int)clamp_num(jc, 0, MEDIA_MAX_LIST, 0);
  /* 100 is maxGalleryPageSize in GET_CAPABILITIES. */
  const int limit = (int)clamp_num(jl, 1, 100, 50);

  char (*names)[64] = calloc(MEDIA_MAX_LIST, 64);
  if (names == NULL) {
    send_nack(KDP_CMD_MEDIA_LIST, seq, "BUSY", "Out of memory");
    return;
  }
  int on_card = 0;
  const int listable = media_scan(names, MEDIA_MAX_LIST, &on_card);

  cJSON *json = cJSON_CreateObject();
  /* `total` is what is on the card. Paging runs over the newest
   * MEDIA_MAX_LIST of those, so hasMore and nextCursor are bounded by
   * `listable` — pointing a cursor past it would page into nothing. */
  cJSON_AddNumberToObject(json, "total", on_card);
  cJSON *items = cJSON_AddArrayToObject(json, "items");
  int sent = 0;
  for (int i = cursor; i < listable && sent < limit; i++, sent++) {
    cJSON_AddItemToArray(items, media_summary(names[i]));
  }
  const int next = cursor + sent;
  if (next < listable) cJSON_AddNumberToObject(json, "nextCursor", next);
  else cJSON_AddNullToObject(json, "nextCursor");
  cJSON_AddBoolToObject(json, "hasMore", next < listable);
  free(names);
  send_json(KDP_CMD_MEDIA_LIST, seq, json);
}

static void handle_media_info(uint32_t seq, const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  if (!cJSON_IsString(jid) || !media_id_ok(jid->valuestring)) {
    send_nack(KDP_CMD_MEDIA_INFO, seq, "BAD_REQUEST", "Expected a capture id");
    return;
  }
  const char *id = jid->valuestring;

  char dir[160];
  snprintf(dir, sizeof dir, "%s/%s", CAPTURES_DIR, id);
  struct stat st;
  if (stat(dir, &st) != 0) {
    send_nack(KDP_CMD_MEDIA_INFO, seq, "NOT_FOUND", "No such capture");
    return;
  }

  cJSON *json = media_summary(id);
  cJSON *files = cJSON_AddArrayToObject(json, "files");
  static const char *FILES[4] = {"C1.JPG", "C2.JPG", "C3.JPG", "C4.JPG"};
  for (int i = 0; i < 4; i++) {
    const long sz = media_file_size(id, FILES[i]);
    if (sz < 0) continue;
    cJSON *f = cJSON_CreateObject();
    cJSON_AddStringToObject(f, "name", FILES[i]);
    cJSON_AddNumberToObject(f, "sizeBytes", (double)sz);
    /* sha256 is in the contract and is not computed here: hashing four
     * multi-megabyte JPEGs on request would block the link for seconds. The
     * field is omitted rather than filled with a wrong or empty digest. */
    cJSON_AddItemToArray(files, f);
  }
  cJSON *meta = media_meta(id);
  if (meta) cJSON_AddItemToObject(json, "meta", meta);
  send_json(KDP_CMD_MEDIA_INFO, seq, json);
}

static void handle_media_delete(uint32_t seq, const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  if (!cJSON_IsString(jid) || !media_id_ok(jid->valuestring)) {
    send_nack(KDP_CMD_MEDIA_DELETE, seq, "BAD_REQUEST", "Expected a capture id");
    return;
  }
  char dir[160];
  snprintf(dir, sizeof dir, "%s/%s", CAPTURES_DIR, jid->valuestring);
  struct stat st;
  if (stat(dir, &st) != 0) {
    send_nack(KDP_CMD_MEDIA_DELETE, seq, "NOT_FOUND", "No such capture");
    return;
  }
  storage_capture_delete(dir);
  /* Told, after the delete and only after it. The gallery's order index would
   * otherwise still name this capture, and the first evidence would be a tile
   * that cannot find its META.JSON - which costs a full rebuild of the order.
   * Non-blocking, so it is safe on the KDP server task; the mutation happens
   * on the gallery task. */
  gallery_note_removed(jid->valuestring);
  klog("P4", "media delete %s", jid->valuestring);
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "id", jid->valuestring);
  cJSON_AddBoolToObject(json, "deleted", true);
  send_json(KDP_CMD_MEDIA_DELETE, seq, json);
}

/* Favourite is a flag inside META.JSON, so it travels with the capture when
 * the card is moved - which is the whole point of keeping no index.
 *
 * The read and the rewrite live here rather than inside the command handler
 * because the body's photograph screen sets the same flag (issue #144) and two
 * implementations of "rewrite META.JSON with favorite flipped" is one too
 * many. This file already owns media_meta() and the CAPTURES_DIR path, so
 * moving them into gallery.c would have dragged that with them.
 *
 * BOTH REQUIRE THE CALLER TO HOLD THE CARD, storage_acquire(STORAGE_USER_UI).
 * That is not only about the SD bus: media_meta() parses into file statics
 * that are safe precisely because every path that touches them holds the one
 * card mutex. The KDP side gets that from with_card(); the UI side takes it
 * around the call.
 */
esp_err_t media_favorite_set(const char *id, bool fav) {
  if (id == NULL || !media_id_ok(id)) return ESP_ERR_INVALID_ARG;
  cJSON *meta = media_meta(id);
  if (meta == NULL) return ESP_ERR_NOT_FOUND;

  cJSON_DeleteItemFromObject(meta, "favorite");
  cJSON_AddBoolToObject(meta, "favorite", fav);

  char path[160];
  snprintf(path, sizeof path, "%s/%s/META.JSON", CAPTURES_DIR, id);
  char *text = cJSON_PrintUnformatted(meta);
  cJSON_Delete(meta);
  if (text == NULL) return ESP_ERR_NO_MEM;

  FILE *f = fopen(path, "wb");
  if (f == NULL) {
    cJSON_free(text);
    return ESP_FAIL;
  }
  const size_t len = strlen(text);
  const size_t wrote = fwrite(text, 1, len, f);
  const int closed = fclose(f);
  cJSON_free(text);
  /* Checked, unlike the version this replaced. A short write leaves a
   * truncated META.JSON, which is a capture whose mode, frame count and label
   * all disappear from the gallery - a far worse outcome than a favourite that
   * did not stick, and it used to be reported as success. */
  if (wrote != len || closed != 0) return ESP_FAIL;
  return ESP_OK;
}

static void handle_media_favorite(uint32_t seq, const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  const cJSON *jfav = cJSON_GetObjectItem(req, "favorite");
  if (!cJSON_IsString(jid) || !media_id_ok(jid->valuestring) || !cJSON_IsBool(jfav)) {
    send_nack(KDP_CMD_MEDIA_FAVORITE, seq, "BAD_REQUEST", "Expected {id, favorite}");
    return;
  }
  const char *id = jid->valuestring;
  const bool fav = cJSON_IsTrue(jfav);
  const esp_err_t err = media_favorite_set(id, fav);
  if (err == ESP_ERR_NOT_FOUND) {
    send_nack(KDP_CMD_MEDIA_FAVORITE, seq, "NOT_FOUND", "No metadata for that capture");
    return;
  }
  if (err == ESP_ERR_NO_MEM) {
    send_nack(KDP_CMD_MEDIA_FAVORITE, seq, "STORAGE_ERROR", "Out of memory");
    return;
  }
  if (err != ESP_OK) {
    send_nack(KDP_CMD_MEDIA_FAVORITE, seq, "STORAGE_ERROR", "Could not rewrite META.JSON");
    return;
  }

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "id", id);
  cJSON_AddBoolToObject(json, "favorite", fav);
  send_json(KDP_CMD_MEDIA_FAVORITE, seq, json);
}

/** One measured pass, as additive detail alongside the contract fields. */
static void bench_pass_json(cJSON *dst, const storage_bench_pass_t *p) {
  cJSON_AddNumberToObject(dst, "bytes", p->bytes);
  cJSON_AddNumberToObject(dst, "writeMs", p->write_ms);
  cJSON_AddNumberToObject(dst, "readMs", p->read_ms);
  cJSON_AddNumberToObject(dst, "writeBytesPerSec", p->write_bytes_per_sec);
  cJSON_AddNumberToObject(dst, "readBytesPerSec", p->read_bytes_per_sec);
  /* CRCs as hex strings, the same convention the capture path uses for
   * checksums, so a mismatch can be compared by eye against a capture. */
  char hex[12];
  snprintf(hex, sizeof hex, "%08lx", (unsigned long)p->crc_written);
  cJSON_AddStringToObject(dst, "crc32Written", hex);
  snprintf(hex, sizeof hex, "%08lx", (unsigned long)p->crc_read);
  cJSON_AddStringToObject(dst, "crc32Read", hex);
  cJSON_AddBoolToObject(dst, "crcMatch", p->crc_match);
  cJSON_AddNumberToObject(dst, "chunkBytes", p->chunk_bytes);
  cJSON_AddNumberToObject(dst, "chunks", p->chunks);
  cJSON_AddNumberToObject(dst, "worstWriteChunkUs", p->worst_write_chunk_us);
  cJSON_AddNumberToObject(dst, "bestWriteChunkUs", p->best_write_chunk_us);
  cJSON_AddNumberToObject(dst, "meanWriteChunkUs", p->mean_write_chunk_us);
  cJSON_AddNumberToObject(dst, "p95WriteChunkUs", p->p95_write_chunk_us);
}

/**
 * STORAGE_BENCH (0x4c) — sustained throughput and per-block write latency.
 *
 * `benchDiagnostics` has advertised this command since Milestone 1B while the
 * dispatcher had no handler for it, so a host that trusted the flag got a
 * NACK. That is the one state the contract forbids: advertised-but-unsupported.
 *
 * The response carries the five fields StorageBenchResult requires
 * (writeMBs, readMBs, worstBlockMs, p95BlockMs, bytes) from the sustained run,
 * plus additive optional detail. No required field changed shape or unit.
 */
static void handle_storage_bench(uint32_t seq, const cJSON *req) {
  /* Shares the capture lock with CAMERA_TEST and the soak run: a megabyte of
   * card traffic during a capture would corrupt both measurements. */
  if (!capture_lock(0)) {
    send_nack(KDP_CMD_STORAGE_BENCH, seq, "BUSY", "A capture or soak run is active");
    return;
  }

  /* StorageBenchRequest: sizeMB, blockKB, passes. sizeMB is the contract's
   * unit; sizeKB is accepted additionally so a caller can ask for the 64 KiB
   * size STORAGE_SELF_TEST uses, which a whole number of megabytes cannot
   * express. Absent means the defaults storage_bench() documents. */
  const cJSON *jsize_mb = cJSON_GetObjectItem(req, "sizeMB");
  const cJSON *jsize_kb = cJSON_GetObjectItem(req, "sizeKB");
  const cJSON *jblock = cJSON_GetObjectItem(req, "blockKB");
  const cJSON *jpasses = cJSON_GetObjectItem(req, "passes");

  uint32_t size_kb = 0;
  if (cJSON_IsNumber(jsize_kb) && jsize_kb->valuedouble > 0) {
    size_kb = (uint32_t)jsize_kb->valuedouble;
  } else if (cJSON_IsNumber(jsize_mb) && jsize_mb->valuedouble > 0) {
    size_kb = (uint32_t)(jsize_mb->valuedouble * 1024.0);
  }
  const uint32_t block_kb = cJSON_IsNumber(jblock) ? (uint32_t)jblock->valuedouble : 0;
  const uint32_t passes = cJSON_IsNumber(jpasses) ? (uint32_t)jpasses->valuedouble : 0;

  storage_bench_result_t r;
  storage_bench(size_kb, block_kb, passes, &r);
  capture_unlock();

  if (!r.ok) {
    /* The failing phase is the diagnostic. "Slow" and "did not finish" are
     * different problems and a bare BENCH_FAILED conflates them. */
    char msg[96];
    snprintf(msg, sizeof msg, "Benchmark stopped at %s after %lu ms",
             storage_bench_phase_str(r.failed_phase), (unsigned long)r.total_ms);
    send_nack(KDP_CMD_STORAGE_BENCH, seq, storage_bench_phase_str(r.failed_phase), msg);
    return;
  }

  /* A verified round trip on this card, at a megabyte rather than 64 KB. */
  hwv_mark_validated(HWV_SD_LDO_CH4, "bench read-back CRC verified");

  cJSON *json = cJSON_CreateObject();

  /* ---- StorageBenchResult, exactly as typed ---- */
  const storage_bench_pass_t *s = &r.sustained;
  /* MB/s as the contract names it. Computed from bytes and milliseconds rather
   * than from the bytes-per-sec figure, so the two cannot drift. */
  const double write_mbs =
      s->write_ms > 0 ? ((double)s->bytes / 1048576.0) / ((double)s->write_ms / 1000.0) : 0.0;
  const double read_mbs =
      s->read_ms > 0 ? ((double)s->bytes / 1048576.0) / ((double)s->read_ms / 1000.0) : 0.0;
  cJSON_AddNumberToObject(json, "writeMBs", write_mbs);
  cJSON_AddNumberToObject(json, "readMBs", read_mbs);
  /* worstBlockMs / p95BlockMs are milliseconds per the contract, measured in
   * microseconds and converted here. Sub-millisecond blocks therefore report
   * as fractional rather than as zero — a card whose worst block is 400 us
   * should not read as 0. */
  cJSON_AddNumberToObject(json, "worstBlockMs", (double)s->worst_write_chunk_us / 1000.0);
  cJSON_AddNumberToObject(json, "p95BlockMs", (double)s->p95_write_chunk_us / 1000.0);
  cJSON_AddNumberToObject(json, "bytes", s->bytes);

  /* ---- additive, optional ---- */
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddNullToObject(json, "failedPhase");
  cJSON_AddNumberToObject(json, "passes", r.passes);
  cJSON_AddNumberToObject(json, "totalMs", r.total_ms);
  cJSON_AddBoolToObject(json, "cleanupOk", r.cleanup_ok);
  bench_pass_json(cJSON_AddObjectToObject(json, "sustained"), &r.sustained);
  /* The 64 KiB run, directly comparable with STORAGE_SELF_TEST on this card. */
  bench_pass_json(cJSON_AddObjectToObject(json, "small"), &r.small);

  send_json(KDP_CMD_STORAGE_BENCH, seq, json);
}

static void handle_storage_self_test(uint32_t seq) {
  if (!capture_lock(0)) {
    send_nack(KDP_CMD_STORAGE_SELF_TEST, seq, "BUSY", "A capture or soak run is active");
    return;
  }
  storage_selftest_result_t result;
  storage_self_test(&result);
  capture_unlock();

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
  /* The viewfinder's own rate on this channel, tenths of a frame per second.
   * Every preview frame is a capture, a chunked read and a release over this
   * UART, so the finder's frame rate IS a link measurement and belongs here
   * rather than in a UI-only counter nothing outside the device can read. */
  cJSON_AddNumberToObject(json, "viewfinderFpsX10", viewfinder_fps_x10(index));
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
/*
 * The LOG event path, and why it has a queue in it.
 *
 * klog() is called from the UI task once a second, from the capture workers,
 * from the radio supervisor - from everything. It used to hand the event
 * straight to send_raw(), which takes the TX lock with portMAX_DELAY and then
 * calls usb_serial_jtag_write_bytes() with portMAX_DELAY. When no host is
 * draining USB-Serial-JTAG the TX FIFO fills and every one of those tasks
 * stops on the wire, for as long as nobody is listening. Measured on
 * KD4-D121BC: the UI watchdog reporting STALLED from 16 s uptime, and 17-22 s
 * gaps between consecutive klog() calls on the radio supervisor that looked,
 * on the coprocessor's console, like the transport pausing between RPCs.
 *
 * So the caller now does one non-blocking queue send and returns. A drain
 * task at low priority owns the wire. When the queue is full the event is
 * dropped and counted - the local ring in klog.c still has it, GET_LOGS still
 * serves it, and GET_RUNTIME_STATS says how many external events went
 * missing. Losing an event on a link nobody is reading is the correct trade;
 * stalling the shutter is not.
 *
 * The queue alone did not finish the job. The drain task took s_tx_lock and
 * then waited on the TX FIFO with portMAX_DELAY, so it could sit there
 * forever holding the lock server_task needs to answer a request: the tasks
 * calling klog() were free, but the one host that WAS talking to us got no
 * reply. The event write is therefore bounded at EVENT_WRITE_TIMEOUT_MS
 * (send_raw_event above) and a short write drops the event into the same
 * counter. The cost is a truncated frame on the wire, which the host decoder
 * resyncs past on the next magic.
 *
 * Responses kept the unbounded write for a while longer, on the argument that a
 * request with no answer is the one failure the contract forbids. That argument
 * was wrong by one step: an unbounded response write holds s_tx_lock, and the
 * drain task's 250 ms deadline is unreachable behind a lock taken with
 * portMAX_DELAY - so one host that stopped reading stalled both tasks anyway,
 * and the unanswered request happened regardless. Responses are now bounded at
 * RESPONSE_WRITE_TIMEOUT_MS with the lock bounded at TX_LOCK_TIMEOUT_MS, six
 * times the event budget, so a slow-but-real host still gets its reply.
 */
typedef struct {
  int64_t t_ms;
  int64_t t_us;
  char src[6];
  char msg[96]; /* KLOG_MSG_MAX */
} log_evt_t;

#define LOG_EVT_QUEUE_LEN 32
static QueueHandle_t s_log_q;

static void log_drain_task(void *arg) {
  (void)arg;
  log_evt_t e;
  for (;;) {
    if (xQueueReceive(s_log_q, &e, portMAX_DELAY) != pdTRUE) continue;
    cJSON *json = cJSON_CreateObject();
    /* `t` keeps its contract meaning: epoch milliseconds, wall clock. `us` is
     * additive - monotonic microseconds since boot, for ordering events that
     * land inside the same millisecond. See klog.h on why there are two. */
    cJSON_AddNumberToObject(json, "t", (double)e.t_ms);
    cJSON_AddNumberToObject(json, "us", (double)e.t_us);
    cJSON_AddStringToObject(json, "src", e.src);
    cJSON_AddStringToObject(json, "msg", e.msg);
    send_event(KDP_EVT_LOG, json);
  }
}

static void log_emitter(int64_t t_ms, int64_t t_us, const char *src, const char *msg) {
  if (s_log_q == NULL) return;
  log_evt_t e = {.t_ms = t_ms, .t_us = t_us};
  strlcpy(e.src, src, sizeof e.src);
  strlcpy(e.msg, msg, sizeof e.msg);
  if (xQueueSend(s_log_q, &e, 0) != pdTRUE) {
    atomic_fetch_add(&s_log_dropped, 1);
  }
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
  /* Internal RAM is the scarce one: ESP-Hosted's DMA buffers, the SDMMC
   * driver and every ISR-touched buffer live there, and on the P4 the PSRAM
   * heap carries no MALLOC_CAP_DMA. The largest DMA-capable block is what a
   * radio recovery has to find (net_hosted.c, the recovery reserve). */
  cJSON_AddNumberToObject(json, "internalFreeKB",
                          (double)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024));
  cJSON_AddNumberToObject(json, "internalMinFreeKB",
                          (double)(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL) / 1024));
  cJSON_AddNumberToObject(json, "largestInternalDmaKB",
                          (double)(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA) / 1024));
  /* The node scheduler (cam_sched.h): how often maintenance ran, how often it
   * stood aside for a capture, how often a capture waited for a probe to end.
   * Additive; the bench reads them to prove discovery keeps running. */
  {
    uint32_t probes_run = 0, probes_deferred = 0, capture_waits = 0;
    capture_sched_stats(&probes_run, &probes_deferred, &capture_waits);
    cJSON_AddNumberToObject(json, "probesRun", probes_run);
    cJSON_AddNumberToObject(json, "probesDeferred", probes_deferred);
    cJSON_AddNumberToObject(json, "captureProbeWaits", capture_waits);
  }

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
  /* Events this device could not deliver: no room in the queue, or the host
   * did not take the frame inside EVENT_WRITE_TIMEOUT_MS. Both mean nobody
   * was draining the link. Nonzero is not a fault; it is the price of the UI
   * and the request path not stalling behind it. */
  cJSON_AddNumberToObject(protocol, "droppedLogEvents",
                          (double)atomic_load(&s_log_dropped));
  /* Frames that never reached the wire: the TX lock was held past
   * TX_LOCK_TIMEOUT_MS, or the host did not take a whole frame inside its
   * write deadline. Responses count here, so nonzero means a host somewhere
   * saw a command time out - which is why it is not folded into
   * droppedLogEvents above. */
  cJSON_AddNumberToObject(protocol, "droppedTxFrames",
                          (double)atomic_load(&s_tx_dropped));

  /*
   * Per-task stack headroom, additive and optional.
   *
   * Thirteen long-lived tasks carry hand-chosen stack sizes that have never
   * been measured, and the 500-capture soak in M1 is exactly the workload that
   * would find one of them short. Cheap to expose now; expensive to discover
   * as a stack-overflow panic mid-soak.
   *
   * `minFreeBytes` is BYTES on this target and the unit is derived, not
   * assumed: uxTaskGetStackHighWaterMark() divides its byte count by
   * sizeof(StackType_t), and the ESP-IDF RISC-V port defines
   * portSTACK_TYPE as uint8_t, so that division is by one. FreeRTOS's own
   * header says "words" - true on ports where StackType_t is wider. See
   * taskmon.h.
   *
   * It is the MINIMUM FREE space the task has ever had, not the amount used.
   * Small is bad.
   */
  taskmon_row_t rows[TASKMON_MAX];
  const int rows_n = taskmon_snapshot(rows, TASKMON_MAX);
  cJSON *tasks = cJSON_AddArrayToObject(json, "tasks");
  for (int i = 0; i < rows_n; i++) {
    cJSON *t = cJSON_CreateObject();
    cJSON_AddStringToObject(t, "name", rows[i].name);
    if (rows[i].measured) {
      cJSON_AddNumberToObject(t, "minFreeBytes", rows[i].min_free_bytes);
    } else {
      /* Registered but no handle retained: the row exists and says it has no
       * measurement rather than reporting a plausible zero. */
      cJSON_AddNullToObject(t, "minFreeBytes");
    }
    /* Present only when true: a one-shot task that has finished, whose number
     * is its last reading rather than a live one. Emitting it for every row
     * would put a false on sixteen long-lived tasks to describe one. */
    if (rows[i].exited) cJSON_AddBoolToObject(t, "exited", true);
    cJSON_AddItemToArray(tasks, t);
  }
  cJSON_AddNumberToObject(json, "tasksUnmeasured", taskmon_unmeasured());

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
        } else if (!capture_lock(100)) {
          status = "skip";
          snprintf(detail, sizeof detail, "capture busy");
        } else {
          storage_selftest_result_t st;
          storage_self_test(&st);
          capture_unlock();
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

/**
 * Take the picture the product exists to take.
 *
 * This blocks the dispatcher for as long as the slowest link needs, the same
 * way CAMERA_TEST does, because there is nothing useful to answer in the
 * meantime and an async job would mean a second protocol for the one command
 * every host issues.
 *
 * A capture the shutter started is already running when this arrives; saying
 * BUSY is right, because the alternative is two photographs of a moment
 * someone asked to photograph once.
 */
static void handle_camera_capture(uint32_t seq, cJSON *req) {
  /* CAMERA_CAPTURE carries an action. `timing-test` asks for the three skews
   * in one synchronized capture, and this body cannot measure any of them:
   * the nodes expose when their command arrives rather than on the trigger
   * edge, and their rolling shutters free-run. Taking a photograph and
   * returning made-up microseconds would be far worse than saying no - the
   * numbers would be filed as evidence. `vsyncTelemetry: false` says the same
   * thing in GET_CAPABILITIES; this is what happens if a client asks anyway. */
  const cJSON *action = cJSON_GetObjectItem(req, "action");
  if (cJSON_IsString(action) && action->valuestring != NULL &&
      strcmp(action->valuestring, "timing-test") == 0) {
    send_nack(KDP_CMD_CAMERA_CAPTURE, seq, "UNSUPPORTED_COMMAND",
              "No exposure timing on this body: nodes fire on command arrival, not the "
              "trigger edge, and the shutters free-run");
    return;
  }

  capture_report_t r;
  const esp_err_t err = capture_fire("host", &r);
  if (err == ESP_ERR_INVALID_STATE) {
    send_nack(KDP_CMD_CAMERA_CAPTURE, seq, "BUSY", "A capture is already running");
    return;
  }
  if (!r.ok) {
    send_nack(KDP_CMD_CAMERA_CAPTURE, seq, r.err_code, r.err_msg);
    return;
  }

  cJSON *json = cJSON_CreateObject();
  /* `ok` first, because that is the whole reply as far as the established
   * contract is concerned; everything after it is additive. Unlike the
   * reference mock this answers when the frames are on the card rather than
   * when the capture starts - a host-triggered shot that acks before it is
   * stored has told the host something it does not yet know. EVT_CAPTURE
   * still fires, for the hosts that only listen. */
  cJSON_AddBoolToObject(json, "ok", true);
  capture_meta_json(&r, json);
  cJSON_AddStringToObject(json, "dir", r.dir);
  cJSON_AddNumberToObject(json, "bytes", r.bytes);
  cJSON_AddNumberToObject(json, "totalMs", r.total_ms);
  cJSON_AddNumberToObject(json, "camerasOnline", r.online);
  /* Gate F: the shutter's view of the rest of the body. Additive, reply-only;
   * META.JSON does not carry it. */
  cJSON *bench = cJSON_CreateObject();
  cJSON_AddNumberToObject(bench, "sdWaitMs", r.sd_wait_ms);
  cJSON_AddNumberToObject(bench, "probeWaitMs", r.probe_wait_ms);
  cJSON_AddStringToObject(bench, "radioState", r.radio_state);
  cJSON_AddStringToObject(bench, "radioDetail", r.radio_detail);
  cJSON_AddBoolToObject(bench, "uploadActive", r.upload_active);
  cJSON_AddNumberToObject(bench, "uploadPending", r.upload_pending);
  cJSON_AddNumberToObject(bench, "internalFreeKB", r.internal_free_kb);
  cJSON_AddNumberToObject(bench, "largestDmaKB", r.largest_dma_kb);
  cJSON_AddNumberToObject(bench, "lockYields", r.lock_yields);
  cJSON_AddNumberToObject(bench, "lockTimeouts", r.lock_timeouts);
  cJSON_AddNumberToObject(bench, "workerStackMin", r.worker_stack_min);
  cJSON *retries = cJSON_CreateArray();
  cJSON *crc_ok = cJSON_CreateArray();
  for (int i = 0; i < CAPTURE_CAMS; i++) {
    if (!r.cam[i].attempted) continue;
    cJSON_AddItemToArray(retries, cJSON_CreateNumber(r.cam[i].chunk_retries));
    cJSON_AddItemToArray(crc_ok, cJSON_CreateBool(r.cam[i].crc_match));
  }
  cJSON_AddItemToObject(bench, "chunkRetries", retries);
  cJSON_AddItemToObject(bench, "crcMatch", crc_ok);
  cJSON_AddItemToObject(json, "bench", bench);
  send_json(KDP_CMD_CAMERA_CAPTURE, seq, json);
}

/** EVT_CAPTURE, so a host attached while someone pressed the shutter learns
 * about the picture without polling MEDIA_LIST for one. */
static void on_capture_done(const capture_report_t *r) {
  if (r == NULL || !r->ok) return;
  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "id", r->id);
  cJSON_AddStringToObject(json, "kind", r->mode);
  /* Beyond CaptureEvent and additive: a host that only knows the two
   * contract fields ignores these, and one that reads them can show a
   * partial capture as partial instead of discovering it on download. */
  cJSON_AddStringToObject(json, "captureUuid", r->uuid);
  cJSON_AddStringToObject(json, "status", r->status);
  cJSON_AddNumberToObject(json, "frameCount", r->stored);
  cJSON_AddStringToObject(json, "triggeredBy", r->source);
  send_event(KDP_EVT_CAPTURE, json);
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
  if (!capture_lock(0)) {
    send_nack(KDP_CMD_CAMERA_TEST, seq, "BUSY", "A capture or soak run is active");
    return;
  }
  capture_result_t result;
  /* The node holds ONE frame and a new capture destroys it, so the
   * viewfinder must stop taking its own before this starts: four captures
   * in five failed with BAD_ID mid-transfer while the link reported zero
   * CRC errors. viewfinder_review() then holds the tiles briefly, which is
   * what a camera does with a shot just taken - and they already show the
   * last frame before the shutter. */
  const bool vf_was = viewfinder_hold(VF_HOLD_MS);
  run_capture(-1, true, &result);
  viewfinder_review(450);
  viewfinder_release(vf_was);
  capture_unlock();

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
  /* True once a distinct error code arrived with all SOAK_ERROR_KINDS slots
   * already taken. The counts that are reported stay correct; this says the
   * list is not the whole set, which is the difference between "eight kinds of
   * failure" and "at least eight kinds of failure". */
  bool errors_truncated = false;

  uint32_t heap_start = heap_kb();
  uint32_t psram_start = psram_kb();

  camlink_info_t node0;
  camlink_get_info(&node0);
  char node_session[16];
  strlcpy(node_session, node0.session, sizeof node_session);

  uint32_t batch = args->captures / 10;
  if (batch == 0) batch = 1;

  /* Held for the whole run, not per capture. A soak is hundreds of captures
   * back to back and the node holds one frame: a viewfinder taking frames of
   * its own between them would invalidate transfers at random and the run
   * would measure the race instead of the link. */
  const bool vf_was = viewfinder_hold(VF_HOLD_MS);

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
        strlcpy(first_uuid, r.capture_uuid, sizeof first_uuid);
      } else if (!args->keep_all) {
        // Keep first and current last; drop the previous middle capture.
        if (kept_last_dir[0] != '\0') storage_capture_delete(kept_last_dir);
        strlcpy(kept_last_dir, r.dir, sizeof kept_last_dir);
      }
      strlcpy(last_uuid, r.capture_uuid, sizeof last_uuid);
    } else {
      failed++;
      if (strcmp(r.err_code, "TRANSFER_CRC_MISMATCH") == 0) crc_errors++;
      if (strcmp(r.err_code, "TRANSFER_TIMEOUT") == 0 ||
          strcmp(r.err_code, "NODE_BOOT_TIMEOUT") == 0) {
        timeouts++;
      }
      if (strncmp(r.err_code, "SD_", 3) == 0) sd_errors++;
      bool recorded = false;
      for (int e = 0; e < SOAK_ERROR_KINDS; e++) {
        if (errors[e].count == 0 || strcmp(errors[e].code, r.err_code) == 0) {
          if (errors[e].count == 0) strlcpy(errors[e].code, r.err_code, sizeof errors[e].code);
          errors[e].count++;
          recorded = true;
          break;
        }
      }
      if (!recorded) errors_truncated = true;
      // Node reset detection: did the node come back with a new session?
      if (camlink_hello() == ESP_OK) {
        camlink_info_t now;
        camlink_get_info(&now);
        if (now.session[0] != '\0' && strcmp(now.session, node_session) != 0) {
          node_resets++;
          strlcpy(node_session, now.session, sizeof node_session);
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
  cJSON_AddBoolToObject(result, "errorsTruncated", errors_truncated);

  cJSON *complete = cJSON_CreateObject();
  cJSON_AddStringToObject(complete, "jobId", args->job_id);
  cJSON_AddItemToObject(complete, "result", result);
  send_event(KDP_EVT_JOB_COMPLETE, complete);

  klog("P4", "soak %s done — %lu/%lu ok, %lu failed", args->job_id,
       (unsigned long)successful, (unsigned long)args->captures,
       (unsigned long)failed);

  s_soak_running = false;
  viewfinder_release(vf_was);
  capture_unlock();
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
  if (!capture_lock(0)) {
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "BUSY", "A capture or soak run is active");
    return;
  }

  soak_args_t *args = calloc(1, sizeof *args);
  if (args == NULL) {
    capture_unlock();
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "OUT_OF_MEMORY", "No memory for soak state");
    return;
  }

  const cJSON *captures = cJSON_GetObjectItem(req, "captures");
  const cJSON *delay = cJSON_GetObjectItem(req, "delayMs");
  const cJSON *quality = cJSON_GetObjectItem(req, "jpegQuality");
  const cJSON *keep = cJSON_GetObjectItem(req, "keepAll");
  args->captures = (uint32_t)clamp_num(captures, 1, 1000, 100);
  args->delay_ms = (uint32_t)clamp_num(delay, 100, 60000, 1000);
  /*
   * jpegQuality is a 60..95 percentage on the wire and 5..63 at the sensor,
   * inverted. This stored the wire value straight into the field run_capture()
   * hands to camlink_capture(), so a soak asking for 95 ran the sensor at its
   * worst setting and every byte the run measured came from a different JPEG
   * than the product path makes. Out of range is refused rather than clamped:
   * a soak reports numbers someone will compare against a spec, so it must run
   * what was asked for or nothing.
   */
  int sensor_quality = -1; /* -1: leave the node on its configured quality */
  if (quality != NULL && !cJSON_IsNull(quality)) {
    const long percent = clamp_num(quality, 0, 1000, -1);
    if (percent < 60 || percent > 95) {
      free(args);
      capture_unlock();
      send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "INVALID_ARGUMENT",
                "jpegQuality must be 60..95");
      return;
    }
    sensor_quality = capture_quality_to_sensor((int)percent);
  }
  args->jpeg_quality = sensor_quality;
  args->keep_all = cJSON_IsTrue(keep);
  snprintf(args->job_id, sizeof args->job_id, "job_%lu", (unsigned long)++s_job_counter);

  /* soak_task owns `args` from here and free()s it when the run ends - which
   * can be before xTaskCreate() has even returned, since it runs at priority 5
   * on a core this task does not pin. The reply is built from this copy. */
  char job_id[sizeof args->job_id];
  strlcpy(job_id, args->job_id, sizeof job_id);

  s_soak_running = true;
  if (xTaskCreate(soak_task, "soak", 8192, args, 5, NULL) != pdPASS) {
    s_soak_running = false;
    free(args);
    capture_unlock();
    send_nack(KDP_CMD_CAMERA_SOAK_TEST, seq, "OUT_OF_MEMORY", "Could not start soak task");
    return;
  }

  cJSON *json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "jobId", job_id);
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

/* Bench only: reset the C6 and nothing else. The decision is bench_c6.c,
 * host-tested; the pulse is net_hosted.c's own. Built in only with
 * -DKINO_C6_RESET_BENCH=1 on a radio build; otherwise the actuator is NULL
 * and the request is refused before anything is called. */
#if KINO_RADIO && KINO_C6_RESET_BENCH
static void c6_bench_pulse(void) { (void)net_hosted_bench_c6_reset(); }
#define C6_RESET_BENCH_BUILT true
#define C6_RESET_BENCH_PULSE c6_bench_pulse
#else
#define C6_RESET_BENCH_BUILT false
#define C6_RESET_BENCH_PULSE NULL
#endif

static void handle_c6_reset_bench(uint32_t seq) {
  const bench_c6_ops_t ops = {.pulse = C6_RESET_BENCH_PULSE, .reboot = NULL};
  if (bench_c6_reset_request(C6_RESET_BENCH_BUILT, &ops) != BENCH_C6_DONE) {
    send_nack(KDP_CMD_C6_RESET_BENCH, seq, "UNSUPPORTED_COMMAND",
              "C6_RESET_BENCH is bench-only and not in this build");
    return;
  }
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddStringToObject(json, "target", "C6");
  send_json(KDP_CMD_C6_RESET_BENCH, seq, json);
}

// ---- dispatch ----

/* How long a MEDIA_* command waits for the card before answering BUSY. A
 * capture holds it for a few seconds; an upload chunk yields within one chunk
 * read. Longer than the latter, shorter than a host's request timeout. */
#define MEDIA_CARD_WAIT_MS 3000

typedef void (*media_handler_t)(uint32_t seq, const cJSON *req);

/**
 * Run a MEDIA_* handler holding the card as the UI user.
 *
 * These six handlers opened FAT directly. Capture and upload were serialised
 * through storage_acquire(), so the gallery reads and META.JSON rewrites a
 * host issues were the remaining traffic that could land on the SDMMC bus
 * while four frames were being written. Nothing corrupts - FATFS has its own
 * lock - but the frame spread widens and a MEDIA_READ mid-capture stalls
 * behind the writes anyway. Taking the lock says so up front: BUSY, retry.
 */
static void with_card(uint8_t cmd, uint32_t seq, const cJSON *req, media_handler_t fn) {
  if (!storage_acquire(STORAGE_USER_UI, MEDIA_CARD_WAIT_MS)) {
    send_nack(cmd, seq, "BUSY", "Card is busy with a capture");
    return;
  }
  fn(seq, req);
  storage_release(STORAGE_USER_UI);
}

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
    case KDP_CMD_GET_POWER_STATUS: handle_power_status(frame->seq); break;
    case KDP_CMD_GET_MODES: handle_get_modes(frame->seq); break;
    case KDP_CMD_CAMERA_CAPTURE: handle_camera_capture(frame->seq, req); break;
    case KDP_CMD_MEDIA_LIST: with_card(frame->type, frame->seq, req, handle_media_list); break;
    case KDP_CMD_MEDIA_READ: with_card(frame->type, frame->seq, req, handle_media_read); break;
    case KDP_CMD_MEDIA_THUMB: with_card(frame->type, frame->seq, req, handle_media_thumb); break;
    case KDP_CMD_MEDIA_INFO: with_card(frame->type, frame->seq, req, handle_media_info); break;
    case KDP_CMD_MEDIA_DELETE: with_card(frame->type, frame->seq, req, handle_media_delete); break;
    case KDP_CMD_MEDIA_FAVORITE:
      with_card(frame->type, frame->seq, req, handle_media_favorite);
      break;
    case KDP_CMD_GET_RECIPES:
    case KDP_CMD_SET_RECIPE:
    case KDP_CMD_UPLOAD_RECIPE:
    case KDP_CMD_DELETE_RECIPE:
      send_module(frame->type, frame->seq, kdp_recipes_handle(frame->type, req));
      break;
    case KDP_CMD_GET_SOUNDS:
    case KDP_CMD_SOUND_BEGIN:
    case KDP_CMD_SOUND_CHUNK:
    case KDP_CMD_SOUND_END:
    case KDP_CMD_SOUND_READ:
    case KDP_CMD_SOUND_DELETE:
      send_module(frame->type, frame->seq,
                  kdp_sounds_handle(frame->type, req, frame->payload, frame->payload_len));
      break;
    case KDP_CMD_SET_MODE: handle_set_mode(frame->seq, req); break;
    case KDP_CMD_GET_CONFIG: handle_get_config(frame->seq); break;
    case KDP_CMD_SET_CONFIG: handle_set_config(frame->seq, req); break;
    case KDP_CMD_SAVE_CONFIG: handle_save_config(frame->seq); break;
    case KDP_CMD_RESET_CONFIG: handle_reset_config(frame->seq); break;
    case KDP_CMD_GET_CAMERA_INFO: handle_camera_info(frame->seq); break;
    case KDP_CMD_CAMERA_STATUS: handle_camera_status(frame->seq, req); break;
    case KDP_CMD_CAMERA_TEST: handle_camera_test(frame->seq, req); break;
    case KDP_CMD_STORAGE_SELF_TEST: handle_storage_self_test(frame->seq); break;
    case KDP_CMD_STORAGE_BENCH: handle_storage_bench(frame->seq, req); break;
    case KDP_CMD_CAMERA_LINK_STATS: handle_link_stats(frame->seq, req); break;
    case KDP_CMD_CAMERA_LINK_STATS_RESET: handle_link_stats_reset(frame->seq, req); break;
    case KDP_CMD_CAMERA_SOAK_TEST: handle_soak_test(frame->seq, req); break;
    case KDP_CMD_GET_HW_VALIDATION: handle_hw_validation(frame->seq); break;
    case KDP_CMD_GET_RUNTIME_STATS: handle_runtime_stats(frame->seq); break;
    case KDP_CMD_GET_LOGS: handle_get_logs(frame->seq); break;
    case KDP_CMD_CLEAR_LOGS: handle_clear_logs(frame->seq); break;
    case KDP_CMD_SELF_TEST: handle_self_test(frame->seq); break;
    case KDP_CMD_REBOOT: handle_reboot(frame->seq); break;
    case KDP_CMD_C6_RESET_BENCH: handle_c6_reset_bench(frame->seq); break;
    /* Read-only. The rest of the FW_* group stays failed-closed — see the
     * handler's comment for why a query is not an update path. */
    case KDP_CMD_FW_QUERY: handle_fw_query(frame->seq); break;

    /* Network / Roll / upload queue. kdp_net.c builds the reply and this
     * sends it — see kdp_net.h for which of these answer for real on a body
     * with no radio route and which refuse with a reason. */
    case KDP_CMD_NETWORK_LIST: send_net(frame->type, frame->seq, kdp_net_list(req)); break;
    case KDP_CMD_NETWORK_SET: send_net(frame->type, frame->seq, kdp_net_set(req)); break;
    case KDP_CMD_NETWORK_DELETE: send_net(frame->type, frame->seq, kdp_net_delete(req)); break;
    case KDP_CMD_NETWORK_STATUS: send_net(frame->type, frame->seq, kdp_net_status(req)); break;
    case KDP_CMD_ROLL_STATUS: send_net(frame->type, frame->seq, kdp_net_roll_status()); break;
    case KDP_CMD_ROLL_CREATE: send_net(frame->type, frame->seq, kdp_net_roll_create(req)); break;
    case KDP_CMD_ROLL_JOIN: send_net(frame->type, frame->seq, kdp_net_roll_join(req)); break;
    case KDP_CMD_ROLL_LEAVE: send_net(frame->type, frame->seq, kdp_net_roll_leave()); break;
    case KDP_CMD_UPLOAD_QUEUE_STATUS:
      send_net(frame->type, frame->seq, kdp_net_upload_status());
      break;
    case KDP_CMD_UPLOAD_QUEUE_RETRY:
      send_net(frame->type, frame->seq, kdp_net_upload_retry());
      break;
    case KDP_CMD_UPLOAD_ENQUEUE:
      send_net(frame->type, frame->seq, kdp_net_upload_enqueue(req));
      break;

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

/* A read of a buffer written once, before the UI task exists. No lock: nothing
 * ever writes s_id again, so there is no torn state to protect against. */
const char *kdp_device_serial(void) { return s_id.serial; }

esp_err_t kdp_server_start(const kdp_identity_t *identity) {
  /* Feature modules first: their capability flags are read by GET_CAPABILITIES
   * and their card directories must exist before the first request. Both log
   * and degrade; neither can stop the server. */
  if (kdp_recipes_init() != ESP_OK) ESP_LOGW(TAG, "looks unavailable");
  if (kdp_sounds_init() != ESP_OK) ESP_LOGW(TAG, "custom sounds unavailable");
  /* Registered before the transport starts: a capture cannot be reported to
   * a host that is not listening yet, but a hook installed late would miss
   * one taken in the gap. */
  capture_on_done(on_capture_done);

  s_id = *identity;
  s_tx_lock = xSemaphoreCreateMutex();
  if (s_tx_lock == NULL) return ESP_ERR_NO_MEM;
  if (s_decode_buf == NULL) s_decode_buf = heap_caps_malloc(KDP_MAX_FRAME, MALLOC_CAP_SPIRAM);
  if (s_tx == NULL) s_tx = heap_caps_malloc(KDP_MAX_FRAME, MALLOC_CAP_SPIRAM);
  if (s_decode_buf == NULL || s_tx == NULL) return ESP_ERR_NO_MEM;

  esp_err_t err = usb_link_init();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "USB_TRANSPORT init FAILED: %s — Studio link unavailable this boot",
             esp_err_to_name(err));
    return err;
  }
  ESP_LOGI(TAG, "USB_TRANSPORT_READY: KDP on USB-Serial-JTAG, session %s",
           s_id.session_id);
  /* The queue and its drain task exist before the emitter is registered, so
   * no klog() call can ever find the emitter without somewhere to put the
   * event. Priority 1: below every product task, because this is the one
   * path that is allowed to wait on a host that is not there. */
  s_log_q = xQueueCreate(LOG_EVT_QUEUE_LEN, sizeof(log_evt_t));
  if (s_log_q != NULL &&
      xTaskCreate(log_drain_task, "log_drain", 4096, NULL, 1, NULL) == pdPASS) {
    klog_set_emitter(log_emitter);
  } else {
    ESP_LOGE(TAG, "log drain not started; LOG events will not be emitted");
  }

  temperature_sensor_config_t tsens_config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
  s_tsens = NULL;
  temperature_sensor_handle_t tsens = NULL;
  if (temperature_sensor_install(&tsens_config, &tsens) == ESP_OK &&
      temperature_sensor_enable(tsens) == ESP_OK) {
    s_tsens = tsens; /* otherwise GET_RUNTIME_STATS reports tempC.p4 null */
  }

  kdp_decoder_init(&s_decoder, s_decode_buf, KDP_MAX_FRAME);
  TaskHandle_t srv = NULL;
  /* 12 KB, from 8. ROLL_CREATE runs on this task and nests two 1 KB HTTP
   * response buffers under cJSON parsing; measured on KD4-D121BC at 580 bytes
   * free after one such call. A large GET_LOGS reply had already taken it to
   * ~1.1 KB. Neither is a place to be one snprintf from the guard page. */
  BaseType_t ok = xTaskCreate(server_task, "kdp_server", 12288, NULL, 9, &srv);
  taskmon_register("kdp_server", srv);
  return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
