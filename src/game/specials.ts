/**
 * Line specials → animated sectors (doors, lifts, moving floors, exit).
 *
 * Animations mutate `map.sectors[].floorHeight/ceilHeight` directly — the single
 * source of truth, so both the GPU heights buffer and collision see live values.
 * Each animated sector runs a small phase list (move to a target, optionally wait,
 * repeat). Covers exactly the specials E1M1 uses: 1/26/117 manual doors,
 * 2 walkover door-open, 88 walkover lift, 62 switch lift, 23 switch floor-lower,
 * 11 exit. Locked doors (26) are treated as openable (no key inventory yet).
 */

import type { DoomMap } from "../wad/maps";

const DOOR_SPEED = 110; // units/sec
const BLAZE_SPEED = 260;
const LIFT_SPEED = 140;
const DOOR_WAIT = 4; // s before auto-close
const LIFT_WAIT = 3;

interface Phase { target: number; wait: number }
interface Mover {
  sector: number;
  field: "floorHeight" | "ceilHeight";
  speed: number;
  phases: Phase[];
  idx: number;
  waiting: boolean;
  waitLeft: number;
}

/** Specials that respond to Use (spacebar). */
export const USABLE = new Set([1, 26, 117, 31, 62, 23, 11, 103, 63, 61, 42, 29]);
/** Specials that respond to walking across the line. */
export const WALKOVER = new Set([2, 88, 4, 10, 16, 109, 90, 86]);

export class MapState {
  private readonly map: DoomMap;
  private readonly movers = new Map<number, Mover>();
  private readonly triggered = new Set<number>(); // once-only line indices
  private readonly _heights: Float32Array<ArrayBuffer>;
  onExit: (() => void) | null = null;
  onSound: ((name: string, x: number, y: number) => void) | null = null;

  constructor(map: DoomMap) {
    this.map = map;
    this._heights = new Float32Array(map.sectors.length * 2);
  }

  private playAt(sector: number, name: string): void {
    if (!this.onSound) return;
    let sx = 0, sy = 0, n = 0;
    for (const ld of this.map.linedefs) {
      const f = ld.right >= 0 ? this.map.sidedefs[ld.right]!.sector : -1;
      const b = ld.left >= 0 ? this.map.sidedefs[ld.left]!.sector : -1;
      if (f === sector || b === sector) { const v = this.map.vertexes[ld.v1]!; sx += v.x; sy += v.y; n++; }
    }
    if (n > 0) this.onSound(name, sx / n, sy / n);
  }

  /** Live heights for the GPU (floor=i*2, ceil=i*2+1), rebuilt from sectors. */
  heights(): Float32Array<ArrayBuffer> {
    const s = this.map.sectors;
    for (let i = 0; i < s.length; i++) {
      this._heights[i * 2] = s[i]!.floorHeight;
      this._heights[i * 2 + 1] = s[i]!.ceilHeight;
    }
    return this._heights;
  }

  get activeCount(): number {
    return this.movers.size;
  }

  update(dt: number): void {
    for (const [sector, m] of this.movers) {
      if (this.advance(m, dt)) this.movers.delete(sector);
    }
  }

  private advance(m: Mover, dt: number): boolean {
    if (m.waiting) {
      m.waitLeft -= dt;
      if (m.waitLeft <= 0) { m.waiting = false; m.idx++; if (m.idx >= m.phases.length) return true; }
      return false;
    }
    const cur = m.phases[m.idx]!;
    const sec = this.map.sectors[m.sector]!;
    let h = sec[m.field];
    const step = m.speed * dt;
    h = h < cur.target ? Math.min(cur.target, h + step) : Math.max(cur.target, h - step);
    sec[m.field] = h;
    if (h === cur.target) {
      if (cur.wait > 0) { m.waiting = true; m.waitLeft = cur.wait; }
      else { m.idx++; if (m.idx >= m.phases.length) return true; }
    }
    return false;
  }

  /** Spacebar use on a line. */
  useLine(lineIdx: number): boolean {
    const ld = this.map.linedefs[lineIdx]!;
    // Switch click sound (lifts/floors/exit are switches, not doors).
    if (this.onSound && [62, 61, 103, 63, 23, 29, 42, 11].includes(ld.special)) {
      const v = this.map.vertexes[ld.v1]!;
      this.onSound("DSSWTCHN", v.x, v.y);
    }
    switch (ld.special) {
      case 1: case 26: case 31: return this.manualDoor(ld.left, DOOR_SPEED);
      case 117: return this.manualDoor(ld.left, BLAZE_SPEED);
      case 11: this.onExit?.(); return true;
      case 62: case 61: return this.taggedOnce(false, ld.tag, (s) => this.lift(s)); // SR
      case 103: case 63: return this.taggedOnce(false, ld.tag, (s) => this.openDoorStay(s));
      case 23: case 29: case 42: return this.taggedOnce(this.once(lineIdx), ld.tag, (s) => this.floorLowerToLowest(s));
      default: return false;
    }
  }

  /** Walking across a line. */
  crossLine(lineIdx: number): void {
    const ld = this.map.linedefs[lineIdx]!;
    switch (ld.special) {
      case 2: case 86: case 109: if (this.once(lineIdx)) this.tagged(ld.tag, (s) => this.openDoorStay(s)); break;
      case 88: case 90: this.tagged(ld.tag, (s) => this.lift(s)); break; // WR repeatable
      case 4: case 10: case 16: if (this.once(lineIdx)) this.tagged(ld.tag, (s) => this.lift(s)); break;
    }
  }

  private once(lineIdx: number): boolean {
    if (this.triggered.has(lineIdx)) return false;
    this.triggered.add(lineIdx);
    return true;
  }

  private taggedOnce(consumed: boolean, tag: number, fn: (s: number) => void): boolean {
    if (consumed) return false;
    return this.tagged(tag, fn);
  }

  private tagged(tag: number, fn: (s: number) => void): boolean {
    if (tag === 0) return false;
    let any = false;
    for (let i = 0; i < this.map.sectors.length; i++) {
      if (this.map.sectors[i]!.tag === tag) { fn(i); any = true; }
    }
    return any;
  }

  private manualDoor(backSide: number, speed: number): boolean {
    const sector = backSide >= 0 ? this.map.sidedefs[backSide]!.sector : -1;
    if (sector < 0 || this.movers.has(sector)) return false;
    const sec = this.map.sectors[sector]!;
    const open = this.lowestNeighborCeiling(sector) - 4;
    const closed = sec.floorHeight;
    // Open if (nearly) closed, else close. Auto-closes after a wait when opening.
    if (sec.ceilHeight <= closed + 8) {
      this.movers.set(sector, { sector, field: "ceilHeight", speed, idx: 0, waiting: false, waitLeft: 0, phases: [{ target: open, wait: DOOR_WAIT }, { target: closed, wait: 0 }] });
      this.playAt(sector, "DSDOROPN");
    } else {
      this.movers.set(sector, { sector, field: "ceilHeight", speed, idx: 0, waiting: false, waitLeft: 0, phases: [{ target: closed, wait: 0 }] });
      this.playAt(sector, "DSDORCLS");
    }
    return true;
  }

  private openDoorStay(sector: number): void {
    if (this.movers.has(sector)) return;
    const open = this.lowestNeighborCeiling(sector) - 4;
    this.movers.set(sector, { sector, field: "ceilHeight", speed: DOOR_SPEED, idx: 0, waiting: false, waitLeft: 0, phases: [{ target: open, wait: 0 }] });
    this.playAt(sector, "DSDOROPN");
  }

  private lift(sector: number): void {
    if (this.movers.has(sector)) return;
    const sec = this.map.sectors[sector]!;
    const top = sec.floorHeight;
    const low = this.lowestNeighborFloor(sector);
    if (low >= top) return; // nothing to lower to
    this.movers.set(sector, { sector, field: "floorHeight", speed: LIFT_SPEED, idx: 0, waiting: false, waitLeft: 0, phases: [{ target: low, wait: LIFT_WAIT }, { target: top, wait: 0 }] });
    this.playAt(sector, "DSPSTART");
  }

  private floorLowerToLowest(sector: number): void {
    if (this.movers.has(sector)) return;
    const low = this.lowestNeighborFloor(sector);
    this.movers.set(sector, { sector, field: "floorHeight", speed: LIFT_SPEED, idx: 0, waiting: false, waitLeft: 0, phases: [{ target: low, wait: 0 }] });
  }

  private neighbors(sector: number): number[] {
    const set = new Set<number>();
    for (const ld of this.map.linedefs) {
      const f = ld.right >= 0 ? this.map.sidedefs[ld.right]!.sector : -1;
      const b = ld.left >= 0 ? this.map.sidedefs[ld.left]!.sector : -1;
      if (f === sector && b >= 0) set.add(b);
      if (b === sector && f >= 0) set.add(f);
    }
    return [...set];
  }

  private lowestNeighborCeiling(sector: number): number {
    const ns = this.neighbors(sector);
    if (ns.length === 0) return this.map.sectors[sector]!.ceilHeight;
    return Math.min(...ns.map((n) => this.map.sectors[n]!.ceilHeight));
  }

  private lowestNeighborFloor(sector: number): number {
    const ns = this.neighbors(sector);
    if (ns.length === 0) return this.map.sectors[sector]!.floorHeight;
    return Math.min(...ns.map((n) => this.map.sectors[n]!.floorHeight));
  }
}
