import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { startWsBridge } from './bridge/wsBridge';

// ?ws=1 (default relay on this host) or ?ws=ws://host:5179 — serve this
// Twin's device across machines through the WebSocket relay (issue #29).
startWsBridge(new URLSearchParams(window.location.search).get('ws'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
