import { useState } from 'react';
import { CAM_IDS } from '@kino/kdp';
import { flashBandRisk } from '@kino/simulator-engine';
import { useSimStore } from '../state/simStore';

const SVG_W = 520;
const LANE_H = 46;
const LEFT = 58;
const PLOT_W = SVG_W - LEFT - 10;

export function FlashTimeline() {
  const snapshot = useSimStore((state) => state.snapshot);
  const [delayMs, setDelayMs] = useState(0);
  const [durationMs, setDurationMs] = useState(1);
  if (!snapshot) return <p className="twin-panel-empty">POWER ON for flash timing.</p>;

  const phases = Object.fromEntries(CAM_IDS.map((cam) => [cam, snapshot.cams[cam].phaseUs])) as Record<(typeof CAM_IDS)[number], number>;
  const readoutUs = snapshot.frameIntervalUs;
  const risk = flashBandRisk(phases, snapshot.frameIntervalUs, readoutUs, delayMs * 1_000, durationMs * 1_000);
  const x = (us: number) => LEFT + (us / snapshot.frameIntervalUs) * PLOT_W;

  return (
    <section className="twin-tool-panel" aria-label="Flash timeline">
      <div className="twin-panel-heading"><span>FLASH TIMELINE</span><span>SIMULATED</span></div>
      <div className="twin-panel-section">
        <label className="twin-slider-row"><span>DELAY {delayMs.toFixed(1)} ms</span><input type="range" min={0} max={40} step={0.1} value={delayMs} onChange={(event) => setDelayMs(Number(event.target.value))} /></label>
        <label className="twin-slider-row"><span>DURATION {durationMs.toFixed(1)} ms</span><input type="range" min={0.1} max={10} step={0.1} value={durationMs} onChange={(event) => setDurationMs(Number(event.target.value))} /></label>
      </div>
      <svg className="twin-flash-svg" viewBox={`0 0 ${SVG_W} ${LANE_H * CAM_IDS.length}`} role="img" aria-label="Per-camera rolling readout and flash pulse timeline">
        {CAM_IDS.map((cam, index) => {
          const y = index * LANE_H;
          const coverage = risk.perCamCoverage[cam];
          const banded = coverage > 0.05 && coverage < 0.95;
          return (
            <g key={cam}>
              <text x={2} y={y + 18}>{cam.toUpperCase()}</text>
              <line x1={LEFT} x2={SVG_W - 10} y1={y + 18} y2={y + 18} />
              <rect className="twin-readout-window" x={x(snapshot.cams[cam].phaseUs)} y={y + 8} width={PLOT_W} height={20} />
              <line className="twin-vsync-tick" x1={x(snapshot.cams[cam].phaseUs)} x2={x(snapshot.cams[cam].phaseUs)} y1={y + 3} y2={y + 33} />
              <rect className="twin-flash-pulse" x={x(delayMs * 1_000)} y={y + 12} width={Math.max(2, (durationMs * 1_000 / snapshot.frameIntervalUs) * PLOT_W)} height={12} />
              <text className={banded ? 'twin-svg-risk' : 'twin-svg-ok'} x={LEFT} y={y + 42}>{banded ? 'PARTIAL EXPOSURE — BANDS LIKELY' : 'NO BANDING RISK'} · {(coverage * 100).toFixed(0)}%</text>
            </g>
          );
        })}
      </svg>
      <p className="twin-panel-note">READOUT {readoutUs} µs · ESTIMATED</p>
    </section>
  );
}
