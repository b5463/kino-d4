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
// The other three nodes. The P4 has five high-power UARTs and UART0 is the
// console, so each camera gets a port of its own — which is what lets four
// transfers overlap instead of queueing behind one another. A viewfinder
// sharing one UART between four cameras runs at a quarter of the rate.
//
// PROVISIONAL, like the rest of the header: these are the assignments
// docs/HARDWARE.md records, and no jumper has proved them yet.
// Physical controls. docs/HARDWARE.md: "Button and mode-slide pins are
// unassigned." They stay unassigned here rather than being guessed: a
// floating input read as a button fires the shutter by itself in a bag,
// which costs a roll and a battery. Assign a real pin and the control comes
// alive with no other change.
#define BOARD_BTN_NONE (-1)
#define BOARD_BTN_SHUTTER BOARD_BTN_NONE
#define BOARD_BTN_FN BOARD_BTN_NONE

#define BOARD_CAM2_UART_NUM 2
#define BOARD_CAM2_TX 50
#define BOARD_CAM2_RX 49
#define BOARD_CAM3_UART_NUM 3
#define BOARD_CAM3_TX 34
#define BOARD_CAM3_RX 33
#define BOARD_CAM4_UART_NUM 4
#define BOARD_CAM4_TX 30
#define BOARD_CAM4_RX 29

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
// One I2C bus, two devices: the GT911 touch controller and the ES8311 audio
// codec. board_i2c.c owns it; neither driver may create its own.
#define BOARD_I2C_SDA 7
#define BOARD_I2C_SCL 8

#define BOARD_TOUCH_RESET 3
#define BOARD_TOUCH_I2C_ADDR 0x5d

// --- Audio: ES8311 codec into an NS4150 class-D amp, speaker on CN1 ---
// The amp output is bridge-tied: SPEAKER_P and SPEAKER_N both swing and
// neither may be grounded. Amp supply is VOUT-BAT rather than 3V3, so volume
// behaviour follows battery state and loud transients show up on the battery
// rail (issue #4).
#define BOARD_I2S_MCLK 13
#define BOARD_I2S_BCLK 12
#define BOARD_I2S_LRCK 10
#define BOARD_I2S_DOUT 9
#define BOARD_I2S_DIN 48
// Amp enable, pulled down by R19 10k: the amp comes up MUTED and stays
// silent until this is driven high. A connected speaker that makes no sound
// is this pin before it is anything else.
#define BOARD_AUDIO_PA_EN 11
// ES8311's own address, in BOTH conventions, because the two APIs on this
// board disagree about which one they want and the mismatch costs a bench
// cycle to find.
//
// NOT 0x5d - that is the GT911 on the same bus, and the board notes conflate
// the two. An I2C scan of this board reports 0x14, 0x18 and 0x5d.
#define BOARD_ES8311_ADDR_7BIT 0x18
// esp_codec_dev takes the address pre-shifted: its own
// ES8311_CODEC_DEFAULT_ADDR is 0x30. Passing the 7-bit form addresses device
// 0x0c instead, which probes fine and NACKs every read and write.
#define BOARD_ES8311_ADDR_8BIT (BOARD_ES8311_ADDR_7BIT << 1)

#endif
