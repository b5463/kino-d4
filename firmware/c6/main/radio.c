#include "radio.h"

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_wifi.h"

static const char *TAG = "radio";

static char s_mac[18] = "unknown";

esp_err_t radio_init(void) {
  // No esp_netif here, on purpose. esp_netif_create_default_wifi_sta() would
  // pull in lwip and give this chip its own IP stack, which is precisely what
  // a coprocessor must not have — two stacks on one link is a bug that only
  // shows up as duplicated ARP under load. Espressif's own hosted slave
  // excludes lwip and esp_netif from its build for the same reason. Wi-Fi
  // init and scan do not need either.
  esp_err_t err = esp_event_loop_create_default();
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
    return err;
  }

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  err = esp_wifi_init(&cfg);
  if (err != ESP_OK) {
    return err;
  }

  // RAM, not NVS. The P4 holds the credentials — a coprocessor that remembers
  // an AP across boots can associate before the host has asked it to, and
  // then the host's first command lands on a link it did not open.
  err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
  if (err != ESP_OK) {
    return err;
  }

  err = esp_wifi_set_mode(WIFI_MODE_STA);
  if (err != ESP_OK) {
    return err;
  }

  err = esp_wifi_start();
  if (err != ESP_OK) {
    return err;
  }

  uint8_t mac[6] = {0};
  if (esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK) {
    snprintf(s_mac, sizeof s_mac, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3],
             mac[4], mac[5]);
  }

  ESP_LOGI(TAG, "station up, mac %s", s_mac);
  return ESP_OK;
}

esp_err_t radio_scan(uint16_t *ap_count) {
  if (ap_count == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  *ap_count = 0;

  // Blocking scan. This runs once at boot as a liveness check, not on a timer:
  // a scan takes the radio off any link it holds, so on a working system only
  // the P4 gets to decide when one happens.
  esp_err_t err = esp_wifi_scan_start(NULL, true);
  if (err != ESP_OK) {
    return err;
  }
  return esp_wifi_scan_get_ap_num(ap_count);
}

const char *radio_mac_str(void) { return s_mac; }
