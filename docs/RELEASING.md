# Releasing KINO

KINO has no published release pipeline yet. This checklist defines the first safe one. Do not describe a local build as a release.

[`versions.json`](../versions.json) is the machine-readable release index. [`VERSIONING.md`](VERSIONING.md) defines bump and tag rules.

## Versions that move independently

| Surface | Current value | Authority |
|---|---:|---|
| Repository workspace | `0.1.0` | root `package.json` |
| KINO Studio | `0.9.0` | `apps/studio/package.json` |
| KDP protocol | `1` | `PROTOCOL_VERSION` in `packages/kdp/src/protocol/commands.ts` |
| KDP config envelope | `1` | `CONFIG_SCHEMA_VERSION` in `packages/kdp/src/protocol/types.ts` |
| Portable documents | `1` per schema | `packages/schemas/src/` |
| Physical firmware | no repository release | firmware implementation repository or future workspace |

A Studio release does not automatically bump KDP. A schema bump does not automatically bump the protocol. Change the smallest surface that matches the compatibility change.

## Before cutting a version

1. Start from a clean worktree at the intended commit.
2. Read [`CHANGELOG.md`](../CHANGELOG.md) and remove claims that are not present in source.
3. Confirm [`ROADMAP.md`](../ROADMAP.md) and the README build-status note still match reality.
4. Review protocol and schema compatibility.
5. Review database migrations and rollback consequences.
6. Build with the lockfile and Node.js 22.

```bash
npm ci
npm run version:check
npm run license:check
npm run lint
npm run test -w @kino/studio -w @kino/kdp -w @kino/schemas -w @kino/test-fixtures
npm run build
```

Run the API suite against clean services:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api
```

## Compatibility review

For every KDP change, confirm:

- numeric command and event values are unchanged unless the protocol version moves;
- optional additions have capability flags where behavior needs gating;
- the reference device and firmware contract match source;
- Studio handles older capabilities and explicit `UNSUPPORTED_COMMAND` replies;
- reconnect and boot-session behavior has a test.

For every portable schema change, confirm the version bump, stepwise migration, unknown-field preservation, and round-trip tests.

For every database change, confirm the migration and snapshot are committed. State whether downgrade is safe. Never rewrite a migration that may already exist in a deployed database.

For every hardware change, confirm there is a numbered ECN, the design-package version moved, `hardware/manifest.json` matches `versions.json`, and the D4 revision record still describes physical compatibility.

## Release artifacts

A Studio release should contain:

- the production output from `apps/studio/dist/`;
- the source commit identifier;
- the Node.js and npm versions used;
- a checksum file produced from the final artifacts;
- release notes taken from the matching changelog section.

A firmware release should also contain a manifest, target identifiers, size, SHA-256 digest, minimum compatible Studio and protocol versions, and recovery instructions. The current updater checks hashes. No signing pipeline exists, so do not call an artifact signed or trusted by hardware.

## Publish

1. Update package versions that belong to the release.
2. Update `versions.json`, package-lock metadata, and the owning manifest.
3. Move Unreleased changelog entries into a dated version section.
4. Run the complete checks again after the version edits.
5. Commit the release state.
6. Create the annotated tag defined in [`VERSIONING.md`](VERSIONING.md).
7. Build artifacts from the tagged source.
8. Publish a GitHub release with checksums, compatibility notes, known gaps, and recovery steps.
9. Start a fresh Unreleased section.

## After release

- Install the published Studio bundle in a clean browser profile.
- Exercise the demo device and one physical camera if hardware support is claimed.
- Verify the API health route and a complete upload against the target environment.
- Confirm links, downloads, checksums, and release notes from a separate machine.
- Record urgent fixes in the changelog before preparing a patch release.
