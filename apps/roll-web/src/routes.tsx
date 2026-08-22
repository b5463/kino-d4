import { useEffect, useState } from 'react';
import { RollFeedPage } from './pages/RollFeedPage';
import { RollDisplayPage } from './pages/RollDisplayPage';
import { CaptureDetailPage } from './pages/CaptureDetailPage';
import { HostDashboardPage } from './pages/HostDashboardPage';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * The three routes this task wires up. No router dependency was named for
 * roll-web (`react`, `react-dom`, `@tanstack/react-virtual`, `vite-plugin-pwa`,
 * `@kino/schemas`, `@kino/media` is the full list), so this is a small
 * hand-rolled matcher rather than an unlisted `react-router-dom` — Tasks
 * 27-31 build the real pages behind these three matches; this task only
 * proves the paths resolve to something.
 */

export type Route =
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

export function AppRoutes() {
  const route = matchRoute(useLocationPathname());

  switch (route.name) {
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
