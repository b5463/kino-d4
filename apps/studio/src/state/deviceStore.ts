import { create } from 'zustand';
import type {
  CalibrationData,
  Capabilities,
  DeviceLimits,
  CameraInfo,
  DeviceInfo,
  KinoConfig,
  PowerStatus,
  RuntimeStats,
  SoundInfo,
  StorageStatus,
} from '@kino/kdp';
import type { Recipe } from '../recipes/recipeTypes';

// Everything in this store is device-reported truth, refreshed by the
// session poller or by explicit commands. Unsaved form drafts live in page
// state, never here.
interface DeviceState {
  info: DeviceInfo | null;
  cameras: CameraInfo[];
  power: PowerStatus | null;
  storage: StorageStatus | null;
  config: KinoConfig | null;
  factoryRecipes: Recipe[];
  customRecipes: Recipe[];
  sounds: SoundInfo[];
  soundLimits: { maxCustom: number; maxSoundKB: number } | null;
  calibration: CalibrationData | null;
  stats: RuntimeStats | null;
  capabilities: Capabilities | null;
  limits: DeviceLimits | null;
  firmwareLabel: string | null;
  configRevision: number;
}

const initial: DeviceState = {
  info: null,
  cameras: [],
  power: null,
  storage: null,
  config: null,
  factoryRecipes: [],
  customRecipes: [],
  sounds: [],
  soundLimits: null,
  calibration: null,
  stats: null,
  capabilities: null,
  limits: null,
  firmwareLabel: null,
  configRevision: 0,
};

export const useDeviceStore = create<DeviceState>(() => initial);

export function setDeviceState(patch: Partial<DeviceState>) {
  useDeviceStore.setState(patch);
}

export function clearDeviceState() {
  useDeviceStore.setState(initial);
}

export function allRecipes(state: DeviceState): Recipe[] {
  return [...state.factoryRecipes, ...state.customRecipes];
}

export function recipeName(state: DeviceState, id: string): string {
  return allRecipes(state).find((r) => r.id === id)?.name ?? id;
}

/**
 * Capability gate. Unknown capabilities (firmware too old to advertise)
 * are treated as present so Studio still works against a device that
 * predates negotiation — the command itself then NACKs if truly missing.
 */
export function supports(state: DeviceState, name: keyof Capabilities): boolean {
  if (!state.capabilities) return true;
  const value = state.capabilities[name];
  return typeof value === 'boolean' ? value : true;
}
