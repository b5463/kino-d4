# ECN-0006: `SLIDE_MODE` is the guest switch, and it is the one control the interface needs

| Field | Value |
|---|---|
| Status | Draft |
| Author | KINO contributors |
| Date | 2026-09-16 |
| Hardware revision | D4-V1 |
| Design version before | 0.1.5 |
| Design version after | 0.1.6 |
| Affected units | No released units. One bench P4 carrier. |

## Problem

`SLIDE_MODE` has been an unassigned signal since the first wiring map: a slide
switch on the body with no pin, no route and no stated purpose. It has been
carried on every revision as a row reading `GPIO_TBD` and nothing has ever
said what it would switch.

Meanwhile the product decided what it is. `firmware/D4_INTERACTION.md` settles
that this camera is passed between guests at a party — strangers, one-handed,
in a dark room, with no manual — and that the interface therefore splits in
two: a guest half of four screens that can change nothing, and the owner's
half, which is everything else.

**That split has to be physical.** The firmware implements both halves today
(`firmware/p4/main/guest.h`), and the only thing choosing between them is a
config key that Studio writes over USB-C. A camera whose guest lock is a
setting is not locked: it is a camera whose owner has to remember to set it,
cannot see whether it is set, and cannot set it without a laptop.

This ECN gives `SLIDE_MODE` its purpose and asks for its pin.

## Proposed change

A two-position slide switch on the case, labelled, reading a P4 GPIO.

```
  GUEST   pin low    the camera, and nothing else
  OWNER   pin high   the camera, and everything else
```

Active low with the P4's internal pull-up, exactly as `BTN_SHUTTER` is wired,
so an open circuit or a missing switch reads OWNER — a body with no switch is
one nobody could otherwise configure. Firmware debounces it the same way and
needs no edge interrupt: `guest_mode()` is read once per UI pass.

The switch is a slide and not a button on purpose, and the reasons are the
same reasons it is hardware and not software:

- **A stranger cannot stumble into it.** Every other candidate — a long
  press, a gesture, a code — is something a guest can do by accident and
  something the owner must be taught.
- **The owner cannot forget to leave it.** A mode that persists invisibly is
  a mode that is wrong half the time.
- **It needs no interface**, which matters because the interface is the thing
  being removed. A hidden gesture has to be taught, and teaching it takes a
  screen.
- **It is visible from across a room.** Whether the camera is safe to hand
  over is a question you ask while someone is reaching for it, and the answer
  should be on the object.

## Options considered

**`GPIO35`, JP1 pin 15 — rejected, again.** It is still the only free header
GPIO and it is still the ESP32-P4 serial-bootloader strap. ECN-0003 rejected
it for the shutter and everything there applies harder here: a *slide* held
low through a reset is not a momentary mistake, it is a camera that boots into
the ROM downloader every time it is switched to GUEST and left there. The pin
stays unconnected.

**The I²C GPIO expander on JP1 23/25 — the route.** ECN-0003 deferred it to M2
and noted it is the right answer for the second row of controls: `BTN_FN`,
`SLIDE_MODE` and the four per-camera power-switch lines. One button did not
justify a part, a driver and a bring-up. A guest lock, an FN key that the
interface has a grammar waiting for, and per-camera power together do.

**Borrowing `CAM_PWR_EN` or a UART pin — not considered.** Both cost a
function the camera needs to take photographs.

## What this unblocks, and what it does not

Unblocks: the guest half stops being a config key. `guest_mode()` in
`guest.h` already reads `BOARD_SW_GUEST` when it is fitted and falls through
to `body.guestMode` when it is not, so nothing in the interface changes on the
day the pin exists.

Does not unblock, and is worth saying: `BTN_FN` rides the same expander. The
interface has numbered positions on every segmented control and a focus ring
on every control, and neither can be reached by any input this body has. That
is a second thing the expander pays for and it is not what this ECN asks for.

## Compatibility

No existing enclosure has the cut-out. No harness changes. Firmware is already
written for both states and defaults to OWNER, so a board without the switch
behaves exactly as it does today. Calibration and service procedures are
unaffected.

## Safety and recovery

No power, thermal or battery effect: one input with a pull-up.

The failure mode worth stating is the one that decided the polarity. A broken
switch, a disconnected wire or an unpopulated part all read OWNER. A camera
that fails into the owner's half is a camera someone can fix; a camera that
fails into the guest half cannot be configured, cannot be taken out of guest
mode without a laptop, and looks identical to one that is working.

## Files changed

- `hardware/WIRING.md` — `SLIDE_MODE` row, and the JP1 narrative
- `hardware/CHANGELOG.md`
- `packages/hardware-profiles/src/profiles/d4-v1.json` — `SLIDE_MODE`
- `firmware/p4/main/board_d4v1.h` — `BOARD_SW_GUEST`
- `firmware/p4/main/guest.h` — already written against it

## Verification

- [ ] BOM and manifest agree.
- [ ] Wiring and GPIO records agree.
- [ ] Assembly and acceptance procedures were updated.
- [ ] Affected firmware and KDP assumptions were tested.
- [ ] Closed-enclosure checks were repeated where needed.
- [ ] `npm run version:check` passes.

## Decision

Open. The pin depends on the expander decision deferred by ECN-0003, and this
is the second signal asking for it. What is settled by this note is what
`SLIDE_MODE` is *for*, which was blank on every revision before it.
