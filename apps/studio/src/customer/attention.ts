// What needs attention, as plain sentences. There is no Problems page: the
// line above the page carries one sentence when something matters, and the
// list behind "See what" carries the rest. Each row answers what happened,
// whether KINO still shoots, and what to do. No severity words.

import type { CalibrationData, CameraInfo, RuntimeStats, StorageStatus } from '@kino/kdp';
import type { NetworkStatus, RollView } from '../roll/rollTypes';
import { LENS_POSITIONS } from './physical/fieldBody';
import { shotsLeft } from './copy';

export type AttentionTarget = 'photos' | 'wifi' | 'update' | 'match';

export interface AttentionRow {
  id: string;
  sentence: string;
  action: { label: string; target: AttentionTarget } | null;
}

export interface AttentionInput {
  storage: StorageStatus | null;
  cameras: CameraInfo[];
  calibration: CalibrationData | null;
  stats: RuntimeStats | null;
  network: NetworkStatus | null;
  roll: RollView | null;
  /** A newer compatible release, when the silent check found one. */
  updateVersion: string | null;
  /** The camera's own count of photographs left; below this the card is "getting full". */
  nearlyFullBelow?: number;
}

/** Warm inside, in the camera's own terms (docs/DEVICE_COPY.md: 78 C). */
const WARM_C = 75;

export function attentionRows(input: AttentionInput): AttentionRow[] {
  const rows: AttentionRow[] = [];
  const { storage, cameras, calibration, stats, network, roll } = input;
  const nearly = input.nearlyFullBelow ?? 50;

  if (storage && !storage.present) {
    rows.push({ id: 'no-card', sentence: "There's no card in KINO. Photos can't be saved.", action: null });
  } else {
    const left = shotsLeft(storage);
    if (left === 0) {
      rows.push({
        id: 'card-full',
        sentence: "The card is full. KINO can't save photos until you make room.",
        action: { label: 'Photos', target: 'photos' },
      });
    } else if (left !== null && left < nearly) {
      rows.push({
        id: 'card-nearly-full',
        sentence: `Your card is getting full. Room for about ${left} more photos.`,
        action: { label: 'Photos', target: 'photos' },
      });
    }
  }

  const down = cameras.filter((c) => !c.online || c.state === 'error' || c.state === 'timeout');
  if (down.length === 1) {
    const i = cameras.indexOf(down[0]!);
    const name = (LENS_POSITIONS[i] ?? 'left').toLowerCase();
    rows.push({ id: 'lens-down', sentence: `The ${name} lens isn't answering. KINO shoots with three.`, action: null });
  } else if (down.length > 1 && down.length < cameras.length) {
    rows.push({
      id: 'lenses-down',
      sentence: `${down.length === 2 ? 'Two' : 'Three'} lenses aren't answering. Photos will be missing frames.`,
      action: null,
    });
  } else if (cameras.length > 0 && down.length === cameras.length) {
    rows.push({ id: 'lenses-down', sentence: "None of the lenses are answering. Restart KINO.", action: null });
  }

  if (input.updateVersion) {
    rows.push({
      id: 'update',
      sentence: `KINO ${input.updateVersion} is ready.`,
      action: { label: 'Update', target: 'update' },
    });
  }

  if (calibration && calibration.capturedAt === null) {
    rows.push({ id: 'not-measured', sentence: 'The first photo you take will match the lenses.', action: null });
  }

  const p4 = stats?.tempC.p4 ?? null;
  if (p4 !== null && p4 >= WARM_C) {
    rows.push({
      id: 'warm',
      sentence: 'KINO is warm inside. The finder slows until it cools. Shooting still works.',
      action: null,
    });
  }

  const waiting = roll?.active && roll.roll ? roll.queue.pending + roll.queue.failed : 0;
  if (waiting > 0 && network && network.state !== 'connected') {
    rows.push({
      id: 'roll-wifi',
      sentence: `Roll uploads are waiting for Wi-Fi. ${waiting} ${waiting === 1 ? 'photo' : 'photos'}.`,
      action: { label: 'Set up Wi-Fi', target: 'wifi' },
    });
  }

  return rows;
}

/**
 * The top line. One row: the row itself, with its action word. More than
 * one: "KINO needs attention." with "See what". None: nothing.
 */
export function attentionLine(rows: AttentionRow[]): { sentence: string; action: string | null; single: AttentionRow | null } | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const row = rows[0]!;
    return { sentence: row.sentence, action: row.action?.label ?? null, single: row };
  }
  return { sentence: 'KINO needs attention.', action: 'See what', single: null };
}
