import { useState } from 'react';
import { parseVersioned } from '@kino/schemas';
import { replaySession, simSessionDoc, verifyReplay } from '@kino/simulator-engine';
import type { SimSessionDoc } from '@kino/simulator-engine';
import type { CollisionFinding } from '../collision/collide';
import {
  exportBom,
  exportCollisionReport,
  exportDimensionReport,
  exportSceneLayout,
  exportWiringReport,
} from '../exports/exports';
import { exportEnvelopeStep, exportFrontPanelDxf, exportTransformsCsv } from '../exports/engineering';
import { downloadBlob, downloadText } from '../exports/download';
import { useSceneStore } from '../state/sceneStore';
import { applySimEvent, useSimStore } from '../state/simStore';

interface RecorderPanelProps {
  findings: CollisionFinding[];
  onScreenshot: () => Promise<Blob>;
}

export function RecorderPanel({ findings, onScreenshot }: RecorderPanelProps) {
  const running = useSimStore((state) => state.running);
  const recording = useSimStore((state) => state.recording);
  const startRecording = useSimStore((state) => state.startRecording);
  const stopRecording = useSimStore((state) => state.stopRecording);
  const [session, setSession] = useState<SimSessionDoc | null>(null);
  const [status, setStatus] = useState('NO SESSION');
  const [replaying, setReplaying] = useState(false);

  function record() {
    try {
      startRecording();
      setStatus('RECORDING');
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'RECORD FAILED');
    }
  }

  function stop() {
    const doc = stopRecording();
    if (!doc) return;
    setSession(doc);
    setStatus(`${doc.events.length} EVENTS SAVED`);
    downloadText('session.kino-sim.json', JSON.stringify(doc, null, 2));
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const doc = parseVersioned(simSessionDoc, JSON.parse(await file.text()));
      setSession(doc);
      setStatus(`${doc.events.length} EVENTS IMPORTED`);
    } catch {
      setStatus('INVALID KINO SIM SESSION');
    }
  }

  async function replay() {
    if (!session) return;
    setReplaying(true);
    setStatus('REPLAYING');
    const { sim, done } = replaySession(session, {
      onEvent: (event) => useSimStore.setState(applySimEvent(useSimStore.getState(), event)),
    });
    try {
      await done;
      setStatus('REPLAY COMPLETE');
    } finally {
      sim.dispose();
      setReplaying(false);
    }
  }

  async function verify() {
    if (!session) return;
    setStatus('VERIFYING');
    const result = await verifyReplay(session);
    setStatus(result.ok ? 'REPLAY OK' : `DIVERGED AT ${result.firstDivergenceAtMs ?? 0} MS`);
  }

  function scene() {
    const state = useSceneStore.getState();
    return { profile: state.profile, overrides: state.overrides, pitchMm: state.pitchMm, explode: state.explode };
  }

  return (
    <section className="twin-tool-panel">
      <div className="twin-panel-heading"><span>RECORDER + EXPORTS</span><span>{replaying ? 'REPLAYING' : status}</span></div>
      <div className="twin-tool-body">
        <div className="twin-export-grid">
          <button type="button" className="twin-btn twin-btn--active" onClick={record} disabled={!running || recording}>RECORD</button>
          <button type="button" className="twin-btn" onClick={stop} disabled={!recording}>STOP</button>
        </div>
        <label className="twin-field-label">IMPORT .KINO-SIM.JSON<input type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0])} /></label>
        <div className="twin-export-grid">
          <button type="button" className="twin-btn" disabled={!session || replaying} onClick={() => void replay()}>REPLAY 1×</button>
          <button type="button" className="twin-btn" disabled={!session || replaying} onClick={() => void verify()}>VERIFY</button>
          <button type="button" className="twin-btn" disabled={!session} onClick={() => session && downloadText('scenario.kino-sim.json', JSON.stringify(session, null, 2))}>SCENARIO</button>
        </div>
      </div>
      <div className="twin-tool-body">
        <strong>ENGINEERING EXPORTS</strong>
        <div className="twin-export-grid">
          <button type="button" className="twin-btn" onClick={() => downloadText('d4-layout.json', exportSceneLayout(scene()))}>LAYOUT JSON</button>
          <button type="button" className="twin-btn" onClick={() => { const s = scene(); downloadText('d4-bom.json', exportBom(s.profile, s.overrides)); }}>BOM</button>
          <button type="button" className="twin-btn" onClick={() => { const s = scene(); downloadText('d4-dimensions.txt', exportDimensionReport(s.profile, s.overrides)); }}>DIMENSIONS</button>
          <button type="button" className="twin-btn" onClick={() => downloadText('d4-collisions.txt', exportCollisionReport(findings))}>COLLISIONS</button>
          <button type="button" className="twin-btn" onClick={() => downloadText('d4-wiring.txt', exportWiringReport(scene().profile))}>WIRING</button>
          <button type="button" className="twin-btn" onClick={() => { const s = scene(); downloadText('d4-front-panel.dxf', exportFrontPanelDxf(s.profile, s.overrides, s.pitchMm)); }}>FRONT PANEL DXF</button>
          <button type="button" className="twin-btn" onClick={() => { const s = scene(); downloadText('d4-transforms.csv', exportTransformsCsv(s.profile, s.overrides, s.pitchMm)); }}>TRANSFORMS CSV</button>
          <button type="button" className="twin-btn" onClick={() => { const s = scene(); downloadText('d4-envelope.step', exportEnvelopeStep(s.profile, s.overrides)); }}>ENVELOPE STEP</button>
          <button type="button" className="twin-btn" onClick={() => void onScreenshot().then((blob) => downloadBlob('d4-twin.png', blob)).catch(() => setStatus('SCREENSHOT FAILED'))}>SCREENSHOT</button>
        </div>
      </div>
    </section>
  );
}
