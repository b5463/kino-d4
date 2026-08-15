// Interactive first-power / bring-up worksheet from the hardware spec.
// Checks persist locally; the wiring record replaces the paper notebook.

import { useEffect, useRef, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { getDevice, onSelfTestEvent } from '../../app/session';
import { useConnectionStore } from '../../state/connectionStore';
import {
  CHECKLIST,
  useBringUp,
  setCheck,
  setWiringRow,
  setNotes,
  exportRecord,
  importRecord,
  totalChecks,
} from '../../developer/bringup';
import type { ChecklistItem, WiringRow } from '../../developer/bringup';
import { CAM_IDS } from '@kino/kdp';
import { downloadJson } from '../../utils/download';

type TestId = NonNullable<ChecklistItem['test']>;

export function BringUpPage() {
  const phase = useConnectionStore((s) => s.phase);
  const state = useBringUp();
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [testBusy, setTestBusy] = useState<TestId | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selfTestSummary = useRef<{ pass: number; fail: number }>({ pass: 0, fail: 0 });

  const connected = phase === 'connected' || phase === 'maintenance';

  useEffect(() => {
    return onSelfTestEvent((e) => {
      if (e.done && e.results) {
        const pass = e.results.filter((r) => r.status === 'pass').length;
        const fail = e.results.filter((r) => r.status === 'fail').length;
        selfTestSummary.current = { pass, fail };
        setTestResults((r) => ({ ...r, selftest: `${pass} pass · ${fail} fail` }));
        setTestBusy(null);
      }
    });
  }, []);

  const runTest = async (test: TestId) => {
    const dev = getDevice();
    if (!dev || testBusy) return;
    setTestBusy(test);
    setTestResults((r) => ({ ...r, [test]: 'running…' }));
    try {
      if (test === 'uart-echo') {
        const parts: string[] = [];
        for (const cam of CAM_IDS) {
          const t0 = performance.now();
          try {
            await dev.cameraStatus(cam);
            parts.push(`${cam.toUpperCase().replace('CAM', 'C')} ${Math.round(performance.now() - t0)}ms`);
          } catch {
            parts.push(`${cam.toUpperCase().replace('CAM', 'C')} NO RESPONSE`);
          }
        }
        setTestResults((r) => ({ ...r, [test]: parts.join(' · ') }));
      } else if (test === 'trigger') {
        const result = await dev.timingTest();
        setTestResults((r) => ({
          ...r,
          [test]: result.vsyncMeasured
            ? `gpio ${result.gpioSpreadUs} µs · vsync ${(result.vsyncSpreadUs / 1000).toFixed(2)} ms · exposure ${(result.exposureSpreadUs / 1000).toFixed(2)} ms`
            : `gpio ${result.gpioSpreadUs} µs · no VSYNC telemetry`,
        }));
      } else if (test === 'captures') {
        const parts: string[] = [];
        for (const cam of CAM_IDS) {
          try {
            const res = await dev.cameraTest(cam);
            parts.push(`${cam.toUpperCase().replace('CAM', 'C')} ${res.jpegKB}KB`);
          } catch {
            parts.push(`${cam.toUpperCase().replace('CAM', 'C')} FAIL`);
          }
        }
        setTestResults((r) => ({ ...r, [test]: parts.join(' · ') }));
      } else if (test === 'selftest') {
        await dev.startSelfTest();
        return; // resolved by the self-test event listener
      }
    } catch (err) {
      setTestResults((r) => ({ ...r, [test]: err instanceof Error ? err.message : String(err) }));
    }
    setTestBusy(null);
  };

  const done = Object.values(state.checks).filter(Boolean).length;

  const onImport = (file: File) => {
    void file.text().then((text) => {
      try {
        const err = importRecord(JSON.parse(text));
        setNotice(err ? `Import failed: ${err}` : 'Wiring record imported.');
      } catch {
        setNotice('Import failed: not valid JSON.');
      }
    });
  };

  return (
    <>
      <div className="pagehead">
        <h1>
          <Icon name="usb" />
          Bring-Up
        </h1>
        <span className="pagehead-actions">
          <span className="microlabel">
            {done}/{totalChecks()} CHECKS
          </span>
          <Button size="sm" onClick={() => downloadJson('kino-wiring-record.json', exportRecord())}>
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
        First-power checklist from the V1 hardware spec. Do not connect the LiPo or solder the
        provisional GPIO map until the relevant section passes. RUN buttons need a connected camera.
      </p>

      {CHECKLIST.map((section) => (
        <Panel key={section.title} title={section.title}>
          <div className="bringup-list">
            {section.items.map((item) => (
              <div key={item.id} className="bringup-item">
                <label>
                  <input
                    type="checkbox"
                    checked={state.checks[item.id] === true}
                    onChange={(e) => setCheck(item.id, e.target.checked)}
                  />
                  <span>{item.text}</span>
                </label>
                {item.test ? (
                  <span className="bringup-test">
                    <Button
                      size="sm"
                      disabled={!connected || testBusy !== null}
                      busy={testBusy === item.test}
                      onClick={() => void runTest(item.test!)}
                    >
                      RUN
                    </Button>
                    {testResults[item.test] ? <span className="val">{testResults[item.test]}</span> : null}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
      ))}

      <Panel title="WIRING RECORD — FROZEN GPIO MAP">
        <p className="dim" style={{ marginBottom: 8 }}>
          Provisional pins from the spec. Enter the measured pin once verified on the delivered
          Guition revision; mark moved pins so the firmware map follows the record, not the spec.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>FUNCTION</th>
                <th>PROVISIONAL</th>
                <th>MEASURED</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {state.wiring.map((row: WiringRow, i: number) => (
                <tr key={row.func}>
                  <td>{row.func}</td>
                  <td>{row.provisional}</td>
                  <td>
                    <input
                      type="text"
                      className="input"
                      style={{ width: 110 }}
                      value={row.measured}
                      placeholder="GPIO…"
                      aria-label={`Measured pin for ${row.func}`}
                      onChange={(e) => setWiringRow(i, { measured: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      style={{ minWidth: 120 }}
                      value={row.status}
                      aria-label={`Status for ${row.func}`}
                      onChange={(e) => setWiringRow(i, { status: e.target.value as WiringRow['status'] })}
                    >
                      <option value="unverified">UNVERIFIED</option>
                      <option value="confirmed">CONFIRMED</option>
                      <option value="moved">MOVED</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="NOTES">
        <textarea
          className="input"
          aria-label="Bring-up notes"
          style={{ width: '100%' }}
          value={state.notes}
          placeholder="battery polarity, BMS pads, IDC pin 1 orientation, measured currents…"
          onChange={(e) => setNotes(e.target.value)}
        />
      </Panel>
    </>
  );
}
