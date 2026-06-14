/** WebGPU device + canvas context bring-up. Fails loud per zero-guessing. */

export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  format: GPUTextureFormat;
  /** Resize the canvas backing store to its CSS size × dpr. Returns true if it changed. */
  resize(): boolean;
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new Error("WebGPU not available. Use Chrome/Edge 113+, or Safari 18+/Firefox with WebGPU enabled.");
  }

  // Adapters are single-use and expire — always request fresh (toji device-loss note).
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No suitable GPUAdapter found.");

  const device = await adapter.requestDevice({ label: "webgpu-doom-device" });
  device.lost.then((info) => {
    // Surface device loss loudly; recovery is a later concern.
    console.error(`GPUDevice lost: ${info.reason} — ${info.message}`);
  });
  // Validation/out-of-memory errors fire off-thread with no JS stack; surface them
  // instead of letting a bad submit silently corrupt the frame.
  device.addEventListener("uncapturederror", (e) => {
    console.error("WebGPU uncaptured error:", (e as GPUUncapturedErrorEvent).error);
  });

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Failed to get a 'webgpu' canvas context.");

  // Use the preferred format to avoid an extra compositor blit (macOS/Android).
  const format = navigator.gpu.getPreferredCanvasFormat();

  function resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  context.configure({ device, format, alphaMode: "opaque" });
  resize();

  return { device, context, canvas, format, resize };
}
