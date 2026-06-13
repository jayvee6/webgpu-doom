import { initGpu } from "./gpu/device";
import { Wad } from "./wad/reader";
import { loadMap } from "./wad/maps";
import { loadPalettes, paletteRGBA } from "./wad/graphics";
import { Wireframe } from "./render/wireframe";

const WAD_URL = "/freedoom1.wad";
const FIRST_MAP = "E1M1";

const hud = document.getElementById("hud") as HTMLDivElement;
const errBox = document.getElementById("err") as HTMLDivElement;

function fatal(e: unknown): never {
  const msg = e instanceof Error ? e.stack ?? e.message : String(e);
  errBox.style.display = "grid";
  errBox.textContent = `webgpu-doom failed to start\n\n${msg}`;
  throw e;
}

async function main() {
  const canvas = document.getElementById("gfx") as HTMLCanvasElement;
  const gpu = await initGpu(canvas).catch(fatal);

  // M1 — parse the WAD (lump directory), the base palette, and the first map.
  const wad = await Wad.load(WAD_URL).catch(fatal);
  const palettes = loadPalettes(wad);
  const basePalette = paletteRGBA(palettes, 0);
  const map = loadMap(wad, FIRST_MAP);

  // M2 — 2D wireframe of the map's linedefs.
  const wireframe = new Wireframe(gpu.device, gpu.format, map);

  // Expose a debug surface for headless drive (devtools / preview_eval).
  (window as unknown as { __doom: unknown }).__doom = { gpu, wad, palettes, basePalette, map, wireframe };

  // Map bounds (useful sanity signal: E1M1 should span a few thousand units).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of map.vertexes) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }

  let frame = 0;
  let lastW = 0, lastH = 0;
  function render() {
    if (gpu.resize()) gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
    if (canvas.width !== lastW || canvas.height !== lastH) {
      lastW = canvas.width; lastH = canvas.height;
      wireframe.setView(canvas.width, canvas.height);
    }

    const encoder = gpu.device.createCommandEncoder({ label: "frame" });
    const pass = encoder.beginRenderPass({
      label: "wireframe",
      colorAttachments: [
        {
          view: gpu.context.getCurrentTexture().createView(),
          // Doom-ish dark wine clear so a blank screen is obviously "running, nothing drawn yet".
          clearValue: { r: 0.06, g: 0.01, b: 0.02, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    wireframe.draw(pass);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    frame++;
    hud.textContent =
      `webgpu-doom — M2 wireframe\n` +
      `${wad.type}  ${wad.lumps.length} lumps  ·  palettes ${palettes.count}\n` +
      `${map.name}: ${map.vertexes.length} verts  ${map.linedefs.length} lines  ${map.sidedefs.length} sides\n` +
      `         ${map.sectors.length} sectors  ${map.segs.length} segs  ${map.subsectors.length} ssec  ${map.nodes.length} nodes  ${map.things.length} things\n` +
      `bounds  x[${minX}..${maxX}]  y[${minY}..${maxY}]\n` +
      `format ${gpu.format}  ·  canvas ${canvas.width}×${canvas.height}  ·  frame ${frame}`;
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

main();
