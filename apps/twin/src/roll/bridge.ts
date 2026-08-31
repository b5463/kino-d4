import { create } from 'zustand';
import type { MockKinoDevice } from '@kino/test-fixtures';

// KINO Roll development bridge (issue #75).
//
// The physical Milestone 1 firmware has no Wi-Fi and no Roll upload; that is
// a later firmware milestone (ROLL_DEVICE_CONTRACT.md is its target). Until
// then this module stands in for the camera's upload task: it watches the
// virtual device commit captures to its SD store, then drives the SAME
// public device wire contract the future firmware will use — register,
// create/join Roll, capture document, asset init/part/complete, capture
// complete. Nothing here fakes device capability: the device keeps reporting
// rollUpload:false on the current-firmware profile, and everything this
// bridge shows is labelled a development bridge.

/** What the queue holds. A 'store' job re-reads bytes from the device media
 * store at upload time (SD stays the source of truth, retries included); an
 * 'inline' job carries the bytes itself (the Milestone-1 single-frame test
 * ingest, which never touches the SD). */
export interface UploadJob {
  captureUuid: string;
  mode: 'wiggle' | 'quad' | 'single';
  capturedAt: string;
  capId?: string;
  frames?: Uint8Array[];
  thumb?: Uint8Array | null;
  attempts: number;
}

interface RollAssociation {
  rollId: string;
  slug: string;
  /** Null when the server did not report one (older API on the join path). */
  guestUrl: string | null;
  hostUrl: string | null;
  title: string;
}

export interface RollBridgeState {
  serverUrl: string;
  deviceId: string | null;
  roll: RollAssociation | null;
  online: boolean;
  queued: number;
  uploading: boolean;
  failed: number;
  uploaded: number;
  lastError: string | null;
  busy: boolean;
}

const STORAGE_KEY = 'kino-twin-roll-bridge';
const MAX_BACKOFF_MS = 30_000;
/** A response the server will never accept differently — drop, don't retry. */
const DROP_STATUSES = new Set([400, 401, 403, 404, 422]);

interface Persisted {
  serverUrl?: string;
  serial?: string;
  deviceId?: string;
  deviceToken?: string;
  roll?: RollAssociation | null;
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : {};
  } catch {
    return {};
  }
}

function savePersisted(patch: Partial<Persisted>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPersisted(), ...patch }));
  } catch {
    // Private-mode storage failure only costs re-registration on reload.
  }
}

export const useRollBridge = create<RollBridgeState>(() => ({
  serverUrl: loadPersisted().serverUrl ?? '',
  deviceId: loadPersisted().deviceId ?? null,
  roll: loadPersisted().roll ?? null,
  online: true,
  queued: 0,
  uploading: false,
  failed: 0,
  uploaded: 0,
  lastError: null,
  busy: false,
}));

// ponytail: the queue lives in memory only — it exists to survive a Roll
// server outage, not a page reload. A reload also resets the simulated SD,
// so there is nothing left to upload anyway. The future firmware queue is
// SD-persistent; that requirement lives in ROLL_DEVICE_CONTRACT.md.
const queue: UploadJob[] = [];
let attachedDevice: MockKinoDevice | null = null;
let detachTelemetry: (() => void) | null = null;
let draining = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function publishQueue(patch: Partial<RollBridgeState> = {}): void {
  const failed = queue.length > 0 && queue[0].attempts > 0 ? 1 : 0;
  useRollBridge.setState({ queued: queue.length - failed, failed, ...patch });
}

/** Watch the virtual device: every committed capture with an associated Roll
 * is queued for upload. Called when the Twin runtime powers up. */
export function attachRollBridge(device: MockKinoDevice): void {
  detachRollBridge();
  attachedDevice = device;
  // The panel showed API REACHABLE from the optimistic initial state until
  // the first upload failed — prove it instead (issue #86).
  void fetch(`${useRollBridge.getState().serverUrl}/api/healthz`, { signal: AbortSignal.timeout(4000) })
    .then((res) => useRollBridge.setState({ online: res.ok }))
    .catch(() => useRollBridge.setState({ online: false }));
  detachTelemetry = device.onTelemetry((e) => {
    if (e.t !== 'capture' || e.phase !== 'committed' || !e.capId) return;
    if (!useRollBridge.getState().roll) return; // not on a Roll — capture stays on SD only
    queue.push({
      captureUuid: crypto.randomUUID(),
      mode: e.kind ?? 'wiggle',
      capturedAt: new Date().toISOString(),
      capId: e.capId,
      attempts: 0,
    });
    publishQueue();
    void drain();
  });
}

/** The sim powered off: its SD content is gone, so pending store-jobs are
 * unreadable and dropped. The shutter was never blocked by any of this. */
export function detachRollBridge(): void {
  detachTelemetry?.();
  detachTelemetry = null;
  attachedDevice = null;
  const dropped = queue.filter((job) => job.capId !== undefined).length;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].capId !== undefined) queue.splice(i, 1);
  publishQueue(dropped > 0 ? { lastError: `${dropped} queued capture(s) dropped — sim powered off before upload` } : {});
}

// ---- wire contract ------------------------------------------------------

class DropError extends Error {}

async function api<T>(path: string, init: RequestInit = {}, allowed: readonly number[] = [200]): Promise<T> {
  const base = useRollBridge.getState().serverUrl.replace(/\/$/, '');
  const response = await fetch(`${base}${path}`, init);
  if (!allowed.includes(response.status)) {
    let detail = '';
    try {
      const body = (await response.json()) as { code?: string; message?: string };
      detail = [body.code, body.message].filter(Boolean).join(': ');
    } catch {
      // non-JSON error body — the status alone tells the story
    }
    const message = `${init.method ?? 'GET'} ${path} → ${response.status}${detail ? ` (${detail})` : ''}`;
    throw DROP_STATUSES.has(response.status) ? new DropError(message) : new Error(message);
  }
  return (await response.json()) as T;
}

function json(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Register once, then reuse; the token never leaves localStorage. */
async function ensureRegistered(): Promise<{ deviceId: string; deviceToken: string }> {
  const persisted = loadPersisted();
  if (persisted.deviceId && persisted.deviceToken) {
    return { deviceId: persisted.deviceId, deviceToken: persisted.deviceToken };
  }
  const serial = persisted.serial ?? `KD4-TWIN-${crypto.randomUUID().slice(0, 12)}`;
  // Registration is gated (issue #146). The Twin bridge is a dev tool
  // speaking to a dev API, so it carries the published dev default from
  // apps/api/src/config.ts — a real deployment refuses that value, which is
  // the point: this bridge cannot mint credentials against production.
  const credential = await api<{ deviceId: string; deviceToken: string }>(
    '/api/studio/devices/register',
    json(
      'POST',
      { serial, product: 'KINO D4', hardwareRevision: 'v1', name: 'KINO Twin dev bridge' },
      'kino-dev-provisioning-token-do-not-use-in-production',
    ),
  );
  savePersisted({ serial, ...credential });
  useRollBridge.setState({ deviceId: credential.deviceId });
  return credential;
}

export function setServerUrl(url: string): void {
  savePersisted({ serverUrl: url });
  useRollBridge.setState({ serverUrl: url });
}

export async function createRoll(title: string): Promise<void> {
  useRollBridge.setState({ busy: true, lastError: null });
  try {
    const credential = await ensureRegistered();
    const created = await api<{ rollId: string; slug: string; guestUrl: string; hostUrl: string }>(
      '/api/device/rolls',
      json('POST', { title }, credential.deviceToken),
      [201],
    );
    const roll: RollAssociation = { ...created, title };
    savePersisted({ roll });
    useRollBridge.setState({ roll, online: true });
  } catch (error) {
    useRollBridge.setState({ lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    useRollBridge.setState({ busy: false });
  }
}

export async function joinRoll(slug: string): Promise<void> {
  useRollBridge.setState({ busy: true, lastError: null });
  try {
    const credential = await ensureRegistered();
    const joined = await api<{ rollId: string; title: string; guestUrl?: string }>(
      '/api/device/rolls/join',
      json('POST', { slug }, credential.deviceToken),
    );
    const upper = slug.toUpperCase();
    const roll: RollAssociation = {
      rollId: joined.rollId,
      slug: upper,
      // The server names the guest host; the Twin's own origin has no /r/
      // route, so a fabricated link and QR went nowhere (issue #86).
      guestUrl: joined.guestUrl ?? null,
      hostUrl: null,
      title: joined.title,
    };
    savePersisted({ roll });
    useRollBridge.setState({ roll, online: true });
  } catch (error) {
    useRollBridge.setState({ lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    useRollBridge.setState({ busy: false });
  }
}

export function leaveRoll(): void {
  queue.length = 0;
  savePersisted({ roll: null });
  publishQueue({ roll: null, lastError: null, uploaded: 0 });
}

/** Milestone-1 development ingest: one CAM1 frame rendered by the virtual
 * sensor, uploaded as a mode:'single' capture. No group capture, no fake
 * Wiggle — exactly what the current firmware could produce. */
export async function sendTestFrame(): Promise<void> {
  const device = attachedDevice;
  if (!device) throw new Error('Power on the Twin first — the virtual sensor renders only while the sim runs');
  if (!useRollBridge.getState().roll) throw new Error('Create or join a Roll first');
  const frame = await device.renderSourceFrame({ cam: 'cam1', kind: 'capture', width: 800, height: 600, phaseMs: 0 });
  if (!frame) throw new Error('CAM1 render failed — is the sim READY?');
  const thumb = await device.renderSourceFrame({ cam: 'cam1', kind: 'thumb', width: 200, height: 150, phaseMs: 0 });
  queue.push({
    captureUuid: crypto.randomUUID(),
    mode: 'single',
    capturedAt: new Date().toISOString(),
    frames: [frame],
    thumb,
    attempts: 0,
  });
  publishQueue();
  void drain();
}

/** Clear the backoff and try the queue again now. */
export function retryUploads(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  void drain();
}

/** Build the kino.capture document for one job. Exported for tests. */
export function captureDocumentFor(
  job: Pick<UploadJob, 'captureUuid' | 'mode' | 'capturedAt'>,
  deviceId: string,
  frameCount: number,
  firmwareProfile: string,
): Record<string, unknown> {
  return {
    schema: 'kino.capture',
    version: 1,
    id: `cap_twin_${job.captureUuid}`,
    captureUuid: job.captureUuid,
    deviceId,
    // A single stored frame is a single, whatever mode triggered it — Roll
    // must never show Wiggle controls for cameraCount 1.
    mode: frameCount === 1 ? 'single' : job.mode,
    capturedAt: job.capturedAt,
    frameCount,
    resolution: '800x600',
    status: 'created',
    visible: true,
    // .passthrough() keys land in the capture's provenance record.
    twin: { bridge: 'twin-dev-bridge', firmwareProfile },
  };
}

/** Retry backoff for the queue head. Exported for tests. */
export function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

async function uploadAsset(
  captureId: string,
  token: string,
  role: 'thumb' | 'original-frame',
  frameIndex: number | null,
  bytes: Uint8Array,
): Promise<void> {
  const upload = await api<{ uploadId: string; partSize: number; alreadyComplete: boolean }>(
    `/api/device/captures/${captureId}/assets/init`,
    json('POST', {
      role,
      ...(frameIndex === null ? {} : { frameIndex }),
      mime: 'image/jpeg',
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
    }, token),
  );
  if (upload.alreadyComplete) return; // idempotent replay — nothing to send
  let partNo = 1;
  for (let offset = 0; offset < bytes.length; offset += upload.partSize) {
    const part = bytes.slice(offset, Math.min(offset + upload.partSize, bytes.length));
    await api(`/api/device/uploads/${upload.uploadId}/parts/${partNo}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: part,
    });
    partNo += 1;
  }
  await api(`/api/device/uploads/${upload.uploadId}/complete`, json('POST', undefined, token));
}

async function uploadJob(job: UploadJob): Promise<void> {
  const state = useRollBridge.getState();
  const roll = state.roll;
  if (!roll) throw new DropError('no Roll association');
  const credential = await ensureRegistered();

  let frames: Uint8Array[];
  let thumb: Uint8Array | null;
  if (job.capId !== undefined) {
    const device = attachedDevice;
    if (!device) throw new DropError('sim powered off — stored capture unreadable');
    const assets = await device.readCaptureAssets(job.capId);
    if (!assets || assets.frames.length === 0) throw new DropError(`capture ${job.capId} not found on the SD store`);
    frames = assets.frames.map((f) => f.bytes);
    thumb = assets.thumb;
  } else {
    frames = job.frames ?? [];
    thumb = job.thumb ?? null;
  }
  if (frames.length === 0) throw new DropError('capture has no frames');

  const firmwareProfile = attachedDevice?.twinSnapshot().firmwareProfile ?? 'unknown';
  const doc = captureDocumentFor(job, credential.deviceId, frames.length, firmwareProfile);
  const created = await api<{ captureId: string }>(
    `/api/device/rolls/${roll.rollId}/captures`,
    json('POST', doc, credential.deviceToken),
    [200, 201], // 200 = idempotent replay of the same captureUuid
  );

  // Thumb first: it flips the capture to preview-ready, so guests see the
  // tile while the full frames are still travelling.
  if (thumb && thumb.length > 0) await uploadAsset(created.captureId, credential.deviceToken, 'thumb', null, thumb);
  for (let i = 0; i < frames.length; i++) {
    await uploadAsset(created.captureId, credential.deviceToken, 'original-frame', i + 1, frames[i]);
  }
  await api(`/api/device/captures/${created.captureId}/complete`, json('POST', undefined, credential.deviceToken));
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  useRollBridge.setState({ uploading: true });
  try {
    while (queue.length > 0) {
      const job = queue[0];
      try {
        await uploadJob(job);
        queue.shift();
        useRollBridge.setState({ uploaded: useRollBridge.getState().uploaded + 1, online: true, lastError: null });
        publishQueue();
      } catch (error) {
        if (error instanceof DropError) {
          queue.shift();
          publishQueue({ lastError: `capture dropped: ${error.message}` });
          continue;
        }
        // Network/server failure: keep the job (same captureUuid — the retry
        // is idempotent end to end) and back off. The shutter stays free.
        job.attempts += 1;
        publishQueue({ online: false, lastError: error instanceof Error ? error.message : String(error) });
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void drain();
        }, backoffMs(job.attempts));
        return;
      }
    }
  } finally {
    draining = false;
    useRollBridge.setState({ uploading: false });
  }
}

/** Test-only: reset module state between vitest cases. */
export function resetRollBridgeForTests(): void {
  queue.length = 0;
  draining = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  attachedDevice = null;
  detachTelemetry = null;
}
