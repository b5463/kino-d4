import { defineConfig } from '@playwright/test';

// Acceptance walk for the Twin↔Studio preview pair (apps/twin/README.md).
// Serves the built dists on a dedicated port so a developer's own
// `npm run preview:all` on :4400 is never touched. Run `npm run build` first;
// the spec drives real KDP over BroadcastChannel, so both apps must be the
// current build.
const PORT = 4401;

export default defineConfig({
  testDir: 'e2e',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        // The Twin scene needs WebGL; headless CI has no GPU, so allow the
        // SwiftShader software rasterizer.
        '--enable-unsafe-swiftshader',
        // The walk keeps two tabs alive (Twin device + Studio client). The
        // backgrounded tab must keep answering KDP without timer throttling.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run preview:all',
    url: `http://localhost:${PORT}/dev/twin/`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { PORT: String(PORT) },
  },
});
