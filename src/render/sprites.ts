/**
 * Billboarded sprite (THINGS) renderer. Each thing is a camera-facing, upright
 * (Y-axis) billboard: an instanced quad expanded in the vertex shader along the
 * camera's horizontal right vector and world up. Sprites are alpha-tested
 * (1-bit Doom transparency → discard), depth-tested + depth-writing so they
 * occlude correctly. Placement uses the patch left/top offsets so sprites stand
 * on the floor and centre on the thing.
 */

import type { SpriteLib, SpriteImage } from "../wad/sprites";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const ATLAS_W = 2048;
const FLOATS_PER_INST = 11;

export interface SpriteRequest {
  lump: string;
  x: number;
  y: number;
  floor: number;
  light: number;
}

const WGSL = /* wgsl */ `
struct Frame { vp : mat4x4f, camPos : vec3f, _p0 : f32, camRight : vec3f, _p1 : f32 };
@group(0) @binding(0) var<uniform> frame : Frame;

struct Inst {
  cx : f32, cy : f32, cz : f32,
  halfW : f32, halfH : f32, hoff : f32, light : f32,
  ox : f32, oy : f32, w : f32, h : f32,
};
@group(1) @binding(0) var<storage, read> insts : array<Inst>;
@group(1) @binding(1) var sprTex : texture_2d<u32>;   // RG8: r=palette index, g=mask
@group(1) @binding(2) var litPalette : texture_2d<f32>; // 256×32 lit palette LUT

fn lightRow(light : f32, dist : f32) -> u32 {
  let li = floor(clamp(light, 0.0, 1.0) * 15.999);
  let startmap = (15.0 - li) * 4.0;
  let scale = 2400.0 / max(dist, 16.0);
  let level = clamp(startmap - scale, 0.0, 31.0);
  return u32(level);
}

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) uv : vec2f,
  @location(1) light : f32,
  @location(2) @interpolate(flat) rect : vec4f,
  @location(3) world : vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let c = corners[vi];
  let inst = insts[ii];
  let right = frame.camRight;
  let up = vec3f(0.0, 1.0, 0.0);
  let center = vec3f(inst.cx, inst.cy, inst.cz);
  let world = center + (c.x * inst.halfW + inst.hoff) * right + (c.y * inst.halfH) * up;

  var o : VSOut;
  o.clip = frame.vp * vec4f(world, 1.0);
  // top of sprite at +y → texel row 0
  o.uv = vec2f((c.x * 0.5 + 0.5) * inst.w, (0.5 - c.y * 0.5) * inst.h);
  o.light = inst.light;
  o.rect = vec4f(inst.ox, inst.oy, inst.w, inst.h);
  o.world = world;
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let tx = u32(clamp(in.uv.x, 0.0, in.rect.z - 1.0));
  let ty = u32(clamp(in.uv.y, 0.0, in.rect.w - 1.0));
  let texel = textureLoad(sprTex, vec2u(u32(in.rect.x) + tx, u32(in.rect.y) + ty), 0);
  if (texel.g < 128u) { discard; } // mask = transparent
  let dist = length(in.world - frame.camPos);
  let row = lightRow(in.light, dist);
  return textureLoad(litPalette, vec2u(texel.r, row), 0);
}
`;

export class SpriteRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly ubuf: GPUBuffer;
  private readonly frameBG: GPUBindGroup;
  private readonly dataBG: GPUBindGroup;
  private readonly instBuf: GPUBuffer;
  private atlasTex!: GPUTexture;
  private litTex!: GPUTexture;
  private readonly maxInstances: number;
  /** lump → atlas placement + offsets, for per-frame instance building. */
  private readonly rects = new Map<string, { ox: number; oy: number; w: number; h: number; lo: number; to: number }>();
  private readonly scratch: Float32Array<ArrayBuffer>;
  private readonly frameScratch = new Float32Array(24); // reused per-frame uniform staging
  instanceCount = 0;
  readonly atlasHeight: number;
  readonly missing: string[] = [];

  constructor(device: GPUDevice, format: GPUTextureFormat, lib: SpriteLib, lumps: string[], litPalette: Uint8Array<ArrayBuffer>, maxInstances: number) {
    this.device = device;
    this.maxInstances = Math.max(1, maxInstances);
    this.scratch = new Float32Array(this.maxInstances * FLOATS_PER_INST);

    // Decode the given sprite lumps and shelf-pack into the RG8 index+mask atlas.
    const images = new Map<string, SpriteImage>();
    for (const lump of lumps) {
      if (images.has(lump)) continue;
      const img = lib.image(lump);
      if (img) images.set(lump, img);
      else this.missing.push(lump);
    }
    lumps = [...images.keys()];
    const origin = new Map<string, [number, number]>();
    const byHeight = [...lumps].sort((a, b) => images.get(b)!.height - images.get(a)!.height);
    let x = 0, y = 0, shelfH = 0;
    for (const lump of byHeight) {
      const img = images.get(lump)!;
      const w = Math.min(img.width, ATLAS_W);
      if (x + w > ATLAS_W) { x = 0; y += shelfH; shelfH = 0; }
      origin.set(lump, [x, y]);
      x += w;
      if (img.height > shelfH) shelfH = img.height;
    }
    const atlasH = Math.max(1, y + shelfH);
    this.atlasHeight = atlasH;

    // RG8 atlas: R = palette index, G = mask.
    const atlas = new Uint8Array(ATLAS_W * atlasH * 2);
    for (const lump of lumps) {
      const img = images.get(lump)!;
      const [ox, oy] = origin.get(lump)!;
      const w = Math.min(img.width, ATLAS_W);
      for (let row = 0; row < img.height; row++) {
        const src = row * img.width * 2;
        const dst = ((oy + row) * ATLAS_W + ox) * 2;
        atlas.set(img.rg.subarray(src, src + w * 2), dst);
      }
    }
    const atlasTex = device.createTexture({
      label: "sprite-atlas",
      size: { width: ATLAS_W, height: atlasH },
      format: "rg8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: atlasTex }, atlas, { bytesPerRow: ATLAS_W * 2, rowsPerImage: atlasH }, { width: ATLAS_W, height: atlasH });

    // Shared lit-palette LUT (256×32) — same as the world's.
    const litTex = device.createTexture({
      label: "sprite-lit-palette",
      size: { width: 256, height: 32 },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: litTex }, litPalette, { bytesPerRow: 256 * 4, rowsPerImage: 32 }, { width: 256, height: 32 });
    this.atlasTex = atlasTex;
    this.litTex = litTex;

    // Record each lump's atlas placement + offsets for per-frame instancing.
    for (const lump of lumps) {
      const img = images.get(lump)!;
      const [ox, oy] = origin.get(lump)!;
      this.rects.set(lump, { ox, oy, w: img.width, h: img.height, lo: img.leftOffset, to: img.topOffset });
    }
    // Instance storage sized for the worst case; filled each frame by setBillboards.
    this.instBuf = device.createBuffer({
      label: "sprite-insts",
      size: this.maxInstances * FLOATS_PER_INST * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.ubuf = device.createBuffer({ label: "sprite-frame", size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const frameBGL = device.createBindGroupLayout({
      label: "sprite-frame-bgl",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    const dataBGL = device.createBindGroupLayout({
      label: "sprite-data-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint", viewDimension: "2d" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      ],
    });
    this.frameBG = device.createBindGroup({ label: "sprite-frame-bg", layout: frameBGL, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });
    this.dataBG = device.createBindGroup({
      label: "sprite-data-bg",
      layout: dataBGL,
      entries: [
        { binding: 0, resource: { buffer: this.instBuf } },
        { binding: 1, resource: atlasTex.createView() },
        { binding: 2, resource: litTex.createView() },
      ],
    });

    const module = device.createShaderModule({ label: "sprite-wgsl", code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "sprite-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameBGL, dataBGL] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: 4 },
    });
  }

  setFrame(vp: Float32Array<ArrayBuffer>, camPos: readonly [number, number, number], camRight: readonly [number, number, number]): void {
    const buf = this.frameScratch;
    buf.set(vp, 0);
    buf[16] = camPos[0]; buf[17] = camPos[1]; buf[18] = camPos[2];
    buf[20] = camRight[0]; buf[21] = camRight[1]; buf[22] = camRight[2];
    this.device.queue.writeBuffer(this.ubuf, 0, buf);
  }

  /** Rebuild the instance buffer from a live billboard list (per frame). */
  setBillboards(requests: SpriteRequest[]): void {
    const s = this.scratch;
    let n = 0;
    for (const r of requests) {
      if (n >= this.maxInstances) break;
      const rect = this.rects.get(r.lump);
      if (!rect) continue;
      const o = n * FLOATS_PER_INST;
      s[o] = r.x;
      s[o + 1] = r.floor + rect.to - rect.h / 2; // center y (feet + topoffset - h/2)
      s[o + 2] = -r.y;
      s[o + 3] = rect.w / 2;
      s[o + 4] = rect.h / 2;
      s[o + 5] = rect.w / 2 - rect.lo;
      s[o + 6] = r.light;
      s[o + 7] = rect.ox;
      s[o + 8] = rect.oy;
      s[o + 9] = rect.w;
      s[o + 10] = rect.h;
      n++;
    }
    this.instanceCount = n;
    if (n > 0) this.device.queue.writeBuffer(this.instBuf, 0, s, 0, n * FLOATS_PER_INST);
  }

  dispose(): void {
    this.instBuf.destroy();
    this.ubuf.destroy();
    this.atlasTex.destroy();
    this.litTex.destroy();
  }

  /** Record the sprite draw into an already-open render pass (shared with world/sky). */
  draw(pass: GPURenderPassEncoder): void {
    if (this.instanceCount === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frameBG);
    pass.setBindGroup(1, this.dataBG);
    pass.draw(6, this.instanceCount);
  }
}
