import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { useDeviceStore, recipeName, supports } from '../../state/deviceStore';
import type { DeviceState } from '../../state/deviceStore';
import { SkewVerdict } from '../Calibration/SkewBench';
import { getDevice, onSelfTestEvent } from '../../app/session';
import { onUi } from '../../state/uiBus';
import type { CameraInfo, SelfTestEvent } from '@kino/kdp';
import { resolutionLabel } from '../../utils/format';
import { camLed, supplyRows } from './healthRows';

// The Overview section, taken apart into the inspector's folding sections.
// Same stores, same selectors, same health rules (healthRows.ts); only the
// frame around them changed — they sit beside every page now instead of
// being a page of their own.

interface TestRow {
  name: string;
  status: 'running' | 'pass' | 'fail' | 'skip';
  detail: string;
}

/**
 * How long RUN SELF TEST may spin before Studio stops believing a `done`
 * event is coming. The firmware's run is a few seconds; a minute covers a slow
 * card check with room to spare, and after it the button comes back with the
 * reason instead of staying busy until the section is left.
 */
export const SELF_TEST_TIMEOUT_MS = 60_000;

/** The positions, left to right, in the operator's words. */
const CAM_POSITION = ['Left', 'Centre-left', 'Centre-right', 'Right'] as const;

/** The ready bar's verdict: what is wrong, and how badly. */
export function readiness(state: DeviceState): { issues: string[]; severity: 'ok' | 'warn' | 'err' } {
  const { cameras, storage, power } = state;
  const issues: string[] = [];
  for (const cam of cameras) {
    if (!cam.online) issues.push(`CAM ${cam.id.slice(-1)} ${cam.state === 'rebooting' ? 'REBOOTING' : 'OFFLINE'}`);
    else if (cam.state === 'timeout') issues.push(`CAM ${cam.id.slice(-1)} TIMEOUT`);
    else if (cam.state === 'error') issues.push(`CAM ${cam.id.slice(-1)} ERROR`);
  }
  if (storage && !storage.present) issues.push('NO SD CARD');
  // Only a measured charge can be low: a body with no gauge reports null, and
  // reading that as 0 put LOW BATTERY on the ready bar of every D4-V1.
  if (power && power.batteryPct !== null && power.batteryPct <= 15 && !power.charging) issues.push('LOW BATTERY');
  const severity = issues.some((i) => i.includes('OFFLINE') || i.includes('NO SD')) ? 'err' : issues.length > 0 ? 'warn' : 'ok';
  return { issues, severity };
}

function StatusSection() {
  const state = useDeviceStore();
  if (!state.info) return null;
  const { issues, severity } = readiness(state);
  return (
    <div className={`readybar readybar--${severity}`} role="status">
      <span className="readybar-state">
        <Led state={severity === 'ok' ? 'ok' : severity === 'warn' ? 'warn' : 'err'} label="" />
        {severity === 'ok' ? 'KINO IS READY' : 'NEEDS ATTENTION'}
      </span>
      {severity === 'ok' ? (
        <span className="readybar-issues">NOTHING TO FIX</span>
      ) : (
        <ul className="readybar-list">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NextShotSection() {
  const state = useDeviceStore();
  const { info, config } = state;
  if (!info) return null;
  return (
    <dl>
      <div className="datarow"><dt>Mode</dt><dd>{info.activeMode.toUpperCase()}</dd></div>
      <div className="datarow"><dt>Look</dt><dd>{recipeName(state, info.activeRecipe).toUpperCase()}</dd></div>
      <div className="datarow"><dt>Resolution</dt><dd>{config ? resolutionLabel(config.wiggle.resolution) : '—'}</dd></div>
      <div className="datarow"><dt>Flash policy</dt><dd>{config ? config.shoot.flashMode.toUpperCase() : '—'}</dd></div>
      <div className="datarow"><dt>Wiggle speed</dt><dd>{config ? `${config.wiggle.fps} FPS` : '—'}</dd></div>
    </dl>
  );
}

function CamerasSection() {
  const state = useDeviceStore();
  const [camTestBusy, setCamTestBusy] = useState<string | null>(null);
  const [camTestResults, setCamTestResults] = useState<Record<string, string>>({});

  const runCamTest = async (camId: CameraInfo['id']) => {
    const dev = getDevice();
    if (!dev || camTestBusy) return;
    setCamTestBusy(camId);
    setCamTestResults((r) => ({ ...r, [camId]: '' }));
    try {
      const result = await dev.cameraTest(camId);
      setCamTestResults((r) => ({ ...r, [camId]: `OK · ${result.jpegKB} KB in ${result.durationMs} ms` }));
    } catch (err) {
      setCamTestResults((r) => ({ ...r, [camId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setCamTestBusy(null);
    }
  };

  if (!state.info) return null;
  return (
    <div className="insp-cams">
      {state.cameras.map((cam, i) => {
        const led = camLed(cam);
        const n = Number(cam.id.slice(-1));
        const temp = cam.online && state.stats ? state.stats.tempC.cams[n - 1] : null;
        return (
          <div key={cam.id} className="insp-cam">
            <div className="insp-cam-head">
              <span className="insp-cam-pos">
                {CAM_POSITION[i] ?? `Camera ${n}`} <span className="insp-cam-id">CAM {n}</span>
              </span>
              <Led state={led.state} label={led.label} />
            </div>
            <dl>
              <div className="datarow"><dt>Sensor</dt><dd>{cam.sensorDetected ? cam.sensor : '—'}</dd></div>
              <div className="datarow"><dt>Firmware</dt><dd>{cam.online ? cam.firmware : '—'}</dd></div>
              <div className="datarow"><dt>Response</dt><dd>{cam.online ? `${cam.latencyMs.toFixed(1)} ms` : '—'}</dd></div>
              <div className="datarow"><dt>Temp</dt><dd>{temp !== null && temp !== undefined ? `${temp.toFixed(0)} °C` : '—'}</dd></div>
              <div className="datarow"><dt>Last capture</dt><dd>{cam.lastCapture ? `${cam.lastCapture.ageS}s ago` : '—'}</dd></div>
            </dl>
            <div className="insp-cam-test">
              <Button
                size="sm"
                busy={camTestBusy === cam.id}
                disabled={camTestBusy !== null || !cam.online}
                onClick={() => void runCamTest(cam.id)}
              >
                TEST
              </Button>
              {camTestResults[cam.id] ? (
                <span className={`microlabel${camTestResults[cam.id].startsWith('OK') ? '' : ' st-fail'}`}>
                  {camTestResults[cam.id]}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SupplySection() {
  const state = useDeviceStore();
  const { info, power, storage, capabilities, network, roll } = state;
  if (!info) return null;
  const supply = supplyRows({
    storage,
    power,
    capabilities,
    network,
    roll,
    hasNetwork: supports(state, 'network'),
    hasRoll: supports(state, 'roll'),
    hasFlashHardware: supports(state, 'flashHardware'),
  });
  return (
    <dl>
      {supply.map((row) => (
        <div key={row.name} className="datarow">
          <dt>{row.name}</dt>
          <dd>
            <Led state={row.state} label={row.label} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The one number that says whether the four frames are a wigglegram or four
 * separate photographs. Measured on the Skew Bench; quoted here with its
 * metric and its age, and the verdict opens the bench rather than repeating it.
 */
function SyncSection() {
  const info = useDeviceStore((s) => s.info);
  if (!info) return null;
  return <SkewVerdict />;
}

function SelfTestSection() {
  const serial = useDeviceStore((s) => s.info?.serial ?? null);
  const [testRows, setTestRows] = useState<TestRow[] | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  // The uiBus subscription below is registered once, so it must read the
  // *current* flag, not the one from the render that registered it. With the
  // state captured directly, the top bar's TEST saw `testRunning` false
  // forever and could start a second run over the first.
  const testRunningRef = useRef(false);
  testRunningRef.current = testRunning;

  useEffect(() => {
    return onSelfTestEvent((e: SelfTestEvent) => {
      if (e.done) {
        setTestRunning(false);
        setTestError(null);
        if (e.results) setTestRows(e.results.map((r) => ({ name: r.name, status: r.status, detail: r.detail })));
        return;
      }
      setTestRows((rows) => {
        const next = [...(rows ?? [])];
        const existing = next.findIndex((r) => r.name === e.name);
        const row: TestRow = { name: e.name, status: e.status, detail: e.detail ?? '' };
        if (existing >= 0) next[existing] = row;
        else next.push(row);
        return next;
      });
    });
  }, []);

  const runSelfTest = async () => {
    const dev = getDevice();
    if (!dev || testRunningRef.current) return;
    setTestRows([]);
    setTestError(null);
    setTestRunning(true);
    try {
      await dev.startSelfTest();
    } catch (err) {
      setTestRunning(false);
      setTestError(err instanceof Error ? err.message : String(err));
    }
  };
  const runSelfTestRef = useRef(runSelfTest);
  runSelfTestRef.current = runSelfTest;

  useEffect(() => onUi('self-test', () => void runSelfTestRef.current()), []);

  // Two exits a `done` event cannot provide. The session ends (the device
  // handle goes away, or another camera answers): the run belongs to a link
  // that no longer exists. And a safety timeout: a firmware that started the
  // test and never finished it must not leave the button busy for the rest of
  // the session.
  useEffect(() => {
    if (serial === null && testRunningRef.current) {
      setTestRunning(false);
      setTestError('KINO disconnected before the self test finished.');
    }
  }, [serial]);
  useEffect(() => {
    if (!testRunning) return;
    const timer = setTimeout(() => {
      setTestRunning(false);
      setTestError(
        `The self test did not finish within ${Math.round(SELF_TEST_TIMEOUT_MS / 1000)} s. The camera sent no result.`,
      );
    }, SELF_TEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [testRunning, serial]);

  if (serial === null) return null;
  return (
    <>
      <div className="insp-actions">
        <Button variant="primary" size="sm" busy={testRunning} onClick={() => void runSelfTest()}>
          RUN SELF TEST
        </Button>
      </div>
      {testError ? <p className="notice notice--err">{testError}</p> : null}
      {testRows === null ? (
        <p className="dim">Checks the P4, all four camera modules, storage, power and peripherals.</p>
      ) : (
        <div className="selftest-list selftest-list--narrow">
          {testRows.map((row) => (
            <div key={row.name} className="selftest-row">
              <span>{row.name}</span>
              <span className={`st-${row.status}`}>
                {row.status === 'running' ? 'RUN…' : row.status.toUpperCase()}
              </span>
              <span className="dim">{row.detail}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export interface InspectorSection {
  id: string;
  title: string;
  Component: ComponentType;
}

/** Top to bottom. The ids are what the inspector folds and scrolls by. */
export const INSPECTOR_SECTIONS: InspectorSection[] = [
  { id: 'status', title: 'STATUS', Component: StatusSection },
  { id: 'nextshot', title: 'NEXT SHOT', Component: NextShotSection },
  { id: 'cameras', title: 'CAMERAS', Component: CamerasSection },
  { id: 'supply', title: 'CARD & POWER', Component: SupplySection },
  { id: 'sync', title: 'SENSOR SYNC', Component: SyncSection },
  { id: 'selftest', title: 'SELF TEST', Component: SelfTestSection },
];
