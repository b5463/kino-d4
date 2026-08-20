# Browser acceptance matrix

Last updated: 2026-08-20. Required by implementation plan Task 35 and acceptance spec 07 §28.

Status meanings:

- **Pass** — the named browser/engine was run against the production build on this workstation.
- **Preflight** — responsive layout and automated component behaviour passed, but this is not the required physical browser/engine.
- **Pending — device gated** — cannot be represented faithfully by an installed local browser; run the listed flow on hardware before release sign-off.

| Product | Browser | Status | Coverage / next action |
|---|---|---|---|
| Studio | Chrome 145 desktop (Windows) | Pass | Production shell startup, compact utility layout, focus styling and unsupported-Web-Serial explanation. Automated Demo/KDP flows cover the interactive session states. |
| Studio | Edge 152 desktop (Windows) | Pass | Same production-build startup/layout check; Edge is the primary supported Web Serial path on this host. |
| Roll | Chrome 145 desktop (Windows) | Pass | Guest/host responsive shell and error/empty states; component tests cover PIN, capture modes, sharing/reactions, moderation and export. |
| Roll | Edge 152 desktop (Windows) | Pass | Guest/host responsive shell and focus/status styling. |
| Roll | Firefox 154 desktop (Windows) | Pass | Guest/host route startup and responsive CSS. Web Serial is irrelevant to Roll. |
| Roll | Android Chrome | Preflight; **Pending — device gated** | Chrome’s reliable 500 px responsive breakpoint, reduced-motion CSS and 42 px primary touch targets pass. On a current Android device, run: open unlisted Roll → PIN → scroll/load more → open Wiggle/Quad → share/download → reconnect after offline. |
| Roll | iOS Safari | Source/test preflight; **Pending — device gated** | Responsive rules and components pass, but Chromium is not used as a WebKit substitute. On current iPhone/iOS Safari, run the Android flow plus add-to-home-screen launch, safe-area/rotation, native share, and reduced-motion checks. |
| Roll | Safari desktop | **Pending — device gated** | Safari is not available on Windows. This is secondary to the explicitly required current iOS Safari row, but should be sampled on the same WebKit release if a Mac is available. |

## Release gate

The two mobile rows are the only unclosed §28 requirements. They do not block continued pre-hardware software work, but they do block marking Task 35 and GitHub issue #28 fully Done. Record device/browser versions, date and failures here when the devices are available; do not replace them with desktop responsive emulation.
