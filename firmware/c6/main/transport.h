// ===========================================================================
// THE SEAM
// ===========================================================================
// The host link. This is the one place the esp_hosted SDIO slave replaces, and
// nothing else in this image needs to change when it does.
//
// Today transport_start() reports ESP_ERR_NOT_SUPPORTED, because the P4 side
// of the link is not routed: firmware/C6_HARDWARE_MAP.md records that no P4
// GPIO for CLK, CMD or DAT0-DAT3 is known, and that the carrier is not even
// established to route SDIO rather than SPI. A slave that answers on a bus no
// host drives is indistinguishable from one that is broken, so this image says
// so instead of pretending.
//
// To close the seam, in this order:
//   1. Resolve the P4 routing (steps 1-3 of "How to close this gate" in
//      firmware/C6_HARDWARE_MAP.md). This decides SDIO vs SPI, which decides
//      which slave transport is built.
//   2. Build Espressif's hosted slave. `espressif/esp_hosted` on the component
//      registry ships it under `slave/` as a standalone IDF project, not as a
//      composable component — see "Why no esp_hosted yet" in README.md for the
//      measured failure when it is added to this project as a dependency.
//   3. Replace the body of transport_start() with the slave's interface
//      bring-up and return its result. The C6-side pads are already fixed:
//      board_c6.h.
// ===========================================================================
#ifndef TRANSPORT_H
#define TRANSPORT_H

#include "esp_err.h"

// What this image can say about the host link, in one word, over UART0.
typedef enum {
  TRANSPORT_NOT_ROUTED,  // No P4-side pins known. The only state reachable today.
  TRANSPORT_UP,
} transport_state_t;

// Brings up the host link. Returns ESP_ERR_NOT_SUPPORTED while the routing is
// unresolved; the caller must keep running, because the console banner is the
// only thing this image can currently deliver.
esp_err_t transport_start(void);

transport_state_t transport_state(void);

// Fixed string for the console and, later, for the P4's FW_QUERY reply.
const char *transport_state_str(void);

#endif  // TRANSPORT_H
