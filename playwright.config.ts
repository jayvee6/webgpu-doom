import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;

/**
 * End-to-end tests: launch the real dev server + a WebGPU-capable Chromium and drive
 * the game through the window.__doom debug handle. Load pages with ?e2e so the sim
 * runs without pointer lock (see main.ts).
 *
 * WebGPU needs the unsafe-webgpu flag. On a machine with a real GPU (local dev, Metal)
 * that's enough; on a GPU-less CI runner we also allow the SwiftShader software adapter
 * (--enable-unsafe-swiftshader) so the tests can still run. The flag is harmless where
 * a hardware adapter exists. If the GPU still won't initialize, the smoke test fails
 * loudly rather than silently passing.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: CI ? 2 : 0,
  forbidOnly: CI,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5180",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5180",
    reuseExistingServer: !CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--enable-unsafe-webgpu",
            "--enable-unsafe-swiftshader",
            "--enable-features=Vulkan,WebGPU",
            "--use-angle=default",
          ],
        },
      },
    },
  ],
});
