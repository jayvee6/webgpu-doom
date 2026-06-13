/**
 * Sprite lumps live between S_START/S_END. Names are SPRITE(4) + FRAME(1) +
 * ROTATION(1), optionally with a second FRAME+ROTATION for a mirrored rotation
 * (e.g. TROOA2A8). For a static billboard we want a front-facing view: prefer
 * rotation '0' (angle-independent), else rotation '1'. Decoded to RGBA via the
 * palette, with the patch's transparency mask → alpha (sprite gaps are NOT
 * palette index 0).
 */

import { Wad } from "./reader";
import { decodePatchFull } from "./textures";

export interface SpriteImage {
  width: number;
  height: number;
  leftOffset: number;
  topOffset: number;
  rgba: Uint8Array<ArrayBuffer>;
}

export class SpriteLib {
  private readonly wad: Wad;
  private readonly palette: Uint8Array; // 1024 bytes RGBA
  private readonly names = new Set<string>();
  private readonly cache = new Map<string, SpriteImage | null>();

  constructor(wad: Wad, paletteRGBA: Uint8Array) {
    this.wad = wad;
    this.palette = paletteRGBA;
    const start = wad.indexOf("S_START");
    const end = wad.indexOf("S_END");
    if (start < 0 || end < 0) return;
    for (let i = start + 1; i < end; i++) {
      const lump = wad.lumps[i]!;
      if (lump.size > 0) this.names.add(lump.name);
    }
  }

  /** Resolve sprite+frame to a concrete lump name (front-facing), or null. */
  resolveLump(sprite: string, frame: string): string | null {
    const base = sprite + frame;
    if (this.names.has(base + "0")) return base + "0"; // rotation-independent
    if (this.names.has(base + "1")) return base + "1"; // facing the viewer
    // Fallback: any lump for this sprite+frame (incl. mirrored-pair names).
    for (const n of this.names) {
      if (n.startsWith(base)) return n;
    }
    return null;
  }

  /** Decode a sprite lump to RGBA (cached). */
  image(lumpName: string): SpriteImage | null {
    const cached = this.cache.get(lumpName);
    if (cached !== undefined) return cached;
    const idx = this.wad.indexOf(lumpName);
    if (idx < 0) { this.cache.set(lumpName, null); return null; }
    const p = decodePatchFull(this.wad.data(idx));
    if (!p) { this.cache.set(lumpName, null); return null; }
    const rgba = new Uint8Array(p.width * p.height * 4);
    for (let i = 0; i < p.width * p.height; i++) {
      if (p.mask[i]) {
        const c = p.indices[i]! * 4;
        rgba[i * 4] = this.palette[c]!;
        rgba[i * 4 + 1] = this.palette[c + 1]!;
        rgba[i * 4 + 2] = this.palette[c + 2]!;
        rgba[i * 4 + 3] = 255;
      } // else fully transparent (0,0,0,0)
    }
    const img: SpriteImage = { width: p.width, height: p.height, leftOffset: p.leftOffset, topOffset: p.topOffset, rgba };
    this.cache.set(lumpName, img);
    return img;
  }
}
