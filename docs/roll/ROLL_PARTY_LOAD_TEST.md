# Roll party load test

`npm run party:sim` (`infra/scripts/party-sim.ts`) compresses a party into minutes against a running Roll API: one simulated camera with bursty shutter behavior, many concurrent SSE guest sessions, and an outage drill you perform by stopping the API mid-run.

## Run

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run dev -w @kino/api &
npm run dev -w @kino/worker &

npm run party:sim -- --captures 20 --guests 20 --duration 300
```

Flags: `--captures N`, `--guests N` (SSE sessions), `--duration S`, `--burst N` (max captures per burst), `--wait S` (per-capture retry budget), `--base-url`, `--fixtures DIR`.

Mind the device rate limit. A registered camera gets **120 upload-path requests per minute per route** (`deviceUpload` in `apps/api/src/plugins/rateLimits.ts`; 60 is only the fallback for a bearer the `devices` table does not know). The counter is keyed by method and route pattern, so each of the five upload routes carries its own 120 — the budgets are not pooled.

One 4-frame capture costs seventeen metered requests: 1 capture create, 5 `assets/init`, 5 part `PUT`, 5 upload complete (thumb plus four frames, one part each), 1 capture complete. The busiest route is therefore 5 per capture, and the sustained ceiling is `120 / 5` = **24 captures per minute**, one every 2.5 s.

That is above what the hardware does — a D4 shoots about 20 a minute — so the limit is no longer the binding constraint on a single camera. Pick `--captures`/`--duration` for a cadence under 24/min anyway, or expect 429 retries to dominate the run.

## Outage drill (the §25 behavior)

While the run is going, stop the API for ~20 s, then start it again. Expected: uploads retry with backoff (`uploadRetries` > 0 in the report), guests reconnect (`sseReconnects` > 0), every capture still lands exactly once (`duplicates: 0`), and the run exits 0.

## Report

The script prints JSON: captures requested/uploaded/in-feed/duplicates, SSE event and reconnect counts, and live-arrival percentiles (capture create → first guest `capture.created` receipt): `p50ms`, `p95ms`, `maxMs`. It exits non-zero on any lost or duplicated capture.

## Scale targets

The Roll MVP spec targets a 2,000-capture archive and ~100 simultaneous guests. Reference runs:

```bash
# arrival-heavy night — 500 captures needs ~21 min at the 24/min ceiling
npm run party:sim -- --captures 500 --guests 100 --duration 1500 --burst 3
# archive-size feed (fills one roll; then browse it in roll-web) — ~85 min at the ceiling
npm run party:sim -- --captures 2000 --guests 10 --duration 6000 --burst 3
```

Both durations carry about 20 % over the ceiling for retries. The bound is the 5-per-capture route, not the camera: at 24 captures a minute the rate limit sits above what a D4 can shoot, so a run that goes slower than these numbers is being paced by the sim or the worker, not by 429s. For a faster archive fill, run several sim processes against separate Rolls — each holds its own device token and therefore its own budget — rather than raising the limit.

Record measured percentiles in the issue that motivated the run; this document carries no fabricated numbers.

Related: weak-network and duplicate-retry verification is `npm run test:uploader -- --drop-part N --dup-retry` (`infra/scripts/test-uploader.ts`), which asserts the idempotency invariants one request at a time.
