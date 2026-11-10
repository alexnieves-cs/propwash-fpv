import {
  AdditiveBlending,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { CLOUD_ALTITUDE, CLOUD_GLSL, EQUIRECT_GLSL, NOISE_GLSL, fullscreenTriangle } from './atmosphere';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform vec2 uTexel;
uniform float uProjScale;
uniform float uRadius;
varying vec2 vUv;
const int SAMPLES = 10;
vec3 viewPos( vec2 uv ) {
	float d = texture2D( tDepth, uv ).x;
	vec4 v = uProjInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
	return v.xyz / v.w;
}
void main() {
	float depth = texture2D( tDepth, vUv ).x;
	if ( depth >= 0.99999 ) { gl_FragColor = vec4( 1.0, 1.0, 0.0, 1.0 ); return; }
	vec3 P = viewPos( vUv );
	float dist = -P.z;
	if ( dist > 260.0 ) { gl_FragColor = vec4( 1.0, 1.0, 0.0, 1.0 ); return; }
	// normal from the smaller of each pair of depth differences, so silhouettes stay clean
	vec3 r = viewPos( vUv + vec2( uTexel.x, 0.0 ) ) - P;
	vec3 l = P - viewPos( vUv - vec2( uTexel.x, 0.0 ) );
	vec3 u = viewPos( vUv + vec2( 0.0, uTexel.y ) ) - P;
	vec3 d = P - viewPos( vUv - vec2( 0.0, uTexel.y ) );
	vec3 dx = abs( r.z ) < abs( l.z ) ? r : l;
	vec3 dy = abs( u.z ) < abs( d.z ) ? u : d;
	vec3 N = normalize( cross( dx, dy ) );
	float radius = uRadius * ( 1.0 + dist * 0.035 );
	float rScreen = clamp( radius * uProjScale / dist, uTexel.y * 3.0, 0.12 );
	float phi = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
	float aspect = uTexel.x / uTexel.y;
	float ao = 0.0;
	for ( int i = 0; i < SAMPLES; i ++ ) {
		float a = ( float( i ) + 0.5 ) / float( SAMPLES );
		float th = float( i ) * 2.399963 + phi;
		vec2 o = vec2( cos( th ) * aspect, sin( th ) ) * sqrt( a ) * rScreen;
		vec3 v = viewPos( vUv + o ) - P;
		float vv = dot( v, v );
		float vn = dot( v, N ) - 0.02 * dist * 0.1 - 0.012;
		float f = max( radius * radius - vv, 0.0 ) / ( radius * radius );
		ao += f * f * f * max( vn / ( vv + 0.0008 ), 0.0 );
	}
	ao = 1.0 - clamp( ao * radius * 2.6 / float( SAMPLES ), 0.0, 1.0 );
	ao = mix( ao, 1.0, smoothstep( 160.0, 260.0, dist ) );
	gl_FragColor = vec4( ao, sqrt( clamp( dist / 260.0, 0.0, 1.0 ) ), 0.0, 1.0 );
}
`;

const AO_BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
	vec2 c = texture2D( tAO, vUv ).xy;
	float sum = 0.0;
	float wsum = 0.0;
	for ( int y = -2; y <= 1; y ++ ) {
		for ( int x = -2; x <= 1; x ++ ) {
			vec2 s = texture2D( tAO, vUv + ( vec2( float( x ), float( y ) ) + 0.5 ) * uTexel ).xy;
			float w = 1.0 / ( 1.0 + abs( s.y - c.y ) * 90.0 );
			sum += s.x * w;
			wsum += w;
		}
	}
	gl_FragColor = vec4( sum / wsum, c.y, 0.0, 1.0 );
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform sampler2D uSky;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uAO;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogBase;
uniform float uCloudShadow;
uniform float uWaterLevel;
uniform vec3 uWaterTint;
varying vec2 vUv;
${NOISE_GLSL}
${CLOUD_GLSL}
${EQUIRECT_GLSL}
void main() {
	vec4 src = texture2D( tColor, vUv );
	vec3 col = src.rgb;
	float depth = texture2D( tDepth, vUv ).x;
	vec4 v = uProjInv * vec4( vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
	vec3 viewPos = v.xyz / v.w;
	vec3 ray = normalize( mat3( uCamWorld ) * viewPos );
	if ( depth < 0.99999 ) {
		float dist = length( viewPos );
		vec3 world = uCamPos + ray * dist;
		col *= mix( 1.0, texture2D( tAO, vUv ).x, uAO );

		// drifting cloud shadows
		if ( uCloudShadow > 0.0 && uSunDir.y > 0.03 ) {
			vec2 P = world.xz + uSunDir.xz * ( ( ${CLOUD_ALTITUDE.toFixed(1)} - world.y ) / uSunDir.y );
			col *= 1.0 - uCloudShadow * pwCloudDensity( P ) * smoothstep( 0.03, 0.2, uSunDir.y );
		}

		// height fog: analytic integral of an exponential density profile along the view ray
		float kh = 1.0 / uFogHeight;
		float a = uFogDensity * exp( -( uCamPos.y - uFogBase ) * kh );
		float ry = ray.y * kh * dist;
		float od = a * dist * ( abs( ry ) > 0.0001 ? ( 1.0 - exp( -ry ) ) / ry : 1.0 );
		float fog = 1.0 - exp( -od );
		// haze takes the colour of the sky near the horizon in that direction
		vec3 hd = normalize( vec3( ray.x, 0.035 + max( ray.y, 0.0 ) * 0.35, ray.z ) );
		vec3 fogCol = texture2D( uSky, pwEquirect( hd ) ).rgb;
		float mu = max( dot( ray, uSunDir ), 0.0 );
		fogCol += uSunColor * ( pow( mu, 8.0 ) * 0.035 + pow( mu, 64.0 ) * 0.05 ) * smoothstep( -0.05, 0.1, uSunDir.y );
		col = mix( col, fogCol, fog );
	}
	// camera under water: thick green murk
	if ( uCamPos.y < uWaterLevel ) {
		float dd = depth < 0.99999 ? length( viewPos ) : 400.0;
		col = mix( col * uWaterTint, uWaterTint * 0.18, 1.0 - exp( -dd * 0.12 ) );
	}
	gl_FragColor = vec4( col, 1.0 );
}
`;

const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
varying vec2 vUv;
vec3 s( vec2 o ) {
	vec3 c = texture2D( tSrc, vUv + o * uTexel ).rgb;
	// tame fireflies on the first, full-range tap
	return uFirst > 0.5 ? c / ( 1.0 + max( c.r, max( c.g, c.b ) ) * 0.06 ) : c;
}
void main() {
	vec3 a = s( vec2( -2.0, 2.0 ) ), b = s( vec2( 0.0, 2.0 ) ), c = s( vec2( 2.0, 2.0 ) );
	vec3 d = s( vec2( -2.0, 0.0 ) ), e = s( vec2( 0.0, 0.0 ) ), f = s( vec2( 2.0, 0.0 ) );
	vec3 g = s( vec2( -2.0, -2.0 ) ), h = s( vec2( 0.0, -2.0 ) ), i = s( vec2( 2.0, -2.0 ) );
	vec3 j = s( vec2( -1.0, 1.0 ) ), k = s( vec2( 1.0, 1.0 ) ), l = s( vec2( -1.0, -1.0 ) ), m = s( vec2( 1.0, -1.0 ) );
	vec3 o = e * 0.125 + ( a + c + g + i ) * 0.03125 + ( b + d + f + h ) * 0.0625 + ( j + k + l + m ) * 0.125;
	gl_FragColor = vec4( o, 1.0 );
}
`;

const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
	vec2 t = uTexel;
	vec3 o = texture2D( tSrc, vUv ).rgb * 4.0;
	o += ( texture2D( tSrc, vUv + vec2( t.x, 0.0 ) ).rgb + texture2D( tSrc, vUv - vec2( t.x, 0.0 ) ).rgb + texture2D( tSrc, vUv + vec2( 0.0, t.y ) ).rgb + texture2D( tSrc, vUv - vec2( 0.0, t.y ) ).rgb ) * 2.0;
	o += texture2D( tSrc, vUv + t ).rgb + texture2D( tSrc, vUv - t ).rgb + texture2D( tSrc, vUv + vec2( t.x, -t.y ) ).rgb + texture2D( tSrc, vUv + vec2( -t.x, t.y ) ).rgb;
	gl_FragColor = vec4( o / 16.0, 1.0 );
}
`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform sampler2D uNoise;
uniform mat4 uReproject;
uniform vec2 uResolution;
uniform float uAspect;
uniform float uDistortion;
uniform float uChroma;
uniform float uMotionBlur;
uniform float uBloom;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uGlitch;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uTint;
uniform float uFade;
varying vec2 vUv;

vec2 lens( vec2 uv ) {
	vec2 p = ( uv - 0.5 ) * vec2( uAspect, 1.0 );
	float rc = 0.25 * ( uAspect * uAspect + 1.0 );
	float s = ( 1.0 + uDistortion * dot( p, p ) ) / ( 1.0 + uDistortion * rc );
	return 0.5 + ( uv - 0.5 ) * s;
}
// ACES filmic (Stephen Hill's fit)
vec3 rrtOdt( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 aces( vec3 c ) {
	const mat3 inM = mat3( 0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777 );
	const mat3 outM = mat3( 1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602 );
	return clamp( outM * rrtOdt( inM * c ), 0.0, 1.0 );
}
float hash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
void main() {
	vec2 uv = vUv;
	// analogue video breakup: torn lines and rolling static when the link is hurting
	float tear = 0.0;
	if ( uGlitch > 0.001 ) {
		float line = floor( uv.y * 90.0 );
		float n = hash( vec2( line, floor( uTime * 30.0 ) ) );
		tear = step( 1.0 - uGlitch * 0.6, n );
		uv.x += ( n - 0.5 ) * 0.09 * uGlitch * tear;
		uv.y += sin( uTime * 40.0 ) * 0.004 * uGlitch;
	}
	vec2 luv = lens( uv );

	// camera motion blur from depth reprojection
	vec3 col;
	#if MB_TAPS > 1
		float depth = texture2D( tDepth, luv ).x;
		vec4 prev = uReproject * vec4( luv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
		vec2 vel = ( luv - ( prev.xy / prev.w * 0.5 + 0.5 ) ) * uMotionBlur;
		if ( prev.w <= 0.0 ) vel = vec2( 0.0 );
		float vl = length( vel );
		if ( vl > 0.045 ) vel *= 0.045 / vl;
		float jitter = hash( gl_FragCoord.xy + uTime ) - 0.5;
		col = vec3( 0.0 );
		for ( int i = 0; i < MB_TAPS; i ++ ) {
			float t = ( float( i ) + 0.5 + jitter ) / float( MB_TAPS ) - 0.5;
			col += texture2D( tColor, luv - vel * t ).rgb;
		}
		col /= float( MB_TAPS );
	#else
		col = texture2D( tColor, luv ).rgb;
	#endif

	// lateral chromatic aberration, growing towards the corners
	vec2 fromC = luv - 0.5;
	float r2 = dot( fromC, fromC );
	if ( uChroma > 0.0 ) {
		float k = uChroma * r2;
		col.r = mix( col.r, texture2D( tColor, 0.5 + fromC * ( 1.0 + k ) ).r, 0.75 );
		col.b = mix( col.b, texture2D( tColor, 0.5 + fromC * ( 1.0 - k ) ).b, 0.75 );
	}

	vec3 bloom = texture2D( tBloom, luv ).rgb / 6.0;
	col = mix( col, bloom, uBloom );

	col *= uExposure * uTint;
	vec2 q = ( vUv - 0.5 ) * vec2( mix( 1.0, uAspect, 0.5 ), 1.0 );
	col *= 1.0 - uVignette * smoothstep( 0.25, 1.05, length( q ) * 1.35 );

	col = aces( col );
	col = pow( col, vec3( 1.0 / 2.2 ) );
	float luma = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
	col = mix( vec3( luma ), col, uSaturation );
	col = ( col - 0.5 ) * uContrast + 0.5;

	if ( uGlitch > 0.001 ) {
		float st = hash( gl_FragCoord.xy * 0.5 + uTime * 61.0 );
		col = mix( col, vec3( st ), clamp( uGlitch * 0.55 + tear * 0.35, 0.0, 0.95 ) );
		col = mix( col, vec3( dot( col, vec3( 0.33 ) ) ), uGlitch * 0.6 );
	}
	float g = hash( gl_FragCoord.xy + fract( uTime ) * 91.7 ) - 0.5;
	col += g * uGrain * ( 1.0 - luma * 0.6 );
	// triangular dither so smooth sky gradients never band
	col += ( hash( gl_FragCoord.xy * 1.7 + 3.1 ) + hash( gl_FragCoord.xy * 2.3 + 7.7 ) - 1.0 ) / 255.0;
	gl_FragColor = vec4( col * uFade, 1.0 );
}
`;

export interface PostSettings {
  ao: boolean;
  bloom: boolean;
  motionBlurTaps: number;
  msaa: number;
}

export interface LookSettings {
  exposure: number;
  fogDensity: number;
  fogHeight: number;
  fogBase: number;
  bloom: number;
  cloudShadow: number;
  saturation: number;
  contrast: number;
  tint: [number, number, number];
}

class Pass {
  readonly scene = new Scene();
  readonly material: ShaderMaterial;
  constructor(fragment: string, uniforms: Record<string, { value: unknown }>, defines?: Record<string, number>) {
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: fragment,
      uniforms,
      defines: defines ?? {},
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    const mesh = new Mesh(fullscreenTriangle(), this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }
  get u(): Record<string, { value: any }> {
    return this.material.uniforms;
  }
}

const BLOOM_LEVELS = 6;

/**
 * HDR frame pipeline: MSAA scene → ambient occlusion → aerial perspective and cloud shadows →
 * bloom → lens (distortion, motion blur, chromatic aberration) → ACES tone map, grade, grain.
 */
export class PostPipeline {
  readonly sceneRT: WebGLRenderTarget;
  private hdrRT: WebGLRenderTarget;
  private aoRT: WebGLRenderTarget;
  private aoBlurRT: WebGLRenderTarget;
  private bloomRT: WebGLRenderTarget[] = [];
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private ao: Pass;
  private aoBlur: Pass;
  private composite: Pass;
  private down: Pass;
  private up: Pass;
  private final: Pass;
  private prevViewProj = new Matrix4();
  private viewProj = new Matrix4();
  private invViewProj = new Matrix4();
  private reproject = new Matrix4();
  private hasPrev = false;
  private width = 2;
  private height = 2;
  settings: PostSettings;

  // artistic controls
  distortion = 0.18;
  chroma = 0.012;
  motionBlur = 0.4;
  vignette = 0.28;
  grain = 0.03;
  glitch = 0;
  fade = 1;
  waterLevel = -1e5;
  private bloomStrength = 0.05;

  constructor(private renderer: WebGLRenderer, sky: Texture, noise: Texture, cloudOffset: Vector2, settings: PostSettings) {
    this.settings = { ...settings };
    this.sceneRT = this.makeSceneRT();
    this.hdrRT = new WebGLRenderTarget(2, 2, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    const aoOpts = { type: UnsignedByteType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false } as const;
    this.aoRT = new WebGLRenderTarget(2, 2, aoOpts);
    this.aoBlurRT = new WebGLRenderTarget(2, 2, aoOpts);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bloomRT.push(new WebGLRenderTarget(2, 2, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false }));
    }

    this.ao = new Pass(AO_FRAG, {
      tDepth: { value: null },
      uProjInv: { value: new Matrix4() },
      uTexel: { value: new Vector2() },
      uProjScale: { value: 1 },
      uRadius: { value: 0.9 },
    });
    this.aoBlur = new Pass(AO_BLUR_FRAG, { tAO: { value: null }, uTexel: { value: new Vector2() } });
    this.composite = new Pass(COMPOSITE_FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      tAO: { value: null },
      uSky: { value: sky },
      uNoise: { value: noise },
      uProjInv: { value: new Matrix4() },
      uCamWorld: { value: new Matrix4() },
      uCamPos: { value: new Vector3() },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Vector3(1, 1, 1) },
      uAO: { value: 1 },
      uFogDensity: { value: 0.00012 },
      uFogHeight: { value: 400 },
      uFogBase: { value: 0 },
      uCloudShadow: { value: 0.4 },
      uCloudOffset: { value: cloudOffset },
      uCloudCover: { value: 0.4 },
      uWaterLevel: { value: -1e5 },
      uWaterTint: { value: new Vector3(0.25, 0.55, 0.5) },
    });
    this.down = new Pass(BLOOM_DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new Vector2() }, uFirst: { value: 0 } });
    this.up = new Pass(BLOOM_UP_FRAG, { tSrc: { value: null }, uTexel: { value: new Vector2() } });
    this.up.material.blending = AdditiveBlending;
    this.up.material.transparent = true;
    this.final = new Pass(
      FINAL_FRAG,
      {
        tColor: { value: null },
        tDepth: { value: null },
        tBloom: { value: null },
        uNoise: { value: noise },
        uReproject: { value: this.reproject },
        uResolution: { value: new Vector2() },
        uAspect: { value: 1 },
        uDistortion: { value: 0.18 },
        uChroma: { value: 0.012 },
        uMotionBlur: { value: 0.4 },
        uBloom: { value: 0.05 },
        uExposure: { value: 0.15 },
        uVignette: { value: 0.28 },
        uGrain: { value: 0.03 },
        uTime: { value: 0 },
        uGlitch: { value: 0 },
        uSaturation: { value: 1 },
        uContrast: { value: 1 },
        uTint: { value: new Vector3(1, 1, 1) },
        uFade: { value: 1 },
      },
      { MB_TAPS: settings.motionBlurTaps },
    );
  }

  private makeSceneRT(): WebGLRenderTarget {
    const rt = new WebGLRenderTarget(this.width, this.height, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      samples: this.settings.msaa,
      depthBuffer: true,
      depthTexture: new DepthTexture(this.width, this.height, UnsignedIntType),
    });
    rt.depthTexture!.minFilter = NearestFilter;
    rt.depthTexture!.magFilter = NearestFilter;
    return rt;
  }

  applySettings(s: PostSettings): void {
    const msaaChanged = s.msaa !== this.settings.msaa;
    this.settings = { ...s };
    if (msaaChanged) {
      this.sceneRT.samples = s.msaa;
      this.sceneRT.dispose();
    }
    if (this.final.material.defines.MB_TAPS !== s.motionBlurTaps) {
      this.final.material.defines.MB_TAPS = s.motionBlurTaps;
      this.final.material.needsUpdate = true;
    }
  }

  setLook(l: LookSettings, sunDir: Vector3, sunColor: Vector3, cloudCover: number): void {
    const c = this.composite.u;
    c.uFogDensity.value = l.fogDensity;
    c.uFogHeight.value = l.fogHeight;
    c.uFogBase.value = l.fogBase;
    c.uCloudShadow.value = l.cloudShadow;
    c.uCloudCover.value = cloudCover;
    c.uSunDir.value.copy(sunDir);
    c.uSunColor.value.copy(sunColor);
    const f = this.final.u;
    f.uExposure.value = l.exposure;
    this.bloomStrength = l.bloom;
    f.uSaturation.value = l.saturation;
    f.uContrast.value = l.contrast;
    f.uTint.value.set(...l.tint);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(2, Math.floor(width));
    this.height = Math.max(2, Math.floor(height));
    this.sceneRT.setSize(this.width, this.height);
    this.hdrRT.setSize(this.width, this.height);
    const hw = Math.max(2, this.width >> 1);
    const hh = Math.max(2, this.height >> 1);
    this.aoRT.setSize(hw, hh);
    this.aoBlurRT.setSize(hw, hh);
    let w = hw;
    let h = hh;
    for (const rt of this.bloomRT) {
      rt.setSize(w, h);
      w = Math.max(2, w >> 1);
      h = Math.max(2, h >> 1);
    }
    this.hasPrev = false;
  }

  /** Call after a teleport or camera cut so motion blur doesn't smear across it. */
  cut(): void {
    this.hasPrev = false;
  }

  private draw(pass: Pass, target: WebGLRenderTarget | null): void {
    this.renderer.setRenderTarget(target);
    this.renderer.render(pass.scene, this.cam);
  }

  render(scene: Scene, camera: PerspectiveCamera, time: number): void {
    const r = this.renderer;
    const depth = this.sceneRT.depthTexture!;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    const projInv = camera.projectionMatrixInverse;
    const hw = this.aoRT.width;
    const hh = this.aoRT.height;

    if (this.settings.ao) {
      const a = this.ao.u;
      a.tDepth.value = depth;
      a.uProjInv.value.copy(projInv);
      a.uTexel.value.set(1 / hw, 1 / hh);
      a.uProjScale.value = camera.projectionMatrix.elements[5] * 0.5;
      this.draw(this.ao, this.aoRT);
      this.aoBlur.u.tAO.value = this.aoRT.texture;
      this.aoBlur.u.uTexel.value.set(1 / hw, 1 / hh);
      this.draw(this.aoBlur, this.aoBlurRT);
    }

    const c = this.composite.u;
    c.tColor.value = this.sceneRT.texture;
    c.tDepth.value = depth;
    c.tAO.value = this.aoBlurRT.texture;
    c.uAO.value = this.settings.ao ? 1 : 0;
    c.uProjInv.value.copy(projInv);
    c.uCamWorld.value.copy(camera.matrixWorld);
    c.uCamPos.value.copy(camera.position);
    c.uWaterLevel.value = this.waterLevel;
    this.draw(this.composite, this.hdrRT);

    if (this.settings.bloom) {
      let src: Texture = this.hdrRT.texture;
      let sw = this.width;
      let sh = this.height;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        this.down.u.tSrc.value = src;
        this.down.u.uTexel.value.set(1 / sw, 1 / sh);
        this.down.u.uFirst.value = i === 0 ? 1 : 0;
        this.draw(this.down, this.bloomRT[i]);
        src = this.bloomRT[i].texture;
        sw = this.bloomRT[i].width;
        sh = this.bloomRT[i].height;
      }
      const auto = r.autoClear;
      r.autoClear = false;
      for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
        this.up.u.tSrc.value = this.bloomRT[i].texture;
        this.up.u.uTexel.value.set(1 / this.bloomRT[i].width, 1 / this.bloomRT[i].height);
        this.draw(this.up, this.bloomRT[i - 1]);
      }
      r.autoClear = auto;
    }

    // reprojection: current clip space → world → last frame's clip space
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.invViewProj.copy(this.viewProj).invert();
    if (!this.hasPrev) this.prevViewProj.copy(this.viewProj);
    this.reproject.multiplyMatrices(this.prevViewProj, this.invViewProj);
    this.prevViewProj.copy(this.viewProj);
    this.hasPrev = true;

    const f = this.final.u;
    f.tColor.value = this.hdrRT.texture;
    f.tDepth.value = depth;
    f.tBloom.value = this.bloomRT[0].texture;
    f.uResolution.value.set(this.width, this.height);
    f.uAspect.value = this.width / this.height;
    f.uDistortion.value = this.distortion;
    f.uChroma.value = this.chroma;
    f.uMotionBlur.value = this.motionBlur;
    f.uVignette.value = this.vignette;
    f.uGrain.value = this.grain;
    f.uTime.value = time % 1000;
    f.uGlitch.value = this.glitch;
    f.uFade.value = this.fade;
    f.uBloom.value = this.settings.bloom ? this.bloomStrength : 0;
    this.draw(this.final, null);
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.hdrRT.dispose();
    this.aoRT.dispose();
    this.aoBlurRT.dispose();
    for (const rt of this.bloomRT) rt.dispose();
  }
}
