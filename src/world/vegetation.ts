import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { lerp, makeRng, saturate } from '../core/math';
import type { PhysicsWorld } from '../sim/physics-world';

/** Shared, per-frame uniforms for everything that sways. */
export const WIND = {
  uTime: { value: 0 },
  uWind: { value: new Vector2(1, 0) },
  uWindStrength: { value: 1 },
};

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  par: number[] = [];
  idx: number[] = [];
  count = 0;

  /** par = (wind weight, phase, shade) */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, wind: number, phase: number, shade: number): number {
    this.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nor.push(nx / l, ny / l, nz / l);
    this.uv.push(u, v);
    this.par.push(wind, phase, shade);
    return this.count++;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, b, d, c);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aParam', new BufferAttribute(new Float32Array(this.par), 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function trunk(b: Builder, H: number, r0: number, sides: number, rings: number, crownStart: number, top = 0.97): void {
  const start = b.count;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const y = H * top * t;
    const rad = r0 * Math.pow(1 - t * 0.96, 0.85) + 0.012;
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      // bark lives in a thin strip along the bottom of the foliage texture; mirror around the trunk
      const vv = 0.008 + 0.058 * Math.abs((2 * s) / sides - 1);
      const shade = t > crownStart ? 0.5 : lerp(1, 0.6, saturate((t - crownStart + 0.15) / 0.15));
      b.v(cx * rad, y, cz * rad, cx, 0.15, cz, y / 2.4, vv, t * t, 0, shade);
    }
  }
  const w = sides + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = start + r * w + s;
      b.quad(a, a + 1, a + w, a + w + 1);
    }
  }
}

const _d = new Vector3();
const _s = new Vector3();
const _p = new Vector3();
const _q = new Vector3();

/** One textured bough: a strip running from `origin` along `dir`, `width` wide along `side`. */
function card(
  b: Builder,
  ox: number,
  oy: number,
  oz: number,
  dir: Vector3,
  side: Vector3,
  len: number,
  width: number,
  segments: number,
  droop: number,
  H: number,
  crownR: number,
  phase: number,
  shadeK: number,
): void {
  const first = b.count;
  _p.set(ox, oy, oz);
  _d.copy(dir);
  for (let j = 0; j <= segments; j++) {
    const u = j / segments;
    if (j > 0) {
      if (j > 1) _d.y -= droop;
      _d.normalize();
      _p.addScaledVector(_d, len / segments);
    }
    for (let k = 0; k < 2; k++) {
      const sgn = k === 0 ? -0.5 : 0.5;
      _q.copy(_p).addScaledVector(side, sgn * width);
      const rad = Math.hypot(_q.x, _q.z);
      const rx = rad > 0.05 ? _q.x / rad : dir.x;
      const rz = rad > 0.05 ? _q.z / rad : dir.z;
      const shade = lerp(0.36, 1, saturate(rad / (crownR * 0.85))) * shadeK;
      const wind = Math.pow(saturate(_q.y / H), 2) + u * 0.3;
      b.v(_q.x, _q.y, _q.z, rx * 0.8, 0.55, rz * 0.8, u, k === 0 ? 0.1 : 1, wind, phase, shade);
    }
  }
  for (let j = 0; j < segments; j++) {
    const a = first + j * 2;
    b.quad(a, a + 1, a + 2, a + 3);
  }
}

export interface ConiferOpts {
  height: number;
  trunkR: number;
  /** fraction of the height where the crown begins */
  crownStart: number;
  crownR: number;
  levels: number;
  perLevel: number;
  segments: number;
  cross: boolean;
  pitchLow: number;
  pitchHigh: number;
  widthK: number;
  /** <1 gives a fuller, rounder cone; >1 a thin spire */
  taper: number;
  sides: number;
  seed: number;
}

export function buildConifer(o: ConiferOpts): BufferGeometry {
  const rng = makeRng(o.seed);
  const b = new Builder();
  const H = o.height;
  trunk(b, H, o.trunkR, o.sides, o.sides > 5 ? 5 : 3, o.crownStart);
  const up = new Vector3(0, 1, 0);
  const dir = new Vector3();
  const side = new Vector3();
  const upv = new Vector3();
  for (let L = 0; L < o.levels; L++) {
    const t = (L + 0.6 * rng()) / o.levels;
    const y = H * (o.crownStart + (0.975 - o.crownStart) * Math.pow(t, 0.9));
    const radius = o.crownR * Math.pow(1 - t, o.taper) + 0.35;
    const pitch = lerp(o.pitchLow, o.pitchHigh, t);
    const spin = L * 2.1 + rng() * 6.28;
    for (let k = 0; k < o.perLevel; k++) {
      const ang = ((k + rng() * 0.7) / o.perLevel) * Math.PI * 2 + spin;
      const len = radius * (0.82 + 0.36 * rng());
      dir.set(Math.cos(ang) * Math.cos(pitch), Math.sin(pitch), Math.sin(ang) * Math.cos(pitch));
      side.set(-Math.sin(ang), 0, Math.cos(ang));
      upv.crossVectors(side, dir).normalize();
      const phase = rng() * 6.28;
      const shadeK = 0.78 + 0.22 * t;
      card(b, 0, y, 0, dir, side, len, len * o.widthK, o.segments, 0.38, H, o.crownR, phase, shadeK);
      if (o.cross) card(b, 0, y - 0.05, 0, dir, upv, len, len * o.widthK * 0.72, o.segments, 0.38, H, o.crownR, phase, shadeK * 0.92);
    }
  }
  // leader
  const tipLen = H * 0.13;
  card(b, 0, H * 0.87, 0, up, new Vector3(1, 0, 0), tipLen, tipLen * 0.55, 1, 0, H, o.crownR, 1, 1);
  card(b, 0, H * 0.87, 0, up, new Vector3(0, 0, 1), tipLen, tipLen * 0.55, 1, 0, H, o.crownR, 2, 1);
  return b.build();
}

export interface BroadleafOpts {
  height: number;
  trunkR: number;
  crownStart: number;
  crownR: number;
  cards: number;
  cardSize: number;
  cross: boolean;
  sides: number;
  seed: number;
}

export function buildBroadleaf(o: BroadleafOpts): BufferGeometry {
  const rng = makeRng(o.seed);
  const b = new Builder();
  const H = o.height;
  if (o.trunkR > 0) trunk(b, H, o.trunkR, o.sides, 4, o.crownStart, 0.82);
  const cy = H * (o.crownStart + (1 - o.crownStart) * 0.52);
  const ry = (H * (1 - o.crownStart)) / 2;
  const n = new Vector3();
  const t1 = new Vector3();
  const t2 = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < o.cards; i++) {
    // a point in the crown ellipsoid, biased towards the shell
    const u = rng() * 2 - 1;
    const th = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    n.set(s * Math.cos(th), u, s * Math.sin(th));
    const rad = 0.42 + 0.58 * Math.sqrt(rng());
    c.set(n.x * o.crownR * rad, cy + n.y * ry * rad, n.z * o.crownR * rad);
    // sprays grow outwards and up
    t2.set(n.x * 0.8, 0.75 + n.y * 0.4, n.z * 0.8).normalize();
    t1.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).cross(t2).normalize();
    const size = o.cardSize * (0.75 + 0.5 * rng());
    const phase = rng() * 6.28;
    const passes = o.cross ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      if (pass === 1) t1.cross(t2).normalize();
      const first = b.count;
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          _q.copy(c)
            .addScaledVector(t1, (k - 0.5) * size)
            .addScaledVector(t2, (j - 0.35) * size);
          const nx = _q.x / o.crownR;
          const ny = (_q.y - cy) / ry;
          const nz = _q.z / o.crownR;
          const depth = saturate(Math.hypot(nx, ny, nz));
          const shade = lerp(0.42, 1, depth * depth) * (0.8 + 0.2 * saturate(ny * 0.5 + 0.5));
          b.v(_q.x, _q.y, _q.z, nx, ny + 0.35, nz, k, lerp(0.1, 1, j), Math.pow(saturate(_q.y / H), 2) + 0.25, phase, shade);
        }
      }
      b.quad(first, first + 1, first + 2, first + 3);
    }
  }
  return b.build();
}

/** Two crossed quads standing on the origin, for trees too far away to draw properly. */
export function buildImpostorGeometry(halfW: number, height: number): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const tan: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (let q = 0; q < 2; q++) {
    const tx = q === 0 ? 1 : 0;
    const tz = q === 0 ? 0 : 1;
    const base = q * 4;
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 2; k++) {
        const s = (k - 0.5) * 2 * halfW;
        pos.push(tx * s, j * height, tz * s);
        uv.push(k, j);
        tan.push(tx, 0, tz);
        nor.push(0, 1, 0);
      }
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aTangent', new BufferAttribute(new Float32Array(tan), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Lit foliage: alpha-tested cards with soft normals, interior darkening, wind and back-lighting. */
export function makeFoliageMaterial(map: Texture, opts: { alphaToCoverage: boolean; translucency?: [number, number, number] }): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    map,
    alphaTest: 0.36,
    side: DoubleSide,
    roughness: 0.82,
    metalness: 0,
    alphaToCoverage: opts.alphaToCoverage,
  });
  const tr = opts.translucency ?? [1.5, 1.45, 0.55];
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WIND);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 aParam;
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
varying float vShade;
varying float vFol;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
vShade = aParam.z;
vFol = step( 0.09, uv.y );
#ifdef USE_INSTANCING
	vec3 pwInst = instanceMatrix[ 3 ].xyz;
#else
	vec3 pwInst = vec3( 0.0 );
#endif
float pwPh = dot( pwInst.xz, vec2( 0.071, 0.113 ) );
float pwGust = sin( uTime * 1.1 + pwPh ) * 0.6 + sin( uTime * 2.7 + pwPh * 1.9 ) * 0.25 + 0.35;
transformed.xz += uWind * pwGust * aParam.x * uWindStrength * 0.42;
transformed.y += sin( uTime * 3.4 + aParam.y + pwPh ) * 0.045 * aParam.x * vFol * uWindStrength;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying float vShade;
varying float vFol;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
diffuseColor.rgb *= vShade;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `#include <normal_fragment_begin>
// card normals are baked to point out of the crown; don't let the back face flip them
if ( vFol > 0.5 ) normal *= faceDirection;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
{
	// light leaking through the foliage when you look towards the sun
	vec3 pwL = directionalLights[ 0 ].direction;
	float pwBack = pow( saturate( dot( -geometryViewDir, pwL ) ), 3.0 ) * 0.55 + saturate( dot( -geometryNormal, pwL ) ) * 0.2;
	reflectedLight.directDiffuse += directLight.color * BRDF_Lambert( diffuseColor.rgb * vec3( ${tr[0].toFixed(2)}, ${tr[1].toFixed(2)}, ${tr[2].toFixed(2)} ) ) * pwBack * vFol;
}
#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'pw-foliage' + tr.join(',');
  return mat;
}

export function makeImpostorMaterial(map: Texture, alphaToCoverage: boolean): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ map, alphaTest: 0.3, side: DoubleSide, roughness: 0.9, metalness: 0, alphaToCoverage });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aTangent;\nvarying vec3 vTan;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
	vTan = normalize( normalMatrix * ( mat3( instanceMatrix ) * aTangent ) );
#else
	vTan = normalize( normalMatrix * aTangent );
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTan;')
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `#include <normal_fragment_begin>
{
	// fake a rounded crown: the normal swings from one edge of the card to the other
	vec3 pwT = normalize( vTan );
	vec3 pwU = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	vec3 pwF = normalize( cross( pwT, pwU ) );
	if ( dot( pwF, vViewPosition ) < 0.0 ) pwF = -pwF;
	float pwS = ( vMapUv.x - 0.5 ) * 1.8;
	normal = normalize( pwT * pwS + pwU * 0.5 + pwF * sqrt( max( 1.0 - pwS * pwS, 0.06 ) ) );
}`,
      );
  };
  mat.customProgramCacheKey = () => 'pw-impostor';
  return mat;
}

/** Render a tree side-on into a texture for use on impostor cards. */
export function bakeImpostor(renderer: WebGLRenderer, geometry: BufferGeometry, map: Texture, halfW: number, height: number, tint: Color): Texture {
  const rt = new WebGLRenderTarget(256, 512, {
    type: UnsignedByteType,
    format: RGBAFormat,
    colorSpace: SRGBColorSpace,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
  });
  const mat = new ShaderMaterial({
    uniforms: { map: { value: map }, uTint: { value: new Vector3(tint.r, tint.g, tint.b) } },
    vertexShader: /* glsl */ `
attribute vec3 aParam;
varying vec2 vUv;
varying float vShade;
void main() {
	vUv = uv;
	vShade = aParam.z;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D map;
uniform vec3 uTint;
varying vec2 vUv;
varying float vShade;
void main() {
	vec4 t = texture2D( map, vUv );
	if ( t.a < 0.3 ) discard;
	gl_FragColor = vec4( t.rgb * uTint * ( 0.3 + 0.7 * vShade ), 1.0 );
}`,
    side: DoubleSide,
  });
  const scene = new Scene();
  scene.add(new Mesh(geometry, mat));
  const cam = new OrthographicCamera(-halfW, halfW, height, 0, 0.1, 200);
  cam.position.set(0, 0, 100);
  cam.updateMatrixWorld();
  const prev = renderer.getRenderTarget();
  const prevColor = new Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(new Color(0.02, 0.035, 0.015), 0);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(prevColor, prevAlpha);
  mat.dispose();
  return rt.texture;
}

export interface Species {
  name: string;
  lod0: BufferGeometry;
  lod1: BufferGeometry | null;
  impostor: BufferGeometry | null;
  material: Material;
  impostorMaterial: Material | null;
  /** beyond this the plant is not drawn at all (small plants only) */
  cullDistance: number;
  /** solid parts, in the species' unscaled metres */
  collider: { trunkR: number; height: number; crownY: number; crownR: number; crownH: number } | null;
}

export interface PlantInstance {
  species: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  rot: number;
  /** multiplies the albedo for natural variation */
  r: number;
  g: number;
  b: number;
}

interface CellBatch {
  cx: number;
  cy: number;
  cz: number;
  half: number;
  lods: (InstancedMesh | null)[];
  cull: number;
}

const _m = new Matrix4();
const _quat = new Quaternion();
const _scale = new Vector3();
const _pos = new Vector3();
const _col = new Color();
const Y = new Vector3(0, 1, 0);

/**
 * All the plants in a map, bucketed into square cells. Each cell holds an instanced mesh per
 * species per level of detail, and switches between them by distance every frame.
 */
export class Forest {
  readonly group = new Group();
  private batches: CellBatch[] = [];
  lod0 = 62;
  lod1 = 250;

  constructor(species: Species[], plants: PlantInstance[], cellSize: number, detailRadius: number) {
    const buckets = new Map<string, PlantInstance[]>();
    for (const p of plants) {
      const key = `${p.species}|${Math.floor(p.x / cellSize)}|${Math.floor(p.z / cellSize)}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(p);
    }
    for (const [key, list] of buckets) {
      const [si, ix, iz] = key.split('|').map(Number);
      const sp = species[si];
      const cx = (ix + 0.5) * cellSize;
      const cz = (iz + 0.5) * cellSize;
      let cy = 0;
      for (const p of list) cy += p.y;
      cy /= list.length;
      // cells that can never be approached only need the cheapest representation
      const far = Math.hypot(cx, cz) - cellSize > detailRadius;
      const geos = [far && sp.impostor ? null : sp.lod0, far && sp.impostor ? null : sp.lod1, sp.impostor];
      const lods = geos.map((geo, level) => {
        if (!geo) return null;
        const mat = level === 2 ? sp.impostorMaterial! : sp.material;
        const mesh = new InstancedMesh(geo, mat, list.length);
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          _quat.setFromAxisAngle(Y, p.rot);
          _m.compose(_pos.set(p.x, p.y, p.z), _quat, _scale.setScalar(p.scale));
          mesh.setMatrixAt(i, _m);
          mesh.setColorAt(i, _col.setRGB(p.r, p.g, p.b));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.visible = false;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        return mesh;
      });
      this.batches.push({ cx, cy, cz, half: cellSize / 2, lods, cull: sp.cullDistance });
    }
  }

  update(camera: PerspectiveCamera, lodScale: number): void {
    const px = camera.position.x;
    const py = camera.position.y;
    const pz = camera.position.z;
    const d0 = this.lod0 * lodScale;
    const d1 = this.lod1 * lodScale;
    for (const c of this.batches) {
      const dx = Math.max(Math.abs(px - c.cx) - c.half, 0);
      const dz = Math.max(Math.abs(pz - c.cz) - c.half, 0);
      const dy = Math.max(Math.abs(py - c.cy) - 20, 0);
      const d = Math.hypot(dx, dy, dz);
      let level = d < d0 ? 0 : d < d1 ? 1 : 2;
      if (d > c.cull) level = -1;
      // fall back to whatever representation exists
      if (level >= 0 && !c.lods[level]) level = c.lods[2] ? 2 : c.lods[1] ? 1 : c.lods[0] ? 0 : -1;
      for (let i = 0; i < 3; i++) {
        const m = c.lods[i];
        if (m) m.visible = i === level;
      }
    }
  }

  castShadow(on: boolean): void {
    for (const c of this.batches) for (const m of c.lods) if (m) m.castShadow = on;
  }

  dispose(): void {
    for (const c of this.batches) for (const m of c.lods) m?.dispose();
  }
}

/** Solid trunks and crowns for the trees a pilot can actually reach. */
export function addPlantColliders(physics: PhysicsWorld, species: Species[], plants: PlantInstance[], maxRadius: number): void {
  for (const p of plants) {
    const c = species[p.species].collider;
    if (!c || Math.hypot(p.x, p.z) > maxRadius) continue;
    const s = p.scale;
    const hh = (c.height * s) / 2;
    physics.addCylinder(p.x, p.y + hh, p.z, hh, c.trunkR * s, undefined, { friction: 0.9, restitution: 0.15 });
    if (c.crownR > 0) {
      const ch = (c.crownH * s) / 2;
      physics.addCone(p.x, p.y + c.crownY * s + ch, p.z, ch, c.crownR * s, undefined, { friction: 1, restitution: 0.05 });
    }
  }
}
