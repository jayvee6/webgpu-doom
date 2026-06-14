/**
 * First-person weapon overlay (Canvas2D, not the WebGPU pass — pragmatic for a
 * HUD sprite). Decodes the pistol + muzzle-flash sprites from the WAD via the
 * palette, draws the gun bottom-centre with a walk bob, and flashes a fire frame
 * + muzzle flash when firing. The flash is positioned by the offset DIFFERENCE
 * between the gun and flash patches, so it lands on the barrel automatically.
 */

import { Wad } from "../wad/reader";
import { decodePatchFull } from "../wad/textures";

interface Spr { canvas: HTMLCanvasElement; w: number; h: number; lo: number; to: number }

function decodeRGBA(wad: Wad, name: string, palette: Uint8Array): Spr | null {
  const idx = wad.indexOf(name);
  if (idx < 0) return null;
  const p = decodePatchFull(wad.data(idx));
  if (!p) return null;
  const img = new ImageData(p.width, p.height);
  for (let i = 0; i < p.width * p.height; i++) {
    if (p.mask[i]) {
      const c = p.indices[i]! * 4;
      img.data[i * 4] = palette[c]!;
      img.data[i * 4 + 1] = palette[c + 1]!;
      img.data[i * 4 + 2] = palette[c + 2]!;
      img.data[i * 4 + 3] = 255;
    }
  }
  const cv = document.createElement("canvas");
  cv.width = p.width; cv.height = p.height;
  cv.getContext("2d")!.putImageData(img, 0, 0);
  return { canvas: cv, w: p.width, h: p.height, lo: p.leftOffset, to: p.topOffset };
}

export class WeaponHUD {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ready: Spr | null;
  private readonly fire: Spr | null;
  private readonly flash: Spr | null;
  private readonly sgunReady: Spr | null;
  private readonly sgunFire: Spr | null;
  private readonly sgunFlash: Spr | null;
  private flashTimer = 0;
  private bob = 0;

  constructor(canvas: HTMLCanvasElement, wad: Wad, palette: Uint8Array) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.ready = decodeRGBA(wad, "PISGA0", palette);
    this.fire = decodeRGBA(wad, "PISGB0", palette) ?? this.ready;
    this.flash = decodeRGBA(wad, "PISFA0", palette) ?? decodeRGBA(wad, "PISFB0", palette);
    this.sgunReady = decodeRGBA(wad, "SHTGA0", palette);
    this.sgunFire  = decodeRGBA(wad, "SHTGB0", palette) ?? this.sgunReady;
    this.sgunFlash = decodeRGBA(wad, "SGTFA0", palette) ?? decodeRGBA(wad, "SGTFB0", palette);
  }

  onFire(): void {
    this.flashTimer = 0.09;
  }

  draw(moving: boolean, dt: number, weapon: "pistol" | "shotgun" = "pistol"): void {
    const W = window.innerWidth, H = window.innerHeight;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.imageSmoothingEnabled = false;
    if (!this.ready) return;

    if (moving) this.bob += dt * 9;
    const bobX = Math.sin(this.bob) * 0.008 * W;
    const bobY = Math.abs(Math.sin(this.bob)) * 0.013 * H;

    this.flashTimer -= dt;
    const firing = this.flashTimer > 0;
    const readySpr = weapon === "shotgun" && this.sgunReady ? this.sgunReady : this.ready;
    const fireSpr  = weapon === "shotgun" && this.sgunFire  ? this.sgunFire  : (this.fire ?? this.ready);
    const flashSpr = weapon === "shotgun" && this.sgunFlash ? this.sgunFlash : this.flash;
    const gun = (firing && fireSpr) ? fireSpr : (readySpr ?? this.ready);

    // Position the sprite so its horizontal centre is at the screen centre.
    // Freedoom weapon sprites have non-standard leftOffset values; centering
    // the sprite image aligns the barrel with the crosshair.
    const scale = H / 200;
    const gunX = W / 2 - (gun.w / 2) * scale + bobX;
    const gunY = H - gun.h * scale + bobY;
    c.drawImage(gun.canvas, gunX, gunY, gun.w * scale, gun.h * scale);

    if (firing && flashSpr) {
      // Flash placed relative to the gun by the offset difference → lands on the barrel.
      const fx = gunX + (gun.lo - flashSpr.lo) * scale;
      const fy = gunY + (gun.to - flashSpr.to) * scale;
      c.drawImage(flashSpr.canvas, fx, fy, flashSpr.w * scale, flashSpr.h * scale);
    }
  }
}
