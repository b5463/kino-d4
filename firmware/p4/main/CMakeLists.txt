# The default build. No radio source, no esp_hosted, no esp_wifi_remote, and no
# pin driven toward the C6 — see firmware/p4/main/net_hosted.h for why that is a
# safety property and not an omission.
set(kino_srcs
  "main.c" "usb_link.c" "storage.c" "cam_link.c" "kdp_server.c" "hardware_validation.c"
    "hwv_rules.c"
  "klog.c" "display.c" "touch.c" "ui.c" "gfx.c" "mesh3d.c" "icons.c" "board_i2c.c"
  "audio.c" "config_store.c" "power.c" "viewfinder.c" "buttons.c" "clock.c" "capture.c"
  "pure.c" "taskmon.c" "meta.c" "thumb.c" "gallery.c" "net_link.c" "wifi_creds.c"
  "roll_queue.c" "upload_queue.c" "upload_store.c" "roll_state.c" "kdp_net.c" "qr.c"
  "roll_api.c" "roll_client.c" "bench_c6.c" "radio_recovery.c" "cam_sched.c"
  "kdp_recipes.c" "kdp_sounds.c" "recipe_rules.c" "wav_probe.c")

set(kino_reqs kdp_core node_link json nvs_flash fatfs sdmmc esp_driver_sdmmc
              esp_driver_uart esp_driver_usb_serial_jtag esp_driver_tsens esp_timer
              esp_lcd esp_driver_gpio esp_lcd_st7701 esp_lcd_touch_gt911 esp_driver_i2c
              esp_driver_i2s esp_codec_dev esp_driver_ppa esp_driver_jpeg esp_mm)

# The radio variant:
#
#   idf.py -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.radio" build
#
# The switch is read from SDKCONFIG_DEFAULTS rather than from CONFIG_ESP_HOSTED,
# and that is not a shortcut. ESP-IDF processes a component's CMakeLists twice —
# once to expand REQUIRES, once to build — and CONFIG_* is not populated in the
# first pass. A `if(CONFIG_ESP_HOSTED)` around `list(APPEND kino_reqs ...)`
# therefore compiles the radio sources with NONE of their include directories:
# measured, and it presents as `esp_crt_bundle.h: No such file or directory`
# with every other component resolving fine. SDKCONFIG_DEFAULTS is a cache
# variable and is visible in both passes.
#
# The two are cross-checked after registration, so a build that sets one and not
# the other fails loudly instead of half-linking.
set(KINO_RADIO_BUILD 0)
if(SDKCONFIG_DEFAULTS MATCHES "sdkconfig\.radio")
  set(KINO_RADIO_BUILD 1)
endif()

# `esp_wifi_remote` is NOT a REQUIRES name — requiring it fails with "Failed to
# resolve component". It is a managed dependency in idf_component.yml and it
# provides `esp_wifi` for targets with no radio of their own, which is why
# esp_wifi is what appears below. Espressif's own combined example does the same
# thing (REQUIRES fatfs esp_wifi, deps in idf_component.yml).
if(KINO_RADIO_BUILD)
  list(APPEND kino_srcs "net_hosted.c" "net_wifi.c" "net_time.c" "roll_http.c")
  list(APPEND kino_reqs esp_hosted esp_wifi esp_netif esp_event lwip
                        esp_http_client esp-tls mbedtls)
endif()

# The eleven factory looks, compiled into the image as a NUL-terminated blob
# (EMBED_TXTFILES, not EMBED_FILES) so kdp_recipes.c hands the symbol straight
# to cJSON_Parse. It is a data file rather than a C table because
# packages/test-fixtures/src/factoryRecipes.ts is the other copy and a vitest
# deep-compares the two: a JSON document can be compared, a C initialiser
# cannot.
idf_component_register(SRCS ${kino_srcs} INCLUDE_DIRS "." REQUIRES ${kino_reqs}
                       EMBED_TXTFILES "factory_recipes.json")

if(KINO_RADIO_BUILD)
  # The two halves of the opt-in must agree. Failing here beats discovering it
  # as a link error, or worse as a radio build with no radio in it.
  if(NOT CONFIG_ESP_HOSTED)
    message(FATAL_ERROR
            "sdkconfig.radio was named but CONFIG_ESP_HOSTED is not y. "
            "Check SDKCONFIG_DEFAULTS and delete build/ before retrying.")
  endif()

  # One derived symbol, so no source file has to know the component's name and
  # net_link.c stays free of sdkconfig.h — it is host-tested and must build
  # against nothing but shim/esp_err.h.
  target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_RADIO=1)

  # Where the Roll API is. No default: this repository records no public KINO
  # API hostname, and a plausible wrong one compiled into a binary is worse than
  # a refusal that says the address is missing.
  #
  #   idf.py -DKINO_ROLL_API_BASE=https://... -DSDKCONFIG_DEFAULTS=... build
  if(KINO_ROLL_API_BASE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE
                               KINO_ROLL_API_BASE="${KINO_ROLL_API_BASE}")
  endif()
  if(KINO_SNTP_SERVER)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE
                               KINO_SNTP_SERVER="${KINO_SNTP_SERVER}")
  endif()

  # Bench only: hold the C6 enable long enough to read on a multimeter.
  #
  # The product asserts EN for EN_HOLD_MS (20 ms), which is correct for the
  # chip and invisible to a meter. Setting this runs a few slow, announced
  # assert/release cycles before the real bring-up so the CHIP_PU transition
  # can be observed by hand. It changes no product timing: leave it unset and
  # not one instruction of it is compiled.
  #
  #   idf.py -DKINO_C6_EN_BENCH_MS=3000 ... build
  if(KINO_C6_EN_BENCH_MS)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE
                               KINO_C6_EN_BENCH_MS=${KINO_C6_EN_BENCH_MS})
  endif()

  # Bench only: the coprocessor-recovery image. One announced GPIO54 pulse so
  # the operator can hold C6_IO9 low across it, then the P4 leaves the C6
  # alone entirely - no SDIO, no ESP-Hosted, no second reset. Unset, not one
  # instruction of it is compiled.
  #
  #   idf.py -DKINO_C6_RECOVERY=1 ... build
  # Bench only: a KDP command (C6_RESET_BENCH, 0x4d) that pulses the C6 enable
  # line once and leaves the P4 running, so the upload queue can be watched
  # surviving a radio reboot (ROLL-C test 3). Unset, the command is refused
  # with UNSUPPORTED_COMMAND and the pulse is not compiled.
  #
  #   idf.py -DKINO_C6_RESET_BENCH=1 ... build
  if(KINO_C6_RESET_BENCH)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_C6_RESET_BENCH=1)
  endif()

  if(KINO_C6_RECOVERY)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_C6_RECOVERY=1)
  endif()
elseif(CONFIG_ESP_HOSTED)
  # The other direction, and the dangerous one: ESP-Hosted enabled without the
  # fragment means the component's constructor drives GPIO14-19 and GPIO54
  # before app_main() while none of this firmware's radio code is even compiled.
  message(FATAL_ERROR
          "CONFIG_ESP_HOSTED is y but sdkconfig.radio was not used. That build "
          "would drive the C6 pins with no driver behind them. See "
          "firmware/C6_BRINGUP.md step 4.")
endif()

# Bench switch: `idf.py -DKINO_UI_FRAME_DUMP=1 build` makes the UI print its
# composed screens over the console so they can be decoded into pictures.
# Off by default - it costs several seconds of boot and floods the log.
if(KINO_UI_FRAME_DUMP)
  target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_UI_FRAME_DUMP=1)
endif()

file(READ "${CMAKE_CURRENT_LIST_DIR}/../../VERSION" KINO_FW_VERSION)
string(STRIP "${KINO_FW_VERSION}" KINO_FW_VERSION)
target_compile_definitions(${COMPONENT_LIB} PRIVATE KINO_FW_VERSION="${KINO_FW_VERSION}")
