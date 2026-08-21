import { useSimStore } from '../state/simStore';

interface StatusBarProps {
  findingsCount: number;
}

function fixed(value: number | undefined, digits: number): string {
  return value === undefined ? '—' : value.toFixed(digits);
}

export function StatusBar({ findingsCount }: StatusBarProps) {
  const power = useSimStore((state) => state.power);
  const snapshot = useSimStore((state) => state.snapshot);

  return (
    <footer className="twin-statusbar" role="region" aria-label="Twin status">
      <span className="twin-status-cell">BAT {fixed(power?.batteryV, 2)}V</span>
      <span className="twin-status-cell">5V {fixed(power?.busV, 2)}V</span>
      <span className="twin-status-cell">{fixed(power?.batteryA, 1)}A</span>
      <span className="twin-status-cell">SD {snapshot?.sdPresent ? 'OK' : '—'}</span>
      <span className="twin-status-cell">Roll {snapshot?.roll.joined ? 'LIVE' : '—'}</span>
      <span className="twin-status-cell">{snapshot?.uploads.pending ?? 0} PENDING</span>
      <span className="twin-status-cell">{findingsCount} FINDINGS</span>
    </footer>
  );
}
