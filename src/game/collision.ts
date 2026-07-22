/**
 * Player vs map collision (map-space, 2D). The player is a circle of PLAYER_RADIUS.
 * A linedef blocks movement if it's one-sided, flagged impassable, or — for a
 * two-sided line — the opening is too short to fit through or the step up is taller
 * than STEP_HEIGHT. Movement is axis-separated so the player slides along walls.
 */

import type { DoomMap } from "../wad/maps";
import type { Entity } from "./state"; // type-only → erased at compile, no runtime import cycle

export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;
export const STEP_HEIGHT = 24;
// Upper bound on any blocking entity's radius (monsters are 20, player 16). Used to
// size the broadphase query so no potential overlapper is missed; the precise test
// below uses each entity's actual radius, so over-querying only costs a few candidates.
const MAX_BLOCKER_RADIUS = 32;

const ML_BLOCKING = 0x0001;

/** Is this linedef solid for a player currently standing at floor height `pf`? */
export function solidLine(map: DoomMap, lineIdx: number, pf: number): boolean {
  const ld = map.linedefs[lineIdx]!;
  if (ld.flags & ML_BLOCKING) return true;
  const front = ld.right >= 0 ? map.sectors[map.sidedefs[ld.right]!.sector] : undefined;
  const back = ld.left >= 0 ? map.sectors[map.sidedefs[ld.left]!.sector] : undefined;
  if (!front || !back) return true; // one-sided wall
  const topFloor = Math.max(front.floorHeight, back.floorHeight);
  const botCeil = Math.min(front.ceilHeight, back.ceilHeight);
  if (botCeil - topFloor < PLAYER_HEIGHT) return true; // opening too short (incl. closed doors)
  if (topFloor - pf > STEP_HEIGHT) return true; // step too high to climb
  return false;
}

/**
 * Would a player circle at (x,y) overlap any solid line? `pf` = current floor.
 * Pass `lineIdxs` (e.g. from a blockmap) to test only nearby lines; omit to scan all.
 */
export function blocked(map: DoomMap, x: number, y: number, pf: number, lineIdxs?: Iterable<number>, radius = PLAYER_RADIUS): boolean {
  const r2 = radius * radius;
  const test = (i: number): boolean => {
    const ld = map.linedefs[i]!;
    const a = map.vertexes[ld.v1];
    const b = map.vertexes[ld.v2];
    if (!a || !b) return false;
    if (distSqPointSeg(x, y, a.x, a.y, b.x, b.y) >= r2) return false;
    return solidLine(map, i, pf);
  };
  if (lineIdxs) {
    for (const i of lineIdxs) if (test(i)) return true;
  } else {
    for (let i = 0; i < map.linedefs.length; i++) if (test(i)) return true;
  }
  return false;
}

/** Living monsters and the player block movement; corpses, items, decor, projectiles don't. */
function isBlocker(e: Entity): boolean {
  if (e.kind === "player") return true;
  return !!e.ai && e.ai.state !== "dead";
}

/**
 * Would `mover` at candidate position (nx,ny) overlap any OTHER blocking entity?
 * Circle test on radii, gated by vertical overlap so things can pass over/under each
 * other (e.g. walk beneath a floating cacodemon, over a corpse).
 *
 * `queryNear` is the EntityGrid broadphase; its result is a SHARED array valid only
 * until the next query — this consumes it fully before returning, so callers must not
 * hold a prior query result across this call.
 */
export function blockedByEntity(
  queryNear: (x: number, y: number, r: number) => Entity[],
  mover: Entity, nx: number, ny: number,
): boolean {
  const r = mover.radius;
  const mz0 = mover.z, mz1 = mover.z + mover.height;
  for (const o of queryNear(nx, ny, r + MAX_BLOCKER_RADIUS)) {
    if (o === mover || !o.active || !isBlocker(o)) continue;
    if (mz1 <= o.z || o.z + o.height <= mz0) continue; // no vertical overlap → can pass
    const dx = nx - o.x, dy = ny - o.y;
    const rr = r + o.radius;
    if (dx * dx + dy * dy < rr * rr) return true;
  }
  return false;
}

export function distSqPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}
