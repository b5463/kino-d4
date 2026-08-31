# Contributing to KINO

KINO spans a browser workbench, a binary device protocol, a backend, and unfinished physical hardware. A small change can cross all four. Read the relevant contract before touching code.

## Start with the right source

| Work | Read first |
|---|---|
| Studio behavior | [`PRODUCT.md`](PRODUCT.md) and [`kino_dev_spec_pack/02_KINO_STUDIO_SPEC.md`](kino_dev_spec_pack/02_KINO_STUDIO_SPEC.md) |
| Device protocol | [`firmware-contract/README.md`](firmware-contract/README.md) and `packages/kdp/src/protocol/` |
| Portable documents | `packages/schemas/src/` and [`firmware-contract/schemas.md`](firmware-contract/schemas.md) |
| API and Roll | [`apps/api/README.md`](apps/api/README.md) and `kino_dev_spec_pack/` |
| D4 hardware | [`docs/HARDWARE.md`](docs/HARDWARE.md) and [`hardware/README.md`](hardware/README.md) |
| Documentation authority | [`docs/README.md`](docs/README.md) |

Tested protocol and schema source wins when old plans disagree with current behavior. Historical plans explain how a decision was reached. They do not redefine shipped code.

## Set up the workspace

KINO requires Node.js 22 or newer.

```bash
npm ci
npm run version:check
npm run license:check
npm run lint
npm run test -w @kino/studio -w @kino/kdp -w @kino/schemas -w @kino/test-fixtures -w @kino/hardware-profiles -w @kino/simulator-engine -w @kino/three-assets -w @kino/twin -w @kino/design-system -w @kino/media -w @kino/roll-web
npm run build
```

That test line is every workspace whose suite runs without Docker, and it is the same line `.github/workflows/ci.yml` runs. A new workspace goes in both.

The API and worker tests need PostgreSQL, Redis, and MinIO:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api -w @kino/worker
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for ports, environment variables, and safe teardown.

## Use the project board

[KINO D4 project #3](https://github.com/users/b5463/projects/3) is the execution queue. [`ROADMAP.md`](ROADMAP.md) records direction; the board records work that is ready to plan, build, test, or validate.

Before starting, read the issue, check its target and acceptance checks, assign it, and move it to `In Progress`. Link the pull request to the issue. After the checks and documentation are complete, close the issue and move the project item to `Done`.

```bash
npm run project -- list
npm run project -- start 3
npm run project -- done 3
```

See [`docs/PROJECT.md`](docs/PROJECT.md) for fields, views, priorities, and adding new issues.

## Keep changes narrow

One pull request should have one job. Protocol work may require coordinated edits across several packages, but an unrelated UI cleanup belongs elsewhere. Leave user changes in the worktree alone.

Generated build output, local environment files, Graphify output, and captured test data stay out of commits unless a maintained document explicitly calls for the asset.

## Changing KDP

A protocol change is complete when all affected layers agree:

1. Update numeric values or flags in `packages/kdp/src/protocol/commands.ts`.
2. Update wire types in `packages/kdp/src/protocol/types.ts`.
3. Update the client or transport.
4. Update `MockKinoDevice` and its failure scenarios.
5. Add packet, decoder, client, or job tests.
6. Update `firmware-contract/`.
7. Update Studio consumers and capability checks.

Never reuse a command value because a range looks empty. Search the full enum. Compatible additions use optional fields and capability flags. Breaking framing or payload semantics require an explicit protocol-version decision.

## Changing portable schemas

Every `kino.*` document has its own version. Bump that version only for its document family, add a stepwise migration, preserve unknown fields, and add round-trip tests.

Wire payloads and portable documents may name the same idea differently. `recipe` belongs to KDP wire payloads. `look` belongs to `kino.capture`. Check the schema instead of guessing.

## Changing hardware records

Hardware claims carry a confidence label. Use the labels defined in [`docs/HARDWARE.md`](docs/HARDWARE.md):

- `MEASURED`
- `OFFICIAL_CAD`
- `OFFICIAL_SPEC`
- `SELLER_SPEC`
- `PROVISIONAL`
- `CONFLICT`

Record the tool, date, part, and conditions for a new measurement. Keep conflicting source values visible until the physical part settles the question. Final GPIO assignments remain unknown until hardware validation; do not turn `GPIO_TBD` into a plausible-looking pin number.

Update [`hardware/BOM.csv`](hardware/BOM.csv) when a part or quantity changes. Update wiring and assembly notes when the physical build order changes.

Every hardware design change also needs a numbered ECN under `hardware/changes/`, a design-package version decision, and matching updates to `hardware/manifest.json`, `versions.json`, and `hardware/CHANGELOG.md`.

## Versions and licenses

Read [`docs/VERSIONING.md`](docs/VERSIONING.md) before changing a package, protocol, schema, migration, hardware revision, or design-package version. Run `npm run version:check` before committing.

[`REUSE.toml`](REUSE.toml) assigns MIT to software and CERN-OHL-S-2.0 to hardware source. Brand assets, product media, and the recovery archive are reserved. Do not move a file across these boundaries, modify a license text, or copy a reserved mark into a fork without reviewing [`LICENSE`](LICENSE) and [`TRADEMARKS.md`](TRADEMARKS.md).

## Writing documentation

Name the part. State what it does. Include the unit. Say what remains unknown.

Use KINO D4, KINO Studio, KINO Roll, KINO Twin, and KINO Device Protocol consistently. Avoid launch copy, fake certainty, and assistant-style filler. Public screenshots must come from the real application or physical camera. Label simulator output as simulated.

## Pull requests

Before opening a pull request:

- run the checks relevant to the change;
- update contracts and maintained guides;
- include hardware photos or measurements when the physical build changed;
- describe what was tested and what was not;
- call out protocol, schema, migration, and hardware compatibility risks;
- rebuild the local knowledge graph with `graphify update . --force` if Graphify is installed.

Use the pull request template. A reviewer should be able to reproduce the result without reconstructing your bench from chat history.
