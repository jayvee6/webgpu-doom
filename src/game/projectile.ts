/**
 * Projectile system — in-flight entities spawned by monster ranged attacks.
 * Lives in state.entities[] alongside monsters/items; proj presence is the
 * discriminant. updateProjectiles() runs each fixed tick after updateEntities().
 *
 * Projectiles are 2D movers (wall collision only — no floor/ceiling clipping).
 * On hit they immediately deactivate (no explosion sprite yet).
 */

import type { DoomMap } from "../wad/maps";
import type { Blockmap } from "./blockmap";
import type { Entity } from "./state";
import { blocked } from "./collision";
import { hurtMonster } from "./ai";

export const PROJ_SPEED = 350; // map units/sec (Doom: 10 units/tic × 35 tics/s)

/**
 * [sprite4, sprite, frame] tuples for every projectile variant. Exported so
 * main.ts can pre-register these lumps in the sprite atlas at level load time
 * (projectile entities are spawned dynamically, not from map Things).
 */
export const PROJ_SPRITES: Array<[sprite4: string, sprite: string, frame: string]> = [
  ["TROO", "BAL1", "A"],
  ["TROO", "BAL1", "B"],
];

export interface ProjectileState {
  vx: number; // map x velocity (units/sec)
  vy: number; // map y velocity (units/sec)
  damage: number;
  radius: number;
}

export interface ProjectileCtx {
  map: DoomMap;
  blockmap: Blockmap;
  px: number; // player map x
  py: number; // player map y
  /** Broadphase spatial query — typically entityGrid.query(). */
  queryNear: (x: number, y: number, radius: number) => Entity[];
  damagePlayer: (amount: number) => void;
  playSound: (name: string, x: number, y: number) => void;
}

/** Append a new projectile entity into the shared entity list. */
export function spawnProjectile(
  entities: Entity[],
  x: number, y: number, z: number,
  vx: number, vy: number,
  lump: string,
  damage: number,
): void {
  entities.push({
    kind: "decor", type: 0,
    x, y, z, sector: -1, angle: 0, light: 1,
    radius: 10, height: 8, lump, active: true,
    proj: { vx, vy, damage, radius: 10 },
  });
}

/**
 * Advance every active projectile one fixed tick. Snapshot the entity count at
 * entry so projectiles spawned this tick (by monster attacks) are not processed
 * until the next tick.
 */
export function updateProjectiles(entities: Entity[], dt: number, ctx: ProjectileCtx): void {
  const n = entities.length;
  for (let i = 0; i < n; i++) {
    const e = entities[i]!;
    if (!e.proj || !e.active) continue;
    const p = e.proj;
    const nx = e.x + p.vx * dt;
    const ny = e.y + p.vy * dt;

    // Wall collision: check x and y moves independently so projectiles can slide
    // into corners rather than bouncing at 45°. Use current z as the floor ref.
    const near = ctx.blockmap.linesNear(e.x, e.y, p.radius + 64);
    if (blocked(ctx.map, nx, e.y, e.z, near, p.radius) ||
        blocked(ctx.map, e.x, ny, e.z, near, p.radius)) {
      e.active = false;
      ctx.playSound("DSBAREXP", e.x, e.y);
      continue;
    }
    e.x = nx;
    e.y = ny;

    // Player hit.
    if (Math.hypot(e.x - ctx.px, e.y - ctx.py) < p.radius + 16) {
      e.active = false;
      ctx.damagePlayer(p.damage);
      ctx.playSound("DSBAREXP", e.x, e.y);
      continue;
    }

    // Monster hit — broadphase then precise radius test.
    for (const target of ctx.queryNear(e.x, e.y, p.radius + 48)) {
      if (!target.ai || !target.active || target.ai.state === "dead") continue;
      if (Math.hypot(target.x - e.x, target.y - e.y) < p.radius + target.radius) {
        e.active = false;
        hurtMonster(target, p.damage);
        ctx.playSound("DSBAREXP", e.x, e.y);
        break;
      }
    }
  }
}
