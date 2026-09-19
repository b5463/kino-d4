# KINO D4 — the interface

> **Not in the tree.** The interface this describes was reverted on 2026-09-16: the
> camera ships `origin/main`'s shell again. Everything below is kept as the
> record of what was tried and why — the code is in git history at `32cdd19`
> and its parents, and `firmware/p4/main/ui.c` is the interface now.

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

**Graphite — the camera.** Live view, capture, playback, an opened
photograph, LOOK. The photograph is the brightest thing on the panel and
everything else gets out of its way.

**Paper — the machine.** Boot, ROLL, LINK, SETUP, diagnostics, calibration,
card, confirmations. Dark type on warm off-white, printed, like the panel of
a piece of equipment.

Crossing between them is a hard cut, and that cut is the transition: you are
either in the camera or in the machine and you always know which. Opening one
photograph out of ROLL crosses back to the camera, which is why it is on
graphite and fills the panel — on the page it was a print among prints, and
now it is the picture.

```
  PAPER   #EFEADE   warm off-white      machine ground, camera ink
  GRAPH   #1C1A18   warm near-black     camera ground, machine ink
  DIM     27% toward the ground         a row not under the cursor
  FAINT   47% toward the ground         rules, units, a numeral as a heading
  COBALT  #2E4C8A   an operation in progress
  YELLOW  #D8A52B   capture, readiness, a photographic event
  RED     #A83A2E   a real error, a destructive action
```

Cobalt, yellow and red are events, not palette. Most screens show none of
them. Two on screen at once is already unusual; three is a bug.

---

## 3. The module

40 px. The panel is exactly 20 × 12 of them, and the field — one module in
from every edge — is 18 × 10, from (40, 40) to (760, 440).

Every structural edge is a whole number of modules and everything inside one
is centred in it by arithmetic, not by eye:

```
  UT_S / UT_SB   22 px   (40 - 22) / 2 =  9
  UT_XS          16 px   (40 - 16) / 2 = 12
  the drawn face 14 px   (40 - 14) / 2 = 13
```

All three are integers, which is why they are the sizes. Half a pixel of
rounding in a row that repeats eight times is a list that visibly leans, and
at 217 ppi that is visible.

What falls out of it:

```
  eight settings rows        8 × 40   = 320 = the field from 120 to 440
  a roll of eight prints     2 × 160  = 320, a print being 4 modules tall
  a print                    168 × 126, which is 4:3 exactly
  four prints and 3 gutters  4×168 + 3×16 = 720 = the field, to the pixel
  ten progress blocks        30 + 10 gap = one module of pitch
  the value column           6 modules, hung off the right edge of the field
```

The cell is 4:3 because every sensor on this camera is 4:3. A cell of any
other proportion puts a mat down the side of every photograph the camera will
ever take.

---

## 4. The join

Where two rules would meet, they do not. A vertical stops a quarter module —
10 px — short of the horizontal at each end.

That gap is the difference between a drawn table and a made object, and it is
why there are no boxes in this interface: a closed rectangle has four of those
joins and gets all four of them wrong.

The same instinct, applied twice more:

- **Selection is a mark, not a bar.** An 8 px square in the margin beside the
  row, and the row itself going from dim to ink. A filled rectangle with the
  type knocked out of it is loud, it destroys the ground, and on a list of
  eight rows it is the only thing anyone sees.
- **A label sits closer to its value than to the next pair.** Eight pixels up,
  thirty-four down. Four evenly spaced lines read as eight unrelated ones.

---

## 5. Type

BIZ UDPGothic, baked at the exact pixel sizes used. A Japanese universal
design gothic — drawn to be legible small on equipment, not to be fashionable.

```
  XS  16   labels, captions, every word on a machine screen that is not a value
  S   22   a value, a list row, a look's name
  SB  22   a value that is a word
  M   34   the one thing on the screen: a code to read across a room
```

Nothing is set large for effect, so emphasis comes from **tracking** instead.
Two steps and no more: a caption at 2 px, a screen's name at 6. At five or
six letters that is about a module of extra width, and it is what makes a
title a title without setting it any larger.

Numerals are not set in this face at all. They are drawn — see `d4_font.h` —
because they are the recurring objects in this interface and a downloaded text
font is what makes an embedded panel look like a web page. **Numbers are
objects and are drawn; words are labels and are set, tracked out, in small
caps.** They never look like each other.

Text over a photograph is contoured, and the contour is **one pixel at caption
sizes and two at display sizes**. Two pixels under a 16 px face is a fifth of
the cap height: the word stops reading as contoured and starts reading as
outlined, which is the loudest thing on a screen whose whole argument is that
it is quiet.

---

## 5a. The camera's one line

The camera has no top band, no boxes and no rules. The photograph fills the
panel down to y = 440 and the last module is the chrome: shots, flash, mode,
card, on four fixed columns.

The picture's own edge is the line, which is why there is not a drawn one.

It costs a module of picture and it is worth it. The alternative is chrome
laid over the photograph, and type over an unknown photograph has to be
contoured or plated to survive a blown-out window — an outline around every
word, or a sheet of grey glass, either of which is louder than the band it
was avoiding.

The columns are fixed rather than packed left to right: a fact that moves when
its neighbour changes length is a fact you have to read instead of glance at.

**The menu is that same line, in paper, saying something else.** Four numbered
places on one module; it takes a choice and it is gone, and the photograph
behind it does not lose a pixel to it.

---

## 5b. The four, on the top edge

One tick per lens, each centred over the quarter of the picture its camera
made — so the chrome is not a caption about the four cameras, it is them,
standing where they are.

```
  16   the one on screen
  12   answered
   7   warming
   4   not answering
```

Four lengths, each visibly different from the next at arm's length. Two pixels
wide with a one pixel dark surround, because a two pixel mark is geometry
rather than type and a surround is enough to seat it over a photograph.

Because the live view is already a wigglegram, the long tick steps across the
top edge in time with the parallax. It is the only moving chrome in the
product and it costs sixteen pixels at the very top of the frame, where a
photographer has already left room.

---

## 5c. Marks, and progress

The mark has five states and they are the whole vocabulary — `●` ready, `○`
waiting, `◐` warming, `■` busy, `✕` not answering. Nothing else in the
interface may use these five shapes for anything else.

**Progress is blocks, never a bar and never a spinner.**

```
  ■■■■■■■□□□
```

Ten of them, 30 × 12 on a module of pitch, and the count is real — frames
written, files sent, cameras answered. A process that cannot report its own
progress does not get blocks; it gets a word.

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

## 9a. What it is not

Three things were built and thrown away, and they are worth keeping written
down because each of them is the obvious answer.

**Bands.** Full-width solid ink with the type knocked out of it, top and
bottom. It is legible in a dark room and in direct sun, which is a real
argument, and it costs two modules of picture on a body whose entire case is
the picture. The camera keeps exactly one band, at the foot, one module tall
(§5a); every machine screen replaced its bands with a hairline and the space
under it.

**A highlight bar for selection.** On a settings list it is the only thing
anyone sees; over a page of photographs it is louder than the photographs. It
is an 8 px square in the margin now (§4).

**Chrome over the photograph.** Contoured type survives a blown-out window,
but at caption size a contour reads as an outline, and a translucent plate to
sit it on is glass by another name. The picture stops a module short instead.

And one that stays: a period costume. Not waves, not brushwork, not paper
texture, not a fake CRT. The composition and the arithmetic are the idea; a
texture on top of them would be the same mistake in a different decade.

---

## 10. Screens

The set, in the order a user meets them.

```
   1  boot                    the four come up, then the camera
   2  live view               the wiggle, full bleed, one line of chrome
   3  shutter                 one inverted frame
   4  capture                 the four marks filling on real arrivals
   5  processing              MAKING IT and ten blocks
   6  playback                the wiggle, looping, full width
   7  ROLL                    eight prints on a page, one playing
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

### 10a. ROLL

Four across and two down, on stock, with the one under the cursor playing —
section 0 has no exception for thumbnails.

```
  ROLL                                          ‹  2/4  ›
  ───────────────────────────────────────────────────────
  ┌──────┐   ┌──────┐   ┌──────┐   ┌──────┐
  │      │   │      │   │      │   │      │
  └──────┘   └──────┘   └──────┘   └──────┘
   ══════
   09         10         11         12       ▪
  ┌──────┐   ┌──────┐
  │      │   │      │
  └──────┘   └──────┘
   13         14
  ───────────────────────────────────────────────────────
  22 FILES                            FN FOR THE CAMERA
```

Selection is the two pixel rule under the cell and the index going from faint
to ink. Not a highlight: a highlight over a page of photographs is the loudest
thing on the screen, and it is not the photographs. A tap on another print
makes it the cursor — which is what starts it playing — and a tap on the one
under the cursor opens it. A roll is browsed by looking.

The small square at the right end of an index line is the kept flag. It is a
fact about the file, so it is filed with the file's other facts rather than
stamped across the picture.

---

Sixteen of them are the same handful of objects rearranged: the four marks,
the grid, the blocks, the two grounds, five type sizes. That is the point. A
product with a language does not need a new drawing for every screen.
