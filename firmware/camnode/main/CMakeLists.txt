idf_component_register(
  SRCS "main.c" "camera.c" "node_server.c"
  INCLUDE_DIRS "."
  REQUIRES kdp_core node_link esp32-camera json nvs_flash esp_driver_uart esp_driver_tsens esp_timer
)

file(READ "${CMAKE_CURRENT_LIST_DIR}/../../VERSION" KINO_FW_VERSION)
string(STRIP "${KINO_FW_VERSION}" KINO_FW_VERSION)
# Same rule as p4/main/CMakeLists.txt, for the same reason: file(READ) is
# configure-time, and a VERSION edit in an existing build dir shipped a node
# reporting the previous version with the new code inside.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
             "${CMAKE_CURRENT_LIST_DIR}/../../VERSION")
target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_FW_VERSION="${KINO_FW_VERSION}")
