# Troubleshooting KINO

Start with the failure you can see. Record the Studio version or commit, P4 firmware, four camera firmware versions, browser, operating system, and whether KINO Twin shows the same fault.

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

A KINO Twin connection should still work. Serve Studio and Twin from one origin with `npm run preview:all`, open Twin at `/dev/twin/`, and press **CONNECT KINO TWIN** in Studio. If that connects, Studio is running and the remaining fault is in browser support, permissions, USB, or the camera.

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
- whether KINO Twin connects.

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

## Roll: photographs are not appearing

Walk this in order. Each step rules something out, so do not skip one because the next looks more likely. Steps 1 and 2 need no terminal.

### Step 1 — read the camera's ROLL screen

The connection word first. It is the only place that separates a network fault from a server fault.

| Word on the screen | What it means | What it rules out | Do this |
|---|---|---|---|
| **ONLINE** | Wi-Fi is up and the server answered the last request. | The whole network path. The fault is further in — go to step 2. | Go to step 2. |
| **OFFLINE** | The camera has no network. | The server. Nothing is wrong on the server side that this camera can see. | Venue Wi-Fi, range, router. Photographs are on the card and go when Wi-Fi returns. |
| **KINO NOT ANSWERING** | Wi-Fi is up; the server did not answer. | The camera's Wi-Fi. Do not go looking at the access point. | The stack, the tunnel or relay, the internet between them. Go to step 4. |
| **UPLOAD PAUSED** | The queue halted itself: credentials or roll association were refused (HTTP 401 or 403). | A transient fault. It will not clear on its own. | Check the device token and the roll association in Studio. The camera says "Check the roll in Studio." |

Then the three lines under the card count:

- **"COUNTING THE CARD"** — the camera has not finished reading the card since boot. It does not yet know what it owes. Wait for it to settle before believing any count. A zero seen here is not a zero.
- **"N waiting to upload" / "Saved safely on camera"** — the photographs exist on the SD card. They are not lost. The camera has no way to send them right now; the connection word above says why.
- **"N waiting to upload"** with a bar — uploads are moving. If N falls, the system is working and the answer is patience.
- **"All uploaded" / "Last upload Ns ago"** — the camera owes the server nothing. The photographs are on the server. Whatever is wrong is on the server side or in the guest's browser. Go to step 3.

Logs at this step: the camera's own log, `GET_LOGS` over KDP from Studio with the camera on USB-C. The upload queue's decisions are in `firmware/p4/main/upload_queue.c` and `roll_queue.c`.

### Step 2 — read the dashboard's camera panel

Open the host dashboard with the host link. The camera panel shows each joined camera, when it was last heard from, and what it still owes.

- **The camera is listed and recently seen, queue empty** — the camera and the server agree. Go to step 3.
- **The camera is listed and recently seen, queue not empty** — uploads are in flight. Compare with the camera's own count; the camera is the one that is ahead.
- **Never heard from** — the camera joined but has never sent a heartbeat. Either it has not been on the network since joining, or it runs firmware older than the heartbeat. That is not proof the camera is broken; go back to step 1.
- **Last seen minutes ago and not moving, while the camera says ONLINE** — the two disagree. Trust the camera about the camera; treat this as a server-side fault and go to step 4.

The panel is fed by `POST /api/device/rolls/:rollId/heartbeat`. A camera that does not send it leaves those columns null; the panel says "never heard from" rather than inventing a zero.

Logs at this step: `deploy.ps1 logs -Service api`, or `docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml logs api`.

### Step 3 — do captures appear, and do they stay PENDING?

Look at the host capture list. A capture that reached the server appears there, with a status.

A capture moves `created → preview-ready → originals-uploading → complete → processing → ready`. Two of those are worth watching:

- **The capture is not in the list at all.** The server never received it. That is the camera or the network — go back to step 1.
- **The capture is in the list and settles to `ready` within a minute or two.** Working. If a guest still cannot see it, check that it is not hidden or trashed, and that the guest is on the right roll code.
- **The capture is stuck pending for more than five minutes** — that is the worker, not the camera. The bytes are on the server; nothing is rendering them. Go to step 4 and read the worker's log, not the API's.

Five minutes is the number because the worker's sweeper runs every five minutes (`SWEEP_INTERVAL_MS`, `apps/worker/src/sweeper.ts`) and re-adds any job whose row is older than two minutes and whose queue entry is missing. Anything the sweeper can fix is fixed inside one sweep. Something still stuck after two sweeps is not a lost job.

Logs at this step: `deploy.ps1 logs -Service worker`.

### Step 4 — `GET /api/healthz`

```sh
curl -sS https://<host>/api/healthz
```

`200` with `{"ok":true,"db":true,"redis":true,"storage":true}` means all three dependencies answered. `503` names which one did not:

| False | What is down | Symptom upstream |
|---|---|---|
| `db` | PostgreSQL | Nothing works. Captures do not even get created. |
| `redis` | Redis | The queue is down, so captures stall in `processing`; the guest live feed stops updating and the dashboard reports 0 guests. |
| `storage` | MinIO, or the `kino-media` bucket is missing | Asset init and part uploads fail. The camera sees 5xx and retries. |

No answer at all, from outside the LAN, with the camera saying **KINO NOT ANSWERING**: the stack is down, the PC is asleep, or the tunnel/relay is not connected. The next section separates those.

Logs at this step: `deploy.ps1 logs -Service api -Relay`, then `-Service worker`, then `-Service proxy`. Container names are `api`, `worker`, `proxy`, `web`, `postgres`, `redis`, `object-storage`, and `relay` on a relay deployment. Drop `-Relay` only on a stack that publishes 80/443 itself.

### Is the tunnel down, or is the stack down?

On the relay deployment (`infra/relay/`) the public name terminates TLS on a VPS and reaches the PC through one outbound frp connection. Two layers can fail and they look nothing alike once you know where to look. The full table, with the VPS-side commands, is in [the deployment runbook](runbooks/production-relay-deploy.md#is-it-the-tunnel-or-is-it-the-stack). The discriminator:

| What `https://kino.acronym.sk/api/healthz` returns | Layer |
|---|---|
| **502**, with valid TLS | **The tunnel.** The VPS answered; nothing was behind it. PC off, asleep, no internet, Docker Desktop not running, wrong `RELAY_TOKEN`, or port 7000 closed on the VPS. |
| **503 with a JSON body** naming `db`, `redis` or `storage` | **The stack.** That JSON could only have been written by the API, so the tunnel is fine. Read the table above for the named dependency. |
| **200** with `ok:true` | Neither. The fault is further up — DNS on the client, the camera's stored `network.apiBase`, or the roll itself. |
| No TCP connection at all | The VPS or its firewall, not the PC. |
| TLS warning | The VPS's Caddy or ACME. Do **not** delete `caddy_data` to retry; Let's Encrypt rate-limits duplicates. |
| Resolves to `37.9.175.156` | DNS. That is the Websupport parking address, so the `A` record was never changed or has not propagated. |

A running `relay` container is not proof of a tunnel. frpc retries forever by design, so a wrong token gives a healthy-looking container that never connected. The proof is the log line `login to server success` (`deploy.ps1 logs -Service relay -Relay`).

### The case the audit found: a capture stuck in `processing`

Symptom: every asset of a capture is present and `ready`, and the capture itself sits at `processing` and never settles.

Two separate mechanisms produced this, and both are addressed:

1. **A status column nobody refreshed.** The stored status is a cache. A render enqueued lazily from a guest or host route did not recompute it, so the row stayed at `processing` after the work finished. Fixed in the API on 2026-09-05: status converges on read (`convergeCaptureStatus`, `apps/api/src/uploads/uploads.ts`).
2. **A `queued` row whose BullMQ job was never added.** The API commits the job row before adding the job and swallows a failed add, on purpose — a 500 there would tell a camera its capture did not complete when it did. The row then pins the capture in `processing` for good. The worker's sweeper is the other half (audit API-14).

**What the operator does now:** re-read the capture. `GET /api/host/captures/:captureId` recomputes and returns the settled status — one read is the whole fix for case 1. **(The route is from this branch's change contract and was not read back out of `apps/api/src/routes/host-captures.ts` at the time of writing; `GET /api/device/captures/:captureId/status` does the same convergence and is verified.)**

If it is still `processing` after that read, it is case 2 and the sweeper owns it: wait one sweep (five minutes) and read again. If it is still stuck after two sweeps, the job is failing rather than missing — read `deploy.ps1 logs -Service worker` for that `jobKey` before doing anything else. There is no operator command that forces a re-render; the sweeper is the only automatic recovery, and re-running the capture-complete call from the camera is a no-op because the row is what makes it one.

## API tests fail immediately

Start and migrate the local services:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api
```

Expected host ports are PostgreSQL `5435`, Redis `6380`, MinIO `9000`, and MinIO console `9001`. The defaults match `infra/.env.example`.

If health returns `503`, inspect which dependency is false. A missing migration usually reports a missing relation during test setup. A missing `kino-media` bucket fails storage health even when MinIO itself is reachable.

## The site was up yesterday and is down after a reboot

Docker Desktop runs in the operator's user session, so on the PC-hosted deployment the whole stack is down from boot until someone signs in. The containers themselves are `restart: unless-stopped` and come back on their own **once the engine is up** — the engine is the part that waits for a login.

Remedies, in the order they matter: automatic sign-in plus a lock-screen task at logon; *Start Docker Desktop when you sign in*; `powercfg /change standby-timeout-ac 0` so the machine never sleeps. The exact commands and the one test that proves it (reboot, touch nothing, check `/api/healthz` from mobile data three minutes later) are in [the deployment runbook](runbooks/production-relay-deploy.md#windows-specific-risks-with-the-remedy).

Two things that look like this fault and are not: a container someone stopped by hand stays stopped, because that is what `unless-stopped` means — start it explicitly. And Docker Desktop can start while its engine does not, usually a pending WSL2 update waiting for a click; `docker version` returning a pipe error rather than a server version is that case.

While the site is down, photography is not. The shutter works, the capture is on the card with its UUID and Roll, and the camera's queue drains by itself when the stack returns.

## Production refuses the cookie secret

The committed cookie secret is a public development placeholder. Configuration accepts it only when `NODE_ENV` is exactly `development` or `test`.

Set a fresh production secret and an explicit environment. Do not weaken the check or add a production fallback.

## Before filing an issue

Include the smallest repeatable path, logs with private data removed, exact versions, and the result from KINO Twin. Hardware faults should include voltage readings, the unit record from [`hardware/TESTING.md`](../hardware/TESTING.md), and clear photographs of the affected connection.

Use the repository issue form that matches the fault. Security failures belong in a private advisory, as described in [`SECURITY.md`](../SECURITY.md).

## Known open issues, 2026-09-05

One list, so an incident does not start with a search of the bench log.

| Symptom | State | Where the detail is |
|---|---|---|
| A KDP reply is dropped or arrives corrupt while the camera is logging heavily | Root cause found and removed in firmware 0.4.43: the console was also on USB-Serial-JTAG, the endpoint KDP frames use, so ESP_LOG text landed inside replies. Console is UART0 only from 0.4.43. Bench proof: the decoder's `discardedBytes` must stay 0 over a session. | `firmware/HARDWARE_VALIDATION.md` (reply-loss item), `CHANGELOG.md` 0.4.43 |
| `GET_LOGS` or any reply larger than about 4 KB never arrives | Fixed in 0.4.x: the USB write was sliced to 1024 bytes and replies are capped at one 16 KB frame; `GET_LOGS` returns the newest lines that fit. | `CHANGELOG.md`, `firmware-contract/commands.md` |
| `ROLL_STATUS.serverReachable` says true while the API is stopped | Fixed in 0.4.43: it now also requires the last HTTP exchange to have been answered; `serverState` says offline / unknown / reachable / unreachable. | `firmware-contract/commands.md` RollView |
| The ROLL screen says 0 waiting while hundreds of captures are on the card | Fixed in 0.4.43: the screen shows window plus card and says when the card is still being counted. Over KDP use `pending + cardPending` and `scanComplete`. | `firmware-contract/commands.md` QueueReport |
| Uploads parked `failed` after an outage never resume | Fixed in 0.4.43: parks caused by a run of network failures are revived when the link or the server comes back, and probed every 10 minutes. Parks the server refused (4xx) still wait for a retry from Studio. | `firmware/p4/main/upload_queue.c` |
| A backend capture stays `processing` after every asset is present | Status converges on read; a render enqueued lazily from the guest or host routes did not recompute it. Fixed in the API on 2026-09-05. | `apps/api/src/uploads/uploads.ts` |
| Gallery task stack minimum about 1.3 KB | Watch item, not a fault. Measured every release; do not add stack use to that task without re-measuring. | `firmware/HARDWARE_VALIDATION.md` |
| The gallery index holds at most 4096 captures | The Photos count and `MEDIA_LIST.total` stay exact past the cap; the gallery shows the newest 4096 and Delete All removes what is indexed, then rebuilds and needs a second press for the rest. About 4096 captures is 3.2 GB of a 32 GB card. | `firmware/p4/main/gallery.c` |
| Delete All has never been run on a real card | Code ready and host-tested (0.4.42). Destructive test waits for an expendable card. | `CHANGELOG.md` 0.4.42 |
| Menu icons are Microsoft artwork | Accepted by the operator for private, unpublished builds (2026-09-05); a blocker only if a binary is ever distributed, issue #134. | `docs/RELEASING.md` stop-gates |

