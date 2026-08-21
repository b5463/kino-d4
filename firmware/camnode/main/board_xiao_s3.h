// XIAO ESP32-S3 Sense pin map. The DVP block is OFFICIAL_SPEC (Seeed wiki,
// mirrored in packages/hardware-profiles/src/profiles/d4-v1.json). The link
// and sync pins are PROVISIONAL until issue #2 locks the harness.
// Every camnode pin lives in this file — no raw GPIO numbers elsewhere.
#ifndef BOARD_XIAO_S3_H
#define BOARD_XIAO_S3_H

// --- Camera DVP bus (OFFICIAL_SPEC) ---
#define BOARD_CAM_XCLK 10
#define BOARD_CAM_SIOD 40 /* CAM_SDA */
#define BOARD_CAM_SIOC 39 /* CAM_SCL */
#define BOARD_CAM_Y9 48
#define BOARD_CAM_Y8 11
#define BOARD_CAM_Y7 12
#define BOARD_CAM_Y6 14
#define BOARD_CAM_Y5 16
#define BOARD_CAM_Y4 18
#define BOARD_CAM_Y3 17
#define BOARD_CAM_Y2 15
#define BOARD_CAM_VSYNC 38
#define BOARD_CAM_HREF 47
#define BOARD_CAM_PCLK 13
#define BOARD_CAM_XCLK_HZ 20000000

// --- P4 link (PROVISIONAL) ---
// UART1 on the module's D6/D7 pads. These are also UART0's default pads, so
// the ROM bootloader prints its banner here at reset — tolerated boot spew.
#define BOARD_LINK_UART_NUM 1
#define BOARD_LINK_TX 43
#define BOARD_LINK_RX 44

// --- Sync input (PROVISIONAL, unused in Milestone 1) ---
#define BOARD_SYNC_IN 2

// --- User LED (Seeed: active-low yellow LED) ---
#define BOARD_LED 21

#endif
