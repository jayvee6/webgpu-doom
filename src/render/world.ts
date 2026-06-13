/**
 * M3 world renderer: flat-shaded triangles (walls now, floors/ceilings next),
 * a per-frame view-projection uniform (group 0), and a managed depth buffer.
 * Lighting = per-sector light × a cheap directional term so faces at different
 * angles read distinctly.
 */

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

const WGSL = /* wgsl */ `
struct Frame { vp : mat4x4f };
@group(0) @binding(0) var<uniform> frame : Frame;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) normal : vec3f,
  @location(1) light : f32,
};

@vertex
fn vs(@location(0) pos : vec3f, @location(1) normal : vec3f, @location(2) light : f32) -> VSOut {
  var o : VSOut;
  o.clip = frame.vp * vec4f(pos, 1.0);
  o.normal = normal;
  o.light = light;
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let lightDir = normalize(vec3f(0.5, 0.6, 0.4));
  let nd = abs(dot(normalize(in.normal), lightDir));
  let shade = clamp(in.light * (0.45 + 0.55 * nd), 0.0, 1.0);
  let tint = vec3f(1.0, 0.92, 0.84);
  return vec4f(shade * tint, 1.0);
}
`;

export class World {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly ubuf: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private vbuf: GPUBuffer;
  private vertexCount: number;
  private depth: GPUTexture | null = null;
  private depthW = 0;
  private depthH = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, mesh: Float32Array<ArrayBuffer>, vertexCount: number) {
    this.device = device;
    this.vertexCount = vertexCount;

    this.vbuf = device.createBuffer({
      label: "world-verts",
      size: Math.max(16, mesh.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vbuf, 0, mesh);

    this.ubuf = device.createBuffer({ label: "world-vp", size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgl = device.createBindGroupLayout({
      label: "world-frame-bgl",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    this.bindGroup = device.createBindGroup({ label: "world-frame-bg", layout: bgl, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });

    const module = device.createShaderModule({ label: "world-wgsl", code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "world-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 7 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
              { shaderLocation: 2, offset: 6 * 4, format: "float32" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });
  }

  /** Replace the geometry (used when floors/ceilings are added). */
  setMesh(mesh: Float32Array<ArrayBuffer>, vertexCount: number): void {
    if (mesh.byteLength > this.vbuf.size) {
      this.vbuf.destroy();
      this.vbuf = this.device.createBuffer({
        label: "world-verts",
        size: mesh.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.vbuf, 0, mesh);
    this.vertexCount = vertexCount;
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
        { view: colorView, clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 }, loadOp: "clear", storeOp: "store" },
      ],
      depthStencilAttachment: {
        view: this.ensureDepth(w, h),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vbuf);
    pass.draw(this.vertexCount);
    pass.end();
  }

  get count(): number {
    return this.vertexCount;
  }
}
