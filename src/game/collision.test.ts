import { describe, it, expect } from "vitest";
import { blockedByEntity } from "./collision";
import type { Entity } from "./state";

/** Build a test Entity — defaults to a living monster at the origin; override any field. */
function ent(over: Partial<Entity>): Entity {
  return {
    kind: "monster", type: 0, x: 0, y: 0, z: 0, sector: 0, angle: 0, light: 1,
    radius: 20, height: 56, lump: "", active: true,
    ai: {
      state: "chase", health: 60, sprite4: "TROO", frame: "A", frameLumps: {},
      walkFrames: [], deathFrames: [], animT: 0, animI: 0, cooldown: 0,
    },
    ...over,
  } as Entity;
}

// A living monster obstacle at the origin (radius 20) and the player (radius 16).
// Overlap when the player's destination is within 16+20 = 36 units of the origin.
const obstacle = ent({ x: 0, y: 0 });
const player = ent({ kind: "player", radius: 16, ai: undefined, x: -200, y: 0 });

/** A fake EntityGrid query that ignores the query window and returns a fixed set. */
const query = (list: Entity[]) => () => list;

describe("blockedByEntity", () => {
  it("blocks the player from moving into a living monster", () => {
    expect(blockedByEntity(query([obstacle]), player, 30, 0)).toBe(true); // dist 30 < 36
  });

  it("does not block when the destination clears the monster", () => {
    expect(blockedByEntity(query([obstacle]), player, 100, 0)).toBe(false);
  });

  it("does not block at exactly the summed-radius boundary (strict overlap)", () => {
    expect(blockedByEntity(query([obstacle]), player, 36, 0)).toBe(false); // dist 36 == 36 → not <
  });

  it("ignores dead monsters — you can walk over corpses", () => {
    const corpse = ent({ ai: { ...ent({}).ai!, state: "dead" } });
    expect(blockedByEntity(query([corpse]), player, 10, 0)).toBe(false);
  });

  it("ignores items and decor", () => {
    const item = ent({ kind: "item", ai: undefined, radius: 16 });
    const decor = ent({ kind: "decor", ai: undefined });
    expect(blockedByEntity(query([item, decor]), player, 10, 0)).toBe(false);
  });

  it("ignores inactive entities", () => {
    expect(blockedByEntity(query([ent({ active: false })]), player, 10, 0)).toBe(false);
  });

  it("excludes the mover itself", () => {
    expect(blockedByEntity(query([player]), player, 10, 0)).toBe(false);
  });

  it("lets things pass when vertically separated (walk under a floating monster)", () => {
    const flyer = ent({ z: 200 }); // player occupies z[0,56], flyer z[200,256] — no overlap
    expect(blockedByEntity(query([flyer]), player, 10, 0)).toBe(false);
  });

  it("blocks monster-vs-monster contact", () => {
    const a = ent({ x: -200 }); // the mover
    const b = ent({ x: 0, y: 0 }); // 20+20=40 > dist 25 → overlap
    expect(blockedByEntity(query([a, b]), a, 25, 0)).toBe(true);
  });
});
