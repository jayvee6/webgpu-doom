/** BSP point location: which sector contains a map-space (x,y). */

import { NF_SUBSECTOR, type DoomMap } from "./maps";

/** Descend the BSP to the subsector containing (x,y); return its sector index, or -1. */
export function locateSector(map: DoomMap, x: number, y: number): number {
  if (map.nodes.length === 0) return -1;
  let nodeIdx = map.nodes.length - 1;
  for (let guard = 0; guard < 256; guard++) {
    const node = map.nodes[nodeIdx]!;
    const cross = node.dx * (y - node.y) - node.dy * (x - node.x);
    const child = cross <= 0 ? node.rightChild : node.leftChild;
    if (child & NF_SUBSECTOR) {
      const ss = map.subsectors[child & 0x7fff];
      if (!ss) return -1;
      const seg = map.segs[ss.firstSeg];
      if (!seg) return -1;
      const ld = map.linedefs[seg.linedef];
      if (!ld) return -1;
      const sideIdx = seg.side === 0 ? ld.right : ld.left;
      if (sideIdx < 0) return -1;
      return map.sidedefs[sideIdx]!.sector;
    }
    nodeIdx = child;
  }
  return -1;
}
