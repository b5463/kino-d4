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
2. Wire P4↔XIAO: GND↔GND first, then P4 GPIO52 → XIAO GPIO44 (RX), P4
   GPIO51 ← XIAO GPIO43 (TX). No 5 V from the P4 header yet — power the XIAO
   from its own USB for this stage.
3. Verify with the meter: common ground, idle UART lines at 3.3 V.
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

After each stage update `HARDWARE_VALIDATION.md` from the device's
`GET_HW_VALIDATION` verdicts. When every table row is VALIDATED and the soak
target is met, Milestone 1B passes (`MILESTONE_1B_PLAN.md` §Pass/fail) and
the four-node work (milestone 2) can start.
