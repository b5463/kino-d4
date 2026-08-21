import { useState } from 'react';
import { CAM_IDS } from '@kino/kdp';
import type { CamId } from '@kino/kdp';
import { SCENARIO_LIST } from '@kino/test-fixtures';
import type { CamFault, ScenarioKey } from '@kino/test-fixtures';
import { getTwinRuntime, useSimStore } from '../state/simStore';

const CAM_FAULTS: CamFault[] = ['offline', 'power-open', 'sensor-missing', 'no-vsync', 'slow-uart', 'crc-noise'];
const BAUDS = [921_600, 1_500_000, 2_000_000, 3_000_000] as const;

export function FaultPanel() {
  const running = useSimStore((state) => state.running);
  const snapshot = useSimStore((state) => state.snapshot);
  const [filter, setFilter] = useState('');
  const scenarios = SCENARIO_LIST.filter((scenario) =>
    `${scenario.label} ${scenario.describe}`.toLowerCase().includes(filter.toLowerCase()),
  );

  function device() {
    return getTwinRuntime().sim.device;
  }

  function setScenario(key: ScenarioKey, value: boolean) {
    if (running) device().setScenario(key, value);
  }

  function setCamFault(cam: CamId, fault: CamFault | null) {
    if (running) device().setCamFault(cam, fault);
  }

  return (
    <section className="twin-tool-panel" aria-label="Fault injection">
      <div className="twin-panel-heading"><span>FAULT INJECTION</span><span>SIM ONLY</span></div>
      <div className="twin-panel-section">
        <input
          className="twin-numeric twin-numeric--wide"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="FILTER FAULTS"
          aria-label="Filter faults"
        />
      </div>
      <div className="twin-fault-list">
        {scenarios.map((scenario) => (
          <label className="twin-fault-row" key={scenario.key} title={scenario.describe}>
            <span>{scenario.label}</span>
            {scenario.oneShot ? (
              <button type="button" className="twin-btn twin-btn--fault" disabled={!running} onClick={() => setScenario(scenario.key, true)}>
                ARM
              </button>
            ) : (
              <input
                type="checkbox"
                disabled={!running}
                checked={snapshot?.scenarios[scenario.key] ?? false}
                onChange={(event) => setScenario(scenario.key, event.target.checked)}
              />
            )}
          </label>
        ))}
      </div>
      <div className="twin-panel-section">
        <span className="twin-field-label">PER-CAMERA FAULT</span>
        {CAM_IDS.map((cam) => (
          <label className="twin-control-row" key={cam}>
            <span>{cam.toUpperCase()}</span>
            <select
              className="twin-select"
              disabled={!running}
              value={snapshot?.cams[cam].fault ?? ''}
              onChange={(event) => setCamFault(cam, (event.target.value || null) as CamFault | null)}
            >
              <option value="">CLEAR</option>
              {CAM_FAULTS.map((fault) => <option key={fault} value={fault}>{fault.toUpperCase()}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="twin-panel-section twin-button-grid">
        <button type="button" className="twin-btn" disabled={!running} onClick={() => setScenario('sessionRestart', true)}>REBOOT P4</button>
        {CAM_IDS.map((cam) => (
          <button type="button" className="twin-btn" disabled={!running} key={cam} onClick={() => device().rebootCam(cam)}>
            REBOOT {cam.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="twin-panel-section">
        <label className="twin-control-row">
          <span>UART BAUD</span>
          <select
            className="twin-select"
            disabled={!running}
            value={snapshot?.uartBaud ?? 1_500_000}
            onChange={(event) => device().setUartBaud(Number(event.target.value) as (typeof BAUDS)[number])}
          >
            {BAUDS.map((baud) => <option key={baud} value={baud}>{baud === 921_600 ? '921600' : `${(baud / 1_000_000).toFixed(1)}M`}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
