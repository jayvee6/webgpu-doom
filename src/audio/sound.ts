/**
 * Doom SFX playback via Web Audio. Sound lumps (DS*) are DMX format: u16 format(3),
 * u16 sampleRate, u32 sampleCount, then unsigned-8-bit PCM (with 16 pad samples at
 * each end we trim). Decoded lazily into AudioBuffers and cached. Positional sounds
 * get distance attenuation + stereo pan relative to the listener.
 *
 * The AudioContext starts suspended (browser autoplay policy) — resume() must be
 * called from a user gesture (the title click-to-enter).
 */

import { Wad } from "../wad/reader";

const MAX_DIST = 1400; // beyond this a positional sound is silent
const MASTER = 0.55;

export class SoundSystem {
  private readonly wad: Wad;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly cache = new Map<string, AudioBuffer | null>();
  private lx = 0;
  private ly = 0;
  private lyaw = 0;

  constructor(wad: Wad) {
    this.wad = wad;
  }

  /** Create/resume the context — must run inside a user gesture. */
  resume(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = MASTER;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setListener(x: number, y: number, yaw: number): void {
    this.lx = x; this.ly = y; this.lyaw = yaw;
  }

  /** Play a sound lump. With (x,y) it's positional (distance + pan); without, flat. */
  play(name: string, x?: number, y?: number): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master || ctx.state !== "running") return;
    const buf = this.decode(name);
    if (!buf) return;

    let gainVal = 1;
    let pan = 0;
    if (x !== undefined && y !== undefined) {
      const dx = x - this.lx, dy = y - this.ly;
      const dist = Math.hypot(dx, dy);
      if (dist >= MAX_DIST) return;
      gainVal = 1 - dist / MAX_DIST;
      if (dist > 1) {
        // right vector in map space = (cos yaw, -sin yaw); project the direction onto it
        pan = Math.max(-1, Math.min(1, (dx * Math.cos(this.lyaw) - dy * Math.sin(this.lyaw)) / dist));
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gainVal;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(g).connect(p).connect(master);
    } else {
      src.connect(g).connect(master);
    }
    src.start();
  }

  private decode(name: string): AudioBuffer | null {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    let buf: AudioBuffer | null = null;
    const idx = this.wad.indexOf(name);
    if (idx >= 0 && this.ctx) {
      try {
        const data = this.wad.data(name);
        if (data.byteLength >= 8) {
          const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const format = v.getUint16(0, true);
          let rate = v.getUint16(2, true);
          // A junk rate outside Web Audio's accepted range throws createBuffer;
          // fall back to Doom's usual 11025 Hz.
          if (rate < 8000 || rate > 48000) rate = 11025;
          const count = v.getUint32(4, true);
          if (format === 3 && count > 32 && 8 + count <= data.byteLength) {
            const start = 8 + 16, end = 8 + count - 16; // trim the pad samples
            const n = end - start;
            if (n > 0) {
              buf = this.ctx.createBuffer(1, n, rate);
              const ch = buf.getChannelData(0);
              for (let i = 0; i < n; i++) ch[i] = (data[start + i]! - 128) / 128;
            }
          }
        }
      } catch {
        // Malformed lump — cache the failure so a bad sound never throws into a
        // gameplay frame, and never retries the decode.
        buf = null;
      }
    }
    this.cache.set(name, buf);
    return buf;
  }
}
