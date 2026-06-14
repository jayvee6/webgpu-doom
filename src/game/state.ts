/**
 * Game state, separated from render state. The renderer reads this; it never owns
 * it. Entities are a flat tagged array (not an ECS — counts are in the hundreds,
 * matching Doom's own mobj list). For now entities are inert holders of position +
 * sprite so the dynamic billboard renderer draws them from LIVE state — this is the
 * gate for moving/animated/dying things (monsters, projectiles, picked-up items).
 */

import type { DoomMap } from "../wad/maps";
import { locateSector } from "../wad/bsp";
import { thingSprite, thingCategory, type ThingCategory } from "../wad/thingtypes";
import type { SpriteLib } from "../wad/sprites";

export type MonsterState = "idle" | "chase" | "attack" | "pain" | "dead";

export interface Entity {
  kind: ThingCategory;
  type: number;
  x: number; // map x
  y: number; // map y
  z: number; // feet (floor height)
  sector: number; // sector the thing stands in (-1 if none)
  angle: number; // degrees
  light: number; // 0..1 (spawn light; live light comes from LightState per frame)
  radius: number;
  height: number;
  /** Resolved sprite lump for the current frame, or "" if none. Renderer reads this. */
  lump: string;
  /** false = removed from the world (picked up / dead / despawned). */
  active: boolean;
  /**
   * Monster behavior + animation state. Present iff this entity is a monster —
   * `e.ai` IS the monster discriminant (cheaper and safer than re-checking kind).
   * Items/decor carry none of these fields. Projectiles will get their own
   * sub-object + system at the same seam.
   */
  ai?: MonsterAI;
}

export interface MonsterAI {
  state: MonsterState;
  health: number;
  sprite4: string; // 4-char sprite name
  frame: string; // current frame letter
  frameLumps: Record<string, string>; // letter → resolved lump
  walkFrames: string[];
  deathFrames: string[];
  animT: number; // animation timer
  animI: number; // current frame index
  cooldown: number; // attack cooldown (s)
}

export interface Player {
  health: number;
  armor: number;
  dead: boolean;
  ammo: { bul: number; shl: number; rck: number; cel: number };
  /** Key colors held (for locked doors). */
  keys: Set<"blue" | "yellow" | "red">;
}

export class GameState {
  readonly map: DoomMap;
  readonly entities: Entity[] = [];
  readonly player: Player = { health: 100, armor: 0, dead: false, ammo: { bul: 50, shl: 0, rck: 0, cel: 0 }, keys: new Set() };
  unmappedTypes = 0;

  constructor(map: DoomMap, lib: SpriteLib) {
    this.map = map;
    for (const t of map.things) {
      // Player/DM starts & markers have no sprite → not world entities.
      const ts = thingSprite(t.type);
      if (!ts) { this.unmappedTypes++; continue; }
      const lump = lib.resolveLump(ts.sprite, ts.frame);
      if (!lump) continue;
      const sec = locateSector(map, t.x, t.y);
      const z = sec >= 0 ? map.sectors[sec]!.floorHeight : 0;
      const light = sec >= 0 ? map.sectors[sec]!.light / 255 : 1;
      const kind = thingCategory(t.type);

      const entity: Entity = {
        kind, type: t.type, x: t.x, y: t.y, z, sector: sec, angle: t.angle, light,
        radius: kind === "monster" ? 20 : 16, height: 56,
        lump, active: true,
      };

      // Monsters get walk + death animation frames and a behavior sub-object.
      // Items/decor are inert holders of their single spawn lump (e.lump).
      if (kind === "monster") {
        const af = lib.monsterFrames(ts.sprite);
        const frameLumps: Record<string, string> = {};
        for (const f of [...af.walk, ...af.death]) {
          const l = lib.resolveLump(ts.sprite, f);
          if (l) frameLumps[f] = l;
        }
        frameLumps[ts.frame] = lump;
        entity.ai = {
          state: "idle", health: monsterHealth(t.type), sprite4: ts.sprite, frame: ts.frame,
          frameLumps,
          walkFrames: af.walk.filter((f) => frameLumps[f]),
          deathFrames: af.death.filter((f) => frameLumps[f]),
          animT: 0, animI: 0, cooldown: 0,
        };
      }

      this.entities.push(entity);
    }
  }

  /** Every sprite lump any entity can show across its frames (for atlas building). */
  spriteLumps(): string[] {
    const set = new Set<string>();
    for (const e of this.entities) {
      if (e.ai) { for (const l of Object.values(e.ai.frameLumps)) if (l) set.add(l); }
      else if (e.lump) set.add(e.lump);
    }
    return [...set];
  }
}

const MONSTER_HP: Record<number, number> = {
  3004: 20, 9: 30, 65: 70, // zombieman, shotgun, chaingunner
  3001: 60, 3002: 150, 58: 150, // imp, demon, spectre
  3006: 100, 3005: 400, 3003: 1000, 69: 500, // lost soul, caco, baron, knight
  68: 500, 71: 400, 66: 300, 67: 600, 64: 700, // arach, pain, revenant, manc, archvile
  7: 3000, 16: 4000, 84: 50, // spider, cyber, SS
};
function monsterHealth(type: number): number {
  return MONSTER_HP[type] ?? 60;
}
