// Protocol conformance suite: fires each command at the connected device
// and classifies the response. Green across the board is the acceptance
// bar for real P4 firmware — Studio is the test harness.

import type { KinoDevice } from '../device/KinoDevice';
import { Cmd, KinoCommandError, KinoTimeoutError, KinoUnsupportedError } from '@kino/kdp';
import type { SoakTestSummary } from '@kino/kdp';

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
  /** Set by GET_CAPABILITIES; gates the capture cases. */
  gallery?: boolean;
  /** Set by the GET_CAPABILITIES case; gates the bench-diagnostics cases. */
  bench?: boolean;
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
      /* A device that reports a clock source must report one of the three we
       * know how to interpret. `unset` is a perfectly good answer from a body
       * that has never been told the time - what would not be is a plausible
       * timestamp with nothing saying where it came from. */
      const clock = r.clockSource;
      if (clock !== undefined && !['host', 'persisted', 'unset'].includes(clock)) {
        throw new ShapeError(`HELLO: unknown clockSource ${String(clock)}`);
      }
      const clockNote = clock === undefined ? 'no clock' : `clock ${clock}`;
      return `${r.product} · protocol ${r.protocol}${r.nonce !== undefined ? ' · nonce echoed' : ' · no nonce echo'} · ${clockNote}`;
    },
  },
  {
    name: 'GET_CAPABILITIES',
    active: false,
    run: async (dev, ctx) => {
      const r = await dev.getCapabilities();
      ctx.bench = r.capabilities.benchDiagnostics === true;
      ctx.gallery = r.capabilities.gallery === true;
      // `firmware` is in the response contract and is what the Unsupported
      // panels quote by name, so a device that omits it is a shape failure,
      // not a cosmetic one.
      expectKeys(r, ['protocol', 'hardware', 'firmware', 'capabilities', 'limits', 'configSchemaVersion'], 'CAPABILITIES');
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
      /* Present-and-null is the answer on a body with no gauge (contract
       * D10), so the keys are required and the numbers are not. Both must
       * agree: a voltage with no percentage, or the reverse, is a firmware
       * that measured half a cell. */
      if ((r.batteryV === null) !== (r.batteryPct === null)) {
        throw new ShapeError('POWER: batteryV and batteryPct disagree about whether the cell was measured');
      }
      if (r.batteryV === null) return `no gauge · ${r.state}`;
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
    name: 'GET_SOUNDS',
    active: false,
    run: async (dev) => {
      const r = await dev.getSounds();
      expectKeys(r, ['custom', 'maxCustom', 'maxSoundKB'], 'SOUNDS');
      if (!Array.isArray(r.custom)) throw new ShapeError('SOUNDS: custom is not an array');
      // The limits are the reason a host can size an upload before it starts.
      // A device reporting zero slots or zero KB would pass a key check and
      // then refuse every SOUND_BEGIN it was sent.
      if (!(r.maxCustom > 0) || !(r.maxSoundKB > 0)) throw new ShapeError('SOUNDS: maxCustom and maxSoundKB must be positive');
      return `${r.custom.length}/${r.maxCustom} slots · ${r.maxSoundKB} KB max`;
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
  // ---- bench diagnostics (Milestone 1B, capability `benchDiagnostics`) ----
  {
    name: 'GET_STORAGE_STATUS (1B fields)',
    active: false,
    run: async (dev, ctx) => {
      if (ctx.bench !== true) return 'skipped — pre-1B firmware';
      const r = await dev.getStorageStatus();
      expectKeys(r, ['mounted', 'filesystem', 'capacityBytes', 'freeBytes', 'lastError', 'mountAttempts', 'writeTestStatus'], 'STORAGE 1B');
      return `mounted ${r.mounted} · ${r.mountAttempts} attempts · write test ${r.writeTestStatus}`;
    },
  },
  {
    name: 'CAMERA_LINK_STATS (CAM1)',
    active: false,
    run: async (dev, ctx) => {
      if (ctx.bench !== true) return 'skipped — pre-1B firmware';
      const r = await dev.cameraLinkStats('cam1');
      expectKeys(r, ['cam', 'baud', 'connected', 'rxFrames', 'txFrames', 'crcErrors', 'decoderResyncs', 'timeouts', 'duplicateFrames', 'lastSequence'], 'LINK_STATS');
      return `${r.connected ? 'up' : 'down'} @ ${r.baud} · ${r.crcErrors} crc · ${r.timeouts} timeouts`;
    },
  },
  {
    name: 'GET_HW_VALIDATION',
    active: false,
    run: async (dev, ctx) => {
      if (ctx.bench !== true) return 'skipped — pre-1B firmware';
      const r = await dev.getHwValidation();
      expectKeys(r, ['p4ResetReason', 'items'], 'HW_VALIDATION');
      if (!Array.isArray(r.items) || r.items.length === 0) throw new ShapeError('HW_VALIDATION: no items');
      expectKeys(r.items[0], ['id', 'status'], 'HW_VALIDATION.items[0]');
      const validated = r.items.filter((i) => i.status === 'validated').length;
      return `${validated}/${r.items.length} validated · reset ${r.p4ResetReason}`;
    },
  },
  {
    name: 'STORAGE_SELF_TEST',
    active: true,
    run: async (dev, ctx) => {
      if (ctx.bench !== true) return 'skipped — pre-1B firmware';
      const r = await dev.storageSelfTest();
      expectKeys(r, ['ok', 'failedPhase', 'durationMs', 'bytesTested'], 'SELF_TEST');
      if (r.ok && r.failedPhase !== null) throw new ShapeError('SELF_TEST: ok with a failedPhase');
      return r.ok ? `${r.bytesTested} bytes verified in ${r.durationMs} ms` : `failed at ${r.failedPhase}`;
    },
  },
  {
    name: 'CAMERA_TEST (CAM1, 1B shape)',
    active: true,
    run: async (dev, ctx) => {
      if (ctx.bench !== true) return 'skipped — pre-1B firmware';
      const r = await dev.cameraTest('cam1');
      expectKeys(r, ['ok', 'captureUuid', 'timing', 'checksums', 'memory'], 'CAMERA_TEST 1B');
      expectKeys(r.timing, ['requestToNodeMs', 'captureCommandToJpegReadyMs', 'jpegTransferMs', 'sdWriteMs', 'totalMs'], 'CAMERA_TEST.timing');
      expectKeys(r.checksums, ['nodeJpegCrc32', 'transferCrc32', 'storedFileCrc32', 'match'], 'CAMERA_TEST.checksums');
      if (!r.checksums!.match) throw new ShapeError('CAMERA_TEST: checksums disagree on a successful capture');
      return `${r.jpegBytes} bytes · total ${r.timing!.totalMs} ms · checksums match`;
    },
  },
  {
    name: 'CAMERA_SOAK_TEST (2 captures)',
    active: true,
    run: async (dev, ctx) => {
      if (ctx.bench !== true) return 'skipped — pre-1B firmware';
      const handle = await dev.client.startJob<SoakTestSummary>(Cmd.CAMERA_SOAK_TEST, {
        cam: 'cam1',
        captures: 2,
        delayMs: 100,
      });
      for await (const p of handle.progress) void p;
      const r = await handle.result;
      expectKeys(r, ['attempted', 'successful', 'failed', 'heapDeltaKB', 'errors'], 'SOAK');
      if (r.attempted !== 2) throw new ShapeError(`SOAK: attempted ${r.attempted}, requested 2`);
      return `${r.successful}/${r.attempted} ok · heap Δ ${r.heapDeltaKB} KB`;
    },
  },
  {
    /*
     * The shutter, over the wire. This is the product's one indispensable
     * command and the only case here that leaves a photograph behind, which
     * is why it is `active` - a passive conformance run must never fill
     * someone's card.
     */
    name: 'CAMERA_CAPTURE',
    active: true,
    run: async (dev, ctx) => {
      if (ctx.gallery !== true) return 'skipped — no capture pipeline in this firmware';
      const r = await dev.captureNow();
      expectKeys(r, ['ok', 'schema', 'id', 'captureUuid', 'mode', 'frameCount', 'status', 'timing'], 'CAPTURE');
      if (r.schema !== 'kino.capture') throw new ShapeError(`CAPTURE: schema ${r.schema}`);
      if (r.frameCount < 1) throw new ShapeError('CAPTURE: reported ok with no frames');
      if (r.status !== 'complete' && r.status !== 'partial') {
        throw new ShapeError(`CAPTURE: status ${r.status}`);
      }
      /*
       * The three skews must be null, and this is the case worth keeping
       * strict. A body that starts reporting a number here has either grown
       * exposure timing hardware or started guessing, and only one of those
       * is allowed to happen quietly. Dispatch spread is reported under its
       * own name precisely so it can never be mistaken for one of them.
       */
      for (const k of ['gpioTriggerSkewUs', 'vsyncPhaseSkewUs', 'effectiveExposureSkewUs'] as const) {
        if (r.timing[k] !== null) throw new ShapeError(`CAPTURE: ${k} is not null on a body that cannot measure it`);
      }
      if (!r.timing.unavailableReason) throw new ShapeError('CAPTURE: null skews with no reason given');
      // The gallery id, not the capture UUID. The cases below feed this to
      // MEDIA_INFO / MEDIA_THUMB / MEDIA_READ, which address captures by id;
      // seeding the UUID made every one of them report "empty card" against a
      // capture that had just been written.
      ctx.captureId = r.id;
      return `${r.id} · ${r.frameCount} frame(s) · ${r.status} · ${r.totalMs} ms · spread ${r.timing.dispatchSpreadUs} us`;
    },
  },
  {
    /*
     * timing-test, both ways round, in one case.
     *
     * A body that cannot measure exposure must refuse the request, not answer
     * it — and a capture is the wrong outcome too: timing-test is not a
     * request for a photograph. A body that *can* measure has to return the
     * whole TimingResult, which is what the deleted duplicate of this case
     * asserted unconditionally. Both assertions cannot hold on one firmware,
     * so which one applies is decided by the capability the device reports,
     * exactly like the bench cases above.
     */
    name: 'CAMERA_CAPTURE timing-test',
    active: false,
    run: async (dev, ctx) => {
      if (ctx.gallery !== true) return 'skipped — no capture pipeline in this firmware';
      const caps = await dev.getCapabilities();
      if (caps.capabilities.vsyncTelemetry === true) {
        const r = await dev.timingTest();
        expectKeys(r, ['cams', 'gpioSpreadUs', 'vsyncSpreadUs', 'exposureSpreadUs', 'vsyncMeasured'], 'TIMING');
        if (!Array.isArray(r.cams) || r.cams.length !== 4) throw new ShapeError('TIMING: needs 4 cameras');
        expectKeys(r.cams[0], ['cam', 'gpioUs', 'vsyncPhaseUs', 'exposureUs'], 'TIMING.cams[0]');
        if (!r.vsyncMeasured) {
          throw new ShapeError('TIMING: vsyncMeasured false on a body advertising vsyncTelemetry: true');
        }
        return `measured — gpio ${r.gpioSpreadUs} µs · vsync ${(r.vsyncSpreadUs / 1000).toFixed(2)} ms`;
      }
      try {
        await dev.timingTest();
      } catch (err) {
        if (err instanceof KinoCommandError || err instanceof KinoUnsupportedError) {
          return `refused — ${err.message.slice(0, 60)}`;
        }
        throw err;
      }
      throw new ShapeError('timing-test answered on a body advertising vsyncTelemetry: false');
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
      /*
       * Files present, not four files.
       *
       * This demanded exactly four, which was true while every capture came
       * from a body with four cameras wired. It is not true of a partial
       * capture, which is a state the capture pipeline reports on purpose -
       * a dead CAM3 costs you CAM3 and nothing else. Requiring four here
       * would mark honest behaviour as a protocol failure.
       *
       * The stronger check is that the file count agrees with the capture's
       * own frameCount: a capture claiming four frames with two on the card
       * is a real defect, and this catches it where a fixed 4 could not.
       */
      if (!Array.isArray(r.files) || r.files.length === 0) {
        throw new ShapeError('MEDIA_INFO: a capture with no files');
      }
      expectKeys(r.files[0], ['name', 'sizeBytes'], 'MEDIA_INFO.files[0]');
      const claimed = (r as unknown as { frameCount?: number }).frameCount;
      if (typeof claimed === 'number' && claimed !== r.files.length) {
        throw new ShapeError(`MEDIA_INFO: claims ${claimed} frames, ${r.files.length} on the card`);
      }
      /* sha256 is in the contract and firmware omits it rather than filling
       * it in wrong: hashing four multi-megabyte JPEGs on request blocks the
       * link for seconds. Absent is reported, not failed. */
      const digests = r.files.filter((f) => typeof f.sha256 === 'string' && f.sha256.length === 64).length;
      ctx.fileName = r.files[0].name;
      return `${ctx.captureId} · ${r.files.length} file(s) · ${digests} digest(s)`;
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
      /* A first page is capped at 8192 bytes by both the reference device and
       * firmware. Anything larger means a device ignoring the cap, which puts
       * it one noisy frame away from overrunning MAX_PAYLOAD. */
      if (bytes.length > 8192) throw new ShapeError(`THUMB: ${bytes.length} B in one page, cap is 8192`);
      return `${bytes.length} bytes`;
    },
  },
  {
    name: 'MEDIA_READ',
    active: false,
    run: async (dev, ctx) => {
      if (!ctx.captureId || !ctx.fileName) return 'skipped — empty card';
      const head = await dev.mediaRead(ctx.captureId, ctx.fileName, 0, 256);
      if (head.length === 0) throw new ShapeError('MEDIA_READ: empty chunk');
      /* The first two bytes of a stored frame are a JPEG SOI. Checking them
       * separates "the device answered" from "the device sent the file",
       * which a length alone cannot. */
      if (ctx.fileName.endsWith('.JPG') && (head[0] !== 0xff || head[1] !== 0xd8)) {
        throw new ShapeError('MEDIA_READ: first chunk is not a JPEG');
      }
      /* Offsets have to actually seek. Reading the same 16 bytes from 0 and
       * from 128 and getting the same answer is a device ignoring `offset`,
       * which looks perfectly healthy until a client assembles a file out of
       * pages and gets page one repeated. */
      const mid = await dev.mediaRead(ctx.captureId, ctx.fileName, 128, 16);
      const same = mid.length === 16 && mid.every((b, i) => b === head[128 + i]);
      if (mid.length === 16 && !same) throw new ShapeError('MEDIA_READ: offset returns the wrong bytes');
      return `${head.length} B @ 0 · ${mid.length} B @ 128 · offsets agree`;
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
      } else if (err instanceof KinoUnsupportedError || (err instanceof KinoCommandError && err.code === 'UNKNOWN_CMD')) {
        // The client raises KinoUnsupportedError for UNSUPPORTED_COMMAND;
        // matching only the legacy UNKNOWN_CMD code reported every genuinely
        // unsupported command as 'error' instead of 'unsupported'.
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
