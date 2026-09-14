import { useState } from 'react';
import { CAM_IDS } from '@kino/kdp';
import type { CamId } from '@kino/kdp';
import { FIRMWARE_PROFILE_LIST, SCENARIO_LIST } from '@kino/test-fixtures';
import type { CamFault, FirmwareProfile, FirmwareProfileId, ScenarioKey } from '@kino/test-fixtures';
import { getTwinRuntime, useSimStore } from '../state/simStore';

/** Exported so the Inspector's per-camera fault control offers the same list. */
export const CAM_FAULTS: CamFault[] = [
  'offline',
  'power-open',
  'sensor-missing',
  'no-vsync',
  'slow-uart',
  'crc-noise',
  // AF faults (audit #55) — only bite on an OV5640_AF sensor profile.
  'af-fail',
  'vcm-stuck',
  'af-timeout',
  'af-hunt',
];
const BAUDS = [921_600, 1_500_000, 2_000_000, 3_000_000] as const;

/**
 * How a firmware profile reads in the selector: the version a camera flashed
 * with it would report, then what the profile is. A simulated future is
 * named as one (brief §42) so nobody mistakes the demo device for a build.
 */
export function profileOptionLabel(profile: FirmwareProfile): string {
  return profile.simulatedFuture
    ? `SIMULATED FUTURE · ${profile.label.replace(/^SIMULATED FUTURE\s*[—-]\s*/, '')}`
    : `${profile.p4Fw} · ${profile.label.replace(/^CURRENT FIRMWARE\s+\S+\s*[—-]\s*/, '')}`;
}

/** Shipped builds first, newest at the top; the simulated future last. */
export function profileOptions(list: readonly FirmwareProfile[] = FIRMWARE_PROFILE_LIST): FirmwareProfile[] {
  const shipped = list.filter((p) => !p.simulatedFuture).reverse();
  return [...shipped, ...list.filter((p) => p.simulatedFuture)];
}

/**
 * Per-camera fault injection — the one place in the app that pokes the
 * simulator for it, so this panel and the Inspector's own control cannot
 * drift apart. A null fault clears. Ignored while the sim is off: there is no
 * device to inject into.
 */
export function injectCamFault(cam: CamId, fault: CamFault | null): void {
  if (!useSimStore.getState().running) return;
  getTwinRuntime().sim.device.setCamFault(cam, fault);
}

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

  /** A profile is a flashed image: switching one is a reflash, so the camera
   * comes back as a new boot and a connected Studio sees the session change
   * and re-reads capabilities instead of keeping the old report. */
  function setFirmwareProfile(id: FirmwareProfileId) {
    if (!running || id === snapshot?.firmwareProfile) return;
    device().setFirmwareProfile(id);
    device().setScenario('sessionRestart', true);
  }


  return (
    <section className="twin-tool-panel" aria-label="Fault injection">
      <div className="twin-panel-heading"><span>FAULT INJECTION</span><span>SIM ONLY</span></div>
      <div className="twin-panel-section">
        <label className="twin-control-row">
          <span>FIRMWARE PROFILE</span>
          <select
            className="twin-select"
            disabled={!running}
            value={snapshot?.firmwareProfile ?? 'd4-sim-full'}
            title="Which firmware this device answers as. Shipped builds refuse what the camera refuses; the simulated future is the demo device."
            onChange={(event) => setFirmwareProfile(event.target.value as FirmwareProfileId)}
          >
            {profileOptions().map((profile) => (
              <option key={profile.id} value={profile.id}>{profileOptionLabel(profile)}</option>
            ))}
          </select>
        </label>
        <p className="twin-panel-note">Switching reboots the device (new session). Studio reconnects and re-reads capabilities.</p>
      </div>
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
              onChange={(event) => injectCamFault(cam, (event.target.value || null) as CamFault | null)}
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
