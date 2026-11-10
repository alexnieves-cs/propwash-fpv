import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RedFormat,
  Vector3,
  Vector4,
  type Texture,
} from 'three';
import { clamp, saturate } from '../core/math';
import type { TexSet } from '../render/textures';
import type { PhysicsWorld } from '../sim/physics-world';

export interface TerrainSpec {
  /** analytic ground height, metres */
  height(x: number, z: number): number;
  /**
   * Surface classification for a vertex. Write layer weights into `out`:
   * [0] grass, [1] forest floor, [2] rock, [3] shore, [4] snow, [5] forest density (for distant tint)
   */
  classify(x: number, z: number, h: number, slope: number, out: Float32Array): void;
  /** half-width of the full-detail, collidable square */
  innerHalf: number;
  /** vertex spacing inside it */
  cell: number;
  /** half-width of the whole terrain including the distant horizon ring */
  outerHalf: number;
  /** largest cell allowed out in the horizon ring */
  maxCell: number;
  waterLevel: number;
  layers: { grass: TexSet; floor: TexSet; rock: TexSet; shore: TexSet };
  /** physical tile size of each layer, metres */
  tile: [number, number, number, number];
  /** colour multiplier for the grass layer (dry summer grass vs lush alpine) */
  grassTint?: [number, number, number];
  /** roughness of each layer; a low value on the paved layer reads as wet */
  roughness?: [number, number, number, number];
}

const CHUNKS = 12;

/**
 * A single continuous height-mapped landscape: dense and collidable in the middle, stretching out
 * with growing cells to form the horizon. Shaded with four height-blended, anti-tiled PBR layers.
 */
export class Terrain {
  readonly group = new Group();
  readonly material: MeshStandardMaterial;
  /** heights of the inner grid, row-major by z */
  readonly heights: Float32Array;
  readonly n: number;
  readonly heightTexture: DataTexture;
  /** 0..255 per inner-grid vertex: how readily grass grows there */
  readonly grassMask: Uint8Array;
  private readonly coords: Float32Array;
  private readonly allHeights: Float32Array;
  private readonly N: number;

  constructor(readonly spec: TerrainSpec, sunDir: Vector3, noise: Texture, anisotropy: number) {
    const { innerHalf, cell, outerHalf } = spec;
    const n = Math.round((2 * innerHalf) / cell);
    this.n = n;

    // ---- vertex lattice: uniform inside, geometrically growing outside -------------------------
    const outer: number[] = [];
    let step = cell;
    let p = innerHalf;
    while (p < outerHalf) {
      step = Math.min(step * 1.07, spec.maxCell);
      p += step;
      outer.push(Math.min(p, outerHalf));
    }
    const ring = outer.length;
    const N = n + 1 + 2 * ring;
    this.N = N;
    const coords = new Float32Array(N);
    for (let i = 0; i < ring; i++) {
      coords[ring - 1 - i] = -outer[i];
      coords[ring + n + 1 + i] = outer[i];
    }
    for (let i = 0; i <= n; i++) coords[ring + i] = -innerHalf + i * cell;
    this.coords = coords;

    const H = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) H[j * N + i] = spec.height(coords[i], coords[j]);
    }
    this.allHeights = H;
    this.heights = new Float32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) this.heights[j * (n + 1) + i] = H[(j + ring) * N + (i + ring)];
    }

    // ---- normals ----------------------------------------------------------------------------------
    const NX = new Float32Array(N * N);
    const NY = new Float32Array(N * N);
    const NZ = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const j0 = Math.max(j - 1, 0);
      const j1 = Math.min(j + 1, N - 1);
      for (let i = 0; i < N; i++) {
        const i0 = Math.max(i - 1, 0);
        const i1 = Math.min(i + 1, N - 1);
        const dx = (H[j * N + i1] - H[j * N + i0]) / (coords[i1] - coords[i0]);
        const dz = (H[j1 * N + i] - H[j0 * N + i]) / (coords[j1] - coords[j0]);
        const l = 1 / Math.hypot(dx, 1, dz);
        NX[j * N + i] = -dx * l;
        NY[j * N + i] = l;
        NZ[j * N + i] = -dz * l;
      }
    }

    // ---- large-scale sun visibility, marched through a coarse copy of the height field ---------
    const G = 320;
    const coarse = new Float32Array(G * G);
    const gStep = (2 * outerHalf) / (G - 1);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) coarse[j * G + i] = spec.height(-outerHalf + i * gStep, -outerHalf + j * gStep);
    }
    const coarseAt = (x: number, z: number): number => {
      const fx = clamp((x + outerHalf) / gStep, 0, G - 1.001);
      const fz = clamp((z + outerHalf) / gStep, 0, G - 1.001);
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const tx = fx - ix;
      const tz = fz - iz;
      const a = coarse[iz * G + ix];
      const b = coarse[iz * G + ix + 1];
      const c = coarse[(iz + 1) * G + ix];
      const d = coarse[(iz + 1) * G + ix + 1];
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    };
    const sunVis = new Float32Array(N * N);
    const sx = sunDir.x;
    const sy = Math.max(sunDir.y, 0.02);
    const sz = sunDir.z;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = coords[i];
        const z = coords[j];
        const y = H[j * N + i];
        let vis = 1;
        let t = 40;
        for (let k = 0; k < 20 && vis > 0.02; k++) {
          const clearance = y + sy * t + 3 - coarseAt(x + sx * t, z + sz * t);
          vis = Math.min(vis, saturate(0.5 + (clearance / t) * 14));
          t *= 1.32;
        }
        sunVis[j * N + i] = vis;
      }
    }

    // ---- per-vertex surface classification -------------------------------------------------------
    const splat = new Uint8Array(N * N * 4);
    const extra = new Uint8Array(N * N * 4);
    const w = new Float32Array(6);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        w.fill(0);
        spec.classify(coords[i], coords[j], H[k], 1 - NY[k], w);
        const sum = w[0] + w[1] + w[2] + w[3] || 1;
        splat[k * 4] = Math.round((w[0] / sum) * 255);
        splat[k * 4 + 1] = Math.round((w[1] / sum) * 255);
        splat[k * 4 + 2] = Math.round((w[2] / sum) * 255);
        splat[k * 4 + 3] = Math.round((w[3] / sum) * 255);
        extra[k * 4] = Math.round(saturate(w[4]) * 255);
        extra[k * 4 + 1] = Math.round(sunVis[k] * 255);
        extra[k * 4 + 2] = Math.round(saturate(w[5]) * 255);
        extra[k * 4 + 3] = 255;
      }
    }

    this.grassMask = new Uint8Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const k = (j + ring) * N + (i + ring);
        const wet = H[k] < spec.waterLevel + 0.25 ? 0 : 1;
        this.grassMask[j * (n + 1) + i] = Math.round(splat[k * 4] * wet * (1 - 0.6 * (extra[k * 4 + 2] / 255)));
      }
    }

    // ---- material -----------------------------------------------------------------------------------
    this.material = this.makeMaterial(noise, anisotropy);

    // ---- chunked meshes, so the frustum and the shadow cascades can cull -----------------------
    const cells = N - 1;
    for (let cj = 0; cj < CHUNKS; cj++) {
      const j0 = Math.floor((cj * cells) / CHUNKS);
      const j1 = Math.floor(((cj + 1) * cells) / CHUNKS);
      for (let ci = 0; ci < CHUNKS; ci++) {
        const i0 = Math.floor((ci * cells) / CHUNKS);
        const i1 = Math.floor(((ci + 1) * cells) / CHUNKS);
        const cw = i1 - i0 + 1;
        const ch = j1 - j0 + 1;
        const pos = new Float32Array(cw * ch * 3);
        const nor = new Float32Array(cw * ch * 3);
        const spl = new Uint8Array(cw * ch * 4);
        const ext = new Uint8Array(cw * ch * 4);
        let v = 0;
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++, v++) {
            const k = j * N + i;
            pos[v * 3] = coords[i];
            pos[v * 3 + 1] = H[k];
            pos[v * 3 + 2] = coords[j];
            nor[v * 3] = NX[k];
            nor[v * 3 + 1] = NY[k];
            nor[v * 3 + 2] = NZ[k];
            spl.set(splat.subarray(k * 4, k * 4 + 4), v * 4);
            ext.set(extra.subarray(k * 4, k * 4 + 4), v * 4);
          }
        }
        const idx = new Uint32Array((cw - 1) * (ch - 1) * 6);
        let q = 0;
        for (let j = 0; j < ch - 1; j++) {
          for (let i = 0; i < cw - 1; i++) {
            const a = j * cw + i;
            const b = a + 1;
            const c = a + cw;
            const d = c + 1;
            idx[q++] = a;
            idx[q++] = c;
            idx[q++] = b;
            idx[q++] = b;
            idx[q++] = c;
            idx[q++] = d;
          }
        }
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(pos, 3));
        geo.setAttribute('normal', new BufferAttribute(nor, 3));
        geo.setAttribute('aSplat', new BufferAttribute(spl, 4, true));
        geo.setAttribute('aExtra', new BufferAttribute(ext, 4, true));
        geo.setIndex(new BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        const mesh = new Mesh(geo, this.material);
        mesh.receiveShadow = true;
        // only the playable region and its near surroundings need to cast into the cascades
        const cx = (coords[i0] + coords[i1]) / 2;
        const cz = (coords[j0] + coords[j1]) / 2;
        mesh.castShadow = Math.hypot(cx, cz) < innerHalf * 3.2;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
      }
    }

    this.heightTexture = new DataTexture(this.heights, n + 1, n + 1, RedFormat, FloatType);
    this.heightTexture.minFilter = NearestFilter;
    this.heightTexture.magFilter = NearestFilter;
    this.heightTexture.needsUpdate = true;
  }

  addCollider(physics: PhysicsWorld): void {
    const size = 2 * this.spec.innerHalf;
    physics.addHeightfield(this.n, this.n, this.heights, size, size, 0, 0, { friction: 0.95, restitution: 0.1 });
  }

  /** Stop grass growing within `radius` of a point (pads, buildings). Call before the grass is built. */
  clearGrass(x: number, z: number, radius: number): void {
    const { innerHalf, cell } = this.spec;
    const s = this.n + 1;
    const r = Math.ceil(radius / cell) + 1;
    const ci = Math.round((x + innerHalf) / cell);
    const cj = Math.round((z + innerHalf) / cell);
    for (let j = Math.max(0, cj - r); j <= Math.min(this.n, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(this.n, ci + r); i++) {
        const d = Math.hypot(-innerHalf + i * cell - x, -innerHalf + j * cell - z);
        if (d < radius + cell * 0.5) this.grassMask[j * s + i] = 0;
      }
    }
  }

  /** Ground height anywhere: bilinear on the mesh lattice inside, analytic beyond it. */
  heightAt(x: number, z: number): number {
    const { innerHalf, cell } = this.spec;
    if (Math.abs(x) >= innerHalf || Math.abs(z) >= innerHalf) return this.spec.height(x, z);
    const fx = (x + innerHalf) / cell;
    const fz = (z + innerHalf) / cell;
    const ix = Math.min(Math.floor(fx), this.n - 1);
    const iz = Math.min(Math.floor(fz), this.n - 1);
    const tx = fx - ix;
    const tz = fz - iz;
    const s = this.n + 1;
    const h = this.heights;
    const a = h[iz * s + ix];
    const b = h[iz * s + ix + 1];
    const c = h[(iz + 1) * s + ix];
    const d = h[(iz + 1) * s + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  normalAt(x: number, z: number, out: Vector3): Vector3 {
    const e = this.spec.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return out.set(-dx, 1, -dz).normalize();
  }

  private makeMaterial(noise: Texture, anisotropy: number): MeshStandardMaterial {
    const { layers, tile, waterLevel } = this.spec;
    const mat = new MeshStandardMaterial({ roughness: 1, metalness: 0 });
    for (const set of Object.values(layers)) {
      set.map.anisotropy = anisotropy;
      set.normalMap.anisotropy = Math.min(anisotropy, 4);
    }
    mat.defines = { ...(mat.defines ?? {}), PW_FAR_SHADOW: 1 };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        tL0: { value: layers.grass.map },
        tL0n: { value: layers.grass.normalMap },
        tL1: { value: layers.floor.map },
        tL1n: { value: layers.floor.normalMap },
        tL2: { value: layers.rock.map },
        tL2n: { value: layers.rock.normalMap },
        tL3: { value: layers.shore.map },
        tL3n: { value: layers.shore.normalMap },
        uNoise: { value: noise },
        uTile: { value: new Vector4(...tile) },
        uWater: { value: waterLevel },
        uGrassTint: { value: new Vector3(...(this.spec.grassTint ?? [1, 1, 1])) },
        uLayerRough: { value: new Vector4(...(this.spec.roughness ?? [0.9, 0.9, 0.8, 0.9])) },
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
attribute vec4 aSplat;
attribute vec4 aExtra;
varying vec4 vSplat;
varying vec4 vExtra;
varying vec3 pwWorldPos;
varying vec3 pwWorldNormal;
varying float vFarShadow;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
vSplat = aSplat;
vExtra = aExtra;
vFarShadow = aExtra.y;
pwWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
pwWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
uniform sampler2D tL0, tL0n, tL1, tL1n, tL2, tL2n, tL3, tL3n, uNoise;
uniform vec4 uTile;
uniform float uWater;
uniform vec3 uGrassTint;
uniform vec4 uLayerRough;
varying vec4 vSplat;
varying vec4 vExtra;
varying vec3 pwWorldPos;
varying vec3 pwWorldNormal;
varying float vFarShadow;
vec3 pwN;
float pwRough;`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
{
	vec3 wp = pwWorldPos;
	vec3 gN = normalize( pwWorldNormal );
	float dist = length( vViewPosition );
	float farK = smoothstep( 25.0, 170.0, dist );
	float macro = texture2D( uNoise, wp.xz / 310.0 ).r;
	float macro2 = texture2D( uNoise, wp.xz / 1700.0 + 0.31 ).g;

	vec2 uv0 = wp.xz / uTile.x;
	vec2 uv1 = wp.xz / uTile.y;
	vec2 uv3 = wp.xz / uTile.w;
	vec4 c0 = texture2D( tL0, uv0 );
	vec4 c1 = texture2D( tL1, uv1 );
	vec4 c3 = texture2D( tL3, uv3 );
	// a second, much larger tiling takes over with distance so the repeat never reads
	c0.rgb = mix( c0.rgb, texture2D( tL0, uv0 * 0.127 + 0.37 ).rgb, farK * 0.8 );
	c1.rgb = mix( c1.rgb, texture2D( tL1, uv1 * 0.131 + 0.11 ).rgb, farK * 0.8 );

	// rock is triplanar so cliffs don't smear
	vec3 bw = pow( abs( gN ), vec3( 5.0 ) );
	bw /= bw.x + bw.y + bw.z;
	float rs = 1.0 / uTile.z;
	vec4 c2 = texture2D( tL2, wp.zy * rs ) * bw.x + texture2D( tL2, wp.xz * rs ) * bw.y + texture2D( tL2, wp.xy * rs ) * bw.z;
	vec3 rockFar = texture2D( tL2, wp.xz * rs * 0.09 + 0.5 ).rgb * bw.y + texture2D( tL2, wp.zy * rs * 0.09 ).rgb * bw.x + texture2D( tL2, wp.xy * rs * 0.09 ).rgb * bw.z;
	c2.rgb = mix( c2.rgb, rockFar * 1.1, farK * 0.7 );

	// height-aware blend
	vec4 w = vSplat;
	vec4 wh = w + vec4( c0.a, c1.a, c2.a, c3.a ) * 0.55 * step( 0.004, w );
	float ma = max( max( wh.x, wh.y ), max( wh.z, wh.w ) ) - 0.22;
	vec4 b = max( wh - ma, 0.0 ) * step( 0.004, w );
	b /= b.x + b.y + b.z + b.w + 1e-5;

	vec3 grass = c0.rgb * uGrassTint * ( 0.74 + 0.52 * macro );
	grass = mix( grass, grass * vec3( 1.5, 1.22, 0.62 ), smoothstep( 0.48, 0.8, macro2 ) * 0.55 );
	vec3 floorC = c1.rgb * ( 0.8 + 0.4 * macro );
	vec3 rockC = c2.rgb * ( 0.82 + 0.36 * macro2 );
	vec3 col = grass * b.x + floorC * b.y + rockC * b.z + c3.rgb * b.w;

	pwRough = dot( b, uLayerRough );
	// puddled paving: the low spots of the surface texture are the glossy ones
	pwRough = mix( pwRough, min( pwRough + 0.35, 0.95 ), b.y * smoothstep( 0.35, 0.7, c1.a ) * step( uLayerRough.y, 0.6 ) );
	col *= mix( 1.0, 0.82 + 0.18 * c0.a, b.x * ( 1.0 - farK ) );

	// normals: planar layers perturb in XZ, rock uses UDN triplanar
	float nK = 1.0 - 0.55 * farK;
	vec2 tn = ( texture2D( tL0n, uv0 ).xy * 2.0 - 1.0 ) * b.x + ( texture2D( tL1n, uv1 ).xy * 2.0 - 1.0 ) * b.y + ( texture2D( tL3n, uv3 ).xy * 2.0 - 1.0 ) * b.w;
	vec3 nFlat = normalize( vec3( gN.x + tn.x * nK, gN.y, gN.z + tn.y * nK ) );
	vec3 nRock = nFlat;
	if ( b.z > 0.01 ) {
		vec3 tx = texture2D( tL2n, wp.zy * rs ).xyz * 2.0 - 1.0;
		vec3 ty = texture2D( tL2n, wp.xz * rs ).xyz * 2.0 - 1.0;
		vec3 tz = texture2D( tL2n, wp.xy * rs ).xyz * 2.0 - 1.0;
		tx = vec3( tx.xy * nK + gN.zy, gN.x );
		ty = vec3( ty.xy * nK + gN.xz, gN.y );
		tz = vec3( tz.xy * nK + gN.xy, gN.z );
		nRock = normalize( tx.zyx * bw.x + ty.xzy * bw.y + tz.xyz * bw.z );
	}
	pwN = normalize( mix( nFlat, nRock, b.z ) );

	// snow settles on the high, gentle slopes
	float snow = smoothstep( 0.4, 0.62, vExtra.x + ( macro - 0.5 ) * 0.35 + ( c2.a - 0.5 ) * 0.2 * ( 1.0 - farK ) ) * smoothstep( 0.62, 0.32, 1.0 - gN.y );
	col = mix( col, vec3( 0.78, 0.83, 0.9 ), snow );
	pwRough = mix( pwRough, 0.6, snow );
	pwN = normalize( mix( pwN, gN, snow * 0.7 ) );

	// forests too far away to draw as trees still darken the hillsides
	col = mix( col, vec3( 0.018, 0.032, 0.014 ) * ( 0.7 + 0.6 * macro ), vExtra.z * smoothstep( 900.0, 1700.0, dist ) * ( 1.0 - snow ) * 0.92 );

	// wet shoreline
	float wet = smoothstep( uWater + 0.45, uWater - 0.05, wp.y );
	col *= mix( 1.0, 0.5, wet );
	pwRough = mix( pwRough, 0.22, wet );

	diffuseColor.rgb = col;
}
`,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = pwRough;')
        .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( pwN, 0.0 ) ).xyz );');
    };
    mat.customProgramCacheKey = () => 'pw-terrain';
    return mat;
  }

  dispose(): void {
    for (const child of this.group.children) (child as Mesh).geometry.dispose();
    this.material.dispose();
    this.heightTexture.dispose();
  }
}
