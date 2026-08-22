// KINO Twin WebSocket relay (issue #29): a dumb bus. Every text frame from
// one socket goes to every other socket, verbatim — BroadcastChannel
// semantics over the network, so the Twin wire protocol works unchanged
// across browsers, containers, and machines.
//
//   npm run twin:relay              (127.0.0.1:5179)
//   KINO_TWIN_WS_HOST=0.0.0.0 npm run twin:relay   # reachable on the LAN
//
// Then: Twin tab with ?ws=ws://<relay-host>:5179 — Studio with
// ?twinWs=ws://<relay-host>:5179 on its connect screen.
//
// Dev tool only: no auth, no TLS. It relays a simulated device; expose it
// past localhost only on a network you trust.
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

export function createTwinRelay({ port = Number(process.env.KINO_TWIN_WS_PORT ?? 5179), host = process.env.KINO_TWIN_WS_HOST ?? '127.0.0.1' } = {}) {
  const server = new WebSocketServer({ host, port });
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const text = data.toString();
      for (const peer of server.clients) {
        if (peer !== socket && peer.readyState === 1) peer.send(text);
      }
    });
    socket.on('error', () => socket.terminate());
  });
  return {
    host,
    port,
    close: () =>
      new Promise((resolve) => {
        // ws waits for every client to hang up before close() resolves; a
        // relay being shut down owes its clients nothing but a closed socket.
        for (const client of server.clients) client.terminate();
        server.close(resolve);
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  const relay = createTwinRelay();
  console.log(`kino twin ws relay on ws://${relay.host}:${relay.port}`);
}
