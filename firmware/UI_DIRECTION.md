# KINO D4 firmware UI — direction

Branch `feat/native-ui`. This replaces the Windows 98 shell with an interface
native to the camera: first the behaviour (motion, events, sound, the five
modes), then a full visual reset on top of it - a modern embedded interface
with the timing and irreverence of a late-90s Japanese arcade machine, and
nothing that looks retro. The brief, distilled, and the decisions that turn it
into code. Read this before touching `ui.c`.

## The idea

Proprietary firmware for a strange Japanese camera that could plausibly have
existed around 1999–2003. The reference is late-90s Japanese arcade hardware and
consumer electronics — but what is borrowed is **behaviour, motion, timing,
typography and personality**, not visual clutter.

- **At rest: restrained.** A screenshot of the idle interface should not explain
  the product. No permanent themed borders, widgets, fake CRT, status dashboards.
- **In use: expressive.** Character emerges while interacting. The complexity
  lives in the implementation, not in the number of visible things.
- **After long use: slightly surprising.** The camera notices things, rarely.
- **Responsive first, expressive second.** Input is acknowledged in 0–40 ms; the
  visual continues afterwards. Animation never blocks input and never delays a
  completed operation. No fake progress: motion is driven by real firmware
  events (`capture_stage()`, `upload_queue`, `net_link`, `viewfinder_status`).

## Sections

| Mode | 日本語 | English | Backed by (today) |
|---|---|---|---|
| Shoot | 撮影 | SHOOT | viewfinder, capture, look/flash readings |
| Roll | 再生 | ROLL | gallery + photograph + send to Roll |
| Filter | 色 | FILTER | looks (recipes) — full preview + `C01 ノーマル` identifier |
| Connect | 接続 | CONNECT | USB link, Wi-Fi, Roll server, upload queue |
| Setup | 設定 | SETUP | display, sound, storage, about, power |

The display is horizontal (800×480) and the only inputs are the touch panel and
the shutter key (FN exists in the button path but has no GPIO on D4-V1).
Navigation is therefore **horizontal**: a swipe left/right on any non-live
surface moves between modes; the mode title can also be tapped to open the mode
strip. Within a mode, vertical placement is content.

## Motion

`ui_motion.h` is the one motion layer. Every animated thing is an object with
position, velocity, target, scale, rotation, opacity and a timing offset, stepped
once per pass by the clock (`mo_step`, dt in ms). Nothing is keyframed by frame
count.

- Springs (`mo_spring`) for anything that moves to a place: critically damped
  for settling, under-damped (overshoot) for entrances. Parameters are named
  presets (`MO_SNAP`, `MO_SETTLE`, `MO_BOUNCE`), not literals at call sites.
- Eases (`ease_out_cubic`, `ease_out_back`, `ease_in_quart`) for fixed-length
  events with a start and an end (a reaction's entry and exit).
- Parent/child timing: children carry `delay_ms`; a sequence starts them
  together and each one waits out its own offset. Primary reacts at 0 ms,
  dependents at +40–100 ms.
- While anything is live, `ui_pass()` returns `MO_FRAME_MS` (16) instead of its
  idle cadence. `mo_any_live()` is the single question.
- Every sequence is interruptible: a new input retargets objects from where
  they are (velocity kept), it never waits for the previous sequence.

Timing guide (from the brief, adjusted to this loop):

| Event | ms |
|---|---|
| Input acknowledgement | 0–40 (same pass) |
| Small UI transition | 120–250 |
| Mode transition | 180–350 (title 0, secondary +60, incoming with overshoot) |
| Capture impact | 100–250 |
| Japanese reaction | 450–1000, entry faster than exit |

## Visual system

The rule for every pixel: *what should the user be looking at right now?*
Render that. Everything else earns its place. A still of the interface at
rest should undersell it; it makes sense moving.

**Primitives.** Type, image, one solid shape (`disc()`), the line, and motion.
There is no control library: a row is two words, a control is a word that
takes a line under it when pressed, a dialog is the darkened screen with a
question and two words standing on it. Nothing is drawn as a button.

**Ground.** Near-black (`C_GROUND`) under anything that is not a picture;
off-white ink; one dim grey. The picture is full-bleed where there is one.

**Colour is an event, not paint.** Cobalt while something moves (the FILTER
identifier arriving, a transfer going out, a link coming up), yellow for a
capture landing, red for a real failure. Afterwards the screen returns to
ink on ground. One event, one colour; never the palette at once.

**Removed, not replaced:** window chrome, bevels and 3D faces, the Windows
palette, the CRT boot and collapse, the icon sheet, the second (English)
script under every title, the tiny technical captions, the chevrons and
rules between rows, the plated dialog, the pixel-doubled bitmap face as the
interface's voice. Where an element was only there because the old UI had
it, it is gone.

**Each mode has its own spatial structure.** The finder is the picture with
four marks in a corner; FILTER is the picture with its identifier bottom
left; ROLL is a grid on dark ground with the count in the header's right;
SETUP and CONNECT are rows of words; 情報 is denser and technical, and is
allowed to be. Coherence comes from the type, the motion and the timing.

## Type

The interface type is **BIZ UDPGothic** (`ui_font_ui.h`, `tools/mkfont-ui.mjs`,
OFL 1.1): Morisawa's universal-design gothic, rasterised anti-aliased at the
sizes the interface uses and blended per pixel on the device (`ui_type.h`).
Three faces:

| face | size | role |
|---|---|---|
| `UT_S`  | 22 px regular | values, captions, the one line under a picture, 情報 |
| `UT_M`  | 34 px regular | rows, controls, words that act |
| `UT_MB` | 34 px bold | the mode's name, identifiers, notices, reactions |

On the 4.3" 217 ppi panel 34 px is 4 mm of em; 22 px is 2.6 mm. Display
sizes - a reaction thrown at 2–3×, the FILTER identifier at 2×, a word four
ems tall cut by the screen's edge - are `UT_MB` through `ut_fx()`: the string
rasterised once into an 8-bit mask and sampled bilinearly through a
scale/rotation/alpha transform. On this density the softening is a quarter
of a millimetre. `ut_vdraw()` sets a word 縦書き.

The glyph set is what `ui.c` says: every code point in its string literals,
plus ASCII. Adding a Japanese word means `npm run font:ui:bake`; CI's
`font:ui:check` fails on drift. A word from outside that set - a look named
in Studio, a Wi-Fi network - falls back to **Shinonome 16** (`ui_font_jp.h`,
public domain), visibly coarser, on the same baseline, rather than to a hole.

Japanese is the identity, not a caption: one script per word. Latin appears
where it is the identifier (`C02`, `QUAD`, `KINO ROLL`, `USB`, an address).
Operational text stays restrained; transient text can be graphic, and each
kind of word has its own manner (below).

## Events and personality

`ui_events` (in `ui.c`): a small pool of reactions, each `{text, colour, weight,
rule}`. On a successful capture the pool is sampled — weighted, with an explicit
"no reaction" weight, so most shutters are quiet and rare lines stay rare.
Contextual rules (100th frame this session, midnight, wake after idle, all four
nodes reporting the sync edge) are the same table with a predicate instead of a
weight, and fire at most once per session. Adding one is one table row.

One event = one visual idea: one colour (cobalt `#2f70c9`, yellow `#f4c542`,
red `#c83a3a`, off-white), no container, typography only.

One lifecycle, several manners (`react_style_t`): a word **thrown** (oversized,
tilted ±4–12°, a back-ease landing, a drift out: 撮れた！ バッチリ。 完璧。); a
word that **stands still** (cut in, cut out, no motion: よし。 4枚同期); a word
**down the side** in 縦書き, each glyph a beat after the last (いいね。 まだ撮る？);
a word **too big for the frame**, four ems tall and cut by the left edge
(4枚！ 百枚！); a **small** word in the corner that says nothing loudly
(もう一枚？). Not a toast component with variants: five presentations.

Four-camera language: `1 → 2 → 3 → 4`, four marks that collapse to one on sync,
used for capture, transfer and the occasional status event — never a permanent
dashboard.

## Live view

The picture first. Permanent overlay: mode/look/flash reading in one line and
the way out. Everything else is a transient that enters, is readable for
~1.2 s, and leaves: `発光準備`, `同期 OK`, `電池 20%`, `カード残り少`. No modal for
routine status.

## Capture

1. **Immediate**: the shutter pass paints the response (luminance hit + the
   panes freeze) before anything is processed.
2. **Four**: `1 → 2 → 3 → 4` as each node's frame lands (`capture_stage()` +
   per-cam facts), fast enough to be nearly subliminal.
3. **Result**: the frame lands oversized (≈1.06) and settles to 1.0 with a
   small impact, in 100–250 ms; then, sometimes, a reaction.

## What is deliberately not done

No achievements page, badges, XP or counters. No manga bubbles, outlined
lettering, permanent neon, scanlines, cabinet art. No modal acknowledgement for
status. No theatrical delay of real completion.

## Working on it

`npm run dev -w @kino/twin`, open `#screen`, `npm run twin:ui:bake -- --w98`
after each change; WATCH reloads the screen. `firmware/p4/host_preview` renders
every state to PPM for review. A new Japanese word in `ui.c` needs
`npm run font:ui:bake`. `font:ui:check`, `font:jp:check` and `twin:ui:check`
gate CI.

## Where it stands

Landed on `feat/native-ui`, in this order, each filmed in the host preview:

1. Foundations: `ui_motion.h`, Shinonome type (`ui_font_jp.h`, `ui_text_jp.h`), the
   five-mode shell with the header carrying the motion, swipe navigation, the
   mode row. Twin harness on animation frames.
2. The capture as an event: blink, `1 → 2 → 3 → 4` from the pipeline's own
   masks (`capture_frames_in()`), the landing, the word.
3. Notices: edge-triggered status that enters, is read, leaves; the four-dot
   sync prelude; every old tooltip routed through it.
4. FILTER (色): full-bleed picture, `C02 クローム`, per-look transitions; the
   finder's reading line as the place for MODE and FLASH.
5. ROLL (再生): pictures alone on dark ground, vertical page turns, the
   photograph with one line of words under it.
6. SETUP (設定) and CONNECT (接続): rows of words; dialogs as a question and
   two words; the Roll and the link on one screen.

7. Sound with the motion: two cues in `audio.c` beside the tick, shutter and
   warning. `audio_sync()` is two short pitched taps 45 ms apart, shaped like
   the four marks meeting; `audio_done()` is one soft mid tone, the body's only
   single note. A notice carries its cue (`notice_cue`) and plays it on the
   frame the dots meet and the word lands, or as a plain word enters; 4枚同期
   plays the sync cue on the pass the word appears. Both obey `body.sounds.ui`.
8. The remaining contextual events: つながった！ when the link to KINO ROLL
   comes up (an address alone stays "WiFi OK"); 送信済 with the four-dot
   prelude and the done cue when a burst that was going out has all arrived;
   続けよう。 on waking after twenty minutes or more dark; a finger held on the
   glass through the splash boots into 情報, the diagnostic page. There is no
   shutdown line to vary: the camera has no shutdown, it is unplugged.
9. The visual reset. BIZ UDPGothic at three sizes replaces the pixel face as
   the interface's voice (`tools/mkfont-ui.mjs`, `ui_type.h`); the Windows
   palette, the CRT boot and collapse, the icon sheet, the bilingual titles,
   the chevrons, rules, plates and captions are gone. Boot is black and the
   name landing on one spring. The finder at rest is the picture and four
   marks; its words show on entry, on a touch, on a change, and let go.
   FILTER is the picture and `C02 白黒` at 2×, cobalt while it changes. Rows
   are two words. The dialog is the darkened screen, a question, two words.
   Capture and sync marks are discs. Reactions have five manners.
10. Ambient: a screen's first visit this boot lets its rows arrive one after
   another; a revisit is simply there. The finder shows its words longer the
   first time. Screens cut rather than crossfade, except a photograph
   opening from its tile. The Twin and the host preview build the same
   files; `font_ui`, `font_jp` and `twin_ui` checks gate CI.

Still to do: a pass on the physical camera, where the timings above were
tuned on a virtual clock and will need the panel's, and where the two new
sounds have not yet been heard through the speaker (levels are the shipping
shutter's, give or take, and `audio_calibrate()` is there to measure them).
`ui.c` builds clean under the P4 toolchain (ESP-IDF 5.5.1, `-Werror=all`).

## Filming a transition

`firmware/p4/host_preview` has a fake clock and a fake finger. A scene sets
`g_touch_*`, steps `g_preview_clock_us`, calls `ui_pass()` and writes the
canvas as `film_<name>_<ms>.ppm` (the `FILM` macro). The swipe, the mode row,
the capture, the notices, a preset change and a page turn each have one. A
strip of those frames is how every timing in this document was chosen, and a
change in one is a diff CI can see.

