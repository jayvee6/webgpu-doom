/**
 * MUS music playback via Web Audio oscillator synthesis.
 *
 * Parses Doom's MUS binary format (id Software, used in all Doom WADs) into a
 * timed event list, then schedules OscillatorNode + GainNode pairs with the
 * Web Audio scheduler. Square waves for melodic channels, sawtooth at 55 Hz
 * for the percussion channel (ch 15). Loops automatically when the score ends.
 */

import { Wad } from "../wad/reader";

interface MusEvent {
  timeSec: number;
  on: boolean;
  channel: number;
  note: number;
  volume: number;
}

function parseMus(data: Uint8Array): MusEvent[] {
  // Validate magic "MUS\x1a"
  if (data[0] !== 0x4D || data[1] !== 0x55 || data[2] !== 0x53 || data[3] !== 0x1A) return [];
  const view = new DataView(data.buffer, data.byteOffset);
  const scoreStart = view.getUint16(6, true);
  const events: MusEvent[] = [];
  let pos = scoreStart;
  let timeSec = 0;
  const channelVol = new Uint8Array(16).fill(127);
  while (pos < data.length) {
    if (pos >= data.length) break;
    const b = data[pos++]!;
    const type = (b >> 4) & 7;
    const hasDelay = (b & 0x80) !== 0;
    const ch = b & 0x0F;
    if (type === 6) break; // end
    if (type === 0) { // note off
      const note = data[pos++]! & 0x7F;
      events.push({ timeSec, on: false, channel: ch, note, volume: 0 });
    } else if (type === 1) { // note on
      const nb = data[pos++]!;
      const hasVol = (nb & 0x80) !== 0;
      const note = nb & 0x7F;
      if (hasVol) channelVol[ch] = data[pos++]! & 0x7F;
      events.push({ timeSec, on: true, channel: ch, note, volume: channelVol[ch]! });
    } else if (type === 2) { pos++; } // pitch — skip 1
    else if (type === 3) { pos++; } // system — skip 1
    else if (type === 4) { pos += 2; } // ctrl — skip 2
    if (hasDelay) {
      let delay = 0;
      let db: number;
      do { db = data[pos++]!; delay = delay * 128 + (db & 0x7F); } while (db & 0x80);
      timeSec += delay / 140;
    }
  }
  return events;
}

export class MusicPlayer {
  private readonly wad: Wad;
  private readonly ctx: AudioContext | null;
  private masterGain: GainNode | null;
  private activeOscs = new Map<string, { osc: OscillatorNode; gain: GainNode }>();
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private currentLump = "";

  constructor(wad: Wad, ctx: AudioContext | null) {
    this.wad = wad;
    this.ctx = ctx;
    if (ctx) {
      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = 0.5;
      this.masterGain.connect(ctx.destination);
    } else {
      this.masterGain = null;
    }
  }

  start(lumpName: string): void {
    if (!this.ctx || !this.masterGain) return;
    this.stop();
    const idx = this.wad.indexOf(lumpName);
    if (idx < 0) return;
    this.currentLump = lumpName;
    const data = this.wad.data(idx);
    const events = parseMus(data);
    if (events.length === 0) return;
    this.scheduleEvents(events);
  }

  private scheduleEvents(events: MusEvent[]): void {
    const ctx = this.ctx;
    const masterGain = this.masterGain;
    if (!ctx || !masterGain) return;
    const now = ctx.currentTime + 0.05;
    const duration = events.length > 0 ? events[events.length - 1]!.timeSec + 0.5 : 0;
    for (const ev of events) {
      const t = now + ev.timeSec;
      const key = ev.channel + "_" + ev.note;
      if (ev.on) {
        const freq = ev.channel === 15 ? 55 : 440 * Math.pow(2, (ev.note - 69) / 12);
        const osc = ctx.createOscillator();
        osc.type = ev.channel === 15 ? "sawtooth" : "square";
        osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime((ev.volume / 127) * 0.07, t + 0.01);
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start(t);
        this.activeOscs.set(key, { osc, gain });
      } else {
        const active = this.activeOscs.get(key);
        if (active) {
          active.gain.gain.setValueAtTime(active.gain.gain.value, t);
          active.gain.gain.linearRampToValueAtTime(0, t + 0.12);
          active.osc.stop(t + 0.13);
          this.activeOscs.delete(key);
        }
      }
    }
    // Loop: reschedule after the score duration elapses
    const lump = this.currentLump;
    this.loopTimer = setTimeout(() => {
      if (this.currentLump === lump) this.start(lump);
    }, duration * 1000);
  }

  stop(): void {
    if (this.loopTimer !== null) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    this.currentLump = "";
    const t = this.ctx?.currentTime ?? 0;
    for (const { osc, gain } of this.activeOscs.values()) {
      try { gain.gain.setValueAtTime(0, t); osc.stop(t + 0.01); } catch { /* already stopped */ }
    }
    this.activeOscs.clear();
  }

  setVolume(v: number): void { if (this.masterGain) this.masterGain.gain.value = Math.max(0, Math.min(1, v)); }
}
