// Session orchestrator: owns the transport + protocol client + device
// facade, runs the connect/handshake sequence, keeps stores fed, and
// survives device reboots during firmware updates. React components never
// touch a transport directly — they call into this module.

import { KinoProtocolClient, KinoTimeoutError, KinoUnsupportedError } from '@kino/kdp';
import { Evt, PROTOCOL_VERSION } from '@kino/kdp';
import type {
  CalibrationEvent,
  CaptureEvent,
  LogEntry,
  PhaseResult,
  SelfTestEvent,
} from '@kino/kdp';
import { KinoDevice } from '../device/KinoDevice';
import { clearSoundCache } from '../device/sounds';
import type { Transport, TransportKind } from '@kino/kdp';
import { MockTransport } from '@kino/kdp';
import { SerialTransport, webSerialSupported } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { setConnection, useConnectionStore } from '../state/connectionStore';
import { clearDeviceState, setDeviceState, useDeviceStore } from '../state/deviceStore';
import { resetDrafts } from '../state/draftStore';
import { claimDevice, releaseDevice, resetDeviceBusy } from '../state/deviceBusy';
import { CONFIG_SCHEMA_VERSION } from '@kino/kdp';
import { appendLog } from '../state/logStore';
import { recordCamera } from '../state/knownCameras';

type BusEvent = 'calibration' | 'selftest' | 'capture' | 'phase';

const busHandlers: Record<BusEvent, Set<(payload: never) => void>> = {
  calibration: new Set(),
  selftest: new Set(),
  capture: new Set(),
  phase: new Set(),
};

export function onCalibrationEvent(cb: (e: CalibrationEvent) => void): () => void {
  busHandlers.calibration.add(cb as (payload: never) => void);
  return () => busHandlers.calibration.delete(cb as (payload: never) => void);
}

export function onSelfTestEvent(cb: (e: SelfTestEvent) => void): () => void {
  busHandlers.selftest.add(cb as (payload: never) => void);
  return () => busHandlers.selftest.delete(cb as (payload: never) => void);
}

export function onCaptureEvent(cb: (e: CaptureEvent) => void): () => void {
  busHandlers.capture.add(cb as (payload: never) => void);
  return () => busHandlers.capture.delete(cb as (payload: never) => void);
}

export type PhaseEvent = { step: 'rephase'; cam: string } | ({ step: 'result' } & PhaseResult);

export function onPhaseEvent(cb: (e: PhaseEvent) => void): () => void {
  busHandlers.phase.add(cb as (payload: never) => void);
  return () => busHandlers.phase.delete(cb as (payload: never) => void);
}

let demoDevice: MockKinoDevice | null = null;
let transport: Transport | null = null;
let client: KinoProtocolClient | null = null;
let device: KinoDevice | null = null;
let lastKind: TransportKind | null = null;
let lastSerialPort: SerialPort | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let expectRebootUntil = 0;
let generation = 0;
let reconnecting = false;

export function getDevice(): KinoDevice | null {
  return device;
}

export function getDemoDevice(): MockKinoDevice | null {
  return demoDevice;
}

export function isDemo(): boolean {
  return lastKind === 'mock';
}

/** Firmware updater calls this right before a P4 reboot is expected. */
export function expectDeviceReboot(windowMs = 45000) {
  expectRebootUntil = Date.now() + windowMs;
}

export function waitForPhase(phase: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (useConnectionStore.getState().phase === phase) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`KINO did not come back within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const unsub = useConnectionStore.subscribe((s) => {
      if (s.phase === phase) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

export async function connectDemo(): Promise<void> {
  if (!demoDevice) demoDevice = new MockKinoDevice();
  await connectWith(() => new MockTransport(demoDevice!), 'mock');
}

export async function connectSerial(): Promise<void> {
  if (!webSerialSupported()) {
    setConnection({ phase: 'error', error: 'This browser has no Web Serial support. Use desktop Chrome or Edge.' });
    return;
  }
  setConnection({ phase: 'requesting-port', error: null });
  let port: SerialPort;
  try {
    port = await navigator.serial.requestPort();
  } catch {
    // User dismissed the picker — not an error state.
    setConnection({ phase: 'disconnected' });
    return;
  }
  lastSerialPort = port;
  await connectWith(() => new SerialTransport(port), 'serial');
}

async function connectWith(factory: () => Transport, kind: TransportKind): Promise<void> {
  await teardown(false);
  lastKind = kind;
  const gen = ++generation;
  // While the reconnect loop runs, the shell stays up with a REBOOTING
  // banner — intermediate phases would flash the connect screen instead.
  setConnection(
    reconnecting
      ? { transportKind: kind, error: null }
      : { phase: 'connecting', transportKind: kind, error: null },
  );

  const t = factory();
  t.onClose((reason) => handleTransportClose(gen, factory, reason));
  try {
    await t.open();
  } catch (err) {
    if (!reconnecting) {
      setConnection({ phase: 'error', error: `Could not open ${kind === 'serial' ? 'serial port' : 'demo device'}: ${message(err)}` });
    }
    return;
  }

  transport = t;
  const c = new KinoProtocolClient(t);
  client = c;
  device = new KinoDevice(c);
  wireEvents(c);

  if (!reconnecting) setConnection({ phase: 'handshaking' });
  try {
    await handshake(device);
    await populateAll();
  } catch (err) {
    await teardown(false);
    if (!reconnecting) {
      setConnection({ phase: 'error', error: `Handshake failed: ${message(err)}` });
    }
    return;
  }

  setConnection({ phase: 'connected' });
  startPolling();
}

/**
 * An ESP32 spews ROM boot text before firmware runs, so the first bytes on
 * the wire are usually garbage. The frame decoder resynchronizes on the
 * magic, and HELLO is retried a few times with a nonce so a stale buffered
 * reply can never be mistaken for a live one.
 */
async function handshake(device: KinoDevice): Promise<void> {
  const attempts = 3;
  let lastError: Error | null = null;
  for (let i = 1; i <= attempts; i++) {
    const nonce = Math.floor(Math.random() * 0xffffffff);
    try {
      const hello = await device.hello(nonce, 500);
      if (hello.product !== 'KINO') {
        throw new Error(`Device answered as "${hello.product}" — not a KINO`);
      }
      if (hello.nonce !== undefined && hello.nonce !== nonce) {
        throw new Error('Handshake reply did not match the request — stale serial buffer');
      }
      if (hello.protocol !== PROTOCOL_VERSION) {
        throw new Error(
          `Protocol ${hello.protocol} is not supported by this version of KINO Studio (needs ${PROTOCOL_VERSION})`,
        );
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only retry silence; a wrong product or protocol is final.
      if (!(err instanceof KinoTimeoutError)) throw lastError;
      if (i < attempts) await sleep(150);
    }
  }
  throw new Error(`No HELLO reply after ${attempts} attempts: ${lastError?.message ?? 'silent'}`);
}

function wireEvents(c: KinoProtocolClient) {
  c.onEvent<LogEntry>(Evt.LOG, (entry) => appendLog(entry));
  c.onEvent<CalibrationEvent>(Evt.CALIBRATION, (e) => {
    for (const cb of busHandlers.calibration) (cb as (p: CalibrationEvent) => void)(e);
  });
  c.onEvent<SelfTestEvent>(Evt.SELF_TEST, (e) => {
    for (const cb of busHandlers.selftest) (cb as (p: SelfTestEvent) => void)(e);
  });
  c.onEvent<CaptureEvent>(Evt.CAPTURE, (e) => {
    for (const cb of busHandlers.capture) (cb as (p: CaptureEvent) => void)(e);
  });
  c.onEvent<PhaseEvent>(Evt.PHASE, (e) => {
    for (const cb of busHandlers.phase) (cb as (p: PhaseEvent) => void)(e);
  });
}

async function populateAll() {
  if (!device) return;
  const info = await device.getDeviceInfo();

  // A draft edited against one camera must never be applied to another.
  const prevSerial = useDeviceStore.getState().info?.serial;
  if (prevSerial && prevSerial !== info.serial) resetDrafts();

  // Capability negotiation: firmware that predates this command simply
  // NACKs or times out, and Studio falls back to a conservative baseline.
  let capabilities = null as Awaited<ReturnType<KinoDevice['getCapabilities']>> | null;
  try {
    capabilities = await device.getCapabilities();
  } catch (err) {
    if (!(err instanceof KinoUnsupportedError || err instanceof KinoTimeoutError)) throw err;
  }

  const [cams, power, storage, envelope, recipes, calibration, stats] = await Promise.all([
    device.getCameraInfo(),
    device.getPowerStatus(),
    device.getStorageStatus(),
    device.getConfig(),
    device.getRecipes(),
    device.getCalibration(),
    device.getRuntimeStats(),
  ]);

  // Sounds arrived after V1 firmware — absence is a state, not an error.
  let sounds = null as Awaited<ReturnType<KinoDevice['getSounds']>> | null;
  if (capabilities === null || capabilities.capabilities.customSounds) {
    try {
      sounds = await device.getSounds();
    } catch (err) {
      if (!(err instanceof KinoUnsupportedError || err instanceof KinoTimeoutError)) throw err;
    }
  }

  if (envelope.schemaVersion !== undefined && envelope.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Camera config schema ${envelope.schemaVersion} is newer than this KINO Studio (${CONFIG_SCHEMA_VERSION}). Update Studio.`,
    );
  }

  setDeviceState({
    info,
    cameras: cams.cameras,
    power,
    storage,
    config: envelope.config,
    configRevision: envelope.configRevision ?? 0,
    capabilities: capabilities?.capabilities ?? null,
    limits: capabilities?.limits ?? null,
    firmwareLabel: capabilities?.firmware ?? info.p4Firmware,
    factoryRecipes: recipes.factory,
    customRecipes: recipes.custom,
    sounds: sounds?.custom ?? [],
    soundLimits: sounds ? { maxCustom: sounds.maxCustom, maxSoundKB: sounds.maxSoundKB } : null,
    calibration,
    stats,
  });
  recordCamera(info, lastKind === 'mock');
}

/**
 * Re-read every device-owned value (toolbar SYNC / F5).
 *
 * This is many round trips at 921600, so it takes the same exclusive claim the
 * benches take. Without it a reflexive F5 contended on the UART with a running
 * burn-in and both reported numbers as if nothing had happened.
 */
export async function refreshAll(): Promise<'done' | 'blocked' | 'offline'> {
  if (!device) return 'offline';
  if (!claimDevice('sync', 'SYNC')) return 'blocked';
  try {
    await populateAll();
    return 'done';
  } finally {
    releaseDevice('sync');
  }
}

export async function refreshDeviceInfo() {
  if (!device) return;
  setDeviceState({ info: await device.getDeviceInfo() });
}

export async function refreshConfig() {
  if (!device) return;
  const envelope = await device.getConfig();
  setDeviceState({ config: envelope.config, configRevision: envelope.configRevision ?? 0 });
}

export async function refreshRecipes() {
  if (!device) return;
  const recipes = await device.getRecipes();
  setDeviceState({ factoryRecipes: recipes.factory, customRecipes: recipes.custom });
}

export async function refreshSounds() {
  if (!device) return;
  const sounds = await device.getSounds();
  setDeviceState({
    sounds: sounds.custom,
    soundLimits: { maxCustom: sounds.maxCustom, maxSoundKB: sounds.maxSoundKB },
  });
}

export async function refreshCalibration() {
  if (!device) return;
  setDeviceState({ calibration: await device.getCalibration() });
}

function startPolling() {
  stopPolling();
  let tick = 0;
  pollTimer = setInterval(async () => {
    if (!device) return;
    const phase = useConnectionStore.getState().phase;
    if (phase !== 'connected' && phase !== 'maintenance') return;
    tick++;
    try {
      const cams = await device.getCameraInfo();
      setDeviceState({ cameras: cams.cameras });
      if (tick % 2 === 0) {
        const [power, storage] = await Promise.all([device.getPowerStatus(), device.getStorageStatus()]);
        setDeviceState({ power, storage });
      }
      if (tick % 3 === 0) {
        setDeviceState({ stats: await device.getRuntimeStats() });
      }
    } catch {
      // A single missed poll (busy device, injected timeout) is not a
      // disconnect. The transport close handler owns real disconnects.
    }
  }, 4000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function handleTransportClose(gen: number, factory: () => Transport, reason?: string) {
  if (gen !== generation) return; // stale transport from a previous session
  stopPolling();
  // A bench that was mid-run no longer holds anything.
  resetDeviceBusy();
  client?.dispose(reason ?? 'Connection closed');
  client = null;
  device = null;
  transport = null;

  const rebootExpected = Date.now() < expectRebootUntil;
  if (rebootExpected) {
    setConnection({ phase: 'reconnecting' });
    void reconnectLoop(factory);
    return;
  }

  clearDeviceState();
  const phase = useConnectionStore.getState().phase;
  if (phase === 'connected' || phase === 'maintenance' || phase === 'updating') {
    setConnection({ phase: 'error', error: reason ?? 'KINO disconnected unexpectedly' });
  } else {
    setConnection({ phase: 'disconnected' });
  }
}

async function reconnectLoop(factory: () => Transport) {
  reconnecting = true;
  try {
    for (let attempt = 1; attempt <= 12; attempt++) {
      await sleep(1500);
      if (Date.now() > expectRebootUntil + 20000) break;
      try {
        await connectWith(factory, lastKind ?? 'mock');
        if (useConnectionStore.getState().phase === 'connected') {
          expectRebootUntil = 0;
          return;
        }
      } catch {
        // keep trying
      }
      setConnection({ phase: 'reconnecting' });
    }
  } finally {
    reconnecting = false;
  }
  expectRebootUntil = 0;
  clearDeviceState();
  setConnection({ phase: 'error', error: 'KINO did not come back after reboot. Check the cable and reconnect.' });
}

export async function disconnect(): Promise<void> {
  expectRebootUntil = 0;
  await teardown(true);
  setConnection({ phase: 'disconnected', transportKind: null, error: null });
}

async function teardown(clearState: boolean) {
  generation++;
  stopPolling();
  const t = transport;
  transport = null;
  client?.dispose();
  client = null;
  device = null;
  if (t) {
    try {
      await t.close();
    } catch {
      // Port already gone.
    }
  }
  if (clearState) {
    clearDeviceState();
    clearSoundCache();
    // Drafts and any bench claim belong to the camera that just left.
    resetDrafts();
    resetDeviceBusy();
  }
}

/** Reconnect after a user-requested reboot (or factory reset). */
export async function rebootAndReconnect(): Promise<void> {
  if (!device) return;
  expectDeviceReboot(30000);
  await device.reboot();
}

export async function factoryResetAndReconnect(): Promise<void> {
  if (!device) return;
  expectDeviceReboot(30000);
  await device.factoryReset();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Serial reconnect uses the remembered port; exported for the connect screen
// to re-offer "reconnect last port" later without a new picker dialog.
export function getLastSerialPort(): SerialPort | null {
  return lastSerialPort;
}
