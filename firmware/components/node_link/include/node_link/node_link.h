// P4 <-> XIAO camera-node link. Reuses the KDP frame layout, CRC and decoder
// from kdp_core on a separate physical UART, so boot-spew tolerance and
// resync behavior are identical on both links. Command ids below are this
// link's own namespace — they never appear on the Studio link.
#ifndef NODE_LINK_H
#define NODE_LINK_H

#define NL_PROTOCOL_VERSION 1

// Default camera-link baud. Escalation to 1.5/2/3 Mbaud is bench work driven
// through KDP SET_LINK_BAUD/LINK_BENCH (milestone 3), not a compile default.
#define NL_DEFAULT_BAUD 921600

// Largest data slice in one NL_CMD_READ response (matches the KDP firmware
// chunk convention; well under KDP_MAX_PAYLOAD).
#define NL_CHUNK_MAX 8192

typedef enum {
  // -> {} <- {product,protocol,firmware,sessionId,resetReason,chipRevision,
  //           heapKB,psramKB,baud,sensor,sensorPid,sensorDetected,autofocus,
  //           maxResolution}
  NL_CMD_HELLO = 0x01,
  // -> {} <- {state,frameId,frameSize?,heapKB,psramKB,crcFailures,resyncs}
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
