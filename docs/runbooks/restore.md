# KINO production backup and restore

## Policy

Run `infra/scripts/backup.sh` nightly from the production host. `BACKUP_ROOT` must be an absolute mount backed by another machine, object-storage gateway, or independently replicated volume; a second directory on the same disk is not an off-host backup. Each immutable snapshot contains a PostgreSQL custom-format dump, both MinIO buckets, metadata, and a SHA-256 manifest. Retention is 14 daily and 8 ISO-weekly snapshots.

Keep the environment file and its credentials outside the backup tree. Encrypt the off-host target at rest and restrict it to the backup operator. A backup containing private Roll media is production data.

```sh
BACKUP_ROOT=/mnt/kino-backups \
ENV_FILE=infra/.env.production \
infra/scripts/backup.sh
```

Treat a run as successful only when it prints `backup complete`. Alert when no new daily directory appears for 26 hours, a snapshot checksum fails, free space falls below 20%, or the most recent successful restore drill is older than 30 days.

## Restore drill

The drill never restores over production. It creates a uniquely named Compose project with scratch PostgreSQL and MinIO volumes, validates the backup manifest before startup, restores the database and both buckets, then asserts:

- every asset row still links to a capture;
- every `assets.status='ready'` row has an object in restored media storage;
- every restored object's SHA-256 equals the database digest.

The trap always removes the scratch containers, network, and volumes. Do not interrupt Docker itself while cleanup is running.

```sh
ENV_FILE=infra/.env.production \
infra/scripts/restore-drill.sh /mnt/kino-backups/daily/20260820T220000Z
```

Record each real run below with the exact snapshot and final output. A script review or syntax check is not a restore drill.

## Drill record

- **2026-08-21** — snapshot `daily/20260821T104705Z` from an isolated production-shaped stack (Compose project `kino-drill`, seeded by the Task 37 uploader with 3 captures over the public HTTP path, worker-produced derivatives, roll closed). `restore-drill.sh` restored into scratch project `kino-restore-20260821104832-1159` and passed: manifest verified, 0 orphan asset rows, **3 captures, 24/24 ready assets verified by SHA-256**. Final output: `restore drill passed: 3 captures, 24 ready assets verified`. The first two runs failed and produced three script fixes now in place: `--wait` on the one-shot `createbucket` container aborted startup; an empty firmware bucket left no directory in the snapshot; and the verification loop's `compose exec` consumed the row stream, silently verifying 1 of 24 assets. The drill now asserts verified count equals the database's ready count, so under-verification fails instead of passing.

## Production recovery

1. Stop the API and worker; keep Caddy in maintenance mode so no writes enter during recovery.
2. Preserve the failed volumes for investigation. Never restore into them in place.
3. Provision clean PostgreSQL and MinIO volumes with the same KINO release and migration set as the snapshot.
4. Verify `SHA256SUMS`, restore PostgreSQL with `pg_restore`, and mirror both object buckets.
5. Run the same relationship and digest assertions as `restore-drill.sh`.
6. Start one worker and the API, verify `/api/healthz` and authenticated `/api/metrics`, then run `npm run test:uploader` with an existing recovery credential.
7. Re-enable traffic only after a guest can read a restored capture and a new capture reaches `ready`.

Database rows and objects are one recovery point. Never combine a newer database with an older media snapshot: ready rows can point at bytes that did not yet exist.
