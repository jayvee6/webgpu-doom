/**
 * Build wall triangles with DYNAMIC-height vertices. Each vertex's Y is an index
 * into the live per-sector heights buffer (sector*2 + 0=floor / 1=ceil) rather
 * than a baked value, so walls follow doors/lifts automatically.
 *
 * Vertex (10 f32): x, z, heightIndex, lightSector, u, vBase(=yOff), vTop,
 * vMode(=1 wall), contrast, texId. Light is looked up live from the sector-light
 * buffer (so light specials animate it); `contrast` is the per-wall fake-contrast
 * offset added in the shader. V = vBase + (vTop - worldY) for walls.
 *
 * Initial heights decide whether a portion is emitted (skip degenerate spans).
 */

import type { DoomMap, Sector, Sidedef, Vertex } from "../wad/maps";

export interface WallMesh {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}

export type TexId = (name: string) => number;

const FLOOR = 0, CEIL = 1;
const hIndex = (sectorIdx: number, which: 0 | 1) => sectorIdx * 2 + which;

export function buildWalls(map: DoomMap, tid: TexId): WallMesh {
  const verts: number[] = [];
  const indices: number[] = [];

  const quad = (
    a: Vertex, b: Vertex, yBottom: number, yTop: number,
    botH: number, topH: number, vTop: number,
    lightSec: number, contrast: number, texId: number, xOff: number, yOff: number,
  ): void => {
    if (yTop <= yBottom || texId < 0) return;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const uA = xOff, uB = xOff + len;
    const ax = a.x, az = -a.y, bx = b.x, bz = -b.y;
    const base = verts.length / 10;
    // 4 unique corners: Ab, Bb, Bt, At
    pushV(verts, ax, az, botH, lightSec, uA, yOff, vTop, contrast, texId);
    pushV(verts, bx, bz, botH, lightSec, uB, yOff, vTop, contrast, texId);
    pushV(verts, bx, bz, topH, lightSec, uB, yOff, vTop, contrast, texId);
    pushV(verts, ax, az, topH, lightSec, uA, yOff, vTop, contrast, texId);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (const ld of map.linedefs) {
    const a = map.vertexes[ld.v1];
    const b = map.vertexes[ld.v2];
    if (!a || !b) continue;

    const frontIdx = ld.right >= 0 ? map.sidedefs[ld.right]!.sector : -1;
    const backIdx = ld.left >= 0 ? map.sidedefs[ld.left]!.sector : -1;
    const frontSide: Sidedef | undefined = ld.right >= 0 ? map.sidedefs[ld.right] : undefined;
    const backSide: Sidedef | undefined = ld.left >= 0 ? map.sidedefs[ld.left] : undefined;
    const frontSec: Sector | undefined = frontIdx >= 0 ? map.sectors[frontIdx] : undefined;
    const backSec: Sector | undefined = backIdx >= 0 ? map.sectors[backIdx] : undefined;

    const contrast = b.y - a.y === 0 ? 0.08 : b.x - a.x === 0 ? -0.08 : 0;

    if (frontSec && !backSec && frontSide) {
      quad(a, b, frontSec.floorHeight, frontSec.ceilHeight,
        hIndex(frontIdx, FLOOR), hIndex(frontIdx, CEIL), frontSec.ceilHeight,
        frontIdx, contrast, tid(frontSide.middle), frontSide.xOffset, frontSide.yOffset);
    } else if (backSec && !frontSec && backSide) {
      quad(a, b, backSec.floorHeight, backSec.ceilHeight,
        hIndex(backIdx, FLOOR), hIndex(backIdx, CEIL), backSec.ceilHeight,
        backIdx, contrast, tid(backSide.middle), backSide.xOffset, backSide.yOffset);
    } else if (frontSec && backSec && frontSide && backSide) {
      // lower step
      if (frontSec.floorHeight !== backSec.floorHeight) {
        const frontLower = frontSec.floorHeight < backSec.floorHeight;
        const lo = Math.min(frontSec.floorHeight, backSec.floorHeight);
        const hi = Math.max(frontSec.floorHeight, backSec.floorHeight);
        const lowIdx = frontLower ? frontIdx : backIdx;
        const highIdx = frontLower ? backIdx : frontIdx;
        const side = frontLower ? frontSide : backSide;
        quad(a, b, lo, hi, hIndex(lowIdx, FLOOR), hIndex(highIdx, FLOOR), hi,
          lowIdx, contrast, tid(side.lower), side.xOffset, side.yOffset);
      }
      // upper step
      if (frontSec.ceilHeight !== backSec.ceilHeight) {
        const frontHigher = frontSec.ceilHeight > backSec.ceilHeight;
        const lo = Math.min(frontSec.ceilHeight, backSec.ceilHeight);
        const hi = Math.max(frontSec.ceilHeight, backSec.ceilHeight);
        const lowIdx = frontHigher ? backIdx : frontIdx;
        const highIdx = frontHigher ? frontIdx : backIdx;
        const side = frontHigher ? frontSide : backSide;
        quad(a, b, lo, hi, hIndex(lowIdx, CEIL), hIndex(highIdx, CEIL), hi,
          highIdx, contrast, tid(side.upper), side.xOffset, side.yOffset);
      }
    }
  }

  return { vertices: new Float32Array(verts), indices: new Uint32Array(indices) };
}

/** x, z, hIdx, lightSec, u, vBase, vTop, vMode(=1 wall), contrast, texId */
function pushV(out: number[], x: number, z: number, h: number, lightSec: number, u: number, vBase: number, vTop: number, contrast: number, texId: number): void {
  out.push(x, z, h, lightSec, u, vBase, vTop, 1, contrast, texId);
}
