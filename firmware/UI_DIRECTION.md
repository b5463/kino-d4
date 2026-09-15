# KINO D4 firmware UI — direction

**What is built.** `WORLD.md` is the phase that followed this one and it
is done bar the hardware: one persistent photographic world rather than
five screens, a mood layer, and behaviour driven by what the four cameras
actually see. Where the two documents disagree, WORLD.md is the newer.

Branch `feat/native-ui`. The interface is a continuously running visual
system that happens to expose camera controls: very little on the screen,
a great deal underneath. This is the brief distilled, the architecture that
answers it, and how to work on it. Read this before touching `ui.c`,
`ui_present.h` or `behaviors/`.

## The idea

A modern embedded interface with the behaviour, timing and irreverence of a
late-90s Japanese arcade machine. Not retro, not themed, not a reskin.

- **At rest: minimal.** A still of the interface undersells it.
- **On input: immediate.** Acknowledged in the pass that saw it; motion continues afterwards and never blocks input.
- **In motion: authored.** Keyframes, curves, paths, hierarchy, deformation, sound on the frame - not slide/fade/scale/bounce.
- **Under interruption: continuous.** The next motion begins from where the object is, at the speed it has. The user always wins.
- **Over time: surprising.** Behaviours chosen from sets, with rules and rarity, from real state. No achievements, no list; things happen.
- **Underneath: more than shows.** State ≠ behaviour selection ≠ animation ≠ rendering.

English only, for now. If a word says `GOT IT.`, the type, motion, timing,
composition and sound make it interesting.

## Architecture

```
camera state / event            ui.c: capture, cards, links, wake, touch, keys
        │
        ▼
behaviour controller            kbehave.h: kb_event() picks a variant by weight,
        │                        rules (interval, once/boot, once/session,
        │                        avoid-last-N, repeats, rare) and conditions
        ▼                        (shots, flash, sync, quad, idle, hour, first boot)
choreography                    kmo.h: clips of tracks over roles; keyframes with
        │                        per-segment interpolation; curves; paths; time
        │                        warps; sound markers; procedural modifiers
        ▼
scene graph                     kscene.h: nodes (text, image, disc, line, rect,
        │                        group) with channels, parents, masks, ghosts;
        │                        continuity joins every change
        ▼
renderer                        kdraw.h + ui_type.h: inverse-mapped image blit
                                 (crop, asymmetric scale, rotation, skew, strip
                                 deformation, colour separation, lift, desat),
                                 anti-aliased type through a bilinear mask,
                                 discs, capsules, clip rects
```

`ui_present.h` is the presentation: each screen is a SYNC function that
acquires nodes by id and sets their resting pose from state, never their
motion. Motion is the clips' and continuity's. Camera events go through
`ui_event()`; the plumbing never chooses a clip.

### Channels

Every node has x, y, sx, sy, rot, alpha, anchor, skew, tracking, mask rect,
crop rect, colour separation, strip deformation, line width, radius, path
position and four free parameters (p0 lifts an image's luminance, p1
desaturates it). Each is driven independently in time.

value = pose (the screen's) or an absolute track, + additive tracks,
+ continuity offset, + impulses, + procedural modifiers.

### Continuity

Whenever what a channel follows would jump - a clip starts, interrupts
another, ends, or the screen moves a resting pose - the difference and the
object's velocity go into a continuity offset that decays critically damped
(3.5 Hz for position and rotation, 5 Hz for scale, 7 Hz for opacity). A
node whose content changed (a different word, a different picture) is a
different object and snaps. Three mode changes in a second read as one thing.

### Keyframes and curves

A track is any number of keys; each segment chooses `lin`, a named curve
(cubic Bezier, sampled, power), `hold`, `step:N`, `smooth` (Catmull-Rom),
`spring` (analytic underdamped, f Hz and zeta), or `exp` (tau ms). All are
pure functions of clip time, so a film is the camera. A clip can warp its
own clock (rush, stall, release) with a curve.

### Procedural layer

Per node, windowed within a clip and faded in and out: deterministic noise
on position/rotation/scale, line boil, damped oscillation on any channel,
follow (inherit another node's departure from its pose, late). Impulses are
velocity added to the continuity spring. Ghosts draw an image's previous
transforms under it.

### Type as geometry

A text node draws as one shape through the transform, or one glyph at a
time with a char clip and a stagger (arrive letter by letter, one lags,
tracking opens on impact), or revealed by a mask edge. Faces: `UT_S` 22 px,
`UT_M` 34 px, `UT_MB` 34 px bold (BIZ UDPGothic, baked by
`tools/mkfont-ui.mjs` for exactly the glyphs `ui.c` uses).

## Authoring

Choreography is data: `firmware/p4/behaviors/kino.json` (the product) and
`playground.json` (the engine tests). `npm run kmo:bake` writes
`kmo_data.h`; the host preview, the Twin and the camera include the same
header. `npm run kmo:plot` draws every track of every clip as an SVG.
`kmo:check`, `font:ui:check` and `twin:ui:check` gate CI.

A track key is `role.channel` (absolute), `role.channel+` (additive),
`role@path` (along a path) or `role@path~` (orientation on the tangent);
keys are `[t_ms, value, interp?, p0?, p1?]`; a value `"170*p1"` scales by
the instance's parameter (a direction, a distance). Events map to variants:
`{clip, w, texts, avoid_prev, max_repeats, min_interval_s, once_per_boot,
once_per_session, rare, shots_eq, flash, sync_ok, quad, idle_min_s, hour_lt,
first_boot}`.

Roles bind to nodes in `role_node()` (ui_present.h): `label` is the corner
note or, for a capture, the word at the centre; `result`/`finder` the four
panes as one group; `f0..f3` the panes; `g0..g3` the fragments; `m0..m3`
the marks; `image` the LOOK picture; `line` the finder's words; `q`/`a`/`b`
the dialog.

## The playground

`ui_playground.h`, compiled into the host preview and the Twin only. One
scene per capability: keyframes with mixed interpolation, five curves,
spring against exponential, paths with tangent, parent/child with a
following caption, mask reveal and strip assembly, per-glyph entry,
tracking as animation, squash/skew/strip deformation, colour separation,
noise, line boil, damped oscillation, time warp, sound markers,
interruption, layers. The preview films each as `pg_<scene>_<ms>.ppm`; in
the Twin's SCREEN VIEW, PLAYGROUND steps through them on the live screen.

## Films and stress tests

`firmware/p4/host_preview` renders every static state and films
(`film_<name>_<ms>.ppm`): `swipe`, `rapid` (three mode changes faster than
the motion), `strip`, `page`, `photo` (opening from its tile), `dialog`,
`words`, every capture behaviour (`cap_none`, `cap_quiet`, `cap_merge`,
`cap_text`, `cap_cut`, `cap_energy`, `cap_hundred`, `cap_fail`), `capcap`
(a second shutter mid-celebration), `capleave` (leaving the finder while the
result lands), `ctx` (a link event during a mode change), `sync`, `sent`,
`back`, `note`, every LOOK transition, `boot_cold`, `boot_first`, and
`complex` (everything at once, with the renderer's counters on stderr).

## Performance

`s_ks_perf`: step and render microseconds, worst, nodes drawn, clips
active, pixels written, missed frames (over 16 ms), and how many of those
pixels went through the inverse mapping rather than the row copy - several
times the cost each, so `MAPPED` is the figure that says why a frame was
slow. Shown on INFO and through the Twin's `kui_perf`. Stable pacing over
peak rate: the loop asks for 16 ms while anything is live and 20-60 ms
otherwise.

The runtime reads one clock and on the host that clock is a variable the
harness winds by hand, so the cost figures used to read zero there.
`KS_PERF_NOW` is the seam: the device's own timer, the wall on the host.
The preview prints a `[cost]` table per state on every run - good only for
comparing one state with another and for catching a change that made the
work several times bigger, which is exactly what it is for.

## What the interface is now

- **Boot.** Black; the name lands on one spring (first boot ever: one letter
  at a time, then the tracking closes). The finder is posed under it and
  the name lets go through continuity. Short wake: a repaint. Long idle:
  `BACK.` and the finder's words shown longer; the session starts over.
- **Navigation.** One title object, retargeted. `mode_move` (p1 = direction)
  sends the old word out and brings the new one in with momentum;
  interruptible. The mode strip drops under the title on a tap.
- **SHOOT.** The picture and four marks. Title and reading line
  (`WIGGLE   C01 PARTY NEG   FLASH AUTO`) show on entry, touch or change and
  let go. The shutter: white two frames, black three, the four frames back
  13 ms apart, each a touch large. Then a behaviour from the set: nothing;
  a quiet breath; four fragments converging on one frame with the sync cue
  and a squash; a word on an arc that opens its tracking on impact; a hard
  cut; an overshoot with channels separating and a huge word cut by the
  edge; `100` once a session. Silence is common on purpose.
- **LOOK.** The picture; `C02 MONO` at 2x on a change and gone after; each
  change one of: exposure snap, channel settling, smear, wipe, luminance
  pulse, cut, late colour. MONO and the QUAD targets are words.
- **ROLL.** The grid; pages turn on a spring; a photograph opens from its
  tile. **LINK.** With a roll on, the same photographs compress into a
  column at the left edge, the facts step right and down a size, and the
  code opens into the room they make; the photographs are restless while
  the queue is being worked and settle when one lands. There is no progress
  bar and no fraction: the queue cannot say which capture is in flight.
  **SETUP.** Rows, plain, hung from a rule the four live views flatten into
  - the one thing left of the world in the state that strips it away.
  **INFO.** Dense and technical, with the renderer's counters.
- **Colour** is an event: cobalt while something moves or a link comes up,
  yellow for a capture, red for a real failure; ink on ground after.
- **Sound** is a channel: markers in clips; sync and done cues land on the
  frame the picture resolves.

## Still to do

The physical-device pass: LCD response, frame pacing, input latency, the
two cues through the speaker, and every timing above re-tuned on the panel
rather than the host's virtual clock. The numbers to check against are the
preview's `[cost]` table and INFO's `SCENE`, `WORST`, `MISSED`, `PX` and
`MAPPED`. A curve editor beyond `kmo:plot`. Localisation, later.
