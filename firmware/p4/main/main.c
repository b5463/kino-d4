// KINO D4 P4 main controller — Milestone 1. Boots, mounts SD, serves KDP on
// USB-Serial-JTAG, probes CAM1 in the background. Capture priority over
// background work arrives with the capture coordinator in milestone 2.
#include <stdio.h>

#include "audio.h"
#include "buttons.h"
#include "cam_link.h"
#include "capture.h"
#include "gallery.h"
#include "thumb.h"
#include "clock.h"
#include "config_store.h"
#include "display.h"
#include "touch.h"
#include "ui.h"
#include "viewfinder.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "kdp_server.h"
#include "klog.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "power.h"
#include "storage.h"
#include "taskmon.h"

static const char *TAG = "kino_p4";

/* A capture just landed, so the card has something new on it. Rescanning here
 * rather than on a timer means the picture is already decoded by the time
 * anyone opens the gallery to look for it. */
static void gallery_on_capture(const capture_report_t *r) {
  (void)r;
  gallery_refresh();
}

static uint32_t next_boot_count(void) {
  nvs_handle_t nvs;
  uint32_t count = 0;
  if (nvs_open("kino", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_get_u32(nvs, "boot", &count);
    count++;
    nvs_set_u32(nvs, "boot", count);
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  return count;
}

// Keep CAM1 identity fresh: probe every 2 s while offline, every 10 s while
// online. GET_CAMERA_INFO reads the cached result instead of blocking.
/**
 * Keep every camera's online state current, not just CAM1's.
 *
 * This used to greet CAM1 alone, which was right when one node was all the
 * harness had. It stopped being right the moment a capture asked which
 * cameras to fire: a channel that has never been greeted reports offline, so
 * a body with four nodes wired would have taken a one-frame photograph and
 * called three cameras missing. The viewfinder happens to exercise all four,
 * but only while its screen is showing, which is not a state the shutter can
 * depend on.
 *
 * Channels are greeted in turn rather than at once. Four HELLOs on four UARTs
 * would be faster and would also mean four timeouts landing together every
 * two seconds on a bench unit with one node fitted.
 */
static void cam_probe_task(void *arg) {
  (void)arg;
  bool was_online[CAMLINK_CAMS] = {false};
  for (;;) {
    int online_count = 0;
    for (int cam = 0; cam < CAMLINK_CAMS; cam++) {
      const bool online = camlink_hello_ch(cam) == ESP_OK;
      if (online) online_count++;
      if (online == was_online[cam]) continue;

      char tag[4];
      snprintf(tag, sizeof tag, "C%d", cam + 1);
      if (online) {
        camlink_info_t info;
        camlink_get_info_ch(cam, &info);
        klog(tag, "node online — fw %s, sensor %s, boot %s", info.firmware,
             info.sensor_detected ? info.sensor : "none", info.reset_reason);
      } else {
        klog(tag, "node offline — stopped answering");
      }
      was_online[cam] = online;
    }
    /* Slow down once anything has answered. A body that is up needs its
     * cameras confirmed occasionally; an empty bench harness needs a retry
     * often enough that plugging a node in feels immediate. */
    vTaskDelay(pdMS_TO_TICKS(online_count > 0 ? 10000 : 2000));
  }
}

void app_main(void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  }

  /* Settings load before any subsystem reads one. Power management, the UI
   * and the KDP config commands all sit on top of this. */
  config_init();

  kdp_identity_t id;
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  snprintf(id.serial, sizeof id.serial, "KD4-%02X%02X%02X", mac[3], mac[4], mac[5]);
  snprintf(id.device_id, sizeof id.device_id, "kino-%02x%02x%02x", mac[3], mac[4], mac[5]);
  snprintf(id.session_id, sizeof id.session_id, "boot-%lu",
           (unsigned long)next_boot_count());

  /* The clock before anything that timestamps: config_init is settings only,
   * but the first capture can happen the moment KDP is up. */
  clock_init();

  klog_init();
  klog("P4", "boot %s serial %s session %s", KINO_FW_VERSION, id.serial, id.session_id);
  ESP_LOGI(TAG, "P4_BOOT %s serial %s session %s transport usb-serial-jtag",
           KINO_FW_VERSION, id.serial, id.session_id);
  hwv_init();
  storage_init(); /* mount failure is a reported state, not a boot failure */

  /* Clean up captures that never got their META.JSON.
   *
   * META.JSON is written last, so a folder without one is an interrupted
   * commit - a reboot, a brownout, or a card pulled between the last frame
   * and the metadata. It can never become a valid capture and nothing will
   * ever explain the JPEGs inside it. Here, at boot, is the only moment
   * nothing else is writing to the card.
   *
   * Bounded and conservative: only UUID-shaped directories, only the six
   * filenames a capture can hold, and an orphan containing anything else is
   * preserved rather than forced. See storage_sweep_orphans. */
  storage_sweep_t sweep;
  storage_sweep_orphans(&sweep);
  ESP_ERROR_CHECK(camlink_init());

  /* Capture before the KDP server, because CAMERA_CAPTURE is dispatched the
   * instant the server is listening and a NACK saying "not ready" on the
   * first frame after boot would be this firmware's own fault. */
  /* Thumbnails are optional: a camera whose JPEG codec will not start still
   * takes and stores photographs, and every reader treats a missing
   * THUMB.JPG as absent rather than as damage. */
  esp_err_t th_err = thumb_init();
  if (th_err != ESP_OK) {
    ESP_LOGW(TAG, "thumbnails unavailable: %s - captures are unaffected",
             esp_err_to_name(th_err));
  }

  esp_err_t cap_err = capture_init(id.device_id);
  if (cap_err != ESP_OK) {
    ESP_LOGE(TAG, "capture unavailable: %s - the camera cannot take pictures",
             esp_err_to_name(cap_err));
  }

  esp_err_t kdp_err = kdp_server_start(&id);
  if (kdp_err != ESP_OK) {
    // No silent boot hang: the device keeps running, the console says why
    // Studio cannot connect, and the camera/SD paths stay debuggable.
    ESP_LOGE(TAG, "KDP server unavailable: %s", esp_err_to_name(kdp_err));
  } else {
    ESP_LOGI(TAG, "KDP_READY session %s", id.session_id);
  }
  TaskHandle_t probe = NULL;
  /* 8192, not 4096. Measured on the first P4 bring-up (firmware 0.3.0, no
   * nodes fitted): cam_probe sat at 356 free bytes of 4096 — steady across
   * six GET_RUNTIME_STATS calls — while doing nothing but timing out on four
   * channels. The online branch is the expensive one: it puts a
   * camlink_info_t (~128 B) on this stack, fills it through
   * camlink_get_info_ch(), then formats a klog line through varargs. That
   * path first runs the instant CAM1 answers, so the overflow would land on
   * the node-greeting checkpoint and read as a link or node fault. */
  xTaskCreate(cam_probe_task, "cam_probe", 8192, NULL, 5, &probe);
  taskmon_register("cam_probe", probe);

  /* The panel comes up last, deliberately, and its failure is never fatal.
   * It is the newest and least proven peripheral on this board, and KDP over
   * USB is the only way to diagnose or recover the device — so a display
   * that cannot start must leave a camera that can still be talked to. The
   * same ordering the camera bench tool learned: bring up the thing that
   * lets you look at the problem before the thing that might be one. */
  esp_err_t lcd_err = display_init();
  if (lcd_err != ESP_OK) {
    ESP_LOGE(TAG, "display unavailable: %s — KDP and storage are unaffected",
             esp_err_to_name(lcd_err));
  } else {
    display_test_pattern();
    /* Audio BEFORE touch, and the order is load-bearing.
     *
     * The ES8311 shares one I2C bus with the GT911, and the touch driver
     * starts a task that polls it every 20 ms. Bringing the codec up behind
     * that failed every transaction with a NACK at 0x18, while a bus scan on
     * a quiet bus saw 0x18 answer perfectly well. The codec gets the bus
     * while it is still calm; the touch poll can contend with nothing
     * afterwards.
     *
     * A camera with no sound is still a camera, so failure is reported and
     * ignored rather than gating the screen. */
    esp_err_t au_err = audio_init();
    if (au_err != ESP_OK) ESP_LOGE(TAG, "audio unavailable: %s", esp_err_to_name(au_err));

#if KINO_AUDIO_CALIBRATE
    /* Bench only. Plays a dozen sounds into the mic and prints the measured
     * levels, which is how the shutter and tick levels were chosen instead of
     * guessed at. Set KINO_AUDIO_CALIBRATE to 0 in audio.h for normal builds -
     * it adds several seconds to boot and is loud. */
    audio_calibrate();
#endif

    /* Touch only after the panel is drawable: a touch report is only
     * meaningful once there is something on screen to have touched. */
    esp_err_t tp_err = touch_init();
    if (tp_err != ESP_OK) {
      ESP_LOGE(TAG, "touch unavailable: %s - the panel and KDP are unaffected",
               esp_err_to_name(tp_err));
    }

    /* The gallery after the card and the codec, before the UI can show it.
     * Its own failure costs the gallery screen and nothing else. */
    esp_err_t gal_err = gallery_init();
    if (gal_err != ESP_OK) ESP_LOGE(TAG, "gallery unavailable: %s", esp_err_to_name(gal_err));
    else capture_on_done(gallery_on_capture);

    /* The viewfinder before the UI: the first screen the UI draws is the
     * viewfinder, and a pane that reports NO LINK because the module has not
     * started yet is indistinguishable from one that reports it because the
     * harness is unplugged. */
    esp_err_t vf_err = viewfinder_init();
    if (vf_err != ESP_OK) ESP_LOGE(TAG, "viewfinder unavailable: %s", esp_err_to_name(vf_err));

    /* The UI replaces the test pattern once both are up. It runs without
     * touch too - a screen that shows the camera's state is worth having
     * even if nothing can be pressed. */
    esp_err_t ui_err = ui_start();
    if (ui_err != ESP_OK) ESP_LOGE(TAG, "ui unavailable: %s", esp_err_to_name(ui_err));
  }

  /*
   * Controls and power come up whether or not the panel did.
   *
   * These used to sit inside the display-success branch above, on the
   * reasoning that power management's job is turning a backlight off and a
   * backlight needs a panel. That reasoning covered half of what power.c
   * does and none of what buttons.c does. The other half drops CAM_PWR_EN,
   * which is what stops four idle camera nodes draining the cell, and the
   * buttons are the physical shutter.
   *
   * So a panel that failed to initialise took the shutter and the battery
   * protection with it - the two things that matter most on a camera whose
   * screen is dead, in a bag, on a battery. Both are independent of the
   * panel and both now start unconditionally; power.c checks display_ready()
   * before touching the backlight rather than assuming one exists.
   */
  esp_err_t btn_err = buttons_init();
  if (btn_err != ESP_OK) ESP_LOGE(TAG, "buttons unavailable: %s", esp_err_to_name(btn_err));

  esp_err_t pw_err = power_init();
  if (pw_err != ESP_OK) {
    ESP_LOGE(TAG, "power management unavailable: %s", esp_err_to_name(pw_err));
  }

  ESP_LOGI(TAG, "KINO D4 P4 %s up: serial %s, session %s, sd %s, display %s", KINO_FW_VERSION,
           id.serial, id.session_id, storage_present() ? "mounted" : "absent",
           display_ready() ? "up" : "down");
}
