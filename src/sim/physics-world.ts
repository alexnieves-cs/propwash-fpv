import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

/** Fixed physics / flight-controller step. 500 Hz keeps the rate loop honest at 1000°/s. */
export const PHYSICS_DT = 1 / 500;
export const GRAVITY = 9.81;

let ready: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface SurfaceOpts {
  friction?: number;
  restitution?: number;
}

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Thin wrapper over a Rapier world holding the static scenery colliders. */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  colliderCount = 0;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_DT;
  }

  private finish(desc: RAPIER.ColliderDesc, x: number, y: number, z: number, q: Quat, o?: SurfaceOpts): RAPIER.Collider {
    desc
      .setTranslation(x, y, z)
      .setRotation(q)
      .setFriction(o?.friction ?? 0.75)
      .setRestitution(o?.restitution ?? 0.22);
    this.colliderCount++;
    return this.world.createCollider(desc);
  }

  addBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, q: Quat = IDENTITY, o?: SurfaceOpts): RAPIER.Collider {
    return this.finish(RAPIER.ColliderDesc.cuboid(hx, hy, hz), x, y, z, q, o);
  }

  /** Cylinder with its axis along local Y. */
  addCylinder(x: number, y: number, z: number, halfHeight: number, radius: number, q: Quat = IDENTITY, o?: SurfaceOpts): RAPIER.Collider {
    return this.finish(RAPIER.ColliderDesc.cylinder(halfHeight, radius), x, y, z, q, o);
  }

  addCapsule(x: number, y: number, z: number, halfHeight: number, radius: number, q: Quat = IDENTITY, o?: SurfaceOpts): RAPIER.Collider {
    return this.finish(RAPIER.ColliderDesc.capsule(halfHeight, radius), x, y, z, q, o);
  }

  addCone(x: number, y: number, z: number, halfHeight: number, radius: number, q: Quat = IDENTITY, o?: SurfaceOpts): RAPIER.Collider {
    return this.finish(RAPIER.ColliderDesc.cone(halfHeight, radius), x, y, z, q, o);
  }

  addBall(x: number, y: number, z: number, radius: number, o?: SurfaceOpts): RAPIER.Collider {
    return this.finish(RAPIER.ColliderDesc.ball(radius), x, y, z, IDENTITY, o);
  }

  addTrimesh(vertices: Float32Array, indices: Uint32Array, o?: SurfaceOpts): RAPIER.Collider {
    return this.finish(RAPIER.ColliderDesc.trimesh(vertices, indices), 0, 0, 0, IDENTITY, o);
  }

  /**
   * Regular height grid centred on (cx, cz). `heights` is row-major: h[iz * (nx + 1) + ix],
   * with ix running along +X and iz along +Z.
   */
  addHeightfield(nx: number, nz: number, heights: Float32Array, sizeX: number, sizeZ: number, cx = 0, cz = 0, o?: SurfaceOpts): RAPIER.Collider {
    // Rapier wants a column-major matrix whose rows run along Z and columns along X.
    const h = new Float32Array((nx + 1) * (nz + 1));
    for (let ix = 0; ix <= nx; ix++) {
      for (let iz = 0; iz <= nz; iz++) h[ix * (nz + 1) + iz] = heights[iz * (nx + 1) + ix];
    }
    const desc = RAPIER.ColliderDesc.heightfield(nz, nx, h, { x: sizeX, y: 1, z: sizeZ });
    return this.finish(desc, cx, 0, cz, IDENTITY, o);
  }

  /** Distance to the first hit along a ray, or -1. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, exclude?: RAPIER.RigidBody): number {
    const r = this.ray;
    r.origin.x = ox;
    r.origin.y = oy;
    r.origin.z = oz;
    r.dir.x = dx;
    r.dir.y = dy;
    r.dir.z = dz;
    const hit = this.world.castRay(r, maxDist, true, undefined, undefined, undefined, exclude);
    return hit ? hit.timeOfImpact : -1;
  }

  step(): void {
    this.world.step();
  }

  dispose(): void {
    this.world.free();
  }
}
