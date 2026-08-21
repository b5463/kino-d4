import { useEffect, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import type { LedState } from '../../components/Led';
import { Icon } from '../../components/Icon';
import { useDeviceStore, recipeName } from '../../state/deviceStore';
import { SkewVerdict } from '../Calibration/SkewBench';
import { getDevice, onSelfTestEvent } from '../../app/session';
import { onUi } from '../../state/uiBus';
import type { CameraInfo, SelfTestEvent } from '@kino/kdp';
import { resolutionLabel, formatMB } from '../../utils/format';

function camLed(cam: CameraInfo): { state: LedState; label: string } {
  if (!cam.online) return { state: 'err', label: cam.state === 'rebooting' ? 'REBOOTING' : 'OFFLINE' };
  switch (cam.state) {
    case 'ready':
      return { state: 'ok', label: 'READY' };
    case 'timeout':
      return { state: 'warn', label: 'TIMEOUT' };
    case 'updating':
      return { state: 'busy', label: 'UPDATING' };
    case 'error':
      return { state: 'err', label: 'ERROR' };
    default:
      return { state: 'busy', label: cam.state.toUpperCase() };
  }
}

interface TestRow {
  name: string;
  status: 'running' | 'pass' | 'fail' | 'skip';
  detail: string;
}

export function OverviewPage() {
  const state = useDeviceStore();
  const [testRows, setTestRows] = useState<TestRow[] | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [camTestBusy, setCamTestBusy] = useState<string | null>(null);
  const [camTestResults, setCamTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    return onSelfTestEvent((e: SelfTestEvent) => {
      if (e.done) {
        setTestRunning(false);
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
    if (!dev || testRunning) return;
    setTestRows([]);
    setTestRunning(true);
    try {
      await dev.startSelfTest();
    } catch {
      setTestRunning(false);
    }
  };

  useEffect(() => onUi('self-test', () => void runSelfTest()), []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const { info, cameras, power, storage, config, capabilities } = state;
  if (!info) return null;

  const issues: string[] = [];
  for (const cam of cameras) {
    if (!cam.online) issues.push(`CAM ${cam.id.slice(-1)} ${cam.state === 'rebooting' ? 'REBOOTING' : 'OFFLINE'}`);
    else if (cam.state === 'timeout') issues.push(`CAM ${cam.id.slice(-1)} TIMEOUT`);
    else if (cam.state === 'error') issues.push(`CAM ${cam.id.slice(-1)} ERROR`);
  }
  if (storage && !storage.present) issues.push('NO SD CARD');
  if (power && power.batteryPct <= 15 && !power.charging) issues.push('LOW BATTERY');
  const severity = issues.some((i) => i.includes('OFFLINE') || i.includes('NO SD')) ? 'err' : issues.length > 0 ? 'warn' : 'ok';

  // Per-camera state belongs to the camera strip below, and the link lamp
  // belongs to the status bar — this panel is only what neither of them says.
  const supply: { name: string; state: LedState; label: string }[] = [
    storage?.present
      ? {
          name: 'SD CARD',
          state: 'ok' as LedState,
          label: `${formatMB(storage.freeMB)} FREE OF ${formatMB(storage.totalMB)}`,
        }
      : { name: 'SD CARD', state: 'err' as LedState, label: 'NO CARD' },
    power
      ? {
          name: 'BATTERY',
          state: (power.batteryPct <= 15 && !power.charging ? 'warn' : 'ok') as LedState,
          label: `${power.batteryPct}% · ${power.batteryV.toFixed(2)} V${
            power.charging ? ' · CHARGING' : power.state === 'usb' ? ' · USB POWER' : ''
          }`,
        }
      : { name: 'BATTERY', state: 'off' as LedState, label: '—' },
    // Device-reported only: firmware without a rail ADC omits busV and this
    // row says so instead of inventing 5.00 (audit #61).
    power && typeof power.busV === 'number'
      ? {
          name: '5V RAIL',
          state: (power.busV < 4.6 ? 'err' : power.busV < 4.9 ? 'warn' : 'ok') as LedState,
          label: `${power.busV.toFixed(2)} V${power.fuse === 'blown' ? ' · FUSE BLOWN' : ''}`,
        }
      : { name: '5V RAIL', state: 'off' as LedState, label: 'NOT REPORTED' },
    // Device-reported only: the capability says whether this firmware exposes
    // flash control. Nothing here measures the flash itself — RUN SELF TEST
    // does that — so this lamp never claims READY on its own.
    capabilities
      ? capabilities.flashControl
        ? { name: 'FLASH', state: 'ok' as LedState, label: 'CONTROL AVAILABLE' }
        : { name: 'FLASH', state: 'off' as LedState, label: 'NOT AVAILABLE' }
      : { name: 'FLASH', state: 'off' as LedState, label: '—' },
  ];

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="overview" />
          Overview
        </h1>
        <span className="microlabel">
          {info.product} {info.hardware} · {info.serial}
        </span>
      </div>

      <div className={`readybar readybar--${severity}`} role="status">
        <span className="readybar-state">
          <Led state={severity === 'ok' ? 'ok' : severity === 'warn' ? 'warn' : 'err'} label="" />
          {severity === 'ok' ? 'KINO IS READY' : 'NEEDS ATTENTION'}
        </span>
        <span className="readybar-issues">
          {severity === 'ok' ? 'NOTHING TO FIX' : issues.join(' · ')}
        </span>
      </div>

      <div className="panel-grid">
        <Panel title="NEXT SHOT">
          <dl>
            <div className="datarow"><dt>Mode</dt><dd>{info.activeMode.toUpperCase()}</dd></div>
            <div className="datarow"><dt>Look</dt><dd>{recipeName(state, info.activeRecipe).toUpperCase()}</dd></div>
            <div className="datarow"><dt>Resolution</dt><dd>{config ? resolutionLabel(config.wiggle.resolution) : '—'}</dd></div>
            <div className="datarow"><dt>Flash policy</dt><dd>{config ? config.shoot.flashMode.toUpperCase() : '—'}</dd></div>
            <div className="datarow"><dt>Wiggle speed</dt><dd>{config ? `${config.wiggle.fps} FPS` : '—'}</dd></div>
          </dl>
        </Panel>

        <Panel title="POWER & STORAGE">
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
        </Panel>

        {/* The one number on this page that says whether the four frames are
            a wigglegram or four separate photographs. It is measured on the
            Skew Bench, so it is quoted here with its metric and its age, and
            the tile opens the bench rather than repeating it. */}
        <Panel title="SENSOR SYNC">
          <SkewVerdict />
        </Panel>
      </div>

      <Panel title="CAMERAS · LEFT TO RIGHT">
        <div className="camstrip">
          {cameras.map((cam) => {
            const led = camLed(cam);
            return (
              <div key={cam.id} className="camcard">
                <div className="camcard-head">
                  <span className="camcard-name">CAM {cam.id.slice(-1)}</span>
                  <Led state={led.state} label={led.label} />
                </div>
                <dl>
                  <div className="datarow"><dt>Sensor</dt><dd>{cam.sensorDetected ? cam.sensor : '—'}</dd></div>
                  <div className="datarow"><dt>Firmware</dt><dd>{cam.online ? cam.firmware : '—'}</dd></div>
                  <div className="datarow"><dt>Response</dt><dd>{cam.online ? `${cam.latencyMs.toFixed(1)} ms` : '—'}</dd></div>
                  <div className="datarow">
                    <dt>Temp</dt>
                    <dd>
                      {cam.online && state.stats && state.stats.tempC.cams[Number(cam.id.slice(-1)) - 1] !== null
                        ? `${state.stats.tempC.cams[Number(cam.id.slice(-1)) - 1]!.toFixed(0)} °C`
                        : '—'}
                    </dd>
                  </div>
                  <div className="datarow"><dt>Last capture</dt><dd>{cam.lastCapture ? `${cam.lastCapture.ageS}s ago` : '—'}</dd></div>
                </dl>
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
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
      </Panel>

      <Panel
        title="SELF TEST"
        actions={
          <Button variant="primary" busy={testRunning} onClick={() => void runSelfTest()}>
            RUN SELF TEST
          </Button>
        }
      >
        {testRows === null ? (
          <p className="dim">Checks the P4, all four camera modules, storage, power and peripherals.</p>
        ) : (
          <div className="selftest-list">
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
      </Panel>
    </>
  );
}
