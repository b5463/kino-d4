/*
 * Host test for firmware/p4/main/board_d4v1.h: the camera UART, SYNC, FLASH
 * and CAM_PWR pin map against the JP1 header of the Guition
 * JC4880P443C-I-W carrier.
 *
 * board_d4v1_checks.h proves the same invariants with _Static_assert, so a
 * bad map cannot compile. This file repeats them at runtime for two reasons:
 * a FAIL line names the offending signal and value where a static assert
 * names a line, and `--dump` prints the map as JSON lines for
 * packages/hardware-profiles to cross-check its copy of the table against.
 *
 *   make -C firmware/p4/host_tests test-pins
 *   ./test_board_pins --dump
 *
 * Dump format, one object per line, in this order:
 *   {"signal":"CAM1_TX","gpio":1,"jp1":7}
 *   ...
 *   {"signal":"FLASH_EN","gpio":null,"jp1":null}
 */
#include <stdio.h>
#include <string.h>

#include "board_d4v1_checks.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...) \
  do { \
    checks++; \
    if (!(cond)) { \
      failures++; \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__); \
      printf("\n"); \
    } \
  } while (0)

typedef struct {
  const char *signal;
  int gpio; /* BOARD_GPIO_NONE when unassigned */
  int jp1;  /* 0 when unassigned */
} signal_t;

/* The nine routed signals, then the two without a pin. */
static const signal_t SIGNALS[] = {
    {"CAM1_TX", BOARD_CAM1_TX, BOARD_CAM1_TX_JP1},
    {"CAM1_RX", BOARD_CAM1_RX, BOARD_CAM1_RX_JP1},
    {"CAM2_TX", BOARD_CAM2_TX, BOARD_CAM2_TX_JP1},
    {"CAM2_RX", BOARD_CAM2_RX, BOARD_CAM2_RX_JP1},
    {"CAM3_TX", BOARD_CAM3_TX, BOARD_CAM3_TX_JP1},
    {"CAM3_RX", BOARD_CAM3_RX, BOARD_CAM3_RX_JP1},
    {"CAM4_TX", BOARD_CAM4_TX, BOARD_CAM4_TX_JP1},
    {"CAM4_RX", BOARD_CAM4_RX, BOARD_CAM4_RX_JP1},
    {"SYNC_OUT", BOARD_SYNC_OUT, BOARD_SYNC_OUT_JP1},
    {"FLASH_EN", BOARD_FLASH_EN, 0},
    {"CAM_PWR_EN", BOARD_CAM_PWR_EN, 0},
};
enum { N_SIGNALS = sizeof SIGNALS / sizeof SIGNALS[0], N_ROUTED = 9 };

/* Manufacturer JP1 table, left (odd) and right (even) columns, row 1 at the
 * top. A GPIO is written as its number; everything else as -1. Kept as data
 * here, separately from the macro in board_d4v1_checks.h, so the two
 * transcriptions of the drawing check each other. */
static const int JP1_LEFT[13] = {-1, -1, -1, 1, 2, 3, 4, 5, 20, 32, 33, -1, -1};
static const int JP1_RIGHT[13] = {-1, -1, -1, -1, 47, 46, 45, -1, -1, -1, -1, -1, -1};

static int jp1_gpio_at(int pin) {
  if (pin < 1 || pin > 26) return -1;
  const int row = (pin - 1) / 2;
  return (pin & 1) ? JP1_LEFT[row] : JP1_RIGHT[row];
}

static int is_free_header_gpio(int g) {
  static const int FREE[9] = {1, 2, 4, 20, 32, 33, 45, 46, 47};
  for (int i = 0; i < 9; i++)
    if (FREE[i] == g) return 1;
  return 0;
}

static int is_reserved_gpio(int g) {
  static const int RESERVED[] = {
      BOARD_SD_CLK,    BOARD_SD_CMD,    BOARD_SD_D0,     BOARD_SD_D1,       BOARD_SD_D2,
      BOARD_SD_D3,     BOARD_C6_D0,     BOARD_C6_D1,     BOARD_C6_D2,       BOARD_C6_D3,
      BOARD_C6_CLK,    BOARD_C6_CMD,    BOARD_C6_EN,     BOARD_I2C_SDA,     BOARD_I2C_SCL,
      BOARD_I2S_MCLK,  BOARD_I2S_BCLK,  BOARD_I2S_LRCK,  BOARD_I2S_DOUT,    BOARD_I2S_DIN,
      BOARD_AUDIO_PA_EN, BOARD_LCD_RESET, BOARD_LCD_BACKLIGHT, BOARD_TOUCH_RESET,
  };
  for (unsigned i = 0; i < sizeof RESERVED / sizeof RESERVED[0]; i++)
    if (RESERVED[i] == g) return 1;
  return 0;
}

static void test_routed_signals(void) {
  for (int i = 0; i < N_ROUTED; i++) {
    const signal_t *s = &SIGNALS[i];
    CHECK(s->gpio >= 0 && s->gpio <= 54, "%s GPIO%d outside 0..54", s->signal, s->gpio);
    CHECK(is_free_header_gpio(s->gpio), "%s GPIO%d is not one of the nine free JP1 GPIOs",
          s->signal, s->gpio);
    CHECK(!is_reserved_gpio(s->gpio), "%s GPIO%d collides with SD/C6/I2C/I2S/LCD/touch",
          s->signal, s->gpio);
    CHECK(s->jp1 >= 1 && s->jp1 <= 26, "%s JP1 pin %d outside 1..26", s->signal, s->jp1);
    CHECK(jp1_gpio_at(s->jp1) == s->gpio, "%s: JP1 pin %d carries GPIO%d, macro says GPIO%d",
          s->signal, s->jp1, jp1_gpio_at(s->jp1), s->gpio);
    /* Column rule from the drawing: odd = left, even = right. */
    const int left = (s->jp1 & 1) == 1;
    const int in_left = 0 <= (s->jp1 - 1) / 2 && JP1_LEFT[(s->jp1 - 1) / 2] == s->gpio;
    CHECK(left == in_left, "%s: GPIO%d on pin %d is in the %s column of the drawing", s->signal,
          s->gpio, s->jp1, in_left ? "left" : "right");
  }

  /* Uniqueness across GPIOs and across JP1 pins. */
  for (int i = 0; i < N_ROUTED; i++) {
    for (int j = i + 1; j < N_ROUTED; j++) {
      CHECK(SIGNALS[i].gpio != SIGNALS[j].gpio, "%s and %s share GPIO%d", SIGNALS[i].signal,
            SIGNALS[j].signal, SIGNALS[i].gpio);
      CHECK(SIGNALS[i].jp1 != SIGNALS[j].jp1, "%s and %s share JP1 pin %d", SIGNALS[i].signal,
            SIGNALS[j].signal, SIGNALS[i].jp1);
    }
  }
  /* SYNC_OUT distinct from the eight UART lines - covered by the loop above,
   * stated once more by name because it is the constraint the spec calls out. */
  for (int i = 0; i < 8; i++)
    CHECK(SIGNALS[i].gpio != BOARD_SYNC_OUT, "SYNC_OUT shares GPIO%d with %s", BOARD_SYNC_OUT,
          SIGNALS[i].signal);
}

static void test_unassigned_signals(void) {
  CHECK(BOARD_GPIO_NONE == -1, "BOARD_GPIO_NONE must equal GPIO_NUM_NC (-1), is %d",
        BOARD_GPIO_NONE);
  CHECK(BOARD_FLASH_EN == BOARD_GPIO_NONE, "FLASH_EN has no JP1 pin, macro says %d",
        BOARD_FLASH_EN);
  CHECK(BOARD_CAM_PWR_EN == BOARD_GPIO_NONE, "CAM_PWR_EN has no JP1 pin, macro says %d",
        BOARD_CAM_PWR_EN);
}

static void test_locked_values(void) {
  /* The decision itself, so a well-formed but different map is still a
   * failure here rather than a silent divergence from the bench notes. */
  CHECK(BOARD_CAM1_UART_NUM == 1 && BOARD_CAM1_TX == 1 && BOARD_CAM1_RX == 2, "CAM1 map");
  CHECK(BOARD_CAM2_UART_NUM == 2 && BOARD_CAM2_TX == 47 && BOARD_CAM2_RX == 46, "CAM2 map");
  CHECK(BOARD_CAM3_UART_NUM == 3 && BOARD_CAM3_TX == 32 && BOARD_CAM3_RX == 33, "CAM3 map");
  CHECK(BOARD_CAM4_UART_NUM == 4 && BOARD_CAM4_TX == 45 && BOARD_CAM4_RX == 4, "CAM4 map");
  CHECK(BOARD_SYNC_OUT == 20, "SYNC_OUT is GPIO20, macro says %d", BOARD_SYNC_OUT);
  CHECK(BOARD_CAM1_TX_JP1 == 7 && BOARD_CAM1_RX_JP1 == 9, "CAM1 JP1 pins");
  CHECK(BOARD_CAM2_TX_JP1 == 10 && BOARD_CAM2_RX_JP1 == 12, "CAM2 JP1 pins");
  CHECK(BOARD_CAM3_TX_JP1 == 19 && BOARD_CAM3_RX_JP1 == 21, "CAM3 JP1 pins");
  CHECK(BOARD_CAM4_TX_JP1 == 14 && BOARD_CAM4_RX_JP1 == 13, "CAM4 JP1 pins");
  CHECK(BOARD_SYNC_OUT_JP1 == 17, "SYNC_OUT JP1 pin");

  /* The two transcriptions of the manufacturer table agree. */
  for (int pin = 1; pin <= 26; pin++)
    CHECK(jp1_gpio_at(pin) == BOARD_JP1_GPIO_AT(pin), "JP1 pin %d: table says %d, macro says %d",
          pin, jp1_gpio_at(pin), BOARD_JP1_GPIO_AT(pin));

  /* Nothing the old map used is on the header. */
  static const int GONE[] = {52, 51, 50, 49, 35, 34, 31, 30, 29, 28};
  for (unsigned i = 0; i < sizeof GONE / sizeof GONE[0]; i++) {
    int on_header = 0;
    for (int pin = 1; pin <= 26; pin++)
      if (jp1_gpio_at(pin) == GONE[i]) on_header = 1;
    CHECK(!on_header, "GPIO%d is not a JP1 pin", GONE[i]);
    for (int s = 0; s < N_SIGNALS; s++)
      CHECK(SIGNALS[s].gpio != GONE[i], "%s still uses GPIO%d, which routes nowhere",
            SIGNALS[s].signal, GONE[i]);
  }
}

static void dump(void) {
  for (int i = 0; i < N_SIGNALS; i++) {
    const signal_t *s = &SIGNALS[i];
    if (s->gpio == BOARD_GPIO_NONE) {
      printf("{\"signal\":\"%s\",\"gpio\":null,\"jp1\":null}\n", s->signal);
    } else {
      printf("{\"signal\":\"%s\",\"gpio\":%d,\"jp1\":%d}\n", s->signal, s->gpio, s->jp1);
    }
  }
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--dump") == 0) {
    dump();
    return 0;
  }
  test_routed_signals();
  test_unassigned_signals();
  test_locked_values();
  printf("%d checks, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
