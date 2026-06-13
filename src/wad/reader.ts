/**
 * WAD reader — header + lump directory.
 *
 * A WAD is: 12-byte header, then lump data, then a directory of 16-byte entries.
 * All multi-byte integers are little-endian. Lump names are 8 bytes, NUL-padded,
 * uppercase ASCII. Identically-named lumps can repeat (e.g. per-map markers), so we
 * keep the full ordered list and a name→firstIndex map, and support search-from-index.
 */

export interface Lump {
  /** Uppercased lump name (≤ 8 chars). */
  name: string;
  /** Byte offset of the lump's data within the WAD. */
  offset: number;
  /** Byte length of the lump's data. */
  size: number;
}

export type WadType = "IWAD" | "PWAD";

export class Wad {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly type: WadType;
  readonly lumps: readonly Lump[];
  /** name → index of its FIRST occurrence. */
  private readonly firstByName: Map<string, number>;

  private constructor(bytes: Uint8Array, type: WadType, lumps: Lump[]) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.type = type;
    this.lumps = lumps;
    this.firstByName = new Map();
    for (let i = 0; i < lumps.length; i++) {
      const n = lumps[i]!.name;
      if (!this.firstByName.has(n)) this.firstByName.set(n, i);
    }
  }

  static async load(url: string): Promise<Wad> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`WAD fetch failed: ${resp.status} ${resp.statusText} for ${url}`);
    return Wad.parse(new Uint8Array(await resp.arrayBuffer()));
  }

  static parse(bytes: Uint8Array): Wad {
    if (bytes.byteLength < 12) throw new Error(`WAD too small: ${bytes.byteLength} bytes`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const magic = readName(bytes, 0, 4);
    if (magic !== "IWAD" && magic !== "PWAD") {
      throw new Error(`Not a WAD: magic="${magic}" (expected IWAD/PWAD)`);
    }
    const numLumps = view.getInt32(4, true);
    const dirOffset = view.getInt32(8, true);
    if (numLumps < 0 || dirOffset < 0 || dirOffset + numLumps * 16 > bytes.byteLength) {
      throw new Error(`Corrupt WAD directory: numLumps=${numLumps} dirOffset=${dirOffset} len=${bytes.byteLength}`);
    }

    const lumps: Lump[] = new Array(numLumps);
    for (let i = 0; i < numLumps; i++) {
      const e = dirOffset + i * 16;
      const offset = view.getInt32(e, true);
      const size = view.getInt32(e + 4, true);
      const name = readName(bytes, e + 8, 8);
      if (offset < 0 || size < 0 || offset + size > bytes.byteLength) {
        throw new Error(`Lump ${i} "${name}" out of bounds: offset=${offset} size=${size}`);
      }
      lumps[i] = { name, offset, size };
    }
    return new Wad(bytes, magic, lumps);
  }

  /** Index of the first lump named `name` at or after `from`, or -1. */
  indexOf(name: string, from = 0): number {
    const want = name.toUpperCase();
    if (from === 0) return this.firstByName.get(want) ?? -1;
    for (let i = from; i < this.lumps.length; i++) {
      if (this.lumps[i]!.name === want) return i;
    }
    return -1;
  }

  has(name: string): boolean {
    return this.firstByName.has(name.toUpperCase());
  }

  /** Raw bytes for a lump by index or name. Throws if not found. */
  data(ref: number | string): Uint8Array {
    const i = typeof ref === "number" ? ref : this.indexOf(ref);
    const lump = this.lumps[i];
    if (!lump) throw new Error(`Lump not found: ${ref}`);
    return this.bytes.subarray(lump.offset, lump.offset + lump.size);
  }

  /** A DataView over a lump's bytes (offset 0 = lump start). */
  dataView(ref: number | string): DataView {
    const d = this.data(ref);
    return new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
}

/** Read a fixed-width name field: ASCII up to the first NUL, uppercased. */
export function readName(bytes: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  const stop = offset + maxLen;
  while (end < stop && bytes[end] !== 0) end++;
  let s = "";
  for (let i = offset; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s.toUpperCase();
}
