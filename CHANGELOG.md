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
- KINO D4 firmware (ESP-IDF): P4 main controller and XIAO camera-node applications with a host-tested portable KDP C core, checksummed single-camera capture to SD, bench diagnostics (storage self-test, link stats, soak job, per-unit hardware-validation registry), structured device logs, honest runtime stats, and a six-check self test — CI-built, awaiting physical bench validation.
- Twin now has a top-level recovery screen and stricter assembly/runtime invariants, with replay, power, flash-risk, wiring, and scene-store edge coverage.
- KINO Twin optical overlays show per-camera axes and frusta, neighboring and four-camera overlap, adjustable subject proxies, and live pitch/distance readouts; unmeasured D4 optics remain explicitly marked `MEASURE REQUIRED`, while candidate lens angles are labelled design scenarios.
- Production and isolated staging stacks now run behind Caddy with automatic TLS, unbuffered live events, private PostgreSQL/Redis/MinIO services, gated migrations, and API-streamed private media.
- Redis-backed request budgets now protect device uploads, guest reads, PIN attempts, device registration, device Roll joining, and anonymous Roll creation.
- API database statements and object-storage requests now time out instead of holding the shared connection pool behind a hung dependency.
- A camera-simulating uploader now verifies resumable fixture uploads, lost-ack and duplicate retries, background derivatives, guest visibility, host closure, and controlled concurrent load before physical cameras are available.
- Production operations now include atomic off-host database/object backups, bounded daily/weekly retention, an isolated digest-verifying restore drill, authenticated Prometheus application metrics, rotating JSON logs, and private MinIO/node-exporter signals.
- KINO Twin can measure two picked assembly points and continuously report assembled-pose component collisions, sub-millimetre hard clearances, cable clearances, and blocked USB or microSD service keepouts.
- KINO Twin now runs the shared KDP simulator in-tab, exposes staged power/test-capture controls, and visualizes boot, exposure, UART, SD, upload, firmware, power, thermal, and Studio connection activity.
- KINO Twin exposes protocol-honest fault injection plus power, synchronization, and rolling-shutter flash analysis panels with explicit simulated and estimated provenance.
- KINO Twin stores versioned as-measured component overrides separately from canonical profiles and provides an enclosure-lock measurement checklist that refreshes geometry and collision findings immediately.
- KINO Twin records and verifies raw-KDP simulation sessions, exports versioned layouts and engineering reports, captures viewport PNGs, and ships a same-origin Studio/Twin preview harness with a 17-point acceptance runbook.
- Twin now guides a first-time user: a powered-off start card names the one action that matters, boot progress renders as a live ladder in the viewport, power and shutter are primary header actions with stated disabled reasons, right-panel tabs carry plain names with one-line descriptions, panels say why they are empty while the simulator is off, the parts list explains itself, and the reference grid has a toggle.
- The Twin device no longer fires ambient demo captures: every capture in the 3D view was commanded by the operator or Studio. Studio's demo device keeps its lively ambient behavior.
- The Twin display renders the live simulated device UI — boot stages, firmware version, battery voltage, SD/Wi-Fi/roll status, capture and firmware-update progress, per-camera faults, and a SIMULATED-labelled CAM2 preview field — on the 3D glass and in a DISPLAY inspector tab whose shutter drives the same raw-KDP capture path Studio uses.

- Master Twin+Studio audit against the D4 hardware/software specification: compliance matrix and thirteen maintained documents under `docs/audit/`, provisional P4 header assignments and XIAO DVP pin map in the hardware profile, and OV3660/OV5640_AF sensor profiles recorded as capability-driven data.

- Capability-driven autofocus architecture: `CAMERA_FOCUS` (trigger/lock/set/mode/store-fixed) behind the new `autofocus`/`focusLock`/`manualFocus` capabilities, PARTY AUTO / PARTY FIXED / MANUAL focus modes with the Wiggle focus→lock→arm→capture flow, per-camera focus state in camera info and the Twin snapshot, four AF faults (fail, VCM stuck, timeout, hunting), a capability-gated FOCUS panel in Studio, and AF state on the Twin's device display. OV3660 firmware simply lacks the surface; nothing assumes OV5640 globally.
- Flash timing is honest about exposure: the Twin flash timeline lights each camera's own SIMULATED exposure window instead of the whole frame, `flashBandRisk` moved into the protocol package and accepts per-camera windows, and Studio gains a FLASH TIMING bench that measures VSYNC phases and reports pulse coverage with measured and assumed inputs labelled separately.
- The power model tells one story: the engine's state of charge follows the device's own draining battery, a charger-connected scenario feeds 0.6 A through GET_POWER_STATUS and the Twin model alike, SW6106 light-load shutdown and a one-camera capture brownout are injectable, the 5 V rail droops gradually past 3 A instead of holding a cliff, and bus demand past the converter's 18 W class carries its own warning.
- Idempotent protocol reads retry once on timeout with a fresh sequence number; mutations stay one-shot. The capability gate fails closed when the capability query never answered, keeps the deliberate everything-on fallback for pre-negotiation firmware that NACKs it, and the client drops CRC-valid frames whose framing version it does not speak.
- The reference device can now injure the transport like real hardware: duplicated response frames, a dropped byte in transit, a mid-frame link death, and a wrong-baud garble that never frames. The Twin BroadcastChannel path splits frames like the serial mock so Studio's decoder reassembles on both. One shared contract test drives the identical command sequence over the serial mock and the Twin channel.
- Restoring a backup made on a different camera now warns with both serials before anything is written — per-camera calibration is measured on one physical unit.

- Capture and derivative provenance: everything a firmware build sends beyond the typed capture surface now lands in a `provenance` column with the device's serial and hardware as they were at the shutter press, and every derived asset records its producer — job, encoder, and the settings that decided the bytes — with a produced-at timestamp. Retuning a render constant is now visible in the data.
- The AI enhancement gate exists before any AI backend: OFF by default, provider-independent interface (local / self-hosted / external), and an external provider is refused without explicit consent — the skip reason names which gate held.

- Database migration 0008: additive `provenance` on captures and `producer`/`produced_at` on assets.
- Studio closes its audit gaps: calibration exports a full per-unit report and imports per-camera offsets only (order and spacing stay physically verified), firmware downgrades warn loudly with both versions before the same explicit confirm, the health overview shows the device-reported 5 V rail or says NOT REPORTED, and per-camera temperature sits on the camera cards.
- Twin gains a PINS tab — the first consumer of the profile's 2×13 header table, provisional GPIO assignments, and XIAO DVP map — and the hardware-profile schema carries optional mass/material metadata and per-instance optical-center offsets that the optics overlay applies (zero until the bench measures real centers).
- Twin gains a ROLL tab: a development bridge that registers as a device, creates or joins a real Roll, shows the working `JOIN THIS ROLL` QR on the virtual D4 display, and uploads committed virtual captures over the public device wire contract — thumb first, idempotent by capture UUID + asset role, with backoff retry across a server outage and an honest single-frame ingest on the current-firmware profile.
- A party simulator (`npm run party:sim`) drives bursty capture load, concurrent SSE guest sessions, and an outage drill against a running Roll API, reporting capture-to-guest arrival percentiles and duplicate counts; `docs/roll/` documents the device upload contract for the future Wi-Fi firmware milestone, the Twin integration, the capture schema map, the realtime architecture, the acceptance walks, and the guest product audit.

### Fixed

- A capture in flight now survives a host link drop: the reference device's exposure → transfer → SD-commit chain no longer dies when the KDP client disconnects right after the CAMERA_CAPTURE ack — only power-off or reboot cancels it, matching the physical rule that unplugging the cable must not lose the photograph.
- The reference device actually verifies firmware images: `FW_END` hashes the received bytes against the declared sha256 and rejects a corrupted image instead of answering `verified: true` unconditionally.
- Studio backups no longer contain the camera's Roll identity block, strip it from older backup files on restore, and now record camera firmware versions, protocol, and the config schema version.
- A Twin session is labelled KINO TWIN in the Studio toolbar and sidebar instead of appearing as USB hardware, the Overview FLASH lamp is device-capability-driven instead of hardcoded green, and the conformance runner classifies unsupported commands correctly.

- Twin typography sits on one four-step token scale with nothing below 10 px, and every panel padding lands on the even spacing grid — the tabs, chips, tables and checklists read as one instrument again.
- The Twin display screen stays crisp when viewed through the clear rear acrylic instead of being washed out by the panel's tint.
- Twin assembly renders the D4 correctly: the display sits landscape inside the body with its glass facing the rear, its connector keepouts hug the board face instead of floating in space, the camera-node service keepout covers rear USB-C access instead of the lens, and the enclosure skeleton is an open edge frame so internal components are visible through the clear panels.
- Sensor-missing camera nodes remain available for firmware repair while sensor-dependent calibration reports the specific fault.
- Repeated Twin power-off calls no longer emit duplicate shutdown activity, and scenario toggles notify observers once.
- Studio and Twin production bundles are split into measured chunks instead of shipping a single oversized application bundle.
- Updated `sharp` to 0.35.3 in image-producing workspaces to remove the current high-severity libvips advisory.
- Production device registration is now first-write-wins, preventing a known serial from rotating and stealing an already deployed device credential; repeated unknown Roll join codes trigger an hour-long per-device lockout.

### Known incomplete work

- Physical D4 firmware and final hardware measurements are not shipped from this repository yet.
- Firmware signing and rollback are not implemented.
- Mobile-device browser acceptance (iOS Safari, Android Chrome) is device-gated and unrecorded.

## Changelog rules

- Record user-visible changes, protocol compatibility changes, schema migrations, database migrations, hardware revisions, and security fixes.
- Keep refactors out unless they change a public contract or remove a supported path.
- Move Unreleased entries into a dated version section only when that version is published.
- Link the release section to its Git tag once tags exist.
