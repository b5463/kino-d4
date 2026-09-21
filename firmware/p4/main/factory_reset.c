#include "factory_reset.h"

#include "config_store.h"
#include "esp_err.h"
#include "klog.h"
#include "nvs.h"
#include "roll_state.h"
#include "wifi_creds.h"

void factory_reset_erase(void) {
  const esp_err_t cfg = config_reset();
  const esp_err_t net = wifi_creds_erase_all();
  const esp_err_t roll = roll_state_erase();
  /* The crash count too: a body being reset is being given a clean start. */
  nvs_handle_t nvs;
  if (nvs_open("kino", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_erase_key(nvs, "crashes");
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  klog("P4", "factory reset: settings %s, networks %s, roll %s", esp_err_to_name(cfg),
       esp_err_to_name(net), esp_err_to_name(roll));
}
