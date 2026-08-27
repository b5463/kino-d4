// The board's shared I2C bus.
//
// The GT911 touch controller and the ES8311 codec sit on the same two pins.
// Each driver creating its own master bus would fail the second time and, on
// a board where touch comes up before audio, would look like "audio is
// broken" rather than "the bus was already taken". One owner, handed out.
#ifndef P4_BOARD_I2C_H
#define P4_BOARD_I2C_H

#include "driver/i2c_master.h"
#include "esp_err.h"

/**
 * The bus handle, created on first call. Safe to call from any driver that
 * needs it; subsequent calls return the same handle.
 */
esp_err_t board_i2c_bus(i2c_master_bus_handle_t *out);

/** Log every address that answers. Called once when the bus comes up. */
void board_i2c_scan(void);

#endif
