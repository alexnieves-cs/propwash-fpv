import { Color, SpotLight, Vector3 } from 'three';
import { Noise2D, lerp, smoothstep } from '../core/math';
import { Grass } from '../world/grass';
import { Kit } from '../world/kit';
import { container, strut, wall } from '../world/structures';
import { Terrain, type TerrainSpec } from '../world/terrain';
import type { BuiltWorld, MapDef, TrackDef, WorldCtx } from '../world/types';
import { WIND } from '../world/vegetation';

const NIGHT_SHIFT: TrackDef = {
  id: 'nightshift',
  name: 'Night Shift',
  blurb: 'Lit gates across a wet apron: through both hangars and under the wing of a parked freighter.',
  laps: 3,
  start: { x: 12, z: 64, heading: 270 },
  medals: [70, 90, 122],
  gates: [
    { kind: 'arch', x: -8, y: 2.4, z: 64, heading: 270 },
    { kind: 'square', x: -60, y: 2.8, z: 50, heading: 288 },
    { kind: 'hoop', x: -106, y: 5, z: 18, heading: 338, size: 3.0 },
    { kind: 'square', x: -70, y: 3.6, z: -30, heading: 20, size: 3.2 },
    { kind: 'square', x: -70, y: 3.2, z: -59.6, heading: 0, size: 3.0 },
    { kind: 'hoop', x: -48, y: 7, z: -78, heading: 90, size: 3.0 },
    { kind: 'square', x: -25, y: 3.2, z: -59.6, heading: 180, size: 3.0 },
    { kind: 'square', x: -18, y: 3.4, z: -10, heading: 150 },
    { kind: 'square', x: 50, y: 1.95, z: 13, heading: 90, size: 2.3 },
    { kind: 'hoop', x: 96, y: 7, z: 22, heading: 122, size: 3.0 },
    { kind: 'dive', x: 106, y: 9, z: 56, heading: 232, size: 3.6 },
    { kind: 'square', x: 60, y: 3, z: 72, heading: 264 },
  ],
};

export const airfield: MapDef = {
  id: 'airfield',
  name: 'Apron Nine',
  tagline: 'Airfield after dark · floodlit',
  description: 'A rain-slick apron under sodium floods. Race the lit gates through two hangars and under a parked freighter.',
  sky: {
    azimuth: 214,
    elevation: 34,
    turbidity: 2.2,
    night: true,
    cloudCover: 0.22,
    cirrus: 0.3,
    groundAlbedo: [0.05, 0.05, 0.05],
    horizonGlow: [0.055, 0.03, 0.012],
    exposure: 1.15,
  },
  look: {
    exposure: 1.15,
    fogDensity: 0.00042,
    fogHeight: 220,
    fogBase: 0,
    bloom: 0.11,
    cloudShadow: 0,
    saturation: 1.08,
    contrast: 1.06,
    tint: [0.97, 0.99, 1.04],
  },
  async build(ctx: WorldCtx, progress): Promise<BuiltWorld> {
    const n = new Noise2D(88);
    await progress(0.05, 'Wetting the apron');

    const paved = (x: number, z: number): number => {
      const dx = Math.max(-170 - x, 0, x - 170);
      const dz = Math.max(-150 - z, 0, z - 104);
      return smoothstep(18, 0, Math.hypot(dx, dz));
    };
    const height = (x: number, z: number): number => {
      const r = Math.hypot(x, z);
      let h = n.fbm(x / 300, z / 300, 3) * 5 + smoothstep(420, 3000, r) * (30 + 160 * n.ridged(x / 3000, z / 3000 + 2, 4, 2, 0.5));
      h = lerp(h, n.fbm(x / 14, z / 14, 2) * 0.03, paved(x, z));
      return h;
    };
    const classify = (x: number, z: number, _h: number, _slope: number, out: Float32Array): void => {
      const p = paved(x, z);
      const seams = smoothstep(0.6, 0.72, n.fbm(x / 40 + 3, z / 40, 3) * 0.5 + 0.5) * 0.35;
      out[1] = p * (1 - seams);
      out[3] = p * seams;
      out[0] = 1 - p;
      out[2] = 0;
    };
    const f = ctx.forge;
    const spec: TerrainSpec = {
      height,
      classify,
      innerHalf: 330,
      cell: 3,
      outerHalf: 6000,
      maxCell: 120,
      waterLevel: -200,
      layers: { grass: f.get('grass'), floor: f.get('asphalt'), rock: f.get('rock'), shore: f.get('concrete') },
      tile: [3.2, 6, 7.5, 5],
      grassTint: [0.9, 0.95, 0.8],
      roughness: [0.9, 0.34, 0.8, 0.5],
    };
    const terrain = new Terrain(spec, ctx.engine.sun.direction, ctx.engine.noise, ctx.engine.maxAnisotropy);
    terrain.addCollider(ctx.physics);
    ctx.root.add(terrain.group);
    await progress(0.35, 'Rolling out the hangars');

    const kit = new Kit(ctx);
    const steel = kit.mat('steel', 'metal', { tile: 1.5, color: 0x5d6368, metalness: 0.7, roughness: 0.6 });
    const sheet = kit.mat('sheet', 'corrugated', { tile: 2.6, color: 0xaeb4b8 });
    const slab = kit.mat('slab', 'concrete', { tile: 4, roughness: 0.6 });
    const concrete = kit.mat('concrete', 'concrete', { tile: 3 });
    const skin = kit.mat('skin', 'metal', { tile: 3, color: 0xd9dcdf, roughness: 0.5, metalness: 0.2 });
    const dark = kit.mat('dark', 'metal', { tile: 2, color: 0x1c1f23, roughness: 0.6 });
    const rubber = kit.mat('rubber', null, { color: 0x0c0c0d, roughness: 0.9 });
    const livery = kit.mat('livery', 'metal', { tile: 3, color: 0xc7401f, roughness: 0.5 });
    const sodium = kit.mat('lamp-sodium', null, { color: 0x000000, emissive: 0xffa24a, emissiveIntensity: 46, castShadow: false });
    const cool = kit.mat('lamp-cool', null, { color: 0x000000, emissive: 0xcfe4ff, emissiveIntensity: 40, castShadow: false });
    const edgeWhite = kit.mat('edge-white', null, { color: 0x000000, emissive: 0xfff2d6, emissiveIntensity: 22, castShadow: false });
    const edgeBlue = kit.mat('edge-blue', null, { color: 0x000000, emissive: 0x2f6bff, emissiveIntensity: 26, castShadow: false });
    const beacon = kit.mat('beacon', null, { color: 0x000000, emissive: 0xff2a1c, emissiveIntensity: 30, castShadow: false });
    const glass = kit.mat('glass', null, { color: 0x05080a, emissive: 0x8fd0c8, emissiveIntensity: 2.6, roughness: 0.2 });
    const boxes = [0x8f3327, 0x2a557c, 0x3a6d4c, 0xb9b5aa].map((c, i) => kit.mat(`box-${i}`, 'corrugated', { tile: 2.5, color: c }));

    const lights: SpotLight[] = [];
    const spot = (x: number, y: number, z: number, tx: number, tz: number, colour: number, candela: number, angle = 0.62): void => {
      const l = new SpotLight(new Color(colour), candela, 0, angle, 0.7, 2);
      l.position.set(x, y, z);
      l.target.position.set(tx, 0, tz);
      l.castShadow = false;
      ctx.root.add(l, l.target);
      l.target.updateMatrixWorld();
      lights.push(l);
    };

    // ---- hangars: steel portals, sheet walls, open front and a door in the back -------------
    for (const [hx, lamp] of [[-70, 0xffe0b8], [-25, 0xdfeaff]] as const) {
      const w = 34;
      const d = 28;
      const zf = -31;
      const zb = zf - d;
      const eave = 9.5;
      const ridge = 12;
      kit.box(slab, hx, 0.04, (zf + zb) / 2, w, 0.1, d, { friction: 0.9 });
      wall(kit, sheet, hx - w / 2, zb, hx + w / 2, zb, 0, eave, 0.25, [{ u0: w / 2 - 4, u1: w / 2 + 4, v0: 0, v1: 6.4 }]);
      wall(kit, sheet, hx - w / 2, zf, hx - w / 2, zb, 0, eave, 0.25, [{ u0: 9, u1: 13, v0: 4.5, v1: 7.5 }]);
      wall(kit, sheet, hx + w / 2, zf, hx + w / 2, zb, 0, eave, 0.25, [{ u0: 15, u1: 19, v0: 4.5, v1: 7.5 }]);
      // header over the open front
      kit.box(sheet, hx, eave - 0.9, zf, w, 1.8, 0.25);
      const run = w / 2;
      const slope = Math.hypot(run, ridge - eave);
      const pitch = (Math.atan2(ridge - eave, run) * 180) / Math.PI;
      for (let k = 0; k <= 4; k++) {
        const z = zf - k * (d / 4);
        kit.box(steel, hx - w / 2 + 0.3, eave / 2, z, 0.3, eave, 0.3);
        kit.box(steel, hx + w / 2 - 0.3, eave / 2, z, 0.3, eave, 0.3);
        kit.box(steel, hx - run / 2, (eave + ridge) / 2 - 0.15, z, slope, 0.32, 0.24, { rot: [0, 0, pitch] });
        kit.box(steel, hx + run / 2, (eave + ridge) / 2 - 0.15, z, slope, 0.32, 0.24, { rot: [0, 0, -pitch] });
      }
      kit.box(sheet, hx - run / 2, (eave + ridge) / 2 + 0.1, (zf + zb) / 2, slope + 0.4, 0.07, d + 0.6, { rot: [0, 0, pitch] });
      kit.box(sheet, hx + run / 2, (eave + ridge) / 2 + 0.1, (zf + zb) / 2, slope + 0.4, 0.07, d + 0.6, { rot: [0, 0, -pitch] });
      // strip lights under the ridge
      for (const z of [zf - 6, zf - 14, zf - 22]) kit.box(lamp === 0xffe0b8 ? sodium : cool, hx, ridge - 1.0, z, 5, 0.08, 0.2, { collide: false });
      spot(hx, ridge - 1.1, (zf + zb) / 2, hx, (zf + zb) / 2, lamp, 1500, 1.05);
      // clutter: benches and a tool crib along the walls
      kit.box(dark, hx - w / 2 + 2.2, 0.55, zb + 6, 3, 1.1, 1.2);
      kit.box(boxes[1], hx + w / 2 - 2.4, 1.2, zb + 5, 2.4, 2.4, 6);
    }
    // a small tug parked between them
    kit.box(livery, -47.5, 0.8, -36, 2.2, 1.0, 3.6);
    kit.box(dark, -47.5, 1.6, -35.2, 1.6, 0.7, 1.4);

    // ---- control tower ----------------------------------------------------------------------------
    kit.cyl(concrete, 72, 9.5, -58, 2.7, 19, { segments: 20 });
    kit.cyl(concrete, 72, 19.6, -58, 4.6, 1.0, { segments: 8, radiusTop: 4.9 });
    kit.cyl(glass, 72, 21.5, -58, 4.5, 2.8, { segments: 8, radiusTop: 5.2 });
    kit.cyl(dark, 72, 23.1, -58, 5.4, 0.4, { segments: 8 });
    kit.cyl(steel, 72, 25.6, -58, 0.07, 4.6, { segments: 6 });
    kit.box(beacon, 72, 28, -58, 0.3, 0.3, 0.3, { collide: false });
    wall(kit, concrete, 62, -68, 82, -68, 0, 4.2, 0.3, [{ u0: 4, u1: 7, v0: 1, v1: 2.6 }, { u0: 12, u1: 16, v0: 1, v1: 2.6 }]);
    wall(kit, concrete, 62, -50, 68, -50, 0, 4.2, 0.3);
    wall(kit, concrete, 76, -50, 82, -50, 0, 4.2, 0.3);
    wall(kit, concrete, 62, -68, 62, -50, 0, 4.2, 0.3);
    wall(kit, concrete, 82, -68, 82, -50, 0, 4.2, 0.3);
    kit.box(concrete, 72, 4.3, -59, 20.4, 0.25, 18.4);

    // ---- a parked freighter to fly under and around -------------------------------------------
    {
      const px = 45;
      const pz = 25;
      const py = 4.3;
      kit.cyl(skin, px, py, pz, 1.95, 30, { axis: 'x', segments: 22 });
      kit.cyl(skin, px - 17.5, py, pz, 1.95, 5, { axis: 'x', segments: 22, radiusTop: 0.45 });
      kit.cyl(skin, px + 18.5, py + 0.35, pz, 1.95, 7, { rot: [0, 180, 96], segments: 22, radiusTop: 0.4 });
      kit.box(livery, px - 2, py + 0.1, pz, 30, 0.5, 3.94, { collide: false });
      kit.box(glass, px - 15.6, py + 0.75, pz, 1.2, 0.55, 3.3, { collide: false });
      for (const s of [-1, 1]) {
        kit.box(skin, px + 3.8, py - 0.8, pz + s * 8.75, 4.8, 0.42, 15.4, { yaw: -s * 22 });
        kit.cyl(dark, px + 2.2, py - 2.2, pz + s * 7.5, 0.95, 3.8, { axis: 'x', segments: 16 });
        kit.box(skin, px + 2.6, py - 1.45, pz + s * 7.5, 2.4, 0.9, 0.3);
        kit.box(skin, px + 21, py + 1.0, pz + s * 4.2, 2.6, 0.22, 7.4, { yaw: -s * 24 });
        // main gear
        kit.cyl(steel, px + 2.5, 1.2, pz + s * 2.6, 0.16, 2.4, { segments: 8 });
        kit.cyl(rubber, px + 2.5, 0.55, pz + s * 2.6, 0.55, 0.9, { axis: 'z', segments: 14 });
      }
      kit.box(skin, px + 20.5, py + 4.6, pz, 4.6, 6.2, 0.32, { rot: [0, 0, -24] });
      kit.box(livery, px + 21.6, py + 6.4, pz, 2.6, 2.4, 0.34, { rot: [0, 0, -24], collide: false });
      kit.cyl(steel, px - 13, 1.2, pz, 0.14, 2.4, { segments: 8 });
      kit.cyl(rubber, px - 13, 0.45, pz, 0.45, 0.6, { axis: 'z', segments: 12 });
      kit.box(beacon, px + 2, py + 2.05, pz, 0.25, 0.2, 0.25, { collide: false });
      // air stairs and a fuel bowser
      strut(kit, steel, px - 10, 0, pz - 7.5, px - 10, 3.2, pz - 2.4, 1.1);
      kit.box(steel, px - 10, 3.3, pz - 2.6, 1.3, 0.12, 1.6);
      kit.cyl(skin, px + 12, 1.9, pz - 12, 1.25, 6.4, { axis: 'x', segments: 16 });
      kit.box(dark, px + 12, 0.75, pz - 12, 7.4, 0.5, 2.2);
      kit.box(livery, px + 7.4, 1.5, pz - 12, 2.0, 2.0, 2.3);
    }

    // ---- flood masts ----------------------------------------------------------------------------
    const masts: [number, number, number, number, number][] = [
      // x, z, aim x, aim z, colour
      [-128, 34, -84, 26, 0xffa850],
      [-40, 96, -24, 58, 0xffa850],
      [62, 98, 46, 52, 0xffb060],
      [136, 30, 96, 26, 0xffa850],
      [118, -30, 70, -22, 0xd6e6ff],
      [-110, -8, -72, -12, 0xd6e6ff],
      [0, -18, 4, 10, 0xffb060],
    ];
    for (const [mx, mz, ax, az, colour] of masts) {
      kit.cyl(steel, mx, 11, mz, 0.22, 22, { segments: 10, radiusTop: 0.12 });
      kit.box(steel, mx, 22.1, mz, 2.6, 0.2, 0.5, { yaw: (Math.atan2(az - mz, ax - mx) * 180) / Math.PI + 90, collide: false });
      const d = Math.hypot(ax - mx, az - mz) || 1;
      const hx = mx + ((ax - mx) / d) * 0.35;
      const hz = mz + ((az - mz) / d) * 0.35;
      kit.box(colour === 0xd6e6ff ? cool : sodium, hx, 21.85, hz, 2.2, 0.35, 0.12, { yaw: (Math.atan2(az - mz, ax - mx) * 180) / Math.PI + 90, collide: false });
      kit.box(beacon, mx, 22.5, mz, 0.18, 0.18, 0.18, { collide: false });
      spot(mx, 21.6, mz, ax, az, colour, 30000, 0.78);
    }

    // ---- taxiway and runway edge lights ------------------------------------------------------
    for (let x = -165; x <= 165; x += 15) {
      kit.box(edgeWhite, x, 0.16, -132, 0.22, 0.22, 0.22, { collide: false });
      kit.box(edgeWhite, x, 0.16, -104, 0.22, 0.22, 0.22, { collide: false });
    }
    for (let x = -150; x <= 150; x += 12) kit.box(edgeBlue, x, 0.14, 98, 0.18, 0.18, 0.18, { collide: false });
    for (let z = -84; z <= 86; z += 12) {
      kit.box(edgeBlue, -160, 0.14, z, 0.18, 0.18, 0.18, { collide: false });
      kit.box(edgeBlue, 160, 0.14, z, 0.18, 0.18, 0.18, { collide: false });
    }

    // ---- freight and barriers ---------------------------------------------------------------------
    const freight: [number, number, number, number, number, boolean?, boolean?][] = [
      [-92, 0, 62, 20, 0, true],
      [-92, 1, 62, 20, 2, true],
      [-78, 0, 70, -8, 1],
      [-110, 0, 52, 70, 3, true, true],
      [-120, 0, 70, 15, 0],
      [128, 0, 70, 80, 1, true],
      [128, 1, 70, 80, 3, true],
      [124, 0, 84, 10, 2],
      [20, 0, 92, 0, 3, true],
    ];
    for (const [x, lvl, z, yaw, c, long, open] of freight) container(kit, boxes[c], x, 0.02 + lvl * 2.6, z, yaw, !!long, !!open);
    for (let k = 0; k < 9; k++) kit.box(concrete, -30 + k * 4.4, 0.42, 30 + Math.sin(k * 1.3) * 1.2, 3.6, 0.84, 0.5, { yaw: 90 + (k % 2 ? 18 : -18) });
    kit.build();
    await progress(0.8, 'Switching on the floods');

    const grass = new Grass({
      count: Math.round(36000 * ctx.engine.quality.grass),
      tile: 62,
      heightTexture: terrain.heightTexture,
      mask: terrain.grassMask,
      gridN: terrain.n,
      innerHalf: spec.innerHalf,
      cell: spec.cell,
      noise: ctx.engine.noise,
      base: [0.05, 0.08, 0.03],
      tip: [0.16, 0.22, 0.07],
      height: 0.3,
    });
    ctx.root.add(grass.mesh);
    await progress(0.9, 'Setting the course');

    const wind = { x: 0.8, z: 0.5, gust: 0.5 };
    WIND.uWind.value.set(wind.x, wind.z).normalize();
    WIND.uWindStrength.value = 0.4;

    return {
      spawn: { pos: new Vector3(12, terrain.heightAt(12, 64), 64), heading: 270 },
      tracks: [NIGHT_SHIFT],
      heightAt: (x, z) => terrain.heightAt(x, z),
      waterLevel: -200,
      boundsRadius: 310,
      ceiling: 260,
      wind,
      update(_dt, time, camera) {
        WIND.uTime.value = time;
        grass.update(camera);
        grass.mesh.visible = camera.position.y - terrain.heightAt(camera.position.x, camera.position.z) < 50;
      },
      dispose() {
        terrain.dispose();
        kit.dispose();
        grass.dispose();
        for (const l of lights) l.dispose();
      },
    };
  },
};
