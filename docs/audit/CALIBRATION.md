# Calibration — four cameras, one photograph

Four nominally identical modules never produce identical images. Calibration is stored **per camera**, on the device, with CAM2 as the device-reported reference. Normative: `apps/studio/src/pages/Calibration`, `packages/kdp/src/protocol/types.ts` (`CamCalibration`), device recipes.

## Implemented (verified)

| Axis | Where |
|---|---|
| Camera ordering | blink-and-identify wizard, `orderVerifiedAt`, destructive-confirm on change |
| Physical pitch / spacing | per-cam mm from CAM1, nominal-vs-measured source flag |
| Alignment (x/y/rotation) | per-cam offsets, clamped ±20 px / ±2°, Align Editor with overlay/difference blend |
| Exposure matching | per-cam EV offsets, measured Δluma vs CAM2 |
| White-balance / color matching | per-cam R/G/B gains, ΔRGB + 16-bin histogram vs reference |
| Sensor timing | Skew Bench (25/250/1000 triggers), three skew metrics separate, banded grading, sensor re-phase |
| Flash level | level/distance procedure with highlight-clipping check |
| Crop-safe region | common-overlap inset incl. rotation slack, per-export toggle |

Calibration survives in device NVS and rides in Studio backups.

## Gaps (audited, tracked)

1. **No calibration export/import.** Every developer bench exports JSON; the product-facing Calibration page and Skew Bench export nothing, and there is no calibration report. This blocks the Wiggle calibration report requirement.
2. **No flash-overlap measurement.** Flash calibration measures clipping only; nothing measures pulse-vs-exposure overlap across the four sensors (pairs with the exposure-window model in `CAMERA_PIPELINE.md`).
3. **No `calibrationVersion`.** Alignment offsets change how frames should render, but nothing ties a derived asset to the calibration that produced it, and the worker ignores calibration entirely when baking (see `PHOTO_PIPELINE.md`).
4. **No focus calibration** — lands with the OV5640/AF work (PARTY FIXED needs a stored calibrated position per camera).
5. **No lens-distortion model**, and parallax is previewed but never measured (no disparity readout).
6. Optical centers are board centers; per-camera optical-center offsets await physical measurement (validation plan).

## Rule

Calibration is truth about *this* unit. It is measured, never assumed; per-camera, never global; and every consumer of frames (Studio preview, worker renders, exports) must eventually apply the same calibration or say why it did not.
