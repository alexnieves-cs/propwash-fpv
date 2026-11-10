import { Color, DirectionalLight, ShaderChunk, Vector3, type Camera, type Scene } from 'three';

let patched = false;

/**
 * Teach every lit three.js material about our shadow cascades.
 *
 * The sun is N directional lights that all cast shadows over nested, camera-centred boxes. Only the
 * first carries colour; the fragment shader lights once and picks the finest cascade that contains
 * the fragment (blending into the next one near its edge). Because the choice is made from the
 * shadow coordinates themselves, no per-material uniforms or setup calls are needed.
 */
export function installCascadePatch(): void {
  if (patched) return;
  patched = true;

  const pars = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	float pwEdge( vec4 c ) {
		vec3 p = c.xyz / c.w;
		vec2 a = abs( p.xy - 0.5 ) * 2.0;
		return ( p.z < 0.0 || p.z > 1.0 ) ? 1.0 : max( a.x, a.y );
	}
	#define PW_SHADOW( i ) getShadow( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowIntensity, directionalLightShadows[ i ].shadowBias, directionalLightShadows[ i ].shadowRadius, vDirectionalShadowCoord[ i ] )
	#define PW_CASCADE( i ) if ( remain > 0.002 ) { float f = 1.0 - smoothstep( 0.82, 0.97, pwEdge( vDirectionalShadowCoord[ i ] ) ); if ( f > 0.0 ) { result += remain * f * PW_SHADOW( i ); remain *= 1.0 - f; } }
	float pwSunShadow() {
		float result = 0.0;
		float remain = 1.0;
		PW_CASCADE( 0 )
		#if NUM_DIR_LIGHT_SHADOWS > 1
		PW_CASCADE( 1 )
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 2
		PW_CASCADE( 2 )
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 3
		PW_CASCADE( 3 )
		#endif
		#ifdef PW_FAR_SHADOW
		// beyond the last cascade, fall back to large-scale shadowing baked into the mesh
		return result + remain * vFarShadow;
		#else
		return result + remain;
		#endif
	}
#endif
`;
  ShaderChunk.shadowmap_pars_fragment = ShaderChunk.shadowmap_pars_fragment + pars;

  const block = /#if \( NUM_DIR_LIGHTS > 0 \) && defined\( RE_Direct \)[\s\S]*?#pragma unroll_loop_end\s*#endif/;
  if (!block.test(ShaderChunk.lights_fragment_begin)) {
    throw new Error('three.js directional light chunk has changed; cascade patch needs updating');
  }
  ShaderChunk.lights_fragment_begin = ShaderChunk.lights_fragment_begin.replace(
    block,
    /* glsl */ `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	directionalLight = directionalLights[ 0 ];
	getDirectionalLightInfo( directionalLight, directLight );
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	directLight.color *= receiveShadow ? pwSunShadow() : 1.0;
	#endif
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,
  );
}

const _x = new Vector3();
const _y = new Vector3();
const _c = new Vector3();
const _f = new Vector3();
const UP = new Vector3(0, 1, 0);

export interface ShadowOptions {
  /** half-extent of each cascade box in metres, finest first */
  radii: number[];
  mapSize: number;
}

/** The sun (or moon): one visible directional light plus its shadow cascades. */
export class SunShadows {
  readonly lights: DirectionalLight[] = [];
  /** unit vector pointing from the ground towards the sun */
  readonly direction = new Vector3(0.4, 0.8, 0.3).normalize();
  private radii: number[] = [];
  private mapSize = 2048;
  private frame = 0;
  private readonly depthRange = 3200;

  constructor(private scene: Scene) {
    installCascadePatch();
  }

  configure(opts: ShadowOptions): void {
    for (const l of this.lights) {
      this.scene.remove(l, l.target);
      l.shadow.dispose();
      l.dispose();
    }
    const first = this.lights[0];
    const color = first ? first.color.clone() : new Color(1, 1, 1);
    const intensity = first ? first.intensity : 1;
    this.lights.length = 0;
    this.radii = opts.radii.slice();
    this.mapSize = opts.mapSize;
    // always keep one light so shading works with shadows off
    const count = Math.max(1, this.radii.length);
    for (let i = 0; i < count; i++) {
      const light = new DirectionalLight(color, i === 0 ? intensity : 0);
      const r = this.radii[i];
      if (r !== undefined) {
        light.castShadow = true;
        const s = light.shadow;
        s.mapSize.set(this.mapSize, this.mapSize);
        const cam = s.camera;
        cam.left = -r;
        cam.right = r;
        cam.top = r;
        cam.bottom = -r;
        cam.near = 1;
        cam.far = this.depthRange;
        cam.updateProjectionMatrix();
        const texel = (2 * r) / this.mapSize;
        s.bias = -(texel * 1.2 + 0.01) / this.depthRange;
        s.normalBias = texel * 1.6 + 0.004;
        s.radius = 1.6;
        s.autoUpdate = false;
        s.needsUpdate = true;
      }
      this.scene.add(light, light.target);
      this.lights.push(light);
    }
  }

  setSun(direction: Vector3, color: Color, intensity: number): void {
    this.direction.copy(direction).normalize();
    const main = this.lights[0];
    if (main) {
      main.color.copy(color);
      main.intensity = intensity;
    }
    this.frame = 0;
  }

  /** Re-centre the cascades around the camera. Far cascades refresh less often. */
  update(camera: Camera): void {
    const d = this.direction;
    _x.crossVectors(UP, d).normalize();
    _y.crossVectors(d, _x);
    camera.getWorldDirection(_f);
    _f.y = 0;
    if (_f.lengthSq() > 1e-4) _f.normalize();
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const r = this.radii[i];
      if (r === undefined) {
        light.position.copy(d).multiplyScalar(100);
        light.target.position.set(0, 0, 0);
        light.target.updateMatrixWorld();
        continue;
      }
      const interval = i < 2 ? 1 : i === 2 ? 2 : 4;
      if (this.frame % interval !== (i < 2 ? 0 : i - 1) % interval && this.frame > 4) continue;
      const texel = (2 * r) / this.mapSize;
      // bias the box towards where the pilot is looking
      _c.copy(camera.position).addScaledVector(_f, r * 0.45);
      const cx = Math.round(_c.dot(_x) / texel) * texel;
      const cy = Math.round(_c.dot(_y) / texel) * texel;
      const cz = _c.dot(d);
      _c.set(0, 0, 0).addScaledVector(_x, cx).addScaledVector(_y, cy).addScaledVector(d, cz);
      light.target.position.copy(_c);
      light.position.copy(_c).addScaledVector(d, this.depthRange * 0.5);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
      light.shadow.needsUpdate = true;
    }
    this.frame++;
  }

  /** Force every cascade to redraw next frame (after a teleport or a scene change). */
  invalidate(): void {
    this.frame = 0;
  }
}
