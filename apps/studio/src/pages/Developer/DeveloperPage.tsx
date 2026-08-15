import { useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { Icon } from '../../components/Icon';
import { LogViewer } from './LogViewer';
import { ConformancePanel } from './ConformancePanel';
import { BurnInPanel } from './BurnInPanel';
import { TimingBench } from './TimingBench';
import type { TimingStats } from './TimingBench';
import { PhasePanel } from './PhasePanel';
import { LinkBenchPanel } from './LinkBenchPanel';
import { useDeviceStore } from '../../state/deviceStore';
import { useConnectionStore } from '../../state/connectionStore';
import { useLogStore } from '../../state/logStore';
import { formatRanAt, useBenchResult } from '../../state/benchResults';
import { getDevice } from '../../app/session';
import { Cmd, Evt, FrameFlags } from '@kino/kdp';
import { formatUs, usColumn } from '@kino/kdp';
import { formatMB, formatUptime, formatLogTime } from '../../utils/format';
import { downloadJson } from '../../utils/download';

function cmdName(type: number): string {
  return Cmd[type] ?? Evt[type] ?? `0x${type.toString(16)}`;
}

function flagText(flags: number): string {
  const parts: string[] = [];
  if (flags & FrameFlags.RESPONSE) parts.push('RSP');
  if (flags & FrameFlags.EVENT) parts.push('EVT');
  if (flags & FrameFlags.ERROR) parts.push('ERR');
  if (flags & FrameFlags.BINARY) parts.push('BIN');
  return parts.join('+') || 'CMD';
}

export function DeveloperPage() {
  const state = useDeviceStore();
  const { info, cameras, power, storage, stats } = state;
  const phase = useConnectionStore((s) => s.phase);
  const [traceVisible, setTraceVisible] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The matrix column is GPIO distribution. The number that decides the
  // photograph is measured next door, so print it next door's answer here
  // rather than let 286–439 µs stand as the verdict on a 21.76 ms capture.
  const timing = useBenchResult<TimingStats>('timing');

  if (!info) return null;

  // Both maintenance buttons used to be live at once, so one of the two was
  // always a guaranteed error. Reflect the real connection phase.
  const inMaintenance = phase === 'maintenance';

  // Skew is one column and gets one unit, chosen from the column's values.
  const skewCol = usColumn(
    cameras.map((c) => c.lastCapture?.gpioSkewUs).filter((v): v is number => typeof v === 'number'),
  );

  const exposureSpread =
    timing && timing.result.vsyncMeasured ? formatUs(timing.result.exposureSpread) : '—';
  const exposureSource = !timing
    ? 'TIMING BENCH NOT RUN'
    : !timing.result.vsyncMeasured
      ? 'NOT MEASURABLE WITHOUT VSYNC TELEMETRY'
      : `TIMING BENCH · RAN ${formatRanAt(timing.ranAt)}${timing.staleReason ? ` · STALE: ${timing.staleReason}` : ''}`;

  const client = getDevice()?.client;

  const service = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setNotice(null);
    try {
      await fn();
      setNotice(`${name} acknowledged by the device.`);
    } catch (err) {
      setNotice(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const downloadReport = () => {
    const report = {
      generated: new Date().toISOString(),
      generator: 'KINO Studio',
      device: info,
      cameras,
      power,
      storage,
      runtimeStats: stats,
      hostProtocol: client
        ? {
            transport: client.transportKind,
            txFrames: client.stats.txFrames,
            rxFrames: client.stats.rxFrames,
            rxEvents: client.stats.rxEvents,
            crcFailures: client.stats.crcFailures,
            timeouts: client.stats.timeouts,
            resyncs: client.stats.resyncs,
          }
        : null,
      recentLog: useLogStore
        .getState()
        .entries.slice(-300)
        .map((e) => ({ t: new Date(e.t).toISOString(), src: e.src, msg: e.msg })),
    };
    downloadJson(`kino-diagnostics-${info.serial}-${Date.now()}.json`, report);
  };

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="developer" />
          Developer
        </h1>
        <Button onClick={downloadReport}>EXPORT DIAGNOSTIC BUNDLE</Button>
      </div>

      <p className="notice notice--warn">
        Service tools. Not needed for normal use.
      </p>

      <div className="panel-grid">
        <Panel title="P4 RUNTIME">
          <dl>
            <div className="datarow"><dt>Uptime</dt><dd>{stats ? formatUptime(stats.uptimeS) : '—'}</dd></div>
            <div className="datarow"><dt>Reset reason</dt><dd>{stats?.resetReason ?? '—'}</dd></div>
            <div className="datarow"><dt>Free heap</dt><dd>{stats ? `${stats.freeHeapKB} KB` : '—'}</dd></div>
            <div className="datarow"><dt>Free PSRAM</dt><dd>{stats ? formatMB(stats.freePsramKB / 1024) : '—'}</dd></div>
            {/* Unit in the label for both rows — these sat next to each
                other reading "45 °C" and "41° / 37° / 38° / 44°". */}
            <div className="datarow"><dt>P4 temp (°C)</dt><dd>{stats ? stats.tempC.p4 : '—'}</dd></div>
            <div className="datarow">
              <dt>Camera temps (°C)</dt>
              <dd>{stats ? stats.tempC.cams.join(' / ') : '—'}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="PROTOCOL COUNTERS">
          <dl>
            <div className="datarow"><dt>Dropped packets (P4)</dt><dd>{stats?.protocol.droppedPackets ?? '—'}</dd></div>
            <div className="datarow"><dt>CRC failures (P4)</dt><dd>{stats?.protocol.crcFailures ?? '—'}</dd></div>
            <div className="datarow"><dt>CRC failures (host)</dt><dd>{client?.stats.crcFailures ?? '—'}</dd></div>
            <div className="datarow"><dt>Timeouts (host)</dt><dd>{client?.stats.timeouts ?? '—'}</dd></div>
            <div className="datarow"><dt>Camera timeouts</dt><dd>{stats?.protocol.cameraTimeouts ?? '—'}</dd></div>
            <div className="datarow"><dt>SD errors</dt><dd>{stats?.protocol.sdErrors ?? '—'}</dd></div>
            <div className="datarow"><dt>Frames tx / rx</dt><dd>{client ? `${client.stats.txFrames} / ${client.stats.rxFrames}` : '—'}</dd></div>
          </dl>
        </Panel>

        <Panel title="SERVICE">
          <div style={{ display: 'grid', gap: 6 }}>
            <Button
              busy={busy === 'Enter maintenance'}
              disabled={inMaintenance}
              title={inMaintenance ? 'Already in maintenance' : undefined}
              onClick={() => void service('Enter maintenance', () => getDevice()!.enterMaintenance())}
            >
              ENTER MAINTENANCE
            </Button>
            <Button
              busy={busy === 'Exit maintenance'}
              disabled={!inMaintenance}
              title={!inMaintenance ? 'Not in maintenance' : undefined}
              onClick={() => void service('Exit maintenance', () => getDevice()!.exitMaintenance())}
            >
              EXIT MAINTENANCE
            </Button>
            <Button
              busy={busy === 'Clear device log'}
              onClick={() => void service('Clear device log', () => getDevice()!.clearDeviceLogs())}
            >
              CLEAR DEVICE LOG BUFFER
            </Button>
          </div>
          {notice ? <p className="dim" style={{ marginTop: 8 }}>{notice}</p> : null}
        </Panel>
      </div>

      <ConformancePanel />

      <PhasePanel />
      <TimingBench />
      <LinkBenchPanel />
      <BurnInPanel />

      <Panel title="CAMERA MATRIX">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>CAMERA</th>
                <th>STATUS</th>
                <th>FIRMWARE</th>
                <th>SENSOR</th>
                <th className="num">UART ERR</th>
                <th className="num">LAST CAPTURE</th>
                <th className="num">JPEG</th>
                <th className="num">DURATION</th>
                {/* Named for what it is. Called "SKEW" it read as the verdict
                    on the capture, on the same page as a bench reporting
                    21.76 ms NOT ACCEPTABLE for those same four frames. */}
                <th className="num">
                  GPIO SKEW (<span style={{ textTransform: 'none' }}>{skewCol.unit}</span>)
                </th>
              </tr>
            </thead>
            <tbody>
              {cameras.map((cam) => (
                <tr key={cam.id}>
                  <td>CAM {cam.id.slice(-1)}</td>
                  <td>
                    <Led
                      state={!cam.online ? 'err' : cam.state === 'ready' ? 'ok' : cam.state === 'timeout' ? 'warn' : 'busy'}
                      label={cam.online ? cam.state.toUpperCase() : 'OFFLINE'}
                    />
                  </td>
                  <td>{cam.online ? cam.firmware : '—'}</td>
                  <td>{cam.sensorDetected ? cam.sensor : '—'}</td>
                  <td className="num">{cam.uartErrors}</td>
                  <td className="num">{cam.lastCapture ? `${cam.lastCapture.ageS}s ago` : '—'}</td>
                  <td className="num">{cam.lastCapture ? `${cam.lastCapture.jpegKB} KB` : '—'}</td>
                  <td className="num">{cam.lastCapture ? `${cam.lastCapture.durationMs} ms` : '—'}</td>
                  <td className="num">{cam.lastCapture ? skewCol.format(cam.lastCapture.gpioSkewUs) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="val" style={{ marginTop: 8 }}>
          LAST MEASURED EFFECTIVE EXPOSURE SPREAD {exposureSpread}
        </p>
        <p className="spark-minmax" style={{ display: 'block' }}>
          {exposureSource}
        </p>
        <p className="spark-minmax" style={{ display: 'block', paddingTop: 4 }}>
          GPIO SKEW is trigger distribution, not exposure spread. Four sensors can share the trigger
          edge to 100 µs and still record a whole frame interval apart.
        </p>
      </Panel>

      <Panel
        title="PROTOCOL MONITOR"
        actions={
          <Button size="sm" onClick={() => setTraceVisible(!traceVisible)}>
            {traceVisible ? 'HIDE' : 'SHOW'} FRAME TRACE
          </Button>
        }
      >
        {traceVisible && client ? (
          <div style={{ overflowX: 'auto', maxHeight: 260, overflowY: 'auto' }} className="well">
            <table className="table">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>DIR</th>
                  <th>FRAME</th>
                  <th>FLAGS</th>
                  <th className="num">SEQ</th>
                  <th className="num">PAYLOAD</th>
                </tr>
              </thead>
              <tbody>
                {[...client.trace].reverse().map((f, i) => (
                  <tr key={`${f.t}-${i}`}>
                    <td>{formatLogTime(f.t)}</td>
                    <td>{f.dir === 'tx' ? '→ TX' : '← RX'}</td>
                    <td>{cmdName(f.type)}</td>
                    <td>{flagText(f.flags)}</td>
                    <td className="num">{f.seq}</td>
                    <td className="num">{f.len} B</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dim">
            Last {client?.trace.length ?? 0} frames on the wire, newest first.
          </p>
        )}
      </Panel>

      <Panel title="SERIAL CONSOLE" bodyClassName="panel-body--log">
        <LogViewer />
      </Panel>
    </>
  );
}
