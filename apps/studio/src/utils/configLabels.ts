// Human names and human values for config paths.
//
// The restore confirmation used to read `config.body.sleepS  60 → 120` for a
// control whose own options are labelled `1 MIN / 2 MIN / 5 MIN`. The one
// screen you read immediately before overwriting a camera should not be the
// only screen in the app speaking in key paths and bare seconds.

/** Last path segment → the label the control itself uses. */
const FIELD_LABELS: Record<string, string> = {
  // shoot
  flashMode: 'Flash policy',
  viewfinder: 'Body viewfinder',
  previewQuality: 'Preview quality',
  shutterSound: 'Shutter sound',
  volume: 'Volume',
  displayAfterShotS: 'Review after shot',
  // wiggle
  fps: 'Wiggle speed',
  loop: 'Loop',
  direction: 'Direction',
  resolution: 'Resolution',
  flash: 'Flash',
  recipeId: 'Look',
  previewCam: 'Viewfinder in wiggle',
  jpegQuality: 'JPEG quality',
  denoise: 'Denoise',
  sharpness: 'Sharpening',
  saveOriginals: 'Save originals',
  // quad slots
  exposureBias: 'Exposure bias',
  gain: 'Gain',
  colorMode: 'Colour',
  note: 'Note',
  // body
  brightness: 'Brightness',
  autoDimS: 'Auto-dim',
  sleepS: 'Sleep',
  camIdleTimeoutS: 'Cam bank idle off',
  startup: 'Startup sound',
  ui: 'UI sounds',
  save: 'Save-complete sound',
  warning: 'Warning sound',
  fn: 'Function button',
  slide: 'Slide switch',
  // top level
  mode: 'Mode',
};

/** Section prefix → how the section is named in the sidebar. */
const SECTION_LABELS: Record<string, string> = {
  shoot: 'Shoot',
  wiggle: 'Wiggle',
  quad: 'Quad',
  body: 'Device',
  sounds: 'Device',
  buttons: 'Device',
};

const SECOND_FIELDS = new Set(['sleepS', 'autoDimS', 'camIdleTimeoutS', 'displayAfterShotS']);
/** Fields where 0 means the timer never fires, not "zero seconds". */
const NEVER_FIELDS = new Set(['sleepS', 'autoDimS', 'camIdleTimeoutS']);

function humanize(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Matches the segmented control's own options exactly — `2 MIN`, not `120`
 * and not `2 min`. The diff is read against the control it describes.
 */
function duration(seconds: number, field: string): string {
  if (seconds < 0) return 'HOLD';
  if (seconds === 0) return NEVER_FIELDS.has(field) ? 'NEVER' : 'OFF';
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60} MIN`;
  return `${seconds} S`;
}

/**
 * Label for a flattened config path, with the camera named when the path is
 * per-slot: `quad.slots.cam3.gain` → "Quad · CAM 3 · Gain".
 */
export function configLabel(path: string): string {
  const parts = path.split('.').filter((p) => p !== 'config');
  const last = parts[parts.length - 1] ?? path;
  const field = FIELD_LABELS[last] ?? humanize(last);
  const cam = parts.find((p) => /^cam[1-4]$/.test(p));
  const section = SECTION_LABELS[parts[0]];
  return [section, cam ? `CAM ${cam.slice(-1)}` : null, field].filter(Boolean).join(' · ');
}

/** Value as the control that owns it would show it. */
export function configValue(path: string, raw: string): string {
  const last = path.split('.').pop() ?? path;
  if (raw === 'true') return 'ON';
  if (raw === 'false') return 'OFF';
  if (raw === '' || raw === 'undefined' || raw === 'null') return '—';
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (SECOND_FIELDS.has(last)) return duration(n, last);
    if (last === 'exposureBias') return `${n > 0 ? '+' : ''}${n.toFixed(1)} EV`;
    if (last === 'fps') return `${n} fps`;
    if (last === 'volume') return n === 0 ? 'MUTE' : String(n);
  }
  if (last === 'resolution') return raw.replace('x', '×');
  if (last === 'flashMode' || last === 'gain' || last === 'loop') return raw.toUpperCase();
  return raw;
}
