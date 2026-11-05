import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // GDB runtime assets are published explicitly from their verified manifest.
  // Do not copy Web runtimes or unfinished build directories into either client.
  publicDir: false,
  base: mode === "web" ? "./" : "/",
  server: { port: 1421, strictPort: true },
  build: {
    target: ["es2022", "safari17"],
    outDir: mode === "web" ? "dist-web" : "dist",
    ...(mode === "web" ? { rollupOptions: { input: "web.html" } } : {}),
  },
  clearScreen: false,
  test: { include: ["src/**/*.test.ts"] },
}));
