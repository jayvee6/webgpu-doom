/**
 * Player combat: instant hitscan ("pistol"). Picks the nearest monster whose
 * center is within a small radius of the aim ray and not behind a sight-blocking
 * wall, then applies damage. No projectile travel yet — that's the next weapon
 * tier.
 */

import type { DoomMap } from "../wad/maps";
import type { Blockmap } from "./blockmap";
import type { GameState, Entity } from "./state";
import { hasSight, hurtMonster } from "./ai";

const PISTOL_DAMAGE = 18;
const AIM_TOLERANCE = 18; // extra radius around the ray

/** Fire from (ox,oy) along map-space yaw; damages the first monster hit. Returns it. */
export function fireHitscan(state: GameState, map: DoomMap, blockmap: Blockmap, ox: number, oy: number, yaw: number): Entity | null {
  const dx = Math.sin(yaw), dy = Math.cos(yaw); // map-forward
  let best: Entity | null = null;
  let bestT = 4000;
  for (const e of state.entities) {
    if (e.kind !== "monster" || !e.active || e.mstate === "dead") continue;
    const rx = e.x - ox, ry = e.y - oy;
    const t = rx * dx + ry * dy; // distance along the ray
    if (t <= 0 || t >= bestT) continue;
    const perp = Math.abs(rx * dy - ry * dx); // perpendicular offset from the ray
    if (perp > e.radius + AIM_TOLERANCE) continue;
    if (!hasSight(map, blockmap, ox, oy, e.x, e.y)) continue; // wall in the way
    best = e;
    bestT = t;
  }
  if (best) hurtMonster(best, PISTOL_DAMAGE);
  return best;
}
