// KINO Twin §13: a pure, deterministic timeline for one capture. TwinSimulator
// schedules the returned {atMs, event} pairs on real timers; this function
// itself touches no clock and no RNG, so the same snapshot + cams input
// always produces the same timeline (§21 replay).
import { CAM_IDS } from '@kino/kdp';
import type { CamId } from '@kino/kdp';
import type { TwinSnapshot } from '@kino/test-fixtures';
import type { SimEvent } from './events';

export interface TimelineEvent {
  atMs: number;
  event: SimEvent;
}

/** §20/§13: these faults take a camera off the bus entirely — it never arms. */
const NEVER_LEAVES_IDLE = new Set(['offline', 'power-open', 'sensor-missing']);

/** §13: every cam is ARMING at 0 and reaches WAIT_SYNC/the sync pulse at 40 ms. */
const SYNC_AT_MS = 40;

export function choreographCapture(
  snap: TwinSnapshot,
  cams: Partial<Record<CamId, { jpegKB: number; durationMs: number }>>,
): TimelineEvent[] {
  const timeline: TimelineEvent[] = [];
  const at = (atMs: number, event: SimEvent) => timeline.push({ atMs, event });

  // A cam with no report this round (down/timed out, same as the device's own
  // committed telemetry) or a bus-down fault never leaves IDLE.
  const active = CAM_IDS.filter((cam) => {
    const fault = snap.cams[cam].fault;
    return cams[cam] !== undefined && !(fault !== null && NEVER_LEAVES_IDLE.has(fault));
  });

  for (const cam of active) at(0, { t: 'cam-stage', cam, stage: 'ARMING' });
  for (const cam of active) at(SYNC_AT_MS, { t: 'cam-stage', cam, stage: 'WAIT_SYNC' });
  at(SYNC_AT_MS, { t: 'sync-pulse' });

  // Free-running VSYNC phase decides frame start — never one shared instant.
  const exposingAtMs = new Map<CamId, number>();
  for (const cam of active) {
    const atMs = SYNC_AT_MS + snap.cams[cam].phaseUs / 1000;
    exposingAtMs.set(cam, atMs);
    at(atMs, { t: 'cam-stage', cam, stage: 'EXPOSING' });
  }

  const jpegReadyAtMs = new Map<CamId, number>();
  for (const cam of active) {
    const durationMs = cams[cam]!.durationMs;
    const atMs = exposingAtMs.get(cam)! + durationMs;
    jpegReadyAtMs.set(cam, atMs);
    at(atMs, { t: 'cam-stage', cam, stage: 'JPEG_READY' });
  }

  // §13: all cams are captured before any transfer begins — every transfer
  // starts together at the slowest exposure, not one-by-one as JPEGs land.
  const transferAtMs = active.length > 0 ? Math.max(...active.map((cam) => jpegReadyAtMs.get(cam)!)) : 0;
  const bytesPerSec = snap.uartBaud / 10; // 10 bits/byte

  for (const cam of active) {
    const { jpegKB } = cams[cam]!;
    const slowUart = snap.cams[cam].fault === 'slow-uart' ? 8 : 1;
    const transferMs = ((jpegKB * 1024 * 10) / snap.uartBaud) * 1000 * slowUart;
    const storedAtMs = transferAtMs + transferMs;

    at(transferAtMs, { t: 'cam-stage', cam, stage: 'TRANSFERRING' });
    at(transferAtMs, { t: 'uart', cam, active: true, bytesPerSec });
    at(storedAtMs, { t: 'uart', cam, active: false, bytesPerSec });
    at(storedAtMs, { t: 'cam-stage', cam, stage: 'STORED' });
    at(storedAtMs, { t: 'cam-stage', cam, stage: 'READY' });
  }

  return timeline.sort((a, b) => a.atMs - b.atMs);
}
