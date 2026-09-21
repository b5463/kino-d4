#include "cam_link.h"

#include <string.h>

#include "board_d4v1.h"
#include "board_d4v1_checks.h"
#include "cJSON.h"
#include "driver/uart.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
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

/* Four chunks deep, not two.
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
 * Eight was tried and made no difference to the overrun rate, which is what
 * rules out "the reader is being outrun" and leaves the ISR being held off as
 * the explanation.
 */
#define LINK_RX_BUF (4 * (NL_CHUNK_MAX + 64))
/* The largest request the P4 sends a node is a firmware chunk. In PSRAM:
 * four of these in internal SRAM is 9 KB the recovery reserve cannot spare,
 * and the UART driver copies from wherever the bytes are. */
#define LINK_TX_BUF (KDP_HEADER_LEN + 4 + NL_FW_CHUNK_MAX + KDP_CRC_LEN + 64)

/*
 * Decoder storage per channel.
 *
 * KDP_MAX_FRAME is 16402 bytes because the KDP payload cap is 16 KB, but this
 * is the NODE link, not the host link, and NL_CHUNK_MAX is 8192 - a node
 * cannot send a larger frame than that. Four channels at KDP_MAX_FRAME was
 * 66 KB of .bss to hold frames that cannot arrive; sized to what the node
 * link actually permits it is half that. The header and CRC are added back
 * because a full chunk still has to fit with its framing.
 *
 * Plus 64 bytes of slack. Sized exactly to one frame, a single stray byte
 * ahead of a full-size chunk - node boot spew, the tail of a resync - leaves
 * no room for the frame behind it to be assembled. The slack costs nothing and
 * removes a cliff that only appears at the maximum chunk size.
 */
#define LINK_DECODE_BUF (KDP_HEADER_LEN + NL_CHUNK_MAX + KDP_CRC_LEN + 64)

/* The arithmetic above, stated so a change to either constant fails the build
 * rather than the link. A frame whose total exceeds the decoder's cap is
 * resynced past like a corrupt length (decoder.h), so getting this wrong does
 * not crash - it silently discards every full-size chunk, which is far worse
 * to diagnose. */
_Static_assert(NL_CHUNK_MAX + KDP_HEADER_LEN + KDP_CRC_LEN <= LINK_DECODE_BUF,
               "a full NL_CHUNK_MAX chunk plus framing must fit LINK_DECODE_BUF");

#define DEFAULT_TIMEOUT_MS 3000

/*
 * A capture is the node's worst case plus its own work, and the budget has to
 * cover it or the P4 gives up on a frame that was on its way.
 *
 * esp32-camera's FB_GET_TIMEOUT is 4000 ms, and this was sized as two of
 * them - the stale-frame discard, then the fresh frame - plus margin for the
 * node's CRC over 240 KB and its cJSON print, a few hundred milliseconds at
 * -O2. 8000 ms was exactly the two fb_gets with nothing left for the reply,
 * so a node doing precisely what it was asked to do timed out here.
 *
 * That arithmetic predated the node's freshness retry. node_server.c
 * handle_capture() will discard a frame armed before its own command and
 * fetch again, so "two fb_gets" was never the node's worst case once that
 * landed: at 4000 ms each, five of them is 20 s against this 12 s. The node
 * now bounds the whole sequence on ITS side with a wall-clock deadline
 * (node_server.c, CAPTURE_BUDGET_MS 3000) rather than a retry count, so its
 * worst answer is that plus the CRC and the reply - inside the product path's
 * NODE_CAPTURE_TIMEOUT_MS 4000 (capture.c) and well inside this.
 *
 * This value is unchanged, and stays 12000 until a node-side p99 says
 * otherwise: it is only reached by camlink_capture(), the bench default. The
 * product path passes its own budget.
 */
#define CAPTURE_TIMEOUT_MS 12000

typedef struct channel_s channel_t;

typedef struct {
  uint32_t seq;
  uint8_t cmd; /* what was asked, so a reply's TYPE can be made to echo it */
  bool got;
  bool nack;
  bool truncated; /* the payload did not fit dst_cap and was cut short */
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
  uint8_t *tx; /* LINK_TX_BUF, PSRAM */
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

/* 36 KB in PSRAM: touched only from tasks with the cache on, never from an
 * ISR and never while a flash write has the cache off. Internal SRAM is what
 * ESP-Hosted's SDIO buffers, the UART rings and every task stack need (#162). */
static EXT_RAM_BSS_ATTR channel_t s_ch[CAMLINK_CAMS];

static bool valid_cam(int cam) { return cam >= 0 && cam < CAMLINK_CAMS && s_ch[cam].lock != NULL; }

static void set_last_error(channel_t *ch, const char *code) {
  strlcpy(ch->stats.last_error, code, sizeof ch->stats.last_error);
  ch->stats.last_error[sizeof ch->stats.last_error - 1] = '\0';
}

static void on_frame(const kdp_frame_t *frame, void *ctx) {
  pending_t *p = (pending_t *)ctx;
  channel_t *ch = p->ch;
  ch->stats.rx_frames++;
  /*
   * VERSION, then TYPE, before anything is copied.
   *
   * Neither was checked on this side of the link. node_server.c NACKs
   * BAD_VERSION on a bad inbound version and kdp-framing.md:236-240 says the
   * device should - so the node held the P4 to a rule the P4 did not hold the
   * node to. And TYPE was ignored entirely: any RESPONSE with a matching
   * sequence satisfied the pending request, so a reply to a different command
   * that happened to reuse the sequence handed its JSON to whatever buffer
   * was waiting - the chunk buffer, on a READ.
   *
   * Counted and dropped rather than NACKed: this is the response direction,
   * and a NACK to a reply is not a thing the link has.
   */
  if (frame->version != NL_PROTOCOL_VERSION) {
    ch->stats.bad_version++;
    return;
  }
  if ((frame->flags & KDP_FLAG_RESPONSE) == 0) {
    /* The node sends no events and no requests. Anything without the RESPONSE
     * flag is framing this link does not have, and the P4 server rejects the
     * mirror case (kdp_server.c). */
    ch->stats.bad_type++;
    return;
  }
  if (frame->type != p->cmd) {
    ch->stats.bad_type++;
    return;
  }
  if (frame->seq != p->seq || p->got) {
    // A response we no longer wait for: a late reply to a timed-out request
    // or a genuine duplicate. Counted, never delivered.
    ch->stats.duplicates++;
    return;
  }

  if (frame->payload_len > p->dst_cap) {
    /* Cut short, and SAID SO. This clamp had no counter and no error path: the
     * caller got truncated JSON, cJSON_Parse failed, and camlink_hello_ch
     * reported the camera OFFLINE - a wiring answer to a message-size fault,
     * with nothing anywhere to contradict it. */
    p->truncated = true;
    ch->stats.truncated++;
    p->len = p->dst_cap;
  } else {
    p->len = frame->payload_len;
  }
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
static esp_err_t request_raw(int cam, uint8_t cmd, uint8_t flags, const uint8_t *payload,
                             size_t payload_len, uint8_t *resp, size_t resp_cap,
                             size_t *resp_len, uint32_t timeout_ms);

/* A JSON request: the shape every command but a firmware chunk has. */
static esp_err_t request(int cam, uint8_t cmd, const char *json, uint8_t *resp,
                         size_t resp_cap, size_t *resp_len, uint32_t timeout_ms) {
  const char *payload = json != NULL ? json : "{}";
  return request_raw(cam, cmd, KDP_FLAG_NONE, (const uint8_t *)payload, strlen(payload), resp,
                     resp_cap, resp_len, timeout_ms);
}

static esp_err_t request_raw(int cam, uint8_t cmd, uint8_t flags, const uint8_t *payload,
                             size_t payload_len, uint8_t *resp, size_t resp_cap,
                             size_t *resp_len, uint32_t timeout_ms) {
  /* Before any early return. camlink_read_ch passes the caller's `got`
   * straight through and does not check the channel itself, so on an invalid
   * cam or an encode failure the caller would read an uninitialised size_t and
   * treat that many bytes of its chunk buffer as received JPEG. */
  if (resp_len != NULL) *resp_len = 0;
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  channel_t *ch = &s_ch[cam];
  xSemaphoreTake(ch->lock, portMAX_DELAY);

  memset(&ch->pending, 0, sizeof ch->pending);
  ch->pending.ch = ch;
  ch->pending.cmd = cmd;
  ch->seq = kdp_next_seq(ch->seq);
  ch->pending.seq = ch->seq;
  ch->pending.dst = resp;
  ch->pending.dst_cap = resp_cap;
  ch->stats.last_sequence = ch->seq;

  size_t total = kdp_encode_frame(ch->tx, LINK_TX_BUF, NL_PROTOCOL_VERSION, cmd, flags,
                                  ch->pending.seq, payload, payload_len);
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
  const uint32_t disc_before = ch->decoder.stats.discarded_bytes;

  int64_t start = esp_timer_get_time();
  uart_flush_input(ch->uart);
  kdp_decoder_reset(&ch->decoder);
  /* The return was discarded. A short or failed write means the node never saw
   * the request, and the only evidence was a peer timeout 250-12000 ms later,
   * charged to the node. Counted, and the request is abandoned immediately -
   * waiting out a budget for an answer to a question that was never asked
   * costs the capture that time for nothing. */
  const int written = uart_write_bytes(ch->uart, ch->tx, total);
  if (written < 0 || (size_t)written != total) {
    ch->stats.write_errors++;
    set_last_error(ch, "TX_SHORT");
    klog(ch->tag, "uart write %d of %u B for cmd 0x%02x", written, (unsigned)total, cmd);
    xSemaphoreGive(ch->lock);
    return ESP_ERR_INVALID_STATE;
  }
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
      /*
       * `held` and `disc` are the two numbers this line was missing.
       *
       * Bytes-received alone cannot tell a lost header from a lost tail, and
       * those have different causes: discarded bytes mean the magic was
       * missed and the decoder resynced past a frame boundary, while a large
       * held length with nothing discarded means the header arrived and the
       * tail did not. A whole session was spent bisecting a fault that these
       * two would have named on the first run - it was a tail loss, from the
       * compositor blacking out this ISR's core.
       */
      klog(ch->tag,
           "TIMEOUT cmd 0x%02x seq %lu %lu/%lums %luB %luf %lud %luc held %luB disc %luB run %lu",
           cmd,
           (unsigned long)ch->pending.seq, (unsigned long)ms, (unsigned long)timeout_ms,
           (unsigned long)(ch->stats.rx_bytes - rx_bytes_before),
           (unsigned long)(ch->stats.rx_frames - rx_frames_before),
           (unsigned long)(ch->stats.duplicates - dups_before),
           (unsigned long)(ch->stats.crc_errors + ch->decoder.stats.crc_failures - crc_before),
           (unsigned long)ch->decoder.len,
           (unsigned long)(ch->decoder.stats.discarded_bytes - disc_before),
           (unsigned long)ch->timeout_run);
      ch->timeout_logged_us = now_us;
    }
    result = ESP_ERR_TIMEOUT;
  } else if (ch->pending.truncated) {
    /* Distinct from a timeout and from a NACK, so the camera is not reported
     * offline for a reply that arrived intact and merely did not fit. */
    set_last_error(ch, "REPLY_TRUNCATED");
    klog(ch->tag, "reply to cmd 0x%02x did not fit %uB, cut short",
         cmd, (unsigned)resp_cap);
    result = ESP_ERR_INVALID_SIZE;
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
    if (ch->tx == NULL) {
      ch->tx = heap_caps_malloc(LINK_TX_BUF, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (ch->tx == NULL) return ESP_ERR_NO_MEM;
    }

    /* A port that will not install is a channel that stays absent, not a
     * boot failure: three unwired nodes must never stop the one that is
     * wired from working. */
    /* No event queue, and no IRAM interrupt flag. Both were tried on
     * 2026-08-29 and both are worse - see sdkconfig.defaults for the bisect
     * that settled the IRAM one. */
    esp_err_t err = uart_driver_install(ch->uart, LINK_RX_BUF, 0, 0, NULL, 0);
    if (err == ESP_OK) err = uart_param_config(ch->uart, &config);
    /*
     * The RX interrupt at 32 of the 128 FIFO bytes, not the driver's 120 (#158).
     *
     * Every note in this file about "1.39 ms of FIFO slack" assumed the ISR
     * is asked for the first byte. It is not: UART_FULL_THRESH_DEFAULT is 120
     * (esp_driver_uart/src/uart.c), so on a continuous 8 KB chunk the ISR has
     * 8 bytes - 87 us at 921600 - before the FIFO overflows. Measured with a
     * 1 ms timer probe on this core (isr_watch.c), interrupt gaps of 1.5-2.9 ms
     * happen constantly: a cache writeback for the compositor, a gallery tile
     * decode, a worker's card write, on either core, and none of them can be
     * pinned away because the stall is the shared cache's, not one core's
     * interrupt mask. 32 gives the ISR 96 bytes, ~1.04 ms, and took the
     * four-camera capture burst from ~1 lost chunk tail per capture to 0.15-
     * 0.65. What remains is the >1.4 ms stalls, which capture.c now keeps out
     * of the transfer window entirely. Costs ~2,900 interrupts/s per channel
     * under a full transfer instead of ~770.
     */
    if (err == ESP_OK) err = uart_set_rx_full_threshold(ch->uart, 32);
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
  /*
   * Bounded, because this reads a cached struct and the lock it shares is
   * held across whole round trips. request() keeps ch->lock for its entire
   * timeout - 3000 ms on a channel with no node - so waiting forever here
   * turned "which cameras are online" into a multi-second stall on the
   * shutter path. The copy is one struct; a stale answer is the same answer,
   * and it is what upstream already treats as advisory.
   */
  if (xSemaphoreTake(ch->lock, pdMS_TO_TICKS(20)) == pdTRUE) {
    *out = ch->info;
    xSemaphoreGive(ch->lock);
  } else {
    *out = ch->info; /* unlocked read of a struct only ever written under the
                      * lock by the same core's driver task; worst case is the
                      * previous poll's values, which is what "cached" means */
  }
}

void camlink_get_info(camlink_info_t *out) { camlink_get_info_ch(0, out); }

void camlink_get_stats_ch(int cam, camlink_stats_t *out) {
  if (out == NULL) return;
  if (!valid_cam(cam)) {
    memset(out, 0, sizeof *out);
    return;
  }
  channel_t *ch = &s_ch[cam];
  /* Bounded, for the reason camlink_get_info_ch is bounded: request() holds
   * this mutex for a whole round trip - up to 12 s on a capture READ, 3 s on a
   * channel with no node - and this is a counter read for a stats command. A
   * portMAX_DELAY here made GET_RUNTIME_STATS stall behind a live capture. */
  if (xSemaphoreTake(ch->lock, pdMS_TO_TICKS(20)) == pdTRUE) {
    *out = ch->stats;
    xSemaphoreGive(ch->lock);
  } else {
    /* Unlocked copy of a struct of independent counters, all written under the
     * lock by the channel's own caller. Worst case is one counter a request
     * ahead of another, which is what "sampled" means for a stats snapshot. */
    *out = ch->stats;
  }
}

void camlink_get_stats(camlink_stats_t *out) { camlink_get_stats_ch(0, out); }

void camlink_reset_stats_ch(int cam) {
  if (!valid_cam(cam)) return;
  channel_t *ch = &s_ch[cam];
  /* Bounded like the read above. A reset that cannot get the lock does
   * nothing rather than blocking the host command behind a capture's
   * transfers; 200 ms rides out a chunk read, and CAMERA_LINK_STATS_RESET is
   * a deliberate operator action that can be repeated. */
  if (xSemaphoreTake(ch->lock, pdMS_TO_TICKS(200)) != pdTRUE) return;
  uint32_t keep_seq = ch->stats.last_sequence;
  memset(&ch->stats, 0, sizeof ch->stats);
  ch->stats.last_sequence = keep_seq;
  xSemaphoreGive(ch->lock);
}

void camlink_note_retry_ch(int cam) {
  if (!valid_cam(cam)) return;
  /* A single uint32_t increment, no lock. Taking the channel mutex here would
   * mean waiting on the very request that just failed, from inside the retry
   * loop; a lost increment on a counter is cheaper than that by any measure. */
  s_ch[cam].stats.retries++;
}

void camlink_reset_stats(void) { camlink_reset_stats_ch(0); }

static void copy_str(char *dst, size_t cap, const cJSON *item) {
  dst[0] = '\0';
  if (cJSON_IsString(item)) strlcpy(dst, item->valuestring, cap);
}

esp_err_t camlink_hello_ch(int cam) { return camlink_hello_ch_timeout(cam, DEFAULT_TIMEOUT_MS); }

esp_err_t camlink_hello_ch_timeout(int cam, uint32_t timeout_ms) {
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  channel_t *ch = &s_ch[cam];
  uint8_t resp[768];
  size_t len = 0;
  esp_err_t err = request(cam, NL_CMD_HELLO, NULL, resp, sizeof resp - 1, &len, timeout_ms);

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
    /* Bounded like camlink_get_info_ch: this writes the cached info struct and
     * shares its mutex with whole round trips. A poll that cannot get the lock
     * within 200 ms leaves the previous sample standing, which is what
     * "cached" already means upstream - it does not block the prober behind
     * another task's capture READ. */
    const bool locked = xSemaphoreTake(ch->lock, pdMS_TO_TICKS(200)) == pdTRUE;
    copy_str(ch->info.state, sizeof ch->info.state, cJSON_GetObjectItem(json, "state"));
    const cJSON *heap = cJSON_GetObjectItem(json, "heapKB");
    if (cJSON_IsNumber(heap)) ch->info.heap_kb = (int32_t)heap->valuedouble;
    const cJSON *psram = cJSON_GetObjectItem(json, "psramKB");
    if (cJSON_IsNumber(psram)) ch->info.psram_kb = (int32_t)psram->valuedouble;
    const cJSON *temp = cJSON_GetObjectItem(json, "tempC");
    ch->info.temp_c = cJSON_IsNumber(temp) ? (int32_t)temp->valuedouble : CAMLINK_TEMP_UNKNOWN;
    if (locked) xSemaphoreGive(ch->lock);
    cJSON_Delete(json);
  }
  return ESP_OK;
}

esp_err_t camlink_ping(uint32_t *rtt_ms) { return camlink_ping_ch(0, rtt_ms); }

esp_err_t camlink_sync_ch(int cam, camlink_sync_t *out) {
  if (out == NULL) return ESP_ERR_INVALID_ARG;
  memset(out, 0, sizeof *out);
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  uint8_t resp[512];
  size_t len = 0;
  esp_err_t err = request(cam, NL_CMD_STATUS, NULL, resp, sizeof resp - 1, &len,
                          DEFAULT_TIMEOUT_MS);
  if (err != ESP_OK) return err;
  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json == NULL) return ESP_ERR_INVALID_RESPONSE;
  const cJSON *seq = cJSON_GetObjectItem(json, "syncSeq");
  const cJSON *raw = cJSON_GetObjectItem(json, "syncRawEdges");
  if (cJSON_IsNumber(seq) && cJSON_IsNumber(raw)) {
    out->present = true;
    out->seq = (uint32_t)seq->valuedouble;
    out->raw = (uint32_t)raw->valuedouble;
    const cJSON *rej = cJSON_GetObjectItem(json, "syncRejected");
    if (cJSON_IsNumber(rej)) out->rejected = (uint32_t)rej->valuedouble;
    const cJSON *dt = cJSON_GetObjectItem(json, "syncDeadtimeUs");
    if (cJSON_IsNumber(dt)) out->deadtime_us = (uint32_t)dt->valuedouble;
    const cJSON *edge = cJSON_GetObjectItem(json, "syncEdgeUs");
    if (cJSON_IsNumber(edge)) out->edge_us = (int64_t)edge->valuedouble;
    out->input_ready = cJSON_IsTrue(cJSON_GetObjectItem(json, "syncInput"));
  }
  cJSON_Delete(json);
  return ESP_OK;
}

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
  /* The sync edge (#165): syncSeq always numeric on a 0.4.30+ node, the three
   * relative values null until the first edge. Absent altogether on older
   * nodes, which leaves has_sync false and sync_seq 0. */
  const cJSON *sseq = cJSON_GetObjectItem(json, "syncSeq");
  if (cJSON_IsNumber(sseq)) out->sync_seq = (uint32_t)sseq->valuedouble;
  const cJSON *sedge = cJSON_GetObjectItem(json, "syncEdgeUs");
  const cJSON *scmd = cJSON_GetObjectItem(json, "syncToCmdUs");
  const cJSON *sframe = cJSON_GetObjectItem(json, "syncToFrameUs");
  if (cJSON_IsNumber(sedge) && cJSON_IsNumber(scmd) && cJSON_IsNumber(sframe)) {
    out->has_sync = true;
    out->sync_edge_us = (int64_t)sedge->valuedouble;
    out->sync_to_cmd_us = (int64_t)scmd->valuedouble;
    out->sync_to_frame_us = (int64_t)sframe->valuedouble;
  }
  /* The node's freshness verdict (#7). Absent on a node older than the field:
   * true/0 then, deliberately - those nodes ran the same bounded loop, and
   * defaulting to "suspect" would mark every frame from every older node. */
  const cJSON *fresh = cJSON_GetObjectItem(json, "frameFresh");
  out->frame_fresh = cJSON_IsBool(fresh) ? cJSON_IsTrue(fresh) : true;
  const cJSON *fretry = cJSON_GetObjectItem(json, "freshnessRetries");
  out->freshness_retries = cJSON_IsNumber(fretry) ? (uint32_t)fretry->valuedouble : 0;
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

/**
 * Append `"key":value` (with a separator) and keep `*n` truthful.
 *
 * snprintf returns the length it WOULD have written, so the old
 * `n += snprintf(buf + n, sizeof buf - (size_t)n, ...)` chain let one
 * truncation push n past the buffer, wrap the unsigned subtraction, and hand
 * the next call a size argument of ~2^64. Returns false on truncation so the
 * caller refuses the request instead of sending a half-built object.
 */
static bool append_field(char *buf, size_t cap, int *n, const char **sep, const char *key,
                         int value) {
  if (*n < 0 || (size_t)*n >= cap) return false;
  const size_t room = cap - (size_t)*n;
  const int wrote = snprintf(buf + *n, room, "%s\"%s\":%d", *sep, key, value);
  if (wrote < 0 || (size_t)wrote >= room) return false;
  *n += wrote;
  *sep = ",";
  return true;
}

/** Read one integer field out of the node's `applied` object. */
static void copy_applied(const cJSON *applied, const char *key, bool *has, int *value) {
  const cJSON *v = cJSON_GetObjectItem(applied, key);
  if (!cJSON_IsNumber(v)) return; /* absent = the node never wrote that knob */
  *has = true;
  *value = (int)v->valuedouble;
}

esp_err_t camlink_set_sensor_ch(int cam, const camlink_sensor_t *want,
                                camlink_sensor_t *applied, uint32_t timeout_ms) {
  if (!valid_cam(cam) || want == NULL) return ESP_ERR_INVALID_ARG;
  if (applied != NULL) memset(applied, 0, sizeof *applied);

  /*
   * Built one field at a time, and only the flagged ones - an absent field is
   * how the node is told to leave a knob alone.
   *
   * 160 bytes: five fields at their longest are
   * {"aeLevel":-2,"gainCeiling":128,"denoise":8,"sharpness":-3,"quality":63}
   * which is 72, so this is over twice the largest request that can be built.
   * It stays well inside the node's 256-byte decode payload cap
   * (node_server.c, LINK_DECODE_PAYLOAD_MAX).
   */
  /*
   * `n` is clamped after every append, and the buffer is asserted big enough.
   *
   * snprintf returns the length it WOULD have written. Five unclamped `n +=`
   * against `sizeof req_json - (size_t)n` meant one truncation made n exceed
   * 160, the subtraction wrapped, and the size argument became ~2^64 - an
   * unbounded write from a size_t underflow. Unreachable today at ~117 of
   * 160 bytes, and guarded only by a comment saying so; a sixth field or a
   * wider value is all it takes.
   */
  char req_json[160];
  /* The longest request that can be built, counted out:
   *   {"aeLevel":-2,"gainCeiling":128,"denoise":8,"sharpness":-3,"quality":63}
   * is 73 bytes with both braces. 160 is over twice that, and it must stay
   * inside the node's 256-byte decode payload cap (node_server.c,
   * LINK_DECODE_PAYLOAD_MAX) or the node resyncs past the request. */
  _Static_assert(sizeof req_json <= 256,
                 "an NL_CMD_SENSOR request must fit node_server's 256-byte payload cap");
  int n = snprintf(req_json, sizeof req_json, "{");
  const char *sep = "";
  bool built = n > 0 && (size_t)n < sizeof req_json;
  if (built && want->has_ae_level)
    built = append_field(req_json, sizeof req_json, &n, &sep, "aeLevel", want->ae_level);
  if (built && want->has_gain_ceiling)
    built = append_field(req_json, sizeof req_json, &n, &sep, "gainCeiling",
                         want->gain_ceiling);
  if (built && want->has_denoise)
    built = append_field(req_json, sizeof req_json, &n, &sep, "denoise", want->denoise);
  if (built && want->has_sharpness)
    built = append_field(req_json, sizeof req_json, &n, &sep, "sharpness", want->sharpness);
  if (built && want->has_quality)
    built = append_field(req_json, sizeof req_json, &n, &sep, "quality", want->quality);
  /* +2: the closing brace and its NUL. Refuse rather than send half a JSON
   * object, which the node answers INVALID_ARGUMENT with no reason a log
   * could name. */
  if (!built || (size_t)n + 2 > sizeof req_json) return ESP_ERR_INVALID_SIZE;
  snprintf(req_json + n, sizeof req_json - (size_t)n, "}");

  uint8_t resp[256];
  size_t len = 0;
  esp_err_t err = request(cam, NL_CMD_SENSOR, req_json, resp, sizeof resp - 1, &len,
                          timeout_ms);
  if (err != ESP_OK) return err;

  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json == NULL) return ESP_ERR_INVALID_RESPONSE;
  esp_err_t result = ESP_OK;
  if (!cJSON_IsTrue(cJSON_GetObjectItem(json, "ok"))) {
    result = ESP_ERR_INVALID_RESPONSE;
  } else if (applied != NULL) {
    /* `applied` is absent when the node has never written a knob, which is a
     * legitimate answer to a request that flagged nothing - not a bad reply. */
    const cJSON *a = cJSON_GetObjectItem(json, "applied");
    if (cJSON_IsObject(a)) {
      copy_applied(a, "aeLevel", &applied->has_ae_level, &applied->ae_level);
      copy_applied(a, "gainCeiling", &applied->has_gain_ceiling, &applied->gain_ceiling);
      copy_applied(a, "denoise", &applied->has_denoise, &applied->denoise);
      copy_applied(a, "sharpness", &applied->has_sharpness, &applied->sharpness);
      copy_applied(a, "quality", &applied->has_quality, &applied->quality);
    }
  }
  cJSON_Delete(json);
  return result;
}

esp_err_t camlink_read_ch(int cam, uint32_t frame_id, uint32_t offset, uint8_t *buf,
                          size_t want, uint32_t timeout_ms, size_t *got) {
  /*
   * Clamped HERE, not only on the node.
   *
   * The caller's `want` went out verbatim - viewfinder.c asks for up to
   * 24 KB - and this worked only because node_server.c's handle_read clamps
   * to NL_CHUNK_MAX before it replies. That is one bounds check, on the far
   * end of a cable, in a different image, with its own version. A node that
   * honoured the request would send a frame larger than LINK_DECODE_BUF, and
   * the decoder would resync past every one of them: no crash, no CRC error,
   * just a channel that never completes a transfer.
   *
   * Clamping is right rather than refusing: a short READ is already the
   * protocol's normal answer, and every caller loops on `got`.
   */
  if (want > NL_CHUNK_MAX) want = NL_CHUNK_MAX;
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
  return request(cam, NL_CMD_RELEASE, req_json, resp, sizeof resp - 1, NULL, DEFAULT_TIMEOUT_MS);
}

esp_err_t camlink_release(uint32_t frame_id) { return camlink_release_ch(0, frame_id); }

/* Copy the node's NACK reason out for the caller, when there was one. */
static void take_code(int cam, esp_err_t err, char *code, size_t cap) {
  if (code == NULL || cap == 0) return;
  code[0] = '\0';
  if (err == ESP_ERR_INVALID_RESPONSE) strlcpy(code, s_ch[cam].pending.err_code, cap);
}

esp_err_t camlink_fw_begin_ch(int cam, uint32_t size, const char *sha256_hex,
                              const char *version, uint32_t *chunk_max, char *code,
                              size_t code_cap) {
  if (!valid_cam(cam) || sha256_hex == NULL) return ESP_ERR_INVALID_ARG;
  char req_json[160];
  snprintf(req_json, sizeof req_json, "{\"size\":%lu,\"sha256\":\"%s\",\"version\":\"%s\"}",
           (unsigned long)size, sha256_hex, version != NULL ? version : "");
  uint8_t resp[192];
  size_t len = 0;
  /* Erasing a 3 MB slot takes the node a few seconds. */
  const esp_err_t err = request(cam, NL_CMD_FW_BEGIN, req_json, resp, sizeof resp - 1, &len, 10000);
  take_code(cam, err, code, code_cap);
  if (err != ESP_OK) return err;
  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json == NULL) return ESP_ERR_INVALID_RESPONSE;
  const cJSON *cs = cJSON_GetObjectItem(json, "chunkSize");
  if (chunk_max != NULL) *chunk_max = cJSON_IsNumber(cs) ? (uint32_t)cs->valueint : NL_FW_CHUNK_MAX;
  const bool ok = cJSON_IsTrue(cJSON_GetObjectItem(json, "ok"));
  cJSON_Delete(json);
  return ok ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

esp_err_t camlink_fw_chunk_ch(int cam, uint32_t offset, const uint8_t *data, size_t len,
                              char *code, size_t code_cap) {
  if (!valid_cam(cam) || data == NULL || len == 0 || len > NL_FW_CHUNK_MAX) {
    return ESP_ERR_INVALID_ARG;
  }
  /* Built in the channel's own PSRAM transmit buffer's shadow: 4 bytes of
   * offset, then the data. The frame itself is encoded from this by
   * request_raw. */
  static uint8_t *s_chunk;
  if (s_chunk == NULL) {
    s_chunk = heap_caps_malloc(4 + NL_FW_CHUNK_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_chunk == NULL) return ESP_ERR_NO_MEM;
  }
  s_chunk[0] = (uint8_t)offset;
  s_chunk[1] = (uint8_t)(offset >> 8);
  s_chunk[2] = (uint8_t)(offset >> 16);
  s_chunk[3] = (uint8_t)(offset >> 24);
  memcpy(s_chunk + 4, data, len);
  uint8_t resp[128];
  const esp_err_t err = request_raw(cam, NL_CMD_FW_CHUNK, KDP_FLAG_BINARY, s_chunk, 4 + len, resp,
                                    sizeof resp - 1, NULL, 4000);
  take_code(cam, err, code, code_cap);
  return err;
}

esp_err_t camlink_fw_end_ch(int cam, bool *verified, char *code, size_t code_cap) {
  if (verified != NULL) *verified = false;
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  uint8_t resp[128];
  size_t len = 0;
  const esp_err_t err = request(cam, NL_CMD_FW_END, "{}", resp, sizeof resp - 1, &len, 15000);
  take_code(cam, err, code, code_cap);
  if (err != ESP_OK) return err;
  resp[len] = '\0';
  cJSON *json = cJSON_Parse((const char *)resp);
  if (json == NULL) return ESP_ERR_INVALID_RESPONSE;
  if (verified != NULL) *verified = cJSON_IsTrue(cJSON_GetObjectItem(json, "verified"));
  cJSON_Delete(json);
  /* The node restarts as soon as this reply has left it; what the channel
   * knew about it is stale from here. */
  xSemaphoreTake(s_ch[cam].lock, portMAX_DELAY);
  s_ch[cam].info.online = false;
  xSemaphoreGive(s_ch[cam].lock);
  return ESP_OK;
}

esp_err_t camlink_fw_abort_ch(int cam) {
  if (!valid_cam(cam)) return ESP_ERR_INVALID_ARG;
  uint8_t resp[128];
  return request(cam, NL_CMD_FW_ABORT, "{}", resp, sizeof resp - 1, NULL, DEFAULT_TIMEOUT_MS);
}

esp_err_t camlink_release_held_ch(int cam, uint32_t timeout_ms) {
  /* An empty object, so handle_release() takes its unconditional branch. The
   * one caller is a CAPTURE that timed out: no frame id was ever returned, so
   * there is nothing to name, and without this the node kept the frame buffer
   * held mid-encode - which is the state that made a camera read offline on
   * the NEXT capture. */
  uint8_t resp[128];
  return request(cam, NL_CMD_RELEASE, "{}", resp, sizeof resp - 1, NULL, timeout_ms);
}
