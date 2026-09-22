/**
 * What is wrong with the camera, as a list the whole interface agrees on.
 *
 * The camera knew all of this already and said none of it where anyone would
 * look. A node two firmware revisions behind its neighbours, two cameras that
 * stopped answering, a clock that has never been set - every one of those was
 * a grey row two levels deep in SETTINGS, or nothing at all. The failure that
 * costs most is the clock: this body has no RTC, so until Studio sets it every
 * capture is dated 1970 plus uptime, and that survives import and sorts
 * someone's evening into the wrong decade forever.
 *
 * So: one enumeration of the things that can be wrong, one severity scale, one
 * scan, and one place they are listed. A subsystem does not get to invent its
 * own way of complaining.
 *
 * ## Scanning is not free and does not happen in a draw
 *
 * The node firmware readings come from camlink, which holds a channel lock
 * across a round trip - an information screen does not get to compete with a
 * capture for it once per repaint. So conditions_scan() runs on the UI loop's
 * own schedule and everything that draws reads the cache underneath it.
 */
#ifndef KINO_CONDITIONS_H
#define KINO_CONDITIONS_H

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cam_link.h"
#include "clock.h"
#include "config_store.h"
#include "kdp_server.h"
#include "roll_http.h"
#include "roll_state.h"
#include "safe_mode.h"
#include "storage.h"

typedef enum {
  COND_CARD_MISSING = 0, /* nowhere to put a photograph */
  COND_CAMERA_DOWN,      /* a lens is not answering */
  COND_CARD_LOW,         /* the card is nearly full */
  COND_NODE_SKEW,        /* the four nodes are not on one firmware */
  COND_CLOCK_UNSET,      /* every capture is dated 1970 plus uptime */
  COND_UNCALIBRATED,     /* the four have never been measured against each other */
  COND_SAFE_MODE,        /* three crashes in a row; radio and uploads left out */
  COND_WARM,             /* the P4 die is over the warm line; the finder is slowed */
  COND_CARD_FAILED,      /* the card failed its write test */
  COND_CARD_SLOW,        /* the card passed, slowly */
  COND_BROWNOUT,         /* this boot follows a brownout reset */
  COND_ZONE_UNSET,       /* the clock is on UTC: nobody has said where the camera is */
  COND_ROLL_NO_SERVER,   /* a Roll is joined but there is no server to upload to */
  COND_COUNT,
} cond_id_t;

/* Three levels and no more. FAULT is the camera cannot do its job; WARN is it
 * is about to stop being able to; NOTE is something a person should know and
 * nothing is broken. A fourth level is how a scale stops meaning anything. */
typedef enum { COND_NOTE = 0, COND_WARN, COND_FAULT } cond_sev_t;

typedef struct {
  cond_id_t id;
  cond_sev_t sev;
  const char *title;
  char detail[64];
  uint8_t mask; /* COND_CAMERA_DOWN: bit i set for the (i+1)th lens from the left */
} cond_t;

/* Six is every condition at once, which is a camera with no card in a drawer. */
#define COND_MAX COND_COUNT

static cond_t s_cond[COND_MAX];
static int s_cond_n;

/** How many are active, and the worst of them. Cheap: reads the cache. */
static inline int conditions_count(void) { return s_cond_n; }
static inline const cond_t *conditions_at(int i) {
  return (i >= 0 && i < s_cond_n) ? &s_cond[i] : NULL;
}
static inline cond_sev_t conditions_worst(void) {
  return s_cond_n > 0 ? s_cond[0].sev : COND_NOTE;
}
static inline bool conditions_has(cond_id_t id) {
  for (int i = 0; i < s_cond_n; i++)
    if (s_cond[i].id == id) return true;
  return false;
}

/* The die temperature that slows the finder, and the one it resumes at.
 * The P4's sensor is rated to 80 C; the case is warm to the hand well
 * before the die reads 75. */
#define COND_WARM_C 75.0f
#define COND_COOL_C 68.0f

/* The 64 KB write test (storage_self_test) takes 30-100 ms on a card that
 * is any good; a card past this is worth a word before it costs a photograph. */
#define COND_CARD_SLOW_MS 600

/**
 * Take a reading. `cams` is camlink's four, already fetched by the caller so
 * this never reaches for the channel itself.
 *
 * Ordered worst first, and inside a severity in the order of the enumeration,
 * so the list is stable between scans - a list that reshuffles while someone
 * reads it is worse than one that is out of date.
 */
static void conditions_scan(const camlink_info_t *cams) {
  cond_t found[COND_MAX];
  memset(found, 0, sizeof found);
  int n = 0;

  storage_status_t sd;
  storage_get_status(&sd);

  if (!sd.mounted) {
    cond_t *c = &found[n++];
    c->id = COND_CARD_MISSING;
    c->sev = COND_FAULT;
    if (sd.removed) {
      c->title = "The card was taken out";
      snprintf(c->detail, sizeof c->detail, "Put it back. Photos cannot be saved.");
    } else if (sd.present) {
      /* A card answered and the filesystem would not: exFAT, which is what
       * every card over 32 GB is sold as. */
      c->title = "The card cannot be read";
      snprintf(c->detail, sizeof c->detail, "Not a format KINO reads. Use a card up to 32 GB, or format it.");
    } else {
      c->title = "No card";
      snprintf(c->detail, sizeof c->detail, "Put a card in. Photos cannot be saved.");
    }
  } else {
    if (sd.write_test != NULL && strcmp(sd.write_test, "fail") == 0) {
      cond_t *c = &found[n++];
      c->id = COND_CARD_FAILED;
      c->sev = COND_FAULT;
      c->title = "This card failed a write";
      snprintf(c->detail, sizeof c->detail, "Copy your photos off it and change the card.");
    } else if (sd.write_test != NULL && strcmp(sd.write_test, "pass") == 0 &&
               sd.write_test_ms > COND_CARD_SLOW_MS) {
      cond_t *c = &found[n++];
      c->id = COND_CARD_SLOW;
      c->sev = COND_WARN;
      c->title = "This card is slow";
      snprintf(c->detail, sizeof c->detail, "Photos take longer to save. A faster card helps.");
    }
    const int shots = (int)(sd.free_bytes / (6ull * 1024 * 1024));
    if (shots <= 0) {
      cond_t *c = &found[n++];
      c->id = COND_CARD_LOW;
      c->sev = COND_FAULT;
      c->title = "The card is full";
      snprintf(c->detail, sizeof c->detail, "Delete photos or change the card.");
    } else if (shots < 50) {
      cond_t *c = &found[n++];
      c->id = COND_CARD_LOW;
      c->sev = COND_WARN;
      c->title = "Card nearly full";
      snprintf(c->detail, sizeof c->detail, "Room for about %d more photos.", shots);
    }
  }

  if (cams != NULL) {
    /* By position, not by number: the lenses are CAM1..CAM4 from the left
     * as the camera is held (hardware/TESTING.md), and "CAM3" means nothing
     * to the hand holding it. The row draws the four cells from the mask. */
    static const char *const POS[4] = {"first", "second", "third", "fourth"};
    uint8_t mask = 0;
    int ndown = 0, last = 0;
    for (int i = 0; i < 4; i++) {
      if (cams[i].online) continue;
      mask |= (uint8_t)(1u << i);
      ndown++;
      last = i;
    }
    if (ndown > 0) {
      cond_t *c = &found[n++];
      c->id = COND_CAMERA_DOWN;
      c->sev = COND_FAULT;
      c->mask = mask;
      c->title = ndown == 1 ? "A lens is not answering" : "Lenses are not answering";
      if (ndown == 1) {
        snprintf(c->detail, sizeof c->detail, "The %s from the left. Try RESTART THE CAMERAS below.",
                 POS[last]);
      } else {
        snprintf(c->detail, sizeof c->detail, "%d of 4. Try RESTART THE CAMERAS below.", ndown);
      }
    }

    /* Node firmware skew. Compared only across the nodes that answered: a node
     * that is off cannot be behind, and calling it behind would send someone
     * reflashing a part that is merely unplugged. */
    const char *first = NULL;
    bool skew = false;
    for (int i = 0; i < 4; i++) {
      if (!cams[i].online || cams[i].firmware[0] == '\0') continue;
      if (first == NULL) first = cams[i].firmware;
      else if (strcmp(first, cams[i].firmware) != 0) skew = true;
    }
    if (skew) {
      cond_t *c = &found[n++];
      c->id = COND_NODE_SKEW;
      c->sev = COND_WARN;
      c->title = "The cameras need an update";
      snprintf(c->detail, sizeof c->detail, "Connect to Studio to update them.");
    }
  }

#ifdef KINO_RADIO
  {
    /* A Roll joined and nowhere to send to: the build has no compiled API
     * base and Studio has not set network.apiBase. Without this row every
     * upload parked FAILED and the ROLL screen said "Online". Radio builds
     * only: a body without a route to the C6 uploads over USB-C, and
     * roll_http.h has no API base on it to ask about. */
    roll_state_t roll;
    char base[160];
    if (roll_state_get(&roll) && !roll_http_api_base(base, sizeof base)) {
      cond_t *c = &found[n++];
      c->id = COND_ROLL_NO_SERVER;
      c->sev = COND_WARN;
      c->title = "Uploads have no server";
      snprintf(c->detail, sizeof c->detail, "Set the Roll server in Studio. Photos stay on the card.");
    }
  }
#endif

  if (clock_source() != CLOCK_UNSET && !clock_offset_known()) {
    cond_t *c = &found[n++];
    c->id = COND_ZONE_UNSET;
    c->sev = COND_NOTE;
    c->title = "The clock is on UTC";
    snprintf(c->detail, sizeof c->detail, "Set the time zone in CONNECTION.");
  }

  if (clock_source() == CLOCK_UNSET) {
    cond_t *c = &found[n++];
    c->id = COND_CLOCK_UNSET;
    c->sev = COND_WARN;
    c->title = "The date is not set";
    /* Said as what it costs, not as what is missing. "No RTC fitted" is a
     * fact about the board; this is a fact about the photographs. */
    snprintf(c->detail, sizeof c->detail, "Wi-Fi or Studio sets it once.");
  }

  if (!config_bool("body.calibration.done", false)) {
    cond_t *c = &found[n++];
    c->id = COND_UNCALIBRATED;
    c->sev = COND_NOTE;
    c->title = "Cameras not measured";
    snprintf(c->detail, sizeof c->detail, "The first photograph measures them.");
  }

  if (safe_mode_brownout()) {
    cond_t *c = &found[n++];
    c->id = COND_BROWNOUT;
    c->sev = COND_WARN;
    c->title = "The camera lost power while running";
    snprintf(c->detail, sizeof c->detail, "Charge or replace the cells.");
  }

  if (safe_mode_active()) {
    cond_t *c = &found[n++];
    c->id = COND_SAFE_MODE;
    c->sev = COND_FAULT;
    c->title = "Running without Wi-Fi";
    snprintf(c->detail, sizeof c->detail, "It crashed %d times in a row. Restart to try again.",
             safe_mode_crashes());
  }

  {
    /* Hysteresis, so the row does not flicker on the line. */
    static bool warm;
    static int last_c;
    float t;
    if (kdp_p4_temp_c(&t)) {
      last_c = (int)(t + 0.5f);
      if (t >= COND_WARM_C) warm = true;
      else if (t <= COND_COOL_C) warm = false;
    }
    if (warm) {
      cond_t *c = &found[n++];
      c->id = COND_WARM;
      c->sev = COND_WARN;
      c->title = "The camera is warm";
      snprintf(c->detail, sizeof c->detail, "%d C inside. The finder slows until it cools.", last_c);
    }
  }

  /* Worst first, stable inside a severity. */
  s_cond_n = 0;
  for (int sev = COND_FAULT; sev >= COND_NOTE; sev--)
    for (int i = 0; i < n; i++)
      if ((int)found[i].sev == sev) s_cond[s_cond_n++] = found[i];
}

#endif /* KINO_CONDITIONS_H */
