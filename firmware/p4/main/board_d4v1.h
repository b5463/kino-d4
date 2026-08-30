// KINO D4 V1 pin map for the Guition JC4880P443C-I-W (ESP32-P4 + ESP32-C6).
// Every P4 pin assignment lives in this file — no raw GPIO numbers elsewhere.
// packages/hardware-profiles/src/profiles/d4-v1.json mirrors this file, not
// the other way round; host_tests/test_board_pins.c --dump is the cross-check.
//
// The camera/sync assignments below are header-correct (the pins exist and
// are free) and electrically UNVALIDATED until a node answers on each one
// (issue #2). The SD block was validated by a real 4-bit mount on 2026-08-26.
#ifndef BOARD_D4V1_H
#define BOARD_D4V1_H

// --- JP1, the 2x13 2.54 mm header, MEASURED on the board ---
//
// Odd pins are the LEFT column, even the RIGHT, pin 1 at the top.
//
//     pin  left            right       pin
//      1   3V3             5V           2
//      3   3V3             5V           4
//      5   GND             GND          6
//      7   GPIO52          GPIO33       8
//      9   GPIO51          GPIO31      10
//     11   GPIO50          GPIO30      12
//     13   GPIO49          GPIO29      14
//     15   GPIO35          GND         16
//     17   GPIO34          ESP_3V3     18
//     19   GPIO32          C6_U0RXD    20
//     21   GPIO28          C6_U0TXD    22
//     23   I2C_SDA         C6_IO9      24
//     25   I2C_SCL         C6_CHIP_PU  26
//
// Twelve P4 GPIOs reach the header: 52, 51, 50, 49, 35, 34, 32, 28 on the
// left and 33, 31, 30, 29 on the right. Eleven signals are wanted -- four
// TX/RX pairs, SYNC_OUT, CAM_PWR_EN, BTN_SHUTTER -- so GPIO35 (pin 15) is
// still the one spare. Eleven, not twelve: FLASH_EN held GPIO28 / pin 21
// under ECN-0002 and handed it to the shutter button on 2026-08-30
// (ECN-0003). Right column pins 20/22/24/26 are the C6 programming and
// recovery lines and stay reserved; pin 18 is the C6's own supply.
//
// THIS TABLE IS MEASURED, NOT TRANSCRIBED. It has been wrong twice, both
// times from copying someone's table:
//
//   1bc8a7e  entered from an assumed third-party expansion list
//   944b68e  "corrected" to the JC-ESP32P4-M3-DEV pinout -- a DIFFERENT
//            carrier that happens to use the same P4 module. That map put
//            CAM1 on GPIO1/GPIO2, which reach nothing here, and the bench
//            spent a session proving it: a node that never answered, then a
//            TX-to-RX loopback on JP1 7-9 that received zero bytes.
//
// It was then settled electrically. The P4 drove every GPIO in turn, each
// announcing its own index in binary, while a node watched one wire:
//
//   JP1 13 (7th down, left)  -> GPIO49
//   JP1  7 (4th down, left)  -> GPIO52   (predicted before the run)
//
// Both agree with the manufacturer PIN DEFINITIONS drawing for the
// JC4880P443C-I-W, which is the board we actually have. ECN-0002.
//
// Do not edit these numbers from a datasheet, a photo of another board, or a
// vendor page. Measure the pin. firmware/p4/host_tests/test_board_pins.c
// and board_d4v1_checks.h hold the table to itself; only the bench can hold
// it to the copper.
//
// UART TX/RX on the P4 go through the GPIO matrix on every port; there is no
// IOMUX restriction, so any header GPIO can carry any of UART1-4.

// Unassigned control line. Numerically equal to GPIO_NUM_NC (-1); every user
// must skip gpio_config and gpio_set_level for a pin equal to this.
#define BOARD_GPIO_NONE (-1)

// --- Camera nodes, one UART each ---
// UART0 is the console, so the four remaining ports carry the four cameras,
// which is what lets four transfers overlap instead of queueing.
// BOARD_*_JP1 is the header pin the wire lands on.
#define BOARD_CAM1_UART_NUM 1
#define BOARD_CAM1_TX 52
#define BOARD_CAM1_RX 51
#define BOARD_CAM1_TX_JP1 7
#define BOARD_CAM1_RX_JP1 9

#define BOARD_CAM2_UART_NUM 2
#define BOARD_CAM2_TX 50
#define BOARD_CAM2_RX 49
#define BOARD_CAM2_TX_JP1 11
#define BOARD_CAM2_RX_JP1 13

#define BOARD_CAM3_UART_NUM 3
#define BOARD_CAM3_TX 34
#define BOARD_CAM3_RX 33
#define BOARD_CAM3_TX_JP1 17
#define BOARD_CAM3_RX_JP1 8

#define BOARD_CAM4_UART_NUM 4
#define BOARD_CAM4_TX 30
#define BOARD_CAM4_RX 29
#define BOARD_CAM4_TX_JP1 12
#define BOARD_CAM4_RX_JP1 14

// --- Control lines ---
// SYNC_OUT fans out to all four XIAO SYNC_IN pins. Driven by capture.c;
// the node side does not arm on it yet.
#define BOARD_SYNC_OUT 32
#define BOARD_SYNC_OUT_JP1 19
// CAM_PWR_EN keeps the P4 in charge of the camera bank's high-side switch.
// It is the last control line with a header pin: GPIO28 on pin 21 belongs to
// the shutter button now.
#define BOARD_CAM_PWR_EN 31
#define BOARD_CAM_PWR_EN_JP1 10
// FLASH_EN has no P4 pin in D4-V1. The built-in flash was dropped on
// 2026-08-30 (ECN-0003) in favour of a separate external module, and its pin
// went to the shutter button. There is no BOARD_FLASH_EN_JP1: it would name a
// header position nothing drives.
//
// This makes capture.c's BOARD_GPIO_NONE branch the LIVE path on this board,
// not a leftover from the pre-measurement map: gpio_setup() skips the flash
// pin, flash_set() drives nothing, and a flash request is accepted and has no
// electrical effect.
#define BOARD_FLASH_EN BOARD_GPIO_NONE
// JP1 15 / GPIO35: routed to the header, assigned to nothing.
//
// LEAVE IT UNCONNECTED. GPIO35 is the ESP32-P4's serial-bootloader strap:
// held LOW at reset the chip enters the ROM downloader instead of running the
// app, and the combination GPIO36=0 with GPIO35=0 is documented as invalid.
// It idles high on an internal pullup, so an unwired pin is safe and a pin
// wired to ground is a board that will not boot -- which on a bench reads as
// dead firmware, not as a wiring mistake.
//
// GPIO34 (CAM3_TX, pin 17) is a strapping pin too. It is safe here because it
// is ours to DRIVE and the far end is a node's UART RX, which is high
// impedance and cannot hold it during our reset. Do not invert that: never
// put a camera's TX -- an input to us -- on 34 or 35.
#define BOARD_SPARE_JP1 15

// Physical controls.
//
// The shutter is a 6x6x4.3 mm tactile switch between JP1 21 (GPIO28) and GND.
// No resistor on the harness: buttons.c enables the internal pull-up, reads
// active low, and debounces 25 ms with a 600 ms long-press threshold.
//
// A switch to ground is safe HERE and not everywhere. The ESP32-P4's
// strapping pins are GPIO34..GPIO38; GPIO28 is not one of them, so holding it
// low across a reset changes no boot decision. GPIO35 on JP1 15 is the
// serial-bootloader strap, which is why the spare stays unwired -- a button
// there would be a board that comes up in the ROM downloader.
//
// BTN_FN keeps no pin rather than being guessed onto one: a floating input
// read as a button fires the shutter by itself in a bag, which costs a roll
// and a battery. Assign a real pin and the control comes alive with no other
// change.
#define BOARD_BTN_NONE (-1)
#define BOARD_BTN_SHUTTER 28
#define BOARD_BTN_SHUTTER_JP1 21
#define BOARD_BTN_FN BOARD_BTN_NONE

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
