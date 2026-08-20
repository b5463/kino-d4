// KINO Twin §21: recording turns a live TwinSimulator session into one
// `.kino-sim.json` document — every raw KDP byte crossing the wire in each
// direction, the fault-injection actions that ran alongside them, and the
// simulator's own SimEvent stream for UI scrubbing. Replay (replay.ts) drives
// a fresh device from this doc directly over `device.receive` — never a JSON
// side-channel around protocol behavior (§10/§20).
import { z } from 'zod';
import { defineSchema } from '@kino/schemas';
import { D4_V1 } from '@kino/hardware-profiles';
import type { CamId } from '@kino/kdp';
import type { CamFault } from '@kino/test-fixtures';
import type { TwinSimulator } from './TwinSimulator';
import type { SimEvent } from './events';

// ---- base64 <-> bytes ----
// No @types/node in this monorepo (Task 3's history): Uint8Array bytes go
// through the DOM `btoa`/`atob` pair instead of Node's Buffer, the same way
// @kino/test-fixtures' own determinism test avoids Buffer entirely.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Exported so replay.ts (and any doc consumer) can decode 'in'/'out' entries without duplicating this. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Mirrors @kino/kdp's CamId union: kept local because zod's `enum` needs a
// literal tuple, not the mutable `CamId[]` that `CAM_IDS` actually exports.
const CAM_ID_VALUES = ['cam1', 'cam2', 'cam3', 'cam4'] as const satisfies readonly CamId[];
// Mirrors @kino/test-fixtures' CamFault union, for the same reason — that
// package exports CamFault only as a type, with no matching runtime array.
const CAM_FAULT_VALUES = [
  'offline',
  'power-open',
  'sensor-missing',
  'no-vsync',
  'slow-uart',
  'crc-noise',
] as const satisfies readonly CamFault[];

const inEvent = z.object({ atMs: z.number(), kind: z.literal('in'), b64: z.string() }).passthrough();
const outEvent = z.object({ atMs: z.number(), kind: z.literal('out'), b64: z.string() }).passthrough();
const scenarioFaultEvent = z
  .object({
    atMs: z.number(),
    kind: z.literal('fault'),
    op: z.literal('scenario'),
    // A ScenarioFlags key, deliberately left as an open string rather than
    // enumerated: an old recording must stay parseable against a future
    // scenario list (07§14 forward-compat), same reasoning as this package's
    // `deviceCapabilities.features`.
    key: z.string(),
    value: z.boolean(),
  })
  .passthrough();
const camFaultEvent = z
  .object({
    atMs: z.number(),
    kind: z.literal('fault'),
    op: z.literal('camFault'),
    cam: z.enum(CAM_ID_VALUES),
    fault: z.union([z.enum(CAM_FAULT_VALUES), z.null()]),
  })
  .passthrough();
const simEvent = z
  .object({
    atMs: z.number(),
    kind: z.literal('sim'),
    // SimEvent is an additive, evolving union (events.ts) — this schema only
    // checks the one thing every variant shares (a string `t` tag), rather
    // than re-enumerating each shape here.
    event: z.custom<SimEvent>(
      (v) => typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string',
    ),
  })
  .passthrough();

/** `kino.sim-session` v1 (§21): one recorded TwinSimulator session, replayable byte-for-byte. */
export const simSessionDoc = defineSchema({
  schema: 'kino.sim-session',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.sim-session'),
      version: z.literal(1),
      seed: z.number(),
      profile: z.string(),
      startedAtIso: z.string(),
      events: z.array(z.union([inEvent, outEvent, scenarioFaultEvent, camFaultEvent, simEvent])),
    })
    .passthrough(),
  migrations: {},
});
export type SimSessionDoc = z.infer<typeof simSessionDoc.shape>;
export type SimSessionEvent = SimSessionDoc['events'][number];

export class SimRecorder {
  // Own clock, defaulting to Date.now like every other class in this engine
  // (TwinSimulator, MockKinoDevice) — under a test's `vi.useFakeTimers()`
  // this advances in lockstep with the simulator's own default clock (they
  // are literally the same global function), which is what makes the
  // recorded `atMs` offsets line up with the simulator's internal timeline.
  private readonly now: () => number = Date.now;
  private active = false;
  private startedAtMs = 0;
  private startedAtIso = '';
  private readonly seed: number;
  private events: SimSessionEvent[] = [];

  /**
   * Taps `sim.onEvent` — the one stream that already carries both
   * TwinSimulator's own SimEvents (boot/cam-stage/sync-pulse/uart/power) and
   * every device telemetry event forwarded as `{t:'device', telemetry}` (see
   * TwinSimulator's constructor), so this single subscription is the
   * "onTelemetry/onEvent" tap. It never sees the raw KDP byte streams —
   * those are wired separately through noteIn/noteOut below, by whatever
   * sits between Studio and the device (a test here; Task 9's
   * TwinDeviceServer in production).
   */
  constructor(sim: TwinSimulator) {
    this.seed = sim.seed;
    sim.onEvent((e) => this.handleSimEvent(e));
  }

  private handleSimEvent(e: SimEvent): void {
    if (!this.active) return;
    const atMs = this.elapsedMs();
    if (e.t === 'device' && e.telemetry.t === 'scenario') {
      this.events.push({ atMs, kind: 'fault', op: 'scenario', key: e.telemetry.key, value: e.telemetry.value });
      return;
    }
    if (e.t === 'device' && e.telemetry.t === 'camFault') {
      this.events.push({ atMs, kind: 'fault', op: 'camFault', cam: e.telemetry.cam, fault: e.telemetry.fault });
      return;
    }
    this.events.push({ atMs, kind: 'sim', event: e });
  }

  /** Raw KDP bytes the host sent to the device. */
  noteIn(bytes: Uint8Array): void {
    if (!this.active) return;
    this.events.push({ atMs: this.elapsedMs(), kind: 'in', b64: bytesToBase64(bytes) });
  }

  /** Raw KDP bytes the device wrote back. */
  noteOut(bytes: Uint8Array): void {
    if (!this.active) return;
    this.events.push({ atMs: this.elapsedMs(), kind: 'out', b64: bytesToBase64(bytes) });
  }

  start(): void {
    this.events = [];
    this.startedAtMs = this.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
    this.active = true;
  }

  stop(): SimSessionDoc {
    this.active = false;
    return {
      schema: 'kino.sim-session',
      version: 1,
      seed: this.seed,
      // @kino/hardware-profiles exports exactly one profile today, so
      // recording its id here is accurate for every simulator that exists in
      // this codebase. TwinSimulator's own `profile` field is private (no
      // getter) — a future multi-profile Twin would need one to do better
      // than this.
      profile: D4_V1.profile,
      startedAtIso: this.startedAtIso,
      events: this.events,
    };
  }

  recording(): boolean {
    return this.active;
  }

  private elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }
}
