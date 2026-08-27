/**
 * QR encoding, for the Roll join code on the camera's display.
 *
 * The camera has a screen and a guest has a phone. A QR is what turns those
 * two facts into someone joining a Roll at a party without anyone opening a
 * laptop — which is the whole reason the Roll screen is worth having on the
 * camera rather than only in Studio.
 *
 * Scope is deliberately small: byte mode, error-correction level M, versions 1
 * to 10 — **213 bytes** at the top end. (271 is version 10 at level L, and an
 * earlier draft of this comment had that figure wrong; qr.c derives the real
 * capacity rather than tabulating it, and the host test asserts the 213/214
 * boundary.) A Roll `guestUrl` is around 40 characters, so that is several
 * times the headroom needed and stops well short of the versions whose module
 * count exceeds what a 480x800 panel can show at a scannable pitch.
 *
 * ## Why level M
 *
 * L would fit more and scan slightly faster in good conditions. M is chosen
 * because the scan happens in the conditions this camera exists for: a dim
 * room, a phone held at an angle, a screen with a backlight that is on or off
 * and nothing in between. The extra redundancy is worth more than the capacity
 * that buys it.
 *
 * ## No allocation
 *
 * The result is a fixed-size struct the caller owns. A 177x177 bitfield is
 * about 4 KB, and version 10 is 57x57 — so the struct is sized for version 10
 * and costs 407 bytes. The UI task draws it directly from the caller's frame,
 * so nothing here allocates and nothing has to be freed on an error path.
 */
#ifndef P4_QR_H
#define P4_QR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Highest version supported. Version 10 is 57x57 modules. */
#define QR_MAX_VERSION 10
/** Module count of the largest supported version: 17 + 4 * version. */
#define QR_MAX_SIZE (17 + 4 * QR_MAX_VERSION)
/** Bytes per row of the packed bitfield. */
#define QR_ROW_BYTES ((QR_MAX_SIZE + 7) / 8)

/** An encoded symbol. `size` is the module count per side. */
typedef struct {
  int version; /* 1..QR_MAX_VERSION, or 0 when encoding failed */
  int size;    /* 17 + 4 * version */
  uint8_t modules[QR_MAX_SIZE][QR_ROW_BYTES];
} qr_t;

/**
 * Encode `text` at the smallest version that fits it.
 *
 * Returns false, and leaves `out->version` 0, when `text` is NULL, empty, or
 * longer than version 10 at level M holds. A caller must check: drawing a
 * failed symbol would put a QR-shaped rectangle on screen that no phone can
 * read, which wastes a guest's time at the party rather than telling anyone
 * anything.
 */
bool qr_encode(const char *text, qr_t *out);

/** True when the module at (`x`, `y`) is dark. Out-of-range reads are light,
 * so a caller drawing a quiet zone does not need its own bounds check. */
bool qr_module(const qr_t *qr, int x, int y);

#endif /* P4_QR_H */
