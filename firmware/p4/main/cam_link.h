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
  char last_error[32]; /* "" when none */
} camlink_stats_t;

typedef struct {
  uint32_t frame_id;
  uint32_t size;
  uint32_t duration_ms; /* node-side capture duration */
  char crc32[12];       /* node-computed JPEG CRC-32, 8 hex chars */
  int32_t heap_kb;      /* node memory after capture, -1 unknown */
  int32_t psram_kb;
} camlink_capture_result_t;

esp_err_t camlink_init(void);
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
