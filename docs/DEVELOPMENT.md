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

These workspaces do not need Docker. The test line is the one `.github/workflows/ci.yml` runs in its `build-test` job; keep the two identical, and add a new workspace to both.

```bash
npm run lint
npm run version:check
npm run license:check
npm run test -w @kino/studio -w @kino/kdp -w @kino/schemas -w @kino/test-fixtures -w @kino/hardware-profiles -w @kino/simulator-engine -w @kino/three-assets -w @kino/twin -w @kino/design-system -w @kino/media -w @kino/roll-web
npm run build
```

Root `npm run build` uses `--if-present`. Only browser applications currently produce a bundle.

## API stack

Start PostgreSQL, Redis, and MinIO. The worker suite needs the same three services and the same migrated database, so it belongs here rather than above:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api -w @kino/worker
```

| Service | Host port | Purpose |
|---|---:|---|
| PostgreSQL | 5435 | Metadata and state |
| Redis | 6380 | Streams, publish/subscribe, viewer presence |
| MinIO S3 API | 9000 | Media and firmware objects |
| MinIO console | 9001 | Local storage inspection |

The Compose stack creates `kino-media` and `kino-firmware`. Development defaults live in `apps/api/src/config.ts` and match `infra/.env.example`.

## Run the Roll stack

One command starts everything in a single terminal — infra services, migration, then api, worker, roll-web, twin and studio with prefixed output:

```bash
npm run dev:all                # add --daemon for the firmware builder, --only api,twin to narrow
```

Ctrl+C stops the dev servers; the docker services stay up. The pieces individually (each dev entry `src/dev.ts` loads `infra/.env` if present and defaults `NODE_ENV` to `development`; no shell environment setup is needed on a clean checkout):

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run dev -w @kino/api        # Roll API on :3000 (PORT overrides)
npm run dev -w @kino/worker     # derivatives: thumbs, wiggle webp/mp4, metadata
npm run dev -w @kino/roll-web   # guest app on :5173, /api proxied to :3000
npm run dev -w @kino/twin       # twin on :5174, /api proxied to :3000
npm run dev -w @kino/studio     # studio on :5175, /api proxied to :3000
```

Built bundles: `npm run preview:all` serves `apps/studio/dist` and `apps/twin/dist` on :4400 and proxies `/api` to :3000 (`KINO_API_URL` overrides). It binds `127.0.0.1`; to open it from a phone on the same network, set `HOST=0.0.0.0` — that also exposes the proxied API, so do it on a network you trust. Load and liveness tooling: `npm run party:sim` (see `docs/roll/ROLL_PARTY_LOAD_TEST.md` — the device upload budget is 120/minute **per route**, 5 calls per capture, so 24 captures a minute) and `npm run test:uploader`. The full Twin→Roll walkthrough is `docs/roll/ROLL_TWIN_INTEGRATION.md`.

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

## Tests, and two ways two runs destroy each other

`npm test` runs every workspace suite. Two of them are not safe to run twice at once on one machine.

**The API database suite takes a fixed database name.** `apps/api/tests/db.test.ts` uses `kino_test` and starts with `drop database ... with (force)`, which terminates whatever is connected — so a second run kills the first run's connections mid-suite and both report failures that have nothing to do with the code. `apps/api/tests/auth.test.ts` shows the fix: it namespaces its database with `randomBytes(4)`. Until the db suite does the same, run one at a time, or point the second run at its own Postgres.

**The acceptance walk serves a build.** `playwright.config.ts` starts `npm run preview:all` on port 4401. `reuseExistingServer` is now `false`, so a second run fails immediately on the busy port instead of silently driving the first checkout's `dist/` and reporting a pass that belongs to neither tree. Run `npm run build` first; the spec drives real KDP against the current build.

`apps/prusa-print-98`'s `test` script is `python -m unittest discover`, so a bare root `npm test` needs Python on PATH.

## Searching the firmware tree

Stale ESP-IDF build trees sit under `firmware/p4/` (`build/`, `build-428/`, `build-428-radio/`, `build-1471/`, `build-1471-radio/`). They are gitignored and untracked, but they hold `.elf`, `.a` and `.obj` files in which every KDP command name survives as a debug symbol — so an unfiltered `grep` for a command name returns a floor of about 25 hits and an unimplemented command reads as implemented.

Scope every search to source:

```bash
grep -rn --include=*.c --include=*.h STORAGE_BENCH firmware/
```

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

# Bench tool: makes one XIAO a USB webcam so a camera module can be checked
# before any harness exists (firmware/uvc-preview/README.md).
docker run --rm -v "$PWD:/project" -w /project/firmware/uvc-preview espressif/idf:v5.5.1 idf.py build
```

Studio's FIRMWARE BUILDER drives the same steps through `npm run firmware:daemon` (see [`docs/FIRMWARE_BUILDER.md`](FIRMWARE_BUILDER.md)); the daemon's port is `KINO_FWD_PORT`, mirrored to Studio with `VITE_KINO_FWD_URL`, and on Windows `KINO_FWD_WSL_DISTRO` pins which WSL distro runs the host tests.

Firmware behavior implements [`firmware-contract/`](../firmware-contract/README.md); pin assumptions live only in the two board headers and stay provisional until the bench record in `firmware/HARDWARE_VALIDATION.md` proves them.

## Bench tools

Six tools under `scripts/`, each with a root npm script. Most talk KDP over a serial port from a terminal, on the framing and protocol client `packages/kdp` gives Studio — no browser, no Web Serial, no clicking. `KINO_PORT` is the fallback for `--port`.

| Script | Tool | What it is for |
|---|---|---|
| `npm run bench` | `scripts/kino-bench.mjs` | Send any JSON-bodied command; `--sanity` runs the ordered link check |
| `npm run bench:conformance` | `scripts/kino-conformance.mjs` | The 32-case protocol conformance suite against real hardware |
| `npm run bench:console` | `scripts/kino-console.mjs` | Plain serial console for a camera node's ESP_LOG boot text (nodes do not speak KDP) |
| `npm run bench:pull` | `scripts/kino-pull.mjs` | Pull one file out of a capture over `MEDIA_READ` so you can look at the pixels |
| `npm run bench:sound` | `scripts/kino-sound-bench.mjs` | Custom-sound upload/read/delete — `SOUND_CHUNK` has a binary body `bench` cannot send |
| `npm run bench:skew` | `scripts/skew-stats.mjs` | Inter-camera **exposure**-skew statistics from hand-entered CSV (M2 measurement) |

Opening a node's own port reboots that node, so `bench:console` is a bring-up instrument, not a monitor for a running rig — diagnose a live camera through the P4 instead.

`bench:skew` is arithmetic only, and deliberately so: its input is a human reading a photographed millisecond timing reference. Never feed it `dispatchSpreadUs`, which measures when the P4 put four commands on four UARTs and has no established relationship to when light reached a sensor.

```bash
# One command, or the ordered link check (§7 of the M1 runbook).
npm run bench -- --port COM8 GET_DEVICE_INFO
npm run bench -- --port COM8 --sanity

# A node's boot log: sensor model, PID, SCCB address, PSRAM, READY.
npm run bench:console -- --port COM6 --seconds 20

# One frame off the card, to tell a corrupt frame from one rendered wrongly.
npm run bench:pull -- --port COM8 --id <uuid> --file C1.JPG --out shot.jpg

# Custom sounds. `-` in place of a file generates a 300 ms 880 Hz sine.
npm run bench:sound -- --port COM8 list
npm run bench:sound -- --port COM8 upload - snd-tone "880 Hz"

# Exposure skew, max(cameras) - min(cameras) per capture, in ms.
npm run bench:skew -- measurements.csv

# The 32-case protocol conformance suite — the same cases Studio's DEVELOPER
# panel runs, imported rather than reimplemented. 8 of the 32 are ACTIVE: they
# take real photographs, write config, and enter maintenance. Firmware and
# serial are printed at the top so a pasted run identifies itself.
npm run bench:conformance -- --port COM8
npm run bench:conformance -- --port COM8 --passive          # read-only 24
npm run bench:conformance -- --port COM8 --json bench.json  # machine record
```

Exit status is 0 only when every reported case is `pass` or `skipped`, so the run belongs in a bench record verbatim. Per-command timeouts are the protocol client's; `--timeout` is a watchdog over the whole run.

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
