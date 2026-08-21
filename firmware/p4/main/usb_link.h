// Studio-facing KDP byte stream over the P4's USB-Serial-JTAG port. The IDF
// console stays on UART0 (GPIO37/38 on this board) so log output can never
// interleave into a KDP frame.
#ifndef P4_USB_LINK_H
#define P4_USB_LINK_H

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

esp_err_t usb_link_init(void);
/** Blocking read with timeout; returns bytes read (0 on timeout). */
int usb_link_read(uint8_t *buf, size_t cap, uint32_t timeout_ms);
void usb_link_write(const uint8_t *data, size_t len);

#endif
