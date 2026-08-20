import type { CollisionFinding } from '../collision/collide';

interface ClearancePanelProps {
  findings: CollisionFinding[];
}

function findingLabel(finding: CollisionFinding): string {
  switch (finding.kind) {
    case 'COLLISION':
      return `COLLISION ${finding.a} ↔ ${finding.b}`;
    case 'HARD_CLEARANCE_UNDER_0_5':
      return `HARD ${finding.a} ↔ ${finding.b}`;
    case 'CABLE_CLEARANCE_UNDER_1_0':
      return `CABLE ${finding.a} ↔ ${finding.b}`;
    case 'USB_ACCESS_BLOCKED':
      return `USB ACCESS ${finding.a} ↔ ${finding.b}`;
    case 'SD_EJECT_BLOCKED':
      return `SD EJECT ${finding.a} ↔ ${finding.b}`;
  }
}

function isCritical(finding: CollisionFinding): boolean {
  return finding.kind === 'COLLISION' || finding.kind === 'USB_ACCESS_BLOCKED' || finding.kind === 'SD_EJECT_BLOCKED';
}

export function ClearancePanel({ findings }: ClearancePanelProps) {
  return (
    <section className="twin-clearance-panel" aria-label="Clearance findings">
      <div className="twin-panel-heading">
        <span>CLEARANCE</span>
        <span>{findings.length}</span>
      </div>
      {findings.length === 0 ? (
        <p className="twin-clearance-empty">No assembled-pose findings.</p>
      ) : (
        <ol className="twin-clearance-list">
          {findings.map((finding, index) => (
            <li
              key={`${finding.kind}-${finding.a}-${finding.b}-${index}`}
              className={isCritical(finding) ? 'twin-clearance-row twin-clearance-row--critical' : 'twin-clearance-row'}
            >
              <span>{findingLabel(finding)}</span>
              <span>{finding.distanceMm.toFixed(2)} mm</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
