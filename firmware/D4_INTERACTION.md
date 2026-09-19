# KINO D4 — what the camera is, and who is holding it

**Superseded, 2026-09-18.** This document argued that the interface splits in
two — a guest half of four screens that can change nothing, and the owner's
half, which is everything else — and that the split had to be a physical
switch on the body. The split was built, looked at, and dropped. There is one
interface now. `guest.h`, `D4_GUEST.md`, the four specimen registers and
`specimen.c` are deleted; `hardware/changes/ECN-0006` is withdrawn.

What follows is what replaced it, and then what is worth keeping from the
argument that lost.

---

## What shipped instead

**One camera, one interface, six screens.** SHOOT, LOOK, GALLERY, ROLL,
SETTINGS, POWER, reached from a home screen of six rows. The register is
settled and is not the Windows-era shell this document was written against:
warm terracotta cards on near-black ground, Oxanium for anything set in caps
and Inter for anything set as a sentence, every corner and every edge drawn
with per-pixel coverage rather than snapped to the pixel grid.

The four questions §6 held open are answered, and were answered by looking at
real renders at the panel's real size rather than by a specimen sheet:

- **Legible across a dark room.** Reading type starts at 19 px, display type
  at 25, and the value on a row is never smaller than its name.
- **One object with the body.** The ground is darker than the case and the
  cards are the colour of the case, so the screen reads as a window in the
  object rather than a display bolted to it.
- **The four is the product's mark.** It is four rows on ABOUT, four bars on a
  capture, four lenses on SHOOT. It is never decoration.

## Why the guest half lost

Not because the reasoning was wrong. A camera handed to a stranger really is a
smaller design than one a person learns, and a lock that is a config key
really is not a lock. Both of those still read true.

It lost on what it cost:

- **Two interfaces is two of everything.** Two palettes that drifted apart
  within a week of each other being written, two sets of states for a full
  card, two answers to what the shutter does. The divergence was recorded in
  `CHANGELOG.md` as a deliberate one, which is how these things are recorded
  right before they become a bug.
- **It was gated on hardware nobody has agreed to.** Every word of it assumed
  a slide switch on a pin that has no route, behind an I²C expander deferred
  to M2. A half of the product that cannot be reached on any existing body is
  not a half of the product.
- **The owner's half got better in the direction the guest half wanted.** The
  conditions screen says what is wrong in words about photographs. A capture
  that fails says so. Nothing destructive happens without a confirm. Those
  were the four guest screens' actual arguments, and they are now true of the
  whole interface rather than of a mode.

## What is kept

- **The shutter always takes a photograph**, from anywhere, interrupting
  anything. Unchanged, and now true on every screen rather than on four.
- **The camera always comes back.** Transient screens return on their own.
- **`conditions.h` is where you look first.** It is its own screen, reached
  from SETTINGS, and the header carries the count so it is visible from every
  other screen rather than only from the one it lives on.
- **The production-state list in §5**, which was the most useful page here and
  is not about guests at all. First power-on, no card, a card pulled mid-write,
  one to three cameras silent, node firmware skew, the clock never set, the
  four never measured, the last few percent of battery, a card wiping. Every
  one of those is a real device state, and each needs a screen somebody has
  looked at.

## What is dropped

The slide switch, the guest palette, the four-screen guest flow, the specimen
sheet as a method, and the claim that the home screen should stop being a
field of peers. Six rows is right for one interface: there is no owner to
flick a switch for, so there is no drawer to put anything in.

---

*The original text is in the history at `firmware/D4_INTERACTION.md` before
2026-09-18 if the argument is ever wanted in full.*
