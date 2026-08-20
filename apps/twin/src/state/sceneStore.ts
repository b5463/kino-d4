import { create } from 'zustand';
import { D4_V1, NET_CLASSES } from '@kino/hardware-profiles';
import type { HardwareProfile, MeasuredOverride, NetClass } from '@kino/hardware-profiles';

/** §3 viewport modes: what the assembly currently renders as. */
export type ViewMode = 'normal' | 'xray' | 'internals' | 'enclosure' | 'wiring';
export type OpticsSubject = 'none' | 'person' | 'group';

export interface OpticsState {
  enabled: boolean;
  fovScenarioDeg: number | null;
  distancesM: number[];
  customM: number | null;
  subject: OpticsSubject;
  subjectWmm: number;
  subjectHmm: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface SceneState {
  profile: HardwareProfile; // D4_V1
  overrides: MeasuredOverride[]; // Task 20 persists these
  selection: string | null; // instance id
  hovered: string | null; // instance id
  explode: number; // 0..1 (§8)
  pitchMm: number; // 20..24, default 22 (§5)
  visibility: Record<string, boolean>; // per instance; absent === visible
  viewMode: ViewMode;
  netClasses: Set<NetClass>; // §8 wiring-view class toggles; absent members are hidden
  netFocus: string | null; // §8 wiring-view instance filter; null = every instance's nets
  optics: OpticsState;
  select(id: string | null): void;
  setExplode(v: number): void;
  setPitch(mm: number): void;
  setViewMode(m: ViewMode): void;
  toggleVisible(id: string): void;
  toggleNetClass(cls: NetClass): void;
  setAllNetClasses(on: boolean): void;
  setNetFocus(id: string | null): void;
  setOpticsEnabled(enabled: boolean): void;
  setFovScenario(deg: number | null): void;
  toggleOpticsDistance(distanceM: number): void;
  setCustomDistance(distanceM: number | null): void;
  setSubject(subject: OpticsSubject): void;
  setSubjectSize(widthMm: number, heightMm: number): void;
}

export const useSceneStore = create<SceneState>((set) => ({
  profile: D4_V1,
  overrides: [],
  selection: null,
  hovered: null,
  explode: 0,
  pitchMm: D4_V1.cameraPitchMm,
  visibility: {},
  viewMode: 'normal',
  netClasses: new Set(NET_CLASSES),
  netFocus: null,
  optics: {
    enabled: false,
    fovScenarioDeg: null,
    distancesM: [1],
    customM: null,
    subject: 'none',
    subjectWmm: 450,
    subjectHmm: 1700,
  },

  select(id) {
    set({ selection: id });
  },
  setExplode(v) {
    set({ explode: clamp(v, 0, 1) });
  },
  setPitch(mm) {
    const [lo, hi] = D4_V1.cameraPitchRangeMm;
    set({ pitchMm: clamp(mm, lo, hi) });
  },
  setViewMode(m) {
    set({ viewMode: m });
  },
  toggleVisible(id) {
    set((s) => ({ visibility: { ...s.visibility, [id]: !(s.visibility[id] ?? true) } }));
  },
  toggleNetClass(cls) {
    set((s) => {
      const next = new Set(s.netClasses);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return { netClasses: next };
    });
  },
  setAllNetClasses(on) {
    set({ netClasses: on ? new Set(NET_CLASSES) : new Set() });
  },
  setNetFocus(id) {
    set({ netFocus: id });
  },
  setOpticsEnabled(enabled) {
    set((s) => ({ optics: { ...s.optics, enabled } }));
  },
  setFovScenario(deg) {
    const fovScenarioDeg = deg !== null && Number.isFinite(deg) && deg > 0 && deg < 180 ? deg : null;
    set((s) => ({ optics: { ...s.optics, fovScenarioDeg } }));
  },
  toggleOpticsDistance(distanceM) {
    if (!Number.isFinite(distanceM) || distanceM <= 0) return;
    set((s) => {
      const distancesM = s.optics.distancesM.includes(distanceM)
        ? s.optics.distancesM.filter((distance) => distance !== distanceM)
        : [...s.optics.distancesM, distanceM].sort((a, b) => a - b);
      return { optics: { ...s.optics, distancesM } };
    });
  },
  setCustomDistance(distanceM) {
    const customM = distanceM !== null && Number.isFinite(distanceM) && distanceM > 0 ? distanceM : null;
    set((s) => ({ optics: { ...s.optics, customM } }));
  },
  setSubject(subject) {
    set((s) => ({
      optics: {
        ...s.optics,
        subject,
        subjectWmm: subject === 'group' ? 1_600 : subject === 'person' ? 450 : s.optics.subjectWmm,
        subjectHmm: subject === 'none' ? s.optics.subjectHmm : 1_700,
      },
    }));
  },
  setSubjectSize(widthMm, heightMm) {
    set((s) => ({
      optics: {
        ...s.optics,
        subjectWmm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : s.optics.subjectWmm,
        subjectHmm: Number.isFinite(heightMm) && heightMm > 0 ? heightMm : s.optics.subjectHmm,
      },
    }));
  },
}));

/**
 * Hover is high-frequency pointer feedback, not a user action — it is
 * deliberately outside `SceneState`'s action surface (only `select`,
 * `setExplode`, `setPitch`, `setViewMode`, `toggleVisible` are load-bearing
 * for later tasks) and instead set directly from the scene's pointer
 * handlers, same "plain setter" pattern Studio's stores use.
 */
export function setHovered(id: string | null): void {
  useSceneStore.setState({ hovered: id });
}
