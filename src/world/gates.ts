import { BoxGeometry, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Quaternion, TorusGeometry, Vector3, Euler } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Kit } from './kit';
import type { GateDef, WorldCtx } from './types';

export interface GateRuntime {
  def: GateDef;
  index: number;
  center: Vector3;
  /** unit direction the pilot must cross in */
  normal: Vector3;
  right: Vector3;
  up: Vector3;
  halfW: number;
  halfH: number;
  round: boolean;
  glow: MeshStandardMaterial;
  /** where to respawn a crashed pilot who had already cleared this gate */
  respawn: Vector3;
  heading: number;
}

const DEG = Math.PI / 180;
const GO = new Color(0.1, 1.0, 0.55);
const IDLE = new Color(1.0, 0.36, 0.08);
const DONE = new Color(0.25, 0.3, 0.36);

/** Set how a gate's light strip looks: 'next' pulses, 'after' is a steady cue, 'done' goes dark. */
export function setGateState(g: GateRuntime, state: 'idle' | 'next' | 'after' | 'done', time: number): void {
  const m = g.glow;
  if (state === 'next') {
    m.emissive.copy(GO);
    m.emissiveIntensity = 9 + 5 * Math.sin(time * 7);
  } else if (state === 'after') {
    m.emissive.copy(IDLE);
    m.emissiveIntensity = 4;
  } else if (state === 'done') {
    m.emissive.copy(DONE);
    m.emissiveIntensity = 0.5;
  } else {
    m.emissive.copy(IDLE);
    m.emissiveIntensity = 2.2;
  }
}

/** Does the segment p0→p1 pass through the gate opening in the right direction? */
export function crossesGate(g: GateRuntime, p0: Vector3, p1: Vector3): boolean {
  const d0 = (p0.x - g.center.x) * g.normal.x + (p0.y - g.center.y) * g.normal.y + (p0.z - g.center.z) * g.normal.z;
  const d1 = (p1.x - g.center.x) * g.normal.x + (p1.y - g.center.y) * g.normal.y + (p1.z - g.center.z) * g.normal.z;
  if (d0 >= 0 || d1 < 0) return false;
  const t = d0 / (d0 - d1);
  const x = p0.x + (p1.x - p0.x) * t - g.center.x;
  const y = p0.y + (p1.y - p0.y) * t - g.center.y;
  const z = p0.z + (p1.z - p0.z) * t - g.center.z;
  const a = x * g.right.x + y * g.right.y + z * g.right.z;
  const b = x * g.up.x + y * g.up.y + z * g.up.z;
  if (g.round) return a * a + b * b <= g.halfW * g.halfW;
  return Math.abs(a) <= g.halfW && Math.abs(b) <= g.halfH;
}

/**
 * Build the gates of a course out of kit parts. Frames and banners are solid; the light strip
 * around each opening is its own mesh so it can be animated.
 */
export function buildGates(ctx: WorldCtx, kit: Kit, defs: GateDef[], heightAt: (x: number, z: number) => number, accent = 0xff5a1f): { gates: GateRuntime[]; group: Group } {
  const group = new Group();
  const frame = kit.mat('gate-frame', 'metal', { color: 0x2a2d31, roughness: 0.55, metalness: 0.6, tile: 1 });
  const banner = kit.mat('gate-banner', 'fabric', { color: accent, roughness: 0.8, tile: 0.6 });
  const white = kit.mat('gate-white', 'fabric', { color: 0xe9e7e2, roughness: 0.8, tile: 0.6 });
  const dark = kit.mat('gate-dark', 'fabric', { color: 0x17181b, roughness: 0.85, tile: 0.6 });
  const gates: GateRuntime[] = [];

  defs.forEach((def, index) => {
    const psi = def.heading * DEG;
    const fwd = new Vector3(Math.sin(psi), 0, -Math.cos(psi));
    const right = new Vector3(Math.cos(psi), 0, Math.sin(psi));
    const ground = heightAt(def.x, def.z);
    const cy = def.agl === false ? def.y : ground + def.y;
    const C = new Vector3(def.x, cy, def.z);
    const size = def.size ?? (def.kind === 'arch' ? 5.6 : 2.7);
    const w2 = size / 2;
    const yaw = def.heading;
    // gate-local placement: lx along right, ly up, lz along the fly-through direction
    const at = (lx: number, ly: number, lz: number): [number, number, number] => [C.x + right.x * lx + fwd.x * lz, C.y + ly, C.z + right.z * lx + fwd.z * lz];
    const groundAt = (lx: number): number => heightAt(C.x + right.x * lx, C.z + right.z * lx);
    const glowParts: BufferGeometry[] = [];
    const glowBox = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number): void => {
      const g = new BoxGeometry(sx, sy, sz);
      g.rotateY(-psi);
      g.translate(...at(lx, ly, lz));
      glowParts.push(g);
    };

    let normal = fwd.clone();
    let up = new Vector3(0, 1, 0);
    let halfH = w2;
    let round = false;
    const tube = 0.09;

    if (def.kind === 'square') {
      const post = (lx: number): void => {
        const g = groundAt(lx);
        const top = cy + w2 + tube;
        const [x, , z] = at(lx, 0, 0);
        kit.box(frame, x, (g + top) / 2, z, tube, top - g, tube, { yaw });
        kit.box(frame, x, g + 0.03, z, 0.5, 0.06, 0.7, { yaw });
      };
      post(-(w2 + tube / 2));
      post(w2 + tube / 2);
      kit.box(frame, ...at(0, w2 + tube / 2, 0), size + 2 * tube, tube, tube, { yaw });
      if (cy - w2 - ground > 0.35) kit.box(frame, ...at(0, -(w2 + tube / 2), 0), size + 2 * tube, tube, tube, { yaw });
      // side wings and a header banner
      const wing = 0.62;
      kit.box(banner, ...at(-(w2 + tube + wing / 2), 0, 0), wing, size, 0.02, { yaw });
      kit.box(banner, ...at(w2 + tube + wing / 2, 0, 0), wing, size, 0.02, { yaw });
      kit.box(dark, ...at(0, w2 + tube + 0.26, 0), size + 2 * tube + 2 * wing, 0.52, 0.025, { yaw });
      kit.box(white, ...at(0, w2 + tube + 0.26, -0.016), size * 0.5, 0.2, 0.01, { yaw, collide: false });
      const s = 0.035;
      glowBox(-(w2 - s / 2), 0, -0.06, s, size, s);
      glowBox(w2 - s / 2, 0, -0.06, s, size, s);
      glowBox(0, w2 - s / 2, -0.06, size, s, s);
      glowBox(0, -(w2 - s / 2), -0.06, size, s, s);
    } else if (def.kind === 'arch') {
      halfH = 1.9;
      const pr = 0.42;
      const leg = (lx: number): void => {
        const g = groundAt(lx);
        const top = cy + halfH + pr;
        const [x, , z] = at(lx, 0, 0);
        kit.cyl(white, x, (g + top) / 2, z, pr, top - g, { segments: 16 });
      };
      leg(-(w2 + pr));
      leg(w2 + pr);
      kit.cyl(white, ...at(0, halfH + pr, 0), pr, size + 4 * pr, { axis: 'x', yaw, segments: 16 });
      // chequered start/finish header
      const n = 12;
      const cw = (size + 2 * pr) / n;
      for (let i = 0; i < n; i++) {
        for (let r = 0; r < 2; r++) {
          kit.box((i + r) % 2 ? dark : white, ...at(-w2 - pr + cw * (i + 0.5), halfH + pr * 2 + 0.2 + r * 0.36, 0), cw, 0.36, 0.04, { yaw, collide: false });
        }
      }
      kit.box(dark, ...at(0, halfH + pr * 2 + 0.38, 0), size + 2 * pr, 0.72, 0.03, { yaw });
      const s = 0.05;
      glowBox(-(w2 - s / 2), 0, -pr - 0.03, s, halfH * 2, s);
      glowBox(w2 - s / 2, 0, -pr - 0.03, s, halfH * 2, s);
      glowBox(0, halfH - s / 2, -pr - 0.03, size, s, s);
    } else {
      // hoop (upright) or dive (lying flat)
      round = true;
      const flat = def.kind === 'dive';
      const R = w2 + tube;
      const segs = 22;
      const q = new Quaternion();
      const e = new Euler();
      for (let i = 0; i < segs; i++) {
        const a = ((i + 0.5) / segs) * Math.PI * 2;
        const len = (2 * Math.PI * R) / segs + 0.02;
        const lx = Math.cos(a) * R;
        const lr = Math.sin(a) * R;
        if (flat) {
          // ring in the horizontal plane
          const [x, y, z] = at(lx, 0, lr);
          kit.cyl(frame, x, y, z, tube, len, { rot: [90, 180 - yaw + (a * 180) / Math.PI, 0], segments: 8 });
        } else {
          const [x, y, z] = at(lx, lr, 0);
          q.setFromEuler(e.set(0, -psi, 0)).multiply(new Quaternion().setFromEuler(new Euler(0, 0, a)));
          e.setFromQuaternion(q, 'YXZ');
          kit.cyl(frame, x, y, z, tube, len, { rot: [e.x / DEG, e.y / DEG, e.z / DEG], segments: 8 });
        }
      }
      if (flat) {
        normal = new Vector3(0, -1, 0);
        up = fwd.clone();
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 + 0.5;
          const lx = Math.cos(a) * (R + 0.12);
          const lz = Math.sin(a) * (R + 0.12);
          const [x, , z] = at(lx, 0, lz);
          const g = heightAt(x, z);
          kit.cyl(frame, x, (g + cy) / 2, z, 0.05, cy - g, { segments: 8 });
        }
      } else {
        const g = groundAt(0);
        const bottom = cy - R - tube;
        if (bottom - g > 0.1) {
          const [x, , z] = at(0, 0, 0);
          kit.cyl(frame, x, (g + bottom) / 2, z, 0.06, bottom - g, { segments: 8 });
          kit.box(frame, x, g + 0.03, z, 1.2, 0.06, 0.9, { yaw });
        }
        // a small flag so the direction reads from a distance
        kit.box(banner, ...at(0, R + tube + 0.3, 0), 1.3, 0.5, 0.02, { yaw });
      }
      const ring = new TorusGeometry(w2 - 0.02, 0.028, 6, 40);
      if (flat) ring.rotateX(Math.PI / 2);
      ring.rotateY(-psi);
      ring.translate(...at(0, flat ? 0.05 : 0, flat ? 0 : -0.07));
      glowParts.push(ring);
    }

    const glow = new MeshStandardMaterial({ color: 0x000000, emissive: IDLE.clone(), emissiveIntensity: 2.2, roughness: 0.6 });
    const mesh = new Mesh(mergeGeometries(glowParts.map((g) => (g.index ? g.toNonIndexed() : g))), glow);
    for (const g of glowParts) g.dispose();
    mesh.matrixAutoUpdate = false;
    group.add(mesh);

    // respawn a few metres before the gate, on the ground
    const rx = C.x - fwd.x * 7;
    const rz = C.z - fwd.z * 7;
    gates.push({
      def,
      index,
      center: C,
      normal,
      right,
      up,
      halfW: w2,
      halfH,
      round,
      glow,
      respawn: new Vector3(rx, heightAt(rx, rz), rz),
      heading: def.heading,
    });
  });

  ctx.root.add(group);
  return { gates, group };
}
