/**
 * THUMB.JPG: the small picture a gallery can actually show.
 *
 * A capture folder holds up to four UXGA frames of 200-400 KB each. Drawing a
 * grid of those means decoding 1.9 megapixels per tile, and shipping one to a
 * host over USB to fill a 96-pixel square wastes about 99% of the transfer.
 * So every capture writes one 320x240 thumbnail beside its frames.
 *
 * It is made once, at capture time, from the frame already in memory — never
 * on demand from the card. Doing it per request would put a full decode on
 * the path of every gallery scroll, and doing it lazily would make the first
 * scroll after a shoot the slowest one.
 *
 * The whole path is hardware: the JPEG codec decodes, the PPA scales, the
 * codec encodes again. On this part that is single-digit milliseconds against
 * roughly a second in software, which is the difference between a shutter
 * that feels immediate and one that does not.
 */
#ifndef KINO_THUMB_H
#define KINO_THUMB_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pure.h" /* pure_cam_offset_t, for the aligned wigglegram decode */

/*
 * The box a thumbnail fits inside, not the size it comes out.
 *
 * The PPA scales in sixteenths, so a 1600-wide frame reduces by 3/16 and not
 * by the 0.2 that would land on exactly 320 - it comes out 300x225. Rounding
 * up instead would overflow the box, and resampling afterwards to hit a round
 * number would spend a second of CPU to make a 320-pixel picture out of a
 * 300-pixel one. Readers take the size from the JPEG, which is where a JPEG's
 * size has always come from.
 */
#define THUMB_MAX_W 320
#define THUMB_MAX_H 240

/** Starts the codec engines. Failure is not fatal to a capture: a camera that
 * cannot make thumbnails still takes photographs, and every reader treats a
 * missing THUMB.JPG as absent rather than broken. */
esp_err_t thumb_init(void);
bool thumb_ready(void);

/**
 * Decode `jpeg`, scale it to fit THUMB_MAX_W x THUMB_MAX_H and write `path`.
 *
 * `jpeg` is the full-size frame as it came off the node — the same buffer
 * that is about to be written to the card, so no file is read back.
 */
esp_err_t thumb_write(const uint8_t *jpeg, size_t len, const char *path);

/**
 * Decode a stored JPEG into an RGB565 tile, scaled to fit and centred.
 *
 * The on-device gallery draws through this. `tile` must hold tile_w * tile_h
 * pixels; the parts the picture does not cover are filled with `pad` so a
 * 4:3 frame in a squarer tile has a deliberate border rather than whatever
 * was in the buffer before.
 *
 * Reads THUMB.JPG happily, and a full-size frame just as happily - a capture
 * from firmware that had no thumbnails is slower to show, not unshowable.
 */
/**
 * Bytes to allocate for a `tile_w` x `tile_h` RGB565 PPA destination.
 *
 * The PPA is a DMA engine and it validates BOTH the buffer pointer and the
 * declared buffer size against the cache line, so a tile needs 64-byte
 * alignment AND a size rounded up to 64. Getting only the pointer right is
 * what a bench session cost: 208x156 is 64896 bytes, an exact multiple of 64,
 * so gallery tiles worked, while 520x390 is 405600 - 6337.5 lines - and the
 * full-screen photo kept returning ESP_ERR_INVALID_ARG with no other symptom
 * than a blank frame.
 *
 * Allocate with heap_caps_aligned_calloc(64, 1, THUMB_TILE_BYTES(w, h), ...).
 */
#define THUMB_CACHE_LINE 64u
#define THUMB_TILE_BYTES(w, h)   ((((size_t)(w) * (size_t)(h) * 2u) + (THUMB_CACHE_LINE - 1u)) & ~(size_t)(THUMB_CACHE_LINE - 1u))

esp_err_t thumb_load(const char *path, uint16_t *tile, int tile_w, int tile_h, uint16_t pad);

/**
 * Like thumb_load, but placing the frame with a calibration alignment: crop the
 * source to the overlap all four lenses cover, shifted by camera `cam`'s stored
 * offset, and scale that crop to FILL the tile. The result is that the subject
 * sits still across the swing instead of lurching between the four lens
 * positions - the same crop and shift the worker bakes into a Roll's WebP,
 * because both sides compute it from pure_align_plan() (packages/media's
 * alignment.ts). `offsets` is cam1..cam4 at PURE_WIGGLE_FRAMES_MAX entries.
 *
 * The caller uses this ONLY when the offsets actually move a frame; the plain
 * thumb_load is the path for every capture today. Kept a separate function from
 * thumb_load rather than a shared core with a crop flag, deliberately: the
 * fit-and-centre path is exercised by neither the host tests nor host_preview
 * (which stubs this file) and runs only on hardware, so it must not be disturbed
 * to add a path that no capture on any current card takes.
 */
esp_err_t thumb_load_aligned(const char *path, uint16_t *tile, int tile_w, int tile_h, uint16_t pad,
                             const pure_cam_offset_t *offsets, int cam);

#endif
