// The Twin's firmware model (issue #72, brief §4/§38/§41): which firmware
// generation this virtual D4 is running, per-target versions and update
// states, and the profile switch. Switching profiles is SIMULATION CONTROL
// (like swapping the flashed image on a bench unit); actually flashing an
// artifact from Studio over KDP FW_* lands in the same place — an installed
// 0.1.0 image switches the device to the honest current-firmware profile.
import { PROTOCOL_VERSION, CONFIG_SCHEMA_VERSION, CAM_IDS } from '@kino/kdp';
import { FIRMWARE_PROFILE_LIST, FIRMWARE_PROFILES } from '@kino/test-fixtures';
import type { FirmwareProfileId } from '@kino/test-fixtures';
import { useSimStore, getTwinRuntime } from '../state/simStore';

function fwStateLabel(entry: { state: string; pct?: number } | undefined): string {
  if (!entry?.state) return '—';
  return `${entry.state.toUpperCase()}${entry.pct !== undefined ? ` ${Math.round(entry.pct)}%` : ''}`;
}

export function FirmwarePanel() {
  const running = useSimStore((s) => s.running);
  const snapshot = useSimStore((s) => s.snapshot);
  const fw = useSimStore((s) => s.fw);

  function setProfile(id: FirmwareProfileId) {
    if (!running) return;
    getTwinRuntime().sim.device.setFirmwareProfile(id);
  }

  const activeId = (snapshot?.firmwareProfile ?? 'd4-sim-full') as FirmwareProfileId;
  const active = FIRMWARE_PROFILES[activeId];

  return (
    <section className="twin-tool-panel" aria-label="Firmware">
      <div className="twin-panel-heading"><span>FIRMWARE</span><span>{active.simulatedFuture ? 'SIMULATED FUTURE' : 'CURRENT'}</span></div>

      <div className="twin-panel-section">
        <span className="twin-field-label">PROFILE</span>
        <div className="twin-button-grid">
          {FIRMWARE_PROFILE_LIST.map((profile) => (
            <button
              type="button"
              key={profile.id}
              className={profile.id === activeId ? 'twin-btn twin-btn--active' : 'twin-btn'}
              disabled={!running}
              title={profile.label}
              onClick={() => setProfile(profile.id)}
            >
              {profile.simulatedFuture ? 'SIMULATED FUTURE' : `CURRENT ${profile.p4Fw}`}
            </button>
          ))}
        </div>
        {active.simulatedFuture ? (
          <p className="twin-panel-note">
            SIMULATED FUTURE CAPABILITY — this profile models firmware that does not exist yet. The shipped
            firmware is the CURRENT profile; flashing the real 0.1.0 artifact over KDP switches to it.
          </p>
        ) : (
          <p className="twin-panel-note">
            Honest current firmware: CAM2–CAM4 offline, only the Milestone 1B command surface answers,
            everything else NACKs UNSUPPORTED_COMMAND — exactly like the physical build.
          </p>
        )}
      </div>

      <div className="twin-panel-section">
        <span className="twin-field-label">TARGET VERSIONS</span>
        {snapshot ? (
          <>
            <div className="twin-control-row"><span>MAIN / P4</span><span>{snapshot.p4Fw} · {fwStateLabel(fw.p4)}</span></div>
            {CAM_IDS.map((cam) => (
              <div className="twin-control-row" key={cam}>
                <span>{cam.toUpperCase()}</span>
                <span>
                  {snapshot.cams[cam].fault === 'offline' ? 'OFFLINE' : snapshot.cams[cam].fw} · {fwStateLabel(fw[cam])}
                </span>
              </div>
            ))}
          </>
        ) : (
          <p className="twin-panel-note">Power the simulator on to read firmware state.</p>
        )}
      </div>

      <p className="twin-panel-note">
        KDP protocol {PROTOCOL_VERSION} · config schema {CONFIG_SCHEMA_VERSION}. Installs arrive from Studio
        over FW_BEGIN/CHUNK/END with SHA-256 verification; the CURRENT profile has no FW_* surface, exactly
        like the physical Milestone 1B build.
      </p>
    </section>
  );
}
