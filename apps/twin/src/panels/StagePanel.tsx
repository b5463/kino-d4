// SIMULATION CONTROL (issue #72, brief §5): the engineer's side of the
// virtual bench — subjects, placement, lighting, lens scenario. None of this
// is a device operation and none of it travels over KDP; the device only
// ever sees the photons (renders) these controls produce.
import { useState } from 'react';
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
  resetStage,
  SUBJECT_KINDS,
  LIGHTING_PRESETS,
  DISTANCE_PRESETS_M,
  type SubjectKind,
  type LightingPresetId,
  type LensFovDeg,
} from '../state/stageStore';

export function StagePanel() {
  const subjects = useStageStore((s) => s.subjects);
  const selectedId = useStageStore((s) => s.selectedId);
  const lighting = useStageStore((s) => s.lighting);
  const room = useStageStore((s) => s.room);
  const lensFovDeg = useStageStore((s) => s.lensFovDeg);
  const [kind, setKind] = useState<SubjectKind>('person');
  const selected = subjects.find((s) => s.id === selectedId) ?? null;

  return (
    <section className="twin-tool-panel" aria-label="Stage">
      <div className="twin-panel-heading"><span>STAGE</span><span>SIM ONLY</span></div>
      <p className="twin-panel-note">
        Subjects exist in real 3D space in front of the lenses; the virtual sensors photograph them with
        true per-camera parallax. Bench-side controls — nothing here is a camera command.
      </p>

      <div className="twin-panel-section">
        <label className="twin-control-row">
          <span>SUBJECT</span>
          <select className="twin-select" value={kind} onChange={(e) => setKind(e.target.value as SubjectKind)}>
            {SUBJECT_KINDS.map((s) => (
              <option key={s.kind} value={s.kind}>{s.label}</option>
            ))}
          </select>
        </label>
        <div className="twin-button-grid">
          <button type="button" className="twin-btn twin-btn--primary" onClick={() => addSubject(kind)}>ADD SUBJECT</button>
          <button type="button" className="twin-btn" onClick={() => loadPartyScene()}>PARTY TEST SCENE</button>
          <button
            type="button"
            className="twin-btn twin-btn--fault"
            disabled={subjects.length === 0 && !room}
            title="Removes every subject and the room shell, resets lighting"
            onClick={() => resetStage()}
          >
            CLEAR STAGE
          </button>
        </div>
        <label className="twin-fault-row">
          <span>ROOM SHELL</span>
          <input type="checkbox" checked={room} onChange={(e) => setRoom(e.target.checked)} />
        </label>
        <p className="twin-panel-note">
          Frame the shot with VIEW → OPERATE in the viewport bar. A selected subject also deletes with the
          Delete key.
        </p>
      </div>

      <div className="twin-panel-section">
        <span className="twin-field-label">ON STAGE</span>
        {subjects.length === 0 ? (
          <p className="twin-panel-note">Empty stage — the cameras are photographing the room.</p>
        ) : (
          <div className="twin-button-grid">
            {subjects.map((s) => (
              <button
                type="button"
                key={s.id}
                className={s.id === selectedId ? 'twin-btn twin-btn--active' : 'twin-btn'}
                onClick={() => selectSubject(s.id)}
              >
                {SUBJECT_KINDS.find((k) => k.kind === s.kind)?.label ?? s.kind} · {(s.zMm / 1000).toFixed(1)}m
              </button>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <div className="twin-panel-section">
          <span className="twin-field-label">DISTANCE</span>
          <div className="twin-button-grid">
            {DISTANCE_PRESETS_M.map((m) => (
              <button
                type="button"
                key={m}
                className={Math.abs(selected.zMm - m * 1000) < 1 ? 'twin-btn twin-btn--active' : 'twin-btn'}
                onClick={() => updateSubject(selected.id, { zMm: m * 1000 })}
              >
                {m.toFixed(1)}m
              </button>
            ))}
          </div>
          <label className="twin-control-row">
            <span>X mm</span>
            <input className="twin-numeric" type="number" step={50} value={Math.round(selected.xMm)} onChange={(e) => updateSubject(selected.id, { xMm: Number(e.target.value) })} />
          </label>
          <label className="twin-control-row">
            <span>Y mm</span>
            <input className="twin-numeric" type="number" step={50} value={Math.round(selected.yMm)} onChange={(e) => updateSubject(selected.id, { yMm: Number(e.target.value) })} />
          </label>
          <label className="twin-control-row">
            <span>Z mm (distance)</span>
            <input className="twin-numeric" type="number" step={50} value={Math.round(selected.zMm)} onChange={(e) => updateSubject(selected.id, { zMm: Number(e.target.value) })} />
          </label>
          <label className="twin-slider-row">
            <span>ROTATE {selected.rotationDeg}°</span>
            <input type="range" min={-180} max={180} value={selected.rotationDeg} onChange={(e) => updateSubject(selected.id, { rotationDeg: Number(e.target.value) })} />
          </label>
          <label className="twin-slider-row">
            <span>SCALE {selected.scale.toFixed(2)}×</span>
            <input type="range" min={0.5} max={1.6} step={0.05} value={selected.scale} onChange={(e) => updateSubject(selected.id, { scale: Number(e.target.value) })} />
          </label>
          <div className="twin-button-grid">
            <button type="button" className="twin-btn" onClick={() => duplicateSubject(selected.id)}>DUPLICATE</button>
            <button type="button" className="twin-btn twin-btn--fault" onClick={() => removeSubject(selected.id)}>DELETE</button>
          </div>
        </div>
      ) : null}

      <div className="twin-panel-section">
        <span className="twin-field-label">LIGHTING</span>
        <div className="twin-button-grid">
          {(Object.keys(LIGHTING_PRESETS) as LightingPresetId[]).map((preset) => (
            <button
              type="button"
              key={preset}
              className={lighting.preset === preset ? 'twin-btn twin-btn--active' : 'twin-btn'}
              onClick={() => setLightingPreset(preset)}
            >
              {LIGHTING_PRESETS[preset].label}
            </button>
          ))}
        </div>
        <label className="twin-slider-row">
          <span>AMBIENT {lighting.ambient.toFixed(2)}</span>
          <input type="range" min={0} max={2} step={0.01} value={lighting.ambient} onChange={(e) => setLightingValue({ ambient: Number(e.target.value) })} />
        </label>
        <label className="twin-slider-row">
          <span>COLOR {lighting.colorK} K</span>
          <input type="range" min={2200} max={6500} step={100} value={lighting.colorK} onChange={(e) => setLightingValue({ colorK: Number(e.target.value) })} />
        </label>
        <label className="twin-slider-row">
          <span>KEY {lighting.key.toFixed(2)}</span>
          <input type="range" min={0} max={2.5} step={0.01} value={lighting.key} onChange={(e) => setLightingValue({ key: Number(e.target.value) })} />
        </label>
        <label className="twin-slider-row">
          <span>BACKLIGHT {lighting.back.toFixed(2)}</span>
          <input type="range" min={0} max={2.5} step={0.01} value={lighting.back} onChange={(e) => setLightingValue({ back: Number(e.target.value) })} />
        </label>
      </div>

      <div className="twin-panel-section">
        <span className="twin-field-label">LENS SCENARIO</span>
        <div className="twin-button-grid">
          {([69, 72, 75] as LensFovDeg[]).map((deg) => (
            <button
              type="button"
              key={deg}
              className={lensFovDeg === deg ? 'twin-btn twin-btn--active' : 'twin-btn'}
              onClick={() => setLensFovDeg(deg)}
            >
              {deg}°
            </button>
          ))}
        </div>
        <p className="twin-panel-note">
          Physical lens FOV is MEASURE REQUIRED — this is a stated scenario; every render is SIMULATED.
        </p>
      </div>
    </section>
  );
}
