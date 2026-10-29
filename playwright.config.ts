import { defineConfig, devices } from '@playwright/test';

// Browser checks run against the production build (`npm run build` first). Locally they reuse a
// preview already running on the port; in CI they start their own.
const PORT = 4323;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : 4,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium-headless-shell' } },
  ],
  webServer: {
    command: `npx astro preview --port ${PORT} --host 127.0.0.1 --ignore-lock`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !CI,
    timeout: 60_000,
  },
});
