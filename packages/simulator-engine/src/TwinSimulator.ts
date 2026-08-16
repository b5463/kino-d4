// KINO Twin §6/§11/§12: TwinSimulator layers a boot-stage machine and capture
// choreography over MockKinoDevice. It never bypasses the KDP wire — Studio
// (or any other client attached to `device`) still only ever sees the bytes
// the device writes to its sink; SimEvent is an additive, device-external
// view for the 3D scene (§10/§20).
import { CAM_IDS } from '@kino/kdp';
import type { CamId } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import type { TwinSnapshot } from '@kino/test-fixtures';
import { D4_V1 } from '@kino/hardware-profiles';
import type { HardwareProfile } from '@kino/hardware-profiles';
import { choreographCapture } from './choreography';
import type { BootStage, SimEvent } from './events';

// §21: seed is always concrete, so a session can always be replayed
// byte-for-byte, even when the caller doesn't pass one. Falling back to
// Math.random()/Date.now() here would make TwinSimulator itself the source
// of nondeterminism it exists to eliminate, so an unseeded simulator gets
// this fixed constant instead of a wall-clock/random default.
const DEFAULT_SEED = 1;

// §11: the default simulated identity every fresh Twin presents on
// DEVICE_INFO (Task 4's `setIdentity` knob). HELLO still answers product
// 'KINO' regardless — Studio's handshake (apps/studio/src/app/session.ts)
// rejects anything else, so this patch cannot change that.
const DEFAULT_IDENTITY = { product: 'KINO D4', hardwareRevision: 'D4-V1', serial: 'KD4-SIM-0001' };

// §12: staged boot after the immediate POWER_OFF → BOOTING_P4 transition.
// 400 + 300 + 900 + 250 + 350 = 2,200 ms until READY.
const BOOT_TIMELINE: [BootStage, number][] = [
  ['CAMERA_RAIL_START', 400],
  ['CAMERA_NODES_BOOT', 300],
  ['STORAGE_MOUNT', 900],
  ['NETWORK_INIT', 250],
  ['READY', 350],
];

export class TwinSimulator {
  readonly device: MockKinoDevice;
  readonly seed: number;

  // Stored for later tasks (Task 7's power model, the 3D scene) — Task 6
  // only needs it to seed the default simulated identity's D4 shape.
  private readonly profile: HardwareProfile;

  private stage: BootStage = 'POWER_OFF';
  private readonly listeners = new Set<(e: SimEvent) => void>();
  private readonly bootTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly captureTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly unsubscribeTelemetry: () => void;

  constructor(opts?: { seed?: number; profile?: HardwareProfile; now?: () => number }) {
    this.seed = opts?.seed ?? DEFAULT_SEED;
    this.profile = opts?.profile ?? D4_V1;
    // §21: passed straight through, undefined-transparent — an omitted `now`
    // leaves MockKinoDevice on its own default (real Date.now). Task 8's
    // replay needs a controllable clock through the engine to byte-compare
    // regenerated outbound bytes against recorded ones; TwinSimulator itself
    // never reads or derives from this value.
    this.device = new MockKinoDevice({ seed: this.seed, now: opts?.now });
    this.device.setIdentity(DEFAULT_IDENTITY);

    this.unsubscribeTelemetry = this.device.onTelemetry((telemetry) => {
      this.emit({ t: 'device', telemetry });
      if (telemetry.t === 'capture' && telemetry.phase === 'begin') {
        this.scheduleCapture();
      } else if (telemetry.t === 'reboot') {
        this.runBootSequence();
      }
    });
  }

  /** Staged boot: 400/300/900/250/350 ms → READY. */
  powerOn(): void {
    this.runBootSequence();
  }

  /** → POWER_OFF, force-closes any client attached to `device`. */
  powerOff(): void {
    this.clearBootTimers();
    this.clearCaptureTimers();
    this.setStage('POWER_OFF');
    // The same public path the fault-injection panel uses for a yanked USB
    // cable — no private hook, no bypass of the device's own state machine.
    this.device.setScenario('disconnect', true);
  }

  bootStage(): BootStage {
    return this.stage;
  }

  onEvent(cb: (e: SimEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Delegates to `device.twinSnapshot()`. */
  snapshot(): TwinSnapshot {
    return this.device.twinSnapshot();
  }

  dispose(): void {
    this.clearBootTimers();
    this.clearCaptureTimers();
    this.unsubscribeTelemetry();
    this.listeners.clear();
  }

  private emit(event: SimEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // Best-effort delivery, matching device.onTelemetry: one bad
        // subscriber must not block the rest or the simulator itself.
      }
    }
  }

  private setStage(stage: BootStage): void {
    this.stage = stage;
    this.emit({ t: 'boot', stage });
  }

  /** Walks BOOTING_P4 → READY on the §12 staged delays. A reboot replays the same walk. */
  private runBootSequence(): void {
    this.clearBootTimers();
    this.setStage('BOOTING_P4');
    let elapsed = 0;
    for (const [stage, delayMs] of BOOT_TIMELINE) {
      elapsed += delayMs;
      const atMs = elapsed;
      this.bootTimers.push(setTimeout(() => this.setStage(stage), atMs));
    }
  }

  /**
   * The 'capture'/'begin' telemetry payload carries no per-cam data yet (the
   * device hasn't drawn this capture's jpegKB/durationMs at the instant it
   * fires — see MockKinoDevice.simulateCapture). Those fields land on the
   * cam models synchronously later in that same call, so deferring to a
   * microtask lets this read `device.twinSnapshot()` once that update has
   * happened, instead of the previous capture's stale numbers.
   */
  private scheduleCapture(): void {
    queueMicrotask(() => {
      const snap = this.device.twinSnapshot();
      const cams: Partial<Record<CamId, { jpegKB: number; durationMs: number }>> = {};
      for (const cam of CAM_IDS) {
        // Match MockKinoDevice's own committed-report exclusions
        // (simulateCapture, §18/§20): a bus-down fault is already covered by
        // choreographCapture's own filter (snap.cams[cam].fault), but
        // cam2Timeout skips cam2 for this round without touching its fault
        // field — that has to be checked here, from the device-wide scenario.
        if (cam === 'cam2' && snap.scenarios.cam2Timeout) continue;
        cams[cam] = { jpegKB: snap.cams[cam].jpegKB, durationMs: snap.cams[cam].durationMs };
      }
      const timeline = choreographCapture(snap, cams);
      for (const { atMs, event } of timeline) {
        this.captureTimers.push(setTimeout(() => this.emit(event), atMs));
      }
    });
  }

  private clearBootTimers(): void {
    for (const t of this.bootTimers) clearTimeout(t);
    this.bootTimers.length = 0;
  }

  private clearCaptureTimers(): void {
    for (const t of this.captureTimers) clearTimeout(t);
    this.captureTimers.length = 0;
  }
}
