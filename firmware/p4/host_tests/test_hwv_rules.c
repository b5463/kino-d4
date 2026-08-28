/*
 * Host tests for firmware/p4/main/hwv_rules.c — when a hardware-validation
 * row may be marked.
 *
 *   make -C firmware/p4/host_tests test-hwv    # no dependencies at all
 *
 * These exist because of a specific near-miss. The C6 rows were wired to be
 * marked after esp_hosted_init() returned 0, on the reasoning that a
 * successful init meant the bus had come up. It does not: the pinned
 * esp_hosted 3.0.6 logs a failed SDIO card init and falls through without
 * propagating an error. On KD4-D121BC init returned 0 with rx_ready 0 —
 * nothing had ever answered on the bus. Had that wiring shipped, the registry
 * would have recorded C6_SDIO_PINS as VALIDATED on a board whose radio has
 * never enumerated, and every later reader would have believed it.
 *
 * So the tests below are mostly negative. A predicate that returns true for a
 * real success is easy and not where the risk is; the risk is the states that
 * look enough like success to be marked. Each one here is a state the bench
 * can actually be in.
 */
#include <stdio.h>
#include <string.h>

#include "hwv_rules.h"

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

/* The exact state measured on KD4-D121BC, 2026-08-28. */
static void test_the_board_we_have_does_not_mark_the_transport(void) {
  CHECK(!hwv_rule_sdio_link(0), "rx_ready 0 must never mark the SDIO row");
  CHECK(!hwv_rule_transport_usable(0, 0), "neither direction ready is not a usable transport");
  CHECK(!hwv_rule_transport_usable(1, 0), "RX without TX is enumeration, not a handshake");
  CHECK(!hwv_rule_transport_usable(0, 1), "TX without RX is not a transport either");

  CHECK(hwv_rule_sdio_link(1), "a real enumeration must mark");
  CHECK(hwv_rule_transport_usable(1, 1), "both directions ready is a usable transport");
}

static void test_version_gate_cannot_be_marked_by_silence(void) {
  /* The failure this board actually produces: no answer at all. */
  CHECK(!hwv_rule_slave_version(false, 0, 0, 3, 0), "an unanswered version RPC must not mark");
  CHECK(!hwv_rule_slave_version(false, 3, 0, 3, 0),
        "zeroed-out version fields must not mark even if they happen to match");

  /* A coprocessor too old to serve this host. */
  CHECK(!hwv_rule_slave_version(true, 2, 9, 3, 0), "a major mismatch must not mark");
  CHECK(!hwv_rule_slave_version(true, 3, 0, 3, 6), "a minor behind the host must not mark");

  CHECK(hwv_rule_slave_version(true, 3, 6, 3, 6), "an exact match marks");
  CHECK(hwv_rule_slave_version(true, 3, 7, 3, 6), "a newer coprocessor still serves this host");
}

static void test_a_scan_that_saw_nothing_is_not_a_scan(void) {
  CHECK(!hwv_rule_wifi_scan(true, 0),
        "a completed scan with zero networks is indistinguishable from no antenna");
  CHECK(!hwv_rule_wifi_scan(false, 5), "a failed scan must not mark whatever it left behind");
  CHECK(hwv_rule_wifi_scan(true, 1), "one real network is enough");
}

static void test_association_needs_a_network(void) {
  CHECK(!hwv_rule_wifi_associate(false, "kino-test"), "not associated must not mark");
  CHECK(!hwv_rule_wifi_associate(true, ""), "an empty SSID is an event without its association");
  CHECK(!hwv_rule_wifi_associate(true, NULL), "a null SSID must not mark or crash");
  CHECK(hwv_rule_wifi_associate(true, "kino-test"), "a named association marks");
}

/*
 * The one most likely to be got wrong, because the device really does have an
 * address in every one of these states.
 */
static void test_link_local_is_dhcp_failing_not_dhcp_working(void) {
  CHECK(!hwv_rule_dhcp(0u), "no address at all");
  CHECK(!hwv_rule_dhcp(0xA9FE0164u), "169.254.1.100 is self-assigned: DHCP FAILED");
  CHECK(!hwv_rule_dhcp(0xA9FEFFFFu), "the whole 169.254/16 block is link-local");
  CHECK(!hwv_rule_dhcp(0x7F000001u), "127.0.0.1 is not a lease");
  CHECK(!hwv_rule_dhcp(0xE0000001u), "multicast is not a lease");

  CHECK(hwv_rule_dhcp(0xC0A80164u), "192.168.1.100 is a real lease");
  CHECK(hwv_rule_dhcp(0x0A000005u), "10.0.0.5 is a real lease");
}

static void test_dns_and_time_and_tls(void) {
  CHECK(!hwv_rule_dns(true, 0u), "a lookup that resolved to nothing has not resolved");
  CHECK(!hwv_rule_dns(false, 0xC0A80164u), "a failed lookup must not mark");
  CHECK(hwv_rule_dns(true, 0xC0A80164u), "a real resolution marks");

  CHECK(!hwv_rule_sntp(true, 0), "an accepted sync carrying epoch zero is an unset clock");
  CHECK(!hwv_rule_sntp(true, 946684800000LL), "the year 2000 is before this camera existed");
  CHECK(!hwv_rule_sntp(false, 1787950000000LL), "a refused sync must not mark");
  CHECK(hwv_rule_sntp(true, 1787950000000LL), "a plausible accepted epoch marks");

  /* The row exists to record a VERIFIED chain. A 200 proves the exchange
   * finished, not that anyone checked who answered. */
  CHECK(!hwv_rule_tls(false, 200), "a 200 over an unverified chain must never mark TLS");
  CHECK(!hwv_rule_tls(true, 0), "a verified connection that returned nothing is not an exchange");
  CHECK(!hwv_rule_tls(true, 500), "a server error is not a successful exchange");
  CHECK(hwv_rule_tls(true, 200), "verified plus a real response marks");
}

static void test_roll_rows(void) {
  CHECK(!hwv_rule_roll_register(200, ""), "a 200 without an identity is not a registration");
  CHECK(!hwv_rule_roll_register(200, NULL), "a null identity must not mark or crash");
  CHECK(!hwv_rule_roll_register(401, "kino-d121bc"), "a refusal must not mark");
  CHECK(hwv_rule_roll_register(201, "kino-d121bc"), "created with an identity marks");

  CHECK(!hwv_rule_roll_upload(200, false),
        "accepted is not confirmed: the queue retries on exactly this difference");
  CHECK(!hwv_rule_roll_upload(500, true), "a server error must not mark");
  CHECK(hwv_rule_roll_upload(201, true), "confirmed media marks");

  CHECK(!hwv_rule_roll_reconnect(false, true),
        "a link that never dropped has not proven recovery");
  CHECK(!hwv_rule_roll_reconnect(true, false), "still down is not recovered");
  CHECK(hwv_rule_roll_reconnect(true, true), "down then ready is a recovery");
}

static void test_http_ok_boundaries(void) {
  CHECK(!hwv_rule_http_ok(199), "199 is not success");
  CHECK(hwv_rule_http_ok(200), "200 is success");
  CHECK(hwv_rule_http_ok(299), "299 is success");
  CHECK(!hwv_rule_http_ok(300), "300 is a redirect, not success");
  CHECK(!hwv_rule_http_ok(0), "no status at all is not success");
  CHECK(!hwv_rule_http_ok(-1), "a transport error is not success");
}

int main(void) {
  test_the_board_we_have_does_not_mark_the_transport();
  test_version_gate_cannot_be_marked_by_silence();
  test_a_scan_that_saw_nothing_is_not_a_scan();
  test_association_needs_a_network();
  test_link_local_is_dhcp_failing_not_dhcp_working();
  test_dns_and_time_and_tls();
  test_roll_rows();
  test_http_ok_boundaries();

  if (failures > 0) {
    printf("p4 hwv-rule tests: %d/%d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 hwv-rule tests: %d checks passed\n", checks);
  return 0;
}
