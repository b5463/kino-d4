# Product

## Register

product

## Users

One primary user at V1: the person who built the camera, sitting at a desk with the KINO opened up, a USB-C cable, a multimeter, and a bench supply. Context is hardware bring-up and service — validating a provisional GPIO map, measuring sensor timing, flashing five controllers, chasing a camera that stopped answering. They wrote the firmware; they know what a VSYNC phase is and do not need it explained.

Secondary, later: an eventual KINO owner who plugs the camera in to change a look, pull photos off the card, or take a firmware update. They get plain language and safe defaults, but they are not the reason a screen exists.

The job: know the exact state of a five-controller, four-sensor device, change its configuration with certainty it was accepted, and recover it when something goes wrong — without an IDE, a serial terminal, or `esptool`.

## Product Purpose

KINO Studio is the local browser-based programmer and configuration utility for the KINO four-lens camera. It is the software half of the product: the camera has no keyboard, so every non-trivial setting, every calibration, every firmware update and every diagnostic lives here.

It exists because the alternative is Arduino IDE plus a serial monitor plus hand-edited JSON, which makes the camera unrepairable by anyone including its builder. Success is a session where the user learns the truth about the hardware faster than they could have measured it themselves, and never has to wonder whether a change actually landed.

Local-first and account-free by construction: browser talks to the ESP32-P4 over Web Serial, nothing leaves the machine, no backend exists.

## Brand Personality

Blunt, technical, quietly confident. Three words: **instrument, service-manual, unbothered.**

Voice rules, as the owner stated them: write it the way he would write it for himself. State what a control does, what it references, and what it costs. No flavor prose, no reassurance the user didn't ask for, no marketing adjectives, no personality performed through copy. "Measures brightness, color and alignment differences between the four sensors and stores per-camera correction offsets. CAM2 is the reference. Corrections are bounded." — not a paragraph about character and imperfection.

Terminology is camera-shop and electronics-bench: WIGGLE, QUAD, PARTY NEG, FLASH, 2M/3M, SAVE TO KINO, RUN SELF TEST, ENTER RECOVERY. Units always carry their real symbol (µs stays µs).

The nostalgia is structural, not decorative: it comes from proportion, density, terminology and one-pixel detail, never from jokes about the era.

## Anti-references

- **Modern SaaS dashboard.** Enormous rounded cards floating in whitespace, one purple-blue gradient everywhere, glassmorphism, oversized marketing headings inside an operational tool, interchangeable metric cards, pill-shaped everything, anonymous outline icons, soft low-contrast gray text.
- **A literal Windows XP recreation.** No cloned system icons, no Luna title bars, no fake CRT scanlines, no dial-up jokes, no distressed textures or deliberately illegible pixel fonts. It borrows behavior and craft, not trademarks.
- **AI-assistant voice.** No chat bubbles, no sparkles, no "magic", no assistant persona narrating deterministic operations, no copy that calls basic functions intelligent or revolutionary.
- **Conceptual-dashboard hollowness.** Nothing that looks like a product demo: no fake spinners standing in for real state, no success claimed before the device acknowledged, no simulated photographs pretending to be captures.

## Design Principles

1. **The device's truth, never Studio's guess.** Device-reported state, unsaved drafts, and transient operation state are separate. Nothing reads as saved until KINO acknowledged it; nothing reads as updated until the device reports the new version after reboot. If a value can't be measured, show `—`, not an estimate.
2. **Name the metric that matters.** When several numbers describe one phenomenon, report them separately and give visual weight to the one with consequences. Reporting 37 µs of GPIO skew while 21 ms of exposure skew ruins the photograph is a lie told with a true number.
3. **Every failure is recoverable and legible.** Partial states are shown as partial (CAM1/2 updated, CAM3 failed, CAM4 not started) with the retry that resumes exactly there. No all-or-nothing wizards, no generic "something went wrong" when the protocol error is known.
4. **Density is a service to an expert.** Compact rows, real tables, many labels visible at once — because the user is comparing four cameras and doesn't want to click. Density is earned by information, never by decoration.
5. **Studio is the firmware's test harness.** The interface doubles as the acceptance bar for the hardware: conformance, timing, link quality and bring-up checklists are first-class surfaces, not debug leftovers.

## Accessibility & Inclusion

WCAG 2.1 AA is a hard requirement and outranks the aesthetic where the two conflict — muted grays get darkened until body text and labels reach 4.5:1 (3:1 for ≥18px or bold ≥14px), including placeholder text. The silver-blue chrome survives a darker gray; unreadable text survives nothing.

- Full keyboard operability: every action reachable and operable without a mouse, visible focus indicators that bevels never clip, focus trapped inside modal dialogs and released on close.
- State is never signalled by color alone. Every LED lamp carries a text label (READY / TIMEOUT / OFFLINE / UPDATING), every status color pairs with a word or icon.
- `prefers-reduced-motion` is honored globally: blinking lamps, the wiggle sequencer and progress motion degrade to static states, never to broken layout.
- Respects browser zoom to 200% and OS text scaling; layout reflows structurally (sidebar, camera strip, quad grid) rather than shrinking type.
- Unsupported capabilities are stated in text ("Sensor phase calibration is not supported by firmware 0.1.0"), never left as a dead control or a silent timeout.
- Desktop-first by intent: Web Serial, four-camera comparison and firmware operations need width. Tablet widths stay readable for status; phones are explicitly out of scope and must not pretend a hardware connection will work.
