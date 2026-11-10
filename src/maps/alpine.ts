import { Vector3 } from 'three';
import { Noise2D, lerp, smoothstep } from '../core/math';
import { BIRCH, BUSH, PINE, SPRUCE, makeFlora, scatter } from '../world/flora';
import { Grass } from '../world/grass';
import { Terrain, type TerrainSpec } from '../world/terrain';
import type { BuiltWorld, MapDef, TrackDef, WorldCtx } from '../world/types';
import { Forest, WIND, addPlantColliders, type PlantInstance } from '../world/vegetation';
import { Water } from '../world/water';

const WATER = 0;
const LAKE = { x: 230, z: -260 };
const KNOLL = { x: -260, z: 120 };

const LAKESIDE: TrackDef = {
  id: 'lakeside',
  name: 'Lakeside Loop',
  blurb: 'A flowing kilometre out to the water and back through the meadow.',
  laps: 2,
  start: { x: 0, z: 30, heading: 0 },
  medals: [78, 98, 130],
  gates: [
    { kind: 'arch', x: 0, y: 2.4, z: -10, heading: 0 },
    { kind: 'square', x: 12, y: 2.6, z: -92, heading: 12 },
    { kind: 'square', x: 82, y: 3.2, z: -152, heading: 62 },
    { kind: 'square', x: 172, y: 3.0, z: -150, heading: 96 },
    { kind: 'hoop', x: 252, y: 4.6, z: -98, heading: 132, size: 3.0 },
    { kind: 'square', x: 302, y: 3.4, z: -18, heading: 166 },
    { kind: 'dive', x: 300, y: 7.5, z: 72, heading: 182, size: 3.4 },
    { kind: 'square', x: 250, y: 2.4, z: 152, heading: 236 },
    { kind: 'square', x: 150, y: 3.0, z: 182, heading: 270 },
    { kind: 'hoop', x: 50, y: 4.2, z: 152, heading: 300, size: 3.0 },
    { kind: 'square', x: -30, y: 2.8, z: 90, heading: 334 },
  ],
};

/** Distance from a point to the racing line, for keeping trees off it. */
function distanceToCourse(x: number, z: number): number {
  const g = LAKESIDE.gates;
  let best = Math.hypot(x - LAKESIDE.start.x, z - LAKESIDE.start.z);
  for (let i = 0; i < g.length; i++) {
    const a = g[i];
    const b = g[(i + 1) % g.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t));
  }
  return best;
}

/** Shape of the valley. Shared by the terrain mesh, the colliders and prop placement. */
export function makeAlpineLandscape() {
  const n = new Noise2D(7);
  const n2 = new Noise2D(19);

  const height = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    let h = 15 + n.fbm(x / 520, z / 520, 4) * 26;
    h += n.fbm(x / 110 + 5, z / 110 - 3, 4) * 5.5;
    h += n.fbm(x / 23, z / 23, 3) * 0.7;

    // lake basin
    const ld = Math.hypot((x - LAKE.x) * 0.82, z - LAKE.z);
    const basin = smoothstep(340, 70, ld);
    h = lerp(h, -8 + n.fbm(x / 70, z / 70, 3) * 1.5, basin);

    // a rocky knoll to play on
    const kd = Math.hypot(x - KNOLL.x, z - KNOLL.z);
    const knoll = smoothstep(170, 0, kd);
    h += Math.pow(knoll, 1.6) * 58 * (0.7 + 0.6 * n.ridged(x / 95, z / 95, 4));

    // level the launch meadow
    h = lerp(h, 13.4, smoothstep(55, 12, r) * 0.94);

    // mountains ring the valley, opening to the south-east
    const m = smoothstep(620, 4300, r);
    if (m > 0) {
      const open = smoothstep(0.5, 0.95, (x * 0.8 + z * 0.6) / (r + 1));
      const wx = x + n.fbm(x / 3100, z / 3100, 2) * 900;
      const wz = z + n.fbm(x / 3100 + 9, z / 3100 + 4, 2) * 900;
      const ridge = n.ridged(wx / 6400 + 1.3, wz / 6400 - 0.7, 4, 2.0, 0.45);
      const hills = n.fbm(x / 1500, z / 1500, 3) * 0.5 + 0.5;
      const massif = 150 + 360 * hills + 1650 * Math.pow(ridge, 1.2);
      // gullies and spurs, stronger the higher the mountain
      const gully = n.ridged(wx / 900 + 4.1, wz / 900 + 2.2, 3, 2.0, 0.5) - 0.4;
      h += Math.pow(m, 1.3) * (1 - 0.74 * open) * (massif + gully * massif * 0.16);
    }
    return h;
  };

  /** 0..1 likelihood of trees at a point (before slope/altitude limits). */
  const forest = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    let f = n2.fbm(x / 360, z / 360, 3) * 0.5 + 0.5;
    f += smoothstep(200, -500, x) * 0.22; // denser to the west
    f -= smoothstep(120, 40, r) * 0.6; // launch meadow stays open
    const ld = Math.hypot((x - LAKE.x) * 0.82, z - LAKE.z);
    f -= smoothstep(290, 200, ld);
    return smoothstep(0.5, 0.62, f);
  };

  const classify = (x: number, z: number, h: number, slope: number, out: Float32Array): void => {
    const jitter = n2.noise(x / 37, z / 37) * 0.07;
    const rock = smoothstep(0.26, 0.44, slope + jitter);
    const shore = smoothstep(1.5, 0.3, h + jitter * 6);
    const treeline = smoothstep(820, 640, h);
    const f = forest(x, z) * treeline * (1 - rock) * (1 - shore);
    out[2] = rock;
    out[3] = shore * (1 - rock);
    out[1] = f * 0.85;
    out[0] = Math.max(0, 1 - rock - out[3] - out[1]) * smoothstep(1180, 900, h);
    if (out[0] + out[1] + out[2] + out[3] < 0.01) out[2] = 1;
    out[4] = smoothstep(880, 1180, h + n2.noise(x / 300, z / 300) * 160);
    out[5] = f;
  };

  return { height, forest, classify };
}

export const alpine: MapDef = {
  id: 'alpine',
  name: 'Larkspur Valley',
  tagline: 'Alpine lake · golden afternoon',
  description: 'A glacial lake ringed by spruce forest and granite. Open meadows to learn on, tree lines to rip, and a long view down the valley.',
  sky: {
    azimuth: 242,
    elevation: 29,
    turbidity: 2.4,
    night: false,
    cloudCover: 0.38,
    cirrus: 0.3,
    groundAlbedo: [0.07, 0.09, 0.04],
    horizonGlow: [0, 0, 0],
    exposure: 0.5,
  },
  look: {
    exposure: 0.5,
    fogDensity: 0.000075,
    fogHeight: 520,
    fogBase: 0,
    bloom: 0.045,
    cloudShadow: 0.4,
    saturation: 1.06,
    contrast: 1.04,
    tint: [1.02, 1.0, 0.97],
  },
  async build(ctx: WorldCtx, progress): Promise<BuiltWorld> {
    const land = makeAlpineLandscape();
    await progress(0.05, 'Raising mountains');
    const f = ctx.forge;
    const spec: TerrainSpec = {
      height: land.height,
      classify: land.classify,
      innerHalf: 630,
      cell: 3,
      outerHalf: 8200,
      maxCell: 90,
      waterLevel: WATER,
      layers: { grass: f.get('grass'), floor: f.get('forestFloor'), rock: f.get('rock'), shore: f.get('dirt') },
      tile: [3.2, 3.6, 7.5, 3.4],
    };
    const terrain = new Terrain(spec, ctx.engine.sun.direction, ctx.engine.noise, ctx.engine.maxAnisotropy);
    terrain.addCollider(ctx.physics);
    terrain.clearGrass(0, 30, 5.5);
    ctx.root.add(terrain.group);
    await progress(0.4, 'Growing forest');

    // ---- plants ----------------------------------------------------------------------------------
    const flora = makeFlora(ctx);
    const plants: PlantInstance[] = [];
    const nrm = new Vector3();
    const tree = (x: number, z: number, rng: () => number, big: number): PlantInstance | null => {
      const y = terrain.heightAt(x, z);
      if (y < WATER + 0.9 || y > 780) return null;
      if (terrain.normalAt(x, z, nrm).y < 0.8) return null;
      if (distanceToCourse(x, z) < 8.5) return null;
      const lakeD = Math.hypot((x - LAKE.x) * 0.82, z - LAKE.z);
      const pick = rng();
      // birch near the water and in the open, pine on the drier high ground
      const species = lakeD < 420 && pick < 0.34 ? BIRCH : y > 60 && pick < 0.5 ? PINE : pick < 0.14 ? PINE : pick > 0.93 ? BIRCH : SPRUCE;
      const shade = 0.78 + rng() * 0.36;
      const warm = rng();
      return {
        species,
        x,
        y: y - 0.25,
        z,
        scale: (0.62 + rng() * rng() * 0.75) * big,
        rot: rng() * Math.PI * 2,
        r: shade * (0.92 + warm * 0.2),
        g: shade,
        b: shade * (0.86 + (1 - warm) * 0.14),
      };
    };
    const BOUNDS = 620;
    scatter(760, 6.6, 101, (x, z) => (Math.hypot(x, z) < 760 ? land.forest(x, z) * 0.92 + 0.012 : 0), (x, z, rng) => tree(x, z, rng, 1), plants);
    scatter(1900, 11.5, 202, (x, z) => { const r = Math.hypot(x, z); return r >= 760 && r < 1900 ? land.forest(x, z) * 0.9 : 0; }, (x, z, rng) => tree(x, z, rng, 1.3), plants);
    scatter(700, 5.2, 303, (x, z) => { const f = land.forest(x, z); return Math.hypot(x, z) < 700 ? (f > 0.05 && f < 0.75 ? 0.3 : 0.035) : 0; }, (x, z, rng) => {
      const y = terrain.heightAt(x, z);
      if (y < WATER + 0.3 || terrain.normalAt(x, z, nrm).y < 0.75 || distanceToCourse(x, z) < 5) return null;
      const s = 0.7 + rng() * 0.3;
      return { species: BUSH, x, y: y - 0.1, z, scale: 0.6 + rng() * 0.9, rot: rng() * 6.28, r: s * 1.05, g: s, b: s * 0.8 };
    }, plants);
    const near = plants.filter((p) => p.species !== BUSH && Math.hypot(p.x, p.z) < 760);
    const distant = plants.filter((p) => p.species !== BUSH && Math.hypot(p.x, p.z) >= 760);
    const bushes = plants.filter((p) => p.species === BUSH);
    const forest = new Forest(flora, near, 84, 1e9);
    const farForest = new Forest(flora, distant, 420, -1e9);
    farForest.castShadow(false);
    const shrubs = new Forest(flora, bushes, 126, 1e9);
    ctx.root.add(forest.group, farForest.group, shrubs.group);
    addPlantColliders(ctx.physics, flora, plants, BOUNDS + 40);
    await progress(0.7, 'Planting meadows');

    const q = ctx.engine.quality;
    const grass = new Grass({
      count: Math.round(72000 * q.grass),
      tile: 62,
      heightTexture: terrain.heightTexture,
      mask: terrain.grassMask,
      gridN: terrain.n,
      innerHalf: spec.innerHalf,
      cell: spec.cell,
      noise: ctx.engine.noise,
      base: [0.06, 0.105, 0.026],
      tip: [0.17, 0.26, 0.055],
      height: 0.34,
    });
    ctx.root.add(grass.mesh);

    const sun = ctx.engine.sun;
    const water = new Water({
      level: WATER,
      size: 1100,
      x: LAKE.x,
      z: LAKE.z,
      heightTexture: terrain.heightTexture,
      gridN: terrain.n,
      innerHalf: spec.innerHalf,
      cell: spec.cell,
      sky: ctx.engine.sky.skyTexture,
      noise: ctx.engine.noise,
      cloudOffset: ctx.engine.sky.cloudOffset,
      cloudCover: alpine.sky.cloudCover,
      sunDir: sun.direction,
      sunColor: new Vector3(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity),
      shallow: [0.1, 0.16, 0.12],
      deep: [0.008, 0.03, 0.035],
    });
    ctx.root.add(water.mesh);
    await progress(0.9, 'Setting the course');

    const wind = { x: 2.2, z: 0.8, gust: 1.2 };
    WIND.uWind.value.set(wind.x, wind.z).normalize();
    WIND.uWindStrength.value = 0.8;

    return {
      spawn: { pos: new Vector3(0, terrain.heightAt(0, 30), 30), heading: 0 },
      tracks: [LAKESIDE],
      heightAt: (x, z) => terrain.heightAt(x, z),
      waterLevel: WATER,
      boundsRadius: BOUNDS,
      ceiling: 450,
      wind,
      update(_dt, time, camera) {
        WIND.uTime.value = time;
        const lod = ctx.engine.quality.lod;
        forest.update(camera, lod);
        farForest.update(camera, lod);
        shrubs.update(camera, lod);
        grass.update(camera);
        grass.mesh.visible = camera.position.y - terrain.heightAt(camera.position.x, camera.position.z) < 60;
        water.update(time, camera);
      },
      dispose() {
        terrain.dispose();
        forest.dispose();
        farForest.dispose();
        shrubs.dispose();
        grass.dispose();
        water.dispose();
      },
    };
  },
};
