/**
 * World renderer with DYNAMIC sector heights (for doors/lifts/moving floors).
 * Each vertex stores (x, z, heightIndex) instead of a baked Y; the vertex shader
 * reads the live height from a storage buffer indexed by heightIndex
 * (sector*2 + 0=floor / 1=ceil). Updating that small buffer animates all walls +
 * flats touching a sector for free — no mesh rebuild.
 *
 * Vertex (9 f32, 36-byte stride):
 *   a: vec3f = (x, z, heightIndex)
 *   b: vec2f = (u, vBase)
 *   c: vec4f = (vTop, vMode, light, texId)
 * V coord: flat (vMode 0) → vBase; wall (vMode 1) → vBase + (vTop - worldY).
 */

import type { TextureAtlas } from "./atlas";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

const WGSL = /* wgsl */ `
struct Frame { vp : mat4x4f, camPos : vec3f, _pad : f32 };
@group(0) @binding(0) var<uniform> frame : Frame;
@group(0) @binding(1) var<storage, read> heights : array<f32>;

@group(1) @binding(0) var atlasTex : texture_2d<u32>;
@group(1) @binding(1) var palette  : texture_2d<f32>;
@group(1) @binding(2) var<storage, read> rects : array<vec4<u32>>;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) uv : vec2f,
  @location(1) light : f32,
  @location(2) @interpolate(flat) texId : u32,
  @location(3) world : vec3f,
};

@vertex
fn vs(@location(0) a : vec3f, @location(1) b : vec2f, @location(2) c : vec4f) -> VSOut {
  let y = heights[u32(a.z + 0.5)];
  let world = vec3f(a.x, y, a.y);
  var o : VSOut;
  o.clip = frame.vp * vec4f(world, 1.0);
  let isWall = c.y > 0.5;
  let V = select(b.y, b.y + (c.x - y), isWall);
  o.uv = vec2f(b.x, V);
  o.light = c.z;
  o.texId = u32(c.w + 0.5);
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
  let rgb = textureLoad(palette, vec2u(palIdx, 0u), 0).rgb;
  let dist = length(in.world - frame.camPos);
  let reach = mix(700.0, 2200.0, in.light);
  let fog = clamp(1.0 - max(dist - 224.0, 0.0) / reach, 0.22, 1.0);
  return vec4f(rgb * in.light * fog, 1.0);
}
`;

export class World {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly ubuf: GPUBuffer;
  private readonly hbuf: GPUBuffer;
  private readonly frameBG: GPUBindGroup;
  private readonly atlasBG: GPUBindGroup;
  private readonly vbuf: GPUBuffer;
  private vertexCount: number;
  private depth: GPUTexture | null = null;
  private depthW = 0;
  private depthH = 0;

  constructor(
    device: GPUDevice, format: GPUTextureFormat,
    mesh: Float32Array<ArrayBuffer>, vertexCount: number,
    atlas: TextureAtlas, heightCount: number,
  ) {
    this.device = device;
    this.vertexCount = vertexCount;
    this.atlasBG = atlas.bindGroup;

    this.vbuf = device.createBuffer({
      label: "world-verts",
      size: Math.max(16, mesh.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vbuf, 0, mesh);

    this.ubuf = device.createBuffer({ label: "world-frame", size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.hbuf = device.createBuffer({ label: "world-heights", size: Math.max(16, heightCount * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const frameBGL = device.createBindGroupLayout({
      label: "world-frame-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.frameBG = device.createBindGroup({
      label: "world-frame-bg",
      layout: frameBGL,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: { buffer: this.hbuf } },
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
            arrayStride: 9 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 3 * 4, format: "float32x2" },
              { shaderLocation: 2, offset: 5 * 4, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
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

  private ensureDepth(w: number, h: number): GPUTextureView {
    if (!this.depth || this.depthW !== w || this.depthH !== h) {
      this.depth?.destroy();
      this.depth = this.device.createTexture({
        label: "world-depth",
        size: { width: w, height: h },
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthW = w;
      this.depthH = h;
    }
    return this.depth.createView();
  }

  render(encoder: GPUCommandEncoder, colorView: GPUTextureView, w: number, h: number): void {
    const pass = encoder.beginRenderPass({
      label: "world",
      colorAttachments: [
        { view: colorView, clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 }, loadOp: "clear", storeOp: "store" },
      ],
      depthStencilAttachment: {
        view: this.ensureDepth(w, h),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frameBG);
    pass.setBindGroup(1, this.atlasBG);
    pass.setVertexBuffer(0, this.vbuf);
    pass.draw(this.vertexCount);
    pass.end();
  }

  get count(): number {
    return this.vertexCount;
  }

  depthView(): GPUTextureView {
    return this.ensureDepth(this.depthW, this.depthH);
  }
}
