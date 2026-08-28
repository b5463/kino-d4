# KINO D4 master audit — Twin + Studio vs the hardware/software specification

Audit of 2026-08-21 against the owner's 50-section master specification.

> **Implementation update, same day:** the fix waves merged as PRs #65/#67/#68/#69 (see `CHANGELOG_AUDIT.md` §Implementation waves). Rows below marked PARTIAL/MISSING for capability negotiation resilience (§1/§11), autofocus (§3/§5), flash exposure windows (§8), transport hostility (§10), power gaps (§12), provenance (§22/§40), AI gating (§23–26/§31), calibration transfer (§20), firmware downgrade (§34), the 5 V health row (§36), and the pin-map consumers (§4/§9) are now implemented; what remains is recorded on issues #55/#59/#61/#62/#63 and in the validation plan. Method: four parallel code inspections (protocol, Twin hardware model, Studio, pipeline/Roll) with file:line evidence, then fixes on branch `master-audit` (issue #51). Companion documents in this directory carry the per-domain detail; `CHANGELOG_AUDIT.md` lists every change made.

Status legend: PASS · PARTIAL · FAIL · MISSING · BLOCKED_BY_HARDWARE. Severity: P0 architecture/data-loss/safety · P1 before hardware integration · P2 before usable beta · P3 improvement.

## Compliance matrix

| Spec § | Requirement | Status | Sev | Action |
|---|---|---|---|---|
| 1 | Capability-driven, no hardcoded D4 assumptions | PARTIAL | P1 | Capabilities exist and gate Studio; sensor identity per-cam; fail-open gate + model drift → #58 |
| 2 | P4+C6 / 4×XIAO topology, XIAO owns sensor | PASS | — | Modeled correctly end to end; no C6 protocol target (P3, recorded) |
| 3 | OV3660/OV5640_AF sensor profiles, capability-driven | PARTIAL | P1 | Profiles added as data this audit; behavior wiring → #55 |
| 4 | OV5640 24-pin DVP module, XIAO pin map, AFVDD 2.8 V | PASS (data) | — | dvpPinMap + module facts added to profile + HARDWARE.md; visualization → #63 |
| 5 | Autofocus model (PARTY AUTO/FIXED/MANUAL, faults, Twin viz) | MISSING | P1 | Designed in CAMERA_PIPELINE.md → #55 |
| 6 | Geometry: pitch 20–24, optical centers, FOV lens profiles, distances | PARTIAL | P2 | Pitch live; FOV scenarios 60–120° labelled DESIGN SCENARIO; distances 0.8–3 m; optical centers = board centers → #63 + bench |
| 7 | Trigger skew ≠ exposure skew; VSYNC/frame-phase model | PASS | — | Three metrics separate everywhere; engine simplifications flagged (TWIN_SPEC.md); 100–400 µs stays a target |
| 8 | Flash as temporal freeze, overlap visualization | PARTIAL | P1 | Timeline + coverage exist; exposure-window model + bench → #56 |
| 9 | P4 2×13 header, provisional assignments, reserved C6 pins | PASS (data) — **later found wrong** | — | Added this audit (profile `gpio`/`header2x13`, HARDWARE.md); electrical lock = issue #2. The GPIO rows added here did not match the JP1 silkscreen (commit `944b68e`); replaced by the manufacturer table in `docs/HARDWARE.md` §P4 header JP1 |
| 10 | Serial: per-cam state, baud ladder, hostile-link simulation | PARTIAL | P1 | States/bauds/faults strong; missing dup/dropped/mid-frame/overflow/baud-mismatch → #58 |
| 11 | KDP: framing, capabilities, config versioning | PARTIAL | P1 | Framing/HELLO solid; migrations unexercised → #60; retries → #58 |
| 12 | Power system limits and faults | PARTIAL | P1 | Limits match seller spec exactly; charger/SW6106/SoC/transient → #57 |
| 13 | 16340 backup profile — experimental only | PASS (by absence) | P3 | Deliberately absent; optional alternate profile → #63 |
| 14 | Enclosure SLA/SLS direction, thermal separation | MISSING (data) | P2 | Material metadata → #63; thermal rule recorded in validation plan |
| 15 | Twin 3D views + component metadata | PARTIAL | P2 | Views comprehensive; mass/material/electrical/thermal fields → #63 |
| 16 | Studio module scope | PARTIAL | P2 | 19 of 23 modules present; gaps → #61 (STUDIO_SPEC.md table) |
| 17 | Design language: 2005 utility, no SaaS | PASS | — | Verified in tokens and components |
| 18 | Connection UX: real vs Twin explicit, KD4-SIM-0001 | PASS | — | Fixed this audit: three-way transport label (was "· USB" for Twin) |
| 19 | Per-camera calibration | PASS | — | Per-cam, CAM2 reference; gaps in CALIBRATION.md |
| 20 | Wiggle calibration workflow + report | PARTIAL | P2 | Workflow strong; report export/import + flash overlap → #61/#56 |
| 21 | Capture modes WIGGLE/QUAD extensible | PASS | — | Mode/profile architecture in place |
| 22 | Photo pipeline, originals immutable | PASS core / PARTIAL provenance | P1 | Immutability enforced twice; provenance → #59 |
| 23–26 | AI: optional, restrained, provenance, upscale | PARTIAL | P1/P2 | Stub contract committed; consent gate + providers + modes → #62 |
| 27 | Deterministic KINO look | PARTIAL | P2 | Device recipes deterministic; server-side look → #59 |
| 28 | Wiggle post: parallax preserved, formats | PARTIAL | P2 | WebP/MP4 pass; parallax structurally safe; worker ignores alignment → #59; GIF server-side absent |
| 29–30 | Roll integration, party workflow, offline-first | PASS | — | Gaps: queue-persistence test, capture-never-blocked test (TEST_PLAN.md) |
| 31 | Local vs external AI, privacy | MISSING | P1 | → #62 (gate before backend) |
| 32 | Storage/SD architecture + faults | PARTIAL | P2 | Presence/free/full pass; slow-card + write-error faults absent → #61/#58 |
| 33 | Gallery 2 000+ | PASS | — | Tested 2 000/10 000 device-side; API-scale walk → TEST_PLAN.md |
| 34 | Firmware management incl. failure recovery | PARTIAL | P0→fixed / P1 | sha256 verification was theatre — **fixed this audit**; rollback/downgrade guard → #61 |
| 35 | Config schemaVersion + migrations + backup identity | PARTIAL | P1 | Envelope versioned; backup now records fw/protocol/schema and strips Roll identity (**fixed**); migrations → #60 |
| 36 | Diagnostics overview | PARTIAL | P2 | FLASH lamp was hardcoded green — **fixed** (capability-driven); 5V/WIFI/ROLL rows → #61 |
| 37 | Twin fault injection breadth | PARTIAL | P1 | 28+6 exist; 11 named faults absent → #55/#57/#58 |
| 38 | Bench tools | PARTIAL | P2 | Most exist; flash-timing/SD-write/power-load/focus-sweep → #61/#56/#55 |
| 39 | Concurrency priority (capture first) | MISSING (as policy) | P2 | Stated nowhere, no queue priorities → recorded in PHOTO_PIPELINE.md, part of #59 |
| 40 | Provenance metadata durable | PARTIAL | P1 | → #59 |
| 41 | Security | PASS | — | Tokens hashed, PIN cookies sound, Wi-Fi creds provably contained, logs redacted; backup leak **fixed this audit** |
| 42 | Future hardware via capabilities | PARTIAL | P1 | Profile-parametric Twin, capability-gated Studio; sensor/AF keys → #55 |
| 43 | Cross-transport contract tests | PARTIAL | P2 | Both transports tested, no shared suite → #58 |
| 44–45 | Prior debts re-checked | PASS | — | All five: capabilities EXIST, config version EXISTS, HELLO resync EXISTS, gallery scale EXISTS, mock transport realistic (with §10 additions pending) |
| 46 | No faked hardware accuracy | PASS | — | Confidence labels pervasive; violations found (FLASH lamp, fw verify, Twin "USB" label) fixed this audit |

## The 48 final-validation questions

Grouped; every NO carries its issue.

**YES today:** Studio connects to Twin exactly as to hardware (same HELLO path, no simulator screens, honest label). Capabilities are discovered and gate features. One camera can carry a different firmware/fault state (per-cam faults, nodeFwMismatch). Twin distinguishes trigger skew from exposure skew, and models VSYNC/frame phase. Flash overlap is visualized. Config documents carry schemaVersion. The gallery handles 2 000+ (tested to 10 000). Originals can never be destroyed by processing (enforced at API and worker middleware). AI enhancement is completely disabled (nothing runs). Wiggle exports preserve parallax (rigid alignment + crop only). Captures continue while Roll is offline (mock rule; test pending). Failed Roll uploads resume (multipart + retry). The 3 A continuous limit is represented correctly, never 6 A. Every unverified hardware assumption is identifiable (confidence labels + this directory).

**NO — tracked:** OV5640 AF calibrate/lock/manual (#55). Per-camera *focus* calibration (#55; optical/color per-cam calibration is YES). Power transients + SW6106 shutdown simulation (#57). One camera with a different *sensor* driving behavior (#55 — identity is reported but not behavior-driving). Studio surviving serial garbage: HELLO resync YES, but request-level retry is absent (#58). Partial firmware implementations: capability gating YES but fail-open default (#58). Config migration between schema versions: engine YES, exercised NO (#60). AI provenance recording (#62 — nothing to record yet, gate first). Future-model addition without rewriting Studio: architecture supports it; sensor/AF capability vocabulary missing (#55).

**The audit is therefore not "complete" in the spec's terms** — it is complete as an audit, with every NO carrying a scheduled, scoped issue (#55–#63) and every hardware-gated item in `HARDWARE_VALIDATION_PLAN.md`.

## Fixed during this audit

See `CHANGELOG_AUDIT.md`. Headlines: firmware sha256 verification made real (P0), backup Roll-identity leak closed + identity fields added (P0/P1), provisional P4 header map + XIAO DVP map + sensor profiles landed as data, honest Twin/DEMO/USB transport labels, capability-driven FLASH lamp, conformance unsupported-classification fix.
