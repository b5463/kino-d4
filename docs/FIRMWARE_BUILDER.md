# Firmware builder

How Studio builds the real firmware (issue #72). One canonical environment,
no second build system.

## Pieces

| Piece | Path | Role |
|---|---|---|
| Build daemon | `scripts/firmware-daemon.mjs` | Localhost HTTP service (127.0.0.1:5177) wrapping `docker run espressif/idf:v5.5.1 idf.py build` on `firmware/p4` and `firmware/camnode` — the same pinned image CI uses (CI enters it via `export.sh`, the daemon via the image entrypoint) |
| Studio panel | `apps/studio/src/pages/Updates/FirmwareBuildPanel.tsx` | FIRMWARE BUILDER on the Updates page (developer mode) |
| Daemon client | `apps/studio/src/firmware/daemonClient.ts` | Typed client + package assembly with SHA-256 re-verification |

## Running it

```bash
npm run firmware:daemon     # terminal 1 — requires Docker
npm run dev -w @kino/studio # terminal 2
```

Studio → Updates → FIRMWARE BUILDER (developer mode on). The panel probes the
daemon every 5 s and says plainly when it is offline.

## Build pipeline (per target)

1. `version check` — `node scripts/check-versions.mjs`. **Drift refuses the
   build** (`VERSION_DRIFT`); the only way past is the explicit
   skip-checks override, and the artifact then carries `checksRun: false`
   which the panel prints as `CHECKS SKIPPED`.
2. `kdp host tests` — the 42-check framing contract suite under gcc.
3. `idf.py build (espressif/idf:v5.5.1)` — real output streamed to the panel:
   status, per-step elapsed time, warning/error counts, binary size,
   partition usage line, artifact path.
4. `artifact + manifest` — SHA-256 of the binary, and a real
   `kino.firmware-manifest` (channel `dev`, versions from `firmware/VERSION`
   and `versions.json`, never invented) with provenance passthrough fields:
   `espIdfVersion`, `chip`, `sizeBytes`, `partitionUsage`, `gitCommit`,
   `gitDirty`, `builtAt`, `checksRun`. Written next to the binary as
   `kino-<target>-manifest.json`.

One build at a time; a second POST answers 409.

## Artifact library

The daemon serves the latest built artifact + manifest per target
(`/api/artifact/<target>/bin|manifest`); the manifests on disk under
`firmware/<target>/build/` are the local library. `GET /api/builds` lists the
session's build history with manifests.

## Flash

**KINO Twin** — LOAD BUILT PACKAGE assembles both targets (releases must
match; images re-hashed against their manifests) into the standard update
package; the existing UPDATE panel then flashes it over KDP
`FW_BEGIN/CHUNK/END` with device-side SHA-256 verification, reboot, and
health check. Installing a `0.1.0` P4 image switches the Twin to the honest
current-firmware profile (`TWIN_FIRMWARE_MODEL.md`).

**Physical hardware** — BLOCKED_BY_HARDWARE for the in-Studio path: M1B
firmware has no `FW_*` surface (OTA is milestone 7), and this machine has no
host esptool. Direct development flashing stays `idf.py -p <port> flash`
per `firmware/README.md`. When OTA lands, the same package flows through the
same updater.

## Failure behavior (brief §39)

Compiler errors → `BUILD_FAILED` with the real log. Version drift →
`VERSION_DRIFT`, refused. Failing host tests → `HOST_TESTS_FAILED`, refused.
Corrupt/mismatched image → the loader's SHA-256 check or the device's
`SHA256_MISMATCH` NACK. Wrong hardware → `checkCompatibility` blocks the
UPDATE panel. Nothing shows "Done" without the underlying operation.
