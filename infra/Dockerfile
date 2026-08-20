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
CMD ["./node_modules/.bin/tsx", "apps/worker/src/main.ts"]

