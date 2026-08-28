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
  ((pin) == 7    ? 1                                                          \
   : (pin) == 9  ? 2                                                          \
   : (pin) == 10 ? 47                                                         \
   : (pin) == 11 ? 3                                                          \
   : (pin) == 12 ? 46                                                         \
   : (pin) == 13 ? 4                                                          \
   : (pin) == 14 ? 45                                                         \
   : (pin) == 15 ? 5                                                          \
   : (pin) == 17 ? 20                                                         \
   : (pin) == 19 ? 32                                                         \
   : (pin) == 21 ? 33                                                         \
                 : -1)

// The nine header GPIOs a camera signal may use. GPIO3 and GPIO5 are on the
// header but taken by touch and LCD reset.
#define BOARD_IS_FREE_JP1_GPIO(g)                                             \
  ((g) == 1 || (g) == 2 || (g) == 4 || (g) == 20 || (g) == 32 || (g) == 33 || \
   (g) == 45 || (g) == 46 || (g) == 47)

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

// Column check against the drawing: odd pins are the left column, even the
// right. The left column carries GPIO1/2/3/4/5/20/32/33; the right carries
// GPIO47/46/45. The JP1->GPIO table above already fixes each pair; this makes
// the column rule explicit so a transposed table is caught by name.
#define BOARD_JP1_IS_LEFT(pin) (((pin) & 1) == 1)
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM1_TX_JP1), "GPIO1 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM1_RX_JP1), "GPIO2 is a left-column pin");
_Static_assert(!BOARD_JP1_IS_LEFT(BOARD_CAM2_TX_JP1), "GPIO47 is a right-column pin");
_Static_assert(!BOARD_JP1_IS_LEFT(BOARD_CAM2_RX_JP1), "GPIO46 is a right-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM3_TX_JP1), "GPIO32 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM3_RX_JP1), "GPIO33 is a left-column pin");
_Static_assert(!BOARD_JP1_IS_LEFT(BOARD_CAM4_TX_JP1), "GPIO45 is a right-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_CAM4_RX_JP1), "GPIO4 is a left-column pin");
_Static_assert(BOARD_JP1_IS_LEFT(BOARD_SYNC_OUT_JP1), "GPIO20 is a left-column pin");

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

// Four ports, UART1..UART4, each once. UART0 is the console.
_Static_assert(BOARD_CAM1_UART_NUM == 1 && BOARD_CAM2_UART_NUM == 2 &&
                   BOARD_CAM3_UART_NUM == 3 && BOARD_CAM4_UART_NUM == 4,
               "camera UART numbers must be 1..4 in camera order");

// The two lines with no header pin. A number here means someone assigned a
// pin without a route for it; the accounting in board_d4v1.h says why.
_Static_assert(BOARD_FLASH_EN == BOARD_GPIO_NONE, "FLASH_EN has no JP1 pin");
_Static_assert(BOARD_CAM_PWR_EN == BOARD_GPIO_NONE, "CAM_PWR_EN has no JP1 pin");

#endif
