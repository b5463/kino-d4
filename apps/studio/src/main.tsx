import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';

import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * Two surfaces, one app.
 *
 * The customer shell (`customer/`) is the default. Service — the menu bar,
 * the sidebar, every bench and worksheet — opens at `/service` (or
 * `?service=1`) and nowhere the customer shell links to. The older
 * `/legacy` and `?legacy=1` spellings still open it, so a bookmark or a
 * script written against them keeps working. Each surface loads its own
 * stylesheet; the customer page never inherits a bevel.
 */
export function wantsService(pathname: string, search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.has('service') || params.has('legacy')) return true;
  return /\/(service|legacy)\/?$/.test(pathname);
}

async function loadShell(): Promise<ComponentType> {
  if (wantsService(window.location.pathname, window.location.search)) {
    await Promise.all([
      import('@kino/design-system/tokens.css'),
      import('@kino/design-system/components.css'),
      import('./styles/base.css'),
      import('./styles/ui.css'),
      import('./styles/pages.css'),
      import('./styles/service.css'),
    ]);
    const [{ ServiceShell }, { applyDensityClass }] = await Promise.all([import('./app/ServiceShell'), import('./state/prefs')]);
    applyDensityClass();
    return ServiceShell;
  }
  const { CustomerApp } = await import('./customer/CustomerApp');
  return CustomerApp;
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
