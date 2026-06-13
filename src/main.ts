import { initGpu } from "./gpu/device";
import { Wad } from "./wad/reader";
import { loadMap } from "./wad/maps";
import { locateSector } from "./wad/bsp";
import { blocked, distSqPointSeg } from "./game/collision";
import { MapState, USABLE, WALKOVER } from "./game/specials";
import { Blockmap } from "./game/blockmap";
import { GameState } from "./game/state";
import { updateEntities, hasSight } from "./game/ai";
import { fireHitscan } from "./game/combat";
import { applyPickup } from "./game/items";
import { loadPalettes, paletteRGBA, buildLitPalette } from "./wad/graphics";
import { TextureLib } from "./wad/textures";
import { SpriteLib } from "./wad/sprites";
import { Wireframe } from "./render/wireframe";
import { World } from "./render/world";
import { TextureAtlas } from "./render/atlas";
import { Sky } from "./render/sky";
import { SpriteRenderer, type SpriteRequest } from "./render/sprites";
import { WeaponHUD } from "./render/weapon";
import { buildWalls } from "./geometry/walls";
import { buildFlats } from "./geometry/flats";
import { FreeFlyCamera } from "./camera/freefly";
import { invert, type Vec3 } from "./math/mat4";

const WAD_URL = "/freedoom1.wad";
const FIRST_MAP = "E1M1";
const EYE_HEIGHT = 41;

const hud = document.getElementById("hud") as HTMLDivElement;
const $ = (id: string) => document.getElementById(id)!;
const elLoading = $("loading"), elTitle = $("title"), elErr = $("err");
const elLoadFill = $("load-fill"), elLoadLabel = $("load-label");
const elErrMsg = $("err-msg"), elCta = $("cta"), elCrosshair = $("crosshair");

function showError(message: string): never {
  elLoading.hidden = true; elTitle.hidden = true;
  elErr.hidden = false;
  elErrMsg.textContent = message;
  throw new Error(message);
}

function fatal(e: unknown): never {
  showError(e instanceof Error ? e.message : String(e));
}

/** Do segments (p1→p2) and (p3→p4) intersect? Used for walkover triggers. */
function segsCross(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (d === 0) return false;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

const WALK_SPEED = 300;
const RUN_SPEED = 500;
const GRAVITY = 1800;

// Transient centered gameplay message (YOU DIED / LEVEL COMPLETE).
let msgEl: HTMLDivElement | null = null;
function showMessage(text: string, color: string): void {
  if (!msgEl) {
    msgEl = document.createElement("div");
    msgEl.style.cssText = "position:fixed;inset:0;display:grid;place-items:center;z-index:9;pointer-events:none;" +
      "font:800 clamp(34px,7vw,72px)/1 ui-monospace,monospace;letter-spacing:.1em;text-shadow:0 0 16px currentColor";
    document.body.appendChild(msgEl);
  }
  msgEl.style.color = color;
  msgEl.style.display = "grid";
  msgEl.textContent = text;
}
function hideMessage(): void {
  if (msgEl) msgEl.style.display = "none";
}

async function main() {
  const canvas = document.getElementById("gfx") as HTMLCanvasElement;

  // Friendly, specific message when the browser simply lacks WebGPU.
  if (!navigator.gpu) {
    showError("This demo needs WebGPU.\n\nTry Chrome or Edge 113+, Safari 18+, or Firefox with WebGPU enabled.");
  }
  const gpu = await initGpu(canvas).catch(fatal);

  // Stream the ~28 MB WAD with a real progress bar.
  const wad = await Wad.load(WAD_URL, (f) => {
    const pct = Math.round(f * 100);
    elLoadFill.style.width = `${pct}%`;
    elLoadLabel.textContent = `LOADING WAD… ${pct}%`;
  }).catch(fatal);
  elLoadLabel.textContent = "BUILDING LEVEL…";

  const palettes = loadPalettes(wad);
  const basePalette = paletteRGBA(palettes, 0);
  const litPalette = buildLitPalette(wad, palettes); // 256×32 palette × colormap LUT
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
  const atlas = new TextureAtlas(gpu.device, texLib, litPalette, names);
  const tid = (name: string) => atlas.id(name);
  const sky = new Sky(gpu.device, gpu.format, atlas, atlas.id(SKY_TEX));

  // Geometry: walls + floors/ceilings, merged into one indexed mesh.
  const walls = buildWalls(map, tid);
  const flats = buildFlats(map, tid);
  const mesh = new Float32Array(walls.vertices.length + flats.vertices.length);
  mesh.set(walls.vertices, 0);
  mesh.set(flats.vertices, walls.vertices.length);
  const wallVertCount = walls.vertices.length / 9;
  const indices = new Uint32Array(walls.indices.length + flats.indices.length);
  indices.set(walls.indices, 0);
  for (let i = 0; i < flats.indices.length; i++) indices[walls.indices.length + i] = flats.indices[i]! + wallVertCount;
  const world = new World(gpu.device, gpu.format, mesh, indices, atlas, map.sectors.length * 2);
  const wireframe = new Wireframe(gpu.device, gpu.format, map);

  // Line specials (doors / lifts / moving floors / exit) drive live sector heights.
  const mapState = new MapState(map);
  let exited = false;
  mapState.onExit = () => {
    if (exited) return;
    exited = true;
    const o = document.createElement("div");
    o.style.cssText = "position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.78);" +
      "font:bold 42px ui-monospace,monospace;color:#6f6;text-shadow:0 0 12px #0f0;z-index:9";
    o.textContent = "LEVEL COMPLETE";
    document.body.appendChild(o);
  };
  world.setHeights(mapState.heights());

  // Game state: build entities (THINGS) and the collision broadphase.
  const spriteLib = new SpriteLib(wad);
  const state = new GameState(map, spriteLib);
  const blockmap = new Blockmap(map);
  const sprites = new SpriteRenderer(gpu.device, gpu.format, spriteLib, state.spriteLumps(), litPalette, state.entities.length);
  console.log(`textures: ${names.length} names, atlas 2048×${atlas.atlasHeight}, ${atlas.missing.length} missing` +
    (atlas.missing.length ? ` (${atlas.missing.slice(0, 12).join(", ")}${atlas.missing.length > 12 ? "…" : ""})` : ""));
  console.log(`geometry: ${mesh.length / 9} verts, ${indices.length} indices (${indices.length / 3} tris); ${flats.failedSectors} sectors failed`);
  console.log(`entities: ${state.entities.length} (${state.unmappedTypes} unmapped types, ${sprites.missing.length} missing sprite lumps)`);
  const monsterTotal = state.entities.filter((e) => e.kind === "monster").length;
  const aliveMonsters = () => state.entities.reduce((n, e) => n + (e.kind === "monster" && e.mstate !== "dead" ? 1 : 0), 0);

  // First-person weapon overlay (Canvas2D).
  const weaponCanvas = $("weapon") as HTMLCanvasElement;
  const weapon = new WeaponHUD(weaponCanvas, wad, basePalette);

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
  let started = false;
  const playing = () => document.pointerLockElement === canvas;

  // Title / pause gate: pointer lock is the play state; releasing it (Esc) pauses.
  // Hide the title only once lock is actually granted (pointerlockchange), so a
  // denied lock leaves the title up to retry rather than stranding the player.
  function enter(): void {
    void canvas.requestPointerLock();
  }
  elCta.addEventListener("click", enter);
  canvas.addEventListener("click", () => { if (started && !playing()) enter(); });
  document.addEventListener("pointerlockchange", () => {
    if (playing()) {
      started = true;
      elTitle.hidden = true;
    } else if (started) {
      cam.onKeyClear();
      const cta = elCta as HTMLElement;
      cta.textContent = "CLICK TO RESUME";
      (elTitle.querySelector(".title") as HTMLElement).textContent = "PAUSED";
      (elTitle.querySelector(".subtitle") as HTMLElement).textContent = "POINTER RELEASED";
      elTitle.hidden = false;
    }
  });

  // Input — gameplay keys only while actively playing (pointer locked).
  addEventListener("keydown", (e) => {
    if (!playing()) return;
    if (e.code === "KeyM") { mode = mode === "world" ? "automap" : "world"; return; }
    if (e.code === "KeyF") { moveMode = moveMode === "walk" ? "fly" : "walk"; cam.vz = 0; return; }
    if (e.code === "Space") { e.preventDefault(); doUse(); return; }
    cam.onKey(e.code, true);
  });
  addEventListener("keyup", (e) => cam.onKey(e.code, false));
  addEventListener("mousemove", (e) => {
    if (playing()) cam.onMouse(e.movementX, e.movementY);
  });

  (window as unknown as { __doom: unknown }).__doom = { gpu, wad, palettes, basePalette, map, world, wireframe, cam, sky, texLib, sprites, mapState, state, blockmap, updateEntities, fireHitscan, hasSight, applyPickup, weapon };

  // "Use" (spacebar): trigger the nearest usable line ~52 units in front.
  function doUse(): void {
    const px = cam.pos[0], py = -cam.pos[2];
    const ux = px + Math.sin(cam.yaw) * 52, uy = py + Math.cos(cam.yaw) * 52;
    let best = -1, bestD = 50 * 50;
    for (const i of blockmap.linesNear(ux, uy, 64)) {
      const ld = map.linedefs[i]!;
      if (!USABLE.has(ld.special)) continue;
      const a = map.vertexes[ld.v1], b = map.vertexes[ld.v2];
      if (!a || !b) continue;
      const d = distSqPointSeg(ux, uy, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) mapState.useLine(best);
  }

  // Walkover triggers: did the player's move segment cross a walkover-special line?
  function checkWalkover(x0: number, y0: number, x1: number, y1: number): void {
    for (const i of blockmap.linesNear((x0 + x1) / 2, (y0 + y1) / 2, 64)) {
      const ld = map.linedefs[i]!;
      if (!WALKOVER.has(ld.special)) continue;
      const a = map.vertexes[ld.v1], b = map.vertexes[ld.v2];
      if (!a || !b) continue;
      if (segsCross(x0, y0, x1, y1, a.x, a.y, b.x, b.y)) mapState.crossLine(i);
    }
  }

  // Walk physics: collide + slide against walls, follow floor, fall with gravity.
  function walkStep(dt: number): void {
    const [idx, idy] = cam.planarInput();
    let mx = cam.pos[0], my = -cam.pos[2];
    const curSec = locateSector(map, mx, my);
    const pf = curSec >= 0 ? map.sectors[curSec]!.floorHeight : 0;
    const dd = (cam.running() ? RUN_SPEED : WALK_SPEED) * dt;
    const ddx = idx * dd, ddy = idy * dd;
    const px0 = cam.pos[0], py0 = -cam.pos[2];
    const near = blockmap.linesNear(mx, my, 96);
    if (ddx !== 0 && !blocked(map, mx + ddx, my, pf, near)) mx += ddx;
    if (ddy !== 0 && !blocked(map, mx, my + ddy, pf, near)) my += ddy;
    cam.pos[0] = mx; cam.pos[2] = -my;
    if (mx !== px0 || my !== py0) checkWalkover(px0, py0, mx, my);

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

  // Combat + player health/death/respawn.
  let fireCd = 0;
  let respawnTimer = 0;
  function fire(): void {
    if (fireCd > 0 || state.player.dead || mode !== "world") return;
    if (state.player.ammo.bul <= 0) return; // out of bullets
    fireCd = 0.16;
    state.player.ammo.bul--;
    weapon.onFire();
    fireHitscan(state, map, blockmap, cam.pos[0], -cam.pos[2], cam.yaw);
  }

  // Pick up items the player walks over (item disappears via active=false).
  function checkPickups(): void {
    const px = cam.pos[0], py = -cam.pos[2];
    for (const e of state.entities) {
      if (e.kind !== "item" || !e.active) continue;
      if (Math.hypot(e.x - px, e.y - py) < e.radius + 16) {
        if (applyPickup(state.player, e.type)) e.active = false;
      }
    }
  }
  function damagePlayer(amount: number): void {
    if (state.player.dead) return;
    state.player.health -= amount;
    if (state.player.health <= 0) {
      state.player.health = 0;
      state.player.dead = true;
      respawnTimer = 2.5;
      showMessage("YOU DIED", "#ff5555");
    }
  }
  function respawn(): void {
    state.player.health = 100;
    state.player.dead = false;
    cam.pos[0] = startPos[0]; cam.pos[1] = startPos[1]; cam.pos[2] = startPos[2];
    cam.vz = 0;
    for (const e of state.entities) if (e.kind === "monster") e.mstate = "idle";
    hideMessage();
  }
  addEventListener("mousedown", (e) => { if (playing() && e.button === 0) fire(); });

  let lastW = 0, lastH = 0;
  let prev = performance.now();
  let frame = 0, fps = 0, fpsT = prev, fpsN = 0;

  // Fixed-timestep simulation at Doom's 35 tics/sec; render interpolates position.
  const FIXED = 1 / 35;
  let acc = 0;
  let simPrev: Vec3 = [cam.pos[0], cam.pos[1], cam.pos[2]];
  const billboards: SpriteRequest[] = [];

  function simulate(dt: number): void {
    simPrev = [cam.pos[0], cam.pos[1], cam.pos[2]];
    if (moveMode === "fly") cam.update(dt);
    else walkStep(dt);
    mapState.update(dt);

    // Combat timers, monster AI, pickups, respawn.
    fireCd -= dt;
    if (state.player.dead) { respawnTimer -= dt; if (respawnTimer <= 0) respawn(); }
    else checkPickups();
    updateEntities(state.entities, dt, { map, blockmap, px: cam.pos[0], py: -cam.pos[2], damagePlayer });
  }

  function render(now: number) {
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;

    if (gpu.resize()) gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
    const w = canvas.width, h = canvas.height;
    if (w !== lastW || h !== lastH) { lastW = w; lastH = h; wireframe.setView(w, h); }

    // Sim only while actively playing; the scene still renders behind overlays.
    if (playing()) {
      acc += dt;
      let steps = 0;
      while (acc >= FIXED && steps < 5) { simulate(FIXED); acc -= FIXED; steps++; }
    } else {
      acc = 0; simPrev = [cam.pos[0], cam.pos[1], cam.pos[2]];
    }
    const alpha = Math.max(0, Math.min(1, acc / FIXED));
    const eye: Vec3 = [
      simPrev[0] + (cam.pos[0] - simPrev[0]) * alpha,
      simPrev[1] + (cam.pos[1] - simPrev[1]) * alpha,
      simPrev[2] + (cam.pos[2] - simPrev[2]) * alpha,
    ];

    world.setHeights(mapState.heights());
    const inGame = playing() && mode === "world";
    elCrosshair.hidden = !inGame;

    // First-person weapon overlay (rendered with the world; bobs only when walking).
    const showWeapon = mode === "world" && !state.player.dead;
    weaponCanvas.hidden = !showWeapon;
    if (showWeapon) {
      const pin = cam.planarInput();
      weapon.draw(inGame && moveMode === "walk" && (pin[0] !== 0 || pin[1] !== 0), dt);
    }

    // Rebuild billboards from live entities (the dynamic-sprite path).
    billboards.length = 0;
    for (const e of state.entities) {
      if (e.active && e.lump) billboards.push({ lump: e.lump, x: e.x, y: e.y, floor: e.z, light: e.light });
    }
    sprites.setBillboards(billboards);

    const aspect = w / h;
    const colorView = gpu.context.getCurrentTexture().createView();
    const encoder = gpu.device.createCommandEncoder({ label: "frame" });

    if (mode === "world") {
      const vp = cam.viewProjAt(eye, aspect);
      world.setFrame(vp, eye);
      world.render(encoder, colorView, w, h);
      // Sprites after world (depth-tested + writing), before sky.
      const camRight: [number, number, number] = [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)];
      sprites.setFrame(vp, eye, camRight);
      sprites.render(encoder, colorView, world.depthView());
      if (sky.skyId >= 0) {
        sky.setFrame(invert(vp), eye);
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
      `webgpu-doom — P3.5 pickups   [${mode} · ${moveMode}]  (CLICK fire · Space use · M map · F fly · WASD)\n` +
      `HEALTH ${state.player.health}  ARMOR ${state.player.armor}  AMMO ${state.player.ammo.bul}  ·  monsters ${aliveMonsters()}/${monsterTotal}  ·  ${fps} fps\n` +
      `${map.name}  pos ${cam.pos[0].toFixed(0)}, ${cam.pos[1].toFixed(0)}, ${cam.pos[2].toFixed(0)}   yaw ${((cam.yaw * 180) / Math.PI).toFixed(0)}°`;
    requestAnimationFrame(render);
  }

  // Everything is built — reveal the title (scene renders live behind it).
  elLoading.hidden = true;
  elTitle.hidden = false;
  requestAnimationFrame(render);
}

main();
