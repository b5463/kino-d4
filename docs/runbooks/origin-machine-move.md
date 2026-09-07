# Moving the origin to a dedicated machine

The on-demand phase runs KINO Roll on the operator's personal Windows PC
([`event-day.md`](event-day.md)). A dedicated machine comes later, and this is
how the origin moves without the product changing address.

This is also where the requirements the on-demand phase dropped come back: a
machine that does not sleep, unattended availability, recovery with nobody
watching, and Docker up all the time. They are properties of the new machine,
not of the old one.

Do this on a day with no event. It is not reversible in five minutes, and the
one thing that must never happen is two origins accepting uploads at once.

---

## The invariants

Everything below exists to keep these four true. Each is followed by what
breaks it.

### 1. The canonical URL does not change

`https://kino.acronym.sk` is the address before and after. Guests' saved links,
printed QR cards, the PWA's origin and the camera's stored `network.apiBase` all
keep working because none of them ever named the machine.

**Broken by:** editing `KINO_SITE_ADDRESS` or `PUBLIC_BASE_URL` in
`infra/.env.production` on the new host; giving the new machine its own hostname
"just for testing" and handing it to anyone; a QR code generated while
`PUBLIC_BASE_URL` was wrong, because that image is printed and cannot be
migrated. Roll guest links are computed from `PUBLIC_BASE_URL` on every read, so
a wrong value breaks old rolls as well as new ones.

### 2. No firmware change is needed

The camera stores one API base and one device token. Neither is tied to a
machine.

**Broken by:** a new hostname (invariant 1); an edge certificate from a
certificate authority the camera's CA bundle does not carry — keep the new edge
on the same ACME issuer the current one uses; a KDP or API contract change
smuggled into the same window, which turns a machine move into a firmware
release. Move the machine and change nothing else.

Device tokens themselves survive: the database stores a plain SHA-256 of the
token with no server-side pepper (`apps/api/src/auth/tokens.ts`), so a restored
database keeps every camera authenticated even if every secret in the
environment file is regenerated. That is a fact about the restore, not
permission to regenerate them — see step 3.

### 3. Roll codes, capture UUIDs and object keys survive identically

`rolls.slug` is what a guest types and what the QR encodes.
`captures.capture_uuid` is generated on the camera and is the anchor of upload
idempotency — the unique index on `(roll_id, capture_uuid)` is what makes a
retried upload after an outage a no-op instead of a duplicate.
`assets.object_key` is `rolls/<rollId>/captures/<captureId>/...`, and it is
stored, not recomputed: a row whose key does not resolve in the bucket is a
photograph nobody can open.

**Broken by:** re-creating rolls by hand on the new machine instead of restoring
the database; migrating an empty database and re-uploading from the cameras'
cards, which mints new ids for everything; renaming `S3_BUCKET` or
`S3_FIRMWARE_BUCKET`; restoring the database from one snapshot and the objects
from another. Rows and objects are **one** recovery point. A newer database with
older media has ready rows pointing at bytes that never existed.

### 4. One origin at a time

**Broken by:** starting the stack on the new machine while the old one is still
reachable through the public name. Both would accept uploads, captures would
land in two databases, and whichever one loses is data thrown away — the drain
gate on the old machine cannot see the other machine's rows. Stop the old stack
before the new one serves.

---

## The procedure

### 0. Prepare the new machine

- Docker with Compose v2, engine reachable (`docker version` prints a server
  version).
- The repository at the same commit as the old machine (`git rev-parse HEAD`
  matches). A different commit means a different migration set, which is a
  second change on top of the move.
- The disk to hold `pgdata` and `miniodata` is at least twice the size of the
  current volumes.
- Sleep off permanently and Docker starting without a signed-in session. This is
  the phase where that is a requirement rather than an event-day toggle.

### 1. Close the door on the old machine

No event in progress, and the queue proven empty:

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 drain -Roll <slug> -Expect <count>
```

Repeat for every roll that is still live. A `NOT SAFE` verdict here means a
camera still owes photographs, and the move would leave them owing them to a
machine that is gone. Wait, or close the rolls and let the cameras drain first.

Then stop accepting: `deploy.ps1 down -Relay`. From this moment the public name
is down, which is why this is not an event day.

### 2. Back up both stores

```powershell
powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 run    -BackupRoot D:\kino-backups
powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 verify -BackupRoot D:\kino-backups
```

`verify` must exit 0: a fresh snapshot, a non-empty `postgres.dump`, a non-empty
object mirror, and matching `SHA256SUMS`. A snapshot that fails verification is
not a migration source.

The snapshot must be reachable from the new machine — an external disk or a
share. Copy it, do not move it: the old machine keeps its copy until step 7 is
done.

### 3. Carry the configuration and the secrets

`infra/.env.production` is deliberately not in the backup tree. Copy it to the
new machine by hand, over something private, and keep the values identical:

| Value | Why it must not change |
|---|---|
| `KINO_SITE_ADDRESS`, `PUBLIC_BASE_URL` | invariant 1. Printed QR codes and every guest link |
| `S3_BUCKET`, `S3_FIRMWARE_BUCKET` | invariant 3. `object_key` is stored relative to the bucket |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | the object store is initialised from these; keeping them identical is one fewer difference between the machines when something does not serve |
| `PROVISIONING_TOKEN` | Studio uses it to register a camera. A new value is not a break, but it is a value the operator has to know is new |
| `COOKIE_SECRET` | signed guest cookies. Changing it logs every guest out of their own picks and PIN sessions. Harmless a week later, rude mid-event |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | consistency with `DATABASE_URL`/`REDIS_URL` in the same file. `deploy.ps1 init` generates these together for that reason; do not hand-edit one of a pair |
| `RELAY_HOST`, `RELAY_TOKEN` | only if the ingress mechanism is unchanged. See step 6 |

Do not run `deploy.ps1 init` on the new machine. It writes fresh secrets, which
is the opposite of what a move needs.

### 4. Restore both stores on the new machine

Follow the production recovery procedure in [`restore.md`](restore.md), not the
drill: the drill deliberately restores into a scratch project and deletes it.
The shape is the same and `infra/scripts/restore-drill.sh` is the reference for
every command in it —

1. verify `SHA256SUMS` before starting anything;
2. bring up `postgres` and `object-storage` on clean volumes, then
   `createbucket`;
3. `pg_restore --clean --if-exists --no-owner --no-privileges` from
   `postgres.dump`;
4. `mc mirror` both buckets out of the snapshot's `objects/`.

### 5. Prove the restore before anyone can reach it

Run the same three assertions the drill runs, against the real new stack:

- every asset row still links to a capture (zero orphans);
- every `assets.status='ready'` row has an object in the store;
- every restored object's SHA-256 equals the digest in the database.

Then start the full stack and check it locally:

```powershell
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 up
powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 drain -Roll <slug>
```

`drain` on a restored machine with no cameras attached is a useful read: it
counts captures, ready assets and objects, and it will say if the store holds
fewer objects than the database claims.

### 6. Move the ingress origin

Mechanism-dependent, and the mechanism may not be the one the old machine used —
the options and their trade-offs are in
[`public-ingress-options.md`](public-ingress-options.md).

- **Relay VPS, still relayed:** the new machine runs `frpc` with the same
  `RELAY_HOST` and `RELAY_TOKEN`; start it, watch for `login to server success`,
  and the VPS forwards to whichever client is connected. Make sure the old
  machine's `relay` container is down first — invariant 4.
- **Stack moving onto the VPS itself:** run the production compose there
  **without** the relay overlay and point the VPS's Caddy at the local stack.
  Switch the relay off. The `A` record does not move.
- **Any other mechanism:** the DNS record stays on `kino.acronym.sk`; only what
  it points at, or what terminates behind it, changes.

Whatever the mechanism: the record's name never changes, and the change is one
edit in one place.

### 7. Verify from outside, then keep the old volumes

Walk checks D through K of [`event-day.md`](event-day.md) — public ingress, DNS,
HTTPS, `/api/healthz`, the PWA on mobile data, a camera reporting **ONLINE**, a
QR opening the right URL, and one real physical-shutter photograph reaching a
phone. A move is not finished because a health endpoint answers.

Then leave the old machine's Docker volumes alone for at least one event cycle.
`deploy.ps1 down` preserves them; `down -v` destroys them. They are the rollback:
if the new machine turns out to be wrong about something, the old one still holds
a complete origin.

---

## Rollback

Before step 6, rollback is "start the old stack again" — nothing has changed for
anybody outside.

After step 6, rollback is: stop the new stack, point the ingress back at the old
machine, start the old stack. Captures uploaded to the new machine in between
are on the new machine only. That window is the reason step 7 verifies quickly
and the reason this is not done on an event day.
