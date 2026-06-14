/**
 * Blockmap collision broadphase. Buckets linedef indices into a uniform grid so
 * collision / use / walkover queries test only the lines near a point instead of
 * all ~1175 every frame. Built at load. This is the broadphase Doom ships
 * precisely so per-entity collision stays cheap as monsters/projectiles arrive.
 */

import type { DoomMap } from "../wad/maps";

const CELL = 128; // map units per cell (Doom's blockmap cell size)

export class Blockmap {
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][]; // cell index → linedef indices
  // De-dup scratch for linesNear: a per-linedef "last query" stamp + reusable
  // result array, so a hot per-entity/per-tick query allocates nothing.
  private readonly stamp: Int32Array;
  private queryGen = 0;
  private readonly result: number[] = [];

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
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
    this.stamp = new Int32Array(map.linedefs.length);

    // Add each linedef to every cell its bounding box overlaps (cheap + correct).
    for (let i = 0; i < map.linedefs.length; i++) {
      const ld = map.linedefs[i]!;
      const a = map.vertexes[ld.v1], b = map.vertexes[ld.v2];
      if (!a || !b) continue;
      const c0 = this.col(Math.min(a.x, b.x)), c1 = this.col(Math.max(a.x, b.x));
      const r0 = this.row(Math.min(a.y, b.y)), r1 = this.row(Math.max(a.y, b.y));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) this.cells[r * this.cols + c]!.push(i);
      }
    }
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / CELL)));
  }
  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.minY) / CELL)));
  }

  /**
   * Linedef indices in cells overlapping the circle (x,y,radius). De-duplicated.
   *
   * Returns a SHARED reusable array — valid only until the next linesNear() call.
   * Callers consume it immediately (iterate or pass to blocked()) and never hold it
   * across another query; none of the call sites overlap, so no copy is needed.
   */
  linesNear(x: number, y: number, radius: number): number[] {
    const c0 = this.col(x - radius), c1 = this.col(x + radius);
    const r0 = this.row(y - radius), r1 = this.row(y + radius);
    const gen = ++this.queryGen;
    const stamp = this.stamp, out = this.result;
    out.length = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const li of this.cells[r * this.cols + c]!) {
          if (stamp[li] !== gen) { stamp[li] = gen; out.push(li); }
        }
      }
    }
    return out;
  }
}
