# @kino/api

Fastify server behind `https://kino.acronym.sk/api/...`. Currently config, the
postgres/redis/S3 plugins, `GET /api/healthz`, the database schema, and the
device/host/guest authentication described below.

## Test precondition — start the dev services

The health and database tests talk to real services, and the auth tests read and
write real tables. Start the stack and migrate it first:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api
```

Without the stack running, `GET /api/healthz` answers `503` with the failing
dependency flagged `false`, and the first test fails. Without the migrations,
`tests/auth.test.ts` stops in `beforeAll` and names the command above rather
than failing 25 times over on "relation does not exist".

The auth suite namespaces every row it writes with a per-run id and deletes them
again afterwards, so it can share the dev `kino` database with your own data.

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
`S3_SECRET_KEY`, `S3_REGION`, `PUBLIC_BASE_URL`, `COOKIE_SECRET`, `NODE_ENV`,
`LOG_LEVEL`.

Every key has a dev default matching the compose file, so **no `.env` is needed
locally**. Two of them are not about the compose stack:

- `COOKIE_SECRET` signs the guest PIN session cookie. Its default is a published
  placeholder, and config loading **fails** unless `NODE_ENV` is explicitly
  `development` or `test`. Note the direction: the check asks "is this provably
  development?", not "is this production?" — so an unset, misspelled or
  unfamiliar `NODE_ENV` refuses to boot on the default rather than accepting it.
  Forgetting to set `NODE_ENV` is the likeliest deployment mistake there is, and
  it must not be the one that silently enables a forgeable cookie. Generate a
  real secret with `openssl rand -base64 48`.
- `NODE_ENV` is a free-form string, not an enum, because the value is set by
  tooling outside this project (vitest sets `test`). It has **no default** on
  purpose: "unset" has to stay distinguishable from "explicitly development" for
  the rule above. Only the exact value `test` registers the diagnostic auth
  routes.

`drizzle-kit` deliberately does *not* call `loadConfig()` — a schema migration
has no business needing a cookie secret, so `drizzle.config.ts` parses only
`DATABASE_URL`, reusing that field's own schema so the dev default still has one
definition. That is what keeps `npm run db:migrate` working with `NODE_ENV`
unset.

Two ways to override, highest precedence first:

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

## Database

`src/db/schema.ts` is the drizzle schema and the single source of truth for
table and column names. PostgreSQL stores metadata only — no media blobs
(05 §5); bytes live in object storage and `assets.object_key` is the only link.

`roll_devices` (migration 0003) is the device↔roll join: a device may operate a
roll it created or joined, and no other (03 §17, 07 §25).

Two indexes are load-bearing contracts, not optimisations:

| Index | On | Why |
| --- | --- | --- |
| `captures_roll_uuid` | `(roll_id, capture_uuid)` | idempotency anchor — a retried upload of the same device-generated capture UUID cannot create a second row (05 §9) |
| `assets_capture_role_frame` | `(capture_id, role, frame_index)`, **NULLS NOT DISTINCT** | same, one level down: one asset per role per frame |

`NULLS NOT DISTINCT` on the second one is load-bearing, not a flourish.
`frame_index` is NULL for every derived role — `thumb`, `wiggle-webp`,
`metadata` — which is most assets. Under PostgreSQL's default (NULLS DISTINCT)
those rows are all mutually distinct, so re-running a render would insert a
*second* `thumb` row for the same capture and the idempotency contract would
quietly cover `original-frame` and nothing else. It is a table constraint rather
than an index because drizzle exposes `nullsNotDistinct()` only on `unique()`;
PostgreSQL still backs it with an index of the same name, so `ON CONFLICT`
inference and error `constraint_name` are unaffected.

### Migrations

drizzle-kit runs outside the server, as a CLI, from this directory:

```bash
cd apps/api
npx drizzle-kit generate --name <what-changed>   # writes drizzle/NNNN_<name>.sql
npm run db:migrate -w @kino/api                  # applies pending files
```

`db:migrate` is a plain alias for `drizzle-kit migrate`. It exists as a script
because CI runs it too: the `api-test` job applies the migrations to its service
database after the services come up and before the tests, since every suite
other than `db.test.ts` talks to the configured database rather than making its
own.

`drizzle.config.ts` takes the target database from `loadConfig().DATABASE_URL`,
so it honours the same precedence as everything else — shell environment first,
then `infra/.env`, then the dev default. Point it elsewhere the usual way:

```powershell
$env:DATABASE_URL = 'postgres://kino:kino@db.internal:5432/kino'
npx drizzle-kit migrate
Remove-Item Env:\DATABASE_URL
```

`drizzle/` is committed in full — the `.sql` files, `meta/*_snapshot.json` and
`meta/_journal.json`. The snapshots are how drizzle-kit diffs the next change;
without them it would regenerate the whole schema every time.

**Numbering.** drizzle-kit starts at `0000`; the first migration was renamed to
`0001_init` (file, snapshot and journal `idx`/`tag` together) so the numbers
line up with the plan's migration numbering. drizzle-kit derives the next index
from the last journal entry's `idx`, not from the entry count, so everything
after that numbers itself — `0002_asset_role_frame_nulls_not_distinct` came out
of a plain `generate` with no renaming. Do not rename migrations again.

### How the tests get a clean database

`tests/db.test.ts` never migrates the dev `kino` database. It drops and
re-creates a throwaway `kino_test` database on every run and applies the
committed migrations to that, which is what makes the run repeatable: it proves
the migration works on an *empty* database rather than inheriting whatever a
previous run left behind. `kino_test` is dropped again afterwards, and the
`DROP` is also repeated up front, so an aborted run cannot wedge the next one.

## Scripts

| Script | Does |
| --- | --- |
| `npm run test -w @kino/api` | vitest, needs the compose stack |
| `npm run lint -w @kino/api` | `tsc --noEmit` |
| `npm run db:migrate -w @kino/api` | `drizzle-kit migrate` against `DATABASE_URL` |

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

## Authentication

Three scopes (05 §12). `src/auth/tokens.ts` mints credentials, `src/auth/pins.ts`
hashes PINs, `src/auth/plugins.ts` turns both into Fastify preHandlers.

| Scope | Credential | preHandler | Sets |
| --- | --- | --- | --- |
| device | `Authorization: Bearer kdt_...` | `requireDevice`, `requireDeviceRoll(param)` | `request.device` |
| host | `Authorization: Bearer hrt_...` | `requireHost(param)` | `request.roll` |
| guest | anonymous + signed PIN cookie | `guestRollAccess` | `request.roll` |

A token is `<prefix>_<base64url of 32 random bytes>`; only its sha256 hash is
stored, so a database dump contains no usable credential and the plaintext
exists exactly once — in the response that issues it. Tokens use a bare digest
rather than a slow KDF on purpose: the secret is 256 bits of CSPRNG output, so
there is nothing to brute-force. PINs are the opposite case and get salted
scrypt, with the honest caveat that a 4-digit PIN is only ever as safe as the
rate limiting in front of it (Task 36).

### Scope separation (07 §25)

A token of the wrong scope answers **403**, not 401 — the credential is real,
the permission is not. On top of that, device routes must live under
`/api/device/` and host routes under `/api/host/`, and an `onRoute` hook
**refuses to boot** a server that breaks the rule. That is why `authPlugin` is
registered before every route plugin in `buildServer`: `onRoute` only observes
routes registered after it.

A device reaches a roll it created (`rolls.created_by_device_id`) or joined
(`roll_devices`) and no other — 07 §25's "must not enumerate unrelated Rolls".
`POST /api/device/rolls/join` writes the `roll_devices` row. Creating a roll
writes **no** such row: the creator is already recorded in
`rolls.created_by_device_id`, and both routes that care read the two with the
same `OR`.

### `request.roll` never carries a credential hash

`request.roll` is typed `PublicRollRow` — every `rolls` column *except*
`host_token_hash` and `pin_hash`. The preHandlers that need a hash read it into
a local, compare it, and drop it; it never reaches the request.

This is deliberate defence against the obvious one-liner. A future handler
writing `return rollOf(request)` would otherwise serve a guest the roll's host
token hash and PIN hash. Two diagnostic routes (`/context`) do exactly that
careless thing, and their tests assert no hash comes back — so reattaching one
fails the suite instead of shipping.

### Device registration — read this before exposing it

`POST /api/studio/devices/register` `{serial, product, hardwareRevision, name?}`
→ `{deviceId, deviceToken}`, `200`. Unauthenticated, and re-registering an
existing serial **rotates** that device's token.

**This is a device-takeover primitive, stated plainly.** One unauthenticated
POST with an existing serial returns a working token for that `deviceId` —
granting every roll the device created or joined — and simultaneously bricks the
real device, which cannot notice or re-enrol on its own. The response echoes the
`deviceId`, so an attacker can tell a hit from a new registration. Serials are
printed on the outside of the hardware and sequential (`KD4-00001`): the space
is walkable by counting, not searching.

Rotation itself is not the flaw and removing it would not fix this — an attacker
can equally pre-claim serials that do not exist yet, and blocking
re-registration would only brick real devices after a factory reset. The fix is
authentication on the endpoint: **rate limiting plus either a registration
secret or first-write-wins serial claiming**, tracked as a Task 36 handoff.
Until then, treat this as the weakest link in the device trust chain.

### Guest PIN session

`POST /api/rolls/:slug/pin` `{pin}` verifies against `rolls.pin_hash` and sets
the signed, httpOnly cookie `kino_pin_<rollId>`. Its value is a fingerprint of
the roll's *current* `pin_hash`, so changing a roll's PIN invalidates every
session issued under the old one. The cookie carries no secret; its
unforgeability comes from the `COOKIE_SECRET` signature.

The cookie uses `secure: 'auto'`, so @fastify/cookie sets `Secure` from the
actual request protocol — https in production, plain http on localhost in dev
and test — with no environment string to get wrong.

> **Deployment caveat.** `'auto'` reads `request.protocol`, which behind a
> TLS-terminating reverse proxy reports `http` unless Fastify's `trustProxy` is
> enabled. In that topology the `Secure` flag would be silently dropped.
> Enabling `trustProxy` is a server-level decision (it makes
> `X-Forwarded-Proto` authoritative, which is only safe behind a trusted proxy),
> so it is not set here — it belongs with the deployment work.

### Diagnostic routes

`/api/device/ping`, `/api/device/rolls/:rollId/ping`,
`/api/host/rolls/:rollId/ping`, `/api/rolls/:slug/ping` and the two `/context`
probes exist only to test the mechanisms above in isolation from the real
routes. `buildServer` registers
them **only when `NODE_ENV === 'test'`** — a plain `if` around `app.register`,
which is the only conditional-registration idiom Fastify has, and which is
fail-closed because `NODE_ENV` has no default and an unset value is not `test`.

## Rolls

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /api/device/rolls` | device | → `{rollId, slug, guestUrl, hostUrl, hostToken}`, `201` |
| `POST /api/device/rolls/join` `{slug}` | device | writes `roll_devices`; idempotent |
| `GET /api/device/rolls/current` | device | assigned rolls with `status = live` |
| `POST /api/host/rolls` | **none** | host web creation; mints a new host token |
| `GET /api/host/rolls/:rollId` | host | dashboard view, `counts` are zero until Task 18 |
| `PATCH /api/host/rolls/:rollId` | host | `title` / `pin` / `downloadsEnabled` / `status` |
| `POST /api/host/rolls/:rollId/regenerate-slug` | host | → `{slug, guestUrl}`; old slug 404s |
| `GET /api/rolls/:slug` | guest | `{title, status, photoCount, createdAt}` |

`POST /api/host/rolls` is unauthenticated for the same reason device
registration is: V1 has no accounts (05 §12), so the call *mints* the
credential rather than checking one. It is a spam/storage surface, not a
data-exposure one — the roll it creates is reachable only through the token in
its own response — and it is the second of the two routes that most need Task
36's rate limiting.

### Slug

Six characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (`src/rolls/slug.ts`),
drawn with rejection sampling from `crypto.randomFillSync` so no character is
more likely than another. `0`/`O` and `1`/`I`/`L` are excluded because a slug
gets read off one phone screen and typed into another. ~887M values, ~29.7 bits:
**not a secret**, a link that is impractical to stumble on — the PIN gate is
what locks a roll that needs locking. Uniqueness is the `rolls_slug_unique`
constraint's job; the caller retries on collision (pre-checking with a SELECT
would still race).

The slug is separate from `rolls.id` (05 §14), which is what lets
`regenerate-slug` rotate a leaked link without touching a single row that
references the roll.

### States (03 §22)

`live ↔ closed → archived`, archived terminal; re-sending the current status is
a no-op, anything else is `400 INVALID_STATE`. Archiving requires closing first
— "closed" is where the host actually decides no more photos are coming.

Closing stops **uploads**, not reading: `GET /api/rolls/:slug` still answers 200
for a closed roll. The upload half of that rule is
`assertRollAcceptsUploads(roll)` in `src/rolls/rolls.ts`, which throws
`RollClosedError` (`409 ROLL_CLOSED`) — Task 18's upload routes call it. It is
an allow-list over `status`, so a status added later refuses uploads by default
instead of accepting them because nobody extended a deny-list.

`PATCH {pin}` always re-hashes, even for an unchanged PIN. That is deliberate:
the guest cookie is a fingerprint of the stored hash, so a fresh salt logs out
every session issued under the old PIN — what a host rotating a leaked PIN is
asking for. `{pin: null}` clears it and returns the roll to `unlisted`.

Close, reopen, archive, rename, PIN change and slug regeneration each write an
`audit_events` row with `actor = 'host'`. The `target` column holds the value
the change **destroyed** (the old title, the old slug) — never the new one,
which is already in the roll row, and never a PIN.

### `X-Robots-Tag`

`src/rolls/robots.ts` sets `noindex, nofollow` on every response whose path is
under `/api/rolls/` (03 §9), as a root-context `onSend` hook rather than a
per-route header — a privacy control must cover the route somebody adds next
year, not just the ones that were remembered. Keying on the request path rather
than the matched route also covers 404s for mistyped slugs, and `onSend` catches
error replies, so the PIN gate's 401 carries it too.

## Logging

pino via Fastify, structured, one `reqId` per request (05 §17) taken from an
inbound `x-request-id` or generated as a UUID. Request bodies are never logged:
the `req` serializer emits an explicit allow-list, and password/secret/token
keys are censored through pino `redact` on top of that (05 §13).
