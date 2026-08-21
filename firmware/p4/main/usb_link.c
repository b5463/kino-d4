#include "usb_link.h"

#include "driver/usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"

esp_err_t usb_link_init(void) {
  usb_serial_jtag_driver_config_t config = {
      .rx_buffer_size = 4096,
      .tx_buffer_size = 4096,
  };
  return usb_serial_jtag_driver_install(&config);
}

int usb_link_read(uint8_t *buf, size_t cap, uint32_t timeout_ms) {
  return usb_serial_jtag_read_bytes(buf, cap, pdMS_TO_TICKS(timeout_ms));
}

void usb_link_write(const uint8_t *data, size_t len) {
  size_t written = 0;
  while (written < len) {
    int n = usb_serial_jtag_write_bytes(data + written, len - written, portMAX_DELAY);
    if (n <= 0) return; /* host gone; the frame is lost, the link recovers */
    written += (size_t)n;
  }
}
