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

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "board_d4v1.h"
#include "driver/gpio.h"
#include "esp_hosted.h"
#include "esp_hosted_transport_config.h"
/* The transport-state query Gate C6-B rests on. Guarded because it is a
 * component-internal header path, not part of the esp_hosted compat surface. */
#if __has_include("eh_host_mcu_transport_state.h")
#include "eh_host_bus.h"
#include "eh_host_mcu_transport.h"
#include "eh_host_mcu_transport_state.h"
#include "eh_host_port_sdio.h"
#include "eh_host_port_sdio_reg.h"
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
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_hosted_event.h"
#include "net_link.h"
#include "net_time.h"
#include "net_wifi.h"
#include "radio_recovery.h"
#include "taskmon.h"
#include "upload_queue.h"
#include "wifi_creds.h"

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

/*
 * The counters are 64-bit and the P4 is a 32-bit core, so `s_rx_bytes += rx`
 * is a load pair, an add with carry and a store pair — not one instruction and
 * not atomic. The writers are not one task either: roll_http.c counts response
 * and part bytes from the upload worker, count_error() runs on the c6link
 * supervisor, and net_hosted_counters() is read from the KDP task. A read that
 * lands between the two stores of a carry reports a number that was never
 * true, which in GET_RUNTIME_STATS is a jump of four gigabytes.
 *
 * A spinlock rather than a mutex: this is four instructions with no blocking
 * call inside it, and a mutex here would put the upload worker on a priority
 * queue for an addition.
 */
static portMUX_TYPE s_counter_lock = portMUX_INITIALIZER_UNLOCKED;

void net_hosted_counters(uint64_t *rx_bytes, uint64_t *tx_bytes, uint32_t *errors) {
  taskENTER_CRITICAL(&s_counter_lock);
  const uint64_t rx = s_rx_bytes;
  const uint64_t tx = s_tx_bytes;
  const uint32_t errs = s_errors;
  taskEXIT_CRITICAL(&s_counter_lock);

  if (rx_bytes != NULL) *rx_bytes = rx;
  if (tx_bytes != NULL) *tx_bytes = tx;
  if (errors != NULL) *errors = errs;
}

void net_hosted_count_bytes(uint64_t rx, uint64_t tx) {
  taskENTER_CRITICAL(&s_counter_lock);
  s_rx_bytes += rx;
  s_tx_bytes += tx;
  const uint64_t now_rx = s_rx_bytes;
  const uint64_t now_tx = s_tx_bytes;
  const uint32_t errs = s_errors;
  taskEXIT_CRITICAL(&s_counter_lock);

  /* Outside the critical section: net_link takes a mutex, and blocking with
   * interrupts disabled is how a capture misses its VSYNC. */
  net_link_report_transport(now_rx, now_tx, errs, true);
}

static void count_error(void) {
  taskENTER_CRITICAL(&s_counter_lock);
  s_errors++;
  const uint64_t rx = s_rx_bytes;
  const uint64_t tx = s_tx_bytes;
  const uint32_t errs = s_errors;
  taskEXIT_CRITICAL(&s_counter_lock);

  net_link_report_transport(rx, tx, errs, false);
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
  if (err == ESP_TRANSPORT_ERR_ALREADY_SET) {
    /* Recovery path: the pins were handed over at first boot and the shadow
     * config survived esp_hosted_deinit(). Same pins, so nothing to do. */
    return true;
  }
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
/*
 * The host's RELEASE version - what esp_hosted itself compares the coprocessor
 * against in eh_host_mcu_transport_verify_fw_compat(), and what it prints as
 * "esp-hosted fw versions: host=3.0.6".
 *
 * Not ESP_HOSTED_VERSION_*_1 from esp_hosted_host_fw_ver.h. That header says
 * so in its own first line - "Upstream-mcu compat" - and carries 2.12.6, a
 * different version space. Measured on KD4-D121BC: the gate below compared
 * the coprocessor's 2.3.2 against 2.12.6, refused on a minor-version rule,
 * and printed "cannot serve host 2.12.6" while the component two lines above
 * it in the same log said "host=3.0.6 ... major version mismatch". Right
 * verdict, wrong constant, misleading detail. The constants below make the
 * two agree.
 */
#if __has_include("eh_common_fw_version.h")
#include "eh_common_fw_version.h"
#define HOST_HOSTED_MAJOR PROJECT_VERSION_MAJOR_1
#define HOST_HOSTED_MINOR PROJECT_VERSION_MINOR_1
#define HOST_HOSTED_PATCH PROJECT_VERSION_PATCH_1
#else
#error "eh_common_fw_version.h missing: esp_hosted layout changed, re-audit the version gate"
#endif

/* The last version gate's verdict, in the recovery machine's vocabulary. */
static rr_version_t s_ver_verdict = RR_VER_UNKNOWN;

static bool version_gate(void) {
  char host_ver[NET_VERSION_LEN];
  snprintf(host_ver, sizeof host_ver, "%u.%u.%u", (unsigned)HOST_HOSTED_MAJOR,
           (unsigned)HOST_HOSTED_MINOR, (unsigned)HOST_HOSTED_PATCH);

  esp_hosted_coprocessor_fwver_t cp = {0};
  if (esp_hosted_get_coprocessor_fwversion(&cp) != 0) {
    s_ver_verdict = RR_VER_NO_RESPONSE;
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
    s_ver_verdict = RR_VER_INCOMPATIBLE;
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
  s_ver_verdict = RR_VER_OK;
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
#ifndef KINO_C6_RECOVERY
#define KINO_C6_RECOVERY 0
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

/* ------------------------------------------------------------------ */
/* Bench: capture ESP-IDF's own log during bring-up                     */
/* ------------------------------------------------------------------ */

/*
 * The console is on UART0 and KDP owns USB-Serial-JTAG, so every ESP_LOGx the
 * IDF and esp_hosted emit is printed where nobody at this bench can read it -
 * including the one line that says WHY sdmmc_card_init() failed. "card init
 * failed" is not a diagnosis; ESP_ERR_TIMEOUT waiting for CMD5 and a CRC error
 * and an unsupported voltage are three different faults with three different
 * fixes.
 *
 * So the log is diverted into a buffer for the duration of the bring-up and
 * then replayed into klog, which GET_LOGS can read.
 *
 * Deliberately NOT calling klog() from inside the hook: klog() itself calls
 * ESP_LOGI, so a hook that logged would re-enter itself forever. Nothing here
 * logs. It appends bytes and returns, and the replay happens later, from
 * ordinary task context, once the hook is uninstalled.
 */
/* 6 KB: the connect path logs the reset, every card-init retry and the
 * sdmmc driver's own reason for each failure, and those are exactly the lines
 * this exists to keep. */
#define HOSTED_LOG_CAP 6144
#define HOSTED_LOG_REPLAY_MAX 40
static char s_hostlog[HOSTED_LOG_CAP];
static size_t s_hostlog_len;
static vprintf_like_t s_prev_vprintf;
/* ESP-Hosted's transport tasks run at priority 22 and log from several tasks
 * at once during connect. A spinlock, not a mutex: this runs inside the log
 * call and must never block or yield. */
static portMUX_TYPE s_hostlog_mux = portMUX_INITIALIZER_UNLOCKED;

static int hostlog_vprintf(const char *fmt, va_list args) {
  char line[192];
  va_list copy;
  va_copy(copy, args);
  const int n = vsnprintf(line, sizeof line, fmt, copy);
  va_end(copy);
  if (n > 0) {
    portENTER_CRITICAL(&s_hostlog_mux);
    if (s_hostlog_len + 1 < HOSTED_LOG_CAP) {
      size_t take = (size_t)n;
      const size_t room = HOSTED_LOG_CAP - s_hostlog_len - 1;
      if (take > room) take = room;
      memcpy(s_hostlog + s_hostlog_len, line, take);
      s_hostlog_len += take;
      s_hostlog[s_hostlog_len] = '\0';
    }
    portEXIT_CRITICAL(&s_hostlog_mux);
  }
  /* Still goes to the real console, so nothing is lost for anyone with a
   * UART0 probe. The default vprintf does not log, so this cannot recurse. */
  return s_prev_vprintf != NULL ? s_prev_vprintf(fmt, args) : n;
}

static void hostlog_begin(void) {
  /* Installing twice would make s_prev_vprintf point at this function and
   * the next log call would recurse without end. bring_up() runs once, but
   * the guard costs nothing and the failure mode is a silent stack overflow. */
  if (s_prev_vprintf != NULL) return;
  portENTER_CRITICAL(&s_hostlog_mux);
  s_hostlog_len = 0;
  s_hostlog[0] = '\0';
  portEXIT_CRITICAL(&s_hostlog_mux);
  s_prev_vprintf = esp_log_set_vprintf(hostlog_vprintf);
}

/** Uninstall and replay. Only the lines worth a bench operator's attention. */
static void hostlog_end(void) {
  if (s_prev_vprintf != NULL) {
    (void)esp_log_set_vprintf(s_prev_vprintf);
    s_prev_vprintf = NULL;
  }
  char *p = s_hostlog;
  int emitted = 0;
  while (p != NULL && *p != '\0' && emitted < HOSTED_LOG_REPLAY_MAX) {
    char *nl = strchr(p, '\n');
    if (nl != NULL) *nl = '\0';
    /* Strip the colour escapes the IDF wraps its levels in. */
    char clean[112];
    size_t o = 0;
    for (const char *q = p; *q != '\0' && o + 1 < sizeof clean; q++) {
      if (*q == 0x1b) {
        while (*q != '\0' && *q != 'm') q++;
        if (*q == '\0') break;
        continue;
      }
      if (*q == '\r') continue;
      clean[o++] = *q;
    }
    clean[o] = '\0';
    /* Every klog event is a serial transaction on the KDP link. Replaying
     * forty of them before the version gate ran delayed the gate by 17 s on
     * the bench and showed up on the coprocessor's console as an unexplained
     * gap between RPCs - the instrument distorting the measurement. So only
     * the lines that carry a verdict are replayed. */
    static const char *const keep[] = {"eh_sdio", "sdmmc", "eh_host_port_sdio", "eh_init_evt",
                                       "eh_mcu_transport", "eh_reconfigure", "eh_host_xport",
                                       "E (", "W ("};
    bool wanted = false;
    for (size_t k = 0; k < sizeof keep / sizeof keep[0] && !wanted; k++) {
      wanted = strstr(clean, keep[k]) != NULL;
    }
    if (o > 0 && wanted && strstr(clean, "kino:") == NULL) {
      klog("C6", "idf: %s", clean);
      emitted++;
    }
    p = nl != NULL ? nl + 1 : NULL;
  }
  if (emitted == 0) klog("C6", "idf: (no log captured during bring-up)");
}

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
#if KINO_C6_RECOVERY
  /*
   * Recovery image for flashing the coprocessor over its own UART.
   *
   * The C6's ROM download mode needs IO9 held low across a reset. The P4
   * owns the reset line, so this build pulses it once - slowly and announced,
   * so the operator can hold the strap - and then does nothing else: no
   * SDIO pin is configured, ESP-Hosted is never initialised, and GPIO54 is
   * never touched again. A normal radio build would pulse reset a second
   * time inside connect_to_slave() and yank the C6 out of the bootloader
   * mid-write.
   */
  klog("C6", "RECOVERY: hold JP1 pin 24 (C6_IO9) LOW now; reset in 5 s");
  vTaskDelay(pdMS_TO_TICKS(5000));
  klog("C6", "RECOVERY: asserting GPIO54 LOW for 500 ms");
  board_c6_hold_reset();
  vTaskDelay(pdMS_TO_TICKS(500));
  board_c6_enable();
  klog("C6", "RECOVERY: released. C6 should be in ROM download mode; P4 is now inert toward it");
  net_link_report_state(NET_C6_BOOTING, NET_REASON_NONE, "recovery image: C6 released for flashing",
                        now_ms());
  return;
#endif
#if KINO_C6_EN_BENCH_MS > 0
  en_bench_cycles();
#endif
  /* Hold the C6 off first, so the transport is opened against a chip in a
   * known state rather than whatever the last boot left running. ESP-Hosted's
   * own ALWAYS reset strategy releases it as part of esp_hosted_init(). */
  net_link_report_state(NET_C6_BOOTING, NET_REASON_NONE, "holding the C6 in reset", now_ms());

  /* Timestamps taken around the sequence and reported AFTER it, not from
   * inside: the 20 ms hold is a chip requirement, and a klog() in the middle
   * of it would be measuring the instrument. */
  const int64_t t_assert = esp_timer_get_time();
  board_c6_hold_reset();
  vTaskDelay(pdMS_TO_TICKS(EN_HOLD_MS));
  const int64_t t_release = esp_timer_get_time();
  board_c6_enable();
  vTaskDelay(pdMS_TO_TICKS(EN_HOLD_MS));
  const int64_t t_done = esp_timer_get_time();
  klog("C6", "own reset: GPIO%d %s-asserted %lldus, released, settled %lldus", BOARD_C6_EN,
       BOARD_C6_EN_ACTIVE_LOW ? "low" : "high", (long long)(t_release - t_assert),
       (long long)(t_done - t_release));

  /* From here to hostlog_end() the IDF's own log is captured, because this is
   * the window in which sdmmc_card_init() says what actually went wrong. */
  hostlog_begin();

  if (!configure_transport()) {
    hostlog_end();
    count_error();
    net_link_report_state(NET_ERROR, NET_REASON_RADIO_FAILURE,
                          "ESP-Hosted refused the SDIO pin configuration", now_ms());
    return;
  }

  const int64_t t_init0 = esp_timer_get_time();
  const int init_rc = esp_hosted_init();
  const int64_t t_init1 = esp_timer_get_time();
  if (init_rc != 0) {
    hostlog_end();
    count_error();
    /* The host side refused before the bus was ever driven - a bad config, no
     * memory, the RPC layer failing to start. NOT "nothing enumerated": see
     * probe_transport() for why init's return value says nothing about
     * enumeration either way. */
    net_link_report_state(NET_C6_ABSENT, NET_REASON_C6_NO_RESPONSE,
                          "ESP-Hosted host init failed before the bus came up", now_ms());
    return;
  }

  /*
   * The half that was missing.
   *
   * esp_hosted_init() brings up the host-side vserial and RPC layers and
   * returns. It does not touch the bus. The reset pulse, sdmmc_card_init()
   * and the RX_ACTIVE state all live in ensure_slave_bus_ready(), which is
   * reached from exactly one place in the pinned 3.0.6 source:
   * eh_host_bus_connect_to_slave(), i.e. esp_hosted_connect_to_slave().
   *
   * The component's own auto-init constructor calls both -
   * `eh_host_init(NULL) == 0 && eh_host_connect_to_slave() == 0` - and this
   * firmware disables that constructor so no pin is driven before app_main().
   * Correct, and then only the first half was reproduced here. Measured on
   * KD4-D121BC: init returned 0 in 32 ms, no reset pulse ever reached the C6
   * beyond our own, "card init failed" never appeared in the IDF log, and
   * rx_ready stayed 0 - because enumeration had never been attempted.
   *
   * Blocks for up to CONFIG_ESP_HOSTED_HOST_CP_BRINGUP_TIMEOUT_MS (5000) and
   * then returns -EIO. It does NOT reboot: CP_BRINGUP_ON_TIMEOUT_NONE is
   * pinned in sdkconfig.radio, because the REATTEMPT and RESTART arms both end
   * in esp_restart(), and a dead radio must never cost a photograph.
   */
  const int64_t t_conn0 = esp_timer_get_time();
  const int conn_rc = esp_hosted_connect_to_slave();
  const int64_t t_conn1 = esp_timer_get_time();
  klog("C6", "connect_to_slave rc=%d in %lldms", conn_rc,
       (long long)((t_conn1 - t_conn0) / 1000));

  /* Whether anything actually answered on the bus, asked rather than assumed.
   * This is Gate C6-B's real evidence and it must be read before the version
   * RPC, because a failed version RPC on a bus that never enumerated means
   * something completely different from the same failure on one that did. */
  const bool bus_up = probe_transport();
  klog("C6", "esp_hosted_init rc=%d in %lldms", init_rc, (long long)((t_init1 - t_init0) / 1000));

  net_link_report_transport(s_rx_bytes, s_tx_bytes, s_errors, bus_up);
  if (!bus_up) {
    hostlog_end();
    count_error();
    net_link_report_state(NET_C6_ABSENT, NET_REASON_C6_NO_RESPONSE,
                          "SDIO did not enumerate; check GPIO14-19 and GPIO54", now_ms());
    return;
  }

  const bool versions_ok = version_gate();
  /* Replay the captured IDF log only now, with the gate's verdict already
   * reported: the replay is slow and must not sit between the RPC and the
   * state it produces. */
  hostlog_end();
  if (!versions_ok) return;
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

/* ------------------------------------------------------------------ */
/* Recovery                                                           */
/* ------------------------------------------------------------------ */

/*
 * What the supervisor does after bring-up: notice the C6 going away, and get
 * it back without rebooting the P4.
 *
 * Measured on KD4-D121BC, 2026-08-30, firmware 0.4.5: a C6 reset with the P4
 * running left the host stack holding the state of a coprocessor that no
 * longer existed - ESP-Hosted transport initialised against a slave that had
 * rebooted, esp_wifi_remote believing it was associated, the netif holding
 * an address - and nothing here re-established anything. NETWORK_STATUS said
 * C6_BOOTING / C6_LINK_LOST for as long as anyone watched. The decision of
 * what to do about it is radio_recovery.c, host-tested; this is the doing.
 *
 * Detection, while the link is believed up:
 *   - EH_HOST_EVENT_TRANSPORT_FAILURE from ESP-Hosted's own bus code;
 *   - net_link's sdio_link_up going false (a reset this firmware issued);
 *   - two consecutive unanswered liveness RPCs (the version RPC, every
 *     PROBE_PERIOD_MS; a coprocessor that reset without telling anyone).
 */
#define PROBE_PERIOD_MS 20000
#define PROBE_CONFIRM_MS 1000

/*
 * The recovery reserve.
 *
 * ESP-Hosted's SDIO buffers are DMA-capable internal RAM: on the P4, IDF
 * 5.5.1 registers the PSRAM heap without MALLOC_CAP_DMA, so the component's
 * SPIRAM preference can never be satisfied and everything falls to internal
 * memory. At first boot a 15,872 B block is there; after the camera has run
 * for a minute it is not, and the component's INIT handler asserts on the
 * advertised SW_AGGR buffer size ("no silent degrade") - measured on
 * KD4-D121BC as a panic 14 s into every recovery attempt. So the blocks the
 * re-init needs are taken here, right after bring-up while the heap still
 * looks like first boot, and handed back the moment before esp_hosted_init()
 * runs again: one for the probe, one for the aggregate TX buffer the bus
 * allocates lazily on its first frame (and asserts on too).
 *
 * The block size is the component's, not a round number. esp_hosted 3.0.6's
 * eh_host_mcu_transport_init_event.c probes max(e2h_bufsz, h2e_bufsz), and
 * both negotiate to 31 x EH_SDIO_CFG_BUF_BLOCK (512 B) = 15,872 B on this
 * carrier - the exact alloc the assert at init_event.c:358 guards. This was
 * 16,384 B, a round-up that fit at first boot on 0.4.6 but not once internal
 * RAM grew across 0.4.7-0.4.20: the largest free internal-DMA block fell to
 * 15,872 B, so a 16,384 B reserve held 0/2 and every C6 recovery re-init
 * asserted (#162). 15,872 B is what the component actually needs and what is
 * actually free, so the reserve holds again. Sizing to the requirement is not
 * lowering the bar - the assert is the component's, unchanged; this stops
 * asking the heap for more than either side ever uses.
 *
 * Not taken before bring-up. The bus allocates its TX aggregate buffer on the
 * first frame it sends, so a reserve held across the component's first init
 * starves that very allocation (eh_host_bus_sdio.c:786) - 0.4.25 did exactly
 * this and boot-looped. The reserve is a promise about recovery, and it can
 * only be made from what is left once the transport is up. The headroom it
 * needs comes from keeping internal RAM for what must be internal: static
 * buffers that only tasks touch (cam_link, klog, upload_queue) live in PSRAM.
 */
#define DMA_RESERVE_BLOCKS 2
/* 31 * EH_SDIO_CFG_BUF_BLOCK (512): the negotiated SW_AGGR buffer size. */
#define DMA_RESERVE_BYTES 15872
static void *s_dma_reserve[DMA_RESERVE_BLOCKS];
static int s_dma_reserve_held; /* honest recovery-readiness, read by net_hosted_recovery_ready() */

static void dma_reserve_take(void) {
  int held = 0;
  for (int i = 0; i < DMA_RESERVE_BLOCKS; i++) {
    if (s_dma_reserve[i] == NULL) {
      s_dma_reserve[i] = heap_caps_aligned_alloc(64, DMA_RESERVE_BYTES,
                                                 MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT);
    }
    if (s_dma_reserve[i] != NULL) held++;
  }
  s_dma_reserve_held = held;
  /* A boot that could not hold the whole reserve is one C6 reset away from the
   * panic this reserve exists to prevent. Say so at WARN so it is not silent -
   * the radio still works, but recovery is not guaranteed until it is fixed. */
  klog("C6", "recovery reserve: %d/%d x %d B internal DMA held; largest free %u B",
       held, DMA_RESERVE_BLOCKS, DMA_RESERVE_BYTES,
       (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT));
  if (held < DMA_RESERVE_BLOCKS) {
    ESP_LOGW("C6", "recovery reserve incomplete (%d/%d): C6 recovery may panic re-init until internal-DMA headroom is restored",
             held, DMA_RESERVE_BLOCKS);
  }
}

bool net_hosted_recovery_ready(void) { return s_dma_reserve_held >= DMA_RESERVE_BLOCKS; }

static void dma_reserve_release(void) {
  for (int i = 0; i < DMA_RESERVE_BLOCKS; i++) {
    if (s_dma_reserve[i] != NULL) {
      heap_caps_free(s_dma_reserve[i]);
      s_dma_reserve[i] = NULL;
    }
  }
  klog("C6", "recovery reserve released; largest free internal DMA block %u B",
       (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT));
}

static rr_t s_rr;
static bool s_linked;                 /* bring-up or a recovery reached LINK_READY */
static volatile bool s_loss_event;    /* transport failure event, or a bench reset */
static volatile bool s_bench_loss;    /* a bench reset specifically; restarts a parked machine */
static int s_probe_failures;
static int64_t s_next_probe_ms;

static void hosted_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  (void)base;
  (void)data;
  if (id == ESP_HOSTED_EVENT_TRANSPORT_FAILURE) s_loss_event = true;
}

static void report_recovery(const char *what) {
  char d[NET_DETAIL_LEN];
  snprintf(d, sizeof d, "recovery: %s", what);
  net_link_report_state(NET_C6_BOOTING, NET_REASON_C6_LINK_LOST, d, now_ms());
}

static void probe_liveness(int64_t now) {
  if (now < s_next_probe_ms) return;
  esp_hosted_coprocessor_fwver_t cp = {0};
  if (esp_hosted_get_coprocessor_fwversion(&cp) == 0) {
    s_probe_failures = 0;
    s_next_probe_ms = now + PROBE_PERIOD_MS;
    return;
  }
  s_probe_failures++;
  s_next_probe_ms = now + PROBE_CONFIRM_MS;
  klog("C6", "liveness probe unanswered (%d)", s_probe_failures);
}

/* Perform one action the machine asked for, and tell it how that went. */
static void perform(rr_action_t act) {
  switch (act) {
    case RR_ACT_TEARDOWN: {
      report_recovery("quiescing the host-side radio state");
      /*
       * Order, found on the bench (KD4-D121BC, 2026-08-30, six images):
       * quiesce first, sending nothing into the dead coprocessor - the first
       * image sent the remote Wi-Fi deinit RPC here and the SDIO write thread
       * then spun on it while eh_host_bus_deinit() waited to join it (one
       * hang, one watchdog panic). Then esp_hosted_deinit(): the transport has
       * to come down and up, because the component's RX/TX byte counters are
       * reset only there and a rebooted slave restarts its own at zero (the
       * in-place re-enumeration tried in between read every frame as ~979 KB).
       * The stale remote stack is deinitialised at WIFI_INIT, over a transport
       * that answers. Deinit itself took 0.1 s, 6.7 s and 108 s on the bench -
       * the component's feature auto-deinit RPCs timing out against the slave
       * that is gone, 5 s each; bounded, and the largest share of a slow
       * recovery.
       */
      net_wifi_suspend();
      /* The transport has to come down and back up: the component's RX/TX
       * byte counters (static to its bus file) are reset only there, and a
       * rebooted slave restarts its own at zero - measured: every frame from
       * the new coprocessor read as ~979 KB until then. No RPC has been sent
       * to the dead slave before this point; net_wifi_suspend() sends none. */
      const int64_t t0 = esp_timer_get_time();
      const int rc = esp_hosted_deinit();
      klog("C6", "recovery: esp_hosted_deinit rc=%d in %lldms", rc,
           (long long)((esp_timer_get_time() - t0) / 1000));
      eh_host_mcu_transport_state_set(EH_HOST_MCU_TRANSPORT_INACTIVE);
      s_loss_event = false;
      s_probe_failures = 0;
      rr_action_done(&s_rr, act, rc == 0 ? 0 : -1, now_ms());
      return;
    }
    case RR_ACT_RESET_C6:
      report_recovery("C6 reset pulse");
      board_c6_hold_reset();
      vTaskDelay(pdMS_TO_TICKS(EN_HOLD_MS));
      board_c6_enable();
      rr_action_done(&s_rr, act, 0, now_ms());
      return;
    case RR_ACT_HOSTED_UP: {
      report_recovery("ESP-Hosted transport init");
      dma_reserve_release();
      int rc = -1;
      if (configure_transport()) {
        const int64_t t0 = esp_timer_get_time();
        rc = esp_hosted_init();
        klog("C6", "recovery: esp_hosted_init rc=%d in %lldms", rc,
             (long long)((esp_timer_get_time() - t0) / 1000));
        if (rc == 0) {
          const int64_t t1 = esp_timer_get_time();
          const int conn = esp_hosted_connect_to_slave();
          klog("C6", "recovery: connect_to_slave rc=%d in %lldms", conn,
               (long long)((esp_timer_get_time() - t1) / 1000));
          /* A connect that timed out is judged by SDIO_WAIT, which reads the
           * transport state the same way probe_transport() does. The fresh
           * read task opens the data path itself. */
        }
      }
      rr_action_done(&s_rr, act, rc == 0 ? 0 : -1, now_ms());
      return;
    }
    case RR_ACT_VERSION_RPC: {
      report_recovery("version gate over the restored transport");
      s_ver_verdict = RR_VER_UNKNOWN;
      const bool ok = version_gate();
      rr_action_done(&s_rr, act, (int)s_ver_verdict, now_ms());
      if (ok) {
        net_link_report_state(NET_C6_LINK_READY, NET_REASON_NONE,
                              "transport recovered, versions agree", now_ms());
      }
      return;
    }
    case RR_ACT_WIFI_INIT: {
      net_wifi_resume();
      const esp_err_t err = net_wifi_start();
      if (err == ESP_OK) {
        net_link_report_state(NET_RADIO_READY, NET_REASON_NONE, "radio up after recovery", now_ms());
        net_link_report_state(NET_WIFI_IDLE, NET_REASON_NONE, NULL, now_ms());
      } else {
        count_error();
        net_link_report_state(NET_ERROR, NET_REASON_RADIO_FAILURE,
                              "the Wi-Fi stack would not initialise on the C6", now_ms());
      }
      rr_action_done(&s_rr, act, err == ESP_OK ? 0 : -1, now_ms());
      return;
    }
    case RR_ACT_WIFI_JOIN: {
      char ssid[NET_SSID_LEN];
      const bool have = wifi_creds_auto_join_target(ssid, sizeof ssid);
      net_time_start(); /* a no-op once the clock is trusted; armed otherwise */
      if (have) net_wifi_auto_join();
      rr_action_done(&s_rr, act, have ? 0 : -1, now_ms());
      return;
    }
    case RR_ACT_RECOVERED: {
      uint64_t rx, tx;
      uint32_t errs;
      net_hosted_counters(&rx, &tx, &errs);
      net_link_report_transport(rx, tx, errs, true);
      net_link_report_recovery();
      s_linked = true;
      s_probe_failures = 0;
      s_next_probe_ms = now_ms() + PROBE_PERIOD_MS;
      const int64_t l = s_rr.t_lost;
      klog("C6", "recovered without a reboot in %lld ms: release +%lld rx +%lld tx +%lld version +%lld assoc +%lld ip +%lld",
           (long long)(s_rr.t_ip - l), (long long)(s_rr.t_release - l), (long long)(s_rr.t_rx - l),
           (long long)(s_rr.t_tx - l), (long long)(s_rr.t_version - l), (long long)(s_rr.t_assoc - l),
           (long long)(s_rr.t_ip - l));
      /* Last: the queue's waiting jobs are due now, with their history. */
      upload_queue_network_restored();
      /* And the next recovery's memory, while the heap is quiet. */
      dma_reserve_take();
      return;
    }
    case RR_ACT_NONE:
    default:
      return;
  }
}

/** One task, and it exits never: bring-up, then the watch, then recovery
 * whenever the watch says the coprocessor went away.
 *
 * Priority 3: above the upload worker (2), below the UI (4) and far below the
 * capture workers (5). The SDIO RX worker ESP-Hosted creates for itself is a
 * separate task at CONFIG_ESP_HOSTED_HOST_DEFLT_TASK_PRIORITY, which is a
 * Gate F question recorded in C6_BRINGUP.md rather than one this file can
 * answer. */
static void supervisor_task(void *arg) {
  (void)arg;
  bring_up();

  {
    net_status_t st;
    net_link_status(&st, now_ms());
    s_linked = st.state >= NET_C6_LINK_READY;
  }
  if (s_linked) dma_reserve_take();
  rr_init(&s_rr);
  s_next_probe_ms = now_ms() + PROBE_PERIOD_MS;
  /* The default loop exists by now (esp_hosted_init created it). */
  (void)esp_event_handler_register(EH_HOST_EVENT, ESP_EVENT_ANY_ID, hosted_event, NULL);

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(rr_active(&s_rr) ? 200 : 1000));
    const int64_t now = now_ms();
    net_status_t st;
    net_link_status(&st, now);

    if (!rr_active(&s_rr)) {
      if (s_rr.state == RR_PARKED) {
        /* Gave up after RR_MAX_ATTEMPTS, said so in NETWORK_STATUS. Only a
         * fresh, explicit event - a transport failure, a bench reset - starts
         * another round; a link that is simply still down does not, or this
         * would be the reset loop that must not ship. */
        if (!s_bench_loss) continue;
        s_bench_loss = false;
        s_loss_event = false;
        klog("C6", "bench reset while parked; recovering again");
        rr_link_lost(&s_rr, now);
        continue;
      }
      if (!s_linked) {
        /* Never came up: C6_ABSENT, NET_ERROR or C6_BAD_FIRMWARE from
         * bring-up. Parked on purpose, as before: re-pulsing a coprocessor
         * that answered with the wrong version, or a bus that did not
         * enumerate, produces a reset loop. A power cycle or a reflash is
         * the fix. */
        continue;
      }
      probe_liveness(now);
      const char *why = NULL;
      if (s_loss_event) why = "transport failure reported";
      else if (!st.sdio_link_up) why = "SDIO link reported down";
      else if (s_probe_failures >= 2) why = "liveness probe unanswered twice";
      if (why == NULL) continue;
      s_loss_event = false;
      count_error();
      klog("C6", "link lost (%s); recovering without a reboot", why);
      rr_link_lost(&s_rr, now);
      report_recovery("link lost");
      continue;
    }

    const rr_obs_t obs = {
        .rx_ready = eh_host_mcu_transport_state_is_rx_ready() != 0,
        .tx_ready = eh_host_mcu_transport_state_is_tx_ready() != 0,
        .associated = st.state >= NET_WIFI_ASSOCIATED,
        .has_ip = st.state == NET_IP_READY,
        .auth_failed = st.state == NET_WIFI_IDLE && st.reason == NET_REASON_AUTH_FAILED,
    };
    const rr_state_t before = s_rr.state;
    const rr_action_t act = rr_step(&s_rr, &obs, s_rr.generation, now);
    if (act != RR_ACT_NONE) perform(act);
    if (s_rr.state != before) {
      klog("C6", "recovery: %s -> %s (%s)", rr_state_name(before), rr_state_name(s_rr.state),
           s_rr.detail);
      if (s_rr.state == RR_PARKED) {
        count_error();
        net_link_report_state(NET_ERROR, NET_REASON_C6_NO_RESPONSE, s_rr.detail, now_ms());
      } else if (s_rr.state == RR_BACKOFF) {
        report_recovery(s_rr.detail);
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

#if KINO_C6_RESET_BENCH
bool net_hosted_bench_c6_reset(void) {
  /* The product's own sequence and timing (bring_up), issued once on
   * request. The link is then reported down through the same calls the
   * supervisor would use; whether and how it comes back is the bench's
   * question, not this function's. */
  klog("C6", "BENCH: C6 reset pulse on GPIO%d, %d ms", BOARD_C6_EN, EN_HOLD_MS);
  const int64_t t_assert = esp_timer_get_time();
  board_c6_hold_reset();
  vTaskDelay(pdMS_TO_TICKS(EN_HOLD_MS));
  board_c6_enable();
  const int64_t t_release = esp_timer_get_time();
  net_link_report_transport(s_rx_bytes, s_tx_bytes, s_errors, false);
  net_link_report_state(NET_C6_BOOTING, NET_REASON_C6_LINK_LOST, "bench: C6 reset pulse",
                        now_ms());
  s_loss_event = true; /* the supervisor recovers from here; see radio_recovery.h */
  s_bench_loss = true;
  klog("C6", "BENCH: released after %lldus; link reported down", (long long)(t_release - t_assert));
  return true;
}
#endif /* KINO_C6_RESET_BENCH */

#endif /* KINO_RADIO */
