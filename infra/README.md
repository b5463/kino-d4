# KINO environments

KINO keeps development, staging, and production isolated. They do not share credentials, databases, object buckets, Compose project names, or persistent volumes.

## Local development

The development stack exposes PostgreSQL, Redis, and MinIO to the host for the test suite:

```sh
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate --workspace @kino/api
```

Its committed credentials are disposable and must never be reused elsewhere.

## Staging

1. Copy `infra/.env.staging.example` to `infra/.env.staging`.
2. Replace every `change-me` value with independently generated credentials.
3. Ensure passwords used inside `DATABASE_URL` and `REDIS_URL` are URL-safe or percent encoded.
4. Point the staging DNS name at the host.
5. Start the isolated stack:

```sh
docker compose --env-file infra/.env.staging -f infra/docker-compose.prod.yml up -d --build
```

The `KINO_ENV=staging` value gives the stack its own Compose project and therefore its own volumes. The sample maps staging to ports 8080/8443 so it cannot take over production listeners on the same host.

## Windows server (deploy.ps1)

`infra/deploy.ps1` wraps the production Compose stack for a Windows server running Docker with Compose v2. PowerShell 5.1 is enough.

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 init    # env file + generated secrets
# edit infra\.env.production: KINO_SITE_ADDRESS, PUBLIC_BASE_URL
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 check   # docker, placeholders, interpolation
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 up      # build, start, wait for healthy
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 update  # git pull --ff-only + up
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 status
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 logs -Service api
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 backup  # pg_dump to infra\backups\
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 down    # volumes preserved
```

`init` replaces every `change-me` placeholder with a generated secret, keeping the same token identical everywhere it appears (so `DATABASE_URL`/`REDIS_URL` stay consistent with the passwords). `-EnvName staging` targets `infra/.env.staging` instead. `backup` covers the database only; the MinIO volume follows `infra/scripts/backup.sh`.

## Production (manual steps)

1. Copy `infra/.env.prod.example` to `infra/.env.production`.
2. Replace every placeholder with production-only credentials. Generate `COOKIE_SECRET` from at least 32 random bytes.
3. Point `KINO_SITE_ADDRESS` and `PUBLIC_BASE_URL` at the production DNS name.
4. Start the stack:

```sh
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d --build
```

Only Caddy publishes host ports. PostgreSQL, Redis, MinIO, the API, the worker, and the static web service remain on the private Compose network. Caddy obtains and renews TLS automatically for a public hostname, streams server-sent events without buffering, sends `/api/*` to the API, and serves Studio at `/studio/` with Roll everywhere else. Roll invitation and host pages receive an `X-Robots-Tag: noindex, nofollow, noarchive` header.

Production sets `OBJECT_DELIVERY=proxy`: media and firmware bytes pass through the authorized API rather than exposing an internal MinIO URL. Local development retains short-lived presigned URLs.

Production also defaults to `DEVICE_REGISTRATION_MODE=first-write-wins`. Re-submitting a serial can never rotate a deployed device's credential. If a physically verified device loses its token, first restrict public access to the registration endpoint, set `DEVICE_REGISTRATION_MODE=rotate` for a maintenance restart, register that one device, then restore `first-write-wins` and public access immediately. Never leave rotation enabled on an internet-reachable API.

The migration container must finish successfully before the API and worker start. A failed migration leaves the application stopped instead of booting against a partial schema.

`JOB_QUEUE_PREFIX` must have the same value in the API and worker. Compose supplies it through their shared environment; changing it on only one process writes jobs to a queue no worker consumes.

## Verification

Validate interpolation without starting services:

```sh
docker compose --env-file infra/.env.prod.example -f infra/docker-compose.prod.yml config --quiet
```

After startup, verify `https://<host>/api/healthz`, `/`, and `/studio/`. The complete upload-to-gallery staging exercise is automated by the Task 37 test uploader.

### Camera-simulating uploader

The uploader exercises the same HTTP contract as a camera, including multipart resume semantics and the real background worker. It never prints device or host credentials.

For a fresh disposable device and Roll:

```sh
npm run test:uploader -- --base-url https://staging.kino.acronym.sk --serial KD4-STAGING-0001 --drop-part 3 --dup-retry --slow 200ms --close
```

`--drop-part 3` treats the third successful part response as lost and sends that numbered part again. `--dup-retry` replays capture creation, upload completion, completed asset initialization, and capture completion. The command succeeds only after every capture is `ready`, appears in the guest feed, and—when `--close` is set—the Roll is closed.

For an already registered device, keep its bearer token out of shell history and process listings:

```sh
export KINO_DEVICE_ID=dev_example
export KINO_DEVICE_TOKEN=kdt_example
npm run test:uploader -- --base-url https://staging.kino.acronym.sk --join ABC123
```

Load mode uses the same upload path and can add concurrent, fully paginated guest readers. Start below the production budgets and increase deliberately while watching queue depth and error rate:

```sh
npm run test:uploader -- --base-url https://staging.kino.acronym.sk --serial KD4-LOAD-0001 --captures 4 --viewers 24 --viewer-polls 2
```

The default mutation budget is 60 requests per minute per device token; one four-frame capture uses about 14 mutations. For a hundreds-of-captures endurance run, pace one camera with `--slow 1s` or run multiple physically distinct test-device credentials. Do not weaken the production budget merely to make a benchmark finish sooner.

Run `npm run test:uploader -- --help` for fixture, timeout, and pacing options. Production registration is first-write-wins, so reuse `KINO_DEVICE_ID` and `KINO_DEVICE_TOKEN` after the initial physically controlled registration instead of attempting to register the serial again.

## Pre-deploy checklist (release closure, 2026-09-05)

Run through this before the first `deploy.ps1 up` on the public host, and
again after any change to `.env.production`. Each line is a check, not a
setting to invent.

| Check | How | Expected |
|---|---|---|
| Secrets complete | `deploy.ps1 check` | no `change-me` left; `compose config --quiet` passes |
| `NODE_ENV` | `.env.production` | `production` (the dev cookie secret and dev provisioning token are refused unless `development`/`test`) |
| Public hostname and base URL | `.env.production` | `KINO_SITE_ADDRESS=kino.acronym.sk`, `PUBLIC_BASE_URL=https://kino.acronym.sk` |
| TLS | Caddy log after `up`; `https://kino.acronym.sk/api/healthz` | certificate issued by ACME for the site address, 200 with `db`, `redis`, `storage` true |
| PWA API URL | none to set | roll-web is same-origin behind Caddy; there is no `VITE_*` base URL to get wrong |
| API base compiled into the camera | `firmware/HARDWARE_VALIDATION.md`, `GET_CONFIG network.apiBase` | the bench image is built with `-DKINO_ROLL_API_BASE=https://kino.acronym.sk`; the stored `network.apiBase` on the bench body points at the LAN dev API and must be cleared or set to production before the E2E |
| Object store endpoint | compose | `S3_ENDPOINT=http://object-storage:9000` (private network), `OBJECT_DELIVERY=proxy` |
| Private buckets | `mc anonymous get` on `kino-media` | no anonymous policy |
| CORS | `apps/api/src/server.ts` | only `PUBLIC_BASE_URL` origin reflected in production |
| Migrations before start | compose `migrate` service | api and worker wait on `service_completed_successfully` |
| Persistent volumes | `docker volume ls` | `pgdata`, `miniodata`, `caddy_data` present after first `up` |
| Restart policy | compose | `unless-stopped` on every long-running service |
| Stale multipart uploads | compose `object-storage` env | `MINIO_API_STALE_UPLOADS_EXPIRY=24h`, `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=6h` |
| Device registration | compose | `DEVICE_REGISTRATION_MODE=first-write-wins` |
| Backup scheduled | see below | `infra/scripts/backup.sh` on a timer, `BACKUP_ROOT` on another machine |

### What the backups cover

- `deploy.ps1 backup` is **PostgreSQL only** (`pg_dump`). It does not touch
  object storage. A database dump alone does not protect a single photograph:
  the originals, thumbnails and renders live in MinIO.
- `infra/scripts/backup.sh` is the full recovery point: `pg_dump` plus `mc
  mirror` of both buckets into one dated snapshot with `SHA256SUMS`, and
  `infra/scripts/restore-drill.sh` proves a snapshot restores. Both are POSIX
  shell. On the Windows deployment host they have to run inside a container
  (`docker compose run --rm` with the compose network) from a scheduled task;
  nothing in `deploy.ps1` does that today. Until it is scheduled, **there is
  no backup of original photographs on the Windows host.**
- Database rows and objects are one recovery point; never restore a newer
  database over an older media snapshot (see the restore runbook).

## Backups and observability

Nightly backup, retention, isolated restoration, and ready-asset digest verification are documented in [the restore runbook](../docs/runbooks/restore.md). The backup target must be an absolute off-host mount; the scripts deliberately refuse a blank, relative, or root target.

The API exposes authenticated Prometheus text at `/api/metrics` when `METRICS_TOKEN` is configured. Production requires the token. API/worker/Caddy JSON logs rotate locally, MinIO exposes metrics only on the private network, and the optional node exporter starts with:

```sh
docker compose --profile observability --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d
```

Scrape topology, metric semantics, and initial alerts are in [the observability runbook](../docs/runbooks/observability.md).

## Media licensing

The worker image currently includes the repository's `ffmpeg-static` dependency. Do not distribute that image publicly until the FFmpeg/GPL distribution decision tracked in GitHub issue #22 is resolved.
