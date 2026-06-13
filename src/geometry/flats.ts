/**
 * Build floor + ceiling triangles per sector (the "flats").
 *
 * Doom never stores sector polygons, so we reconstruct them. For each linedef we
 * emit a DIRECTED boundary edge per bordering sector, oriented so the sector's
 * interior is always on the edge's LEFT:
 *   - front (right sidedef) sector → edge v2→v1
 *   - back  (left  sidedef) sector → edge v1→v2
 * Walking these edges yields closed loops; CCW loops (area > 0) are outer
 * boundaries, CW loops are holes (e.g. a pillar's footprint). Holes are matched to
 * the outer loop that contains them, then each outer + its holes is triangulated
 * with earcut. Floor verts sit at floorHeight (normal +Y), ceiling at ceilHeight
 * (normal −Y). Sky flats (F_SKY1) are left open.
 *
 * This is the "earcut first" path (see design doc): robust on the common
 * one-outer + holes sectors; pathological self-touching sectors may show minor
 * artifacts and are the trigger to upgrade to BSP-subsector reconstruction.
 *
 * Vertex layout matches walls: position xyz · uv · light · texId (7 f32).
 * Flat UVs are the absolute map (x,y) — Doom aligns flats to the world grid and
 * tiles every 64 units; the shader handles the wrap.
 */

import earcut from "earcut";
import type { DoomMap } from "../wad/maps";

const SKY_FLAT = "F_SKY1";

export interface FlatMesh {
  data: Float32Array<ArrayBuffer>;
  vertexCount: number;
  /** Sectors that produced no usable loop — diagnostic for the earcut→BSP decision. */
  failedSectors: number;
}

export type TexId = (name: string) => number;

type Edge = [number, number]; // [fromVertex, toVertex]

export function buildFlats(map: DoomMap, tid: TexId): FlatMesh {
  const out: number[] = [];
  let failedSectors = 0;

  // Gather directed boundary edges per sector.
  const edgesBySector: Edge[][] = map.sectors.map(() => []);
  for (const ld of map.linedefs) {
    if (ld.right >= 0) {
      const s = map.sidedefs[ld.right]!.sector;
      if (edgesBySector[s]) edgesBySector[s]!.push([ld.v2, ld.v1]);
    }
    if (ld.left >= 0) {
      const s = map.sidedefs[ld.left]!.sector;
      if (edgesBySector[s]) edgesBySector[s]!.push([ld.v1, ld.v2]);
    }
  }

  for (let s = 0; s < map.sectors.length; s++) {
    const sec = map.sectors[s]!;
    const loops = buildLoops(edgesBySector[s]!, map);
    if (loops.length === 0) { failedSectors++; continue; }

    // Classify outer (CCW, area>0) vs hole (CW, area<0).
    const outers: number[][] = [];
    const holes: number[][] = [];
    for (const loop of loops) (signedArea(loop, map) >= 0 ? outers : holes).push(loop);
    if (outers.length === 0) { failedSectors++; continue; }

    // Assign each hole to the outer that contains it.
    const holesFor = new Map<number, number[][]>();
    for (const hole of holes) {
      const pt = vertXY(map, hole[0]!);
      let target = 0;
      for (let oi = 0; oi < outers.length; oi++) {
        if (pointInLoop(pt, outers[oi]!, map)) { target = oi; break; }
      }
      const list = holesFor.get(target) ?? [];
      list.push(hole);
      holesFor.set(target, list);
    }

    const light = sec.light / 255;
    const doFloor = sec.floorFlat !== SKY_FLAT;
    const doCeil = sec.ceilFlat !== SKY_FLAT;
    const floorTex = tid(sec.floorFlat);
    const ceilTex = tid(sec.ceilFlat);

    for (let oi = 0; oi < outers.length; oi++) {
      const tri = triangulate(outers[oi]!, holesFor.get(oi) ?? [], map);
      if (!tri) continue;
      emitFlat(out, tri.indices, tri.ring, map, sec.floorHeight, sec.ceilHeight, light,
        doFloor && floorTex >= 0, doCeil && ceilTex >= 0, floorTex, ceilTex);
    }
  }

  return { data: new Float32Array(out), vertexCount: out.length / 7, failedSectors };
}

/** Walk directed edges into closed loops, resolving junctions by tightest clockwise turn. */
function buildLoops(edges: Edge[], map: DoomMap): number[][] {
  if (edges.length === 0) return [];
  const byFrom = new Map<number, number[]>();
  edges.forEach((e, i) => {
    const a = byFrom.get(e[0]);
    if (a) a.push(i); else byFrom.set(e[0], [i]);
  });
  const used = new Array(edges.length).fill(false);
  const loops: number[][] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const loop: number[] = [];
    let cur = start;
    let guard = 0;
    while (cur !== -1 && !used[cur] && guard++ < 200000) {
      used[cur] = true;
      const e = edges[cur]!;
      loop.push(e[0]);
      const cands = (byFrom.get(e[1]) ?? []).filter((i) => !used[i]);
      if (cands.length === 0) break;
      if (cands.length === 1) { cur = cands[0]!; continue; }
      cur = pickNext(edges, map, e[0], e[1], cands);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** At a junction, choose the candidate edge making the sharpest clockwise turn. */
function pickNext(edges: Edge[], map: DoomMap, from: number, via: number, cands: number[]): number {
  const a = vertXY(map, from), b = vertXY(map, via);
  const inx = b[0] - a[0], iny = b[1] - a[1];
  let best = cands[0]!, bestAngle = Infinity;
  for (const c of cands) {
    const to = vertXY(map, edges[c]![1]);
    const dx = to[0] - b[0], dy = to[1] - b[1];
    const cross = inx * dy - iny * dx;
    const dot = inx * dx + iny * dy;
    const ang = Math.atan2(cross, dot); // (-π,π], negative = clockwise
    if (ang < bestAngle) { bestAngle = ang; best = c; }
  }
  return best;
}

function triangulate(
  outer: number[], holes: number[][], map: DoomMap,
): { coords: number[]; ring: number[]; indices: number[] } | null {
  const coords: number[] = [];
  const ring: number[] = [];
  const push = (vi: number) => { const p = vertXY(map, vi); coords.push(p[0], p[1]); ring.push(vi); };
  for (const vi of outer) push(vi);
  const holeIndices: number[] = [];
  for (const hole of holes) {
    holeIndices.push(ring.length);
    for (const vi of hole) push(vi);
  }
  const indices = earcut(coords, holeIndices.length ? holeIndices : undefined, 2);
  if (indices.length === 0) return null;
  return { coords, ring, indices };
}

function emitFlat(
  out: number[], indices: number[], ring: number[], map: DoomMap,
  floorH: number, ceilH: number, light: number, doFloor: boolean, doCeil: boolean,
  floorTex: number, ceilTex: number,
): void {
  for (let i = 0; i < indices.length; i += 3) {
    const a = ring[indices[i]!]!, b = ring[indices[i + 1]!]!, c = ring[indices[i + 2]!]!;
    const pa = vertXY(map, a), pb = vertXY(map, b), pc = vertXY(map, c);
    // UV = absolute map (x,y); cull disabled so winding is irrelevant.
    if (doFloor) {
      pushV(out, pa[0], floorH, -pa[1], pa[0], pa[1], light, floorTex);
      pushV(out, pb[0], floorH, -pb[1], pb[0], pb[1], light, floorTex);
      pushV(out, pc[0], floorH, -pc[1], pc[0], pc[1], light, floorTex);
    }
    if (doCeil) {
      pushV(out, pa[0], ceilH, -pa[1], pa[0], pa[1], light, ceilTex);
      pushV(out, pb[0], ceilH, -pb[1], pb[0], pb[1], light, ceilTex);
      pushV(out, pc[0], ceilH, -pc[1], pc[0], pc[1], light, ceilTex);
    }
  }
}

function pushV(out: number[], x: number, y: number, z: number, u: number, v: number, l: number, texId: number): void {
  out.push(x, y, z, u, v, l, texId);
}

function vertXY(map: DoomMap, vi: number): [number, number] {
  const v = map.vertexes[vi]!;
  return [v.x, v.y];
}

function signedArea(loop: number[], map: DoomMap): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = vertXY(map, loop[i]!);
    const b = vertXY(map, loop[(i + 1) % loop.length]!);
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function pointInLoop(pt: [number, number], loop: number[], map: DoomMap): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = vertXY(map, loop[i]!), b = vertXY(map, loop[j]!);
    const intersect = a[1] > pt[1] !== b[1] > pt[1] &&
      pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (intersect) inside = !inside;
  }
  return inside;
}
