/**
 * One shutter press, every fitted camera, one folder on the card.
 *
 * This is the product path. `run_capture()` in kdp_server.c is the bench one:
 * a single camera, exhaustively instrumented, answering "does CAM1 work".
 * This answers "did the camera take the picture", which is a different
 * question with different failure rules — a dead CAM3 must cost you CAM3, not
 * the shot.
 *
 * ## Why the frames are fetched concurrently
 *
 * The node link runs at 921600 baud, about 92 KB/s. A UXGA JPEG is 200-400 KB,
 * so pulling one frame takes two to four seconds. Done in turn, four cameras
 * would be twelve seconds and the last frame would be a different moment, a
 * different pose and possibly a different room. Each camera has its own UART,
 * so they are fetched at the same time by four workers and the whole capture
 * costs about what one frame costs.
 *
 * ## What the trigger wire does, and does not, do
 *
 * BOARD_SYNC_OUT is pulsed at the start of every capture. The camera nodes do
 * not yet arm on that edge — they capture when their NL_CMD_CAPTURE arrives —
 * so today the pulse coordinates nothing. It is driven, timed and recorded
 * anyway so the wire is proven and the node-side arm is a node change alone.
 *
 * Until that exists, the frames are separated by however long it takes to
 * wake four workers and put four commands on four UARTs. `spread_us` measures
 * exactly that and META.JSON reports it. What it is *not* is any of the three
 * skews in `kino.capture.timing`: those stay null with a reason, because a
 * free-running rolling shutter's exposure has no fixed relationship to when
 * its command arrived (04 §14). Reporting dispatch spread as exposure skew
 * would be the single most misleading number this firmware could produce.
 */
#ifndef KINO_CAPTURE_H
#define KINO_CAPTURE_H

#include <stdbool.h>
#include <stdint.h>

#include "cam_link.h"
#include "esp_err.h"

#define CAPTURE_CAMS CAMLINK_CAMS

/** What became of one camera's frame. */
typedef struct {
  bool attempted;      /* the camera was online, so a frame was asked for */
  bool ok;             /* bytes are on the card and the CRC matched */
  uint32_t bytes;
  uint32_t node_ms;    /* the node's own capture duration */
  uint32_t transfer_ms;
  uint32_t write_ms;
  int32_t fire_us;     /* when the command went out, relative to the trigger */
  uint32_t crc;        /* CRC-32 read back from the stored file */
  bool crc_match;      /* stored file agrees with the node's own CRC */
  char err[48];        /* "" when ok; a reason a person can act on when not */
} capture_frame_t;

/** What became of the press. */
typedef struct {
  bool ok;                /* at least one frame is on the card */
  char id[16];            /* "CAP_000042" */
  char uuid[40];
  char dir[72];
  char mode[12];          /* wiggle | quad | single */
  char resolution[16];
  char captured_at[40];   /* ISO 8601; read clock_source alongside it */
  int64_t captured_at_ms; /* the same instant, for consumers that sort */
  const char *clock_source;
  const char *status;     /* complete | partial | failed — kino.capture states */
  /* What fired it: "shutter", "shutter-hold", "button" or "host".
   *
   * Copied, not pointed at. The async path fills this from a buffer on the
   * capture task's stack, and the report outlives the call - capture_last()
   * hands it out for as long as the camera is on. A pointer here read fine
   * for exactly as long as nothing else used that stack. */
  char source[16];
  int online;             /* cameras that answered a status probe */
  int stored;             /* frames that reached the card intact */
  uint32_t bytes;
  uint32_t total_ms;
  uint32_t spread_us;     /* dispatch spread, not exposure skew — see above */
  capture_frame_t cam[CAPTURE_CAMS];
  char err_code[24];      /* §14 code when !ok */
  char err_msg[96];
} capture_report_t;

/** Progress, so a UI can say something true while three seconds pass. */
typedef enum {
  CAPTURE_IDLE = 0,
  CAPTURE_TRIGGERING, /* trigger asserted, commands going out */
  CAPTURE_READING,    /* frames coming back over the links */
  CAPTURE_WRITING,    /* frames going to the card */
  CAPTURE_DONE,       /* a report is waiting in capture_last() */
} capture_stage_t;

/** `device_id` is stamped into every META.JSON, so a card that ends up in the
 * wrong bag still says which body took the pictures. */
esp_err_t capture_init(const char *device_id);

/**
 * Take a picture and return when it is on the card.
 *
 * Blocks for as long as the slowest link takes — seconds, not milliseconds.
 * Call it from the KDP task or the capture task, never from the draw loop.
 * Returns ESP_ERR_INVALID_STATE if a capture is already running.
 */
esp_err_t capture_fire(const char *source, capture_report_t *out);

/** Queue a capture and return immediately. The UI and the physical button use
 * this; watch capture_stage() and read capture_last() when it reaches DONE.
 * Returns false when one is already running, so a double-press is ignored
 * rather than queued — nobody wants their second press two shots later. */
bool capture_request(const char *source);

capture_stage_t capture_stage(void);
bool capture_busy(void);

/** Clears CAPTURE_DONE back to CAPTURE_IDLE. The UI calls this when it has
 * finished showing the result, so the stage says "there is something to
 * show" rather than merely "the last capture ended". */
void capture_ack(void);

/** The most recent report, complete or failed. `ok` is false and `id` empty
 * before the first capture of this boot. */
void capture_last(capture_report_t *out);

/** Captures committed since boot, for the status screen. */
uint32_t capture_count(void);

/**
 * Convert the host-facing quality percentage to the sensor's scale.
 *
 * `jpegQuality` is documented as 60..95 across the contract and Studio's
 * sliders, where higher is better. esp32-camera's `set_quality` takes 5..63
 * where *lower* is better. Nothing converted between them, so asking for the
 * best quality Studio offers produced the worst JPEG the sensor can make —
 * silently, since both numbers are in range for the other scale.
 */
int capture_quality_to_sensor(int percent);

/** Fill a cJSON object with a `kino.capture` v1 document for this report.
 * Declared as void* so callers that do not use cJSON need not include it. */
void capture_meta_json(const capture_report_t *r, void *cjson_object);

/** Called on the capture task once a report is final, however it ended.
 * kdp_server uses it to emit EVT_CAPTURE so a host learns about a picture
 * someone took on the camera without having to poll for it. */
typedef void (*capture_done_cb_t)(const capture_report_t *r);
/** Registers a listener. Up to CAPTURE_MAX_LISTENERS of them; a listener runs
 * on the capture task, so it must not block. */
#define CAPTURE_MAX_LISTENERS 4
void capture_on_done(capture_done_cb_t cb);

/** RFC 4122 v4, from the hardware RNG. */
void capture_uuid4(char *out, size_t cap);

/**
 * Parse a "WIDTHxHEIGHT" resolution string.
 *
 * Returns false and leaves the outputs untouched on anything it does not fully
 * understand — trailing junk, a missing dimension, a zero, or a value larger
 * than this firmware advertises. Callers use the failure to fall back to a
 * conservative bound rather than to a zero, because a zero would size a
 * space reservation to nothing.
 *
 * Pure, host-tested.
 */
bool capture_parse_resolution(const char *s, uint32_t *width, uint32_t *height);

#endif
