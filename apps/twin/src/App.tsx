import { D4_V1 } from '@kino/hardware-profiles';
import { Assembly } from './scene/Assembly';
import { TwinCanvas } from './scene/TwinCanvas';

// KINO Twin app shell — §3 frame. The header identifies the app, the loaded
// hardware profile, sim state, and the Studio link; the center pane now
// renders the assembly scene (Task 12). The left/right panels and status
// bar stay empty frames for later Phase C tasks (component tree/inspector,
// the BroadcastChannel wiring in Task 18) to fill in. No live sim state
// here yet — this app has nothing running to report.

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
          <TwinCanvas>
            <Assembly />
          </TwinCanvas>
        </main>
        <aside className="twin-panel twin-panel--right" aria-label="Inspector" />
      </div>

      <footer className="twin-statusbar" role="region" aria-label="Twin status">
        <span className="twin-status-cell">—</span>
      </footer>
    </div>
  );
}
