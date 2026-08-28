/*
 * ESP-Hosted transport bring-up and the version gate. See net_hosted.h for
 * why this file is a build-time opt-in and what the default build does
 * instead.
 *
 * Nothing here has been run on hardware. No pin has been driven toward the
 * C6 on any unit.
 */
#include "net_hosted.h"

#ifdef KINO_RADIO

#include <stdio.h>
#include <string.h>

#include "board_d4v1.h"
#include "driver/gpio.h"
#include "esp_hosted.h"
#include "esp_hosted_transport_config.h"
/* The transport-state query Gate C6-B rests on. Guarded because it is a
 * component-internal header path, not part of the esp_hosted compat surface. */
#if __has_include("eh_host_mcu_transport_state.h")
#include "eh_host_mcu_transport_state.h"
#else
#error "eh_host_mcu_transport_state.h missing: esp_hosted layout changed, re-audit C6-B"
#endif
#include "esp_log.h"
#include "esp_timer.h"
#include "hardware_validation.h"
#include "hwv_rules.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "klog.h"
#include "net_link.h"
#include "net_time.h"
#include "net_wifi.h"
#include "taskmon.h"

static const char *TAG = "c6";

/* ------------------------------------------------------------------ */
/* Build-time consistency                                             */
/* ------------------------------------------------------------------ */

/* One SDMMC controller, two slots, and the card is on slot 0. If these ever
 * agree the radio and the card fight over the same chip select, which
 * presents as a card that stops mounting when the radio comes up — a full
 * bench session to diagnose from the symptom. */
_Static_assert(BOARD_C6_SLOT != BOARD_SD_SLOT,
               "the C6 and the SD card cannot share an SDMMC slot");

#ifdef CONFIG_ESP_HOSTED_HOST_RESET_ACTIVE_LOW
#define HOSTED_EN_ACTIVE_LOW 1
#else
#define HOSTED_EN_ACTIVE_LOW 0
#endif

/* Two places name GPIO54's polarity: board_d4v1.h, which is where every pin
 * fact on this body lives, and sdkconfig.radio, which is what ESP-Hosted's own
 * reset pulse reads. They must say the same thing. This is the one signal
 * where being wrong leaves a board that will not boot, and the polarity is
 * UNCONFIRMED on this carrier — so the bench will flip it, and it must not be
 * possible to flip only half of it. */
_Static_assert(HOSTED_EN_ACTIVE_LOW == BOARD_C6_EN_ACTIVE_LOW,
               "BOARD_C6_EN_ACTIVE_LOW and CONFIG_ESP_HOSTED_SDIO_RESET_ACTIVE_LOW disagree");

/* ------------------------------------------------------------------ */
/* The enable line                                                    */
/* ------------------------------------------------------------------ */

/*
 * GPIO54 goes to the C6's CHIP_PU, which is an ENABLE and not a
 * reset-request: LOW holds the chip off, HIGH lets it run. Named for the
 * physical signal for that reason. There is deliberately no C6_RESET_HIGH():
 * on an active-low enable that name asserts the opposite of what it reads
 * like.
 *
 * BOARD_C6_EN_ACTIVE_LOW is the board's answer to "which level asserts
 * reset", and it is a guess corroborated by convention, not a measurement.
 */
static void en_configure(void) {
  const gpio_config_t cfg = {
      .pin_bit_mask = 1ULL << BOARD_C6_EN,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  (void)gpio_config(&cfg);
}

/** Hold the C6 off. */
static void board_c6_hold_reset(void) {
  en_configure();
  (void)gpio_set_level(BOARD_C6_EN, BOARD_C6_EN_ACTIVE_LOW ? 0 : 1);
  net_link_report_reset();
}

/** Let the C6 run. */
static void board_c6_enable(void) {
  en_configure();
  (void)gpio_set_level(BOARD_C6_EN, BOARD_C6_EN_ACTIVE_LOW ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* Counters                                                           */
/* ------------------------------------------------------------------ */

static uint64_t s_rx_bytes;
static uint64_t s_tx_bytes;
static uint32_t s_errors;

void net_hosted_counters(uint64_t *rx_bytes, uint64_t *tx_bytes, uint32_t *errors) {
  if (rx_bytes != NULL) *rx_bytes = s_rx_bytes;
  if (tx_bytes != NULL) *tx_bytes = s_tx_bytes;
  if (errors != NULL) *errors = s_errors;
}

void net_hosted_count_bytes(uint64_t rx, uint64_t tx) {
  s_rx_bytes += rx;
  s_tx_bytes += tx;
  net_link_report_transport(s_rx_bytes, s_tx_bytes, s_errors, true);
}

static void count_error(void) {
  s_errors++;
  net_link_report_transport(s_rx_bytes, s_tx_bytes, s_errors, false);
}

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* ------------------------------------------------------------------ */
/* Transport                                                          */
/* ------------------------------------------------------------------ */

/**
 * Hand ESP-Hosted our pins rather than its Kconfig's.
 *
 * Runtime configuration, not sdkconfig, because every P4 pin assignment on
 * this body lives in board_d4v1.h and that rule is what makes a pin change
 * reviewable. It is only possible because
 * CONFIG_ESP_HOSTED_AUTO_CALL_INIT_BEFORE_APP_MAIN=n: with the constructor
 * on, the shadow config is already locked and every setter returns
 * ESP_TRANSPORT_ERR_ALREADY_SET.
 *
 * The reset pin is handed over too, and ESP-Hosted's ALWAYS strategy pulses it
 * again during esp_hosted_init() with the 1500 ms settle its own enumeration
 * expects. That is one redundant pulse after the explicit hold-and-release
 * above, and it is the right trade: the alternative is telling ESP-Hosted the
 * pin does not exist, which leaves its recovery path with no way to reset a
 * wedged coprocessor.
 */
static bool configure_transport(void) {
  struct esp_hosted_sdio_config cfg = INIT_DEFAULT_HOST_SDIO_CONFIG();

  cfg.slot = BOARD_C6_SLOT;
  cfg.bus_width = 4;
  cfg.pin_clk.pin = BOARD_C6_CLK;
  cfg.pin_cmd.pin = BOARD_C6_CMD;
  cfg.pin_d0.pin = BOARD_C6_D0;
  cfg.pin_d1.pin = BOARD_C6_D1;
  cfg.pin_d2.pin = BOARD_C6_D2;
  cfg.pin_d3.pin = BOARD_C6_D3;
  cfg.pin_reset.pin = BOARD_C6_EN;

  const esp_hosted_transport_err_t err = esp_hosted_sdio_set_config(&cfg);
  if (err != ESP_TRANSPORT_OK) {
    ESP_LOGE(TAG, "SDIO config refused: %d", (int)err);
    return false;
  }
  ESP_LOGI(TAG, "SDIO slot %d, 4-bit, D0-D3 %d-%d, CLK %d, CMD %d, EN %d", BOARD_C6_SLOT,
           BOARD_C6_D0, BOARD_C6_D3, BOARD_C6_CLK, BOARD_C6_CMD, BOARD_C6_EN);
  return true;
}

/* ------------------------------------------------------------------ */
/* The version gate                                                   */
/* ------------------------------------------------------------------ */

/*
 * A version mismatch is a GATE, not a warning.
 *
 * This carrier is publicly reported to ship a C6 factory image older than
 * current hosts expect, and an incompatible coprocessor does not announce
 * itself as one: RPCs time out, the transport looks flaky, and the whole
 * thing gets diagnosed as bad Wi-Fi or bad soldering. Refusing at the
 * handshake with C6_BAD_FIRMWARE turns three bench sessions into one.
 *
 * The rule:
 *
 *   - MAJOR must match exactly. A major change is a wire change.
 *   - A coprocessor MINOR below the host's is refused. Minors add RPC
 *     messages, so an older coprocessor lacks messages this host sends.
 *   - A coprocessor MINOR above the host's is accepted and logged. The host
 *     simply never sends what it does not know about.
 *
 * The RPC protocol version is not separately queryable in esp_hosted 3.0.6 —
 * the host's RPC layer is compile-time (rpc_v2 msg_id dispatch) and there is
 * no "tell me your protocol version" call outside the version RPC itself. So
 * the protocol check IS this call succeeding: a coprocessor that cannot
 * answer it does not speak our RPC, and that maps to C6_NO_RESPONSE rather
 * than to a version number nobody has.
 */
#define HOST_HOSTED_MAJOR ESP_HOSTED_VERSION_MAJOR_1
#define HOST_HOSTED_MINOR ESP_HOSTED_VERSION_MINOR_1
#define HOST_HOSTED_PATCH ESP_HOSTED_VERSION_PATCH_1

static bool version_gate(void) {
  char host_ver[NET_VERSION_LEN];
  snprintf(host_ver, sizeof host_ver, "%u.%u.%u", (unsigned)HOST_HOSTED_MAJOR,
           (unsigned)HOST_HOSTED_MINOR, (unsigned)HOST_HOSTED_PATCH);

  esp_hosted_coprocessor_fwver_t cp = {0};
  if (esp_hosted_get_coprocessor_fwversion(&cp) != 0) {
    count_error();
    net_link_report_versions(host_ver, NULL, NULL);
    net_link_report_state(NET_C6_BOOTING, NET_REASON_C6_NO_RESPONSE,
                          "the C6 did not answer the version RPC", now_ms());
    return false;
  }

  char cp_ver[NET_VERSION_LEN];
  snprintf(cp_ver, sizeof cp_ver, "%u.%u.%u", (unsigned)cp.major1, (unsigned)cp.minor1,
           (unsigned)cp.patch1);

  /* The image's own description, when the coprocessor offers one. Worth
   * having beside the protocol version: "which build is on the C6" is the
   * question a bench operator actually asks, and the answer is a project name
   * and a date, not a semver. */
  esp_hosted_app_desc_t desc = {0};
  if (esp_hosted_get_coprocessor_app_desc(&desc) == ESP_OK) {
    ESP_LOGI(TAG, "coprocessor image %s %s (IDF %s, %s %s)", desc.project_name, desc.version,
             desc.idf_ver, desc.date, desc.time);
  }

  net_link_report_versions(host_ver, cp_ver, "rpc-v2");

  if ((uint32_t)cp.major1 != (uint32_t)HOST_HOSTED_MAJOR ||
      (uint32_t)cp.minor1 < (uint32_t)HOST_HOSTED_MINOR) {
    char detail[NET_DETAIL_LEN];
    snprintf(detail, sizeof detail, "C6 image %s cannot serve host %s; reflash the C6", cp_ver,
             host_ver);
    net_link_report_state(NET_C6_BOOTING, NET_REASON_C6_BAD_FIRMWARE, detail, now_ms());
    klog("C6", "version gate refused C6 %s against host %s", cp_ver, host_ver);
    /* Deliberately does NOT go on to Wi-Fi. A stale coprocessor that is
     * allowed through fails later, somewhere else, as something else. */
    return false;
  }

  if ((uint32_t)cp.minor1 > (uint32_t)HOST_HOSTED_MINOR) {
    ESP_LOGW(TAG, "C6 image %s is newer than host %s; unknown RPCs go unused", cp_ver, host_ver);
  }
  if (hwv_rule_slave_version(true, (uint32_t)cp.major1, (uint32_t)cp.minor1, HOST_HOSTED_MAJOR,
                             HOST_HOSTED_MINOR)) {
    char detail[64];
    snprintf(detail, sizeof detail, "C6 %s serves host %s", cp_ver, host_ver);
    hwv_mark_validated(HWV_C6_SLAVE_VERSION, detail);
  }
  klog("C6", "link ready, C6 %s against host %s", cp_ver, host_ver);
  return true;
}

/* ------------------------------------------------------------------ */
/* The driver net_link calls back into                                */
/* ------------------------------------------------------------------ */

static const net_link_driver_t s_driver = {
    .scan_start = net_wifi_scan_start,
    .connect = net_wifi_connect,
    .disconnect = net_wifi_disconnect,
};

/* ------------------------------------------------------------------ */
/* Bring-up                                                           */
/* ------------------------------------------------------------------ */

/** How long the C6 is held off before ESP-Hosted takes the pin. Long enough
 * for CHIP_PU to settle through whatever the carrier has on it, and short
 * enough not to matter: this runs once, after the UI is already up. */
#define EN_HOLD_MS 20

/*
 * Bench only, and compiled out unless -DKINO_C6_EN_BENCH_MS is given.
 *
 * EN_HOLD_MS is right for the chip and unreadable by hand: a 20 ms dip does
 * not move a multimeter. B2 asks whether GPIO54 actually reaches the C6's
 * CHIP_PU and in which direction, and that is answered by watching JP1 pin 26
 * while this pin is deliberately driven. So drive it slowly, announce every
 * edge, and repeat, so a reading can be taken more than once.
 *
 * Three outcomes, all of them useful:
 *   pin 26 follows LOW then HIGH  - GPIO54 drives CHIP_PU, active-low
 *                                   confirmed, B2's transition observed
 *   pin 26 follows HIGH then LOW  - the net is inverted; flip
 *                                   BOARD_C6_EN_ACTIVE_LOW before any flash
 *   pin 26 never moves            - GPIO54 does not reach this pin, and the
 *                                   routing is wrong however well it is
 *                                   corroborated on paper
 */
#ifndef KINO_C6_EN_BENCH_MS
#define KINO_C6_EN_BENCH_MS 0
#endif

#if KINO_C6_EN_BENCH_MS > 0
#define EN_BENCH_CYCLES 3
static void en_bench_cycles(void) {
  klog("C6", "EN BENCH: %d cycles at %d ms. Meter on JP1 pin 26, GND on pin 16.",
       EN_BENCH_CYCLES, KINO_C6_EN_BENCH_MS);
  for (int i = 1; i <= EN_BENCH_CYCLES; i++) {
    klog("C6", "EN BENCH %d/%d: ASSERT - driving GPIO%d %s, expect pin 26 LOW", i,
         EN_BENCH_CYCLES, BOARD_C6_EN, BOARD_C6_EN_ACTIVE_LOW ? "LOW" : "HIGH");
    board_c6_hold_reset();
    vTaskDelay(pdMS_TO_TICKS(KINO_C6_EN_BENCH_MS));
    klog("C6", "EN BENCH %d/%d: RELEASE - driving GPIO%d %s, expect pin 26 HIGH", i,
         EN_BENCH_CYCLES, BOARD_C6_EN, BOARD_C6_EN_ACTIVE_LOW ? "HIGH" : "LOW");
    board_c6_enable();
    vTaskDelay(pdMS_TO_TICKS(KINO_C6_EN_BENCH_MS));
  }
  klog("C6", "EN BENCH: done, continuing into the real bring-up");
}
#endif

/*
 * What esp_hosted_init() proves, and what it does not.
 *
 * Read from the pinned esp_hosted 3.0.6 source rather than assumed: the SDIO
 * card init lives in eh_host_bus_sdio.c, and on failure it logs
 * "card init failed" and falls through without propagating an error. It is
 * also reached from transport threads started during init, not from init's own
 * call frame. So esp_hosted_init() == 0 establishes that the host-side vserial
 * and RPC layers came up - nothing more. It is not evidence that a
 * coprocessor exists.
 *
 * The transport state can be asked directly, and RX_ACTIVE is set from
 * exactly one place: a successful sdmmc_card_init(), which is ESP-IDF's own
 * SDIO enumeration and cannot succeed without a device answering CMD0/CMD5 on
 * the bus. That makes it the honest test for Gate C6-B.
 *
 * ESP-IDF's console is on UART0 and unreachable while KDP owns
 * USB-Serial-JTAG, so without this the answer is printed where no one at this
 * bench can read it.
 */
static bool probe_transport(void) {
  /* Enumeration is asynchronous: the threads that run it are started during
   * init and reach RX_ACTIVE afterwards. Poll rather than sample once. */
  const int64_t deadline = now_ms() + 3000;
  int rx = 0, tx = 0;
  do {
    rx = eh_host_mcu_transport_state_is_rx_ready();
    tx = eh_host_mcu_transport_state_is_tx_ready();
    if (rx) break;
    vTaskDelay(pdMS_TO_TICKS(100));
  } while (now_ms() < deadline);

  klog("C6", "SDIO after init: rx_ready=%d tx_ready=%d", rx, tx);

  /* The registry rows earn themselves here and nowhere else. Marking these on
   * esp_hosted_init()'s return value - which was the obvious place - would
   * have recorded VALIDATED on this very board, where init returns 0 and
   * nothing has ever answered. */
  if (hwv_rule_sdio_link(rx)) {
    char detail[48];
    snprintf(detail, sizeof detail, "SDIO enumerated on slot %d", BOARD_C6_SLOT);
    hwv_mark_validated(HWV_C6_SDIO_PINS, detail);
  }
  if (hwv_rule_transport_usable(rx, tx)) {
    hwv_mark_validated(HWV_C6_LINK_HANDSHAKE, "transport usable both directions");
  }

  if (!rx) {
    klog("C6", "no SDIO enumeration - nothing answered on GPIO14-19");
    return false;
  }

  /* Identity over the bus, which also answers "is it really a C6" without the
   * UART recovery path. Best-effort: an old slave may not serve this RPC. */
  uint32_t chip_id = 0;
  char target[24] = {0};
  if (esp_hosted_get_cp_info(&chip_id, target, sizeof target) == 0) {
    klog("C6", "coprocessor id=%lu target=%s", (unsigned long)chip_id, target);
  } else {
    klog("C6", "bus up but get_cp_info unanswered");
  }
  return true;
}

static void bring_up(void) {
#if KINO_C6_EN_BENCH_MS > 0
  en_bench_cycles();
#endif
  /* Hold the C6 off first, so the transport is opened against a chip in a
   * known state rather than whatever the last boot left running. ESP-Hosted's
   * own ALWAYS reset strategy releases it as part of esp_hosted_init(). */
  net_link_report_state(NET_C6_BOOTING, NET_REASON_NONE, "holding the C6 in reset", now_ms());
  board_c6_hold_reset();
  vTaskDelay(pdMS_TO_TICKS(EN_HOLD_MS));
  board_c6_enable();
  vTaskDelay(pdMS_TO_TICKS(EN_HOLD_MS));

  if (!configure_transport()) {
    count_error();
    net_link_report_state(NET_ERROR, NET_REASON_RADIO_FAILURE,
                          "ESP-Hosted refused the SDIO pin configuration", now_ms());
    return;
  }

  if (esp_hosted_init() != 0) {
    count_error();
    /* The host side refused before the bus was ever driven - a bad config, no
     * memory, the RPC layer failing to start. NOT "nothing enumerated": see
     * probe_transport() for why init's return value says nothing about
     * enumeration either way. */
    net_link_report_state(NET_C6_ABSENT, NET_REASON_C6_NO_RESPONSE,
                          "ESP-Hosted host init failed before the bus came up", now_ms());
    return;
  }

  /* Whether anything actually answered on the bus, asked rather than assumed.
   * This is Gate C6-B's real evidence and it must be read before the version
   * RPC, because a failed version RPC on a bus that never enumerated means
   * something completely different from the same failure on one that did. */
  const bool bus_up = probe_transport();

  net_link_report_transport(s_rx_bytes, s_tx_bytes, s_errors, bus_up);
  if (!bus_up) {
    count_error();
    net_link_report_state(NET_C6_ABSENT, NET_REASON_C6_NO_RESPONSE,
                          "SDIO did not enumerate; check GPIO14-19 and GPIO54", now_ms());
    return;
  }

  if (!version_gate()) return;
  net_link_report_state(NET_C6_LINK_READY, NET_REASON_NONE, "transport up, versions agree",
                        now_ms());

  /* LINK_READY is not WIFI_CONNECTED and is not reported as such. The radio
   * stack is a separate step and can fail on its own. */
  if (net_wifi_start() != ESP_OK) {
    count_error();
    net_link_report_state(NET_ERROR, NET_REASON_RADIO_FAILURE,
                          "the Wi-Fi stack would not initialise on the C6", now_ms());
    return;
  }
  net_link_report_state(NET_RADIO_READY, NET_REASON_NONE, "radio up", now_ms());
  net_link_report_state(NET_WIFI_IDLE, NET_REASON_NONE, NULL, now_ms());

  /* SNTP is armed here and only fires once there is an address — it needs one
   * and there is none yet. See net_time.c for why TLS waits on it. */
  net_time_start();
  net_wifi_auto_join();
}

/** One task, and it exits when there is nothing left to supervise.
 *
 * Priority 3: above the upload worker (2), below the UI (4) and far below the
 * capture workers (5). This task does bring-up and then watches; the SDIO RX
 * worker ESP-Hosted creates for itself is a separate task at
 * CONFIG_ESP_HOSTED_HOST_DEFLT_TASK_PRIORITY, which is a Gate F question
 * recorded in C6_BRINGUP.md rather than one this file can answer. */
static void supervisor_task(void *arg) {
  (void)arg;
  bring_up();

  /* Recovery, which is the half that gets skipped. A link that drops is
   * reported and re-established; the camera stays fully usable throughout,
   * because nothing in the capture path waits on any of this. */
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(2000));

    net_status_t st;
    net_link_status(&st, now_ms());
    if (st.state == NET_C6_ABSENT || st.state == NET_ERROR ||
        st.reason == NET_REASON_C6_BAD_FIRMWARE) {
      /* Parked on purpose. Re-pulsing a coprocessor that answered with the
       * wrong version, or a bus that did not enumerate, produces a reset loop
       * and a log nobody can read — and on unproven routing a reset loop is
       * the thing that must not ship. A power cycle or a reflash is the fix.
       */
      continue;
    }
    if (st.state == NET_C6_LINK_READY || st.state >= NET_RADIO_READY) {
      if (!st.sdio_link_up) {
        count_error();
        net_link_report_state(NET_C6_BOOTING, NET_REASON_C6_LINK_LOST,
                              "the SDIO link went down", now_ms());
      }
    }
  }
}

esp_err_t net_hosted_start(void) {
  /* Registered BEFORE a pin moves, so a NETWORK_STATUS read during bring-up
   * says BOOTING rather than claiming this firmware has no route. */
  net_link_set_driver(&s_driver, now_ms());

  TaskHandle_t h = NULL;
  if (xTaskCreate(supervisor_task, "c6link", 5120, NULL, 3, &h) != pdPASS) {
    net_link_set_driver(NULL, now_ms());
    ESP_LOGE(TAG, "supervisor task create failed");
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("c6link", h);
  return ESP_OK;
}

#endif /* KINO_RADIO */
