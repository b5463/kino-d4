import { useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { ToggleField } from '../../components/fields';
import { getDevice } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { claimDevice, releaseDevice, useBlockedBy } from '../../state/deviceBusy';
import { runConformance, conformanceCaseCount } from '../../developer/conformance';
import type { ConformanceResult, ConformanceStatus } from '../../developer/conformance';
import { downloadJson } from '../../utils/download';

const OWNER = 'conformance';
const LABEL = 'PROTOCOL CONFORMANCE';

const STATUS_CLASS: Record<ConformanceStatus, string> = {
  pass: 'st-pass',
  shape: 'st-fail',
  unsupported: 'st-skip',
  timeout: 'st-fail',
  error: 'st-fail',
  skipped: 'st-skip',
};

export function ConformancePanel() {
  const info = useDeviceStore((s) => s.info);
  const [includeActive, setIncludeActive] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [results, setResults] = useState<ConformanceResult[] | null>(null);
  const blockedBy = useBlockedBy(OWNER);

  const run = async () => {
    const dev = getDevice();
    if (!dev || running) return;
    // One bench at a time on one UART. Four at once produced numbers that
    // disagreed with each other by 5×.
    if (!claimDevice(OWNER, LABEL)) return;
    setRunning(true);
    setResults(null);
    try {
      const res = await runConformance(dev, includeActive, (done, total, current) =>
        setProgress({ done, total, current }),
      );
      setResults(res);
    } finally {
      releaseDevice(OWNER);
      setRunning(false);
    }
  };

  const passed = results?.filter((r) => r.status === 'pass').length ?? 0;
  const total = results?.filter((r) => r.status !== 'skipped').length ?? 0;
  const allGreen = results !== null && passed === total;

  return (
    <Panel
      title="PROTOCOL CONFORMANCE"
      actions={
        <>
          {results ? (
            <Button
              size="sm"
              onClick={() =>
                downloadJson(`kino-conformance-${info?.serial ?? 'unknown'}-${Date.now()}.json`, {
                  device: info?.serial,
                  p4Firmware: info?.p4Firmware,
                  ranAt: new Date().toISOString(),
                  results,
                })
              }
            >
              EXPORT REPORT
            </Button>
          ) : null}
          {/* Progress never goes in the label: a changing label is not
              announced, and the count shifted the button width every case. */}
          <Button
            variant="primary"
            size="sm"
            busy={running}
            disabled={!running && blockedBy !== null}
            title={blockedBy ? `${blockedBy} is running` : undefined}
            onClick={() => void run()}
          >
            RUN {conformanceCaseCount(includeActive)} CHECKS
          </Button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 6 }}>
        Fires every protocol command and validates the response shape. Firmware is done when this
        is all green.
      </p>
      <ToggleField
        label="INCLUDE ACTIVE CHECKS"
        checked={includeActive}
        onChange={setIncludeActive}
        onLabel="ON"
        offLabel="OFF"
      />
      <p className="val" role="status" style={{ padding: '6px 0', minHeight: 18 }}>
        {running
          ? `RUNNING ${progress.done}/${progress.total} · ${progress.current}`
          : blockedBy
            ? `${blockedBy} is running.`
            : ''}
      </p>
      {results ? (
        <>
          <p className={allGreen ? 'st-pass' : 'st-fail'} style={{ margin: '8px 0', fontWeight: 700 }}>
            {passed}/{total} PASS{allGreen ? ' — PROTOCOL CONFORMANT' : ''}
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>CHECK</th>
                  <th>RESULT</th>
                  <th>DETAIL</th>
                  <th className="num">TIME</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.name}>
                    <td>
                      {r.name}
                      {r.active ? ' *' : ''}
                    </td>
                    <td className={STATUS_CLASS[r.status]}>{r.status.toUpperCase()}</td>
                    <td style={{ whiteSpace: 'normal' }}>{r.detail}</td>
                    <td className="num">{r.ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="microlabel" style={{ paddingTop: 4 }}>* ACTIVE CHECK — WRITES OR CAPTURES</p>
        </>
      ) : null}
    </Panel>
  );
}
