# Player-Entity Refactor — Plan

**Status:** Phases 0–3 implemented (tsc + build clean); live runtime verification still pending (preview tooling was unavailable during implementation). See each phase's gate-out checks for what to confirm on a real drive.
**Why it's #1:** Today the player *is* the camera (`FreeFlyCamera`). Position lives on `cam.pos`, walk physics live in `walkStep()` inside `main.ts`, stats live in `state.player`, and cross-level carry lives in a third object, `carried`. Because there's no player *entity*, monsters can't block the player, the player can't block monsters, and every downstream system takes bare `px/py` floats. This single missing abstraction caps combat feel, saves, demos, and anything multiplayer-shaped. Fixing it also delivers the biggest *feel* win (momentum-based movement) at the same time.

## Current shape (grounded in the code)

| Concern | Lives in | File |
|---|---|---|
| Player position, `vz`, yaw, pitch | `FreeFlyCamera` | `src/camera/freefly.ts` |
| Walk collide/slide/gravity | `walkStep(dt)` closure mutating `cam.pos` | `src/main.ts:351` |
| Player stats (health/armor/ammo/keys) | `GameState.player` | `src/game/state.ts:59` |
| Cross-level carry | `carried` literal | `src/main.ts:119` |
| "Where is the player" for AI/projectiles/combat | passed as bare `px`/`py` | `main.ts:487`, `:495`, `combat.ts` |
| Broadphase (buckets active entities) | `EntityGrid` — header already names entity-vs-entity as its purpose | `src/game/entitygrid.ts` |
| Wall collision (circle vs lines, slide) | `blocked()` | `src/game/collision.ts:34` |

Monsters admit they can't block you (`src/game/ai.ts`), and `EntityGrid` is already built and rebuilt each tick — it just isn't consulted for blocking yet.

## Target

- The player is a real `Entity` (`state.pmo` — "player map object") pushed into `state.entities[]`, so `EntityGrid` buckets it and monster `queryNear` sees it.
- The player entity owns **position, horizontal velocity (`vx,vy`), vertical velocity (`vz`), and facing (`angle`)**. `GameState.player` keeps the *stats* (health/armor/ammo/keys). One source of truth for each concern.
- `FreeFlyCamera` is demoted to **input + aim + projection**: it reads keys/mouse, holds `pitch` and the view matrix math, and *reads* the player entity for position/yaw. It no longer owns where the player is.
- Movement gets Doom's **thrust + friction** momentum instead of instant velocity.
- Both the player move and monster moves consult `EntityGrid` for **entity↔entity blocking**.

## Phased execution — each phase ships and is verifiable on its own

### Phase 0 — Scaffold the player entity (zero behavior change)
- Add `"player"` to `ThingCategory` (`src/wad/thingtypes.ts`) and to `Entity.kind`.
- In `GameState` (or `buildLevel`), construct a player Entity at the player-1 start (radius `PLAYER_RADIUS`=16, height `PLAYER_HEIGHT`=56), add `vx/vy` fields to `Entity` (optional, monster-inert). Store it as `state.pmo` and `push` it into `state.entities`.
- Keep the camera authoritative for now: at the **end** of each tick, sync `pmo.{x,y,z}` from `cam.pos`. Mark `pmo` so the billboard loop and combat **skip** it (don't draw/shoot yourself) — e.g. `kind === "player"` guard in the `billboards` loop (`main.ts:556`) and in combat target scans.
- **Gate-out:** game plays byte-identically; `window.__doom.state.pmo` exists and tracks the camera; monster kill counts unchanged; you are not rendered as a sprite and can't shoot yourself.

### Phase 1 — Make the entity authoritative + add momentum
- Move `walkStep` logic to operate on `state.pmo` (`x,y,z,vx,vy,vz`). New model per tick:
  1. `thrust`: add input direction × accel to `vx,vy` (Doom `P_Thrust`).
  2. `friction`: `vx *= FRICTION; vy *= FRICTION` (Doom `FRICTION = 0.90625`).
  3. move by velocity with the **existing** `blocked()` axis-separated slide (unchanged, just sourced from `pmo`).
  4. floor-follow + gravity + head clamp exactly as `walkStep` does today.
- Camera position is synced **from** `pmo` after the step; interpolation (`simPrev`/`eye`, `main.ts:467`,`:520`) tracks `pmo` prev→cur instead of `cam.pos`.
- Tuning: expose `THRUST`, `FRICTION`, `MAX_WALK`, `MAX_RUN` as live handles on `window.__doom` (per your viz-tuning habit), tune until run speed ≈ 583 u/s and the skid feels right, then bake the constants. Equilibrium speed = `accel_per_tic / (1 - FRICTION)`, so `accel_per_tic ≈ target × 0.09375`.
- Keep the fly-mode (`F`) debug path working (it can stay velocity-instant).
- **Gate-out:** movement has ramp-up/skid/overshoot; wall slide still works; no floor clip; step-up (≤24) still climbs; fly mode still flies.

### Phase 2 — Entity↔entity blocking
- Add `blockedByEntity(grid, mover, nx, ny)`: query `grid` at `(nx, ny, mover.radius + MAX_ENTITY_RADIUS)`, return true if any candidate that is `active`, blocking (monster, alive), **not self**, and **z-overlapping** (so you walk *over* corpses) has `hypot(dx,dy) < mover.radius + other.radius`.
  - Non-blockers: items, decor, dead monsters, projectiles.
- Apply in the player's axis-separated move (can't walk through a live Baron) **and** in the monster chase move in `ai.ts` (monsters stop at you and each other — this is what makes melee land and kills conga-lines). Reconcile with the existing monster-separation code if present.
- **⚠ Aliasing gotcha:** `EntityGrid.query()` returns a *single shared* `result` array valid only until the next `query()` (`entitygrid.ts:23,61`). Phase 2 introduces nested queries (a monster move queries while the tick loop is mid-iterate). **Consume candidates immediately or copy them** — do not hold a `query()` result across another `query()`. Call this out in review.
- **Gate-out:** can't walk through a live monster; monsters bump you/each other; corpses and items never block; no crash from shared-array reuse.

### Phase 3 — Collapse the state smear
- AI/projectile/combat contexts read player position/facing from `state.pmo` (either replace `px/py` args, or keep the args but source them from `pmo` for minimal churn). Player `angle` updated by mouse-look on the entity.
- `respawn()` (`main.ts:434`) repositions `pmo` and zeroes its velocity; `carried` is retired in favor of reading `pmo`/`player` at level exit (or kept only as the serialization struct).
- **Gate-out:** single source of truth per concern; no `carried` duplication of live state; respawn and level-carry still correct.

## Files touched
- `src/game/state.ts` — player Entity, `pmo`, `vx/vy`, `kind:"player"`.
- `src/wad/thingtypes.ts` — `"player"` in `ThingCategory`.
- `src/camera/freefly.ts` — demote to input/aim/projection; read pmo.
- `src/main.ts` — `walkStep`→pmo thrust/friction; interp on pmo; billboard + combat self-skip; respawn; enter/carry.
- `src/game/ai.ts` — monster move consults entity blocking; player pos from pmo.
- `src/game/collision.ts` — add `blockedByEntity`.
- `src/game/projectile.ts` — player pos from pmo (Phase 3).

## Risks
- **Shared-array aliasing** in `EntityGrid.query` (see Phase 2) — the one real footgun.
- Interpolation regressions if `simPrev` isn't switched cleanly to `pmo` — watch for stutter.
- Don't render or self-target the player entity (Phase 0 guard is load-bearing).
- Tuning momentum to "feels like Doom" is iterative; ship the sliders before baking.

## Definition of done
Player is an entity with momentum, monsters block and are blocked, and no gameplay system reads player position from the camera. This unblocks the "make combat real" work (ammo/shotgun/autoaim/hitscan monsters) and any future save/demo/netcode.
