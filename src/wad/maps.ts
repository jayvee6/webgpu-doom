/**
 * Doom-format map lump parsing.
 *
 * Map lumps follow a marker lump (e.g. "E1M1" / "MAP01") in a fixed order:
 *   THINGS, LINEDEFS, SIDEDEFS, VERTEXES, SEGS, SSECTORS, NODES, SECTORS, REJECT, BLOCKMAP
 * We locate the marker, then read each named sub-lump that follows it. We only parse
 * the lumps the renderer needs (REJECT/BLOCKMAP are skipped). Doom format only —
 * Hexen-format linedefs (a different record size) are out of scope for Freedoom phase 1.
 */

import { Wad, readName } from "./reader";

export interface Thing {
  x: number;
  y: number;
  angle: number; // degrees
  type: number; // thing type id
  flags: number;
}

export interface Linedef {
  v1: number; // start vertex index
  v2: number; // end vertex index
  flags: number;
  special: number;
  tag: number;
  right: number; // front sidedef index, or -1
  left: number; // back sidedef index, or -1
}

export interface Sidedef {
  xOffset: number;
  yOffset: number;
  upper: string; // texture name ("-" = none)
  lower: string;
  middle: string;
  sector: number; // sector index
}

export interface Vertex {
  x: number;
  y: number;
}

export interface Seg {
  v1: number;
  v2: number;
  angle: number; // binary angle measure (BAM, int16)
  linedef: number;
  side: number; // 0 = same direction as linedef, 1 = opposite
  offset: number;
}

export interface Subsector {
  segCount: number;
  firstSeg: number;
}

export interface Node {
  x: number;
  y: number;
  dx: number;
  dy: number;
  rightBox: [number, number, number, number]; // top, bottom, left, right
  leftBox: [number, number, number, number];
  rightChild: number; // raw child (high bit => subsector index)
  leftChild: number;
}

export interface Sector {
  floorHeight: number;
  ceilHeight: number;
  floorFlat: string;
  ceilFlat: string;
  light: number; // 0..255
  special: number;
  tag: number;
}

export interface DoomMap {
  name: string;
  things: Thing[];
  linedefs: Linedef[];
  sidedefs: Sidedef[];
  vertexes: Vertex[];
  segs: Seg[];
  subsectors: Subsector[];
  nodes: Node[];
  sectors: Sector[];
}

/** High bit of a NODES child field marks a subsector reference. */
export const NF_SUBSECTOR = 0x8000;

const SIGNED16 = 0xffff; // sentinel "no sidedef" when read as uint16

export function loadMap(wad: Wad, name: string): DoomMap {
  const marker = wad.indexOf(name);
  if (marker < 0) throw new Error(`Map "${name}" not found in WAD`);

  // Resolve a required sub-lump that must appear shortly after the marker.
  const sub = (lumpName: string): Wad["lumps"][number] => {
    const idx = wad.indexOf(lumpName, marker + 1);
    // Map sub-lumps live within the next ~10 entries; reject far-away same-named lumps.
    if (idx < 0 || idx > marker + 11) {
      throw new Error(`Map "${name}": missing sub-lump ${lumpName} after marker @${marker}`);
    }
    return wad.lumps[idx]!;
  };

  return {
    name,
    things: parseThings(wad, sub("THINGS")),
    linedefs: parseLinedefs(wad, sub("LINEDEFS")),
    sidedefs: parseSidedefs(wad, sub("SIDEDEFS")),
    vertexes: parseVertexes(wad, sub("VERTEXES")),
    segs: parseSegs(wad, sub("SEGS")),
    subsectors: parseSubsectors(wad, sub("SSECTORS")),
    nodes: parseNodes(wad, sub("NODES")),
    sectors: parseSectors(wad, sub("SECTORS")),
  };
}

type LumpRef = Wad["lumps"][number];

function dv(wad: Wad, lump: LumpRef): DataView {
  return new DataView(wad.bytes.buffer, wad.bytes.byteOffset + lump.offset, lump.size);
}

function parseThings(wad: Wad, lump: LumpRef): Thing[] {
  const v = dv(wad, lump);
  const n = (lump.size / 10) | 0;
  const out: Thing[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 10;
    out[i] = {
      x: v.getInt16(o, true),
      y: v.getInt16(o + 2, true),
      angle: v.getUint16(o + 4, true),
      type: v.getUint16(o + 6, true),
      flags: v.getUint16(o + 8, true),
    };
  }
  return out;
}

function parseLinedefs(wad: Wad, lump: LumpRef): Linedef[] {
  const v = dv(wad, lump);
  const n = (lump.size / 14) | 0;
  const out: Linedef[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 14;
    const right = v.getUint16(o + 10, true);
    const left = v.getUint16(o + 12, true);
    out[i] = {
      v1: v.getUint16(o, true),
      v2: v.getUint16(o + 2, true),
      flags: v.getUint16(o + 4, true),
      special: v.getUint16(o + 6, true),
      tag: v.getUint16(o + 8, true),
      right: right === SIGNED16 ? -1 : right,
      left: left === SIGNED16 ? -1 : left,
    };
  }
  return out;
}

function parseSidedefs(wad: Wad, lump: LumpRef): Sidedef[] {
  const v = dv(wad, lump);
  const n = (lump.size / 30) | 0;
  const out: Sidedef[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 30;
    out[i] = {
      xOffset: v.getInt16(o, true),
      yOffset: v.getInt16(o + 2, true),
      upper: readName(wad.bytes, lump.offset + o + 4, 8),
      lower: readName(wad.bytes, lump.offset + o + 12, 8),
      middle: readName(wad.bytes, lump.offset + o + 20, 8),
      sector: v.getUint16(o + 28, true),
    };
  }
  return out;
}

function parseVertexes(wad: Wad, lump: LumpRef): Vertex[] {
  const v = dv(wad, lump);
  const n = (lump.size / 4) | 0;
  const out: Vertex[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = { x: v.getInt16(o, true), y: v.getInt16(o + 2, true) };
  }
  return out;
}

function parseSegs(wad: Wad, lump: LumpRef): Seg[] {
  const v = dv(wad, lump);
  const n = (lump.size / 12) | 0;
  const out: Seg[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    out[i] = {
      v1: v.getUint16(o, true),
      v2: v.getUint16(o + 2, true),
      angle: v.getInt16(o + 4, true),
      linedef: v.getUint16(o + 6, true),
      side: v.getUint16(o + 8, true),
      offset: v.getInt16(o + 10, true),
    };
  }
  return out;
}

function parseSubsectors(wad: Wad, lump: LumpRef): Subsector[] {
  const v = dv(wad, lump);
  const n = (lump.size / 4) | 0;
  const out: Subsector[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = { segCount: v.getUint16(o, true), firstSeg: v.getUint16(o + 2, true) };
  }
  return out;
}

function parseNodes(wad: Wad, lump: LumpRef): Node[] {
  const v = dv(wad, lump);
  const n = (lump.size / 28) | 0;
  const out: Node[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 28;
    out[i] = {
      x: v.getInt16(o, true),
      y: v.getInt16(o + 2, true),
      dx: v.getInt16(o + 4, true),
      dy: v.getInt16(o + 6, true),
      rightBox: [v.getInt16(o + 8, true), v.getInt16(o + 10, true), v.getInt16(o + 12, true), v.getInt16(o + 14, true)],
      leftBox: [v.getInt16(o + 16, true), v.getInt16(o + 18, true), v.getInt16(o + 20, true), v.getInt16(o + 22, true)],
      rightChild: v.getUint16(o + 24, true),
      leftChild: v.getUint16(o + 26, true),
    };
  }
  return out;
}

function parseSectors(wad: Wad, lump: LumpRef): Sector[] {
  const v = dv(wad, lump);
  const n = (lump.size / 26) | 0;
  const out: Sector[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 26;
    out[i] = {
      floorHeight: v.getInt16(o, true),
      ceilHeight: v.getInt16(o + 2, true),
      floorFlat: readName(wad.bytes, lump.offset + o + 4, 8),
      ceilFlat: readName(wad.bytes, lump.offset + o + 12, 8),
      light: v.getUint16(o + 20, true),
      special: v.getUint16(o + 22, true),
      tag: v.getUint16(o + 24, true),
    };
  }
  return out;
}
