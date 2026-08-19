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
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'KINO Roll',
        short_name: 'KINO Roll',
        description: 'Guest gallery for a KINO Roll',
        // Placeholder pending Task 34's design tokens — this is scaffolding,
        // not the finished visual language.
        theme_color: '#2f70c9',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '.',
        icons: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Everything under /api/ EXCEPT asset bytes: roll/capture reads,
            // the PIN exchange. Never the SSE stream — an event source is not
            // a fetch this plugin should intercept at all.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith('/api/') &&
              !url.pathname.startsWith('/api/assets/') &&
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
              expiration: { maxEntries: 500 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
