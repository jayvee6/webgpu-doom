/**
 * Shader-module creation with compile-error surfacing.
 *
 * A WGSL compile error otherwise fails silently on some implementations (notably
 * Safari/Metal) — the pipeline just produces a black screen with nothing in the
 * console. getCompilationInfo() asks the implementation for diagnostics and logs
 * any error-severity messages with file:line, so a bad shader is loud, not blank.
 */
export function createCheckedModule(device: GPUDevice, label: string, code: string): GPUShaderModule {
  const module = device.createShaderModule({ label, code });
  void module.getCompilationInfo().then((info) => {
    for (const m of info.messages) {
      if (m.type !== "error") continue;
      console.error(`[WGSL ${label}] ${m.lineNum}:${m.linePos} ${m.message}`);
    }
  });
  return module;
}
