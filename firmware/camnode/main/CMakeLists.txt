idf_component_register(
  SRCS "main.c" "camera.c" "node_server.c"
  INCLUDE_DIRS "."
  REQUIRES kdp_core node_link esp32-camera json nvs_flash esp_driver_uart esp_driver_tsens esp_timer
           app_update esp_partition mbedtls # firmware update over the link (node_server.c)
)

# App rollback (#242). sdkconfig.defaults sets it, a stale sdkconfig can still
# have it off, and a node built that way boots an update straight to VALID: a
# bad image written over the link could no longer be rolled back. CONFIG_* is
# only populated in the build pass, which is why this sits after
# idf_component_register.
if(NOT CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE)
  message(FATAL_ERROR
          "CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE is not set, so an update "
          "written over the link could not be rolled back. Delete the build's "
          "sdkconfig and build again so sdkconfig.defaults is read.")
endif()

file(READ "${CMAKE_CURRENT_LIST_DIR}/../../VERSION" KINO_FW_VERSION)
string(STRIP "${KINO_FW_VERSION}" KINO_FW_VERSION)
# Same rule as p4/main/CMakeLists.txt, for the same reason: file(READ) is
# configure-time, and a VERSION edit in an existing build dir shipped a node
# reporting the previous version with the new code inside.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
             "${CMAKE_CURRENT_LIST_DIR}/../../VERSION")
target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_FW_VERSION="${KINO_FW_VERSION}")

# Our own code compiles clean, and stays that way: a warning here is a build
# failure rather than a line in a log nobody reads. Three of the defects the
# September hygiene pass removed had been in every build log for days - two
# dead functions and a NUL byte in a literal - because nothing failed on them.
# Scoped to this component on purpose: managed_components is not ours to fix.
target_compile_options(${COMPONENT_LIB} PRIVATE -Werror)

