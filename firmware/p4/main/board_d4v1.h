// KINO D4 V1 pin map for the Guition JC4880P443C-I-W (ESP32-P4 + ESP32-C6).
// Every P4 pin assignment lives in this file — no raw GPIO numbers elsewhere.
//
// PROVISIONAL: the camera/sync/flash assignments mirror the header map in
// packages/hardware-profiles/src/profiles/d4-v1.json and are locked only by
// electrical validation (issue #2). The SD block comes from the community
// field notes for this board (github.com/ultramcu/guition-jc4880p443c-i-w)
// and is likewise unverified on our unit.
#ifndef BOARD_D4V1_H
#define BOARD_D4V1_H

// --- Camera node UARTs (PROVISIONAL, 2x13 header) ---
#define BOARD_CAM1_UART_NUM 1
#define BOARD_CAM1_TX 52
#define BOARD_CAM1_RX 51
// CAM2: UART2, TX 50, RX 49 — milestone 2
// CAM3: UART3, TX 34, RX 33 — milestone 2
// CAM4: UART4, TX 30, RX 29 — milestone 2

// --- Control lines (PROVISIONAL, unused in Milestone 1) ---
#define BOARD_SYNC_OUT 32
#define BOARD_FLASH_EN 28
#define BOARD_CAM_PWR_EN 31

// --- TF/microSD, SDMMC 4-bit (field notes; MEASURE before lock) ---
#define BOARD_SD_CLK 43
#define BOARD_SD_CMD 44
#define BOARD_SD_D0 39
#define BOARD_SD_D1 40
#define BOARD_SD_D2 41
#define BOARD_SD_D3 42
// Card power comes from the P4 on-chip LDO, channel 4 (3.3 V).
#define BOARD_SD_LDO_CHANNEL 4

// --- On-board 4.3in panel, ST7701S over MIPI-DSI (Guition JC4880P443C-I-W) ---
// From the board field notes, the same source whose SD map above was
// validated on our unit on 2026-08-26. PROVISIONAL until the panel lights.
#define BOARD_LCD_RESET 5
#define BOARD_LCD_BACKLIGHT 23 /* active high, plain GPIO - not LEDC */
// DSI-PHY supply. Channel 3, deliberately not the card's channel 4: an
// on-chip LDO collision would present as a card that stops mounting when the
// screen comes up.
#define BOARD_LCD_DSI_LDO_CHANNEL 3
#define BOARD_LCD_DSI_LDO_MV 2500
// GT911 capacitive touch, sharing an I2C bus with the ES8311 codec. Unused
// until touch is actually driven - declared so the pins have one owner.
#define BOARD_TOUCH_I2C_SDA 7
#define BOARD_TOUCH_I2C_SCL 8
#define BOARD_TOUCH_RESET 3
#define BOARD_TOUCH_I2C_ADDR 0x5d

#endif
