idf_component_register(
  SRCS "main.c"
  INCLUDE_DIRS "."
  # The pin map is camnode's, not a copy of it: one file owns every XIAO GPIO.
  PRIV_INCLUDE_DIRS "../../camnode/main"
  REQUIRES esp32-camera usb_device_uvc esp_driver_gpio
)

file(READ "${CMAKE_CURRENT_LIST_DIR}/../../VERSION" KINO_FW_VERSION)
string(STRIP "${KINO_FW_VERSION}" KINO_FW_VERSION)
target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_FW_VERSION="${KINO_FW_VERSION}")
