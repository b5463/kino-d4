#pragma once

/*
 * When a hardware-validation row may be marked.
 *
 * Every one of these is the condition for turning UNVALIDATED into VALIDATED
 * on a physical unit, and a row marked wrongly is worse than a row left blank:
 * the registry is the thing the project consults to answer "has this ever
 * actually worked", and a false VALIDATED is indistinguishable from a true one
 * six weeks later.
 *
 * They live here, apart from the code that calls them, for one reason: this
 * file reaches nothing from ESP-IDF, so the conditions can be exercised on a
 * host with the false states deliberately fed in. That is what
 * host_tests/test_hwv_rules.c does. Putting the same logic inline at the call
 * sites would leave it provable only by having the hardware fail in exactly
 * the right way, which is not a test anyone can run.
 *
 * The rule these encode: prove the thing itself, not a step near it. An
 * association is not an address. An address is not necessarily a lease. A
 * 200 is not a verified certificate. Each predicate takes the evidence that
 * separates those.
 *
 * Deliberately absent: any rule for HWV_C6_EN_GPIO54. That row is the C6's
 * enable line behaving as an enable line, and firmware driving a level proves
 * only that firmware drove a level - the pin may not be connected to the C6 at
 * all. It is earned by an operator with a meter on JP1 pin 26 and recorded by
 * hand in HARDWARE_VALIDATION.md. There is no self-test that can honestly
 * earn it, so there is no function here that could be miswired to try.
 */

#include <stdbool.h>
#include <stdint.h>

/* ---- transport ---- */

/*
 * The SDIO bus carried a real transaction.
 *
 * rx_ready comes from eh_host_mcu_transport_state_is_rx_ready(), which
 * esp_hosted sets from exactly one place: a successful sdmmc_card_init().
 * That is ESP-IDF's own enumeration and cannot succeed without a device
 * answering on the bus.
 *
 * NOT esp_hosted_init()'s return value. Measured on the pinned 3.0.6 source:
 * a failed card init logs and falls through without propagating an error, so
 * init returns 0 with nothing on the bus. On KD4-D121BC that is exactly what
 * happened - init returned 0, rx_ready was 0.
 */
bool hwv_rule_sdio_link(int rx_ready);

/* Both directions usable, which is what a handshake needs. RX alone means the
 * card enumerated; it does not mean the host can send to it. */
bool hwv_rule_transport_usable(int rx_ready, int tx_ready);

/*
 * The coprocessor answered the version RPC AND its version can serve this
 * host. Same comparison the version gate makes: major must match exactly, and
 * the coprocessor's minor may not be behind the host's.
 */
bool hwv_rule_slave_version(bool rpc_ok, uint32_t cp_major, uint32_t cp_minor, uint32_t host_major,
                            uint32_t host_minor);

/* ---- radio ---- */

/* A scan that completed and saw something. A scan returning zero networks is
 * indistinguishable from an antenna that is not connected. */
bool hwv_rule_wifi_scan(bool scan_ok, unsigned ap_count);

/* Associated to a named network. An empty SSID means the event arrived without
 * the association it claims to describe. */
bool hwv_rule_wifi_associate(bool associated, const char *ssid);

/*
 * A DHCP lease, not merely an address.
 *
 * 169.254.0.0/16 is what a host assigns itself when DHCP fails. Marking the
 * DHCP row on one would record the precise failure it exists to catch as a
 * success. 127.0.0.0/8 and 0.0.0.0 are equally not leases.
 *
 * ip is host byte order.
 */
bool hwv_rule_dhcp(uint32_t ip);

/* A name resolved to a usable address. */
bool hwv_rule_dns(bool ok, uint32_t resolved_ip);

/*
 * Network time the clock policy accepted, and that is plausibly a real epoch.
 *
 * The lower bound is deliberate: an SNTP server that answers with zero, or a
 * device that adopts its own unset clock, both produce an "accepted" sync
 * carrying a time no camera should believe. TLS is checked against this, so a
 * wrong-but-accepted clock fails certificates or, worse, passes them for the
 * wrong reason.
 */
bool hwv_rule_sntp(bool accepted, int64_t epoch_ms);

/*
 * A certificate-verified HTTPS exchange that produced a real response.
 *
 * verified is not inferred from the status code: a 200 over an unverified
 * chain is exactly the state this row must never record. Nothing in this
 * firmware can disable verification, so verified is the transport's own
 * report, and status proves the exchange completed rather than merely
 * connecting.
 */
bool hwv_rule_tls(bool cert_verified, int http_status);

/* ---- Roll ---- */

/* The server accepted this body and gave it an identity. */
bool hwv_rule_roll_register(int http_status, const char *device_id);

/* The server confirmed the media, not merely accepted the request. */
bool hwv_rule_roll_upload(int http_status, bool server_confirmed);

/* A link that went away and came back on its own. Both halves are required:
 * a link that never dropped has not proven recovery. */
bool hwv_rule_roll_reconnect(bool was_down, bool now_ip_ready);

/* Any 2xx. Shared by the rules above so "success" has one definition. */
bool hwv_rule_http_ok(int http_status);
