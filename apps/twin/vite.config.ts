import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Static deploy target: relative base so the bundle works from any path
// (file server subdirectory, GitHub Pages, USB stick) — same rationale as Studio.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // Roll development bridge (issue #75): same-origin /api reaches the Roll
    // API. ws:false keeps SSE passthrough intact — same setup as roll-web.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, ws: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Three is intentionally a large engine; split it from R3F and use
    // a measured 700 kB ceiling for that one engine chunk instead of Vite's
    // generic 500 kB web-app default. The prior single chunk was 1.16 MB.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/three/')) return 'three';
          if (id.includes('/@react-three/')) return 'react-three';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
