// The demo KINO. Implements the device side of the framed protocol so the
// full stack above the transport (decoder, client, device facade, UI) runs
// unchanged against it. State survives simulated reboots, like real NVS.

import { Cmd, Evt, FrameFlags, PROTOCOL_VERSION } from '../protocol/commands';
import { FrameDecoder, encodeFrame, encodeJson, decodeJson } from '../protocol/packet';
import type { Frame } from '../protocol/packet';
import type {
  CamId,
  CameraInfo,
  CamCalibration,
  KinoConfig,
  LogEntry,
  LogSource,
  SelfTestCheck,
  TargetId,
} from '../protocol/types';
import { CAM_IDS, NEUTRAL_CAL } from '../protocol/types';
import type { Recipe } from '../recipes/recipeTypes';
import { validateRecipe } from '../recipes/recipeTypes';
import { FACTORY_RECIPES } from '../recipes/factoryRecipes';
import { BUILTIN_SHUTTER_SOUNDS } from '../protocol/types';
import type { SoundInfo } from '../protocol/types';
import { encodeWav, SOUND_SAMPLE_RATE } from '../utils/soundFx';
import type { ScenarioFlags } from './scenarios';
import { DEFAULT_SCENARIOS } from './scenarios';
import { MockMediaStore, renderPreviewFrame } from './MockMediaStore';

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randInt = (lo: number, hi: number) => Math.round(rand(lo, hi));
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

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

export class MockKinoDevice {
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
  private customRecipes = new Map<string, Recipe>();
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
    this.startAmbient();
  }

  detach() {
    this.sink = null;
    this.forceCloseCb = null;
    this.stopAmbient();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
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
    if (key === 'cam1Offline' && value) this.log('P4', 'C1 link lost — no response on camera bus');
    if (key === 'cam1Offline' && !value) this.log('P4', 'C1 link re-established');
    if (key === 'sdMissing') this.log('SD', value ? 'card removed' : 'card inserted, mounted');
    if (key === 'lowBattery' && value) { this.batteryV = 3.42; this.log('PWR', 'battery low 3.42 V'); }
    if (key === 'lowBattery' && !value) this.batteryV = 3.96;
    this.scenarioCb?.();
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
    if ((src === 'C1' && this.scenarios.cam1Offline) || (src === 'C2' && this.scenarios.cam2Timeout)) return;
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
      if (id === 'cam1' && this.scenarios.cam1Offline) {
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
      const skipped = (this.scenarios.cam1Offline ? 1 : 0) + (this.scenarios.cam2Timeout ? 1 : 0);
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
    if (this.scenarios.crcErrorNext && frame.flags & FrameFlags.RESPONSE) {
      bytes = bytes.slice();
      bytes[bytes.length - 3] ^= 0xff; // corrupt CRC in transit
      this.scenarios.crcErrorNext = false;
      this.scenarioCb?.();
    }
    this.sink(bytes);
  }

  private handleFrame(frame: Frame) {
    if (frame.version !== PROTOCOL_VERSION) {
      this.respondError(frame, 'BAD_VERSION', `Protocol ${frame.version} not supported`);
      return;
    }
    const latency = frame.type === Cmd.FW_CHUNK ? randInt(4, 10) : randInt(8, 26);
    this.after(latency, () => this.dispatch(frame));
  }

  private cameraInfo(id: CamId): CameraInfo {
    const cam = this.cams[id];
    const offline = id === 'cam1' && this.scenarios.cam1Offline;
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

  private dispatch(frame: Frame) {
    const cmd = frame.type as Cmd;
    switch (cmd) {
      case Cmd.HELLO: {
        const req = decodeJson<{ nonce?: number }>(frame.payload);
        this.respond(frame, { product: 'KINO', protocol: PROTOCOL_VERSION, nonce: req.nonce });
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
        const check = validateRecipe(recipe);
        if (!check.ok) {
          this.respondError(frame, 'BAD_RECIPE', check.error);
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
        if ((cam === 'cam1' && this.scenarios.cam1Offline) || (cam === 'cam2' && this.scenarios.cam2Timeout)) {
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
        if (camId === 'cam1' && this.scenarios.cam1Offline) {
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
          if (this.scenarios.cam1Offline || this.scenarios.cam2Timeout) {
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
      if (this.scenarios.cam1Offline || this.scenarios.cam2Timeout) {
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
    if (this.scenarios.cam1Offline) {
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
          if (id === 'cam1' && this.scenarios.cam1Offline) return { name: 'CAM1 capture', status: 'fail', detail: 'no response on camera bus' };
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
    if (req.target === 'cam1' && this.scenarios.cam1Offline) {
      this.respondError(frame, 'CAM_UNREACHABLE', 'CAM1 is offline');
      return;
    }
    const failAt = req.target === 'cam3' && this.scenarios.fwFailCam3 ? Math.floor(req.size * 0.6) : null;
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
      this.scenarios.fwFailCam3 = false; // one-shot — a retry will succeed
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
