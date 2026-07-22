import { test, expect } from "@playwright/test";

/** Read the live player map-object from the debug handle. */
async function pmo(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const p = (window as any).__doom.state.pmo;
    return { x: p.x, y: p.y, z: p.z, vx: p.vx ?? 0, vy: p.vy ?? 0 };
  });
}

async function waitReady(page: import("@playwright/test").Page) {
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__doom?.state?.pmo), { timeout: 20_000 })
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?e2e");
  await waitReady(page);
});

test("walking forward moves the player (sim + input + momentum integrated)", async ({ page }) => {
  const start = await pmo(page);

  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  const moving = await pmo(page);
  await page.keyboard.up("w");

  const dist = Math.hypot(moving.x - start.x, moving.y - start.y);
  expect(dist, "player should have moved a meaningful distance while holding W").toBeGreaterThan(40);
  expect(Math.hypot(moving.vx, moving.vy), "should have non-zero velocity while held").toBeGreaterThan(50);
});

test("momentum decays after release (skid, not instant stop)", async ({ page }) => {
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  const held = await pmo(page);
  await page.keyboard.up("w");

  await page.waitForTimeout(500);
  const coasted = await pmo(page);

  const heldSpeed = Math.hypot(held.vx, held.vy);
  const coastSpeed = Math.hypot(coasted.vx, coasted.vy);
  expect(heldSpeed, "should be moving while held").toBeGreaterThan(50);
  expect(coastSpeed, "velocity should decay toward zero after release").toBeLessThan(heldSpeed * 0.5);
});
