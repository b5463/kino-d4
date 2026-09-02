/**
 * The parts of the P4 firmware that are arithmetic and string handling, with
 * no ESP-IDF dependency — so they can be compiled and tested on a workstation.
 *
 * Everything here was previously inline in `capture.c`, `storage.c`,
 * `thumb.c` or `clock.c`, where it could not be reached by a test: those files
 * pull in FreeRTOS, the JPEG codec, the PPA, SDMMC and NVS, and compiling any
 * of them on a host means shimming a driver stack to test a division.
 *
 * The two worst defects this firmware has shipped both lived in functions of
 * exactly this shape:
 *
 *   - `capture_quality_to_sensor()` mapped a 60..95 percentage onto a sensor
 *     scale where lower is better, and for a while did not: asking for the
 *     best quality produced the worst JPEG the sensor can make. Both numbers
 *     were in range for the other scale, so nothing could detect it.
 *   - `media_summary()` read META.JSON keys that had never existed, so every
 *     gallery listing reported every capture as a wiggle taken at the epoch,
 *     from fallbacks that looked like deliberate defaults.
 *
 * Neither is a hardware problem, neither needs a camera, and neither was
 * catchable by any test the repository had. That is what this module is for.
 * The callers keep their public APIs and delegate here, so there is exactly
 * one implementation of each rule.
 *
 * Rules for this file: C99, no ESP-IDF headers, no allocation, no I/O, no
 * globals. If something here needs any of those, it belongs in its own module.
 */
#ifndef P4_PURE_H
#define P4_PURE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Convert the host-facing quality percentage to the OV3660's scale.
 *
 * `jpegQuality` is documented 60..95 across the KDP contract and Studio's
 * sliders, where **higher is better**. `esp32-camera`'s `set_quality()` takes
 * **5..63, where lower is better**, and the camera node clamps to that.
 *
 * 60..95 maps onto 20..5. Both ends are deliberate: 5 is the best the driver
 * accepts, and quality numerically above 20 on this sensor produces visible
 * blocking on skin — the one subject this camera exists for.
 *
 * Returns 0 for "not specified", which the node reads as "keep your own".
 */
int pure_quality_to_sensor(int percent);

/* The node's own clamp on the JPEG-quality register (esp32-camera
 * set_quality(), mirrored in camnode/main/camera.c). Repeated here because the
 * value META records has to be the value the node wrote, clamp included. */
#define PURE_SENSOR_QUALITY_MIN 5
#define PURE_SENSOR_QUALITY_MAX 63

/**
 * One decision for both halves of a frame's JPEG quality: what the CAPTURE
 * command carries, and what META.JSON must record.
 *
 * There are two writers of the sensor's quality register and they are not the
 * same command. NL_CMD_SENSOR writes it before the trigger from the look's
 * value; NL_CMD_CAPTURE writes it as a side effect when the request carries a
 * `quality` field - and so does the viewfinder, which is a capture loop
 * (viewfinder.c). So the register at exposure is whichever of the two wrote it
 * last, and META has to say what the frame was ENCODED at rather than what
 * anyone asked for. Keeping the two answers in one function is the point:
 * capture #2 was encoded at preview quality while META reported the look's,
 * because the two lived in different places and drifted (audit FW-1).
 *
 *   `sensor_owns`      - NL_CMD_SENSOR has a quality standing in this camera
 *                        and nothing has overwritten it since.
 *   `applied_quality`  - what the node reported it accepted for that apply,
 *                        sensor scale; 0 when there is none.
 *   `mode_quality`     - the mode default the CAPTURE would carry, sensor
 *                        scale, already through pure_quality_to_sensor(); 0
 *                        means the settings envelope names no quality.
 *
 * `*cap_quality` 0 means OMIT the field, which is how the node is told to
 * leave the register alone. `*record_quality` 0 means nothing is known about
 * the register, and META must then write no `quality` at all rather than a
 * plausible number - see the absent-not-zeroed rule in meta.c.
 *
 * Either out pointer may be NULL.
 */
void pure_frame_quality(bool sensor_owns, int applied_quality, int mode_quality,
                        int *cap_quality, int *record_quality);

/**
 * Exposure bias in EV to the OV3660's `ae_level`.
 *
 * Studio and the QUAD slots carry `exposureBias` as -2.0..2.0 in 0.1 steps.
 * The sensor's AEC target offset is an integer, and node_link.h fixes the wire
 * at -2..2, so this is a round-to-nearest with a clamp and nothing more.
 *
 * Half-steps round AWAY from zero: -1.5 EV is -2, +1.5 EV is +2. The
 * alternative (toward zero) makes the two extremes of the slider unreachable
 * from the half-step the UI can actually produce.
 *
 * The clamp is not decoration. A look document is a file on the card and an
 * upload from Studio, so a value outside the slider's range does arrive, and
 * ov3660's set_ae_level REFUSES anything past its own limits rather than
 * clamping - a refused write leaves the previous exposure in place and the
 * photograph is silently taken at the last camera's setting.
 *
 * A NaN returns 0: it is not an exposure, and 0 is the sensor's own metering
 * target rather than a guess in either direction. Written as `ev != ev`
 * because this file may not include math.h - the host test links without libm.
 */
int pure_ev_to_ae_level(double ev);

/**
 * A QUAD slot's `gain` word to a gain-ceiling X-FACTOR for NL_CMD_SENSOR.
 *
 * Three words and one non-value:
 *
 *   "auto" -> 0, meaning DO NOT SEND the field at all. The slot is saying
 *             "leave the AGC where it is", which on this link is an absent
 *             field, not a number. 0 is not a legal gainceiling_t x-factor
 *             (the ladder starts at 2X), so it cannot be confused for one.
 *   "low"  -> 4  (GAINCEILING_4X)
 *   "high" -> 32 (GAINCEILING_32X)
 *
 * Anything else, including NULL and an empty string, is 0. A slot carrying a
 * word this firmware does not know must not silently become a gain setting.
 *
 * Why 4X and 32X out of sensor.h's 2X..128X ladder. The use case is a party in
 * a dark room, and the two words mean opposite things about what to sacrifice.
 * "low" is the clean one: 4X caps the AEC's gain so it lengthens exposure
 * instead of amplifying, which is the right trade on a static subject and the
 * only way this sensor produces skin without chroma noise. 2X was rejected as
 * the "low" step because it starves the AEC badly enough indoors that faces go
 * to black, which is not a cleaner photograph, it is no photograph. "high" is
 * bright-at-any-cost: 32X gets an exposure out of a room lit by one lamp and
 * accepts the noise. 64X and 128X were left off the top for the same reason 2X
 * was left off the bottom - past 32X the OV3660's output is grain with a face
 * somewhere in it, and a control that produces an unusable picture at one end
 * is a control nobody trusts at the other.
 */
int pure_gain_to_ceiling(const char *gain);

/**
 * Parse a "WIDTHxHEIGHT" resolution string.
 *
 * Strict: the whole string must be consumed, both dimensions must be present
 * and non-zero, and neither may exceed 4096. Returns false and leaves the
 * outputs untouched otherwise, so a caller can distinguish "did not
 * understand" from "understood as zero" — a zero would size a space
 * reservation to nothing, which is the one wrong answer here.
 */
bool pure_parse_resolution(const char *s, uint32_t *width, uint32_t *height);

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Fixed costs a capture folder carries beyond its frames. */
#define PURE_RESERVE_THUMB_BYTES (64u * 1024u)
#define PURE_RESERVE_META_BYTES (8u * 1024u)
#define PURE_RESERVE_MARGIN_BYTES (1024u * 1024u)

/**
 * A conservative upper BOUND on what one capture will occupy — not an
 * estimate.
 *
 * An estimate that is usually right still lets a capture start that cannot
 * finish, and a capture that dies at frame three has already written frames
 * one and two. The bound is struck at 0.5 bytes per pixel per frame: observed
 * VGA q12 frames were 0.025-0.1 bpp, so this is several times the expected
 * size. It only ever matters on a nearly-full card, where being generous costs
 * nothing.
 *
 * `frames` is clamped to 1..4. A zero width or height reserves for the largest
 * frame the firmware advertises (2048x1536) rather than for nothing.
 */
uint64_t pure_capture_reserve_bytes(int frames, uint32_t width, uint32_t height);

/**
 * True when `name` is unmistakably a KINO capture directory name: an RFC 4122
 * v4 UUID in lowercase hex — 36 characters, dashes at 8/13/18/23.
 *
 * The orphan sweep deletes things, so this is a shape match on the entire
 * string rather than anything looser. A folder someone put on the card by hand
 * will not match, which is the intent.
 */
bool pure_is_capture_dirname(const char *name);

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/* ------------------------------------------------------------------ */

/**
 * The largest sixteenth that keeps a `w` x `h` picture inside `box_w` x
 * `box_h`.
 *
 * The PPA scales by n/16, so a 1600-wide frame reduces into a 320-wide box by
 * 3/16 and not by the 0.2 that would land on exactly 320 — it comes out 300
 * wide. Always rounds DOWN: rounding to nearest would overflow the box by a
 * few pixels, and the PPA would then write outside the destination.
 *
 * Returns 0 when the picture cannot fit even at 1/16, and when any dimension
 * is zero. 0 means "refuse" — it is NOT a ratio. Returning 1 in that case
 * (which an earlier version did) yields an output larger than the
 * destination, and the PPA writes outside the buffer it was handed.
 * Callers must treat 0 as "no thumbnail", which both current callers already
 * do by rejecting a zero output size.
 */
int pure_scale_sixteenths(uint32_t w, uint32_t h, uint32_t box_w, uint32_t box_h);

/* ------------------------------------------------------------------ */
/* Clock                                                              */
/* ------------------------------------------------------------------ */

/** The window a host-supplied epoch must fall in: 2020-01-01 .. 2100-01-01,
 * in milliseconds. Outside it, the value is a unit mix-up — seconds sent where
 * milliseconds were meant is the classic — and taking it would date every
 * later capture wrongly and persist that across boots. */
#define PURE_EPOCH_MS_MIN 1577836800000LL
#define PURE_EPOCH_MS_MAX 4102444800000LL

/** True when a host-supplied epoch is plausible enough to adopt. */
bool pure_epoch_plausible(int64_t epoch_ms);

/** Clamp a UTC offset to +/- 14 h, returning 0 for anything outside — the
 * device writes "+00:00" rather than guessing a timezone. */
int pure_clamp_utc_offset_min(int offset_min);

/** What clock_init() should do with the time it found. */
typedef enum {
  /** Neither source is usable. Captures are dated from boot until a host says
   * otherwise, and `clockSource` says `unset` so nothing downstream trusts it. */
  PURE_CLOCK_UNSET = 0,
  /** The system clock already holds the better time — leave it alone. */
  PURE_CLOCK_KEEP_SYSTEM,
  /** Push the persisted value into the system clock. */
  PURE_CLOCK_RESTORE_SAVED,
} pure_clock_action_t;

/**
 * Decide between a persisted time and whatever the system clock already reads.
 *
 * Split out here because it is the part worth testing and the only part with no
 * ESP-IDF in it. Two rules, and the second is the one that costs a bench cycle
 * if it is missing:
 *
 *   - A value outside 2020..2100 is not a time. It is a unit mix-up or a stale
 *     key, and adopting one now writes it into the *system* clock, where FAT
 *     timestamps and every capturedAt read it.
 *   - The system clock must never be moved backwards by a persisted value that
 *     is older than what it already reads. The RTC keeps running across a soft
 *     reset, so after a host has set the time, the system clock is the fresher
 *     of the two and NVS holds a snapshot from before the reboot.
 */
pure_clock_action_t pure_clock_restore_action(bool have_saved, int64_t saved_ms,
                                             int64_t system_now_ms);

/**
 * How much a time source is worth, as a number this file can compare without
 * including clock.h.
 *
 * There are four sources and the order is the whole policy:
 * a host at the bench beats the network, the network beats a value carried
 * across a power cycle, and anything beats uptime-since-1970.
 *
 * The numbers are a comparison key, not a stored value — nothing writes them
 * to NVS — so they may be renumbered. clock.c maps its enum onto them.
 */
#define PURE_CLOCK_RANK_UNSET 0
#define PURE_CLOCK_RANK_PERSISTED 1
#define PURE_CLOCK_RANK_NETWORK 2
#define PURE_CLOCK_RANK_HOST 3

/** What clock.c should do with a time some source has just offered. */
typedef enum {
  /** Take it. */
  PURE_CLOCK_ADOPT = 0,
  /** Outside 2020..2100, so it is not a time at all. */
  PURE_CLOCK_REJECT_IMPLAUSIBLE,
  /** A better-sourced time already holds. An SNTP answer must not quietly
   * overwrite a wall clock a bench operator has just set by hand. */
  PURE_CLOCK_REJECT_RANK,
  /** Same rank or lower, and taking it would move the clock backwards. */
  PURE_CLOCK_REJECT_BACKWARDS,
} pure_clock_adopt_t;

/**
 * Decide whether to adopt `incoming_ms` from a source of `incoming_rank` when
 * the clock currently reads `current_ms` from a source of `current_rank`.
 *
 * Two rules, and they are not the same rule:
 *
 *   - A HIGHER-ranked source may move the clock in either direction. That is
 *     what a correction is, and it is what clock_set() has always done for a
 *     host: a persisted time that is wrong by a year has to be fixable.
 *   - An EQUAL-ranked AUTOMATIC source may never move the clock backwards. A
 *     second SNTP sync reading 200 ms earlier is noise, and adopting it would
 *     let one capture be dated before an earlier one — the property the
 *     gallery actually depends on. A host at the same rank is exempt: that is
 *     a person typing a time in, and it is how a clock that is wrong the
 *     other way gets fixed.
 *
 * Same discipline as pure_clock_restore_action(), which is the boot-time case
 * of the second rule; this is the running case and covers all four sources.
 */
pure_clock_adopt_t pure_clock_adopt_action(int current_rank, int64_t current_ms,
                                           int incoming_rank, int64_t incoming_ms);

/**
 * Format an instant as ISO 8601 with an explicit offset, e.g.
 * "2026-08-27T14:02:11+02:00".
 *
 * `epoch_ms` is UTC; `offset_min` is added before formatting so the printed
 * wall time is local, and the offset is appended so the instant stays
 * unambiguous. Always writes a syntactically valid timestamp — whether it
 * means anything is what `clockSource` is for.
 *
 * Self-contained civil-time arithmetic rather than gmtime_r, so the same code
 * runs on the host test and the device with no libc or timezone dependence.
 */
/**
 * Bounded string copy that always terminates. Returns the length of `src`, so
 * a return >= `cap` means the result was truncated.
 *
 * This exists because `strlcpy` is not C99. ESP-IDF's newlib provides it, so
 * the firmware links fine and the host tests do not: compiling a shared source
 * with `-std=c99` on glibc gives an implicit-declaration error, which under
 * `-Werror` stops the build. `roll_queue.c` is compiled both ways, and that is
 * exactly what broke `test-queue` and `test-store`.
 *
 * `strncpy` is not the answer either, and that is why the `strlcpy` calls were
 * introduced in the first place: it does not terminate on truncation, and at
 * -O2 GCC proves the truncation is possible and refuses the build under
 * `-Werror=stringop-truncation`. So the two obvious options each fail on one
 * side of the same source file.
 *
 * Deliberately not a `#define strlcpy` shim or a `-D_GNU_SOURCE`: the first
 * hides which implementation is in use, and the second buys one function by
 * changing the dialect of every file that includes this header.
 *
 * NULL-safe on both sides, and `cap` of 0 writes nothing.
 */
static inline size_t pure_strcopy(char *dst, size_t cap, const char *src) {
  const char *s = (src != NULL) ? src : "";
  size_t len = 0;
  while (s[len] != '\0') len++;
  if (dst == NULL || cap == 0) return len;
  const size_t n = (len < cap - 1) ? len : cap - 1;
  for (size_t i = 0; i < n; i++) dst[i] = s[i];
  dst[n] = '\0';
  return len;
}

void pure_format_iso8601(int64_t epoch_ms, int offset_min, char *out, size_t cap);

/* ------------------------------------------------------------------ */
/* Wi-Fi credentials                                                  */
/* ------------------------------------------------------------------ */

/** 802.11 caps an SSID at 32 octets. */
#define PURE_SSID_MAX 32
/** WPA-PSK's own floor. Shorter is not a weak passphrase, it is not a
 * passphrase — wpa_supplicant will refuse it. */
#define PURE_WPA_PASSPHRASE_MIN 8
/** WPA-PSK's ceiling for the ASCII form. */
#define PURE_WPA_PASSPHRASE_MAX 63

/**
 * True when `ssid` is a usable SSID: 1..32 octets, no control characters.
 *
 * Control characters are rejected rather than sanitised. An SSID is compared
 * byte-for-byte against scan results and used as an NVS key suffix; silently
 * rewriting one produces a saved network that can never match the AP it was
 * saved for. Anything else — including invalid UTF-8 and emoji — is accepted,
 * because APs really are named that and the camera's job is to join them, not
 * to have opinions.
 */
bool pure_wifi_ssid_valid(const char *ssid);

/**
 * Whether a `NETWORK_SET` may be accepted, given what the host sent and what
 * is already stored.
 *
 * `keeps_stored` is the case that matters and the one an obvious
 * implementation gets wrong. `NETWORK_LIST` only ever hands the host a mask,
 * never the passphrase, so a host editing a saved network's `autoJoin` has
 * nothing to send back in `password`. An empty passphrase against a network
 * that already has one therefore means "keep it", not "set it to empty" —
 * and checking the length rule before that case makes the keep path
 * unreachable. The reference device has the same ordering, deliberately
 * (packages/test-fixtures/src/MockKinoDevice.ts, NETWORK_SET).
 *
 * `open` networks take no passphrase at all.
 */
bool pure_wifi_passphrase_ok(const char *passphrase, bool is_open, bool keeps_stored);

/** Longest API base URL the firmware will store or use. */
#define PURE_API_BASE_MAX 96

/**
 * Whether `url` may serve as the Roll API base.
 *
 * Accepts `http://host[:port]` or `https://host[:port]` with a non-empty host
 * and nothing after it: the firmware appends `/api/...` paths itself, so a
 * trailing slash or a path here would produce `//api` or a nested path. No
 * `@` - credentials never travel in the URL, whatever the scheme. No spaces or
 * control characters. At most PURE_API_BASE_MAX characters.
 *
 * `http` is accepted here because this validates a stored development
 * override; the compiled production default is https and never passes through
 * a stored value. Whether an http base may be used at all is the caller's
 * policy, not this function's.
 */
bool pure_api_base_ok(const char *url);

/* ------------------------------------------------------------------ */
/* UI health watch                                                     */
/* ------------------------------------------------------------------ */

/**
 * Consecutive one-second ticks a press may stay latched before the watch says
 * so.
 *
 * A finger on a tile is a few hundred milliseconds, and the longest deliberate
 * gesture this UI has is the wake press, which ui_task() already ceilings at
 * 1200 ms. Three seconds is past both, so a latch that survives it is a touch
 * controller that stopped reporting the lift rather than a person pressing.
 */
#define PURE_UI_LATCH_TICKS 3

/** What one tick of the UI health watch found worth saying. At most one. */
typedef enum {
  UI_HEALTH_QUIET = 0,     /* nothing changed that a reader needs */
  UI_HEALTH_STALLED,       /* a frame was due this tick and none came out */
  UI_HEALTH_PRESENTING,    /* the compositor moved again after a stall */
  UI_HEALTH_STALL_ENDED,   /* nothing is due any more; it never did present */
  UI_HEALTH_LATCH_STUCK,   /* a press has outlived any plausible finger */
  UI_HEALTH_LATCH_CLEARED, /* ...and has now let go */
} ui_health_report_t;

/** The watch's carried state. Zero-initialise; the caller owns it. */
typedef struct {
  bool stalled;
  bool latch_stuck;
  uint16_t latch_ticks;
} ui_health_t;

/**
 * One tick of the UI health watch: edges only, never a heartbeat.
 *
 * ## What was wrong (issue #140)
 *
 * The old test was `frames == last_frames`, klogged every second. The UI only
 * presents when something changes, so a settled screen legitimately draws no
 * frames and the line fired forever. Two costs, measured at the bench: it read
 * as a wedged UI task and sent a session chasing a phantom deadlock, and - the
 * real damage - a line a second into a fixed-size klog ring evicted the boot
 * lines someone was about to ask for. A diagnostic that destroys evidence is
 * worse than no diagnostic.
 *
 * ## The rule
 *
 * A stall is "a frame was DUE and none came out", not "no frame came out".
 * `present_due` is the caller's answer to whether this pass was going to
 * present, so an idle screen is idle rather than stalled. And it is reported on
 * the EDGE - once on entry, once when it ends - so a stall that lasts a minute
 * costs two lines instead of sixty.
 *
 * Rejected alternatives, both weaker:
 *   - keep the every-second line and only add the due-a-frame gate: still one
 *     line a second for the whole of any real stall, which is the flood again
 *     exactly when the ring matters most.
 *   - count ticks since the last input or state change: says "idle", which is
 *     true and useless - it cannot tell an idle screen from a UI that stopped
 *     presenting while work was pending, and that is the whole question.
 *
 * ## The latch, and why it is reported first
 *
 * A press held down skips the SHOOT repaint, so on that screen a stuck latch
 * CAUSES the missing present. Reporting the symptom first sends a reader to
 * the compositor; reporting the cause first sends them to the touch driver.
 * The old code logged the latch every second while a finger rested on a
 * button - three lines for a slow tap - so this fires only past
 * PURE_UI_LATCH_TICKS, which no finger reaches.
 *
 * A tick that reports a latch edge does not also evaluate the stall; the next
 * tick does. Two edges in one tick would need two lines, and the stall is
 * still there a second later.
 *
 * ## What this deliberately cannot do
 *
 * Detect a wedged UI task. This runs ON that task, so a task blocked in a draw
 * never reaches it and the only symptom is SILENCE, which is not evidence.
 * That job belongs to a reader outside the task - see `ui_liveness()` and the
 * `ui` object in GET_RUNTIME_STATS.
 */
ui_health_report_t ui_health_step(ui_health_t *h, bool present_due, bool frames_advanced,
                                  bool input_latched);

/* ------------------------------------------------------------------ */
/* Shooting modes                                                      */
/* ------------------------------------------------------------------ */

/**
 * Why this body cannot take a photograph, or NULL when it can.
 *
 * ## What was wrong
 *
 * `GET_MODES` hardcoded `available: false` and "No capture pipeline in this
 * build" for both modes. That was true in Milestone 1B and stopped being true
 * when capture landed in 0.3.0; nobody changed it. Measured on KD4-D121BC
 * running 0.4.17: GET_MODES reported both modes unavailable for want of a
 * capture pipeline, and eleven cases later in the same conformance run
 * CAMERA_CAPTURE stored CAP_000629, one frame, complete, 2980 ms. Every host
 * that asked that camera what it could do was told it could not shoot.
 *
 * ## The predicate, taken from capture_fire() rather than invented
 *
 * capture_fire() refuses a shutter for exactly two reasons that are knowable
 * before the shutter, and it checks them in this order:
 *
 *   1. no card mounted            -> SD_NOT_MOUNTED
 *   2. no online camera with a
 *      capture worker behind it   -> CAMERA_OFFLINE, "No camera answered"
 *
 * So this returns them in the same order, and the reason names the FIRST thing
 * that would stop the shutter - which is what a host needs, because fixing the
 * second while the first stands changes nothing.
 *
 * Two of capture_fire()'s gates are deliberately NOT here. SD_FULL is
 * arithmetic on the frame count and resolution of a capture that has not been
 * requested yet (storage_capture_reserve_bytes), so answering it here would be
 * a bound that is stale by the time anyone shoots. BUSY is a sample of a state
 * that changes between the answer and the shutter, and capture_request()
 * already re-checks it; reporting a mode as unavailable because a capture is
 * in flight would make GET_MODES flicker.
 *
 * ## Why the modes cannot differ
 *
 * capture.c never consults the mode when deciding whether it MAY shoot - only
 * when deciding which look and exposure to put in each sensor. `quad` has no
 * resolution of its own and no camera count of its own: "the four frames of a
 * quad are the same four sensors as a wiggle, shown differently"
 * (capture.c, capture_settings). So the availability of a mode is not a
 * property of the mode at all, it is a property of the body, and reporting the
 * two identically is the truth rather than a shortcut.
 *
 * Rejected: the stricter reading that `quad` needs four online cameras. Nothing
 * in capture.c enforces it - a quad with one camera stores one frame and
 * commits as complete - and advertising a rule the shutter does not apply is
 * the same class of lie as this function exists to remove, pointing the other
 * way. A host that wants to know how many panes it will get reads
 * GET_CAMERA_INFO, which answers per camera.
 *
 * The returned string is a literal and outlives any caller.
 */
const char *capture_unavailable_reason(bool card_mounted, bool any_camera_ready);

/* ------------------------------------------------------------------ */
/* Wigglegram playback                                                 */
/* ------------------------------------------------------------------ */

/** Four lenses, so four frames. */
#define PURE_WIGGLE_FRAMES_MAX 4
/** The longest order any mode produces: a bounce over n frames is 2n-2. */
#define PURE_WIGGLE_SEQ_MAX (2 * PURE_WIGGLE_FRAMES_MAX - 2)

/** 02 §9's speed range, the same numbers packages/media/src/sequence.ts
 * clamps to. The camera's own envelope defaults to 10 (config_store.c), which
 * is what an unreadable or absent value falls back to here. It was 8 until
 * 0.4.23, when a reference wigglegram reel was measured at a frame every
 * 100 ms; 10 is also what MockKinoDevice and packages/media had all along. */
#define PURE_WIGGLE_FPS_MIN 5
#define PURE_WIGGLE_FPS_MAX 15
#define PURE_WIGGLE_FPS_DEFAULT 10

/**
 * KDP's loop vocabulary (WiggleLoop in packages/kdp/src/protocol/types.ts).
 *
 * These are the KDP words, not the media package's. The two vocabularies
 * collide on two of three values - KDP `continuous` is media `sweep`, KDP
 * `sweep` is media `once` (packages/media/src/playback.ts) - and the camera
 * stores the KDP words, so this enum speaks KDP and the mapping is done once,
 * here, rather than being re-derived at every call site.
 */
typedef enum {
  PURE_WIGGLE_BOUNCE = 0, /* out and back, repeating: 0 1 2 3 2 1 */
  PURE_WIGGLE_CONTINUOUS, /* one way, repeating, snapping back: 0 1 2 3 */
  PURE_WIGGLE_SWEEP,      /* one way, ONCE, then hold the last frame */
} pure_wiggle_loop_t;

/** `wiggle.loop` as a word to the enum. Anything unrecognised, including NULL,
 * is BOUNCE: the value comes out of a stored JSON envelope, and a mangled one
 * still deserves the default wiggle rather than a still. */
pure_wiggle_loop_t pure_wiggle_loop(const char *word);

/** True for `wiggle.direction` == "rtl". Anything else, including NULL, is
 * left-to-right, which is CAM1 first. */
bool pure_wiggle_direction_rtl(const char *word);

/**
 * True when `text` nests no deeper than `max_depth` levels of `{`/`[`.
 *
 * cJSON parses by recursion and its own nesting limit is 1000 levels - far
 * more stack than the 3-4 KB tasks this firmware parses on (the gallery's
 * META.JSON, the recipes on the card, the saved config on app_main, a KDP
 * request). A document that fails this is refused before cJSON sees it, so a
 * card edited on a PC or a hostile host cannot overflow a task stack into a
 * reboot loop - and, for the config, cannot be SAVED into a document every
 * boot then fails on. Strings are skipped with their escapes honoured, so a
 * brace inside a value does not count. A NULL text is not ok.
 */
bool pure_json_depth_ok(const char *text, int max_depth);

/** The same over a byte range that need not be NUL-terminated - a KDP payload
 * sits in the decoder's frame buffer with the CRC after it. */
bool pure_json_depth_ok_n(const char *text, size_t len, int max_depth);

/** The depth every untrusted parse in this firmware allows. A kino.capture is
 * three levels; a config envelope with calibration is five. */
#define PURE_JSON_MAX_DEPTH 12

/**
 * The order the frames are shown in, as frame indices 0..3 (C1..C4).
 *
 * This is the device's copy of packages/media/src/sequence.ts, and it must
 * give the same answer: the baked WebP a Roll shows and the picture moving on
 * the camera's own panel are the same photograph, and two orders would make
 * them two. The rules are taken from there rather than re-invented:
 *
 *   - BOUNCE is out and back with neither end repeated - `0 1 2 3 2 1`, length
 *     2n-2. Repeating an end (`0 1 2 3 3 2 1 0`) stalls the swing for two
 *     frame periods at each turn, and the D4's parallax reads as a head
 *     movement; a head that pauses at both extremes looks mechanical.
 *   - CONTINUOUS is one pass, repeating. The snap back from the far frame to
 *     the near one IS the effect.
 *   - SWEEP is the same order as CONTINUOUS. The two differ in whether
 *     playback repeats, not in which frames are shown - which is why the
 *     repeat is a separate output and not a shape in the array.
 *   - `rtl` mirrors the frame POSITIONS (p -> n-1-p) rather than reversing the
 *     array. For the one-way modes the two are the same. For a bounce they are
 *     not: mirroring gives `3 2 1 0 1 2`, which starts the swing at the far
 *     camera and keeps its shape, while reversing gives `1 2 3 2 1 0` - the
 *     same cyclic loop entered half way through a swing, so the frame it
 *     rests on is a middle rather than an end.
 *
 * `present` is a bit mask of the frames that actually decoded, bit i for
 * C(i+1). It is not `frameCount`: a partial capture with three frames may be
 * missing any one of the four, and META records only how many were stored.
 * The frames that are there are wiggled as an n-frame wiggle in camera order,
 * so a capture missing C2 swings C1 -> C3 -> C4 -> C3 rather than holding a
 * gap. That is a shorter swing, which is what it is - the parallax that was
 * not photographed cannot be shown.
 *
 * Returns the length written, or 0 when nothing can be played - no frames
 * present, or `cap` smaller than the order needs. 0 means REFUSE, and the
 * caller shows the still. A single present frame returns 1, which is also a
 * still: the caller treats a length below 2 as nothing to play.
 *
 * `repeats` may be NULL; it is false only for SWEEP.
 */
int pure_wiggle_sequence(pure_wiggle_loop_t loop, bool rtl, unsigned present, uint8_t *seq,
                         int cap, bool *repeats);

/** Milliseconds one frame is held, from `wiggle.fps`. Clamped to 5..15 fps
 * rather than rejected, for the same reason media's clampWiggleFps() clamps:
 * the number comes from a slider or a stored preference, and one a little out
 * of range is a stale client, not a reason to refuse to play. */
int pure_wiggle_period_ms(int fps);

/* ------------------------------------------------------------------ */
/* Wigglegram alignment geometry                                       */
/* ------------------------------------------------------------------ */

/**
 * A port of packages/media/src/alignment.ts - the calibration geometry, as
 * numbers with no pixels in them.
 *
 * The panel plays the four frames straight off the card, at the four physical
 * camera positions ~19 mm apart, so the subject lurches between them. The
 * WORKER that bakes the WebP and MP4 a Roll guest sees does not: it moves each
 * frame by that camera's stored x/y/rotation correction and crops to the
 * overlap they all still cover, so the subject sits still and only the parallax
 * moves. Those two have to be the SAME photograph, so the geometry lives in one
 * place the TS side and this side both mirror rather than each inventing it.
 *
 * This module is the numbers only. Applying them is a PPA source crop + block
 * offset in thumb.c, exactly the engine the thumbnail scaler already uses.
 *
 * Where the offsets come from is the caller's job, and the rule is strict: the
 * capture's own META.JSON if it recorded a `calibration` block, else the live
 * device calibration, else - which is every capture this firmware has written,
 * because it records neither - all zeros, and then every function here is a
 * clean no-op. Never a guessed offset (types.ts, MEDIA_INFO `meta.calibration`).
 */

/** The sensor width the stored x/y offsets are measured against
 * (packages/media/src/alignment.ts SENSOR_BASE_W). */
#define PURE_ALIGN_SENSOR_BASE_W 1600

/** One camera's correction, in sensor pixels at the 1600-wide base; `rot` in
 * degrees. `double` because a scaled offset is fractional (-6 px at a 0.5 scale
 * is -3, but 7 px at 0.375 is 2.625) and the crop rounds it deliberately. */
typedef struct {
  double x;
  double y;
  double rot;
} pure_cam_offset_t;

/** A rectangle in source pixels. */
typedef struct {
  int x;
  int y;
  int w;
  int h;
} pure_crop_t;

/** One frame's move, in source pixels at whatever resolution the plan was asked
 * for: translate by (dx, dy), rotate `rot_deg` about the centre. */
typedef struct {
  double dx;
  double dy;
  double rot_deg;
} pure_frame_xform_t;

/** True when any of the `n` offsets moves a frame at all. False is the answer on
 * every capture today, and it is what lets the caller take the untouched
 * #160 path rather than a crop of the whole frame. */
bool pure_align_has_offset(const pure_cam_offset_t *offsets, int n);

/**
 * The common crop, in source pixels, that every moved frame still covers.
 * Mirrors computeOverlapCrop(): inset each side by the largest offset on that
 * axis (scaled), plus a rotation slack of sin(maxRot) x half-diagonal, plus a
 * 2 px pad; floor to an even size no smaller than 16, centred.
 *
 * `scale` is the source width over PURE_ALIGN_SENSOR_BASE_W - the same number
 * the TS side passes - because the offsets are stored at the sensor base and
 * the crop is wanted at the source's real resolution.
 */
pure_crop_t pure_align_overlap_crop(int w, int h, const pure_cam_offset_t *offsets, int n,
                                    double scale);

/**
 * The whole plan at one source resolution, mirroring alignmentPlan(): scale the
 * stored offsets into per-frame (dx, dy) at this resolution, pass rotation
 * through unscaled, and return the crop those moves leave. `out` receives `n`
 * transforms in offset order and may be NULL to ask for the crop alone.
 *
 * Computed against the ACTUAL decoded frame size at apply time, not a nominal
 * one, so the crop is inside the pixels that really exist - a frame stored at a
 * size other than the look's configured resolution still crops correctly.
 */
pure_crop_t pure_align_plan(int src_w, int src_h, const pure_cam_offset_t *offsets, int n,
                            pure_frame_xform_t *out);

#endif
