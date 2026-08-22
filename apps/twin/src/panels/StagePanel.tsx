// SIMULATION CONTROL (issue #72, brief §5): the engineer's side of the
// virtual bench — subjects, placement, lighting, lens scenario. None of this
// is a device operation and none of it travels over KDP; the device only
// ever sees the photons (renders) these controls produce.
import {
  useStageStore,
  addSubject,
  removeSubject,
  duplicateSubject,
  updateSubject,
  selectSubject,
  setLightingPreset,
  setLightingValue,
  setRoom,
  setLensFovDeg,
  loadPartyScene,
  SUBJECT_KINDS,
  LIGHTING_PRESETS,
  DISTANCE_PRESETS_M,
  type SubjectKind,
  type LightingPresetId,
  type LensFovDeg,
} from '../state/stageStore';
import { useState } from 'react';

const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 };
const num: React.CSSProperties = { width: 72 };

export function StagePanel() {
  const subjects = useStageStore((s) => s.subjects);
  const selectedId = useStageStore((s) => s.selectedId);
  const lighting = useStageStore((s) => s.lighting);
  const room = useStageStore((s) => s.room);
  const lensFovDeg = useStageStore((s) => s.lensFovDeg);
  const [kind, setKind] = useState<SubjectKind>('person');
  const selected = subjects.find((s) => s.id === selectedId) ?? null;

  return (
    <div>
      <p className="twin-panel-note">
        Stage controls are bench-side simulation, not camera commands. Subjects exist in real 3D space;
        the virtual sensors photograph them with true per-camera parallax.
      </p>

      <div style={row}>
        <select value={kind} onChange={(e) => setKind(e.target.value as SubjectKind)} aria-label="Subject kind">
          {SUBJECT_KINDS.map((s) => (
            <option key={s.kind} value={s.kind}>{s.label}</option>
          ))}
        </select>
        <button type="button" onClick={() => addSubject(kind)}>ADD SUBJECT</button>
        <button type="button" onClick={() => loadPartyScene()}>PARTY TEST SCENE</button>
        <label>
          <input type="checkbox" checked={room} onChange={(e) => setRoom(e.target.checked)} /> ROOM
        </label>
      </div>

      {subjects.length > 0 ? (
        <div style={row}>
          {subjects.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => selectSubject(s.id)}
              style={{ fontWeight: s.id === selectedId ? 700 : 400 }}
            >
              {SUBJECT_KINDS.find((k) => k.kind === s.kind)?.label ?? s.kind} · {(s.zMm / 1000).toFixed(1)}m
            </button>
          ))}
        </div>
      ) : (
        <p className="twin-panel-note">No subjects. The cameras are looking at an empty stage.</p>
      )}

      {selected ? (
        <>
          <div style={row}>
            <span>DISTANCE</span>
            {DISTANCE_PRESETS_M.map((m) => (
              <button type="button" key={m} onClick={() => updateSubject(selected.id, { zMm: m * 1000 })}>
                {m.toFixed(1)}m
              </button>
            ))}
          </div>
          <div style={row}>
            <label>X <input style={num} type="number" step={50} value={Math.round(selected.xMm)} onChange={(e) => updateSubject(selected.id, { xMm: Number(e.target.value) })} /> mm</label>
            <label>Y <input style={num} type="number" step={50} value={Math.round(selected.yMm)} onChange={(e) => updateSubject(selected.id, { yMm: Number(e.target.value) })} /> mm</label>
            <label>Z <input style={num} type="number" step={50} value={Math.round(selected.zMm)} onChange={(e) => updateSubject(selected.id, { zMm: Number(e.target.value) })} /> mm</label>
          </div>
          <div style={row}>
            <label>ROTATE <input type="range" min={-180} max={180} value={selected.rotationDeg} onChange={(e) => updateSubject(selected.id, { rotationDeg: Number(e.target.value) })} /> {selected.rotationDeg}°</label>
            <label>SCALE <input type="range" min={0.5} max={1.6} step={0.05} value={selected.scale} onChange={(e) => updateSubject(selected.id, { scale: Number(e.target.value) })} /> {selected.scale.toFixed(2)}×</label>
          </div>
          <div style={row}>
            <button type="button" onClick={() => duplicateSubject(selected.id)}>DUPLICATE</button>
            <button type="button" onClick={() => removeSubject(selected.id)}>DELETE</button>
          </div>
        </>
      ) : null}

      <div style={row}>
        <span>LIGHTING</span>
        {(Object.keys(LIGHTING_PRESETS) as LightingPresetId[]).map((preset) => (
          <button
            type="button"
            key={preset}
            onClick={() => setLightingPreset(preset)}
            style={{ fontWeight: lighting.preset === preset ? 700 : 400 }}
          >
            {LIGHTING_PRESETS[preset].label}
          </button>
        ))}
      </div>
      <div style={row}>
        <label>AMBIENT <input type="range" min={0} max={2} step={0.01} value={lighting.ambient} onChange={(e) => setLightingValue({ ambient: Number(e.target.value) })} /></label>
        <label>COLOR {lighting.colorK} K <input type="range" min={2200} max={6500} step={100} value={lighting.colorK} onChange={(e) => setLightingValue({ colorK: Number(e.target.value) })} /></label>
      </div>
      <div style={row}>
        <label>KEY <input type="range" min={0} max={2.5} step={0.01} value={lighting.key} onChange={(e) => setLightingValue({ key: Number(e.target.value) })} /></label>
        <label>BACKLIGHT <input type="range" min={0} max={2.5} step={0.01} value={lighting.back} onChange={(e) => setLightingValue({ back: Number(e.target.value) })} /></label>
      </div>

      <div style={row}>
        <span>LENS SCENARIO</span>
        {([69, 72, 75] as LensFovDeg[]).map((deg) => (
          <button type="button" key={deg} onClick={() => setLensFovDeg(deg)} style={{ fontWeight: lensFovDeg === deg ? 700 : 400 }}>
            {deg}°
          </button>
        ))}
        <span className="twin-panel-note" style={{ margin: 0 }}>
          Physical lens FOV is MEASURE REQUIRED — this is a stated scenario, every render is SIMULATED.
        </span>
      </div>
    </div>
  );
}
