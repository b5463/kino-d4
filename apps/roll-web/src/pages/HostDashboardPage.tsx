import { useMemo, useState, type FormEvent } from 'react';
import { consumeHostToken, createHostApi, storeHostToken } from '../api/hostClient';
import { HostDashboard } from './HostDashboard';

export function HostDashboardPage() {
  const [token, setToken] = useState(() => consumeHostToken());
  const api = useMemo(() => (token === null ? null : createHostApi(token)), [token]);

  if (api !== null) return <HostDashboard api={api} />;

  return (
    <main style={{ maxWidth: 440, margin: '10vh auto', padding: '1rem' }}>
      <h1>Host dashboard</h1>
      <p>Open the private host link supplied when this Roll was created, or paste its host token.</p>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const next = String(form.get('token') ?? '');
        if (storeHostToken(next)) setToken(next.trim());
      }}>
        <label htmlFor="host-token">Host token</label><br />
        <input id="host-token" name="token" type="password" autoComplete="off" required style={{ width: '100%' }} />
        <button type="submit">Open dashboard</button>
      </form>
    </main>
  );
}
