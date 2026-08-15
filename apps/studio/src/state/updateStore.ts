import { create } from 'zustand';
import type { TargetId } from '@kino/kdp';
import type { FwPackage } from '../firmware/manifest';
import type { CompatibilityCheck } from '../firmware/manifest';

// Transient firmware-update state. Per-target so a failed CAM3 never hides
// behind an overall spinner, and retry can resume exactly where it stopped.

export type TargetUpdateStatus =
  | 'waiting'
  | 'sending'
  | 'verifying'
  | 'applying'
  | 'rebooting'
  | 'checking'
  | 'updated'
  | 'failed'
  | 'not-started';

export interface TargetProgress {
  id: TargetId;
  label: string;
  status: TargetUpdateStatus;
  progress: number; // 0..1, transfer phase
  error: string | null;
}

interface UpdateState {
  pkg: FwPackage | null;
  pkgError: string | null;
  compat: CompatibilityCheck | null;
  running: boolean;
  /** Sequence halted on a failed target; retry or abort. */
  halted: boolean;
  finished: boolean;
  targets: TargetProgress[];
  fatalError: string | null;
}

export const TARGET_LABELS: Record<TargetId, string> = {
  p4: 'P4',
  cam1: 'CAM1',
  cam2: 'CAM2',
  cam3: 'CAM3',
  cam4: 'CAM4',
};

export function freshTargets(order: TargetId[]): TargetProgress[] {
  return order.map((id) => ({
    id,
    label: TARGET_LABELS[id],
    status: 'not-started',
    progress: 0,
    error: null,
  }));
}

const initial: UpdateState = {
  pkg: null,
  pkgError: null,
  compat: null,
  running: false,
  halted: false,
  finished: false,
  targets: [],
  fatalError: null,
};

export const useUpdateStore = create<UpdateState>(() => initial);

export function setUpdateState(patch: Partial<UpdateState>) {
  useUpdateStore.setState(patch);
}

export function resetUpdateState() {
  useUpdateStore.setState(initial);
}

export function patchTarget(id: TargetId, patch: Partial<TargetProgress>) {
  useUpdateStore.setState((s) => ({
    targets: s.targets.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  }));
}

export const TARGET_STATUS_LABEL: Record<TargetUpdateStatus, string> = {
  'waiting': 'WAITING',
  'sending': 'UPDATING',
  'verifying': 'VERIFYING',
  'applying': 'APPLYING',
  'rebooting': 'REBOOTING',
  'checking': 'HEALTH CHECK',
  'updated': 'UPDATED',
  'failed': 'FAILED',
  'not-started': 'NOT STARTED',
};
