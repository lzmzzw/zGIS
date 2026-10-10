import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 1421, strictPort: true },
  build: { target: ["es2022", "safari17"] },
  clearScreen: false,
  test: { include: ["src/**/*.test.ts"] },
});
