/**
 * Build wall triangles from linedefs/sidedefs.
 *
 * World mapping: worldPos = (map.x, height, -map.y).
 * Per linedef:
 *   - one-sided  → one solid wall, front sector floor → ceiling
 *   - two-sided  → a "lower" step quad between the two floor heights, and an
 *                  "upper" step quad between the two ceiling heights (each only
 *                  if the heights differ). Middle (mid-texture) skipped for now.
 * Each step is emitted once per linedef (spanning min..max of the pair) so the
 * two sidedefs don't double-draw it.
 *
 * Vertex layout (7 f32, 28-byte stride): position xyz · normal xyz · light.
 */

import type { DoomMap, Sector, Vertex } from "../wad/maps";

export interface WallMesh {
  data: Float32Array<ArrayBuffer>;
  vertexCount: number;
}

export function buildWalls(map: DoomMap): WallMesh {
  const out: number[] = [];

  const quad = (a: Vertex, b: Vertex, yBottom: number, yTop: number, light: number): void => {
    if (yTop <= yBottom) return;
    // Wall normal: perpendicular to the edge in the XZ plane.
    let nx = -(b.y - a.y); // = world dz direction component
    let nz = -(b.x - a.x);
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    const ax = a.x, az = -a.y, bx = b.x, bz = -b.y;
    // Two triangles: (Ab, Bb, Bt) and (Ab, Bt, At)
    const Ab = [ax, yBottom, az], Bb = [bx, yBottom, bz];
    const At = [ax, yTop, az], Bt = [bx, yTop, bz];
    pushTri(out, Ab, Bb, Bt, nx, nz, light);
    pushTri(out, Ab, Bt, At, nx, nz, light);
  };

  for (const ld of map.linedefs) {
    const a = map.vertexes[ld.v1];
    const b = map.vertexes[ld.v2];
    if (!a || !b) continue;

    const frontSec: Sector | undefined = ld.right >= 0 ? map.sectors[map.sidedefs[ld.right]!.sector] : undefined;
    const backSec: Sector | undefined = ld.left >= 0 ? map.sectors[map.sidedefs[ld.left]!.sector] : undefined;

    if (frontSec && !backSec) {
      quad(a, b, frontSec.floorHeight, frontSec.ceilHeight, frontSec.light / 255);
    } else if (backSec && !frontSec) {
      quad(a, b, backSec.floorHeight, backSec.ceilHeight, backSec.light / 255);
    } else if (frontSec && backSec) {
      // lower step
      if (frontSec.floorHeight !== backSec.floorHeight) {
        const lo = Math.min(frontSec.floorHeight, backSec.floorHeight);
        const hi = Math.max(frontSec.floorHeight, backSec.floorHeight);
        const lit = (frontSec.floorHeight < backSec.floorHeight ? frontSec : backSec).light / 255;
        quad(a, b, lo, hi, lit);
      }
      // upper step
      if (frontSec.ceilHeight !== backSec.ceilHeight) {
        const lo = Math.min(frontSec.ceilHeight, backSec.ceilHeight);
        const hi = Math.max(frontSec.ceilHeight, backSec.ceilHeight);
        const lit = (frontSec.ceilHeight > backSec.ceilHeight ? frontSec : backSec).light / 255;
        quad(a, b, lo, hi, lit);
      }
    }
  }

  return { data: new Float32Array(out), vertexCount: out.length / 7 };
}

function pushTri(
  out: number[],
  p0: number[], p1: number[], p2: number[],
  nx: number, nz: number, light: number,
): void {
  for (const p of [p0, p1, p2]) {
    out.push(p[0]!, p[1]!, p[2]!, nx, 0, nz, light);
  }
}
