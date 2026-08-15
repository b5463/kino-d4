# @kino/api

Fastify server behind `https://kino.acronym.sk/api/...`. Currently a scaffold:
config, the postgres/redis/S3 plugins, and `GET /api/healthz`. No tables yet.

## Test precondition — start the dev services

The health test talks to real services. Start them first:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run test -w @kino/api
```

Without the stack running, `GET /api/healthz` answers `503` with the failing
dependency flagged `false`, and the first test fails.

## Port mappings

Container-internal ports are standard; only the host side is shifted.

| Service | Host | Container | Notes |
| --- | --- | --- | --- |
| postgres | `5435` | `5432` | 5432 and 5433 are native PostgreSQL clusters on the dev host, 5434 belongs to another project |
| redis | `6380` | `6379` | another project owns a `6379` mapping; claiming it would stop their container binding |
| minio (S3 API) | `9000` | `9000` | |
| minio (console) | `9001` | `9001` | login `kino` / `kino-secret` |

Buckets `kino-media` and `kino-firmware` are created on first `up` by the
one-shot `createbucket` service.

## Teardown

```bash
# stop the containers, KEEP the postgres and minio volumes
docker compose -f infra/docker-compose.dev.yml down

# stop AND wipe all data — only when you intend to reset
docker compose -f infra/docker-compose.dev.yml down -v
```

`down` without `-v` is the default. The stack is namespaced under the compose
project `kino-dev`, so it never collides with other stacks on the machine.

## Configuration

`src/config.ts` validates the environment with zod:

`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_REGION`, `PUBLIC_BASE_URL`, `LOG_LEVEL`.

Every key has a dev default matching the compose file, so **no `.env` is needed
locally**. Two ways to override, highest precedence first:

**1. Inline, for a one-off.**

```bash
# bash
DATABASE_URL=postgres://kino:kino@localhost:5999/kino npm run test -w @kino/api
```

```powershell
# PowerShell — no inline env-var prefix, so set it first
$env:DATABASE_URL = 'postgres://kino:kino@localhost:5999/kino'
npm run test -w @kino/api
Remove-Item Env:\DATABASE_URL
```

**2. `infra/.env`, for a persistent local setup.**

```bash
cp infra/.env.example infra/.env    # then edit
```

`infra/.env` is gitignored. The test suite loads it via
`apps/api/tests/setup-env.ts`, which uses Node's built-in env-file parser — no
dotenv dependency. Precedence follows `node --env-file`: a variable already in
the environment wins over the file, so option 1 still overrides option 2, and CI
(which sets everything explicitly and has no `.env`) is unaffected.

## Scripts

| Script | Does |
| --- | --- |
| `npm run test -w @kino/api` | vitest, needs the compose stack |
| `npm run lint -w @kino/api` | `tsc --noEmit` |

There is deliberately no `build` script. The server is TypeScript run directly
on Node 22 — nothing bundles it, so a build step would only produce artifacts
nobody consumes. This matches `@kino/kdp` and `@kino/schemas`; only
`@kino/studio` builds, because a browser app has to be bundled. Root
`npm run build` uses `--if-present` and skips this workspace.

## Server shape

`buildServer(config): FastifyInstance` returns an unstarted instance — no port
is bound, so tests drive it in-process via `app.inject()`. Fastify boots the
registered plugins lazily on the first request, which is why it is synchronous.

Plugins decorate the instance with `app.db` (drizzle over postgres-js),
`app.redis` (ioredis) and `app.s3` (AWS SDK v3 pointed at MinIO), and each
registers an `onClose` hook, so `app.close()` releases every connection.

`GET /api/healthz` pings all three concurrently (`select 1`, `PING`,
`HeadBucket`) with a 5 s per-probe timeout, and answers
`{ ok, db, redis, storage }` — `200` when all are reachable, `503` otherwise.

## Logging

pino via Fastify, structured, one `reqId` per request (05 §17) taken from an
inbound `x-request-id` or generated as a UUID. Request bodies are never logged:
the `req` serializer emits an explicit allow-list, and password/secret/token
keys are censored through pino `redact` on top of that (05 §13).
