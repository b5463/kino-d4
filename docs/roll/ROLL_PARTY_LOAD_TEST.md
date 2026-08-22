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

Mind the device rate limit: the API allows 60 upload-path requests per minute per device (`apps/api/src/plugins/rateLimits.ts`), and one 4-frame capture costs 14 metered requests (create + 4×(init, part, complete) + complete), so a single simulated camera sustains ~4 captures per minute. That is the real product constraint — a physical camera shoots at that cadence — so pick `--captures`/`--duration` under it, or expect 429 retries to dominate the run.

## Outage drill (the §25 behavior)

While the run is going, stop the API for ~20 s, then start it again. Expected: uploads retry with backoff (`uploadRetries` > 0 in the report), guests reconnect (`sseReconnects` > 0), every capture still lands exactly once (`duplicates: 0`), and the run exits 0.

## Report

The script prints JSON: captures requested/uploaded/in-feed/duplicates, SSE event and reconnect counts, and live-arrival percentiles (capture create → first guest `capture.created` receipt): `p50ms`, `p95ms`, `maxMs`. It exits non-zero on any lost or duplicated capture.

## Scale targets

The Roll MVP spec targets a 2,000-capture archive and ~100 simultaneous guests. Reference runs:

```bash
# arrival-heavy night — 500 captures needs ~125 min at the 4/min device budget
npm run party:sim -- --captures 500 --guests 100 --duration 7500 --burst 3
# archive-size feed (fills one roll; then browse it in roll-web) — ~8.5 h at real cadence
npm run party:sim -- --captures 2000 --guests 10 --duration 30000 --burst 3
```

Both are bounded by the per-device upload rate limit, exactly like a physical camera. For a faster archive fill, run several sim processes against separate Rolls rather than raising the limit.

Record measured percentiles in the issue that motivated the run; this document carries no fabricated numbers.

Related: weak-network and duplicate-retry verification is `npm run test:uploader -- --drop-part N --dup-retry` (`infra/scripts/test-uploader.ts`), which asserts the idempotency invariants one request at a time.
