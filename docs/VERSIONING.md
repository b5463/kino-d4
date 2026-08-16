# KINO versioning

KINO has several compatibility surfaces. They do not move as one number. [`versions.json`](../versions.json) records the current state, and `npm run version:check` rejects drift from source.

## Software packages

Workspace packages use semantic versioning: `MAJOR.MINOR.PATCH`.

- Major: an incompatible public API, file format, deployment contract, or supported workflow.
- Minor: a backward-compatible feature.
- Patch: a backward-compatible fix.

Versions below `1.0.0` are pre-release surfaces. A minor bump may contain a compatibility break, but the changelog and release notes must say so plainly.

Packages version independently. Studio can release without changing API or KDP package versions.

## KDP protocol

The byte-level protocol uses an integer `PROTOCOL_VERSION`. Compatible optional fields, new command IDs, and capability-gated behavior do not bump it. A framing change or incompatible meaning for an existing payload does.

A new protocol version requires an explicit compatibility window in HELLO, reference-device coverage, firmware-contract changes, and tests against the oldest supported peer.

## Portable schemas

Each `kino.*` document owns its own integer version. A change to `kino.capture` does not bump `kino.roll`. Every bump needs a migration from the previous version and a round-trip test that preserves unknown fields.

## Database migrations

Database state is versioned by immutable ordered Drizzle migrations. The latest committed tag is recorded in `versions.json`. Never rename or edit a migration that may have run outside the current worktree.

## Hardware

Hardware carries two identifiers:

1. Physical revision, such as `D4-V1`. This defines electrical, mechanical, harness, and firmware-pin compatibility.
2. Design-package version, such as `0.1.0`. This versions the BOM, wiring, CAD, PCB, assembly, and test source for that physical revision.

Before `1.0.0`, the hardware package is a prototype. Version `1.0.0` requires a locked GPIO map, released mechanical source, released carrier source, and a passed physical acceptance record.

Every hardware design change needs a numbered ECN under `hardware/changes/`. The ECN records evidence, compatibility, affected units, and the required version bump.

## Tags

| Surface | Tag form | Example |
|---|---|---|
| Workspace snapshot | `kino-v<VERSION>` | `kino-v0.1.0` |
| Studio | `kino-studio-v<VERSION>` | `kino-studio-v0.9.0` |
| API | `kino-api-v<VERSION>` | `kino-api-v0.1.0` |
| KDP package | `kino-kdp-v<VERSION>` | `kino-kdp-v0.1.0` |
| Schemas package | `kino-schemas-v<VERSION>` | `kino-schemas-v0.1.0` |
| D4 hardware package | `kino-d4-hw-v<VERSION>` | `kino-d4-hw-v0.1.0` |

Tags are annotated and point to the commit containing the matching manifests and changelogs. A tag does not replace a GitHub release or its checksums.

## Change sequence

1. Write the code change or hardware ECN.
2. Update the owning source version.
3. Update `versions.json` and the relevant changelog.
4. Update compatibility documentation.
5. Run `npm run version:check`, tests, lint, and build.
6. Tag only the reviewed release commit.
