# Developing KINO

## Requirements

- Node.js 22 or newer
- npm with workspace support
- Chrome, Edge, or another Chromium browser for physical Web Serial work
- Docker with Compose for API integration tests
- A KINO D4 or the mock device for device flows
- ffmpeg built with libx264, for worker MP4 renders. Optional: `ffmpeg-static` is
  the fallback. See [Worker renders](#worker-renders).

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
npm run version:check
npm run license:check
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

## Run the Roll stack

Each dev entry (`src/dev.ts`) loads `infra/.env` if present and defaults `NODE_ENV` to `development`; no shell environment setup is needed on a clean checkout.

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run dev -w @kino/api        # Roll API on :3000 (PORT overrides)
npm run dev -w @kino/worker     # derivatives: thumbs, wiggle webp/mp4, metadata
npm run dev -w @kino/roll-web   # guest app on :5173, /api proxied to :3000
npm run dev -w @kino/twin       # twin on :5174, /api proxied to :3000
npm run dev -w @kino/studio     # studio on :5175, /api proxied to :3000
```

Built bundles: `npm run preview:all` serves `apps/studio/dist` and `apps/twin/dist` on :4400 and proxies `/api` to :3000 (`KINO_API_URL` overrides). Load and liveness tooling: `npm run party:sim` (see `docs/roll/ROLL_PARTY_LOAD_TEST.md` — mind the 60/min device rate limit) and `npm run test:uploader`. The full Twin→Roll walkthrough is `docs/roll/ROLL_TWIN_INTEGRATION.md`.

Stop the services and keep data:

```bash
docker compose -f infra/docker-compose.dev.yml down
```

Adding `-v` deletes the local PostgreSQL and MinIO volumes. Use it only for an intentional reset.

## Environment

Copy `infra/.env.example` to `infra/.env` only when the defaults need to change. Existing process variables take precedence.

`COOKIE_SECRET` has a published local default. Configuration accepts that value only when `NODE_ENV` is exactly `development` or `test`. Production must set a real secret and an explicit environment. The `dev` scripts run `src/dev.ts`, which reads `infra/.env` and sets `NODE_ENV=development` when unset; `src/main.ts` (production) reads only real environment variables.

## Worker renders

`render-wiggle-mp4` shells out to ffmpeg with `-c:v libx264`. The worker resolves
the binary from the environment first and falls back to the bundled build:

| Variable | Used by | Fallback |
|---|---|---|
| `FFMPEG_PATH` | `@kino/worker` renders | `ffmpeg-static` |
| `FFPROBE_PATH` | `@kino/worker` tests only | `ffprobe-static` |

Set neither and a plain `npm install` gives working renders with no setup, which
is the local default. Set both when the machine already has ffmpeg tools, or when
the deployment needs a build it chose itself — libx264 is GPL, so an operator who
distributes the worker carries that obligation over the binary they ship.

`ffmpeg-static` and `ffprobe-static` download their binaries in a postinstall
script. On a host with no egress to those downloads, set the two variables and
install with:

```bash
npm ci --ignore-scripts
```

Both variables are read at render time, so a blank value falls back to the bundled
build rather than failing.

## Protocol changes

Change a KDP behavior in this order:

1. Update command IDs or flags in `packages/kdp/src/protocol/commands.ts`.
2. Update wire types in `packages/kdp/src/protocol/types.ts`.
3. Update the client and transports.
4. Update `MockKinoDevice` and fixtures.
5. Add packet, decoder, client, or job tests.
6. Update `firmware-contract/` and record any deviation from the product spec.
7. Update Studio consumers.

Do not assign a command value from an empty-looking range without checking the full enum. Do not reuse a portable document field name merely because the same concept has a similar KDP field. A new command id must also land in `firmware/components/kdp_core/include/kdp/protocol.h` — `npm run version:check` diffs every command and event name/value between `commands.ts` and `protocol.h`, plus the protocol version itself.

## Firmware

The D4 firmware lives in `firmware/` (build, flash, and layout details in [`firmware/README.md`](../firmware/README.md)). Building needs no local ESP-IDF install; *flashing* does (the container cannot reach the serial port on Windows/macOS):

```bash
# Protocol-core host tests (plain gcc + make; on Windows run inside WSL)
make -C firmware/components/kdp_core/host_tests test

# Device builds (canonical environment; CI uses the same image).
# "$PWD" works in bash and PowerShell 7; Windows PowerShell 5.1: use ${PWD}.
docker run --rm -v "$PWD:/project" -w /project/firmware/p4      espressif/idf:v5.5.1 idf.py build
docker run --rm -v "$PWD:/project" -w /project/firmware/camnode espressif/idf:v5.5.1 idf.py build
```

Studio's FIRMWARE BUILDER drives the same steps through `npm run firmware:daemon` (see [`docs/FIRMWARE_BUILDER.md`](FIRMWARE_BUILDER.md)); the daemon's port is `KINO_FWD_PORT`, mirrored to Studio with `VITE_KINO_FWD_URL`, and on Windows `KINO_FWD_WSL_DISTRO` pins which WSL distro runs the host tests.

Firmware behavior implements [`firmware-contract/`](../firmware-contract/README.md); pin assumptions live only in the two board headers and stay provisional until the bench record in `firmware/HARDWARE_VALIDATION.md` proves them.

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

## Version and license checks

[`versions.json`](../versions.json) records package, protocol, portable-schema, database, and hardware versions. The checker reads the owning source and fails on drift:

```bash
npm run version:check
```

Licenses are path-scoped through [`REUSE.toml`](../REUSE.toml). Software packages declare MIT. Physical hardware source declares CERN-OHL-S-2.0. Reserved visual assets stay outside both grants.

```bash
npm run license:check
```

Do not edit a license text, move a file across license boundaries, or change a public version without updating the corresponding manifest and policy document.

## Generated knowledge graph

Graphify output is local and gitignored. Rebuild it after source or documentation changes:

```bash
graphify update . --force
```

Claude project instructions require `graphify query`, `graphify path`, or `graphify explain` before broad code searches when the graph exists.

## Documentation changes

Read [the documentation map](README.md) before editing specifications. Preserve the authority order. Label hardware dimensions by source confidence. Separate current implementation from intended product behavior.

Write the way the device is built: name the part, state what it does, include the unit, and say what remains unknown.
