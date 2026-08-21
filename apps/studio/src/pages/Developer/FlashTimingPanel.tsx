import { useState } from 'react';
import { CAM_IDS, flashBandRisk } from '@kino/kdp';
import type { CamId, TimingResult } from '@kino/kdp';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { getDevice } from '../../app/session';
import { downloadText } from '../../utils/download';

/**
 * Flash timing bench (audit #56). Fires a timing-test capture, takes the
 * measured per-camera VSYNC phases, and reports how much of each camera's
 * exposure window a flash pulse of the given delay/duration would light.
 * The exposure duration is a STATED bench input (default 1/60 s) until
 * firmware reports real sensor exposure — the verdict says which numbers
 * are measured and which are assumed.
 */
export function FlashTimingPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TimingResult | null>(null);
  const [delayMs, setDelayMs] = useState(0);
  const [durationMs, setDurationMs] = useState(1);
  const [exposureMs, setExposureMs] = useState(16.7);

  async function run() {
    const dev = getDevice();
    if (!dev) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await dev.timingTest());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const phases = result
    ? (Object.fromEntries(result.cams.map((cam) => [cam.cam, cam.vsyncPhaseUs])) as Record<CamId, number>)
    : null;
  const risk =
    result && phases
      ? flashBandRisk(phases, result.frameIntervalUs, exposureMs * 1_000, delayMs * 1_000, durationMs * 1_000)
      : null;

  function exportJson() {
    if (!result || !risk) return;
    downloadText(
      `flash-timing-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`,
      JSON.stringify(
        {
          kind: 'kino-flash-timing-bench',
          measured: { timing: result },
          assumed: { exposureMs, note: 'exposure duration is a bench input, not a firmware measurement' },
          flash: { delayMs, durationMs },
          coverage: risk,
        },
        null,
        2,
      ),
    );
  }

  return (
    <Panel
      title="FLASH TIMING"
      actions={
        <>
          <Button size="sm" busy={busy} onClick={() => void run()}>
            MEASURE
          </Button>
          <Button size="sm" disabled={!risk} onClick={exportJson}>
            EXPORT
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
        <label>
          DELAY {delayMs.toFixed(1)} ms{' '}
          <input type="range" min={0} max={40} step={0.1} value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))} />
        </label>
        <label>
          PULSE {durationMs.toFixed(1)} ms{' '}
          <input type="range" min={0.1} max={10} step={0.1} value={durationMs} onChange={(e) => setDurationMs(Number(e.target.value))} />
        </label>
        <label>
          EXPOSURE {exposureMs.toFixed(1)} ms (assumed){' '}
          <input type="range" min={1} max={33} step={0.1} value={exposureMs} onChange={(e) => setExposureMs(Number(e.target.value))} />
        </label>
      </div>

      {error ? <p className="warn">{error}</p> : null}
      {!result ? (
        <p className="dim">MEASURE fires one timing-test capture; coverage updates live as you move the sliders.</p>
      ) : risk ? (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>CAM</th>
                <th className="num">VSYNC PHASE (µs)</th>
                <th className="num">FLASH COVERAGE</th>
              </tr>
            </thead>
            <tbody>
              {CAM_IDS.map((cam) => (
                <tr key={cam}>
                  <td>{cam.toUpperCase()}</td>
                  <td className="num">{phases![cam]}</td>
                  <td className="num">{Math.round(risk.perCamCoverage[cam] * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={risk.banded ? 'warn' : 'dim'} style={{ marginTop: 6 }}>
            {risk.banded
              ? 'PARTIAL EXPOSURE — a band is likely on at least one camera at this timing.'
              : 'No banding risk at this timing: every window is evenly lit or evenly dark.'}
            {' '}Phases {result.vsyncMeasured ? 'MEASURED' : 'NOT MEASURED — grades are guesses'}; exposure duration ASSUMED.
          </p>
        </>
      ) : null}
    </Panel>
  );
}
