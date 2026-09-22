// CAM1 node-link client. Requests are serialized behind one mutex; responses
// are correlated by sequence id, matching the node-link design of one
// outstanding request per camera UART.
#ifndef P4_CAM_LINK_H
#define P4_CAM_LINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
  bool online;
  char firmware[16];
  char sensor[16];     /* "" when no sensor answered the node's bus */
  char sensor_pid[8];  /* "0x3660" style, "" when none */
  bool sensor_detected;
  bool autofocus;      /* sensor-model capability only */
  char session[16];    /* node boot session, "" when never seen */
  char reset_reason[16];
  int chip_revision;   /* -1 unknown */
  int32_t heap_kb;     /* -1 unknown */
  int32_t psram_kb;    /* -1 unknown */
  int32_t temp_c;      /* node die temperature; CAMLINK_TEMP_UNKNOWN when unread */
  char state[24];      /* node-reported state string, "" when never seen */
  uint32_t latency_ms; /* last successful request RTT */
} camlink_info_t;

#define CAMLINK_TEMP_UNKNOWN INT32_MIN

/**
 * A node's sync-edge counters, read fresh from NL_CMD_STATUS.
 *
 * `seq` counts ACCEPTED edges - the generation id a capture reply carries and
 * the figure the P4 holds to one per pulse fired. `raw` counts every rising
 * edge the pin produced and `rejected` those the node's dead time refused, so
 * ringing on the fan-out stays visible rather than being filtered into
 * silence. `edge_us` is the node's own clock at its last accepted edge; it
 * shares no epoch with the P4 or with another node.
 */
typedef struct {
  bool present;        /* the node reported the fields at all (0.4.31+) */
  bool input_ready;    /* the node armed its GPIO */
  uint32_t seq;
  uint32_t raw;
  uint32_t rejected;
  uint32_t deadtime_us;
  int64_t edge_us;     /* 0 when the node has never seen an edge */
} camlink_sync_t;

typedef struct {
  uint32_t rx_frames;
  uint32_t tx_frames;
  uint32_t rx_bytes;
  uint32_t tx_bytes;
  uint32_t crc_errors;
  uint32_t resyncs;
  uint32_t timeouts;
  /**
   * Chunk reads re-issued by the caller's retry policy. This said "zero until
   * a retry policy exists" long after one did: capture.c has had
   * CHUNK_RETRIES 2 since it was written and fires it at every failed READ,
   * so GET_RUNTIME_STATS published 0 and link health read cleaner than it was
   * - a link needing two retries per frame looked identical to one needing
   * none. cam_link cannot count these itself, because whether a failed
   * request is retried is the caller's decision; capture.c reports each one
   * through camlink_note_retry_ch().
   */
  uint32_t retries;
  uint32_t duplicates;
  /**
   * Replies whose payload was larger than the buffer the caller offered, and
   * were therefore cut short. This had no counter and no error: an over-long
   * reply became truncated JSON, failed to parse, and the camera was reported
   * OFFLINE - a wiring diagnosis for a message-size fault. request() now
   * returns ESP_ERR_INVALID_SIZE and last_error says REPLY_TRUNCATED.
   */
  uint32_t truncated;
  /** Replies whose VERSION byte was not NL_PROTOCOL_VERSION. Not delivered.
   * kdp-framing.md:236-240 says a device checks inbound version; the node
   * already NACKs BAD_VERSION and the P4 side checked nothing. */
  uint32_t bad_version;
  /**
   * Replies discarded because TYPE did not echo the command, or because they
   * arrived carrying REQUEST/EVENT framing on a link that has neither. A
   * mismatched type meant a RELEASE reply could satisfy a pending READ and
   * hand its JSON to the chunk buffer.
   */
  uint32_t bad_type;
  /** uart_write_bytes() calls that wrote short or failed. Ignoring these made
   * a failed write indistinguishable from a silent node. */
  uint32_t write_errors;
  uint32_t last_sequence;
  /**
   * Worst successful request RTT since the last reset. The bench needs the
   * tail, not the latest sample: `latency_ms` is whatever the most recent
   * request happened to cost, which on a link that stalls once in fifty
   * requests reads as healthy every time you look at it.
   */
  uint32_t latency_max_ms;
  char last_error[32]; /* "" when none */
} camlink_stats_t;

typedef struct {
  uint32_t frame_id;
  uint32_t size;
  uint32_t duration_ms; /* node-side capture duration */
  char crc32[12];       /* node-computed JPEG CRC-32, 8 hex chars */
  int32_t heap_kb;      /* node memory after capture, -1 unknown */
  int32_t psram_kb;
  /*
   * Node-side timing, in the NODE's esp_timer domain. No epoch is shared with
   * the P4 or with any other node, so only differences within one node mean
   * anything. Zero when the node did not report the field - firmware older
   * than these additions omits them.
   *
   * These exist for the stale-frame question in
   * firmware/SYNC_FEASIBILITY.md. With fb_count=1 the driver captures one
   * frame after a release and then stalls, so a later capture can return that
   * already-queued frame instantly: a photograph of the moment after the
   * PREVIOUS readout rather than of the shutter.
   *
   * Signature: fb_get_us near zero and frame_age_us large and positive.
   *
   * frame_start_us is the driver's DMA-arm timestamp (camera_fb_t.timestamp).
   * It is FRAME START. It is not exposure start, not exposure centre, and must
   * never be reported as exposure timing - a rolling shutter integrates per
   * row and this firmware cannot observe that at all.
   */
  int64_t fb_get_us;      /* wall time the node spent inside esp_camera_fb_get() */
  int64_t frame_start_us; /* node esp_timer when this frame's DMA began */
  int64_t frame_age_us;   /* command arrival minus frame start; >0 means stale */
  /*
   * The common sync edge as this node saw it (#165, node firmware 0.4.30+).
   * has_sync is false on older nodes and on a node that has never seen an
   * edge (syncEdgeUs null); sync_seq is still reported in that case (0 when
   * never seen). sync_to_frame_us = frameStartUs - syncEdgeUs is the one
   * figure comparable across nodes: each node measures its own frame against
   * the same physical pulse. Negative: the frame was in flight before the
   * pulse. Not exposure time.
   */
  bool has_sync;
  uint32_t sync_seq;       /* rising edges the node has counted since its boot */
  int64_t sync_edge_us;    /* node esp_timer at the last edge */
  int64_t sync_to_cmd_us;  /* command acted on, relative to the edge */
  int64_t sync_to_frame_us;/* frame DMA arm, relative to the edge */
  /*
   * Whether the node's freshness guarantee actually held for this frame.
   *
   * The node retries until it gets a frame whose DMA began AFTER the command
   * that asked for it. That loop is bounded, and when the bound is reached the
   * node answers ok:true with a frame armed BEFORE its own shutter. Nothing
   * marked it, so a photograph of the moment before the shutter press was
   * indistinguishable from a good one, on the card and on the wire.
   *
   * `frame_fresh` is the node's own verdict. `freshness_retries` is how many
   * frames it threw away getting there - 0 on the common path.
   *
   * true / 0 for a node too old to report the field. That is the honest
   * default: those nodes ran the same bounded loop, and assuming the failure
   * case would mark every frame from every older node as suspect.
   */
  bool frame_fresh;
  uint32_t freshness_retries;
} camlink_capture_result_t;

/**
 * The sensor knobs NL_CMD_SENSOR carries, in both directions.
 *
 * A `has_` flag per field because every one of them has a meaningful zero -
 * aeLevel 0 is the sensor's own metering target, denoise 0 is denoise off. On
 * the way out a cleared flag means "leave that knob alone", which is what lets
 * capture.c send only what changed since the last apply. On the way back a
 * cleared flag means the node has never got that knob into the sensor, so
 * META.JSON must not claim a value for it.
 *
 * Units are the wire's, not the driver's: `gain_ceiling` is an x-factor
 * (2..128) and not a gainceiling_t ordinal, and `quality` is the sensor's
 * 5..63 scale where LOWER is better - not the 60..95 percentage Studio uses.
 * See node_link.h.
 */
typedef struct {
  bool has_ae_level;
  int ae_level;      /* -2..2 */
  bool has_gain_ceiling;
  int gain_ceiling;  /* x-factor 2,4,8,16,32,64,128 */
  bool has_denoise;
  int denoise;       /* 0..8 */
  bool has_sharpness;
  int sharpness;     /* -3..3 */
  bool has_quality;
  int quality;       /* 5..63, lower is better */
} camlink_sensor_t;

/** CAM1..CAM4. Index 0 is CAM1 throughout. */
#define CAMLINK_CAMS 4

/**
 * Count one caller-driven retry of a request on this channel.
 *
 * cam_link issues exactly what it is asked to issue once; the retry policy
 * lives in capture.c (CHUNK_RETRIES). Without this the `retries` field it
 * publishes was permanently 0 while the policy fired.
 */
void camlink_note_retry_ch(int cam);

/**
 * RELEASE with no frameId: "free whatever you are holding".
 *
 * For the one exit where the P4 has no frame id to name - a CAPTURE that
 * timed out. The node may still be mid-encode; the request queues behind that
 * work and is answered when it lands, which is exactly the point. Every other
 * exit from a capture names its id and must keep using
 * camlink_release_ch(): an unconditional release racing a LATER capture would
 * free that one.
 *
 * node_server.c handle_release() treats an absent frameId as unconditional,
 * deliberately, for this call.
 */
esp_err_t camlink_release_held_ch(int cam, uint32_t timeout_ms);

esp_err_t camlink_init(void);

/*
 * Per-camera entry points.
 *
 * Every channel has its own UART, mutex, decoder and counters, so two cameras
 * can be mid-transfer at the same time — which is the only reason a four-up
 * viewfinder is a viewfinder rather than a slideshow. Nothing is shared
 * between channels except the code.
 *
 * The unsuffixed functions below are CAM1, kept because most of the firmware
 * legitimately only cares about the one node the M1B harness has.
 */
void camlink_get_info_ch(int cam, camlink_info_t *out);
void camlink_get_stats_ch(int cam, camlink_stats_t *out);
void camlink_reset_stats_ch(int cam);
esp_err_t camlink_hello_ch(int cam);

/**
 * Move one channel to a new baud, or leave it exactly where it was.
 *
 * The measured cost of a shutter is the largest JPEG divided by the line rate
 * (#218), so this is the only lever on it that does not cost picture quality.
 *
 * Both ends treat the change as provisional, because a link with two wires and
 * no flow control has no way to report that the two ends disagree about the
 * rate - nothing either of them sends would be understood. The node reverts to
 * NL_DEFAULT_BAUD unless a frame decodes at the new rate within
 * NL_BAUD_PROBE_MS; this waits longer than that before giving up, so on any
 * failure the node is already back on the default when the body looks for it.
 *
 * Returns ESP_OK only when a HELLO has been answered at the new rate. On any
 * other outcome the channel is back at NL_DEFAULT_BAUD and usable, and the
 * error says which step failed.
 *
 * Not while a capture is running: take capture_lock() first.
 */
esp_err_t camlink_set_baud_ch(int cam, uint32_t baud);

/** What the channel is running at now. 0 for an invalid cam. */
uint32_t camlink_baud_ch(int cam);
/** HELLO with a caller-chosen timeout. For a channel believed empty a few
 * hundred milliseconds is generous - a node that is there answers in a few -
 * and the difference is what a periodic probe would otherwise charge the
 * shutter: with the default 3000 ms per absent channel, three empty channels
 * held the capture lock for ~9 s of every ~19 s and half the shutter presses
 * on a one-camera body were refused BUSY (Gate F bench, 2026-08-30). */
esp_err_t camlink_hello_ch_timeout(int cam, uint32_t timeout_ms);
esp_err_t camlink_ping_ch(int cam, uint32_t *rtt_ms);

/** One STATUS round trip, for the node's sync counters alone. Measurement
 * only: it asks the node nothing about its camera and changes nothing. */
esp_err_t camlink_sync_ch(int cam, camlink_sync_t *out);
/*
 * The per-camera capture and read take an explicit timeout, because the two
 * callers want opposite things from a slow node. A stored capture is worth
 * waiting seconds for - it is the photograph. A viewfinder frame is worth
 * almost no wait at all: a pane that freezes for eight seconds is worse than
 * a pane that admits it has nothing, and the next frame is 200 ms away
 * regardless. The unsuffixed wrappers keep the capture-shaped budgets.
 */
esp_err_t camlink_capture_ch(int cam, const char *resolution, int jpeg_quality,
                             uint32_t timeout_ms, camlink_capture_result_t *out);
/**
 * Put capture settings into one node's sensor (NL_CMD_SENSOR).
 *
 * Only the fields `want` flags are sent, so a request that changes nothing is
 * never made at all - that decision belongs to the caller, which knows what it
 * sent last. `applied`, when given, receives what the node reports the sensor
 * ACCEPTED after its own clamping and snapping, which is what belongs in
 * META.JSON; it is the node's whole last-applied set, not an echo of `want`.
 *
 * ESP_ERR_INVALID_RESPONSE on a NACK (a node with no sensor answers
 * HARDWARE_ERROR), ESP_ERR_TIMEOUT on silence. Neither is fatal to a capture:
 * the sensor keeps the settings it had.
 */
esp_err_t camlink_set_sensor_ch(int cam, const camlink_sensor_t *want,
                                camlink_sensor_t *applied, uint32_t timeout_ms);
esp_err_t camlink_read_ch(int cam, uint32_t frame_id, uint32_t offset, uint8_t *buf,
                          size_t want, uint32_t timeout_ms, size_t *got);
esp_err_t camlink_release_ch(int cam, uint32_t frame_id);

/*
 * Firmware update of one node over its link (NL_CMD_FW_*; fw_update.c is
 * the caller). `code` receives the node's NACK reason when the result is
 * ESP_ERR_INVALID_RESPONSE, so the host is told BAD_SIZE or FLASH_WRITE
 * rather than "the node said no".
 */
esp_err_t camlink_fw_begin_ch(int cam, uint32_t size, const char *sha256_hex,
                              const char *version, uint32_t *chunk_max, char *code,
                              size_t code_cap);
esp_err_t camlink_fw_chunk_ch(int cam, uint32_t offset, const uint8_t *data, size_t len,
                              char *code, size_t code_cap);
esp_err_t camlink_fw_end_ch(int cam, bool *verified, char *code, size_t code_cap);
esp_err_t camlink_fw_abort_ch(int cam);

void camlink_get_info(camlink_info_t *out);
void camlink_get_stats(camlink_stats_t *out);
void camlink_reset_stats(void);

/** Ping the node and refresh identity. Marks the node online/offline. */
esp_err_t camlink_hello(void);
/** Round-trip a STATUS request; refreshes state. Cheap link-health probe. */
esp_err_t camlink_ping(uint32_t *rtt_ms);
esp_err_t camlink_capture(const char *resolution, int jpeg_quality,
                          camlink_capture_result_t *out);
/** Reads up to `want` bytes at `offset`; short reads past EOF are normal. */
esp_err_t camlink_read(uint32_t frame_id, uint32_t offset, uint8_t *buf, size_t want,
                       size_t *got);
esp_err_t camlink_release(uint32_t frame_id);

#endif
