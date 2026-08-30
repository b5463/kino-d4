// Studio-facing KDP byte stream over the P4's USB-Serial-JTAG port. The IDF
// console stays on UART0 (GPIO37/38 on this board) so log output can never
// interleave into a KDP frame.
#ifndef P4_USB_LINK_H
#define P4_USB_LINK_H

#include <stddef.h>
#include <stdint.h>

#include <stdbool.h>

#include "esp_err.h"

esp_err_t usb_link_init(void);
/** Blocking read with timeout; returns bytes read (0 on timeout). */
int usb_link_read(uint8_t *buf, size_t cap, uint32_t timeout_ms);

/**
 * True when a host has sent us something recently.
 *
 * Deliberately "a host is talking to us" rather than "we are on USB power":
 * the SW6106 feeds the same 5 V rail from the battery or from the socket, and
 * the P4 cannot tell those apart. Claiming to know would be inventing a fact
 * about the power path.
 */
bool usb_link_connected(void);

/**
 * Write the whole buffer, waiting as long as it takes.
 *
 * For request/response traffic only. USB-Serial-JTAG has a 4 KB TX FIFO and
 * no flow control the device can see: when nothing on the host is draining
 * the port the FIFO fills and this call parks the caller until something
 * does. A reply the host asked for is worth that wait; an event is not.
 */
void usb_link_write(const uint8_t *data, size_t len);

/**
 * Write with a deadline for the whole call. Returns bytes actually written,
 * which is less than `len` when the host stopped draining the port.
 *
 * A short return means a partial frame is already on the wire. That is safe
 * for the decoder on either end - it resyncs on the next KI magic and counts
 * the remainder as discarded - but it means the caller must treat the frame
 * as lost rather than retry the tail.
 */
int usb_link_write_timeout(const uint8_t *data, size_t len, uint32_t timeout_ms);

#endif
