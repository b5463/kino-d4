import { useEffect, useMemo, useState } from 'react';
import type { MeasuredOverride } from '@kino/hardware-profiles';
import { useSceneStore } from '../state/sceneStore';

export interface ChecklistRow {
  label: string;
  componentId: string;
  done: boolean;
}

const CHECKLIST: ReadonlyArray<Omit<ChecklistRow, 'done'>> = [
  { label: 'Guition envelope + thickness', componentId: 'main-display' },
  { label: 'Connector protrusions', componentId: 'main-display' },
  { label: 'SW6106 carrier', componentId: 'power-module' },
  { label: 'BMS', componentId: 'bms' },
  { label: 'Battery pouch + folds', componentId: 'battery' },
  { label: 'Battery lead exit', componentId: 'battery' },
  { label: 'Perfboard', componentId: 'perfboard' },
  { label: 'LED driver', componentId: 'flash-led' },
  { label: 'Speaker thickness', componentId: 'speaker' },
  { label: 'OV3660 lens protrusion', componentId: 'camera-node' },
  { label: 'Camera ribbon clearance', componentId: 'camera-node' },
  { label: 'Final acrylic thickness', componentId: 'enclosure-shell' },
];

export function measurementChecklist(overrides: MeasuredOverride[]): ChecklistRow[] {
  const measured = new Set(overrides.map((override) => override.componentId));
  return CHECKLIST.map((row) => ({ ...row, done: measured.has(row.componentId) }));
}

function vec(value: string, length: 2 | 3): number[] | null {
  const parts = value.split(',').map((part) => Number(part.trim()));
  return parts.length === length && parts.every(Number.isFinite) ? parts : null;
}

function holesFromText(value: string): Array<[number, number]> | undefined {
  if (!value.trim()) return undefined;
  const rows = value.split(/\r?\n/).filter(Boolean).map((line) => vec(line, 2));
  return rows.every(Boolean) ? rows as Array<[number, number]> : undefined;
}

function protrusionsFromText(value: string): MeasuredOverride['protrusionsMm'] {
  if (!value.trim()) return undefined;
  const parsed = value.split(/\r?\n/).filter(Boolean).map((line) => {
    const [label, sizeText, offsetText] = line.split('|').map((part) => part.trim());
    const size = vec(sizeText ?? '', 3);
    const offset = vec(offsetText ?? '', 3);
    if (!label || !size || !offset || size.some((n) => n <= 0)) return null;
    return { label, sizeMm: size as [number, number, number], offsetMm: offset as [number, number, number] };
  });
  return parsed.every(Boolean) ? parsed as NonNullable<MeasuredOverride['protrusionsMm']> : undefined;
}

function holesText(value: MeasuredOverride | undefined): string {
  return value?.holesMm?.map((row) => row.join(', ')).join('\n') ?? '';
}

function protrusionsText(value: MeasuredOverride | undefined): string {
  return value?.protrusionsMm?.map((item) => `${item.label} | ${item.sizeMm.join(', ')} | ${item.offsetMm.join(', ')}`).join('\n') ?? '';
}

export function MeasurePanel() {
  const profile = useSceneStore((state) => state.profile);
  const overrides = useSceneStore((state) => state.overrides);
  const componentId = useSceneStore((state) => state.measureComponentId);
  const close = useSceneStore((state) => state.closeMeasureComponent);
  const upsert = useSceneStore((state) => state.upsertOverride);
  const remove = useSceneStore((state) => state.removeOverride);
  const existing = overrides.find((override) => override.componentId === componentId);
  const component = profile.components.find((candidate) => candidate.id === componentId);
  const [size, setSize] = useState('');
  const [holes, setHoles] = useState('');
  const [protrusions, setProtrusions] = useState('');
  const [wireExit, setWireExit] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setSize(existing?.sizeMm.join(', ') ?? '');
    setHoles(holesText(existing));
    setProtrusions(protrusionsText(existing));
    setWireExit(existing?.wireExitMm?.join(', ') ?? '');
    setError('');
  }, [componentId, existing]);

  const checklist = useMemo(() => measurementChecklist(overrides), [overrides]);

  function save() {
    if (!component) return;
    const parsedSize = vec(size, 3);
    const parsedHoles = holesFromText(holes);
    const parsedProtrusions = protrusionsFromText(protrusions);
    const parsedWire = wireExit.trim() ? vec(wireExit, 3) : null;
    if (!parsedSize || parsedSize.some((n) => n <= 0)) {
      setError('WIDTH, HEIGHT AND DEPTH MUST BE POSITIVE MM VALUES.');
      return;
    }
    if (holes.trim() && parsedHoles === undefined) {
      setError('HOLES MUST BE ONE X,Y PAIR PER LINE.');
      return;
    }
    if (protrusions.trim() && parsedProtrusions === undefined) {
      setError('PROTRUSIONS MUST USE LABEL | W,H,D | X,Y,Z.');
      return;
    }
    if (wireExit.trim() && !parsedWire) {
      setError('WIRE EXIT MUST BE X,Y,Z.');
      return;
    }
    upsert({
      componentId: component.id,
      sizeMm: parsedSize as [number, number, number],
      ...(parsedHoles ? { holesMm: parsedHoles } : {}),
      ...(parsedProtrusions ? { protrusionsMm: parsedProtrusions } : {}),
      ...(parsedWire ? { wireExitMm: parsedWire as [number, number, number] } : {}),
      measuredAt: new Date().toISOString(),
    });
    setError('');
  }

  return (
    <section className="twin-measure-panel">
      <div className="twin-panel-heading"><span>MEASURE ACTUAL PART</span>{component && <button type="button" className="twin-btn" onClick={close}>CLOSE</button>}</div>
      {component && (
        <div className="twin-tool-body">
          <strong>{component.name}</strong>
          <span className="twin-provenance">CANONICAL PROFILE REMAINS UNCHANGED</span>
          <label className="twin-field-label">WIDTH, HEIGHT, DEPTH MM<input className="twin-select" value={size} onChange={(event) => setSize(event.target.value)} placeholder="114.4, 66.8, 9" /></label>
          <label className="twin-field-label">HOLES MM — ONE X,Y PER LINE<textarea className="twin-select twin-measure-textarea" value={holes} onChange={(event) => setHoles(event.target.value)} /></label>
          <label className="twin-field-label">PROTRUSIONS — LABEL | W,H,D | X,Y,Z<textarea className="twin-select twin-measure-textarea" value={protrusions} onChange={(event) => setProtrusions(event.target.value)} /></label>
          <label className="twin-field-label">WIRE EXIT X,Y,Z<input className="twin-select" value={wireExit} onChange={(event) => setWireExit(event.target.value)} /></label>
          {error && <div className="twin-tool-warning twin-tool-warning--danger">{error}</div>}
          <div className="twin-measure-actions">
            <button type="button" className="twin-btn twin-btn--active" onClick={save}>SAVE MEASUREMENT</button>
            {existing && <button type="button" className="twin-btn twin-btn--danger" onClick={() => remove(component.id)}>CLEAR</button>}
          </div>
        </div>
      )}
      <div className="twin-tool-body">
        <strong>REQUIRED BEFORE ENCLOSURE LOCK</strong>
        <ul className="twin-checklist">
          {checklist.map((row) => <li key={row.label} className={row.done ? 'twin-checklist--done' : ''}><span>{row.done ? 'DONE' : 'OPEN'}</span>{row.label}</li>)}
        </ul>
      </div>
    </section>
  );
}
