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

#endif
