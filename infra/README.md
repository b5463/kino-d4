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

## Production

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

## Verification

Validate interpolation without starting services:

```sh
docker compose --env-file infra/.env.prod.example -f infra/docker-compose.prod.yml config --quiet
```

After startup, verify `https://<host>/api/healthz`, `/`, and `/studio/`. The complete upload-to-gallery staging exercise is automated by the Task 37 test uploader.

## Media licensing

The worker image currently includes the repository's `ffmpeg-static` dependency. Do not distribute that image publicly until the FFmpeg/GPL distribution decision tracked in GitHub issue #22 is resolved.
