import { lazy, Suspense, useEffect, useState } from 'react';
import { RollFeedPage } from './pages/RollFeedPage';
import { LandingPage } from './pages/LandingPage';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * Five routes: the landing page at `/`, the guest feed, one capture, the
 * display mode and the host dashboard. No router dependency was named for
 * roll-web (`react`, `react-dom`, `@tanstack/react-virtual`, `vite-plugin-pwa`,
 * `@kino/schemas`, `@kino/media` is the full list), so this is a small
 * hand-rolled matcher rather than an unlisted `react-router-dom`.
 *
 * ## What is in the first chunk, and what is not
 *
 * Every page used to be a static import, so `/r/:slug` — the route every guest
 * at the party opens — parsed the host dashboard, the design system it is
 * built on, the QR encoder and the display page before it painted a single
 * photograph. A third of the bundle was unreachable on that route.
 *
 * The feed, the landing page and the 404 stay eager: the feed IS the first
 * paint, and the other two are a form and a paragraph. The capture page, the
 * display page and `/host` are lazy — the capture page because a guest reaches
 * it by tapping a tile, by which time its chunk is already downloading; the
 * other two because a guest never reaches them at all.
 */

const CaptureDetailPage = lazy(async () => ({
  default: (await import('./pages/CaptureDetailPage')).CaptureDetailPage,
}));
const RollDisplayPage = lazy(async () => ({
  default: (await import('./pages/RollDisplayPage')).RollDisplayPage,
}));
const HostDashboardPage = lazy(async () => ({
  default: (await import('./pages/HostDashboardPage')).HostDashboardPage,
}));

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

/** The event this app dispatches on its own `pushState`; `popstate` does not fire for one. */
const NAVIGATED = 'kino-navigated';

/**
 * Goes to `path` without reloading the document.
 *
 * Exported so a control that is not a link (there are none today) has the same
 * one way in as every link does.
 */
export function navigate(path: string): void {
  if (path === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATED));
}

/**
 * Whether this click is one this app should handle itself.
 *
 * Everything that is NOT an ordinary left-click on an ordinary same-origin
 * in-app link belongs to the browser: a middle-click or a modifier opens a
 * tab, `target` and `download` mean something specific, a hash is an anchor on
 * the page, and an off-site or unmatched href is not this app's business. A
 * route that does not match falls through to a real document load, which is
 * what serves `/host#token=…` and anything the matcher has not heard of.
 */
function interceptable(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.('a');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target !== '' && anchor.target !== '_self') return null;
  if (anchor.hasAttribute('download')) return null;
  if (anchor.getAttribute('rel')?.includes('external') === true) return null;
  const href = anchor.getAttribute('href');
  if (href === null || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
    return null;
  }
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.hash !== '') return null;
  if (matchRoute(url.pathname).name === 'not-found') return null;
  return `${url.pathname}${url.search}`;
}

/**
 * Reads and subscribes to `location.pathname`.
 *
 * `popstate` is the browser's back and forward. `NAVIGATED` is this app's own
 * `pushState`, which fires no event of its own — without it a tap on a tile
 * would change the URL and leave the old page rendered.
 */
function useLocationPathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const changed = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', changed);
    window.addEventListener(NAVIGATED, changed);
    return () => {
      window.removeEventListener('popstate', changed);
      window.removeEventListener(NAVIGATED, changed);
    };
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

  /**
   * Every in-app link, intercepted once, at the document.
   *
   * Nothing in this app was client-side routed: every link was a plain
   * `<a href>` and the only listener was `popstate`, so tapping a tile was a
   * full document load — the whole bundle re-parsed, page 1 of the feed
   * refetched, the SSE stream torn down and reopened, and the guest's scroll
   * position and pending buffer thrown away. At a party that is the difference
   * between a gallery and a website.
   *
   * One capturing listener rather than an `onClick` per link: the links live
   * in the feed tile, the capture page's back control and the Info panel, and
   * a tile is rendered sixty times a screen. It also means a link added later
   * is routed without anyone remembering to route it.
   *
   * Scroll restoration is the browser's: `history.scrollRestoration` stays at
   * its default `auto`, so going back to the feed lands where the guest left
   * it — which only works because the document is no longer being reloaded.
   */
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const path = interceptable(event);
      if (path === null) return;
      event.preventDefault();
      navigate(path);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

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

  return <Suspense fallback={<RouteLoading />}>{pageFor(route)}</Suspense>;
}

/**
 * What a lazy route shows while its chunk arrives.
 *
 * The same line and the same class the pages use for their own first load, so
 * a slow chunk and a slow roll read look like one wait rather than two.
 */
function RouteLoading() {
  return (
    <div className="k-app">
      <p className="k-note" role="status" aria-live="polite">
        Reading roll…
      </p>
    </div>
  );
}

function pageFor(route: Route) {
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
