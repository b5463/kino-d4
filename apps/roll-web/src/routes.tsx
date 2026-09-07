import { useEffect, useState } from 'react';
import { RollFeedPage } from './pages/RollFeedPage';
import { RollDisplayPage } from './pages/RollDisplayPage';
import { CaptureDetailPage } from './pages/CaptureDetailPage';
import { HostDashboardPage } from './pages/HostDashboardPage';
import { LandingPage } from './pages/LandingPage';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * Five routes: the landing page at `/`, the guest feed, one capture, the
 * display mode and the host dashboard. No router dependency was named for
 * roll-web (`react`, `react-dom`, `@tanstack/react-virtual`, `vite-plugin-pwa`,
 * `@kino/schemas`, `@kino/media` is the full list), so this is a small
 * hand-rolled matcher rather than an unlisted `react-router-dom`.
 */

export type Route =
  | { name: 'landing' }
  | { name: 'roll-feed'; slug: string }
  | { name: 'roll-display'; slug: string }
  | { name: 'capture-detail'; slug: string; captureId: string }
  | { name: 'host-dashboard' }
  | { name: 'not-found'; pathname: string };

/** Decodes one path segment the way `history`/`location.pathname` leaves it encoded. */
function segment(raw: string): string {
  return decodeURIComponent(raw);
}

export function matchRoute(pathname: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '');

  if (parts.length === 0) {
    return { name: 'landing' };
  }

  if (parts[0] === 'host' && parts.length === 1) {
    return { name: 'host-dashboard' };
  }

  if (parts[0] === 'r' && parts.length === 2 && parts[1] !== undefined) {
    return { name: 'roll-feed', slug: segment(parts[1]) };
  }

  if (parts[0] === 'r' && parts.length === 3 && parts[1] !== undefined && parts[2] === 'display') {
    return { name: 'roll-display', slug: segment(parts[1]) };
  }

  if (
    parts[0] === 'r' &&
    parts.length === 4 &&
    parts[1] !== undefined &&
    parts[2] === 'c' &&
    parts[3] !== undefined
  ) {
    return { name: 'capture-detail', slug: segment(parts[1]), captureId: segment(parts[3]) };
  }

  return { name: 'not-found', pathname };
}

/** Reads and subscribes to `location.pathname`, updating on `popstate`. */
function useLocationPathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return pathname;
}

/** Guest routes are the dark image browser; `/host` stays the light operator page. */
function surfaceOf(name: Route['name']): 'guest' | 'host' {
  return name === 'host-dashboard' ? 'host' : 'guest';
}

export function AppRoutes() {
  const route = matchRoute(useLocationPathname());
  const surface = surfaceOf(route.name);

  // One attribute on <body> switches the whole palette, so guest and host
  // styles never have to out-specify each other.
  useEffect(() => {
    document.body.dataset.surface = surface;
    // ...and the browser's own chrome with it. This tag carries the GUEST
    // colour only, `--k-ground`. The light `/host` page needs a pale status
    // bar instead, and it cannot be done from here: `vite-plugin-pwa`
    // rewrites the document's first `theme-color` from the manifest after
    // startup, so an edit made here comes back as the guest colour a moment
    // later. `HostDashboardPage` therefore prepends a tag of its own and
    // holds it - a browser honours the first applicable `theme-color` - and
    // removes it on the way out. Setting a host value here as well would be
    // a second declaration that loses to that one, which is how the two
    // disagreed: this line claimed the header blue while the host page
    // painted its own ground.
    const tag = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (tag !== null) tag.content = '#0b0b0c';
  }, [surface]);

  switch (route.name) {
    case 'landing':
      return <LandingPage />;
    case 'roll-feed':
      return <RollFeedPage slug={route.slug} />;
    case 'roll-display':
      return <RollDisplayPage slug={route.slug} />;
    case 'capture-detail':
      return <CaptureDetailPage slug={route.slug} captureId={route.captureId} />;
    case 'host-dashboard':
      return <HostDashboardPage />;
    case 'not-found':
      return <NotFoundPage pathname={route.pathname} />;
  }
}
