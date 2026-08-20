# KINO Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the permanent KINO platform — KINO Studio, KINO Roll, self-hosted backend, and shared KDP/schema contracts — per `kino_dev_spec_pack/`, on top of the existing Studio v0.9.0 codebase.

**Architecture:** npm-workspaces monorepo with contracts-first shared packages (`@kino/kdp`, `@kino/schemas`, `@kino/test-fixtures`). The existing Studio app moves to `apps/studio` and gains its missing spec features (Roll page, first-class Skew Bench, capability audit). A new Fastify + PostgreSQL + Redis + MinIO backend (`apps/api`), BullMQ media workers (`apps/worker`), and a React PWA (`apps/roll-web`) implement KINO Roll. Hardware-gated phases (real-device bring-up, firmware/flash/power acceptance) are specified as bench procedures, not code tasks.

**Tech Stack:** TypeScript everywhere. Studio: React 19 + Vite + Zustand + Web Serial (existing). Backend: Node 22, Fastify 5, Drizzle ORM, PostgreSQL 16, Redis 7 (BullMQ + pub/sub), MinIO (S3 API), zod. Workers: BullMQ + sharp + ffmpeg. Roll web: React + Vite + vite-plugin-pwa + @tanstack/react-virtual. Tests: vitest.

**Spec:** `kino_dev_spec_pack/00_README.md` through `07_IMPLEMENTATION_AND_ACCEPTANCE.md` (all eight files travel with this plan; tasks cite sections as `02§10` = file 02, section 10).

## Global Constraints

Copied from the spec pack — every task's requirements implicitly include these:

- Locked naming: **KINO D4**, **KINO Studio**, **KINO Roll** (00§Locked naming).
- Locked domain: `https://kino.acronym.sk`; routes `/`, `/studio`, `/r/<roll-slug>`, `/host`, `/api/...` (00, 05§3).
- Build Studio and Roll as the **permanent platform**, not D4-only prototypes (00§Core requirement).
- Never hard-code: exactly 4 cameras, OV3660, UART, one sync method, one resolution, one firmware target. Every device reports capabilities (01§2).
- Every persistent/portable structure has schema name, schema version, migration path (01§3, 05§20).
- Studio talks to a `DeviceTransport` abstraction, never Web Serial directly from feature code (01§4).
- State discipline: device truth / draft state / transient state kept separate (01§5).
- Local-first: camera captures offline, SD first; internet never required to shoot; Studio USB functionality works without account/cloud (01§6, 03§3).
- **Originals are immutable.** Never overwrite originals; AI enhancement is always an optional derivative (01§7, 03§20).
- Timing: report **GPIO distribution skew**, **VSYNC phase skew**, and **effective exposure skew** separately. If unavailable, return null + reason. Never fabricate. 100–400 µs is a target, not an assumption (00§Critical D4 timing note, 02§10, 04§13).
- Unsupported KDP commands NACK with reason (`UNSUPPORTED_COMMAND` etc.); never silently time out (02§27, 04§6).
- Wi-Fi credentials stay local to camera — never sent to backend, never logged (03§27, 05§13).
- No media blobs in PostgreSQL; media lives in S3-compatible object storage; object key is not authorization (05§5, 05§6).
- Rolls are unlisted by default (secret slug), `X-Robots-Tag: noindex, nofollow`, no public directory in V1 (03§9).
- No guest accounts, no mandatory PWA install (03§2, 03§5, 03§18).
- Design: authentic 2003–2007 utility software, moderately dense, not SaaS/Instagram; period vibe must not damage accessibility (06 all).
- Studio browsers: current Chrome/Edge desktop; unsupported browsers show explicit explanation. Roll: current iOS Safari + Android Chrome + major desktop (02§2, 07§28).
- CI on every PR: TypeScript checks, lint, unit tests, KDP decoder tests, schema validation, API tests, upload tests, production builds (07§12).
- Roll terminology in copy: "Start a Roll", "Join a Roll", "47 photos on this Roll", "Close Roll" (01§10).
- UI copy voice: blunt and functional, no flavor prose (project preference, overrides nothing in spec).

---

## Current State (verified 2026-08-14)

The repo (`kino d4/`) is a **single Vite app: KINO Studio v0.9.0** — not yet a git repository.

**Already built and tested (keep, don't rewrite):**

| Area | Location | Status |
|---|---|---|
| KDP framing, CRC32, packet codec | `src/protocol/packet.ts`, `crc32.ts` | Exists + tests |
| Protocol client, UNSUPPORTED_COMMAND handling | `src/protocol/KinoProtocolClient.ts` | Exists |
| Transport abstraction + Serial + Mock | `src/transport/` | Exists |
| Mock device + failure scenarios | `src/mock/` | Exists + tests |
| Pages: Overview, Shoot, Wiggle, Quad, Looks, Calibration, Gallery, Device, Updates, Developer | `src/pages/` | Exist |
| Build Mode wizard | `src/pages/BringUp/` | Exists + tests |
| Timing/phase benches (in Developer) | `src/pages/Developer/TimingBench.tsx`, `PhasePanel.tsx` | Exists — needs promotion to first-class Skew Bench |
| Backup/restore incl. custom sounds | tested (`tests/backup.test.ts`, `sounds.test.ts`) | Exists |
| Firmware update flow + manifest + rollback UI | `src/firmware/` | Exists + tests |
| Wiggle render + MP4 export | `mp4-muxer`, `tests/wiggleRender.test.ts` | Exists |

**Missing vs spec pack (this plan's scope):**

1. Git repo, monorepo layout, shared packages, CI (07§1, §12).
2. `@kino/schemas` package with versioned schemas + migration framework (01§3, 05§19–20).
3. KDP gaps: async job model (`jobId`, `JOB_PROGRESS/COMPLETE/FAILED` — 04§15), network/Roll/upload-queue command groups (04§7), decoder acceptance audit vs 07§13.
4. Studio Roll page: Wi-Fi provisioning, server URL, registration, create/join Roll, upload queue, guest QR, host link (02§17).
5. Skew Bench as first-class feature with mean/median/p95/max over hundreds of triggers + quality bands (02§10, 07§18).
6. Backend entirely: API, DB, object storage, Redis, resumable uploads, SSE, auth, moderation, exports, firmware catalog (03, 05).
7. Workers entirely: thumbnail, gallery still, wiggle WebP/MP4, contact sheet, metadata, recap, AI stub (03§19, 05§11).
8. Roll guest PWA + host dashboard entirely (03§5–14, §23).
9. Studio↔backend integration: device registration, firmware catalog, Roll provisioning (07§5).
10. Production deployment for `kino.acronym.sk`: compose stack, reverse proxy, backups + restore drill, observability (05§1–2, §16–17).
11. Hardware-gated acceptance (real D4): sync/flash/power/UART benches (07§17–22) — procedures only until hardware arrives.

---

## Monorepo Target Layout (07§1)

```text
kino d4/                      (repo root — becomes workspace root)
├── apps/
│   ├── studio/               (moved from repo root)
│   ├── roll-web/             (new: guest PWA + host dashboard)
│   ├── api/                  (new: Fastify backend)
│   └── worker/               (new: BullMQ media workers)
├── packages/
│   ├── kdp/                  (protocol framing, client, transports — extracted from studio)
│   ├── schemas/              (zod schemas + migrations for kino.* contracts)
│   ├── media/                (shared media helpers: wiggle sequence math, asset roles)
│   ├── design-system/        (created in Workstream 8, not before — YAGNI)
│   └── test-fixtures/        (mock device, scenarios, sample captures, migration fixtures)
├── firmware-contract/        (canonical KDP + schema docs for the firmware team)
├── infra/                    (docker compose, proxy config, env templates, backup scripts)
├── docs/
└── kino_dev_spec_pack/       (the spec — stays)
```

## Workstreams and Dependency Order

```text
WS0 repo foundation ──► WS1 contracts ──┬─► WS2 Studio gap closure (vs mock)
                                        └─► WS3 backend core ──┬─► WS4 workers
                                                               ├─► WS5 roll-web
                                                               └─► WS6 Studio ↔ backend
WS7 hardware-gated benches (blocked on physical D4; spec'd as procedures)
WS8 design-system final pass (after WS2/WS5 flows are stable — 07§10)
WS9 production deployment (after WS3–WS6)
```

Each workstream produces working, testable software on its own. WS2 and WS3 can run in parallel after WS1. Suggested execution: treat each workstream as a sub-plan; dispatch per-task subagents inside it.

Maps to spec phases: WS0+WS1 = Phase 0; WS2 = Phase 1; WS3+WS4+WS5 = Phase 2; WS6 = Phase 3; WS7 = Phases 4–6; WS4/WS3 hardening = Phase 7; WS8 = Phase 8.

---

# Workstream 0 — Repo Foundation

### Task 1: Initialize git and commit the baseline

**Files:**
- Create: `.gitignore`

**Interfaces:**
- Produces: a git repository with the current working Studio as the first commit. Every later task assumes `git` is available and commits frequently.

- [x] **Step 1: Initialize the repository**

```bash
cd "c:/Users/AlexanderMoravcik/Desktop/kino d4"
git init -b main
```

- [x] **Step 2: Write `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo
.env
.env.*
!.env.example
coverage/
.DS_Store
```

- [x] **Step 3: Verify the tree is clean of junk**

Run: `git status --short | head -40`
Expected: source files, specs, config — no `node_modules/`, no `dist/`, no `.tsbuildinfo`.

- [x] **Step 4: Baseline commit**

```bash
git add -A
git commit -m "chore: baseline KINO Studio v0.9.0 + dev spec pack"
```

Note: `KINO_PROJECT_RECOVERY_PACK.zip` is a binary recovery artifact. The documentation cleanup retained it at `archive/KINO_PROJECT_RECOVERY_PACK.zip`; do not delete it without the owner's approval.

### Task 2: Convert to npm workspaces and move Studio to `apps/studio`

**Files:**
- Create: `package.json` (new workspace root — the current one moves with Studio)
- Create: `tsconfig.base.json`
- Move: `src/`, `index.html`, `public/`, `tests/`, `vite.config.ts`, `tsconfig*.json`, current `package.json` → `apps/studio/`

**Interfaces:**
- Produces: workspace root where `npm install` hoists deps; `npm run test -w @kino/studio` runs Studio tests. All later apps/packages are workspace members named `@kino/<name>`.

- [x] **Step 1: Move the app with git mv**

```bash
mkdir -p apps/studio
git mv src index.html public tests vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json package.json apps/studio/
rm -f tsconfig.app.tsbuildinfo tsconfig.node.tsbuildinfo package-lock.json
```

- [x] **Step 2: Write the new workspace root `package.json`**

```json
{
  "name": "kino",
  "private": true,
  "version": "0.1.0",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present"
  },
  "engines": { "node": ">=22" }
}
```

- [x] **Step 3: Rename Studio package and add base tsconfig**

In `apps/studio/package.json` set `"name": "@kino/studio"`. Write `tsconfig.base.json` at root:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

Point `apps/studio/tsconfig.json` `extends` at `../../tsconfig.base.json` (keep its existing compiler options that differ, e.g. JSX settings, by leaving them in the app tsconfig).

- [x] **Step 4: Reinstall and verify Studio still builds and tests pass**

Run: `npm install && npm run test -w @kino/studio && npm run build -w @kino/studio`
Expected: all existing tests PASS (14 test files), `vite build` succeeds. If `vite.config.ts` or `index.html` referenced root-relative paths, fix them now — they moved one directory down.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: npm workspaces monorepo; studio -> apps/studio"
```

### Task 3: CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI running typecheck, lint, tests, and production builds for every workspace on every push/PR (07§12). API/upload test jobs are added by WS3 tasks; the workflow is structured so they slot in.

- [x] **Step 1: Write the workflow**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

- [x] **Step 2: Verify the same commands pass locally**

Run: `npm run lint && npm run test && npm run build`
Expected: PASS (this is what CI will run).

- [x] **Step 3: Commit**

```bash
git add .github && git commit -m "ci: typecheck, lint, test, build for all workspaces"
```

---

# Workstream 1 — Contracts First (Phase 0, 07§2)

### Task 4: `@kino/schemas` package with versioned envelope + migration framework

**Files:**
- Create: `packages/schemas/package.json`, `packages/schemas/tsconfig.json`
- Create: `packages/schemas/src/registry.ts`
- Create: `packages/schemas/src/errors.ts`
- Create: `packages/schemas/src/index.ts`
- Test: `packages/schemas/tests/registry.test.ts`

**Interfaces:**
- Produces: `defineSchema<T>(def): SchemaDef<T>`, `parseVersioned<T>(def: SchemaDef<T>, raw: unknown): T`, errors `SchemaTooNewError`, `MissingMigrationError`. Every `kino.*` document in every app parses through this. Package name `@kino/schemas`, dep: `zod@^3`.

- [x] **Step 1: Scaffold the package**

`packages/schemas/package.json`:

```json
{
  "name": "@kino/schemas",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": { "test": "vitest run", "lint": "tsc --noEmit" },
  "dependencies": { "zod": "^3.24.0" },
  "devDependencies": { "typescript": "~5.8.3", "vitest": "^3.1.3" }
}
```

`tsconfig.json` extends `../../tsconfig.base.json` with `"include": ["src", "tests"]`.

- [x] **Step 2: Write the failing test**

```ts
// packages/schemas/tests/registry.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineSchema, parseVersioned, SchemaTooNewError, MissingMigrationError } from '../src/index';

const widget = defineSchema({
  schema: 'kino.test-widget',
  version: 2,
  shape: z.object({
    schema: z.literal('kino.test-widget'),
    version: z.literal(2),
    name: z.string(),
    color: z.string(),
  }),
  migrations: {
    // v1 had no color; v1 -> v2 adds default
    1: (doc) => ({ ...doc, color: 'grey' }),
  },
});

describe('parseVersioned', () => {
  it('parses a current-version document', () => {
    const out = parseVersioned(widget, { schema: 'kino.test-widget', version: 2, name: 'a', color: 'blue' });
    expect(out.color).toBe('blue');
  });
  it('migrates an old document forward', () => {
    const out = parseVersioned(widget, { schema: 'kino.test-widget', version: 1, name: 'a' });
    expect(out.version).toBe(2);
    expect(out.color).toBe('grey');
  });
  it('rejects newer-than-known versions explicitly', () => {
    expect(() => parseVersioned(widget, { schema: 'kino.test-widget', version: 3, name: 'a' }))
      .toThrow(SchemaTooNewError);
  });
  it('rejects wrong schema name', () => {
    expect(() => parseVersioned(widget, { schema: 'kino.other', version: 2, name: 'a', color: 'x' })).toThrow();
  });
  it('fails loudly on a missing migration step', () => {
    const gappy = defineSchema({ ...widget, version: 3, shape: z.any(), migrations: { 1: (d) => d } });
    expect(() => parseVersioned(gappy, { schema: 'kino.test-widget', version: 1, name: 'a' }))
      .toThrow(MissingMigrationError);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npm run test -w @kino/schemas`
Expected: FAIL — module `../src/index` not found.

- [x] **Step 4: Implement**

```ts
// packages/schemas/src/errors.ts
export class SchemaTooNewError extends Error {
  constructor(public schema: string, public docVersion: number, public knownVersion: number) {
    super(`${schema} v${docVersion} is newer than supported v${knownVersion}`);
    this.name = 'SchemaTooNewError';
  }
}
export class MissingMigrationError extends Error {
  constructor(public schema: string, public fromVersion: number) {
    super(`${schema}: no migration from v${fromVersion}`);
    this.name = 'MissingMigrationError';
  }
}
```

```ts
// packages/schemas/src/registry.ts
import { z } from 'zod';
import { SchemaTooNewError, MissingMigrationError } from './errors';

export interface SchemaDef<T> {
  schema: string;
  version: number;
  shape: z.ZodType<T>;
  migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>;
}

export function defineSchema<T>(def: SchemaDef<T>): SchemaDef<T> {
  return def;
}

const envelope = z.object({ schema: z.string(), version: z.number().int().min(1) }).passthrough();

export function parseVersioned<T>(def: SchemaDef<T>, raw: unknown): T {
  const env = envelope.parse(raw);
  if (env.schema !== def.schema) {
    throw new Error(`expected schema ${def.schema}, got ${env.schema}`);
  }
  if (env.version > def.version) throw new SchemaTooNewError(def.schema, env.version, def.version);
  let doc: Record<string, unknown> = env;
  let v = env.version;
  while (v < def.version) {
    const step = def.migrations[v];
    if (!step) throw new MissingMigrationError(def.schema, v);
    doc = { ...step(doc), version: v + 1 };
    v += 1;
  }
  return def.shape.parse(doc);
}
```

```ts
// packages/schemas/src/index.ts
export { defineSchema, parseVersioned, type SchemaDef } from './registry';
export { SchemaTooNewError, MissingMigrationError } from './errors';
```

- [x] **Step 5: Run test to verify it passes, then commit**

Run: `npm run test -w @kino/schemas`
Expected: PASS.

```bash
git add packages/schemas && git commit -m "feat(schemas): versioned schema envelope + migration framework"
```

### Task 5: Core `kino.*` schema definitions

**Files:**
- Create: `packages/schemas/src/device.ts` (kino.device-info, kino.device-capabilities)
- Create: `packages/schemas/src/config.ts` (kino.device-config)
- Create: `packages/schemas/src/media.ts` (kino.capture, kino.asset, kino.roll)
- Create: `packages/schemas/src/firmware.ts` (kino.firmware-manifest)
- Modify: `packages/schemas/src/index.ts`
- Test: `packages/schemas/tests/schemas.test.ts`

**Interfaces:**
- Produces (exact export names used by every later task):
  - `deviceCapabilities` (`SchemaDef<DeviceCapabilities>`), `deviceInfo`, `deviceConfig`, `capture`, `asset`, `roll`, `firmwareManifest`
  - Types: `DeviceCapabilities`, `DeviceConfig`, `Capture`, `Asset`, `Roll`, `FirmwareManifest`
  - `ASSET_ROLES` const array: `['thumb','kino-still','original-frame','wiggle-preview','wiggle-webp','wiggle-mp4','gif','contact-sheet','enhanced-still','enhanced-wiggle','metadata']` (05§19)
  - `CAPTURE_MODES`: `['wiggle','quad','single']` (03§12)
  - `ROLL_STATUSES`: `['draft','live','closed','archived','trash']` (03§22)
  - `CAPTURE_STATUSES`: `['created','preview-ready','originals-uploading','complete','processing','ready','partial','failed']` (05§8)
- Consumes: Task 4's `defineSchema`.

- [x] **Step 1: Write the failing test** — one `it` per schema, each parsing the exact example JSON from the spec (01§2 capabilities, 02§28 config, 05§19 device/roll/capture/asset/manifest), plus one migration fixture per schema proving `migrations` is wired (v1 documents currently migrate to themselves; the fixture asserts `parseVersioned` accepts version 1). Include the timing rule: `capture.timing` fields each `number | null`, and a `timingUnavailableReason` optional string — assert a capture with `effectiveExposureSkewUs: null` parses (04§13: null + reason, never fabricate).

```ts
// packages/schemas/tests/schemas.test.ts — representative cases; write all schemas the same way
import { describe, it, expect } from 'vitest';
import { parseVersioned } from '../src/index';
import { capture, deviceCapabilities, firmwareManifest } from '../src/index';

it('parses the spec example capture with null effective exposure skew', () => {
  const doc = {
    schema: 'kino.capture', version: 1, id: 'cap_0042', captureUuid: 'b96c1111-0000-4000-8000-000000000000',
    rollId: 'roll_01', deviceId: 'dev_01', mode: 'wiggle', look: 'party-neg',
    capturedAt: '2026-08-14T23:42:18+02:00', frameCount: 4, resolution: '1600x1200',
    timing: { gpioTriggerSkewUs: 140, vsyncPhaseSkewUs: 1200, effectiveExposureSkewUs: null },
    status: 'ready', visible: true,
  };
  expect(parseVersioned(capture, doc).timing.effectiveExposureSkewUs).toBeNull();
});

it('tolerates unknown future capability fields (07§14)', () => {
  const doc = {
    schema: 'kino.device-capabilities', version: 1, cameraCount: 4,
    features: { wiggle: true, futureThing: true }, limits: { maxResolution: '2048x1536' },
    someFutureTopLevelField: 'x',
  };
  expect(parseVersioned(deviceCapabilities, doc).cameraCount).toBe(4);
});

it('parses the firmware manifest example (04§12)', () => {
  const doc = {
    schema: 'kino.firmware-manifest', version: 1, release: '0.6.1', protocolMin: 1, protocolMax: 1,
    compatibleHardware: ['D4-V1'],
    targets: { main: { file: 'p4-app.bin', sha256: 'a'.repeat(64) }, cameraNode: { file: 'xiao-app.bin', sha256: 'b'.repeat(64) } },
    updateOrder: ['cameraNode', 'main'],
  };
  expect(parseVersioned(firmwareManifest, doc).release).toBe('0.6.1');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test -w @kino/schemas`
Expected: FAIL — exports missing.

- [x] **Step 3: Implement the schemas**

Key shape decisions (implement exactly):

```ts
// packages/schemas/src/media.ts (capture shown; asset and roll follow the 05§19 examples)
import { z } from 'zod';
import { defineSchema } from './registry';

export const CAPTURE_MODES = ['wiggle', 'quad', 'single'] as const;
export const CAPTURE_STATUSES = ['created','preview-ready','originals-uploading','complete','processing','ready','partial','failed'] as const;
export const ROLL_STATUSES = ['draft','live','closed','archived','trash'] as const;
export const ASSET_ROLES = ['thumb','kino-still','original-frame','wiggle-preview','wiggle-webp','wiggle-mp4','gif','contact-sheet','enhanced-still','enhanced-wiggle','metadata'] as const;

const timing = z.object({
  gpioTriggerSkewUs: z.number().nullable(),
  vsyncPhaseSkewUs: z.number().nullable(),
  effectiveExposureSkewUs: z.number().nullable(),
  unavailableReason: z.string().optional(),
});

export const capture = defineSchema({
  schema: 'kino.capture',
  version: 1,
  shape: z.object({
    schema: z.literal('kino.capture'),
    version: z.literal(1),
    id: z.string(),
    captureUuid: z.string().uuid(),
    rollId: z.string().nullable().optional(),
    deviceId: z.string(),
    mode: z.enum(CAPTURE_MODES),
    look: z.string().optional(),
    capturedAt: z.string(),           // ISO 8601
    frameCount: z.number().int().positive(),   // NOT hard-coded to 4 (01§2, 03§12)
    resolution: z.string().regex(/^\d+x\d+$/),
    timing: timing.partial().passthrough().optional(),
    status: z.enum(CAPTURE_STATUSES),
    visible: z.boolean().default(true),
  }).passthrough(),
  migrations: {},
});
export type Capture = z.infer<typeof capture.shape>;
```

`deviceCapabilities.shape` uses `.passthrough()` at every level and `features: z.record(z.boolean()).catchall(z.unknown())`-style tolerance so unknown future fields never fail parsing (07§14). `firmwareManifest` validates `sha256: z.string().regex(/^[0-9a-f]{64}$/)`, `targets: z.record(z.object({ file: z.string(), sha256, version: z.string().optional() }))`, `updateOrder: z.array(z.string()).optional()` (manifest may override order, 02§21).

- [x] **Step 4: Run tests, verify PASS**

Run: `npm run test -w @kino/schemas`

- [x] **Step 5: Wire Studio to the shared package (replace duplicated local types where they exist in `apps/studio/src/types/`), run Studio tests, commit**

Run: `npm run test -w @kino/studio`
Expected: PASS (Studio keeps its own view-model types; only the portable `kino.*` document shapes move to `@kino/schemas`).

```bash
git add -A && git commit -m "feat(schemas): kino.* core schemas with spec-example fixtures"
```

### Task 6: Extract `@kino/kdp` from Studio

**Files:**
- Create: `packages/kdp/package.json`, `packages/kdp/tsconfig.json`, `packages/kdp/src/index.ts`
- Move: `apps/studio/src/protocol/*` → `packages/kdp/src/protocol/`
- Move: `apps/studio/src/transport/*` → `packages/kdp/src/transport/`
- Move: `apps/studio/tests/packet.test.ts`, `crc32.test.ts` → `packages/kdp/tests/`
- Modify: all Studio imports of `../protocol/...` / `../transport/...` → `@kino/kdp`

**Interfaces:**
- Produces: `@kino/kdp` exporting (names must match what Studio already uses — do not rename during the move): the packet encoder/decoder from `packet.ts`, `crc32`, `KinoProtocolClient`, command constants from `commands.ts`, timing types from `timing.ts`, `Transport` interface, `SerialTransport`, `MockTransport`.
- Consumes: nothing new. The mock *device* (`src/mock/`) does NOT move here — it goes to `@kino/test-fixtures` (Task 8).

- [x] **Step 1: Move files with git mv, scaffold package.json** (same shape as Task 4's, name `@kino/kdp`, no runtime deps).

- [x] **Step 2: Create the barrel export `packages/kdp/src/index.ts` re-exporting every public symbol Studio imports today.** Find the exact list first:

Run: `grep -rhn "from '.*\(protocol\|transport\)/" apps/studio/src --include="*.ts*" | grep -o "{[^}]*}" | tr -d '{}' | tr ',' '\n' | sort -u`

- [x] **Step 3: Update Studio imports**

Run: `grep -rl "protocol/\|transport/" apps/studio/src | xargs sed -i "s|from '[./]*\(protocol\|transport\)[^']*'|from '@kino/kdp'|g"` — then hand-fix any relative-depth stragglers the typechecker finds. Add `"@kino/kdp": "*"` to Studio's dependencies.

- [x] **Step 4: Run all tests**

Run: `npm run test`
Expected: kdp tests (packet, crc32) PASS in the new package; all Studio tests still PASS.

- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: extract @kino/kdp (protocol + transports) from studio"
```

### Task 7: KDP decoder acceptance audit + async job model

**Files:**
- Modify: `packages/kdp/src/protocol/types.ts`, `commands.ts`, `KinoProtocolClient.ts`
- Test: `packages/kdp/tests/decoder-acceptance.test.ts`, `packages/kdp/tests/jobs.test.ts`

**Interfaces:**
- Produces:
  - Decoder proven against the full 07§13 list.
  - Async job API on `KinoProtocolClient`: `startJob(command, payload): Promise<JobHandle>` where `JobHandle = { jobId: string; progress: AsyncIterable<JobProgress>; result: Promise<JobResult> }`, event types `JOB_PROGRESS | JOB_COMPLETE | JOB_FAILED` (04§15). Used by calibration, firmware, stress tests, storage checks, exports.
  - New command constants (04§7): `NETWORK_LIST, NETWORK_SET, NETWORK_DELETE, NETWORK_STATUS, ROLL_STATUS, ROLL_CREATE, ROLL_JOIN, ROLL_LEAVE, UPLOAD_QUEUE_STATUS, UPLOAD_QUEUE_RETRY, GET_POWER_STATUS, GET_STORAGE_STATUS` (add whichever of these are missing — check `commands.ts` first).
- Consumes: existing packet codec.

- [x] **Step 1: Write the decoder acceptance test** — one case per 07§13 requirement. Audit `packet.test.ts` first; only add the missing cases. Required coverage: split frame across reads; multiple frames in one read; bad CRC rejected then resync; leading boot text; random bytes; wrong protocol version; disconnect/reconnect; new session ID detected (client surfaces `sessionChanged` event when HELLO returns a different boot/session ID). HELLO coverage: retry (up to 3), nonce echo verified, timeout, protocol negotiation.

- [x] **Step 2: Run, confirm which cases fail** (existing code may already pass several — that's fine; keep the tests as the acceptance record).

- [x] **Step 3: Write the failing job-model test**

```ts
// packages/kdp/tests/jobs.test.ts
import { it, expect } from 'vitest';
// harness: a scripted Transport that replies to a command with { jobId, accepted: true },
// then emits JOB_PROGRESS 0.5, then JOB_COMPLETE { ok: true }
it('startJob yields progress then resolves result', async () => {
  const client = makeClientWithScriptedDevice([
    { onCommand: 'SELF_TEST', reply: { jobId: 'job_1', accepted: true } },
    { emit: { type: 'JOB_PROGRESS', jobId: 'job_1', progress: 0.5 } },
    { emit: { type: 'JOB_COMPLETE', jobId: 'job_1', result: { ok: true } } },
  ]);
  const job = await client.startJob('SELF_TEST', {});
  const seen: number[] = [];
  for await (const p of job.progress) seen.push(p.progress);
  expect(seen).toEqual([0.5]);
  expect(await job.result).toEqual({ ok: true });
});
it('JOB_FAILED rejects result with the device error object', async () => { /* same harness, emit JOB_FAILED */ });
```

- [x] **Step 4: Implement `startJob` + event routing** — async events carry no request sequence ID (04§16); route by `jobId`. Progress iterable completes when COMPLETE/FAILED arrives.

- [x] **Step 5: Run all kdp tests, commit**

```bash
git add packages/kdp && git commit -m "feat(kdp): decoder acceptance suite + async job model + network/roll commands"
```

### Task 8: `@kino/test-fixtures` — mock device hardened to 04§19

**Files:**
- Create: `packages/test-fixtures/package.json`
- Move: `apps/studio/src/mock/*` → `packages/test-fixtures/src/`
- Move: `apps/studio/tests/mockDevice.test.ts` → `packages/test-fixtures/tests/`
- Modify: Studio imports → `@kino/test-fixtures`
- Test: `packages/test-fixtures/tests/scenarios.test.ts`

**Interfaces:**
- Produces: `MockKinoDevice`, `MockMediaStore`, `scenarios` export where every 04§19 scenario is a named entry: `splitFrames, coalescedFrames, badCrc, bootSpew, delayedResponses, unsupportedCommands, disconnect, failedUpdate, offlineCameraNode, sessionRestart, largeGallery2k, uploadBacklog`. Mock now answers the Task 7 command groups: `NETWORK_*` (stores networks in-memory, never echoes passwords back in full — masked as `••••`), `ROLL_*` (fake roll state machine), `UPLOAD_QUEUE_*` (scripted backlog that drains over time). Consumed by Studio dev/demo mode and by WS2 tests.
- Consumes: `@kino/kdp` command constants, `@kino/schemas`.

- [x] **Step 1: Move + rewire imports, run full test suite** (same mechanics as Task 6).

- [x] **Step 2: Write failing scenario-coverage test** — asserts `Object.keys(scenarios)` includes all twelve 04§19 names, and one behavioral test per newly added scenario (`uploadBacklog`: `UPLOAD_QUEUE_STATUS` returns `{ pending: 12, uploading: 1, failed: 2 }` then drains on simulated ticks; `ROLL_CREATE` returns `{ rollId, slug, guestUrl }`).

- [x] **Step 3: Implement missing scenarios + new mock commands.**

- [x] **Step 4: Run tests, verify Studio demo mode still boots** (`npm run dev -w @kino/studio`, connect Demo mode, Overview renders).

- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(fixtures): @kino/test-fixtures with full 04§19 scenario coverage + roll/network mock"
```

### Task 9: `firmware-contract/` canonical docs

**Files:**
- Create: `firmware-contract/README.md`, `firmware-contract/kdp-framing.md`, `firmware-contract/commands.md`, `firmware-contract/schemas.md`

**Interfaces:**
- Produces: the canonical, versioned reference the firmware team implements against (07§1: "protocol/schema source must remain canonical/shared"). Content: packet layout table (04§3), command list with request/response payload JSON for every command in `commands.ts` (generated by hand once, kept in PR review), NACK reason enum (04§6), job model (04§15), timing telemetry contract incl. null+reason rule (04§13–14), links to `@kino/schemas` source as the type authority.

- [x] **Step 1: Write the four documents** (extract from `packages/kdp` source + spec 04 — no new design decisions here; where source and spec 04 disagree, source wins and the discrepancy is listed in README under "deviations").

- [x] **Step 2: Commit**

```bash
git add firmware-contract && git commit -m "docs: canonical firmware contract (KDP framing, commands, schemas)"
```

---

# Workstream 2 — Studio Gap Closure (Phase 1, against mock)

### Task 10: Skew Bench — stats module

**Files:**
- Create: `apps/studio/src/skew/skewStats.ts`
- Test: `apps/studio/tests/skewStats.test.ts`

**Interfaces:**
- Produces (consumed by Task 11's UI):

```ts
export interface SkewStats { mean: number; median: number; p95: number; max: number; count: number }
export function skewStats(samplesUs: number[]): SkewStats;          // throws on empty input
export type SkewBand = 'excellent' | 'very-good' | 'good' | 'warning' | 'poor' | 'fail';
export function bandForSpreadMs(spreadMs: number): SkewBand;
export interface SkewRun {                                          // one bench pass over N triggers
  metric: 'gpio' | 'vsync' | 'exposure';
  perCameraUs: Array<{ camera: number; offsetsUs: number[] } >;     // camera count from capabilities, not 4
  unavailableReason?: string;                                       // set when device returned null (04§13)
}
export function spreadUs(offsets: number[]): number;                // max - min within one trigger
```

- [x] **Step 1: Write the failing test** — cases: `skewStats([100,200,300,400])` → mean 250, median 250, max 400; p95 uses nearest-rank (`p95 of 100 samples = 95th sorted value`); band boundaries exactly per 02§10/07§18: `bandForSpreadMs(0.49)==='excellent'`, `0.5→'very-good'`, `1→'good'`, `2→'warning'`, `5→'poor'`, `10.01→'fail'` (bands are `<0.5`, `0.5–1`, `1–2`, `2–5`, `5–10`, `>10`); `skewStats([])` throws.

- [x] **Step 2: Run to verify FAIL.** Run: `npm run test -w @kino/studio -- skewStats`

- [x] **Step 3: Implement** (pure functions, no deps; nearest-rank p95: `sorted[Math.ceil(0.95 * n) - 1]`).

- [x] **Step 4: Run to verify PASS.**

- [x] **Step 5: Commit** — `feat(studio): skew statistics with 07§18 quality bands`

### Task 11: Skew Bench — first-class UI

**Files:**
- Create: `apps/studio/src/pages/Calibration/SkewBench.tsx`
- Modify: `apps/studio/src/pages/Calibration/CalibrationPage.tsx` (add "Skew Bench" tab)
- Modify: `apps/studio/src/pages/Overview/OverviewPage.tsx` (surface latest skew verdict + link)
- Modify: reuse/relocate logic from `apps/studio/src/pages/Developer/TimingBench.tsx` — Developer keeps its raw view; SkewBench is the product surface

**Interfaces:**
- Consumes: Task 10 stats; `KinoProtocolClient.startJob('SYNC_BENCH', { triggers: N })` from Task 7; `CAMERA_GET_TIMING` for single reads.
- Produces: the 02§10 display — three separate sections (GPIO distribution / VSYNC phase / effective exposure), each with per-camera offsets, spread, band label, and mean/median/p95/max over the run. Run sizes: 25 (quick) / 250 (bench, default — "hundreds of triggers" per 07§18) / 1000 (soak). When the device reports a metric as null, the section renders "NOT MEASURABLE — <reason from device>" — never a fabricated number, never a collapsed single score.

- [x] **Step 1: Write failing component/store test** — feed a fake job stream of trigger samples; assert: three metric sections render independently; exposure section with `unavailableReason: 'no exposure telemetry in this firmware'` shows the reason text and no numbers; band label "GOOD TARGET" shown for a 1.2 ms VSYNC spread (the 02§10 example data).

- [x] **Step 2: Run to verify FAIL.**

- [x] **Step 3: Implement.** Layout per design system: compact table per metric (rows CAM1..CAMn from capabilities), monospace numbers as `+0.61ms`, spread row, band lamp (`● / ▲ / ×`), distribution line (`mean 0.42 · median 0.39 · p95 0.88 · max 1.20 ms`). Progress via job progress events with cancel (`FW_ABORT`-style job cancel is not in the protocol — cancel = stop consuming + device timeout is acceptable for V1; note in UI as "Stopping after current trigger…").

- [x] **Step 4: Run tests + `npm run dev`, run a bench against mock scenario, verify all three sections + null path (mock `sessionRestart` scenario has vsync telemetry; add a mock capability flag `vsyncTelemetry:false` variant to see the null path).**

- [x] **Step 5: Commit** — `feat(studio): first-class Skew Bench with three-metric display`

### Task 12: Studio Roll page (device side, against mock)

**Files:**
- Create: `apps/studio/src/pages/Roll/RollPage.tsx`
- Create: `apps/studio/src/pages/Roll/NetworkPanel.tsx`, `RollPanel.tsx`, `UploadQueuePanel.tsx`, `ServerPanel.tsx`
- Create: `apps/studio/src/roll/RollServerClient.ts` (interface + stub)
- Modify: `apps/studio/src/app/` nav registry — add `Roll` between `Gallery` and `Device` (02§3 order)
- Test: `apps/studio/tests/rollPage.test.ts`
- Add dependency: `qrcode@^1.5` to `apps/studio`

**Interfaces:**
- Consumes: `@kino/kdp` commands `NETWORK_LIST/SET/DELETE/STATUS`, `ROLL_STATUS/CREATE/JOIN/LEAVE`, `UPLOAD_QUEUE_STATUS/RETRY` (Task 7); mock behaviors (Task 8). Capability-gated: page renders only if `capabilities.features.rollUpload`; otherwise nav entry hidden (02§27).
- Produces:

```ts
// RollServerClient — the ONLY seam WS6 fills in; everything else on this page is device-side KDP
export interface RollServerClient {
  baseUrl: string;                                    // default 'https://kino.acronym.sk'
  testConnection(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  registerDevice(serial: string, product: string, hardwareRevision: string):
    Promise<{ deviceId: string; deviceToken: string }>;   // token shown once, then written to device
  createRoll(opts: { title: string; pin?: string; downloadsEnabled: boolean }):
    Promise<{ rollId: string; slug: string; guestUrl: string; hostUrl: string }>;
}
export class StubRollServerClient implements RollServerClient { /* rejects with 'SERVER_NOT_CONFIGURED' */ }
```

- [x] **Step 1: Write failing tests** — (a) Wi-Fi form submits `NETWORK_SET {ssid, password}` over KDP and the password value never appears in the log store or in any outbound `RollServerClient` call (assert by spying — this is the 05§13 guarantee); (b) saved networks list renders from `NETWORK_LIST` with masked passwords; (c) "Start a Roll" calls `ROLL_CREATE` on the device after server create succeeds, and renders guest QR for `guestUrl`; (d) upload queue renders `UPLOAD_QUEUE_STATUS` counts and "Retry failed" sends `UPLOAD_QUEUE_RETRY`; (e) with `rollUpload:false` capability, nav has no Roll entry.

- [x] **Step 2: Run to verify FAIL.**

- [x] **Step 3: Implement.** Panels top-to-bottom: Server (URL field default locked domain, [Test Server]), Network (list + add form + status lamp `● WIFI CONNECTED`), Roll (current `ROLL_STATUS`; Start a Roll / Join a Roll / Leave Roll; guest QR via `qrcode` `toCanvas`; "Open host dashboard" external link), Upload queue (`3 PENDING · 1 FAILED`, retry button). Copy uses Roll terminology (01§10). Offline note pinned at bottom: "KINO shoots without Wi-Fi. Uploads resume when the Roll server is reachable."

- [x] **Step 4: Run tests + manual pass against mock (create Roll, see QR, watch mock backlog drain).**

- [x] **Step 5: Commit** — `feat(studio): Roll page — Wi-Fi provisioning, roll lifecycle, upload queue, guest QR`

### Task 13: Gallery "Push to Roll" + Studio spec-audit sweep

**Files:**
- Modify: `apps/studio/src/pages/Gallery/*` (add action)
- Modify: `packages/kdp/src/protocol/commands.ts` (+ mock) — add `UPLOAD_ENQUEUE { captureId }`
- Test: extend `apps/studio/tests/rollPage.test.ts`; new `apps/studio/tests/specAudit.test.ts`

**Interfaces:**
- Produces: gallery item action "Push to Roll" (visible only when device reports an active roll via `ROLL_STATUS` and `rollUpload` capability) that sends `UPLOAD_ENQUEUE`; queue count on Roll page reflects it (mock increments backlog).
- Also in this task — close the remaining 02 checklist as an audited sweep with a written result. For each item: verify it exists, implement if missing, record in `docs/studio-spec-audit.md`:
  - 02§14 LUT support: `.cube` import + KINO look JSON, device LUT 17×17×17 (grep hit inconclusive — verify `apps/studio/src/recipes/` handles `.cube`; if not, implement parser: title/LUT_3D_SIZE/data triplets → `Float32Array(17*17*17*3)`, reject non-17 sizes with a clear message, unit-test with a 2-line synthetic cube file scaled up).
  - 02§30 time sync on connect (optional prompt; sets device clock from computer).
  - 02§2 unsupported-browser explanation screen (no Web Serial → explicit message, Demo mode still offered).
  - 02§6 connection strip covers all nine states (Connected/Connecting/Reconnecting/Maintenance/Updating/Recovery/Disconnected/Protocol mismatch/Hardware error).
  - 07§14 capability acceptance: unknown future capability fields tolerated (schema already passthrough — add UI test), version-mismatch banner rendered when device protocol outside supported range.
  - 07§16 gallery scale: virtualization test at 0 / 60 / 2,000 / 10,000 metadata rows — assert render count stays bounded (existing virtualization; add the 10k fixture case using `largeGallery2k` scenario generator parameterized).

- [x] **Step 1: Write failing tests for push-to-roll + each missing audit item** (only the ones the audit finds missing get implementation steps — the audit doc records "already present" for the rest).

- [x] **Step 2: Run to verify FAIL.**

- [x] **Step 3: Implement the gaps.**

- [x] **Step 4: Run full Studio suite.** Run: `npm run test -w @kino/studio`

- [x] **Step 5: Commit** — `feat(studio): push-to-roll + 02/07 spec audit closure` (include `docs/studio-spec-audit.md`)

---

# Workstream 3 — Backend Core (Phase 2)

### Task 14: Dev infra + API scaffold

**Files:**
- Create: `infra/docker-compose.dev.yml`, `infra/.env.example`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`
- Create: `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/src/plugins/db.ts`, `apps/api/src/plugins/redis.ts`, `apps/api/src/plugins/s3.ts`
- Test: `apps/api/tests/health.test.ts`

**Interfaces:**
- Produces: `docker compose -f infra/docker-compose.dev.yml up -d` starts postgres:16, redis:7, minio (+ bucket bootstrap). `buildServer(config): FastifyInstance` (exported for tests — tests build the server in-process, no port binding). `GET /api/healthz` → `{ ok: true, db: true, redis: true, storage: true }`. Config from env: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET=kino-media`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `PUBLIC_BASE_URL=https://kino.acronym.sk`.
- Deps: `fastify@^5`, `drizzle-orm`, `postgres` (driver), `ioredis`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `zod`, `@kino/schemas`; dev: `drizzle-kit`, `vitest`.

- [x] **Step 1: Write compose file**

```yaml
# infra/docker-compose.dev.yml
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: kino, POSTGRES_PASSWORD: kino, POSTGRES_DB: kino }
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: kino, MINIO_ROOT_PASSWORD: kino-secret }
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]
  createbucket:
    image: minio/mc
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "mc alias set local http://minio:9000 kino kino-secret &&
      mc mb -p local/kino-media && mc mb -p local/kino-firmware && exit 0"
volumes: { pgdata: {}, miniodata: {} }
```

- [x] **Step 2: Write failing health test** (`buildServer` + `app.inject({ url: '/api/healthz' })`, expect 200 and all three booleans true — test runs against the compose services; document `docker compose up -d` as a test precondition in `apps/api/README.md`).

- [x] **Step 3: Implement scaffold** — `buildServer` registers db/redis/s3 plugins (fastify decorators `app.db`, `app.redis`, `app.s3`), healthz pings each (`select 1`, `PING`, `HeadBucket`). Structured logging: fastify's pino with request IDs (05§17). Never log request bodies on device routes (Wi-Fi rule is device-side, but belt-and-braces: redact `password` keys in the serializer).

- [x] **Step 4: Run** `npm run test -w @kino/api` → PASS. Add an `api-test` job to CI with `services:` postgres/redis/minio matching compose.

- [x] **Step 5: Commit** — `feat(api): fastify scaffold + dev infra compose + healthz`

### Task 15: Database schema (Drizzle) + migration 0001

**Files:**
- Create: `apps/api/src/db/schema.ts`, `apps/api/drizzle.config.ts`, `apps/api/drizzle/0001_init.sql` (generated)
- Test: `apps/api/tests/db.test.ts`

**Interfaces:**
- Produces (table + column names used by every later API task):

```ts
// apps/api/src/db/schema.ts — implement exactly; types abbreviated here for width
import { pgTable, text, integer, bigint, boolean, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const devices = pgTable('devices', {
  id: text('id').primaryKey(),                       // 'dev_' + nanoid
  serial: text('serial').notNull().unique(),         // 'KD4-00001'
  product: text('product').notNull(),                // 'KINO D4'
  hardwareRevision: text('hardware_revision').notNull(),
  name: text('name'),
  tokenHash: text('token_hash').notNull(),           // sha256 hex of device token
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolls = pgTable('rolls', {
  id: text('id').primaryKey(),                       // 'roll_' + nanoid
  slug: text('slug').notNull().unique(),             // '7F3K9Q' — public, unguessable
  title: text('title').notNull(),
  status: text('status').notNull().default('live'),  // draft|live|closed|archived|trash (03§22)
  privacy: text('privacy').notNull().default('unlisted'), // unlisted|pin  (public deferred, 03§9)
  pinHash: text('pin_hash'),
  downloadsEnabled: boolean('downloads_enabled').notNull().default(true),
  reactionsEnabled: boolean('reactions_enabled').notNull().default(true),
  hostTokenHash: text('host_token_hash').notNull(),
  createdByDeviceId: text('created_by_device_id').references(() => devices.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const captures = pgTable('captures', {
  id: text('id').primaryKey(),                       // 'cap_' + nanoid
  captureUuid: text('capture_uuid').notNull(),       // device-generated (05§9)
  rollId: text('roll_id').notNull().references(() => rolls.id),
  deviceId: text('device_id').notNull().references(() => devices.id),
  mode: text('mode').notNull(),                      // wiggle|quad|single — extensible (03§12)
  look: text('look'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  frameCount: integer('frame_count').notNull(),
  resolution: text('resolution').notNull(),
  timing: jsonb('timing'),                           // { gpioTriggerSkewUs, vsyncPhaseSkewUs, effectiveExposureSkewUs, unavailableReason? }
  status: text('status').notNull().default('created'),
  visible: boolean('visible').notNull().default(true),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),  // trash grace (03§11)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('captures_roll_uuid').on(t.rollId, t.captureUuid),   // idempotency anchor
  index('captures_roll_created').on(t.rollId, t.createdAt),        // feed pagination
]);

export const assets = pgTable('assets', {
  id: text('id').primaryKey(),                       // 'asset_' + nanoid
  captureId: text('capture_id').notNull().references(() => captures.id),
  role: text('role').notNull(),                      // ASSET_ROLES from @kino/schemas
  frameIndex: integer('frame_index'),                // for original-frame
  mime: text('mime').notNull(),
  width: integer('width'), height: integer('height'),
  bytes: bigint('bytes', { mode: 'number' }),
  sha256: text('sha256'),
  objectKey: text('object_key').notNull().unique(),  // rolls/<rollId>/captures/<capId>/... (05§6)
  status: text('status').notNull().default('pending'), // pending|uploading|ready|failed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('assets_capture_role_frame').on(t.captureId, t.role, t.frameIndex)]);

export const uploadSessions = pgTable('upload_sessions', {
  id: text('id').primaryKey(),                       // 'up_' + nanoid
  assetId: text('asset_id').notNull().references(() => assets.id),
  s3UploadId: text('s3_upload_id'),                  // S3 multipart upload id
  bytesExpected: bigint('bytes_expected', { mode: 'number' }).notNull(),
  sha256Expected: text('sha256_expected').notNull(),
  partsReceived: integer('parts_received').notNull().default(0),
  status: text('status').notNull().default('open'),  // open|complete|aborted|failed
  idempotencyKey: text('idempotency_key').notNull().unique(),  // <captureUuid>:<role>:<frameIndex> (05§9)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const uploadParts = pgTable('upload_parts', {
  uploadId: text('upload_id').notNull().references(() => uploadSessions.id),
  partNo: integer('part_no').notNull(),
  bytes: integer('bytes').notNull(),
  etag: text('etag').notNull(),
}, (t) => [uniqueIndex('upload_parts_pk').on(t.uploadId, t.partNo)]);

export const reactions = pgTable('reactions', {
  id: text('id').primaryKey(),
  captureId: text('capture_id').notNull().references(() => captures.id),
  guestId: text('guest_id').notNull(),               // ephemeral cookie id (03§18)
  kind: text('kind').notNull().default('heart'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('reactions_unique').on(t.captureId, t.guestId, t.kind)]);

export const firmwareReleases = pgTable('firmware_releases', {
  id: text('id').primaryKey(),
  release: text('release').notNull(),
  channel: text('channel').notNull().default('stable'),   // stable|beta|dev (05§15)
  compatibleHardware: jsonb('compatible_hardware').notNull(),   // string[]
  protocolMin: integer('protocol_min').notNull(),
  protocolMax: integer('protocol_max').notNull(),
  manifest: jsonb('manifest').notNull(),             // kino.firmware-manifest document
  notes: text('notes'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('firmware_release_channel').on(t.release, t.channel)]);

export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey(),
  rollId: text('roll_id').references(() => rolls.id),
  actor: text('actor').notNull(),                    // 'host' | 'device:<id>' | 'system'
  action: text('action').notNull(),                  // 'capture.hidden', 'roll.closed', ...
  target: text('target'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const processingEvents = pgTable('processing_events', {
  id: text('id').primaryKey(),
  captureId: text('capture_id').notNull().references(() => captures.id),
  job: text('job').notNull(),                        // 'render-wiggle-webp', ...
  status: text('status').notNull(),                  // queued|running|done|failed
  error: text('error'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
```

No media blobs anywhere (05§5). Guest identity is a cookie ID only — no accounts table for guests. Host auth is per-roll `hostTokenHash` for V1 (05§12 "secure account/session **or equivalent host token**"); an accounts table is deliberately deferred until multi-roll host management is real (YAGNI).

- [x] **Step 1: Write failing test** — migration applies to a clean DB; inserting a duplicate `(rollId, captureUuid)` violates the unique index; inserting an asset with duplicate `(captureId, role, frameIndex)` fails.

- [x] **Step 2: Generate + apply migration.** Run: `npx drizzle-kit generate && npx drizzle-kit migrate` (config points at `DATABASE_URL`).

- [x] **Step 3: Run test → PASS.**

- [x] **Step 4: Commit** — `feat(api): postgres schema 0001 — devices, rolls, captures, assets, uploads, firmware, audit`

### Task 16: Auth — device tokens, host tokens, guest PIN session

**Files:**
- Create: `apps/api/src/auth/tokens.ts`, `apps/api/src/auth/plugins.ts`
- Create: `apps/api/src/routes/studio-devices.ts` (`POST /api/studio/devices/register`)
- Test: `apps/api/tests/auth.test.ts`

**Interfaces:**
- Produces:

```ts
// tokens.ts
export function newToken(prefix: 'kdt' | 'hrt'): { token: string; hash: string };
// token = `${prefix}_${base64url(32 random bytes)}`; hash = sha256 hex of full token string
export function hashToken(token: string): string;

// plugins.ts — fastify decorators
// requireDevice: preHandler — Authorization: Bearer kdt_... → req.device = { id, serial } | 401
// requireHost(rollIdParam): preHandler — Authorization: Bearer hrt_... matching rolls.host_token_hash → req.roll | 403
// guestRollAccess: resolves :slug → roll; if privacy==='pin', requires signed cookie `kino_pin_<rollId>`
//   set by POST /api/rolls/:slug/pin { pin } (compares argon2/scrypt pinHash; sets cookie) | 401 PIN_REQUIRED
```

- `POST /api/studio/devices/register` body `{ serial, product, hardwareRevision, name? }` → `{ deviceId, deviceToken }` (token returned exactly once; row stores hash). Re-registering an existing serial rotates the token (old one invalidated) and returns the new one — physical possession of the serial + Studio is the trust anchor for V1; note this in the route comment.
- Scope enforcement (07§25): device token routes live under `/api/device/*` only; host routes under `/api/host/*`; a device token used on a host route is 403; devices can only touch rolls they created or joined (`roll_devices` join check — add small `rollDevices` table `(rollId, deviceId, joinedAt)` in this task's migration 0002).

- [x] **Step 1: Write failing tests** — register returns `kdt_` token; token authenticates `/api/device/ping` (test-only route); tampered token 401; device token on host route 403; host token operates only its own roll (second roll → 403); PIN flow: wrong PIN 401, right PIN sets cookie, subsequent guest reads pass.

- [x] **Step 2: Run → FAIL. Step 3: Implement (scrypt for PIN hash via `node:crypto`, timing-safe compares). Step 4: Run → PASS. Step 5: Commit** — `feat(api): device/host/guest auth with scoped tokens`

### Task 17: Rolls API — create, join, host manage, guest read

**Files:**
- Create: `apps/api/src/routes/device-rolls.ts`, `apps/api/src/routes/host-rolls.ts`, `apps/api/src/routes/guest-rolls.ts`
- Create: `apps/api/src/rolls/slug.ts`
- Test: `apps/api/tests/rolls.test.ts`

**Interfaces:**
- Produces:

```text
POST  /api/device/rolls            {title, pin?, downloadsEnabled?}     → {rollId, slug, guestUrl, hostUrl, hostToken}
POST  /api/device/rolls/join       {slug}                               → {rollId, title, status}   (adds to roll_devices)
GET   /api/device/rolls/current                                          → assigned open rolls for this device
POST  /api/host/rolls              {title, ...}                          → same as device create (host web creation, 03§8)
GET   /api/host/rolls/:rollId                                            → full roll incl. hidden captures, pending counts
PATCH /api/host/rolls/:rollId      {title?|pin?|downloadsEnabled?|status?('live'|'closed'|'archived')} → updated roll
POST  /api/host/rolls/:rollId/regenerate-slug                            → {slug, guestUrl}
GET   /api/rolls/:slug                                                   → guest view: {title, status, photoCount, createdAt} — X-Robots-Tag: noindex, nofollow on ALL /api/rolls/* and /r/* responses
```

- `slug.ts`: `newSlug(): string` — 6 chars from alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O/1/I/L), `crypto.getRandomValues`, retry on unique collision. Internal ID separate from slug (05§14).
- Closed roll: uploads rejected with `ROLL_CLOSED`; guest gallery remains readable (03§22).

- [x] **Step 1: Write failing tests** — create → slug matches `/^[23456789A-HJKMNP-Z]{6}$/`; guest GET works with no auth; PIN-protected roll returns 401 PIN_REQUIRED before PIN cookie; PATCH close then device upload attempt → `ROLL_CLOSED`; regenerate-slug invalidates the old slug (old → 404); every guest response carries the `X-Robots-Tag` header; audit_events row written for close/rename/regenerate.

- [x] **Step 2–5: Run FAIL → implement → run PASS → commit** — `feat(api): roll lifecycle — device create/join, host manage, guest read`

### Task 18: Captures + resumable upload pipeline

**Files:**
- Create: `apps/api/src/routes/device-captures.ts`, `apps/api/src/uploads/uploads.ts`, `apps/api/src/uploads/objectKeys.ts`
- Test: `apps/api/tests/uploads.test.ts`

**Interfaces:**
- Produces the 03§16 endpoints, all under `requireDevice`:

```text
POST /api/device/rolls/:rollId/captures        body: kino.capture document (device-authored)
     → 201 {captureId}  |  200 {captureId} if captureUuid already exists (idempotent replay, 05§9)
POST /api/device/captures/:captureId/assets/init
     body {role, frameIndex?, mime, bytes, sha256}
     → {uploadId, partSize: 5242880, alreadyComplete: false}
     — idempotency key <captureUuid>:<role>:<frameIndex>; replay of a completed upload returns {alreadyComplete: true}
PUT  /api/device/uploads/:uploadId/parts/:partNo    (raw body, ≤ partSize)
     → {received: true, partNo}   — streams to S3 UploadPart; records etag; repeated part overwrite is safe
POST /api/device/uploads/:uploadId/complete
     → 200 {assetId, status:'ready'}  |  422 CHECKSUM_MISMATCH (upload marked failed; device restarts init)
     — CompleteMultipartUpload, then stream object back through sha256 and compare to sha256Expected
       (D4 assets are ≤ ~2 MB JPEGs — re-read verification is cheap and exact)
POST /api/device/captures/:captureId/complete       → recomputes capture.status; enqueues processing jobs (Task 22)
GET  /api/device/captures/:captureId/status         → {status, assets: [{role, frameIndex, status}]}
```

- `objectKeys.ts`: `originalKey(rollId, captureId, frameIndex)` → `rolls/<rollId>/captures/<captureId>/original/cam-<NN>.jpg`; `derivedKey(rollId, captureId, name)` → `.../derived/<name>`; `rollDerivedKey(rollId, name)` → `rolls/<rollId>/derived/<name>` (roll-scoped outputs: Task 21 exports `derived/exports/<jobId>.zip`, Task 25 recaps `derived/recap/<jobId>.mp4`) (05§6). **Immutability guard:** `assertNotOriginalOverwrite(key)` — any write path that would target an existing `original/` key with different sha256 throws; workers may only write under `derived/` (01§7).
- Capture status transitions (05§8): `created` → (thumb or wiggle-preview asset ready) `preview-ready` → (any original uploading) `originals-uploading` → (all declared assets ready) `complete` → (jobs queued) `processing` → (derivatives done) `ready`; `partial` when some originals failed and retries exhausted; `failed` on total loss. Implement as a pure function `nextCaptureStatus(assets: AssetRow[], jobsDone: boolean): CaptureStatus` — unit-tested exhaustively.
- On capture create and each asset completion: `publishRollEvent(redis, rollId, event)` (defined in Task 19; stub it here, Task 19 replaces the stub).

- [x] **Step 1: Write failing tests** — full happy path (create capture → init thumb → 1 part → complete → capture status `preview-ready`); duplicate capture POST returns same id, no second row; duplicate `assets/init` after completion → `alreadyComplete`; part re-send after simulated network drop succeeds; checksum mismatch → 422 + session failed + asset stays `pending`; upload to closed roll → `ROLL_CLOSED`; object key for frame 2 is exactly `rolls/<id>/captures/<id>/original/cam-02.jpg`; worker-style write to an existing original key throws.

- [x] **Step 2–5: FAIL → implement → PASS → commit** — `feat(api): idempotent captures + resumable S3 uploads with checksum verification`

### Task 19: SSE live events

**Files:**
- Create: `apps/api/src/events/publish.ts`, `apps/api/src/routes/guest-events.ts`
- Test: `apps/api/tests/sse.test.ts`

**Interfaces:**
- Produces:

```ts
// publish.ts
export type RollEvent =
  | { type: 'roll.opened' | 'roll.closed' }
  | { type: 'capture.created' | 'capture.updated' | 'capture.hidden' | 'capture.deleted'; captureId: string }
  | { type: 'processing.completed'; captureId: string; role: string };
export async function publishRollEvent(redis: Redis, rollId: string, event: RollEvent): Promise<void>;
// XADD roll:<id>:stream MAXLEN ~ 500 + PUBLISH roll:<id>:events
```

- `GET /api/rolls/:slug/events` (guest auth rules apply): SSE with `retry: 3000`, event id = Redis stream entry id, replay from `Last-Event-ID` header via XRANGE, then live via subscribe; `: heartbeat` comment every 25 s; connection count per roll tracked in Redis (`SCARD` of connection set with TTL refresh) — this feeds the host dashboard "Guests" number (03§10).
- Event payloads carry IDs only; the PWA re-fetches the capture (05§10 flow).

- [x] **Step 1: Write failing tests** — client receives `capture.created` after a publish; reconnect with `Last-Event-ID` replays the missed event exactly once; hidden capture emits `capture.hidden`.

- [x] **Step 2–5: FAIL → implement → PASS → commit** — `feat(api): SSE roll events with Last-Event-ID replay`

### Task 20: Guest feed + asset delivery

**Files:**
- Create: `apps/api/src/routes/guest-captures.ts`, `apps/api/src/routes/assets.ts`
- Test: `apps/api/tests/guest-feed.test.ts`

**Interfaces:**
- Produces:

```text
GET /api/rolls/:slug/captures?cursor=<opaque>&limit=50
    → {items: CaptureView[], nextCursor, hasMore}   — newest first, keyset pagination on (createdAt, id);
      only visible=true, deletedAt IS NULL; CaptureView includes asset summaries {role, assetId, width, height}
GET /api/rolls/:slug/captures/:captureId             → capture detail incl. all ready assets
GET /api/assets/:assetId/content
    → 302 to a presigned S3 GET URL (60 s expiry)  — after checking: roll visible to requester,
      capture visible, and (role==='original-frame' || role==='kino-still') ⇒ roll.downloadsEnabled
      for download-disposition requests; thumbs/previews are always viewable when the roll is viewable.
      Cache-Control: private, max-age=55 on the redirect (RULING: cache lifetime must stay strictly below the 60 s signature lifetime; max-age=300 would serve dead URLs).
```

- Object key never appears in guest responses; asset access is always via `assetId` + authorization check (05§6 "object key is not authorization").

- [x] **Step 1: Write failing tests** — pagination walks 120 captures in 3 pages with no overlap/no gaps; hidden captures absent from guest feed but present in host view; downloads disabled ⇒ original-frame content 403 while thumb still 302s; PIN roll without cookie ⇒ 401.

- [x] **Step 2–5: FAIL → implement → PASS → commit** — `feat(api): guest feed pagination + authorized asset delivery`

### Task 21: Host moderation + export job

**Files:**
- Create: `apps/api/src/routes/host-captures.ts`, `apps/api/src/routes/host-export.ts`
- Test: `apps/api/tests/moderation.test.ts`

**Interfaces:**
- Produces:

```text
POST /api/host/captures/:captureId/hide      → visible=false + capture.hidden event   (03§11: immediate guest removal, retained)
POST /api/host/captures/:captureId/unhide    → visible=true + capture.updated event
DELETE /api/host/captures/:captureId         → deletedAt=now (trash, 7-day grace), capture.deleted event; purge job hard-deletes objects after grace
POST /api/host/rolls/:rollId/export          → {jobId}   — enqueues 'export-roll' (Task 22 queue); job output = ZIP in derived/exports/<jobId>.zip + presigned link (24 h expiry)
GET  /api/host/rolls/:rollId/export/:jobId   → {status, url?}
```

- [x] **Step 1: Write failing tests** — hide removes from guest feed within the same request cycle + SSE event observed; delete → guest 404, host still sees it in trash until purge; export job row created with status queued.

- [x] **Step 2–5: FAIL → implement → PASS → commit** — `feat(api): host moderation with trash grace + export jobs`

---

# Workstream 4 — Processing Workers (Phase 2/7)

### Task 22: Worker scaffold — queue, idempotency, independence

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/src/main.ts`, `apps/worker/src/queue.ts`, `apps/worker/src/jobs/types.ts`
- Modify: `apps/api/src/routes/device-captures.ts` — capture complete enqueues jobs
- Test: `apps/worker/tests/queue.test.ts`

**Interfaces:**
- Produces:

```ts
// jobs/types.ts
export type JobName =
  | 'generate-thumbnail' | 'generate-gallery-still' | 'render-wiggle-webp'
  | 'render-wiggle-mp4' | 'render-contact-sheet' | 'extract-metadata'
  | 'generate-recap' | 'ai-enhance' | 'export-roll' | 'purge-trash';
export interface JobPayload { captureId?: string; rollId?: string; jobKey: string }
// jobKey = `${captureId}:${jobName}` (or `${rollId}:${jobName}:${exportId}`) — BullMQ jobId, so
// re-enqueueing the same work is a no-op (idempotency, 03§19)

// queue.ts
export function enqueue(name: JobName, payload: JobPayload): Promise<void>;
export function registerHandler(name: JobName, fn: (p: JobPayload, ctx: JobCtx) => Promise<void>): void;
// JobCtx = { db, s3, redis, getObject(key): Readable, putDerived(rollId, captureId, name, body, mime): Promise<string> }
// putDerived is the ONLY write path handlers get — it can never write under original/ (01§7)
```

- Retry policy: 5 attempts, exponential backoff starting 10 s. A failed job writes `processing_events` status `failed` and touches nothing else — MP4 failure must not affect originals/thumbs (07§26). Each handler runs in its own try/catch; handlers never share state.
- Enqueue fan-out on capture complete: wiggle capture → `extract-metadata`, `generate-thumbnail`*, `generate-gallery-still`*, `render-wiggle-webp`* (*skipped if the device already uploaded that role — device-uploaded previews take priority, workers fill gaps and upgrade quality, 03§4); quad/single → metadata, thumbnail, still. `render-wiggle-mp4` + `render-contact-sheet` enqueue lazily on first request (host export or guest MP4 ask) — keeps party-time queue short.

- [x] **Step 1: Write failing tests** — same jobKey enqueued twice runs once; a handler that throws marks `processing_events` failed and does not block a different job for the same capture; retry count respects max attempts. (Use a real Redis from compose; fake handlers.)

- [x] **Step 2–5: FAIL → implement → PASS → commit** — `feat(worker): bullmq scaffold with idempotent job keys + independent failure`

### Task 23: Image jobs — thumbnail, gallery still, contact sheet, metadata

**Files:**
- Create: `apps/worker/src/jobs/thumbnail.ts`, `galleryStill.ts`, `contactSheet.ts`, `metadata.ts`
- Test: `apps/worker/tests/imageJobs.test.ts` (fixture JPEGs in `packages/test-fixtures/media/` — generate 4 numbered 1600×1200 test frames with sharp in a fixture script)

**Interfaces:**
- Consumes: capture + original-frame assets from DB/S3.
- Produces assets (roles from `@kino/schemas`):
  - `generate-thumbnail`: source = kino-still if present else frame at `floor(frameCount/2)` (center-ish viewpoint); sharp → 480 px wide WebP q70 → `derived/thumb.webp`, asset role `thumb`.
  - `generate-gallery-still`: source frame same rule; sharp → 1280 px wide WebP q82 → `derived/still.webp`, role `kino-still` (only if device didn't upload one).
  - `render-contact-sheet`: all frames in one row (n across for n frames), 320 px cells, 8 px gutter, label `CAM1..CAMn` bottom-left of each cell, JPEG q85 → `derived/contact-sheet.jpg`, role `contact-sheet`.
  - `extract-metadata`: exif via `exifr` from frame 1 + capture row → JSON `derived/metadata.json`, role `metadata`.
- Every job: insert/update the asset row (status `ready`, sha256, bytes, dimensions), `publishRollEvent(..., { type: 'processing.completed', captureId, role })`.

- [x] **Step 1: Write failing tests** — thumbnail output is WebP, width 480, asset row ready, event published; contact sheet width = n*320 + (n-1)*8; running thumbnail twice produces one asset row (upsert by unique index).

- [x] **Step 2–5: FAIL → implement → PASS → commit** — `feat(worker): thumbnail, gallery still, contact sheet, metadata jobs`

### Task 24: Wiggle renders — animated WebP + MP4

**Files:**
- Create: `apps/worker/src/jobs/wiggleWebp.ts`, `wiggleMp4.ts`
- Create: `packages/media/package.json`, `packages/media/src/sequence.ts`
- Test: `packages/media/tests/sequence.test.ts`, `apps/worker/tests/wiggleJobs.test.ts`

**Interfaces:**
- Produces:

```ts
// packages/media/src/sequence.ts — shared by worker, roll-web player, and studio preview
export type LoopMode = 'bounce' | 'sweep' | 'once';
export function wiggleSequence(frameCount: number, loop: LoopMode, direction: 'ltr' | 'rtl'): number[];
// bounce, 4 frames, ltr → [0,1,2,3,2,1]  (the 01§8 default 1→2→3→4→3→2, zero-indexed)
// sweep,  4 frames, ltr → [0,1,2,3]
// works for any frameCount ≥ 2 — never hard-coded to 4
```

  - `render-wiggle-webp`: frames resized to 960 px wide, animated WebP at capture's fps (default 10), loop forever, q75 → `derived/wiggle.webp`, role `wiggle-webp`. Use sharp's animated webp (`sharp(pages).webp({ ... })` via joined buffer with `pageHeight`) — if sharp's animation limits bite, fall back to `webpmux` via execa; decide in implementation, test only asserts: valid animated WebP (`VP8X` + `ANIM` chunk present), ≥ sequence length frames.
  - `render-wiggle-mp4`: ffmpeg (`ffmpeg-static` + execa): loop the bounce sequence 4×, `-r <fps>`, `-c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart`, 960 px wide → `derived/wiggle.mp4`, role `wiggle-mp4`.

- [x] **Step 1: Write failing sequence tests** — the three loop modes for 4 frames; rtl reverses; frameCount 2 bounce → `[0,1]`... actually `[0,1]` (bounce interior of 2 frames has no middle) — assert `[0,1]`; frameCount 5 bounce → `[0,1,2,3,4,3,2,1]`.

- [x] **Step 2–5: FAIL → implement sequence, then jobs → PASS → commit** — `feat(worker,media): wiggle sequence math + animated WebP/MP4 renders`

### Task 25: Recap + AI-enhance stubs, purge job

**Files:**
- Create: `apps/worker/src/jobs/recap.ts`, `aiEnhance.ts`, `purgeTrash.ts`
- Test: `apps/worker/tests/recap.test.ts`

**Interfaces:**
- `generate-recap` (03§21): input rollId → chronological MP4: 1.2 s per capture (wiggles play one bounce cycle, stills hold), title card first frame ("<ROLL TITLE> — <date>", plain type on dark grey, no decoration), 960 px, → `derived/recap/<jobId>.mp4`. V1 keeps it simple — no music, no transitions.
- `ai-enhance` (03§20): implement the job registration + interface only; handler returns `{ skipped: 'AI_ENHANCE_NOT_CONFIGURED' }` and writes no assets. The interface commits to the rules: input = original frames; output roles `enhanced-still`/`enhanced-wiggle`; never replaces originals; wiggle-safe ops list documented in the handler comment (mild denoise, JPEG cleanup, restrained deblur, 1.5–2× upscale, preserve grain; no face reconstruction).
- `purge-trash`: repeatable job (daily): hard-delete captures where `deletedAt < now() - 7 days` — delete asset objects, then rows, audit event per purge.

- [x] **Steps 1–5: failing test (recap produces playable MP4 with ≥ captureCount segments — probe with ffprobe; purge removes objects + rows; ai-enhance no-ops cleanly) → implement → PASS → commit** — `feat(worker): recap render, purge, ai-enhance stub`

---

# Workstream 5 — KINO Roll Web (guest PWA + host dashboard)

### Task 26: roll-web scaffold + API client + PWA shell

**Files:**
- Create: `apps/roll-web/` (Vite React TS app: `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/api/client.ts`, `src/routes.tsx`)
- Test: `apps/roll-web/tests/client.test.ts`

**Interfaces:**
- Routes: `/r/:slug` (guest), `/r/:slug/c/:captureId` (detail), `/host` (dashboard). Deps: `react`, `react-dom`, `@tanstack/react-virtual`, `vite-plugin-pwa`, `@kino/schemas`, `@kino/media`.
- `src/api/client.ts` produces (consumed by Tasks 27–31):

```ts
export interface RollApi {
  getRoll(slug: string): Promise<RollView>;                       // throws PinRequiredError
  submitPin(slug: string, pin: string): Promise<void>;
  listCaptures(slug: string, cursor?: string): Promise<{ items: CaptureView[]; nextCursor?: string; hasMore: boolean }>;
  getCapture(slug: string, id: string): Promise<CaptureDetail>;
  assetUrl(assetId: string): string;                              // /api/assets/:id/content
  react(slug: string, captureId: string): Promise<void>;
  events(slug: string, lastEventId?: string): EventSource;        // native EventSource w/ withCredentials
}
```

- PWA: `vite-plugin-pwa` with cached app shell, network-first API, cache-first assets; installable manifest (name "KINO Roll", theme per design baseline); install NEVER prompted automatically (03§5).
- HTML head on `/r/*`: `<meta name="robots" content="noindex, nofollow">` (03§9).

- [x] **Steps 1–5: failing client test (PIN flow, cursor passthrough) → implement → PASS → commit** — `feat(roll-web): scaffold, typed API client, PWA shell`

### Task 27: WigglePlayer component

**Files:**
- Create: `apps/roll-web/src/components/WigglePlayer.tsx`
- Test: `apps/roll-web/tests/wigglePlayer.test.tsx`

**Interfaces:**
- Consumes: `wiggleSequence` from `@kino/media`; frame URLs.
- Produces:

```tsx
export function WigglePlayer(props: {
  frames: string[];            // ordered frame URLs (any count ≥ 2)
  fps?: number;                // default 10
  loop?: LoopMode;             // default 'bounce'
  poster?: string;             // shown until frames load / when reduced-motion
  autoPlay?: boolean;          // default true, but see visibility + reduced-motion rules
}): JSX.Element;
```

- Behavior (03§13, §23; 06§14–15): preloads frames via `Image`; steps through `wiggleSequence` on a `requestAnimationFrame` clock at `fps`; renders current frame in an `<img>` (swap `src` from preloaded cache — no canvas needed for V1); pauses when offscreen (IntersectionObserver, threshold 0.25) and when `document.hidden`; `prefers-reduced-motion: reduce` → renders poster with a manual ▶ button (motion is opt-in); tap toggles play/pause; the animated wiggle is the hero — no UI animation competing with it.

- [x] **Step 1: Write failing tests** (vitest + jsdom, fake rAF timer): advances exactly `fps` frames per simulated second in bounce order; unmount cancels rAF; reduced-motion media query mocked → no autoplay, poster + button rendered.

- [x] **Steps 2–5: FAIL → implement → PASS → commit** — `feat(roll-web): WigglePlayer with visibility + reduced-motion handling`

### Task 28: Guest feed — virtualized, live

**Files:**
- Create: `apps/roll-web/src/pages/RollFeed.tsx`, `src/hooks/useRollFeed.ts`, `src/hooks/useRollEvents.ts`
- Test: `apps/roll-web/tests/useRollFeed.test.ts`

**Interfaces:**
- `useRollFeed(slug)` produces `{ captures, loadMore, hasMore, prepend(capture) }` — keyset pagination, newest first (06§11).
- `useRollEvents(slug, handlers)` — SSE subscription: reconnect with stored last event id + exponential backoff (1 s → 30 s cap); pauses EventSource on `pagehide`/`visibilitychange` hidden, resumes + refetches head on visible (mobile sleep/wake, 07§24); on `capture.created` fetches the capture and calls `prepend`; on `capture.hidden`/`deleted` removes it; on `capture.updated`/`processing.completed` refetches that capture (thumbnail may have upgraded — "derivative appears later", 07§24).
- Feed rendering: `@tanstack/react-virtual` vertical list of thumbnail grid rows (3-up mobile, 4-up desktop); only WigglePlayers in/near viewport animate (the player's own IntersectionObserver handles it); header per 06§11: `KINO ROLL / <title> LIVE / 47 photos · 14 Aug 2026`.

- [x] **Steps 1–5: failing hook tests (prepend dedupes by id; hidden removes; reconnect refetches head) → implement → PASS → commit** — `feat(roll-web): live virtualized guest feed`

### Task 29: Capture detail + downloads + share

**Files:**
- Create: `apps/roll-web/src/pages/CaptureDetail.tsx`
- Test: `apps/roll-web/tests/captureDetail.test.tsx`

**Interfaces:**
- Consumes: `getCapture`, `WigglePlayer`, `wiggleSequence`.
- Renders by mode (03§13–14): wiggle → hero player (full-screen toggle) + strip of the n original frames + processed still + metadata block (time, look, resolution) + Download / Share; quad → 2×2 grid (layout derives from frameCount: `ceil(sqrt(n))` columns — not hard-coded 2×2) with recipe labels under each cell; single → still + metadata. Download button hidden entirely when roll `downloadsEnabled === false`; Share uses `navigator.share` when present, else copy-link. Reactions (♡ count + toggle) only when `reactionsEnabled`.

- [x] **Steps 1–5: failing tests (downloads hidden when disabled; quad labels rendered; frameCount 6 → 3-column grid) → implement → PASS → commit** — `feat(roll-web): capture detail for wiggle/quad/single`

### Task 30: PIN gate + roll states

**Files:**
- Create: `apps/roll-web/src/pages/PinGate.tsx`, `src/pages/RollClosed.tsx`
- Modify: `RollFeed.tsx` routing logic
- Test: `apps/roll-web/tests/pinGate.test.tsx`

**Interfaces:**
- `PinRequiredError` from the client routes to PinGate: compact form ("This Roll needs a PIN"), wrong PIN shows inline error, success re-enters feed. Closed roll: banner `CLOSED — <date>` at feed top, everything else readable (03§22). Trash/unknown slug → plain 404 page ("No Roll here.").

- [x] **Steps 1–5: failing tests → implement → PASS → commit** — `feat(roll-web): PIN gate + closed/404 states`

### Task 31: Host dashboard

**Files:**
- Create: `apps/roll-web/src/pages/HostDashboard.tsx`, `src/api/hostClient.ts`
- Test: `apps/roll-web/tests/host.test.tsx`

**Interfaces:**
- Auth: `/host#token=hrt_...` deep link (from Studio or roll creation response) → token kept in sessionStorage, never in URL after load (`history.replaceState`); manual token paste field as fallback.
- Renders the 03§10 dashboard: title, status, device serial, capture count, guest count (SSE connections), pending uploads; actions wired to Task 17/21 endpoints: Show QR (guest URL), Close/Reopen Roll, Download All (export job → poll status → link), rename, set/remove PIN, toggle downloads, regenerate guest slug (confirmation: "Old links stop working."), per-capture hide/unhide/delete from a moderation grid (hidden captures shown dimmed with `HIDDEN` lamp).
- Host client = separate module; host token never sent to guest endpoints.

- [x] **Steps 1–5: failing tests (token from hash stored + stripped; hide action optimistic + reconciled by SSE; export flow polls to link) → implement → PASS → commit** — `feat(roll-web): host dashboard with moderation + export`

---

# Workstream 6 — Studio ↔ Backend (Phase 3)

### Task 32: Real `RollServerClient` + device registration flow

**Files:**
- Create: `apps/studio/src/roll/HttpRollServerClient.ts`
- Modify: `apps/studio/src/pages/Roll/ServerPanel.tsx`, `RollPanel.tsx`
- Test: `apps/studio/tests/httpRollClient.test.ts`

**Interfaces:**
- Implements Task 12's `RollServerClient` against Task 16/17 endpoints. Registration flow: Studio reads serial/product/revision from device truth → `POST /api/studio/devices/register` → writes `{ deviceId, deviceToken, serverUrl }` to the camera via KDP `SET_CONFIG` patch (config section `roll.credentials`) → device token never persisted in Studio storage (only pass-through; 03§17). "Start a Roll" now: server create → device `ROLL_JOIN` with rollId + upload scope → QR + host link shown; host link offered as "Open host dashboard" (deep link with host token).
- Acceptance guard (07§5): all USB device operations still work with no backend reachable — test: with `StubRollServerClient` failing, every other Studio page functions (mock-connect smoke test).

- [x] **Steps 1–5: failing tests (registration writes credential to device not localStorage; offline backend doesn't break Shoot/Gallery) → implement → PASS → commit** — `feat(studio): live Roll server client + device registration`

### Task 33: Firmware catalog integration

**Files:**
- Create: `apps/api/src/routes/firmware.ts` (`GET /api/firmware/releases?hardware=&channel=`, `GET /api/firmware/releases/:release/manifest`, binaries served from `kino-firmware` bucket via presigned URLs; admin upload = `infra/scripts/publish-firmware.ts` CLI for V1, no admin UI)
- Modify: `apps/studio/src/pages/Updates/*` — "Check updates" hits catalog when online; offline keeps cached package flow
- Test: `apps/api/tests/firmware.test.ts`, `apps/studio/tests/updatesCatalog.test.ts`

**Interfaces:**
- Catalog response = array of `kino.firmware-manifest` documents filtered by `compatibleHardware` + protocol range vs the connected device (07§14: incompatible releases marked, not hidden — "Requires newer Studio/protocol"). Studio downloads manifest + binaries, verifies SHA-256 locally before the existing update flow takes over (02§21 requirements already implemented).

- [ ] **Steps 1–5: failing tests (hardware filter; sha mismatch rejected before flash; offline → cached package still installable) → implement → PASS → commit** — `feat: firmware catalog end-to-end`

---

# Workstream 7 — Hardware-Gated Acceptance (Phases 4–6; blocked on physical D4)

These are bench procedures, not code tasks. They run when D4 hardware exists; software prerequisites are all delivered by WS1–WS2 (SerialTransport, Skew Bench, Build Mode, update flow already exist in Studio). Record results in `docs/bench-results/<date>-<bench>.md`.

### 7.1 Real transport validation (Phase 4)
- [ ] Connect real P4 over Web Serial; HELLO negotiates through actual boot spew; capabilities render; unsupported firmware subset produces NACKs, not timeouts (07§6).
- [ ] Disconnect/reconnect mid-session; session ID change detected and Studio resyncs state.

### 7.2 Bring-up ladder (Phase 5, 07§7 — run strictly in this order)
- [ ] 1 P4 connection → 2 one camera node → 3 four camera UARTs → 4 status → 5 one capture → 6 four captures → 7 parallel transfer → 8 SD → 9 common trigger → 10 VSYNC telemetry → 11 Skew Bench → 12 flash → 13 power tests → 14 Wi-Fi → 15 Roll queue. Each rung uses the corresponding Build Mode step; do not skip rungs.

### 7.3 Synchronization acceptance (07§18–19)
- [ ] Skew Bench soak: ≥ 250 triggers; record mean/median/p95/max separately for GPIO / VSYNC / exposure. Pass judgement uses the band table; **never pass sync based only on GPIO ISR timing**.
- [ ] Moving-subject test: repeatable moving target (metronome arm or turntable); compare unaligned vs re-phased sensor timing, flash vs no flash; decide whether motion disparity overwhelms intended parallax at party distances.

### 7.4 UART rate selection (07§22)
- [ ] Stress 921600 / 1.5M / 2M / 3M, all four channels concurrently, ≥ 100 MB per channel per rate. Final baud = highest error-free rate on the real harness (02§25).

### 7.5 Flash + power (07§20–21)
- [ ] Flash at 0.8/1/1.5/2/3 m: clipping, rolling-shutter bands, cross-camera consistency, thermal, voltage sag, resets. If power issues: reduce flash first.
- [ ] Power table: idle / display / 4 cams awake / 4-capture / flash+capture / transfer / Wi-Fi upload. Verify SW6106 low-load shutdown behavior in sleep/idle.

### 7.6 Production updates (Phase 6, 07§17)
- [ ] Update matrix on real hardware: normal P4, normal node, CAM3 mid-update failure, USB disconnect mid-update, bad checksum, wrong-hardware package, reboot failure, rollback, reconnect. All nine must behave per the existing Studio update flow.
- [ ] No irreversible secure-boot/eFuse decisions until recovery is proven (07§8).

### 7.7 Roll queue on-device (07§23)
- [ ] Online / Wi-Fi loss / DNS failure / server down / camera reboot / duplicate retry / partial asset / closed Roll / token expiry. Required: capture never blocked; SD source of truth; queue resumes; server shows zero duplicates (verify by `captures_roll_uuid` uniqueness holding under retry storms).

---

# Workstream 8 — Design System Final Pass (Phase 8)

Applied after WS2 + WS5 flows are stable (07§10). Studio already had an accessibility/contrast pass (Aug 2026); this workstream extracts and enforces.

### Task 34: Extract `@kino/design-system`
- **Files:** Create `packages/design-system/` — tokens (`tokens.css`: cool greys, pale blue utility fills, selected-tab blue, 1px borders/highlights per 06§5), primitives (StatusLamp `●/○/▲/×`, Toolbar, TabStrip, Panel/GroupBox, CompactTable, ClassicProgressBar, UtilitySlider), consumed by both `apps/studio` and `apps/roll-web`.
- [ ] Move Studio's existing token CSS into the package; Studio imports it; visual regression = manual side-by-side (no pixel-diff tooling for V1).
- [ ] Roll-web adopts the family look, simpler + more social: framed thumbnails, small glossy buttons, photo counters, compact tabs (06§10) — while staying touch-friendly and responsive (06§11).
- [ ] Commit — `refactor: shared @kino/design-system`

### Task 35: Anti-slop + accessibility audit (06§16, 07§29)
- [ ] Walk every Studio page and Roll view against the 06§16 reject/accept checklist; file and fix violations (giant cards, oversized headings, decorative status, etc.).
- [ ] Accessibility acceptance: keyboard reachability, visible focus, labels, contrast, reduced motion (WigglePlayer + Studio hooks already honor it), screen-reader status announcements (`aria-live` on connection strip + upload queue), **no color-only status** (lamps always pair symbol + text).
- [ ] Browser matrix: Studio on current Chrome + Edge desktop; Roll on iOS Safari + Android Chrome + desktop (07§28). Record in `docs/acceptance/browser-matrix.md`.
- [ ] Commit — `polish: design-system + a11y audit closure`

---

# Workstream 9 — Production Deployment (kino.acronym.sk)

### Task 36: Production compose + reverse proxy
- **Files:** Create `infra/docker-compose.prod.yml`, `infra/Caddyfile`, `infra/.env.prod.example`
- Containers per 05§2: `kino-proxy` (Caddy — automatic TLS), `kino-web` (static: studio at `/studio`, roll-web at `/` + `/r/*` + `/host`), `kino-api`, `kino-worker`, `kino-postgres`, `kino-redis`, `kino-object-storage` (MinIO, not publicly exposed — presigned URLs proxied via Caddy path or MinIO on subdomain; decide at implementation, default: internal-only MinIO + API-streamed assets fallback if presign hosting is awkward behind one domain).
- Caddyfile routes: `/api/*` → api:3000 (SSE: `flush_interval -1`), `/studio*` → studio static, everything else → roll-web static with SPA fallback; global header `X-Robots-Tag: noindex, nofollow` on `/r/*` and `/host*`.
- [ ] Environments: `local` (compose.dev), `staging` (separate DB/bucket/credentials, subdomain or alt port), `production` (07§11).
- [ ] Rate limits (05§13): `@fastify/rate-limit` — device upload routes 60/min/token, guest reads 300/min/IP, PIN attempts 5/min/IP.
- [ ] Smoke: deploy to staging, run a full happy path (register device via Studio → create Roll → test-uploader pushes a capture → guest sees it live → host closes Roll).
- [ ] Commit — `feat(infra): production compose + caddy for kino.acronym.sk`

### Task 37: Test uploader CLI (Phase 2 requirement, 07§4)
- **Files:** Create `infra/scripts/test-uploader.ts`
- A CLI that impersonates a camera against the real API: registers (or reuses) a device, creates/joins a Roll, uploads fixture captures (from `packages/test-fixtures/media/`) through the full resumable pipeline with configurable failure injection (`--drop-part 3`, `--dup-retry`, `--slow 200ms`). This is how Roll gets exercised before camera firmware exists, and stays as the load-test tool (dozens of viewers × hundreds of captures, 03§24).
- [ ] Steps: failing integration test (uploader against local compose produces a `ready` capture with all assets) → implement → PASS → commit — `feat(infra): camera-simulating test uploader`

### Task 38: Backups + restore drill + observability
- **Files:** Create `infra/scripts/backup.sh`, `infra/scripts/restore-drill.sh`, `docs/runbooks/restore.md`
- [ ] `backup.sh`: nightly `pg_dump -Fc` + `mc mirror` of both buckets to an off-host target; retention 14 daily + 8 weekly (05§16).
- [ ] `restore-drill.sh`: restores dump + objects into a scratch compose stack, then runs an assertion script: every `assets.status='ready'` row's objectKey exists in restored storage and sha256 matches — captures/assets relink correctly (07§27). **The drill must actually be run**, not just written; record the run in the runbook.
- [ ] Observability (05§17): pino structured logs shipped to a file/loki; `/api/metrics` (Prometheus format via `fastify-metrics`): request latency, error rate, upload failures, queue depth (BullMQ counts), SSE connections, active devices; MinIO + disk usage from node exporter. Alert thresholds documented, not over-tooled.
- [ ] Commit — `feat(infra): backups with tested restore drill + metrics`

---

# Acceptance Traceability

Every 07 acceptance section mapped to where it's proven:

| Spec | Proven by |
|---|---|
| 07§12 CI | Task 3 (+ api services job in Task 14) |
| 07§13 decoder/HELLO | Task 7 test suite |
| 07§14 capabilities | Task 5 (passthrough schemas), Task 13 (UI audit), Task 33 (catalog mismatch) |
| 07§15 config schema/migrations | Tasks 4–5 (framework + fixtures), existing Studio backup tests |
| 07§16 gallery 0/60/2k/10k | Task 13 |
| 07§17 firmware update matrix | existing Studio flow + WS7.6 on hardware |
| 07§18–19 sync acceptance | Tasks 10–11 (software), WS7.3 (hardware) |
| 07§20–22 flash/power/UART | WS7.4–7.5 |
| 07§23 roll queue | Task 37 failure injection (server side), WS7.7 (device side) |
| 07§24 live feed | Tasks 19, 28 + Task 37 load run |
| 07§25 permissions | Task 16 scope tests, Task 20 download tests |
| 07§26 workers | Tasks 22–25 independence/idempotency tests |
| 07§27 backup restore | Task 38 drill |
| 07§28 browsers | Task 35 matrix |
| 07§29 accessibility | Task 35 |
| 07§30 definition of done | the union of the above — no happy-path-only sign-off |

Studio production acceptance (02§32) is satisfied by: mock+serial same protocol tests (Tasks 6–8), capability negotiation (existing + Task 13), versioned config (Tasks 4–5), HELLO retries/resync (Task 7), gallery pagination+virtualization (Task 13), update rollback (existing + WS7.6), Build Mode blank→READY (existing + WS7.2), Skew Bench meaningful sensor timing (Tasks 10–11 + WS7.3), Roll setup without CLI (Tasks 12 + 32).

Roll production acceptance (03§30) is satisfied by: no-login guest flow (Tasks 26–30), live feed (19, 28), queue survival (device-side firmware + Task 37 server proof), dedupe (Task 18), moderation (21, 31), long-Roll performance (28 + 37 load), independent jobs (22–25), backups (38), download permissions (20), Wi-Fi credentials never reach backend (Task 12 test + 05§13 redaction in Task 14).

---

# Execution Notes

- **Order:** Tasks 1–9 are strictly sequential-ish (1→2→3, then 4→5, 6→7, 8, 9). After Task 9, WS2 (Tasks 10–13) and WS3 (Tasks 14–21) can run in parallel. WS4 (22–25) and WS5 (26–31) start after Task 19. WS6 after both. WS8/WS9 last. WS7 whenever hardware lands.
- **Firmware:** This plan covers the platform software. D4 firmware (P4 + XIAO camera nodes) implements against `firmware-contract/` (Task 9) and is planned separately — the mock (Task 8) is its behavioral reference.
- **Commit discipline:** every task ends in a commit; never batch multiple tasks into one commit.
- **When a task's test framework choice conflicts with what exists** (e.g. Studio already has vitest patterns), follow the existing pattern — this plan's snippets show intent, the codebase shows house style.
