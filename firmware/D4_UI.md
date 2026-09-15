# KINO D4 — the interface

This is the interface, not a theme on top of one. The previous system is in
git history and nothing is kept from it for continuity; what survives is the
drawing code underneath — the blitter, the type rasteriser, the font — because
those are the panel, not the design.

The camera has four lenses. Everything below follows from that one fact.

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

**Graphite ground — the camera.** Live view, capture, playback, ROLL, LOOK,
LINK. The photograph is the brightest thing on the panel and everything else
gets out of its way. Pale type on near-black.

**Paper ground — the machine.** SETUP, diagnostics, calibration, card,
information, confirmations. Dark type on warm off-white, dense, printed, like
the panel of a piece of equipment. No photograph here, so no reason to be dark.

Crossing between them is a hard cut. That cut is the transition: you are
either in the camera or in the machine, and you always know which.

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

Vertical rhythm is 24. The head strip is 34 tall and only exists where a
screen needs a name; the camera does not need one. The foot strip is 30 and
carries the mundane facts — count, card, battery — in XS.

The four-column grid is also the ROLL page (four across), the four feeds (four
adjacent verticals, gutterless), the diagnostics columns and the settings
value column. One measure, used everywhere.

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

Numerals are the recurring objects. `1 2 3 4` appear at XS above the marks, at
S in a list, at MB in a count. They are always the same numerals.

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

## 10. Screens

The set, in the order a user meets them.

```
   1  boot                    the four come up, then the camera
   2  live view               four feeds, almost nothing else
   3  shutter                 one inverted frame
   4  capture                 the four marks filling on real arrivals
   5  processing              MAKING IT and ten blocks
   6  playback                the wiggle, looping, full width
   7  ROLL                    four across, indexed
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

Sixteen of them are the same handful of objects rearranged: the four marks,
the grid, the blocks, the two grounds, five type sizes. That is the point. A
product with a language does not need a new drawing for every screen.
