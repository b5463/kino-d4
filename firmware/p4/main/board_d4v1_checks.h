// Compile-time proof that the camera pin map in board_d4v1.h is consistent
// with itself, with the rest of the board, and with the JP1 header.
//
// Included from cam_link.c (the one file that opens the four UARTs) and from
// host_tests/test_board_pins.c. Any edit to a camera, SYNC or JP1 macro that
// breaks these fails the build rather than the bench.
#ifndef BOARD_D4V1_CHECKS_H
#define BOARD_D4V1_CHECKS_H

#include "board_d4v1.h"

// Manufacturer JP1 table, GPIO by pin number. Only the P4 GPIO positions are
// listed; every other position is power, ground, NC, ESI2C or the C6.
#define BOARD_JP1_GPIO_AT(pin)                                                \
  ((pin) == 7    ? 52                                                         \
   : (pin) == 8  ? 33                                                         \
   : (pin) == 9  ? 51                                                         \
   : (pin) == 10 ? 31                                                         \
   : (pin) == 11 ? 50                                                         \
   : (pin) == 12 ? 30                                                         \
   : (pin) == 13 ? 49                                                         \
   : (pin) == 14 ? 29                                                         \
   : (pin) == 15 ? 35                                                         \
   : (pin) == 17 ? 34                                                         \
   : (pin) == 19 ? 32                                                         \
   : (pin) == 21 ? 28                                                         \
                 : -1)

// The twelve header GPIOs. All are free: none of the P4's other peripherals
// land on this connector, so unlike the previous map there is no pin that is
// simultaneously on JP1 and owned by the panel or the touch controller.
#define BOARD_IS_FREE_JP1_GPIO(g)                                             \
  ((g) == 52 || (g) == 51 || (g) == 50 || (g) == 49 || (g) == 35 ||           \
   (g) == 34 || (g) == 32 || (g) == 28 || (g) == 33 || (g) == 31 ||           \
   (g) == 30 || (g) == 29)

// Everything else the P4 drives on this carrier.
#define BOARD_IS_RESERVED_GPIO(g)                                             \
  ((g) == BOARD_SD_CLK || (g) == BOARD_SD_CMD || (g) == BOARD_SD_D0 ||        \
   (g) == BOARD_SD_D1 || (g) == BOARD_SD_D2 || (g) == BOARD_SD_D3 ||          \
   (g) == BOARD_C6_D0 || (g) == BOARD_C6_D1 || (g) == BOARD_C6_D2 ||          \
   (g) == BOARD_C6_D3 || (g) == BOARD_C6_CLK || (g) == BOARD_C6_CMD ||        \
   (g) == BOARD_C6_EN || (g) == BOARD_I2C_SDA || (g) == BOARD_I2C_SCL ||      \
   (g) == BOARD_I2S_MCLK || (g) == BOARD_I2S_BCLK || (g) == BOARD_I2S_LRCK || \
   (g) == BOARD_I2S_DOUT || (g) == BOARD_I2S_DIN || (g) == BOARD_AUDIO_PA_EN || \
   (g) == BOARD_LCD_RESET || (g) == BOARD_LCD_BACKLIGHT ||                    \
   (g) == BOARD_TOUCH_RESET)

// One signal: valid GPIO range, on the header, free, not a peripheral pin, and
// its JP1 macro names the position the manufacturer table gives that GPIO.
#define BOARD_CHECK_SIGNAL(name)                                              \
  _Static_assert(name >= 0 && name <= 54, #name " outside GPIO0..54");        \
  _Static_assert(BOARD_IS_FREE_JP1_GPIO(name), #name " is not a free JP1 GPIO"); \
  _Static_assert(!BOARD_IS_RESERVED_GPIO(name), #name " collides with a peripheral pin"); \
  _Static_assert(name##_JP1 >= 1 && name##_JP1 <= 26, #name "_JP1 outside 1..26"); \
  _Static_assert(BOARD_JP1_GPIO_AT(name##_JP1) == name, #name "_JP1 does not carry " #name)

BOARD_CHECK_SIGNAL(BOARD_CAM1_TX);
BOARD_CHECK_SIGNAL(BOARD_CAM1_RX);
BOARD_CHECK_SIGNAL(BOARD_CAM2_TX);
BOARD_CHECK_SIGNAL(BOARD_CAM2_RX);
BOARD_CHECK_SIGNAL(BOARD_CAM3_TX);
BOARD_CHECK_SIGNAL(BOARD_CAM3_RX);
BOARD_CHECK_SIGNAL(BOARD_CAM4_TX);
BOARD_CHECK_SIGNAL(BOARD_CAM4_RX);
BOARD_CHECK_SIGNAL(BOARD_SYNC_OUT);
BOARD_CHECK_SIGNAL(BOARD_FLASH_EN);
BOARD_CHECK_SIGNAL(BOARD_CAM_PWR_EN);

// Column check against the drawing: odd pins are the left column, even the
// right. The left column carries GPIO52/51/50/49/35/34/32/28; the right
// carries GPIO33/31/30/29. The JP1->GPIO table above already fixes each pair;
// this makes the column rule explicit so a transposed table is caught by name.
#define BOARD_JP1_IS_LEFT(pin) (((pin) & 1) == 1)
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM1_TX_JP1), "GPIO52 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM1_RX_JP1), "GPIO51 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM2_TX_JP1), "GPIO50 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM2_RX_JP1), "GPIO49 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM3_TX_JP1), "GPIO34 is a left-column pin");
_Static_assert(!BOARD_JP1_IS_LEFT(BOARD_CAM3_RX_JP1), "GPIO33 is a right-column pin");
_Static_assert(!BOARD_JP1_IS_LEFT(BOARD_CAM4_TX_JP1), "GPIO30 is a right-column pin");
_Static_assert(!BOARD_JP1_IS_LEFT(BOARD_CAM4_RX_JP1), "GPIO29 is a right-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_SYNC_OUT_JP1), "GPIO32 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_FLASH_EN_JP1), "GPIO28 is a left-column pin");
_Static_assert(!BOARD_JP1_IS_LEFT(BOARD_CAM_PWR_EN_JP1), "GPIO31 is a right-column pin");

// The spare is a real header GPIO that nothing claims.
_Static_assert(BOARD_JP1_GPIO_AT(BOARD_SPARE_JP1) == 35, "JP1 15 carries GPIO35");

// Uniqueness. Nine GPIOs, nine JP1 pins, no two the same. Written as a sum of
// pairwise collisions so the message names the whole set, not one pair.
#define BOARD_EQ(a, b) ((a) == (b) ? 1 : 0)
#define BOARD_COLLISIONS(a, b, c, d, e, f, g, h, i)                            \
  (BOARD_EQ(a, b) + BOARD_EQ(a, c) + BOARD_EQ(a, d) + BOARD_EQ(a, e) +         \
   BOARD_EQ(a, f) + BOARD_EQ(a, g) + BOARD_EQ(a, h) + BOARD_EQ(a, i) +         \
   BOARD_EQ(b, c) + BOARD_EQ(b, d) + BOARD_EQ(b, e) + BOARD_EQ(b, f) +         \
   BOARD_EQ(b, g) + BOARD_EQ(b, h) + BOARD_EQ(b, i) + BOARD_EQ(c, d) +         \
   BOARD_EQ(c, e) + BOARD_EQ(c, f) + BOARD_EQ(c, g) + BOARD_EQ(c, h) +         \
   BOARD_EQ(c, i) + BOARD_EQ(d, e) + BOARD_EQ(d, f) + BOARD_EQ(d, g) +         \
   BOARD_EQ(d, h) + BOARD_EQ(d, i) + BOARD_EQ(e, f) + BOARD_EQ(e, g) +         \
   BOARD_EQ(e, h) + BOARD_EQ(e, i) + BOARD_EQ(f, g) + BOARD_EQ(f, h) +         \
   BOARD_EQ(f, i) + BOARD_EQ(g, h) + BOARD_EQ(g, i) + BOARD_EQ(h, i))

_Static_assert(BOARD_COLLISIONS(BOARD_CAM1_TX, BOARD_CAM1_RX, BOARD_CAM2_TX, BOARD_CAM2_RX,
                                BOARD_CAM3_TX, BOARD_CAM3_RX, BOARD_CAM4_TX, BOARD_CAM4_RX,
                                BOARD_SYNC_OUT) == 0,
               "two camera/SYNC signals share a GPIO");
_Static_assert(BOARD_COLLISIONS(BOARD_CAM1_TX_JP1, BOARD_CAM1_RX_JP1, BOARD_CAM2_TX_JP1,
                                BOARD_CAM2_RX_JP1, BOARD_CAM3_TX_JP1, BOARD_CAM3_RX_JP1,
                                BOARD_CAM4_TX_JP1, BOARD_CAM4_RX_JP1, BOARD_SYNC_OUT_JP1) == 0,
               "two camera/SYNC signals share a JP1 pin");

// FLASH_EN and CAM_PWR_EN have real pins on this carrier, so they join the
// uniqueness rule. Counted against the nine above and each other rather than
// widening BOARD_COLLISIONS to eleven arguments and 55 pairs.
#define BOARD_VS_NINE(x, a, b, c, d, e, f, g, h, i)                            \
  (BOARD_EQ(x, a) + BOARD_EQ(x, b) + BOARD_EQ(x, c) + BOARD_EQ(x, d) +         \
   BOARD_EQ(x, e) + BOARD_EQ(x, f) + BOARD_EQ(x, g) + BOARD_EQ(x, h) +         \
   BOARD_EQ(x, i))

#define BOARD_VS_CAM_GPIOS(x)                                                  \
  BOARD_VS_NINE(x, BOARD_CAM1_TX, BOARD_CAM1_RX, BOARD_CAM2_TX, BOARD_CAM2_RX, \
                BOARD_CAM3_TX, BOARD_CAM3_RX, BOARD_CAM4_TX, BOARD_CAM4_RX,    \
                BOARD_SYNC_OUT)
#define BOARD_VS_CAM_JP1(x)                                                    \
  BOARD_VS_NINE(x, BOARD_CAM1_TX_JP1, BOARD_CAM1_RX_JP1, BOARD_CAM2_TX_JP1,    \
                BOARD_CAM2_RX_JP1, BOARD_CAM3_TX_JP1, BOARD_CAM3_RX_JP1,       \
                BOARD_CAM4_TX_JP1, BOARD_CAM4_RX_JP1, BOARD_SYNC_OUT_JP1)

_Static_assert(BOARD_VS_CAM_GPIOS(BOARD_FLASH_EN) == 0, "FLASH_EN shares a GPIO");
_Static_assert(BOARD_VS_CAM_GPIOS(BOARD_CAM_PWR_EN) == 0, "CAM_PWR_EN shares a GPIO");
_Static_assert(BOARD_FLASH_EN != BOARD_CAM_PWR_EN, "FLASH_EN and CAM_PWR_EN share a GPIO");
_Static_assert(BOARD_VS_CAM_JP1(BOARD_FLASH_EN_JP1) == 0, "FLASH_EN shares a JP1 pin");
_Static_assert(BOARD_VS_CAM_JP1(BOARD_CAM_PWR_EN_JP1) == 0, "CAM_PWR_EN shares a JP1 pin");
_Static_assert(BOARD_FLASH_EN_JP1 != BOARD_CAM_PWR_EN_JP1,
               "FLASH_EN and CAM_PWR_EN share a JP1 pin");
_Static_assert(BOARD_VS_CAM_JP1(BOARD_SPARE_JP1) == 0, "the spare pin is claimed");

// Four ports, UART1..UART4, each once. UART0 is the console.
_Static_assert(BOARD_CAM1_UART_NUM == 1 && BOARD_CAM2_UART_NUM == 2 &&
                   BOARD_CAM3_UART_NUM == 3 && BOARD_CAM4_UART_NUM == 4,
               "camera UART numbers must be 1..4 in camera order");

// Every signal is routed on this carrier, so neither of these may quietly
// revert to BOARD_GPIO_NONE: that is what the previous map forced, and code
// in capture.c and power.c still carries the skip-if-unassigned branches it
// grew for it. Those branches stay -- they are correct for a board without
// the pin -- but this board has both.
_Static_assert(BOARD_FLASH_EN != BOARD_GPIO_NONE, "FLASH_EN is routed on JP1 21");
_Static_assert(BOARD_CAM_PWR_EN != BOARD_GPIO_NONE, "CAM_PWR_EN is routed on JP1 10");

#endif
