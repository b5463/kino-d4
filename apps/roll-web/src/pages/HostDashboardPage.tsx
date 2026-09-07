import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  clearHostToken,
  consumeHostToken,
  createHostApi,
  isHostTokenRemembered,
  rememberHostToken,
  storeHostToken,
} from '../api/hostClient';
import { HostDashboard } from './HostDashboard';
import { Button, Panel } from '@kino/design-system';
import kinoRoll from '../assets/kino-roll-dark.png';
import '../host.css';

/**
 * The `/host` surface is deliberately light — pale blue-grey page, white
 * panels — while the guest image browser is near-black, and the document's one
 * `theme-color` is the guest's. On a phone that painted a black status bar over
 * a pale page. The manifest belongs to the guest app; this route sets its own
 * colour at runtime and puts the tag back the way it found it on the way out.
 */
const HOST_THEME_COLOR = '#e9edf2';

function useHostThemeColor(): void {
  useEffect(() => {
    /**
     * A tag of our own at the head of `<head>`, rather than an edit to the one
     * already there. The document's `theme-color` belongs to the guest app and
     * is rewritten from the manifest by `vite-plugin-pwa` — an edit to it gets
     * overwritten. A browser honours the FIRST applicable `theme-color`, so
     * prepending wins without touching anybody else's tag, and removing it on
     * the way out leaves the guest colour exactly as it was.
     */
    const tag = document.createElement('meta');
    tag.name = 'theme-color';
    tag.content = HOST_THEME_COLOR;
    tag.dataset.surface = 'host';
    document.head.prepend(tag);

    /**
     * And held there. The PWA layer rewrites the first `theme-color` in the
     * document from the manifest after startup — measured in dev: the tag
     * came back as the guest blue a moment after mount. Re-asserting is two
     * lines; guessing at the plugin's timing is not.
     */
    const keep = new MutationObserver(() => {
      if (tag.content !== HOST_THEME_COLOR) tag.content = HOST_THEME_COLOR;
    });
    keep.observe(tag, { attributes: true, attributeFilter: ['content'] });

    return () => {
      keep.disconnect();
      tag.remove();
    };
  }, []);
}

export function HostDashboardPage() {
  const [token, setToken] = useState(() => consumeHostToken());
  const [remembered, setRemembered] = useState(() => isHostTokenRemembered());
  const [error, setError] = useState('');
  const api = useMemo(() => (token === null ? null : createHostApi(token)), [token]);
  useHostThemeColor();

  const signOut = (): void => {
    clearHostToken();
    setRemembered(false);
    setToken(null);
    setError('');
  };

  if (api !== null && token !== null) {
    return (
      <HostDashboard
        api={api}
        token={token}
        remembered={remembered}
        onRemember={(value) => {
          rememberHostToken(token, value);
          setRemembered(value);
        }}
        onSignOut={signOut}
      />
    );
  }

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
          const keep = form.get('remember') === 'on';
          if (storeHostToken(next)) {
            rememberHostToken(next.trim(), keep);
            setRemembered(keep);
            setError('');
            setToken(next.trim());
            return;
          }
          setError('That does not look like a host token. Open the private host link from when the Roll was created, or paste the token from it.');
        }}>
          <label htmlFor="host-token">Host token</label>
          <input id="host-token" name="token" type="password" autoComplete="off" required />
          <p className="host-check">
            <label>
              <input id="host-remember" name="remember" type="checkbox" /> Keep me signed in on this
              device
            </label>
          </p>
          <Button variant="primary" type="submit">Open dashboard</Button>
        </form>
        <p className="host-quiet">
          There is one host link per Roll and it cannot be re-issued. Off, this tab forgets the
          token when you close it.
        </p>
        {error === '' ? null : <p className="roll-alert" role="alert">{error}</p>}
      </Panel>
    </main>
  );
}
