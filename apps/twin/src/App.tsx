import { D4_V1 } from '@kino/hardware-profiles';

// KINO Twin app shell — §3 frame. The header identifies the app, the loaded
// hardware profile, sim state, and the Studio link; everything below it is
// an empty frame for later Phase C tasks (scene assembly, panels, the
// BroadcastChannel wiring in Task 18) to fill in. No live state here yet —
// this scaffold has nothing running to report.

const PROFILE_LABEL = D4_V1.name.replace(/^KINO\s+/, '');

export function App() {
  return (
    <div className="twin-app">
      <header className="twin-header">
        <span className="twin-header-item">KINO Twin</span>
        <span className="twin-header-sep">|</span>
        <span className="twin-header-item">{PROFILE_LABEL}</span>
        <span className="twin-header-sep">|</span>
        <span className="twin-header-item">
          <span className="twin-dot" aria-hidden="true" />
          SIM OFF
        </span>
        <span className="twin-header-sep">|</span>
        <span className="twin-header-item twin-header-item--last">
          Studio <span className="twin-dot" aria-hidden="true" /> —
        </span>
      </header>

      <div className="twin-body">
        <aside className="twin-panel twin-panel--left" aria-label="Layers" />
        <main className="twin-viewport" aria-label="3D viewport">
          NO SCENE LOADED
        </main>
        <aside className="twin-panel twin-panel--right" aria-label="Inspector" />
      </div>

      <footer className="twin-statusbar" role="region" aria-label="Twin status">
        <span className="twin-status-cell">—</span>
      </footer>
    </div>
  );
}
