import { initGpu } from "./gpu/device";
import { Wad } from "./wad/reader";
import { loadMap } from "./wad/maps";
import { locateSector } from "./wad/bsp";
import { blocked } from "./game/collision";
import { loadPalettes, paletteRGBA } from "./wad/graphics";
import { TextureLib } from "./wad/textures";
import { SpriteLib } from "./wad/sprites";
import { thingSprite } from "./wad/thingtypes";
import { Wireframe } from "./render/wireframe";
import { World } from "./render/world";
import { TextureAtlas } from "./render/atlas";
import { Sky } from "./render/sky";
import { SpriteRenderer, type SpriteRequest } from "./render/sprites";
import { buildWalls } from "./geometry/walls";
import { buildFlats } from "./geometry/flats";
import { FreeFlyCamera } from "./camera/freefly";
import { invert, type Vec3 } from "./math/mat4";

const WAD_URL = "/freedoom1.wad";
const FIRST_MAP = "E1M1";
const EYE_HEIGHT = 41;

const hud = document.getElementById("hud") as HTMLDivElement;
const errBox = document.getElementById("err") as HTMLDivElement;

function fatal(e: unknown): never {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  errBox.style.display = "grid";
  errBox.textContent = `webgpu-doom failed to start\n\n${msg}`;
  throw e;
}

const WALK_SPEED = 300;
const RUN_SPEED = 500;
const GRAVITY = 1800;

async function main() {
  const canvas = document.getElementById("gfx") as HTMLCanvasElement;
  const gpu = await initGpu(canvas).catch(fatal);

  const wad = await Wad.load(WAD_URL).catch(fatal);
  const palettes = loadPalettes(wad);
  const basePalette = paletteRGBA(palettes, 0);
  const map = loadMap(wad, FIRST_MAP);

  // Textures: collect every wall texture + flat the map references, then atlas them.
  const texLib = new TextureLib(wad);
  const usedNames = new Set<string>();
  for (const sd of map.sidedefs) {
    for (const n of [sd.upper, sd.lower, sd.middle]) if (n !== "-" && n !== "") usedNames.add(n);
  }
  for (const sec of map.sectors) { usedNames.add(sec.floorFlat); usedNames.add(sec.ceilFlat); }
  const SKY_TEX = "SKY1"; // E1 sky texture; packed so the sky pass can sample it
  if (texLib.texture(SKY_TEX)) usedNames.add(SKY_TEX);
  const names = [...usedNames];
  const atlas = new TextureAtlas(gpu.device, texLib, basePalette, names);
  const tid = (name: string) => atlas.id(name);
  const sky = new Sky(gpu.device, gpu.format, atlas, atlas.id(SKY_TEX));

  // Geometry: walls + floors/ceilings, concatenated into one vertex buffer.
  const walls = buildWalls(map, tid);
  const flats = buildFlats(map, tid);
  const mesh = new Float32Array(walls.data.length + flats.data.length);
  mesh.set(walls.data, 0);
  mesh.set(flats.data, walls.data.length);
  const totalVerts = walls.vertexCount + flats.vertexCount;
  const world = new World(gpu.device, gpu.format, mesh, totalVerts, atlas);
  const wireframe = new Wireframe(gpu.device, gpu.format, map);

  // Sprites (THINGS): resolve each thing's spawn sprite → billboard request.
  const spriteLib = new SpriteLib(wad, basePalette);
  const requests: SpriteRequest[] = [];
  let unmappedTypes = 0;
  for (const t of map.things) {
    const ts = thingSprite(t.type);
    if (!ts) { unmappedTypes++; continue; }
    const lump = spriteLib.resolveLump(ts.sprite, ts.frame);
    if (!lump) continue;
    const sec = locateSector(map, t.x, t.y);
    const floor = sec >= 0 ? map.sectors[sec]!.floorHeight : 0;
    const light = sec >= 0 ? map.sectors[sec]!.light / 255 : 1;
    requests.push({ lump, x: t.x, y: t.y, floor, light });
  }
  const sprites = new SpriteRenderer(gpu.device, gpu.format, spriteLib, requests);
  console.log(`textures: ${names.length} names, atlas 2048×${atlas.atlasHeight}, ${atlas.missing.length} missing` +
    (atlas.missing.length ? ` (${atlas.missing.slice(0, 12).join(", ")}${atlas.missing.length > 12 ? "…" : ""})` : ""));
  console.log(`geometry: ${walls.vertexCount} wall-verts + ${flats.vertexCount} flat-verts; ${flats.failedSectors} sectors failed triangulation`);
  console.log(`sprites: ${sprites.instanceCount} things drawn, ${unmappedTypes} unmapped types, ${sprites.missing.length} missing sprite lumps`);

  // Camera at player-1 start, eye height above the floor it stands on.
  const p1 = map.things.find((t) => t.type === 1);
  const startX = p1 ? p1.x : 0;
  const startY = p1 ? p1.y : 0;
  const startSector = locateSector(map, startX, startY);
  const floorH = startSector >= 0 ? map.sectors[startSector]!.floorHeight : 0;
  const startPos: Vec3 = [startX, floorH + EYE_HEIGHT, -startY];
  const startYaw = p1 ? Math.PI / 2 - (p1.angle * Math.PI) / 180 : 0;
  const cam = new FreeFlyCamera(startPos, startYaw);

  let mode: "world" | "automap" = "world";
  let moveMode: "walk" | "fly" = "walk";

  // Input
  addEventListener("keydown", (e) => {
    if (e.code === "KeyM") { mode = mode === "world" ? "automap" : "world"; return; }
    if (e.code === "KeyF") { moveMode = moveMode === "walk" ? "fly" : "walk"; cam.vz = 0; return; }
    cam.onKey(e.code, true);
  });
  addEventListener("keyup", (e) => cam.onKey(e.code, false));
  canvas.addEventListener("click", () => canvas.requestPointerLock());
  addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === canvas) cam.onMouse(e.movementX, e.movementY);
  });

  (window as unknown as { __doom: unknown }).__doom = { gpu, wad, palettes, basePalette, map, world, wireframe, cam, sky, texLib, sprites };

  // Walk physics: collide + slide against walls, follow floor, fall with gravity.
  function walkStep(dt: number): void {
    const [idx, idy] = cam.planarInput();
    let mx = cam.pos[0], my = -cam.pos[2];
    const curSec = locateSector(map, mx, my);
    const pf = curSec >= 0 ? map.sectors[curSec]!.floorHeight : 0;
    const dd = (cam.running() ? RUN_SPEED : WALK_SPEED) * dt;
    const ddx = idx * dd, ddy = idy * dd;
    if (ddx !== 0 && !blocked(map, mx + ddx, my, pf)) mx += ddx;
    if (ddy !== 0 && !blocked(map, mx, my + ddy, pf)) my += ddy;
    cam.pos[0] = mx; cam.pos[2] = -my;

    const sec = locateSector(map, mx, my);
    const floorZ = sec >= 0 ? map.sectors[sec]!.floorHeight : pf;
    const ceilZ = sec >= 0 ? map.sectors[sec]!.ceilHeight : 1e9;
    const eyeTarget = floorZ + EYE_HEIGHT;
    if (cam.pos[1] <= eyeTarget) {
      cam.pos[1] = eyeTarget; cam.vz = 0; // grounded / stepped up
    } else {
      cam.vz -= GRAVITY * dt;
      cam.pos[1] += cam.vz * dt;
      if (cam.pos[1] < eyeTarget) { cam.pos[1] = eyeTarget; cam.vz = 0; }
    }
    const headMax = ceilZ - 8;
    if (cam.pos[1] > headMax) { cam.pos[1] = headMax; if (cam.vz > 0) cam.vz = 0; }
  }

  let lastW = 0, lastH = 0;
  let prev = performance.now();
  let frame = 0, fps = 0, fpsT = prev, fpsN = 0;

  function render(now: number) {
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;

    if (gpu.resize()) gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
    const w = canvas.width, h = canvas.height;
    if (w !== lastW || h !== lastH) { lastW = w; lastH = h; wireframe.setView(w, h); }

    if (moveMode === "fly") cam.update(dt);
    else walkStep(dt);
    const aspect = w / h;
    const colorView = gpu.context.getCurrentTexture().createView();
    const encoder = gpu.device.createCommandEncoder({ label: "frame" });

    if (mode === "world") {
      const vp = cam.viewProj(aspect);
      world.setFrame(vp, cam.pos);
      world.render(encoder, colorView, w, h);
      // Sprites after world (depth-tested + writing), before sky.
      const camRight: [number, number, number] = [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)];
      sprites.setFrame(vp, cam.pos, camRight);
      sprites.render(encoder, colorView, world.depthView());
      if (sky.skyId >= 0) {
        sky.setFrame(invert(vp), cam.pos);
        sky.render(encoder, colorView, world.depthView());
      }
    } else {
      const pass = encoder.beginRenderPass({
        label: "automap",
        colorAttachments: [{ view: colorView, clearValue: { r: 0.06, g: 0.01, b: 0.02, a: 1 }, loadOp: "clear", storeOp: "store" }],
      });
      wireframe.draw(pass);
      pass.end();
    }
    gpu.device.queue.submit([encoder.finish()]);

    frame++; fpsN++;
    if (now - fpsT >= 500) { fps = Math.round((fpsN * 1000) / (now - fpsT)); fpsN = 0; fpsT = now; }
    hud.textContent =
      `webgpu-doom — M6 walk   [${mode} · ${moveMode}]  (M: map · F: fly/walk · click: mouselook · WASD)\n` +
      `${map.name}  ${world.count} verts  ·  ${fps} fps\n` +
      `pos ${cam.pos[0].toFixed(0)}, ${cam.pos[1].toFixed(0)}, ${cam.pos[2].toFixed(0)}   yaw ${((cam.yaw * 180) / Math.PI).toFixed(0)}°  pitch ${((cam.pitch * 180) / Math.PI).toFixed(0)}°`;
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

main();
