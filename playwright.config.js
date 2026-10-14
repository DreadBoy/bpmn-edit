import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  // Measurement specs (*.measure.spec.js) are long-running experiments, run only on request.
  testIgnore: process.env.BPMN_EDIT_MEASURE ? [] : ['**/*.measure.spec.js'],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
  // Every spec runs in all three browsers (S10). v1 support is Chrome; Firefox and WebKit guard against
  // browser-specific breakage. Run one with `npx playwright test --project=firefox`.
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
