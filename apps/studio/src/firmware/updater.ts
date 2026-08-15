// Firmware update engine. Camera modules first (through the P4 gateway),
// P4 last. Every target runs begin → chunks → end → device-side verify →
// reboot → health check, and a target only counts as UPDATED once the
// device reports the expected version afterwards. A failure halts the
// sequence with per-target state intact so RETRY resumes precisely there.

import type { TargetId } from '@kino/kdp';
import type { FwPackage } from './manifest';
import { getDevice, expectDeviceReboot, waitForPhase, refreshDeviceInfo } from '../app/session';
import { setConnection, useConnectionStore } from '../state/connectionStore';
import {
  freshTargets,
  patchTarget,
  setUpdateState,
  useUpdateStore,
} from '../state/updateStore';

// Camera modules first, P4 last — change this list to change the order.
export const UPDATE_ORDER: TargetId[] = ['cam1', 'cam2', 'cam3', 'cam4', 'p4'];

const STATUS_POLL_MS = 500;
const CAM_APPLY_TIMEOUT_MS = 30000;

function fail(msg: string): never {
  throw new Error(msg);
}

async function updateOneTarget(pkg: FwPackage, id: TargetId): Promise<void> {
  const dev = getDevice() ?? fail('Not connected');
  const isP4 = id === 'p4';
  const image = isP4 ? pkg.p4Image : pkg.xiaoImage;
  const entry = isP4 ? pkg.manifest.p4 : pkg.manifest.xiao;

  patchTarget(id, { status: 'sending', progress: 0, error: null });
  const begin = await dev.fwBegin({
    target: id,
    size: image.length,
    sha256: entry.sha256,
    version: entry.version,
  });
  const chunkSize = Math.min(Math.max(begin.chunkSize || 4096, 1024), 8192);

  for (let offset = 0; offset < image.length; offset += chunkSize) {
    const data = image.subarray(offset, Math.min(offset + chunkSize, image.length));
    await dev.fwChunk(begin.sessionId, offset, data);
    patchTarget(id, { progress: (offset + data.length) / image.length });
  }

  const end = await dev.fwEnd();
  if (!end.ok || !end.verified) fail('Device rejected the image after transfer');

  if (isP4) {
    patchTarget(id, { status: 'rebooting', progress: 1 });
    expectDeviceReboot(45000);
    await waitForPhase('connected', 60000);
    patchTarget(id, { status: 'checking' });
    const fresh = getDevice() ?? fail('Reconnected but device handle is missing');
    const info = await fresh.getDeviceInfo();
    if (info.p4Firmware !== entry.version) {
      fail(`P4 rebooted but reports ${info.p4Firmware}, expected ${entry.version}`);
    }
    patchTarget(id, { status: 'updated' });
    return;
  }

  // Camera module: watch the device-side state machine until it lands.
  patchTarget(id, { status: 'verifying', progress: 1 });
  const deadline = Date.now() + CAM_APPLY_TIMEOUT_MS;
  let state = 'verifying';
  while (Date.now() < deadline) {
    await sleep(STATUS_POLL_MS);
    const status = await dev.fwStatus(id);
    state = status.state;
    if (state === 'error') fail(status.error ?? `${id.toUpperCase()} reported an update error`);
    if (state === 'ready') break;
    if (state === 'verifying') patchTarget(id, { status: 'verifying' });
    else if (state === 'applying') patchTarget(id, { status: 'applying' });
    else if (state === 'rebooting') patchTarget(id, { status: 'rebooting' });
  }
  if (state !== 'ready') fail(`${id.toUpperCase()} did not finish applying within ${CAM_APPLY_TIMEOUT_MS / 1000}s`);

  patchTarget(id, { status: 'checking' });
  const cams = await dev.getCameraInfo();
  const cam = cams.cameras.find((c) => c.id === id);
  if (!cam || !cam.online) fail(`${id.toUpperCase()} did not come back online after the update`);
  if (cam.firmware !== entry.version) {
    fail(`${id.toUpperCase()} rebooted but reports ${cam.firmware}, expected ${entry.version}`);
  }
  patchTarget(id, { status: 'updated' });
}

async function runSequence(pkg: FwPackage, queue: TargetId[]): Promise<void> {
  setUpdateState({ running: true, halted: false, finished: false, fatalError: null });
  setConnection({ phase: 'updating' });

  const dev = getDevice();
  if (!dev) {
    setUpdateState({ running: false, fatalError: 'Not connected' });
    return;
  }
  try {
    await dev.enterMaintenance();
  } catch (err) {
    setUpdateState({ running: false, fatalError: `Could not enter maintenance mode: ${msg(err)}` });
    setConnection({ phase: 'connected' });
    return;
  }

  for (const id of queue) patchTarget(id, { status: 'waiting', error: null });

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    try {
      await updateOneTarget(pkg, id);
    } catch (err) {
      patchTarget(id, { status: 'failed', error: msg(err) });
      for (const rest of queue.slice(i + 1)) patchTarget(rest, { status: 'not-started' });
      setUpdateState({ running: false, halted: true });
      // Leave the device in maintenance mode — a retry continues from here.
      if (useConnectionStore.getState().phase === 'updating') {
        setConnection({ phase: 'maintenance' });
      }
      return;
    }
  }

  // Sequence complete. If the P4 was in the queue it just rebooted and
  // maintenance mode is already gone; otherwise leave it explicitly.
  const after = getDevice();
  if (after && !queue.includes('p4')) {
    try {
      await after.exitMaintenance();
    } catch {
      // Not fatal — the device drops maintenance on its own timer.
    }
  }
  setUpdateState({ running: false, halted: false, finished: true });
  setConnection({ phase: 'connected' });
  await refreshDeviceInfo().catch(() => undefined);
}

/** Start a full update of every target in UPDATE_ORDER. */
export async function startUpdate(pkg: FwPackage): Promise<void> {
  setUpdateState({ targets: freshTargets(UPDATE_ORDER), finished: false, fatalError: null });
  await runSequence(pkg, UPDATE_ORDER);
}

/** Retry a failed target, then continue with everything still pending. */
export async function retryTarget(id: TargetId): Promise<void> {
  const { pkg, targets } = useUpdateStore.getState();
  if (!pkg) return;
  const idx = UPDATE_ORDER.indexOf(id);
  const queue = UPDATE_ORDER.slice(idx).filter((t) => {
    const status = targets.find((x) => x.id === t)?.status;
    return status !== 'updated';
  });
  await runSequence(pkg, queue);
}

/** Abandon a halted update and return the camera to normal operation. */
export async function abortUpdate(): Promise<void> {
  const dev = getDevice();
  if (dev) {
    try {
      await dev.fwAbort();
    } catch {
      // No active session on device — fine.
    }
    try {
      await dev.exitMaintenance();
    } catch {
      // Device may already be out of maintenance.
    }
  }
  // Clear the halted run so UPDATE KINO is offered again for this package.
  setUpdateState({ running: false, halted: false, finished: false, targets: [] });
  setConnection({ phase: 'connected' });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
