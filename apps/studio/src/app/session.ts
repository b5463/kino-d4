// Session orchestrator: owns the transport + protocol client + device
// facade, runs the connect/handshake sequence, keeps stores fed, and
// survives device reboots during firmware updates. React components never
// touch a transport directly — they call into this module.

import { KinoHandshakeError, KinoProtocolClient, KinoTimeoutError, KinoUnsupportedError } from '@kino/kdp';
import { Evt, PROTOCOL_VERSION } from '@kino/kdp';
import type {
  CalibrationEvent,
  CaptureEvent,
  LogEntry,
  PhaseResult,
  SelfTestEvent,
  SessionChange,
} from '@kino/kdp';
import { KinoDevice } from '../device/KinoDevice';
import { clearSoundCache } from '../device/sounds';
import type { Transport, TransportKind } from '@kino/kdp';
import { MockTransport } from '@kino/kdp';
import { SerialTransport, webSerialSupported } from '@kino/kdp';
import { BroadcastTransport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { setConnection, useConnectionStore } from '../state/connectionStore';
import type { ConnectionFault } from '../state/connectionStore';
import { clearDeviceState, setDeviceState, useDeviceStore } from '../state/deviceStore';
import { resetDrafts } from '../state/draftStore';
import { claimDevice, releaseDevice, resetDeviceBusy } from '../state/deviceBusy';
import { CONFIG_SCHEMA_VERSION } from '@kino/kdp';
import { appendLog } from '../state/logStore';
import { recordCamera } from '../state/knownCameras';

/** Reported in HELLO so the device's own log names the peer (04 §4). */
const CLIENT_NAME = 'kino-studio';

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
let pollInFlight = false;
let expectRebootUntil = 0;
let generation = 0;
let reconnecting = false;
/**
 * Boot/session ID of the last camera this Studio spoke to. Studio builds a
 * fresh protocol client per connection, so the client cannot notice a reboot
 * on its own — it has to be handed what the previous one saw (04 §17).
 *
 * `lastDeviceId` is what keeps that from lying: two boot IDs only mean a
 * restart if they came from the same unit. Both are cleared whenever Studio
 * lets go of a camera deliberately.
 */
let lastSessionId: string | null = null;
let lastDeviceId: string | null = null;

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
    setConnection({
      phase: 'error',
      fault: null,
      error: 'This browser has no Web Serial support. Use desktop Chrome or Edge.',
    });
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

/**
 * KINO Twin §10 option 2: a Twin running in another same-origin tab, reached
 * over BroadcastTransport. Same connect/handshake/populate path as serial and
 * demo — the twin is just another transport kind, not a special case.
 */
export async function connectTwin(): Promise<void> {
  await connectWith(() => new BroadcastTransport(), 'twin');
}

/** What each transport kind is called in a "could not open" error. */
const OPEN_TARGET_LABEL: Record<TransportKind, string> = {
  serial: 'serial port',
  mock: 'demo device',
  twin: 'KINO Twin',
};

async function connectWith(factory: () => Transport, kind: TransportKind): Promise<void> {
  await teardown(false);
  lastKind = kind;
  const gen = ++generation;
  // While the reconnect loop runs, the shell stays up with a REBOOTING
  // banner — intermediate phases would flash the connect screen instead.
  setConnection(
    reconnecting
      ? { transportKind: kind, error: null, fault: null }
      : { phase: 'connecting', transportKind: kind, error: null, fault: null },
  );

  const t = factory();
  t.onClose((reason) => handleTransportClose(gen, factory, reason));
  try {
    await t.open();
  } catch (err) {
    if (!reconnecting) {
      // The port is the hardware as far as Studio can see it: nothing else
      // can be diagnosed until it opens.
      setConnection({
        phase: 'error',
        fault: 'hardware',
        error: `Could not open ${OPEN_TARGET_LABEL[kind]}: ${message(err)}`,
      });
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
    await handshake(c);
    await populateAll();
  } catch (err) {
    await teardown(false);
    if (!reconnecting) {
      setConnection({ phase: 'error', fault: handshakeFault(err), error: `Handshake failed: ${message(err)}` });
    }
    return;
  }

  setConnection({ phase: 'connected', fault: null });
  startPolling();
}

/**
 * An ESP32 spews ROM boot text before firmware runs, so the first bytes on
 * the wire are usually garbage. The frame decoder resynchronizes on the
 * magic, and HELLO is retried with a fresh nonce per attempt so a stale
 * buffered reply can never be mistaken for a live one.
 *
 * All of that lives in the protocol client (04 §4/§17), and Studio used to
 * run its own copy of the retry loop, which never compared boot IDs at all.
 *
 * The live poller also calls `recheckSession()` periodically. That covers a
 * watchdog/soft restart where the USB CDC endpoint remains open and there is
 * therefore no reconnect on which to run this initial handshake again.
 */
async function handshake(c: KinoProtocolClient): Promise<void> {
  const hello = await c.hello({
    protocolMin: PROTOCOL_VERSION,
    protocolMax: PROTOCOL_VERSION,
    clientVersion: CLIENT_NAME,
    // A fresh client per connection would otherwise read every reconnect as
    // a first session and never raise sessionChanged.
    knownSessionId: lastSessionId,
  });
  if (hello.product !== 'KINO') {
    throw new Error(`Device answered as "${hello.product}" — not a KINO`);
  }
  lastSessionId = c.sessionId;
  lastDeviceId = hello.deviceId ?? null;
}

/**
 * Re-run HELLO on the existing link so a new boot/session ID is observable
 * even when USB CDC never closes. The protocol client's session-change event
 * performs the same cache invalidation used by reconnect detection.
 */
export async function recheckSession(): Promise<void> {
  const c = client;
  if (!c) return;
  const hello = await c.hello({
    protocolMin: PROTOCOL_VERSION,
    protocolMax: PROTOCOL_VERSION,
    clientVersion: CLIENT_NAME,
    knownSessionId: lastSessionId,
    attempts: 1,
  });
  if (hello.product !== 'KINO') throw new Error(`Device answered as "${hello.product}" — not a KINO`);
  // Ignore a reply from a connection that was torn down while HELLO was in
  // flight. Its IDs must not contaminate the next camera's handshake.
  if (client !== c) return;
  lastSessionId = c.sessionId;
  lastDeviceId = hello.deviceId ?? null;
}

/**
 * Two different boot IDs are only a restart if the same unit produced them.
 * Unplug camera A and plug in camera B and the IDs differ for the ordinary
 * reason — telling the user their camera "restarted" would be a lie, and the
 * state that belonged to A is dropped by the serial check in `populateAll`
 * regardless. Firmware that predates device IDs (04 §17) reports none, and is
 * given the benefit of the doubt.
 */
export function isSameCamera(previousDeviceId: string | null, change: SessionChange): boolean {
  if (previousDeviceId === null || change.deviceId === undefined) return true;
  return change.deviceId === previousDeviceId;
}

/**
 * A protocol the device selected outside our range is the one handshake
 * failure the user can act on differently: it needs a different build, not a
 * different cable. 02 §6 gives it its own connection-strip state.
 */
function handshakeFault(err: unknown): ConnectionFault | null {
  return err instanceof KinoHandshakeError && err.reason === 'protocol' ? 'protocol-mismatch' : null;
}

function wireEvents(c: KinoProtocolClient) {
  // 04 §17: a new boot ID means the camera restarted under us. Anything this
  // session cached about it — drafts edited against the old run, a bench
  // claim, cached sounds — belongs to a device that no longer exists. The
  // client has already failed every in-flight job by the time this fires.
  c.onSessionChanged((change) => {
    // A different unit answering is not a restart — see `isSameCamera`.
    if (!isSameCamera(lastDeviceId, change)) return;
    appendLog({
      t: Date.now(),
      src: 'P4',
      msg: `camera restarted (session ${change.previous} → ${change.current}) — cached state dropped`,
    });
    clearSoundCache();
    resetDrafts();
    resetDeviceBusy();
  });
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

  // Capability negotiation. A NACK means firmware that predates the command
  // (legacy: deliberate everything-on fallback); a timeout — even after the
  // client's read retry — means the answer never arrived, and the gate stays
  // closed rather than granting the full surface to a device that never
  // answered (audit #58).
  let capabilities = null as Awaited<ReturnType<KinoDevice['getCapabilities']>> | null;
  let capabilitiesState: 'loaded' | 'legacy' | 'unknown' = 'loaded';
  try {
    capabilities = await device.getCapabilities();
  } catch (err) {
    if (err instanceof KinoUnsupportedError) capabilitiesState = 'legacy';
    else if (err instanceof KinoTimeoutError) capabilitiesState = 'unknown';
    else throw err;
  }

  // Milestone 1B firmware (issue #72) implements a narrow, honest surface:
  // power, config, recipes and calibration NACK UNSUPPORTED_COMMAND. Each
  // read degrades to "absent" on its own instead of failing the whole
  // connection — Studio must work against the firmware that exists, not
  // only against the finished demo device.
  const dev = device;
  const tolerate = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      if (err instanceof KinoUnsupportedError || err instanceof KinoTimeoutError) return null;
      throw err;
    }
  };

  const [cams, power, storage, envelope, recipes, calibration, stats] = await Promise.all([
    dev.getCameraInfo(),
    tolerate(() => dev.getPowerStatus()),
    dev.getStorageStatus(),
    tolerate(() => dev.getConfig()),
    tolerate(() => dev.getRecipes()),
    tolerate(() => dev.getCalibration()),
    tolerate(() => dev.getRuntimeStats()),
  ]);

  // Sounds arrived after V1 firmware — absence is a state, not an error.
  // Legacy firmware gets the probe (everything-on rule); an unanswered
  // capability query does not.
  let sounds = null as Awaited<ReturnType<KinoDevice['getSounds']>> | null;
  if (capabilitiesState === 'legacy' || capabilities?.capabilities.customSounds) {
    try {
      sounds = await device.getSounds();
    } catch (err) {
      if (!(err instanceof KinoUnsupportedError || err instanceof KinoTimeoutError)) throw err;
    }
  }

  if (envelope && envelope.schemaVersion !== undefined && envelope.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Camera config schema ${envelope.schemaVersion} is newer than this KINO Studio (${CONFIG_SCHEMA_VERSION}). Update Studio.`,
    );
  }

  setDeviceState({
    info,
    cameras: cams.cameras,
    power,
    storage,
    config: envelope?.config ?? null,
    configRevision: envelope?.configRevision ?? 0,
    capabilities: capabilities?.capabilities ?? null,
    capabilitiesState,
    limits: capabilities?.limits ?? null,
    firmwareLabel: capabilities?.firmware ?? info.p4Firmware,
    factoryRecipes: recipes?.factory ?? [],
    customRecipes: recipes?.custom ?? [],
    sounds: sounds?.custom ?? [],
    soundLimits: sounds ? { maxCustom: sounds.maxCustom, maxSoundKB: sounds.maxSoundKB } : null,
    calibration,
    stats,
  });
  recordCamera(info, lastKind !== 'serial');
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
    if (!device || pollInFlight) return;
    const phase = useConnectionStore.getState().phase;
    if (phase !== 'connected' && phase !== 'maintenance') return;
    pollInFlight = true;
    tick++;
    try {
      // Every third poll (~12 s), prove that the process behind a still-open
      // transport is the same boot we populated state from.
      if (tick % 3 === 0) await recheckSession();
      if (!device) return;
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
    } finally {
      pollInFlight = false;
    }
  }, 4000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollInFlight = false;
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
    // A live session whose link went away without anyone asking: the cable,
    // the port or the board. 02 §6 calls that a hardware error, not a plain
    // disconnect — the user did not do this.
    setConnection({ phase: 'error', fault: 'hardware', error: reason ?? 'KINO disconnected unexpectedly' });
  } else {
    setConnection({ phase: 'disconnected', fault: null });
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
  // The board was told to reboot and never answered again. That is the 02 §22
  // recovery situation, and 02 §6 gives it its own strip state rather than
  // filing it under ERROR with everything else.
  setConnection({
    phase: 'recovery',
    fault: null,
    error: 'KINO did not come back after reboot. Check the cable and reconnect.',
  });
}

export async function disconnect(): Promise<void> {
  expectRebootUntil = 0;
  await teardown(true);
  setConnection({ phase: 'disconnected', transportKind: null, error: null, fault: null });
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
    // So does its boot ID. Studio let go of that camera deliberately and has
    // just dropped everything the ID would have protected, so carrying it into
    // the next connection can only produce a false "camera restarted" — loudly
    // and wrongly, if the next thing plugged in is a different unit.
    lastSessionId = null;
    lastDeviceId = null;
  }
}

/**
 * Reconnect after a user-requested reboot (or factory reset). A refused
 * command (M1B firmware NACKs FACTORY_RESET) means no reboot is coming: the
 * armed window must be disarmed, or the next unrelated transport close is
 * misread as an expected reboot. The error propagates so the button that
 * asked can say what happened — a `void` call site swallowing it is how
 * "ERASE EVERYTHING" turned into silence (issue #80).
 */
export async function rebootAndReconnect(): Promise<void> {
  if (!device) return;
  expectDeviceReboot(30000);
  try {
    await device.reboot();
  } catch (err) {
    expectRebootUntil = 0;
    throw err;
  }
}

export async function factoryResetAndReconnect(): Promise<void> {
  if (!device) return;
  expectDeviceReboot(30000);
  try {
    await device.factoryReset();
  } catch (err) {
    expectRebootUntil = 0;
    throw err;
  }
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
