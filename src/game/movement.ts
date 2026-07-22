/**
 * Player horizontal movement — Doom's P_Thrust momentum model, extracted as a pure
 * function so the physics can be unit-tested without the map, GPU, or DOM. One call
 * advances velocity by one 35 Hz sim tic: friction is applied, then thrust toward the
 * (already-normalized) input direction. The friction equilibrium speed
 * accel/(1−FRICTION) equals the target walk/run speed, so holding a direction ramps
 * up to speed and releasing skids to a stop instead of snapping.
 */

export interface MoveTune {
  MAX_WALK: number; // equilibrium speed while walking (map units/sec)
  MAX_RUN: number;  // equilibrium speed while running (map units/sec)
  FRICTION: number; // per-tic velocity retention (Doom = 0.90625)
}

export interface Velocity {
  vx: number;
  vy: number;
}

/**
 * Advance horizontal velocity by one tic. (idx,idy) is the desired move direction in
 * map space — normalized upstream, so [0,0] means "no input" and the velocity simply
 * decays by FRICTION (the skid). Returns a fresh velocity; does not mutate the input.
 */
export function stepVelocity(v: Velocity, idx: number, idy: number, running: boolean, tune: MoveTune): Velocity {
  const maxV = running ? tune.MAX_RUN : tune.MAX_WALK;
  const accel = maxV * (1 - tune.FRICTION);
  return {
    vx: v.vx * tune.FRICTION + idx * accel,
    vy: v.vy * tune.FRICTION + idy * accel,
  };
}
