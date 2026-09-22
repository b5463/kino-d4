// The virtual bench stage (issue #72): subjects placed in real 3D space in
// front of the KINO D4, plus stage lighting. Everything here is SIMULATION
// CONTROL — an engineer arranging the bench — never a device operation, so
// none of it travels over KDP.
import { create } from 'zustand';

export type SubjectKind =
  | 'person'
  | 'two-people'
  | 'group'
  | 'calibration-grid'
  | 'color-chart'
  | 'texture-target'
  | 'near-object'
  | 'party-table';

export const SUBJECT_KINDS: { kind: SubjectKind; label: string }[] = [
  { kind: 'person', label: 'PERSON' },
  { kind: 'two-people', label: 'TWO PEOPLE' },
  { kind: 'group', label: 'GROUP' },
  { kind: 'calibration-grid', label: 'CALIBRATION GRID' },
  { kind: 'color-chart', label: 'COLOR CHART' },
  { kind: 'texture-target', label: 'TEXTURE TARGET' },
  { kind: 'near-object', label: 'NEAR OBJECT' },
  { kind: 'party-table', label: 'PARTY TABLE' },
];

export interface StageSubject {
  id: string;
  kind: SubjectKind;
  /** Millimetres, scene axes: +Z is out of the lenses. */
  xMm: number;
  yMm: number;
  zMm: number;
  rotationDeg: number;
  scale: number;
}

/** The stage floor sits 1.2 m below the handheld camera — a person's feet
 * land here so their face ends up near lens height. */
export const STAGE_FLOOR_Y_MM = -1200;

export const DISTANCE_PRESETS_M = [0.8, 1.0, 1.5, 2.0, 3.0] as const;

export type LightingPresetId = 'daylight' | 'indoor' | 'dim-party' | 'very-dark' | 'backlit';

export interface LightingValues {
  /** Ambient intensity 0..2. */
  ambient: number;
  /** Ambient color temperature, Kelvin. */
  colorK: number;
  /** Key light intensity (front-left of subject). */
  key: number;
  /** Backlight intensity (behind subject, toward the camera). */
  back: number;
}

export const LIGHTING_PRESETS: Record<LightingPresetId, { label: string } & LightingValues> = {
  daylight: { label: 'DAYLIGHT', ambient: 1.1, colorK: 5600, key: 1.6, back: 0.3 },
  indoor: { label: 'INDOOR', ambient: 0.55, colorK: 3600, key: 0.9, back: 0.15 },
  'dim-party': { label: 'DIM PARTY', ambient: 0.18, colorK: 2900, key: 0.35, back: 0.3 },
  'very-dark': { label: 'VERY DARK', ambient: 0.05, colorK: 2500, key: 0.12, back: 0.05 },
  backlit: { label: 'BACKLIT', ambient: 0.25, colorK: 4500, key: 0.15, back: 1.8 },
};

/**
 * Approximate blackbody color for a lighting temperature. Good enough for a
 * bench mood control; clearly not colorimetry. Pure, node-testable.
 */
export function kelvinToHex(kelvin: number): string {
  const t = Math.min(12000, Math.max(1000, kelvin)) / 100;
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const r = t <= 66 ? 255 : clamp(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const g = t <= 66 ? clamp(99.4708025861 * Math.log(t) - 161.1195681661) : clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 255 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Where a fresh subject of this kind starts (mm). Charts face the lens at
 * lens height; people stand on the stage floor. */
export function subjectSpawn(kind: SubjectKind): { yMm: number; zMm: number } {
  switch (kind) {
    case 'calibration-grid':
    case 'color-chart':
    case 'texture-target':
      return { yMm: 10, zMm: 1000 };
    case 'near-object':
      return { yMm: 0, zMm: 300 };
    case 'party-table':
      return { yMm: STAGE_FLOOR_Y_MM, zMm: 1200 };
    default:
      return { yMm: STAGE_FLOOR_Y_MM, zMm: 1500 };
  }
}

export type LensFovDeg = 69 | 72 | 75;

interface StageState {
  subjects: StageSubject[];
  selectedId: string | null;
  lighting: LightingValues & { preset: LightingPresetId | null };
  room: boolean;
  /**
   * Horizontal lens FOV used by the virtual sensors. The real D4 lens is
   * MEASURE_REQUIRED (hardware profile); this is a stated bench scenario in
   * the 69–75° target band, and every render it produces is SIMULATED.
   */
  lensFovDeg: LensFovDeg;
  /**
   * The external light on the body's top stud (ECN-0003 dropped the built-in
   * flash). OFF: it lights nothing. FLASH: it fires for a capture the device
   * asks a flash for, as the built-in one did. CONSTANT: on for every
   * preview and capture - a video light, which is what is fitted.
   */
  topLight: TopLightMode;
}

export type TopLightMode = 'off' | 'flash' | 'constant';

let subjectCounter = 0;

function freshSubject(kind: SubjectKind): StageSubject {
  const spawn = subjectSpawn(kind);
  return { id: `subject_${++subjectCounter}`, kind, xMm: 0, yMm: spawn.yMm, zMm: spawn.zMm, rotationDeg: 0, scale: 1 };
}

function initialState(): StageState {
  return {
    subjects: [],
    selectedId: null,
    lighting: { preset: 'indoor', ...LIGHTING_PRESETS.indoor },
    room: false,
    lensFovDeg: 72,
    topLight: 'flash',
  };
}

/**
 * The Twin starts on the party scene, not on an empty stage.
 *
 * It started empty - no subjects, no room - and every camera on the body
 * photographed a void: the SHOOT screen showed four panes of pure black
 * under a lit 4/4, every capture was a black JPEG, and the only way out was
 * a button on the STAGE tab that a person reading the device screen never
 * sees. The brief's own words (§9) ask for one useful default. This is it;
 * CLEAR STAGE still empties the stage for anyone who wants the void.
 */
export const useStageStore = create<StageState>(() => ({ ...initialState(), ...partySceneState() }));

export function addSubject(kind: SubjectKind): string {
  const subject = freshSubject(kind);
  useStageStore.setState((s) => ({ subjects: [...s.subjects, subject], selectedId: subject.id }));
  return subject.id;
}

export function removeSubject(id: string): void {
  useStageStore.setState((s) => ({
    subjects: s.subjects.filter((x) => x.id !== id),
    selectedId: s.selectedId === id ? null : s.selectedId,
  }));
}

export function duplicateSubject(id: string): void {
  const source = useStageStore.getState().subjects.find((x) => x.id === id);
  if (!source) return;
  const copy: StageSubject = { ...source, id: `subject_${++subjectCounter}`, xMm: source.xMm + 300 };
  useStageStore.setState((s) => ({ subjects: [...s.subjects, copy], selectedId: copy.id }));
}

export function updateSubject(id: string, patch: Partial<Omit<StageSubject, 'id' | 'kind'>>): void {
  useStageStore.setState((s) => ({
    subjects: s.subjects.map((x) => (x.id === id ? { ...x, ...patch } : x)),
  }));
}

export function selectSubject(id: string | null): void {
  useStageStore.setState({ selectedId: id });
}

export function setLightingPreset(preset: LightingPresetId): void {
  useStageStore.setState({ lighting: { preset, ...LIGHTING_PRESETS[preset] } });
}

export function setLightingValue(patch: Partial<LightingValues>): void {
  useStageStore.setState((s) => ({ lighting: { ...s.lighting, ...patch, preset: null } }));
}

export function setRoom(room: boolean): void {
  useStageStore.setState({ room });
}

export function setTopLight(mode: TopLightMode): void {
  useStageStore.setState({ topLight: mode });
}

export function setLensFovDeg(deg: LensFovDeg): void {
  useStageStore.setState({ lensFovDeg: deg });
}

/** Brief §9: one useful default — person at 1.5 m, table with objects,
 * background depth, dim party light, room shell for bounce and backdrop. */
function partySceneState(): Pick<StageState, 'subjects' | 'selectedId' | 'room' | 'lighting'> {
  const person = freshSubject('person');
  const table = { ...freshSubject('party-table'), xMm: -700, zMm: 1200 };
  const backGroup = { ...freshSubject('two-people'), xMm: 600, zMm: 2600 };
  return {
    subjects: [person, table, backGroup],
    selectedId: person.id,
    room: true,
    lighting: { preset: 'dim-party', ...LIGHTING_PRESETS['dim-party'] },
  };
}

export function loadPartyScene(): void {
  useStageStore.setState(partySceneState());
}

export function resetStage(): void {
  useStageStore.setState(initialState());
}
