# KINO Studio + KINO Roll Development Spec Pack

This package is the implementation handoff for the KINO software ecosystem.

## Products
- **KINO D4** — first physical KINO camera; a handmade four-camera house-party wigglegram camera.
- **KINO Studio** — browser-based device utility for setup, configuration, calibration, firmware, recovery, diagnostics, looks, profiles, media access, and servicing.
- **KINO Roll** — live shared party/event gallery PWA hosted at **https://kino.acronym.sk**.

## Core requirement
Build Studio and Roll as the permanent KINO platform, not as throwaway D4-only prototype software. D4 V1 is the first hardware implementation, but the software must support future KINO devices through capability negotiation, versioned schemas, migrations, and transport-independent device APIs.

## Files
- `01_PLATFORM_OVERVIEW.md` — platform rules, terminology, product boundaries.
- `02_KINO_STUDIO_SPEC.md` — complete Studio product specification.
- `03_KINO_ROLL_SPEC.md` — complete Roll product specification.
- `04_KINO_DEVICE_PROTOCOL.md` — Studio↔camera protocol, capabilities, updates, media, timing telemetry.
- `05_BACKEND_AND_DATA.md` — self-hosted backend architecture, APIs, storage, schemas.
- `06_DESIGN_SYSTEM.md` — 2000s software visual/interaction direction.
- `07_IMPLEMENTATION_AND_ACCEPTANCE.md` — implementation order, testing, acceptance criteria.

## Locked naming
- KINO D4
- KINO Studio
- KINO Roll

## Locked domain
- `https://kino.acronym.sk`

Recommended URLs:

```text
https://kino.acronym.sk/
https://kino.acronym.sk/studio
https://kino.acronym.sk/r/<roll-slug>
https://kino.acronym.sk/host
https://kino.acronym.sk/api/...
```

## Critical D4 timing note
D4 V1 uses four free-running rolling-shutter OV3660 sensors behind XIAO ESP32-S3 camera nodes. A shared GPIO trigger does **not** prove synchronized exposure. Studio must distinguish:
1. GPIO distribution skew;
2. VSYNC/frame-phase skew;
3. effective exposure skew.

The 100–400 µs range is a target, not an assumed property of the hardware.
