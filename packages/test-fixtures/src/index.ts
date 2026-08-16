// @kino/test-fixtures — the KINO simulator: a device that speaks the framed
// protocol from the other end of the wire, hardened to the mock requirements
// of 04 §19. Studio's demo mode and the platform test suites drive the same
// object, so the behavior under test is the behavior shipped in the demo.

export { MockKinoDevice } from './MockKinoDevice';
export { MockMediaStore, renderPreviewFrame } from './MockMediaStore';
export { type TwinTelemetry, type TwinSnapshot } from './telemetry';

export {
  scenarios,
  SCENARIO_LIST,
  SPEC_SCENARIO_KEYS,
  DEFAULT_SCENARIOS,
  type ScenarioFlags,
  type ScenarioKey,
  type ScenarioDescriptor,
  type CamFault,
} from './scenarios';

export { FACTORY_RECIPES } from './factoryRecipes';
export {
  RECIPE_SCHEMA,
  validateDeviceRecipe,
  sampleRecipe,
  RECIPE_PARITY_CASES,
  type DeviceRecipe,
  type DeviceRecipeCapture,
  type DeviceRecipeLook,
  type DeviceRecipeAdvanced,
} from './recipes';

export { encodeWav, SOUND_SAMPLE_RATE } from './deviceAudio';
export { SYNC_BENCH } from './commands';
