// The demo KINO. Implements the device side of the framed protocol so the
// full stack above the transport (decoder, client, device facade, UI) runs
// unchanged against it. State survives simulated reboots, like real NVS.

import { Cmd, Evt, FrameFlags, PROTOCOL_VERSION } from '@kino/kdp';
import { FrameDecoder, encodeFrame, encodeJson, decodeJson } from '@kino/kdp';
import type { Frame } from '@kino/kdp';
import type {
  CamId,
  CameraInfo,
  CamCalibration,
  KinoConfig,
  LogEntry,
  LogSource,
  SelfTestCheck,
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
import type { ScenarioFlags } from './scenarios';
import { DEFAULT_SCENARIOS } from './scenarios';
import { MockMediaStore, renderPreviewFrame } from './MockMediaStore';
import { SYNC_BENCH } from './commands';

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randInt = (lo: number, hi: number) => Math.round(rand(lo, hi));
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

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

  private sink: ((data: Uint8Array) => void) | null = null;
  private forceCloseCb: (() => void) | null = null;
  private scenarioCb: (() => void) | null = null;
  private readonly decoder = new FrameDecoder();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private logTimer: ReturnType<typeof setTimeout> | null = null;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;

  private bootedAt = Date.now();
  private bootBlockedUntil = 0;
  private resetReason = 'power-on';
  private maintenance = false;
  private batteryV = 4.02;
  private sdFreeMB = 27431;
  private p4Fw = '0.1.0';
  private cams: Record<CamId, CamModel> = this.freshCams('0.1.0');
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

  // ---- identity (04 §4 / §17) ----
  // deviceId is the unit. sessionId is this boot of it: a host that sees a
  // different one on reconnect knows every cached handle it holds is stale.
  private readonly deviceId = 'kino-000012';
  private bootCount = 1;
  private sessionId = 'boot-1';

  // ---- network / roll (04 §7) ----
  private networks: SavedNetwork[] = [
    { ssid: 'kino-bench', password: 'benchwifi2026', security: 'wpa2', autoJoin: true, lastSeen: Date.now() - 40_000 },
    { ssid: 'loft-guest', password: 'partytime', security: 'wpa2', autoJoin: false, lastSeen: null },
  ];
  private roll: RollState | null = null;
  private rollCounter = 0;
  private uploads: UploadQueue = { pending: 0, uploading: 0, failed: 0, uploaded: 118 };
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- async jobs (04 §15) ----
  private jobs = new Map<string, JobState>();
  private jobCounter = 0;

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

  private freshCams(fw: string): Record<CamId, CamModel> {
    const cam = (): CamModel => ({
      fw,
      lastCaptureAt: Date.now() - randInt(40_000, 300_000),
      jpegKB: randInt(320, 520),
      durationMs: randInt(140, 260),
      gpioSkewUs: randInt(80, 400),
      uartErrors: randInt(0, 2),
      updating: false,
      rebootUntil: 0,
    });
    return { cam1: cam(), cam2: cam(), cam3: cam(), cam4: cam() };
  }

  // ---- transport binding ----

  bootDelayMs(): number {
    return Math.max(0, this.bootBlockedUntil - Date.now());
  }

  attach(sink: (data: Uint8Array) => void, onForceClose: () => void) {
    this.sink = sink;
    this.forceCloseCb = onForceClose;
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
    if (key === 'offlineCameraNode' && value) this.log('P4', 'C1 link lost — no response on camera bus');
    if (key === 'offlineCameraNode' && !value) this.log('P4', 'C1 link re-established');
    if (key === 'sdMissing') this.log('SD', value ? 'card removed' : 'card inserted, mounted');
    if (key === 'lowBattery' && value) { this.batteryV = 3.42; this.log('PWR', 'battery low 3.42 V'); }
    if (key === 'lowBattery' && !value) this.batteryV = 3.96;
    if (key === 'largeGallery2k') this.media.resize(value ? LARGE_GALLERY_SIZE : DEMO_GALLERY_SIZE);
    if (key === 'uploadBacklog') this.setUploadBacklog(Boolean(value));
    if (key === 'bootSpew' && value) this.emitBootSpew();
    this.scenarioCb?.();

    // These two are actions, not states: arming them makes the device do
    // something once and disarm itself, so the panel never shows a stuck ON.
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
  }

  /** Boot/session ID of the current run (04 §17). Changes on every reboot. */
  currentSessionId(): string {
    return this.sessionId;
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
      this.logTimer = setTimeout(tickLog, randInt(900, 2600));
    };
    this.logTimer = setTimeout(tickLog, 600);

    const tickCapture = () => {
      this.simulateCapture();
      this.captureTimer = setTimeout(tickCapture, randInt(9000, 22000));
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
    this.batteryV = Math.max(3.3, this.batteryV - rand(0.0001, 0.0005));
    const camSrc = pick(['C1', 'C2', 'C3', 'C4'] as LogSource[]);
    const options: [LogSource, string][] = [
      ['P4', pick(['touch: mode dial', 'ui idle', 'preview stream 12 fps', 'wiggle armed', 'heap ok'])],
      [camSrc, pick(['AE converged in 3 frames', `exposure locked 1/60 gain ${randInt(4, 16)}`, 'awb warm bias applied', `frame sync ok, skew ${randInt(60, 420)} us`])],
      ['PWR', `battery ${this.batteryV.toFixed(2)} V`],
      ['SD', pick([`free ${(this.sdFreeMB / 1024).toFixed(1)} GB`, `write burst ${rand(3.2, 4.4).toFixed(1)} MB/s`])],
      ['PROTO', pick(['usb host poll ok', 'trigger bus idle'])],
    ];
    const weights = [4, 5, 1, 1, 1];
    let total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { idx = i; break; }
    }
    const [src, msg] = options[idx];
    if ((src === 'C1' && this.scenarios.offlineCameraNode) || (src === 'C2' && this.scenarios.cam2Timeout)) return;
    if (src === 'SD' && this.scenarios.sdMissing) return;
    this.log(src, msg);
  }

  private simulateCapture() {
    const n = String(this.captureCounter++).padStart(4, '0');
    const mode = this.config.mode;
    this.log('P4', `${mode} capture ${n} triggered${this.config.wiggle.flash ? ' — flash' : ''}`);
    let delay = 60;
    for (const id of CAM_IDS) {
      const cam = this.cams[id];
      const src = ('C' + id.slice(-1)) as LogSource;
      if (id === 'cam1' && this.scenarios.offlineCameraNode) {
        this.after(delay, () => { this.log('P4', 'C1 no frame — group incomplete'); this.camTimeouts++; });
        continue;
      }
      if (id === 'cam2' && this.scenarios.cam2Timeout) {
        this.after(delay + 900, () => { this.log('P4', 'C2 frame timeout after 900 ms'); this.camTimeouts++; cam.uartErrors++; });
        continue;
      }
      cam.jpegKB = randInt(300, 560);
      cam.durationMs = randInt(130, 280);
      cam.gpioSkewUs = randInt(60, 450);
      cam.lastCaptureAt = Date.now();
      this.after(delay, () => this.log(src, `jpeg ${cam.jpegKB} KB in ${cam.durationMs} ms`));
      delay += randInt(15, 45);
    }
    if (!this.scenarios.sdMissing) {
      // Sequential CAM1→4 UART transfer happens before the SD commit; at
      // 921600 baud a four-frame set takes a few seconds.
      const skipped = (this.scenarios.offlineCameraNode ? 1 : 0) + (this.scenarios.cam2Timeout ? 1 : 0);
      // Concurrent transfer on four UARTs: wall clock is the slowest
      // channel, not the sum of four sequential transfers.
      const transferMs = Math.round((380 * 1024) / ((this.uartBaud / 10) * 0.9) * 1000);
      this.after(delay + transferMs, () => {
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
        const capId = this.media.addLiveCapture(number, kind, recipeIds, this.config.wiggle.flash);
        this.log('SD', `${capId} committed`);
        this.sendEvent(Evt.CAPTURE, { id: capId, kind });
      });
    } else {
      this.after(delay + 120, () => { this.sdErrors++; this.log('SD', `capture ${n} lost — no card`); });
    }
  }

  private after(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }

  private log(src: LogSource, msg: string) {
    const entry: LogEntry = { t: Date.now(), src, msg };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 400) this.logBuffer.splice(0, this.logBuffer.length - 400);
    this.sendEvent(Evt.LOG, entry);
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
    if (!this.scenarios.splitFrames || bytes.length < 4) {
      sink(bytes);
      return;
    }
    // Two or three writes per frame, always cutting inside the payload so a
    // header lands split across reads at least some of the time.
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = bytes.length - offset;
      const n = remaining <= 3 ? remaining : randInt(1, Math.max(1, remaining - 1));
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
    closeCb?.();
  }

  private handleFrame(frame: Frame) {
    if (frame.version !== PROTOCOL_VERSION) {
      this.respondError(frame, 'BAD_VERSION', `Protocol ${frame.version} not supported`);
      return;
    }
    const latency = this.scenarios.delayedResponses
      ? randInt(SLOW_RESPONSE_MS[0], SLOW_RESPONSE_MS[1])
      : frame.type === Cmd.FW_CHUNK
        ? randInt(4, 10)
        : randInt(8, 26);
    this.after(latency, () => this.dispatch(frame));
  }

  private cameraInfo(id: CamId): CameraInfo {
    const cam = this.cams[id];
    const offline = id === 'cam1' && this.scenarios.offlineCameraNode;
    const timeout = id === 'cam2' && this.scenarios.cam2Timeout;
    const rebooting = cam.rebootUntil > Date.now();
    return {
      id,
      online: !offline && !rebooting,
      sensor: 'OV3660',
      sensorDetected: !offline && !rebooting,
      firmware: cam.fw,
      state: offline ? 'offline' : rebooting ? 'rebooting' : cam.updating ? 'updating' : timeout ? 'timeout' : 'ready',
      latencyMs: offline ? 0 : timeout ? 900 : Math.round(rand(2, 9) * 10) / 10,
      uartErrors: cam.uartErrors,
      lastCapture: offline
        ? null
        : {
            ageS: Math.round((Date.now() - cam.lastCaptureAt) / 1000),
            jpegKB: cam.jpegKB,
            durationMs: cam.durationMs,
            gpioSkewUs: cam.gpioSkewUs,
          },
    };
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
    SYNC_BENCH,
  ];

  /** Single source of truth for both the capability report and the dispatcher. */
  private supportsNetworkRoll(): boolean {
    return !this.scenarios.legacyFirmware && !this.scenarios.unsupportedCommands;
  }

  private dispatch(frame: Frame) {
    const cmd = frame.type as Cmd;

    const gated =
      (this.scenarios.unsupportedCommands &&
        MockKinoDevice.OPTIONAL_COMMANDS.includes(frame.type)) ||
      (!this.supportsNetworkRoll() &&
        MockKinoDevice.NETWORK_ROLL_COMMANDS.includes(frame.type));
    if (gated) {
      this.respondError(
        frame,
        'UNSUPPORTED_COMMAND',
        `Command ${Cmd[cmd] ?? '0x' + frame.type.toString(16)} not implemented in firmware ${this.p4Fw}`,
      );
      return;
    }

    if (frame.type === SYNC_BENCH) {
      this.handleSyncBench(frame);
      return;
    }

    switch (cmd) {
      case Cmd.HELLO: {
        const req = decodeJson<{ nonce?: number }>(frame.payload);
        // 04 §4: selected protocol, nonce echo, device ID, boot/session ID.
        this.respond(frame, {
          product: 'KINO',
          protocol: PROTOCOL_VERSION,
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
      case Cmd.GET_CAPABILITIES: {
        const legacy = this.scenarios.legacyFirmware;
        this.respond(frame, {
          protocol: PROTOCOL_VERSION,
          hardware: 'kino-v1',
          firmware: this.p4Fw,
          capabilities: {
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
            // 04 §7 Network/Roll. Same predicate the dispatcher gates on, so
            // what the device claims and what it answers cannot drift apart.
            rollUpload: this.supportsNetworkRoll(),
            network: this.supportsNetworkRoll(),
            syncBench: this.supportsNetworkRoll(),
          },
          limits: {
            maxUartBaud: 3_000_000,
            currentUartBaud: this.uartBaud,
            maxResolution: '2048x1536',
            maxGalleryPageSize: 100,
          },
          configSchemaVersion: 1,
        });
        return;
      }
      case Cmd.GET_DEVICE_INFO:
        this.respond(frame, {
          product: 'KINO',
          hardware: 'V1',
          serial: 'KINO000012',
          protocol: PROTOCOL_VERSION,
          p4Firmware: this.p4Fw,
          cameraFirmware: CAM_IDS.map((id) => this.cams[id].fw),
          sensors: ['OV3660', 'OV3660', 'OV3660', 'OV3660'],
          sdPresent: !this.scenarios.sdMissing,
          sdFreeMB: this.sdFreeMB,
          activeMode: this.config.mode,
          activeRecipe: this.config.wiggle.recipeId,
        });
        return;
      case Cmd.GET_CAMERA_INFO:
        this.respond(frame, { cameras: CAM_IDS.map((id) => this.cameraInfo(id)) });
        return;
      case Cmd.GET_POWER_STATUS: {
        const v = this.scenarios.lowBattery ? 3.42 : this.batteryV;
        const pct = Math.max(0, Math.min(100, Math.round(((v - 3.3) / (4.2 - 3.3)) * 100)));
        this.respond(frame, { batteryV: Math.round(v * 100) / 100, batteryPct: pct, state: 'battery', charging: false });
        return;
      }
      case Cmd.GET_STORAGE_STATUS:
        this.respond(frame, {
          present: !this.scenarios.sdMissing,
          totalMB: 30432,
          freeMB: this.scenarios.sdMissing ? 0 : this.sdFreeMB,
        });
        return;
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
        this.config = deepMerge(this.config, env.config ?? {});
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
        if ((cam === 'cam1' && this.scenarios.offlineCameraNode) || (cam === 'cam2' && this.scenarios.cam2Timeout)) {
          this.after(400, () => this.respondError(frame, 'CAM_UNREACHABLE', `${cam.toUpperCase()} did not answer test capture`));
          return;
        }
        this.after(350, () => {
          const kb = randInt(300, 560);
          this.log(('C' + cam.slice(-1)) as LogSource, `test capture ok — jpeg ${kb} KB`);
          this.respond(frame, { ok: true, jpegKB: kb, durationMs: randInt(140, 260) });
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
      case Cmd.GET_RUNTIME_STATS:
        this.respond(frame, {
          uptimeS: Math.round((Date.now() - this.bootedAt) / 1000),
          resetReason: this.resetReason,
          freeHeapKB: randInt(148, 176),
          freePsramKB: randInt(11800, 14200),
          tempC: { p4: Math.round(rand(38, 46)), cams: CAM_IDS.map(() => Math.round(rand(34, 44))) },
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
        for (const id of CAM_IDS) targets[id] = { version: this.cams[id].fw, state: this.fwStates[id].state };
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
          this.fwStates[this.fwSession.target] = { state: 'idle' };
          if (this.fwSession.target !== 'p4') this.cams[this.fwSession.target].updating = false;
          this.fwSession = null;
        }
        this.respond(frame, { ok: true });
        return;
      case Cmd.FW_STATUS: {
        const { target } = decodeJson<{ target: TargetId }>(frame.payload);
        const st = this.fwStates[target];
        this.respond(frame, {
          target,
          state: st.state,
          version: target === 'p4' ? this.p4Fw : this.cams[target].fw,
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
        if (camId === 'cam1' && this.scenarios.offlineCameraNode) {
          this.respondError(frame, 'CAM_UNREACHABLE', 'CAM1 is offline');
          return;
        }
        void renderPreviewFrame(Number(camId.slice(-1)) - 1, Date.now() - this.bootedAt)
          .then((bytes) => this.respondBytes(frame, bytes))
          .catch((err) => this.respondError(frame, 'PREVIEW_FAILED', err instanceof Error ? err.message : String(err)));
        return;
      }
      case Cmd.CAMERA_CAPTURE: {
        const req = decodeJson<{ action?: string }>(frame.payload);
        if (req.action === 'timing-test') {
          if (this.scenarios.offlineCameraNode || this.scenarios.cam2Timeout) {
            this.respondError(frame, 'CAM_UNREACHABLE', 'All four cameras are required for a timing test');
            return;
          }
          this.after(650, () => {
            this.batteryV = Math.max(3.3, this.batteryV - rand(0.002, 0.006)); // flash pulse
            this.respond(frame, this.measureTiming());
          });
          return;
        }
        this.respond(frame, { ok: true });
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
        if (security !== 'open' && password.length < 8) {
          this.respondError(frame, 'INVALID_ARGUMENT', 'WPA passphrase must be at least 8 characters');
          return;
        }
        const existing = this.networks.find((n) => n.ssid === ssid);
        if (existing) {
          // An update that omits the password keeps the stored one — the host
          // never had it to send back.
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
        const active = this.networks.find((n) => n.autoJoin) ?? null;
        this.respond(
          frame,
          active
            ? {
                state: 'connected',
                ssid: active.ssid,
                ip: '192.168.1.74',
                rssi: randInt(-68, -42),
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
    if (!this.roll) return { active: false, roll: null, queue: this.uploadQueueReport() };
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
          joinedAt: Date.now(),
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
        const req = decodeJson<{ slug?: string; code?: string }>(frame.payload);
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
          rollId: `roll_${slug}`,
          slug,
          guestUrl: `https://kino.roll/${slug}`,
          name: slug,
          role: 'guest',
          joinedAt: Date.now(),
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
    if (this.scenarios.offlineCameraNode || this.scenarios.cam2Timeout) {
      this.respondError(frame, 'CAMERA_OFFLINE', 'All four cameras are required for a sync bench');
      return;
    }
    const jobId = `job_${++this.jobCounter}`;
    this.jobs.set(jobId, { id: jobId, cmd: SYNC_BENCH, step: 0, steps: triggers });
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
          return;
        }
        case Cmd.MEDIA_INFO: {
          const { id } = decodeJson<{ id: string }>(frame.payload);
          const info = await this.media.info(id);
          if (!info) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else this.respond(frame, info);
          return;
        }
        case Cmd.MEDIA_THUMB: {
          const { id } = decodeJson<{ id: string }>(frame.payload);
          const bytes = await this.media.thumb(id);
          if (!bytes) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else this.respondBytes(frame, bytes);
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
          return;
        }
        case Cmd.MEDIA_DELETE: {
          const { id } = decodeJson<{ id: string }>(frame.payload);
          if (!this.media.delete(id)) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else {
            this.log('SD', `${id} deleted`);
            this.respond(frame, { ok: true });
          }
          return;
        }
        case Cmd.MEDIA_FAVORITE: {
          const { id, favorite } = decodeJson<{ id: string; favorite: boolean }>(frame.payload);
          if (!this.media.setFavorite(id, favorite)) this.respondError(frame, 'NOT_FOUND', `No capture ${id}`);
          else this.respond(frame, { ok: true });
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
    const gpio = CAM_IDS.map((_id, i) => Math.round(rand(30, 90) + i * rand(3, 12)));
    const gpioMin = Math.min(...gpio);

    // VSYNC phase: how long each sensor waits for its next frame start.
    // This is what decides which frame the sensor actually hands over.
    const jitter = this.phaseAligned ? 90 : 400;
    const phases = CAM_IDS.map((id) =>
      Math.max(0, this.camPhaseUs[id] + rand(-jitter, jitter)),
    );
    const phaseRef = phases[1]; // CAM2 reference

    const cams = CAM_IDS.map((camId, i) => {
      const vsyncPhaseUs = Math.round(phases[i]);
      // Effective exposure = trigger arrival + wait for frame start +
      // rolling-shutter row offset for the subject band.
      const rolling = rand(0, 900);
      return {
        cam: camId,
        gpioUs: Math.round(gpio[i] - gpioMin),
        vsyncPhaseUs,
        exposureUs: Math.round(phases[i] - phaseRef + rolling),
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
    const cams = CAM_IDS.map((cam) => ({ cam, phaseUs: Math.round(this.camPhaseUs[cam]) }));
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
      t += randInt(300, 500);
    }
    this.after(t + 300, () => {
      for (const cam of CAM_IDS) {
        if (cam === 'cam2') continue;
        // Each pass removes most of the remaining error but never all of it.
        this.camPhaseUs[cam] = this.camPhaseUs[cam] * rand(0.06, 0.16) + rand(-120, 120);
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
        const crcErrors = Math.round(bytes * errorRate * penalty * rand(0.6, 1.4));
        const framingErrors = crcErrors > 0 ? Math.round(crcErrors * rand(0.1, 0.5)) : 0;
        // Payload throughput after 8N1 framing and protocol overhead.
        const kbytesPerSec = Math.round(((baud / 10) * rand(0.86, 0.93)) / 1024);
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
      this.calibration.orderVerifiedAt = new Date().toISOString();
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
      if (this.scenarios.offlineCameraNode || this.scenarios.cam2Timeout) {
        this.respondError(frame, 'CAM_UNREACHABLE', 'All four cameras are required for a flash test');
        return;
      }
      this.log('P4', 'flash test capture — full pulse');
      this.after(900, () => {
        const level = req.flash?.level ?? this.calibration.flash.level;
        const base = level === 'low' ? 1.4 : level === 'medium' ? 3.1 : 6.2;
        const clip = () => Math.round((base + rand(-0.8, 1.2)) * 10) / 10;
        const results = CAM_IDS.map((cam) => ({ cam, clippedPct: Math.max(0.2, clip()) }));
        const avg = results.reduce((a, r) => a + r.clippedPct, 0) / 4;
        const suggested = avg > 5 ? 'low' : avg > 2.5 ? 'medium' : 'high';
        this.respond(frame, { results, suggested });
      });
      return;
    }
    if (req.action === 'flash-save' && req.flash) {
      this.calibration.flash = { ...req.flash, calibratedAt: new Date().toISOString() };
      this.log('P4', `flash calibration saved: ${req.flash.level.toUpperCase()}`);
      this.respond(frame, { ok: true });
      return;
    }
    if (req.action === 'apply' && req.offsets) {
      this.calibration.cams = req.offsets;
      this.calibration.capturedAt = new Date().toISOString();
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
    if (this.scenarios.offlineCameraNode) {
      this.respondError(frame, 'CAM_UNREACHABLE', 'CAM1 is offline — all four cameras are required');
      return;
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
      t += randInt(500, 800);
    }
    this.after(t + 200, () => this.sendEvent(Evt.CALIBRATION, { step: 'analyze', message: 'comparing against CAM2' }));
    this.after(t + 1600, () => {
      const jitter = (scale: number) => Math.round(rand(-scale, scale) * 1000) / 1000;
      const offsets: Record<CamId, CamCalibration> = {
        cam1: { ev: jitter(0.25), r: 1 + jitter(0.04), g: 1 + jitter(0.02), b: 1 + jitter(0.05), x: randInt(-6, 6), y: randInt(-4, 4), rot: jitter(0.4) },
        cam2: { ...NEUTRAL_CAL },
        cam3: { ev: jitter(0.25), r: 1 + jitter(0.04), g: 1 + jitter(0.02), b: 1 + jitter(0.05), x: randInt(-6, 6), y: randInt(-4, 4), rot: jitter(0.4) },
        cam4: { ev: jitter(0.3), r: 1 + jitter(0.05), g: 1 + jitter(0.02), b: 1 + jitter(0.06), x: randInt(-8, 8), y: randInt(-5, 5), rot: jitter(0.5) },
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
      { name: 'P4 heap', run: () => ({ name: 'P4 heap', status: 'pass', detail: `${randInt(148, 176)} KB free` }) },
      { name: 'PSRAM', run: () => ({ name: 'PSRAM', status: 'pass', detail: `${randInt(11, 14)} MB free` }) },
      { name: 'Touch panel', run: () => ({ name: 'Touch panel', status: 'pass', detail: 'controller responds' }) },
      {
        name: 'SD card',
        run: () => this.scenarios.sdMissing
          ? { name: 'SD card', status: 'fail', detail: 'no card detected' }
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
          if (id === 'cam1' && this.scenarios.offlineCameraNode) return { name: 'CAM1 capture', status: 'fail', detail: 'no response on camera bus' };
          if (id === 'cam2' && this.scenarios.cam2Timeout) return { name: 'CAM2 capture', status: 'fail', detail: 'frame timeout after 900 ms' };
          return { name: `${id.toUpperCase()} capture`, status: 'pass', detail: `OV3660, jpeg ${randInt(300, 560)} KB` };
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
      t += randInt(280, 420);
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
    if (req.target === 'cam1' && this.scenarios.offlineCameraNode) {
      this.respondError(frame, 'CAM_UNREACHABLE', 'CAM1 is offline');
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
    };
    this.fwStates[req.target] = { state: 'receiving' };
    if (req.target !== 'p4') this.cams[req.target].updating = true;
    this.log('P4', `fw begin ${req.target} — ${req.version}, ${Math.round(req.size / 1024)} KB`);
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
      this.log('P4', `${s.target} flash write failed at 0x${offset.toString(16)}`);
      this.fwStates[s.target] = { state: 'error', error: 'flash write failed' };
      if (s.target !== 'p4') this.cams[s.target].updating = false;
      this.fwSession = null;
      this.scenarios.failedUpdate = false; // one-shot — a retry will succeed
      this.scenarioCb?.();
      this.respondError(frame, 'FLASH_WRITE', `${s.target.toUpperCase()} flash write failed at ${Math.round((offset / s.size) * 100)}%`);
      return;
    }
    s.received = offset + dataLen;
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
    this.respond(frame, { ok: true, verified: true });
    this.log('P4', `${target} image received — verifying sha256`);

    if (target === 'p4') {
      this.after(900, () => { this.fwStates.p4 = { state: 'applying' }; this.log('P4', 'writing p4 ota partition'); });
      this.after(2200, () => {
        this.p4Fw = s.version;
        this.fwStates.p4 = { state: 'rebooting' };
        this.log('P4', 'update applied — rebooting');
      });
      this.after(2800, () => this.reboot('ota-update'));
    } else {
      this.after(900, () => { this.fwStates[target] = { state: 'applying' }; this.log('P4', `${target} flashing app partition`); });
      this.after(2400, () => {
        this.fwStates[target] = { state: 'rebooting' };
        this.cams[target].updating = false;
        this.cams[target].rebootUntil = Date.now() + 1800;
        this.log(('C' + target.slice(-1)) as LogSource, 'rebooting into new firmware');
      });
      this.after(4300, () => {
        this.cams[target].fw = s.version;
        this.fwStates[target] = { state: 'ready' };
        this.log(('C' + target.slice(-1)) as LogSource, `OV3660 ready — fw ${s.version}`);
      });
    }
  }

  private reboot(reason: string) {
    this.stopAmbient();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    // 04 §17: every boot gets a new session ID, so a host that reconnects can
    // tell a rebooted device from the one it was already talking to. Anything
    // scoped to the old boot — running jobs, upload progress — died with it.
    this.bootCount++;
    this.sessionId = `boot-${this.bootCount}`;
    this.jobs.clear();
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.coalesceBuffer = [];
    this.stopUploadDrain();
    this.resetReason = reason;
    this.bootedAt = Date.now() + 2500;
    this.bootBlockedUntil = Date.now() + 2500;
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
