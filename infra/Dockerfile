FROM node:24-bookworm-slim AS source
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./
RUN npm ci

FROM source AS web-build
RUN npm run build --workspace @kino/studio \
 && npm run build --workspace @kino/roll-web

FROM caddy:2.10.2-alpine AS web
COPY infra/Caddyfile.web /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/roll-web/dist /srv
COPY --from=web-build /app/apps/studio/dist /srv/studio

FROM source AS runtime
ENV NODE_ENV=production
# The MP4 render mandates libx264 (GPL). No image built from this Dockerfile may
# ship the ffmpeg-static/ffprobe-static download binaries — an npm-fetched GPL
# build this project would then be distributing (issue #22) — so they are dropped
# in the SHARED stage, before anything branches.
#
# It used to be done only in the `worker` stage, which left them in the `api`
# image: `npm ci` installs the whole workspace, so both targets carry the
# worker's dependencies whether they run them or not. The api target never
# invokes ffmpeg, so nobody would ever have noticed by using the image.
#
# Deleting them here rather than twice is also what keeps that true for any
# target added later: a new stage inherits the removal instead of having to
# remember it.
RUN npm prune --omit=dev \
 && rm -rf node_modules/ffmpeg-static node_modules/ffprobe-static
USER node

FROM runtime AS api
CMD ["./node_modules/.bin/tsx", "apps/api/src/main.ts"]

FROM runtime AS worker
# The MP4 render mandates libx264 (GPL). This image uses Debian's ffmpeg —
# corresponding source is Debian's (see THIRD_PARTY_NOTICES.md) — and the
# npm-fetched static builds are already gone from the shared `runtime` stage
# above. With FFMPEG_PATH set the worker never imports ffmpeg-static at all.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
USER node
ENV FFMPEG_PATH=/usr/bin/ffmpeg
CMD ["./node_modules/.bin/tsx", "apps/worker/src/main.ts"]

