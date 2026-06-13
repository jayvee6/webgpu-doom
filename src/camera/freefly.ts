/**
 * Free-fly FPS camera. Yaw around world Y, pitch clamped. WASD + QE (down/up),
 * mouse-look via pointer lock. World coords: X = map.x, Y = height, Z = -map.y.
 */

import { lookAt, perspectiveZO, multiply, type Mat4, type Vec3 } from "../math/mat4";

const HALF_PI = Math.PI / 2 - 0.01;

export class FreeFlyCamera {
  pos: Vec3;
  yaw: number; // radians; 0 looks toward -Z
  pitch = 0;
  fovY = (75 * Math.PI) / 180;
  near = 1;
  far = 12000;
  speed = 350; // units/sec
  vz = 0; // vertical velocity (walk-mode gravity)
  private keys = new Set<string>();

  constructor(pos: Vec3, yaw = 0) {
    this.pos = pos;
    this.yaw = yaw;
  }

  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  onKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  onKeyClear(): void {
    this.keys.clear();
  }

  /** Desired horizontal move direction in MAP space (x,y), normalized; [0,0] if idle. */
  planarInput(): [number, number] {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // map forward = (sin yaw, cos yaw); map right = (cos yaw, -sin yaw)
    let mx = 0, my = 0;
    if (this.keys.has("KeyW")) { mx += sy; my += cy; }
    if (this.keys.has("KeyS")) { mx -= sy; my -= cy; }
    if (this.keys.has("KeyD")) { mx += cy; my -= sy; }
    if (this.keys.has("KeyA")) { mx -= cy; my += sy; }
    const len = Math.hypot(mx, my);
    if (len > 0) { mx /= len; my /= len; }
    return [mx, my];
  }

  running(): boolean {
    return this.keys.has("ShiftRight") || this.keys.has("ShiftLeft");
  }

  onMouse(dx: number, dy: number, sens = 0.0022): void {
    this.yaw += dx * sens;
    this.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, this.pitch - dy * sens));
  }

  update(dt: number): void {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // Flat forward/right (movement stays horizontal regardless of pitch).
    const fx = sy, fz = -cy;
    const rx = cy, rz = sy;
    let mx = 0, mz = 0, my = 0;
    if (this.keys.has("KeyW")) { mx += fx; mz += fz; }
    if (this.keys.has("KeyS")) { mx -= fx; mz -= fz; }
    if (this.keys.has("KeyD")) { mx += rx; mz += rz; }
    if (this.keys.has("KeyA")) { mx -= rx; mz -= rz; }
    if (this.keys.has("KeyE")) my += 1;
    if (this.keys.has("KeyQ")) my -= 1;

    const boost = this.keys.has("ShiftRight") ? 3 : 1;
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
    const d = this.speed * boost * dt;
    this.pos[0] += mx * d;
    this.pos[2] += mz * d;
    this.pos[1] += my * d;
  }

  viewProj(aspect: number): Mat4 {
    return this.viewProjAt(this.pos, aspect);
  }

  /** Build the view-projection from an arbitrary eye position (for interpolation). */
  viewProjAt(pos: Vec3, aspect: number): Mat4 {
    const f = this.forward();
    const center: Vec3 = [pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]];
    const view = lookAt(pos, center, [0, 1, 0]);
    const proj = perspectiveZO(this.fovY, aspect, this.near, this.far);
    return multiply(proj, view);
  }
}
