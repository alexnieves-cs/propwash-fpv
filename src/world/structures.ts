import type { Kit, PlaceOpts } from './kit';

export interface Opening {
  /** start and end along the wall, metres from its first corner */
  u0: number;
  u1: number;
  /** bottom and top above the wall's base */
  v0: number;
  v1: number;
}

/**
 * A straight wall from (x0, z0) to (x1, z1) with rectangular holes left in it — doors, windows,
 * missing bays. Built from solid boxes, so the holes are genuinely flyable.
 */
export function wall(kit: Kit, mat: string, x0: number, z0: number, x1: number, z1: number, y0: number, height: number, thickness: number, openings: Opening[] = []): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const yaw = (Math.atan2(dz, dx) * 180) / Math.PI;
  const place = (a: number, b: number, v0: number, v1: number): void => {
    if (b - a < 0.02 || v1 - v0 < 0.02) return;
    const c = (a + b) / 2;
    kit.box(mat, x0 + ux * c, y0 + (v0 + v1) / 2, z0 + uz * c, b - a, v1 - v0, thickness, { yaw });
  };
  const sorted = openings.slice().sort((a, b) => a.u0 - b.u0);
  let cursor = 0;
  for (const o of sorted) {
    place(cursor, o.u0, 0, height);
    place(o.u0, o.u1, 0, o.v0);
    place(o.u0, o.u1, o.v1, height);
    cursor = Math.max(cursor, o.u1);
  }
  place(cursor, len, 0, height);
}

/** Evenly spaced openings along a wall: `count` bays of `width`, starting `margin` in from each end. */
export function bays(length: number, count: number, width: number, v0: number, v1: number, margin = 0, skip: number[] = []): Opening[] {
  const out: Opening[] = [];
  const pitch = (length - 2 * margin) / count;
  for (let i = 0; i < count; i++) {
    if (skip.includes(i)) continue;
    const c = margin + pitch * (i + 0.5);
    out.push({ u0: c - width / 2, u1: c + width / 2, v0, v1 });
  }
  return out;
}

/** An ISO shipping container resting with its base at height y. `long` picks 40 ft over 20 ft. */
export function container(kit: Kit, mat: string, x: number, y: number, z: number, yaw: number, long = false, open = false): void {
  const L = long ? 12.19 : 6.06;
  const W = 2.44;
  const H = 2.59;
  if (!open) {
    kit.box(mat, x, y + H / 2, z, L, H, W, { yaw });
    return;
  }
  // a hollow one with both doors gone: four sides, flyable end to end
  const r = (yaw * Math.PI) / 180;
  const sx = -Math.sin(r);
  const sz = Math.cos(r);
  const t = 0.08;
  kit.box(mat, x, y + t / 2, z, L, t, W, { yaw });
  kit.box(mat, x, y + H - t / 2, z, L, t, W, { yaw });
  kit.box(mat, x + sx * (W / 2 - t / 2), y + H / 2, z + sz * (W / 2 - t / 2), L, H, t, { yaw });
  kit.box(mat, x - sx * (W / 2 - t / 2), y + H / 2, z - sz * (W / 2 - t / 2), L, H, t, { yaw });
}

/** A lattice mast or leg between two points, as one rotated box. */
export function strut(kit: Kit, mat: string, ax: number, ay: number, az: number, bx: number, by: number, bz: number, thick: number, o: PlaceOpts = {}): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  // box's long axis is local Y; yaw it towards the run, then lean it over
  const yawDeg = (Math.atan2(dx, dz) * 180) / Math.PI;
  const lean = (Math.acos(dy / len) * 180) / Math.PI;
  kit.box(mat, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, thick, len, thick, { ...o, rot: [lean, yawDeg, 0] });
}
