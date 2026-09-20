import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * PWA shape, per the Task 26 brief:
 *   - app shell precached (`globPatterns`, the default `injectManifest`-free
 *     `generateSW` strategy already does this for the built assets);
 *   - `/api/*` reads go network-first — a guest at a party with patchy signal
 *     should see today's data the instant the network answers, and only fall
 *     back to a cache when it does not, never the reverse;
 *   - `/api/assets/*` content is cache-first — a photo a guest already
 *     opened should stay a photo, not a refetch, and the API already sets a
 *     short `private` cache-control (`ASSET_CACHE_CONTROL`) that this runtime
 *     cache entry is layered on top of, not a replacement for;
 *   - `registerType: 'prompt'` (not `'autoUpdate'`) plus no `beforeinstallprompt`
 *     listener anywhere in this app is what makes 03§5's "never prompt to
 *     install automatically" true — there is no code path that calls
 *     `event.prompt()` on its own.
 */
export default defineConfig({
  // NOT './': this app is served at fixed, deep, absolute routes
  // (`/r/:slug`, `/r/:slug/c/:captureId`, `/host`) by one host — it is the
  // opposite of Studio's static-bundle-from-anywhere deployment, which is
  // what `base: './'` is for. A relative base makes every asset path resolve
  // against the *route's* directory instead of the site root, so anything
  // one level deep 404s. Confirmed by building both ways and diffing
  // `dist/index.html`.
  base: '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'KINO Roll',
        short_name: 'KINO Roll',
        description: 'Guest gallery for a KINO Roll',
        // The GUEST shell, which is what an installed KINO Roll opens on
        // (`start_url: '/'`). These two colours are the install splash and
        // the task-switcher card, and they were still the old light design's
        // — so the app flashed pale blue-grey before painting a near-black
        // page. `--k-ground` from roll.css, both of them: the splash and the
        // page it becomes are the same surface.
        //
        // The per-surface value lives in the page, not here: a manifest has
        // one theme colour, and `/host` is a light operator page. `index.html`
        // carries the guest `theme-color` and `routes.tsx` swaps it for the
        // host's, which is the only place that distinction can be made.
        theme_color: '#0b0b0c',
        background_color: '#0b0b0c',
        display: 'standalone',
        // The landing page: an installed app opens on "enter a roll code",
        // not on whatever route it happened to be installed from.
        start_url: '/',
        // The D4 badge from the KINO wordmark, white on the header blue. The
        // "kino" word was the other candidate and lost on measurement: at
        // 5.8:1 it is an unreadable smear in a 48px launcher tile, while the
        // badge stays legible down to about 32px. Art sits inside the middle
        // 78%, so the same file serves `maskable` launchers that cut the tile
        // to a circle or squircle.
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // `woff2` is in the list because the two BIZ UDPGothic subsets are
        // part of the app SHELL, not content: every line of guest chrome is
        // set in them. Precached they arrive with the build; left out they
        // were fetched at runtime, so the first offline paint fell back to
        // system-ui and the interface changed shape. ~56 kB for both.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        /**
         * Three files in that glob are never rendered on a roll visit, and a
         * roll visit is the only visit that matters at a party.
         *
         *  - `icon-512.png` and `icon-apple-touch.png` are launcher art. A
         *    browser fetches them when the guest INSTALLS the app or adds it to
         *    a home screen, which is a deliberate act with a network behind it;
         *    `icon-192.png` stays precached because it is the one the manifest
         *    is most often read for.
         *  - `kino-roll-light-*.png` is the light wordmark, used by the PIN
         *    gate and the landing page only. A PIN roll fetches it on demand,
         *    once, and every other roll never asks for it at all.
         *
         * That is ~65 kB off the install a guest pays for before they see a
         * photograph. The dark wordmark, the fonts, the CSS and the JS stay:
         * those ARE the roll.
         */
        globIgnores: [
          '**/icon-512.png',
          '**/icon-apple-touch.png',
          '**/assets/kino-roll-light-*.png',
        ],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Everything under /api/ EXCEPT asset bytes and the SSE stream:
            // roll/capture reads, the PIN exchange. The `/events` exclusion
            // is load-bearing, not defensive — `GET /api/rolls/:slug/events`
            // otherwise matches all three clauses below it and the Workbox
            // SW fetch handler DOES see EventSource requests. Caching a
            // `text/event-stream` body that by design never ends means an
            // unbounded, ever-growing Cache Storage entry for the whole
            // visit, and a stale one played back offline would feed a
            // *different*, sourceless EventSource before the real
            // reconnect. Never intercept it at all.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith('/api/') &&
              !url.pathname.startsWith('/api/assets/') &&
              !url.pathname.endsWith('/events') &&
              request.method === 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'kino-roll-api',
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'kino-roll-assets',
              expiration: {
                maxEntries: 500,
                // A host can hide or delete a capture (03§11: "immediate
                // guest removal"), and cache-first alone would keep serving
                // it from any device that already opened it, forever. This
                // bound is a backstop, not the real fix — Tasks 28/29 own
                // the real one: evict the specific asset ids from
                // `kino-roll-assets` on `capture.hidden` / `capture.deleted`
                // (delivered over `rollApi.events()`) rather than waiting on
                // this to expire.
                maxAgeSeconds: 60 * 60 * 24,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    // Fixed port so docs, PUBLIC_BASE_URL and QR base URLs stay true across
    // restarts: roll-web 5173, twin 5174, studio 5175 (issue #86).
    port: 5173,
    proxy: {
      // Without this, `npm run dev` serves the SPA on Vite's own port with
      // no API behind it, and every `RollApi` call — which defaults to
      // same-origin — 404s on Vite's HTML fallback instead of reaching
      // `apps/api`. Tasks 27-31 all hit this on their first `npm run dev`.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // The SSE stream is a long-lived response; without this Vite's dev
        // proxy can time it out like an ordinary slow request.
        ws: false,
      },
    },
  },
  preview: {
    port: 5173,
    // `vite preview` reads its own proxy config (issue #86).
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, ws: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    /*
     * A fixed zone, because shortDate() renders in the LOCAL one.
     *
     * That is the right behaviour - a guest at a party wants the date their
     * own phone says, not UTC - but it makes any test that pins an absolute
     * instant depend on where the machine running it happens to be. One did:
     * `2026-08-14T22:30:00.000Z` is the 14th in UTC and the 15th anywhere
     * east of UTC+1:30, so `pinGate` passed in Bratislava and failed on a CI
     * runner for six weeks while the suite was red for other reasons and
     * nobody read it.
     *
     * UTC rather than a product zone: it is what the runners already use, so
     * a failure here reproduces on a developer machine without argument.
     */
    env: { TZ: 'UTC' },
  },
});
