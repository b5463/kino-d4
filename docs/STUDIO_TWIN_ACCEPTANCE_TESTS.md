# Studio + Twin acceptance tests

Issue #72. Two layers: the automated contract test, and the no-code virtual
walk. Labels: REAL (works now, verified), SIMULATED (works now, simulation
clearly labeled), FUTURE (waits on a later firmware milestone),
BLOCKED_BY_HARDWARE (waits on the physical bench).

## Automated contract test — REAL

`packages/test-fixtures/tests/firmwareIntegration.test.ts` (runs in CI):

1. Pin the device to the current-firmware profile (`d4-m1b`).
2. HELLO — product, protocol, nonce echo, session id.
3. GET_DEVICE_INFO / GET_CAPABILITIES / GET_STORAGE_STATUS /
   GET_CAMERA_INFO — the honest M1B shapes (CAM2–4 offline, one capability).
4. Unimplemented commands NACK with the firmware version.
5. CAMERA_TEST — checksummed capture result.
6. A frame-source capture produces REAL bytes: `MEDIA_READ` returns exactly
   the rendered JPEG, `MEDIA_THUMB` the rendered thumb, `CAMERA_PREVIEW`
   the rendered preview; all four cameras rendered.
7. REBOOT → reconnect → session changed.
8. OTA install of a `0.1.0` image over `FW_BEGIN/CHUNK/END` (SHA-256
   verified) switches the device to the honest M1B profile.

Plus: 42 kdp_core host checks (framing), Twin's 112 unit tests, Studio's 220
(incl. the conformance suite's six capability-gated bench cases).

## Virtual user acceptance walk (brief §46)

| Step | Status |
|---|---|
| Open Twin, see the D4 in 3D | REAL |
| STAGE tab → ADD PERSON | REAL |
| Distance preset 1.5 m | REAL |
| DIM PARTY lighting | REAL (SIMULATED light model) |
| See the person on the rear display viewfinder | SIMULATED render, labeled |
| Press SHUTTER (header / SCREEN tab) | REAL — framed-KDP capture path |
| Watch capture stages on display + 3D | REAL |
| Image generated | REAL JPEG from the virtual sensors |
| Open Studio, CONNECT KINO TWIN | REAL (same-origin tabs — `npm run preview:all` or one dev origin) |
| See the capture in the gallery, inspect metadata | REAL under the demo profile; FUTURE under current firmware (M1B has no media surface — honest) |
| Updates → FIRMWARE BUILDER → BUILD P4 / CAMNODE | REAL — canonical Docker build, real checks (daemon running) |
| LOAD BUILT PACKAGE → UPDATE → watch D4 reboot | REAL against Twin (demo profile; the current-firmware profile has no OTA, like the hardware) |
| Reconnect, confirm firmware version + narrowed capabilities | REAL |
| Move the subject closer, parallax increases across CAM1–4 | REAL (multi-cam views exist on the demo profile; single-cam on current firmware) |
| Faults have consequences | REAL — FAULTS tab: offline/sd/crc faults change captures, NACKs, telemetry |
| Distinguish SIMULATED from MEASURED | REAL — transport suffixes + per-value labels |

## Brief §50 answers

Yes to every question except two, answered honestly:

- *"Can Studio eventually use the same firmware artifact for real
  hardware?"* — the artifact and manifest are the real repository build;
  the in-Studio flash path to hardware is FUTURE (firmware OTA, milestone
  7). Direct `idf.py flash` uses the same binaries today.
- *"Can I see that capture in Studio [under current firmware]?"* — FUTURE:
  the real M1B build has no gallery surface, so the Twin's current-firmware
  profile honestly NACKs it too. Under the labeled demo profile the full
  walk works today.

## BLOCKED_BY_HARDWARE

Everything in `firmware/HARDWARE_VALIDATION.md`: nothing in this integration
claims bench validation. The Twin's numbers stay SIMULATED until the
physical D4 produces measured ones.
