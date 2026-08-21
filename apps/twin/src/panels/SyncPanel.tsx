import { CAM_IDS, gradeSkew, usColumn } from '@kino/kdp';
import type { GradeInfo } from '@kino/kdp';
import type { ProvenanceTag } from '@kino/hardware-profiles';
import type { TwinSnapshot } from '@kino/test-fixtures';
import { useSimStore } from '../state/simStore';

export function tagLabel(tag: ProvenanceTag): string {
  return tag;
}

export interface SyncRow {
  metric: string;
  spreadUs: number;
  grade: GradeInfo;
}

function spread(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

function availableCams(snapshot: TwinSnapshot) {
  return CAM_IDS.filter((cam) => {
    const fault = snapshot.cams[cam].fault;
    return fault !== 'offline' && fault !== 'power-open' && fault !== 'no-vsync';
  });
}

export function syncRows(snapshot: TwinSnapshot): SyncRow[] {
  const cams = availableCams(snapshot);
  const gpio = cams.map((cam) => snapshot.cams[cam].gpioSkewUs);
  const vsync = cams.map((cam) => snapshot.cams[cam].phaseUs);
  // Snapshot has no separate row-timing sample; the effective simulated
  // exposure proxy is the trigger distribution delay plus VSYNC phase.
  const exposure = cams.map((cam) => snapshot.cams[cam].phaseUs + snapshot.cams[cam].gpioSkewUs);
  return [
    { metric: 'GPIO DISTRIBUTION SKEW', spreadUs: spread(gpio), grade: gradeSkew(spread(gpio)) },
    { metric: 'VSYNC PHASE SKEW', spreadUs: spread(vsync), grade: gradeSkew(spread(vsync)) },
    { metric: 'EFFECTIVE EXPOSURE SKEW', spreadUs: spread(exposure), grade: gradeSkew(spread(exposure)) },
  ];
}

export function SyncPanel() {
  const snapshot = useSimStore((state) => state.snapshot);
  if (!snapshot) return <p className="twin-panel-empty">POWER ON for simulated timing.</p>;

  const rows = syncRows(snapshot);
  const spreadColumn = usColumn(rows.map((row) => row.spreadUs));
  const cams = availableCams(snapshot);

  return (
    <section className="twin-tool-panel" aria-label="Synchronization analysis">
      <div className="twin-panel-heading"><span>SYNC ANALYSIS</span><span>{tagLabel('SIMULATED')}</span></div>
      <div className="twin-panel-section">
        {rows.map((row) => (
          <div className="twin-sync-row" key={row.metric}>
            <span>{row.metric}</span>
            <strong>{spreadColumn.format(row.spreadUs)} {spreadColumn.unit}</strong>
            <span className={`twin-grade twin-grade--${row.grade.state}`}>{row.grade.label}</span>
          </div>
        ))}
      </div>
      <div className="twin-panel-section">
        <span className="twin-field-label">VSYNC PHASE · 33.3 MS FRAME</span>
        {cams.map((cam) => (
          <div className="twin-phase-row" key={cam}>
            <span>{cam.toUpperCase()}</span>
            <div className="twin-phase-track">
              <span style={{ width: `${Math.min(100, (snapshot.cams[cam].phaseUs / snapshot.frameIntervalUs) * 100)}%` }} />
            </div>
            <span>{(snapshot.cams[cam].phaseUs / 1_000).toFixed(2)} ms</span>
          </div>
        ))}
      </div>
      <p className="twin-panel-note">GPIO edge ≠ synchronized exposure.</p>
    </section>
  );
}
