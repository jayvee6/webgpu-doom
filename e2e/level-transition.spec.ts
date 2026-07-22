import { test, expect } from "@playwright/test";

// Regression for the "automap blank after a level switch" bug: a freshly built level's
// wireframe frame-uniform was left zeroed (setView only ran on canvas resize) → the
// automap shader divided by zero. buildLevel now seeds the view; assert it's non-zero.
test("switching levels rebuilds cleanly and seeds the automap view", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto("/?e2e");
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__doom?.state?.pmo), { timeout: 20_000 })
    .toBe(true);

  const before = await page.evaluate(() => (window as any).__doom.map.name);

  const after = await page.evaluate(() => {
    (window as any).__doom.buildLevel("E1M2");
    // __doom is a LIVE getter — re-read it so we see the new map/wireframe/state that
    // buildLevel just swapped in, not the pre-switch snapshot.
    const d = (window as any).__doom;
    return {
      name: d.map.name,
      scale: d.wireframe.lastView[2], // [cx, cy, scale, aspect]; scale 0 ⇒ blank automap
      aspect: d.wireframe.lastView[3],
      pmo: { x: d.state.pmo.x, y: d.state.pmo.y, kind: d.state.pmo.kind },
    };
  });

  expect(before).toBe("E1M1");
  expect(after.name).toBe("E1M2");                 // new level actually loaded
  expect(after.scale).not.toBe(0);                 // automap view seeded (the fix)
  expect(Number.isFinite(after.scale)).toBe(true);
  expect(after.aspect).toBeGreaterThan(0);
  expect(after.pmo.kind).toBe("player");           // player re-initialized at the new start
  expect(Number.isFinite(after.pmo.x)).toBe(true);

  expect(errors, `errors during level switch:\n${errors.join("\n")}`).toEqual([]);
});
