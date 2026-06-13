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
 * Vertex layout matches walls (9 f32): x, z, heightIndex, u, vBase, vTop, vMode,
 * light, texId. Flats are vMode 0 (V = vBase = map-y directly); heightIndex picks
 * the sector floor (s*2) or ceiling (s*2+1) live height. UVs are absolute map
 * (x,y) — Doom aligns flats to the world grid and tiles every 64 units.
 */

import earcut from "earcut";
import type { DoomMap } from "../wad/maps";

const SKY_FLAT = "F_SKY1";

export interface FlatMesh {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** Sectors that produced no usable loop — diagnostic for the earcut→BSP decision. */
  failedSectors: number;
}

export type TexId = (name: string) => number;

type Edge = [number, number]; // [fromVertex, toVertex]

export function buildFlats(map: DoomMap, tid: TexId): FlatMesh {
  const verts: number[] = [];
  const indices: number[] = [];
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
      emitFlat(verts, indices, tri.indices, tri.ring, map, s, light,
        doFloor && floorTex >= 0, doCeil && ceilTex >= 0, floorTex, ceilTex);
    }
  }

  return { vertices: new Float32Array(verts), indices: new Uint32Array(indices), failedSectors };
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
  verts: number[], indices: number[], triIndices: number[], ring: number[], map: DoomMap,
  sectorIdx: number, light: number, doFloor: boolean, doCeil: boolean,
  floorTex: number, ceilTex: number,
): void {
  const floorH = sectorIdx * 2; // heightIndex for this sector's floor
  const ceilH = sectorIdx * 2 + 1;
  // Emit each ring vertex once per face, then the earcut indices offset by the base.
  const emitRing = (hIdx: number, texId: number) => {
    const base = verts.length / 9;
    for (const vi of ring) { const p = vertXY(map, vi); pushV(verts, p[0], hIdx, p[1], light, texId); }
    for (const t of triIndices) indices.push(base + t);
  };
  if (doFloor) emitRing(floorH, floorTex);
  if (doCeil) emitRing(ceilH, ceilTex);
}

/** x, z(=-mapY), heightIndex, u(=mapX), vBase(=mapY), vTop(0), vMode(0 flat), light, texId */
function pushV(out: number[], mapX: number, hIdx: number, mapY: number, light: number, texId: number): void {
  out.push(mapX, -mapY, hIdx, mapX, mapY, 0, 0, light, texId);
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
