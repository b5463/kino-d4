/*
 * Scan, association and DHCP on the hosted C6. See net_wifi.h for the split
 * and net_hosted.h for why none of this is in the default build.
 *
 * Nothing here has been run on hardware.
 */
#include "net_wifi.h"

#ifdef KINO_RADIO

#include <stdio.h>
#include <string.h>

#include "clock.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "klog.h"
#include "net_link.h"
#include "net_time.h"
#include "wifi_creds.h"

static const char *TAG = "wifi";

/* Records asked of the radio in one scan. Above net_link's own cap so the
 * strongest-duplicate pass below has something to choose from: a flat with
 * three access points on one SSID would otherwise fill the list with one
 * network. */
#define SCAN_RECORDS 32

static bool s_started;
/* Set while the user (or auto-join) wants an association. Cleared by
 * net_wifi_disconnect() so a deliberate disconnect does not immediately
 * reconnect on the driver's own retry. */
static bool s_want_association;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* ------------------------------------------------------------------ */
/* Text from the air                                                  */
/* ------------------------------------------------------------------ */

/**
 * Copy an SSID out of a scan record into something safe to draw and to put in
 * JSON.
 *
 * An SSID is 32 arbitrary octets. It is not required to be UTF-8, not
 * required to be printable and not required to be terminated, and the three
 * places it ends up — a cJSON string, the panel's font, and a log line — all
 * assume otherwise. cJSON in particular emits invalid UTF-8 verbatim, so a
 * malformed SSID becomes a KDP reply Studio cannot parse.
 *
 * So: control codes become '?', and any byte sequence that is not valid UTF-8
 * becomes one '?' per offending byte. Valid multi-byte sequences pass through
 * untouched, because a network really can be called "Kaffeehaus".
 */
static void sanitise_ssid(const uint8_t *raw, size_t raw_len, char *out, size_t cap) {
  size_t o = 0;
  size_t i = 0;
  while (i < raw_len && raw[i] != '\0' && o + 1 < cap) {
    const uint8_t c = raw[i];
    if (c < 0x20 || c == 0x7f) {
      out[o++] = '?';
      i++;
      continue;
    }
    if (c < 0x80) {
      out[o++] = (char)c;
      i++;
      continue;
    }
    /* Multi-byte: work out how long the sequence claims to be, then check the
     * continuation bytes really are there. */
    size_t need = 0;
    if ((c & 0xe0) == 0xc0) need = 2;
    else if ((c & 0xf0) == 0xe0) need = 3;
    else if ((c & 0xf8) == 0xf0) need = 4;
    bool ok = need > 0 && i + need <= raw_len && o + need < cap;
    for (size_t k = 1; ok && k < need; k++) {
      if ((raw[i + k] & 0xc0) != 0x80) ok = false;
    }
    if (!ok) {
      out[o++] = '?';
      i++;
      continue;
    }
    for (size_t k = 0; k < need; k++) out[o++] = (char)raw[i + k];
    i += need;
  }
  out[o] = '\0';
}

static void format_bssid(const uint8_t mac[6], char *out, size_t cap) {
  snprintf(out, cap, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4],
           mac[5]);
}

/** Which of the three wire security names an authmode is.
 *
 * Anything unrecognised is WPA2, not open: net_link.h's rule, and for the same
 * reason — calling an unknown mode open would offer an unencrypted join. */
static net_security_t security_of(wifi_auth_mode_t mode) {
  switch (mode) {
    case WIFI_AUTH_OPEN:
      return NET_SEC_OPEN;
    case WIFI_AUTH_WPA3_PSK:
    case WIFI_AUTH_WPA2_WPA3_PSK:
    case WIFI_AUTH_WPA3_ENT_192:
    case WIFI_AUTH_WPA3_EXT_PSK:
    case WIFI_AUTH_WPA3_EXT_PSK_MIXED_MODE:
      return NET_SEC_WPA3;
    default:
      return NET_SEC_WPA2;
  }
}

/* ------------------------------------------------------------------ */
/* Scan                                                               */
/* ------------------------------------------------------------------ */

/**
 * Turn the radio's records into net_link's list.
 *
 * Three cases the raw list gets wrong for a user:
 *
 *   - the same SSID on several access points, which is one network to a
 *     person and three rows to the radio. Kept once, at the strongest RSSI.
 *   - a hidden network, which advertises an empty SSID. Reported as hidden
 *     rather than dropped: it is a real network and the count matters.
 *   - two different hidden networks, which would collapse into one under the
 *     SSID rule. Hidden entries are never merged, because their only identity
 *     is the BSSID.
 */
static void publish_scan(const wifi_ap_record_t *records, uint16_t count) {
  net_scan_entry_t out[NET_SCAN_MAX];
  size_t n = 0;

  for (uint16_t i = 0; i < count && n < NET_SCAN_MAX; i++) {
    net_scan_entry_t e;
    memset(&e, 0, sizeof e);
    sanitise_ssid(records[i].ssid, sizeof records[i].ssid, e.ssid, sizeof e.ssid);
    e.hidden = e.ssid[0] == '\0';
    format_bssid(records[i].bssid, e.bssid, sizeof e.bssid);
    e.rssi = records[i].rssi;
    e.channel = records[i].primary;
    e.security = security_of(records[i].authmode);

    if (!e.hidden) {
      bool merged = false;
      for (size_t k = 0; k < n; k++) {
        if (out[k].hidden || strcmp(out[k].ssid, e.ssid) != 0) continue;
        /* Same network, another radio. Keep the one a person would actually
         * associate with. */
        if (e.rssi > out[k].rssi) out[k] = e;
        merged = true;
        break;
      }
      if (merged) continue;
    }
    out[n++] = e;
  }

  net_link_report_scan(out, n);
  ESP_LOGI(TAG, "scan: %u records, %u networks", (unsigned)count, (unsigned)n);
}

static void handle_scan_done(void) {
  uint16_t number = SCAN_RECORDS;
  static wifi_ap_record_t records[SCAN_RECORDS];
  memset(records, 0, sizeof records);

  if (esp_wifi_scan_get_ap_records(&number, records) != ESP_OK) {
    /* An empty answer is a real answer — a shielded room scans to nothing —
     * so this is only reported when the call itself failed. */
    net_link_report_state(NET_WIFI_IDLE, NET_REASON_RADIO_FAILURE,
                          "the scan finished but no records came back", now_ms());
    return;
  }
  publish_scan(records, number);

  /* Back to whatever the radio was doing before the scan. A scan while
   * associated does not drop the association, so IP_READY must survive it. */
  net_status_t st;
  net_link_status(&st, now_ms());
  if (st.ip[0] == '\0') {
    net_link_report_state(NET_WIFI_IDLE, NET_REASON_NONE, NULL, now_ms());
  }
}

bool net_wifi_scan_start(void) {
  if (!s_started) return false;
  const esp_err_t err = esp_wifi_scan_start(NULL, false);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "scan refused: %s", esp_err_to_name(err));
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Association                                                        */
/* ------------------------------------------------------------------ */

/**
 * The one frame on this device that holds a Wi-Fi passphrase.
 *
 * wifi_creds_apply_to() calls this and wipes its own copy before returning;
 * `cfg` is wiped here before this returns. Nothing above this function has
 * ever seen the value, which is the whole point of the callback shape.
 */
static esp_err_t apply_credential(const char *ssid, const char *passphrase,
                                  net_security_t security, void *ctx) {
  (void)ctx;

  wifi_config_t cfg;
  memset(&cfg, 0, sizeof cfg);
  snprintf((char *)cfg.sta.ssid, sizeof cfg.sta.ssid, "%s", ssid);
  if (passphrase != NULL) {
    snprintf((char *)cfg.sta.password, sizeof cfg.sta.password, "%s", passphrase);
  }

  /* The floor, not the ceiling. WPA3 is offered as WPA3-PSK with H2E, which a
   * WPA2/WPA3 transitional access point accepts; a stored WPA2 network still
   * associates with a transitional AP because WPA2_PSK is the floor and the
   * driver takes the strongest mode on offer above it. Setting the threshold
   * to OPEN for a network we believe is encrypted would let an evil twin
   * downgrade the join, silently. */
  switch (security) {
    case NET_SEC_OPEN:
      cfg.sta.threshold.authmode = WIFI_AUTH_OPEN;
      break;
    case NET_SEC_WPA3:
      cfg.sta.threshold.authmode = WIFI_AUTH_WPA3_PSK;
      cfg.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
      break;
    case NET_SEC_WPA2:
    default:
      cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
      break;
  }
  /* Hidden networks do not answer a broadcast probe. */
  cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;

  esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
  if (err == ESP_OK) err = esp_wifi_connect();

  memset(&cfg, 0, sizeof cfg);
  return err;
}

bool net_wifi_connect(const char *ssid) {
  if (!s_started || ssid == NULL || ssid[0] == '\0') return false;

  const esp_err_t err = wifi_creds_apply_to(ssid, apply_credential, NULL);
  if (err == ESP_ERR_NOT_FOUND) {
    net_link_report_state(NET_WIFI_IDLE, NET_REASON_NO_CREDENTIALS,
                          "no passphrase saved for that network", now_ms());
    return false;
  }
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "connect refused: %s", esp_err_to_name(err));
    return false;
  }
  s_want_association = true;
  return true;
}

bool net_wifi_disconnect(void) {
  if (!s_started) return false;
  s_want_association = false;
  return esp_wifi_disconnect() == ESP_OK;
}

void net_wifi_auto_join(void) {
  char ssid[NET_SSID_LEN];
  if (!wifi_creds_auto_join_target(ssid, sizeof ssid)) {
    net_link_report_state(NET_WIFI_IDLE, NET_REASON_NO_CREDENTIALS,
                          "no network saved to join on its own", now_ms());
    return;
  }
  /* Through net_link, not straight into net_wifi_connect(), so the state and
   * the SSID are recorded in one place whoever asked. */
  (void)net_link_connect(ssid, now_ms());
}

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

/** Why the association ended, in net_link's vocabulary.
 *
 * The distinction that matters to a user is "wrong passphrase" against "that
 * network is not here", and the driver reports both as a disconnect. */
static net_reason_t disconnect_reason(uint8_t code) {
  switch (code) {
    case WIFI_REASON_NO_AP_FOUND:
      return NET_REASON_NETWORK_NOT_FOUND;
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
    case WIFI_REASON_802_1X_AUTH_FAILED:
      return NET_REASON_AUTH_FAILED;
    default:
      return NET_REASON_ASSOC_FAILED;
  }
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  (void)base;

  switch (id) {
    case WIFI_EVENT_SCAN_DONE:
      handle_scan_done();
      break;

    case WIFI_EVENT_STA_CONNECTED: {
      const wifi_event_sta_connected_t *e = (const wifi_event_sta_connected_t *)data;
      char ssid[NET_SSID_LEN];
      char bssid[NET_BSSID_LEN];
      sanitise_ssid(e->ssid, sizeof e->ssid, ssid, sizeof ssid);
      format_bssid(e->bssid, bssid, sizeof bssid);
      net_link_report_association(ssid, bssid, 0, e->channel);
      /* ASSOCIATED, then IP_WAIT. Neither is `connected` on the wire, and
       * that is the defect this whole state set exists to avoid. */
      net_link_report_state(NET_WIFI_ASSOCIATED, NET_REASON_NONE, NULL, now_ms());
      net_link_report_state(NET_IP_WAIT, NET_REASON_NONE, "waiting for DHCP", now_ms());
      break;
    }

    case WIFI_EVENT_STA_DISCONNECTED: {
      const wifi_event_sta_disconnected_t *e = (const wifi_event_sta_disconnected_t *)data;
      const net_reason_t reason = disconnect_reason(e->reason);
      char detail[NET_DETAIL_LEN];
      snprintf(detail, sizeof detail, "disconnected, 802.11 reason %u", (unsigned)e->reason);
      net_link_report_state(NET_WIFI_IDLE, reason, detail, now_ms());

      if (reason == NET_REASON_AUTH_FAILED) {
        /* Do not retry a wrong passphrase. The access point counts the
         * attempts and a camera that hammers it gets blacklisted, which then
         * looks like a hardware fault. */
        s_want_association = false;
        klog("P4", "wifi auth failed; not retrying until asked");
        break;
      }
      if (s_want_association) {
        /* The AP was switched off, or the guest walked out of range. Let the
         * driver's own retry do it; there is nothing for this firmware to add
         * and a second retry loop on top is how a radio never settles. */
        (void)esp_wifi_connect();
      }
      break;
    }

    default:
      break;
  }
}

static void ip_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  (void)base;

  if (id == IP_EVENT_STA_GOT_IP) {
    const ip_event_got_ip_t *e = (const ip_event_got_ip_t *)data;
    char ip[NET_IP_LEN];
    snprintf(ip, sizeof ip, IPSTR, IP2STR(&e->ip_info.ip));

    /* RSSI is worth having beside the address and is not in this event. */
    char ssid[NET_SSID_LEN] = {0};
    wifi_ap_record_t ap;
    memset(&ap, 0, sizeof ap);
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
      char bssid[NET_BSSID_LEN];
      sanitise_ssid(ap.ssid, sizeof ap.ssid, ssid, sizeof ssid);
      format_bssid(ap.bssid, bssid, sizeof bssid);
      net_link_report_association(ssid, bssid, ap.rssi, ap.primary);
    }

    net_link_report_ip(ip, now_ms());
    /* The metadata behind `lastConnectedAt`, and only worth writing when the
     * SSID came back: a blank one would stamp a network nobody can identify.
     * Trustworthy only as far as clockSource says it is. */
    if (ssid[0] != 0) wifi_creds_mark_connected(ssid, clock_now_ms());
    klog("P4", "wifi up, address %s", ip);

    /* Only now can SNTP resolve anything. */
    net_time_sync_now();
    return;
  }

  if (id == IP_EVENT_STA_LOST_IP) {
    /* The lease went and the association may still be up. Dropping to IP_WAIT
     * rather than IDLE says exactly that, and stops the upload queue without
     * claiming the network is gone. */
    net_link_report_state(NET_IP_WAIT, NET_REASON_DHCP_TIMEOUT, "the DHCP lease expired",
                          now_ms());
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                              */
/* ------------------------------------------------------------------ */

esp_err_t net_wifi_start(void) {
  if (s_started) return ESP_OK;

  esp_err_t err = esp_netif_init();
  if (err != ESP_OK) return err;

  /* The default loop may already exist: kdp_server and the camera links do
   * not use it today, but a component that does would have created it. */
  err = esp_event_loop_create_default();
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

  if (esp_netif_create_default_wifi_sta() == NULL) return ESP_FAIL;

  err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL,
                                            NULL);
  if (err != ESP_OK) return err;
  err = esp_event_handler_instance_register(IP_EVENT, ESP_EVENT_ANY_ID, ip_event, NULL, NULL);
  if (err != ESP_OK) return err;

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  err = esp_wifi_init(&cfg);
  if (err != ESP_OK) return err;

  /* No NVS for the radio's own config: wifi_creds.c owns what this camera
   * remembers, in its own namespace, and a second store would be a second
   * answer to "which networks does it know". sdkconfig.radio sets
   * CONFIG_WIFI_RMT_NVS_ENABLED=n for the same reason. */
  err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
  if (err != ESP_OK) return err;

  err = esp_wifi_set_mode(WIFI_MODE_STA);
  if (err != ESP_OK) return err;
  err = esp_wifi_start();
  if (err != ESP_OK) return err;

  s_started = true;
  return ESP_OK;
}

#endif /* KINO_RADIO */
