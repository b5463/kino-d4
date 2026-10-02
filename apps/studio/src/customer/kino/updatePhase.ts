// One bar and three sentences over the real per-target update store.

import type { ConnectionPhase } from '../../state/connectionStore';
import type { TargetProgress } from '../../state/updateStore';

export type UpdateStage = 'preparing' | 'updating' | 'restarting' | 'done' | 'stopped';

export interface UpdateView {
  stage: UpdateStage;
  sentence: string;
  /** 0..1, the mean of the targets' transfer, never faked. */
  progress: number;
}

export function updateView(input: { targets: TargetProgress[]; phase: ConnectionPhase; halted: boolean; finished: boolean; downloading: boolean }): UpdateView {
  const { targets, phase, halted, finished, downloading } = input;
  const progress =
    targets.length === 0 ? 0 : targets.reduce((sum, t) => sum + (t.status === 'updated' ? 1 : Math.min(t.progress, 0.95)), 0) / targets.length;
  if (finished) return { stage: 'done', sentence: 'KINO is ready.', progress: 1 };
  if (halted) return { stage: 'stopped', sentence: 'The update stopped partway.', progress };
  if (phase === 'reconnecting' || targets.some((t) => t.status === 'rebooting' || t.status === 'checking')) {
    return { stage: 'restarting', sentence: 'Restarting KINO.', progress: Math.max(progress, 0.95) };
  }
  if (downloading || targets.every((t) => t.status === 'waiting' || t.status === 'not-started')) {
    return { stage: 'preparing', sentence: 'Preparing KINO.', progress: 0 };
  }
  return { stage: 'updating', sentence: 'Updating KINO. Keep it plugged in.', progress };
}

/** The customer's notes for a release: the publisher's lines, or nothing. */
export function noteLines(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0);
}
