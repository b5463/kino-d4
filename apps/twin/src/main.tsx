import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { startWsBridge } from './bridge/wsBridge';

// ?ws=1 (default relay on this host) or ?ws=ws://localhost:5179 — serve this
// Twin's device across machines through the WebSocket relay (issue #29).
//
// Development only. The relay is a dev-server tool, and a URL parameter that
// opens an outbound socket carrying the device wire has no business existing
// in a built, hosted Twin — a link with `?ws=` appended would be enough to
// use it. Vite drops this branch from a production bundle entirely.
if (import.meta.env.DEV) {
  startWsBridge(new URLSearchParams(window.location.search).get('ws'));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
