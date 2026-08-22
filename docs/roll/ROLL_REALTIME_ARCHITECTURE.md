# Roll realtime architecture

How a capture reaches every open guest phone without polling. Normative source: `apps/api/src/events/*`, `apps/api/src/routes/guest-events.ts`, `apps/roll-web/src/hooks/useRollEvents.ts`.

## Transport: SSE over Redis streams

- Publish: `publishRollEvent(redis, rollId, event)` does `XADD roll:<id>:stream MAXLEN ~500` then `PUBLISH roll:<id>:events`. The stream entry id becomes the SSE `id:`, which makes reconnect replay exact.
- Serve: `GET /api/rolls/:slug/events` (`text/event-stream`), heartbeat comment every 25 s, `retry: 3000`, `Last-Event-ID` replays missed events from the stream. Host variant: `/api/host/rolls/:rollId/events`.
- Consume: `useRollEvents` reconnects with 1 s → 30 s backoff, pauses on `visibilitychange`/`pagehide`, refetches the feed head on every reconnect so nothing is missed even past the 500-entry stream window.

SSE was chosen over WebSocket deliberately: delivery is one-way, proxies and phone sleep/wake handle SSE reconnect semantics well, and `Last-Event-ID` gives replay for free.

## Event types

| Event | Emitted when |
|---|---|
| `capture.created` | Capture document inserted (`device-captures.ts`) |
| `capture.updated` | Capture completed, or any asset upload completed — this is the progressive-asset signal |
| `processing.completed {captureId, role}` | Worker finished one derivative |
| `capture.hidden` / `capture.deleted` | Host moderation; guests' feeds react live |
| `roll.opened` / `roll.closed` | Host lifecycle |

## Progressive delivery to the guest

1. Capture created → `capture.created` → guest fetches the capture; tile appears as soon as any asset is `ready`.
2. `thumb` upload completes → `capture.updated` → tile shows the thumbnail (`preview-ready`).
3. Each worker derivative → `processing.completed` → tile upgrades (Wiggle preview, then video).

Guests always see the most useful version that exists; nothing waits for originals.

## Load shape

One Redis stream + one pub/sub channel per Roll; SSE responses cap buffered backpressure at 64 KiB per client. `npm run party:sim` exercises this with concurrent SSE guests and reports capture-to-guest arrival percentiles (see [ROLL_PARTY_LOAD_TEST.md](ROLL_PARTY_LOAD_TEST.md)).
