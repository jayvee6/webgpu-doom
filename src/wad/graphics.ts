/**
 * Palette parsing. PLAYPAL holds 14 palettes, each 256 RGB triplets (768 bytes).
 * Palette 0 is the base; the others are damage/bonus/radsuit tints applied as
 * screen flashes. We expose palette 0 as RGBA for direct upload to a GPU texture.
 */

import { Wad } from "./reader";

export const PALETTE_SIZE = 256;
const BYTES_PER_PALETTE = PALETTE_SIZE * 3;

export interface Palettes {
  /** Number of palettes found (Doom = 14). */
  count: number;
  /** Raw RGB, all palettes concatenated: count * 768 bytes. */
  rgb: Uint8Array;
}

export function loadPalettes(wad: Wad): Palettes {
  const data = wad.data("PLAYPAL");
  if (data.byteLength < BYTES_PER_PALETTE) {
    throw new Error(`PLAYPAL too small: ${data.byteLength} bytes (need ≥ ${BYTES_PER_PALETTE})`);
  }
  const count = (data.byteLength / BYTES_PER_PALETTE) | 0;
  return { count, rgb: data.slice() };
}

/** Return palette `index` as RGBA8 (1024 bytes), alpha forced to 255. */
export function paletteRGBA(pal: Palettes, index = 0): Uint8Array<ArrayBuffer> {
  if (index < 0 || index >= pal.count) throw new Error(`Palette index ${index} out of range (0..${pal.count - 1})`);
  const base = index * BYTES_PER_PALETTE;
  const out = new Uint8Array(PALETTE_SIZE * 4);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const s = base + i * 3;
    const d = i * 4;
    out[d] = pal.rgb[s]!;
    out[d + 1] = pal.rgb[s + 1]!;
    out[d + 2] = pal.rgb[s + 2]!;
    out[d + 3] = 255;
  }
  return out;
}
