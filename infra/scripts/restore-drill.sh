#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-infra/.env.production}"
BACKUP_DIR="${1:-}"

die() { printf 'restore drill: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'
[[ -n "$BACKUP_DIR" ]] || die 'usage: restore-drill.sh /absolute/path/to/backup'
[[ "$BACKUP_DIR" = /* ]] || die 'backup path must be absolute'
[[ -d "$BACKUP_DIR/objects" && -f "$BACKUP_DIR/postgres.dump" ]] || die 'backup is incomplete'
[[ -f "$BACKUP_DIR/SHA256SUMS" ]] || die 'backup checksum manifest is missing'
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd -P)"
[[ -f "$COMPOSE_FILE" && -f "$ENV_FILE" ]] || die 'compose or environment file is missing'

(
  cd "$BACKUP_DIR"
  sha256sum -c SHA256SUMS
)

project="kino-restore-$(date -u +%Y%m%d%H%M%S)-$$"
compose() {
  docker compose -p "$project" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# --wait treats a cleanly exited one-shot as a failure, so run createbucket in the foreground.
compose up -d --wait postgres object-storage
compose run --rm --no-deps createbucket

compose exec -T postgres sh -eu -c \
  'pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$BACKUP_DIR/postgres.dump"

compose run --rm --no-deps \
  -v "$BACKUP_DIR/objects:/backup:ro" \
  --entrypoint /bin/sh createbucket -eu -c '
    mc alias set restored http://object-storage:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
    mc mirror --overwrite /backup/"$S3_BUCKET" restored/"$S3_BUCKET"
    mc mirror --overwrite /backup/"$S3_FIRMWARE_BUCKET" restored/"$S3_FIRMWARE_BUCKET"
  '

orphan_count="$(compose exec -T postgres sh -eu -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from assets a left join captures c on c.id=a.capture_id where c.id is null"' \
  | tr -d '\r')"
[[ "$orphan_count" = 0 ]] || die "$orphan_count asset rows do not relink to captures"

compose exec -T object-storage sh -eu -c \
  'mc alias set restored http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'

verified=0
while IFS=$'\t' read -r object_key expected_sha; do
  [[ -n "$object_key" && -n "$expected_sha" ]] || die 'a ready asset lacks object_key or sha256'
  # </dev/null: without it, exec consumes the loop's stdin and the loop ends after one row.
  actual_sha="$(
    compose exec -T object-storage sh -eu -c 'mc cat "restored/$S3_BUCKET/$1"' _ "$object_key" </dev/null \
      | sha256sum | cut -d ' ' -f 1 | tr -d '\r'
  )"
  [[ "$actual_sha" = "$expected_sha" ]] || die "sha256 mismatch: $object_key"
  verified=$((verified + 1))
done < <(
  compose exec -T postgres sh -eu -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "$(printf "\t")" -c "select object_key, sha256 from assets where status='"'"'ready'"'"' order by object_key"'
)

ready_count="$(compose exec -T postgres sh -eu -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from assets where status='"'"'ready'"'"'"' | tr -d '\r')"
[[ "$verified" = "$ready_count" ]] || die "verified only $verified of $ready_count ready assets"

capture_count="$(compose exec -T postgres sh -eu -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from captures"' | tr -d '\r')"
printf 'restore drill passed: %s captures, %s ready assets verified; scratch project %s removed\n' \
  "$capture_count" "$verified" "$project"
