import { Quaternion, Vector3 } from 'three';
import { makeRng } from '../src/core/math';
import { hoverThrottle, type DroneConfig } from '../src/sim/drone-config';
import type { RcCommand } from '../src/sim/flight-controller';
import { PHYSICS_DT, PhysicsWorld } from '../src/sim/physics-world';
import { Quad, type Atmosphere } from '../src/sim/quad';

/** Shared by the step-cost bench and its sanity check. */

export const air: Atmosphere = { wind: new Vector3(0.8, 0, -0.4), density: 1.225 };
const dt = PHYSICS_DT;

/** The quad goes back to its start point this often (8 s of sim time), so it never wanders off. */
export const RESET_EVERY = 4000;

/** Gentle, never-repeating stick motion around hover, so the controller has real work to do. */
export function sticks(cfg: DroneConfig): (i: number) => RcCommand {
  const th = hoverThrottle(cfg);
  const cmd: RcCommand = { roll: 0, pitch: 0, yaw: 0, throttle: th, climb: 0 };
  return (i) => {
    const t = i * dt;
    cmd.roll = 0.25 * Math.sin(t * 2.3);
    cmd.pitch = 0.2 * Math.sin(t * 1.7 + 1);
    cmd.yaw = 0.3 * Math.sin(t * 0.9);
    cmd.throttle = th * (1 + 0.05 * Math.sin(t * 3.1));
    return cmd;
  };
}

export function flatWorld(): PhysicsWorld {
  const world = new PhysicsWorld();
  world.addBox(0, -1, 0, 4000, 1, 4000);
  return world;
}

/** Ground height of the stand-in terrain. */
export const terrainAt = (x: number, z: number): number => 6 * Math.sin(x * 0.011) * Math.cos(z * 0.013) + 2 * Math.sin(x * 0.05 + z * 0.03);

/** Radius of the tree-free clearing around the start point. */
export const CLEARING = 6;

/**
 * A stand-in for Larkspur Valley's colliders, which need a GPU to build: a 420 x 420 cell height
 * field over 1260 m (the alpine map's grid: 3 m cells, 630 m half-size) and 18,000 six-sided tree
 * colliders merged into one trimesh, built the way src/world/vegetation.ts builds them. The real
 * map has fewer trees with colliders (about 13,300 by the estimate in docs/PERFORMANCE.md), so
 * this errs on the heavy side.
 */
export function forestWorld(): PhysicsWorld {
  const world = new PhysicsWorld();
  const n = 420;
  const size = 1260;
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) heights[iz * (n + 1) + ix] = terrainAt((ix / n - 0.5) * size, (iz / n - 0.5) * size);
  world.addHeightfield(n, n, heights, size, size);
  const rng = makeRng(77);
  const verts: number[] = [];
  const idx: number[] = [];
  const SIDES = 6;
  for (let i = 0; i < 18000; i++) {
    const r = Math.sqrt(rng()) * 650;
    const a = rng() * Math.PI * 2;
    if (r < CLEARING) continue;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = terrainAt(x, z);
    const s = 0.8 + rng() * 0.5;
    const ring = (yy: number, rr: number): number => {
      const first = verts.length / 3;
      for (let k = 0; k < SIDES; k++) {
        const t = (k / SIDES) * Math.PI * 2;
        verts.push(x + Math.cos(t) * rr, yy, z + Math.sin(t) * rr);
      }
      return first;
    };
    const b0 = ring(y - 0.5, 0.25 * s);
    const b1 = ring(y + 14 * s, 0.12 * s);
    for (let k = 0; k < SIDES; k++) {
      const m = (k + 1) % SIDES;
      idx.push(b0 + k, b1 + k, b0 + m, b0 + m, b1 + k, b1 + m);
    }
    const y0 = y + 3 * s;
    const r0 = ring(y0, 2.6 * s);
    const apex = verts.length / 3;
    verts.push(x, y0 + 11 * s, z);
    const centre = verts.length / 3;
    verts.push(x, y0, z);
    for (let k = 0; k < SIDES; k++) {
      const m = (k + 1) % SIDES;
      idx.push(r0 + k, apex, r0 + m, r0 + m, centre, r0 + k);
    }
  }
  world.addTrimesh(new Float32Array(verts), new Uint32Array(idx));
  world.step();
  return world;
}

function launch(quad: Quad, at: Vector3): void {
  quad.reset(at, new Quaternion());
  quad.fc.armed = true;
  quad.fc.mode = 'angle';
  quad.fc.altHold = true;
}

/**
 * One step exactly as Game.step runs it, minus race and trick bookkeeping: angle mode with
 * altitude hold, so the quad holds its height, and a reset every RESET_EVERY steps.
 */
export function stepper(world: PhysicsWorld, cfg: DroneConfig, at: Vector3): { step: () => void; quad: Quad } {
  const quad = new Quad(world, cfg);
  quad.unlimitedBattery = true;
  launch(quad, at);
  const cmd = sticks(cfg);
  let i = 0;
  const step = (): void => {
    if (++i % RESET_EVERY === 0) launch(quad, at);
    quad.preStep(dt, cmd(i), air);
    world.step();
    quad.postStep(dt);
  };
  return { step, quad };
}
