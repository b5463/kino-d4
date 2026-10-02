import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';

import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * Three ways in, one app.
 *
 * The full Studio — rail, inspector, every page and bench — is the default,
 * as it always was. `?service=1` (or `/service`, and the older `/legacy` and
 * `?legacy=1` spellings) opens the same app under the red SERVICE band.
 * `?customer=1` opens the customer-shell prototype from #230, which loads
 * only its own stylesheets.
 */
export function wantsService(pathname: string, search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.has('service') || params.has('legacy')) return true;
  return /\/(service|legacy)\/?$/.test(pathname);
}

export function wantsCustomer(search: string): boolean {
  return new URLSearchParams(search).has('customer');
}

async function loadShell(): Promise<ComponentType> {
  const { pathname, search } = window.location;
  if (wantsCustomer(search) && !wantsService(pathname, search)) {
    const { CustomerApp } = await import('./customer/CustomerApp');
    return CustomerApp;
  }
  await Promise.all([
    import('@fontsource/inter/400.css'),
    import('@fontsource/inter/500.css'),
    import('@fontsource/inter/700.css'),
    import('@fontsource/oxanium/500.css'),
    import('@fontsource/oxanium/600.css'),
    import('@fontsource/oxanium/700.css'),
  ]);
  // In order, one at a time: the cascade is the order these land in the
  // document, and the dev server injects each sheet as its module arrives.
  // Under Promise.all that order was whichever fetch finished first, and
  // theme-kino.css sometimes lost to the sheets it exists to override.
  await import('@kino/design-system/tokens.css');
  await import('@kino/design-system/components.css');
  await import('./styles/base.css');
  await import('./styles/ui.css');
  await import('./styles/pages.css');
  await import('./styles/service.css');
  // The camera's register, on top of the era sheets: same layout, new skin.
  await import('./styles/theme-kino.css');
  // The frame: rail, top bar, workspace, inspector.
  await import('./styles/shell.css');
  const { applyDensityClass } = await import('./state/prefs');
  applyDensityClass();
  if (wantsService(pathname, search)) {
    const { ServiceShell } = await import('./app/ServiceShell');
    return ServiceShell;
  }
  const { App } = await import('./app/App');
  return App;
}

if (typeof document !== 'undefined' && document.getElementById('root')) {
  void loadShell().then((Shell) => {
    // The outer net. App wraps each section in its own boundary so one bad
    // panel does not take the shell; this one catches anything above that.
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary what="KINO Studio">
          <Shell />
        </ErrorBoundary>
      </StrictMode>,
    );
  });

  // Offline application shell. The camera connection is local anyway — after
  // the first visit, KINO Studio opens without a network.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
        // Offline shell is a convenience, not a requirement.
      });
    });
  }
}
