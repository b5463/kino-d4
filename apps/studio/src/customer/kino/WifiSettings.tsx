import { useCallback, useEffect, useState } from 'react';
import { getDevice } from '../../app/session';
import { submitNetwork } from '../../roll/rollOps';
import type { NetworkStatus, NetworkView } from '../../roll/rollTypes';
import { useReadOnly } from '../useReadOnly';

/** Signal as one word. Never a number. */
export function signalWord(status: NetworkStatus | null): string {
  if (!status || status.state !== 'connected') return status?.state === 'connecting' ? 'Connecting' : 'Not in range';
  const rssi = status.rssi;
  if (rssi === null) return 'Connected';
  if (rssi >= -60) return 'Strong';
  if (rssi >= -70) return 'Fair';
  return 'Weak';
}

/**
 * Connection: the saved network's name and one word for its signal; add a
 * network with a name and a password. Security is detected; nothing else
 * is asked. Always: KINO shoots without Wi-Fi.
 */
export function WifiSettings({ focus }: { focus: boolean }) {
  const readOnly = useReadOnly();
  const [networks, setNetworks] = useState<NetworkView[]>([]);
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [adding, setAdding] = useState(focus);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const dev = getDevice();
    if (!dev) return;
    try {
      const [list, st] = await Promise.all([dev.networkList(), dev.networkStatus()]);
      setNetworks(list.networks);
      setStatus(st);
    } catch {
      // The status line says when the link is gone.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (focus) setAdding(true);
  }, [focus]);

  const save = async () => {
    const dev = getDevice();
    if (!dev || busy) return;
    setBusy(true);
    setNote(null);
    try {
      setNetworks(await submitNetwork(dev, { ssid, password }));
      setSsid('');
      setPassword('');
      setAdding(false);
      await refresh();
    } catch {
      setNote("KINO didn't save this network. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const forget = async (name: string) => {
    const dev = getDevice();
    if (!dev) return;
    try {
      setNetworks((await dev.networkDelete(name)).networks);
      await refresh();
    } catch {
      setNote("KINO didn't forget this network. Try again.");
    }
  };

  const known = networks.some((n) => n.ssid === ssid.trim());
  const canSave = ssid.trim().length > 0 && (known || password.length >= 8);

  return (
    <>
      <h2 id="c-wifi">Connection</h2>
      {networks.length === 0 ? (
        <div className="c-setting is-wide">
          <span className="c-setting-label">Wi-Fi</span>
          <span className="c-setting-body">No network yet.</span>
        </div>
      ) : (
        networks.map((n) => (
          <div key={n.ssid} className="c-setting is-wide">
            <span className="c-setting-label">Wi-Fi</span>
            <span className="c-setting-body">
              {n.ssid}
              {status?.ssid === n.ssid ? ` · ${signalWord(status)}` : ''}
            </span>
            <span className="c-setting-action">
              <button type="button" disabled={readOnly} onClick={() => void forget(n.ssid)}>
                Forget
              </button>
            </span>
          </div>
        ))
      )}
      <div className="c-setting is-wide">
        <span className="c-setting-label" />
        <span className="c-setting-body">
          {adding ? (
            <form
              className="c-net-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                <span className="c-field-label">Network name</span>
                <input className="c-field" value={ssid} maxLength={32} autoComplete="off" disabled={busy} onChange={(e) => setSsid(e.target.value)} />
              </label>
              <label>
                <span className="c-field-label">{known ? 'Password (leave empty to keep the one KINO has)' : 'Password'}</span>
                <input className="c-field" type="password" value={password} autoComplete="off" disabled={busy} onChange={(e) => setPassword(e.target.value)} />
              </label>
              {note ? <span className="c-mark">{note}</span> : null}
              <span className="c-pair" style={{ gap: 24 }}>
                <button type="submit" className="c-button" disabled={!canSave || busy}>
                  Save
                </button>
                <button type="button" className="c-word c-word--quiet" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </span>
            </form>
          ) : (
            <button type="button" className="c-word" disabled={readOnly} onClick={() => setAdding(true)}>
              Add a network
            </button>
          )}
          <span className="c-quiet">KINO shoots without Wi-Fi. Wi-Fi is for Roll and for setting the clock.</span>
        </span>
      </div>
    </>
  );
}
