/**
 * Sky pass. Runs after the world pass and fills only the pixels no geometry
 * touched (open F_SKY1 ceilings / sky upper-walls). It reconstructs the world-
 * space view ray from the inverse view-projection and samples the SKY1 texture
 * cylindrically (yaw → U, elevation → V). Palette-indexed point sampling, like
 * the world. Depth test = less-equal against a fullscreen quad at z=1, so it only
 * appears where the depth buffer is still at its 1.0 clear value.
 */

import type { TextureAtlas } from "./atlas";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

const WGSL = /* wgsl */ `
struct Sky { invVP : mat4x4f, camPos : vec3f, skyId : f32 };
@group(0) @binding(0) var<uniform> sky : Sky;

@group(1) @binding(0) var atlasTex : texture_2d<u32>;
@group(1) @binding(1) var palette  : texture_2d<f32>;
@group(1) @binding(2) var<storage, read> rects : array<vec4<u32>>;

struct VSOut { @builtin(position) clip : vec4f, @location(0) ndc : vec2f };

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : VSOut;
  o.clip = vec4f(p[vi], 1.0, 1.0); // z=1 → fragment depth 1.0
  o.ndc = p[vi];
  return o;
}

const PI = 3.14159265;

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // Reconstruct a world-space ray through this pixel.
  let far = sky.invVP * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - sky.camPos);

  let yaw = atan2(dir.x, -dir.z);          // around the horizon
  let el = asin(clamp(dir.y, -1.0, 1.0));  // up/down

  let r = rects[u32(sky.skyId + 0.5)];
  let w = f32(r.z);
  let h = f32(r.w);
  // Sky wraps 4× per 360° (classic Doom feel); elevation maps to texture height.
  let u = (yaw / (2.0 * PI)) * w * 4.0;
  let v = (0.5 - clamp(el / (PI / 3.0), -1.0, 1.0) * 0.5) * h;
  let uu = u - floor(u / w) * w;
  let vv = clamp(v, 0.0, h - 1.0);
  let coord = vec2u(r.x + u32(uu), r.y + u32(vv));
  let palIdx = textureLoad(atlasTex, coord, 0).r;
  let rgb = textureLoad(palette, vec2u(palIdx, 0u), 0).rgb;
  return vec4f(rgb, 1.0);
}
`;

export class Sky {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly ubuf: GPUBuffer;
  private readonly skyBG: GPUBindGroup;
  private readonly atlasBG: GPUBindGroup;
  readonly skyId: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, atlas: TextureAtlas, skyId: number) {
    this.device = device;
    this.skyId = skyId;
    this.atlasBG = atlas.bindGroup;

    this.ubuf = device.createBuffer({ label: "sky-uniform", size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const skyBGL = device.createBindGroupLayout({
      label: "sky-bgl",
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    this.skyBG = device.createBindGroup({ label: "sky-bg", layout: skyBGL, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });

    const module = device.createShaderModule({ label: "sky-wgsl", code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "sky-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [skyBGL, atlas.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "less-equal" },
      multisample: { count: 4 },
    });
  }

  setFrame(invVP: Float32Array<ArrayBuffer>, camPos: readonly [number, number, number]): void {
    const buf = new Float32Array(20);
    buf.set(invVP, 0);
    buf[16] = camPos[0]; buf[17] = camPos[1]; buf[18] = camPos[2];
    buf[19] = this.skyId;
    this.device.queue.writeBuffer(this.ubuf, 0, buf);
  }

  /** Draw into the existing color + depth (loaded, not cleared). */
  render(encoder: GPUCommandEncoder, colorView: GPUTextureView, depthView: GPUTextureView): void {
    const pass = encoder.beginRenderPass({
      label: "sky",
      colorAttachments: [{ view: colorView, loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: { view: depthView, depthLoadOp: "load", depthStoreOp: "store" },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.skyBG);
    pass.setBindGroup(1, this.atlasBG);
    pass.draw(3);
    pass.end();
  }
}
