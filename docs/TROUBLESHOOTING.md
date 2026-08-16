# Troubleshooting KINO

Start with the failure you can see. Record the Studio version or commit, P4 firmware, four camera firmware versions, browser, operating system, and whether the demo device shows the same fault.

## Studio does not start

Run from the repository root with Node.js 22 or newer:

```bash
node --version
npm ci
npm run dev -w @kino/studio
```

If dependency installation fails, keep the first error. Later workspace errors are often fallout. Do not replace `npm ci` with an unrecorded dependency upgrade.

If the page is blank, check the browser console and the terminal running Vite. Confirm the local address matches the one printed by Vite.

## Web Serial is unavailable

Physical camera access needs desktop Chrome or Edge in a secure context. `localhost` qualifies. Firefox and Safari do not expose Web Serial.

The **OPEN DEMO DEVICE** button should still work. If it does, Studio is running and the remaining fault is in browser support, permissions, USB, or the camera.

## The camera is missing from the port picker

1. Use a known data-capable USB-C cable.
2. Connect directly instead of through an unpowered hub.
3. Close other Studio tabs, serial monitors, and IDE terminals that may own the port.
4. Check the operating system's device list for a new serial device.
5. Try the other exposed USB-C port only after confirming the board documentation.
6. Reboot the camera, then reopen the port picker.

A charging indicator proves power. It does not prove the cable carries data.

## The port opens, then handshake fails

Studio tolerates ESP32 ROM boot text and resynchronizes on the KDP frame magic. Persistent failure usually means the wrong port, incompatible firmware, damaged framing, or a camera that never reached application firmware.

Collect:

- the exact handshake message;
- P4 boot output;
- Studio logs with tokens and private media removed;
- the claimed KDP protocol range;
- whether the demo device connects.

If Studio says the product is not KINO, stop. Do not run firmware or destructive commands against an unidentified serial device.

## Protocol mismatch

The current KDP protocol version is defined in `packages/kdp/src/protocol/commands.ts`. Studio and firmware negotiate during HELLO. A mismatch needs a compatible build, not a different cable.

Check [`firmware-contract/README.md`](../firmware-contract/README.md) before changing command values or payloads. Unknown commands should produce `UNSUPPORTED_COMMAND`; they should not crash the device.

## The camera disconnects under load

Treat an unexpected live-session disconnect as a hardware or power fault until measured otherwise.

1. Repeat with flash disabled.
2. Repeat with one camera powered, then add cameras one at a time.
3. Measure the 5 V rail at the main unit and the farthest camera.
4. Record the lowest rail voltage during capture and parallel transfer.
5. Inspect the fuse, battery connector, SW6106 carrier, camera switches, and bulk capacitors.
6. Check whether the failure follows USB, battery, or both.

The fitted battery harness is limited to 3 A sustained. The BMS's larger advertised number does not override the harness.

## One camera is offline

Power down before moving a harness.

Check the affected channel in this order:

1. connector polarity and seating;
2. switched 5 V at the XIAO;
3. common ground;
4. P4 TX to XIAO RX crossover;
5. XIAO TX to P4 RX crossover;
6. MOSFET, NPN, diode, and resistor orientation;
7. camera firmware and sensor detection.

Swap the camera module with a known channel. If the fault follows the module, inspect that module. If it stays on the channel, inspect the switch and harness. Record the swap; do not diagnose by appearance alone.

## Gallery or microSD failures

Originals land on microSD before derivatives or uploads.

- Confirm the card is detected and reports free space.
- Test with an expendable known-good card.
- Preserve a failing card before formatting it.
- Check whether existing files read before writing new captures.
- Compare file size and SHA-256 when a transfer completes but the image is damaged.
- Retry a media read from a new offset after an interruption.

Do not treat a successful thumbnail as proof that all four originals are intact.

## WIGGLE looks out of phase

Run the skew bench and keep the three timing values separate:

| Value | Meaning |
|---|---|
| GPIO distribution skew | When camera nodes handled the shared edge |
| VSYNC phase skew | Position of each rolling sensor in its frame cycle |
| Effective exposure skew | Best measurement or estimate of scene capture time |

A low GPIO number can coexist with a large exposure spread. Check camera order, lens order, per-camera frame identity, VSYNC telemetry, and the physical rigidity of the camera bar. Missing timing data must appear as `null` with a reason.

## Flash causes bands or resets

Begin at the 350 mA driver setting.

- Measure rail sag and LED current during the pulse.
- Confirm the P4 controls only the driver's enable input.
- Inspect the LED star, thermal pad, and heatsink contact.
- Compare short and long shutter settings.
- Record which cameras show a band and where it crosses the frame.
- Repeat without flash to separate timing from power collapse.

Do not raise flash current to hide an exposure-timing fault.

## Firmware update recovery

Keep the camera connected after an expected reboot. Studio retries the remembered port during the recovery window.

If it does not return:

1. record the package manifest, target, size, and SHA-256;
2. check whether the serial device disappeared or changed identity;
3. reconnect with a known cable and stable power;
4. enter the board's documented bootloader path;
5. restore the last known recoverable build;
6. do not retry an image intended for a different target.

Firmware rollback is not implemented in the current KDP command surface. Recovery uses the board bootloader and a known build until that contract exists.

## API tests fail immediately

Start and migrate the local services:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api
```

Expected host ports are PostgreSQL `5435`, Redis `6380`, MinIO `9000`, and MinIO console `9001`. The defaults match `infra/.env.example`.

If health returns `503`, inspect which dependency is false. A missing migration usually reports a missing relation during test setup. A missing `kino-media` bucket fails storage health even when MinIO itself is reachable.

## Production refuses the cookie secret

The committed cookie secret is a public development placeholder. Configuration accepts it only when `NODE_ENV` is exactly `development` or `test`.

Set a fresh production secret and an explicit environment. Do not weaken the check or add a production fallback.

## Before filing an issue

Include the smallest repeatable path, logs with private data removed, exact versions, and the result from the demo device. Hardware faults should include voltage readings, the unit record from [`hardware/TESTING.md`](../hardware/TESTING.md), and clear photographs of the affected connection.

Use the repository issue form that matches the fault. Security failures belong in a private advisory, as described in [`SECURITY.md`](../SECURITY.md).
