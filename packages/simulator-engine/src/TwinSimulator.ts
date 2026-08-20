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
import type { BootStage, CaptureStage, SimEvent } from './events';
import { computePower } from './power';
import type { ActivityState } from './power';

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

// Task 7 §15: 2 Hz power sampling while the Twin is powered on.
const POWER_SAMPLE_MS = 500;

export class TwinSimulator {
  readonly device: MockKinoDevice;
  readonly seed: number;

  // Task 6 only needed this to seed the default simulated identity's D4
  // shape; Task 7's power sampler also reads its `power` section.
  private readonly profile: HardwareProfile;

  private stage: BootStage = 'POWER_OFF';
  private readonly listeners = new Set<(e: SimEvent) => void>();
  private readonly bootTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly captureTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly unsubscribeTelemetry: () => void;
  private disposed = false;

  // §21: same default-transparent pattern as MockKinoDevice's own `now` —
  // an omitted clock falls back to real time, a passed one makes every
  // timestamp this reads replay-controllable. Task 7 is the first thing in
  // this class that actually needs wall time (the over-3A dwell timer
  // below), hence this being introduced here rather than in Task 6.
  private readonly now: () => number;

  // Per-cam capture stage, updated as 'cam-stage' events pass through
  // emit() — lets the 2 Hz power sampler know which cams are currently
  // exposing (drawing camActive current) or flushing over UART, without
  // re-deriving that from the device's telemetry stream itself.
  private readonly camStage: Record<CamId, CaptureStage> = {
    cam1: 'IDLE',
    cam2: 'IDLE',
    cam3: 'IDLE',
    cam4: 'IDLE',
  };
  private powerTimer: ReturnType<typeof setInterval> | null = null;
  // The wall-clock ms (per `this.now`) at which battery current first went
  // over the safe-continuous limit, or null while it isn't. computePower is
  // pure — it only evaluates this, it never updates it — so tracking it
  // across samples is this class's job.
  private overAsinceMs: number | null = null;
  // Latches once computePower reports the fuse blown (task-7 review finding
  // #1 — a fast-blow fuse doesn't self-heal, so once true this stays true
  // for the rest of this power-on session regardless of what current does
  // afterward). Cleared only on a power cycle, in stopPowerSampling().
  private fuseBlown = false;

  constructor(opts?: { seed?: number; profile?: HardwareProfile; now?: () => number }) {
    this.seed = opts?.seed ?? DEFAULT_SEED;
    this.profile = opts?.profile ?? D4_V1;
    // §21: passed straight through to the device too, undefined-transparent
    // — an omitted `now` leaves MockKinoDevice on its own default (real
    // Date.now). Task 8's replay needs a controllable clock through the
    // engine to byte-compare regenerated outbound bytes against recorded
    // ones; Task 7's power sampler (`this.now`, above) is the first thing
    // in this class to also use it directly, for the over-3A dwell timer.
    this.now = opts?.now ?? Date.now;
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
    this.startPowerSampling();
    this.runBootSequence();
  }

  /** → POWER_OFF, force-closes any client attached to `device`. */
  powerOff(): void {
    this.clearBootTimers();
    this.clearCaptureTimers();
    this.stopPowerSampling();
    // Idempotent controls matter once Task 18 wires this to a UI: clicking
    // POWER OFF twice must not emit a second fake transition or link-drop.
    if (this.stage === 'POWER_OFF') return;
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
    if (this.disposed) return;
    this.disposed = true;
    this.clearBootTimers();
    this.clearCaptureTimers();
    this.stopPowerSampling();
    this.unsubscribeTelemetry();
    this.listeners.clear();
  }

  private emit(event: SimEvent): void {
    if (this.disposed) return;
    // Tracked here rather than re-derived from device telemetry: every
    // cam-stage transition the choreography produces passes through this
    // one method, so this is the single point that needs to know about it.
    if (event.t === 'cam-stage') this.camStage[event.cam] = event.stage;

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

  private startPowerSampling(): void {
    if (this.powerTimer !== null) return; // already running (e.g. a reboot mid-session)
    this.powerTimer = setInterval(() => this.samplePower(), POWER_SAMPLE_MS);
  }

  private stopPowerSampling(): void {
    if (this.powerTimer !== null) clearInterval(this.powerTimer);
    this.powerTimer = null;
    this.overAsinceMs = null;
    // A power cycle is the only thing that clears a blown fuse (replacing
    // it, in the real hardware this models) — see the `fuseBlown` field.
    this.fuseBlown = false;
  }

  /** §15/§7: one computePower call against the Twin's current activity, emitted as a 'power' SimEvent. */
  private samplePower(): void {
    const activity = this.deriveActivity();
    const nowMs = this.now();
    const sample = computePower(this.profile.power, this.profile.power.loads, activity, {
      overAsinceMs: this.overAsinceMs,
      nowMs,
      fuseBlown: this.fuseBlown,
    });

    // computePower only evaluates the over-3A dwell timer and the fuse
    // latch; advancing both for the next sample is this class's job (see
    // the `overAsinceMs`/`fuseBlown` fields).
    if (sample.batteryA > this.profile.power.battery.safeContinuousA) {
      if (this.overAsinceMs === null) this.overAsinceMs = nowMs;
    } else {
      this.overAsinceMs = null;
    }
    if (sample.fuse === 'blown') this.fuseBlown = true;

    this.emit({ t: 'power', sample });
  }

  /**
   * Derives §15's ActivityState from what this class already tracks: the
   * boot stage (is the P4 even on), the per-cam capture stage (exposing vs.
   * transferring vs. idle), and the device's own public snapshot (cam
   * faults, wifi upload activity, flash calibration level). There's no
   * device-side "is flash armed for this shot" signal yet — that config
   * lives inside MockKinoDevice's private wiggle config — so a cam mid-
   * exposure is treated as firing the calibrated flash current unless a
   * flash-disabling scenario is armed. Charging has no device signal at all
   * yet (no USB-insertion concept exists), so it always reads 0 for now.
   */
  private deriveActivity(): ActivityState {
    const snap = this.device.twinSnapshot();
    const p4On = this.stage !== 'POWER_OFF';

    const camsOn = p4On
      ? CAM_IDS.filter((cam) => snap.cams[cam].fault !== 'offline' && snap.cams[cam].fault !== 'power-open')
      : [];
    const camsCapturing = camsOn.filter((cam) => this.camStage[cam] === 'EXPOSING');
    const uartActive = camsOn.filter((cam) => this.camStage[cam] === 'TRANSFERRING');

    const flashFires = camsCapturing.length > 0 && !snap.scenarios.flashOverload && !snap.scenarios.flashUnavailable;
    const flashLevel = this.device.getCalibration().flash.level;
    const flashA: ActivityState['flashA'] = flashFires
      ? flashLevel === 'low'
        ? 0.35
        : flashLevel === 'medium'
          ? 0.5
          : 0.65
      : 0;

    return {
      p4On,
      camsOn,
      camsCapturing,
      uartActive,
      flashA,
      wifiUploading: snap.uploads.uploading > 0,
      chargingA: 0,
    };
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
      // dispose() can run after device telemetry queued this work but before
      // the microtask checkpoint. Do not create fresh, untracked timers for
      // a simulator whose teardown already cleared its timer arrays.
      if (this.disposed) return;
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
