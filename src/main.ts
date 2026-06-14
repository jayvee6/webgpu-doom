import { initGpu } from "./gpu/device";
import { Wad } from "./wad/reader";
import { loadMap, type DoomMap } from "./wad/maps";
import { locateSector } from "./wad/bsp";
import { blocked, distSqPointSeg } from "./game/collision";
import { MapState, USABLE, WALKOVER } from "./game/specials";
import { Blockmap } from "./game/blockmap";
import { EntityGrid } from "./game/entitygrid";
import { GameState } from "./game/state";
import { LightState } from "./game/lights";
import { updateEntities, hasSight, monsterSound } from "./game/ai";
import { fireHitscan } from "./game/combat";
import { spawnProjectile, updateProjectiles, PROJ_SPRITES } from "./game/projectile";
import { applyPickup } from "./game/items";
import { SoundSystem } from "./audio/sound";
import { loadPalettes, paletteRGBA, buildLitPalette } from "./wad/graphics";
import { TextureLib } from "./wad/textures";
import { SpriteLib } from "./wad/sprites";
import { Wireframe } from "./render/wireframe";
import { World, SAMPLES } from "./render/world";
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
const SKY_TEX = "SKY1"; // sky texture, packed into the atlas for the sky pass
const EYE_HEIGHT = 41;

const hud = document.getElementById("hud") as HTMLDivElement;
const $ = (id: string) => document.getElementById(id)!;
const elLoading = $("loading"), elTitle = $("title"), elErr = $("err");
const elLoadFill = $("load-fill"), elLoadLabel = $("load-label");
const elErrMsg = $("err-msg"), elCta = $("cta"), elCrosshair = $("crosshair");
const elInter = $("intermission"), elInterDone = $("inter-done"), elInterStats = $("inter-stats"), elInterCta = $("inter-cta");
const elPainFlash = $("pain-flash"), elPickupFlash = $("pickup-flash");
let painFlash = 0, pickupFlash = 0; // 0..1 opacity, decays each frame

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

  // WAD-global resources, shared across all levels.
  const texLib = new TextureLib(wad);
  const spriteLib = new SpriteLib(wad);
  const weaponCanvas = $("weapon") as HTMLCanvasElement;
  const weapon = new WeaponHUD(weaponCanvas, wad, basePalette);
  const sound = new SoundSystem(wad);
  const cam = new FreeFlyCamera([0, EYE_HEIGHT, 0], 0);
  // Player stats carried between levels (keys reset each level).
  const carried = { health: 100, armor: 0, ammo: { bul: 50, shl: 0, rck: 0, cel: 0 } };

  // Per-level objects (rebuilt by buildLevel).
  let currentMap = FIRST_MAP;
  let map!: DoomMap;
  let atlas!: TextureAtlas;
  let sky!: Sky;
  let world!: World;
  let wireframe!: Wireframe;
  let lights!: LightState;
  let mapState!: MapState;
  let state!: GameState;
  let blockmap!: Blockmap;
  let entityGrid!: EntityGrid;
  let projLumpFor!: Map<string, string>;
  let sprites!: SpriteRenderer;
  let startPos: Vec3 = [0, EYE_HEIGHT, 0];
  let monsterTotal = 0;
  let itemTotal = 0;
  const aliveMonsters = () => state.entities.reduce((n, e) => n + (e.ai && e.ai.state !== "dead" ? 1 : 0), 0);
  const itemsTaken = () => itemTotal - state.entities.reduce((n, e) => n + (e.kind === "item" && e.active ? 1 : 0), 0);

  function buildLevel(name: string): void {
    // Free the previous level's GPU resources — but only after the in-flight frame
    // (which may still reference these textures) has finished on the GPU. A level
    // transition is triggered from a click handler that can land between submit()
    // and GPU completion, so a synchronous destroy would race that frame.
    if (world) {
      const stale = [world, sky, wireframe, sprites, atlas];
      void gpu.device.queue.onSubmittedWorkDone().then(() => { for (const r of stale) r.dispose(); });
    }

    currentMap = name;
    map = loadMap(wad, name);

    // Atlas of every texture/flat this map uses (+ sky).
    const usedNames = new Set<string>();
    for (const sd of map.sidedefs) for (const n of [sd.upper, sd.lower, sd.middle]) if (n !== "-" && n !== "") usedNames.add(n);
    for (const sec of map.sectors) { usedNames.add(sec.floorFlat); usedNames.add(sec.ceilFlat); }
    if (texLib.texture(SKY_TEX)) usedNames.add(SKY_TEX);
    atlas = new TextureAtlas(gpu.device, texLib, litPalette, [...usedNames]);
    const tid = (n: string) => atlas.id(n);
    sky = new Sky(gpu.device, gpu.format, atlas, atlas.id(SKY_TEX));

    // Geometry → indexed mesh → world.
    const walls = buildWalls(map, tid);
    const flats = buildFlats(map, tid);
    const mesh = new Float32Array(walls.vertices.length + flats.vertices.length);
    mesh.set(walls.vertices, 0);
    mesh.set(flats.vertices, walls.vertices.length);
    const wallVertCount = walls.vertices.length / 10;
    const indices = new Uint32Array(walls.indices.length + flats.indices.length);
    indices.set(walls.indices, 0);
    for (let i = 0; i < flats.indices.length; i++) indices[walls.indices.length + i] = flats.indices[i]! + wallVertCount;
    world = new World(gpu.device, gpu.format, mesh, indices, atlas, map.sectors.length * 2);
    wireframe = new Wireframe(gpu.device, gpu.format, map);

    lights = new LightState(map);
    mapState = new MapState(map);
    mapState.onSound = (n, x, y) => sound.play(n, x, y);
    mapState.onExit = onLevelExit;
    world.setHeights(mapState.heights());
    world.setSectorLights(lights.lights());

    // Entities, collision, sprites; carry the player's stats forward.
    state = new GameState(map, spriteLib);
    state.player.health = carried.health;
    state.player.armor = carried.armor;
    state.player.ammo = { ...carried.ammo };
    blockmap = new Blockmap(map);
    entityGrid = new EntityGrid(map);

    // Pre-resolve projectile lumps so the atlas covers dynamically-spawned entities.
    // projLumpFor maps sprite4 → first/spawn frame; all frames go into projLumpSet
    // for atlas registration (they differ, so we can't just take .values()).
    projLumpFor = new Map();
    const projLumpSet = new Set<string>();
    for (const [sprite4, sprite, frame] of PROJ_SPRITES) {
      const l = spriteLib.resolveLump(sprite, frame);
      if (!l) continue;
      projLumpSet.add(l);
      if (!projLumpFor.has(sprite4)) projLumpFor.set(sprite4, l); // first = spawn lump
    }
    const projLumps = [...projLumpSet];
    // +64 instance capacity for in-flight projectiles (fixed instBuf size).
    sprites = new SpriteRenderer(gpu.device, gpu.format, spriteLib, [...state.spriteLumps(), ...projLumps], litPalette, Math.max(1, state.entities.length + 64));
    monsterTotal = state.entities.filter((e) => e.ai).length;
    itemTotal = state.entities.filter((e) => e.kind === "item").length;

    // Camera at player-1 start, eye above the floor it stands on.
    const p1 = map.things.find((t) => t.type === 1);
    const sx = p1 ? p1.x : 0, sy = p1 ? p1.y : 0;
    const sec = locateSector(map, sx, sy);
    const fh = sec >= 0 ? map.sectors[sec]!.floorHeight : 0;
    startPos = [sx, fh + EYE_HEIGHT, -sy];
    cam.pos[0] = startPos[0]; cam.pos[1] = startPos[1]; cam.pos[2] = startPos[2];
    cam.yaw = p1 ? Math.PI / 2 - (p1.angle * Math.PI) / 180 : 0;
    cam.pitch = 0; cam.vz = 0; cam.onKeyClear();

    console.log(`${name}: ${state.entities.length} entities, ${monsterTotal} monsters, atlas 2048×${atlas.atlasHeight}`);
  }

  buildLevel(FIRST_MAP);

  // Campaign progression: E1M1 → … → E4M9, then "campaign complete".
  const MAP_ORDER: string[] = [];
  for (let e = 1; e <= 4; e++) for (let m = 1; m <= 9; m++) MAP_ORDER.push(`E${e}M${m}`);
  function nextMapName(cur: string): string | null {
    const i = MAP_ORDER.indexOf(cur);
    return i >= 0 && i + 1 < MAP_ORDER.length ? MAP_ORDER[i + 1]! : null;
  }

  let levelDone = false;
  function onLevelExit(): void {
    if (levelDone) return;
    levelDone = true;
    carried.health = state.player.health;
    carried.armor = state.player.armor;
    carried.ammo = { ...state.player.ammo };
    // Intermission screen with the level's stats.
    elInterDone.textContent = `${currentMap} COMPLETE`;
    const row = (label: string, val: string) => `<tr><td style="text-align:right;color:var(--fg-dim)">${label}</td><td style="text-align:left;font-weight:700">${val}</td></tr>`;
    elInterStats.innerHTML =
      row("KILLS", `${monsterTotal - aliveMonsters()} / ${monsterTotal}`) +
      row("ITEMS", `${itemsTaken()} / ${itemTotal}`) +
      row("NEXT", nextMapName(currentMap) ?? "—");
    elInter.hidden = false;
    document.exitPointerLock();
  }
  function nextLevel(): void {
    elInter.hidden = true;
    levelDone = false;
    const next = nextMapName(currentMap);
    if (!next) { showMessage("CAMPAIGN COMPLETE", "#7dff8a"); return; }
    buildLevel(next);
    enter();
  }
  elInterCta.addEventListener("click", nextLevel);

  let mode: "world" | "automap" = "world";
  let moveMode: "walk" | "fly" = "walk";
  let started = false;
  const playing = () => document.pointerLockElement === canvas;

  // Title / pause gate: pointer lock is the play state; releasing it (Esc) pauses.
  // Hide the title only once lock is actually granted (pointerlockchange), so a
  // denied lock leaves the title up to retry rather than stranding the player.
  function enter(): void {
    sound.resume(); // user gesture — unlock the AudioContext
    Promise.resolve(canvas.requestPointerLock()).catch(() => { /* lock denied — title stays up */ });
  }
  elCta.addEventListener("click", enter);
  canvas.addEventListener("click", () => { if (started && !playing()) enter(); });
  document.addEventListener("pointerlockchange", () => {
    if (playing()) {
      started = true;
      elTitle.hidden = true;
    } else if (started && elInter.hidden) {
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
    if (e.code === "Space") { e.preventDefault(); useQueued = true; return; }
    cam.onKey(e.code, true);
  });
  addEventListener("keyup", (e) => cam.onKey(e.code, false));
  addEventListener("mousemove", (e) => {
    if (playing()) cam.onMouse(e.movementX, e.movementY);
  });

  // Debug surface. A live getter over the per-level `let` bindings — so it never
  // points at (or retains) a disposed level after buildLevel() swaps them out.
  Object.defineProperty(window, "__doom", {
    configurable: true,
    get: () => ({ gpu, wad, palettes, basePalette, map, world, wireframe, cam, sky, texLib, sprites, mapState, state, blockmap, entityGrid, projLumpFor, updateEntities, fireHitscan, hasSight, applyPickup, weapon, sound, lights, spawnProjectile, updateProjectiles }),
  });

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
  // Fire/use are edge-latched by the DOM handlers and consumed inside the fixed
  // sim tick, so combat mutates state deterministically at tick boundaries and
  // reads tick-stable camera position — not mid-interpolation on the event thread.
  let fireCd = 0;
  let fireQueued = false;
  let useQueued = false;
  let respawnTimer = 0;
  function fire(): void {
    if (fireCd > 0 || state.player.dead || mode !== "world") return;
    fireCd = 0.16;
    weapon.onFire();
    sound.play("DSPISTOL");
    const hit = fireHitscan(state, map, blockmap, cam.pos[0], -cam.pos[2], cam.pos[1], cam.yaw, cam.pitch);
    if (hit?.ai) sound.play(monsterSound(hit.ai.sprite4, hit.ai.state === "dead" ? "death" : "pain"), hit.x, hit.y);
  }

  // Pick up items the player walks over (item disappears via active=false).
  // Broadphase via the entity grid: only items near the player are tested, not all
  // ~123 every tick. Query radius covers the player's cell + neighbours (item
  // radius 16 + player 16 = 32 max pickup distance).
  function checkPickups(): void {
    const px = cam.pos[0], py = -cam.pos[2];
    for (const e of entityGrid.query(px, py, 64)) {
      if (e.kind !== "item" || !e.active) continue;
      if (Math.hypot(e.x - px, e.y - py) < e.radius + 16) {
        if (applyPickup(state.player, e.type)) { e.active = false; sound.play("DSITEMUP"); pickupFlash = 0.6; }
      }
    }
  }
  function damagePlayer(amount: number): void {
    if (state.player.dead) return;
    state.player.health -= amount;
    painFlash = Math.min(1, painFlash + amount / 60); // scale with hit severity
    if (state.player.health <= 0) {
      state.player.health = 0;
      state.player.dead = true;
      painFlash = 1;
      respawnTimer = 2.5;
      sound.play("DSPLDETH");
      showMessage("YOU DIED", "#ff5555");
    } else {
      sound.play("DSPLPAIN");
    }
  }
  function respawn(): void {
    state.player.health = 100;
    state.player.dead = false;
    cam.pos[0] = startPos[0]; cam.pos[1] = startPos[1]; cam.pos[2] = startPos[2];
    cam.vz = 0;
    for (const e of state.entities) if (e.ai) { e.ai.state = "idle"; e.ai.animT = 0; e.ai.animI = 0; }
    hideMessage();
  }
  addEventListener("mousedown", (e) => { if (playing() && e.button === 0) fireQueued = true; });

  let lastW = 0, lastH = 0;
  let heightsWereActive = false; // gates the per-frame heights storage re-upload
  let prev = performance.now();
  let frame = 0, fps = 0, fpsT = prev, fpsN = 0;

  // MSAA: all passes render into a 4× color target, resolved to the swapchain.
  let msaaTex: GPUTexture | null = null, msaaW = 0, msaaH = 0;
  function msaaView(w: number, h: number): GPUTextureView {
    if (!msaaTex || msaaW !== w || msaaH !== h) {
      msaaTex?.destroy();
      msaaTex = gpu.device.createTexture({
        label: "msaa-color", size: { width: w, height: h }, format: gpu.format,
        sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      msaaW = w; msaaH = h;
    }
    return msaaTex.createView();
  }

  // Fixed-timestep simulation at Doom's 35 tics/sec; render interpolates position.
  const FIXED = 1 / 35;
  let acc = 0;
  let simPrev: Vec3 = [cam.pos[0], cam.pos[1], cam.pos[2]];
  const billboards: SpriteRequest[] = [];

  function simulate(dt: number): void {
    simPrev = [cam.pos[0], cam.pos[1], cam.pos[2]];
    entityGrid.rebuild(state.entities); // broadphase snapshot for this tick (pickups; future mob/projectile queries)
    if (moveMode === "fly") cam.update(dt);
    else walkStep(dt);
    mapState.update(dt);
    lights.update(dt);

    // Combat timers, monster AI, pickups, respawn.
    sound.setListener(cam.pos[0], -cam.pos[2], cam.yaw);
    fireCd -= dt;
    // Consume edge-latched player actions at the tick boundary (post-move).
    if (useQueued) { useQueued = false; doUse(); }
    if (fireQueued) { fireQueued = false; fire(); }
    if (state.player.dead) { respawnTimer -= dt; if (respawnTimer <= 0) respawn(); }
    else checkPickups();
    updateEntities(state.entities, dt, {
      map, blockmap, px: cam.pos[0], py: -cam.pos[2], damagePlayer,
      playSound: (name, x, y) => sound.play(name, x, y),
      projLumpFor,
      spawnProjectile: (x, y, z, vx, vy, lump, damage) =>
        spawnProjectile(state.entities, x, y, z, vx, vy, lump, damage),
      queryNear: (x, y, r) => entityGrid.query(x, y, r),
    });
    updateProjectiles(state.entities, dt, {
      map, blockmap, px: cam.pos[0], py: -cam.pos[2],
      queryNear: (x, y, r) => entityGrid.query(x, y, r),
      damagePlayer,
      playSound: (name, x, y) => sound.play(name, x, y),
    });
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
      // Lag-spike guard: if we hit the step cap, drop the unsimulated backlog so
      // alpha doesn't stay pinned at 1 (frozen interpolation) for several frames.
      if (acc >= FIXED) acc %= FIXED;
    } else {
      acc = 0; simPrev = [cam.pos[0], cam.pos[1], cam.pos[2]];
    }
    const alpha = Math.max(0, Math.min(1, acc / FIXED));
    const eye: Vec3 = [
      simPrev[0] + (cam.pos[0] - simPrev[0]) * alpha,
      simPrev[1] + (cam.pos[1] - simPrev[1]) * alpha,
      simPrev[2] + (cam.pos[2] - simPrev[2]) * alpha,
    ];

    // Only re-upload the animated storage buffers when something actually moved
    // this frame. Heights change only while a door/lift is active (plus the final
    // frame it settles); lights only when a flicker/strobe value flipped.
    const heightsActive = mapState.activeCount > 0;
    if (heightsActive || heightsWereActive) world.setHeights(mapState.heights());
    heightsWereActive = heightsActive;
    if (lights.consumeDirty()) world.setSectorLights(lights.lights());
    const inGame = playing() && mode === "world";
    elCrosshair.hidden = !inGame;

    // Decay screen flashes (pain = 3/s, pickup = 5/s) and write opacity.
    if (painFlash > 0)   { painFlash   = Math.max(0, painFlash   - dt * 3); elPainFlash.style.opacity   = String(painFlash); }
    if (pickupFlash > 0) { pickupFlash = Math.max(0, pickupFlash - dt * 5); elPickupFlash.style.opacity = String(pickupFlash); }

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
      if (!e.active || !e.lump) continue;
      const onFloor = e.ai?.state === "dead"; // corpses lie flat; everything else is a billboard
      billboards.push({ lump: e.lump, x: e.x, y: e.y, floor: e.z, light: lights.sectorLight(e.sector), onFloor });
    }
    sprites.setBillboards(billboards);

    const aspect = w / h;
    const swapView = gpu.context.getCurrentTexture().createView();
    const colorView = msaaView(w, h); // 4× MSAA target
    const encoder = gpu.device.createCommandEncoder({ label: "frame" });

    if (mode === "world") {
      const vp = cam.viewProjAt(eye, aspect);
      world.setFrame(vp, eye);
      const camRight: [number, number, number] = [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)];
      sprites.setFrame(vp, eye, camRight);
      const drawSky = sky.skyId >= 0;
      if (drawSky) sky.setFrame(invert(vp), eye);

      // One render pass for world + sprites + sky. The MSAA color is resolved
      // into the swapchain on store (storeOp "discard" is correct here — the
      // multisample texture isn't needed after the resolve). Collapsing the three
      // draws into a single pass avoids two tile color+depth reloads per frame.
      const pass = encoder.beginRenderPass({
        label: "world",
        colorAttachments: [
          { view: colorView, resolveTarget: swapView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "discard" },
        ],
        depthStencilAttachment: {
          view: world.depthView(w, h),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "discard",
        },
      });
      world.draw(pass);          // opaque geometry, writes depth
      sprites.draw(pass);        // alpha-tested billboards, depth-tested + writing
      if (drawSky) sky.draw(pass); // fills untouched depth==1.0 pixels last
      pass.end();
    } else {
      const pass = encoder.beginRenderPass({
        label: "automap",
        colorAttachments: [
          { view: colorView, resolveTarget: swapView, clearValue: { r: 0.06, g: 0.01, b: 0.02, a: 1 }, loadOp: "clear", storeOp: "discard" },
        ],
      });
      wireframe.draw(pass);
      pass.end();
    }

    gpu.device.queue.submit([encoder.finish()]);

    frame++; fpsN++;
    if (now - fpsT >= 500) { fps = Math.round((fpsN * 1000) / (now - fpsT)); fpsN = 0; fpsT = now; }
    hud.textContent =
      `webgpu-doom — P4 MSAA   [${mode} · ${moveMode}]  (CLICK fire · Space use · M map · F fly · WASD)\n` +
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
