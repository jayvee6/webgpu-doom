/**
 * Sprite lumps live between S_START/S_END. Names are SPRITE(4) + FRAME(1) +
 * ROTATION(1), optionally with a second FRAME+ROTATION for a mirrored rotation
 * (e.g. TROOA2A8). For a static billboard we want a front-facing view: prefer
 * rotation '0' (angle-independent), else rotation '1'. Kept as palette index +
 * transparency mask (sprite gaps are NOT palette index 0) so the shader applies
 * the same COLORMAP lighting as the world. Packed RG8: R=index, G=mask(0/255).
 */

import { Wad } from "./reader";
import { decodePatchFull } from "./textures";

export interface SpriteImage {
  width: number;
  height: number;
  leftOffset: number;
  topOffset: number;
  /** RG8: byte 0 = palette index, byte 1 = mask (255 painted / 0 transparent). */
  rg: Uint8Array<ArrayBuffer>;
}

export class SpriteLib {
  private readonly wad: Wad;
  private readonly names = new Set<string>();
  private readonly cache = new Map<string, SpriteImage | null>();

  constructor(wad: Wad) {
    this.wad = wad;
    const start = wad.indexOf("S_START");
    const end = wad.indexOf("S_END");
    if (start < 0 || end < 0) return;
    for (let i = start + 1; i < end; i++) {
      const lump = wad.lumps[i]!;
      if (lump.size > 0) this.names.add(lump.name);
    }
  }

  /** Does a specific sprite+frame+rotation lump exist? */
  hasFrameRot(sprite: string, frame: string, rot: string): boolean {
    return this.names.has(sprite + frame + rot);
  }

  /**
   * Data-driven animation frames for a monster sprite (no hardcoded state table):
   *   walk  = directional frames A..D (have a rotation-1 variant)
   *   death = rotation-0-ONLY frames after D, alphabetical (the death/corpse run)
   */
  monsterFrames(sprite: string): { walk: string[]; death: string[] } {
    const walk: string[] = [];
    for (const f of ["A", "B", "C", "D"]) {
      if (this.hasFrameRot(sprite, f, "1") || this.hasFrameRot(sprite, f, "0")) walk.push(f);
    }
    const death: string[] = [];
    // Scan E–Z for all death/dying frames: include both rotation-0-only corpse frames
    // AND directional frames (rotation-1 variants) that Freedoom uses for the falling
    // sequence (e.g. TROO E–H, POSS E–G). resolveLump() will pick the front-facing view.
    for (let c = "E".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
      const f = String.fromCharCode(c);
      if (this.hasFrameRot(sprite, f, "0") || this.hasFrameRot(sprite, f, "1")) death.push(f);
    }
    if (walk.length === 0) walk.push("A");
    return { walk, death };
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

  /** Decode a sprite lump to packed index+mask RG8 (cached). */
  image(lumpName: string): SpriteImage | null {
    const cached = this.cache.get(lumpName);
    if (cached !== undefined) return cached;
    const idx = this.wad.indexOf(lumpName);
    if (idx < 0) { this.cache.set(lumpName, null); return null; }
    const p = decodePatchFull(this.wad.data(idx));
    if (!p) { this.cache.set(lumpName, null); return null; }
    const rg = new Uint8Array(p.width * p.height * 2);
    for (let i = 0; i < p.width * p.height; i++) {
      if (p.mask[i]) {
        rg[i * 2] = p.indices[i]!;
        rg[i * 2 + 1] = 255;
      } // else (0,0) = transparent
    }
    const img: SpriteImage = { width: p.width, height: p.height, leftOffset: p.leftOffset, topOffset: p.topOffset, rg };
    this.cache.set(lumpName, img);
    return img;
  }
}
