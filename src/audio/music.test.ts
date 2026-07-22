import { describe, it, expect } from "vitest";
import { MusicPlayer } from "./music";
import type { Wad } from "../wad/reader";

/** Minimal valid MUS lump: header + one note-on (ch0, note64) + score-end. */
function minimalMus(): Uint8Array {
  const b = new Uint8Array(19);
  b.set([0x4d, 0x55, 0x53, 0x1a], 0); // "MUS\x1a"
  b[6] = 16; b[7] = 0;                // scoreStart = 16 (u16 LE)
  b[16] = 0x10;                       // note-on, channel 0
  b[17] = 0x40;                       // note 64, no volume byte
  b[18] = 0x60;                       // score-end
  return b;
}

const wad = {
  indexOf: (n: string) => (n === "D_E1M1" ? 0 : -1),
  data: () => minimalMus(),
} as unknown as Wad;

/** Mock AudioContext; `oscCount()` reveals whether playback actually got scheduled. */
function mockAudio() {
  let oscCount = 0;
  const ctx: any = {
    state: "suspended" as "suspended" | "running",
    currentTime: 0,
    destination: {},
    createGain: () => ({
      gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
      connect() {},
    }),
    createOscillator: () => {
      oscCount++;
      return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    },
  };
  return { ctx, oscCount: () => oscCount };
}

describe("MusicPlayer — first-level silence regression", () => {
  it("does not schedule anything while the AudioContext is suspended", () => {
    const { ctx, oscCount } = mockAudio();
    const music = new MusicPlayer(wad, () => ctx as AudioContext);
    music.start("D_E1M1"); // requested before a user gesture unlocked audio
    expect(oscCount()).toBe(0);
  });

  it("resume() plays a track that was requested before the context was running", () => {
    const { ctx, oscCount } = mockAudio();
    const music = new MusicPlayer(wad, () => ctx as AudioContext);

    music.start("D_E1M1"); // E1M1 built before audio unlocked → dropped
    expect(oscCount()).toBe(0);

    ctx.state = "running";  // user gesture unlocks the context
    music.resume();         // enter() calls this after sound.resume()
    expect(oscCount()).toBeGreaterThan(0); // now the track actually plays

    music.stop(); // clear the reschedule timer so the test doesn't leak it
  });

  it("resume() is a no-op when no track is pending", () => {
    const { ctx, oscCount } = mockAudio();
    ctx.state = "running";
    const music = new MusicPlayer(wad, () => ctx as AudioContext);
    music.resume();
    expect(oscCount()).toBe(0);
  });

  it("start() plays immediately when the context is already running", () => {
    const { ctx, oscCount } = mockAudio();
    ctx.state = "running";
    const music = new MusicPlayer(wad, () => ctx as AudioContext);
    music.start("D_E1M1");
    expect(oscCount()).toBeGreaterThan(0);
    music.stop();
  });
});
