// Carrier bridge to the WebSocket relay (issue #29): forwards the Twin wire
// between the local BroadcastChannel — where TwinDeviceServer listens,
// unchanged — and `scripts/twin-ws-relay.mjs`. Started by the `?ws=` URL
// parameter; retried on loss so a restarted relay picks the Twin back up.
import { bridgeTwinChannel } from '@kino/kdp';

const RETRY_MS = 5000;

/**
 * Hosts a `?ws=` parameter may name. The relay is a development tool started
 * on the same machine, so a URL is only accepted if it points at this host.
 *
 * Without this, any link into the Twin could aim its whole device wire —
 * captures, config, firmware bytes — at an attacker's socket, and the page
 * would report the bridge as up. The parameter is convenience for a bench
 * with several dev ports, not a way to relocate the device.
 */
function allowedHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === window.location.hostname;
}

/** The relay URL to dial, or null when the parameter names a host we refuse. */
export function relayUrl(param: string): string | null {
  if (param === '' || param === '1') return `ws://${window.location.hostname}:5179`;

  let parsed: URL;
  try {
    parsed = new URL(param);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  if (!allowedHost(parsed.hostname)) return null;
  return param; // dial exactly what was asked for, once it is known to be local
}

export function startWsBridge(param: string | null): void {
  if (param === null) return;
  const url = relayUrl(param);
  if (url === null) {
    console.warn(`[twin] ws bridge: refusing relay "${param}" — only ws://localhost, 127.0.0.1 or this host`);
    return;
  }
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    bridgeTwinChannel({
      url,
      onDown: () => {
        console.warn(`[twin] ws bridge to ${url} lost — retrying in ${RETRY_MS / 1000}s`);
        setTimeout(connect, RETRY_MS);
      },
    })
      .then(() => console.info(`[twin] ws bridge up: ${url}`))
      .catch(() => {
        console.warn(`[twin] ws bridge: no relay at ${url} — retrying in ${RETRY_MS / 1000}s`);
        setTimeout(connect, RETRY_MS);
      });
  };
  window.addEventListener('beforeunload', () => {
    stopped = true;
  });
  connect();
}
