# Roll–Twin integration

How the KINO Twin uploads virtual captures to a real KINO Roll, so the whole guest loop can be built and tested before the physical camera has Wi-Fi.

## What it is

`apps/twin/src/roll/bridge.ts` is a development bridge: a browser-side stand-in for the future firmware upload task defined in [ROLL_DEVICE_CONTRACT.md](ROLL_DEVICE_CONTRACT.md). It watches the virtual device commit captures to its simulated SD store (`{t:'capture', phase:'committed'}` telemetry), then drives the same public device wire contract a physical camera will use. It does not change what the device claims over KDP: the current-firmware profile keeps reporting `rollUpload: false`.

Pieces:

- `apps/twin/src/roll/bridge.ts` — registration, Roll create/join, upload queue with backoff retry, idempotent by capture UUID + asset role.
- `apps/twin/src/panels/RollPanel.tsx` — the ROLL tab: server, association, QR, queue state, single-frame test ingest.
- `apps/twin/src/display/deviceUi.ts` (`rollBridgeTile`) — `JOIN THIS ROLL` QR on the virtual D4 display; the QR payload is the real guest URL.
- `packages/test-fixtures/src/MockKinoDevice.ts` — `readCaptureAssets()` and `renderSourceFrame()` taps (device-side, like `onTelemetry`; Studio never uses them).

## Run the loop locally

```bash
docker compose -f infra/docker-compose.dev.yml up -d   # postgres :5435, redis :6380, minio :9000
npm run db:migrate -w @kino/api
npm run dev -w @kino/api        # :3000
npm run dev -w @kino/worker     # derivatives (thumb, wiggle webp/mp4, metadata)
npm run dev -w @kino/roll-web   # guest app, /api proxied to :3000
npm run dev -w @kino/twin       # twin, /api proxied to :3000
```

Then in the Twin:

1. POWER ON. Pick a firmware profile (FIRMWARE tab).
2. ROLL tab → CREATE ROLL. The virtual D4 display now shows the `JOIN THIS ROLL` QR; scan it with a phone (or click OPEN GUEST ROLL).
3. STAGE tab → place a subject, set the lighting.
4. Press SHUTTER. On the `SIMULATED FUTURE` profile the four rendered frames upload (thumb first); the guest feed updates live over SSE and the worker upgrades the tile to a Wiggle.
5. On the `CURRENT FIRMWARE` profile there is no group capture — use SEND TEST FRAME for the Milestone-1 single-frame ingest (`mode: single`, no Wiggle controls in Roll).

Note: guest and host URLs are built from the API's `PUBLIC_BASE_URL` (default `https://kino.acronym.sk`). For a phone-scannable local QR, start the API with `PUBLIC_BASE_URL` pointed at the roll-web dev server as reachable from the phone, e.g. `PUBLIC_BASE_URL=http://<your-lan-ip>:5173`.

## Capture mapping

| Twin | Roll |
|---|---|
| Committed capture `WG…`/`QD…` on the simulated SD | `kino.capture` with a fresh UUIDv4, `deviceId` of the Twin's registered device |
| Rendered 800×600 per-camera JPEGs | `original-frame` 1..N |
| Rendered 200×150 CAM2 thumb | `thumb` (uploads first → `preview-ready`) |
| Firmware profile | provenance (`twin.firmwareProfile` passthrough key) |
| 1 frame available | `mode: single` — never a fake Wiggle |

## Outage behavior

Stop the API mid-party: the shutter keeps working, captures queue in the bridge, the panel shows `UNREACHABLE — RETRYING`. Restart the API: the queue drains with the same capture UUIDs, so nothing duplicates. The queue is in-memory by design — a page reload also resets the simulated SD, so there would be nothing left to read. The persistent-across-reboot requirement applies to physical firmware and lives in the device contract.

## Limits

- One browser tab is the camera; the bridge reads capture bytes from the live simulator, so powering the sim off drops undelivered queue entries (reported in the panel).
- Uploads run at browser-fetch speed against localhost; use `npm run party:sim` for load, not the Twin.
