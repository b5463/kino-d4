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
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 drain -Roll amber-001 -Expect 137
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 event-backup -Roll amber-001 -BackupRoot D:\kino-backups
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 down    # volumes preserved
```

`drain` and `event-backup` exist for the on-demand event model below. `drain`
answers "is it safe to shut this PC down yet" in one command: it reads each
camera's last heartbeat and this server's own rows out of PostgreSQL, counts the
objects in the bucket, and exits 0 only on `SAFE TO SHUT DOWN`. `event-backup`
takes one snapshot of **both** stores into
`<BackupRoot>\events\<yyyy-MM-dd>-<slug>` and verifies it — it is
`backup-task.ps1 run` plus `verify` with a per-event root, not a third backup
implementation. Both are documented step by step in
[`docs/runbooks/event-day.md`](../docs/runbooks/event-day.md).

`init` replaces every `change-me` placeholder with a generated secret, keeping the same token identical everywhere it appears (so `DATABASE_URL`/`REDIS_URL` stay consistent with the passwords). `-EnvName staging` targets `infra/.env.staging` instead. `backup` covers the database only; the MinIO volume follows `infra/scripts/backup.sh`.

`-Relay` adds `infra/relay/docker-compose.relay.yml` to the file list and must be passed on **every** action of a relay deployment, `down` and `logs` included. Without it the file list is the production file alone: the frpc container is dropped and 80/443 are republished on the host, which is exactly what the relay exists to avoid. `check` also refuses to be quiet about a port that is already held - see "Ports 80 and 443 on the PC are taken" below.

## Production (manual steps)

1. Copy `infra/.env.prod.example` to `infra/.env.production`.
2. Replace every placeholder with production-only credentials. Generate `COOKIE_SECRET` from at least 32 random bytes.
3. Point `KINO_SITE_ADDRESS` and `PUBLIC_BASE_URL` at the production DNS name.
4. Start the stack:

```sh
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d --build
```

Only Caddy publishes host ports. PostgreSQL, Redis, MinIO, the API, the worker, and the static web service remain on the private Compose network. Caddy obtains and renews TLS automatically for a public hostname, streams server-sent events without buffering, sends `/api/*` to the API, and serves Studio at `/studio/` with Roll everywhere else. Roll invitation and host pages receive an `X-Robots-Tag: noindex, nofollow, noarchive` header.

Server-sent events need two things from every Caddy hop, not one. `flush_interval -1` on the `/api/*` proxy is the first. The second is that `text/event-stream` is never compressed: Caddy's default `encode` match includes `text/*`, which covers SSE, and a compressor in front of a long-lived stream delivers a batch of events minutes late instead of one event now. All three Caddyfiles (`Caddyfile`, `Caddyfile.tunnel`, `relay/vps/Caddyfile`) therefore replace the default with an explicit eight-entry Content-Type allow list that omits it. Verified by adapting each file with the pinned `caddy:2.10.2-alpine` image: the JSON matcher lists the eight types and the string `event-stream` does not appear anywhere in the adapted config.

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

The upload budget is 120 requests per minute per device token **per route** for a registered camera (`deviceUpload` in `apps/api/src/plugins/rateLimits.ts`; 60 is only the fallback for a bearer the `devices` table does not know). The counter is keyed by method and route pattern, so the five upload routes each carry their own 120 and the budgets are not pooled. One four-frame capture spends seventeen mutations — 1 capture create, 5 `assets/init`, 5 part `PUT`, 5 upload complete, 1 capture complete — so the busiest route is 5 per capture and the sustained ceiling is 24 captures a minute, one every 2.5 s.

For a hundreds-of-captures endurance run, pace one camera with `--slow 1s` or run multiple physically distinct test-device credentials. Do not weaken the production budget merely to make a benchmark finish sooner.

`--concurrency N` runs N captures in flight at once (default 1, clamped to `--captures`). It multiplies the per-route spend, so raise it only when you are measuring the limiter itself. `--title TEXT` names the Roll the run creates; the default is `KINO uploader acceptance`, so set it when a staging run has to be findable afterwards on the host dashboard.

Run `npm run test:uploader -- --help` for fixture, timeout, and pacing options. Production registration is first-write-wins, so reuse `KINO_DEVICE_ID` and `KINO_DEVICE_TOKEN` after the initial physically controlled registration instead of attempting to register the serial again.

### Per-camera thumbnail backfill

`infra/scripts/backfill-thumbnails.ts` re-queues `generate-thumbnail` for captures processed before the worker started writing one thumbnail per camera. Those captures still make a capture page fetch four full originals — 754 kB instead of 293 kB. Nothing is migrated: the job is idempotent, so the tool only queues work.

```sh
npx tsx infra/scripts/backfill-thumbnails.ts --roll RRG8AZ            # dry run, writes nothing
npx tsx infra/scripts/backfill-thumbnails.ts --roll RRG8AZ --apply    # queue it, 100 captures at a time
```

Dry run is the default and reports how many captures are affected and how much storage the run would add. It is safe to run twice, and re-running it is the resume. A backfill raises the host dashboard's Pending count for as long as it runs, so do not start one during a live party. Procedure, measured costs and the interruption behaviour are in [the thumbnail backfill runbook](../docs/runbooks/thumbnail-backfill.md).

## PC-hosted production behind a tunnel (first production phase)

> **This phase is ON-DEMAND EVENT HOSTING, not a 24/7 service.** The stack runs
> on event days and long enough afterwards for the upload queue to drain and one
> backup to finish; then the PC may sleep or be shut down. The event workflow —
> the twelve-check pre-event list, what to say when the origin disappears
> mid-party, the drain gate, the event backup, and how to disable sleep for one
> evening and put the setting back — is
> [`docs/runbooks/event-day.md`](../docs/runbooks/event-day.md). The move to a
> dedicated always-on machine is
> [`docs/runbooks/origin-machine-move.md`](../docs/runbooks/origin-machine-move.md),
> and that is where a permanent sleep disable, unattended availability and
> constant Docker uptime become requirements. They are not requirements here.

> **Deployment day is written out step by step in
> [`docs/runbooks/production-relay-deploy.md`](../docs/runbooks/production-relay-deploy.md)**:
> what to provision, the one Websupport record, the commands on the VPS and on
> the PC in order, verification through the canonical URL, how to tell a dead
> tunnel from a dead stack, rollback, the Windows sleep/reboot remedies, and a
> gate list that ends in a yes/no. This section is the design; that document is
> the procedure.

The canonical product URL is `https://kino.acronym.sk`. For the first
production phase the stack runs on the operator's Windows PC, and the public
hostname reaches it through an **outbound** tunnel. Clients never learn a LAN
address, a PC name or a temporary IP: the D4's stored `network.apiBase`, the
PWA's same-origin API and `PUBLIC_BASE_URL` all say `kino.acronym.sk`, so a
later move to a server is a DNS/tunnel change and nothing else.

### Layout

```
Internet -> kino.acronym.sk (TLS at the relay or tunnel edge)
         -> outbound tunnel (frpc to the relay VPS, or cloudflared; no inbound ports on the PC)
         -> proxy (Caddy, plain HTTP on the Compose network)
         -> api:3000 / web:8080
postgres, redis, object-storage, worker: Compose network only, never published
```

Files: `docker-compose.prod.yml` + `docker-compose.tunnel.yml` (overlay:
removes the proxy's host ports, serves Caddy on `:80` inside the network via
`Caddyfile.tunnel`, adds the `tunnel` service) and `.env.production` with
`CLOUDFLARE_TUNNEL_TOKEN`. Prerequisite for the **free** shape of that path: the
`acronym.sk` zone moved to Cloudflare DNS, because a free-plan tunnel serves a
hostname only in a zone Cloudflare is authoritative for. That is what the
operator refused - the zone move, not Cloudflare. Two other Cloudflare shapes do
keep the zone at Websupport, and their costs and conditions are compared in
[`docs/runbooks/public-ingress-options.md`](../docs/runbooks/public-ingress-options.md);
the other alternative is router port-forwarding to Caddy on 80/443, which the
production file already supports without the overlay.

### Which path: measured on 2026-09-06

DNS for `acronym.sk` stays at Websupport (operator decision), which rules out
the **free** Cloudflare Tunnel shape: that one needs Cloudflare authoritative
for the zone. It does not rule out Cloudflare. A partial (CNAME) setup keeps the
zone at Websupport but is Business or Enterprise only, at $250/month, and
Cloudflare for SaaS custom hostnames reaches the same result at $0/month with
100 hostnames on the free plan, at the cost of a second domain on a Cloudflare
account acting as the front door. The comparison, the costs and the conditions
are in
[`docs/runbooks/public-ingress-options.md`](../docs/runbooks/public-ingress-options.md).

**Standing decision, 2026-09-08: the selected ingress is a Pinggy Pro
custom-domain tunnel, and the relay below is the FALLBACK.** Purchase of Pinggy
Pro is blocked pending privacy and data-processing clarification, because KINO
Roll carries photographs of identifiable people and Pinggy can inspect HTTP
tunnel traffic; see
[`docs/runbooks/pinggy-plan-facts.md`](../docs/runbooks/pinggy-plan-facts.md).

The relay stays fully documented and valid. What changed is evidence, not
merit: the argument for the relay was that server-sent events are safe through
it by construction — frp forwards raw TCP, so there is no content type for
anything to buffer, and the only HTTP-aware hop is a Caddy this repository
already gates with `flush_interval -1` and an eight-entry compression allow list
that omits `text/event-stream` — while every hosted tunnel puts an HTTP proxy
nobody here controls in front of the product's headline feature. That argument
was sound when no hosted tunnel had been measured. Pinggy has since been
measured, at two pacings, and it streams. The relay remains the answer whenever
privacy or control decides the question, since a relay we operate carries no
third party that can read the payload.

**Carrier NAT: settled, 2026-09-09.** This branch used to end "confirm on the
router's status page" and offered a direct-path option if the WAN address
turned out to be public. That question is closed, and the direct path is not
available.

The bench PC egresses as `46.34.228.61` (O2 Slovakia, AS28952). Its gateway is
`10.20.99.1`, and the route beyond it runs through two carrier-side private
addresses (`10.106.16.198`, `10.109.122.193`) before the first public hop
(`90.176.30.41`). O2's own RIPE registration for the egress address reads
`netname: O2SK-CGNAT-POOL-FBB` — the ISP naming it a CGNAT pool for fixed
broadband. The host has no global IPv6 and no delegated prefix, and an inbound
probe from four countries reached nothing. O2 publishes that a public static
IPv4 is not available for these products.

So: **inbound 80/443 can never arrive, and no DNS or router change helps.** Do
not spend time on port forwarding, UPnP, or a dynamic-DNS updater — DynDNS
tracks an address that changes, and cannot create one that does not exist.
Every viable path is an outbound connection from the PC.

The evidence, the probe's own caveat, and the single remaining question for O2
are in
[`docs/runbooks/public-ingress-options.md`](../docs/runbooks/public-ingress-options.md#the-network-constraint-confirmed--2026-09-09).

**The fallback: relay VPS** (`infra/relay/`). A small VPS with a static IPv4
runs Caddy (ACME for `kino.acronym.sk`) and an frp server; the PC runs frpc,
which opens one outbound, token-authenticated, TLS connection and exposes only
the Compose-internal Caddy as `127.0.0.1:8080` on the VPS. Websupport gets one
`A` record pointing at the VPS, which is static, so no DDNS. Nothing on the PC
listens on the internet; the VPS holds no data; and it is the machine the
stack moves to later, at which point the relay is switched off and Caddy on the
VPS points at the local stack. Cost: the cheapest VPS the operator trusts.

```
PC:  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 up -Relay
     # equivalently, by hand:
     docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml -f infra/relay/docker-compose.relay.yml up -d --build
VPS: cd relay/vps && cp .env.example .env && docker compose up -d   # firewall: 80, 443, 7000
```

`deploy.ps1` takes `-Relay`, and it belongs on **every** action for a relay
deployment - `check`, `up`, `update`, `status`, `logs`, `down`. Without it the
file list is the production file alone, which drops the frpc container and
republishes 80/443 on the host.

### Ports 80 and 443 on the PC are taken (measured 2026-09-07)

`netstat -ano` shows `0.0.0.0:80` and `0.0.0.0:443` LISTENING on PID 8088:
`httpd.exe` from `C:\Bitnami\wordpress-6.0.3-0\apache2\bin\`, owned by the
Windows service **`wordpressApache-1`**, start mode Automatic - so it returns on
every reboot. (`PEMHTTPD`, a second Apache from EDB Postgres Enterprise
Manager, is also running and holds neither port.)

- **Relay and tunnel paths: not blocked.** Both overlays `!reset` the proxy's
  `ports`, so the stack publishes nothing at all and Caddy serves `:80` only
  inside the Compose network. Apache keeps both ports; nothing collides.
- **Direct, router-forwarded path: hard block.** The production file alone
  publishes `80:80` and `443:443` and `up` fails on port allocation. That path
  needs `Stop-Service wordpressApache-1` plus
  `Set-Service wordpressApache-1 -StartupType Disabled`, or Apache moved to
  other ports. Do not do that to make the relay work - it is not needed there.

`deploy.ps1 check` now warns when 80 or 443 is already held and `-Relay` was
not passed. Verified on this machine: it named PID 8088.

`infra/docker-compose.tunnel.yml` (Cloudflare) stays in the tree for a
hostname Cloudflare is authoritative for. It cannot serve `kino.acronym.sk` on
the free plan while Websupport holds the zone; it could serve it through
Cloudflare for SaaS or a Business-plan partial setup, which is a different
build-out and belongs to
[`public-ingress-options.md`](../docs/runbooks/public-ingress-options.md).

### Bring-up

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 init      # writes infra\.env.production with generated secrets
# edit infra\.env.production: KINO_SITE_ADDRESS, PUBLIC_BASE_URL, PROVISIONING_TOKEN, CLOUDFLARE_TUNNEL_TOKEN
docker compose --env-file infra\.env.production -f infra\docker-compose.prod.yml -f infra\docker-compose.tunnel.yml config --quiet
docker compose --env-file infra\.env.production -f infra\docker-compose.prod.yml -f infra\docker-compose.tunnel.yml up -d --build
```

Verify from outside the LAN: `https://kino.acronym.sk/` is the Roll PWA,
`https://kino.acronym.sk/api/healthz` returns `ok` with `db`, `redis`,
`storage` true, the certificate is valid, and nothing on the PC listens on
80/443 (`netstat -an | findstr :443`).

### What the PC must do

| Requirement | How | Status |
|---|---|---|
| Docker Desktop starts at logon | Docker Desktop > Settings > General > Start Docker Desktop when you sign in | operator setting |
| Containers come back after a reboot | every service has `restart: unless-stopped`; Docker Desktop restarts them once its engine is up | in the compose files |
| The tunnel comes back | `tunnel` service, same restart policy; cloudflared reconnects on its own | in the overlay |
| Data survives container restart and rebuilds | named volumes `pgdata`, `miniodata`, `caddy_data`, `caddy_config` | in the compose file |
| The PC does not sleep **during an event** | `powercfg /change standby-timeout-ac 0`, restored to the previous value afterwards; keep the machine on mains | operator setting, per event. Read the current index first: [`event-day.md` §4](../docs/runbooks/event-day.md) |
| Backups of both stores | `deploy.ps1 event-backup` after each event (Postgres dump + mirror of both buckets, in a per-event directory), and `infra/scripts/backup.sh` on a schedule for the days between. `deploy.ps1 backup` is Postgres only and protects no photograph | `event-backup` next to `deploy.ps1`; the daily task is "Scheduling the backup on the Windows host" |
| The queue is proven empty before the machine goes to sleep | `deploy.ps1 drain -Roll <slug> -Expect <n>` | one command, exit 0 = safe |

Requirements this phase does **not** have, recorded because they were
prerequisites before the model changed and become prerequisites again on a
dedicated machine: a permanent sleep disable, unattended overnight
availability, automatic recovery while nobody is using KINO, a dedicated PC,
and 24/7 Docker uptime. Two consequences of that, worth stating rather than
discovering: Docker Desktop runs in the signed-in user session, so a rebooted
PC has no engine until somebody signs in; and `restart: unless-stopped` brings
the containers back once the engine is up, which is recovery for a crash during
an event, not availability at four in the morning. Both are addressed in
[`origin-machine-move.md`](../docs/runbooks/origin-machine-move.md).

### Availability, stated plainly

`kino.acronym.sk` is available while the origin PC is awake with the stack up —
that is, on event days and the drain-and-backup window after them. When the PC
is off, asleep, rebooting or without internet, the URL does not answer, and in
this phase that is an accepted state rather than an incident.

Photography is never unavailable: the shutter works, the capture is on the SD
card with its UUID and Roll, the queue waits, and when the stack returns the
uploads resume by themselves with no manual enqueue (proven on the bench on
2026-09-05 with a 40-capture outage and a 105-capture backlog). The PC-hosted
phase is a real-world test of exactly that design, which is why an on-demand
origin is a legitimate first production phase and not a compromise.

What the operator says at a party when the origin is away, and which numbers
prove the recovery afterwards, are in
[`event-day.md` §2](../docs/runbooks/event-day.md).

### Migration later

Back up Postgres and both buckets, restore both on the new host, carry
`.env.production` across by hand, start the stack, move the ingress origin. The
canonical URL, the Roll codes, the capture UUIDs, the object keys, the schema
and the camera's stored `network.apiBase` do not change — the full procedure,
the invariants and what breaks each of them are in
[`docs/runbooks/origin-machine-move.md`](../docs/runbooks/origin-machine-move.md).

## Pre-deploy checklist (release closure, 2026-09-05)

Run through this before the first `deploy.ps1 up` on the public host, and
again after any change to `.env.production`. Each line is a check, not a
setting to invent. For the relay deployment specifically, walk the ordered gate
list in
[`docs/runbooks/production-relay-deploy.md`](../docs/runbooks/production-relay-deploy.md)
instead - it covers these rows plus the VPS, the DNS record, the tunnel and the
Windows reboot behaviour, and it ends in a yes/no. Its gates F1 (sleep
permanently disabled) and F2 (survives a reboot unattended) belong to the
always-on phase and are not gates for an on-demand event deployment; the
per-event checklist that replaces them is
[`docs/runbooks/event-day.md` §1](../docs/runbooks/event-day.md).

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
| Only the edge publishes a port | `docker compose --env-file infra/.env.prod.example -f infra/docker-compose.prod.yml config \| grep published` | exactly two entries, both on `proxy` (80, 443). With `-f infra/relay/docker-compose.relay.yml` added: **no output at all**. Read the rendered config, not the source file - an overlay can add a port the source does not show |
| MinIO console port | compose `object-storage` command | `--console-address ':9001'`. Pinned so it does not move between runs; neither 9000 nor 9001 is published |
| Log growth is bounded | compose | every service carries `logging: *json-logging` (20 MB x 5). An uncapped container log fills the Docker drive and takes the stack with it |
| CORS | `apps/api/src/server.ts` | only `PUBLIC_BASE_URL` origin reflected in production |
| Migrations before start | compose `migrate` service | api and worker wait on `service_completed_successfully` |
| Persistent volumes | `docker volume ls` | `pgdata`, `miniodata`, `caddy_data` present after first `up` |
| Restart policy | compose | `unless-stopped` on every long-running service |
| Stale multipart uploads | compose `object-storage` env | `MINIO_API_STALE_UPLOADS_EXPIRY=24h`, `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=6h` |
| Device registration | compose | `DEVICE_REGISTRATION_MODE=first-write-wins` |
| Backup scheduled | see below | `infra/scripts/backup.sh` on a timer, `BACKUP_ROOT` on another machine |
| Restore proven | `docs/runbooks/restore.md` drill log | one recorded drill against a snapshot from this deployment, less than 30 days old |

### What the backups cover

- `deploy.ps1 backup` is **PostgreSQL only** (`pg_dump`). It does not touch
  object storage. A database dump alone does not protect a single photograph:
  the originals, thumbnails and renders live in MinIO.
- `infra/scripts/backup.sh` is the full recovery point: `pg_dump` plus `mc
  mirror` of both buckets into one dated snapshot with `SHA256SUMS`, and
  `infra/scripts/restore-drill.sh` proves a snapshot restores. Both are POSIX
  shell. On the Windows deployment host they have to run inside a container
  (`docker compose run --rm` with the compose network) from a scheduled task —
  which is what the helper described under "Scheduling the backup on the
  Windows host" below registers. Until that task exists and has produced a
  snapshot, **there is no backup of original photographs on the Windows host.**
- Database rows and objects are one recovery point; never restore a newer
  database over an older media snapshot (see the restore runbook).

### Scheduling the backup on the Windows host

The helper is **`infra/backup-task.ps1`**. It registers a daily Windows
Scheduled Task that runs `infra/scripts/backup.sh` through Git-for-Windows bash
against the Compose network, so the POSIX script works on a host that has no
shell for it. It is the only thing that makes the sentence above — no backup
of original photographs on the Windows host — stop being true.

```powershell
powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 register -BackupRoot D:\kino-backups
powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 run      -BackupRoot D:\kino-backups
powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 verify   -BackupRoot D:\kino-backups
powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 status
```

Task name `KINO Roll daily backup`, daily at `-At` (default 03:30), running as
SYSTEM with `-StartWhenAvailable`. `-BackupRoot` must be an absolute path; that
it is off-host is the operator's judgement and the script says so rather than
pretending to check. `register` does not take the first backup - run `run` once,
then `verify` the next morning. `verify` returns 0 only when the newest snapshot
is younger than `-MaxAgeHours` (30), carries a non-empty `postgres.dump`,
carries a **non-empty object mirror**, and matches its own `SHA256SUMS`.

It satisfies every requirement in the table below, which is why the table is
still here: read it before replacing the helper with something homemade.

Whatever the helper is called, the job it registers must satisfy all of the
following, and the point of writing them down is that a job that satisfies only
the first is worse than no job, because it looks like a backup:

| Requirement | Why |
|---|---|
| One job covers PostgreSQL **and** both buckets | A `pg_dump` alone protects no photograph. Originals, thumbnails and renders are objects in MinIO; the database holds only the rows that point at them. `deploy.ps1 backup` is `pg_dump` only and is not a backup of the party. |
| Database and objects captured in the **same** run | Rows and objects are one recovery point. Two jobs on two schedules drift, and a restore then puts a newer database over an older media snapshot — asset rows pointing at objects that do not exist. `backup.sh` writes both into one dated snapshot with `SHA256SUMS` for this reason. |
| `BACKUP_ROOT` is an absolute path on **another machine** | A snapshot on the same disk as `pgdata` and `miniodata` survives nothing that matters. The script refuses a blank, relative or root target; it cannot refuse a target that is merely on the wrong drive. |
| The task runs whether or not anyone is signed in | Docker Desktop runs in the user session, so a task configured "run only when user is logged on" silently does nothing on a rebooted, unattended PC — the same limitation the availability table above records for the stack itself. |
| The run's exit status is checked | A run is successful only when it prints `backup complete`. Alert when no new daily directory appears for 26 hours, a snapshot checksum fails, or free space falls below 20% (thresholds from the restore runbook). |

Retention is the script's, not the task's: `backup.sh` prunes daily snapshots
after 14 and weekly after 8. Do not add a second retention policy in the
scheduled task.

### Restore rehearsal cadence

A backup that has never been restored is a hypothesis.

- **Every 30 days**, run `infra/scripts/restore-drill.sh` against the most
  recent daily snapshot. The restore runbook alerts when the last successful
  drill is older than 30 days; this is that alert's other half.
- **Before any migration to a new host**, and **after any change** to
  `backup.sh`, `restore-drill.sh`, the schema, or the bucket layout.
- The drill never touches production: it builds a uniquely named Compose
  project with scratch volumes, verifies the manifest, restores both stores,
  and asserts orphan-free asset rows plus SHA-256 on every `ready` asset.
- **Record each real run** in the log at the end of
  [`docs/runbooks/restore.md`](../docs/runbooks/restore.md), with the exact
  snapshot directory and the final output line. A script review, a syntax
  check, or "it looked fine" is not a drill and does not reset the 30 days.

## What a fresh deployment does, in order

One list, so a first `up` on a new host is not a search through three sections.
Each step must finish before the next means anything.

1. **`deploy.ps1 init`** writes `infra/.env.production` and replaces every
   `change-me` with a generated secret, keeping repeated tokens identical so
   `DATABASE_URL` and `REDIS_URL` stay consistent with the passwords.
2. **Edit `.env.production` by hand** for the values no generator can know:
   `KINO_SITE_ADDRESS`, `PUBLIC_BASE_URL`, `PROVISIONING_TOKEN`, and the tunnel
   or relay credential if one is used.
3. **`deploy.ps1 check`** — Docker present, no placeholder left, `compose
   config --quiet` interpolates.
4. **Walk the pre-deploy checklist above.** It is a list of checks, not
   settings to invent.
5. **`deploy.ps1 up`** builds the images and starts the stack.
6. **The `migrate` container runs to completion first.** The API and worker
   wait on `service_completed_successfully`, so a failed migration leaves the
   application stopped rather than booting against a partial schema.
7. **`createbucket` creates `kino-media` and the firmware bucket.** Storage
   health is false until it has.
8. **API and worker start**, sharing `JOB_QUEUE_PREFIX`. The same value in both
   or the worker consumes a queue nobody writes to.
9. **Caddy obtains a certificate** for the site address, over ACME — directly
   if the host is reachable on 80/443, or on the relay VPS if the PC is behind
   carrier NAT (see the measured section above). Only Caddy publishes host
   ports; PostgreSQL, Redis, MinIO, the API, the worker and the web service
   stay on the private Compose network.
10. **Verify from outside the LAN**: `https://<host>/api/healthz` returns 200
    with `db`, `redis` and `storage` true, `/` is the Roll PWA, `/studio/` is
    Studio, and nothing on the PC listens on 80/443 when a tunnel or relay is
    in use.
11. **Register the camera** from Studio over USB-C, using `PROVISIONING_TOKEN`.
    Production is `first-write-wins`, so this happens once per serial.
12. **Schedule the backup**, then **run the restore drill once** against its
    first snapshot. The deployment is not finished until a snapshot has been
    restored; until then there is a stack, not a recovery point.

## Backups and observability

Nightly backup, retention, isolated restoration, and ready-asset digest verification are documented in [the restore runbook](../docs/runbooks/restore.md). The backup target must be an absolute off-host mount; the scripts deliberately refuse a blank, relative, or root target.

The API exposes authenticated Prometheus text at `/api/metrics` when `METRICS_TOKEN` is configured. Production requires the token. API/worker/Caddy JSON logs rotate locally, MinIO exposes metrics only on the private network, and the optional node exporter starts with:

```sh
docker compose --profile observability --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d
```

Scrape topology, metric semantics, and initial alerts are in [the observability runbook](../docs/runbooks/observability.md).

## Media licensing

The worker image currently includes the repository's `ffmpeg-static` dependency. Do not distribute that image publicly until the FFmpeg/GPL distribution decision tracked in GitHub issue #22 is resolved.
