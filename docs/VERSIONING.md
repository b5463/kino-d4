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

## Firmware

The D4 firmware (`firmware/`) carries one semantic version in `firmware/VERSION`, shared by the P4 and camera-node images — the nodes run the same binary and a release ships both targets together in one `kino.firmware-manifest`. Before `1.0.0` the firmware is pre-release; a release additionally requires the bench record in `firmware/HARDWARE_VALIDATION.md` to back what the images claim to support.

**A firmware bump touches four files, and `npm run version:check` fails on any one of them:**

| File | What the check asserts |
|---|---|
| `firmware/VERSION` | The version itself, and that it is semver |
| `versions.json` (`firmware.version`) | Equal to `firmware/VERSION` |
| `firmware/components/kdp_core/include/kdp/protocol.h` | `KDP_PROTOCOL_VERSION` matches `versions.json`, and every `KDP_CMD_*`/`KDP_EVT_*` name and value matches `packages/kdp/src/protocol/commands.ts` in both directions |
| `packages/test-fixtures/src/firmwareProfiles.ts` | `PROFILE_FOR_VERSION` has an entry for the new version. The Twin emulates "current firmware" through that map, so a bump without an entry silently makes the Twin model an older device (#90) |

The fourth is the one that surprises people: the change sequence below has no step that names it, and `version:check` reports it at step 5 as `PROFILE_FOR_VERSION has no entry for firmware <x.y.z>`. A release that adds no KDP command and no capability maps onto the existing profile — see [`TWIN_FIRMWARE_MODEL.md`](TWIN_FIRMWARE_MODEL.md) for which — so the entry is usually one line.

`npm run version:check -- --firmware` scopes the run to exactly these four plus the protocol records, which is the gate the build daemon uses; unrelated backend drift must not block a firmware build.

## Tags

Every tag form is the `tagPrefix` of an entry in [`versions.json`](../versions.json), which is what `scripts/check-versions.mjs` reads. All sixteen are listed here; do not invent one for a surface that is missing from this table — add it to `versions.json` first.

| Surface | Tag form | Example |
|---|---|---|
| Workspace snapshot | `kino-v<VERSION>` | `kino-v0.1.1` |
| Studio | `kino-studio-v<VERSION>` | `kino-studio-v0.9.1` |
| Twin | `kino-twin-v<VERSION>` | `kino-twin-v0.1.0` |
| API | `kino-api-v<VERSION>` | `kino-api-v0.3.0` |
| Worker | `kino-worker-v<VERSION>` | `kino-worker-v0.2.0` |
| Guest PWA (roll-web) | `kino-roll-web-v<VERSION>` | `kino-roll-web-v0.6.0` |
| KDP package | `kino-kdp-v<VERSION>` | `kino-kdp-v0.2.0` |
| Media package | `kino-media-v<VERSION>` | `kino-media-v0.1.0` |
| Hardware-profiles package | `kino-hardware-profiles-v<VERSION>` | `kino-hardware-profiles-v0.1.1` |
| Schemas package | `kino-schemas-v<VERSION>` | `kino-schemas-v0.2.0` |
| Simulator-engine package | `kino-simulator-engine-v<VERSION>` | `kino-simulator-engine-v0.1.0` |
| Test-fixtures package | `kino-test-fixtures-v<VERSION>` | `kino-test-fixtures-v0.1.0` |
| Three-assets package | `kino-three-assets-v<VERSION>` | `kino-three-assets-v0.1.0` |
| Design-system package | `kino-design-system-v<VERSION>` | `kino-design-system-v0.1.0` |
| D4 firmware | `kino-fw-v<VERSION>` | `kino-fw-v0.4.53` |
| D4 hardware package | `kino-d4-hw-v<VERSION>` | `kino-d4-hw-v0.1.4` |

Tags are annotated and point to the commit containing the matching manifests and changelogs. A tag does not replace a GitHub release or its checksums.

## Change sequence

1. Write the code change or hardware ECN.
2. Update the owning source version — and its `package-lock.json` entry for a workspace package, which `version:check` compares too.
3. Update `versions.json` and the relevant changelog.
4. Update compatibility documentation. On a **firmware** bump this includes `PROFILE_FOR_VERSION` in `packages/test-fixtures/src/firmwareProfiles.ts` — see the four files under [Firmware](#firmware).
5. Run `npm run version:check`, tests, lint, and build.
6. Tag only the reviewed release commit, using the form from the table above.
