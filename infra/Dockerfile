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
RUN npm prune --omit=dev
USER node

FROM runtime AS api
CMD ["./node_modules/.bin/tsx", "apps/api/src/main.ts"]

FROM runtime AS worker
# The MP4 render mandates libx264 (GPL). The image uses Debian's ffmpeg —
# corresponding source is Debian's (see THIRD_PARTY_NOTICES.md) — and drops
# the ffmpeg-static/ffprobe-static download binaries so this image never
# distributes an npm-fetched GPL build (issue #22). With FFMPEG_PATH set the
# worker never imports ffmpeg-static at all.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf node_modules/ffmpeg-static node_modules/ffprobe-static
USER node
ENV FFMPEG_PATH=/usr/bin/ffmpeg
CMD ["./node_modules/.bin/tsx", "apps/worker/src/main.ts"]

