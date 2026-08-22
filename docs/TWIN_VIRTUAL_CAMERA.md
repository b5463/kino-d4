# Twin virtual camera

The virtual bench (issue #72): a 3D scene the four virtual cameras actually
photograph.

## Stage

Twin → STAGE tab (`apps/twin/src/panels/StagePanel.tsx`, state in
`apps/twin/src/state/stageStore.ts`). Subject library — person, two people,
group, calibration grid, color chart, texture target, near object, party
table — all generated geometry and canvas textures
(`apps/twin/src/scene/subjects.ts`), nothing licensed. Subjects exist in real
3D space (mm, +Z out of the lenses): X/Y/Z numeric controls, distance
presets 0.8/1.0/1.5/2.0/3.0 m, rotate, scale, duplicate, delete, click-to-
select in the viewport. PARTY TEST SCENE loads a person at 1.5 m, a table,
background people at 2.6 m, the room shell, and DIM PARTY lighting.

Lighting: ambient intensity + color temperature, key light, backlight, with
DAYLIGHT / INDOOR / DIM PARTY / VERY DARK / BACKLIT presets. Stage lights
carry the sensor layer, so the photographs see the same illumination the
viewport shows. All simulation control — none of it is a KDP operation.

## Virtual sensors

`apps/twin/src/scene/SensorRig.tsx` registers itself as the reference
device's frame source (`MockKinoDevice.setFrameSource`). On any preview,
capture, or thumbnail request it renders the live scene from that camera's
optical center — position from the hardware profile's camera-node instances
at the configured pitch (`apps/twin/src/scene/sensor.ts`), horizontal FOV
from the stated 69/72/75° lens scenario (the physical lens is
MEASURE_REQUIRED; every render is SIMULATED and labeled) — into a render
target, reads the pixels, and encodes a real JPEG.

Consequences:

- Four cameras produce four genuinely different perspectives; moving a
  subject closer increases parallax (`neighborParallaxDeg` is the pure check).
- A committed capture's `C1..C4` files ARE those renders — `MEDIA_READ`
  serves the same bytes, `MEDIA_INFO` hashes them, `MEDIA_THUMB` serves the
  rendered thumb. No "capture successful" without an image (brief §20).
- The rear display's viewfinder shows the live render (~3 fps), labeled
  `CAM1/CAM2 PREVIEW · SIMULATED RENDER`; with no renderer running it falls
  back to the labeled framing marks. The preview camera follows the firmware
  profile: CAM2 (product viewfinder) on the demo profile, CAM1 on current
  firmware — the only camera M1B has.
- If a render fails, the device falls back to its synthesized placeholder so
  the wire never goes silent; protocol tests in Node stay deterministic.

## Storage format parity (brief §21)

Twin captures live in the reference device's media store with the mock's
established `/DCIM`-style ids (`WG… / QD…`), matching what Studio consumes
today. The real firmware's `/KINO/CAPTURES/<uuid>/` layout is not imposed on
the mock until the gallery capability lands in firmware (milestone 2) — the
audit records this as the storage seam to align then.

## Operating the camera (brief §13/§18/§19)

OPERATE view (viewport bar) frames the photographer's position: rear display
and shutter in front of you, subject visible past the body. SHUTTER lives in
the header and on the SCREEN tab; pressing it drives the same framed-KDP
capture path Studio uses, the display reacts through boot/capture/save, and
the resulting JPEG lands in the gallery Studio reads.

## Performance

Sensor renders happen on demand (capture/preview requests) plus a ~3 fps
display-preview loop — the interactive frame loop is untouched; render
targets are cached per resolution and disposed with the rig.
