#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-infra/.env.production}"
BACKUP_ROOT="${BACKUP_ROOT:-}"

die() { printf 'backup: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "environment file not found: $ENV_FILE"
[[ -n "$BACKUP_ROOT" ]] || die 'set BACKUP_ROOT to an absolute off-host mount'
[[ "$BACKUP_ROOT" = /* && "$BACKUP_ROOT" != / ]] || die 'BACKUP_ROOT must be an absolute path other than /'

mkdir -p -- "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"
BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd -P)"
[[ "$BACKUP_ROOT" != / && ${#BACKUP_ROOT} -gt 5 ]] || die 'resolved BACKUP_ROOT is too broad'

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
week="$(date -u +%G-W%V)"
partial="$BACKUP_ROOT/daily/$stamp.partial"
destination="$BACKUP_ROOT/daily/$stamp"
[[ ! -e "$partial" && ! -e "$destination" ]] || die "backup already exists: $stamp"

cleanup() {
  case "$partial" in
    "$BACKUP_ROOT"/daily/*.partial) [[ ! -e "$partial" ]] || rm -rf -- "$partial" ;;
    *) printf 'backup: refused unsafe cleanup target %s\n' "$partial" >&2 ;;
  esac
}
trap cleanup ERR INT TERM
mkdir -p -- "$partial/objects"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose exec -T postgres sh -eu -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial/postgres.dump"

compose run --rm --no-deps \
  -v "$partial/objects:/backup" \
  --entrypoint /bin/sh createbucket -eu -c '
    mc alias set source http://object-storage:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
    # An empty bucket is a valid state; the snapshot must still contain its directory.
    mkdir -p /backup/"$S3_BUCKET" /backup/"$S3_FIRMWARE_BUCKET"
    mc mirror --overwrite source/"$S3_BUCKET" /backup/"$S3_BUCKET"
    mc mirror --overwrite source/"$S3_FIRMWARE_BUCKET" /backup/"$S3_FIRMWARE_BUCKET"
  '

printf 'created_at=%s\ncompose_file=%s\nenvironment_file=%s\n' \
  "$stamp" "$COMPOSE_FILE" "$ENV_FILE" > "$partial/BACKUP_INFO"
(
  cd "$partial"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

mv -- "$partial" "$destination"
trap - ERR INT TERM

weekly="$BACKUP_ROOT/weekly/$week"
if [[ ! -e "$weekly" ]]; then
  cp -al -- "$destination" "$weekly" 2>/dev/null || cp -a -- "$destination" "$weekly"
fi

prune_after() {
  local root="$1" keep="$2" candidate
  mapfile -t candidates < <(find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
  for candidate in "${candidates[@]:$keep}"; do
    case "$root/$candidate" in
      "$BACKUP_ROOT"/daily/*|"$BACKUP_ROOT"/weekly/*) rm -rf -- "$root/$candidate" ;;
      *) die "refused unsafe retention target: $root/$candidate" ;;
    esac
  done
}

prune_after "$BACKUP_ROOT/daily" 14
prune_after "$BACKUP_ROOT/weekly" 8
printf 'backup complete: %s\n' "$destination"
