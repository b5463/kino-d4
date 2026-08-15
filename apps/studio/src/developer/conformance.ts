// Protocol conformance suite: fires each command at the connected device
// and classifies the response. Green across the board is the acceptance
// bar for real P4 firmware — Studio is the test harness.

import type { KinoDevice } from '../device/KinoDevice';
import { KinoCommandError, KinoTimeoutError } from '@kino/kdp';

export type ConformanceStatus = 'pass' | 'shape' | 'unsupported' | 'timeout' | 'error' | 'skipped';

export interface ConformanceResult {
  name: string;
  active: boolean;
  status: ConformanceStatus;
  detail: string;
  ms: number;
}

class ShapeError extends Error {}

function expectKeys(obj: unknown, keys: string[], label: string) {
  if (typeof obj !== 'object' || obj === null) throw new ShapeError(`${label}: response is not an object`);
  const record = obj as Record<string, unknown>;
  const missing = keys.filter((k) => !(k in record));
  if (missing.length > 0) throw new ShapeError(`${label}: missing ${missing.join(', ')}`);
}

interface Ctx {
  captureId?: string;
  fileName?: string;
}

interface Case {
  name: string;
  /** Active cases change device state (writes, captures, mode switches). */
  active: boolean;
  run: (dev: KinoDevice, ctx: Ctx) => Promise<string>;
}

const CASES: Case[] = [
  {
    name: 'HELLO',
    active: false,
    run: async (dev) => {
      const nonce = Math.floor(Math.random() * 0xffffffff);
      const r = await dev.hello(nonce, 1500);
      expectKeys(r, ['product', 'protocol'], 'HELLO');
      if (r.nonce !== undefined && r.nonce !== nonce) throw new ShapeError('HELLO: nonce not echoed');
      return `${r.product} · protocol ${r.protocol}${r.nonce !== undefined ? ' · nonce echoed' : ' · no nonce echo'}`;
    },
  },
  {
    name: 'GET_CAPABILITIES',
    active: false,
    run: async (dev) => {
      const r = await dev.getCapabilities();
      expectKeys(r, ['protocol', 'hardware', 'capabilities', 'limits', 'configSchemaVersion'], 'CAPABILITIES');
      expectKeys(r.capabilities, ['cameraCount', 'wiggle', 'quad', 'gallery'], 'CAPABILITIES.capabilities');
      expectKeys(r.limits, ['maxUartBaud', 'maxResolution', 'maxGalleryPageSize'], 'CAPABILITIES.limits');
      if (r.capabilities.cameraCount !== 4) throw new ShapeError('CAPABILITIES: cameraCount must be 4 on V1');
      const on = Object.entries(r.capabilities)
        .filter(([, v]) => v === true)
        .map(([k]) => k);
      return `schema ${r.configSchemaVersion} · ${on.length} features · ${r.limits.maxUartBaud / 1000}k max baud`;
    },
  },
  {
    name: 'GET_DEVICE_INFO',
    active: false,
    run: async (dev) => {
      const r = await dev.getDeviceInfo();
      expectKeys(r, ['product', 'hardware', 'serial', 'protocol', 'p4Firmware', 'cameraFirmware', 'sdPresent'], 'DEVICE_INFO');
      if (!Array.isArray(r.cameraFirmware) || r.cameraFirmware.length !== 4) {
        throw new ShapeError('DEVICE_INFO: cameraFirmware must list 4 versions');
      }
      return `${r.serial} · P4 ${r.p4Firmware}`;
    },
  },
  {
    name: 'GET_CAMERA_INFO',
    active: false,
    run: async (dev) => {
      const r = await dev.getCameraInfo();
      if (!Array.isArray(r.cameras) || r.cameras.length !== 4) throw new ShapeError('CAMERA_INFO: needs 4 cameras');
      expectKeys(r.cameras[0], ['id', 'online', 'sensor', 'firmware', 'state'], 'CAMERA_INFO[0]');
      return `${r.cameras.filter((c) => c.online).length}/4 online`;
    },
  },
  {
    name: 'GET_POWER_STATUS',
    active: false,
    run: async (dev) => {
      const r = await dev.getPowerStatus();
      expectKeys(r, ['batteryV', 'batteryPct', 'state'], 'POWER');
      return `${r.batteryV.toFixed(2)} V · ${r.batteryPct}%`;
    },
  },
  {
    name: 'GET_STORAGE_STATUS',
    active: false,
    run: async (dev) => {
      const r = await dev.getStorageStatus();
      expectKeys(r, ['present', 'totalMB', 'freeMB'], 'STORAGE');
      return r.present ? `${r.freeMB} MB free` : 'no card';
    },
  },
  {
    name: 'GET_CONFIG',
    active: false,
    run: async (dev) => {
      const env = await dev.getConfig();
      expectKeys(env, ['schemaVersion', 'configRevision', 'config'], 'CONFIG envelope');
      if (typeof env.schemaVersion !== 'number') throw new ShapeError('CONFIG: schemaVersion must be a number');
      const r = env.config;
      expectKeys(r, ['mode', 'wiggle', 'quad', 'shoot', 'body'], 'CONFIG.config');
      expectKeys(r.wiggle, ['resolution', 'fps', 'recipeId', 'loop', 'direction'], 'CONFIG.wiggle');
      expectKeys(r.quad, ['flash', 'slots'], 'CONFIG.quad');
      return `schema ${env.schemaVersion} · revision ${env.configRevision} · mode ${r.mode}`;
    },
  },
  {
    name: 'GET_MODES',
    active: false,
    run: async (dev) => {
      const r = await dev.client.request<{ modes: string[] }>(0x20);
      if (!Array.isArray(r.modes) || !r.modes.includes('wiggle')) throw new ShapeError('MODES: missing wiggle');
      return r.modes.join(', ');
    },
  },
  {
    name: 'GET_RECIPES',
    active: false,
    run: async (dev) => {
      const r = await dev.getRecipes();
      if (!Array.isArray(r.factory) || r.factory.length === 0) throw new ShapeError('RECIPES: no factory looks');
      expectKeys(r.factory[0], ['schema', 'id', 'name', 'capture', 'look'], 'RECIPES.factory[0]');
      return `${r.factory.length} factory · ${r.custom.length} custom`;
    },
  },
  {
    name: 'CAMERA_STATUS (CAM2)',
    active: false,
    run: async (dev) => {
      const r = await dev.cameraStatus('cam2');
      expectKeys(r, ['id', 'online', 'state'], 'CAMERA_STATUS');
      return `${r.state} · ${r.latencyMs} ms`;
    },
  },
  {
    name: 'CAMERA_CALIBRATE (get)',
    active: false,
    run: async (dev) => {
      const r = await dev.getCalibration();
      expectKeys(r, ['reference', 'cams', 'order', 'spacingMm', 'flash'], 'CALIBRATION');
      return `reference ${r.reference}`;
    },
  },
  {
    name: 'GET_LOGS',
    active: false,
    run: async (dev) => {
      const r = await dev.getLogs();
      if (!Array.isArray(r.entries)) throw new ShapeError('LOGS: entries missing');
      return `${r.entries.length} buffered entries`;
    },
  },
  {
    name: 'GET_RUNTIME_STATS',
    active: false,
    run: async (dev) => {
      const r = await dev.getRuntimeStats();
      expectKeys(r, ['uptimeS', 'resetReason', 'freeHeapKB', 'protocol'], 'STATS');
      return `up ${r.uptimeS}s · ${r.resetReason}`;
    },
  },
  {
    name: 'MEDIA_LIST',
    active: false,
    run: async (dev, ctx) => {
      const r = await dev.mediaList({ cursor: 0, limit: 2 });
      expectKeys(r, ['total', 'items', 'nextCursor', 'hasMore'], 'MEDIA_LIST');
      if (!Array.isArray(r.items)) throw new ShapeError('MEDIA_LIST: items missing');
      if (r.items.length > 2) throw new ShapeError('MEDIA_LIST: limit not honored');
      if (r.total > 2 && !r.hasMore) throw new ShapeError('MEDIA_LIST: hasMore false with more items available');
      if (r.items.length > 0) {
        expectKeys(r.items[0], ['id', 'kind', 'ts'], 'MEDIA_LIST.items[0]');
        ctx.captureId = r.items[0].id;
      }
      return `${r.total} captures · page of ${r.items.length} · nextCursor ${String(r.nextCursor)}`;
    },
  },
  {
    name: 'MEDIA_INFO',
    active: false,
    run: async (dev, ctx) => {
      if (!ctx.captureId) return 'skipped — empty card';
      const r = await dev.mediaInfo(ctx.captureId);
      expectKeys(r, ['files', 'meta'], 'MEDIA_INFO');
      if (!Array.isArray(r.files) || r.files.length !== 4) throw new ShapeError('MEDIA_INFO: needs 4 files');
      expectKeys(r.files[0], ['name', 'sizeBytes', 'sha256'], 'MEDIA_INFO.files[0]');
      ctx.fileName = r.files[0].name;
      return `${ctx.captureId} · ${r.files.length} files`;
    },
  },
  {
    name: 'MEDIA_THUMB',
    active: false,
    run: async (dev, ctx) => {
      if (!ctx.captureId) return 'skipped — empty card';
      const bytes = await dev.mediaThumb(ctx.captureId);
      if (bytes.length < 100) throw new ShapeError('THUMB: too small to be a JPEG');
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ShapeError('THUMB: not a JPEG');
      return `${bytes.length} bytes`;
    },
  },
  {
    name: 'MEDIA_READ',
    active: false,
    run: async (dev, ctx) => {
      if (!ctx.captureId || !ctx.fileName) return 'skipped — empty card';
      const bytes = await dev.mediaRead(ctx.captureId, ctx.fileName, 0, 256);
      if (bytes.length === 0) throw new ShapeError('MEDIA_READ: empty chunk');
      return `${bytes.length} bytes @ offset 0`;
    },
  },
  {
    name: 'FW_QUERY',
    active: false,
    run: async (dev) => {
      const r = await dev.fwQuery();
      expectKeys(r, ['targets'], 'FW_QUERY');
      const targets = Object.keys(r.targets);
      const expected = ['p4', 'cam1', 'cam2', 'cam3', 'cam4'];
      const missing = expected.filter((t) => !targets.includes(t));
      if (missing.length > 0) throw new ShapeError(`FW_QUERY: missing ${missing.join(', ')}`);
      return `5 targets reported`;
    },
  },
  {
    name: 'FW_BEGIN gate (outside maintenance)',
    active: false,
    run: async (dev) => {
      try {
        await dev.fwBegin({ target: 'cam1', size: 1024, sha256: 'a'.repeat(64), version: '0.0.0' });
      } catch (err) {
        if (err instanceof KinoCommandError && /maint/i.test(err.code + err.message)) {
          return 'correctly refused: maintenance required';
        }
        throw err;
      }
      // Accepting a flash session outside maintenance is a firmware bug.
      await dev.fwAbort().catch(() => undefined);
      throw new ShapeError('FW_BEGIN accepted an update outside maintenance mode');
    },
  },
  {
    name: 'CAMERA_CAPTURE timing test',
    active: true,
    run: async (dev) => {
      const r = await dev.timingTest();
      expectKeys(r, ['cams', 'gpioSpreadUs', 'vsyncSpreadUs', 'exposureSpreadUs', 'vsyncMeasured'], 'TIMING');
      if (!Array.isArray(r.cams) || r.cams.length !== 4) throw new ShapeError('TIMING: needs 4 cameras');
      expectKeys(r.cams[0], ['cam', 'gpioUs', 'vsyncPhaseUs', 'exposureUs'], 'TIMING.cams[0]');
      if (!r.vsyncMeasured) return 'firmware reports GPIO only — VSYNC telemetry unavailable';
      return `gpio ${r.gpioSpreadUs} µs · vsync ${(r.vsyncSpreadUs / 1000).toFixed(2)} ms`;
    },
  },
  {
    name: 'CAMERA_TEST (CAM2)',
    active: true,
    run: async (dev) => {
      const r = await dev.cameraTest('cam2');
      expectKeys(r, ['ok', 'jpegKB'], 'CAMERA_TEST');
      return `jpeg ${r.jpegKB} KB in ${r.durationMs} ms`;
    },
  },
  {
    name: 'CAMERA_PREVIEW frame',
    active: true,
    run: async (dev) => {
      const bytes = await dev.previewFrame('cam2');
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ShapeError('PREVIEW: not a JPEG');
      return `${bytes.length} bytes`;
    },
  },
  {
    name: 'SET_CONFIG round trip',
    active: true,
    run: async (dev) => {
      const before = await dev.getConfig();
      await dev.applyConfig({ wiggle: { ...before.config.wiggle } });
      const after = await dev.getConfig();
      if (after.config.wiggle.fps !== before.config.wiggle.fps) {
        throw new ShapeError('SET_CONFIG: value drifted on no-op write');
      }
      if (after.configRevision === before.configRevision) {
        throw new ShapeError('SET_CONFIG: configRevision did not increment');
      }
      return `revision ${before.configRevision} → ${after.configRevision}`;
    },
  },
  {
    name: 'MAINTENANCE enter/exit',
    active: true,
    run: async (dev) => {
      await dev.enterMaintenance();
      await dev.exitMaintenance();
      return 'entered and exited cleanly';
    },
  },
];

export function conformanceCaseCount(includeActive: boolean): number {
  return CASES.filter((c) => includeActive || !c.active).length;
}

export async function runConformance(
  dev: KinoDevice,
  includeActive: boolean,
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<ConformanceResult[]> {
  const ctx: Ctx = {};
  const selected = CASES.filter((c) => includeActive || !c.active);
  const results: ConformanceResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const testCase = selected[i];
    onProgress?.(i, selected.length, testCase.name);
    const t0 = performance.now();
    try {
      const detail = await testCase.run(dev, ctx);
      results.push({
        name: testCase.name,
        active: testCase.active,
        status: detail.startsWith('skipped') ? 'skipped' : 'pass',
        detail,
        ms: Math.round(performance.now() - t0),
      });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      if (err instanceof ShapeError) {
        results.push({ name: testCase.name, active: testCase.active, status: 'shape', detail: err.message, ms });
      } else if (err instanceof KinoTimeoutError) {
        results.push({ name: testCase.name, active: testCase.active, status: 'timeout', detail: 'no response', ms });
      } else if (err instanceof KinoCommandError && err.code === 'UNKNOWN_CMD') {
        results.push({ name: testCase.name, active: testCase.active, status: 'unsupported', detail: err.message, ms });
      } else {
        results.push({
          name: testCase.name,
          active: testCase.active,
          status: 'error',
          detail: err instanceof Error ? err.message : String(err),
          ms,
        });
      }
    }
  }
  onProgress?.(selected.length, selected.length, 'done');
  return results;
}
