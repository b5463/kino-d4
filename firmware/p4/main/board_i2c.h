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
 * needs it, and from two tasks at once: creation is serialised, so the second
 * caller waits for the first rather than trying to install I2C_NUM_0 twice.
 * Subsequent calls return the same handle without taking a lock.
 */
esp_err_t board_i2c_bus(i2c_master_bus_handle_t *out);

/**
 * The bring-up scan, run at most once for the life of the boot.
 *
 * board_i2c_bus() calls this itself after the handle is published, which is
 * where it has always happened, so the boot log is the same. It is separate
 * and idempotent so the cost - 112 probes at a 50 ms timeout, up to 5.6 s on
 * a quiet bus - is not paid inside the bus lock, and so a caller that wants
 * the scan can ask for it without depending on being the first one up.
 */
void board_i2c_scan_once(void);

/** Log every address that answers. Probes the whole 7-bit range; blocks for
 * seconds when the bus is quiet. Call it directly only to re-scan. */
void board_i2c_scan(void);

#endif
