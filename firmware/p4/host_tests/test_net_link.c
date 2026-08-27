/*
 * Host tests for firmware/p4/main/net_link.c and the Wi-Fi credential rules
 * in pure.c.
 *
 *   make -C firmware/p4/host_tests test-net    # needs shim/esp_err.h only
 *
 * The C6 transport is not routed on the D4 V1 carrier
 * (firmware/C6_HARDWARE_MAP.md), so nothing here has ever run against a
 * radio. What these tests can still prove is the part that would otherwise be
 * discovered on the bench with a soldering iron in hand: that the firmware
 * reports the difference between "no radio fitted" and "radio fitted, no
 * route to it", that it never claims usable before it has an address, and
 * that the credential rules behave the way the reference device's do.
 */
#include <stdio.h>
#include <string.h>

#include "net_link.h"
#include "pure.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...)                          \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      failures++;                                 \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                        \
      printf("\n");                               \
    }                                             \
  } while (0)

/* ---- the honest initial state ----------------------------------------- */

static void test_v1_reports_fitted_but_not_routed(void) {
  /* The distinction this whole module exists for. A boolean `wifi = false`
   * would report a wiring question as a missing part, and send someone
   * looking for a chip that is already soldered to the module. */
  net_link_init(1000);

  net_status_t st;
  net_link_status(&st, 1000);

  CHECK(st.radio_fitted, "the C6 IS fitted to the Guition carrier");
  CHECK(!st.radio_routed, "and this firmware has no route to it");
  CHECK(st.state == NET_C6_NOT_ROUTED, "state says NOT_ROUTED, got %s",
        net_state_name(st.state));
  CHECK(st.reason == NET_REASON_TRANSPORT_UNKNOWN, "with the routing reason, got %s",
        net_reason_name(st.reason));
  CHECK(st.state != NET_C6_ABSENT, "NOT_ROUTED must never be reported as ABSENT");

  /* The detail must point at the evidence rather than being a shrug. */
  CHECK(strstr(st.detail, "C6_HARDWARE_MAP") != NULL,
        "the detail names where the evidence is: %s", st.detail);

  /* Nothing has been measured, so nothing is claimed. */
  CHECK(st.ssid[0] == '\0', "no SSID is claimed");
  CHECK(st.ip[0] == '\0', "no IP is claimed");
  CHECK(st.rssi == 0, "no RSSI is invented, got %d", st.rssi);
  CHECK(st.c6_version[0] == '\0', "no slave version is invented");
  CHECK(st.transport_errors == 0, "no transport has run, so no errors");
}

static void test_status_before_init_does_not_imply_a_probe(void) {
  /* The UI can render during boot, before net_link_init() has run. It must
   * not be told the radio is absent — nothing has looked yet. */
  net_status_t st;
  net_link_status(&st, 0);
  CHECK(st.state == NET_C6_NOT_ROUTED, "pre-init is NOT_ROUTED on V1, got %s",
        net_state_name(st.state));
  CHECK(st.radio_fitted, "and the chip is still fitted");
}

/* ---- upload gating ---------------------------------------------------- */

static void test_only_ip_ready_permits_upload(void) {
  /* Association is deliberately not enough. A device that reports connected
   * on association produces a queue retrying against a network it never
   * really joined, and a display that says online while nothing resolves. */
  const net_state_t states[] = {
      NET_C6_NOT_ROUTED, NET_C6_ABSENT,     NET_C6_BOOTING,     NET_C6_LINK_READY,
      NET_RADIO_READY,   NET_WIFI_IDLE,     NET_WIFI_SCANNING,  NET_WIFI_CONNECTING,
      NET_WIFI_ASSOCIATED, NET_IP_WAIT,     NET_IP_READY,       NET_ERROR,
  };
  for (size_t i = 0; i < sizeof states / sizeof states[0]; i++) {
    net_status_t st;
    memset(&st, 0, sizeof st);
    st.state = states[i];
    const bool ok = net_link_can_upload(&st);
    if (states[i] == NET_IP_READY) {
      CHECK(ok, "IP_READY permits upload");
    } else {
      CHECK(!ok, "%s must not permit upload", net_state_name(states[i]));
    }
  }
  CHECK(!net_link_can_upload(NULL), "a NULL status never permits upload");
}

static void test_wire_state_does_not_overclaim(void) {
  /* The coarse three-value field Studio's NetworkStatus already uses. The
   * rule that matters: associated-without-an-address is `connecting`. */
  CHECK(strcmp(net_wire_state(NET_IP_READY), "connected") == 0, "IP_READY is connected");
  CHECK(strcmp(net_wire_state(NET_WIFI_ASSOCIATED), "connecting") == 0,
        "ASSOCIATED is connecting, not connected");
  CHECK(strcmp(net_wire_state(NET_IP_WAIT), "connecting") == 0, "IP_WAIT is connecting");
  CHECK(strcmp(net_wire_state(NET_WIFI_CONNECTING), "connecting") == 0, "CONNECTING is connecting");
  CHECK(strcmp(net_wire_state(NET_C6_NOT_ROUTED), "disconnected") == 0,
        "NOT_ROUTED is disconnected");
  CHECK(strcmp(net_wire_state(NET_WIFI_SCANNING), "disconnected") == 0,
        "SCANNING is disconnected — a scan is not a connection");
  CHECK(strcmp(net_wire_state(NET_ERROR), "disconnected") == 0, "ERROR is disconnected");
}

/* ---- operations fail closed ------------------------------------------- */

static void test_operations_fail_closed_with_a_reason(void) {
  net_link_init(0);

  /* Every operation must refuse, and must say why. Refusing silently is how
   * a Studio user concludes the camera is broken rather than unrouted. */
  CHECK(!net_link_scan_start(10), "scan refuses with no transport");
  net_status_t st;
  net_link_status(&st, 10);
  CHECK(st.reason == NET_REASON_TRANSPORT_UNKNOWN, "and says why, got %s",
        net_reason_name(st.reason));

  CHECK(net_link_scan_results(NULL, 0) == 0, "no results, and not a crash");
  net_scan_entry_t entries[4];
  CHECK(net_link_scan_results(entries, 4) == 0, "zero is a real answer");

  CHECK(!net_link_connect("SomeNetwork", 20), "connect refuses with no transport");
  net_link_status(&st, 20);
  CHECK(st.reason == NET_REASON_TRANSPORT_UNKNOWN, "with the routing reason");
  /* And it must NOT record the SSID as one it tried: a status naming a
   * network it never attempted reads as a failed join. */
  CHECK(st.ssid[0] == '\0', "an unattempted network is not recorded, got '%s'", st.ssid);

  CHECK(!net_link_connect(NULL, 30), "a NULL SSID is refused");
  CHECK(!net_link_connect("", 30), "an empty SSID is refused");
  CHECK(!net_link_disconnect(40), "disconnect refuses with no transport");
}

/* ---- naming ----------------------------------------------------------- */

static void test_every_state_and_reason_has_a_name(void) {
  /* These strings reach the RADIO screen and NETWORK_STATUS. An "UNKNOWN"
   * on the display is a defect, so every enumerator is checked. */
  for (int s = NET_C6_NOT_ROUTED; s <= NET_ERROR; s++) {
    const char *n = net_state_name((net_state_t)s);
    CHECK(n != NULL && n[0] != '\0', "state %d has a name", s);
    CHECK(strcmp(n, "UNKNOWN") != 0, "state %d is named, not UNKNOWN", s);
  }
  for (int r = NET_REASON_NONE; r <= NET_REASON_NO_CREDENTIALS; r++) {
    const char *n = net_reason_name((net_reason_t)r);
    CHECK(n != NULL && n[0] != '\0', "reason %d has a name", r);
    CHECK(strcmp(n, "UNKNOWN") != 0, "reason %d is named, not UNKNOWN", r);
  }
}

static void test_security_parsing_is_safe_by_default(void) {
  CHECK(net_security_parse("open") == NET_SEC_OPEN, "open parses");
  CHECK(net_security_parse("wpa2") == NET_SEC_WPA2, "wpa2 parses");
  CHECK(net_security_parse("wpa3") == NET_SEC_WPA3, "wpa3 parses");

  /* The important cases. Defaulting an unrecognised mode to `open` would
   * attempt an unencrypted join against a network we failed to parse. */
  CHECK(net_security_parse(NULL) == NET_SEC_WPA2, "NULL defaults to WPA2, not open");
  CHECK(net_security_parse("") == NET_SEC_WPA2, "empty defaults to WPA2");
  CHECK(net_security_parse("wpa4-future") == NET_SEC_WPA2, "an unknown mode defaults to WPA2");
  CHECK(net_security_parse("WPA2") == NET_SEC_WPA2, "unexpected case defaults to WPA2");
  CHECK(net_security_parse("OPEN") != NET_SEC_OPEN,
        "case-mismatched 'OPEN' must NOT be taken as open");

  /* Round trip, so a saved value reads back as itself. */
  CHECK(net_security_parse(net_security_name(NET_SEC_OPEN)) == NET_SEC_OPEN, "open round-trips");
  CHECK(net_security_parse(net_security_name(NET_SEC_WPA2)) == NET_SEC_WPA2, "wpa2 round-trips");
  CHECK(net_security_parse(net_security_name(NET_SEC_WPA3)) == NET_SEC_WPA3, "wpa3 round-trips");
}

/* ---- credential rules ------------------------------------------------- */

static void test_ssid_validation(void) {
  CHECK(pure_wifi_ssid_valid("Home"), "an ordinary SSID is valid");
  CHECK(pure_wifi_ssid_valid("a"), "one character is valid");

  char max[PURE_SSID_MAX + 1];
  memset(max, 'x', PURE_SSID_MAX);
  max[PURE_SSID_MAX] = '\0';
  CHECK(pure_wifi_ssid_valid(max), "32 octets is valid");

  char over[PURE_SSID_MAX + 2];
  memset(over, 'x', PURE_SSID_MAX + 1);
  over[PURE_SSID_MAX + 1] = '\0';
  CHECK(!pure_wifi_ssid_valid(over), "33 octets is not");

  CHECK(!pure_wifi_ssid_valid(""), "empty is not valid");
  CHECK(!pure_wifi_ssid_valid(NULL), "NULL is not valid");

  /* Control characters are rejected rather than stripped: this value is
   * matched byte-for-byte against a scan result and used as part of an NVS
   * record, so rewriting it saves a network that can never match. */
  CHECK(!pure_wifi_ssid_valid("bad\nname"), "a newline is rejected");
  CHECK(!pure_wifi_ssid_valid("bad\tname"), "a tab is rejected");
  CHECK(!pure_wifi_ssid_valid("\x7f"), "DEL is rejected");

  /* But high bytes are fine — APs really are named in UTF-8, and the
   * camera's job is to join them. */
  CHECK(pure_wifi_ssid_valid("Caf\xc3\xa9"), "UTF-8 is accepted");
  CHECK(pure_wifi_ssid_valid("\xf0\x9f\x93\xb7"), "an emoji SSID is accepted");
  CHECK(pure_wifi_ssid_valid("net work"), "a space is fine");
}

static void test_passphrase_rules_match_the_reference_device(void) {
  /* WPA's own floor and ceiling. */
  CHECK(pure_wifi_passphrase_ok("12345678", false, false), "8 characters is the WPA minimum");
  CHECK(!pure_wifi_passphrase_ok("1234567", false, false), "7 is refused");
  CHECK(pure_wifi_passphrase_ok("hunter2hunter2", false, false), "an ordinary passphrase is fine");

  char max[PURE_WPA_PASSPHRASE_MAX + 1];
  memset(max, 'p', PURE_WPA_PASSPHRASE_MAX);
  max[PURE_WPA_PASSPHRASE_MAX] = '\0';
  CHECK(pure_wifi_passphrase_ok(max, false, false), "63 characters is the maximum");

  char over[PURE_WPA_PASSPHRASE_MAX + 2];
  memset(over, 'p', PURE_WPA_PASSPHRASE_MAX + 1);
  over[PURE_WPA_PASSPHRASE_MAX + 1] = '\0';
  CHECK(!pure_wifi_passphrase_ok(over, false, false), "64 is refused");

  /* THE case that an obvious implementation gets wrong. NETWORK_LIST only
   * ever hands the host a mask, so a host toggling autoJoin on a saved
   * network has nothing to put in `password`. Checking the length rule first
   * makes this path unreachable and editing impossible. */
  CHECK(pure_wifi_passphrase_ok("", false, true), "empty + stored means keep the stored one");
  CHECK(pure_wifi_passphrase_ok(NULL, false, true), "absent + stored means keep");
  CHECK(!pure_wifi_passphrase_ok("", false, false),
        "empty with nothing stored is refused — that would save an unusable network");
  CHECK(!pure_wifi_passphrase_ok(NULL, false, false), "absent with nothing stored is refused");

  /* An open network takes no passphrase. Storing one it will never present
   * would read on the display as a protected network. */
  CHECK(pure_wifi_passphrase_ok("", true, false), "open + empty is fine");
  CHECK(pure_wifi_passphrase_ok(NULL, true, false), "open + absent is fine");
  CHECK(!pure_wifi_passphrase_ok("12345678", true, false), "open + a passphrase is refused");
  CHECK(!pure_wifi_passphrase_ok("12345678", true, true), "still refused when one is stored");
}

int main(void) {
  /* Pre-init first, while it genuinely is pre-init: net_link_init() latches
   * `initialised`, so running this after the next test would not exercise
   * the path it names. */
  test_status_before_init_does_not_imply_a_probe();
  test_v1_reports_fitted_but_not_routed();
  test_only_ip_ready_permits_upload();
  test_wire_state_does_not_overclaim();
  test_operations_fail_closed_with_a_reason();
  test_every_state_and_reason_has_a_name();
  test_security_parsing_is_safe_by_default();
  test_ssid_validation();
  test_passphrase_rules_match_the_reference_device();

  if (failures > 0) {
    printf("p4 net-link tests: %d/%d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 net-link tests: %d checks passed\n", checks);
  return 0;
}
