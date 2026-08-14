import { create } from 'zustand';

// Local UI preferences, persisted in the browser. Nothing here touches the
// camera; it is strictly how this computer shows KINO Studio.

export type Density = 'compact' | 'comfortable';

interface Prefs {
  density: Density;
  developerMode: boolean;
}

const KEY = 'kino-studio-prefs';

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return {
        density: parsed.density === 'comfortable' ? 'comfortable' : 'compact',
        developerMode: parsed.developerMode === true,
      };
    }
  } catch {
    // Fresh profile.
  }
  return { density: 'compact', developerMode: false };
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

export function applyDensityClass(density: Density = usePrefs.getState().density) {
  document.documentElement.classList.toggle('density-comfortable', density === 'comfortable');
}
