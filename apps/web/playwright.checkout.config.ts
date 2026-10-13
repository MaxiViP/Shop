import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/checkout',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  forbidOnly: Boolean(process.env.CI),
  outputDir: '../../work/checkout/artifacts/browser',
  reporter: [['list'], ['html', { outputFolder: '../../work/checkout/report', open: 'never' }],
    ['json', { outputFile: '../../work/checkout/artifacts/results.json' }]],
  use: {
    baseURL: process.env.E2E_WEB_BASE,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: process.env.CATALOG_BROWSER_PATH ? { executablePath: process.env.CATALOG_BROWSER_PATH } : {},
  },
  projects: [
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop-1280', use: { viewport: { width: 1280, height: 900 } } },
  ],
});
