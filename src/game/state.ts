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

export interface Entity {
  kind: ThingCategory;
  type: number;
  x: number; // map x
  y: number; // map y
  z: number; // feet (floor height)
  angle: number; // degrees
  light: number; // 0..1
  radius: number;
  height: number;
  health: number;
  /** Resolved sprite lump for the current frame, or "" if none. */
  lump: string;
  /** false = removed from the world (picked up / dead / despawned). */
  active: boolean;
}

export interface Player {
  health: number;
  armor: number;
  /** Key colors held (for locked doors). */
  keys: Set<"blue" | "yellow" | "red">;
}

export class GameState {
  readonly map: DoomMap;
  readonly entities: Entity[] = [];
  readonly player: Player = { health: 100, armor: 0, keys: new Set() };
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
      this.entities.push({
        kind, type: t.type, x: t.x, y: t.y, z, angle: t.angle, light,
        radius: kind === "monster" ? 20 : 16, height: 56,
        health: kind === "monster" ? 60 : 0,
        lump, active: true,
      });
    }
  }

  /** Distinct sprite lumps any entity can currently show (for atlas building). */
  spriteLumps(): string[] {
    return [...new Set(this.entities.map((e) => e.lump).filter(Boolean))];
  }
}
