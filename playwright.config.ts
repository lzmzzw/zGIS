import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  // Hosted Windows runners can stall browser startup and teardown; retain every assertion.
  timeout: process.env.CI ? 90000 : 30000,
  expect: { timeout: process.env.CI ? 15000 : 5000 },
  use: {
    baseURL: "http://127.0.0.1:1421",
    channel: "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  reporter: "list",
  outputDir: "output/playwright",
});
