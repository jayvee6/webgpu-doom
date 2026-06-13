/**
 * Build wall triangles with DYNAMIC-height vertices. Each vertex's Y is an index
 * into the live per-sector heights buffer (sector*2 + 0=floor / 1=ceil) rather
 * than a baked value, so walls follow doors/lifts automatically.
 *
 * Vertex (9 f32): x, z, heightIndex, u, vBase(=yOff), vTop, vMode(=1 wall), light, texId.
 * V is computed in the shader as vBase + (vTop - worldY); vTop is the wall's
 * (initial) top height, so top-pegged textures (doors) stay aligned as they move.
 *
 * Initial heights decide whether a portion is emitted (skip degenerate spans).
 */

import type { DoomMap, Sector, Sidedef, Vertex } from "../wad/maps";

export interface WallMesh {
  data: Float32Array<ArrayBuffer>;
  vertexCount: number;
}

export type TexId = (name: string) => number;

const FLOOR = 0, CEIL = 1;
const hIndex = (sectorIdx: number, which: 0 | 1) => sectorIdx * 2 + which;

export function buildWalls(map: DoomMap, tid: TexId): WallMesh {
  const out: number[] = [];

  const quad = (
    a: Vertex, b: Vertex, yBottom: number, yTop: number,
    botH: number, topH: number, vTop: number,
    light: number, texId: number, xOff: number, yOff: number,
  ): void => {
    if (yTop <= yBottom || texId < 0) return;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const uA = xOff, uB = xOff + len;
    const ax = a.x, az = -a.y, bx = b.x, bz = -b.y;
    //            x   z  hIdx  u   vBase
    const Ab = [ax, az, botH, uA, yOff];
    const Bb = [bx, bz, botH, uB, yOff];
    const At = [ax, az, topH, uA, yOff];
    const Bt = [bx, bz, topH, uB, yOff];
    pushTri(out, Ab, Bb, Bt, vTop, light, texId);
    pushTri(out, Ab, Bt, At, vTop, light, texId);
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
    const lit = (sec: Sector) => Math.max(0, Math.min(1, sec.light / 255 + contrast));

    if (frontSec && !backSec && frontSide) {
      quad(a, b, frontSec.floorHeight, frontSec.ceilHeight,
        hIndex(frontIdx, FLOOR), hIndex(frontIdx, CEIL), frontSec.ceilHeight,
        lit(frontSec), tid(frontSide.middle), frontSide.xOffset, frontSide.yOffset);
    } else if (backSec && !frontSec && backSide) {
      quad(a, b, backSec.floorHeight, backSec.ceilHeight,
        hIndex(backIdx, FLOOR), hIndex(backIdx, CEIL), backSec.ceilHeight,
        lit(backSec), tid(backSide.middle), backSide.xOffset, backSide.yOffset);
    } else if (frontSec && backSec && frontSide && backSide) {
      // lower step
      if (frontSec.floorHeight !== backSec.floorHeight) {
        const frontLower = frontSec.floorHeight < backSec.floorHeight;
        const lo = Math.min(frontSec.floorHeight, backSec.floorHeight);
        const hi = Math.max(frontSec.floorHeight, backSec.floorHeight);
        const lowIdx = frontLower ? frontIdx : backIdx;
        const highIdx = frontLower ? backIdx : frontIdx;
        const side = frontLower ? frontSide : backSide;
        const sec = frontLower ? frontSec : backSec;
        quad(a, b, lo, hi, hIndex(lowIdx, FLOOR), hIndex(highIdx, FLOOR), hi,
          lit(sec), tid(side.lower), side.xOffset, side.yOffset);
      }
      // upper step
      if (frontSec.ceilHeight !== backSec.ceilHeight) {
        const frontHigher = frontSec.ceilHeight > backSec.ceilHeight;
        const lo = Math.min(frontSec.ceilHeight, backSec.ceilHeight);
        const hi = Math.max(frontSec.ceilHeight, backSec.ceilHeight);
        const lowIdx = frontHigher ? backIdx : frontIdx;
        const highIdx = frontHigher ? frontIdx : backIdx;
        const side = frontHigher ? frontSide : backSide;
        const sec = frontHigher ? frontSec : backSec;
        quad(a, b, lo, hi, hIndex(lowIdx, CEIL), hIndex(highIdx, CEIL), hi,
          lit(sec), tid(side.upper), side.xOffset, side.yOffset);
      }
    }
  }

  return { data: new Float32Array(out), vertexCount: out.length / 9 };
}

function pushTri(out: number[], p0: number[], p1: number[], p2: number[], vTop: number, light: number, texId: number): void {
  for (const p of [p0, p1, p2]) {
    // x, z, hIdx, u, vBase, vTop, vMode(=1 wall), light, texId
    out.push(p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, vTop, 1, light, texId);
  }
}
