# Roll party load test

`npm run party:sim` (`infra/scripts/party-sim.ts`) compresses a party into minutes against a running Roll API: one simulated camera with bursty shutter behavior, many concurrent SSE guest sessions, and an outage drill you perform by stopping the API mid-run.

## Run

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run dev -w @kino/api &
npm run dev -w @kino/worker &

npm run party:sim -- --captures 60 --guests 20 --duration 120
```

Flags: `--captures N`, `--guests N` (SSE sessions), `--duration S`, `--burst N` (max captures per burst), `--wait S` (per-capture retry budget), `--base-url`, `--fixtures DIR`.

## Outage drill (the §25 behavior)

While the run is going, stop the API for ~20 s, then start it again. Expected: uploads retry with backoff (`uploadRetries` > 0 in the report), guests reconnect (`sseReconnects` > 0), every capture still lands exactly once (`duplicates: 0`), and the run exits 0.

## Report

The script prints JSON: captures requested/uploaded/in-feed/duplicates, SSE event and reconnect counts, and live-arrival percentiles (capture create → first guest `capture.created` receipt): `p50ms`, `p95ms`, `maxMs`. It exits non-zero on any lost or duplicated capture.

## Scale targets

The Roll MVP spec targets a 2,000-capture archive and ~100 simultaneous guests. Reference runs:

```bash
# arrival-heavy night
npm run party:sim -- --captures 500 --guests 100 --duration 600 --burst 6
# archive-size feed (fills one roll; then browse it in roll-web)
npm run party:sim -- --captures 2000 --guests 10 --duration 300 --burst 8
```

Record measured percentiles in the issue that motivated the run; this document carries no fabricated numbers.

Related: weak-network and duplicate-retry verification is `npm run test:uploader -- --drop-part N --dup-retry` (`infra/scripts/test-uploader.ts`), which asserts the idempotency invariants one request at a time.
