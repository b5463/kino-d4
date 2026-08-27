idf_component_register(
  SRCS "main.c" "usb_link.c" "storage.c" "cam_link.c" "kdp_server.c" "hardware_validation.c" "klog.c" "display.c" "touch.c" "ui.c" "gfx.c" "mesh3d.c" "icons.c" "board_i2c.c" "audio.c" "config_store.c" "power.c" "viewfinder.c" "buttons.c" "clock.c" "capture.c" "pure.c" "taskmon.c" "meta.c" "thumb.c" "gallery.c" "net_link.c" "wifi_creds.c" "roll_queue.c" "upload_queue.c" "upload_store.c" "roll_state.c" "kdp_net.c" "qr.c"
  INCLUDE_DIRS "."
  REQUIRES kdp_core node_link json nvs_flash fatfs sdmmc esp_driver_sdmmc
           esp_driver_uart esp_driver_usb_serial_jtag esp_driver_tsens esp_timer
           esp_lcd esp_driver_gpio esp_lcd_st7701 esp_lcd_touch_gt911 esp_driver_i2c
           esp_driver_i2s esp_codec_dev esp_driver_ppa esp_driver_jpeg
)

# Bench switch: `idf.py -DKINO_UI_FRAME_DUMP=1 build` makes the UI print its
# composed screens over the console so they can be decoded into pictures.
# Off by default - it costs several seconds of boot and floods the log.
if(KINO_UI_FRAME_DUMP)
  target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_UI_FRAME_DUMP=1)
endif()

file(READ "${CMAKE_CURRENT_LIST_DIR}/../../VERSION" KINO_FW_VERSION)
string(STRIP "${KINO_FW_VERSION}" KINO_FW_VERSION)
target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_FW_VERSION="${KINO_FW_VERSION}")
