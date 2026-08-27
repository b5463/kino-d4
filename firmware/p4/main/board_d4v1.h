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

// --- The 2x13 header, as photographed on the physical board ---
//
// The map this file and d4-v1.json carried was WRONG. Rows 1-3 and the C6
// block matched; almost nothing else did, and not one of the eight camera UART
// pins existed. Silkscreen of JC-ESP32P4-M3-DEV, top to bottom:
//
//     row   left            right
//      1    3V3             5V
//      2    3V3             5V
//      3    GND             GND
//      4    GPIO1           NC
//      5    GPIO2           GPIO47
//      6    GPIO3           GPIO46
//      7    GPIO4           GPIO45
//      8    GPIO5           GND
//      9    GPIO20          3V3
//     10    GPIO32          C6_U0RXD
//     11    GPIO33          C6_U0TXD
//     12    ES I2C_SDA      C6_IO9
//     13    ES I2C_SCL      C6_CHIP_PU
//
// GPIO52/51/50/49/35/34/31/30/29/28 are not brought out anywhere. CAM1 was
// opening UART1 on GPIO52/51, which route to nothing: the link would have
// failed at the first checkpoint looking exactly like a wiring or ground
// fault, which is the most expensive way to be told a pin map is fiction.
//
// Of the eleven header GPIOs, two are already spoken for by peripherals that
// are validated on hardware — GPIO3 is TOUCH_RESET and GPIO5 is LCD_RESET —
// leaving nine: 1, 2, 4, 20, 32, 33, 45, 46, 47.
//
// --- CAM1 (real header pins, row 4 and row 5 of the left column) ---
#define BOARD_CAM1_UART_NUM 1
#define BOARD_CAM1_TX 1
#define BOARD_CAM1_RX 2
// The other three nodes. The P4 has five high-power UARTs and UART0 is the
// console, so each camera gets a port of its own — which is what lets four
// transfers overlap instead of queueing behind one another. A viewfinder
// sharing one UART between four cameras runs at a quarter of the rate.
//
// !! CAM2-4 BELOW STILL POINT AT PINS THAT DO NOT EXIST ON THIS HEADER !!
//
// Left alone deliberately rather than guessed at, because reassigning them is
// an M2 decision with a real constraint behind it. Nine header GPIOs are free
// and the design wants eleven:
//
//     4 cameras x 2 (TX/RX)   8
//     SYNC_OUT                1
//     CAM_PWR_EN              1
//     FLASH_EN                1
//                            --
//                            11   against 9 available
//
// So the four-camera body does not fit this carrier as drawn, and something
// has to give: FLASH_EN has no hardware behind it yet, the ES I2C pins could
// carry an I/O expander for the slow control lines, or the header is not the
// only way off this board. That is a bring-up finding for M2 to settle with
// the schematic in hand, not something to invent here.
//
// Harmless meanwhile: these GPIO numbers are valid on the chip and simply
// route nowhere on this carrier, so the three channels time out exactly as
// they would with no node fitted. M1 uses CAM1 only.
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

// --- TF/microSD, SDMMC slot 0, 4-bit ---
//
// These six are not a choice. They are the ESP32-P4's slot-0 IOMUX pads,
// verbatim from soc/esp32p4/include/soc/sdmmc_pins.h, and the board wires the
// card to them — which is why the map was right and why a real 29820 MB
// 4-bit mount validated it on 2026-08-26.
//
// SLOT 0, explicitly. `SDMMC_HOST_DEFAULT()` selects slot 1, and slot 1 is the
// slot ESP-Hosted needs for the C6 radio. Slot 0 is also simply correct for a
// card on these pins: slot 1 has no IOMUX path at all ("SLOT1 doesn't go
// through IOMUX"), so leaving the card there pushed its dedicated pads through
// the GPIO matrix for nothing. See firmware/C6_HARDWARE_MAP.md.
#define BOARD_SD_SLOT 0
#define BOARD_SD_CLK 43
#define BOARD_SD_CMD 44
#define BOARD_SD_D0 39
#define BOARD_SD_D1 40
#define BOARD_SD_D2 41
#define BOARD_SD_D3 42
// Card power comes from the P4 on-chip LDO, channel 4 (3.3 V).
#define BOARD_SD_LDO_CHANNEL 4

// --- ESP32-C6 hosted radio, SDMMC slot 1, 4-bit (PROVISIONAL, issue #2) ---
//
// PROVISIONAL: identified from Guition documentation for this carrier and
// corroborated pin-for-pin by Espressif's own ESP-Hosted defaults for a P4
// host with a C6 coprocessor (esp_hosted 3.0.6,
// host/mcu/eh_host_mcu_transport/Kconfig.host.sdio, where min == max for each
// pin). Nothing here has been driven. firmware/C6_HARDWARE_MAP.md carries the
// full evidence chain and what is still unknown.
//
// Slot 1, because slot 0 is the card's and slot 1 is the matrix-routable one.
// One SDMMC controller serves both slots — separate pins are not separate
// driver resources, and that distinction is the whole of the arbitration.
#define BOARD_C6_SLOT 1
#define BOARD_C6_D0 14
#define BOARD_C6_D1 15
#define BOARD_C6_D2 16
#define BOARD_C6_D3 17
#define BOARD_C6_CLK 18
#define BOARD_C6_CMD 19

// The C6's CHIP_PU, reached from the P4. An ENABLE, not a reset request:
//
//   LOW  -> C6 held off
//   HIGH -> C6 released and running
//
// Named `EN` rather than `RESET` on purpose. On an active-low enable a macro
// called C6_RESET_HIGH() asserts the opposite of what it reads like, and this
// is the one signal where being wrong leaves a board that will not boot.
//
// POLARITY UNCONFIRMED on this carrier. ESP-Hosted defaults to active-low
// ("pull LOW to assert reset, HIGH to run") and carries an explicit active-high
// override for boards whose EN is buffered through an inverting transistor.
// We do not know which this is. BOARD_C6_EN_ACTIVE_LOW is that decision, in
// one place, so the bench can flip it.
#define BOARD_C6_EN 54
#define BOARD_C6_EN_ACTIVE_LOW 1

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
