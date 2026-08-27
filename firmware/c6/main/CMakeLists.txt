idf_component_register(
  SRCS "main.c" "radio.c" "transport.c"
  INCLUDE_DIRS "."
  REQUIRES esp_wifi nvs_flash esp_event esp_timer
)

file(READ "${CMAKE_CURRENT_LIST_DIR}/../../VERSION" KINO_FW_VERSION)
string(STRIP "${KINO_FW_VERSION}" KINO_FW_VERSION)
target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_FW_VERSION="${KINO_FW_VERSION}")
