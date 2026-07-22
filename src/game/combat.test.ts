import { describe, it, expect } from "vitest";
import { fireHitscan, fireShotgun } from "./combat";
import type { GameState, Entity } from "./state";
import type { DoomMap } from "../wad/maps";
import type { Blockmap } from "./blockmap";

/** Living monster at (x,y), feet z, standing 56 tall unless overridden. */
function monster(x: number, y: number, over: Partial<Entity> = {}): Entity {
  return {
    kind: "monster", type: 3001, x, y, z: 0, sector: 0, angle: 0, light: 1,
    radius: 20, height: 56, lump: "TROOA1", active: true,
    ai: {
      state: "chase", health: 60, sprite4: "TROO", frame: "A", frameLumps: {},
      walkFrames: [], deathFrames: ["H", "I"], animT: 0, animI: 0, cooldown: 0,
    },
    ...over,
  } as Entity;
}

// Empty map + blockmap: hasSight() iterates blockmap.linesNear() which returns [],
// so line-of-sight is always clear — isolating the aim geometry under test.
const MAP = { linedefs: [], vertexes: [], sidedefs: [], sectors: [] } as unknown as DoomMap;
const BLOCKMAP = { linesNear: () => [] } as unknown as Blockmap;
const stateWith = (...entities: Entity[]) => ({ entities } as unknown as GameState);

// Shooter at origin, eye z=20, facing +x (yaw=π/2 → dx=sin=1, dy=cos=0), level pitch.
const FWD_X = Math.PI / 2;
const shoot = (state: GameState, yaw = FWD_X, pitch = 0) =>
  fireHitscan(state, MAP, BLOCKMAP, 0, 0, 20, yaw, pitch);

describe("fireHitscan", () => {
  it("hits a monster dead ahead and applies pistol damage (18)", () => {
    const m = monster(100, 0);
    const hit = shoot(stateWith(m));
    expect(hit).toBe(m);
    expect(m.ai!.health).toBe(60 - 18);
  });

  it("misses a monster outside the aim cone", () => {
    // 50 units off-axis at 100 ahead → perp 50 > radius(20)+tolerance(18)=38
    expect(shoot(stateWith(monster(100, 50)))).toBeNull();
  });

  it("misses a monster behind the shooter", () => {
    expect(shoot(stateWith(monster(-100, 0)))).toBeNull();
  });

  it("misses when the aim ray passes above the target's height column", () => {
    // Eye at z=20 firing level; a target on the floor is fine, but raise the shooter
    // far above and the level ray clears the 56-tall column entirely.
    expect(fireHitscan(stateWith(monster(100, 0)), MAP, BLOCKMAP, 0, 0, 400, FWD_X, 0)).toBeNull();
  });

  it("picks the nearest monster along the ray", () => {
    const near = monster(50, 0), far = monster(120, 0);
    expect(shoot(stateWith(far, near))).toBe(near);
    expect(near.ai!.health).toBe(60 - 18);
    expect(far.ai!.health).toBe(60); // untouched
  });

  it("ignores dead monsters", () => {
    const corpse = monster(100, 0, { ai: { ...monster(0, 0).ai!, state: "dead" } });
    expect(shoot(stateWith(corpse))).toBeNull();
  });
});

describe("fireShotgun", () => {
  const blast = (state: GameState) => fireShotgun(state, MAP, BLOCKMAP, 0, 0, 20, FWD_X, 0);

  it("hits a monster in the spread and damages it", () => {
    const m = monster(100, 0);
    const hits = blast(stateWith(m));
    expect(hits).toContain(m);
    expect(m.ai!.health).toBeLessThan(60);
  });

  it("returns each monster at most once per blast (current pellet model)", () => {
    // NOTE: characterizes today's behavior — fireShotgun's hitSet caps each monster to
    // one pellet, which is why the shotgun underperforms (see Fable critique). Update
    // this expectation when pellet damage is reworked.
    const m = monster(100, 0);
    const hits = blast(stateWith(m));
    expect(hits.filter((h) => h === m).length).toBe(1);
  });

  it("does not hit dead monsters or targets behind the shooter", () => {
    const corpse = monster(100, 0, { ai: { ...monster(0, 0).ai!, state: "dead" } });
    expect(blast(stateWith(corpse))).toEqual([]);
    expect(blast(stateWith(monster(-100, 0)))).toEqual([]);
  });
});
