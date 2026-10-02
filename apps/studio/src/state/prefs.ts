import { create } from 'zustand';

// Local UI preferences, persisted in the browser. Nothing here touches the
// camera; it is strictly how this computer shows KINO Studio.

export type Density = 'compact' | 'comfortable';

/** The inspector column: default, floor and ceiling, px. */
export const INSPECTOR_DEFAULT_W = 360;
export const INSPECTOR_MIN_W = 280;
export const INSPECTOR_MAX_W = 560;

interface Prefs {
  density: Density;
  developerMode: boolean;
  /** Width of the right-hand inspector column, px. */
  inspectorWidth: number;
  /** The inspector folded to its 28 px strip. */
  inspectorCollapsed: boolean;
  /** Which inspector sections are folded shut. Absent means open. */
  inspectorClosed: Record<string, boolean>;
}

const KEY = 'kino-studio-prefs';

function clampWidth(w: unknown): number {
  const n = typeof w === 'number' && Number.isFinite(w) ? w : INSPECTOR_DEFAULT_W;
  return Math.min(INSPECTOR_MAX_W, Math.max(INSPECTOR_MIN_W, Math.round(n)));
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      const closed: Record<string, boolean> = {};
      if (parsed.inspectorClosed && typeof parsed.inspectorClosed === 'object') {
        for (const [k, v] of Object.entries(parsed.inspectorClosed)) closed[k] = v === true;
      }
      return {
        density: parsed.density === 'comfortable' ? 'comfortable' : 'compact',
        developerMode: parsed.developerMode === true,
        inspectorWidth: clampWidth(parsed.inspectorWidth),
        inspectorCollapsed: parsed.inspectorCollapsed === true,
        inspectorClosed: closed,
      };
    }
  } catch {
    // Fresh profile.
  }
  return {
    density: 'compact',
    developerMode: false,
    inspectorWidth: INSPECTOR_DEFAULT_W,
    inspectorCollapsed: false,
    inspectorClosed: {},
  };
}

export const usePrefs = create<Prefs>(() => load());

function persist(state: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full/blocked — prefs just won't stick.
  }
}

export function setDensity(density: Density) {
  usePrefs.setState({ density });
  persist(usePrefs.getState());
  applyDensityClass(density);
}

export function setDeveloperMode(developerMode: boolean) {
  usePrefs.setState({ developerMode });
  persist(usePrefs.getState());
}

export function setInspectorWidth(width: number) {
  usePrefs.setState({ inspectorWidth: clampWidth(width) });
  persist(usePrefs.getState());
}

export function setInspectorCollapsed(inspectorCollapsed: boolean) {
  usePrefs.setState({ inspectorCollapsed });
  persist(usePrefs.getState());
}

export function setInspectorSectionOpen(id: string, open: boolean) {
  usePrefs.setState((s) => ({ inspectorClosed: { ...s.inspectorClosed, [id]: !open } }));
  persist(usePrefs.getState());
}

export function applyDensityClass(density: Density = usePrefs.getState().density) {
  document.documentElement.classList.toggle('density-comfortable', density === 'comfortable');
}
