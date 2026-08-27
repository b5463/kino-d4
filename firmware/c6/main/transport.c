#include "transport.h"

#include "board_c6.h"
#include "esp_log.h"

static const char *TAG = "transport";

static transport_state_t s_state = TRANSPORT_NOT_ROUTED;

esp_err_t transport_start(void) {
  // Deliberately no GPIO configuration. The six SDIO slave pads in board_c6.h
  // are fixed in silicon and correct, but driving them before the P4 side is
  // known is the failure this repo's hardware gate exists to prevent: the C6's
  // GPIO19-23 are also its boot-strap neighbourhood, and a slave clocking an
  // unrouted bus can hold a line that the carrier uses for something else.
  // Configuring nothing is the only state that cannot damage bring-up.
  ESP_LOGW(TAG,
           "host link NOT ROUTED: C6 slave pads are CLK=%d CMD=%d DAT0..3=%d,%d,%d,%d, "
           "no P4-side GPIO known (firmware/C6_HARDWARE_MAP.md)",
           BOARD_C6_SDIO_CLK, BOARD_C6_SDIO_CMD, BOARD_C6_SDIO_DAT0, BOARD_C6_SDIO_DAT1,
           BOARD_C6_SDIO_DAT2, BOARD_C6_SDIO_DAT3);

  s_state = TRANSPORT_NOT_ROUTED;
  return ESP_ERR_NOT_SUPPORTED;
}

transport_state_t transport_state(void) { return s_state; }

const char *transport_state_str(void) {
  switch (s_state) {
    case TRANSPORT_UP:
      return "up";
    case TRANSPORT_NOT_ROUTED:
    default:
      return "not-routed";
  }
}
