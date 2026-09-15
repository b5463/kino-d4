# KINO D4 — the interface

This is the interface, not a theme on top of one. The previous system is in
git history and nothing is kept from it for continuity; what survives is the
drawing code underneath — the blitter, the type rasteriser, the font — because
those are the panel, not the design.

The camera has four lenses pointed at one instant, and what it makes moves.
Everything below follows from that.

---

## 0. The one fact

KINO does not have four lenses the way a phone has three. It has four lenses
pointed at the same instant from four places a few millimetres apart, and what
it makes out of them **moves**. That is the whole product. No other camera's
photographs wiggle.

Which gives the rule the rest of this document is built on:

> **KINO has no still images.**
>
> Everywhere a photograph appears — the live view, a roll thumbnail under the
> cursor, an opened file, a look preview — it is playing. The only still
> things in this product are the machine screens, and that difference is how
> you know which half of it you are in.

The live view is therefore already a wigglegram: one frame filling the panel,
cycling 1 2 3 4 3 2 through the camera's own `pure_wiggle_sequence()` at the
rate the photograph will play at. You are not framing a still that will later
be turned into a wiggle. You are looking at the wiggle, and composing for the
parallax you can see moving.

Two other arrangements were built and judged against it. **SPREAD** — the
aiming lens sharp with the other three ghosted over it, so near objects triple
and far ones do not — turned out to be a check rather than a home: it answers
"how much wiggle will this composition have" and it degrades the picture to do
it, so it is what the camera shows while a button is held. **SHEETS** — the
four as fanned prints — was charming and cost a third of the framing area,
which is not a trade a camera gets to make.

---

## 1. Four

```
1   2   3   4
●   ●   ●   ●
```

This object is KINO's signature and its native sentence. It is not decoration
and it is not a logo: it is the camera reporting on itself, and it means the
same thing everywhere it appears. Four numerals, four marks under them, one
mark per lens, always in hardware order.

The mark has five states and they are the whole vocabulary:

| mark | drawn | means |
|---|---|---|
| `●` | filled disc | ready, answered, captured, ok |
| `○` | ring | waiting, not yet, empty slot |
| `◐` | half disc | warming, syncing, part way |
| `■` | filled square | busy — calibrating, writing, charging |
| `✕` | cross | not answering, failed |

The same row is the live view's readiness, the capture's progress, the
processing indicator, the diagnostics page and the calibration screen. A user
who learns it once has learned the camera. Nothing else in the interface is
allowed to use these five shapes for anything else.

**Four is also the count of places.** The camera is home; the four places you
can go from it are numbered, in the same order, in the same type:

```
1 ROLL     2 LOOK     3 LINK     4 SETUP
```

So `1 2 3 4` addresses lenses *and* destinations, and a keypad press means the
same thing in both registers.

Where four is genuinely the shape of the data — feeds, frames, channels,
temperatures, a page of thumbnails — use four. Where it is not, do not force
it. A list of eight settings is a list of eight settings.

---

## 2. The two grounds

KINO has two registers and they are told apart by which way round they are.

**Graphite ground — the camera.** Live view, capture, playback, an opened
photograph, LOOK, LINK. The photograph is the brightest thing on the panel and
everything else gets out of its way. Pale type on near-black.

**Paper ground — the machine.** SETUP, diagnostics, calibration, card,
information, confirmations. Dark type on warm off-white, dense, printed, like
the panel of a piece of equipment. No photograph here, so no reason to be dark.

**Paper ground — the page.** ROLL, and only ROLL. A roll of film is not a
screenful of controls, it is a set of prints, and a set of prints belongs on
stock. See §10a.

Crossing between them is a hard cut. That cut is the transition: you are
either in the camera, in the machine, or looking at the page — and you always
know which. Opening one photograph out of ROLL crosses from the page back to
the camera, which is why an opened photograph is on graphite and fills the
panel: on the page it was a print among prints, and now it is the picture.

```
  PAPER   #ECEAE4   warm off-white      machine ground, camera ink
  GRAPH   #17181A   near-black          camera ground, machine ink
  DIM     60% toward the ground         secondary type, inactive
  FAINT   35% toward the ground         units, rules, disabled
  COBALT  #1B46C8   selection, connection, an operation in progress
  YELLOW  #F2C01E   capture, readiness, a photographic event
  RED     #C8281E   a real error, a destructive action
```

Cobalt, yellow and red are events, not palette. Most screens show none of
them. Two on screen at once is already unusual; three is a bug.

---

## 3. Grid

800 × 480, 4.3 inch, 217 ppi.

Four columns, because of course four:

```
margin 16 │ col 186 │ 8 │ 186 │ 8 │ 186 │ 8 │ 186 │ margin 16
          └ 109 ────┴─── 303 ──┴─── 497 ──┴─── 691 ┘   centres
```

Vertical rhythm is 24. The top band is 40 and the foot band 44; everything
else lives between them.

The four-column measure is the ROLL page (four across), the four cells of the
camera's top band, the diagnostics columns and the settings value column. One
measure, used everywhere.

---

## 4. Type

BIZ UDPGothic, baked at the exact pixel sizes used. It is a Japanese universal
design gothic — drawn to be legible small on equipment, not to be fashionable.

```
  XS  16   units, indexes, metadata, the small print on the machine
  S   22   body, list rows, labels
  SB  22   the value in a row, a selection, a fact that matters
  M   34   a screen's name, a number the user is meant to read across the room
  MB  34   the count, the state word, the one thing on the screen
```

No size above 34. Nothing is set large for effect; if something needs
emphasis it is bold, inverted, or alone — not enormous.

Numerals are not set in this face at all. They are drawn — see `d4_font.h` —
because they are the recurring objects in this interface and a downloaded text
font is what makes an embedded panel look like a web page. The rule that falls
out: **numbers are objects and are drawn; words are labels and are set,
tracked out, in small caps.** They never look like each other.

Text over a photograph carries a two-pixel dark contour, because the ground
underneath it is unknown and may be a blown-out window. Text on either flat
ground does not.

---

## 5. Marks, boxes and small drawn things

Icons are bitmaps on a 16 × 16 grid, one bit per pixel, drawn for this panel
and no other. They are not from a library and they do not scale. There are
only as many as the camera actually needs:

```
  flash        a bolt, four pixels wide at the waist
  flash off    the same bolt with a stroke through it
  battery      a box, a tip, and up to four bars inside it   ← four again
  card         a box with the top-right corner cut
  link         two brackets facing each other
  arrow        a three pixel triangle, right or down
  lock         a box with a staple over it
  warning      a triangle with a bar
```

Everything else is rectangles and discs drawn in code: rules 1px, selection a
filled rectangle with the type knocked out of it, progress a row of blocks.

**Progress is blocks, never a bar and never a spinner.**

```
  ■■■■■■■□□□
```

Ten blocks, 14 × 10, 4 apart. Blocks fill left to right and the count is real
— frames written, files sent, cameras answered. A process that cannot report
its own progress does not get blocks; it gets a word.

---

## 6. Motion

Fast, stepped, and mostly absent. There are six moves and nothing else:

```
  appear      one frame, nothing fades in
  disappear   one frame
  invert      ink and ground swap for 2 frames, then swap back — a press
  blink       on 6, off 6 frames, for attention that must be refused
  wipe        a reveal in four steps, left to right, one column each
  advance     a discrete step to the next position, no interpolation
```

Nothing eases. Nothing springs. Nothing floats. A transition that takes longer
than 200 ms is wrong, and most take 60.

The exception, and the only expressive motion in the product, is the four
cameras answering at capture. That gets its own budget and its own section.

---

## 7. Capture — the characteristic interaction

Shutter down. The panel inverts for one frame — the whole screen, white — and
that is the shutter. Then the four marks report, one per lens, as each frame
actually arrives:

```
1   2   3   4          1   2   3   4          1   2   3   4
●   ○   ○   ○          ●   ●   ●   ○          ●   ●   ●   ●
```

The marks fill on the real arrival, not on a timer. Four sensors on four
mounts do not agree, so the row fills unevenly and that unevenness is true.

Then processing, which is the camera doing arithmetic and saying so:

```
        MAKING IT
        ■■■■■■■□□□
```

Then the wiggle plays, immediately, full width, looping. No word, no
congratulation. The photograph is the reward. If something is worth saying —
rarely — one dry word appears in the corner and leaves:

```
  GOOD.    NICE.    OK!    KEEP IT    AGAIN    DONE    4/4
```

Restraint is the rule. Most captures are silent. KINO is not a mascot and it
does not applaud.

---

## 8. Navigation

The camera is home. It is not one of five tabs; it is where you live.

```
       live view
            │  MENU
            ▼
  1 ROLL  2 LOOK  3 LINK  4 SETUP        ← a strip, over the picture
            │
            ▼
       the place, then BACK to the camera
```

The menu strip is temporary: it appears over the live view, takes a numbered
choice, and is gone. Pressing MENU again dismisses it. Every place returns to
the camera with one press of BACK, from any depth.

The shutter works from anywhere. If the user is in SETUP and presses the
shutter, they get a photograph — the camera is the point.

---

## 9. Sound

Six cues, short, synthetic, and paired with something visible. The interface
is designed with them, not decorated by them.

```
  ready       one short tick when the fourth camera comes up
  move        a click per row, menu movement
  confirm     a two-step tick, a selection taken
  shutter     the mechanical one, on the inverted frame
  complete    a rising pair on the fourth mark filling
  error       a low double, with red
```

`complete` and `error` are the two that must never be missed; the rest may be
off. Sound is not a substitute for a visible state.

---

## 9a. What the bands are

Screens are built from full-width solid ink with the type knocked out of it,
not from hairlines with grey text between them. A band is a structural fact:
it says where the picture stops and the machine starts, and it says it at full
contrast on a panel that gets read in a dark room and in direct sun on the
same evening.

The top band on the camera is divided into four cells, one directly over the
part of the picture its lens made — so the chrome is not a caption about the
four cameras, it **is** them. The cell of the lens currently on screen is
lit, so the band sweeps in time with the picture: the chrome moves because the
photograph moves.

The foot band carries the mundane facts on the camera, and on the machine it
says what the screen is for and the way out. Colour lives in the band and
almost nowhere else: black is neutral, cobalt is an operation in progress, red
is something about to go wrong or be lost, yellow is a photographic event.

---

## 10. Screens

The set, in the order a user meets them.

```
   1  boot                    the four come up, then the camera
   2  live view               four feeds, almost nothing else
   3  shutter                 one inverted frame
   4  capture                 the four marks filling on real arrivals
   5  processing              MAKING IT and ten blocks
   6  playback                the wiggle, looping, full width
   7  ROLL                    a page of prints, on stock
   8  ROLL item               one photograph, its facts
   9  LOOK                    the picture, the looks as a strip
  10  LINK                    the code, the address, who is on
  11  transfer                blocks and a count
  12  SETUP                   a dense list on paper
  13  cameras                 the four, with what each is doing
  14  calibration             the four, being brought into line
  15  flash charging          a square mark and blocks
  16  storage warning         paper, a count, a number in red
  17  camera failure          a cross in the row, and what it means
  18  confirm                 paper, two choices, the destructive one on the right
```

### 10a. ROLL is a page

Everything else in this product is a screen. ROLL is a page, and it is
composed the way a print series is rather than the way a file browser is:

```
  ┌ 14 ─────────┐                              ┌──────────────┐
  │ cut by the  │                              │ ┌──────────┐ │
  └ margin ─────┘                              │ │   Roll   │ │
   09    ┌────────────────────────────┐        │ ├──────────┤ │
  wiggle │                            │        │ │ FILES 22 │ │
  4/4    │   the lead, and it plays   │        │ │ PAGE 2/4 │ │
         │                            │        │ │  ◄    ►  │ │
         └────────────────────────────┘        └─┴──────────┴─┘
                                                  ┌────────┐
  KINO D4  10% CARD                               └── 10 ──┘
                                                    ┌─────┐  ← smaller
                                                    └─ 11 ┘     on purpose
```

What is taken from the woodblock print: **asymmetry** — nothing is centred
and no two blocks are the same size, so the eye is given an order to read in
rather than a field to scan. **Cropping** — the neighbour runs off the left
edge, which says the roll continues past the page better than an arrow would.
**Layered planes** rather than a grid. **Ma** — the empty corner is what makes
the rest legible and filling it is the mistake. **The cartouche** — a ruled
title panel in a corner instead of a masthead, and since it is the only piece
of furniture on the page it is also the only control: the page turns along its
bottom edge. **The seal** — pressed two thirds onto a print the camera has
been told to keep and one third onto the stock, the way a hand does it.

The seal's carved mark is the four. That is the part that makes this KINO's
page and not borrowed japonisme, and it is why none of the costume comes with
it: no waves, no blossoms, no brushwork, no paper texture, no registration
offset. Those would be the "fake CRT" move under a different flag.

The lead plays, because §0 does not have an exception for thumbnails. Tapping
another print makes it the lead — which is what starts it playing — and
tapping the lead opens it. A roll is browsed by looking.

---

Sixteen of them are the same handful of objects rearranged: the four marks,
the grid, the blocks, the two grounds, five type sizes. That is the point. A
product with a language does not need a new drawing for every screen.
