import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import '@kino/design-system/tokens.css';
import '@kino/design-system/components.css';
// Latin subsets only, and deliberately so: the Japanese subsets of these
// faces are 1.3 MB each, and a guest opens this on a phone at a party.
// Together these three files are ~80 kB and the whole guest UI is Latin.
import '@fontsource/biz-udpgothic/latin-400.css';
import '@fontsource/biz-udpgothic/latin-700.css';
import '@fontsource/biz-udgothic/latin-400.css';
import './roll.css';

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
