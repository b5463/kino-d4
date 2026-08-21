import { useState } from 'react';
import { CAM_IDS } from '@kino/kdp';
import { flashBandRisk } from '@kino/simulator-engine';
import { useSimStore } from '../state/simStore';

// The panel is ~244 px wide; keeping the viewBox close to that renders the
// in-SVG cam labels near 1:1 instead of scaling them into illegibility.
const SVG_W = 250;
const LANE_H = 34;
const LEFT = 38;
const PLOT_W = SVG_W - LEFT - 6;

export function FlashTimeline() {
  const snapshot = useSimStore((state) => state.snapshot);
  const [delayMs, setDelayMs] = useState(0);
  const [durationMs, setDurationMs] = useState(1);
  if (!snapshot) return <p className="twin-panel-empty">POWER ON for flash timing.</p>;

  const phases = Object.fromEntries(CAM_IDS.map((cam) => [cam, snapshot.cams[cam].phaseUs])) as Record<(typeof CAM_IDS)[number], number>;
  // audit #56: each camera's own exposure window, not the whole frame — the
  // window a flash pulse must cover is the time the sensor integrates, and
  // it is SIMULATED until real sensor timing is measured.
  const exposures = Object.fromEntries(CAM_IDS.map((cam) => [cam, snapshot.cams[cam].exposureUs])) as Record<(typeof CAM_IDS)[number], number>;
  const frameUs = snapshot.frameIntervalUs;
  const risk = flashBandRisk(phases, frameUs, exposures, delayMs * 1_000, durationMs * 1_000);
  const x = (us: number) => LEFT + ((us % frameUs) / frameUs) * PLOT_W;

  return (
    <section className="twin-tool-panel" aria-label="Flash timeline">
      <div className="twin-panel-heading"><span>FLASH TIMELINE</span><span>SIMULATED</span></div>
      <div className="twin-panel-section">
        <label className="twin-slider-row"><span>DELAY {delayMs.toFixed(1)} ms</span><input type="range" min={0} max={40} step={0.1} value={delayMs} onChange={(event) => setDelayMs(Number(event.target.value))} /></label>
        <label className="twin-slider-row"><span>DURATION {durationMs.toFixed(1)} ms</span><input type="range" min={0.1} max={10} step={0.1} value={durationMs} onChange={(event) => setDurationMs(Number(event.target.value))} /></label>
      </div>
      <div className="twin-panel-section">
        <svg className="twin-flash-svg" viewBox={`0 0 ${SVG_W} ${LANE_H * CAM_IDS.length}`} role="img" aria-label="Per-camera rolling readout and flash pulse timeline">
          {CAM_IDS.map((cam, index) => {
            const y = index * LANE_H;
            const phaseX = x(snapshot.cams[cam].phaseUs);
            // The exposure window is a wheel: it wraps at the end of the
            // frame interval. Draw the tail segment, then the wrapped head.
            const windowW = Math.min(PLOT_W, (exposures[cam] / frameUs) * PLOT_W);
            const tailW = Math.min(windowW, LEFT + PLOT_W - phaseX);
            const headW = windowW - tailW;
            return (
              <g key={cam}>
                <text x={2} y={y + 21}>{cam.toUpperCase()}</text>
                <line x1={LEFT} x2={LEFT + PLOT_W} y1={y + 17} y2={y + 17} />
                <rect className="twin-readout-window" x={phaseX} y={y + 8} width={tailW} height={18} />
                {headW > 0.5 && <rect className="twin-readout-window" x={LEFT} y={y + 8} width={headW} height={18} />}
                <line className="twin-vsync-tick" x1={phaseX} x2={phaseX} y1={y + 4} y2={y + 30} />
                <rect
                  className="twin-flash-pulse"
                  x={x(delayMs * 1_000)}
                  y={y + 12}
                  width={Math.max(2, Math.min(PLOT_W, ((durationMs * 1_000) / frameUs) * PLOT_W))}
                  height={10}
                />
              </g>
            );
          })}
        </svg>
        <ul className="twin-flash-risklist">
          {CAM_IDS.map((cam) => {
            const coverage = risk.perCamCoverage[cam];
            const banded = coverage > 0.05 && coverage < 0.95;
            return (
              <li key={cam} className={banded ? 'twin-flash-risk twin-flash-risk--banded' : 'twin-flash-risk'}>
                <span>{cam.toUpperCase()}</span>
                <span>{banded ? 'PARTIAL EXPOSURE — BANDS LIKELY' : 'NO BANDING RISK'}</span>
                <span>{(coverage * 100).toFixed(0)}%</span>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="twin-panel-note">
        EXPOSURE ~{Math.round(exposures.cam1 / 100) / 10} ms · SIMULATED · yellow = flash pulse, grey = exposure window, blue tick = VSYNC
      </p>
    </section>
  );
}
