import { useMemo, useRef, useState } from 'react';
import { Assembly } from './scene/Assembly';
import { Wiring } from './scene/Wiring';
import { Optics } from './scene/Optics';
import { MeasureTool } from './scene/MeasureTool';
import { Effects } from './scene/Effects';
import { TwinCanvas, type TwinCanvasHandle } from './scene/TwinCanvas';
import { ViewportBar } from './panels/ViewportBar';
import { ComponentTree } from './panels/ComponentTree';
import { Inspector } from './panels/Inspector';
import { OpticsPanel } from './panels/OpticsPanel';
import { ClearancePanel } from './panels/ClearancePanel';
import { collisionReport, shellExclusions } from './collision/collide';
import { useSceneStore } from './state/sceneStore';
import { Header } from './panels/Header';
import { StatusBar } from './panels/StatusBar';
import { DisplayPanel } from './panels/DisplayPanel';
import { PinsPanel } from './panels/PinsPanel';
import { DisplayScreen } from './scene/DisplayScreen';
import { WelcomeOverlay } from './panels/WelcomeOverlay';
import { useSimStore } from './state/simStore';
import { FaultPanel } from './panels/FaultPanel';
import { PowerPanel } from './panels/PowerPanel';
import { SyncPanel } from './panels/SyncPanel';
import { FlashTimeline } from './panels/FlashTimeline';
import { MeasurePanel } from './panels/MeasurePanel';
import { RecorderPanel } from './panels/RecorderPanel';
import { StagePanel } from './panels/StagePanel';
import { FirmwarePanel } from './panels/FirmwarePanel';
import { RollPanel } from './panels/RollPanel';
import { Stage } from './scene/Stage';
import { SensorRig } from './scene/SensorRig';
import type { ViewPoseName } from './scene/viewPoses';

// KINO Twin app shell — §3 frame. The header identifies the app, the loaded
// hardware profile, sim state, and the Studio link; the center pane renders
// the assembly scene (Task 12) plus its viewport toolbar (Task 13); the left
// panel is the component tree and the right panel the inspector (Task 14).
// The status bar carries assembled-pose clearance and live simulation state;
// the right-side engineering tabs own inspection, fault, power, timing,
// measurement, recorder, and export workflows.

/** Live panels are empty until the simulator runs — say so once, in one place. */
function SimOffNotice() {
  const running = useSimStore((s) => s.running);
  if (running) return null;
  return <p className="twin-panel-note twin-simoff-note">Simulator is off. POWER ON in the header fills these panels with live data.</p>;
}

type RightTab = 'inspect' | 'stage' | 'firmware' | 'roll' | 'pins' | 'display' | 'faults' | 'power' | 'sync' | 'flash' | 'record';

/** Plain tab names with one blunt line each — the label a beginner reads,
 * the id the code keeps (persisted layouts and tests stay stable). */
const RIGHT_TABS: { id: RightTab; label: string; blurb: string }[] = [
  { id: 'inspect', label: 'PARTS', blurb: 'Every component: dimensions, clearances, measured overrides.' },
  { id: 'stage', label: 'STAGE', blurb: 'Place subjects and set lighting — what the virtual cameras photograph.' },
  { id: 'firmware', label: 'FIRMWARE', blurb: 'Which firmware generation this virtual D4 runs, per-target versions.' },
  { id: 'roll', label: 'ROLL', blurb: 'Send virtual captures to a real KINO Roll — development bridge for the future upload firmware.' },
  { id: 'pins', label: 'PINS', blurb: 'Header and camera-bus pin maps — provisional until the bench locks them.' },
  { id: 'display', label: 'SCREEN', blurb: "The camera's own display, live, plus the shutter." },
  { id: 'faults', label: 'FAULTS', blurb: 'Break things on purpose and watch the device cope.' },
  { id: 'power', label: 'POWER', blurb: 'Battery, rails, current draw, thermal state.' },
  { id: 'sync', label: 'TIMING', blurb: 'Sensor phase and skew — the numbers that decide the photo.' },
  { id: 'flash', label: 'FLASH', blurb: 'Flash pulse against the rolling-shutter readout.' },
  { id: 'record', label: 'SESSIONS', blurb: 'Record, replay and export simulation sessions.' },
];

export function App() {
  const canvasRef = useRef<TwinCanvasHandle>(null);
  const [rightTab, setRightTab] = useState<RightTab>('inspect');
  const profile = useSceneStore((state) => state.profile);
  const overrides = useSceneStore((state) => state.overrides);
  const pitchMm = useSceneStore((state) => state.pitchMm);
  const findings = useMemo(() => collisionReport(profile, overrides, pitchMm), [overrides, pitchMm, profile]);
  const shellSkipped = useMemo(() => shellExclusions(profile), [profile]);

  function handleView(name: ViewPoseName) {
    canvasRef.current?.applyView(name);
  }

  return (
    <div className="twin-app">
      <Header />

      <div className="twin-body">
        <aside className="twin-panel twin-panel--left" aria-label="Layers">
          <ComponentTree />
        </aside>
        <main className="twin-viewport" aria-label="3D viewport">
          <ViewportBar onView={handleView} />
          <div className="twin-viewport-canvas">
            <WelcomeOverlay />
            <TwinCanvas ref={canvasRef}>
              <Assembly />
              <Wiring />
              <Optics />
              <MeasureTool />
              <Effects />
              <DisplayScreen />
              <Stage />
              <SensorRig />
            </TwinCanvas>
          </div>
        </main>
        <aside className="twin-panel twin-panel--right" aria-label="Inspector">
          <nav className="twin-panel-tabs" aria-label="Engineering panels">
            {RIGHT_TABS.map((tab) => (
              <button
                type="button"
                key={tab.id}
                className={rightTab === tab.id ? 'twin-panel-tab twin-panel-tab--active' : 'twin-panel-tab'}
                aria-pressed={rightTab === tab.id}
                onClick={() => setRightTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <p className="twin-tab-blurb">{RIGHT_TABS.find((tab) => tab.id === rightTab)?.blurb}</p>
          <SimOffNotice />
          {rightTab === 'inspect' && <><OpticsPanel /><ClearancePanel findings={findings} notEvaluated={shellSkipped} /><MeasurePanel /><Inspector /></>}
          {rightTab === 'stage' && <StagePanel />}
          {rightTab === 'firmware' && <FirmwarePanel />}
          {rightTab === 'roll' && <RollPanel />}
          {rightTab === 'pins' && <PinsPanel />}
          {rightTab === 'display' && <DisplayPanel />}
          {rightTab === 'faults' && <FaultPanel />}
          {rightTab === 'power' && <PowerPanel />}
          {rightTab === 'sync' && <SyncPanel />}
          {rightTab === 'flash' && <FlashTimeline />}
          {rightTab === 'record' && <RecorderPanel findings={findings} onScreenshot={() => canvasRef.current?.screenshot() ?? Promise.reject(new Error('3D canvas is not ready'))} />}
        </aside>
      </div>

      <StatusBar findingsCount={findings.length} />
    </div>
  );
}
