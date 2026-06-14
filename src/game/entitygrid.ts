/**
 * Entity spatial hash — the broadphase for entity-centric queries (pickups now;
 * entity-vs-entity collision, projectile hits, and ranged line-of-sight when those
 * land). A uniform grid over map space, same 128-unit cell as the blockmap.
 *
 * Each entity is bucketed by its CENTRE into exactly one cell, so a multi-cell
 * query never sees an entity twice — no de-dup needed. Rebuilt once per fixed tick
 * (entities move every tick); query() returns a SHARED reusable array valid only
 * until the next query(), like blockmap.linesNear.
 */

import type { DoomMap } from "../wad/maps";
import type { Entity } from "./state";

const CELL = 128;

export class EntityGrid {
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: Entity[][];
  private readonly result: Entity[] = [];

  constructor(map: DoomMap) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of map.vertexes) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
    this.rows = Math.max(1, Math.ceil((maxY - minY) / CELL) + 1);
    this.cells = Array.from({ length: this.cols * this.rows }, () => [] as Entity[]);
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / CELL)));
  }
  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.minY) / CELL)));
  }

  /** Re-bucket every active entity. Call once at the top of each fixed tick. */
  rebuild(entities: Entity[]): void {
    for (const b of this.cells) b.length = 0;
    for (const e of entities) {
      if (!e.active) continue;
      this.cells[this.row(e.y) * this.cols + this.col(e.x)]!.push(e);
    }
  }

  /**
   * Active entities whose centres fall in cells overlapping the circle (x,y,radius).
   * A broadphase candidate set — callers do the precise distance test. Returns a
   * SHARED array valid only until the next query().
   */
  query(x: number, y: number, radius: number): Entity[] {
    const out = this.result;
    out.length = 0;
    const c0 = this.col(x - radius), c1 = this.col(x + radius);
    const r0 = this.row(y - radius), r1 = this.row(y + radius);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const bucket = this.cells[r * this.cols + c]!;
        for (const e of bucket) out.push(e);
      }
    }
    return out;
  }
}
