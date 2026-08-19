import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('#root element is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * `registerSW` with no `onNeedRefresh`/`onOfflineReady` callbacks registers
 * the service worker and updates it silently in the background — it never
 * surfaces a prompt of its own. 03§5 requires install is never prompted
 * automatically; this app does not listen for `beforeinstallprompt` either,
 * so there is nowhere for an automatic prompt to come from. A future task can
 * add an explicit "Install" affordance that calls `event.prompt()` itself,
 * from a `beforeinstallprompt` listener it owns.
 */
registerSW({ immediate: true });
