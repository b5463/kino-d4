import { useSceneStore } from '../state/sceneStore';
import type { OpticsSubject } from '../state/sceneStore';
import { commonWidthMm, fovForCam, opticsDistancesM, pairOverlapPct } from '../optics/frustum';

const FOV_SCENARIOS_DEG = [60, 70, 75, 90, 120] as const;
const DISTANCES_M = [0.8, 1, 1.5, 2, 3] as const;

export function OpticsPanel() {
  const profile = useSceneStore((state) => state.profile);
  const pitchMm = useSceneStore((state) => state.pitchMm);
  const optics = useSceneStore((state) => state.optics);
  const setOpticsEnabled = useSceneStore((state) => state.setOpticsEnabled);
  const setFovScenario = useSceneStore((state) => state.setFovScenario);
  const toggleOpticsDistance = useSceneStore((state) => state.toggleOpticsDistance);
  const setCustomDistance = useSceneStore((state) => state.setCustomDistance);
  const setSubject = useSceneStore((state) => state.setSubject);
  const setSubjectSize = useSceneStore((state) => state.setSubjectSize);

  const fov = fovForCam(profile, optics.fovScenarioDeg);
  const distancesM = opticsDistancesM(optics.distancesM, optics.customM);

  return (
    <section className="twin-optics-panel" aria-label="Optics controls">
      <div className="twin-panel-heading">
        <span>OPTICS</span>
        <button
          type="button"
          className={optics.enabled ? 'twin-btn twin-btn--active' : 'twin-btn'}
          onClick={() => setOpticsEnabled(!optics.enabled)}
        >
          {optics.enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="twin-inspector-section">
        {'hDeg' in fov ? (
          <>
            <div className="twin-inspector-row">
              <span className="twin-inspector-label">FOV</span>
              <span>{fov.hDeg.toFixed(1)}° H · {fov.vDeg.toFixed(1)}° V</span>
            </div>
            <span className="twin-badge">{fov.source}</span>
          </>
        ) : (
          <div className="twin-optics-alert">FOV: MEASURE REQUIRED</div>
        )}
        <label className="twin-field-label" htmlFor="twin-fov-scenario">LENS FOV</label>
        <select
          id="twin-fov-scenario"
          className="twin-select"
          value={optics.fovScenarioDeg ?? ''}
          onChange={(event) => setFovScenario(event.target.value === '' ? null : Number(event.target.value))}
        >
          <option value="">PROFILE VALUE</option>
          {FOV_SCENARIOS_DEG.map((degrees) => (
            <option key={degrees} value={degrees}>{degrees}° — DESIGN SCENARIO</option>
          ))}
        </select>
      </div>

      <div className="twin-inspector-section">
        <div className="twin-field-label">DISTANCE PLANES</div>
        <div className="twin-inspector-chips">
          {DISTANCES_M.map((distanceM) => (
            <button
              key={distanceM}
              type="button"
              className={optics.distancesM.includes(distanceM) ? 'twin-btn twin-btn--active' : 'twin-btn'}
              onClick={() => toggleOpticsDistance(distanceM)}
            >
              {distanceM.toFixed(1)} m
            </button>
          ))}
        </div>
        <label className="twin-field-label" htmlFor="twin-custom-distance">CUSTOM m</label>
        <input
          id="twin-custom-distance"
          className="twin-numeric twin-numeric--wide"
          type="number"
          min={0.1}
          max={5}
          step={0.1}
          value={optics.customM ?? ''}
          onChange={(event) => setCustomDistance(event.target.value === '' ? null : Number(event.target.value))}
        />
      </div>

      <div className="twin-inspector-section">
        <label className="twin-field-label" htmlFor="twin-subject">SUBJECT PROXY</label>
        <select
          id="twin-subject"
          className="twin-select"
          value={optics.subject}
          onChange={(event) => setSubject(event.target.value as OpticsSubject)}
        >
          <option value="none">NONE</option>
          <option value="person">PERSON</option>
          <option value="group">THREE-PERSON GROUP</option>
        </select>
        {optics.subject !== 'none' ? (
          <div className="twin-dimension-grid">
            <label htmlFor="twin-subject-width">WIDTH mm</label>
            <input
              id="twin-subject-width"
              className="twin-numeric"
              type="number"
              min={1}
              step={10}
              value={optics.subjectWmm}
              onChange={(event) => setSubjectSize(Number(event.target.value), optics.subjectHmm)}
            />
            <label htmlFor="twin-subject-height">HEIGHT mm</label>
            <input
              id="twin-subject-height"
              className="twin-numeric"
              type="number"
              min={1}
              step={10}
              value={optics.subjectHmm}
              onChange={(event) => setSubjectSize(optics.subjectWmm, Number(event.target.value))}
            />
          </div>
        ) : null}
      </div>

      {'hDeg' in fov && distancesM.length > 0 ? (
        <div className="twin-inspector-section">
          <table className="twin-optics-table">
            <thead><tr><th>DIST</th><th>PAIR</th><th>COMMON</th></tr></thead>
            <tbody>
              {distancesM.map((distanceM) => (
                <tr key={distanceM}>
                  <td>{distanceM.toFixed(1)} m</td>
                  <td>{pairOverlapPct(pitchMm, fov.hDeg, distanceM * 1_000).toFixed(1)}%</td>
                  <td>{Math.round(commonWidthMm(pitchMm, fov.hDeg, distanceM * 1_000))} mm</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
