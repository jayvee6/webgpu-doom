/**
 * Player vs map collision (map-space, 2D). The player is a circle of PLAYER_RADIUS.
 * A linedef blocks movement if it's one-sided, flagged impassable, or — for a
 * two-sided line — the opening is too short to fit through or the step up is taller
 * than STEP_HEIGHT. Movement is axis-separated so the player slides along walls.
 */

import type { DoomMap } from "../wad/maps";

export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;
export const STEP_HEIGHT = 24;

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

/** Would a player circle at (x,y) overlap any solid line? `pf` = current floor height. */
export function blocked(map: DoomMap, x: number, y: number, pf: number, radius = PLAYER_RADIUS): boolean {
  const r2 = radius * radius;
  for (let i = 0; i < map.linedefs.length; i++) {
    const ld = map.linedefs[i]!;
    const a = map.vertexes[ld.v1];
    const b = map.vertexes[ld.v2];
    if (!a || !b) continue;
    if (distSqPointSeg(x, y, a.x, a.y, b.x, b.y) >= r2) continue;
    if (solidLine(map, i, pf)) return true;
  }
  return false;
}

function distSqPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}
