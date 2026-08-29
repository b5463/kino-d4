/*
 * Host tests for the radio seam in firmware/p4/main/net_link.c.
 *
 *   make -C firmware/p4/host_tests test-report
 *
 * A separate file from test_net_link.c on purpose. That suite asserts what the
 * camera reports with NO radio in the build, and it must keep asserting exactly
 * that, unchanged, because that is what ships. This one registers a stub driver
 * and drives the state machine the radio build actually uses — the part that
 * would otherwise first run on a board, with a soldering iron nearby.
 *
 * net_hosted.c is not tested here and cannot be: it is esp_hosted and esp_wifi
 * calls. What IS tested is everything those calls report INTO, which is where
 * the decisions live.
 */
#include <stdio.h>
#include <string.h>

#include "net_link.h"

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

/* ---- a stub radio ------------------------------------------------------ */

static int scan_calls;
static int connect_calls;
static int disconnect_calls;
static char last_ssid[NET_SSID_LEN];
static bool refuse;

static bool stub_scan(void) {
  scan_calls++;
  return !refuse;
}

static bool stub_connect(const char *ssid) {
  connect_calls++;
  snprintf(last_ssid, sizeof last_ssid, "%s", ssid);
  return !refuse;
}

static bool stub_disconnect(void) {
  disconnect_calls++;
  return true;
}

static const net_link_driver_t stub = {
    .scan_start = stub_scan,
    .connect = stub_connect,
    .disconnect = stub_disconnect,
};

static net_status_t status_now(int64_t t) {
  net_status_t st;
  net_link_status(&st, t);
  return st;
}

/* ---- registering a driver is what "routed" means ----------------------- */

static void test_the_driver_is_the_gate(void) {
  net_link_init(1000);
  net_status_t st = status_now(1000);
  CHECK(!st.radio_routed, "no driver, no route");
  CHECK(st.state == NET_C6_NOT_ROUTED, "and NOT_ROUTED, got %s", net_state_name(st.state));

  net_link_set_driver(&stub, 2000);
  st = status_now(2000);
  CHECK(st.radio_routed, "a registered driver is a route");
  CHECK(st.state == NET_C6_BOOTING, "BOOTING once a pin can move, got %s",
        net_state_name(st.state));
  CHECK(st.reason == NET_REASON_NONE, "and the routing reason is cleared, got %s",
        net_reason_name(st.reason));
  CHECK(strstr(st.detail, "C6_HARDWARE_MAP") == NULL,
        "the no-transport detail is gone too: %s", st.detail);

  /* Withdrawing goes back to the honest answer rather than to an error. */
  net_link_set_driver(NULL, 3000);
  st = status_now(3000);
  CHECK(!st.radio_routed, "withdrawn is not routed");
  CHECK(st.state == NET_C6_NOT_ROUTED, "and NOT_ROUTED again, got %s",
        net_state_name(st.state));
}

/* ---- init is not enumeration ------------------------------------------ */

/*
 * The distinction that cost this project its first C6 bring-up. esp_hosted_init()
 * returning 0 means the host-side library came up; it says nothing about a
 * coprocessor, and on KD4-D121BC it returned 0 with nothing on the bus. The
 * transport report carries the real evidence, and the state machine must not
 * advance past BOOTING on anything less.
 */
static void test_library_up_is_not_slave_connected(void) {
  net_link_init(1000);
  net_link_set_driver(&stub, 1000);

  /* Host library initialised, bus never enumerated: what a missing
   * connect_to_slave() looks like from here. */
  net_link_report_transport(0, 0, 0, false);
  net_status_t st = status_now(2000);
  CHECK(!st.sdio_link_up, "no enumeration, no link");
  CHECK(st.state != NET_C6_LINK_READY, "and never LINK_READY, got %s",
        net_state_name(st.state));

  /* Enumerated: the bus is up. Still not LINK_READY - that needs the version
   * gate, which is a separate report. */
  net_link_report_transport(512, 64, 0, true);
  st = status_now(3000);
  CHECK(st.sdio_link_up, "an enumerated bus is a link");
  CHECK(st.state != NET_C6_LINK_READY,
        "but enumeration alone is not LINK_READY, got %s", net_state_name(st.state));

  /* Only the explicit state report, made after the version gate passes,
   * says LINK_READY. */
  net_link_report_state(NET_C6_LINK_READY, NET_REASON_NONE, "versions agree", 4000);
  st = status_now(4000);
  CHECK(st.state == NET_C6_LINK_READY, "the gate's report is what advances, got %s",
        net_state_name(st.state));
}

/* ---- the version gate ------------------------------------------------- */

static void test_versions_survive_a_refusal(void) {
  net_link_init(0);
  net_link_set_driver(&stub, 0);

  /* Recorded BEFORE the compatibility decision, which is the point: a refused
   * link has to say what it refused, or the bench cannot tell a stale
   * coprocessor image from a dead one. */
  net_link_report_versions("2.12.6", "2.9.0", "rpc-v2");
  net_link_report_state(NET_C6_BOOTING, NET_REASON_C6_BAD_FIRMWARE,
                        "C6 image 2.9.0 cannot serve host 2.12.6; reflash the C6", 100);

  net_status_t st = status_now(100);
  CHECK(strcmp(st.host_version, "2.12.6") == 0, "host version kept, got '%s'",
        st.host_version);
  CHECK(strcmp(st.c6_version, "2.9.0") == 0, "C6 version kept, got '%s'", st.c6_version);
  CHECK(strcmp(st.protocol_version, "rpc-v2") == 0, "protocol version kept, got '%s'",
        st.protocol_version);
  CHECK(st.c6_present, "something answered, so the chip is present");
  CHECK(st.reason == NET_REASON_C6_BAD_FIRMWARE, "and the reason names the firmware, got %s",
        net_reason_name(st.reason));

  /* A refused version must not read as usable, and must not read as absent. */
  CHECK(!net_link_can_upload(&st), "a bad-firmware link may not upload");
  CHECK(st.state != NET_C6_ABSENT, "a stale image is not a missing chip");
  CHECK(strcmp(net_wire_state(st.state), "disconnected") == 0, "and the wire says disconnected");
}

/* ---- LINK_READY is not connected -------------------------------------- */

static void test_link_ready_is_not_connected(void) {
  net_link_init(0);
  net_link_set_driver(&stub, 0);
  net_link_report_state(NET_C6_LINK_READY, NET_REASON_NONE, "transport up", 10);

  net_status_t st = status_now(10);
  CHECK(st.c6_present, "the transport answered");
  CHECK(!net_link_can_upload(&st), "C6_LINK_READY is not permission to upload");
  CHECK(strcmp(net_wire_state(st.state), "disconnected") == 0,
        "and it is not `connected` on the wire");

  /* Nor is association. This is the defect the whole state set exists for. */
  net_link_report_state(NET_RADIO_READY, NET_REASON_NONE, NULL, 20);
  net_link_report_association("Kaffeehaus", "aa:bb:cc:dd:ee:ff", -55, 6);
  net_link_report_state(NET_WIFI_ASSOCIATED, NET_REASON_NONE, NULL, 30);
  st = status_now(30);
  CHECK(!net_link_can_upload(&st), "WIFI_ASSOCIATED is not permission to upload");
  CHECK(strcmp(net_wire_state(st.state), "connecting") == 0, "association is `connecting`");
  CHECK(st.rssi == -55, "RSSI is reported, got %d", st.rssi);
  CHECK(st.channel == 6, "channel is reported, got %d", st.channel);
  CHECK(strcmp(st.ssid, "Kaffeehaus") == 0, "SSID is reported, got '%s'", st.ssid);

  /* Only an address is. */
  net_link_report_ip("192.168.1.42", 40);
  st = status_now(40);
  CHECK(st.state == NET_IP_READY, "an address means IP_READY, got %s",
        net_state_name(st.state));
  CHECK(net_link_can_upload(&st), "and IP_READY is the one state that may upload");
  CHECK(strcmp(st.ip, "192.168.1.42") == 0, "the address is reported, got '%s'", st.ip);
}

/* ---- falling back must not leave a stale address ---------------------- */

static void test_a_drop_clears_what_is_no_longer_true(void) {
  net_link_init(0);
  net_link_set_driver(&stub, 0);
  net_link_report_state(NET_RADIO_READY, NET_REASON_NONE, NULL, 0);
  net_link_report_association("Kaffeehaus", "aa:bb:cc:dd:ee:ff", -55, 6);
  net_link_report_ip("192.168.1.42", 10);

  /* The access point was switched off. A status that still named an address
   * would keep the upload queue retrying against a network the camera left. */
  net_link_report_state(NET_WIFI_IDLE, NET_REASON_ASSOC_FAILED, "disconnected", 20);
  net_status_t st = status_now(20);
  CHECK(st.ip[0] == '\0', "the address is gone, got '%s'", st.ip);
  CHECK(st.rssi == 0, "and the signal level with it, got %d", st.rssi);
  CHECK(st.channel == 0, "and the channel, got %d", st.channel);
  CHECK(!net_link_can_upload(&st), "and uploading is not permitted");

  /* IP_WAIT is above ASSOCIATED, so a lost lease keeps the association facts:
   * the camera is still on that network, it just has no address. */
  net_link_report_association("Kaffeehaus", "aa:bb:cc:dd:ee:ff", -55, 6);
  net_link_report_ip("192.168.1.42", 30);
  net_link_report_state(NET_IP_WAIT, NET_REASON_DHCP_TIMEOUT, "the lease expired", 40);
  st = status_now(40);
  CHECK(st.rssi == -55, "a lost lease is not a lost association, got %d", st.rssi);
  CHECK(!net_link_can_upload(&st), "but it is not usable either");
}

/* ---- scan results ------------------------------------------------------ */

static void test_scan_results_round_trip(void) {
  net_link_init(0);
  net_link_set_driver(&stub, 0);
  net_link_report_state(NET_RADIO_READY, NET_REASON_NONE, NULL, 0);

  scan_calls = 0;
  refuse = false;
  CHECK(net_link_scan_start(10), "a ready radio accepts a scan");
  CHECK(scan_calls == 1, "and the driver was asked exactly once, got %d", scan_calls);
  CHECK(status_now(10).state == NET_WIFI_SCANNING, "state says scanning");

  net_scan_entry_t found[3];
  memset(found, 0, sizeof found);
  snprintf(found[0].ssid, sizeof found[0].ssid, "Kaffeehaus");
  found[0].rssi = -42;
  found[0].channel = 1;
  found[0].security = NET_SEC_WPA3;
  found[1].hidden = true; /* empty SSID, on purpose */
  found[1].rssi = -80;
  snprintf(found[2].ssid, sizeof found[2].ssid, "Guest");
  found[2].rssi = -60;
  found[2].security = NET_SEC_OPEN;
  net_link_report_scan(found, 3);

  net_scan_entry_t out[NET_SCAN_MAX];
  size_t n = net_link_scan_results(out, NET_SCAN_MAX);
  CHECK(n == 3, "three networks came back, got %zu", n);
  CHECK(strcmp(out[0].ssid, "Kaffeehaus") == 0, "first is named, got '%s'", out[0].ssid);
  CHECK(out[0].security == NET_SEC_WPA3, "WPA3 survives the copy");
  CHECK(out[1].hidden, "the hidden one is still hidden");
  CHECK(out[1].ssid[0] == '\0', "and still has no name");
  CHECK(out[2].security == NET_SEC_OPEN, "and open is still open");

  /* A caller with room for one gets one, not a buffer overrun. */
  n = net_link_scan_results(out, 1);
  CHECK(n == 1, "a caller with room for one gets one, got %zu", n);

  /* More than the cap is truncated rather than refused: a truncated list is
   * usable and an empty one is not. */
  net_scan_entry_t many[NET_SCAN_MAX + 5];
  memset(many, 0, sizeof many);
  for (size_t i = 0; i < NET_SCAN_MAX + 5; i++) snprintf(many[i].ssid, 8, "ap%zu", i);
  net_link_report_scan(many, NET_SCAN_MAX + 5);
  n = net_link_scan_results(out, NET_SCAN_MAX);
  CHECK(n == NET_SCAN_MAX, "truncated to the cap, got %zu", n);

  /* An empty scan is an answer, not an error — a shielded room really does
   * scan to nothing. */
  net_link_report_scan(NULL, 0);
  CHECK(net_link_scan_results(out, NET_SCAN_MAX) == 0, "an empty scan reports zero");
}

/* ---- operations refuse before the radio is ready ---------------------- */

static void test_operations_still_fail_closed(void) {
  net_link_init(0);
  net_link_set_driver(&stub, 0);
  scan_calls = connect_calls = 0;

  /* BOOTING is below RADIO_READY. The driver must not even be asked: a scan
   * issued at a coprocessor that has not finished its handshake is how a
   * transport gets blamed for a Wi-Fi problem. */
  CHECK(!net_link_scan_start(10), "no scan before the radio is up");
  CHECK(scan_calls == 0, "and the driver was not asked, got %d", scan_calls);
  CHECK(!net_link_connect("Kaffeehaus", 10), "no join before the radio is up");
  CHECK(connect_calls == 0, "and the driver was not asked, got %d", connect_calls);
  CHECK(status_now(10).reason == NET_REASON_RADIO_FAILURE, "with a reason, got %s",
        net_reason_name(status_now(10).reason));

  /* A radio that is up but refuses is a different answer, and it must not
   * leave the state claiming a scan or a join is running. */
  net_link_report_state(NET_RADIO_READY, NET_REASON_NONE, NULL, 20);
  refuse = true;
  CHECK(!net_link_scan_start(30), "a refused scan is a failure");
  CHECK(scan_calls == 1, "the driver WAS asked this time, got %d", scan_calls);
  CHECK(status_now(30).state != NET_WIFI_SCANNING, "and the state does not claim scanning");
  CHECK(!net_link_connect("Kaffeehaus", 30), "a refused join is a failure");
  CHECK(status_now(30).state != NET_WIFI_CONNECTING, "and the state does not claim connecting");
  CHECK(status_now(30).ssid[0] == '\0', "nor does it name a network it never attempted");

  /* An accepted join records the SSID and nothing else — never a passphrase,
   * which this interface cannot carry. */
  refuse = false;
  CHECK(net_link_connect("Kaffeehaus", 40), "an accepted join succeeds");
  CHECK(strcmp(last_ssid, "Kaffeehaus") == 0, "the driver got the SSID, got '%s'", last_ssid);
  CHECK(status_now(40).state == NET_WIFI_CONNECTING, "and the state says connecting");

  disconnect_calls = 0;
  CHECK(net_link_disconnect(50), "disconnect is accepted");
  CHECK(disconnect_calls == 1, "and reaches the driver, got %d", disconnect_calls);
  CHECK(status_now(50).state == NET_WIFI_IDLE, "leaving the radio idle");
}

/* ---- diagnostics ------------------------------------------------------ */

static void test_transport_counters(void) {
  net_link_init(0);
  net_link_set_driver(&stub, 0);

  net_status_t st = status_now(0);
  CHECK(st.c6_resets == 1 || st.c6_resets == 0, "resets start at zero until one happens");

  net_link_report_reset();
  net_link_report_reset();
  net_link_report_transport(4096, 8192, 3, true);
  net_link_report_reconnect();

  st = status_now(0);
  CHECK(st.c6_resets == 2, "two resets counted, got %u", (unsigned)st.c6_resets);
  CHECK(st.reconnects == 1, "one reconnect counted, got %u", (unsigned)st.reconnects);
  CHECK(st.transport_rx_bytes == 4096, "rx bytes reported, got %llu",
        (unsigned long long)st.transport_rx_bytes);
  CHECK(st.transport_tx_bytes == 8192, "tx bytes reported, got %llu",
        (unsigned long long)st.transport_tx_bytes);
  CHECK(st.transport_errors == 3, "errors reported, got %u", (unsigned)st.transport_errors);
  CHECK(st.sdio_link_up, "and the link is up");

  /* A reset takes the link down whatever was reported before it: the two must
   * not disagree, because "link up, chip in reset" is not a state. */
  net_link_report_reset();
  CHECK(!status_now(0).sdio_link_up, "a reset takes the link down");
}

/* ---- the clock reason ------------------------------------------------- */

static void test_clock_reason_does_not_claim_disconnected(void) {
  net_link_init(0);
  net_link_set_driver(&stub, 0);
  net_link_report_state(NET_RADIO_READY, NET_REASON_NONE, NULL, 0);
  net_link_report_association("Kaffeehaus", "aa:bb:cc:dd:ee:ff", -55, 6);
  net_link_report_ip("192.168.1.42", 10);

  /* No trustworthy clock, so TLS is held. The network really is up, and saying
   * otherwise would send someone to look at the router. */
  net_link_report_state(NET_IP_READY, NET_REASON_CLOCK_UNTRUSTED, "waiting for a clock", 20);
  net_status_t st = status_now(20);
  CHECK(st.state == NET_IP_READY, "the network is up, got %s", net_state_name(st.state));
  CHECK(strcmp(net_wire_state(st.state), "connected") == 0, "and the wire says connected");
  CHECK(st.reason == NET_REASON_CLOCK_UNTRUSTED, "with the clock as the reason, got %s",
        net_reason_name(st.reason));
  CHECK(strcmp(net_reason_name(NET_REASON_CLOCK_UNTRUSTED), "CLOCK_UNTRUSTED") == 0,
        "and the reason has a stable name");
  CHECK(strcmp(net_reason_name(NET_REASON_CLOCK_UNTRUSTED), "UNKNOWN") != 0,
        "which is not UNKNOWN");
}

int main(void) {
  test_the_driver_is_the_gate();
  test_library_up_is_not_slave_connected();
  test_versions_survive_a_refusal();
  test_link_ready_is_not_connected();
  test_a_drop_clears_what_is_no_longer_true();
  test_scan_results_round_trip();
  test_operations_still_fail_closed();
  test_transport_counters();
  test_clock_reason_does_not_claim_disconnected();

  if (failures > 0) {
    printf("p4 net-report tests: %d/%d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 net-report tests: %d checks passed\n", checks);
  return 0;
}
