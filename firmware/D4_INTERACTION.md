# KINO D4 — what the camera is, and who is holding it

Not a style document. The four things that were settled before this was
written, because every previous attempt at this interface failed by guessing
one of them:

1. **The controls are not frozen.** Keys, a switch, a wheel can still be added.
2. **The Windows-era shell is a placeholder.** It is what the camera runs
   today, not what it is.
3. **Guests hold this, at a party, passed around.** Strangers, one-handed, in
   a dark room, with a drink in the other hand and no manual.
4. **The next milestone is production firmware.** It has to ship.

(3) and (4) together decide almost everything below. A camera that has to
survive a stranger AND has to ship is a much smaller design than the one
currently in the tree.

---

## 1. The one decision

**There is no menu.**

The interface today is six equal tiles — SHOOT, LOOK, GALLERY, ROLL,
SETTINGS, POWER — which is a desktop metaphor: a field of peers, any of which
you might want. That is the right shape for a machine one person learns and
the wrong shape for an object handed to someone at a party. A stranger does
not want six choices. A stranger wants to take a photograph, and everything
else on the screen is something between them and that.

So the product splits in two, and the split is physical:

```
  GUEST                                OWNER
  the camera, and nothing else         the camera, and everything else
  four screens                         the roll, the looks, settings,
  no way to change anything            diagnostics, the card, power
  no way to lose anything
```

## 2. The switch

The split is a **physical lock switch on the body**, not a mode in software.

Two positions, labelled on the case. In GUEST the camera is a camera: touch
reaches nothing but the shutter and the last photograph. In OWNER the whole
product exists. A guest cannot find their way in, because there is nothing to
find — the way in is a switch they are not going to flick.

Why a switch rather than a long-press, a code, or a hidden gesture:

- A stranger cannot stumble into it, and the owner cannot forget to leave it.
- It needs no interface at all. A hidden gesture needs to be taught, which
  means a screen, which is the thing being removed.
- It is visible from across a room. You can tell whether the camera is safe to
  hand over by looking at it, which is when you actually want to know.
- It is honest about what it does. A camera that says GUEST on the case is a
  camera you understand without being told.

**This is a hardware ask.** One slide switch and one GPIO, on the answer that
the controls are not frozen. Everything below assumes it; nothing below is
worth building without it.

## 3. What a guest can see

Four screens. Not four sections — four screens, and that is the whole guest
half of the product.

```
  1  AIM        the four lenses, live, and almost nothing else
  2  TAKING     the shutter is down and the four are answering
  3  TAKEN      what was just made, playing, for a couple of seconds
  4  WRONG      the one screen that says the camera cannot do its job
```

Rules that hold across all four:

- **The shutter always takes a photograph.** From any of the four, at any
  moment. There is no state in the guest half where the button does something
  else, and no state it cannot interrupt.
- **The camera always comes back.** Every screen that is not AIM returns to
  AIM on its own. A guest who leaves it somewhere hands back a camera.
- **Nothing a guest touches changes anything.** No setting, no deletion, no
  roll, no look. The only thing their finger can do is take a photograph and
  look at the last one.
- **It reads in the dark, at arm's length, one-handed.** Which is a contrast
  and size constraint before it is a style one, and it is why the register
  question in §6 is not a matter of taste.

Screen 4 is the production screen and the one nobody demos. A card that is
full or absent, four cameras that stopped answering: a guest must be told the
photograph did not happen, in words that are about the photograph and not
about the hardware, and must not be told anything they cannot act on.

## 4. What the owner can see

Everything that is there now — ROLL, LOOK, GALLERY, SETTINGS and its pages,
the card, the diagnostics, power — restyled but not rethought. That half
already works, it is dense on purpose, and a person who knows the camera is
holding it.

Two changes it does need:

- The home screen stops being six equal tiles. The camera is not a peer of
  SETTINGS; it is where the camera lives and the rest is a drawer.
- The conditions list (`conditions.h`, already built) is the owner's landing
  page, not a panel at the bottom of SETTINGS. When you flick to OWNER, what
  you want first is what is wrong.

## 5. What production means, beyond the styling

The list of states that must exist and be seen before this can ship. Every one
of them is a real device state today with no screen, or a screen nobody has
looked at:

- first power-on, before anything is configured
- no card / card pulled while writing / card full mid-capture
- one, two, three cameras not answering
- node firmware skew (built)
- the clock never set (built)
- the four never measured (built)
- battery low, and the last few percent
- the card wiping, which takes a minute
- a guest handing the camera back mid-transfer

## 6. The register — open, and settled by a specimen

Four attempts at this have been thrown away: a from-scratch system, POPEYE,
Edo, and a modular minimalism. All four failed the same way — they were
written as a whole product and judged after they were built.

So the register is not decided in this document. It is decided by **a specimen
sheet**: the four guest screens only, rendered from the real firmware at the
panel's real size, in two or three candidate registers, looked at side by side
before anything else is touched.

What the specimen has to answer, and the only things it has to answer:

- Is it legible across a dark room, at a glance, by someone who has never seen
  it?
- Does it look like one object with the body, or like software on a screen?
- Is the four the product's mark, or decoration?

Everything else — the owner's half, the settings pages, the type scale, the
icons — follows from the answer and is not worth drawing until there is one.

---

## Where this leaves the tree

The work in `feat/d4-ui` is not wasted and is not the product:

- `conditions.h` and the calibration are product behaviour and survive any
  register.
- The chrome consistency work, the numbered positions and the strip grammar
  are correct for the owner's half and will be restyled with it.
- `D4_UI.md`, `UI_DIRECTION.md` and `WORLD.md` describe interfaces that are
  not in the tree and stay marked as such.

The next thing built is the specimen, and nothing else until it is judged.
