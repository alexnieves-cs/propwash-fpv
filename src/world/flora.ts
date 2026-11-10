import { Color } from 'three';
import { makeRng } from '../core/math';
import type { WorldCtx } from './types';
import {
  bakeImpostor,
  buildBroadleaf,
  buildConifer,
  buildImpostorGeometry,
  makeFoliageMaterial,
  makeImpostorMaterial,
  type PlantInstance,
  type Species,
} from './vegetation';

export const SPRUCE = 0;
export const PINE = 1;
export const BIRCH = 2;
export const BUSH = 3;

/** The plant species shared by the outdoor maps, built once per map load. */
export function makeFlora(ctx: WorldCtx): Species[] {
  const a2c = ctx.engine.quality.msaa > 0;
  const needles = ctx.forge.get('needles').map;
  const leaves = ctx.forge.get('leaves').map;
  needles.anisotropy = 4;
  leaves.anisotropy = 4;
  const r = ctx.engine.renderer;
  const conifer = makeFoliageMaterial(needles, { alphaToCoverage: a2c, translucency: [1.15, 1.5, 0.5] });
  const broad = makeFoliageMaterial(leaves, { alphaToCoverage: a2c, translucency: [1.7, 1.6, 0.45] });
  const white = new Color(1, 1, 1);

  const spruceBase = { height: 21, trunkR: 0.3, crownStart: 0.15, crownR: 3.9, pitchLow: -0.42, pitchHigh: 0.52, taper: 0.9 };
  const spruce0 = buildConifer({ ...spruceBase, levels: 15, perLevel: 5, segments: 2, cross: true, widthK: 0.62, sides: 7, seed: 1 });
  const spruce1 = buildConifer({ ...spruceBase, levels: 8, perLevel: 4, segments: 1, cross: true, widthK: 0.95, sides: 5, seed: 1 });
  const spruceImp = bakeImpostor(r, spruce0, needles, 4.5, 21.6, white);

  const pineBase = { height: 26, trunkR: 0.36, crownStart: 0.5, crownR: 4.6, pitchLow: -0.1, pitchHigh: 0.7, taper: 0.55 };
  const pine0 = buildConifer({ ...pineBase, levels: 9, perLevel: 5, segments: 2, cross: true, widthK: 0.8, sides: 7, seed: 5 });
  const pine1 = buildConifer({ ...pineBase, levels: 5, perLevel: 4, segments: 1, cross: true, widthK: 1.1, sides: 5, seed: 5 });
  const pineImp = bakeImpostor(r, pine0, needles, 5.2, 26.6, white);

  const birchBase = { height: 15, trunkR: 0.16, crownStart: 0.34, crownR: 3.1, cardSize: 2.5 };
  const birch0 = buildBroadleaf({ ...birchBase, cards: 46, cross: true, sides: 6, seed: 9 });
  const birch1 = buildBroadleaf({ ...birchBase, cards: 18, cardSize: 3.6, cross: false, sides: 4, seed: 9 });
  const birchImp = bakeImpostor(r, birch0, leaves, 4.2, 16.5, white);

  const bush0 = buildBroadleaf({ height: 1.9, trunkR: 0, crownStart: 0, crownR: 1.15, cards: 10, cardSize: 1.5, cross: true, sides: 4, seed: 13 });
  const bush1 = buildBroadleaf({ height: 1.9, trunkR: 0, crownStart: 0, crownR: 1.15, cards: 5, cardSize: 2.0, cross: false, sides: 4, seed: 13 });

  return [
    {
      name: 'spruce',
      lod0: spruce0,
      lod1: spruce1,
      impostor: buildImpostorGeometry(4.5, 21.6),
      material: conifer,
      impostorMaterial: makeImpostorMaterial(spruceImp, a2c),
      cullDistance: 1e9,
      collider: { trunkR: 0.26, height: 20, crownY: 4.2, crownR: 2.6, crownH: 15.5 },
    },
    {
      name: 'pine',
      lod0: pine0,
      lod1: pine1,
      impostor: buildImpostorGeometry(5.2, 26.6),
      material: conifer,
      impostorMaterial: makeImpostorMaterial(pineImp, a2c),
      cullDistance: 1e9,
      collider: { trunkR: 0.32, height: 25, crownY: 14, crownR: 3.1, crownH: 11 },
    },
    {
      name: 'birch',
      lod0: birch0,
      lod1: birch1,
      impostor: buildImpostorGeometry(4.2, 16.5),
      material: broad,
      impostorMaterial: makeImpostorMaterial(birchImp, a2c),
      cullDistance: 1e9,
      collider: { trunkR: 0.15, height: 13, crownY: 5.5, crownR: 2.3, crownH: 9 },
    },
    {
      name: 'bush',
      lod0: bush0,
      lod1: bush1,
      impostor: null,
      material: broad,
      impostorMaterial: null,
      cullDistance: 260,
      collider: null,
    },
  ];
}

/**
 * Jittered-grid scatter: one candidate per grid square, kept with the probability returned by
 * `density`. Deterministic for a given seed.
 */
export function scatter(
  half: number,
  spacing: number,
  seed: number,
  density: (x: number, z: number) => number,
  make: (x: number, z: number, rng: () => number) => PlantInstance | null,
  out: PlantInstance[],
): void {
  const rng = makeRng(seed);
  const n = Math.floor((2 * half) / spacing);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i + rng()) * spacing;
      const z = -half + (j + rng()) * spacing;
      const keep = rng();
      if (keep >= density(x, z)) continue;
      const p = make(x, z, rng);
      if (p) out.push(p);
    }
  }
}
