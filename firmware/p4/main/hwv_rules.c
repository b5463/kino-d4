#include "hwv_rules.h"

#include <string.h>

/* 2020-01-01T00:00:00Z. Anything earlier is not a time this camera can have
 * been switched on at, so it is a clock that never got set rather than one
 * that got set wrongly. */
#define EPOCH_FLOOR_MS 1577836800000LL

bool hwv_rule_http_ok(int http_status) { return http_status >= 200 && http_status < 300; }

bool hwv_rule_sdio_link(int rx_ready) { return rx_ready != 0; }

bool hwv_rule_transport_usable(int rx_ready, int tx_ready) {
  return rx_ready != 0 && tx_ready != 0;
}

bool hwv_rule_slave_version(bool rpc_ok, uint32_t cp_major, uint32_t cp_minor, uint32_t host_major,
                            uint32_t host_minor) {
  if (!rpc_ok) return false;
  if (cp_major != host_major) return false;
  return cp_minor >= host_minor;
}

bool hwv_rule_wifi_scan(bool scan_ok, unsigned ap_count) { return scan_ok && ap_count > 0u; }

bool hwv_rule_wifi_associate(bool associated, const char *ssid) {
  return associated && ssid != NULL && ssid[0] != '\0';
}

bool hwv_rule_dhcp(uint32_t ip) {
  if (ip == 0u) return false;
  const uint32_t a = (ip >> 24) & 0xffu;
  const uint32_t b = (ip >> 16) & 0xffu;
  if (a == 127u) return false;         /* loopback */
  if (a == 169u && b == 254u) return false; /* link-local: DHCP failed */
  if (a == 0u) return false;
  if (a >= 224u) return false; /* multicast and reserved */
  return true;
}

bool hwv_rule_dns(bool ok, uint32_t resolved_ip) { return ok && resolved_ip != 0u; }

bool hwv_rule_sntp(bool accepted, int64_t epoch_ms) {
  return accepted && epoch_ms >= EPOCH_FLOOR_MS;
}

bool hwv_rule_tls(bool cert_verified, int http_status) {
  return cert_verified && hwv_rule_http_ok(http_status);
}

bool hwv_rule_roll_register(int http_status, const char *device_id) {
  return hwv_rule_http_ok(http_status) && device_id != NULL && device_id[0] != '\0';
}

bool hwv_rule_roll_upload(int http_status, bool server_confirmed) {
  return hwv_rule_http_ok(http_status) && server_confirmed;
}

bool hwv_rule_roll_reconnect(bool was_down, bool now_ip_ready) { return was_down && now_ip_ready; }
