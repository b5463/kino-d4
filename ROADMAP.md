# KINO roadmap

Updated 2026-08-31.

This file records direction. It does not promise dates. Current behavior is defined by tested source and the maintained documents linked from [`docs/README.md`](docs/README.md).

## Now

### Finish the D4 V1 bench build

- Measure the purchased main display board, battery pouch, BMS, carrier, speaker depth, and final harness exits.
- Lock the GPIO map only after electrical validation.
- Bring up one camera, then four UART links, shared sync, storage, flash, power switching, and Wi-Fi in that order.
- Record current draw, rail sag, flash temperature, and effective exposure skew on physical hardware.
- Replace provisional enclosure dimensions with measured values before final CAD.

### Keep Studio and KDP honest

- Hold the mock camera to the same protocol used by hardware.
- Close the known firmware-contract gaps instead of hiding them in Studio.
- Keep GPIO distribution, VSYNC phase, and effective exposure timing separate.
- Exercise recovery, power loss, damaged media, and interrupted firmware updates on the bench.

## Next

### Open Roll to the internet

- Close the remaining hardening items before `kino.acronym.sk` is public.
- Record the device-gated mobile browser acceptance rows on real phones.
- Resolve the FFmpeg/GPL distribution decision before publishing a worker image.

### Feed the Twin measured reality

- Replace canonical D4 geometry with bench-measured overrides as issue #1 produces them.
- Complete the enclosure-lock measurement checklist against the physical build.

## Later

- Versioned firmware packages for the P4 and four camera nodes.
- Firmware rollback once the device contract defines it.
- Signed release artifacts and a documented trust path.
- A manufacturing test fixture for assembled D4 units.
- Twin beyond 0.1: GLB assets from official STEP, DXF/CSV/STEP exports.

## Landed

These were on the list above and are in the tree. Listed so the sections above stay a queue rather than a history.

- Release bundles with a `kino.release` manifest and `SHA256SUMS` over the bytes on disk: `npm run release` (`scripts/release.mjs`). Firmware images are included when the tree has built them. Not yet signed — that is still under Later.
- The Twin WebSocket bridge, for running Studio and Twin on separate origins: `npm run twin:relay` and `apps/twin/src/bridge/wsBridge.ts`.
- Playwright acceptance automation of the Twin walk: `e2e/`, `npm run test:acceptance`, and the `acceptance` workflow.
- Two clean firmware builds of one commit compared by hash in CI, for the P4, the radio variant, and the C6 (the `reproducible` job in `.github/workflows/firmware.yml`).

## Maybe

- Alternate sensor or lens modules after D4 V1 is stable.
- Additional camera spacing or swappable camera bars.
- A desktop wrapper if browser hardware access becomes a real constraint.
- Public hardware kits or small-batch builds.

## Explicitly out of scope for D4 V1

- Cloud-dependent shutter behavior.
- Destructive processing of original frames.
- Claims of synchronized exposure based on the shared GPIO edge alone.
- Final mechanical dimensions copied from seller listings without measurement.
