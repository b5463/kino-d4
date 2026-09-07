import { useState } from 'react';
import { Button, Panel } from '@kino/design-system';
import { hostLinkUrl } from '../../api/hostClient';

/**
 * The host link, and the fact that there is only one of it.
 *
 * The token is minted once, arrives in a URL fragment, and is stripped from
 * history on arrival. There is no rotate route and no re-issue route: a host
 * who loses it loses moderation, close and export for that roll permanently.
 * Nothing here can change that — it is a server-side gap — but everything that
 * can be done from the browser is done here: the whole link is rebuilt on
 * demand so it can be copied somewhere durable, the host is told once and
 * plainly that this is the only copy, and a host who chooses to can keep it on
 * this device past the tab closing.
 */

export const HOST_LINK_WARNED_KEY = 'kino.hostLinkWarned';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser refusing storage still gets the warning, every load.
  }
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The header control: one button, and the link in the open if copying fails. */
export function CopyHostLink({ token }: { token: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = hostLinkUrl(token);

  return (
    <span className="host-copy">
      <Button
        size="sm"
        onClick={() => {
          void copy(link).then((ok) => {
            setCopied(ok);
            // A browser that refuses the clipboard (no permission, no HTTPS)
            // must still be able to hand the host the link.
            setShown(!ok);
          });
        }}
      >
        {copied ? 'Host link copied' : 'Copy host link'}
      </Button>
      {shown ? (
        <input
          className="host-copy-field"
          readOnly
          aria-label="Host link"
          value={link}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </span>
  );
}

/** Shown once per device until dismissed. It is one line because it is one fact. */
export function HostLinkWarning({ token }: { token: string }) {
  const [dismissed, setDismissed] = useState(() => read(HOST_LINK_WARNED_KEY) !== null);
  if (dismissed) return null;
  return (
    <p className="host-warn" role="note">
      <span>
        This host link is the only copy. It cannot be re-issued — save it now, or you lose
        moderation, close and export for this roll.
      </span>
      <Button
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(hostLinkUrl(token)).catch(() => undefined);
          write(HOST_LINK_WARNED_KEY, new Date().toISOString());
          setDismissed(true);
        }}
      >
        Copy and dismiss
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          write(HOST_LINK_WARNED_KEY, new Date().toISOString());
          setDismissed(true);
        }}
      >
        Dismiss
      </Button>
    </p>
  );
}

export function HostAccessPanel({
  token,
  remembered,
  onRemember,
  onSignOut,
}: {
  token: string;
  remembered: boolean;
  onRemember: (remember: boolean) => void;
  onSignOut: () => void;
}) {
  return (
    <Panel title="Host access">
      <p>
        The host link is the whole key to this roll. Anyone who has it is the host; nobody can mint
        you a new one.
      </p>
      <CopyHostLink token={token} />
      <p className="host-check">
        <label>
          <input
            type="checkbox"
            checked={remembered}
            onChange={(event) => onRemember(event.target.checked)}
          />{' '}
          Keep me signed in on this device
        </label>
      </p>
      <p className="host-quiet">
        {remembered
          ? 'Kept in this browser until you sign out. Do not tick this on a borrowed machine.'
          : 'Off: closing this tab signs you out, and only the host link gets you back.'}
      </p>
      <Button variant="danger" onClick={onSignOut}>
        Sign out
      </Button>
    </Panel>
  );
}
