import { Vector3 } from 'three';
import { Noise2D, lerp, smoothstep } from '../core/math';
import { BIRCH, BUSH, SPRUCE, makeFlora, scatter } from '../world/flora';
import { Grass } from '../world/grass';
import { Kit } from '../world/kit';
import { bays, container, strut, wall } from '../world/structures';
import { Terrain, type TerrainSpec } from '../world/terrain';
import { distanceToTrack, type BuiltWorld, type MapDef, type TrackDef, type WorldCtx } from '../world/types';
import { Forest, WIND, addPlantColliders, type PlantInstance } from '../world/vegetation';

const YARD = { x0: -105, x1: 112, z0: -70, z1: 88 };

const IRONWORKS: TrackDef = {
  id: 'ironworks',
  name: 'Ironworks',
  blurb: 'Between the silos, down through the roof, out the far door and home under the pipes.',
  laps: 3,
  start: { x: -38, z: 62, heading: 0 },
  medals: [72, 92, 125],
  gates: [
    { kind: 'arch', x: -38, y: 2.4, z: 44, heading: 0 },
    { kind: 'hoop', x: -46, y: 6.5, z: 8, heading: 348, size: 3.0 },
    { kind: 'square', x: -62, y: 5, z: -30, heading: 338, size: 3.0 },
    { kind: 'dive', x: -15, y: 10.6, z: -30, heading: 90, size: 3.6 },
    { kind: 'square', x: 30.6, y: 3.6, z: -30, heading: 90, size: 3.2 },
    { kind: 'square', x: 80, y: 4.2, z: -38, heading: 112, size: 3.0 },
    { kind: 'hoop', x: 96, y: 8.5, z: 6, heading: 184, size: 3.0 },
    { kind: 'square', x: 62, y: 5.25, z: 27, heading: 236, size: 2.5 },
    { kind: 'square', x: 38, y: 5.5, z: 51, heading: 262 },
    { kind: 'square', x: 6.4, y: 1.45, z: 56, heading: 270, size: 2.1 },
    { kind: 'square', x: -12, y: 2.7, z: 58, heading: 272 },
  ],
};

function inYard(x: number, z: number, margin = 0): boolean {
  return x > YARD.x0 - margin && x < YARD.x1 + margin && z > YARD.z0 - margin && z < YARD.z1 + margin;
}

export const bando: MapDef = {
  id: 'bando',
  name: 'The Ironworks',
  tagline: 'Abandoned concrete works · hazy noon',
  description: 'A derelict plant gone quiet: a gutted hall, silos, a chimney and stacked containers. Every doorway is a gap.',
  sky: {
    azimuth: 158,
    elevation: 41,
    turbidity: 3.4,
    night: false,
    cloudCover: 0.5,
    cirrus: 0.25,
    groundAlbedo: [0.1, 0.1, 0.09],
    horizonGlow: [0, 0, 0],
    exposure: 0.42,
  },
  look: {
    exposure: 0.42,
    fogDensity: 0.00017,
    fogHeight: 380,
    fogBase: 0,
    bloom: 0.045,
    cloudShadow: 0.38,
    saturation: 0.94,
    contrast: 1.05,
    tint: [1.0, 0.99, 0.97],
  },
  async build(ctx: WorldCtx, progress): Promise<BuiltWorld> {
    const n = new Noise2D(31);
    const n2 = new Noise2D(57);
    await progress(0.05, 'Pouring concrete');

    // ---- ground: a levelled yard set in low wooded hills ---------------------------------------
    const yardBlend = (x: number, z: number): number => {
      const dx = Math.max(YARD.x0 - x, 0, x - YARD.x1);
      const dz = Math.max(YARD.z0 - z, 0, z - YARD.z1);
      return smoothstep(26, 0, Math.hypot(dx, dz));
    };
    const height = (x: number, z: number): number => {
      const r = Math.hypot(x, z);
      let h = 2 + n.fbm(x / 420, z / 420, 4) * 22 + n.fbm(x / 70, z / 70, 3) * 3.2;
      h += smoothstep(260, 2400, r) * (40 + 210 * n.ridged(x / 2600 + 3, z / 2600 + 1, 4, 2, 0.5));
      h = lerp(h, n.fbm(x / 9, z / 9, 2) * 0.05, yardBlend(x, z));
      return h;
    };
    const forestAt = (x: number, z: number): number => {
      if (inYard(x, z, 14)) return 0;
      return smoothstep(0.38, 0.55, n2.fbm(x / 240, z / 240, 3) * 0.5 + 0.5 + smoothstep(140, 320, Math.hypot(x, z)) * 0.2);
    };
    const classify = (x: number, z: number, _h: number, slope: number, out: Float32Array): void => {
      const yard = yardBlend(x, z);
      const weeds = smoothstep(0.64, 0.78, n2.fbm(x / 11, z / 11, 3) * 0.5 + 0.5) * 0.8;
      const worn = smoothstep(0.55, 0.7, n.fbm(x / 21 + 9, z / 21, 3) * 0.5 + 0.5);
      const rock = smoothstep(0.3, 0.5, slope);
      const f = forestAt(x, z);
      // inside the yard: asphalt, with gravel patches and weeds breaking through
      out[1] = yard * (1 - weeds * 0.75) * (1 - worn * 0.6);
      out[3] = yard * worn * 0.6 + (1 - yard) * f * 0.55;
      out[2] = (1 - yard) * rock;
      out[0] = Math.max(0, 1 - out[1] - out[2] - out[3]);
      out[5] = f;
    };
    const f = ctx.forge;
    const spec: TerrainSpec = {
      height,
      classify,
      innerHalf: 360,
      cell: 3,
      outerHalf: 6500,
      maxCell: 110,
      waterLevel: -200,
      layers: { grass: f.get('grass'), floor: f.get('asphalt'), rock: f.get('rock'), shore: f.get('dirt') },
      tile: [3.2, 5.5, 7.5, 3.4],
      grassTint: [1.0, 0.86, 0.62],
    };
    const terrain = new Terrain(spec, ctx.engine.sun.direction, ctx.engine.noise, ctx.engine.maxAnisotropy);
    terrain.addCollider(ctx.physics);
    terrain.clearGrass(0, 72, 5);
    terrain.clearGrass(-38, 62, 5);
    ctx.root.add(terrain.group);
    await progress(0.3, 'Raising the hall');

    // ---- materials ---------------------------------------------------------------------------------
    const kit = new Kit(ctx);
    const concrete = kit.mat('concrete', 'concrete', { tile: 3.2 });
    const concreteDark = kit.mat('concrete-dark', 'concrete', { tile: 3.2, color: 0xb8b2a6 });
    const brick = kit.mat('brick', 'brick', { tile: 2.2 });
    const steel = kit.mat('steel', 'rust', { tile: 1.6, metalness: 0.35 });
    const roof = kit.mat('roof', 'corrugated', { tile: 2.6, color: 0xb9b3a8 });
    const plaster = kit.mat('plaster', 'plaster', { tile: 3 });
    const pipe = kit.mat('pipe', 'rust', { tile: 2, color: 0xd9c9b0, metalness: 0.4 });
    const tank = kit.mat('tank', 'corrugated', { tile: 3, color: 0x8fa2a8 });
    const planks = kit.mat('planks', 'planks', { tile: 1.6 });
    const colours = [0xa4372a, 0x2f5d86, 0x3f7a55, 0xc9c4b8, 0xc28a2c, 0x5a2f6b];
    const box = colours.map((c, i) => kit.mat(`container-${i}`, 'corrugated', { tile: 2.5, color: c }));

    // ---- main hall: 60 × 24 m, open gables, a roller door, gaps in the roof --------------------
    {
      const x0 = -30;
      const x1 = 30;
      const zs = -18;
      const zn = -42;
      const eave = 9;
      const ridge = 12.2;
      const zc = (zs + zn) / 2;
      // brick plinth with a tall window band; the centre bay of the south wall is a doorway
      const south = bays(60, 10, 4.2, 4.2, 7.9).map((o, i) => (i === 4 || i === 5 ? null : o)).filter((o) => o !== null);
      south.push({ u0: 26, u1: 34, v0: 0, v1: 5.6 });
      wall(kit, brick, x0, zs, x1, zs, 0, eave, 0.4, south);
      // the north wall has lost two whole bays
      const north = bays(60, 10, 4.2, 4.2, 7.9, 0, [2, 7]);
      north.push({ u0: 12.4, u1: 17.6, v0: 0, v1: 8.2 }, { u0: 42.4, u1: 47.6, v0: 0, v1: 8.2 });
      wall(kit, brick, x0, zn, x1, zn, 0, eave, 0.4, north);
      // gables: a wide opening each end, brick above
      for (const x of [x0, x1]) wall(kit, brick, x, zs, x, zn, 0, eave, 0.4, [{ u0: 7, u1: 17, v0: 0, v1: 7.2 }]);
      const slope = Math.hypot(ridge - eave, 12);
      const pitch = (Math.atan2(ridge - eave, 12) * 180) / Math.PI;
      for (let i = 0; i <= 10; i++) {
        const x = x0 + i * 6;
        // portal frames
        kit.box(steel, x, eave / 2, zs + 0.45, 0.32, eave, 0.32);
        kit.box(steel, x, eave / 2, zn - 0.45, 0.32, eave, 0.32);
        kit.box(steel, x, (eave + ridge) / 2 - 0.1, zs - 6, 0.26, 0.34, slope, { rot: [pitch, 0, 0] });
        kit.box(steel, x, (eave + ridge) / 2 - 0.1, zn + 6, 0.26, 0.34, slope, { rot: [-pitch, 0, 0] });
        if (i % 2 === 0) kit.box(steel, x, eave - 0.3, zc, 0.16, 0.2, 23.2);
        if (i < 10) {
          const xm = x + 3;
          // roof sheets, with the odd bay rusted through
          const gone = [[2, 0], [6, 1], [7, 1], [3, 1]].some(([b, side]) => b === i && side === 0);
          const gone2 = [[2, 1], [6, 0], [8, 0]].some(([b]) => b === i);
          if (!gone) kit.box(roof, xm, (eave + ridge) / 2 + 0.14, zs - 6, 6, 0.07, slope + 0.5, { rot: [pitch, 0, 0] });
          if (!gone2) kit.box(roof, xm, (eave + ridge) / 2 + 0.14, zn + 6, 6, 0.07, slope + 0.5, { rot: [-pitch, 0, 0] });
        }
      }
      // gable infill above the eaves
      for (const x of [x0, x1]) {
        for (let k = 0; k < 6; k++) {
          const zz = zs - 1 - k * 2;
          const hgt = ((k + 0.5) / 6) * (ridge - eave);
          kit.box(roof, x, eave + hgt / 2, zz, 0.12, hgt, 2);
          kit.box(roof, x, eave + hgt / 2, zn + 1 + k * 2, 0.12, hgt, 2);
        }
      }
      // crane rails and a seized overhead crane
      kit.box(steel, 0, 6.6, zs - 0.9, 60, 0.5, 0.3);
      kit.box(steel, 0, 6.6, zn + 0.9, 60, 0.5, 0.3);
      kit.box(steel, 9, 7.25, zc, 1.1, 0.8, 22);
      kit.box(steel, 9, 5.9, zc + 3, 0.14, 2.0, 0.14);
      kit.box(steel, 9, 4.7, zc + 3, 0.7, 0.5, 0.5);
      // floor slab and what's left inside
      kit.box(concreteDark, 0, 0.04, zc, 60, 0.1, 24, { friction: 0.9 });
      for (const [mx, mz, sx, sy, sz] of [[-20, -24, 3.2, 1.3, 2.2], [-20, -36, 2.4, 1.8, 2.4], [20, -37, 4, 1.1, 2], [-6, -38, 2, 0.9, 5]]) {
        kit.box(concrete, mx, sy / 2, mz, sx, sy, sz);
      }
      for (let k = 0; k < 3; k++) kit.cyl(tank, 16 + k * 3.4, 2.1, -24, 1.4, 4.2, { segments: 18 });
      kit.cyl(pipe, 21, 4.5, -24, 0.18, 9, { axis: 'x' });
    }
    await progress(0.42, 'Stacking containers');

    // ---- three-storey frame: slabs and columns, no walls ----------------------------------------
    {
      const cx = 62;
      const cz = 22;
      const w = 20;
      const d = 14;
      const fh = 3.5;
      for (let fl = 1; fl <= 3; fl++) {
        const y = fl * fh;
        // each slab is cast as strips so one bay can be left out as a shaft
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 2; j++) {
            if (fl >= 2 && i === 1 && j === 0) continue;
            kit.box(concrete, cx - w / 2 + (i + 0.5) * (w / 4), y - 0.14, cz - d / 2 + (j + 0.5) * (d / 2), w / 4, 0.28, d / 2);
          }
        }
      }
      for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 2; j++) kit.box(concrete, cx - w / 2 + i * (w / 4), (3 * fh) / 2, cz - d / 2 + j * (d / 2), 0.45, 3 * fh, 0.45);
      }
      // stair core, parapet and a rooftop tank
      kit.box(plaster, cx + w / 2 - 1.6, (3 * fh + 2.4) / 2, cz - d / 2 + 2, 3.2, 3 * fh + 2.4, 4);
      wall(kit, concrete, cx - w / 2, cz - d / 2, cx + w / 2, cz - d / 2, 3 * fh, 0.9, 0.2);
      wall(kit, concrete, cx - w / 2, cz + d / 2, cx + w / 2, cz + d / 2, 3 * fh, 0.9, 0.2);
      wall(kit, concrete, cx - w / 2, cz - d / 2, cx - w / 2, cz + d / 2, 3 * fh, 0.9, 0.2);
      kit.cyl(tank, cx - 5, 3 * fh + 1.5, cz + 3, 1.5, 2.4, { segments: 16 });
      // a few surviving partitions on the middle floor
      wall(kit, plaster, cx - 4, cz - 2, cx + 3, cz - 2, fh, 2.6, 0.15, [{ u0: 2.5, u1: 4.2, v0: 0, v1: 2.1 }]);
      wall(kit, brick, cx - w / 2, cz + d / 2, cx - w / 2 + 9, cz + d / 2, 0, fh - 0.28, 0.3, [{ u0: 3, u1: 6, v0: 1, v1: 2.6 }]);
    }

    // ---- silos with a catwalk --------------------------------------------------------------------
    for (const sx of [-69, -55]) {
      kit.cyl(concrete, sx, 9, -30, 4.2, 18, { segments: 28 });
      kit.cyl(concreteDark, sx, 18.9, -30, 4.2, 1.8, { segments: 28, radiusTop: 1.2 });
      kit.cyl(steel, sx, 20.3, -30, 0.5, 1.0, { segments: 10 });
    }
    kit.cyl(concrete, -62, 7, -44, 3.4, 14, { segments: 24 });
    kit.box(steel, -62, 19.9, -30, 15.5, 0.12, 1.3);
    for (const s of [-0.6, 0.6]) {
      kit.box(steel, -62, 20.5, -30 + s, 15.5, 0.05, 0.05, { collide: false });
      for (let k = 0; k <= 6; k++) kit.box(steel, -69.6 + k * 2.55, 20.25, -30 + s, 0.05, 0.6, 0.05, { collide: false });
    }
    // conveyor gallery sloping from the ground to the silo tops
    strut(kit, steel, -40, 2, -52, -55, 19.5, -34, 1.5);
    kit.box(steel, -40, 1, -52, 0.4, 2, 0.4);
    kit.box(steel, -47.5, 5.4, -43, 0.35, 10.8, 0.35);

    // ---- chimney ---------------------------------------------------------------------------------
    kit.cyl(brick, -60, 23, 12, 2.3, 46, { segments: 24, radiusTop: 1.35 });
    kit.box(concrete, -60, 0.9, 12, 6.4, 1.8, 6.4);
    for (const yy of [12, 24, 36]) kit.cyl(steel, -60, yy, 12, 2.3 - (yy / 46) * 0.95 + 0.06, 0.25, { segments: 24, collide: false });

    // ---- container yard under a gantry ----------------------------------------------------------
    {
      const rows: [number, number, number, number, number, boolean?, boolean?][] = [
        // x, level, z, yaw, colour, long, open
        [14.5, 0, 56, 0, 0, true, true],
        [14.5, 1, 56, 0, 1, true],
        [14.5, 0, 59.2, 0, 3, true],
        [14.5, 0, 52.8, 0, 2, true],
        [30, 0, 62, 0, 4],
        [30, 1, 62, 0, 0],
        [30, 2, 62, 0, 2],
        [37, 0, 62, 0, 1],
        [37, 1, 62, 0, 3],
        [46, 0, 60, 14, 5, true],
        [52, 0, 44, 90, 0, true],
        [52, 1, 44, 90, 4, true],
        [55, 0, 44, 90, 2, true],
        [24, 0, 40, 90, 3],
        [24, 0, 33.5, 90, 1],
        [27, 0, 40, 90, 5],
        [27, 1, 40, 90, 0],
        [-2, 0, 78, 6, 2, true],
        [70, 0, 70, 30, 4],
      ];
      for (const [x, lvl, z, yaw, c, long, open] of rows) container(kit, box[c], x, 0.02 + lvl * 2.6, z, yaw, !!long, !!open);
      // gantry crane straddling the stacks
      for (const gx of [28, 48]) {
        strut(kit, steel, gx, 0, 44.5, gx, 11, 49, 0.45);
        strut(kit, steel, gx, 0, 57.5, gx, 11, 53, 0.45);
        kit.box(steel, gx, 0.2, 51, 0.6, 0.4, 14.5);
      }
      kit.box(steel, 38, 11.4, 51, 24, 0.9, 1.2);
      kit.box(steel, 34, 10.4, 51, 2.2, 1.2, 2.2);
      kit.box(steel, 34, 7.6, 51, 0.1, 4.6, 0.1, { collide: false });
    }

    // ---- pipe rack ---------------------------------------------------------------------------------
    for (let k = 0; k < 6; k++) {
      const z = 30 + k * 8;
      kit.box(steel, -14.2, 2.75, z, 0.22, 5.5, 0.22);
      kit.box(steel, -9.8, 2.75, z, 0.22, 5.5, 0.22);
      kit.box(steel, -12, 5.4, z, 5.2, 0.24, 0.24);
      kit.box(steel, -12, 6.6, z, 5.2, 0.2, 0.2);
      kit.box(steel, -14.2, 6, z, 0.2, 1.2, 0.2);
      kit.box(steel, -9.8, 6, z, 0.2, 1.2, 0.2);
    }
    kit.cyl(pipe, -13.2, 5.85, 50, 0.32, 44, { axis: 'z', segments: 12 });
    kit.cyl(pipe, -12.2, 5.75, 50, 0.2, 44, { axis: 'z', segments: 10 });
    kit.cyl(tank, -10.9, 5.8, 50, 0.26, 44, { axis: 'z', segments: 10 });
    kit.cyl(pipe, -12, 6.95, 50, 0.24, 44, { axis: 'z', segments: 10 });
    // the big line drops to a pair of horizontal tanks
    kit.cyl(pipe, -13.2, 2.9, 28.3, 0.32, 5.8, { segments: 12 });
    for (const tz of [18, 24]) {
      kit.cyl(tank, -16, 2.2, tz, 1.6, 8, { axis: 'x', segments: 18 });
      for (const tx of [-18.6, -13.4]) kit.box(concrete, tx, 0.5, tz, 0.5, 1.0, 2.6);
    }

    // ---- water tower -----------------------------------------------------------------------------
    {
      const tx = 84;
      const tz = -40;
      const legs: [number, number][] = [[-4.2, -4.2], [4.2, -4.2], [4.2, 4.2], [-4.2, 4.2]];
      for (let i = 0; i < 4; i++) {
        const [ax, az] = legs[i];
        const [bx, bz] = legs[(i + 1) % 4];
        strut(kit, steel, tx + ax, 0, tz + az, tx + ax * 0.62, 16.5, tz + az * 0.62, 0.34);
        for (const yy of [5.5, 11]) {
          const k = 1 - (yy / 16.5) * 0.38;
          strut(kit, steel, tx + ax * k, yy, tz + az * k, tx + bx * k, yy, tz + bz * k, 0.16);
        }
        strut(kit, steel, tx + ax * 0.87, 5.5, tz + az * 0.87, tx + bx * 0.75, 11, tz + bz * 0.75, 0.1, { collide: false });
      }
      kit.cyl(tank, tx, 19.2, tz, 3.6, 5.4, { segments: 24 });
      kit.cyl(tank, tx, 22.5, tz, 3.6, 1.3, { segments: 24, radiusTop: 0.5 });
      kit.cyl(pipe, tx, 8.2, tz, 0.28, 16.4, { segments: 10 });
    }

    // ---- odds and ends: gatehouse, barriers, lamp posts, a loading dock ---------------------
    wall(kit, brick, -96, 70, -88, 70, 0, 3.2, 0.3, [{ u0: 2.6, u1: 5.4, v0: 1, v1: 2.4 }]);
    wall(kit, brick, -96, 76, -88, 76, 0, 3.2, 0.3);
    wall(kit, brick, -96, 70, -96, 76, 0, 3.2, 0.3);
    wall(kit, brick, -88, 70, -88, 76, 0, 3.2, 0.3, [{ u0: 1.2, u1: 2.4, v0: 0, v1: 2.2 }]);
    kit.box(concrete, -92, 3.3, 73, 9, 0.2, 7);
    for (let k = 0; k < 14; k++) kit.box(concrete, -30 + k * 4.6, 0.42, 86, 3.8, 0.84, 0.5, { yaw: (k % 3) * 3 - 3 });
    for (const [lx, lz] of [[-80, 40], [-20, 4], [40, 2], [96, 40], [0, 84], [72, -64]]) {
      kit.cyl(steel, lx, 4.5, lz, 0.09, 9, { segments: 8 });
      kit.box(steel, lx + 0.7, 8.9, lz, 1.5, 0.08, 0.14, { collide: false });
    }
    kit.box(concrete, 86, 0.6, 62, 16, 1.2, 9);
    kit.box(planks, 86, 1.26, 62, 16, 0.08, 9, { collide: false });
    for (let k = 0; k < 5; k++) kit.box(planks, 74 + k * 1.4, 0.09, 52 + (k % 2) * 0.8, 1.2, 0.14, 1.0, { yaw: k * 17 });
    kit.build();
    // make the new colliders visible to ray queries used for planting
    ctx.physics.step();
    await progress(0.62, 'Letting the weeds in');

    // ---- plants ---------------------------------------------------------------------------------
    const flora = makeFlora(ctx);
    const plants: PlantInstance[] = [];
    const nrm = new Vector3();
    const tree = (x: number, z: number, rng: () => number): PlantInstance | null => {
      if (inYard(x, z, 9)) return null;
      const y = terrain.heightAt(x, z);
      if (terrain.normalAt(x, z, nrm).y < 0.82) return null;
      const pick = rng();
      const shade = 0.78 + rng() * 0.34;
      return { species: pick < 0.55 ? BIRCH : SPRUCE, x, y: y - 0.25, z, scale: 0.6 + rng() * rng() * 0.8, rot: rng() * 6.28, r: shade, g: shade, b: shade * 0.9 };
    };
    scatter(900, 7.2, 404, (x, z) => forestAt(x, z) * 0.9 + (inYard(x, z, 9) ? 0 : 0.02), tree, plants);
    scatter(380, 5.5, 505, (x, z) => (inYard(x, z, 2) ? 0.012 : 0.2), (x, z, rng) => {
      const y = terrain.heightAt(x, z);
      const s = 0.7 + rng() * 0.3;
      if (distanceToTrack(IRONWORKS, x, z) < 6 || Math.hypot(x, z - 72) < 6) return null;
      // don't grow through the buildings
      if (ctx.physics.raycast(x, y + 40, z, 0, -1, 0, 39.5) >= 0) return null;
      return { species: BUSH, x, y: y - 0.1, z, scale: 0.5 + rng() * 0.8, rot: rng() * 6.28, r: s, g: s, b: s * 0.82 };
    }, plants);
    const trees = plants.filter((p) => p.species !== BUSH);
    const forest = new Forest(flora, trees.filter((p) => Math.hypot(p.x, p.z) < 520), 90, 1e9);
    const farForest = new Forest(flora, trees.filter((p) => Math.hypot(p.x, p.z) >= 520), 420, -1e9);
    farForest.castShadow(false);
    const shrubs = new Forest(flora, plants.filter((p) => p.species === BUSH), 126, 1e9);
    ctx.root.add(forest.group, farForest.group, shrubs.group);
    addPlantColliders(ctx.physics, flora, plants, 360);

    const grass = new Grass({
      count: Math.round(60000 * ctx.engine.quality.grass),
      tile: 62,
      heightTexture: terrain.heightTexture,
      mask: terrain.grassMask,
      gridN: terrain.n,
      innerHalf: spec.innerHalf,
      cell: spec.cell,
      noise: ctx.engine.noise,
      base: [0.07, 0.1, 0.03],
      tip: [0.24, 0.26, 0.08],
      height: 0.36,
    });
    ctx.root.add(grass.mesh);
    await progress(0.9, 'Setting the course');

    const wind = { x: 1.4, z: -0.6, gust: 0.9 };
    WIND.uWind.value.set(wind.x, wind.z).normalize();
    WIND.uWindStrength.value = 0.6;

    return {
      spawn: { pos: new Vector3(0, terrain.heightAt(0, 72), 72), heading: 0 },
      tracks: [IRONWORKS],
      heightAt: (x, z) => terrain.heightAt(x, z),
      waterLevel: -200,
      boundsRadius: 340,
      ceiling: 300,
      wind,
      update(_dt, time, camera) {
        WIND.uTime.value = time;
        const lod = ctx.engine.quality.lod;
        forest.update(camera, lod);
        farForest.update(camera, lod);
        shrubs.update(camera, lod);
        grass.update(camera);
        grass.mesh.visible = camera.position.y - terrain.heightAt(camera.position.x, camera.position.z) < 60;
      },
      dispose() {
        terrain.dispose();
        kit.dispose();
        forest.dispose();
        farForest.dispose();
        shrubs.dispose();
        grass.dispose();
      },
    };
  },
};
