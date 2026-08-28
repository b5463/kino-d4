# Milestone 1B bench procedure

The exact single-camera bring-up sequence for our physical Guition
JC4880P443C-I-W and one XIAO ESP32-S3 Sense. Record every stage's result in
[`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md) and issue #66: firmware
revision, wiring revision, result, failure notes. Do not skip a stage because
a later one "would prove it anyway".

Prerequisites: `kino-p4.bin` and `kino-camnode.bin` from this tree
(`firmware/README.md` has the build and flash commands), a known-good
microSD you can afford to lose (a spare card — the self-test is
non-destructive by design, but this is its first run on real hardware),
Studio or any KDP serial client, a multimeter.

## A — P4 only

1. Power the bare P4 board. Watch temperature by touch near the SW6106 and
   the P4 for the first minutes.
2. Verify USB enumeration on the host. Note WHICH physical USB-C port
   enumerates as what — the field notes say the FS port is USB-Serial-JTAG;
   this is assumption `USB_SERIAL_JTAG`.
3. Console (UART0, GPIO37/38, 115200) must show `P4_BOOT`,
   `USB_TRANSPORT_READY`, `SD_MOUNT` (or its failure), `KDP_READY`.
4. Connect Studio. HELLO must succeed inside the 3×500 ms retry budget with
   the nonce echoed.
5. `GET_DEVICE_INFO`, `GET_CAPABILITIES` (expect `benchDiagnostics: true`,
   everything else false), `GET_HW_VALIDATION` (expect `USB_SERIAL_JTAG`
   flipped to VALIDATED — the device saw your frames).
6. `REBOOT` from Studio; reconnect; the session id must change (`boot-N+1`).
7. Repeat the reboot/reconnect cycle ×10. Any hang, missing session change,
   or failed reconnect fails the stage.

## B — SD

1. Insert the known-good card. Boot.
2. `GET_STORAGE_STATUS`: `present`, `mounted`, real `capacityBytes`,
   `mountAttempts: 1`, `lastError: null`. A mount failure here means the pin
   or LDO assumption is wrong — record it, then probe CLK/CMD/D0–D3 against
   the field-note map before changing `board_d4v1.h`.
3. `STORAGE_SELF_TEST` (Studio → Developer → Bench Diagnostics). Expect PASS,
   64 KB verified. On failure the response names the exact phase.
4. Reboot and remount ×10; `mountAttempts` restarts per boot, every mount
   must succeed.
5. Confirm pre-existing card data is untouched (directory listing on a PC).

## C — CAM1 safe bring-up

1. Flash one XIAO with `kino-camnode.bin` over its own USB-C. Its console
   (native USB) must show the sensor detect line.
2. Wire P4↔XIAO, three wires only, on the P4's `JP1` header (26-pin, 2×13,
   odd pins left, pin 1 top):

   ```text
   P4 CAM1_TX  GPIO1  (JP1 pin 7)    → XIAO RX GPIO44
   P4 CAM1_RX  GPIO2  (JP1 pin 9)    ← XIAO TX GPIO43
   common GND         (JP1 pin 5/6)  — XIAO GND
   ```

   GND first. No 5 V from the P4 header yet — the XIAO is powered from its
   own USB-C for this stage, and P4↔XIAO are connected by GND + TX/RX and
   nothing else. **Do not wire from the old GPIO52/GPIO51 instructions.**
   Those pins are not on the header; a wire placed by that map lands on
   a different signal. Pin numbers come from `board_d4v1.h`
   (`BOARD_CAM1_TX_JP1`, `BOARD_CAM1_RX_JP1`); check them against the
   silkscreen before the first power-up.
3. Verify with the meter: common ground, idle UART lines at 3.3 V. Confirm
   pin 7 and pin 9 by counting from pin 1, not by position on the ribbon.
4. Within ~2 s the P4's probe marks CAM1 online. `GET_CAMERA_INFO` must show
   `cam1.online`, the sensor name and PID from the real SCCB read, the node
   firmware, session, and reset reason (`power-on` on a cold boot — anything
   else, stop and read the node console).
5. `CAMERA_LINK_STATS`: zero `crcErrors`/`timeouts` after a minute of idle
   probing. Boot-banner resyncs are normal after a node reset; steady-state
   growth is not.
6. Anything abnormal — hot module, wrong PID, resets — stop. No capture.

## D — CAM1 capture

1. `CAMERA_TEST` on cam1 (Studio → Developer → Bench Diagnostics → CAM1 TEST
   CAPTURE).
2. The response must show the three checksums agreeing and the four timing
   buckets. Expected order of magnitude at 921600: transfer ≈ 2–4 s for a
   200–400 KB JPEG; capture ≤ ~300 ms.
3. Pull the card, open `/KINO/CAPTURES/<uuid>/C1.JPG` on a PC. Look at it —
   a checksum proves integrity, only an eye proves the sensor saw a scene.
   `META.JSON` must parse and carry the same checksums.
4. Repeat ×10. Watch `CAMERA_LINK_STATS` for CRC errors and
   `GET_HW_VALIDATION` for `CAM1_CAPTURE`/`CAM1_JPEG_TRANSFER`/
   `CAM1_SD_WRITE` flipping to VALIDATED.

## E — Soak

1. `CAMERA_SOAK_TEST`: 100 captures, 1000 ms delay, `keepAll: false`.
2. Pass: 100/100 successful, zero crc/timeout/sd errors, zero node resets,
   `heapDeltaKB`/`psramDeltaKB` around zero (a steady downward trend fails
   the milestone), JPEG sizes plausible and stable.
3. If clean: 500 captures at the same cadence.
4. Export the summary JSON from the panel and attach it to issue #66.

## Recording

**A failed stage is data — pull it before you retry.** Failures on the capture
path carry their measurement in the message, and the numbers are gone once you
power-cycle:

- `GET_LOGS` after any failure. A node-link timeout logs
  `TIMEOUT cmd 0x62 seq 41 8003/8000ms 131072B 0f 0d 0c` — elapsed against the
  budget, then the bytes, frames, duplicates and CRC errors that arrived during
  that one request. Bytes still arriving at the budget means the timeout is too
  short, not that the link is dead; zero bytes with zero CRC errors means
  nothing came back at all; duplicates mean the node answered a request the P4
  had already given up on.
- `CAMERA_LINK_STATS` before and after each stage, for `latencyMaxMs`. The
  worst round trip is the number that sizes `DEFAULT_TIMEOUT_MS` and
  `CAPTURE_TIMEOUT_MS`; the last one tells you nothing.
- The NACK message itself. `TRANSFER_TIMEOUT` now reads
  `Chunk read failed at 131072/524288 B (25%) after 3004 ms`, and
  `OUT_OF_MEMORY` reads `JPEG staging wants 524288 B, free 96 KB psram /
  142 KB heap`. Copy them verbatim into the issue — a paraphrase loses the
  number that mattered.

Every timeout budget in `cam_link.c` was chosen before any hardware existed.
Treat the first run's numbers as the ones that replace them, and record the
measurement even when the stage passes.

After each stage update `HARDWARE_VALIDATION.md` from the device's
`GET_HW_VALIDATION` verdicts. When every table row is VALIDATED and the soak
target is met, Milestone 1B passes (`MILESTONE_1B_PLAN.md` §Pass/fail) and
the four-node work (milestone 2) can start.
