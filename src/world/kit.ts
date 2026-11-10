import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Side,
} from 'three';
import type { TexName } from '../render/textures';
import type { WorldCtx } from './types';

export interface MatOpts {
  color?: number;
  /** physical size of one texture tile, metres */
  tile?: number;
  roughness?: number;
  metalness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  normalScale?: number;
  side?: Side;
  castShadow?: boolean;
}

interface Batch {
  material: MeshStandardMaterial;
  tile: number;
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
  count: number;
  castShadow: boolean;
}

export interface PlaceOpts {
  /** yaw in degrees, clockwise seen from above */
  yaw?: number;
  /** full rotation (overrides yaw) */
  rot?: [number, number, number];
  collide?: boolean;
  friction?: number;
  restitution?: number;
}

const _q = new Quaternion();
const _e = new Euler();
const _v = new Vector3();
const _n = new Vector3();
const DEG = Math.PI / 180;

/**
 * A tiny CSG-free modelling kit: place textured boxes and cylinders, get merged meshes (one draw
 * call per material) and matching physics colliders. Buildings, gates and props are all made of it.
 */
export class Kit {
  private batches = new Map<string, Batch>();
  readonly group = new Group();

  constructor(private ctx: WorldCtx) {}

  /** Define (or fetch) a named material built on one of the procedural texture sets. */
  mat(key: string, tex: TexName | null, o: MatOpts = {}): string {
    if (this.batches.has(key)) return key;
    const m = new MeshStandardMaterial({
      color: new Color(o.color ?? 0xffffff),
      roughness: o.roughness ?? 1,
      metalness: o.metalness ?? 0,
      side: o.side ?? 0,
    });
    if (tex) {
      const set = this.ctx.forge.get(tex);
      m.map = set.map;
      m.normalMap = set.normalMap;
      m.roughnessMap = set.orm;
      m.aoMap = set.orm;
      if (o.normalScale !== undefined) m.normalScale.setScalar(o.normalScale);
    }
    if (o.emissive !== undefined) {
      m.emissive = new Color(o.emissive);
      m.emissiveIntensity = o.emissiveIntensity ?? 1;
    }
    this.batches.set(key, { material: m, tile: o.tile ?? 2, pos: [], nor: [], uv: [], idx: [], count: 0, castShadow: o.castShadow ?? true });
    return key;
  }

  material(key: string): MeshStandardMaterial {
    return this.batches.get(key)!.material;
  }

  private rotation(o: PlaceOpts): Quaternion {
    if (o.rot) return _q.setFromEuler(_e.set(o.rot[0] * DEG, o.rot[1] * DEG, o.rot[2] * DEG, 'YXZ'));
    return _q.setFromEuler(_e.set(0, -(o.yaw ?? 0) * DEG, 0));
  }

  /** Box centred at (x, y, z) with full sizes (sx, sy, sz). */
  box(key: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, o: PlaceOpts = {}): void {
    const b = this.batches.get(key)!;
    const q = this.rotation(o);
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const t = 1 / b.tile;
    // each face: normal, two tangent axes, and the half sizes along them
    const faces: [number, number, number, number, number, number, number, number, number, number, number][] = [
      [1, 0, 0, 0, 0, -1, 0, 1, 0, hz, hy],
      [-1, 0, 0, 0, 0, 1, 0, 1, 0, hz, hy],
      [0, 1, 0, 1, 0, 0, 0, 0, -1, hx, hz],
      [0, -1, 0, 1, 0, 0, 0, 0, 1, hx, hz],
      [0, 0, 1, 1, 0, 0, 0, 1, 0, hx, hy],
      [0, 0, -1, -1, 0, 0, 0, 1, 0, hx, hy],
    ];
    for (const f of faces) {
      const [nx, ny, nz, ux, uy, uz, vx, vy, vz, hu, hv] = f;
      const base = b.count;
      _n.set(nx, ny, nz).applyQuaternion(q);
      for (let j = -1; j <= 1; j += 2) {
        for (let i = -1; i <= 1; i += 2) {
          _v.set(nx * hx + ux * hu * i + vx * hv * j, ny * hy + uy * hu * i + vy * hv * j, nz * hz + uz * hu * i + vz * hv * j);
          // world-scale UVs, offset by position so neighbouring boxes don't share the same crop
          const u = (i * hu + (x + z) * 0.37) * t;
          const v = (j * hv + y) * t;
          _v.applyQuaternion(q);
          b.pos.push(_v.x + x, _v.y + y, _v.z + z);
          b.nor.push(_n.x, _n.y, _n.z);
          b.uv.push(u, v);
          b.count++;
        }
      }
      b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    if (o.collide !== false) {
      this.ctx.physics.addBox(x, y, z, hx, hy, hz, { x: q.x, y: q.y, z: q.z, w: q.w }, { friction: o.friction, restitution: o.restitution });
    }
  }

  /** Cylinder centred at (x, y, z). `axis` picks which way it lies before yaw is applied. */
  cyl(
    key: string,
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    o: PlaceOpts & { axis?: 'x' | 'y' | 'z'; segments?: number; radiusTop?: number; open?: boolean } = {},
  ): void {
    const b = this.batches.get(key)!;
    const geo = new CylinderGeometry(o.radiusTop ?? radius, radius, length, o.segments ?? 14, 1, o.open ?? false);
    const q = new Quaternion();
    if (o.rot) q.setFromEuler(_e.set(o.rot[0] * DEG, o.rot[1] * DEG, o.rot[2] * DEG, 'YXZ'));
    else {
      q.setFromEuler(_e.set(0, -(o.yaw ?? 0) * DEG, 0));
      if (o.axis === 'x') q.multiply(_q.setFromEuler(_e.set(0, 0, Math.PI / 2)));
      else if (o.axis === 'z') q.multiply(_q.setFromEuler(_e.set(Math.PI / 2, 0, 0)));
    }
    const p = geo.getAttribute('position');
    const n = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const base = b.count;
    const circ = 2 * Math.PI * radius;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyQuaternion(q);
      _n.fromBufferAttribute(n, i).applyQuaternion(q);
      b.pos.push(_v.x + x, _v.y + y, _v.z + z);
      b.nor.push(_n.x, _n.y, _n.z);
      b.uv.push((uv.getX(i) * circ) / b.tile, (uv.getY(i) * length) / b.tile);
      b.count++;
    }
    const index = geo.getIndex()!;
    for (let i = 0; i < index.count; i++) b.idx.push(base + index.getX(i));
    geo.dispose();
    if (o.collide !== false) {
      this.ctx.physics.addCylinder(x, y, z, length / 2, Math.max(radius, o.radiusTop ?? 0), { x: q.x, y: q.y, z: q.z, w: q.w }, { friction: o.friction, restitution: o.restitution });
    }
  }

  /** Append an arbitrary pre-transformed geometry (no collider). UVs are used as given. */
  add(key: string, geo: BufferGeometry): void {
    const b = this.batches.get(key)!;
    const p = geo.getAttribute('position');
    const n = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const base = b.count;
    for (let i = 0; i < p.count; i++) {
      b.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      b.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      b.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      b.count++;
    }
    const index = geo.getIndex();
    if (index) for (let i = 0; i < index.count; i++) b.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) b.idx.push(base + i);
  }

  /** Merge everything placed so far into meshes and attach them to the map. */
  build(): Group {
    for (const b of this.batches.values()) {
      if (b.count === 0) continue;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
      g.setAttribute('normal', new BufferAttribute(new Float32Array(b.nor), 3));
      g.setAttribute('uv', new BufferAttribute(new Float32Array(b.uv), 2));
      g.setIndex(b.count > 65535 ? new BufferAttribute(new Uint32Array(b.idx), 1) : new BufferAttribute(new Uint16Array(b.idx), 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const mesh = new Mesh(g, b.material);
      mesh.castShadow = b.castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      b.pos = [];
      b.nor = [];
      b.uv = [];
      b.idx = [];
      b.count = 0;
    }
    this.ctx.root.add(this.group);
    return this.group;
  }

  dispose(): void {
    for (const child of this.group.children) (child as Mesh).geometry.dispose();
    for (const b of this.batches.values()) b.material.dispose();
  }
}

export { DoubleSide };
