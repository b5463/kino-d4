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
  /**
   * How `capabilities` came to be what it is. `loaded` = the device answered
   * GET_CAPABILITIES; `legacy` = the firmware NACKed the command (predates
   * negotiation, deliberate fallback to everything-on); `unknown` = the query
   * timed out even after retry — grant nothing rather than everything.
   */
  capabilitiesState: 'loaded' | 'legacy' | 'unknown' | null;
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
  capabilitiesState: null,
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
 * Capability gate, fail-closed by default (audit #58).
 *
 * - `loaded`: the device advertised its set — a key it did not advertise is
 *   NOT supported. Absence is an answer, not an unknown.
 * - `legacy`: the firmware NACKed GET_CAPABILITIES entirely (predates
 *   negotiation). Everything-on is the deliberate, documented degradation;
 *   individual commands then NACK.
 * - `unknown`/null: the query timed out or nothing is connected. Granting the
 *   full surface to a device that never answered is how a flaky link
 *   impersonates a full-featured camera — gate closed.
 */
export function supports(state: DeviceState, name: keyof Capabilities): boolean {
  if (state.capabilitiesState === 'legacy') return true;
  if (!state.capabilities) return false;
  const value = state.capabilities[name];
  // A loaded set keeps the documented forward-compat rule: a flag the device
  // sent as boolean is respected; anything else (missing, or a shape from a
  // newer camera) is neither trusted nor fatal — it is not a gate.
  return typeof value === 'boolean' ? value : true;
}

/**
 * Roll upload gate (02 §27). `rollUpload` arrived with the Network/Roll
 * command group, after the typed `Capabilities` interface was settled, so
 * the flag is read off the object the device actually reported. Same
 * three-state rule as `supports`.
 */
export function supportsRollUpload(state: DeviceState): boolean {
  if (state.capabilitiesState === 'legacy') return true;
  if (!state.capabilities) return false;
  const flag = (state.capabilities as Record<string, unknown>).rollUpload;
  return typeof flag === 'boolean' ? flag : true;
}
