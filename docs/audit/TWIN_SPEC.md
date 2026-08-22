# Twin specification — current architecture and accuracy assumptions

What KINO Twin is today, what it faithfully models, and where its accuracy stops. Normative: `apps/twin/src`, `packages/simulator-engine/src`, `packages/hardware-profiles/src`, `packages/test-fixtures/src`. Product intent: `kino_twin_spec/KINO_TWIN_SIMULATOR_SPEC.md`.

## Architecture

```
hardware-profiles   d4-v1.json: geometry, nets, gpio, power data, confidence labels
      ↓
three-assets        parametric Tier B/C proxy meshes (no invented dimensions; null → 5 mm fallback + "?")
      ↓
apps/twin           R3F scene: assembly, explode, x-ray/internals/shell/wiring views,
                    optics (FOV scenarios), measure tool, collision/clearance engine,
                    live display texture, engineering panels
      ↕
simulator-engine    TwinSimulator: boot ladder, capture choreography, power/thermal/flash-risk
                    models, recording + deterministic replay (kino.sim-session)
      ↕
test-fixtures       MockKinoDevice: the protocol-honest device (same KDP bytes Studio speaks)
      ↕  BroadcastChannel KDP transport (same-origin)
KINO Studio         connects to Twin exactly as to a serial device
```

Studio reaches the Twin device only through framed KDP. The telemetry tap that drives the 3D visuals is additive and device-side; it never substitutes for protocol traffic.

## What Twin models faithfully today

- **Geometry**: every instance inside the 126 × 80 × 36 envelope; camera bar rigid, pitch 20–24 mm live (22 default); measured overrides refresh geometry and collision findings without code changes; dimension confidence (`MEASURED`/`OFFICIAL_CAD`/`OFFICIAL_SPEC`/`SELLER_SPEC`/`PROVISIONAL` + computed `CONFLICT`) renders on every part, unknown axes render `?`, FOV renders `MEASURE REQUIRED` — never a number.
- **Timing honesty**: `gpioTriggerSkewUs`, `vsyncPhaseSkewUs`, and `effectiveExposureSkewUs` are separate quantities end to end (protocol vocabulary, engine, SYNC panel). Trigger timing is never presented as exposure synchronization.
- **Boot/capture choreography**: seven-stage boot; captures expose in VSYNC-phase order, transfer concurrently at the configured baud with real duration math.
- **Power envelope**: 3 A continuous harness limit, 6 A transient, charge 0.6 A preferred / 1.5 A max, sag, fuse dwell, flash 350/500/650 mA draw — see `POWER_MODEL.md`.
- **Fault injection**: 28 device scenarios + 6 per-camera faults, all injected through the device's own state machine so Studio experiences them as protocol behavior.
- **Recording/replay**: raw-KDP session documents replay deterministically and verify byte-for-byte.
- **On-device UI**: the display glass renders the live simulated device UI (boot, ready, capture, firmware update, faults), labelled SIMULATED; the shutter drives the same KDP capture path.

## Accuracy limits — stated, not hidden

| Simplification | Status |
|---|---|
| Optical center = board center; no lens offset or principal point | `BLOCKED_BY_HARDWARE` (issue #1 measurements) + schema work |
| Readout window = full frame interval (no exposure-time model) | model gap — exposure windows needed for honest flash overlap |
| Per-cam trigger latency is a seeded random draw, not a wire-derived model | acceptable until bench data exists; must then be replaced |
| Flash coverage is geometric only — no intensity, ambient, or falloff term | model gap |
| Fuse dwell-only; thermal zones qualitative; single boost efficiency | `ESTIMATED`, labelled |
| `profile.gpio` and DVP pin data have no scene consumers yet (no pin/signal view) | feature gap |
| Collision engine uses AABBs, not oriented boxes/meshes | documented ceiling |
| Mass/material metadata recorded per component where a source exists (battery mass ESTIMATED, heatsink copper SELLER, enclosure split into shell/chassis with SLA UTR-8100 / SLS PA12-GF directions as ESTIMATED material claims); unsourced parts show "not recorded"; thermal properties still absent | partial — thermal gap remains |
| No AF/VCM/focus concept anywhere | blocked on the OV5640 direction (see `CAMERA_PIPELINE.md`) |

## Rules the Twin must keep

1. Unknown dimension ≠ guessed dimension. The fallback box is visibly a placeholder.
2. Trigger timestamp ≠ exposure timestamp, in every panel and every export.
3. Simulated and estimated values carry their tag wherever a number is shown.
4. Studio-facing behavior changes only through the device state machine — no side channels.
5. A measured value replaces its provisional twin in the same change that records the bench evidence.
