#include "usb_link.h"

#include "esp_timer.h"

#include "driver/usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"

esp_err_t usb_link_init(void) {
  usb_serial_jtag_driver_config_t config = {
      .rx_buffer_size = 4096,
      .tx_buffer_size = 4096,
  };
  return usb_serial_jtag_driver_install(&config);
}

/* When a host last sent us anything. USB-Serial-JTAG has no link-state line
 * to read on this part, so "connected" is inferred from traffic. */
static volatile int64_t s_last_rx;

int usb_link_read(uint8_t *buf, size_t cap, uint32_t timeout_ms) {
  const int got = usb_serial_jtag_read_bytes(buf, cap, pdMS_TO_TICKS(timeout_ms));
  if (got > 0) s_last_rx = esp_timer_get_time();
  return got;
}

bool usb_link_connected(void) {
  if (s_last_rx == 0) return false;
  /* Five seconds: Studio polls status far faster than that, so a live session
   * never flickers, and a cable pulled mid-session clears within one screen
   * refresh of the status panel. */
  return (esp_timer_get_time() - s_last_rx) < 5000000;
}

void usb_link_write(const uint8_t *data, size_t len) {
  size_t written = 0;
  while (written < len) {
    int n = usb_serial_jtag_write_bytes(data + written, len - written, portMAX_DELAY);
    if (n <= 0) return; /* host gone; the frame is lost, the link recovers */
    written += (size_t)n;
  }
}

int usb_link_write_timeout(const uint8_t *data, size_t len, uint32_t timeout_ms) {
  const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
  size_t written = 0;
  while (written < len) {
    const int64_t left_us = deadline - esp_timer_get_time();
    if (left_us <= 0) break;
    /* The deadline is for the whole call, so each driver wait gets what is
     * left of it. Below one tick, wait one tick rather than zero: a zero
     * timeout returns immediately and would turn the last few hundred
     * microseconds of budget into a spin. */
    TickType_t ticks = pdMS_TO_TICKS((uint32_t)(left_us / 1000));
    if (ticks == 0) ticks = 1;
    const int n = usb_serial_jtag_write_bytes(data + written, len - written, ticks);
    if (n <= 0) break; /* host gone or the FIFO stayed full for the whole wait */
    written += (size_t)n;
  }
  return (int)written;
}
