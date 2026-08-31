# @kino/api

Fastify server behind `https://kino.acronym.sk/api/...`. Currently config, the
postgres/redis/S3 plugins, `GET /api/healthz`, the database schema, the
device/host/guest authentication described below, roll lifecycle, and the
capture + resumable upload pipeline.

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

`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_FIRMWARE_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_REGION`, `PUBLIC_BASE_URL`, `COOKIE_SECRET`,
`PROVISIONING_TOKEN`, `NODE_ENV`, `LOG_LEVEL`.

Every key has a dev default matching the compose file, so **no `.env` is needed
locally**. Three of them are not about the compose stack:

- `COOKIE_SECRET` signs the guest PIN session cookie. Its default is a published
  placeholder, and config loading **fails** unless `NODE_ENV` is explicitly
  `development` or `test`. Note the direction: the check asks "is this provably
  development?", not "is this production?" — so an unset, misspelled or
  unfamiliar `NODE_ENV` refuses to boot on the default rather than accepting it.
  Forgetting to set `NODE_ENV` is the likeliest deployment mistake there is, and
  it must not be the one that silently enables a forgeable cookie. Generate a
  real secret with `openssl rand -base64 48`.
- `PROVISIONING_TOKEN` is the shared secret a factory bench presents to
  `POST /api/studio/devices/register`, as `Authorization: Bearer <token>`,
  compared constant-time. Same treatment as `COOKIE_SECRET`, for the same reason:
  the default is a published placeholder
  (`kino-dev-provisioning-token-do-not-use-in-production`) and config loading
  fails unless `NODE_ENV` is provably `development` or `test`. The endpoint mints
  device tokens, so an unauthenticated one is a way for anyone who can reach the
  API to fill the platform with cameras nobody built. A *shared* secret proves
  the caller is a provisioning station, not which one — per-serial HMAC against a
  station registry is the follow-up, and V1 has no table to hold stations.
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

Three indexes are load-bearing contracts, not optimisations:

| Index | On | Why |
| --- | --- | --- |
| `captures_roll_uuid` | `(roll_id, capture_uuid)` | idempotency anchor — a retried upload of the same device-generated capture UUID cannot create a second row (05 §9) |
| `assets_capture_role_frame` | `(capture_id, role, frame_index)`, **NULLS NOT DISTINCT** | same, one level down: one asset per role per frame |
| `processing_events_capture_job_queued` | `(capture_id, job)` **WHERE `status = 'queued'`** | one enqueue per job per capture, while leaving the rest of that job's lifecycle log free to grow (migration 0004) |

Note what `captures_roll_uuid` does *not* say: a capture UUID is unique **per
roll**, not globally. Anything keyed on the uuid alone across the whole table —
`upload_sessions.idempotency_key` was, briefly — will collide between rolls. See
"Idempotency is an index, never a pre-check" below.

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
| `npm run firmware:publish -- <package-dir>` | verify and publish an immutable firmware package |

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
`app.redis` (ioredis), `app.s3` (AWS SDK v3 pointed at MinIO) and
`app.rollEvents` (the shared roll event subscriber), and each registers an
`onClose` hook, so `app.close()` releases every connection — including any open
SSE stream, which by definition would never end on its own.

`GET /api/healthz` pings all three concurrently (`select 1`, `PING`,
`HeadBucket`) with a 5 s per-probe timeout, and answers
`{ ok, db, redis, storage }` — `200` when all are reachable, `503` otherwise.

### Firmware catalog

`GET /api/firmware/releases?hardware=<revision>&protocol=<number>&channel=stable`
returns every release in the channel. Compatibility is annotated with an
explicit reason rather than hiding a package that does not match the connected
device. `GET /api/firmware/releases/:release/manifest?channel=stable` returns
the validated `kino.firmware-manifest` plus short-lived download URLs for each
target in the separate `S3_FIRMWARE_BUCKET`.

Publishing is intentionally a CLI operation in V1. A package directory contains
`manifest.json` and every target named by its `targets` map. The command checks
the manifest, safe file paths, image sizes and every SHA-256 before uploading
anything, then records the release:

```bash
npm run firmware:publish -- ./kino-firmware-1.2.3 --notes "Production D4 release"
```

An existing release/channel pair is always refused. Publish a new release number
instead: immutable releases make rollback and incident diagnosis reliable.

## Authentication

Three scopes (05 §12). `src/auth/tokens.ts` mints credentials, `src/auth/pins.ts`
hashes PINs, `src/auth/plugins.ts` turns both into Fastify preHandlers.

| Scope | Credential | preHandler | Sets |
| --- | --- | --- | --- |
| device | `Authorization: Bearer kdt_...` | `requireDevice`, `requireDeviceRoll(param)` | `request.device` |
| host | `Authorization: Bearer hrt_...` | `requireHost(param)`, `requireHostCapture(param)` | `request.roll`, `request.capture` |
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

### Host auth on a route with no `:rollId`

The moderation routes are addressed by `captureId`, so `requireHost(param)` —
which keys its comparison on a roll id path parameter — cannot express them.
`requireHostCapture(param)` joins `captures` to `rolls`, compares the presented
token against **the capture's own roll**, and sets `request.capture` alongside
`request.roll`. A host token for roll A therefore cannot moderate a capture in
roll B: the hash it is compared against is the one belonging to the capture, not
one the caller named.

Both preHandlers share `hostBearer` (presence and scope) and `hostTokenOpens`
(the constant-time comparison), so there is one definition of what a host
credential is. Order of answers: an unknown capture is **404 before** the token
is compared — safe because a capture id is 128 random bits — and a capture under
a roll the token does not open is **403**.

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
→ `{deviceId, deviceToken}`, `200`. Re-registering an existing serial follows
`DEVICE_REGISTRATION_MODE`.

**Gated on `PROVISIONING_TOKEN`.** The caller sends
`Authorization: Bearer <PROVISIONING_TOKEN>`; anything else — a missing header, a
wrong secret, a non-bearer header — is `401 PROVISIONING_TOKEN_REQUIRED`, refused
before the body is parsed and with the same answer either way, so the refusal
does not tell a prober it had the right shape. The comparison is constant-time
(`timingSafeSecretEqual`, which hashes both sides and reuses the one hex
comparison in `auth/tokens.ts`).

The endpoint mints a device token, i.e. a credential for the whole upload API, so
leaving it open meant anyone who could reach the API could create cameras. The
limitation is stated rather than papered over: one shared secret proves the caller
is *a* provisioning station and never which one, so a leaked bench secret
registers devices exactly as the bench does. Per-serial HMAC is the follow-up.

Every client that registers a device therefore has to send the header —
`apps/studio`, `apps/twin`, the P4 firmware's `roll_client.c`, and the
`infra/scripts` benches.

Task 36 made the safe behavior environment-sensitive and fail-closed:

- development/test default to `rotate`, preserving fast factory-reset work on a
  private bench;
- production and any unset/unrecognized environment default to
  `first-write-wins`, where an existing serial returns
  `409 DEVICE_ALREADY_REGISTERED` and its token hash is untouched; and
- every mode is limited to 10 registration requests/minute/IP — which still
  matters with the secret in place, because it bounds a caller that *has* it.

This closes the previous device-takeover primitive: knowing a printed serial can
no longer rotate the deployed device's token. The controlled physical recovery
procedure is documented in `infra/README.md`. First-write-wins does not make
unissued sequential serials secret, so registration remains rate-limited.

### Guest PIN session

`POST /api/rolls/:slug/pin` `{pin}` verifies against `rolls.pin_hash` and sets
the signed, httpOnly cookie `kino_pin_<rollId>`. Its value is a fingerprint of
the roll's *current* `pin_hash`, so changing a roll's PIN invalidates every
session issued under the old one. The cookie carries no secret; its
unforgeability comes from the `COOKIE_SECRET` signature.

The cookie uses `secure: 'auto'`, so @fastify/cookie sets `Secure` from the
actual request protocol — https in production, plain http on localhost in dev
and test — with no environment string to get wrong.

The production Compose stack enables `trustProxy` because the API is reachable
only through its private Caddy service. `X-Forwarded-Proto` therefore preserves
the cookie's `Secure` flag after TLS termination without trusting headers from a
publicly reachable API socket.

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
| `GET /api/host/rolls/:rollId` | host | dashboard view: real capture `counts` and live `guests` |
| `PATCH /api/host/rolls/:rollId` | host | `title` / `pin` / `downloadsEnabled` / `status` |
| `POST /api/host/rolls/:rollId/regenerate-slug` | host | → `{slug, guestUrl}`; old slug 404s |
| `GET /api/rolls/:slug` | guest | includes photo count plus download/reaction switches |
| `GET /api/rolls/:slug/captures` | guest | visible capture feed with ordered asset summaries |
| `GET /api/rolls/:slug/captures/:captureId` | guest | visible detail plus anonymous reaction state |
| `POST /api/rolls/:slug/captures/:captureId/react` | guest | toggles one signed, session-only anonymous heart |
| `GET /api/rolls/:slug/events` | guest | SSE; see [Live events](#live-events-03-7-05-10) |

`POST /api/host/rolls` is unauthenticated for the same reason device
registration is: V1 has no accounts (05 §12), so the call *mints* the
credential rather than checking one. It is a spam/storage surface, not a
data-exposure one — the roll it creates is reachable only through the token in
its own response.

### Slug

Six characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (`src/rolls/slug.ts`),
drawn with rejection sampling from `crypto.randomFillSync` so no character is
more likely than another. `0`/`O` and `1`/`I`/`L` are excluded because a slug
gets read off one phone screen and typed into another. ~887M values, ~29.7 bits.
Uniqueness is the `rolls_slug_unique` constraint's job; the caller retries on
collision (pre-checking with a SELECT would still race).

Every site that resolves a slug — `guestRollAccess`, the PIN exchange, and
`POST /api/device/rolls/join` — runs it through `normalizeSlug()`
(`trim().toUpperCase()`) first. All three, deliberately: a roll that is readable
at `…/r/abc234` but cannot be *unlocked* at that casing would be a dead end with
no error message that explains it.

The slug is separate from `rolls.id` (05 §14), which is what lets
`regenerate-slug` rotate a leaked link without touching a single row that
references the roll.

#### What the slug actually is, post-Task-17

Earlier drafts of this file called the slug "not a secret, a link that is
impractical to stumble on". That was true when only guests could use one. It is
**not true any more**, and the difference matters:

> Since Task 17, the slug is the **sole credential for device write scope**.
> `POST /api/device/rolls/join` takes a slug and grants the calling device a
> `roll_devices` row — permanent operate/upload scope on that roll. There is no
> PIN gate on join (correct per 03 §9 — the PIN protects the *guest gallery*,
> not device assignment) and no host approval step. Anyone holding a slug and
> any device token can put a camera into that roll.

~29.7 bits is a thin credential for write access, so Task 36 now meters the join
route by IP and locks a device for an hour after ten misses. The slug still does
authorization work its entropy was not chosen for; the controls are therefore
part of the security boundary, not optional performance tuning.

### Rate limiting and exposure hardening (Task 36)

All counters use shared Redis storage, so adding API replicas does not multiply
an attacker's budget. Test servers alone use isolated namespaces so parallel
suites cannot throttle one another. The controls remain ordered by what a
successful guess wins:

**1. `POST /api/device/rolls/join` — enumeration that converts directly into
write scope.** Limited to 30/minute/IP. Each authenticated device also gets a
miss counter: ten unknown slugs lock it for one hour, while a valid join clears
the history. This covers both source rotation and free-token rotation without
making a single human typo punitive.

**2. `POST /api/studio/devices/register` — identity takeover.** Limited to
10/minute/IP, with production first-write-wins. An existing serial cannot rotate
a deployed token; see the registration section above.

**3. `POST /api/rolls/:slug/pin` — online PIN guessing.** Limited to
5/minute/IP. scrypt remains defence in depth, not the request budget.

**4. Guest reads.** 300/minute across Roll metadata, feeds, details, live events
and firmware. This meters the existence oracle and bounds anonymous read
amplification.

**5. Media delivery — its own, much larger bucket.**
`GET /api/assets/:assetId/content` is 3000/minute. It used to share (4)'s 300,
which had the reads that decide *what to draw* rationed by the image traffic they
produce: one gallery screen is a handful of API calls and a tile per capture, so a
household or a venue behind one address hit 429 on its own photographs. Large, not
unlimited — the route signs a URL or proxies bytes after three joined rows.

Both guest buckets key on the **signed guest cookie id** when the request carries
one and fall back to the source address otherwise (`guestKey` in
`plugins/rateLimits.ts`). The cookie is the better key where it exists: it follows
a phone from Wi-Fi to cellular mid-gallery and stops one visitor spending a shared
address's whole allowance. It is signed, so it cannot be invented to buy a fresh
bucket, and the limiter never *mints* one — handing out browser state is
`ensureGuestId`'s job, not a rate limiter's. (This is why `@fastify/cookie` is
registered before `rateLimitsPlugin` in `buildServer`: both parse in an
`onRequest` hook, and hooks run in registration order.)

Device upload mutations are grouped at 60/minute/token, and `POST /api/device/rolls`
joins them at 60/minute/token — keyed by credential rather than address, because
four cameras on one venue uplink share an address but not a token. Anonymous
`POST /api/host/rolls` is limited to 60/minute/IP as a row/storage abuse surface.

`GET /api/device/rolls/current` also caps its result at 50 rolls: the query was
unbounded and its consumer is a camera touchscreen that shows a handful.

### Revoking a guest link (`access_epoch`)

`POST /api/host/rolls/:rollId/regenerate-slug` rotates the slug **and** bumps
`rolls.access_epoch` in the same statement (`access_epoch + 1`, computed in SQL so
two concurrent regenerations produce two increments).

The column exists because rotating the slug alone revokes only the front door.
`GET /api/assets/:assetId/content` is addressed by asset id and derives the roll
from the asset, so without it every id a leaked link had already handed out would
keep serving bytes from a roll the host had just taken back.

`guestRollAccess` — the slug gate — hands a guest a signed, httpOnly cookie
`kino_roll_<rollId>` stamped with the current epoch, on path `/` because the asset
route lives outside the slug space. `deliverAsset` requires the current stamp.
Same mechanism as the PIN cookie, pointed at a different fact.

**Enforced only once a roll has actually been revoked**, and the gap is stated
rather than hidden. `access_epoch = 0` — the host has never regenerated — answers
exactly as it did before, so a leaked asset id is still readable by whoever holds
it. Requiring the stamp unconditionally would blank the gallery for any deployment
whose web app and API are not the same site: a cross-site `<img src>` sends no
`SameSite=Lax` cookie, which is every dev bench (roll-web on its own localhost
port). Production behind Caddy is same-site and carries the stamp. Closing the
remaining gap means either making the stamp mandatory — which needs same-site
delivery everywhere — or putting a signed grant in the asset URL itself, which is
a change to how `roll-web` builds those URLs.

The roll host is exempt from all of it: `hostTokenPresented` short-circuits the
guest gates, since it is the host's roll and the host who revoked the link.

### Which asset roles a guest may see

`GUEST_VISIBLE_ROLES` in `captures/delivery.ts` is an **allow-list** of the roles
on the guest surface, and `guestMaySeeRole` is read by two places that must agree:
the feed, which decides which asset ids a guest is *told* about, and
`deliverAsset`, which decides which it may *fetch*. One predicate, so the feed
cannot publish an id that only ever 404s.

`metadata` is the only role off the list, and it is why the list exists.
`extract-metadata` writes a `metadata.json` asset carrying GPS EXIF, the device
serial and hardware revision, every original frame's object key and the capture's
provenance — and it arrived as an ordinary `ready` asset row, so the feed named its
id to guests and delivery signed a URL for it. A guest asking for one now gets
`404 ASSET_NOT_FOUND`, the same answer as an id that was never real; the roll's
host token fetches it.

Note the polarity, which is the opposite of `NEVER_GATED_ROLES` ten lines above it
in the same file, deliberately. That list answers "may this be *downloaded* when
the host said no?", where forgetting a role costs a file saved that should not have
been. This one answers "may a stranger with a link *see* this at all?", where
forgetting a non-pixel role publishes it to the internet the day a worker first
writes one. A guest role missing from the list is invisible in the gallery — a bug
a tester finds in a minute. `guest-feed.test.ts` enumerates every role in
`ASSET_ROLES` against the predicate, so a role added to the schema with no decision
made about it fails there.

### States (03 §22)

`live ↔ closed → archived`, archived terminal; re-sending the current status is
a no-op, anything else is `400 INVALID_STATE`. Archiving requires closing first
— "closed" is where the host actually decides no more photos are coming.

Closing stops **uploads**, not reading: `GET /api/rolls/:slug` still answers 200
for a closed roll. The upload half of that rule is
`assertRollAcceptsUploads(roll)` in `src/rolls/rolls.ts`, which throws
`RollClosedError` (`409 ROLL_CLOSED`); the capture and asset-init routes call
it. It is an allow-list over `status`, so a status added later refuses uploads
by default instead of accepting them because nobody extended a deny-list.

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

## Captures and uploads

The camera's side of the platform (03 §16). Everything is device-scoped and
lives under `/api/device/`.

| File | Holds |
| --- | --- |
| `src/routes/device-captures.ts` | the six routes — parse, authorise, answer |
| `src/uploads/objectKeys.ts` | every key the platform writes, plus the immutability guard |
| `src/uploads/uploads.ts` | the pure rules: capture states, idempotency keys, role/MIME, counts |
| `src/uploads/sessions.ts` | the S3 choreography: asset rows, multipart lifecycle, verification |

| Route | Body | Answers |
| --- | --- | --- |
| `POST /api/device/rolls/:rollId/captures` | a `kino.capture` document | `201 {captureId}`, or `200 {captureId}` replaying a known `captureUuid` |
| `POST /api/device/captures/:captureId/assets/init` | `{role, frameIndex?, mime, bytes, sha256}` | `{uploadId, partSize, alreadyComplete}` |
| `PUT /api/device/uploads/:uploadId/parts/:partNo` | raw `application/octet-stream`, ≤ `partSize` | `{received: true, partNo}` |
| `POST /api/device/uploads/:uploadId/complete` | — | `{assetId, status:'ready'}` or `422 CHECKSUM_MISMATCH` |
| `POST /api/device/captures/:captureId/complete` | — | `{captureId, status}`; queues processing jobs |
| `GET /api/device/captures/:captureId/status` | — | `{status, assets:[{role, frameIndex, status}]}` |

The capture body is parsed with `parseVersioned(capture, body)` from
`@kino/schemas`, not an ad-hoc zod object: the document is device-authored, so
an older firmware gets migrated and a newer one gets a clear refusal. Path and
token beat document: `rollId` comes from the URL, `deviceId` from the
credential, `status` from the server's own state machine. A document field is a
claim, never a capability.

### Idempotency is an index, never a pre-check (05 §9)

Both retry-safe writes are `INSERT ... ON CONFLICT DO NOTHING` followed by a
read-back — `captures_roll_uuid` for the capture, `assets_capture_role_frame`
for the asset. A `SELECT` first would let two concurrent retries both find
nothing and both insert; the index makes the loser's `INSERT` wait for the
winner to commit and then return no row, so the read-back sees the winner.
`tests/uploads.test.ts` fires two identical capture POSTs concurrently and
asserts one row, one id, and a 201/200 split.

The upload session's key is unique, so a device that restarts an upload
**reuses** that row rather than adding a second one. One session per asset is
what keeps "which upload is this asset's?" answerable at all.

That key is `<captureId>:<captureUuid>:<role>:<frameIndex>` in the column, not
the bare 05 §9 string, and the prefix is load-bearing. `captureUuid` is camera-
generated and anchored **per roll** (`captures_roll_uuid` is
`(roll_id, capture_uuid)`), so the same uuid may legitimately appear in two
rolls — while `upload_sessions.idempotency_key` is unique across the whole
table. Keyed on the device's string alone, capture B's `init` would find, reset
and steal capture A's session: A loses its parts and its expected digest, and B
is left pointing at A's asset and can never upload that role at all. The
device-facing semantics of 05 §9 are unchanged — the substring after the first
colon is exactly `idempotencyKeyFor(...)`.

Belt and braces, because this one is a data-loss bug rather than a nuisance: the
lookup is *also* pinned to the asset (`AND asset_id = ...`) so it can never
adopt a stranger's row, and a unique violation on the insert answers
`409 UPLOAD_IN_PROGRESS` — with the key capture-scoped, that can only mean a
concurrent `init` for this same asset, and the caller's retry finds the winner's
session and resumes it.

### Every session is a multipart upload

D4 assets are ≤ ~2 MB and `partSize` is 5 MiB, so in practice every upload is a
single part and a plain `PutObject` would work. It is multipart anyway, always,
because a `PutObject` fast path would need somewhere to hold part 1 until it
learned whether a part 2 was coming — a second code path that fails differently
from the one used on a bad connection, which is the path that must not be the
less-tested one. S3 allows a single-part multipart upload (the 5 MiB floor
exempts the last part), the schema already carries `s3_upload_id` and part
etags, and the wire contract is identical either way: the device never learns
which it got.

### Completion re-reads the object

`complete` finishes the multipart upload, then **streams the stored object back
through sha256** and compares it to what the device declared at init. Trusting
the bytes on the way in would miss a truncated part, a part that landed twice,
and storage that accepted something other than what was sent. On a mismatch the
object is deleted (it was never accepted), the session is marked `failed`, the
asset stays `pending`, and the device gets `422 CHECKSUM_MISMATCH` and starts
again from init.

### Size is enforced in three places (`MAX_ASSET_BYTES`)

There was no ceiling at all: `bytes` at init was merely `positive()`, and nothing
ever compared it to what arrived — so a session could accept parts up to
`MAX_PART_NUMBER × PART_SIZE`, roughly 48 GiB, per asset, per capture.

- **init** refuses a declaration above `MAX_ASSET_BYTES` (32 MiB) with
  `400 INVALID_BODY`. A D4 original is ~2 MB and the largest derivative anything
  produces is a recap MP4 of a few tens of MB, so this is an order of magnitude of
  headroom over the biggest real asset.
- **each part** is refused with `413 UPLOAD_TOO_LARGE` if the parts already filed
  plus this body exceed `bytes_expected`. Checked *before* the `UploadPart`, so
  the refusal has not already paid for the bytes, and a **resent** part replaces
  its own row rather than adding to the total — otherwise the ordinary retry this
  pipeline exists to survive would be refused as oversized.
- **complete** compares the stored object's length to `bytes_expected` and answers
  `422 SIZE_MISMATCH`, with the same disposal as a checksum failure. This is the
  case where a device declares two megabytes, stores thirty, and declares the
  digest of what it actually sent — content that verifies at a length nothing
  authorized.

Capture provenance is capped too: the passthrough remainder of `kino.capture` is
unvalidated client input landing verbatim in a jsonb column, so anything over
8 KiB of JSON is dropped whole and replaced with `{extraDropped: {bytes, limit}}`.
Dropped whole rather than trimmed key by key — a half-kept provenance block is a
record that looks complete and is not.

### Object keys (05 §6) and the immutability guard (01 §7)

`src/uploads/objectKeys.ts` is the only place keys are built:

```text
rolls/<rollId>/captures/<captureId>/original/cam-<NN>.jpg   originalKey
rolls/<rollId>/captures/<captureId>/derived/<name>          derivedKey
rolls/<rollId>/derived/<name>                               rollDerivedKey
```

Camera numbers are 1-based and zero-padded to two digits, matching the
`CAM1..CAMn` labelling on the hardware. `.jpg` is fixed by the spec, which is
why `original-frame` uploads must declare `image/jpeg` — a key that says one
thing while the bytes say another is a trap for everything downstream. Derived
names are `<role>.<ext>` with the extension from an allow-list of stored MIME
types, so no client string ever reaches a key verbatim.

`assertNotOriginalOverwrite(key, storedSha256, incomingSha256)` is the guard,
called at init *and* on the write path in `complete`. Anything under `derived/`
passes — re-rendering a thumbnail is the normal case. Under `original/` there
are exactly two ways through: the caller declares a digest and nothing is stored
yet, or the declared digest *equals* what is stored (a retried upload of
identical bytes, which is not an overwrite). A caller that cannot name the
digest of its own payload is refused outright — which is the shape of every
worker write path (Task 22's `putDerived` has nowhere to put one), so "workers
may only write under `derived/`" falls out of the same check instead of needing
a second one that could disagree with it.

**The `complete`-side guard runs under a row lock**, and that is not a
precaution. The guard reads the asset's stored digest and then a write happens;
between those two moments a concurrent complete can flip the asset to `ready`
with different content, so a guard evaluated on a snapshot would be answering
about a state that no longer exists. `finishUpload` opens a transaction, reads
the asset `FOR UPDATE`, re-reads the session, and holds that lock across the
guard **and** the write — the second completer blocks, then re-reads and sees
the digest it now has to match. The lock spans the S3 round trip, which is the
deliberate cost: it is one asset row, contended only by another attempt to write
the same object, which is exactly what must not run in parallel.

### Capture states (05 §8)

```text
created → preview-ready → originals-uploading → complete → processing → ready
                                                   ↘ partial     ↘ failed
```

`nextCaptureStatus(assets, jobsDone, jobsQueued = jobsDone)` is a pure function
of the asset rows plus the job phase, and `recomputeCaptureStatus` re-derives
the stored column from the tables rather than transitioning it — a cache that is
rebuilt cannot drift from what it caches. Job state comes from
`processing_events`, which is what stops a worker's own `pending` asset row from
walking a `processing` capture backwards into `originals-uploading`.

`complete` deliberately requires at least one *original* frame to be in: a
capture whose only asset is a thumbnail is a preview that arrived first (03 §4's
upload priority), not a finished capture.

`partial` stays reachable after the queue has run: jobs finishing on a capture
that permanently lost an original yields `partial`, not `ready`. Reporting
`ready` there would drop it out of the host's Pending count while it is
genuinely incomplete, which is the one thing `partial` exists to prevent. While
the jobs are still running the answer is `processing` — a failed asset may yet
be retried, so the outcome is not decided.

### One stub, marked as such

- `enqueueProcessingJobs` in `src/uploads/uploads.ts` — writes the
  `processing_events` `queued` rows and returns the payloads a real queue would
  have been handed. Task 22 adds `await enqueue(name, payload)` inside the loop;
  the job names, the `jobKey` format and the fan-out rule (skip a role the device
  already uploaded — 03 §4) are already Task 22's.

  It inserts and lets an index decide, like everything else here: migration
  `0004` adds `processing_events_capture_job_queued`, a **partial** unique index
  on `(capture_id, job) WHERE status = 'queued'`. The `WHERE` is the whole point
  — this table is an event *log*, and Task 22 records a job's progress as
  `queued` → `running` → `done`/`failed`, so a blanket unique on
  `(capture_id, job)` would make the second row of any job's own lifecycle
  impossible. Restricting it to the enqueue keeps the log open while making the
  one thing that must not duplicate impossible to duplicate.

### Known gaps

- An abandoned session leaves an incomplete multipart upload in MinIO until
  something aborts it. `init` aborts the previous one when it restarts a
  session, but a device that simply stops leaves it behind; a bucket lifecycle
  rule is the real answer. **Deferred as audit API-13** and not built here: it is
  bucket policy rather than application code, so it belongs with the storage
  configuration in `infra/`.
- A job whose `queued` row is committed but whose BullMQ entry was never added is
  never retried, because the row is what makes a second capture-complete a no-op.
  Reconciling that needs a sweeper over `queued` rows with no live job.
  **Deferred as audit API-14** and not built here.
- Two concurrent `init` calls for the same asset both create a multipart upload;
  the loser now answers `409 UPLOAD_IN_PROGRESS` and aborts the upload it had
  just created, so the database stays single-session — but a failed abort still
  leaves bytes behind, same as above.
- Re-initialising a *derived* asset with a different MIME type moves it to a new
  key and orphans the object at the old one. Rare, and deleting a still-good
  object on the strength of an upload that has not happened yet would be the
  worse trade — but it is a gap, not a design.
- Closing a roll stops *new* uploads. A session opened while the roll was live
  is allowed to finish, because stranding half-transferred bytes is not what
  closing a roll is for.
- `complete` holds a database connection for the length of its S3 round trip
  (the row lock above). The pool is 10, so ten simultaneous completions saturate
  it. Correct, and cheap at party scale; it is the figure to look at first if
  this ever needs to serve many rigs at once.

## Live events (03 §7, 05 §10)

`GET /api/rolls/:slug/events` — Server-Sent Events, under the same
`guestRollAccess` rules and the same `X-Robots-Tag` as the rest of the guest URL
space. New captures appear without a refresh.

| File | Holds |
| --- | --- |
| `src/events/publish.ts` | the event union, the keys, `publishRollEvent`, `readRollHistory` |
| `src/events/bus.ts` | the one shared subscriber connection and its refcounts |
| `src/events/feed.ts` | one guest's replay-then-live join |
| `src/events/viewers.ts` | the per-roll live viewer count |
| `src/routes/guest-events.ts` | the SSE response itself |

### Publishing

Every event goes to two Redis keys, in this order:

```text
XADD    roll:<id>:stream  MAXLEN ~ 500    the durable, replayable log
PUBLISH roll:<id>:events                  the live fan-out
```

XADD first, because a publish that dies half-way has at least *recorded* the
event and every subscriber finds it on their next reconnect; PUBLISH first would
deliver to whoever happened to be connected and hide it from everyone else
forever. The channel payload is `{"id":"<entry id>","event":{…}}` — the
subscriber has to label each frame with the id a reconnect sends back, and the
stream entry id is the only id both halves agree on.

Payloads carry **ids only** (`{type, captureId?, role?}`); the PWA re-fetches the
capture (05 §10). Everything read back off either key is parsed against the
event union before it can reach a guest.

`MAXLEN ~ 500` bounds replay depth per roll, not retention: a guest away for
more than 500 events gets a truncated replay, which costs at most a stale tile
until the next event.

### The wire

```text
retry: 3000

id: 1786903764873-0
event: capture.created
data: {"type":"capture.created","captureId":"cap_…"}

: heartbeat
```

Events are **named**, matching 03 §7's list, so a client uses
`addEventListener('capture.created', …)` — `onmessage` alone will see nothing.
The payload repeats `type` so one handler can serve every name. The heartbeat
comment every 25 s keeps proxies from reaping an idle stream.

The reply is a `PassThrough` stream, not `reply.hijack()` + `reply.raw.write()`:
hijacking skips `onSend`, which is where `robotsPlugin` lives, and a route that
can forget the privacy header is exactly what that plugin exists to prevent.

### Reconnect, and the gap between replay and live

On reconnect the browser sends `Last-Event-ID`. The feed **subscribes first**,
buffers, then reads history with an exclusive `XRANGE (<id>`, then drains the
buffer. Both orderings have a window, and this is the recoverable one:

- snapshot then subscribe — an event published in between is **lost**, and no
  later mechanism recovers it, because the client's `Last-Event-ID` has already
  moved past it.
- subscribe then snapshot — an event published in between arrives **twice**.

Duplicates are detectable, losses are not. The detector is a watermark: stream
ids only increase, so anything not greater than the last id delivered has
already been delivered. It starts at the client's own `Last-Event-ID`, which
also makes the replay exclusive of the event it already has.

The watermark is **disarmed once the drain finishes**, and that is deliberate.
`XADD` and `PUBLISH` are two round trips, so two API instances publishing to one
roll can reach the channel in the opposite order to the one the stream assigned.
A watermark left armed for the life of the connection would discard the older id
forever — and nothing would recover it, because the guest's socket is healthy and
no replay is coming, so a tile would simply never appear. That is the same
loss-versus-duplicate trade, decided the same way: while catching up the gate
prevents a real duplicate, and afterwards a reordered publish costs at most one,
which the PWA's re-fetch absorbs.

A malformed `Last-Event-ID` is a `400 INVALID_LAST_EVENT_ID`; a browser can only
send back an id this route issued.

### One subscriber connection per process

ioredis puts a connection into subscribe mode when it subscribes, after which it
refuses ordinary commands — so `app.redis` cannot be used, and the obvious
alternative (`duplicate()` per SSE request) is 50 viewers × rolls × instances
idle connections, re-established on every mobile screen lock. Instead
`RollEventBus` owns exactly one duplicated connection, subscribes per channel
with a reference count, and unsubscribes when the last guest on a roll leaves.
Per-channel rather than `PSUBSCRIBE roll:*:events`, so Redis does the filtering
it already has the index for.

The cost is shared fate: if that connection drops, every live guest is affected
— and *silently*, which is the part that matters. ioredis reconnects and
re-subscribes on its own, but events published during the blip were only ever on
the channel, and the guest's SSE socket stayed healthy throughout, so their
EventSource never reconnects, never sends `Last-Event-ID`, and never replays.
Left alone, those events are gone for the rest of the party.

So the loss is announced, not assumed away. `RollEventBus.onConnectionLost`
fires on the subscriber socket's `close`/`end`, and `guest-events.ts` responds by
**ending every open SSE response**. That turns a silent server-side fault into
the one failure the client already knows how to recover from: the browser
reconnects after 3 s with `Last-Event-ID` and replays the gap out of the stream.
Tested by killing the subscriber connection server-side (`CLIENT KILL TYPE
pubsub`) and asserting the streams end and the reconnect receives the event
published while this process was deaf.

### Counting guests

`roll:<id>:viewers` is a sorted set scored by heartbeat timestamp, not a set
with a key TTL. A TTL belongs to the key, so one connection that died without a
FIN — a phone that left the building — would be counted for as long as any other
guest kept refreshing the key. Per-member scores expire per member:
`countRollViewers` prunes anything older than 60 s (two missed heartbeats) on
read and returns `ZCARD`. Resolution is the heartbeat: a clean disconnect is
removed at once, a vanished one within 60 s.

`GET /api/host/rolls/:rollId` is the consumer — the dashboard's `guests` field
(03 §10). It runs concurrently with the capture counts, and a Redis failure
reports **0** rather than failing the dashboard: the viewer set is maintained
only by live SSE connections, which need the same Redis, so an unreachable Redis
means there is nobody to count. The outage itself shows up in `/api/healthz`.

### Known gaps

- Roll deletion (trash grace + purge job) removes rows and objects but does
  not `DEL` the roll's `roll:<id>:stream` and viewer keys. The stream is
  bounded at `MAXLEN ~ 500` entries, so an orphaned key is small but
  permanent. If orphaned keys ever matter, the purge job is the place to
  `DEL` both.
- A client that stops reading is dropped once 64 KB has queued for it, rather
  than being buffered indefinitely. That is safe *because* of `Last-Event-ID`:
  it reconnects and replays.

## Host moderation and export (03 §11, §25)

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /api/host/rolls/:rollId/captures` | host | every capture incl. hidden and trashed |
| `POST /api/host/captures/:captureId/hide` | host (capture) | `visible = false`; `capture.hidden` |
| `POST /api/host/captures/:captureId/unhide` | host (capture) | `visible = true`; `capture.updated` |
| `DELETE /api/host/captures/:captureId` | host (capture) | `deleted_at = now()`; `capture.deleted` |
| `POST /api/host/rolls/:rollId/export` | host | `202 {jobId}`, `Location:` the poll route |
| `GET /api/host/rolls/:rollId/export/:jobId` | host | `{status, url?}` |

The four write routes each write an `audit_events` row with actor `host` and actions
`capture.hidden` / `capture.unhidden` / `capture.deleted` / `roll.exported`. For
these, `target` is the id of the row the action applied to, not a destroyed value
— an entry that did not name its capture would record only that *something* was
hidden.

Moderation works on a **closed or archived** roll. Closing stops uploads (03
§22); it does not stop a host taking down a photo somebody complained about
afterwards, which is when most complaints arrive.

### The host's own capture list

`GET /api/host/rolls/:rollId/captures` returns **every** capture of the roll —
hidden and trashed included — each item carrying `visible`, `deletedAt` and the
derived `purgeAfter` on top of the guest fields.

It is not a convenience. 03 §11 says a hidden capture is "retained for host", and
every other capture-listing route is guest-gated behind
`visible = true AND deleted_at IS NULL`. Without this route a hidden capture's id
appears nowhere on the API surface: the host watches `counts.hidden` go up and has
no way to name the capture it counted, so `POST /unhide` is unreachable in
practice. Retention that cannot be observed is not retention.

A **dedicated route** rather than a `captures` array on the dashboard response,
for two reasons: a roll holds hundreds of captures, so an embedded array would
make every dashboard render read the whole roll with no pagination story to grow
into; and the dashboard is the request that gets polled for its counts, so it is
the one that must stay cheap.

It reuses the guest feed's reader through a `FeedAudience` flag — `visibleTo()` is
the only thing that differs — so both feeds share one keyset, one cursor encoding,
one `limit + 1` trick and one asset join. Duplicating them would let the host's
list drift out of step with the guest's, which is precisely the comparison a host
makes when deciding whether a photo is really hidden. `limit` and `cursor` behave
identically to the guest feed, down to the 400 codes.

### Hide versus delete

`hide` sets `visible = false` and retains everything. `delete` sets `deleted_at`
and retains everything for `TRASH_GRACE_DAYS` = **7**; the daily purge job is
what finally removes the bytes. Both API and worker import that value from
`@kino/schemas`, so the displayed recovery deadline and enforced deadline cannot
drift.

Both are invisible to a guest the moment the row is committed — `guestVisible` in
`captures/feed.ts` reads the same two columns, so the feed and the detail route
change within the same request cycle, with no cache to invalidate. A trashed
capture also leaves the host's dashboard counts, which read "what is not in the
bin"; a hidden one stays in `captures` and appears in `hidden`.

`delete` deliberately does **not** also clear `visible`. The two flags mean
different things, and any future restore has to put the capture back exactly as
the host had it. Re-deleting keeps the **original** `deleted_at`, so a client
retrying on a timeout cannot postpone the purge.

Every verb is a no-op the second time — no duplicate audit row, no duplicate
event. Hiding an already-hidden capture is an ordinary retry, and an event for it
would tell every connected guest to re-fetch something that did not move.

**The test that decides is the WHERE clause** (`ne(visible)` / `isNull(deleted_at)`),
not a comparison against the preHandler's read. That read is a snapshot one round
trip old, so two concurrent requests both see the old state and both pass a guard
based on it — duplicate audit row, duplicate event, and for delete a `deleted_at`
overwritten with the later timestamp, which silently postpones the purge. It is
not a rare interleaving either: a client timeout does not cancel the in-flight
request, so the retry races the original by construction. With the predicate in
the statement, PostgreSQL's row lock decides and "no row came back" is the honest
definition of "somebody else already did this"; the reply then re-reads the row
rather than echoing the stale snapshot. A
failed publish does not fail the request: the row is committed, so the capture is
already gone for anyone loading the page, and refusing the host's moderation
because Redis blinked would be the worse trade.

There is no bulk endpoint, no reason field, no reviewer queue and no restore
route — 03 §29, "do not overbuild moderation for V1".

### Export state lives in `export_jobs`, not `processing_events`

`processing_events.capture_id` is NOT NULL and its dedupe index is keyed on
`(capture_id, job)`. A roll export belongs to no capture, so it cannot have a row
there without either loosening that column — making every capture-scoped consumer
handle a null it can never see — or inventing a placeholder capture. So a roll
export gets its own table, and the keys state the difference: one answers "how is
this capture's pipeline doing", the other "where is the host's ZIP".

The row **is** the jobId. Its primary key names the row, names the BullMQ job
(`exportJobKey(jobId)` = `<jobId>:export-roll`), and names the object
(`exportObjectKey` = `rolls/<rollId>/derived/exports/<jobId>.zip`), so a host
holding one id can be answered with no lookup table between the three. The key is
**derived, never stored**: a stored key and a computed key are two answers to one
question, and the day they disagree the ZIP is unreachable with nothing to say
why.

`export_jobs_roll_live` is a partial unique index on `roll_id` where status is
`queued` or `running` — one live export per roll, enforced by the database rather
than the route. A full export is the heaviest job in the platform, and the host
UI's natural failure mode is a button pressed three times because nothing
visibly happened; without the index that is three full exports. `claimExportJob`
inserts and lets the index decide (a SELECT-then-insert would let two taps both
find nothing and both insert), then reads back the job already in flight and
returns *its* id.

Unlike the upload pipeline, a failed `queue.add` **fails the request**. A missing
thumbnail regenerates on the next capture; a missing export never happens, so a
`202 {jobId}` for a job nobody will pick up would be a lie. The route therefore
submits on *every* call, not only on a fresh claim: the jobId is derived from the
row, so re-submitting a job that still exists is a no-op inside BullMQ, and
re-submitting one that does not is how the retry recovers the `queued` row a
failed add left behind. Submitting only fresh claims would leave that row unqueued
forever.

### The link is signed only when the ZIP is there

`GET …/export/:jobId` answers `{status}` alone until status is `done` **and** a
`HeadObject` confirms the object. Signing a missing object hands the host a link
that 404s from storage with nothing to explain it, while the status field claims
the file exists; one HEAD to make that claim true is the right trade, and the
"done but no object" case is logged at error level.

Expiry is 24 h — far longer than the 60 s on an asset URL, because the two links
are different things: an asset URL is fetched immediately by an `<img>` the
server just authorized, an export URL is handed to a human to click when
convenient. The job id is part of the `WHERE`, so a job belonging to another roll
is indistinguishable from one that never existed (`404 EXPORT_JOB_NOT_FOUND`).

Neither route consults `downloadsEnabled`: that flag governs what **guests** may
download, and a host who turned it off has not locked themselves out of their own
photos.

### Known gap

- There is no restore route in the V1 moderation surface. A trashed capture can
  only be recovered administratively during its seven-day grace period. The V1
  plan deliberately limits moderation to hide/unhide/delete; adding a host
  restore action remains a product decision rather than an unfinished purge.

## Logging

pino via Fastify, structured, one `reqId` per request (05 §17) taken from an
inbound `x-request-id` or generated as a UUID. Request bodies are never logged:
the `req` serializer emits an explicit allow-list, and password/secret/token
keys are censored through pino `redact` on top of that (05 §13).

The **slug** is censored out of the logged URL: `/api/rolls/<slug>/captures` is
logged as `/api/rolls/[REDACTED]/captures`. A slug is not an identifier, it is the
guest credential for an unlisted roll (03 §9) — whoever holds one reads the
gallery — so an access log full of them is an access log full of live links, the
same class of value as the `Authorization` header this serializer already refuses
to print. Only that one segment is replaced: the route, the capture id and the
query survive, because a capture id opens nothing on its own and the path is what
makes a log line worth keeping.

`PROVISIONING_TOKEN` is listed in `SECRET_KEYS` by its exact name. fast-redact
matches whole key names, so the generic `token` rule does not cover it — the same
trap `S3_SECRET_KEY` documents.
