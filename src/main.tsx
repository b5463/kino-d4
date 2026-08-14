import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/pages.css';

import { App } from './app/App';
import { applyDensityClass } from './state/prefs';

applyDensityClass();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
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
