// The hardware worksheet (issue #93): every task that still needs physical
// hardware, in one page. Live validation comes from the connected unit;
// stage checks and notes persist locally; the measurements table derives
// from the hardware-profile data and empties itself as measurements land.

import { useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Led } from '../../components/Led';
import type { LedState } from '../../components/Led';
import { getDevice } from '../../app/session';
import { useConnectionStore } from '../../state/connectionStore';
import type { HwValidationReport, HwValidationStatus } from '@kino/kdp';
import {
  ACCEPTANCE_ITEMS,
  BENCH_STAGES,
  exportBenchRecord,
  importBenchRecord,
  measurementTasks,
  setBenchCheck,
  setBenchNotes,
  totalBenchChecks,
  useBench,
} from '../../developer/bench';
import { downloadJson } from '../../utils/download';

const STATUS_LED: Record<HwValidationStatus, LedState> = {
  'validated': 'ok',
  'failed': 'err',
  'not-applicable': 'warn',
  'unvalidated': 'off',
};

export function BenchPage() {
  const phase = useConnectionStore((s) => s.phase);
  const state = useBench();
  const [report, setReport] = useState<HwValidationReport | null>(null);
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const connected = phase === 'connected' || phase === 'maintenance';
  const measurements = measurementTasks();
  const done = Object.values(state.checks).filter(Boolean).length;

  const readValidation = async () => {
    const dev = getDevice();
    if (!dev) return;
    setReadBusy(true);
    setReadError(null);
    try {
      setReport(await dev.getHwValidation());
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
    } finally {
      setReadBusy(false);
    }
  };

  const onImport = (file: File) => {
    void file.text().then((text) => {
      try {
        const err = importBenchRecord(JSON.parse(text));
        setNotice(err ? `Import failed: ${err}` : 'Bench record imported.');
      } catch {
        setNotice('Import failed: not valid JSON.');
      }
    });
  };

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="test" />
          Bench
        </h1>
        <span className="pagehead-actions">
          <span className="microlabel">
            {done}/{totalBenchChecks()} CHECKS
          </span>
          <Button size="sm" onClick={() => downloadJson('kino-bench-record.json', exportBenchRecord())}>
            EXPORT RECORD
          </Button>
          <Button size="sm" onClick={() => importRef.current?.click()}>
            IMPORT…
          </Button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = '';
            }}
          />
        </span>
      </div>

      {notice ? <p className="notice">{notice}</p> : null}
      <p className="notice notice--warn">
        Everything that still needs physical hardware, in one place. Stages mirror
        firmware/BENCH_M1B.md — record each stage&apos;s verdicts in HARDWARE_VALIDATION.md and issue
        #66. The measurements table is derived from the hardware-profile data: recording a real
        measurement removes its own row.
      </p>

      <Panel
        title="LIVE HARDWARE VALIDATION"
        actions={
          <Button size="sm" busy={readBusy} disabled={!connected} onClick={() => void readValidation()}>
            READ FROM DEVICE
          </Button>
        }
      >
        {!connected ? (
          <p className="faint">Connect the camera to read its per-unit validation registry.</p>
        ) : report === null ? (
          <p className="faint">READ FROM DEVICE fetches GET_HW_VALIDATION — what this unit has bench-proven.</p>
        ) : (
          <>
            <p className="dim" style={{ marginBottom: 8 }}>
              P4 reset reason: <span className="val">{report.p4ResetReason}</span>. VALIDATED only
              flips when the real event happened on this unit; it survives reboots.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>ITEM</th>
                    <th>STATUS</th>
                    <th>DETAIL</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((item) => (
                    <tr key={item.id}>
                      <td className="val">{item.id}</td>
                      <td>
                        <Led state={STATUS_LED[item.status]} label={item.status.toUpperCase()} />
                      </td>
                      <td className="dim">{item.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {readError ? <p className="notice notice--err" style={{ marginTop: 8 }}>{readError}</p> : null}
      </Panel>

      {BENCH_STAGES.map((stage) => (
        <Panel key={stage.title} title={stage.title}>
          <div className="bringup-list">
            {stage.items.map((item) => (
              <div key={item.id} className="bringup-item">
                <label>
                  <input
                    type="checkbox"
                    checked={state.checks[item.id] === true}
                    onChange={(e) => setBenchCheck(item.id, e.target.checked)}
                  />
                  <span>{item.text}</span>
                </label>
              </div>
            ))}
          </div>
        </Panel>
      ))}

      <Panel title="MEASUREMENTS STILL OWED TO THE DATA">
        {measurements.length === 0 ? (
          <p className="faint">Nothing — every profile value is measured.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>MEASURE</th>
                  <th>DATA SAYS TODAY</th>
                  <th>RECORD IN</th>
                </tr>
              </thead>
              <tbody>
                {measurements.map((task) => (
                  <tr key={task.id}>
                    <td>{task.task}</td>
                    <td className="dim">{task.current}</td>
                    <td className="dim">{task.recordIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="ACCEPTANCE">
        <div className="bringup-list">
          {ACCEPTANCE_ITEMS.map((item) => (
            <div key={item.id} className="bringup-item">
              <label>
                <input
                  type="checkbox"
                  checked={state.checks[item.id] === true}
                  onChange={(e) => setBenchCheck(item.id, e.target.checked)}
                />
                <span>{item.text}</span>
              </label>
              <span className="microlabel">#{item.issue}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="NOTES">
        <textarea
          className="input"
          aria-label="Bench notes"
          style={{ width: '100%' }}
          value={state.notes}
          placeholder="stage results, temperatures, measured currents, anything the record should keep…"
          onChange={(e) => setBenchNotes(e.target.value)}
        />
      </Panel>
    </>
  );
}
