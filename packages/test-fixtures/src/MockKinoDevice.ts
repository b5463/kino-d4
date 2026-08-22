// The demo KINO. Implements the device side of the framed protocol so the
// full stack above the transport (decoder, client, device facade, UI) runs
// unchanged against it. State survives simulated reboots, like real NVS.

import { Cmd, Evt, FrameFlags, PROTOCOL_VERSION } from '@kino/kdp';
import { FrameDecoder, encodeFrame, encodeJson, decodeJson } from '@kino/kdp';
import type { Frame } from '@kino/kdp';
import type {
  CamId,
  CameraFocus,
  CameraInfo,
  CameraLinkStats,
  CamCalibration,
  FocusMode,
  HwValidationItem,
  KinoConfig,
  LogEntry,
  LogSource,
  SelfTestCheck,
  StorageSelfTestPhase,
  StorageSelfTestResult,
  TargetId,
} from '@kino/kdp';
import { CAM_IDS, NEUTRAL_CAL } from '@kino/kdp';
import type { MockDeviceLike } from '@kino/kdp';
import type { DeviceRecipe } from './recipes';
import { validateDeviceRecipe } from './recipes';
import { FACTORY_RECIPES } from './factoryRecipes';
import { BUILTIN_SHUTTER_SOUNDS } from '@kino/kdp';
import type { SoundInfo } from '@kino/kdp';
import { encodeWav, SOUND_SAMPLE_RATE } from './deviceAudio';
import { sha256Hex } from './sha256';
import type { ScenarioFlags, CamFault } from './scenarios';
import { DEFAULT_SCENARIOS } from './scenarios';
import { MockMediaStore, renderPreviewFrame } from './MockMediaStore';
import type { TwinTelemetry, TwinSnapshot } from './telemetry';
import { FIRMWARE_PROFILES, PROFILE_FOR_VERSION } from './firmwareProfiles';
import type { FirmwareProfileId } from './firmwareProfiles';

/**
 * A virtual sensor (issue #72): supplies real JPEG bytes for previews,
 * capture frames, and thumbnails — the Twin renders its 3D scene from each
 * camera's optical center and feeds the result here. Null (or a thrown
 * error) falls back to the synthesized placeholder art, so protocol tests
 * and the Node environment stay deterministic.
 */
export interface MockFrameRequest {
  cam: CamId;
  kind: 'preview' | 'capture' | 'thumb';
  width: number;
  height: number;
  phaseMs: number;
  /** The flash fires during this exposure (issue #75): config.wiggle.flash
   * held at capture time, minus the flashUnavailable fault. The frame source
   * lights the photograph accordingly; previews never flash. */
  flash?: boolean;
}
export type MockFrameSource = (req: MockFrameRequest) => Promise<Uint8Array | null> | Uint8Array | null;

// Per-camera UART link counters (Milestone 1B, CAMERA_LINK_STATS).
interface LinkCounters {
  rxFrames: number;
  txFrames: number;
  rxBytes: number;
  txBytes: number;
  crcErrors: number;
  decoderResyncs: number;
  timeouts: number;
  retries: number;
  duplicateFrames: number;
  lastSequence: number;
  lastError: string | null;
}

function freshLinkCounters(): LinkCounters {
  return {
    rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, crcErrors: 0,
    decoderResyncs: 0, timeouts: 0, retries: 0, duplicateFrames: 0,
    lastSequence: 0, lastError: null,
  };
}

/** mulberry32 — a job that reports numbers has to report the same ones twice. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultConfig(): KinoConfig {
  return {
    mode: 'wiggle',
    wiggle: {
      resolution: '1600x1200',
      flash: true,
      fps: 10,
      loop: 'bounce',
      direction: 'ltr',
      recipeId: 'party-neg',
      previewCam: 'cam2',
      jpegQuality: 86,
      denoise: 1,
      sharpness: 1,
      saveOriginals: true,
    },
    quad: {
      flash: true,
      slots: {
        cam1: { recipeId: 'party-neg', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: '' },
        cam2: { recipeId: 'motion', exposureBias: 0.3, gain: 'low', flash: 'skip', colorMode: 'recipe', note: 'blur' },
        cam3: { recipeId: 'raw-digi', exposureBias: 0, gain: 'auto', flash: 'fire', colorMode: 'recipe', note: 'raw' },
        cam4: { recipeId: 'mono', exposureBias: -0.3, gain: 'high', flash: 'fire', colorMode: 'mono', note: 'b/w' },
      },
    },
    shoot: {
      flashMode: 'auto',
      viewfinder: 'cam2',
      previewQuality: 'normal',
      shutterSound: 'cheap-digi',
      volume: 6,
      displayAfterShotS: 2,
    },
    body: {
      brightness: 7,
      autoDimS: 20,
      sleepS: 120,
      camIdleTimeoutS: 180,
      sounds: { startup: true, ui: false, save: true, warning: true },
      buttons: { fn: 'flash', slide: 'mode' },
    },
  };
}

function neutralCalibration() {
  return {
    reference: 'cam2' as CamId,
    cams: {
      cam1: { ...NEUTRAL_CAL },
      cam2: { ...NEUTRAL_CAL },
      cam3: { ...NEUTRAL_CAL },
      cam4: { ...NEUTRAL_CAL },
    },
    capturedAt: null as string | null,
    saved: true,
    order: ['cam1', 'cam2', 'cam3', 'cam4'] as [CamId, CamId, CamId, CamId],
    orderVerifiedAt: null as string | null,
    spacingMm: [0, 19, 38, 57] as [number, number, number, number],
    spacingSource: 'nominal' as 'nominal' | 'measured',
    flash: {
      level: 'medium' as 'low' | 'medium' | 'high',
      distance: '1-2' as '0.5-1' | '1-2' | '2-3',
      calibratedAt: null as string | null,
    },
  };
}

interface FwSession {
  id: number;
  target: TargetId;
  size: number;
  sha256: string;
  version: string;
  received: number;
  failAt: number | null; // byte offset at which to inject a failure
  // The received image, assembled by offset so duplicated or re-sent chunks
  // land idempotently. Held so FW_END can actually verify sha256 — a
  // reference device that answers `verified: true` without hashing teaches
  // Studio to trust theatre.
  image: Uint8Array;
}

interface SoundSession {
  id: number;
  info: SoundInfo;
  data: Uint8Array;
  received: number;
}

const MAX_CUSTOM_SOUNDS = 8;
const MAX_SOUND_KB = 128;

/** Captures on the card in the demo party, and under the 04 §19 2k scenario. */
const DEMO_GALLERY_SIZE = 22;
const LARGE_GALLERY_SIZE = 2048;

/** How often the backed-up upload queue moves one item along. */
const UPLOAD_TICK_MS = 1200;

/**
 * A command's normal turnaround, and what `delayedResponses` stretches it to.
 * The slow figure sits under the client's 3 s default so commands crawl rather
 * than fail — the point of 04 §19's "delayed responses" is a device that is
 * technically alive, which is harder on a UI than one that is plainly gone.
 */
const SLOW_RESPONSE_MS: [number, number] = [1400, 2400];

/**
 * How long the coalescing scenario holds outbound frames before flushing them
 * as one write. Comfortably wider than the 8–26 ms dispatch latency, so two
 * commands issued together reliably come back in a single read — the point of
 * the scenario is that grouping, not the delay.
 */
const COALESCE_WINDOW_MS = 40;

/** One demo clip so the simulator shows the custom-sound flow populated. */
function demoSounds(): Map<string, { info: SoundInfo; data: Uint8Array }> {
  const durationMs = 320;
  const frames = Math.round((SOUND_SAMPLE_RATE * durationMs) / 1000);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / SOUND_SAMPLE_RATE;
    samples[i] = Math.sin(2 * Math.PI * 1318.5 * t) * Math.exp(-t * 9) * 0.6;
  }
  const data = encodeWav(samples, SOUND_SAMPLE_RATE);
  const info: SoundInfo = { id: 'snd-ding', name: 'ding', sizeBytes: data.length, durationMs };
  return new Map([[info.id, { info, data }]]);
}

interface CamModel {
  fw: string;
  lastCaptureAt: number;
  jpegKB: number;
  durationMs: number;
  gpioSkewUs: number;
  uartErrors: number;
  updating: boolean;
  rebootUntil: number;
  /** KINO Twin §20 per-camera fault, independent of the device-wide ScenarioFlags. */
  fault: CamFault | null;
  /** Capability-driven sensor identity (audit #55): behavior keys off this,
   * never off a global assumption. OV3660 has no focus surface at all. */
  sensorProfile: 'OV3660' | 'OV5640_AF';
  /** Null on OV3660 — no lens to drive, nothing to report. */
  focus: CameraFocus | null;
  /** SIMULATED exposure window (audit #56) until real sensor timing exists. */
  exposureUs: number;
}

/** Saved Wi-Fi network as the device keeps it (05 §13). */
interface SavedNetwork {
  ssid: string;
  /** Never leaves the device. NETWORK_LIST reports MASKED_PASSWORD instead. */
  password: string;
  security: 'wpa2' | 'wpa3' | 'open';
  autoJoin: boolean;
  lastSeen: number | null;
}

/**
 * What NETWORK_LIST reports in place of a stored password (05 §13). The
 * device knows the secret; nothing that leaves the camera ever contains it.
 */
const MASKED_PASSWORD = '••••';

interface RollState {
  rollId: string;
  slug: string;
  guestUrl: string;
  name: string;
  role: 'host' | 'guest';
  joinedAt: number;
}

interface UploadQueue {
  pending: number;
  uploading: number;
  failed: number;
  uploaded: number;
}

/** A running async job (04 §15). */
interface JobState {
  id: string;
  cmd: number;
  step: number;
  steps: number;
}

const ROLL_WORDS = ['amber', 'harbor', 'meridian', 'saltbox', 'lantern', 'cobalt'];

export class MockKinoDevice implements MockDeviceLike {
  readonly scenarios: ScenarioFlags = { ...DEFAULT_SCENARIOS };

  // Every random draw and every timestamp inside this class goes through
  // these two. Unseeded, they are Math.random/Date.now — same as before this
  // class took constructor options. Seeded, replay is byte-for-byte (§21).
  private readonly rng: () => number;
  private readonly now: () => number;

  private sink: ((data: Uint8Array) => void) | null = null;
  private forceCloseCb: (() => void) | null = null;
  private scenarioCb: (() => void) | null = null;
  // KINO Twin §5/§10 telemetry tap: additive, device-side observation surface
  // for the Twin's 3D view. Never a substitute for the raw KDP bytes above —
  // Studio reads only those; this Set exists for the simulator's own render.
  private readonly telemetryListeners = new Set<(e: TwinTelemetry) => void>();
  private readonly decoder = new FrameDecoder();
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** Timers for an in-flight capture's exposure → transfer → SD commit chain
   * (issue #75). Deliberately NOT connection-scoped: unplugging the host
   * cable right after CAMERA_CAPTURE acks must not lose the photograph —
   * the commit is device-internal. Reboot and dispose still cancel them. */
  private captureTimers: ReturnType<typeof setTimeout>[] = [];
  private logTimer: ReturnType<typeof setTimeout> | null = null;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  // Studio's demo device shoots on its own so its gallery/logs stay lively.
  // A real idle D4 does not — the Twin builds with this off, so every capture
  // in the 3D view was commanded by someone.
  private readonly ambientCaptures: boolean;

  // Set in the constructor, after this.now is available (see below).
  private bootedAt: number;
  private bootBlockedUntil = 0;
  private resetReason = 'power-on';
  private maintenance = false;
  private batteryV = 4.02;
  private sdFreeMB = 27431;
  private p4Fw = '0.1.0';
  // Set in the constructor: freshCams() draws from this.now()/this.randInt().
  private cams: Record<CamId, CamModel>;
  private config = defaultConfig();
  private calibration = neutralCalibration();
  private customRecipes = new Map<string, DeviceRecipe>();
  private customSounds = demoSounds();
  private soundSession: SoundSession | null = null;
  private soundSessionCounter = 500;
  private logBuffer: LogEntry[] = [];
  private fwSession: FwSession | null = null;
  private fwSessionCounter = 100;
  private fwStates: Record<TargetId, { state: string; error?: string }> = {
    cam1: { state: 'idle' }, cam2: { state: 'idle' }, cam3: { state: 'idle' }, cam4: { state: 'idle' }, p4: { state: 'idle' },
  };
  private camTimeouts = 0;
  private sdErrors = 0;
  private captureCounter = 137;
  private readonly media = new MockMediaStore();
  private configRevision = 3;
  private uartBaud = 921600;
  /** KINO Twin §20 batterySag: end of the transient dip a capture just triggered. */
  private batterySagUntil = 0;
  /** KINO Twin §11: patch merged into GET_CAPABILITIES.capabilities; null = no override. */
  private capabilityOverrides: Record<string, boolean> | null = null;

  // ---- identity (04 §4 / §17) ----
  // deviceId is the unit. sessionId is this boot of it: a host that sees a
  // different one on reconnect knows every cached handle it holds is stale.
  private readonly deviceId = 'kino-000012';
  private bootCount = 1;
  private sessionId = 'boot-1';
  // KINO Twin §11/§13 identity override, DEVICE_INFO only — HELLO always
  // answers product 'KINO' (apps/studio session.ts rejects anything else).
  private identity = { serial: 'KINO000012', hardwareRevision: 'V1', product: 'KINO' };

  // ---- network / roll (04 §7) ----
  // Set in the constructor: lastSeen draws from this.now().
  private networks: SavedNetwork[];
  private roll: RollState | null = null;
  /** The server credential is write-only configuration and never leaves GET_CONFIG. */
  private rollCredentials: { deviceId: string; deviceToken: string; serverUrl: string } | null = null;
  private rollCounter = 0;
  private uploads: UploadQueue = { pending: 0, uploading: 0, failed: 0, uploaded: 118 };
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- async jobs (04 §15) ----
  private jobs = new Map<string, JobState>();
  private jobCounter = 0;

  // ---- firmware profile + virtual sensor (issue #72) ----
  private firmwareProfileId: FirmwareProfileId = 'd4-sim-full';
  private frameSource: MockFrameSource | null = null;

  // ---- Milestone 1B bench diagnostics (issue #66) ----
  private storageWriteTest: 'none' | 'pass' | 'fail' = 'none';
  private storageMountAttempts = 1;
  /** memoryLeak scenario: node heap drained per capture, never recovered. */
  private leakKB = 0;
  private soakRunning = false;
  private linkStats: Record<CamId, LinkCounters> = {
    cam1: freshLinkCounters(),
    cam2: freshLinkCounters(),
    cam3: freshLinkCounters(),
    cam4: freshLinkCounters(),
  };

  // ---- outbound shaping (04 §19 split / coalesced frames) ----
  private coalesceBuffer: Uint8Array[] = [];
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  // Each OV3660 free-runs on its own clock. Phase = where that sensor sits
  // in its frame cycle relative to CAM2. Untouched sensors start scattered
  // across the whole 33 ms frame interval, which is the real synchronization
  // problem — the GPIO edge is common, the frame timelines are not.
  private readonly frameIntervalUs = 33_333;
  private camPhaseUs: Record<CamId, number> = {
    cam1: 7_420,
    cam2: 0,
    cam3: 21_880,
    cam4: 2_910,
  };
  private phaseAligned = false;

  /**
   * Unseeded (no opts, the default): behavior is exactly what it was before
   * this constructor existed — Math.random()/Date.now() throughout.
   * Seeded: one mulberry32 stream (module `seeded()`) drives every random
   * draw, and every timestamp comes from `now` instead of the wall clock, so
   * the same seed + the same inbound bytes reproduce the same outbound bytes.
   */
  constructor(opts?: { seed?: number; now?: () => number; ambientCaptures?: boolean }) {
    this.rng = opts?.seed !== undefined ? seeded(opts.seed) : Math.random;
    this.now = opts?.now ?? Date.now;
    this.ambientCaptures = opts?.ambientCaptures ?? true;
    // These used to be field initializers, but they draw from this.now()/
    // this.randInt() and so must run after the two lines above.
    this.bootedAt = this.now();
    this.cams = this.freshCams('0.1.0');
    this.networks = [
      { ssid: 'kino-bench', password: 'benchwifi2026', security: 'wpa2', autoJoin: true, lastSeen: this.now() - 40_000 },
      { ssid: 'loft-guest', password: 'partytime', security: 'wpa2', autoJoin: false, lastSeen: null },
    ];
  }

  private rand(lo: number, hi: number): number {
    return lo + this.rng() * (hi - lo);
  }

  private randInt(lo: number, hi: number): number {
    return Math.round(this.rand(lo, hi));
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  /** ISO timestamp fields (calibration's *At markers) route through this.now() too. */
  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private freshCams(fw: string): Record<CamId, CamModel> {
    const cam = (): CamModel => ({
      fw,
      lastCaptureAt: this.now() - this.randInt(40_000, 300_000),
      jpegKB: this.randInt(320, 520),
      durationMs: this.randInt(140, 260),
      gpioSkewUs: this.randInt(80, 400),
      uartErrors: this.randInt(0, 2),
      updating: false,
      rebootUntil: 0,
      fault: null,
      sensorProfile: 'OV3660',
      focus: null,
      exposureUs: 16_667 + this.randInt(-400, 400),
    });
    return { cam1: cam(), cam2: cam(), cam3: cam(), cam4: cam() };
  }

  /**
   * Swap one camera node's sensor profile (audit #55). OV5640_AF grows a
   * focus surface; OV3660 has none. The device-level autofocus capability is
   * derived, never assumed — one AF module on the bench is enough to light
   * the surface for that camera only.
   */
  setSensorProfile(id: CamId, profile: 'OV3660' | 'OV5640_AF'): void {
    const cam = this.cams[id];
    cam.sensorProfile = profile;
    cam.focus =
      profile === 'OV5640_AF'
        ? { mode: this.config.wiggle.focusMode ?? 'party-auto', state: 'idle', vcmPosition: null, estimatedDistanceM: null, locked: false }
        : null;
    this.log('P4', `${id.toUpperCase()} sensor profile: ${profile}`);
    this.scenarioCb?.();
  }

  private hasAutofocus(): boolean {
    return CAM_IDS.some((id) => this.cams[id].sensorProfile === 'OV5640_AF');
  }

  private afCams(): CamId[] {
    return CAM_IDS.filter((id) => this.cams[id].sensorProfile === 'OV5640_AF' && !this.busUnreachable(id));
  }

  // ---- transport binding ----

  bootDelayMs(): number {
    return Math.max(0, this.bootBlockedUntil - this.now());
  }

  attach(sink: (data: Uint8Array) => void, onForceClose: () => void) {
    this.sink = sink;
    this.forceCloseCb = onForceClose;
    this.emitTelemetry({ t: 'link', connected: true });
    this.decoder.reset();
    // A real ESP32 prints its ROM banner into the same UART the protocol uses.
    // The first thing a host reads after opening the port is that noise, and
    // the decoder has to resync out of it before it sees a frame (04 §19).
    if (this.scenarios.bootSpew) this.emitBootSpew();
    this.startAmbient();
    // Resume a backlog that was left mid-drain by the previous connection.
    if (this.scenarios.uploadBacklog) this.armUploadDrain();
  }

  detach() {
    this.sink = null;
    this.forceCloseCb = null;
    this.emitTelemetry({ t: 'link', connected: false });
    this.stopAmbient();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.coalesceBuffer = [];
    // The queue keeps its counts, but nothing of this device may outlive the
    // connection that opened it — a stray timer keeps a whole process up.
    this.stopUploadDrain();
  }

  receive(data: Uint8Array) {
    for (const frame of this.decoder.push(data)) {
      this.handleFrame(frame);
    }
  }

  onScenarioChange(cb: () => void) {
    this.scenarioCb = cb;
  }

  setScenario<K extends keyof ScenarioFlags>(key: K, value: ScenarioFlags[K]) {
    this.scenarios[key] = value;
    this.emitTelemetry({ t: 'scenario', key, value: Boolean(value) });
    // CAM1 offline is now a per-camera fault (04 §20); this flag just
    // mirrors it so Studio's simulator panel keeps its one-button toggle.
    // setCamFault does its own logging and keeps scenarios.offlineCameraNode
    // in sync, including when a caller sets the fault directly.
    if (key === 'offlineCameraNode') {
      this.setCamFault('cam1', value ? 'offline' : null);
      return; // setCamFault already notifies observers after synchronizing the mirrored flag.
    }
    if (key === 'sdMissing') this.log('SD', value ? 'card removed' : 'card inserted, mounted');
    if (key === 'lowBattery' && value) { this.batteryV = 3.42; this.log('PWR', 'battery low 3.42 V'); }
    if (key === 'lowBattery' && !value) this.batteryV = 3.96;
    if (key === 'largeGallery2k') this.media.resize(value ? LARGE_GALLERY_SIZE : DEMO_GALLERY_SIZE);
    if (key === 'uploadBacklog') this.setUploadBacklog(Boolean(value));
    if (key === 'bootSpew' && value) this.emitBootSpew();
    this.scenarioCb?.();

    // These are actions, not states: arming them makes the device do
    // something once, so the panel never shows a stuck ON — dropFirstHello
    // disarms itself at the next HELLO instead, since the action is "skip
    // one reply", not "do something right now".
    if (key === 'disconnect' && value) {
      this.scenarios.disconnect = false;
      this.log('P4', 'usb host link dropped');
      this.dropLink();
      this.scenarioCb?.();
    }
    if (key === 'sessionRestart' && value) {
      this.scenarios.sessionRestart = false;
      this.reboot('session-restart');
      this.scenarioCb?.();
    }
    // A blown fuse force-closes the current link like a dead rail, but the
    // fault itself is a persisted hardware state, not a one-shot action —
    // GET_POWER_STATUS keeps reporting it blown on the next connection.
    if (key === 'fuseBlown' && value) {
      this.log('PWR', 'fuse blown — 5V rail dead');
      this.dropLink();
      this.scenarioCb?.();
    }
    // SW6106 light-load auto-shutdown: same dead-rail outcome as the fuse,
    // but a one-shot event rather than persisted damage — the converter
    // restarts on the next power cycle. Threshold and timing are
    // NEEDS_HARDWARE_VALIDATION; only the outcome is injectable.
    if (key === 'sw6106Shutdown' && value) {
      this.scenarios.sw6106Shutdown = false;
      this.log('PWR', 'SW6106 light-load shutdown — 5V rail off');
      this.dropLink();
      this.scenarioCb?.();
    }
  }

  /** Boot/session ID of the current run (04 §17). Changes on every reboot. */
  currentSessionId(): string {
    return this.sessionId;
  }

  /**
   * Model a watchdog/soft restart whose USB CDC endpoint remains open. Real
   * firmware can reboot behind the same browser SerialPort, so Studio must
   * notice the new session via HELLO rather than a transport-close event.
   */
  restartSessionInPlace(reason = 'soft-restart'): void {
    this.bootCount++;
    this.sessionId = `boot-${this.bootCount}`;
    this.jobs.clear();
    this.resetReason = reason;
    this.emitTelemetry({ t: 'reboot', sessionId: this.sessionId, reason });
  }

  // ---- telemetry tap + public snapshot (KINO Twin §5 / §10) ----
  // A second, additive channel alongside the raw KDP wire: the Twin's 3D view
  // reads this, Studio never does (§10/§20 — no side-channel around protocol
  // behavior). Multiple subscribers; delivery is synchronous and best-effort,
  // so one listener throwing never blocks the others or the device itself.

  onTelemetry(cb: (e: TwinTelemetry) => void): () => void {
    this.telemetryListeners.add(cb);
    return () => this.telemetryListeners.delete(cb);
  }

  private emitTelemetry(e: TwinTelemetry): void {
    for (const cb of this.telemetryListeners) {
      try {
        cb(e);
      } catch {
        // best-effort: a bad subscriber must not break delivery to the rest.
      }
    }
  }

  /** A read-only, point-in-time view of device state for the Twin's 3D render. */
  twinSnapshot(): TwinSnapshot {
    const activeProfile = FIRMWARE_PROFILES[this.firmwareProfileId];
    const camSnapshot = (id: CamId) => {
      const cam = this.cams[id];
      return {
        fw: this.camFirmware(id),
        phaseUs: Math.round(this.effectivePhaseUs(id)),
        uartErrors: cam.uartErrors,
        jpegKB: cam.jpegKB,
        durationMs: cam.durationMs,
        gpioSkewUs: cam.gpioSkewUs,
        fault: cam.fault,
        updating: cam.updating,
        exposureUs: cam.exposureUs,
        focus: cam.focus ? { ...cam.focus } : null,
      };
    };
    // Same predicate NETWORK_STATUS answers with (handleNetwork, below).
    const wifiActive = this.scenarios.wifiLost ? null : this.networks.find((n) => n.autoJoin) ?? null;
    return {
      sessionId: this.sessionId,
      maintenance: this.maintenance,
      batteryV: this.batteryV,
      sdPresent: !this.scenarios.sdMissing,
      sdFreeMB: this.scenarios.sdMissing || this.scenarios.sdFull ? 0 : this.sdFreeMB,
      uartBaud: this.uartBaud,
      frameIntervalUs: this.frameIntervalUs,
      phaseAligned: this.phaseAligned,
      p4Fw: this.p4Fw,
      firmwareProfile: this.firmwareProfileId,
      simulatedFuture: activeProfile.simulatedFuture,
      flashEnabled: this.config.wiggle.flash,
      cams: {
        cam1: camSnapshot('cam1'),
        cam2: camSnapshot('cam2'),
        cam3: camSnapshot('cam3'),
        cam4: camSnapshot('cam4'),
      },
      roll: { joined: this.roll !== null, name: this.roll?.name ?? null },
      uploads: { ...this.uploads },
      wifi: wifiActive ? 'connected' : 'offline',
      scenarios: { ...this.scenarios },
    };
  }

  // ---- per-camera faults (KINO Twin §20) ----
  // Separate from ScenarioFlags: these target one of four cameras, not the
  // whole device. offline/power-open take the camera off the bus entirely
  // (per-cam commands NACK CAM_OFFLINE, CAMERA_STATUS/SELF_TEST report it);
  // the rest degrade a still-answering camera in one specific way.

  setCamFault(cam: CamId, fault: CamFault | null): void {
    const model = this.cams[cam];
    if (model.fault === fault) return;
    const wasDown = model.fault === 'offline' || model.fault === 'power-open';
    model.fault = fault;
    this.emitTelemetry({ t: 'camFault', cam, fault });
    const label = cam.toUpperCase();
    const src = ('C' + cam.slice(-1)) as LogSource;
    if (fault === 'offline') this.log('P4', `${label} link lost — no response on camera bus`);
    else if (fault === 'power-open') this.log('PWR', `no 5V rail on ${label}`);
    else if (wasDown) this.log('P4', `${label} link re-established`);
    else if (fault) this.log(src, `fault injected: ${fault}`);
    else this.log(src, 'fault cleared');
    // offlineCameraNode predates per-camera faults and stays as CAM1's mirror
    // so Studio's existing single-button panel keeps working.
    if (cam === 'cam1') this.scenarios.offlineCameraNode = fault === 'offline' || fault === 'power-open';
    this.scenarioCb?.();
  }

  camFault(cam: CamId): CamFault | null {
    return this.cams[cam].fault;
  }

  /** Simulated XIAO power-cycle (04 §20): the node goes briefly unreachable, then returns. */
  rebootCam(cam: CamId): void {
    const model = this.cams[cam];
    const src = ('C' + cam.slice(-1)) as LogSource;
    model.rebootUntil = this.now() + 1800;
    this.log(src, 'XIAO reboot');
    this.after(1800, () => this.log(src, 'OV3660 ready'));
    this.scenarioCb?.();
  }

  // ---- twin identity + tuning knobs (KINO Twin §11 / §13) ----

  /**
   * Feeds DEVICE_INFO only. HELLO always answers product 'KINO' regardless of
   * this patch — Studio's handshake (apps/studio/src/app/session.ts) rejects
   * any other product string, so the identity a Twin presents cannot change
   * what makes the connection recognizable as a KINO in the first place.
   */
  setIdentity(patch: { serial?: string; hardwareRevision?: string; product?: string }): void {
    this.identity = { ...this.identity, ...patch };
  }

  /** Test-only proof that the write-only Roll credential reached device-owned storage. */
  hasRollCredential(): boolean {
    return this.rollCredentials !== null;
  }

  /** Patch merged into GET_CAPABILITIES.capabilities; null clears any override. */
  overrideCapabilities(patch: Record<string, boolean> | null): void {
    this.capabilityOverrides = patch;
  }

  /** Plug in (or clear) the virtual sensor. See MockFrameSource. */
  setFrameSource(source: MockFrameSource | null): void {
    this.frameSource = source;
  }

  /**
   * Device-side tap (like onTelemetry, issue #75): read a committed capture's
   * stored files for the Twin's Roll development bridge. The SD card stays
   * the source of truth — an upload retry re-reads from here rather than
   * holding bytes in a second queue. Studio never uses this; it reads media
   * over KDP like a real host.
   */
  async readCaptureAssets(id: string): Promise<{
    kind: 'wiggle' | 'quad';
    ts: number;
    frames: { cam: number; bytes: Uint8Array }[];
    thumb: Uint8Array | null;
  } | null> {
    const summary = this.media.list().find((c) => c.id === id);
    if (!summary) return null;
    const frames: { cam: number; bytes: Uint8Array }[] = [];
    for (let cam = 0; cam < 4; cam++) {
      const bytes = await this.media.fileBytesByIndex(id, cam);
      if (bytes) frames.push({ cam, bytes });
    }
    return { kind: summary.kind, ts: summary.ts, frames, thumb: await this.media.thumb(id) };
  }

  /**
   * Render one frame through the registered frame source (issue #75). The
   * Twin's development bridge uses this for the Milestone-1 single-frame
   * ingest, where no group capture exists to commit. Null when no virtual
   * sensor is plugged in or the render fails.
   */
  async renderSourceFrame(req: MockFrameRequest): Promise<Uint8Array | null> {
    if (!this.frameSource) return null;
    try {
      return await this.frameSource(req);
    } catch {
      return null;
    }
  }

  /**
   * Pin the device to one firmware generation (issue #72). The dispatcher,
   * the capability report, the reported versions, and which camera links
   * answer all derive from the profile, so what the device claims and what
   * it answers cannot drift apart. Switching profiles resets per-camera
   * link faults for cameras the profile marks online.
   *
   * Like a flashed image, the profile survives reboots and factory reset.
   */
  setFirmwareProfile(id: FirmwareProfileId): void {
    const profile = FIRMWARE_PROFILES[id];
    this.firmwareProfileId = id;
    this.p4Fw = profile.p4Fw;
    CAM_IDS.forEach((camId, index) => {
      this.cams[camId].fw = profile.camFw;
      this.cams[camId].fault = profile.camsOnline[index] ? null : 'offline';
    });
    this.overrideCapabilities(profile.capabilities);
    this.log('P4', `firmware profile: ${profile.label}`);
    this.emitTelemetry({ t: 'profile', id });
    this.scenarioCb?.();
  }

  getFirmwareProfile(): FirmwareProfileId {
    return this.firmwareProfileId;
  }

  /** Twin-side equivalent of SET_LINK_BAUD — drives simulated transfer durations. */
  setUartBaud(baud: 921600 | 1500000 | 2000000 | 3000000): void {
    this.uartBaud = baud;
    this.log('P4', `camera UART baud set to ${baud}`);
  }

  /**
   * Resize the simulated card to an arbitrary count. The `largeGallery2k`
   * scenario is the one-click version of this; 07 §16 asks for 0 / 60 /
   * 2,000 / 10,000 rows, which is more sizes than a boolean can carry.
   */
  setGallerySize(count: number) {
    this.media.resize(count);
  }

  // ---- upload queue (04 §7 Network/Roll) ----

  private setUploadBacklog(on: boolean) {
    this.stopUploadDrain();
    if (!on) {
      this.uploads = { ...this.uploads, pending: 0, uploading: 0, failed: 0 };
      return;
    }
    this.uploads = { pending: 12, uploading: 1, failed: 2, uploaded: this.uploads.uploaded };
    this.log('P4', 'upload queue backed up — 12 pending, 2 failed');
    this.armUploadDrain();
  }

  /** Schedule the next automatic drain step, replacing any pending one. */
  private armUploadDrain() {
    this.stopUploadDrain();
    if (this.uploads.pending + this.uploads.uploading === 0) return;
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      this.tickUploads();
    }, UPLOAD_TICK_MS);
  }

  private stopUploadDrain() {
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = null;
  }

  /**
   * Move the queue along by one item. The backlog scenario calls this on a
   * timer; a test calls it directly so its assertions do not race wall clock.
   * Either way the next automatic step is rescheduled from here, so a burst of
   * manual ticks can never be interleaved with a timer that was already due.
   */
  tickUploads() {
    // KINO Twin §18: an expired Roll auth token stalls the queue — nothing
    // moves until a fresh token would be issued, which this mock does not
    // model, so the stall is unconditional while the flag is armed.
    if (this.scenarios.rollTokenExpired) return;
    const q = this.uploads;
    const draining = this.uploadTimer !== null || this.scenarios.uploadBacklog;
    if (q.uploading > 0) {
      q.uploading--;
      q.uploaded++;
    }
    if (q.pending > 0) {
      q.pending--;
      q.uploading++;
    }
    this.emitTelemetry({ t: 'uploads', pending: q.pending, uploading: q.uploading, failed: q.failed, uploaded: q.uploaded });
    if (q.pending === 0 && q.uploading === 0) {
      this.stopUploadDrain();
      if (draining) this.log('P4', `upload queue drained — ${q.failed} failed`);
      return;
    }
    if (draining) this.armUploadDrain();
  }

  uploadQueue(): UploadQueue {
    return { ...this.uploads };
  }

  // ---- ambient simulation ----

  private startAmbient() {
    const tickLog = () => {
      this.emitAmbientLog();
      this.logTimer = setTimeout(tickLog, this.randInt(900, 2600));
    };
    this.logTimer = setTimeout(tickLog, 600);

    if (!this.ambientCaptures) return;
    const tickCapture = () => {
      this.simulateCapture();
      this.captureTimer = setTimeout(tickCapture, this.randInt(9000, 22000));
    };
    this.captureTimer = setTimeout(tickCapture, 5000);
  }

  private stopAmbient() {
    if (this.logTimer) clearTimeout(this.logTimer);
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.logTimer = null;
    this.captureTimer = null;
  }

  private emitAmbientLog() {
    this.batteryV = Math.max(3.3, this.batteryV - this.rand(0.0001, 0.0005));
    const camSrc = this.pick(['C1', 'C2', 'C3', 'C4'] as LogSource[]);
    const options: [LogSource, string][] = [
      ['P4', this.pick(['touch: mode dial', 'ui idle', 'preview stream 12 fps', 'wiggle armed', 'heap ok'])],
      [camSrc, this.pick(['AE converged in 3 frames', `exposure locked 1/60 gain ${this.randInt(4, 16)}`, 'awb warm bias applied', `frame sync ok, skew ${this.randInt(60, 420)} us`])],
      ['PWR', `battery ${this.batteryV.toFixed(2)} V`],
      ['SD', this.pick([`free ${(this.sdFreeMB / 1024).toFixed(1)} GB`, `write burst ${this.rand(3.2, 4.4).toFixed(1)} MB/s`])],
      ['PROTO', this.pick(['usb host poll ok', 'trigger bus idle'])],
    ];
    const weights = [4, 5, 1, 1, 1];
    let total = weights.reduce((a, b) => a + b, 0);
    let roll = this.rng() * total;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { idx = i; break; }
    }
    const [src, msg] = options[idx];
    const camId = /^C[1-4]$/.test(src) ? (`cam${src[1]}` as CamId) : null;
    if (camId && (this.busUnreachable(camId) || (camId === 'cam2' && this.scenarios.cam2Timeout))) return;
    if (src === 'SD' && this.scenarios.sdMissing) return;
    this.log(src, msg);
  }

  /**
   * CAMERA_FOCUS (audit #55). Requires the autofocus capability — firmware
   * without an AF sensor NACKs UNSUPPORTED_COMMAND, exactly like any other
   * capability-gated group. Per-cam AF faults shape every outcome.
   */
  private handleCameraFocus(frame: Frame) {
    if (!this.hasAutofocus()) {
      this.respondError(frame, 'UNSUPPORTED_COMMAND', 'No autofocus camera is fitted');
      return;
    }
    const req = decodeJson<{ action: string; cam?: CamId; position?: number; locked?: boolean; mode?: FocusMode }>(
      frame.payload,
    );

    if (req.action === 'trigger') {
      const cams = this.afCams();
      if (cams.length === 0) {
        this.respondError(frame, 'CAM_UNREACHABLE', 'No reachable autofocus camera');
        return;
      }
      let pending = cams.length;
      for (const id of cams) {
        const cam = this.cams[id];
        const focus = cam.focus!;
        focus.state = 'searching';
        focus.locked = false;
        this.emitTelemetry({ t: 'af', cam: id, state: 'searching' });
        const settle = () => {
          if (--pending === 0) {
            this.respond(frame, {
              cams: Object.fromEntries(cams.map((c) => [c, { ...this.cams[c].focus! }])),
            });
          }
        };
        const fault = cam.fault;
        if (fault === 'af-timeout') {
          this.after(900, () => {
            focus.state = 'failed';
            this.log(('C' + id.slice(-1)) as LogSource, 'AF timeout — no lock');
            this.emitTelemetry({ t: 'af', cam: id, state: 'failed' });
            settle();
          });
        } else if (fault === 'af-fail' || fault === 'vcm-stuck') {
          this.after(this.randInt(250, 400), () => {
            focus.state = 'failed';
            this.log(('C' + id.slice(-1)) as LogSource, fault === 'vcm-stuck' ? 'VCM stuck — lens did not move' : 'AF failed to converge');
            this.emitTelemetry({ t: 'af', cam: id, state: 'failed' });
            settle();
          });
        } else if (fault === 'af-hunt') {
          // Oscillate twice, then lock — the party-light hunting pattern.
          this.after(250, () => this.emitTelemetry({ t: 'af', cam: id, state: 'locked' }));
          this.after(450, () => this.emitTelemetry({ t: 'af', cam: id, state: 'searching' }));
          this.after(800, () => {
            focus.state = 'locked';
            focus.locked = true;
            focus.vcmPosition = this.randInt(120, 240);
            focus.estimatedDistanceM = Math.round(this.rand(0.8, 3.0) * 10) / 10;
            this.log(('C' + id.slice(-1)) as LogSource, 'AF locked after hunting');
            this.emitTelemetry({ t: 'af', cam: id, state: 'locked' });
            settle();
          });
        } else {
          this.after(this.randInt(250, 450), () => {
            focus.state = 'locked';
            focus.locked = true;
            focus.vcmPosition = this.randInt(120, 240);
            focus.estimatedDistanceM = Math.round(this.rand(0.8, 3.0) * 10) / 10;
            this.emitTelemetry({ t: 'af', cam: id, state: 'locked' });
            settle();
          });
        }
      }
      return;
    }

    if (req.action === 'lock') {
      for (const id of this.afCams()) {
        const focus = this.cams[id].focus!;
        focus.locked = req.locked !== false;
        if (!focus.locked && focus.state === 'locked') focus.state = 'idle';
      }
      this.respond(frame, { ok: true, locked: req.locked !== false });
      return;
    }

    if (req.action === 'set') {
      const id = req.cam;
      if (!id || !CAM_IDS.includes(id)) {
        this.respondError(frame, 'INVALID_ARGUMENT', 'set requires a cam');
        return;
      }
      const cam = this.cams[id];
      if (cam.sensorProfile !== 'OV5640_AF' || !cam.focus) {
        this.respondError(frame, 'UNSUPPORTED_COMMAND', `${id.toUpperCase()} has no focus drive`);
        return;
      }
      if (cam.fault === 'vcm-stuck') {
        this.respondError(frame, 'VCM_STUCK', `${id.toUpperCase()} lens does not move`);
        return;
      }
      const position = Math.max(0, Math.min(255, Math.round(Number(req.position) || 0)));
      cam.focus.mode = 'manual';
      cam.focus.state = 'locked';
      cam.focus.locked = true;
      cam.focus.vcmPosition = position;
      cam.focus.estimatedDistanceM = null; // a set position is a position, not a measured distance
      this.emitTelemetry({ t: 'af', cam: id, state: 'locked' });
      this.respond(frame, { ok: true, cam: id, position });
      return;
    }

    if (req.action === 'mode') {
      const mode = req.mode;
      if (mode !== 'party-auto' && mode !== 'party-fixed' && mode !== 'manual') {
        this.respondError(frame, 'INVALID_ARGUMENT', 'mode must be party-auto | party-fixed | manual');
        return;
      }
      this.config.wiggle.focusMode = mode;
      for (const id of this.afCams()) {
        const cam = this.cams[id];
        cam.focus!.mode = mode;
        if (mode === 'party-fixed') {
          const stored = this.calibration.cams[id]?.focusPosition;
          if (typeof stored === 'number') {
            cam.focus!.state = 'locked';
            cam.focus!.locked = true;
            cam.focus!.vcmPosition = stored;
          } else {
            cam.focus!.state = 'idle'; // nothing stored yet — store-fixed first
            cam.focus!.locked = false;
          }
        }
      }
      this.configRevision++;
      this.respond(frame, { ok: true, mode });
      return;
    }

    if (req.action === 'store-fixed') {
      const stored: CamId[] = [];
      for (const id of this.afCams()) {
        const focus = this.cams[id].focus!;
        if (focus.state === 'locked' && focus.vcmPosition !== null) {
          this.calibration.cams[id].focusPosition = focus.vcmPosition;
          stored.push(id);
        }
      }
      if (stored.length === 0) {
        this.respondError(frame, 'NOT_LOCKED', 'No camera holds a locked focus to store');
        return;
      }
      this.log('P4', `PARTY FIXED positions stored for ${stored.map((c) => c.toUpperCase()).join(' ')}`);
      this.respond(frame, { ok: true, stored });
      return;
    }

    this.respondError(frame, 'INVALID_ARGUMENT', `Unknown focus action "${String(req.action)}"`);
  }

  private simulateCapture() {
    // audit #57 cameraPowerTransient: one channel browns out as the group
    // draws capture current — the camera power-cycles mid-shot and the set
    // comes back incomplete, exactly the §18 partial-group behavior.
    if (this.scenarios.cameraPowerTransient) {
      this.scenarios.cameraPowerTransient = false;
      const victim = this.pick([...CAM_IDS]);
      this.cams[victim].rebootUntil = this.now() + 1500;
      this.log('PWR', `${victim.toUpperCase()} channel brownout during capture — power-cycling`);
      this.scenarioCb?.();
    }
    const captureId = this.captureCounter;
    const n = String(this.captureCounter++).padStart(4, '0');
    const mode = this.config.mode;
    // KINO Twin §20 flashUnavailable: the capture proceeds — nothing about
    // §18's "no Roll/server condition may block a capture" scopes to flash,
    // but a missing flash still isn't a reason to fail the shot — only the
    // flash itself is skipped, and it says so in the log.
    const flashFires = this.config.wiggle.flash && !this.scenarios.flashUnavailable;
    // KINO Twin §5 telemetry tap: nothing per-cam is known yet at trigger time.
    this.emitTelemetry({ t: 'capture', phase: 'begin', id: captureId, cams: {} });
    this.log('P4', `${mode} capture ${n} triggered${flashFires ? ' — flash' : ''}`);
    if (this.config.wiggle.flash && !flashFires) this.log('P4', 'flash unavailable — capture without flash');
    // KINO Twin §20 batterySag: the transient dip GET_POWER_STATUS reports
    // right after a capture draws current.
    if (this.scenarios.batterySag) this.batterySagUntil = this.now() + 700;
    let delay = 60;
    // PARTY AUTO (audit #55): focus → lock → arm → capture. The group waits
    // for one AF pass; a camera whose AF fails still shoots (soft frame beats
    // no frame at a party), it just reports failed. PARTY FIXED and MANUAL
    // add no delay — the lens is already where it was told to be.
    if (this.hasAutofocus() && (this.config.wiggle.focusMode ?? 'party-auto') === 'party-auto') {
      for (const id of this.afCams()) {
        const focus = this.cams[id].focus!;
        focus.state = 'searching';
        focus.locked = false;
        this.emitTelemetry({ t: 'af', cam: id, state: 'searching' });
        const failing = focus && ['af-fail', 'vcm-stuck', 'af-timeout'].includes(this.cams[id].fault ?? '');
        this.afterCapture(300, () => {
          if (failing) {
            focus.state = 'failed';
          } else {
            focus.state = 'locked';
            focus.locked = true;
            focus.vcmPosition = this.randInt(120, 240);
            focus.estimatedDistanceM = Math.round(this.rand(0.8, 3.0) * 10) / 10;
          }
          this.emitTelemetry({ t: 'af', cam: id, state: focus.state });
        });
      }
      delay += 350;
    }
    let skipped = 0;
    for (const id of CAM_IDS) {
      const cam = this.cams[id];
      const src = ('C' + id.slice(-1)) as LogSource;
      if (this.camDown(id)) {
        skipped++;
        this.afterCapture(delay, () => { this.log('P4', `${id.toUpperCase()} no frame — group incomplete`); this.camTimeouts++; });
        continue;
      }
      if (id === 'cam2' && this.scenarios.cam2Timeout) {
        skipped++;
        this.afterCapture(delay + 900, () => { this.log('P4', 'C2 frame timeout after 900 ms'); this.camTimeouts++; cam.uartErrors++; });
        continue;
      }
      cam.jpegKB = this.randInt(300, 560);
      // KINO Twin §20 slow-uart: this camera's transfer takes 8x as long.
      cam.durationMs = this.randInt(130, 280) * (cam.fault === 'slow-uart' ? 8 : 1);
      cam.gpioSkewUs = this.randInt(60, 450);
      cam.lastCaptureAt = this.now();
      if (cam.fault === 'crc-noise') {
        // KINO Twin §20 crc-noise: errors climb each transfer, and the
        // capture log line reports the retries that absorbed them.
        const retries = this.randInt(1, 3);
        cam.uartErrors += retries;
        this.afterCapture(delay, () => this.log(src, `jpeg ${cam.jpegKB} KB in ${cam.durationMs} ms — ${retries} retries (crc noise)`));
      } else {
        this.afterCapture(delay, () => this.log(src, `jpeg ${cam.jpegKB} KB in ${cam.durationMs} ms`));
      }
      delay += this.randInt(15, 45);
    }
    if (this.scenarios.sdMissing || this.scenarios.sdFull) {
      const reason = this.scenarios.sdMissing ? 'no card' : 'card full';
      this.afterCapture(delay + 120, () => { this.sdErrors++; this.log('SD', `capture ${n} lost — ${reason}`); });
      return;
    }
    // Sequential CAM1→4 UART transfer happens before the SD commit; at
    // 921600 baud a four-frame set takes a few seconds.
    // Concurrent transfer on four UARTs: wall clock is the slowest
    // channel, not the sum of four sequential transfers.
    const transferMs = Math.round((380 * 1024) / ((this.uartBaud / 10) * 0.9) * 1000);
    this.afterCapture(delay + transferMs, () => {
      this.sdFreeMB = Math.max(0, this.sdFreeMB - 2);
      if (skipped > 0) {
        this.log('SD', `capture ${n} committed incomplete — ${4 - skipped}/4 frames`);
        return; // incomplete sets are marked, not published as wigglegrams
      }
      const number = this.captureCounter - 1;
      const kind = mode;
      const recipeIds =
        kind === 'quad'
          ? CAM_IDS.map((id) => this.config.quad.slots[id].recipeId)
          : [this.config.wiggle.recipeId];
      const finalize = (assets?: { frames?: (Uint8Array | null)[]; thumb?: Uint8Array | null }) => {
        const capId = this.media.addLiveCapture(number, kind, recipeIds, flashFires, assets);
        this.log('SD', `${capId} committed`);
        this.sendEvent(Evt.CAPTURE, { id: capId, kind });
        this.emitTelemetry({ t: 'sd', activity: 'write' });
        const camsReport: Partial<Record<CamId, { jpegKB: number; durationMs: number }>> = {};
        for (const camId of CAM_IDS) {
          if (this.camDown(camId) || (camId === 'cam2' && this.scenarios.cam2Timeout)) continue;
          camsReport[camId] = { jpegKB: this.cams[camId].jpegKB, durationMs: this.cams[camId].durationMs };
        }
        this.emitTelemetry({ t: 'capture', phase: 'committed', id: captureId, capId, kind, cams: camsReport });
      };
      const source = this.frameSource;
      if (source) {
        // Virtual sensors (issue #72): render the actual scene from each
        // optical center — the capture's files ARE those renders. A failed
        // render for one camera falls back to synthesis for that camera.
        const phaseMs = this.now() - this.bootedAt;
        void (async () => {
          try {
            const frames = await Promise.all(
              CAM_IDS.map((camId) =>
                Promise.resolve(
                  source({ cam: camId, kind: 'capture', width: 800, height: 600, phaseMs, flash: flashFires }),
                ).catch(() => null),
              ),
            );
            const thumb = await Promise.resolve(
              source({ cam: 'cam2', kind: 'thumb', width: 200, height: 150, phaseMs, flash: flashFires }),
            ).catch(() => null);
            finalize({ frames, thumb });
          } catch {
            finalize();
          }
        })();
      } else {
        finalize();
      }
    });
  }

  private after(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }

  /** Like after(), but survives detach/dropLink — see captureTimers. */
  private afterCapture(ms: number, fn: () => void) {
    this.captureTimers.push(setTimeout(fn, ms));
  }

  private clearCaptureTimers() {
    for (const t of this.captureTimers) clearTimeout(t);
    this.captureTimers = [];
  }

  /** Power removed: an in-flight capture chain dies with the rails. The Twin
   * simulator calls this on POWER OFF; a mere link drop must NOT — see
   * captureTimers. */
  cancelInFlightCaptures(): void {
    this.clearCaptureTimers();
  }

  private log(src: LogSource, msg: string) {
    const entry: LogEntry = { t: this.now(), src, msg };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 400) this.logBuffer.splice(0, this.logBuffer.length - 400);
    this.sendEvent(Evt.LOG, entry);
    this.emitTelemetry({ t: 'log', entry });
  }

  // ---- frame plumbing ----

  private sendEvent(type: Evt, payload: unknown) {
    this.sendFrame({ version: PROTOCOL_VERSION, type, flags: FrameFlags.EVENT, seq: 0, payload: encodeJson(payload) });
  }

  private respond(frame: Frame, payload: unknown) {
    this.sendFrame({
      version: PROTOCOL_VERSION,
      type: frame.type,
      flags: FrameFlags.RESPONSE,
      seq: frame.seq,
      payload: encodeJson(payload),
    });
  }

  private respondBytes(frame: Frame, bytes: Uint8Array) {
    this.sendFrame({
      version: PROTOCOL_VERSION,
      type: frame.type,
      flags: FrameFlags.RESPONSE | FrameFlags.BINARY,
      seq: frame.seq,
      payload: bytes,
    });
  }

  private respondError(frame: Frame, code: string, message: string) {
    this.sendFrame({
      version: PROTOCOL_VERSION,
      type: frame.type,
      flags: FrameFlags.RESPONSE | FrameFlags.ERROR,
      seq: frame.seq,
      payload: encodeJson({ code, message }),
    });
  }

  private sendFrame(frame: Frame) {
    if (!this.sink) return;
    let bytes = encodeFrame(frame);
    if (this.scenarios.badCrc && frame.flags & FrameFlags.RESPONSE) {
      bytes = bytes.slice();
      bytes[bytes.length - 3] ^= 0xff; // corrupt CRC in transit
      this.scenarios.badCrc = false;
      this.scenarioCb?.();
    }
    if (this.scenarios.droppedByte && frame.flags & FrameFlags.RESPONSE) {
      // One byte vanishes mid-frame: CRC fails, the decoder resyncs, the
      // request times out — the shape of a marginal cable, not a NACK.
      const cut = 6 + Math.floor(this.rng() * Math.max(1, bytes.length - 7));
      const shorter = new Uint8Array(bytes.length - 1);
      shorter.set(bytes.subarray(0, cut));
      shorter.set(bytes.subarray(cut + 1), cut);
      bytes = shorter;
      this.scenarios.droppedByte = false;
      this.scenarioCb?.();
    }
    if (this.scenarios.midFrameDisconnect && frame.flags & FrameFlags.RESPONSE) {
      this.scenarios.midFrameDisconnect = false;
      this.scenarioCb?.();
      this.emit(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      this.dropLink();
      return;
    }
    if (this.scenarios.duplicateFrame && frame.flags & FrameFlags.RESPONSE) {
      // A retransmitted duplicate: same bytes twice. The client must settle
      // the request once and drop the second copy by sequence number.
      this.scenarios.duplicateFrame = false;
      this.scenarioCb?.();
      this.writeOut(bytes);
    }
    this.writeOut(bytes);
  }

  /**
   * The one place bytes leave the device. 04 §19 wants both failure modes of a
   * byte stream visible here: one frame arriving as several reads, and several
   * frames arriving as one. Neither changes the bytes, only their grouping —
   * a decoder that assumes read boundaries are frame boundaries breaks on both.
   */
  private writeOut(bytes: Uint8Array) {
    if (this.scenarios.coalescedFrames) {
      this.coalesceBuffer.push(bytes);
      if (!this.coalesceTimer) {
        this.coalesceTimer = setTimeout(() => this.flushCoalesced(), COALESCE_WINDOW_MS);
      }
      return;
    }
    this.emit(bytes);
  }

  private flushCoalesced() {
    this.coalesceTimer = null;
    const chunks = this.coalesceBuffer;
    this.coalesceBuffer = [];
    if (chunks.length === 0) return;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.length;
    }
    this.emit(joined);
  }

  private emit(bytes: Uint8Array) {
    const sink = this.sink;
    if (!sink) return;
    if (this.scenarios.baudMismatch) {
      // A mis-set serial port doesn't drop bytes, it mangles all of them —
      // nothing frames, HELLO can't complete, until the rate is corrected.
      bytes = bytes.map((b) => b ^ 0xa5);
    }
    if (!this.scenarios.splitFrames || bytes.length < 4) {
      sink(bytes);
      return;
    }
    // Two or three writes per frame, always cutting inside the payload so a
    // header lands split across reads at least some of the time.
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = bytes.length - offset;
      const n = remaining <= 3 ? remaining : this.randInt(1, Math.max(1, remaining - 1));
      sink(bytes.subarray(offset, offset + n));
      offset += n;
    }
  }

  /** ESP32 ROM/bootloader chatter on the same UART — unframed, must resync. */
  private emitBootSpew() {
    const sink = this.sink;
    if (!sink) return;
    const banner =
      'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n' +
      'configsip: 0, SPIWP:0xee\r\n' +
      'mode:DIO, clock div:2\r\n' +
      'load:0x3fff0030,len:4832\r\n' +
      'entry 0x400805e4\r\n' +
      'I (312) cpu_start: Pro cpu up.\r\n' +
      'I (418) kino: protocol v1 ready\r\n';
    sink(new TextEncoder().encode(banner));
  }

  /** Yank the link without a reboot — no reply, no close frame, just gone. */
  private dropLink() {
    const closeCb = this.forceCloseCb;
    this.stopAmbient();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    // Same teardown as detach(): the device state survives, but nothing
    // scheduled by this connection may outlive it.
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.coalesceBuffer = [];
    this.stopUploadDrain();
    this.sink = null;
    this.forceCloseCb = null;
    this.emitTelemetry({ t: 'link', connected: false });
    closeCb?.();
  }

  private handleFrame(frame: Frame) {
    if (frame.version !== PROTOCOL_VERSION) {
      this.respondError(frame, 'BAD_VERSION', `Protocol ${frame.version} not supported`);
      return;
    }
    const latency = this.scenarios.delayedResponses
      ? this.randInt(SLOW_RESPONSE_MS[0], SLOW_RESPONSE_MS[1])
      : frame.type === Cmd.FW_CHUNK
        ? this.randInt(4, 10)
        : this.randInt(8, 26);
    this.after(latency, () => this.dispatch(frame));
  }

  private cameraInfo(id: CamId): CameraInfo {
    const cam = this.cams[id];
    const offline = this.busUnreachable(id);
    const sensorMissing = cam.fault === 'sensor-missing';
    const timeout = id === 'cam2' && this.scenarios.cam2Timeout;
    const rebooting = cam.rebootUntil > this.now();
    return {
      id,
      online: !offline && !rebooting,
      sensor: sensorMissing ? null : cam.sensorProfile === 'OV5640_AF' ? 'OV5640' : 'OV3660',
      sensorDetected: !offline && !rebooting && !sensorMissing,
      ...(cam.focus ? { focus: { ...cam.focus } } : {}),
      firmware: this.camFirmware(id),
      state: offline
        ? 'offline'
        : rebooting
          ? 'rebooting'
          : cam.updating
            ? 'updating'
            : timeout
              ? 'timeout'
              : sensorMissing
                ? 'error'
                : 'ready',
      latencyMs: offline ? 0 : timeout ? 900 : Math.round(this.rand(2, 9) * 10) / 10,
      uartErrors: cam.uartErrors,
      lastCapture: offline
        ? null
        : {
            ageS: Math.round((this.now() - cam.lastCaptureAt) / 1000),
            jpegKB: cam.jpegKB,
            durationMs: cam.durationMs,
            gpioSkewUs: cam.gpioSkewUs,
          },
    };
  }

  /** offline/power-open: the node doesn't answer the camera bus at all. */
  private busUnreachable(id: CamId): boolean {
    const fault = this.cams[id].fault;
    return fault === 'offline' || fault === 'power-open';
  }

  /** Bus-unreachable, or reachable but unable to produce a frame at all. */
  private camDown(id: CamId): boolean {
    return this.busUnreachable(id) || this.cams[id].fault === 'sensor-missing';
  }

  private anyCamDown(): boolean {
    return CAM_IDS.some((id) => this.camDown(id));
  }

  /** KINO Twin §20 nodeFwMismatch: CAM4 reports an out-of-date build. */
  private camFirmware(id: CamId): string {
    return id === 'cam4' && this.scenarios.nodeFwMismatch ? '0.0.9' : this.cams[id].fw;
  }

  /** KINO Twin §20 vsyncOffsetLarge: CAM3's phase jumps far outside frame-plausible range. */
  private effectivePhaseUs(id: CamId): number {
    return id === 'cam3' && this.scenarios.vsyncOffsetLarge ? 31_000 : this.camPhaseUs[id];
  }

  /**
   * Commands a firmware build may not have. 04 §6: never silence, always a
   * NACK with a reason, so Studio says "not supported" instead of waiting out
   * a timeout. `unsupportedCommands` turns the whole optional surface off at
   * once; `legacyFirmware` is the narrower pre-timing build.
   */
  private static readonly OPTIONAL_COMMANDS: number[] = [
    Cmd.CAMERA_PHASE,
    Cmd.LINK_BENCH,
    Cmd.SET_LINK_BAUD,
    Cmd.GET_SOUNDS,
    Cmd.SOUND_BEGIN,
    Cmd.SOUND_CHUNK,
    Cmd.SOUND_END,
    Cmd.SOUND_READ,
    Cmd.SOUND_DELETE,
  ];

  /**
   * The Network/Roll group plus the bench job. Unlike the commands above,
   * these have no legacy check further down, so the gate here is the only
   * thing enforcing them — and it has to use exactly the condition
   * GET_CAPABILITIES reports for `network`/`rollUpload`/`syncBench`. A device
   * that advertises no network support and then answers NETWORK_LIST is a
   * worse mock than one that has no network support at all.
   */
  private static readonly NETWORK_ROLL_COMMANDS: number[] = [
    Cmd.NETWORK_LIST,
    Cmd.NETWORK_SET,
    Cmd.NETWORK_DELETE,
    Cmd.NETWORK_STATUS,
    Cmd.ROLL_STATUS,
    Cmd.ROLL_CREATE,
    Cmd.ROLL_JOIN,
    Cmd.ROLL_LEAVE,
    Cmd.UPLOAD_QUEUE_STATUS,
    Cmd.UPLOAD_QUEUE_RETRY,
    Cmd.UPLOAD_ENQUEUE,
    Cmd.SYNC_BENCH,
  ];

  /** Single source of truth for both the capability report and the dispatcher. */
  private supportsNetworkRoll(): boolean {
    return !this.scenarios.legacyFirmware && !this.scenarios.unsupportedCommands;
  }

  /** Milestone 1B bench diagnostics — same rule: the flag and the gate agree. */
  private supportsBench(): boolean {
    return !this.scenarios.legacyFirmware && !this.scenarios.unsupportedCommands;
  }

  private static readonly BENCH_COMMANDS: number[] = [
    Cmd.STORAGE_SELF_TEST,
    Cmd.CAMERA_LINK_STATS,
    Cmd.CAMERA_LINK_STATS_RESET,
    Cmd.CAMERA_SOAK_TEST,
    Cmd.GET_HW_VALIDATION,
  ];

  // ---- Milestone 1B bench diagnostics ----

  private hex8(): string {
    return ((this.randInt(0, 0xffff) << 16) >>> 0 | this.randInt(0, 0xffff)).toString(16).padStart(8, '0');
  }

  private mockUuid(): string {
    const h = (n: number) => Array.from({ length: n }, () => this.randInt(0, 15).toString(16)).join('');
    return `${h(8)}-${h(4)}-4${h(3)}-${(8 + this.randInt(0, 3)).toString(16)}${h(3)}-${h(12)}`;
  }

  /** Set once a checksummed capture succeeded this session — feeds the
   * hardware-validation registry the same way real firmware marks items. */
  private captureProven = false;

  /**
   * One simulated diagnostic capture over the node link. Shared by
   * CAMERA_TEST and CAMERA_SOAK_TEST so faults behave identically in both.
   * Legacy fault codes (CAM_OFFLINE / CAM_UNREACHABLE / SENSOR_MISSING) are
   * checked by the callers; this covers the 1B failure kinds.
   */
  private benchCapture(cam: CamId): {
    ok: boolean;
    code?: string;
    message?: string;
    jpegBytes?: number;
    requestToNodeMs?: number;
    readyMs?: number;
    transferMs?: number;
    sdMs?: number;
    crc?: string;
    nodeHeapKB?: number;
    nodePsramKB?: number;
  } {
    const link = this.linkStats[cam];
    link.lastSequence += 4;
    link.txFrames += 3;
    link.txBytes += 180;

    if (this.busUnreachable(cam)) {
      link.timeouts++;
      link.lastError = 'TIMEOUT';
      return { ok: false, code: 'CAMERA_OFFLINE', message: `${cam.toUpperCase()} did not answer` };
    }
    if (this.cams[cam].fault === 'sensor-missing') {
      return { ok: false, code: 'SENSOR_NOT_DETECTED', message: `${cam.toUpperCase()} sensor not detected` };
    }
    if (this.scenarios.sdMissing) {
      this.sdErrors++;
      return { ok: false, code: 'SD_NOT_MOUNTED', message: 'No durable storage path' };
    }
    if (this.scenarios.sdFull) {
      this.sdErrors++;
      return { ok: false, code: 'SD_WRITE_FAILED', message: 'Card full' };
    }

    const jpegBytes = this.randInt(300, 560) * 1024;
    const chunks = Math.ceil(jpegBytes / 8192);
    if (this.cams[cam].fault === 'crc-noise') {
      link.crcErrors += this.randInt(1, 3);
      link.decoderResyncs += 1;
      link.rxFrames += chunks;
      link.rxBytes += jpegBytes;
      link.lastError = 'TRANSFER_CRC_MISMATCH';
      return { ok: false, code: 'TRANSFER_CRC_MISMATCH', message: 'Node and transfer checksums disagree' };
    }

    link.txFrames += chunks;
    link.txBytes += chunks * 90;
    link.rxFrames += chunks + 3;
    link.rxBytes += jpegBytes + chunks * 18 + 400;
    const slow = this.cams[cam].fault === 'slow-uart' ? 8 : 1;
    if (this.scenarios.memoryLeak) this.leakKB += this.randInt(2, 5);
    this.captureProven = true;
    return {
      ok: true,
      jpegBytes,
      requestToNodeMs: this.randInt(2, 6),
      readyMs: this.randInt(140, 260),
      transferMs: Math.round(((jpegBytes * 10 * slow) / this.uartBaud) * 1000),
      sdMs: this.randInt(60, 180),
      crc: this.hex8(),
      nodeHeapKB: 96 - this.leakKB,
      nodePsramKB: 7900 - 4 * this.leakKB,
    };
  }

  /** Full CameraTestResult payload from one successful benchCapture. */
  private captureResult(cam: CamId, r: ReturnType<MockKinoDevice['benchCapture']>) {
    const totalMs = r.requestToNodeMs! + r.readyMs! + r.transferMs! + r.sdMs!;
    const heapBase = 162 - this.leakKB;
    return {
      ok: true,
      cam,
      captureUuid: this.mockUuid(),
      captureId: `TC_${String(++this.captureCounter).padStart(6, '0')}`,
      resolution: '1600x1200',
      jpegBytes: r.jpegBytes!,
      jpegKB: Math.round(r.jpegBytes! / 1024),
      durationMs: totalMs,
      timing: {
        requestToNodeMs: r.requestToNodeMs!,
        captureCommandToJpegReadyMs: r.readyMs!,
        jpegTransferMs: r.transferMs!,
        sdWriteMs: r.sdMs!,
        totalMs,
      },
      // The three checksums agree on a clean path — a mismatch is a NACK,
      // never a "successful" capture with disagreeing sums.
      checksums: { nodeJpegCrc32: r.crc!, transferCrc32: r.crc!, storedFileCrc32: r.crc!, match: true },
      memory: {
        p4HeapKBBefore: heapBase + this.randInt(0, 4),
        p4HeapKBAfter: heapBase - this.randInt(0, 2),
        p4PsramKBBefore: 12900,
        p4PsramKBAfter: 12900 - this.randInt(0, 8),
        nodeHeapKB: r.nodeHeapKB!,
        nodePsramKB: r.nodePsramKB!,
      },
    };
  }

  private handleStorageSelfTest(frame: Frame) {
    const missing = this.scenarios.sdMissing;
    const full = this.scenarios.sdFull;
    this.after(missing ? 50 : 420, () => {
      const failedPhase: StorageSelfTestPhase | null = missing ? 'MOUNT_FAILED' : full ? 'WRITE_FAILED' : null;
      const ok = failedPhase === null;
      this.storageWriteTest = ok ? 'pass' : 'fail';
      if (!ok) this.sdErrors++;
      this.log('SD', ok ? 'self-test pass — 64 KB written, read back, verified' : `self-test FAIL — ${failedPhase}`);
      const result: StorageSelfTestResult = {
        ok,
        failedPhase,
        durationMs: ok ? 412 : 45,
        bytesTested: ok ? 65536 : 0,
      };
      this.respond(frame, result);
    });
  }

  private handleLinkStats(frame: Frame) {
    const { cam } = decodeJson<{ cam: CamId }>(frame.payload);
    if (!CAM_IDS.includes(cam)) {
      this.respondError(frame, 'INVALID_ARGUMENT', 'cam must be cam1..cam4');
      return;
    }
    const link = this.linkStats[cam];
    const stats: CameraLinkStats = {
      cam,
      baud: this.uartBaud,
      connected: !this.busUnreachable(cam),
      rxFrames: link.rxFrames,
      txFrames: link.txFrames,
      rxBytes: link.rxBytes,
      txBytes: link.txBytes,
      crcErrors: link.crcErrors,
      decoderResyncs: link.decoderResyncs,
      timeouts: link.timeouts,
      retries: link.retries,
      duplicateFrames: link.duplicateFrames,
      lastSequence: link.lastSequence,
      lastNodeBootReason: this.busUnreachable(cam) ? null : 'power-on',
      lastError: link.lastError,
    };
    this.respond(frame, stats);
  }

  private handleLinkStatsReset(frame: Frame) {
    const { cam } = decodeJson<{ cam: CamId }>(frame.payload);
    if (!CAM_IDS.includes(cam)) {
      this.respondError(frame, 'INVALID_ARGUMENT', 'cam must be cam1..cam4');
      return;
    }
    const keepSeq = this.linkStats[cam].lastSequence;
    this.linkStats[cam] = freshLinkCounters();
    this.linkStats[cam].lastSequence = keepSeq;
    this.respond(frame, { ok: true });
  }

  private handleSoakTest(frame: Frame) {
    const req = decodeJson<{ cam?: CamId; captures?: number; delayMs?: number; keepAll?: boolean }>(frame.payload);
    const cam = (req.cam ?? 'cam1') as CamId;
    if (!CAM_IDS.includes(cam)) {
      this.respondError(frame, 'INVALID_ARGUMENT', 'cam must be cam1..cam4');
      return;
    }
    if (this.busUnreachable(cam)) {
      this.respondError(frame, 'CAMERA_OFFLINE', `${cam.toUpperCase()} did not answer`);
      return;
    }
    if (this.scenarios.sdMissing) {
      this.respondError(frame, 'SD_NOT_MOUNTED', 'No durable storage path');
      return;
    }
    if (this.soakRunning) {
      this.respondError(frame, 'BUSY', 'A soak run is already active');
      return;
    }

    const captures = Math.min(Math.max(1, Math.floor(req.captures ?? 100)), 1000);
    const jobId = `job_${++this.jobCounter}`;
    this.jobs.set(jobId, { id: jobId, cmd: Cmd.CAMERA_SOAK_TEST, step: 0, steps: captures });
    this.soakRunning = true;
    this.respond(frame, { jobId, accepted: true });

    // The simulated bench compresses the requested delay the same way the
    // SYNC_BENCH mock compresses triggers — the summary math is what matters.
    const tick = Math.min(Math.max(100, Math.floor(req.delayMs ?? 1000)), 200);
    const batch = Math.max(1, Math.round(captures / 10));
    let successful = 0;
    let failed = 0;
    let crcErrors = 0;
    let timeouts = 0;
    let sdErrorCount = 0;
    const jpeg: number[] = [];
    const ready: number[] = [];
    const transfer: number[] = [];
    const sdWrite: number[] = [];
    const errorCounts = new Map<string, number>();
    let firstUuid: string | null = null;
    let lastUuid: string | null = null;
    const leakStart = this.leakKB;

    for (let i = 0; i < captures; i++) {
      this.after(40 + i * tick, () => {
        const job = this.jobs.get(jobId);
        if (!job) return; // cancelled by a reboot or a dropped link
        const r = this.benchCapture(cam);
        if (r.ok) {
          successful++;
          jpeg.push(r.jpegBytes!);
          ready.push(r.readyMs!);
          transfer.push(r.transferMs!);
          sdWrite.push(r.sdMs!);
          const uuid = this.mockUuid();
          if (firstUuid === null) firstUuid = uuid;
          lastUuid = uuid;
        } else {
          failed++;
          if (r.code === 'TRANSFER_CRC_MISMATCH') crcErrors++;
          if (r.code === 'CAMERA_OFFLINE') timeouts++;
          if (r.code!.startsWith('SD_')) sdErrorCount++;
          errorCounts.set(r.code!, (errorCounts.get(r.code!) ?? 0) + 1);
        }
        job.step = i + 1;
        if ((i + 1) % batch === 0 || i + 1 === captures) {
          this.sendEvent(Evt.JOB_PROGRESS, {
            jobId,
            progress: (i + 1) / captures,
            step: 'capture',
            message: `${i + 1}/${captures} captures, ${failed} failed`,
          });
        }
      });
    }

    const stat = (xs: number[]) => ({
      min: xs.length > 0 ? Math.min(...xs) : null,
      max: xs.length > 0 ? Math.max(...xs) : null,
      avg: xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
    });

    this.after(40 + captures * tick + 60, () => {
      if (!this.jobs.delete(jobId)) return;
      this.soakRunning = false;
      const j = stat(jpeg);
      const rd = stat(ready);
      const tr = stat(transfer);
      const sw = stat(sdWrite);
      const leaked = this.leakKB - leakStart;
      this.sendEvent(Evt.JOB_COMPLETE, {
        jobId,
        result: {
          cam,
          attempted: captures,
          successful,
          failed,
          crcErrors,
          timeouts,
          nodeResets: 0,
          p4Resets: 0,
          sdErrors: sdErrorCount,
          minJpegBytes: j.min, maxJpegBytes: j.max, avgJpegBytes: j.avg,
          minCaptureReadyMs: rd.min, maxCaptureReadyMs: rd.max, avgCaptureReadyMs: rd.avg,
          minTransferMs: tr.min, maxTransferMs: tr.max, avgTransferMs: tr.avg,
          minSdWriteMs: sw.min, maxSdWriteMs: sw.max, avgSdWriteMs: sw.avg,
          heapDeltaKB: leaked > 0 ? -leaked : this.randInt(-1, 1),
          psramDeltaKB: leaked > 0 ? -4 * leaked : this.randInt(-2, 2),
          firstCaptureUuid: firstUuid,
          lastCaptureUuid: lastUuid,
          errors: Array.from(errorCounts, ([code, count]) => ({ code, count })),
        },
      });
      this.log('P4', `soak ${jobId} done — ${successful}/${captures} ok, ${failed} failed`);
    });
  }

  private handleHwValidation(frame: Frame) {
    const sd = !this.scenarios.sdMissing;
    const cam1 = !this.busUnreachable('cam1');
    const sensor1 = cam1 && this.cams.cam1.fault !== 'sensor-missing';
    const item = (id: string, ok: boolean, detail?: string): HwValidationItem =>
      ok ? { id, status: 'validated', ...(detail ? { detail } : {}) } : { id, status: 'unvalidated' };
    const items: HwValidationItem[] = [
      // The host is literally talking to this device, so its Studio
      // transport is proven by construction.
      item('USB_SERIAL_JTAG', true, 'host frame decoded'),
      item('SD_CLK_GPIO43', sd, 'mounted'),
      item('SD_CMD_GPIO44', sd, 'mounted'),
      item('SD_D0_GPIO39', sd, 'mounted'),
      item('SD_D1_GPIO40', sd, 'mounted'),
      item('SD_D2_GPIO41', sd, 'mounted'),
      item('SD_D3_GPIO42', sd, 'mounted'),
      item('SD_LDO_CH4', sd, 'mounted'),
      item('CAM1_TX_GPIO52', cam1, 'node HELLO answered'),
      item('CAM1_RX_GPIO51', cam1, 'node HELLO answered'),
      item('CAM1_BAUD_921600', cam1, 'node HELLO at 921600'),
      item('CAM1_NODE_LINK', cam1, 'node HELLO answered'),
      item('CAM1_SENSOR_DETECT', sensor1, 'OV3660'),
      item('CAM1_CAPTURE', this.captureProven, 'checksummed capture'),
      item('CAM1_JPEG_TRANSFER', this.captureProven, 'transfer CRC matched'),
      item('CAM1_SD_WRITE', this.captureProven && sd, 'stored file verified'),
    ];
    this.respond(frame, { p4ResetReason: this.resetReason, items });
  }

  private dispatch(frame: Frame) {
    const cmd = frame.type as Cmd;

    // Firmware profile gate (issue #72): a profile pinned to a real firmware
    // generation answers exactly that firmware's command surface — HELLO is
    // always alive, everything unimplemented NACKs with the firmware version
    // in the message, exactly like the C dispatcher's default arm.
    const profileCommands = FIRMWARE_PROFILES[this.firmwareProfileId].implementedCommands;
    if (profileCommands !== null && frame.type !== Cmd.HELLO && !profileCommands.includes(frame.type)) {
      this.respondError(
        frame,
        'UNSUPPORTED_COMMAND',
        `Command ${Cmd[cmd] ?? '0x' + frame.type.toString(16)} not implemented in firmware ${this.p4Fw}`,
      );
      return;
    }

    const gated =
      (this.scenarios.unsupportedCommands &&
        MockKinoDevice.OPTIONAL_COMMANDS.includes(frame.type)) ||
      (!this.supportsNetworkRoll() &&
        MockKinoDevice.NETWORK_ROLL_COMMANDS.includes(frame.type)) ||
      (!this.supportsBench() && MockKinoDevice.BENCH_COMMANDS.includes(frame.type));
    if (gated) {
      this.respondError(
        frame,
        'UNSUPPORTED_COMMAND',
        `Command ${Cmd[cmd] ?? '0x' + frame.type.toString(16)} not implemented in firmware ${this.p4Fw}`,
      );
      return;
    }

    switch (cmd) {
      case Cmd.HELLO: {
        // KINO Twin §12: a boot glitch that swallows the first handshake —
        // one-shot, exercising the same reconnect/retry path a real dropped
        // frame would.
        if (this.scenarios.dropFirstHello) {
          this.scenarios.dropFirstHello = false;
          this.scenarioCb?.();
          return;
        }
        const req = decodeJson<{ nonce?: number }>(frame.payload);
        // 04 §4: selected protocol, nonce echo, device ID, boot/session ID.
        //
        // A device that selects a protocol outside the offered range is the
        // one handshake failure a retry cannot fix, and the host has to say so
        // rather than time out. The framing version is untouched — this is
        // firmware from the future, not a corrupt stream.
        this.respond(frame, {
          product: 'KINO',
          protocol: this.scenarios.protocolMismatch ? 99 : PROTOCOL_VERSION,
          nonce: req.nonce,
          deviceId: this.deviceId,
          sessionId: this.sessionId,
        });
        return;
      }
      case Cmd.NETWORK_LIST:
      case Cmd.NETWORK_SET:
      case Cmd.NETWORK_DELETE:
      case Cmd.NETWORK_STATUS:
        this.handleNetwork(frame, cmd);
        return;
      case Cmd.ROLL_STATUS:
      case Cmd.ROLL_CREATE:
      case Cmd.ROLL_JOIN:
      case Cmd.ROLL_LEAVE:
        this.handleRoll(frame, cmd);
        return;
      case Cmd.UPLOAD_QUEUE_STATUS:
        this.respond(frame, this.uploadQueueReport());
        return;
      case Cmd.UPLOAD_QUEUE_RETRY: {
        const retried = this.uploads.failed;
        this.uploads.pending += retried;
        this.uploads.failed = 0;
        if (retried > 0) {
          this.log('P4', `upload retry — ${retried} item(s) requeued`);
          // A queue that had already drained is asleep; requeued work wakes it.
          if (this.scenarios.uploadBacklog) this.armUploadDrain();
        }
        this.respond(frame, { ok: true, retried, queue: this.uploadQueueReport() });
        return;
      }
      case Cmd.UPLOAD_ENQUEUE: {
        const { captureId } = decodeJson<{ captureId?: string }>(frame.payload);
        if (typeof captureId !== 'string' || captureId.length === 0) {
          this.respondError(frame, 'INVALID_ARGUMENT', 'captureId is required');
          return;
        }
        // Queueing into no Roll would silently drop the capture. The camera
        // has to be on one before it accepts work for it.
        if (!this.roll) {
          this.respondError(frame, 'INVALID_STATE', 'Not on a roll');
          return;
        }
        if (!this.media.list().some((c) => c.id === captureId)) {
          this.respondError(frame, 'NOT_FOUND', `No capture ${captureId}`);
          return;
        }
        this.uploads.pending++;
        this.log('P4', `queued ${captureId} for roll ${this.roll.slug}`);
        // A queue that had already drained is asleep; new work wakes it.
        if (this.scenarios.uploadBacklog) this.armUploadDrain();
        this.respond(frame, { ok: true, captureId, queue: this.uploadQueueReport() });
        return;
      }
      case Cmd.GET_CAPABILITIES: {
        const legacy = this.scenarios.legacyFirmware;
        const capabilities = {
          cameraCount: 4,
          wiggle: true,
          quad: true,
          gallery: true,
          flashControl: true,
          // A firmware that predates the timing work reports these false;
          // Studio must degrade gracefully rather than time out.
          vsyncTelemetry: !legacy,
          phaseCalibration: !legacy,
          xiaoProxyUpdate: !legacy,
          linkBench: !legacy,
          customSounds: !legacy,
          // OV5640_AF capability group (audit #55): derived from the actual
          // per-camera sensor profiles, never assumed from a model name.
          autofocus: !legacy && this.hasAutofocus(),
          focusLock: !legacy && this.hasAutofocus(),
          manualFocus: !legacy && this.hasAutofocus(),
          // 04 §7 Network/Roll. Same predicate the dispatcher gates on, so
          // what the device claims and what it answers cannot drift apart.
          rollUpload: this.supportsNetworkRoll(),
          network: this.supportsNetworkRoll(),
          syncBench: this.supportsNetworkRoll(),
          // Milestone 1B bench diagnostics — same predicate as the gate on
          // STORAGE_SELF_TEST / CAMERA_LINK_STATS(_RESET) / CAMERA_SOAK_TEST /
          // GET_HW_VALIDATION below.
          benchDiagnostics: this.supportsBench(),
          // KINO Twin §11: editable to test future firmware/hardware.
          ...(this.capabilityOverrides ?? {}),
        };
        this.respond(frame, {
          protocol: PROTOCOL_VERSION,
          hardware: 'kino-v1',
          firmware: this.p4Fw,
          capabilities,
          limits: {
            // M1B firmware honestly caps at its one validated baud (issue #72).
            maxUartBaud: FIRMWARE_PROFILES[this.firmwareProfileId].maxUartBaud,
            currentUartBaud: this.uartBaud,
            maxResolution: '2048x1536',
            maxGalleryPageSize: 100,
          },
          configSchemaVersion: 1,
          // KINO Twin §20 nodeFwMismatch: CAM4 is on an out-of-date build.
          firmwareMismatch: this.scenarios.nodeFwMismatch,
        });
        return;
      }
      case Cmd.GET_DEVICE_INFO:
        this.respond(frame, {
          product: this.identity.product,
          hardware: this.identity.hardwareRevision,
          serial: this.identity.serial,
          protocol: PROTOCOL_VERSION,
          p4Firmware: this.p4Fw,
          // Offline nodes report empty strings, and the sensor string follows
          // each camera's actual profile — matching the M1B firmware's
          // handle_device_info rather than a hardcoded happy path.
          cameraFirmware: CAM_IDS.map((id) => (this.busUnreachable(id) ? '' : this.camFirmware(id))),
          sensors: CAM_IDS.map((id) =>
            this.busUnreachable(id) ? '' : this.cams[id].sensorProfile === 'OV5640_AF' ? 'OV5640' : 'OV3660',
          ),
          sdPresent: !this.scenarios.sdMissing,
          sdFreeMB: this.scenarios.sdMissing || this.scenarios.sdFull ? 0 : this.sdFreeMB,
          activeMode: this.config.mode,
          activeRecipe: this.config.wiggle.recipeId,
        });
        return;
      case Cmd.GET_CAMERA_INFO:
        this.respond(frame, { cameras: CAM_IDS.map((id) => this.cameraInfo(id)) });
        return;
      case Cmd.GET_POWER_STATUS: {
        let v = this.batteryV;
        if (this.scenarios.lowBattery) v = 3.42;
        // KINO Twin §20 batterySag: a steady 3.55 V baseline that dips a
        // further 0.25 V for a moment right after a capture draws current.
        else if (this.scenarios.batterySag) v = this.now() < this.batterySagUntil ? 3.3 : 3.55;
        const pct = Math.max(0, Math.min(100, Math.round(((v - 3.3) / (4.2 - 3.3)) * 100)));
        const charging = this.scenarios.chargerConnected;
        this.respond(frame, {
          batteryV: Math.round(v * 100) / 100,
          batteryPct: pct,
          state: charging ? 'usb' : 'battery',
          charging,
          chargingA: charging ? 0.6 : 0,
          // The 5 V rail as this firmware "measures" it: nominal, dipping
          // with the battery-sag transient, dead when the fuse is blown.
          busV: this.scenarios.fuseBlown ? 0 : this.scenarios.batterySag && this.now() < this.batterySagUntil ? 4.82 : 5.0,
          fuse: this.scenarios.fuseBlown ? 'blown' : 'ok',
        });
        return;
      }
      case Cmd.GET_STORAGE_STATUS: {
        const present = !this.scenarios.sdMissing;
        const freeMB = this.scenarios.sdMissing || this.scenarios.sdFull ? 0 : this.sdFreeMB;
        this.respond(frame, {
          present,
          totalMB: 30432,
          freeMB,
          // Milestone 1B optional fields ride only on a bench-capable build,
          // like real pre-1B firmware would omit them.
          ...(this.supportsBench()
            ? {
                mounted: present,
                filesystem: present ? 'FAT' : null,
                capacityBytes: 30432 * 1024 * 1024,
                freeBytes: freeMB * 1024 * 1024,
                lastError: present ? null : 'MOUNT_FAILED',
                mountAttempts: this.storageMountAttempts,
                writeTestStatus: this.storageWriteTest,
              }
            : {}),
        });
        return;
      }
      case Cmd.GET_CONFIG:
        this.respond(frame, {
          schemaVersion: 1,
          device: 'kino-v1',
          configRevision: this.configRevision,
          config: this.config,
        });
        return;
      case Cmd.SET_CONFIG: {
        const env = decodeJson<{ schemaVersion?: number; config?: Partial<KinoConfig> }>(frame.payload);
        if (env.schemaVersion !== undefined && env.schemaVersion !== 1) {
          this.respondError(
            frame,
            'SCHEMA_MISMATCH',
            `Config schema ${env.schemaVersion} not supported by this firmware (expects 1)`,
          );
          return;
        }
        const patch = env.config ?? {};
        const credentials = patch.roll?.credentials;
        if (
          credentials?.deviceToken !== undefined &&
          credentials.deviceId !== undefined &&
          credentials.serverUrl !== undefined
        ) {
          this.rollCredentials = {
            deviceId: credentials.deviceId,
            deviceToken: credentials.deviceToken,
            serverUrl: credentials.serverUrl,
          };
          patch.roll = {
            ...patch.roll,
            credentials: {
              deviceId: credentials.deviceId,
              serverUrl: credentials.serverUrl,
              hasDeviceToken: true,
            },
          };
        }
        this.config = deepMerge(this.config, patch);
        this.configRevision++;
        this.log('P4', `config updated from host (revision ${this.configRevision})`);
        this.respond(frame, { ok: true, configRevision: this.configRevision });
        return;
      }
      case Cmd.SAVE_CONFIG:
        this.log('P4', 'config written to NVS');
        this.respond(frame, { ok: true });
        return;
      case Cmd.RESET_CONFIG:
        this.config = defaultConfig();
        this.rollCredentials = null;
        this.log('P4', 'config reset to defaults');
        this.respond(frame, { ok: true });
        return;
      case Cmd.GET_MODES:
        this.respond(frame, { modes: ['wiggle', 'quad'] });
        return;
      case Cmd.SET_MODE: {
        const { mode } = decodeJson<{ mode: 'wiggle' | 'quad' }>(frame.payload);
        this.config.mode = mode;
        this.log('P4', `mode set: ${mode.toUpperCase()}`);
        this.respond(frame, { ok: true });
        return;
      }
      case Cmd.GET_RECIPES:
        this.respond(frame, { factory: FACTORY_RECIPES, custom: [...this.customRecipes.values()] });
        return;
      case Cmd.SET_RECIPE: {
        const { id } = decodeJson<{ id: string }>(frame.payload);
        this.config.wiggle.recipeId = id;
        this.respond(frame, { ok: true });
        return;
      }
      case Cmd.UPLOAD_RECIPE: {
        const { recipe } = decodeJson<{ recipe: unknown }>(frame.payload);
        const check = validateDeviceRecipe(recipe);
        if (!check.ok) {
          this.respondError(frame, 'INVALID_ARGUMENT', check.error);
          return;
        }
        if (FACTORY_RECIPES.some((r) => r.id === check.recipe.id)) {
          this.respondError(frame, 'FACTORY_LOCKED', 'Factory recipe ids cannot be overwritten');
          return;
        }
        this.customRecipes.set(check.recipe.id, { ...check.recipe, factory: false });
        this.log('P4', `recipe stored: ${check.recipe.name}`);
        this.respond(frame, { ok: true });
        return;
      }
      case Cmd.DELETE_RECIPE: {
        const { id } = decodeJson<{ id: string }>(frame.payload);
        if (FACTORY_RECIPES.some((r) => r.id === id)) {
          this.respondError(frame, 'FACTORY_LOCKED', 'Factory recipes cannot be deleted');
          return;
        }
        this.customRecipes.delete(id);
        this.respond(frame, { ok: true });
        return;
      }
      case Cmd.GET_SOUNDS:
      case Cmd.SOUND_BEGIN:
      case Cmd.SOUND_CHUNK:
      case Cmd.SOUND_END:
      case Cmd.SOUND_READ:
      case Cmd.SOUND_DELETE:
        this.handleSound(frame, cmd);
        return;
      case Cmd.CAMERA_STATUS: {
        const { cam } = decodeJson<{ cam: CamId }>(frame.payload);
        if (cam === 'cam2' && this.scenarios.cam2Timeout) {
          this.camTimeouts++;
          return; // deliberately no response — host times out
        }
        this.respond(frame, this.cameraInfo(cam));
        return;
      }
      case Cmd.CAMERA_TEST: {
        const { cam } = decodeJson<{ cam: CamId }>(frame.payload);
        // KINO Twin §20: offline/power-open NACK CAM_OFFLINE — a distinct
        // code from cam2Timeout's CAM_UNREACHABLE, since one is "not there"
        // and the other is "there but not answering in time".
        if (this.busUnreachable(cam)) {
          this.after(400, () => this.respondError(frame, 'CAM_OFFLINE', `${cam.toUpperCase()} did not answer test capture`));
          return;
        }
        if (cam === 'cam2' && this.scenarios.cam2Timeout) {
          this.after(400, () => this.respondError(frame, 'CAM_UNREACHABLE', `${cam.toUpperCase()} did not answer test capture`));
          return;
        }
        if (this.cams[cam].fault === 'sensor-missing') {
          this.after(400, () => this.respondError(frame, 'SENSOR_MISSING', `${cam.toUpperCase()} sensor not detected`));
          return;
        }
        const r = this.benchCapture(cam);
        const delay = 350 + (this.cams[cam].fault === 'slow-uart' ? 1200 : 0);
        this.after(delay, () => {
          if (!r.ok) {
            this.log(('C' + cam.slice(-1)) as LogSource, `test capture FAILED — ${r.code}`);
            this.respondError(frame, r.code!, r.message!);
            return;
          }
          const kb = Math.round(r.jpegBytes! / 1024);
          this.log(('C' + cam.slice(-1)) as LogSource, `test capture ok — jpeg ${kb} KB`);
          if (!this.supportsBench()) {
            // Pre-1B firmware shape.
            this.respond(frame, { ok: true, jpegKB: kb, durationMs: r.readyMs });
            return;
          }
          this.respond(frame, this.captureResult(cam, r));
        });
        return;
      }
      case Cmd.CAMERA_CALIBRATE:
        this.handleCalibrate(frame);
        return;
      case Cmd.GET_LOGS:
        this.respond(frame, { entries: this.logBuffer.slice(-200) });
        return;
      case Cmd.CLEAR_LOGS:
        this.logBuffer = [];
        this.respond(frame, { ok: true });
        return;
      case Cmd.SELF_TEST:
        this.handleSelfTest(frame);
        return;
      case Cmd.SYNC_BENCH:
        this.handleSyncBench(frame);
        return;
      case Cmd.STORAGE_SELF_TEST:
        this.handleStorageSelfTest(frame);
        return;
      case Cmd.CAMERA_LINK_STATS:
        this.handleLinkStats(frame);
        return;
      case Cmd.CAMERA_LINK_STATS_RESET:
        this.handleLinkStatsReset(frame);
        return;
      case Cmd.CAMERA_SOAK_TEST:
        this.handleSoakTest(frame);
        return;
      case Cmd.GET_HW_VALIDATION:
        this.handleHwValidation(frame);
        return;
      case Cmd.GET_RUNTIME_STATS:
        this.respond(frame, {
          uptimeS: Math.round((this.now() - this.bootedAt) / 1000),
          resetReason: this.resetReason,
          freeHeapKB: this.randInt(148, 176),
          freePsramKB: this.randInt(11800, 14200),
          tempC: { p4: Math.round(this.rand(38, 46)), cams: CAM_IDS.map(() => Math.round(this.rand(34, 44))) },
          uartBaud: this.uartBaud,
          protocol: {
            droppedPackets: this.decoder.stats.resyncs,
            crcFailures: this.decoder.stats.crcFailures,
            cameraTimeouts: this.camTimeouts,
            sdErrors: this.sdErrors,
          },
        });
        return;
      case Cmd.ENTER_MAINTENANCE:
        this.maintenance = true;
        this.stopAmbient();
        this.log('P4', 'maintenance mode — capture disabled');
        this.respond(frame, { ok: true });
        return;
      case Cmd.EXIT_MAINTENANCE:
        this.maintenance = false;
        this.startAmbient();
        this.log('P4', 'maintenance mode exited');
        this.respond(frame, { ok: true });
        return;
      case Cmd.REBOOT:
        this.respond(frame, { ok: true });
        this.after(300, () => this.reboot('host-reboot'));
        return;
      case Cmd.FACTORY_RESET:
        this.config = defaultConfig();
        this.customRecipes.clear();
        this.customSounds.clear();
        this.soundSession = null;
        this.calibration = neutralCalibration();
        this.log('P4', 'factory reset — config, recipes, sounds, calibration cleared');
        this.respond(frame, { ok: true });
        this.after(400, () => this.reboot('factory-reset'));
        return;
      case Cmd.FW_QUERY: {
        const targets: Record<string, { version: string; state: string }> = {
          p4: { version: this.p4Fw, state: this.fwStates.p4.state },
        };
        for (const id of CAM_IDS) targets[id] = { version: this.camFirmware(id), state: this.fwStates[id].state };
        this.respond(frame, { targets });
        return;
      }
      case Cmd.FW_BEGIN:
        this.handleFwBegin(frame);
        return;
      case Cmd.FW_CHUNK:
        this.handleFwChunk(frame);
        return;
      case Cmd.FW_END:
        this.handleFwEnd(frame);
        return;
      case Cmd.FW_ABORT:
        if (this.fwSession) {
          const target = this.fwSession.target;
          this.fwStates[target] = { state: 'idle' };
          if (target !== 'p4') this.cams[target].updating = false;
          this.fwSession = null;
          this.emitTelemetry({ t: 'fw', target, state: 'idle' });
        }
        this.respond(frame, { ok: true });
        return;
      case Cmd.FW_STATUS: {
        const { target } = decodeJson<{ target: TargetId }>(frame.payload);
        const st = this.fwStates[target];
        this.respond(frame, {
          target,
          state: st.state,
          version: target === 'p4' ? this.p4Fw : this.camFirmware(target),
          ...(st.error ? { error: st.error } : {}),
        });
        return;
      }
      case Cmd.MEDIA_LIST:
      case Cmd.MEDIA_INFO:
      case Cmd.MEDIA_THUMB:
      case Cmd.MEDIA_READ:
      case Cmd.MEDIA_DELETE:
      case Cmd.MEDIA_FAVORITE:
        void this.handleMedia(frame, cmd);
        return;
      case Cmd.CAMERA_PREVIEW: {
        const { cam } = decodeJson<{ cam?: CamId }>(frame.payload);
        const camId = cam ?? this.config.shoot.viewfinder;
        if (this.busUnreachable(camId)) {
          this.respondError(frame, 'CAM_OFFLINE', `${camId.toUpperCase()} is offline`);
          return;
        }
        const phaseMs = this.now() - this.bootedAt;
        const source = this.frameSource;
        void (async () => {
          let bytes: Uint8Array | null = null;
          if (source) {
            // Virtual sensor first (issue #72); anything wrong falls back to
            // the synthesized preview so the wire never goes silent.
            try {
              bytes = await source({ cam: camId, kind: 'preview', width: 320, height: 240, phaseMs });
            } catch {
              bytes = null;
            }
          }
          if (bytes === null || bytes.length === 0 || bytes.length > 16_000) {
            bytes = await renderPreviewFrame(Number(camId.slice(-1)) - 1, phaseMs);
          }
          this.respondBytes(frame, bytes);
        })().catch((err) =>
          this.respondError(frame, 'PREVIEW_FAILED', err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      case Cmd.CAMERA_FOCUS: {
        this.handleCameraFocus(frame);
        return;
      }
      case Cmd.CAMERA_CAPTURE: {
        const req = decodeJson<{ action?: string }>(frame.payload);
        if (req.action === 'timing-test') {
          if (this.anyCamDown() || this.scenarios.cam2Timeout) {
            this.respondError(frame, 'CAM_UNREACHABLE', 'All four cameras are required for a timing test');
            return;
          }
          this.after(650, () => {
            this.batteryV = Math.max(3.3, this.batteryV - this.rand(0.002, 0.006)); // flash pulse
            this.respond(frame, this.measureTiming());
          });
          return;
        }
        // KINO Twin §20 sdFull: a 0 MB free card NACKs a capture instead of
        // silently losing it — the core §18 rule (capture → SD first) means
        // this is the one condition allowed to actually refuse a shot.
        if (this.scenarios.sdFull) {
          this.respondError(frame, 'SD_FULL', 'SD card full — 0 MB free');
          return;
        }
        // KINO Twin §5: a host-triggered capture runs the same pipeline as
        // the ambient loop (batterySag included), so capture telemetry and
        // the eventual media commit fire whether the shot came from
        // Studio's shutter or the demo's own idle loop. The wire response
        // stays the documented mock `{ ok: true }` either way.
        this.respond(frame, { ok: true });
        this.simulateCapture();
        return;
      }
      case Cmd.CAMERA_PHASE:
        this.handlePhase(frame);
        return;
      case Cmd.LINK_BENCH:
        this.handleLinkBench(frame);
        return;
      case Cmd.SET_LINK_BAUD: {
        if (this.scenarios.legacyFirmware) {
          this.respondError(frame, 'UNSUPPORTED_COMMAND', 'Link baud switching not implemented in this firmware');
          return;
        }
        const { baud } = decodeJson<{ baud: number }>(frame.payload);
        if (![921600, 1500000, 2000000, 3000000].includes(baud)) {
          this.respondError(frame, 'BAD_BAUD', `Unsupported baud ${baud}`);
          return;
        }
        this.uartBaud = baud;
        this.log('P4', `camera UART baud set to ${baud}`);
        this.respond(frame, { ok: true, baud });
        return;
      }
      case Cmd.CAMERA_ARM:
        this.respond(frame, { ok: true });
        return;
      default:
        // Explicit NACK, never silence — Studio can then say "not supported"
        // instead of waiting for a timeout.
        this.respondError(
          frame,
          'UNSUPPORTED_COMMAND',
          `Command ${Cmd[cmd] ?? '0x' + (cmd as number).toString(16)} not implemented in firmware ${this.p4Fw}`,
        );
    }
  }

  // ---- network / roll (04 §7) ----

  /**
   * 05 §13: a saved password is write-only. The camera needs it to join, and
   * nothing that leaves the camera — list reply, log line, backup — ever
   * contains it. The device reports whether one is stored, never what it is.
   */
  private networkView(n: SavedNetwork) {
    return {
      ssid: n.ssid,
      password: MASKED_PASSWORD,
      hasPassword: n.password.length > 0,
      security: n.security,
      autoJoin: n.autoJoin,
      lastSeen: n.lastSeen,
    };
  }

  private handleNetwork(frame: Frame, cmd: Cmd) {
    switch (cmd) {
      case Cmd.NETWORK_LIST:
        this.respond(frame, { networks: this.networks.map((n) => this.networkView(n)) });
        return;
      case Cmd.NETWORK_SET: {
        const req = decodeJson<{
          ssid?: string;
          password?: string;
          security?: SavedNetwork['security'];
          autoJoin?: boolean;
        }>(frame.payload);
        const ssid = typeof req.ssid === 'string' ? req.ssid.trim() : '';
        if (!ssid || ssid.length > 32) {
          this.respondError(frame, 'INVALID_ARGUMENT', 'SSID must be 1-32 characters');
          return;
        }
        const security = req.security ?? 'wpa2';
        const password = typeof req.password === 'string' ? req.password : '';
        const existing = this.networks.find((n) => n.ssid === ssid);
        // Editing a known network without sending a passphrase is the normal
        // case, not a malformed request: NETWORK_LIST only ever handed the host
        // a mask, so it has nothing to send back. The length rule therefore
        // applies to a passphrase actually being set — checking it first made
        // the keep-what-is-stored path below unreachable.
        const keepsStored = existing !== undefined && password.length === 0 && existing.password.length > 0;
        if (security !== 'open' && !keepsStored && password.length < 8) {
          this.respondError(frame, 'INVALID_ARGUMENT', 'WPA passphrase must be at least 8 characters');
          return;
        }
        if (existing) {
          if (password.length > 0) existing.password = password;
          existing.security = security;
          existing.autoJoin = req.autoJoin ?? existing.autoJoin;
        } else {
          this.networks.push({
            ssid,
            password,
            security,
            autoJoin: req.autoJoin ?? true,
            lastSeen: null,
          });
        }
        // Deliberately no password in the log line.
        this.log('P4', `wifi network saved: ${ssid}`);
        this.respond(frame, { ok: true, networks: this.networks.map((n) => this.networkView(n)) });
        return;
      }
      case Cmd.NETWORK_DELETE: {
        const { ssid } = decodeJson<{ ssid: string }>(frame.payload);
        const before = this.networks.length;
        this.networks = this.networks.filter((n) => n.ssid !== ssid);
        if (this.networks.length === before) {
          this.respondError(frame, 'INVALID_ARGUMENT', `No saved network ${ssid}`);
          return;
        }
        this.log('P4', `wifi network removed: ${ssid}`);
        this.respond(frame, { ok: true, networks: this.networks.map((n) => this.networkView(n)) });
        return;
      }
      case Cmd.NETWORK_STATUS: {
        // KINO Twin §20: wifiLost overrides any saved auto-join network.
        const active = this.scenarios.wifiLost ? null : this.networks.find((n) => n.autoJoin) ?? null;
        this.respond(
          frame,
          active
            ? {
                state: 'connected',
                ssid: active.ssid,
                ip: '192.168.1.74',
                rssi: this.randInt(-68, -42),
                since: this.bootedAt,
                internet: true,
              }
            : { state: 'disconnected', ssid: null, ip: null, rssi: null, since: null, internet: false },
        );
        return;
      }
      default:
        this.respondError(frame, 'UNSUPPORTED_COMMAND', 'Unhandled network command');
    }
  }

  private rollView() {
    // KINO Twin §18 camera-side network state, orthogonal to whether a roll
    // is currently joined.
    const network = {
      serverReachable: !this.scenarios.rollServerUnreachable,
      tokenStatus: this.scenarios.rollTokenExpired ? ('token-expired' as const) : ('ok' as const),
    };
    if (!this.roll) return { active: false, roll: null, queue: this.uploadQueueReport(), ...network };
    return {
      active: true,
      roll: {
        rollId: this.roll.rollId,
        slug: this.roll.slug,
        guestUrl: this.roll.guestUrl,
        name: this.roll.name,
        role: this.roll.role,
        joinedAt: this.roll.joinedAt,
      },
      queue: this.uploadQueueReport(),
      ...network,
    };
  }

  private handleRoll(frame: Frame, cmd: Cmd) {
    switch (cmd) {
      case Cmd.ROLL_STATUS:
        this.respond(frame, this.rollView());
        return;
      case Cmd.ROLL_CREATE: {
        if (this.roll) {
          this.respondError(frame, 'INVALID_STATE', `Already on roll ${this.roll.slug}`);
          return;
        }
        const req = decodeJson<{ name?: string }>(frame.payload);
        this.rollCounter++;
        const word = ROLL_WORDS[(this.rollCounter - 1) % ROLL_WORDS.length];
        const slug = `${word}-${String(this.rollCounter).padStart(3, '0')}`;
        this.roll = {
          rollId: `roll_${String(this.rollCounter).padStart(4, '0')}`,
          slug,
          guestUrl: `https://kino.roll/${slug}`,
          name: (req.name ?? 'Untitled roll').slice(0, 60),
          role: 'host',
          joinedAt: this.now(),
        };
        this.log('P4', `roll created: ${slug}`);
        this.respond(frame, {
          rollId: this.roll.rollId,
          slug: this.roll.slug,
          guestUrl: this.roll.guestUrl,
          name: this.roll.name,
          role: this.roll.role,
        });
        return;
      }
      case Cmd.ROLL_JOIN: {
        const req = decodeJson<{
          slug?: string;
          code?: string;
          rollId?: string;
          guestUrl?: string;
          name?: string;
          role?: 'host' | 'guest';
          uploadScope?: 'upload';
        }>(frame.payload);
        const slug = (req.slug ?? req.code ?? '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(slug)) {
          this.respondError(frame, 'INVALID_ARGUMENT', 'Roll code must be a slug like amber-001');
          return;
        }
        if (this.roll) {
          this.respondError(frame, 'INVALID_STATE', `Already on roll ${this.roll.slug}`);
          return;
        }
        this.rollCounter++;
        this.roll = {
          rollId: req.rollId ?? `roll_${slug}`,
          slug,
          guestUrl: req.guestUrl ?? `https://kino.roll/${slug}`,
          name: req.name ?? slug,
          role: req.role ?? 'guest',
          joinedAt: this.now(),
        };
        this.log('P4', `joined roll: ${slug}`);
        this.respond(frame, this.rollView());
        return;
      }
      case Cmd.ROLL_LEAVE: {
        if (!this.roll) {
          this.respondError(frame, 'INVALID_STATE', 'Not on a roll');
          return;
        }
        this.log('P4', `left roll: ${this.roll.slug}`);
        this.roll = null;
        this.respond(frame, { ok: true, ...this.rollView() });
        return;
      }
      default:
        this.respondError(frame, 'UNSUPPORTED_COMMAND', 'Unhandled roll command');
    }
  }

  private uploadQueueReport() {
    const q = this.uploads;
    return {
      pending: q.pending,
      uploading: q.uploading,
      failed: q.failed,
      uploaded: q.uploaded,
      draining: this.uploadTimer !== null,
    };
  }

  // ---- async jobs (04 §15) ----

  /**
   * SYNC_BENCH: fire N triggers and report per-camera timing for each. Runs
   * through the job model because a hundred triggers outlives any request
   * deadline. Deterministic per trigger index so the stats module downstream
   * has a stable fixture to test against.
   */
  private handleSyncBench(frame: Frame) {
    const req = decodeJson<{ triggers?: number }>(frame.payload);
    const triggers = Math.min(Math.max(1, Math.floor(req.triggers ?? 20)), 200);
    if (this.anyCamDown() || this.scenarios.cam2Timeout) {
      this.respondError(frame, 'CAMERA_OFFLINE', 'All four cameras are required for a sync bench');
      return;
    }
    const jobId = `job_${++this.jobCounter}`;
    this.jobs.set(jobId, { id: jobId, cmd: Cmd.SYNC_BENCH, step: 0, steps: triggers });
    this.respond(frame, { jobId, accepted: true });
    this.log('P4', `sync bench started — ${triggers} triggers`);

    const samples: { trigger: number; cams: { cam: CamId; gpioUs: number; vsyncPhaseUs: number; exposureUs: number }[] }[] = [];
    // Seeded from the job number so a rerun in the same session differs, but a
    // single run is reproducible from its first sample onward.
    const rnd = seeded(0x5e1f ^ this.jobCounter);
    const batch = Math.max(1, Math.round(triggers / 10));
    let t = 120;

    for (let i = 0; i < triggers; i++) {
      const index = i;
      this.after(t, () => {
        const job = this.jobs.get(jobId);
        if (!job) return; // cancelled by a reboot or a dropped link
        const jitter = this.phaseAligned ? 90 : 400;
        const cams = CAM_IDS.map((cam, c) => {
          const phase = Math.max(0, this.camPhaseUs[cam] + (rnd() * 2 - 1) * jitter);
          return {
            cam,
            gpioUs: Math.round(30 + c * 8 + rnd() * 60),
            vsyncPhaseUs: Math.round(phase),
            exposureUs: Math.round(phase - this.camPhaseUs.cam2 + rnd() * 900),
          };
        });
        samples.push({ trigger: index, cams });
        job.step = index + 1;
        if ((index + 1) % batch === 0 || index + 1 === triggers) {
          this.sendEvent(Evt.JOB_PROGRESS, {
            jobId,
            progress: (index + 1) / triggers,
            step: 'trigger',
            message: `${index + 1}/${triggers} triggers`,
          });
        }
      });
      t += 18;
    }

    this.after(t + 60, () => {
      if (!this.jobs.delete(jobId)) return;
      const spread = (values: number[]) => Math.round(Math.max(...values) - Math.min(...values));
      const perTrigger = samples.map((s) => ({
        trigger: s.trigger,
        gpioSpreadUs: spread(s.cams.map((c) => c.gpioUs)),
        vsyncSpreadUs: spread(s.cams.map((c) => c.vsyncPhaseUs)),
        exposureSpreadUs: spread(s.cams.map((c) => c.exposureUs)),
      }));
      this.log('P4', `sync bench done — ${samples.length} samples`);
      this.sendEvent(Evt.JOB_COMPLETE, {
        jobId,
        result: {
          triggers: samples.length,
          frameIntervalUs: this.frameIntervalUs,
          aligned: this.phaseAligned,
          samples,
          perTrigger,
        },
      });
    });
  }

  // ---- media (P4 file server) ----

  private async handleMedia(frame: Frame, cmd: Cmd) {
    if (this.scenarios.sdMissing) {
      this.sdErrors++;
      this.respondError(frame, 'SD_MISSING', 'No SD card mounted');
      return;
    }
    try {
      switch (cmd) {
        case Cmd.MEDIA_LIST: {
          const req = decodeJson<{ cursor?: number; limit?: number }>(frame.payload);
          const all = this.media.list();
          const cursor = Math.max(0, req.cursor ?? 0);
          const limit = Math.min(Math.max(1, req.limit ?? 100), 100);
          const items = all.slice(cursor, cursor + limit);
          const next = cursor + items.length;
          this.respond(frame, {
            total: all.length,
            items,
            nextCursor: next < all.length ? next : null,
            hasMore: next < all.length,
          });
          this.emitTelemetry({ t: 'sd', activity: 'read' });
          return;
        }
        case Cmd.MEDIA_INFO: {
          const { id } = decodeJson<{ id: string }>(frame.payload);
          const info = await this.media.info(id);
          if (!info) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else {
            this.respond(frame, info);
            this.emitTelemetry({ t: 'sd', activity: 'read' });
          }
          return;
        }
        case Cmd.MEDIA_THUMB: {
          const { id } = decodeJson<{ id: string }>(frame.payload);
          const bytes = await this.media.thumb(id);
          if (!bytes) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else {
            this.respondBytes(frame, bytes);
            this.emitTelemetry({ t: 'sd', activity: 'read' });
          }
          return;
        }
        case Cmd.MEDIA_READ: {
          const req = decodeJson<{ id: string; file: string; offset: number; length: number }>(frame.payload);
          const bytes = await this.media.fileBytes(req.id, req.file);
          if (!bytes) {
            this.respondError(frame, 'NOT_FOUND', `No file ${req.file} in ${req.id}`);
            return;
          }
          const offset = Math.max(0, req.offset | 0);
          const length = Math.min(Math.max(1, req.length | 0), 8192);
          this.respondBytes(frame, bytes.subarray(offset, Math.min(offset + length, bytes.length)));
          this.emitTelemetry({ t: 'sd', activity: 'read' });
          return;
        }
        case Cmd.MEDIA_DELETE: {
          const { id } = decodeJson<{ id: string }>(frame.payload);
          if (!this.media.delete(id)) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else {
            this.log('SD', `${id} deleted`);
            this.respond(frame, { ok: true });
            this.emitTelemetry({ t: 'sd', activity: 'write' });
          }
          return;
        }
        case Cmd.MEDIA_FAVORITE: {
          const { id, favorite } = decodeJson<{ id: string; favorite: boolean }>(frame.payload);
          if (!this.media.setFavorite(id, favorite)) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else {
            this.respond(frame, { ok: true });
            this.emitTelemetry({ t: 'sd', activity: 'write' });
          }
          return;
        }
        default:
          this.respondError(frame, 'UNKNOWN_CMD', 'Unhandled media command');
      }
    } catch (err) {
      this.respondError(frame, 'MEDIA_ERROR', err instanceof Error ? err.message : String(err));
    }
  }

  // ---- timing: GPIO edge vs sensor frame phase ----

  private measureTiming() {
    // GPIO distribution: wire + ISR entry. Small and mostly irrelevant.
    const gpio = CAM_IDS.map((_id, i) => Math.round(this.rand(30, 90) + i * this.rand(3, 12)));
    const gpioMin = Math.min(...gpio);

    // VSYNC phase: how long each sensor waits for its next frame start.
    // This is what decides which frame the sensor actually hands over.
    const jitter = this.phaseAligned ? 90 : 400;
    const phases = CAM_IDS.map((id) =>
      Math.max(0, this.effectivePhaseUs(id) + this.rand(-jitter, jitter)),
    );
    const phaseRef = phases[1]; // CAM2 reference

    const cams = CAM_IDS.map((camId, i) => {
      const vsyncPhaseUs = Math.round(phases[i]);
      // Effective exposure = trigger arrival + wait for frame start +
      // rolling-shutter row offset for the subject band.
      const rolling = this.rand(0, 900);
      return {
        cam: camId,
        gpioUs: Math.round(gpio[i] - gpioMin),
        vsyncPhaseUs,
        exposureUs: Math.round(phases[i] - phaseRef + rolling),
        // KINO Twin §20 no-vsync: this camera can't be trusted for phase.
        vsyncMeasured: !this.scenarios.legacyFirmware && this.cams[camId].fault !== 'no-vsync',
      };
    });

    const spread = (values: number[]) => Math.round(Math.max(...values) - Math.min(...values));
    const result = {
      cams,
      gpioSpreadUs: spread(cams.map((c) => c.gpioUs)),
      vsyncSpreadUs: spread(cams.map((c) => c.vsyncPhaseUs)),
      exposureSpreadUs: spread(cams.map((c) => c.exposureUs)),
      vsyncMeasured: !this.scenarios.legacyFirmware,
      frameIntervalUs: this.frameIntervalUs,
    };
    this.log(
      'P4',
      `timing: gpio ${result.gpioSpreadUs} us · vsync ${(result.vsyncSpreadUs / 1000).toFixed(2)} ms`,
    );
    return result;
  }

  private phaseSnapshot(aligned: boolean) {
    const cams = CAM_IDS.map((cam) => ({ cam, phaseUs: Math.round(this.effectivePhaseUs(cam)) }));
    const values = cams.map((c) => c.phaseUs);
    return {
      cams,
      spreadUs: Math.round(Math.max(...values) - Math.min(...values)),
      frameIntervalUs: this.frameIntervalUs,
      reference: 'cam2' as CamId,
      aligned,
    };
  }

  private handlePhase(frame: Frame) {
    if (this.scenarios.legacyFirmware) {
      this.respondError(frame, 'UNSUPPORTED_COMMAND', 'Phase calibration not implemented in this firmware');
      return;
    }
    const req = decodeJson<{ action: 'measure' | 'rephase' | 'reset' }>(frame.payload);
    if (req.action === 'measure') {
      this.after(400, () => this.respond(frame, this.phaseSnapshot(this.phaseAligned)));
      return;
    }
    if (req.action === 'reset') {
      this.camPhaseUs = { cam1: 7_420, cam2: 0, cam3: 21_880, cam4: 2_910 };
      this.phaseAligned = false;
      this.log('P4', 'sensor phase reset — sensors free-running');
      this.respond(frame, this.phaseSnapshot(false));
      return;
    }
    // Re-phase: restart each sensor with a compensating delay. Convergence
    // is partial per iteration, exactly like the real bench procedure.
    this.respond(frame, { started: true });
    let t = 500;
    for (const cam of CAM_IDS) {
      this.after(t, () => {
        this.log(('C' + cam.slice(-1)) as LogSource, 'sensor restart with phase offset');
        this.sendEvent(Evt.PHASE, { step: 'rephase', cam });
      });
      t += this.randInt(300, 500);
    }
    this.after(t + 300, () => {
      for (const cam of CAM_IDS) {
        if (cam === 'cam2') continue;
        // Each pass removes most of the remaining error but never all of it.
        this.camPhaseUs[cam] = this.camPhaseUs[cam] * this.rand(0.06, 0.16) + this.rand(-120, 120);
      }
      const snapshot = this.phaseSnapshot(false);
      this.phaseAligned = snapshot.spreadUs < 1200;
      const final = this.phaseSnapshot(this.phaseAligned);
      this.log('P4', `sensor phase spread now ${(final.spreadUs / 1000).toFixed(2)} ms`);
      this.sendEvent(Evt.PHASE, { step: 'result', ...final });
    });
  }

  // ---- UART link benchmark ----

  private handleLinkBench(frame: Frame) {
    if (this.scenarios.legacyFirmware) {
      this.respondError(frame, 'UNSUPPORTED_COMMAND', 'Link benchmark not implemented in this firmware');
      return;
    }
    const req = decodeJson<{ baud?: number; bytes?: number }>(frame.payload);
    const baud = req.baud ?? this.uartBaud;
    const bytes = Math.min(req.bytes ?? 262_144, 1_048_576);

    // Error behavior rises with baud: clean to 1.5M, marginal at 2M on the
    // longest harness, unusable at 3M until wiring is improved.
    const errorRate =
      baud <= 921_600 ? 0 : baud <= 1_500_000 ? 0 : baud <= 2_000_000 ? 0.0000012 : 0.000045;

    this.after(900, () => {
      const channels = CAM_IDS.map((cam, i) => {
        // CAM4 sits at the end of the longest run in the V1 harness.
        const penalty = i === 3 ? 2.2 : i === 0 ? 1.3 : 1;
        const crcErrors = Math.round(bytes * errorRate * penalty * this.rand(0.6, 1.4));
        const framingErrors = crcErrors > 0 ? Math.round(crcErrors * this.rand(0.1, 0.5)) : 0;
        // Payload throughput after 8N1 framing and protocol overhead.
        let kbytesPerSec = Math.round(((baud / 10) * this.rand(0.86, 0.93)) / 1024);
        // KINO Twin §20 slow-uart: this channel degrades, dragging the
        // overall bench duration up since it becomes the slowest channel.
        if (this.cams[cam].fault === 'slow-uart') kbytesPerSec = Math.round(kbytesPerSec / 8);
        return { cam, bytes, kbytesPerSec, crcErrors, framingErrors };
      });
      const clean = channels.every((c) => c.crcErrors === 0 && c.framingErrors === 0);
      // Concurrent transfer: wall clock is the slowest channel, not the sum.
      const slowest = Math.min(...channels.map((c) => c.kbytesPerSec));
      const durationMs = Math.round((bytes / 1024 / slowest) * 1000);
      this.log(
        'P4',
        `link bench @ ${baud}: ${clean ? 'clean' : 'errors'} · ${slowest} KB/s per channel`,
      );
      this.respond(frame, { baud, durationMs, channels, clean, concurrent: true });
    });
  }

  // ---- calibration ----

  private handleCalibrate(frame: Frame) {
    const req = decodeJson<{
      action:
        | 'get'
        | 'start'
        | 'apply'
        | 'reset'
        | 'order-blink'
        | 'order-save'
        | 'spacing-save'
        | 'flash-test'
        | 'flash-save';
      offsets?: Record<CamId, CamCalibration>;
      cam?: CamId;
      order?: [CamId, CamId, CamId, CamId];
      spacingMm?: [number, number, number, number];
      spacingSource?: 'nominal' | 'measured';
      flash?: { level: 'low' | 'medium' | 'high'; distance: '0.5-1' | '1-2' | '2-3' };
    }>(frame.payload);
    if (req.action === 'get') {
      this.respond(frame, this.calibration);
      return;
    }
    if (req.action === 'order-blink' && req.cam) {
      // Real hardware strobes that module's status LED; the demo just logs it.
      this.log(('C' + req.cam.slice(-1)) as LogSource, 'identify: status LED strobing');
      this.respond(frame, { ok: true });
      return;
    }
    if (req.action === 'order-save' && req.order) {
      const unique = new Set(req.order);
      if (unique.size !== 4) {
        this.respondError(frame, 'BAD_ORDER', 'Each physical position needs a different camera');
        return;
      }
      this.calibration.order = req.order;
      this.calibration.orderVerifiedAt = this.nowIso();
      this.log('P4', `camera order saved: ${req.order.map((c) => c.slice(-1)).join('-')}`);
      this.respond(frame, { ok: true });
      return;
    }
    if (req.action === 'spacing-save' && req.spacingMm) {
      this.calibration.spacingMm = req.spacingMm;
      this.calibration.spacingSource = req.spacingSource ?? 'measured';
      this.log('P4', 'lens spacing saved');
      this.respond(frame, { ok: true });
      return;
    }
    if (req.action === 'flash-test') {
      if (this.anyCamDown() || this.scenarios.cam2Timeout) {
        this.respondError(frame, 'CAM_UNREACHABLE', 'All four cameras are required for a flash test');
        return;
      }
      // KINO Twin §20 flashOverload: the driver reports a fault and a
      // thermal flag instead of a clip-percentage result.
      if (this.scenarios.flashOverload) {
        this.log('PWR', 'flash driver fault — thermal cutout');
        this.after(300, () =>
          this.respond(frame, { results: [], suggested: this.calibration.flash.level, fault: true, thermal: 'hot' }),
        );
        return;
      }
      this.log('P4', 'flash test capture — full pulse');
      this.after(900, () => {
        const level = req.flash?.level ?? this.calibration.flash.level;
        const base = level === 'low' ? 1.4 : level === 'medium' ? 3.1 : 6.2;
        const clip = () => Math.round((base + this.rand(-0.8, 1.2)) * 10) / 10;
        const results = CAM_IDS.map((cam) => ({ cam, clippedPct: Math.max(0.2, clip()) }));
        const avg = results.reduce((a, r) => a + r.clippedPct, 0) / 4;
        const suggested = avg > 5 ? 'low' : avg > 2.5 ? 'medium' : 'high';
        this.respond(frame, { results, suggested });
      });
      return;
    }
    if (req.action === 'flash-save' && req.flash) {
      this.calibration.flash = { ...req.flash, calibratedAt: this.nowIso() };
      this.log('P4', `flash calibration saved: ${req.flash.level.toUpperCase()}`);
      this.respond(frame, { ok: true });
      return;
    }
    if (req.action === 'apply' && req.offsets) {
      this.calibration.cams = req.offsets;
      this.calibration.capturedAt = this.nowIso();
      this.calibration.saved = true;
      this.log('P4', 'calibration written to NVS');
      this.respond(frame, { ok: true });
      return;
    }
    if (req.action === 'reset') {
      this.calibration = neutralCalibration();
      this.log('P4', 'calibration reset to neutral');
      this.respond(frame, { ok: true });
      return;
    }
    // start
    for (const id of CAM_IDS) {
      if (this.busUnreachable(id)) {
        this.respondError(frame, 'CAM_UNREACHABLE', `${id.toUpperCase()} is offline — all four cameras are required`);
        return;
      }
      if (this.cams[id].fault === 'sensor-missing') {
        this.respondError(frame, 'SENSOR_MISSING', `${id.toUpperCase()} sensor not detected — all four cameras are required`);
        return;
      }
    }
    if (this.scenarios.cam2Timeout) {
      this.respondError(frame, 'CAM_UNREACHABLE', 'CAM2 is not answering — all four cameras are required');
      return;
    }
    this.respond(frame, { started: true });
    let t = 400;
    for (const id of CAM_IDS) {
      this.after(t, () => {
        this.log(('C' + id.slice(-1)) as LogSource, 'calibration frame captured');
        this.sendEvent(Evt.CALIBRATION, { step: 'capture', cam: id });
      });
      t += this.randInt(500, 800);
    }
    this.after(t + 200, () => this.sendEvent(Evt.CALIBRATION, { step: 'analyze', message: 'comparing against CAM2' }));
    this.after(t + 1600, () => {
      const jitter = (scale: number) => Math.round(this.rand(-scale, scale) * 1000) / 1000;
      const offsets: Record<CamId, CamCalibration> = {
        cam1: { ev: jitter(0.25), r: 1 + jitter(0.04), g: 1 + jitter(0.02), b: 1 + jitter(0.05), x: this.randInt(-6, 6), y: this.randInt(-4, 4), rot: jitter(0.4) },
        cam2: { ...NEUTRAL_CAL },
        cam3: { ev: jitter(0.25), r: 1 + jitter(0.04), g: 1 + jitter(0.02), b: 1 + jitter(0.05), x: this.randInt(-6, 6), y: this.randInt(-4, 4), rot: jitter(0.4) },
        cam4: { ev: jitter(0.3), r: 1 + jitter(0.05), g: 1 + jitter(0.02), b: 1 + jitter(0.06), x: this.randInt(-8, 8), y: this.randInt(-5, 5), rot: jitter(0.5) },
      };
      this.log('P4', 'calibration analysis complete');
      this.sendEvent(Evt.CALIBRATION, { step: 'result', offsets });
    });
  }

  getCalibration() {
    return this.calibration;
  }

  // ---- self test ----

  private handleSelfTest(frame: Frame) {
    this.respond(frame, { started: true });
    const checks: { name: string; run: () => SelfTestCheck }[] = [
      { name: 'P4 heap', run: () => ({ name: 'P4 heap', status: 'pass', detail: `${this.randInt(148, 176)} KB free` }) },
      { name: 'PSRAM', run: () => ({ name: 'PSRAM', status: 'pass', detail: `${this.randInt(11, 14)} MB free` }) },
      { name: 'Touch panel', run: () => ({ name: 'Touch panel', status: 'pass', detail: 'controller responds' }) },
      {
        name: 'SD card',
        run: () => this.scenarios.sdMissing
          ? { name: 'SD card', status: 'fail', detail: 'no card detected' }
          : this.scenarios.sdFull
            ? { name: 'SD card', status: 'fail', detail: 'card full — 0 MB free' }
            : { name: 'SD card', status: 'pass', detail: `write test ok, ${(this.sdFreeMB / 1024).toFixed(1)} GB free` },
      },
      {
        name: 'Battery gauge',
        run: () => this.scenarios.lowBattery
          ? { name: 'Battery gauge', status: 'fail', detail: '3.42 V — charge before a long session' }
          : { name: 'Battery gauge', status: 'pass', detail: `${this.batteryV.toFixed(2)} V` },
      },
      { name: 'Flash LED', run: () => ({ name: 'Flash LED', status: 'pass', detail: 'driver ok (not fired)' }) },
      { name: 'Speaker', run: () => ({ name: 'Speaker', status: 'pass', detail: 'amp enabled' }) },
      ...CAM_IDS.map((id) => ({
        name: `${id.toUpperCase()} capture`,
        run: (): SelfTestCheck => {
          if (this.busUnreachable(id)) return { name: `${id.toUpperCase()} capture`, status: 'fail', detail: 'no response on camera bus' };
          if (id === 'cam2' && this.scenarios.cam2Timeout) return { name: 'CAM2 capture', status: 'fail', detail: 'frame timeout after 900 ms' };
          if (this.cams[id].fault === 'sensor-missing') return { name: `${id.toUpperCase()} capture`, status: 'fail', detail: 'sensor not detected' };
          return { name: `${id.toUpperCase()} capture`, status: 'pass', detail: `OV3660, jpeg ${this.randInt(300, 560)} KB` };
        },
      })),
    ];
    const results: SelfTestCheck[] = [];
    let t = 250;
    checks.forEach((check, i) => {
      this.after(t, () => this.sendEvent(Evt.SELF_TEST, { index: i, total: checks.length, name: check.name, status: 'running' }));
      this.after(t + 220, () => {
        const result = check.run();
        results.push(result);
        this.sendEvent(Evt.SELF_TEST, { index: i, total: checks.length, name: result.name, status: result.status, detail: result.detail });
      });
      t += this.randInt(280, 420);
    });
    this.after(t + 300, () => {
      const failed = results.filter((r) => r.status === 'fail').length;
      this.log('P4', failed === 0 ? 'self test passed' : `self test: ${failed} check(s) failed`);
      this.sendEvent(Evt.SELF_TEST, { index: checks.length, total: checks.length, name: 'done', status: failed ? 'fail' : 'pass', done: true, results });
    });
  }

  // ---- firmware ----

  // ---- sounds ----

  private handleSound(frame: Frame, cmd: Cmd) {
    if (this.scenarios.legacyFirmware) {
      this.respondError(frame, 'UNSUPPORTED_COMMAND', 'Custom sounds not implemented in this firmware');
      return;
    }
    switch (cmd) {
      case Cmd.GET_SOUNDS:
        this.respond(frame, {
          custom: [...this.customSounds.values()].map((s) => s.info),
          maxCustom: MAX_CUSTOM_SOUNDS,
          maxSoundKB: MAX_SOUND_KB,
        });
        return;
      case Cmd.SOUND_BEGIN: {
        const req = decodeJson<{ id: string; name: string; sizeBytes: number; durationMs: number }>(frame.payload);
        if (this.soundSession) {
          this.respondError(frame, 'BUSY', 'A sound upload is already in progress');
          return;
        }
        if ((BUILTIN_SHUTTER_SOUNDS as readonly string[]).includes(req.id)) {
          this.respondError(frame, 'BAD_ID', 'Builtin sound ids cannot be overwritten');
          return;
        }
        if (!req.sizeBytes || req.sizeBytes < 44 || req.sizeBytes > MAX_SOUND_KB * 1024) {
          this.respondError(frame, 'BAD_SIZE', `Sound must be 44 bytes to ${MAX_SOUND_KB} KB`);
          return;
        }
        if (!this.customSounds.has(req.id) && this.customSounds.size >= MAX_CUSTOM_SOUNDS) {
          this.respondError(frame, 'SOUND_SLOTS_FULL', `All ${MAX_CUSTOM_SOUNDS} sound slots are used. Delete one first.`);
          return;
        }
        this.soundSession = {
          id: ++this.soundSessionCounter,
          info: {
            id: req.id,
            name: String(req.name ?? req.id).slice(0, 32),
            sizeBytes: req.sizeBytes,
            durationMs: Math.max(0, Math.round(req.durationMs ?? 0)),
          },
          data: new Uint8Array(req.sizeBytes),
          received: 0,
        };
        this.respond(frame, { sessionId: this.soundSession.id, chunkSize: 8192 });
        return;
      }
      case Cmd.SOUND_CHUNK: {
        const s = this.soundSession;
        if (!s) {
          this.respondError(frame, 'NO_SESSION', 'No sound upload active');
          return;
        }
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset);
        const sessionId = view.getUint32(0, true);
        const offset = view.getUint32(4, true);
        const data = frame.payload.subarray(8);
        if (sessionId !== s.id) {
          this.respondError(frame, 'BAD_SESSION', 'Stale sound upload session');
          return;
        }
        if (offset + data.length > s.info.sizeBytes) {
          this.soundSession = null;
          this.respondError(frame, 'BAD_OFFSET', 'Chunk past the announced sound size');
          return;
        }
        s.data.set(data, offset);
        s.received = Math.max(s.received, offset + data.length);
        this.respond(frame, { ok: true, received: s.received });
        return;
      }
      case Cmd.SOUND_END: {
        const s = this.soundSession;
        if (!s) {
          this.respondError(frame, 'NO_SESSION', 'No sound upload active');
          return;
        }
        if (s.received < s.info.sizeBytes) {
          this.respondError(frame, 'SHORT_SOUND', `Received ${s.received} of ${s.info.sizeBytes} bytes`);
          return;
        }
        this.soundSession = null;
        this.customSounds.set(s.info.id, { info: s.info, data: s.data });
        this.log('P4', `sound stored: ${s.info.name} (${Math.round(s.info.sizeBytes / 1024)} KB)`);
        this.respond(frame, { ok: true, sound: s.info });
        return;
      }
      case Cmd.SOUND_READ: {
        const req = decodeJson<{ id: string; offset: number; length: number }>(frame.payload);
        const entry = this.customSounds.get(req.id);
        if (!entry) {
          this.respondError(frame, 'NOT_FOUND', `No sound ${req.id}`);
          return;
        }
        const offset = Math.max(0, req.offset | 0);
        const length = Math.min(Math.max(1, req.length | 0), 8192);
        this.respondBytes(frame, entry.data.subarray(offset, Math.min(offset + length, entry.data.length)));
        return;
      }
      case Cmd.SOUND_DELETE: {
        const { id } = decodeJson<{ id: string }>(frame.payload);
        if (!this.customSounds.delete(id)) {
          this.respondError(frame, 'NOT_FOUND', `No sound ${id}`);
          return;
        }
        // A deleted clip cannot stay selected — fall back like firmware would.
        if (this.config.shoot.shutterSound === id) {
          this.config.shoot.shutterSound = 'click';
          this.configRevision++;
          this.log('P4', `shutter sound reset to CLICK — ${id} deleted`);
        } else {
          this.log('P4', `sound deleted: ${id}`);
        }
        this.respond(frame, { ok: true });
        return;
      }
    }
  }

  private handleFwBegin(frame: Frame) {
    const req = decodeJson<{ target: TargetId; size: number; sha256: string; version: string }>(frame.payload);
    if (!this.maintenance) {
      this.respondError(frame, 'MAINT_REQUIRED', 'Enter maintenance mode before updating firmware');
      return;
    }
    if (this.fwSession) {
      this.respondError(frame, 'BUSY', `Update already in progress for ${this.fwSession.target}`);
      return;
    }
    if (req.size <= 0 || req.size > 4 * 1024 * 1024) {
      this.respondError(frame, 'BAD_SIZE', 'Image size out of range');
      return;
    }
    if (req.target !== 'p4' && this.busUnreachable(req.target)) {
      this.respondError(frame, 'CAM_UNREACHABLE', `${req.target.toUpperCase()} is offline`);
      return;
    }
    const failAt = req.target === 'cam3' && this.scenarios.failedUpdate ? Math.floor(req.size * 0.6) : null;
    this.fwSession = {
      id: ++this.fwSessionCounter,
      target: req.target,
      size: req.size,
      sha256: req.sha256,
      version: req.version,
      received: 0,
      failAt,
      image: new Uint8Array(req.size),
    };
    this.fwStates[req.target] = { state: 'receiving' };
    if (req.target !== 'p4') this.cams[req.target].updating = true;
    this.log('P4', `fw begin ${req.target} — ${req.version}, ${Math.round(req.size / 1024)} KB`);
    this.emitTelemetry({ t: 'fw', target: req.target, state: 'receiving', pct: 0 });
    this.respond(frame, { sessionId: this.fwSession.id, chunkSize: 8192 });
  }

  private handleFwChunk(frame: Frame) {
    const s = this.fwSession;
    if (!s) {
      this.respondError(frame, 'NO_SESSION', 'No firmware session active');
      return;
    }
    const view = new DataView(frame.payload.buffer, frame.payload.byteOffset);
    const sessionId = view.getUint32(0, true);
    const offset = view.getUint32(4, true);
    const dataLen = frame.payload.length - 8;
    if (sessionId !== s.id) {
      this.respondError(frame, 'BAD_SESSION', 'Stale firmware session');
      return;
    }
    if (s.failAt !== null && offset + dataLen >= s.failAt) {
      const pct = Math.round((offset / s.size) * 100);
      this.log('P4', `${s.target} flash write failed at 0x${offset.toString(16)}`);
      this.fwStates[s.target] = { state: 'error', error: 'flash write failed' };
      if (s.target !== 'p4') this.cams[s.target].updating = false;
      this.fwSession = null;
      this.scenarios.failedUpdate = false; // one-shot — a retry will succeed
      this.scenarioCb?.();
      this.emitTelemetry({ t: 'fw', target: s.target, state: 'error', pct });
      this.respondError(frame, 'FLASH_WRITE', `${s.target.toUpperCase()} flash write failed at ${pct}%`);
      return;
    }
    if (offset + dataLen > s.size) {
      this.respondError(frame, 'BAD_OFFSET', `Chunk ends at ${offset + dataLen}, image is ${s.size} bytes`);
      return;
    }
    s.image.set(frame.payload.subarray(8), offset);
    s.received = offset + dataLen;
    this.emitTelemetry({ t: 'fw', target: s.target, state: 'receiving', pct: Math.round((s.received / s.size) * 100) });
    this.respond(frame, { ok: true, received: s.received });
  }

  private handleFwEnd(frame: Frame) {
    const s = this.fwSession;
    if (!s) {
      this.respondError(frame, 'NO_SESSION', 'No firmware session active');
      return;
    }
    if (s.received < s.size) {
      this.respondError(frame, 'SHORT_IMAGE', `Received ${s.received} of ${s.size} bytes`);
      return;
    }
    this.fwSession = null;
    const target = s.target;
    this.fwStates[target] = { state: 'verifying' };
    this.emitTelemetry({ t: 'fw', target, state: 'verifying' });
    // Real verification: hash what actually arrived against the declared
    // digest. Answering `verified: true` without hashing would let a corrupt
    // image pass end-to-end in the reference device.
    const actualSha = sha256Hex(s.image);
    if (actualSha !== s.sha256.toLowerCase()) {
      this.log('P4', `${target} sha256 mismatch — image rejected, nothing flashed`);
      this.fwStates[target] = { state: 'error', error: 'sha256 mismatch' };
      if (target !== 'p4') this.cams[target].updating = false;
      this.emitTelemetry({ t: 'fw', target, state: 'error' });
      this.respondError(frame, 'SHA256_MISMATCH', `${target.toUpperCase()} image hash does not match FW_BEGIN declaration`);
      return;
    }
    this.respond(frame, { ok: true, verified: true });
    this.log('P4', `${target} image received — sha256 verified`);

    if (target === 'p4') {
      this.after(900, () => {
        this.fwStates.p4 = { state: 'applying' };
        this.emitTelemetry({ t: 'fw', target, state: 'applying' });
        this.log('P4', 'writing p4 ota partition');
      });
      this.after(2200, () => {
        this.p4Fw = s.version;
        // Issue #72: installing an artifact whose version maps to a known
        // firmware profile makes the device BECOME that firmware — flashing
        // the real 0.1.0 build produces an honest Milestone 1B device.
        const mapped = PROFILE_FOR_VERSION[s.version];
        if (mapped && mapped !== this.firmwareProfileId) this.setFirmwareProfile(mapped);
        this.fwStates.p4 = { state: 'rebooting' };
        this.emitTelemetry({ t: 'fw', target, state: 'rebooting' });
        this.log('P4', 'update applied — rebooting');
      });
      this.after(2800, () => this.reboot('ota-update'));
    } else {
      this.after(900, () => {
        this.fwStates[target] = { state: 'applying' };
        this.emitTelemetry({ t: 'fw', target, state: 'applying' });
        this.log('P4', `${target} flashing app partition`);
      });
      this.after(2400, () => {
        this.fwStates[target] = { state: 'rebooting' };
        this.cams[target].updating = false;
        this.cams[target].rebootUntil = this.now() + 1800;
        this.emitTelemetry({ t: 'fw', target, state: 'rebooting' });
        this.log(('C' + target.slice(-1)) as LogSource, 'rebooting into new firmware');
      });
      this.after(4300, () => {
        this.cams[target].fw = s.version;
        this.fwStates[target] = { state: 'ready' };
        this.emitTelemetry({ t: 'fw', target, state: 'ready' });
        this.log(('C' + target.slice(-1)) as LogSource, `OV3660 ready — fw ${s.version}`);
      });
    }
  }

  private reboot(reason: string) {
    this.stopAmbient();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.clearCaptureTimers(); // a capture mid-commit dies with the boot
    // 04 §17: every boot gets a new session ID, so a host that reconnects can
    // tell a rebooted device from the one it was already talking to. Anything
    // scoped to the old boot — running jobs, upload progress — died with it.
    this.bootCount++;
    this.sessionId = `boot-${this.bootCount}`;
    this.emitTelemetry({ t: 'reboot', sessionId: this.sessionId, reason });
    this.jobs.clear();
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.coalesceBuffer = [];
    this.stopUploadDrain();
    this.resetReason = reason;
    this.bootedAt = this.now() + 2500;
    this.bootBlockedUntil = this.now() + 2500;
    this.maintenance = false;
    this.fwStates.p4 = { state: 'idle' };
    for (const id of CAM_IDS) this.fwStates[id] = { state: 'idle' };
    const closeCb = this.forceCloseCb;
    this.sink = null;
    this.forceCloseCb = null;
    closeCb?.();
  }
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (patch as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && key in out && typeof out[key] === 'object') {
      out[key] = deepMerge(out[key], value as Partial<unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}
