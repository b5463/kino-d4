# Changelog

KINO has no published release yet. Changes intended for the first release collect under **Unreleased**. Git remains the record for work completed before this file existed.

## Unreleased

### Added

- KINO Studio with simulated and Web Serial device connections.
- KINO Device Protocol framing, CRC, commands, transports, jobs, and timing vocabulary.
- Portable `kino.*` schemas with versioned migrations and unknown-field preservation.
- Reference D4 device, media store, factory recipes, and injectable failure scenarios.
- Roll API foundation with authentication, roll lifecycle, resumable uploads, object storage, and live events.
- Installable Roll guest PWA with a virtualized live feed, mode-aware capture detail, sharing, download controls, and anonymous reactions.
- Private Roll host dashboard with QR sharing, live moderation, Roll settings, guest counts, and durable ZIP export polling.
- Studio can register a connected KINO with the Roll server, pass its write-only device credential to the camera, and assign server-created Rolls without making offline camera work depend on the backend.
- Studio can check the Roll firmware catalog, see why a release is incompatible, download verified P4 and camera-node images, and retain a loaded local package when the server is offline; maintainers can publish verified packages with the V1 CLI.
- Shared KINO design tokens and accessible utility primitives now keep Studio and the responsive Roll guest/host surfaces in one visual family.
- Studio and Roll status changes, queue progress, sharing and exports now announce correctly; keyboard tab navigation, mobile PIN hints, focusable feed scrolling and automated contrast guards close the pre-hardware accessibility audit.
- Background processing for capture derivatives, playable roll recaps, durable ZIP exports, and recoverable seven-day trash retention.
- Maintained hardware, architecture, development, firmware-contract, troubleshooting, contribution, security, and release documentation.
- Split light and dark KINO D4 brand marks plus a real Studio demo capture.
- Path-scoped MIT software and CERN-OHL-S-2.0 hardware licensing with SPDX/REUSE metadata and reserved brand assets.
- Machine-readable software, protocol, schema, database, and hardware version control enforced by CI.
- D4 physical revision records, artifact versions, and numbered engineering change notices.
- Public KINO D4 project board with roadmap-backed issues, target views, and a repository helper for status updates.
- KINO Twin foundations: versioned D4 hardware profiles, deterministic simulation and replay, BroadcastChannel KDP transport, parametric assembly, engineering viewport controls, inspector, and wiring view.
- Studio connection to KINO Twin through the same KDP client path used by serial hardware, including cross-tab handshake and reboot coverage.
- Twin transport leases recover from crashed Studio tabs, and Studio detects device restarts even when the underlying link remains open.
- Large Studio galleries can extend their index in bounded 5,000-row windows without eagerly loading every thumbnail.
- Twin now has a top-level recovery screen and stricter assembly/runtime invariants, with replay, power, flash-risk, wiring, and scene-store edge coverage.
- KINO Twin optical overlays show per-camera axes and frusta, neighboring and four-camera overlap, adjustable subject proxies, and live pitch/distance readouts; unmeasured D4 optics remain explicitly marked `MEASURE REQUIRED`, while candidate lens angles are labelled design scenarios.
- Production and isolated staging stacks now run behind Caddy with automatic TLS, unbuffered live events, private PostgreSQL/Redis/MinIO services, gated migrations, and API-streamed private media.
- Redis-backed request budgets now protect device uploads, guest reads, PIN attempts, device registration, device Roll joining, and anonymous Roll creation.

### Fixed

- Sensor-missing camera nodes remain available for firmware repair while sensor-dependent calibration reports the specific fault.
- Repeated Twin power-off calls no longer emit duplicate shutdown activity, and scenario toggles notify observers once.
- Studio and Twin production bundles are split into measured chunks instead of shipping a single oversized application bundle.
- Updated `sharp` to 0.35.3 in image-producing workspaces to remove the current high-severity libvips advisory.
- Production device registration is now first-write-wins, preventing a known serial from rotating and stealing an already deployed device credential; repeated unknown Roll join codes trigger an hour-long per-device lockout.

### Known incomplete work

- The public Roll client is under construction.
- KINO Twin is under construction.
- Physical D4 firmware and final hardware measurements are not shipped from this repository yet.
- Firmware signing and rollback are not implemented.

## Changelog rules

- Record user-visible changes, protocol compatibility changes, schema migrations, database migrations, hardware revisions, and security fixes.
- Keep refactors out unless they change a public contract or remove a supported path.
- Move Unreleased entries into a dated version section only when that version is published.
- Link the release section to its Git tag once tags exist.
