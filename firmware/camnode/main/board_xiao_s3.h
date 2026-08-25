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
/**
 * 16 MHz, measured — not the 20 MHz the Seeed material uses.
 *
 * At 20 MHz this sensor corrupts JPEG frames: 77 of 160 frames (48%) carried
 * a chroma-damaged band in a fixed ~12-pixel zone around x=498, which is JPEG
 * MCU column 31. At 16 MHz the same measurement over 200 frames gave 1 (0.5%).
 * Corrupted JPEGs at xclk 20 MHz are a known esp32-camera problem
 * (espressif/esp32-camera#244) and community guidance is to avoid multiples of
 * 10 MHz on this part.
 *
 * The cost is capture throughput, which the product barely spends: camnode
 * takes single stills, so a slower pixel clock costs a little latency per
 * capture, not frame rate. A corrupt still costs the photograph.
 *
 * The 0.5% residue is the upstream issue, not this constant. Next lever if it
 * matters is the OV3660 PCLK register fix in espressif/esp32-camera#220.
 * Measured with firmware/uvc-preview; method in its README.
 */
#define BOARD_CAM_XCLK_HZ 16000000

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
