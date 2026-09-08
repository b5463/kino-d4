import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@kino/design-system/tokens.css';
import '@kino/design-system/components.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/pages.css';

import { App } from './app/App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyDensityClass } from './state/prefs';

applyDensityClass();

// The outer net. App wraps each section in its own boundary so one bad panel
// does not take the shell; this one catches anything above that — including a
// throw inside the shell itself, which would otherwise leave a blank window.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary what="KINO Studio">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Offline application shell. The camera connection is local anyway — after
// the first visit, KINO Studio opens without a network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline shell is a convenience, not a requirement.
    });
  });
}
