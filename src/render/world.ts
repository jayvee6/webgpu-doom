/**
 * World renderer with DYNAMIC sector heights (for doors/lifts/moving floors).
 * Each vertex stores (x, z, heightIndex) instead of a baked Y; the vertex shader
 * reads the live height from a storage buffer indexed by heightIndex
 * (sector*2 + 0=floor / 1=ceil). Updating that small buffer animates all walls +
 * flats touching a sector for free — no mesh rebuild.
 *
 * Vertex (10 f32, 40-byte stride):
 *   a: vec4f = (x, z, heightIndex, lightSector)
 *   b: vec3f = (u, vBase, vTop)
 *   c: vec3f = (vMode, contrast, texId)
 * V coord: flat (vMode 0) → vBase; wall (vMode 1) → vBase + (vTop - worldY).
 */

import type { TextureAtlas } from "./atlas";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
export const SAMPLES = 4; // MSAA sample count (shared by all world-pass pipelines)

const WGSL = /* wgsl */ `
struct Frame { vp : mat4x4f, camPos : vec3f, _pad : f32 };
@group(0) @binding(0) var<uniform> frame : Frame;
@group(0) @binding(1) var<storage, read> heights : array<f32>;
@group(0) @binding(2) var<storage, read> sectorLights : array<f32>;

@group(1) @binding(0) var atlasTex : texture_2d<u32>;
@group(1) @binding(1) var palette  : texture_2d<f32>;
@group(1) @binding(2) var<storage, read> rects : array<vec4<u32>>;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) uv : vec2f,
  @location(1) @interpolate(flat) light : f32,
  @location(2) @interpolate(flat) texId : u32,
  @location(3) world : vec3f,
};

// Doom light level → lit-palette row (0 bright → 31 dark) with distance diminishing.
// Bright sectors (light≈1) sit near row 0 and barely fade; dim sectors darken with
// range. Near surfaces brighten toward the sector's startmap; far recede to it.
fn lightRow(light : f32, dist : f32) -> u32 {
  let li = floor(clamp(light, 0.0, 1.0) * 15.999);   // 0..15 light level
  let startmap = (15.0 - li) * 4.0;                    // 0..60
  let scale = 2400.0 / max(dist, 16.0);               // near → big → brighter
  let level = clamp(startmap - scale, 0.0, 31.0);
  return u32(level);
}

// Vertex (10 f32): a=(x,z,hIdx,lightSec) b=(u,vBase,vTop) c=(vMode,contrast,texId)
@vertex
fn vs(@location(0) a : vec4f, @location(1) b : vec3f, @location(2) c : vec3f) -> VSOut {
  let y = heights[u32(a.z + 0.5)];
  let world = vec3f(a.x, y, a.y);
  var o : VSOut;
  o.clip = frame.vp * vec4f(world, 1.0);
  let isWall = c.x > 0.5;
  let V = select(b.y, b.y + (b.z - y), isWall);
  o.uv = vec2f(b.x, V);
  // Live sector light (animated by light specials) + per-wall fake contrast.
  o.light = clamp(sectorLights[u32(a.w + 0.5)] + c.y, 0.0, 1.0);
  o.texId = u32(c.z + 0.5);
  o.world = world;
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let r = rects[in.texId];
  let w = f32(r.z);
  let h = f32(r.w);
  let uu = in.uv.x - floor(in.uv.x / w) * w;
  let vv = in.uv.y - floor(in.uv.y / h) * h;
  let coord = vec2u(r.x + u32(uu), r.y + u32(vv));
  let palIdx = textureLoad(atlasTex, coord, 0).r;
  let dist = length(in.world - frame.camPos);
  let row = lightRow(in.light, dist);
  // Single lit-palette lookup: palette index remapped through the colormap row.
  return textureLoad(palette, vec2u(palIdx, row), 0);
}
`;

export class World {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly ubuf: GPUBuffer;
  private readonly hbuf: GPUBuffer;
  private readonly slbuf: GPUBuffer;
  private readonly frameBG: GPUBindGroup;
  private readonly atlasBG: GPUBindGroup;
  private readonly vbuf: GPUBuffer;
  private readonly ibuf: GPUBuffer;
  private readonly indexCount: number;
  private depth: GPUTexture | null = null;
  private depthViewCached: GPUTextureView | null = null;
  private depthW = 0;
  private depthH = 0;

  constructor(
    device: GPUDevice, format: GPUTextureFormat,
    mesh: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>,
    atlas: TextureAtlas, heightCount: number,
  ) {
    this.device = device;
    this.indexCount = indices.length;
    this.atlasBG = atlas.bindGroup;

    this.vbuf = device.createBuffer({
      label: "world-verts",
      size: Math.max(16, mesh.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vbuf, 0, mesh);

    this.ibuf = device.createBuffer({
      label: "world-indices",
      size: Math.max(16, indices.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.ibuf, 0, indices);

    this.ubuf = device.createBuffer({ label: "world-frame", size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.hbuf = device.createBuffer({ label: "world-heights", size: Math.max(16, heightCount * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.slbuf = device.createBuffer({ label: "world-sector-lights", size: Math.max(16, (heightCount / 2) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const frameBGL = device.createBindGroupLayout({
      label: "world-frame-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.frameBG = device.createBindGroup({
      label: "world-frame-bg",
      layout: frameBGL,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: { buffer: this.hbuf } },
        { binding: 2, resource: { buffer: this.slbuf } },
      ],
    });

    const module = device.createShaderModule({ label: "world-wgsl", code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "world-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameBGL, atlas.layout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 10 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },     // x, z, hIdx, lightSec
              { shaderLocation: 1, offset: 4 * 4, format: "float32x3" }, // u, vBase, vTop
              { shaderLocation: 2, offset: 7 * 4, format: "float32x3" }, // vMode, contrast, texId
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: SAMPLES },
    });
  }

  setFrame(vp: Float32Array<ArrayBuffer>, camPos: readonly [number, number, number]): void {
    const buf = new Float32Array(20);
    buf.set(vp, 0);
    buf[16] = camPos[0]; buf[17] = camPos[1]; buf[18] = camPos[2];
    this.device.queue.writeBuffer(this.ubuf, 0, buf);
  }

  setHeights(heights: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.hbuf, 0, heights);
  }

  setSectorLights(lights: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.slbuf, 0, lights);
  }

  /**
   * Ensure the MSAA depth texture matches (w,h), recreating it on resize.
   * The view is cached and only rebuilt when the texture is — callers may invoke
   * this every frame without churning GPUTextureView allocations.
   */
  depthView(w: number, h: number): GPUTextureView {
    if (!this.depth || this.depthW !== w || this.depthH !== h) {
      this.depth?.destroy();
      this.depth = this.device.createTexture({
        label: "world-depth",
        size: { width: w, height: h },
        format: DEPTH_FORMAT,
        sampleCount: SAMPLES,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthViewCached = this.depth.createView();
      this.depthW = w;
      this.depthH = h;
    }
    return this.depthViewCached!;
  }

  /** Record the world draw into an already-open render pass (shared with sprites/sky). */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frameBG);
    pass.setBindGroup(1, this.atlasBG);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, "uint32");
    pass.drawIndexed(this.indexCount);
  }

  get count(): number {
    return this.indexCount;
  }

  dispose(): void {
    this.vbuf.destroy();
    this.ibuf.destroy();
    this.ubuf.destroy();
    this.hbuf.destroy();
    this.slbuf.destroy();
    this.depth?.destroy();
  }
}
