import { useId, useState } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import type { LedState } from '../../components/Led';
import { FieldRow, SegField, ToggleField } from '../../components/fields';
import type { NetworkSetRequest, NetworkStatus, NetworkView, WifiSecurity } from '../../roll/rollTypes';

/**
 * Wi-Fi provisioning (03 §27). Credentials are written to the camera and stay
 * there: the passphrase box is a password input, its value goes straight into
 * `NETWORK_SET`, and the saved list shows the device's mask — never a secret.
 */

function statusLamp(status: NetworkStatus | null): { state: LedState; label: string } {
  if (!status) return { state: 'off', label: 'WIFI UNKNOWN' };
  switch (status.state) {
    case 'connected':
      return { state: 'ok', label: 'WIFI CONNECTED' };
    case 'connecting':
      return { state: 'busy', label: 'WIFI CONNECTING' };
    default:
      return { state: 'off', label: 'WIFI OFF' };
  }
}

export function NetworkPanel({
  networks,
  status,
  busy,
  error,
  onSave,
  onForget,
}: {
  networks: NetworkView[];
  status: NetworkStatus | null;
  busy: boolean;
  error: string | null;
  onSave: (req: NetworkSetRequest) => Promise<void>;
  onForget: (ssid: string) => Promise<void>;
}) {
  const ssidId = useId();
  const passwordId = useId();
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [security, setSecurity] = useState<WifiSecurity>('wpa2');
  const [autoJoin, setAutoJoin] = useState(true);

  const known = networks.some((n) => n.ssid === ssid.trim());
  const needsPassword = security !== 'open' && !known;
  const canSave = ssid.trim().length > 0 && (!needsPassword || password.length >= 8);

  const save = async () => {
    if (!canSave || busy) return;
    await onSave({ ssid: ssid.trim(), password, security, autoJoin });
    // The passphrase is dropped the moment the command is away. Nothing in
    // this component keeps it, so nothing can leak it later.
    setPassword('');
    setSsid('');
  };

  const lamp = statusLamp(status);

  return (
    <Panel title="NETWORK" actions={<Led state={lamp.state} label={lamp.label} />}>
      <dl>
        <div className="datarow">
          <dt>Network</dt>
          <dd>{status?.ssid ?? '—'}</dd>
        </div>
        <div className="datarow">
          <dt>Address</dt>
          <dd>{status?.ip ?? '—'}</dd>
        </div>
        <div className="datarow">
          <dt>Signal</dt>
          <dd>{status?.rssi === null || status?.rssi === undefined ? '—' : `${status.rssi} dBm`}</dd>
        </div>
        <div className="datarow">
          <dt>Internet</dt>
          <dd>
            {status?.internet ? (
              <Led state="ok" label="REACHABLE" />
            ) : (
              <Led state="warn" label="NOT REACHABLE" />
            )}
          </dd>
        </div>
      </dl>

      <h3 className="roll-subhead">SAVED NETWORKS</h3>
      {networks.length === 0 ? (
        <p className="roll-empty">No networks saved on this camera.</p>
      ) : (
        <ul className="netlist">
          {networks.map((n) => (
            <li className="netrow" key={n.ssid}>
              <span className="netrow-ssid">{n.ssid}</span>
              <span className="netrow-pass" aria-label={`Passphrase for ${n.ssid} is stored on the camera`}>
                {n.hasPassword ? n.password : 'OPEN'}
              </span>
              <span className="netrow-meta">
                {n.security.toUpperCase()}
                {n.autoJoin ? ' · AUTO-JOIN' : ''}
              </span>
              <Button size="sm" disabled={busy} onClick={() => void onForget(n.ssid)}>
                FORGET
              </Button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="roll-subhead">ADD NETWORK</h3>
      {/* A real form: a password field outside one is a browser anti-pattern,
          and Enter has to save the network like it does in every other
          credentials dialog. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FieldRow label="SSID" htmlFor={ssidId}>
          <input
            id={ssidId}
            type="text"
            className="input"
            value={ssid}
            maxLength={32}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setSsid(e.target.value)}
          />
        </FieldRow>
        <FieldRow
          label="PASSPHRASE"
          htmlFor={passwordId}
          hint={
            known
              ? 'Leave empty to keep the passphrase already stored on the camera.'
              : security === 'open'
                ? 'Open network — no passphrase.'
                : 'At least 8 characters. Written to the camera only; it never reaches the Roll server.'
          }
        >
          <input
            id={passwordId}
            type="password"
            className="input"
            value={password}
            autoComplete="off"
            spellCheck={false}
            disabled={busy || security === 'open'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FieldRow>
        <SegField
          label="SECURITY"
          value={security}
          options={[
            { value: 'wpa2', label: 'WPA2' },
            { value: 'wpa3', label: 'WPA3' },
            { value: 'open', label: 'OPEN' },
          ]}
          disabled={busy}
          onChange={(v) => setSecurity(v as WifiSecurity)}
        />
        <ToggleField label="AUTO-JOIN" checked={autoJoin} disabled={busy} onChange={setAutoJoin} />

        {error ? <p className="notice notice--err">{error}</p> : null}

        <div className="panel-actions">
          <Button type="submit" variant="primary" busy={busy} disabled={!canSave}>
            SAVE NETWORK
          </Button>
        </div>
      </form>
    </Panel>
  );
}
