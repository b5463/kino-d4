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
import type { NetworkStatus, RollView } from '../roll/rollTypes';

// Everything in this store is device-reported truth, refreshed by the
// session poller or by explicit commands. Unsaved form drafts live in page
// state, never here.
interface DeviceState {
  info: DeviceInfo | null;
  cameras: CameraInfo[];
  power: PowerStatus | null;
  storage: StorageStatus | null;
  /**
   * NETWORK_STATUS / ROLL_STATUS, polled on the slow tick beside power and
   * storage. Null means unanswered — not offline, and not "no Roll". A
   * connected camera with no Roll reports `{ active: false, roll: null }`;
   * only a NACK or a timeout leaves these null, and every reader has to
   * keep the two apart.
   */
  network: NetworkStatus | null;
  roll: RollView | null;
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
  network: null,
  roll: null,
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
 * What a KNOWN capability means when the device did not send it.
 *
 * `keyof Capabilities` exists only at compile time, so "known key" has to be
 * written down to be checkable at run time. Every entry here is `false`
 * because a loaded capability set is the device's answer: a flag it left out
 * is a no, which is what this gate's documentation has always claimed and
 * what the code did not do — it returned `true` for a missing key and put
 * live Network and Roll pages in front of a 0.2.0 body that NACKs both.
 *
 * `brightnessControl` is the single true-on-absent entry, and it is a
 * different question rather than an exception: firmware older than 0.4.9
 * never answered it (contract D11/D19), and greying the slider on a body that
 * never said it cannot dim would be inventing a limit. Only an explicit
 * `false` disables that control.
 *
 * `cameraCount` is deliberately absent — it is a count, not a gate, and no
 * caller asks `supports(state, 'cameraCount')`.
 */
const CAPABILITY_DEFAULTS: Partial<Record<keyof Capabilities, boolean>> = {
  wiggle: false,
  quad: false,
  gallery: false,
  flashControl: false,
  vsyncTelemetry: false,
  phaseCalibration: false,
  xiaoProxyUpdate: false,
  linkBench: false,
  customSounds: false,
  recipes: false,
  autofocus: false,
  focusLock: false,
  manualFocus: false,
  benchDiagnostics: false,
  network: false,
  roll: false,
  rollUpload: false,
  configStore: false,
  flashHardware: false,
  mediaIndex: false,
  powerManagement: false,
  powerTelemetry: false,
  radioFitted: false,
  radioRouted: false,
  brightnessControl: true,
};

/**
 * Capability gate, fail-closed (audit #58, #CN-3).
 *
 * - `loaded`: the device advertised its set. A boolean it sent is respected.
 *   A KNOWN key it omitted takes its `CAPABILITY_DEFAULTS` entry — `false`
 *   for all but `brightnessControl`. Absence is an answer, not an unknown.
 * - A key this build has never heard of stays `true`: a newer camera will
 *   report flags by names not in `Capabilities`, and 07§14 says an unknown
 *   field must be inert rather than fatal. It is not a gate, so it does not
 *   close one.
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
  // Read through `unknown`: a device may report a flag under a name
  // `Capabilities` has never declared, and the interface has no index
  // signature to admit one.
  const value = (state.capabilities as unknown as Record<string, unknown>)[name];
  if (typeof value === 'boolean') return value;
  // A non-boolean under a known name (a shape from a newer camera) is treated
  // the same as an absent one: the device did not answer this question.
  return CAPABILITY_DEFAULTS[name] ?? true;
}

/**
 * Roll upload gate (02 §27). `rollUpload` is a declared `Capabilities` flag
 * now, so this is `supports(state, 'rollUpload')` and nothing else — kept as a
 * named function only because the call sites read better for it. It used to
 * reach into the untyped reported object with its own copy of the three-state
 * rule, which is one gate with two implementations waiting to disagree.
 */
export function supportsRollUpload(state: DeviceState): boolean {
  return supports(state, 'rollUpload');
}
