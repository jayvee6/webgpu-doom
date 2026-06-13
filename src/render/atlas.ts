/**
 * Packs all used wall textures + flats into a single R8Uint palette-index atlas,
 * plus a 256×1 RGBA palette texture and a storage buffer of per-texture rects.
 * The fragment shader wraps UVs with integer modulo into each rect and does
 * point-sampled palette lookup — no sampler, no filtering (authentic + correct).
 */

import type { TextureLib, IndexedImage } from "../wad/textures";

const ATLAS_W = 2048; // multiple of 256 → satisfies writeTexture bytesPerRow

export class TextureAtlas {
  readonly bindGroup: GPUBindGroup;
  readonly layout: GPUBindGroupLayout;
  private readonly ids = new Map<string, number>();
  readonly missing: string[] = [];
  readonly atlasHeight: number;

  /** Stable texture id for a name (walls + flats share the id space). -1 if absent. */
  id(name: string): number {
    return this.ids.get(name) ?? -1;
  }

  constructor(device: GPUDevice, lib: TextureLib, paletteRGBA: Uint8Array<ArrayBuffer>, names: string[]) {
    // Resolve each name to an image (fallback 2×2 if missing).
    const fallback: IndexedImage = { width: 2, height: 2, indices: new Uint8Array([0, 0, 0, 0]) };
    const images: IndexedImage[] = [];
    const order: number[] = [];
    names.forEach((name, i) => {
      const img = lib.texture(name) ?? lib.flat(name);
      if (!img) this.missing.push(name);
      this.ids.set(name, i);
      images.push(img ?? fallback);
      order.push(i);
    });

    // Shelf-pack (tallest first) into fixed-width atlas; exact-coord sampling → no padding.
    order.sort((a, b) => images[b]!.height - images[a]!.height);
    const origin = new Array<[number, number]>(images.length);
    let x = 0, y = 0, shelfH = 0;
    for (const id of order) {
      const img = images[id]!;
      const w = Math.min(img.width, ATLAS_W);
      if (x + w > ATLAS_W) { x = 0; y += shelfH; shelfH = 0; }
      origin[id] = [x, y];
      x += w;
      if (img.height > shelfH) shelfH = img.height;
    }
    const atlasH = Math.max(1, y + shelfH);
    this.atlasHeight = atlasH;

    // Blit indices into the atlas buffer.
    const atlas = new Uint8Array(ATLAS_W * atlasH);
    for (let id = 0; id < images.length; id++) {
      const img = images[id]!;
      const [ox, oy] = origin[id]!;
      const w = Math.min(img.width, ATLAS_W);
      for (let row = 0; row < img.height; row++) {
        const src = row * img.width;
        const dst = (oy + row) * ATLAS_W + ox;
        atlas.set(img.indices.subarray(src, src + w), dst);
      }
    }

    // GPU resources.
    const atlasTex = device.createTexture({
      label: "tex-atlas",
      size: { width: ATLAS_W, height: atlasH },
      format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: atlasTex }, atlas, { bytesPerRow: ATLAS_W, rowsPerImage: atlasH }, { width: ATLAS_W, height: atlasH });

    const paletteTex = device.createTexture({
      label: "palette",
      size: { width: 256, height: 1 },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: paletteTex }, paletteRGBA, { bytesPerRow: 256 * 4, rowsPerImage: 1 }, { width: 256, height: 1 });

    // rects[id] = vec4u(originX, originY, width, height)
    const rects = new Uint32Array(images.length * 4);
    for (let id = 0; id < images.length; id++) {
      const img = images[id]!;
      const [ox, oy] = origin[id]!;
      rects.set([ox, oy, img.width, img.height], id * 4);
    }
    const rectsBuf = device.createBuffer({
      label: "tex-rects",
      size: Math.max(16, rects.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(rectsBuf, 0, rects);

    this.layout = device.createBindGroupLayout({
      label: "atlas-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint", viewDimension: "2d" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: "atlas-bg",
      layout: this.layout,
      entries: [
        { binding: 0, resource: atlasTex.createView() },
        { binding: 1, resource: paletteTex.createView() },
        { binding: 2, resource: { buffer: rectsBuf } },
      ],
    });
  }
}
