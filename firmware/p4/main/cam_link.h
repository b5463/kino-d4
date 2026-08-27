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

typedef struct {
  uint32_t rx_frames;
  uint32_t tx_frames;
  uint32_t rx_bytes;
  uint32_t tx_bytes;
  uint32_t crc_errors;
  uint32_t resyncs;
  uint32_t timeouts;
  uint32_t retries; /* zero until a retry policy exists */
  uint32_t duplicates;
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
} camlink_capture_result_t;

/** CAM1..CAM4. Index 0 is CAM1 throughout. */
#define CAMLINK_CAMS 4

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
esp_err_t camlink_ping_ch(int cam, uint32_t *rtt_ms);
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
esp_err_t camlink_read_ch(int cam, uint32_t frame_id, uint32_t offset, uint8_t *buf,
                          size_t want, uint32_t timeout_ms, size_t *got);
esp_err_t camlink_release_ch(int cam, uint32_t frame_id);

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
