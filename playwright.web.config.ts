import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests-web",
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:14841/zgis/",
    channel: "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "node scripts/serve-web-test.mjs",
    url: "http://127.0.0.1:14841/zgis/",
    reuseExistingServer: false,
  },
  reporter: "list",
  outputDir: "output/web-0.4.0/playwright",
});
