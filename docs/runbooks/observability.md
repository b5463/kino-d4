# KINO production observability

## Signals and access

The API emits pino JSON to stdout with request IDs. The worker emits job/capture IDs, and Caddy emits JSON access logs. Production Compose stores all three with Docker's rotating `json-file` driver (20 MB × 5 files per container). Forward those files to Loki when a central collector exists; never enable body logging or remove the existing credential redaction.

`GET /api/metrics` returns Prometheus text only with `Authorization: Bearer <METRICS_TOKEN>`. The route is a 404 when the token is not configured. Store the token in the Prometheus secret store, not its checked-in configuration.

Application metrics include:

- `kino_http_request_duration_seconds` and request/error counters, labelled by route template rather than raw URL;
- `kino_upload_failures_total`;
- `kino_queue_jobs{state=...}` and durable `kino_worker_failures`;
- `kino_object_storage_bytes` / `kino_object_storage_objects` for both buckets;
- per-process `kino_sse_connections`;
- `kino_active_devices`, meaning a successful authenticated device request in the last 15 minutes.

Scrape the API every 60 seconds. Object enumeration is intentionally accurate and can be expensive at large scale; do not use a sub-minute interval. Sum HTTP/SSE counters across API replicas. Queue, database, and object metrics are shared and should use `max`, not `sum`, across replicas.

MinIO also exposes cluster metrics at `http://object-storage:9000/minio/v2/metrics/cluster` on the private Compose network. Start `node-exporter` with the `observability` profile and scrape `node-exporter:9100`; it is not published to the host. Attach Prometheus to the KINO Compose network or run an authenticated collector sidecar—do not publish either endpoint to the internet.

## Initial alerts

Tune after observing two real events; until then use these conservative thresholds:

| Signal | Warning | Critical |
|---|---:|---:|
| API p95 latency | > 1 s for 10 min | > 2.5 s for 5 min |
| API 5xx ratio | > 1% for 10 min | > 5% for 5 min |
| Upload failures | > 5 in 5 min | > 20 in 5 min |
| Waiting + delayed queue | > 100 for 10 min | > 500 for 5 min |
| Worker failures | any increase | > 5 new in 15 min |
| Host disk used | > 80% | > 90% |
| MinIO used capacity | > 80% | > 90% |
| SSE connections per API | > 400 | > 800 |
| Active devices during a scheduled event | drops to 0 for 10 min | drops to 0 for 20 min |
| Latest daily backup | older than 26 h | older than 36 h |
| Latest restore drill | older than 30 d | older than 45 d |

An alert is actionable only when its annotation links here, identifies the KINO environment, and includes the relevant request/job IDs. Queue depth without worker failures usually means capacity; failures without depth usually mean a bad input or deploy. Preserve that distinction during triage.
