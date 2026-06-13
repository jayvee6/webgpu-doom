/**
 * M4 world renderer: palette-indexed textured triangles.
 * Vertex: position xyz · uv (texels) · light · texId (7 f32, 28-byte stride).
 * Fragment wraps uv into the texture's atlas rect with integer modulo, point-
 * samples the R8Uint atlas to a palette index, then looks up RGB in the palette
 * texture. No sampler / no filtering — palette indices must never be interpolated.
 */

import type { TextureAtlas } from "./atlas";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

const WGSL = /* wgsl */ `
struct Frame { vp : mat4x4f };
@group(0) @binding(0) var<uniform> frame : Frame;

@group(1) @binding(0) var atlasTex : texture_2d<u32>;
@group(1) @binding(1) var palette  : texture_2d<f32>;
@group(1) @binding(2) var<storage, read> rects : array<vec4<u32>>;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) uv : vec2f,
  @location(1) light : f32,
  @location(2) @interpolate(flat) texId : u32,
};

@vertex
fn vs(@location(0) pos : vec3f, @location(1) uv : vec2f,
      @location(2) light : f32, @location(3) texId : f32) -> VSOut {
  var o : VSOut;
  o.clip = frame.vp * vec4f(pos, 1.0);
  o.uv = uv;
  o.light = light;
  o.texId = u32(texId + 0.5);
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let r = rects[in.texId];
  let w = f32(r.z);
  let h = f32(r.w);
  // Integer-modulo wrap so textures tile correctly within their atlas cell.
  let uu = in.uv.x - floor(in.uv.x / w) * w;
  let vv = in.uv.y - floor(in.uv.y / h) * h;
  let coord = vec2u(r.x + u32(uu), r.y + u32(vv));
  let palIdx = textureLoad(atlasTex, coord, 0).r;
  let rgb = textureLoad(palette, vec2u(palIdx, 0u), 0).rgb;
  return vec4f(rgb * in.light, 1.0);
}
`;

export class World {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly ubuf: GPUBuffer;
  private readonly frameBG: GPUBindGroup;
  private readonly atlasBG: GPUBindGroup;
  private vbuf: GPUBuffer;
  private vertexCount: number;
  private depth: GPUTexture | null = null;
  private depthW = 0;
  private depthH = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, mesh: Float32Array<ArrayBuffer>, vertexCount: number, atlas: TextureAtlas) {
    this.device = device;
    this.vertexCount = vertexCount;
    this.atlasBG = atlas.bindGroup;

    this.vbuf = device.createBuffer({
      label: "world-verts",
      size: Math.max(16, mesh.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vbuf, 0, mesh);

    this.ubuf = device.createBuffer({ label: "world-vp", size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const frameBGL = device.createBindGroupLayout({
      label: "world-frame-bgl",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    this.frameBG = device.createBindGroup({ label: "world-frame-bg", layout: frameBGL, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });

    const module = device.createShaderModule({ label: "world-wgsl", code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "world-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameBGL, atlas.layout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 7 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 3 * 4, format: "float32x2" },
              { shaderLocation: 2, offset: 5 * 4, format: "float32" },
              { shaderLocation: 3, offset: 6 * 4, format: "float32" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });
  }

  setViewProj(vp: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.ubuf, 0, vp);
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
}
