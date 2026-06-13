/**
 * Monster behavior: a small finite state machine (idle → chase → attack → pain →
 * dead) driving the entities built in GameState. Movement is Doom's model —
 * greedy seek toward the player using the existing line collision + blockmap, no
 * pathfinding. Monsters wake on line-of-sight, chase, melee on contact, animate
 * walk frames while moving, and play their death-frame run when killed. Runs in
 * the fixed timestep, so behavior is frame-rate-independent.
 *
 * NOTE: monsters don't yet block the player or each other (entity-vs-entity
 * collision isn't implemented) — they collide only with walls.
 */

import type { DoomMap, Linedef } from "../wad/maps";
import type { Blockmap } from "./blockmap";
import type { Entity } from "./state";
import { blocked } from "./collision";
import { locateSector } from "../wad/bsp";

const SIGHT_RANGE = 1400;
const ATTACK_RANGE = 52; // melee reach beyond the monster radius
const MONSTER_SPEED = 170; // units/sec
const WALK_FRAME_TIME = 0.16;
const DEATH_FRAME_TIME = 0.14;
const MELEE_DAMAGE = 9;
const ATTACK_COOLDOWN = 1.1; // s
const PAIN_TIME = 0.12;

export interface AIContext {
  map: DoomMap;
  blockmap: Blockmap;
  px: number; // player map x
  py: number; // player map y
  damagePlayer: (amount: number) => void;
  playSound: (name: string, x: number, y: number) => void;
}

type SoundKind = "sight" | "pain" | "death" | "melee";
// Per-monster Doom SFX (one variant each); fallback = imp.
const SOUNDS: Record<string, Record<SoundKind, string>> = {
  POSS: { sight: "DSPOSIT1", pain: "DSPOPAIN", death: "DSPODTH1", melee: "DSPISTOL" },
  SPOS: { sight: "DSPOSIT2", pain: "DSPOPAIN", death: "DSPODTH2", melee: "DSSHOTGN" },
  CPOS: { sight: "DSPOSIT3", pain: "DSPOPAIN", death: "DSPODTH3", melee: "DSSHOTGN" },
  TROO: { sight: "DSBGSIT1", pain: "DSPOPAIN", death: "DSBGDTH1", melee: "DSCLAW" },
  SARG: { sight: "DSSGTSIT", pain: "DSDMPAIN", death: "DSSGTDTH", melee: "DSSGTATK" },
  HEAD: { sight: "DSCACSIT", pain: "DSDMPAIN", death: "DSCACDTH", melee: "DSCLAW" },
  BOSS: { sight: "DSBRSSIT", pain: "DSDMPAIN", death: "DSBRSDTH", melee: "DSCLAW" },
  SKUL: { sight: "DSSKLATK", pain: "DSDMPAIN", death: "DSFIRXPL", melee: "DSSKLATK" },
};
const FALLBACK = SOUNDS.TROO!;

export function monsterSound(sprite: string, kind: SoundKind): string {
  return (SOUNDS[sprite] ?? FALLBACK)[kind];
}

export function updateEntities(entities: Entity[], dt: number, ctx: AIContext): void {
  for (const e of entities) {
    if (e.kind === "monster" && e.active) updateMonster(e, dt, ctx);
  }
}

function updateMonster(e: Entity, dt: number, ctx: AIContext): void {
  e.cooldown -= dt;

  if (e.mstate === "dead") { advanceDeath(e, dt); return; }
  if (e.mstate === "pain") {
    e.animT += dt;
    if (e.animT > PAIN_TIME) e.mstate = "chase";
  }

  const dx = ctx.px - e.x, dy = ctx.py - e.y;
  const dist = Math.hypot(dx, dy) || 1;

  if (e.mstate === "idle") {
    if (dist < SIGHT_RANGE && hasSight(ctx.map, ctx.blockmap, e.x, e.y, ctx.px, ctx.py)) {
      e.mstate = "chase";
      ctx.playSound(monsterSound(e.sprite4, "sight"), e.x, e.y);
    } else return;
  }

  e.angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  if (dist <= e.radius + ATTACK_RANGE) {
    e.mstate = "attack";
    if (e.cooldown <= 0) {
      ctx.damagePlayer(MELEE_DAMAGE);
      ctx.playSound(monsterSound(e.sprite4, "melee"), e.x, e.y);
      e.cooldown = ATTACK_COOLDOWN;
    }
  } else {
    e.mstate = "chase";
    const sp = MONSTER_SPEED * dt;
    const nx = e.x + (dx / dist) * sp, ny = e.y + (dy / dist) * sp;
    const near = ctx.blockmap.linesNear(e.x, e.y, e.radius + 48);
    if (!blocked(ctx.map, nx, e.y, e.z, near, e.radius)) e.x = nx;
    if (!blocked(ctx.map, e.x, ny, e.z, near, e.radius)) e.y = ny;
    const sec = locateSector(ctx.map, e.x, e.y);
    if (sec >= 0) e.z = ctx.map.sectors[sec]!.floorHeight; // stick to the floor
  }
  advanceWalk(e, dt);
}

function advanceWalk(e: Entity, dt: number): void {
  if (e.walkFrames.length <= 1) { setFrame(e, e.walkFrames[0]); return; }
  e.animT += dt;
  if (e.animT >= WALK_FRAME_TIME) {
    e.animT = 0;
    e.animI = (e.animI + 1) % e.walkFrames.length;
    setFrame(e, e.walkFrames[e.animI]);
  }
}

function advanceDeath(e: Entity, dt: number): void {
  if (e.deathFrames.length === 0) return;
  e.animT += dt;
  if (e.animI < e.deathFrames.length - 1 && e.animT >= DEATH_FRAME_TIME) {
    e.animT = 0;
    e.animI++;
    setFrame(e, e.deathFrames[e.animI]);
  }
}

function setFrame(e: Entity, f: string | undefined): void {
  if (!f) return;
  const l = e.frameLumps[f];
  if (l) { e.frame = f; e.lump = l; }
}

/** Apply damage to a monster; transition to pain or death. */
export function hurtMonster(e: Entity, amount: number): void {
  if (e.mstate === "dead") return;
  e.health -= amount;
  if (e.health <= 0) {
    e.mstate = "dead";
    e.animT = 0; e.animI = 0;
    if (e.deathFrames.length > 0) setFrame(e, e.deathFrames[0]);
    else e.active = false; // no death sprite → vanish
  } else {
    e.mstate = "pain";
    e.animT = 0;
  }
}

/** True if no sight-blocking line lies between (ax,ay) and (bx,by). */
export function hasSight(map: DoomMap, blockmap: Blockmap, ax: number, ay: number, bx: number, by: number): boolean {
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const r = Math.hypot(bx - ax, by - ay) / 2 + 32;
  for (const i of blockmap.linesNear(mx, my, r)) {
    const ld = map.linedefs[i]!;
    if (!blocksSight(map, ld)) continue;
    const a = map.vertexes[ld.v1], b = map.vertexes[ld.v2];
    if (!a || !b) continue;
    if (segCross(ax, ay, bx, by, a.x, a.y, b.x, b.y)) return false;
  }
  return true;
}

function blocksSight(map: DoomMap, ld: Linedef): boolean {
  const front = ld.right >= 0 ? map.sectors[map.sidedefs[ld.right]!.sector] : undefined;
  const back = ld.left >= 0 ? map.sectors[map.sidedefs[ld.left]!.sector] : undefined;
  if (!front || !back) return true; // one-sided wall
  return Math.min(front.ceilHeight, back.ceilHeight) <= Math.max(front.floorHeight, back.floorHeight);
}

function segCross(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (d === 0) return false;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
