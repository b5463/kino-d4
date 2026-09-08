# Releasing KINO

KINO has no published release pipeline yet. This checklist defines the first safe one. Do not describe a local build as a release.

[`versions.json`](../versions.json) is the machine-readable release index. [`VERSIONING.md`](VERSIONING.md) defines bump and tag rules.

## Versions that move independently

| Surface | Current value | Authority |
|---|---:|---|
| Repository workspace | `0.1.1` | root `package.json` |
| KINO Studio | `0.9.1` | `apps/studio/package.json` |
| KINO Roll API / worker | `0.2.0` | `apps/api/package.json`, `apps/worker/package.json` |
| KINO Roll web | `0.5.0` | `apps/roll-web/package.json` |
| KDP protocol | `1` | `PROTOCOL_VERSION` in `packages/kdp/src/protocol/commands.ts` |
| KDP config envelope | `1` | `CONFIG_SCHEMA_VERSION` in `packages/kdp/src/protocol/types.ts` |
| Portable documents | `1` per schema | `packages/schemas/src/` |
| Physical firmware (P4 and camera node, one image family) | `0.4.43`, bench builds only, no published release | `firmware/VERSION`, checked against `versions.json` |

A Studio release does not automatically bump KDP. A schema bump does not automatically bump the protocol. Change the smallest surface that matches the compatibility change.

## Stop-gates that are not in any script

- **Firmware artwork.** `firmware/p4/main/icons_w98.h` carries Microsoft's
  Windows 98 shell icons under `LicenseRef-Microsoft-Proprietary`
  (`REUSE.toml`, `THIRD_PARTY_NOTICES.md`). Publishing any P4 binary built
  from this tree redistributes them. Issue #134 has to be answered - a licence,
  or original artwork in the same idiom - before a firmware release exists.
  `npm run license:check` proves the mapping is intact; it does not make the
  redistribution lawful. **Operator decision, 2026-09-05:** the project is not
  sold or published; builds are for the owner's own units, and the artwork
  stays. The gate therefore applies only if a binary is ever distributed.
- **Gate U — Roll on the internet.** The backend and web have been proven only
  against a development API on the LAN. `kino.acronym.sk` answered 404 on
  2026-09-05 and today resolves to Websupport parking (`37.9.175.156`,
  `2a00:4b40:aaaa:2004::7`). Production deployment is an operator step with
  credentials and a VPS this repository does not hold. The stack is deployable
  — every compose combination interpolates from the example env files alone and
  nothing but the edge publishes a host port — but nothing in this tree has
  served a request over TLS on the public name.

  **What passing means at this stage.** Production is on-demand event hosting
  on the operator's PC, not a 24/7 service, so this gate no longer asks for
  one. It passes when all of the following have been observed in a single event
  session:

  1. `https://kino.acronym.sk` serves during the session, with valid HTTPS and
     no certificate warning.
  2. The Roll PWA opens on a phone using **mobile data**, not the venue LAN.
  3. `/api/healthz` returns `{"ok":true,"db":true,"redis":true,"storage":true}`
     through the public URL.
  4. One **physical shutter press** — not a KDP-triggered capture — reaches a
     guest's phone end to end while online.
  5. The origin is taken away mid-session and the camera holds: the ROLL screen
     reads "N waiting to upload" with "Saved safely on camera", and the count on
     the card keeps rising.
  6. The origin comes back and the backlog uploads itself with **no manual
     enqueue** and **no duplicates** — the roll's capture count equals the
     number of shutter presses, which the unique index on
     `(roll_id, capture_uuid)` and the `<captureUuid>:<role>:<frameIndex>`
     upload idempotency key are what guarantee.
  7. A live update lands on a real phone: a new capture appears without a
     reload.
  8. The database and object storage persist across a stack restart (named
     volumes, `down` without `-v`).
  9. A post-event backup covering **both** stores completes and verifies:
     `deploy.ps1 event-backup -Roll <slug> -BackupRoot <off-PC path>`.

  The drain gate that says the session is over —  `pending`, `uploading`,
  `cardPending` and `failed` at zero, `scanComplete` true, and the expected
  capture count on the roll — is one command,
  `deploy.ps1 drain -Roll <slug> -Expect <n>`, and the procedure around it is
  [`docs/runbooks/event-day.md`](runbooks/event-day.md).

  **Classification when it passes: ON-DEMAND PC-HOSTED PRODUCTION PASS.** An
  always-on machine is explicitly **not** required, and neither is a permanent
  Windows sleep disable, unattended overnight availability, automatic recovery
  while nobody is using KINO, a dedicated PC, or 24/7 Docker uptime. Those are
  the next phase's gates
  ([`docs/runbooks/origin-machine-move.md`](runbooks/origin-machine-move.md)) and
  a release must not be held for them. A release record must say
  "on-demand PC-hosted production" rather than "production" without
  qualification, because the URL does not answer when the PC is asleep and that
  is by design at this stage.

  The public ingress mechanism is not part of this gate. It is decided as of
  2026-09-08: **selected** is a Pinggy Pro custom-domain tunnel, **blocked**
  pending privacy and data-processing clarification, with the self-controlled
  relay VPS as the **fallback**. The standing decision and its conditions:
  [`docs/runbooks/public-ingress-options.md`](runbooks/public-ingress-options.md);
  the blocker:
  [`docs/runbooks/pinggy-plan-facts.md`](runbooks/pinggy-plan-facts.md).

  The blocking finding, measured 2026-09-06 and 2026-09-07: the PC egresses as
  `46.34.228.61` but two RFC1918 hops (`10.106.16.198`, `10.109.122.193`) sit
  beyond the operator's own router, which is the signature of carrier-grade
  NAT, and the PC has no IPv6 egress at all. Direct inbound hosting is
  therefore not viable, ports 80 and 443 on the PC are held by a Bitnami
  Apache service in any case, and DNS is not moving to Cloudflare. Both live
  paths keep Websupport authoritative: the selected Pinggy tunnel needs one
  `CNAME` on the `kino` label, and the fallback relay VPS needs one `A`.

  The whole procedure, the rollback, and a gate list that ends in a yes/no on
  whether `https://kino.acronym.sk` can be served:
  [`docs/runbooks/production-relay-deploy.md`](runbooks/production-relay-deploy.md).
  That document is the fallback's procedure. The router's own WAN address, as
  shown on its status page, is still the one unmeasured fact, and it changes
  nothing about either live path — both work behind carrier NAT. A release must not claim a public Roll deployment
  until gates B through F in it have passed — except F1 (sleep permanently
  disabled) and F2 (survives a reboot unattended), which belong to the always-on
  phase and are replaced at this stage by the twelve pre-event checks in
  [`docs/runbooks/event-day.md`](runbooks/event-day.md).
- **Destructive firmware paths.** Delete All (0.4.42) is index-driven and
  host-tested and has never been executed on a real card. Run it on an
  expendable card before a release claims it.

The table above is hand-written; `npm run version:check` verifies
`versions.json` against the sources, not this table. When they disagree,
`versions.json` is right.

## Bench acceptance a release cannot skip

- **Real shutter presses.** At least three physical shutter presses on the
  release image, 4/4 where the hardware is healthy, and the capture task's
  minimum free stack recorded afterwards (reference: about 4,048 B free on
  the 10 KB stack, 0.4.45). KDP `CAMERA_CAPTURE` runs on the kdp_server task
  and its 12 KB; the shutter runs on the capture task. On 2026-09-05 a hundred
  host-driven captures passed and the first two physical presses panicked
  the body (stack protection fault). A soak that fires the shutter over KDP
  does not exercise the shutter.
- **Firmware binaries are private.** The P4 image carries Microsoft Windows 98
  shell icons under an operator decision for the owner's own units (#134,
  2026-09-05). Release bundles built from this tree are for private use;
  nothing containing `icons_w98.h` may be published or handed on until the
  artwork or its licence is resolved. Say so in every release record.
- **Camnode provenance.** The camera-node binary in a bundle is stamped from
  `firmware/VERSION`; before publishing, either show the source delta since
  the last physically proven node image is version-only (`git diff <proven>..HEAD
  -- firmware/camnode firmware/components`) or flash the nodes and re-run the
  shutter and capture checks.

## Before cutting a version

1. Start from a clean worktree at the intended commit.
2. Read [`CHANGELOG.md`](../CHANGELOG.md) and remove claims that are not present in source.
3. Confirm [`ROADMAP.md`](../ROADMAP.md) and the README build-status note still match reality.
4. Review protocol and schema compatibility.
5. Review database migrations and rollback consequences.
6. Build with the lockfile and Node.js 22. `npm ci` needs npm 10 (the lockfile
   refuses npm 9: `npx npm@10.9.8 ci`); the scripts themselves run on either.
7. For a distributable bundle, build from a clean detached worktree so the
   manifest says `dirty: false` (`git worktree add --detach <dir> HEAD`,
   `npm ci` there, copy the firmware binaries into `firmware/*/build/`,
   `npm run release`).

```bash
npm ci
npm run version:check
npm run license:check
npm run lint
npm run test -w @kino/studio -w @kino/kdp -w @kino/schemas -w @kino/test-fixtures -w @kino/hardware-profiles -w @kino/simulator-engine -w @kino/three-assets -w @kino/twin -w @kino/design-system -w @kino/media -w @kino/roll-web
npm run build
```

Run the API and worker suites against clean services:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
npm run db:migrate -w @kino/api
npm run test -w @kino/api -w @kino/worker
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

`npm run release` builds the bundle from a clean checkout and is the only supported way to produce one:

```bash
npm run release                 # Studio bundle; firmware images included when already built
npm run release -- --firmware   # refuse to finish unless both firmware images are present
npm run release -- --out DIR    # default dist/release
```

It runs `version:check`, `license:check`, `lint` and `build` first — a release is never cut from a tree that fails its own gates — then writes `dist/release/`:

- `studio/` — the production Studio bundle;
- `firmware/kino-p4.bin`, `firmware/kino-camnode.bin` — when this tree has built them (`docker run … idf.py build`, see `firmware/README.md`);
- `release.json` — a `kino.release` manifest: Studio version, an embedded `kino.firmware-manifest` with per-target SHA-256 and `compatibleHardware` (the string devices report, `V1`), protocol versions, hardware revision, the source commit, and the tag names from [`VERSIONING.md`](VERSIONING.md);
- `SHA256SUMS` — every file in the bundle, manifest included. Verify with `sha256sum -c SHA256SUMS`.

The manifest records `source.dirty`. A bundle built from a dirty tree is emitted but marked, because it cannot be rebuilt from the commit it names — never publish one.

Signing is a separate, off-build-machine step; the trust contract, verification order, key rotation and the firmware rollback state machine are in [`RELEASE_TRUST.md`](RELEASE_TRUST.md). No signing pipeline exists yet, so do not call an artifact signed or trusted by hardware.

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

## Publish firmware to the Roll catalog

`npm run firmware:publish -- <package-dir>` uploads a firmware release to the API's catalog (S3 + database, with an advisory lock and rollback on failure). The input directory must contain:

- `manifest.json` — a `kino.firmware-manifest` naming **all** targets for the release (`targets.main`, `targets.cameraNode`), the `release` semver, a `channel`, `protocolMin`/`protocolMax`, and `compatibleHardware` using the string devices report (`V1`)
- every image file the manifest names, with matching SHA-256

The build daemon emits one single-target manifest per build (`firmware/<app>/build/kino-<app>-manifest.json`); assemble the publishable package by copying both `.bin` files into a directory and merging the two manifests' `targets` maps into one `manifest.json`. Connection settings come from the same environment variables as the API (`DATABASE_URL`, `S3_*`).

- Install the published Studio bundle in a clean browser profile.
- Exercise KINO Twin and one physical camera if hardware support is claimed.
- Verify the API health route and a complete upload against the target environment.
- Confirm links, downloads, checksums, and release notes from a separate machine.
- Record urgent fixes in the changelog before preparing a patch release.
