import { describe, it, expect } from "vitest";
import { stepVelocity, type MoveTune } from "./movement";

// The shipped defaults (main.ts). Equilibrium speed must equal these.
const TUNE: MoveTune = { MAX_WALK: 291, MAX_RUN: 583, FRICTION: 0.90625 };

/** Hold a direction for `ticks` tics from a standstill and return the final velocity. */
function equilibrium(idx: number, idy: number, running: boolean, ticks = 400): { vx: number; vy: number } {
  let v = { vx: 0, vy: 0 };
  for (let i = 0; i < ticks; i++) v = stepVelocity(v, idx, idy, running, TUNE);
  return v;
}

describe("stepVelocity — Doom P_Thrust momentum", () => {
  it("converges to MAX_RUN holding forward while running", () => {
    const v = equilibrium(1, 0, true);
    expect(v.vx).toBeCloseTo(TUNE.MAX_RUN, 1);
    expect(v.vy).toBeCloseTo(0, 6);
  });

  it("converges to MAX_WALK holding forward while walking", () => {
    expect(equilibrium(1, 0, false).vx).toBeCloseTo(TUNE.MAX_WALK, 1);
  });

  it("preserves target speed along a normalized diagonal (no diagonal speed-up)", () => {
    const d = Math.SQRT1_2; // normalized (1,1)
    const v = equilibrium(d, d, true);
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(TUNE.MAX_RUN, 1);
  });

  it("ramps up gradually, not instantly — one tic is well below top speed", () => {
    const one = stepVelocity({ vx: 0, vy: 0 }, 1, 0, true, TUNE);
    expect(one.vx).toBeCloseTo(TUNE.MAX_RUN * (1 - TUNE.FRICTION), 6);
    expect(one.vx).toBeLessThan(TUNE.MAX_RUN * 0.2);
  });

  it("skids to a near-stop on release, decaying by FRICTION and never going negative", () => {
    let v = { vx: TUNE.MAX_RUN, vy: 0 };
    expect(stepVelocity(v, 0, 0, false, TUNE).vx).toBeCloseTo(TUNE.MAX_RUN * TUNE.FRICTION, 4);
    for (let i = 0; i < 120; i++) v = stepVelocity(v, 0, 0, false, TUNE);
    expect(v.vx).toBeGreaterThan(0);
    expect(v.vx).toBeLessThan(1);
  });

  it("does not mutate the input velocity", () => {
    const v = { vx: 5, vy: 7 };
    stepVelocity(v, 1, 0, true, TUNE);
    expect(v).toEqual({ vx: 5, vy: 7 });
  });
});
