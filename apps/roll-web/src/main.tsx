import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import '@kino/design-system/tokens.css';
import '@kino/design-system/components.css';
// Latin subsets only, and deliberately so: the Japanese subset of this face
// is 1.3 MB, and a guest opens this on a phone at a party. Two files, ~56 kB,
// and the whole guest interface is Latin. Numbers use the same face with
// tabular figures rather than the fixed-width sibling, which gave punctuation
// a full cell and set 23.08.26 as "23. 08. 26".
import '@fontsource/biz-udpgothic/latin-400.css';
import '@fontsource/biz-udpgothic/latin-700.css';
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
