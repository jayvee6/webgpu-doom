import { describe, it, expect } from "vitest";
import { hurtMonster, resetMonstersToIdle } from "./ai";
import type { Entity } from "./state";

function monster(over: Partial<Entity["ai"]> = {}, deathFrames = ["H", "I"]): Entity {
  return {
    kind: "monster", type: 3001, x: 0, y: 0, z: 0, sector: 0, angle: 0, light: 1,
    radius: 20, height: 56, lump: "TROOA1", active: true,
    ai: {
      state: "chase", health: 60, sprite4: "TROO", frame: "A",
      frameLumps: { H: "TROOH0", I: "TROOI0" },
      walkFrames: ["A", "B"], deathFrames, animT: 0.1, animI: 3, cooldown: 0,
      ...over,
    },
  } as Entity;
}

describe("hurtMonster", () => {
  it("enters pain and subtracts health on a non-lethal hit", () => {
    const m = monster();
    hurtMonster(m, 18);
    expect(m.ai!.health).toBe(42);
    expect(m.ai!.state).toBe("pain");
  });

  it("dies and resets animation on a lethal hit (with death frames)", () => {
    const m = monster({ health: 10 });
    hurtMonster(m, 18);
    expect(m.ai!.state).toBe("dead");
    expect(m.ai!.animI).toBe(0);
    expect(m.ai!.animT).toBe(0);
    expect(m.active).toBe(true); // corpse remains, plays its death frames
  });

  it("vanishes when killed with no death frames", () => {
    const m = monster({ health: 5 }, []);
    hurtMonster(m, 18);
    expect(m.ai!.state).toBe("dead");
    expect(m.active).toBe(false);
  });

  it("is a no-op on an already-dead monster", () => {
    const m = monster({ state: "dead", health: -5 });
    hurtMonster(m, 18);
    expect(m.ai!.health).toBe(-5);
    expect(m.ai!.state).toBe("dead");
  });
});

describe("resetMonstersToIdle (respawn — corpse-resurrection regression)", () => {
  it("resets living monsters to idle", () => {
    const m = monster({ state: "chase", animI: 2, animT: 0.3 });
    resetMonstersToIdle([m]);
    expect(m.ai!.state).toBe("idle");
    expect(m.ai!.animI).toBe(0);
    expect(m.ai!.animT).toBe(0);
  });

  it("leaves corpses dead — they must NOT stand back up", () => {
    const corpse = monster({ state: "dead", health: -10, animI: 1 });
    resetMonstersToIdle([corpse]);
    expect(corpse.ai!.state).toBe("dead");
    expect(corpse.ai!.health).toBe(-10);
  });

  it("ignores non-monster entities", () => {
    const item = { kind: "item", active: true, ai: undefined } as unknown as Entity;
    expect(() => resetMonstersToIdle([item])).not.toThrow();
  });
});
