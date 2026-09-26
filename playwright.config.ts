import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:1421",
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  reporter: "list",
  outputDir: "output/playwright",
});
