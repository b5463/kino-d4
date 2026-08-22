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

const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 };

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
    <div>
      <div style={row}>
        <span>FIRMWARE PROFILE</span>
        {FIRMWARE_PROFILE_LIST.map((profile) => (
          <button
            type="button"
            key={profile.id}
            disabled={!running}
            onClick={() => setProfile(profile.id)}
            style={{ fontWeight: profile.id === activeId ? 700 : 400 }}
          >
            {profile.label}
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
          Honest current firmware: CAM2–CAM4 are offline, only the Milestone 1B command surface answers,
          everything else NACKs UNSUPPORTED_COMMAND — exactly like the physical build.
        </p>
      )}

      {snapshot ? (
        <table className="twin-table">
          <thead>
            <tr><th>TARGET</th><th>VERSION</th><th>UPDATE STATE</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>MAIN / P4</td>
              <td>{snapshot.p4Fw}</td>
              <td>{fw.p4?.state ? `${fw.p4.state.toUpperCase()}${fw.p4.pct !== undefined ? ` ${Math.round(fw.p4.pct)}%` : ''}` : '—'}</td>
            </tr>
            {CAM_IDS.map((cam) => (
              <tr key={cam}>
                <td>{cam.toUpperCase()}</td>
                <td>{snapshot.cams[cam].fault === 'offline' ? 'OFFLINE' : snapshot.cams[cam].fw}</td>
                <td>{fw[cam]?.state ? `${fw[cam]!.state.toUpperCase()}${fw[cam]!.pct !== undefined ? ` ${Math.round(fw[cam]!.pct!)}%` : ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="twin-panel-note">Power the simulator on to read firmware state.</p>
      )}

      <p className="twin-panel-note">
        KDP protocol {PROTOCOL_VERSION} · config schema {CONFIG_SCHEMA_VERSION}. Firmware installs arrive
        from Studio over FW_BEGIN/CHUNK/END with SHA-256 verification; the CURRENT profile has no FW_*
        surface, exactly like the physical Milestone 1B build.
      </p>
    </div>
  );
}
