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

1. ~~**No calibration export/import.**~~ **Closed.** `apps/studio/src/pages/Calibration/CalibrationTransfer.tsx` exports and imports the calibration report from the product-facing Calibration page. Locally imported captures (Gallery → IMPORT FOLDER…) take their offsets from the capture's own `META.JSON` first, then live device calibration, and otherwise render unaligned and say so — the same precedence rule as gap 3, and for the same reason: zeros are not a measurement.
2. **No flash-overlap measurement.** Flash calibration measures clipping only; nothing measures pulse-vs-exposure overlap across the four sensors (pairs with the exposure-window model in `CAMERA_PIPELINE.md`).
3. **`calibrationVersion` — plumbing done, stamping firmware-blocked.** The whole path now exists on the server side: `CaptureInfo.meta.calibration` (`{version, cams}`) is an optional typed member of the KDP contract, the API lands it in `captures.provenance`, the worker's wiggle renders apply it (rotate + overlap crop at source resolution, clamped to the ±20 px / ±2° bounds above) and every derived wiggle records `calibrationVersion`/`aligned`/`crop` in `assets.producer`; Studio prefers offsets recorded on the capture over live calibration. **What remains is the truth itself:** the version and offsets must be stamped by the device at the shutter press, and no firmware records them yet — a capture without them renders unaligned, by design, rather than borrowing today's calibration.
4. **No focus calibration** — lands with the OV5640/AF work (PARTY FIXED needs a stored calibrated position per camera).
5. **No lens-distortion model**, and parallax is previewed but never measured (no disparity readout).
6. Optical centers are board centers; per-camera optical-center offsets await physical measurement (validation plan).

## Rule

Calibration is truth about *this* unit. It is measured, never assumed; per-camera, never global; and every consumer of frames (Studio preview, worker renders, exports) must eventually apply the same calibration or say why it did not.
