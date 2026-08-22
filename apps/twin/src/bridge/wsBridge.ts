// Carrier bridge to the WebSocket relay (issue #29): forwards the Twin wire
// between the local BroadcastChannel — where TwinDeviceServer listens,
// unchanged — and `scripts/twin-ws-relay.mjs`. Started by the `?ws=` URL
// parameter; retried on loss so a restarted relay picks the Twin back up.
import { bridgeTwinChannel } from '@kino/kdp';

const RETRY_MS = 5000;

function relayUrl(param: string): string {
  if (param === '' || param === '1') return `ws://${window.location.hostname}:5179`;
  return param;
}

export function startWsBridge(param: string | null): void {
  if (param === null) return;
  const url = relayUrl(param);
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
