/**
 * Animated sector lighting (Doom light specials). Produces a live per-sector
 * light value (0..1) each tic, uploaded to a GPU storage buffer the world shader
 * reads — the lighting analogue of the dynamic-heights buffer. Sprites sample the
 * same live value so things in flickering rooms flicker too.
 *
 * E1M1 uses: special 1 (random flicker) and special 12 (synchronised slow strobe).
 * Both alternate between the sector's own light (bright) and the lowest adjacent
 * sector light (dark) — Doom's model. Other specials (7 nukage, 9 secret) don't
 * touch light.
 */

import type { DoomMap } from "../wad/maps";

// Doom strobe timing (35 tics/sec): bright ~5 tics, dark ~35 tics, synchronised.
const STROBE_BRIGHT = 5 / 35;
const STROBE_PERIOD = (5 + 35) / 35;

export class LightState {
  private readonly base: Float32Array; // static light 0..1 per sector
  private readonly dark: Float32Array; // lowest-neighbour light 0..1
  private readonly special: Int8Array; // 1 flicker, 12 strobe, else 0
  private readonly live: Float32Array<ArrayBuffer>;
  private readonly flickerTimer: Float32Array;
  private readonly flickerOn: Uint8Array;
  private strobePhase = 0;
  private dirty = false; // a live light value changed since the last consumeDirty()

  constructor(map: DoomMap) {
    const n = map.sectors.length;
    this.base = new Float32Array(n);
    this.dark = new Float32Array(n);
    this.special = new Int8Array(n);
    this.live = new Float32Array(n);
    this.flickerTimer = new Float32Array(n);
    this.flickerOn = new Uint8Array(n);

    // Lowest light among neighbours sharing a linedef.
    const minNeighbor = new Float32Array(n).fill(Infinity);
    for (const ld of map.linedefs) {
      const f = ld.right >= 0 ? map.sidedefs[ld.right]!.sector : -1;
      const b = ld.left >= 0 ? map.sidedefs[ld.left]!.sector : -1;
      if (f >= 0 && b >= 0) {
        minNeighbor[f] = Math.min(minNeighbor[f]!, map.sectors[b]!.light);
        minNeighbor[b] = Math.min(minNeighbor[b]!, map.sectors[f]!.light);
      }
    }

    for (let i = 0; i < n; i++) {
      const sec = map.sectors[i]!;
      this.base[i] = sec.light / 255;
      const mn = isFinite(minNeighbor[i]!) ? minNeighbor[i]! : sec.light * 0.4;
      this.dark[i] = Math.min(this.base[i]!, mn / 255);
      this.special[i] = sec.special === 1 ? 1 : sec.special === 12 ? 12 : 0;
      this.live[i] = this.base[i]!;
      this.flickerOn[i] = 1;
      this.flickerTimer[i] = 0.1 + Math.random() * 0.6;
    }
  }

  update(dt: number): void {
    this.strobePhase = (this.strobePhase + dt) % STROBE_PERIOD;
    const strobeBright = this.strobePhase < STROBE_BRIGHT;
    for (let i = 0; i < this.live.length; i++) {
      const sp = this.special[i]!;
      let nv = this.live[i]!;
      if (sp === 12) {
        nv = strobeBright ? this.base[i]! : this.dark[i]!;
      } else if (sp === 1) {
        this.flickerTimer[i]! -= dt;
        if (this.flickerTimer[i]! <= 0) {
          const on = (this.flickerOn[i] = this.flickerOn[i]! ^ 1);
          // mostly bright, brief dark flickers (Doom P_SpawnLightFlash feel)
          this.flickerTimer[i] = on ? 0.15 + Math.random() * 1.6 : 0.03 + Math.random() * 0.22;
        }
        nv = this.flickerOn[i] ? this.base[i]! : this.dark[i]!;
      } else {
        nv = this.base[i]!;
      }
      // Only flag a GPU re-upload when a value actually flips (strobe/flicker
      // boundaries are rare — static-light sectors never dirty after construction).
      if (nv !== this.live[i]) { this.live[i] = nv; this.dirty = true; }
    }
  }

  /** Did any live light value change since the last call? Clears the flag. */
  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  /** Live per-sector light (0..1) for the GPU buffer. */
  lights(): Float32Array<ArrayBuffer> {
    return this.live;
  }

  sectorLight(sector: number): number {
    return sector >= 0 && sector < this.live.length ? this.live[sector]! : 1;
  }
}
