idf_component_register(
  SRCS "main.c" "usb_link.c" "storage.c" "cam_link.c" "kdp_server.c" "hardware_validation.c" "klog.c" "display.c" "touch.c" "ui.c"
  INCLUDE_DIRS "."
  REQUIRES kdp_core node_link json nvs_flash fatfs sdmmc esp_driver_sdmmc
           esp_driver_uart esp_driver_usb_serial_jtag esp_driver_tsens esp_timer
           esp_lcd esp_driver_gpio esp_lcd_st7701 esp_lcd_touch_gt911 esp_driver_i2c
)

file(READ "${CMAKE_CURRENT_LIST_DIR}/../../VERSION" KINO_FW_VERSION)
string(STRIP "${KINO_FW_VERSION}" KINO_FW_VERSION)
target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_FW_VERSION="${KINO_FW_VERSION}")
