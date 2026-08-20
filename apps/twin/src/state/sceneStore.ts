import { create } from 'zustand';
import { D4_V1, NET_CLASSES } from '@kino/hardware-profiles';
import type { HardwareProfile, MeasuredOverride, NetClass } from '@kino/hardware-profiles';

/** §3 viewport modes: what the assembly currently renders as. */
export type ViewMode = 'normal' | 'xray' | 'internals' | 'enclosure' | 'wiring';

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
  select(id: string | null): void;
  setExplode(v: number): void;
  setPitch(mm: number): void;
  setViewMode(m: ViewMode): void;
  toggleVisible(id: string): void;
  toggleNetClass(cls: NetClass): void;
  setAllNetClasses(on: boolean): void;
  setNetFocus(id: string | null): void;
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
