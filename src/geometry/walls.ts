/**
 * Build textured wall triangles from linedefs/sidedefs.
 *
 * World mapping: worldPos = (map.x, height, -map.y).
 * Per linedef:
 *   - one-sided  → one solid wall (middle texture), front floor → ceiling
 *   - two-sided  → "lower" step (lower texture of the side with the lower floor)
 *                  and "upper" step (upper texture of the side with the higher
 *                  ceiling), each emitted once. Middle (mid-texture) skipped.
 *
 * Texture coords: U runs along the wall in map units (+ sidedef xOffset); V runs
 * downward from the region's top (+ yOffset). Pegging flags are approximated
 * (top-aligned) for now. Per-wall "fake contrast" (Doom's faked directional
 * shading) is baked into the light value.
 *
 * Vertex layout: position xyz · uv · light · texId (7 f32, 28-byte stride).
 */

import type { DoomMap, Sector, Sidedef, Vertex } from "../wad/maps";

export interface WallMesh {
  data: Float32Array<ArrayBuffer>;
  vertexCount: number;
}

export type TexId = (name: string) => number;

export function buildWalls(map: DoomMap, tid: TexId): WallMesh {
  const out: number[] = [];

  const quad = (
    a: Vertex, b: Vertex, yBottom: number, yTop: number,
    light: number, texId: number, xOff: number, yOff: number,
  ): void => {
    if (yTop <= yBottom || texId < 0) return;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const uA = xOff, uB = xOff + len;
    const vAt = (h: number) => yOff + (yTop - h);
    const ax = a.x, az = -a.y, bx = b.x, bz = -b.y;
    // corners: position + uv
    const Ab = [ax, yBottom, az, uA, vAt(yBottom)];
    const Bb = [bx, yBottom, bz, uB, vAt(yBottom)];
    const At = [ax, yTop, az, uA, vAt(yTop)];
    const Bt = [bx, yTop, bz, uB, vAt(yTop)];
    pushTri(out, Ab, Bb, Bt, light, texId);
    pushTri(out, Ab, Bt, At, light, texId);
  };

  for (const ld of map.linedefs) {
    const a = map.vertexes[ld.v1];
    const b = map.vertexes[ld.v2];
    if (!a || !b) continue;

    const frontSide: Sidedef | undefined = ld.right >= 0 ? map.sidedefs[ld.right] : undefined;
    const backSide: Sidedef | undefined = ld.left >= 0 ? map.sidedefs[ld.left] : undefined;
    const frontSec: Sector | undefined = frontSide ? map.sectors[frontSide.sector] : undefined;
    const backSec: Sector | undefined = backSide ? map.sectors[backSide.sector] : undefined;

    // Fake contrast: E-W lines brighter, N-S lines darker.
    const contrast = b.y - a.y === 0 ? 0.08 : b.x - a.x === 0 ? -0.08 : 0;
    const lit = (sec: Sector) => Math.max(0, Math.min(1, sec.light / 255 + contrast));

    if (frontSec && !backSec && frontSide) {
      quad(a, b, frontSec.floorHeight, frontSec.ceilHeight, lit(frontSec), tid(frontSide.middle), frontSide.xOffset, frontSide.yOffset);
    } else if (backSec && !frontSec && backSide) {
      quad(a, b, backSec.floorHeight, backSec.ceilHeight, lit(backSec), tid(backSide.middle), backSide.xOffset, backSide.yOffset);
    } else if (frontSec && backSec && frontSide && backSide) {
      // lower step: textured by the side standing in the lower-floored sector
      if (frontSec.floorHeight !== backSec.floorHeight) {
        const lo = Math.min(frontSec.floorHeight, backSec.floorHeight);
        const hi = Math.max(frontSec.floorHeight, backSec.floorHeight);
        const lowSide = frontSec.floorHeight < backSec.floorHeight ? frontSide : backSide;
        const lowSec = frontSec.floorHeight < backSec.floorHeight ? frontSec : backSec;
        quad(a, b, lo, hi, lit(lowSec), tid(lowSide.lower), lowSide.xOffset, lowSide.yOffset);
      }
      // upper step: textured by the side standing in the higher-ceilinged sector
      if (frontSec.ceilHeight !== backSec.ceilHeight) {
        const lo = Math.min(frontSec.ceilHeight, backSec.ceilHeight);
        const hi = Math.max(frontSec.ceilHeight, backSec.ceilHeight);
        const hiSide = frontSec.ceilHeight > backSec.ceilHeight ? frontSide : backSide;
        const hiSec = frontSec.ceilHeight > backSec.ceilHeight ? frontSec : backSec;
        quad(a, b, lo, hi, lit(hiSec), tid(hiSide.upper), hiSide.xOffset, hiSide.yOffset);
      }
    }
  }

  return { data: new Float32Array(out), vertexCount: out.length / 7 };
}

function pushTri(out: number[], p0: number[], p1: number[], p2: number[], light: number, texId: number): void {
  for (const p of [p0, p1, p2]) {
    out.push(p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, light, texId);
  }
}
