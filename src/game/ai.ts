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
import type { Entity, MonsterAI } from "./state";
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

/** Monsters in this set throw projectiles; others are melee-only. */
const RANGED_MONSTERS = new Set(["TROO"]);

export interface AIContext {
  map: DoomMap;
  blockmap: Blockmap;
  px: number; // player map x
  py: number; // player map y
  damagePlayer: (amount: number) => void;
  playSound: (name: string, x: number, y: number) => void;
  /** Resolved sprite lump per ranged monster sprite4 (pre-built at level load). */
  projLumpFor?: Map<string, string>;
  /** Callback to push a new projectile entity this tick. */
  spawnProjectile?: (x: number, y: number, z: number, vx: number, vy: number, lump: string, damage: number) => void;
  /** Broadphase spatial query (from EntityGrid) for monster-vs-monster separation. */
  queryNear?: (x: number, y: number, radius: number) => import("./state").Entity[];
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

/** Monster system: advance every entity that has an AI sub-object. */
export function updateEntities(entities: Entity[], dt: number, ctx: AIContext): void {
  for (const e of entities) {
    if (e.ai && e.active) updateMonster(e, e.ai, dt, ctx);
  }
}

function updateMonster(e: Entity, ai: MonsterAI, dt: number, ctx: AIContext): void {
  ai.cooldown -= dt;

  if (ai.state === "dead") { advanceDeath(e, ai, dt); return; }
  if (ai.state === "pain") {
    // Brief stun: advance only the pain timer and bail, so we don't fall through
    // to movement + advanceWalk (which shares animT and would clobber this timer).
    ai.animT += dt;
    if (ai.animT > PAIN_TIME) { ai.state = "chase"; ai.animT = 0; }
    return;
  }

  const dx = ctx.px - e.x, dy = ctx.py - e.y;
  const dist = Math.hypot(dx, dy) || 1;

  if (ai.state === "idle") {
    if (dist < SIGHT_RANGE && hasSight(ctx.map, ctx.blockmap, e.x, e.y, ctx.px, ctx.py)) {
      ai.state = "chase";
      ctx.playSound(monsterSound(ai.sprite4, "sight"), e.x, e.y);
    } else return;
  }

  e.angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  if (dist <= e.radius + ATTACK_RANGE) {
    ai.state = "attack";
    if (ai.cooldown <= 0) {
      ctx.damagePlayer(MELEE_DAMAGE);
      ctx.playSound(monsterSound(ai.sprite4, "melee"), e.x, e.y);
      ai.cooldown = ATTACK_COOLDOWN;
    }
  } else {
    ai.state = "chase";
    const sp = MONSTER_SPEED * dt;
    const nx = e.x + (dx / dist) * sp, ny = e.y + (dy / dist) * sp;
    const near = ctx.blockmap.linesNear(e.x, e.y, e.radius + 48);
    if (!blocked(ctx.map, nx, e.y, e.z, near, e.radius)) e.x = nx;
    if (!blocked(ctx.map, e.x, ny, e.z, near, e.radius)) e.y = ny;
    const sec = locateSector(ctx.map, e.x, e.y);
    if (sec >= 0) { e.z = ctx.map.sectors[sec]!.floorHeight; e.sector = sec; }

    // Push-apart: separate from overlapping monsters so they don't stack.
    if (ctx.queryNear) {
      for (const other of ctx.queryNear(e.x, e.y, e.radius * 3)) {
        if (other === e || !other.ai || !other.active) continue;
        const odx = e.x - other.x, ody = e.y - other.y;
        const dist = Math.hypot(odx, ody) || 1;
        const minDist = e.radius + other.radius;
        if (dist < minDist) {
          const push = (minDist - dist) * 0.5;
          e.x += (odx / dist) * push;
          e.y += (ody / dist) * push;
        }
      }
    }

    // Ranged attack while chasing: throw a projectile when in sight + off cooldown.
    if (
      ai.cooldown <= 0 &&
      RANGED_MONSTERS.has(ai.sprite4) &&
      ctx.spawnProjectile &&
      ctx.projLumpFor?.has(ai.sprite4) &&
      hasSight(ctx.map, ctx.blockmap, e.x, e.y, ctx.px, ctx.py)
    ) {
      const lump = ctx.projLumpFor.get(ai.sprite4)!;
      const speed = 350; // PROJ_SPEED — can't import to avoid circular dep
      ctx.spawnProjectile(e.x, e.y, e.z + 32, (dx / dist) * speed, (dy / dist) * speed, lump, 5 + Math.floor(Math.random() * 8));
      ai.cooldown = ATTACK_COOLDOWN + 0.3;
    }
  }
  advanceWalk(e, ai, dt);
}

function advanceWalk(e: Entity, ai: MonsterAI, dt: number): void {
  if (ai.walkFrames.length <= 1) { setFrame(e, ai, ai.walkFrames[0]); return; }
  ai.animT += dt;
  if (ai.animT >= WALK_FRAME_TIME) {
    ai.animT = 0;
    ai.animI = (ai.animI + 1) % ai.walkFrames.length;
    setFrame(e, ai, ai.walkFrames[ai.animI]);
  }
}

function advanceDeath(e: Entity, ai: MonsterAI, dt: number): void {
  if (ai.deathFrames.length === 0) return;
  ai.animT += dt;
  if (ai.animI < ai.deathFrames.length - 1 && ai.animT >= DEATH_FRAME_TIME) {
    ai.animT = 0;
    ai.animI++;
    setFrame(e, ai, ai.deathFrames[ai.animI]);
  }
}

function setFrame(e: Entity, ai: MonsterAI, f: string | undefined): void {
  if (!f) return;
  const l = ai.frameLumps[f];
  if (l) { ai.frame = f; e.lump = l; } // ai.frame tracks logic; e.lump is what the renderer draws
}

/** Apply damage to a monster; transition to pain or death. */
export function hurtMonster(e: Entity, amount: number): void {
  const ai = e.ai;
  if (!ai || ai.state === "dead") return;
  ai.health -= amount;
  if (ai.health <= 0) {
    ai.state = "dead";
    ai.animT = 0; ai.animI = 0;
    if (ai.deathFrames.length > 0) setFrame(e, ai, ai.deathFrames[0]);
    else e.active = false; // no death sprite → vanish
  } else {
    ai.state = "pain";
    ai.animT = 0;
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
