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
 * The service worker installs a new build in the background, but the page
 * already open keeps running the old one until every tab of it is gone. A roll
 * left open on a phone all evening is exactly that tab, so a fix shipped
 * mid-party never reached the guests who needed it.
 *
 * `onNeedRefresh` fires when a new build is installed and waiting. It gets one
 * line and one button: nothing reloads under a guest's thumb until they say so.
 * This is not an install prompt — 03§5 forbids prompting install automatically,
 * and this app registers no `beforeinstallprompt` listener, so there is still
 * nowhere for one to come from. A future task can add an explicit "Install"
 * affordance that owns that listener and calls `event.prompt()` itself.
 */
const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Plain DOM rather than a React island: this has to work even when the bug
    // being fixed is in the app tree the new build replaces.
    if (document.querySelector('.k-update') !== null) return;

    const bar = document.createElement('div');
    bar.className = 'k-update';
    bar.setAttribute('role', 'status');

    const line = document.createElement('span');
    line.textContent = 'A newer version of this page is ready.';

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => {
      reload.disabled = true;
      // `true` tells the waiting worker to take over and reloads the page.
      void updateServiceWorker(true);
    });

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Later';
    dismiss.addEventListener('click', () => bar.remove());

    bar.append(line, reload, dismiss);
    document.body.append(bar);
  },
});
