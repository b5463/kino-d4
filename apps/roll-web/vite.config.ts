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
        // Matches the silver-blue chrome the gallery masthead wears.
        theme_color: '#ccd8e6',
        background_color: '#f7f8fa',
        display: 'standalone',
        start_url: '.',
        // A typographic app tile, not a new logo. `sizes: any` is valid for the
        // vector source and lets one approved asset cover every launcher size;
        // its wide safe area also makes the same file suitable for maskable
        // launchers. Task 34 may restyle the tile through shared tokens, but
        // Task 26's manifest is installable now rather than knowingly incomplete.
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
