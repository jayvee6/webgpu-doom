/**
 * M2 — 2D automap-style wireframe of a map's linedefs, drawn with a WebGPU
 * line-list pipeline. One-sided lines (solid walls) render white; two-sided
 * lines (sector boundaries / steps / doors) render dim grey.
 *
 * This deliberately sets up the structure M3 reuses: a "frame" uniform (group 0)
 * holding the view transform, with an explicit bind-group layout so later
 * pipelines can share the same group-0 binding.
 */

import type { DoomMap } from "../wad/maps";

const WGSL = /* wgsl */ `
struct Frame {
  // center.xy = map-space center, scale = units→ndc, aspect = canvasW/H
  center : vec2f,
  scale  : f32,
  aspect : f32,
};
@group(0) @binding(0) var<uniform> frame : Frame;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) kind : f32,
};

@vertex
fn vs(@location(0) p : vec2f, @location(1) kind : f32) -> VSOut {
  var o : VSOut;
  let c = (p - frame.center) * frame.scale;
  // Correct for non-square canvas so map geometry keeps its true proportions.
  o.pos = vec4f(c.x / frame.aspect, c.y, 0.0, 1.0);
  o.kind = kind;
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // kind: 0 = two-sided (grey), 1 = one-sided wall (white)
  let grey = vec3f(0.32, 0.30, 0.34);
  let white = vec3f(0.92, 0.92, 0.86);
  return vec4f(mix(grey, white, in.kind), 1.0);
}
`;

export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Wireframe {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly vbuf: GPUBuffer;
  private readonly ubuf: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  readonly frameLayout: GPUBindGroupLayout;
  readonly vertexCount: number;
  readonly bounds: MapBounds;

  constructor(device: GPUDevice, format: GPUTextureFormat, map: DoomMap) {
    this.device = device;

    // Build line vertices: 2 per linedef. Layout per vertex: x, y, kind (3 f32).
    const lines = map.linedefs;
    const data = new Float32Array(lines.length * 2 * 3);
    const b: MapBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    let w = 0;
    for (const ld of lines) {
      const a = map.vertexes[ld.v1];
      const c = map.vertexes[ld.v2];
      if (!a || !c) continue; // defensive: skip a malformed linedef rather than NaN the buffer
      const kind = ld.left === -1 ? 1 : 0;
      data[w++] = a.x; data[w++] = a.y; data[w++] = kind;
      data[w++] = c.x; data[w++] = c.y; data[w++] = kind;
      for (const v of [a, c]) {
        if (v.x < b.minX) b.minX = v.x;
        if (v.y < b.minY) b.minY = v.y;
        if (v.x > b.maxX) b.maxX = v.x;
        if (v.y > b.maxY) b.maxY = v.y;
      }
    }
    this.vertexCount = w / 3;
    this.bounds = b;

    this.vbuf = device.createBuffer({
      label: "wireframe-verts",
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vbuf, 0, data, 0, w);

    // Frame uniform: center(vec2) + scale + aspect = 4 f32 = 16 bytes.
    this.ubuf = device.createBuffer({
      label: "frame-uniform",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Explicit group-0 layout (reused by M3 world/sprite pipelines).
    this.frameLayout = device.createBindGroupLayout({
      label: "frame-bgl",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    this.bindGroup = device.createBindGroup({
      label: "frame-bg",
      layout: this.frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.ubuf } }],
    });

    const module = device.createShaderModule({ label: "wireframe-wgsl", code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "wireframe-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 3 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
              { shaderLocation: 1, offset: 2 * 4, format: "float32" }, // kind
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "line-list" },
      multisample: { count: 4 },
    });
  }

  /** Update the fit-to-canvas view transform. Call when canvas size changes. */
  setView(canvasW: number, canvasH: number, margin = 0.92): void {
    const b = this.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const mapW = Math.max(1, b.maxX - b.minX);
    const mapH = Math.max(1, b.maxY - b.minY);
    const aspect = canvasW / canvasH;
    // After dividing ndc.x by aspect, x extent = mapW*scale/aspect; fit both axes.
    const scale = Math.min((2 * margin * aspect) / mapW, (2 * margin) / mapH);
    this.device.queue.writeBuffer(this.ubuf, 0, new Float32Array([cx, cy, scale, aspect]));
  }

  dispose(): void {
    this.vbuf.destroy();
    this.ubuf.destroy();
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vbuf);
    pass.draw(this.vertexCount);
  }
}
