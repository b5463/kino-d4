# The guest half

Four screens. This is all of it. A stranger at a party holds this camera and
these four are everything they can ever see.

Chosen off the specimen sheet (`host_preview/specimen/`), register D. The
three it beat each took one layout and applied it to four states, and each was
bullied by whichever state suited it least. Aiming, taking, looking and
failing are four different jobs. The product is held together by its
vocabulary — the four, one accent, one face — not by four screens built the
same way.

---

## The rules

**The shutter always takes a photograph.** From any of the four, at any moment.
It interrupts anything.

**The camera always comes back.** Anything that is not AIM returns to AIM by
itself. A guest who wanders off hands back a camera.

**Nothing a finger touches changes anything.** In guest mode the touch panel
reaches nothing. Not a setting, not a look, not a deletion. The glass is a
viewfinder.

**One accent.** `FFD22A`. It means a photographic event and nothing else.
Red is a failure. There is no third colour.

**No chrome a guest cannot act on.** No battery. No card percentage. No look
name, no mode, no wifi. A guest can do nothing about any of it.

---

## 1. AIM

Full bleed, one lens, at the rate the photograph will play at.

Four ticks on the top edge — one per lens, each over the quarter of the
picture its camera made. 12 px, `F2F4F7`. A lens that is not answering goes
red and stays the same length.

Bottom left: how many photographs are left, on a black plate, 2×. Nothing
else. The plate exists because the number sits over an unknown photograph.

## 2. TAKING

The picture stays. The four arrive across it.

Four bands, 200 px each. A band whose lens has landed shows the photograph at
full strength with a 10 px accent bar under it. A band still waiting is held
at a third. Filling left to right, on the real arrivals — `capture_frames_in()`,
not a timer. Four sensors on four mounts do not agree and the unevenness is
true.

Two things a stranger reads with no words: something is happening, and it is
happening four times.

## 3. TAKEN

The wigglegram, full bleed, playing, looping.

**Nothing on it.** No word, no count, no ticks, no congratulation. It is the
one thing no other camera does and it does not need help. Two seconds, then
AIM.

## 4. WRONG

The only screen that takes the picture away, because the picture is what did
not happen.

Black. Four marks in red, 46 px, 22 apart, centred. Two words at 2×. One
sentence under them a stranger can act on.

```
  NO ROOM          Hand it back to whoever brought it.
  NO CARD          Hand it back to whoever brought it.
  ONE CAMERA       It still takes photographs.
  CAMERAS DOWN     Hand it back to whoever brought it.
```

Nothing about filesystems, nodes, UARTs or firmware. A guest cannot act on any
of it and telling them is a way of blaming them.

---

## The switch

Guest and owner are a **physical slide switch on the case**, not a mode in
software. See `D4_INTERACTION.md` §2.

Until that pin exists: `body.guestMode` in the config, which Studio sets over
USB-C. `guest_mode()` reads the pin when `BOARD_SW_GUEST` is fitted and the
config key when it is not, so the day the switch lands nothing above changes.

Default is **owner**, because a body with no switch that boots into guest mode
is a body nobody can configure.

---

## Type and colour

```
  ink      F2F4F7
  dim      7A8694     a sentence under the words. Nothing else.
  ground   0C0E11     near black, because a party is a dark room
  accent   FFD22A     a photographic event
  bad      E04B3C     a failure
```

One face, the shell's own. Two sizes on these four screens: 2× for the thing
you read across a room, 1× for the one sentence under it. There is no third
size, because there is nothing else to say.
