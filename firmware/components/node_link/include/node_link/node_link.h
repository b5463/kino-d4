// P4 <-> XIAO camera-node link. Reuses the KDP frame layout, CRC and decoder
// from kdp_core on a separate physical UART, so boot-spew tolerance and
// resync behavior are identical on both links. Command ids below are this
// link's own namespace — they never appear on the Studio link.
#ifndef NODE_LINK_H
#define NODE_LINK_H

#define NL_PROTOCOL_VERSION 1

// Default camera-link baud. Escalation to 1.5/2/3 Mbaud is bench work driven
// through KDP SET_LINK_BAUD/LINK_BENCH (milestone 3), not a compile default.
/*
 * 921600. Halving it to 460800 was tried and is not kept.
 *
 * The RX FIFO is 128 bytes, which is 1.39 ms of tolerance at this rate, and
 * overruns do happen: the driver resets the FIFO on one, so the frame in
 * flight is lost and the read times out. 460800 doubles the tolerance and did
 * cut overruns from 4-10 per capture to 1-4, but it did not eliminate them and
 * it doubles every transfer on all four cameras. Since a lost chunk is
 * recovered by a retry either way, the faster line with retries beats the
 * slower line without them.
 */
#define NL_DEFAULT_BAUD 921600

// Largest data slice in one NL_CMD_READ response (matches the KDP firmware
// chunk convention; well under KDP_MAX_PAYLOAD).
/*
 * 8192, and the size was tested rather than assumed.
 *
 * An overrun destroys the frame in flight, so shrinking chunks looked like it
 * should limit the damage. It did the opposite: at 2048 a 170 KB capture takes
 * 83 requests instead of 21 and the bench measured about one overrun per
 * request - 30 overruns and 30 retries in a single capture, against 4 with 8 KB
 * chunks. The hazard scales with the number of request/response turnarounds,
 * not with the bytes carried, so fewer and larger chunks is the cheaper trade.
 */
#define NL_CHUNK_MAX 8192

typedef enum {
  // -> {} <- {product,protocol,firmware,sessionId,resetReason,chipRevision,
  //           heapKB,psramKB,baud,sensor,sensorPid,sensorDetected,autofocus,
  //           maxResolution}
  NL_CMD_HELLO = 0x01,
  // -> {} <- {state,frameId,frameSize?,heapKB,psramKB,tempC,crcFailures,resyncs,
  //           sensor?}
  /*
   * `sensor` is the last set NL_CMD_SENSOR actually got into the sensor on
   * this node, same field names and same units as the SENSOR reply's
   * `applied`. Only the fields the node has applied appear — and in practice
   * it is always present with at least `quality`, because camsensor_init
   * seeds the read-back JPEG quality on boot. Do not read presence as "the
   * P4 has configured this node".
   *
   * A bench diagnostic, not a control input: the P4 detects a node reset by
   * comparing HELLO's boot session (cam_link.c caches it per camera and
   * clears its change-only sensor cache on a mismatch), and nothing on the
   * P4 parses this field. It is here so a human at a terminal can ask a node
   * what its sensor is actually set to.
   */
  NL_CMD_STATUS = 0x02,
  // -> {resolution?,quality?} <- {ok,frameId,size,durationMs,crc32,heapKB,psramKB}
  NL_CMD_CAPTURE = 0x10,
  NL_CMD_READ = 0x11,    // -> {frameId,offset,length} <- BINARY slice (short past EOF)
  NL_CMD_RELEASE = 0x12, // -> {frameId} <- {ok}

  /*
   * ---- RESERVED, NOT IMPLEMENTED ----
   *
   * The arm/trigger flow. Specified here and deliberately unimplemented on
   * both ends: firmware/SYNC_FEASIBILITY.md (verdict SMALL_DRIVER_EXTENSION)
   * establishes that the mechanism is constructible, and the roadmap holds it
   * for M4 so that it is built against measured skew rather than a prediction.
   * A node that receives either of these today answers UNSUPPORTED_COMMAND,
   * which is the correct behaviour for a reserved opcode.
   *
   * Reserving the numbers now costs nothing and stops two people picking the
   * same one later.
   */

  /*
   * NL_CMD_ARM — prepare to capture on a GPIO edge instead of on a command.
   *
   *   -> {resolution?, quality?, timeoutMs?}
   *   <- {ok, armed, armReceivedUs, armedUs}
   *
   * The node prepares the sensor, holds its frame buffer so the driver's
   * capture stalls (buffer availability is the gate — see the study), installs
   * an ISR on BOARD_SYNC_IN, and reports ARMED. It must self-disarm after
   * `timeoutMs` so a node whose trigger never arrives returns to READY rather
   * than holding the buffer for ever.
   */
  NL_CMD_ARM = 0x13,

  /*
   * NL_CMD_TRIGGER_INFO — what the node observed about the last armed capture.
   *
   *   -> {}
   *   <- {ok, frameId, timing:{...}}
   *
   * Every timing field is nullable and MUST be null rather than 0 when the
   * node did not observe it. A fabricated timestamp here would be laundered
   * into a skew figure and then into a product claim.
   *
   *   armReceivedUs    node esp_timer at ARM receipt
   *   armedUs          node esp_timer once the sensor was held and the ISR set
   *   syncEdgeUs       node esp_timer in the GPIO ISR  (null if never fired)
   *   captureStartUs   node esp_timer when the buffer was released to the driver
   *   frameStartUs     camera_fb_t.timestamp — DMA start for the returned
   *                    frame. PUBLIC API, available today, and the one field
   *                    that anchors a cross-node comparison: the difference
   *                    (frameStartUs - syncEdgeUs) is comparable between nodes
   *                    with no clock synchronisation between them.
   *   frameCompleteUs  node esp_timer when esp_camera_fb_get() returned
   *
   * All values are that node's own esp_timer microseconds and share no epoch
   * with any other node or with the P4. Only DIFFERENCES within one node are
   * meaningful across nodes.
   *
   * What this is not: none of these is exposure skew. Frame start is not
   * exposure start, and a rolling shutter integrates per row. The three
   * kino.capture skews stay null with an unavailableReason regardless of what
   * this reports.
   */
  NL_CMD_TRIGGER_INFO = 0x14,

  /*
   * NL_CMD_SENSOR — put capture settings into the sensor before the shutter.
   *
   *   -> {aeLevel?, gainCeiling?, denoise?, sharpness?, quality?}
   *   <- {ok:true, applied:{...}}
   *
   * Why it exists: a QUAD slot carries exposureBias and gain per camera and
   * every look carries a capture block (jpegQuality, exposureBias, gainLimit,
   * denoise, sharpness), and until this command none of it reached a sensor.
   * The link could only ask for a resolution and a JPEG quality, so a slot set
   * to -1.5 EV and a slot set to 0 EV produced the same photograph and the
   * only honest thing to call the exposure controls was decorative.
   *
   * Request fields, all OPTIONAL — an absent field means "leave that knob as
   * it is", which is what makes the P4's change-only cache possible:
   *
   *   aeLevel      -2..2, the AEC target offset. The driver takes -5..5 on the
   *                OV3660; the link is narrower because that is the range
   *                Studio's exposureBias slider covers.
   *   gainCeiling  an X-FACTOR, not an enum ordinal: 2, 4, 8, 16, 32, 64 or
   *                128. Anything else is snapped to the nearest of those by
   *                the node, so a look's gainLimit of 12 may be sent as it is.
   *   denoise      0..8, 0 being off.
   *   sharpness    -3..3.
   *   quality      the SENSOR's JPEG scale, 5..63, where LOWER is better —
   *                not the 60..95 percentage the KDP contract and Studio use.
   *                The P4 converts (pure_quality_to_sensor). Optional because
   *                NL_CMD_CAPTURE also carries it.
   *
   * The reply's `applied` echoes what the sensor accepted AFTER clamping and
   * snapping, field by field, and it is the only truthful record of the
   * exposure: META.JSON stores this, never what was asked. A knob the node
   * could not write (no such setter on the detected part, or the driver
   * refused the value) is simply absent from `applied`.
   *
   * NACK HARDWARE_ERROR when no sensor answered the node's bus. A NACK or a
   * timeout does not stop the capture: a photograph taken with the previous
   * settings beats no photograph.
   */
  NL_CMD_SENSOR = 0x15,

  NL_CMD_REBOOT = 0x20,  // -> {} <- {ok}, then the node restarts
} nl_cmd_t;

// Node state machine, reported as strings in NL_CMD_STATUS. The P4 maps
// these onto the KDP CameraState vocabulary.
#define NL_STATE_BOOTING "booting"
#define NL_STATE_INIT_SENSOR "initializing-sensor"
#define NL_STATE_READY "ready"
#define NL_STATE_EXPOSING "exposing"
#define NL_STATE_JPEG_READY "jpeg-ready"
#define NL_STATE_TRANSFERRING "transferring"
#define NL_STATE_ERROR "error"
/* RESERVED alongside NL_CMD_ARM: sensor prepared, frame buffer held, GPIO ISR
 * installed, waiting for the trigger edge. No node reports this yet. */
#define NL_STATE_ARMED "armed"

#endif
