// The Twin's firmware model (issue #72, brief §4/§38/§41): which firmware
// generation this virtual D4 is running, per-target versions and update
// states, and the profile switch. Switching profiles is SIMULATION CONTROL
// (like swapping the flashed image on a bench unit); actually flashing an
// artifact from Studio over KDP FW_* lands in the same place — an installed
// 0.1.0 image switches the device to the honest current-firmware profile.
import { PROTOCOL_VERSION, CONFIG_SCHEMA_VERSION, CAM_IDS } from '@kino/kdp';
import { FIRMWARE_PROFILE_LIST, FIRMWARE_PROFILES } from '@kino/test-fixtures';
import type { FirmwareProfile, FirmwareProfileId } from '@kino/test-fixtures';
import { useSimStore, getTwinRuntime } from '../state/simStore';

function fwStateLabel(entry: { state: string; pct?: number } | undefined): string {
  if (!entry?.state) return '—';
  return `${entry.state.toUpperCase()}${entry.pct !== undefined ? ` ${Math.round(entry.pct)}%` : ''}`;
}

/**
 * Capability flags worth naming in the panel, in reading order. A flag the
 * profile does not carry at all is left out of both lists — absent is not the
 * same claim as false (see the `brightnessControl` note in firmwareProfiles).
 */
const CAPABILITY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['configStore', 'settings store'],
  ['powerManagement', 'power management'],
  ['powerTelemetry', 'battery telemetry'],
  ['mediaIndex', 'media index'],
  ['gallery', 'frame reads'],
  ['wiggle', 'wiggle capture'],
  ['quad', 'quad capture'],
  ['flashControl', 'flash window'],
  ['recipes', 'looks'],
  ['customSounds', 'custom sounds'],
  ['brightnessControl', 'backlight brightness'],
  ['vsyncTelemetry', 'VSYNC phase telemetry'],
  ['network', 'network'],
  ['roll', 'Roll'],
  ['rollUpload', 'Roll upload'],
];

/** `CAM1 online, CAM2/CAM3/CAM4 offline` — read off the profile, not assumed. */
export function camLinkLine(profile: FirmwareProfile): string {
  const online = CAM_IDS.filter((_, index) => profile.camsOnline[index] === true);
  const offline = CAM_IDS.filter((_, index) => profile.camsOnline[index] !== true);
  if (offline.length === 0) return 'all four camera nodes online';
  if (online.length === 0) return 'no camera node online';
  const name = (cams: typeof online) => cams.map((cam) => cam.toUpperCase()).join('/');
  return `${name(online)} online, ${name(offline)} offline`;
}

/**
 * What this profile's firmware advertises and what it refuses, derived from
 * its own capability flags.
 *
 * The panel used to print one fixed sentence about 0.1.0's Milestone 1B
 * surface no matter which CURRENT profile was selected — so picking 0.4.9 read
 * "CAM2–CAM4 offline, only the Milestone 1B command surface answers", which
 * describes firmware five releases older than the one running. Same reason
 * Header.tsx asks `capabilities.flashControl` instead of matching a profile id.
 */
export function capabilitySplit(profile: FirmwareProfile): { advertised: string[]; refused: string[] } {
  const caps = profile.capabilities;
  if (!caps) return { advertised: [], refused: [] };
  const advertised: string[] = [];
  const refused: string[] = [];
  for (const [flag, label] of CAPABILITY_LABELS) {
    const value = caps[flag];
    if (value === true) advertised.push(label);
    else if (value === false) refused.push(label);
  }
  return { advertised, refused };
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
  const { advertised, refused } = capabilitySplit(active);

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
          <>
            <p className="twin-panel-note">
              Honest current firmware {active.p4Fw}: {camLinkLine(active)}. A command outside this
              firmware&apos;s implemented set NACKs UNSUPPORTED_COMMAND — exactly like the physical build.
            </p>
            {advertised.length > 0 ? (
              <p className="twin-panel-note">ADVERTISED: {advertised.join(', ')}.</p>
            ) : null}
            {refused.length > 0 ? (
              <p className="twin-panel-note">NOT ADVERTISED: {refused.join(', ')}.</p>
            ) : null}
          </>
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
        over FW_BEGIN/CHUNK/END with SHA-256 verification; no CURRENT profile implements that surface — one
        factory partition, no OTA slots. FW_QUERY reports versions from 0.4.0 on.
      </p>
    </section>
  );
}
