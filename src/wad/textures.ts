/**
 * Wall-texture composition + flats.
 *
 * Doom wall textures are not stored as images — they're recipes. PNAMES lists
 * patch lump names; TEXTURE1/TEXTURE2 define each texture as a width×height canvas
 * with a list of patches stamped at offsets. Each patch is in the column/post
 * "picture" format. We composite the requested textures into flat palette-index
 * buffers (one byte per pixel = palette index; 0 used for gaps, fine for opaque
 * walls). Flats are raw 64×64 palette-index lumps between the F_START/F_END
 * markers.
 *
 * Everything stays in palette-index space until the shader; we never bilinear-
 * filter indices (that would interpolate unrelated palette entries into garbage).
 */

import { Wad, readName } from "./reader";

export interface IndexedImage {
  width: number;
  height: number;
  /** width*height palette indices, row-major. */
  indices: Uint8Array;
}

interface PatchPlacement {
  originX: number;
  originY: number;
  patch: number; // index into PNAMES
}
interface TextureDef {
  name: string;
  width: number;
  height: number;
  patches: PatchPlacement[];
}

export class TextureLib {
  private readonly wad: Wad;
  private readonly pnames: string[] = [];
  private readonly defs = new Map<string, TextureDef>();
  private readonly composited = new Map<string, IndexedImage>();
  private readonly flats = new Map<string, IndexedImage>();
  private readonly patchCache = new Map<string, IndexedImage | null>();

  constructor(wad: Wad) {
    this.wad = wad;
    this.loadPnames();
    this.loadTextureLump("TEXTURE1");
    this.loadTextureLump("TEXTURE2");
    this.loadFlats();
  }

  has(name: string): boolean {
    return this.defs.has(name) || this.flats.has(name);
  }

  /** Composited wall texture by name (cached). null if unknown. */
  texture(name: string): IndexedImage | null {
    if (name === "-" || name === "") return null;
    const cached = this.composited.get(name);
    if (cached) return cached;
    const def = this.defs.get(name);
    if (!def) return null;
    const img = this.composite(def);
    this.composited.set(name, img);
    return img;
  }

  flat(name: string): IndexedImage | null {
    return this.flats.get(name) ?? null;
  }

  private loadPnames(): void {
    if (!this.wad.has("PNAMES")) return;
    const v = this.wad.dataView("PNAMES");
    const bytes = this.wad.data("PNAMES");
    const count = v.getInt32(0, true);
    for (let i = 0; i < count; i++) this.pnames.push(readName(bytes, 4 + i * 8, 8));
  }

  private loadTextureLump(lumpName: string): void {
    if (!this.wad.has(lumpName)) return;
    const bytes = this.wad.data(lumpName);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const num = v.getInt32(0, true);
    for (let i = 0; i < num; i++) {
      const off = v.getInt32(4 + i * 4, true);
      const name = readName(bytes, off, 8);
      const width = v.getInt16(off + 12, true);
      const height = v.getInt16(off + 14, true);
      const patchCount = v.getInt16(off + 20, true);
      const patches: PatchPlacement[] = [];
      for (let p = 0; p < patchCount; p++) {
        const po = off + 22 + p * 10;
        patches.push({
          originX: v.getInt16(po, true),
          originY: v.getInt16(po + 2, true),
          patch: v.getInt16(po + 4, true),
        });
      }
      this.defs.set(name, { name, width, height, patches });
    }
  }

  private loadFlats(): void {
    const start = this.wad.indexOf("F_START");
    const end = this.wad.indexOf("F_END");
    if (start < 0 || end < 0) return;
    for (let i = start + 1; i < end; i++) {
      const lump = this.wad.lumps[i]!;
      if (lump.size !== 4096) continue; // skip F1_START/F2_START sub-markers etc.
      const data = this.wad.bytes.subarray(lump.offset, lump.offset + 4096);
      this.flats.set(lump.name, { width: 64, height: 64, indices: data.slice() });
    }
  }

  private composite(def: TextureDef): IndexedImage {
    const { width, height } = def;
    const indices = new Uint8Array(width * height); // 0 = gap (ok for opaque walls)
    for (const pl of def.patches) {
      const pname = this.pnames[pl.patch];
      if (!pname) continue;
      const patch = this.patch(pname);
      if (!patch) continue;
      stamp(indices, width, height, patch, pl.originX, pl.originY);
    }
    return { width, height, indices };
  }

  /** Decode a patch (column/post picture format) into an IndexedImage (cached). */
  private patch(name: string): IndexedImage | null {
    const cached = this.patchCache.get(name);
    if (cached !== undefined) return cached;
    const idx = this.wad.indexOf(name);
    if (idx < 0) { this.patchCache.set(name, null); return null; }
    const full = decodePatchFull(this.wad.data(idx));
    const img = full ? { width: full.width, height: full.height, indices: full.indices } : null;
    this.patchCache.set(name, img);
    return img;
  }
}

/** Patch with offsets + a painted-pixel mask (sprites need both; gaps are alpha, not index 0). */
export interface PatchImage {
  width: number;
  height: number;
  leftOffset: number;
  topOffset: number;
  indices: Uint8Array;
  mask: Uint8Array; // 1 = painted, 0 = transparent gap
}

/** Decode Doom patch picture (column/post) format, capturing offsets and a transparency mask. */
export function decodePatchFull(bytes: Uint8Array): PatchImage | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getInt16(0, true);
  const height = v.getInt16(2, true);
  const leftOffset = v.getInt16(4, true);
  const topOffset = v.getInt16(6, true);
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return null;
  const indices = new Uint8Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let colOfs = v.getUint32(8 + x * 4, true);
    let guard = 0;
    while (colOfs < bytes.length && guard++ < 1024) {
      const topDelta = bytes[colOfs]!;
      if (topDelta === 0xff) break;
      const len = bytes[colOfs + 1]!;
      const pixStart = colOfs + 3; // skip topdelta, length, 1 pad byte
      for (let y = 0; y < len; y++) {
        const dy = topDelta + y;
        if (dy >= 0 && dy < height) {
          indices[dy * width + x] = bytes[pixStart + y]!;
          mask[dy * width + x] = 1;
        }
      }
      colOfs = pixStart + len + 1; // skip pixels + trailing pad byte
    }
  }
  return { width, height, leftOffset, topOffset, indices, mask };
}

/** Stamp a patch into a texture canvas at (ox,oy), clipping to bounds. Index 0 = skip (gap). */
function stamp(dst: Uint8Array, dw: number, dh: number, patch: IndexedImage, ox: number, oy: number): void {
  for (let y = 0; y < patch.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= dh) continue;
    for (let x = 0; x < patch.width; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= dw) continue;
      const px = patch.indices[y * patch.width + x]!;
      // Treat exact-0 as transparent gap so overlapping patches composite correctly.
      if (px !== 0) dst[ty * dw + tx] = px;
    }
  }
}
