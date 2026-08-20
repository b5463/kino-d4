import { useMemo, useRef } from 'react';
import { D4_V1 } from '@kino/hardware-profiles';
import { Assembly } from './scene/Assembly';
import { Wiring } from './scene/Wiring';
import { Optics } from './scene/Optics';
import { MeasureTool } from './scene/MeasureTool';
import { TwinCanvas, type TwinCanvasHandle } from './scene/TwinCanvas';
import { ViewportBar } from './panels/ViewportBar';
import { ComponentTree } from './panels/ComponentTree';
import { Inspector } from './panels/Inspector';
import { OpticsPanel } from './panels/OpticsPanel';
import { ClearancePanel } from './panels/ClearancePanel';
import { collisionReport } from './collision/collide';
import { useSceneStore } from './state/sceneStore';
import type { ViewPoseName } from './scene/viewPoses';

// KINO Twin app shell — §3 frame. The header identifies the app, the loaded
// hardware profile, sim state, and the Studio link; the center pane renders
// the assembly scene (Task 12) plus its viewport toolbar (Task 13); the left
// panel is the component tree and the right panel the inspector (Task 14).
// The status bar carries Task 17's assembled-pose clearance count; Task 18
// will add live BroadcastChannel simulation state. No live sim state here
// yet — the Inspector's runtime block remains a static SIM OFF placeholder.

const PROFILE_LABEL = D4_V1.name.replace(/^KINO\s+/, '');

export function App() {
  const canvasRef = useRef<TwinCanvasHandle>(null);
  const profile = useSceneStore((state) => state.profile);
  const overrides = useSceneStore((state) => state.overrides);
  const pitchMm = useSceneStore((state) => state.pitchMm);
  const findings = useMemo(() => collisionReport(profile, overrides, pitchMm), [overrides, pitchMm, profile]);

  function handleView(name: ViewPoseName) {
    canvasRef.current?.applyView(name);
  }

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
        <aside className="twin-panel twin-panel--left" aria-label="Layers">
          <ComponentTree />
        </aside>
        <main className="twin-viewport" aria-label="3D viewport">
          <ViewportBar onView={handleView} />
          <div className="twin-viewport-canvas">
            <TwinCanvas ref={canvasRef}>
              <Assembly />
              <Wiring />
              <Optics />
              <MeasureTool />
            </TwinCanvas>
          </div>
        </main>
        <aside className="twin-panel twin-panel--right" aria-label="Inspector">
          <OpticsPanel />
          <ClearancePanel findings={findings} />
          <Inspector />
        </aside>
      </div>

      <footer className="twin-statusbar" role="region" aria-label="Twin status">
        <span className="twin-status-cell">{findings.length} CLEARANCE FINDINGS</span>
      </footer>
    </div>
  );
}
