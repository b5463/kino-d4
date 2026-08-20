import { useMemo, useState, type FormEvent } from 'react';
import { consumeHostToken, createHostApi, storeHostToken } from '../api/hostClient';
import { HostDashboard } from './HostDashboard';
import { Button, Panel } from '@kino/design-system';

export function HostDashboardPage() {
  const [token, setToken] = useState(() => consumeHostToken());
  const api = useMemo(() => (token === null ? null : createHostApi(token)), [token]);

  if (api !== null) return <HostDashboard api={api} />;

  return (
    <main className="roll-shell roll-shell--narrow">
      <div className="roll-brand">KINO ROLL · HOST</div>
      <Panel title="Private dashboard">
        <h1>Host dashboard</h1>
        <p>Open the private host link supplied when this Roll was created, or paste its host token.</p>
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const next = String(form.get('token') ?? '');
          if (storeHostToken(next)) setToken(next.trim());
        }}>
          <label htmlFor="host-token">Host token</label>
          <input id="host-token" name="token" type="password" autoComplete="off" required />
          <Button variant="primary" type="submit">Open dashboard</Button>
        </form>
      </Panel>
    </main>
  );
}
