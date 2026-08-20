import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Static deploy target: relative base so the bundle works from any path
// (file server subdirectory, GitHub Pages, USB stick).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/zustand/')) return 'react';
          if (id.includes('/qrcode/')) return 'qrcode';
          if (id.includes('/zod/')) return 'schemas';
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'node',
    // .tsx as well: a component that renders a measurement is tested by
    // rendering it (react-dom/server — no DOM, no extra dependency).
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
