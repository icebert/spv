import { defineConfig } from '@playwright/test';

// The E2E suite runs against the production build served at a non-root base (like GitHub Pages).
// It builds into its own directory and listens on its own port so it never collides with a
// developer's `npm run preview` (root base, dist/, port 4173): reusing that server would silently
// test a stale bundle and 404 every `/spv/...` fixture URL.
const base = process.env.VITE_BASE ?? '/spv/';
const port = 4174;
const outDir = 'dist-e2e';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${port}${base}`,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite build --outDir ${outDir} && npx vite preview --outDir ${outDir} --port ${port} --strictPort`,
    url: `http://localhost:${port}${base}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { VITE_BASE: base },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
