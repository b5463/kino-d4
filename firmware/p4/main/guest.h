/**
 * The guest half: the whole product, for a stranger at a party.
 *
 * Four screens - aim, taking, taken, wrong - and they are everything someone
 * who did not bring this camera can ever see. The specification is
 * firmware/D4_GUEST.md and the register was chosen off a specimen sheet
 * rather than argued for after it was built, which is the correction to four
 * previous attempts at this interface.
 *
 * Why it is a separate half rather than a mode inside the shell: the shell is
 * six equal tiles, which is a desktop metaphor - a field of peers, any of
 * which you might want. That is right for a machine one person learns and
 * wrong for an object handed to someone with a drink in their other hand. A
 * stranger wants to take a photograph and every other tile is between them
 * and it.
 *
 * The three rules, and they are not negotiable inside this file:
 *
 *   - the shutter always takes a photograph, from any of the four, always
 *   - anything that is not AIM returns to AIM by itself, so a guest who
 *     wanders off hands back a camera rather than a menu
 *   - nothing a finger touches changes anything: in guest mode the panel
 *     reaches nothing at all, and the glass is a viewfinder
 *
 * Drawn with the shell's own fill, faces and clock so the two halves cannot
 * drift into two renderers.
 */
#ifndef KINO_GUEST_H
#define KINO_GUEST_H

#include <stdbool.h>

#include "capture.h"
#include "config_store.h"
#include "storage.h"
#include "viewfinder.h"

/* A party is a dark room and a stranger is at arm's length, so contrast comes
 * before everything. One accent, one failure colour, and no third. */
#define G_INK RGB(0xf2, 0xf4, 0xf7)
#define G_DIM RGB(0x7a, 0x86, 0x94)
#define G_GROUND RGB(0x0c, 0x0e, 0x11)
#define G_HOT RGB(0xff, 0xd2, 0x2a)
#define G_BAD RGB(0xe0, 0x4b, 0x3c)

/* How long the reward stays up before the camera comes back. */
#define G_TAKEN_MS 2000

/*
 * Guest or owner.
 *
 * A physical slide switch on the case is the intended answer and the reason
 * is in D4_INTERACTION.md: a stranger cannot stumble into a switch, the owner
 * cannot forget to leave it, it needs no interface, and you can tell from
 * across a room whether the camera is safe to hand over.
 *
 * That pin does not exist yet. Until it does the config carries it, which
 * Studio sets over USB-C - so the behaviour is real today and the day the
 * switch lands only this function changes.
 *
 * The default is OWNER. A body with no switch that booted into guest mode is
 * a body nobody can configure.
 */
static inline bool guest_mode(void) {
#ifdef BOARD_SW_GUEST
#if BOARD_SW_GUEST != BOARD_BTN_NONE
  return gpio_get_level(BOARD_SW_GUEST) == 0;
#endif
#endif
  return config_bool("body.guestMode", false);
}

/* Which of the four is on screen. Not a screen enum in ui.c's sense: the
 * guest half is one destination and these are its states. */
typedef enum { G_AIM = 0, G_TAKING, G_TAKEN, G_WRONG } g_state_t;

static int64_t s_g_taken_us; /* when the reward went up */

/** The picture, scaled to a rectangle. The finder's own blit is built for the
 *  shell's 2x2 panes; this half puts one lens across the whole panel. */
static void g_pic(const uint16_t *tile, int dx, int dy, int dw, int dh) {
  if (tile == NULL) {
    fill(dx, dy, dw, dh, RGB(0x1a, 0x1e, 0x24));
    return;
  }
  for (int y = 0; y < dh; y++) {
    const uint16_t *src = tile + (size_t)(y * VF_H / dh) * VF_W;
    uint16_t *dst = s_cv + (size_t)(dy + y) * UI_W + dx;
    for (int x = 0; x < dw; x++) dst[x] = src[x * VF_W / dw];
  }
}

/** Which lens the live view is showing. The photograph moves, so the finder
 *  moves: this half never shows a still. */
static int g_lens(void) {
  static const int ORDER[6] = {0, 1, 2, 3, 2, 1};
  const int ms = (int)((esp_timer_get_time() / 1000) % (6 * 110));
  return ORDER[ms / 110];
}

/* ------------------------------------------------------------------ */

/** 1. AIM. Framing is the whole job, so the camera gets out of the way. */
static void g_draw_aim(void) {
  g_pic(viewfinder_ready() ? viewfinder_tile(g_lens()) : NULL, 0, 0, UI_W, UI_H);

  /*
   * The count, and nothing else at all.
   *
   * There were four ticks on the top edge, one per lens, saying which of them
   * were answering. They came off, and the rule they broke is one written two
   * files up: no chrome a guest cannot act on. A stranger can do nothing
   * about a lens being down. If one is, the photograph comes back with three
   * frames and TAKING shows that as it happens; if all four are, WRONG says
   * so in words. Neither of those needs a permanent row of marks on the
   * screen someone is framing with, and "it looks like our product" is not a
   * reason a guest can act on.
   *
   * What is left is the picture and how many more they can take, which is
   * the only thing on this screen anybody has ever wanted from it.
   *
   * On a plate, because it sits over a photograph nobody has taken yet and
   * that photograph may be a window.
   */
  storage_status_t sd;
  storage_get_status(&sd);
  char n[16];
  snprintf(n, sizeof n, "%d", (int)(sd.free_bytes / (6ull * 1024 * 1024)));
  const int w = text_w(&UI_FONT_M, n) * 2 + 24;
  fill(18, UI_H - 76, w, 58, RGB(0x00, 0x00, 0x00));
  text_scaled(&UI_FONT_M, 30, UI_H - 66, n, 2, G_INK);
}

/** 2. TAKING. The picture stays and the four arrive across it. */
static void g_draw_taking(void) {
  g_pic(viewfinder_ready() ? viewfinder_tile(1) : NULL, 0, 0, UI_W, UI_H);

  /*
   * Four segments along the bottom edge, filling on the real arrivals -
   * capture_frames_in(), not a timer, because four sensors on four mounts do
   * not answer together and the unevenness is true.
   *
   * ALONG THE EDGE, NOT ACROSS THE PICTURE. The first cut dimmed three
   * quarters of the frame to a third while the capture ran, which read well
   * on a bright test gradient and read as a broken screen on an actual party
   * photograph: dark stripes over a dark room. The photograph someone just
   * took is the wrong thing to damage in order to report on it. The segments
   * are 16 px of the bottom edge and the picture is untouched.
   */
  const uint32_t in = capture_frames_in();
  const int bw = UI_W / 4, h = 16, y = UI_H - h;
  fill(0, y, UI_W, h, RGB(0x00, 0x00, 0x00));
  for (int i = 0; i < 4; i++) {
    if (in & (1u << i)) fill(i * bw + 2, y + 3, bw - 4, h - 6, G_HOT);
  }
}

/** 3. TAKEN. The reward, and nothing on it whatsoever. */
static void g_draw_taken(void) {
  g_pic(viewfinder_ready() ? viewfinder_tile(g_lens()) : NULL, 0, 0, UI_W, UI_H);
}

/**
 * 4. WRONG.
 *
 * The only screen that takes the picture away, because the picture is what
 * did not happen. Nothing here names a filesystem, a node, a UART or a
 * firmware revision: a guest can act on none of it, and telling them is a way
 * of blaming them for it.
 */
static void g_draw_wrong(const char *word, const char *line) {
  fill(0, 0, UI_W, UI_H, G_GROUND);
  const int cell = 46, gap = 22;
  const int w = 4 * cell + 3 * gap;
  const int x0 = (UI_W - w) / 2, y0 = 150;
  for (int i = 0; i < 4; i++) fill(x0 + i * (cell + gap), y0, cell, cell, G_BAD);
  text_scaled_mid(&UI_FONT_M, UI_W / 2, y0 + cell + 44, word, 2, G_INK);
  text_mid(&UI_FONT_M, UI_W / 2, y0 + cell + 116, line, G_DIM);
}

/**
 * What the camera is doing, as one of four.
 *
 * Read from the device rather than tracked here: a state machine that
 * believes a capture is running when the capture is not is how the shutter
 * stops working, and there is nothing in the guest half that can be pressed
 * to get out of it.
 */
static g_state_t g_state(const char **word, const char **line) {
  *word = NULL;
  *line = NULL;

  const capture_stage_t cs = capture_stage();
  if (cs == CAPTURE_TRIGGERING || cs == CAPTURE_READING || cs == CAPTURE_WRITING) return G_TAKING;

  if (cs == CAPTURE_DONE) {
    capture_report_t r;
    capture_last(&r);
    if (!r.ok) {
      /* Said as what it means for the photograph. The code is in the log and
       * the KDP reply, where someone who can act on it will find it. */
      *word = strstr(r.err_code, "FULL") ? "NO ROOM" : "NO PHOTO";
      *line = "Hand it back to whoever brought it.";
      return G_WRONG;
    }
    if (s_g_taken_us == 0) s_g_taken_us = esp_timer_get_time();
    if ((esp_timer_get_time() - s_g_taken_us) / 1000 < G_TAKEN_MS) return G_TAKEN;
    return G_AIM; /* the camera always comes back */
  }
  s_g_taken_us = 0;

  /* Standing faults, which outrank the viewfinder: a guest pointing a camera
   * that cannot save anything should be told before they press, not after. */
  storage_status_t sd;
  storage_get_status(&sd);
  if (!sd.mounted) {
    *word = "NO CARD";
    *line = "Hand it back to whoever brought it.";
    return G_WRONG;
  }
  if (sd.free_bytes < (6ull * 1024 * 1024)) {
    *word = "NO ROOM";
    *line = "Hand it back to whoever brought it.";
    return G_WRONG;
  }
  if (viewfinder_ready()) {
    int up = 0;
    for (int i = 0; i < 4; i++) up += viewfinder_tile(i) != NULL ? 1 : 0;
    if (up == 0) {
      *word = "CAMERAS DOWN";
      *line = "Hand it back to whoever brought it.";
      return G_WRONG;
    }
  }
  return G_AIM;
}

/** The guest half, drawn. One call, from draw_screen(). */
static void draw_guest(void) {
  fill(0, 0, UI_W, UI_H, G_GROUND);
  const char *word = NULL, *line = NULL;
  switch (g_state(&word, &line)) {
    case G_TAKING: g_draw_taking(); break;
    case G_TAKEN: g_draw_taken(); break;
    case G_WRONG: g_draw_wrong(word, line); break;
    default: g_draw_aim(); break;
  }
}

#endif /* KINO_GUEST_H */
