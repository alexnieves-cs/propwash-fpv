import {
  BufferAttribute,
  DataTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RedFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import { makeRng } from '../core/math';
import { WIND } from './vegetation';

export interface GrassOpts {
  /** number of tufts in the tile that follows the camera */
  count: number;
  /** side of that tile, metres */
  tile: number;
  heightTexture: Texture;
  /** 0..255 per terrain vertex: how much grass grows there */
  mask: Uint8Array;
  gridN: number;
  innerHalf: number;
  cell: number;
  noise: Texture;
  base: [number, number, number];
  tip: [number, number, number];
  height: number;
}

/**
 * Grass that exists only around the camera: a fixed set of tufts on a tile that wraps as you move,
 * planted on the terrain height texture in the vertex shader. Costs nothing to fly across.
 */
export class Grass {
  readonly mesh: Mesh;
  private uniforms: Record<string, { value: unknown }>;
  private maskTexture: DataTexture;

  constructor(o: GrassOpts) {
    // one tuft = three curved blades
    const pos: number[] = [];
    const tipK: number[] = [];
    const idx: number[] = [];
    const rng = makeRng(77);
    for (let bl = 0; bl < 4; bl++) {
      const a = (bl / 4) * Math.PI * 2 + rng() * 1.2;
      const lean = 0.2 + rng() * 0.3;
      const h = 0.6 + rng() * 0.65;
      const w = 0.011 + rng() * 0.007;
      const ox = Math.cos(a) * 0.045;
      const oz = Math.sin(a) * 0.045;
      const px = -Math.sin(a);
      const pz = Math.cos(a);
      const base = pos.length / 3;
      // base pair, mid pair, tip
      const stations = [0, 0.55, 1];
      for (let s = 0; s < stations.length; s++) {
        const t = stations[s];
        const cx = ox + Math.cos(a) * lean * t * t * h;
        const cz = oz + Math.sin(a) * lean * t * t * h;
        const ww = w * (1 - t * 0.7);
        if (s < stations.length - 1) {
          pos.push(cx - px * ww, t * h, cz - pz * ww, cx + px * ww, t * h, cz + pz * ww);
          tipK.push(t, t);
        } else {
          pos.push(cx, t * h, cz);
          tipK.push(t);
        }
      }
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
    }
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aTip', new BufferAttribute(new Float32Array(tipK), 1));
    geo.setIndex(idx);
    const seeds = new Float32Array(o.count * 4);
    for (let i = 0; i < o.count; i++) {
      seeds[i * 4] = rng();
      seeds[i * 4 + 1] = rng();
      seeds[i * 4 + 2] = rng() * Math.PI * 2;
      seeds[i * 4 + 3] = 0.55 + rng() * 0.9;
    }
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = o.count;

    this.maskTexture = new DataTexture(o.mask, o.gridN + 1, o.gridN + 1, RedFormat, UnsignedByteType);
    this.maskTexture.minFilter = NearestFilter;
    this.maskTexture.magFilter = NearestFilter;
    this.maskTexture.needsUpdate = true;

    this.uniforms = {
      uCam: { value: new Vector3() },
      uTile: { value: o.tile },
      tHeight: { value: o.heightTexture },
      tMask: { value: this.maskTexture },
      uNoise: { value: o.noise },
      uInnerHalf: { value: o.innerHalf },
      uCell: { value: o.cell },
      uGridN: { value: o.gridN },
      uBase: { value: new Vector3(...o.base) },
      uTipCol: { value: new Vector3(...o.tip) },
      uBladeH: { value: o.height },
      uGrassWind: { value: new Vector2() },
      ...WIND,
    };

    const mat = new MeshStandardMaterial({ roughness: 0.78, metalness: 0, side: DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
attribute vec4 aSeed;
attribute float aTip;
uniform vec3 uCam;
uniform float uTile;
uniform highp sampler2D tHeight;
uniform sampler2D tMask;
uniform sampler2D uNoise;
uniform float uInnerHalf;
uniform float uCell;
uniform int uGridN;
uniform float uBladeH;
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
varying float vTip;
varying float vVar;
varying float vMacro;
vec3 pwGrassN;
float pwH( ivec2 p ) { return texelFetch( tHeight, clamp( p, ivec2( 0 ), ivec2( uGridN ) ), 0 ).r; }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
vec2 pwBase = aSeed.xy * uTile;
vec2 pwRel = mod( pwBase - uCam.xz + uTile * 0.5, uTile ) - uTile * 0.5;
vec2 pwXZ = uCam.xz + pwRel;
vec2 pwG = ( pwXZ + uInnerHalf ) / uCell;
ivec2 pwI = ivec2( floor( pwG ) );
vec2 pwF = fract( pwG );
float h00 = pwH( pwI );
float h10 = pwH( pwI + ivec2( 1, 0 ) );
float h01 = pwH( pwI + ivec2( 0, 1 ) );
float h11 = pwH( pwI + ivec2( 1, 1 ) );
float pwGround = mix( mix( h00, h10, pwF.x ), mix( h01, h11, pwF.x ), pwF.y );
pwGrassN = normalize( vec3( ( h00 - h10 + h01 - h11 ) * 0.5, uCell, ( h00 - h01 + h10 - h11 ) * 0.5 ) );
vec3 objectNormal = pwGrassN;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
float pwMask = texelFetch( tMask, clamp( ivec2( floor( pwG + 0.5 ) ), ivec2( 0 ), ivec2( uGridN ) ), 0 ).r;
float pwPatch = texture2D( uNoise, pwXZ / 47.0 ).r;
float pwOut = step( uInnerHalf - 2.0, max( abs( pwXZ.x ), abs( pwXZ.y ) ) );
float pwGrow = pwMask * smoothstep( 0.22, 0.5, pwPatch + pwMask * 0.3 ) * ( 1.0 - pwOut );
float pwFade = 1.0 - smoothstep( 0.6, 0.98, length( pwRel ) / ( uTile * 0.5 ) );
float pwScale = aSeed.w * uBladeH * pwGrow * pwFade * ( 0.6 + 0.8 * texture2D( uNoise, pwXZ / 9.0 ).g );
float cs = cos( aSeed.z ), sn = sin( aSeed.z );
vec3 lp = position;
lp.xz = mat2( cs, -sn, sn, cs ) * lp.xz;
lp *= pwScale;
float pwSway = sin( uTime * 1.9 + pwXZ.x * 0.31 + pwXZ.y * 0.23 ) * 0.5 + sin( uTime * 4.3 + pwXZ.x * 1.3 ) * 0.2 + 0.45;
lp.xz += uWind * uWindStrength * pwSway * aTip * aTip * pwScale * 0.55;
vec3 transformed = vec3( pwXZ.x + lp.x, pwGround + lp.y - 0.02, pwXZ.y + lp.z );
vTip = aTip;
vVar = fract( aSeed.z * 3.7 );
vMacro = texture2D( uNoise, pwXZ / 310.0 ).r;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
uniform vec3 uBase;
uniform vec3 uTipCol;
varying float vTip;
varying float vVar;
varying float vMacro;`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
vec3 pwGc = mix( uBase, uTipCol, vTip * vTip ) * ( 0.74 + 0.52 * vMacro );
pwGc = mix( pwGc, pwGc * vec3( 1.45, 1.25, 0.62 ), step( 0.78, vVar ) * 0.45 );
diffuseColor.rgb = pwGc * ( 0.5 + 0.5 * vTip );`,
        );
    };
    mat.customProgramCacheKey = () => 'pw-grass';
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'grass';
  }

  update(camera: PerspectiveCamera): void {
    (this.uniforms.uCam.value as Vector3).copy(camera.position);
    // no point drawing grass from high up
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
    this.maskTexture.dispose();
  }
}
