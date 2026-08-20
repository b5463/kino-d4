# UI and accessibility audit — Studio + Roll

Audit date: 2026-08-20. Scope: implementation plan Task 35, design spec 06 §§15–16, and acceptance spec 07 §29.

This is a source-and-behaviour audit, not a claim that a physical-device browser matrix has run. Browser results and the remaining device-gated checks are recorded separately in `browser-matrix.md`.

## Anti-slop page/view walk

The reject criteria are: generic startup-dashboard styling, card walls, wasteful empty space, giant gradient heroes, Notion/Linear/Stripe-like Studio, Instagram-like Roll, or status hidden in decoration. Acceptance requires camera-utility structure, useful density, compact controls, obvious hardware state, and nostalgia carried by structure rather than novelty decoration.

| Surface | Result | Evidence / correction |
|---|---|---|
| Studio shell + Connect/Overview | Pass | Menu, toolbar, device strip, sidebar, work area and status bar remain dense utility chrome. Connection state is symbol + exact wording in every strip; the visually compact toolbar lamp retains an accessible name. |
| Shoot, Wiggle and Quad | Pass | Capture/viewfinder work remains primary; mode controls are compact semantic buttons and status text is explicit. Reduced-motion hooks continue to stop JS-driven wiggle motion. |
| Gallery, Capture Inspector and Align | Pass | Bounded thumbnail grid and inspector dialog preserve camera-software hierarchy. Cards are functional capture targets, not decorative dashboard cards; images have contextual names or are correctly decorative inside named controls. |
| Looks | Pass | Dense library/editor split, field labels and command row remain intact. No decorative hero or oversized typography. |
| Calibration + Skew Bench | Pass | Procedure steps, measurements, quality bands and save/discard actions stay data-first. Long-running result lines already use status semantics. |
| Studio Roll setup | Fixed | Server/network/Roll/queue group boxes remain compact. Queue changes now use an atomic polite live region; errors use an alert; Push-to-Roll completion is announced. |
| Device + Updates | Pass | Tables, meters, package facts, target progress and recovery actions remain explicit. Progress has numeric ARIA values and destructive actions remain labelled. |
| Bring-up + Developer | Pass | Engineering forms, logs and bench outputs deliberately retain high information density. The live log is not announced continuously; bounded result summaries use status regions. |
| Roll guest feed | Fixed | Framed capture grid remains a simple Roll, not an Instagram clone. The scroll region is keyboard focusable/named, loading/empty/roll-state changes are announced, and failures remain alerts. |
| Roll PIN / missing / closed states | Fixed | Compact group-box presentation, labelled PIN entry, numeric keyboard hint, correct autocomplete purpose, alert on rejection, and textual closed/missing states. |
| Capture detail: single, Quad, Wiggle | Fixed | Media remains the hero without a gradient marketing hero. Actions are compact; frame images are named; share outcome is an atomic polite status; WigglePlayer retains reduced-motion opt-in. |
| Host token gate + dashboard | Fixed | Private token/PIN fields are labelled, moderation always prints HIDDEN/TRASH states, export progress is announced, and the responsive settings/moderation layout keeps useful density. |

No giant-card, oversized-heading, decorative-status, generic SaaS-shell, or social-feed imitation violation remained after the shared design-system extraction.

## Accessibility acceptance

| Requirement | Verdict | Evidence |
|---|---|---|
| Keyboard reachability | Pass in code/tests | Native buttons, links and form controls; Studio skip link; focusable Roll feed scroller; dialogs retain focus handling; shared tab strip now has one tab stop plus Left/Right/Home/End navigation and skips disabled tabs. |
| Visible focus | Pass | Global two-pixel focus outline plus contrasting keyline in Studio and Roll; focus is not encoded by colour alone. |
| Labels / semantics | Pass | Form labels, named toolbars/regions, image alternatives, progressbar values, button text/ARIA names, alerts and status regions are present. PIN input purpose is exposed to mobile keyboards/autofill. |
| Contrast | Pass, automated guard | Shared token tests enforce 4.5:1 text pairs, 3:1 status marks, and the lightest primary/danger gradient stops. The intentionally compact palette therefore cannot silently regress below the recorded floors. |
| Reduced motion | Pass in code/tests | Shared blink/spinner animation and both application CSS transitions are suppressed; Studio JS motion uses its reduced-motion hook; Roll WigglePlayer renders a poster/manual-play path under the media preference. |
| Screen-reader status | Fixed | ConnectionStrip and Roll state lamps are polite atomic status regions; upload queue, Push-to-Roll result, Roll loading/empty state, sharing and export progress announce changes; errors remain assertive alerts. |
| No colour-only status | Pass, automated guard | Shared `StatusLamp` always renders a state symbol (`●`, `○`, `▲`, `×`) plus text or an explicit accessible label. Studio/Roll use the shared primitive. Moderation and queue states are also printed as words. |

## Verification evidence

- `@kino/design-system`: 14 tests, including token contrast and shared semantics.
- Studio focused acceptance: 79 tests (`specAudit` + `rollPage`).
- Roll focused interaction acceptance: 12 tests (`pinGate`, `captureDetail`, `host`).
- Full application and workspace verification is recorded with the Task 35 commit/PR update.

## Remaining external acceptance

The implementation audit is closed. Current iOS Safari and real Android Chrome remain browser/device acceptance work because neither engine is available on this Windows workstation. Responsive desktop-engine emulation is useful preflight evidence but is not substituted for those rows; see `browser-matrix.md`.
