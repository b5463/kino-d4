import { useMemo, useState, type FormEvent } from 'react';
import { consumeHostToken, createHostApi, storeHostToken } from '../api/hostClient';
import { HostDashboard } from './HostDashboard';
import { Button, Panel } from '@kino/design-system';
import kinoRoll from '../assets/kino-roll-dark.png';

export function HostDashboardPage() {
  const [token, setToken] = useState(() => consumeHostToken());
  const [error, setError] = useState('');
  const api = useMemo(() => (token === null ? null : createHostApi(token)), [token]);

  if (api !== null) return <HostDashboard api={api} />;

  return (
    <main className="roll-shell roll-shell--narrow">
      <div className="roll-brand"><img src={kinoRoll} alt="KINO Roll" /> · HOST</div>
      <Panel title="Private dashboard">
        <h1>Host dashboard</h1>
        <p>Open the private host link supplied when this Roll was created, or paste its host token.</p>
        {/* A rejected token used to do nothing whatsoever: the button
            appeared to work and the page never moved or explained itself. */}
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const next = String(form.get('token') ?? '');
          if (storeHostToken(next)) {
            setError('');
            setToken(next.trim());
            return;
          }
          setError('That does not look like a host token. Open the private host link from when the Roll was created, or paste the token from it.');
        }}>
          <label htmlFor="host-token">Host token</label>
          <input id="host-token" name="token" type="password" autoComplete="off" required />
          <Button variant="primary" type="submit">Open dashboard</Button>
        </form>
        {error === '' ? null : <p className="roll-alert" role="alert">{error}</p>}
      </Panel>
    </main>
  );
}
