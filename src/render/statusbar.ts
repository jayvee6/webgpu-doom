/**
 * Status bar HUD — Canvas2D, drawn over the WebGPU frame.
 * Renders health / armor / ammo using WAD STTNUM* digit sprites when available,
 * falling back to plain monospace text. Mirrors the Canvas2D pattern used by
 * WeaponHUD: decode via decodePatchFull, blit through an offscreen HTMLCanvasElement.
 */

import { Wad } from "../wad/reader";
import { decodePatchFull } from "../wad/textures";

interface NumGlyph { canvas: HTMLCanvasElement; w: number; h: number }

export class StatusBar {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly glyphs: (NumGlyph | null)[] = [];
  private readonly hasSprites: boolean;

  constructor(canvas: HTMLCanvasElement, wad: Wad, palette: Uint8Array) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    let anyFound = false;
    for (let i = 0; i <= 9; i++) {
      const idx = wad.indexOf("STTNUM" + i);
      if (idx < 0) { this.glyphs.push(null); continue; }
      const p = decodePatchFull(wad.data(idx));
      if (!p) { this.glyphs.push(null); continue; }
      const imgData = new ImageData(p.width, p.height);
      for (let j = 0; j < p.width * p.height; j++) {
        if (p.mask[j]) {
          const ci = p.indices[j]! * 4;
          imgData.data[j * 4]     = palette[ci]!;
          imgData.data[j * 4 + 1] = palette[ci + 1]!;
          imgData.data[j * 4 + 2] = palette[ci + 2]!;
          imgData.data[j * 4 + 3] = 255;
        }
      }
      const cv = document.createElement("canvas");
      cv.width = p.width; cv.height = p.height;
      cv.getContext("2d")!.putImageData(imgData, 0, 0);
      this.glyphs.push({ canvas: cv, w: p.width, h: p.height });
      anyFound = true;
    }
    this.hasSprites = anyFound;
  }

  draw(health: number, armor: number, ammo: number): void {
    const W = window.innerWidth, H = window.innerHeight;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
    }
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const BAR_H = Math.max(36, Math.round(H * 0.07));
    const y0 = H - BAR_H;
    c.fillStyle = "rgba(0,0,0,0.72)";
    c.fillRect(0, y0, W, BAR_H);
    c.fillStyle = "rgba(125,255,138,0.18)";
    c.fillRect(0, y0, W, 1);
    const third = W / 3;
    this.drawNum(c, Math.max(0, Math.floor(health)), third * 0.5, y0, BAR_H, "#ff5555", "HEALTH");
    this.drawNum(c, Math.max(0, Math.floor(armor)),  third * 1.5, y0, BAR_H, "#5599ff", "ARMOR");
    this.drawNum(c, Math.max(0, Math.floor(ammo)),   third * 2.5, y0, BAR_H, "#ffdd55", "AMMO");
  }

  private drawNum(
    c: CanvasRenderingContext2D,
    val: number,
    cx: number,
    y0: number,
    BAR_H: number,
    color: string,
    label: string,
  ): void {
    const text = String(val);
    if (this.hasSprites && this.glyphs[0]) {
      const scale = (BAR_H * 0.72) / this.glyphs[0].h;
      c.imageSmoothingEnabled = false;
      let totalW = 0;
      for (const ch of text) { totalW += (this.glyphs[Number(ch)]?.w ?? 8) * scale + 1; }
      let dx = cx - totalW / 2;
      for (const ch of text) {
        const g = this.glyphs[Number(ch)];
        if (g) {
          c.drawImage(g.canvas, dx, y0 + BAR_H * 0.08, g.w * scale, g.h * scale);
          dx += g.w * scale + 1;
        }
      }
    } else {
      c.font = `bold ${Math.round(BAR_H * 0.65)}px ui-monospace,Menlo,monospace`;
      c.fillStyle = color;
      c.textAlign = "center";
      c.fillText(text, cx, y0 + BAR_H * 0.72);
    }
    c.font = `${Math.round(BAR_H * 0.22)}px ui-monospace,Menlo,monospace`;
    c.fillStyle = "rgba(125,255,138,0.55)";
    c.textAlign = "center";
    c.fillText(label, cx, y0 + BAR_H - 3);
  }

  dispose(): void {}
}
