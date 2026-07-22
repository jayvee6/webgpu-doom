/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  server: { port: 5180, host: true, strictPort: true },
  build: { target: "es2022" },
  test: {
    // Unit tests cover the GPU-free gameplay logic (game/, wad/, math/, geometry/,
    // audio/music). They run in Node — no browser needed. Browser end-to-end tests
    // live in e2e/ and are driven by Playwright, not Vitest.
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
