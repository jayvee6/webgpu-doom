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

/** Fire from (ox,oy,oz) along map-space yaw+pitch; damages the first monster hit. Returns it. */
export function fireHitscan(state: GameState, map: DoomMap, blockmap: Blockmap, ox: number, oy: number, oz: number, yaw: number, pitch: number): Entity | null {
  const dx = Math.sin(yaw), dy = Math.cos(yaw); // horizontal map-forward unit vector
  const tanP = Math.tan(pitch); // height gained per unit of horizontal travel
  let best: Entity | null = null;
  let bestT = 4000;
  for (const e of state.entities) {
    if (!e.ai || !e.active || e.ai.state === "dead") continue;
    const rx = e.x - ox, ry = e.y - oy;
    const t = rx * dx + ry * dy; // horizontal distance along ray
    if (t <= 0 || t >= bestT) continue;
    const perp = Math.abs(rx * dy - ry * dx); // perpendicular offset
    if (perp > e.radius + AIM_TOLERANCE) continue;
    // Vertical check: ray height at this horizontal distance vs entity height column
    const rayZ = oz + t * tanP;
    if (rayZ < e.z || rayZ > e.z + e.height) continue;
    if (!hasSight(map, blockmap, ox, oy, e.x, e.y)) continue;
    best = e;
    bestT = t;
  }
  if (best) hurtMonster(best, PISTOL_DAMAGE);
  return best;
}

const SHOTGUN_PELLETS = 7;
const SHOTGUN_SPREAD = 0.0873; // approx 5 degrees in radians

export function fireShotgun(
  state: GameState, map: DoomMap, blockmap: Blockmap,
  ox: number, oy: number, oz: number, yaw: number, pitch: number
): Entity[] {
  const tanP = Math.tan(pitch);
  const hitSet = new Set<Entity>();
  const hits: Entity[] = [];
  for (let p = 0; p < SHOTGUN_PELLETS; p++) {
    const spread = (p / (SHOTGUN_PELLETS - 1) - 0.5) * 2 * SHOTGUN_SPREAD;
    const pelletYaw = yaw + spread;
    const pdx = Math.sin(pelletYaw), pdy = Math.cos(pelletYaw);
    let best: Entity | null = null, bestT = 4000;
    for (const e of state.entities) {
      if (!e.ai || !e.active || e.ai.state === "dead") continue;
      const rx = e.x - ox, ry = e.y - oy;
      const t = rx * pdx + ry * pdy;
      if (t <= 0 || t >= bestT) continue;
      const perp = Math.abs(rx * pdy - ry * pdx);
      if (perp > e.radius + 18) continue;
      const rayZ = oz + t * tanP;
      if (rayZ < e.z || rayZ > e.z + e.height) continue;
      if (!hasSight(map, blockmap, ox, oy, e.x, e.y)) continue;
      best = e; bestT = t;
    }
    if (best && !hitSet.has(best)) {
      hitSet.add(best);
      hurtMonster(best, 5 + (p * 3) % 10);
      hits.push(best);
    }
  }
  return hits;
}
