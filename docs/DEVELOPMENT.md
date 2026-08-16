# Developing KINO

## Requirements

- Node.js 22 or newer
- npm with workspace support
- Chrome, Edge, or another Chromium browser for physical Web Serial work
- Docker with Compose for API integration tests
- A KINO D4 or the mock device for device flows

Install the workspace exactly from the lockfile:

```bash
npm ci
```

## Studio

Start the browser workbench:

```bash
npm run dev -w @kino/studio
```

Build and test it:

```bash
npm run lint -w @kino/studio
npm run test -w @kino/studio
npm run build -w @kino/studio
```

Web Serial needs a secure browser context. `localhost` qualifies. A deployed Studio needs HTTPS. Unsupported browsers should show a direct explanation instead of a dead Connect button.

## Service-free checks

These workspaces do not need Docker:

```bash
npm run lint
npm run test -w @kino/studio -w @kino/kdp -w @kino/schemas -w @kino/test-fixtures
npm run build
```

Root `npm run build` uses `--if-present`. Only browser applications currently produce a bundle.

## API stack

Start PostgreSQL, Redis, and MinIO:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api
```

| Service | Host port | Purpose |
|---|---:|---|
| PostgreSQL | 5435 | Metadata and state |
| Redis | 6380 | Streams, publish/subscribe, viewer presence |
| MinIO S3 API | 9000 | Media and firmware objects |
| MinIO console | 9001 | Local storage inspection |

The Compose stack creates `kino-media` and `kino-firmware`. Development defaults live in `apps/api/src/config.ts` and match `infra/.env.example`.

There is no API development server script yet. `buildServer()` returns an unbound Fastify instance for tests. Do not document an `npm run dev -w @kino/api` command until a real entry point exists.

Stop the services and keep data:

```bash
docker compose -f infra/docker-compose.dev.yml down
```

Adding `-v` deletes the local PostgreSQL and MinIO volumes. Use it only for an intentional reset.

## Environment

Copy `infra/.env.example` to `infra/.env` only when the defaults need to change. Existing process variables take precedence.

`COOKIE_SECRET` has a published local default. Configuration accepts that value only when `NODE_ENV` is exactly `development` or `test`. Production must set a real secret and an explicit environment.

## Protocol changes

Change a KDP behavior in this order:

1. Update command IDs or flags in `packages/kdp/src/protocol/commands.ts`.
2. Update wire types in `packages/kdp/src/protocol/types.ts`.
3. Update the client and transports.
4. Update `MockKinoDevice` and fixtures.
5. Add packet, decoder, client, or job tests.
6. Update `firmware-contract/` and record any deviation from the product spec.
7. Update Studio consumers.

Do not assign a command value from an empty-looking range without checking the full enum. Do not reuse a portable document field name merely because the same concept has a similar KDP field.

## Schema changes

Portable documents use independent versions and stepwise migrations. Parsers preserve unknown fields so an older Studio can read, modify, and write a newer device document without stripping data.

Database changes need a committed Drizzle migration and its metadata snapshot:

```bash
cd apps/api
npx drizzle-kit generate --name <change>
cd ../..
npm run db:migrate -w @kino/api
```

Do not rename existing migration numbers. Their journal indices already carry the repository's numbering choice.

## Generated knowledge graph

Graphify output is local and gitignored. Rebuild it after source or documentation changes:

```bash
graphify update . --force
```

Claude project instructions require `graphify query`, `graphify path`, or `graphify explain` before broad code searches when the graph exists.

## Documentation changes

Read [the documentation map](README.md) before editing specifications. Preserve the authority order. Label hardware dimensions by source confidence. Separate current implementation from intended product behavior.

Write the way the device is built: name the part, state what it does, include the unit, and say what remains unknown.
