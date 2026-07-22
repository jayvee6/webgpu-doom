import { test, expect } from "@playwright/test";

// Boot verification — this is the runtime check that was blocked all session: does the
// whole engine initialize WebGPU, parse the WAD, build the level, and expose state?
test("boots, initializes WebGPU, and exposes the player map-object", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto("/?e2e");

  // If WebGPU fails, the app shows an error screen and never defines __doom — so this
  // waiting for pmo doubles as a "WebGPU actually worked" assertion.
  await expect
    .poll(() => page.evaluate(() => {
      const d = (window as any).__doom;
      return d && d.state && d.state.pmo ? "ready" : "not-ready";
    }), { timeout: 20_000 })
    .toBe("ready");

  const pmo = await page.evaluate(() => {
    const p = (window as any).__doom.state.pmo;
    return { x: p.x, y: p.y, z: p.z, kind: p.kind };
  });
  expect(pmo.kind).toBe("player");
  expect(Number.isFinite(pmo.x)).toBe(true);
  expect(Number.isFinite(pmo.y)).toBe(true);
  expect(Number.isFinite(pmo.z)).toBe(true);

  expect(errors, `page/console errors:\n${errors.join("\n")}`).toEqual([]);
});
