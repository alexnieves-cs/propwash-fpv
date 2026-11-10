import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PMREMGenerator,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  ClampToEdgeWrapping,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { DEG, makeRng } from '../core/math';

export interface SkyParams {
  /** compass bearing of the sun/moon, degrees clockwise from north (-Z) */
  azimuth: number;
  /** degrees above the horizon */
  elevation: number;
  /** 1 = crystal clear, 4+ = hazy */
  turbidity: number;
  night: boolean;
  /** 0..1 fraction of sky covered by cumulus */
  cloudCover: number;
  /** 0..1 strength of the high cirrus layer */
  cirrus: number;
  /** average ground colour, used for bounce light from below */
  groundAlbedo: [number, number, number];
  /** extra glow hugging the horizon (city light pollution at night) */
  horizonGlow: [number, number, number];
  exposure: number;
}

export interface SunState {
  direction: Vector3;
  color: Color;
  intensity: number;
}

/** 256² RGBA white noise; sampled with smooth interpolation it becomes cheap value noise everywhere. */
export function makeNoiseTexture(): DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const rng = makeRng(90210);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rng() * 256);
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Shared GLSL: smooth value noise from the noise texture, and the cumulus density field. */
export const NOISE_GLSL = /* glsl */ `
uniform sampler2D uNoise;
float pwNoise( vec2 p ) {
	vec2 x = p * 256.0;
	vec2 i = floor( x );
	vec2 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return texture2D( uNoise, ( i + f + 0.5 ) / 256.0 ).r;
}
float pwFbm( vec2 p ) {
	float s = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 5; i ++ ) {
		s += a * pwNoise( p );
		p = p * 2.03 + vec2( 0.173, 0.411 );
		a *= 0.5;
	}
	return s / 0.96875;
}
`;

export const CLOUD_GLSL = /* glsl */ `
uniform vec2 uCloudOffset;
uniform float uCloudCover;
float pwCloudDensity( vec2 P ) {
	vec2 p = P / 153600.0 + uCloudOffset;
	float base = pwFbm( p );
	float detail = pwFbm( p * 5.7 + 3.7 );
	float d = base + ( detail - 0.5 ) * 0.22;
	float t = 0.74 - uCloudCover * 0.42;
	return smoothstep( t, t + 0.2, d ) * step( 0.001, uCloudCover );
}
`;

export const EQUIRECT_GLSL = /* glsl */ `
vec2 pwEquirect( vec3 d ) {
	return vec2( atan( d.z, d.x ) * 0.15915494 + 0.5, asin( clamp( d.y, -1.0, 1.0 ) ) * 0.31830989 + 0.5 );
}
`;

/** Altitude of the cumulus deck, metres. */
export const CLOUD_ALTITUDE = 1900;

const KR = [5.8e-6, 13.5e-6, 33.1e-6];
const KO = [0.65e-6, 1.881e-6, 0.085e-6];
const KM = 21e-6;

/** How much of the sun's light survives the trip through the atmosphere, per RGB channel. */
function sunTransmittance(elevation: number, turbidity: number): [number, number, number] {
  const RP = 6371e3;
  const RA = 6471e3;
  const oy = RP + 300;
  const dx = Math.cos(elevation);
  const dy = Math.sin(elevation);
  const b = 2 * oy * dy;
  // does the ray dip into the planet?
  const cGround = oy * oy - RP * RP;
  const discG = b * b - 4 * cGround;
  if (discG > 0 && -b - Math.sqrt(discG) > 0) return [0, 0, 0];
  const c = oy * oy - RA * RA;
  const t1 = (-b + Math.sqrt(b * b - 4 * c)) / 2;
  const N = 64;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  for (let i = 0; i < N; i++) {
    const u0 = i / N;
    const u1 = (i + 1) / N;
    const ta = t1 * u0 * u0;
    const tb = t1 * u1 * u1;
    const t = (ta + tb) / 2;
    const px = dx * t;
    const py = oy + dy * t;
    const h = Math.hypot(px, py) - RP;
    const ds = tb - ta;
    odR += Math.exp(-h / 8000) * ds;
    odM += Math.exp(-h / 1200) * ds;
    odO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * ds;
  }
  const km = KM * 1.11 * turbidity;
  return [0, 1, 2].map((i) => Math.exp(-(KR[i] * odR + km * odM + KO[i] * odO))) as [number, number, number];
}

const BAKE_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uTurbidity;
uniform float uIntensity;
uniform vec3 uGroundAlbedo;
uniform vec3 uHorizonGlow;
uniform vec3 uBase;
varying vec2 vUv;
const float PI = 3.14159265;
const float RP = 6371e3;
const float RA = 6471e3;
const vec3 KR = vec3( 5.8e-6, 13.5e-6, 33.1e-6 );
const vec3 KO = vec3( 0.65e-6, 1.881e-6, 0.085e-6 );
const float KM = 21e-6;
const int STEPS = 40;
const int LSTEPS = 8;

vec2 rsi( vec3 r0, vec3 rd, float sr ) {
	float b = 2.0 * dot( rd, r0 );
	float c = dot( r0, r0 ) - sr * sr;
	float d = b * b - 4.0 * c;
	if ( d < 0.0 ) return vec2( 1e9, -1e9 );
	float s = sqrt( d );
	return vec2( ( -b - s ) * 0.5, ( -b + s ) * 0.5 );
}
vec3 density( float h ) {
	return vec3( exp( -h / 8000.0 ), exp( -h / 1200.0 ), max( 0.0, 1.0 - abs( h - 25000.0 ) / 15000.0 ) );
}
void main() {
	float phi = ( vUv.x - 0.5 ) * 2.0 * PI;
	float theta = ( vUv.y - 0.5 ) * PI;
	vec3 r = vec3( cos( theta ) * cos( phi ), sin( theta ), cos( theta ) * sin( phi ) );
	vec3 r0 = vec3( 0.0, RP + 300.0, 0.0 );
	float km = KM * uTurbidity;
	vec2 pa = rsi( r0, r, RA );
	vec2 pg = rsi( r0, r, RP );
	bool ground = pg.x > 0.0 && pg.x < pg.y;
	float tEnd = ground ? pg.x : pa.y;
	vec3 od = vec3( 0.0 );
	vec3 sumR = vec3( 0.0 );
	vec3 sumM = vec3( 0.0 );
	for ( int i = 0; i < STEPS; i ++ ) {
		float u0 = float( i ) / float( STEPS );
		float u1 = float( i + 1 ) / float( STEPS );
		float ta = tEnd * u0 * u0;
		float tb = tEnd * u1 * u1;
		float ds = tb - ta;
		vec3 p = r0 + r * ( ta + tb ) * 0.5;
		float h = length( p ) - RP;
		vec3 dn = density( h ) * ds;
		od += dn;
		vec2 ps = rsi( p, uSunDir, RA );
		vec2 pp = rsi( p, uSunDir, RP * 0.9995 );
		if ( pp.x > 0.0 && pp.x < pp.y ) continue; // planet shadow
		float ls = ps.y / float( LSTEPS );
		vec3 odl = vec3( 0.0 );
		for ( int j = 0; j < LSTEPS; j ++ ) {
			vec3 q = p + uSunDir * ( float( j ) + 0.5 ) * ls;
			odl += density( length( q ) - RP ) * ls;
		}
		vec3 tau = KR * ( od.x + odl.x ) + km * 1.11 * ( od.y + odl.y ) + KO * ( od.z + odl.z );
		vec3 att = exp( -tau );
		sumR += dn.x * att;
		sumM += dn.y * att;
	}
	float mu = dot( r, uSunDir );
	float mumu = mu * mu;
	float g = 0.76;
	float gg = g * g;
	float pR = 3.0 / ( 16.0 * PI ) * ( 1.0 + mumu );
	float pM = 3.0 / ( 8.0 * PI ) * ( ( 1.0 - gg ) * ( mumu + 1.0 ) ) / ( pow( 1.0 + gg - 2.0 * mu * g, 1.5 ) * ( 2.0 + gg ) );
	vec3 col = uIntensity * ( pR * KR * sumR + pM * km * sumM );
	// crude multiple-scattering lift so the sky is not unrealistically dark against the sun
	col *= 1.0 + vec3( 0.7, 0.85, 1.0 ) * 1.1;
	vec3 viewT = exp( -( KR * od.x + km * 1.11 * od.y + KO * od.z ) );
	if ( ground ) {
		// sunlit ground seen through the haze — this is what lights the underside of things
		float sunUp = max( uSunDir.y, 0.0 );
		vec3 tSun = exp( -( KR * 8000.0 + km * 1.11 * 1200.0 ) / max( uSunDir.y, 0.06 ) );
		vec3 lit = uGroundAlbedo * ( uIntensity * tSun * sunUp / PI + uIntensity * 0.06 * vec3( 0.5, 0.65, 1.0 ) * ( 0.25 + sunUp ) );
		col += lit * viewT;
	}
	col += uBase * ( 0.4 + 0.6 * smoothstep( -0.1, 0.5, r.y ) );
	col += uHorizonGlow * exp( -abs( r.y ) * 9.0 );
	gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
}
`;

const SKY_VERT = /* glsl */ `
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
varying vec3 vDir;
void main() {
	gl_Position = vec4( position.xy, 1.0, 1.0 );
	vec4 v = uProjInv * vec4( position.xy, 1.0, 1.0 );
	vDir = mat3( uCamWorld ) * ( v.xyz / v.w );
}
`;

const SKY_FRAG = /* glsl */ `
uniform sampler2D uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uCloudLight;
uniform vec3 uCloudAmbient;
uniform float uCirrus;
uniform float uNight;
uniform float uTime;
uniform float uCamY;
uniform vec2 uCamXZ;
varying vec3 vDir;
${NOISE_GLSL}
${CLOUD_GLSL}
${EQUIRECT_GLSL}
void main() {
	vec3 dir = normalize( vDir );
	vec3 col = texture2D( uSky, pwEquirect( dir ) ).rgb;
	float mu = dot( dir, uSunDir );

	// stars, only where the sky is actually dark
	if ( uNight > 0.5 && dir.y > -0.05 ) {
		vec2 suv = vec2( atan( dir.z, dir.x ), dir.y * 2.2 ) * 2.6;
		float s = texture2D( uNoise, suv ).g;
		float s2 = texture2D( uNoise, suv * 0.37 + 0.31 ).b;
		float twinkle = 0.75 + 0.25 * sin( uTime * 3.0 + s2 * 40.0 );
		col += vec3( 0.8, 0.88, 1.0 ) * pow( smoothstep( 0.9, 1.0, s ), 6.0 ) * ( 0.25 + s2 ) * twinkle * smoothstep( -0.02, 0.25, dir.y ) * 0.9;
	}

	// sun / moon disc with limb darkening
	float discR = uNight > 0.5 ? 0.9996 : 0.99988;
	float disc = smoothstep( discR, discR + ( 1.0 - discR ) * 0.55, mu );
	col += uSunColor * disc * smoothstep( -0.03, 0.02, dir.y );
	col += uSunColor * 0.012 * pow( max( mu, 0.0 ), 900.0 ) * ( 1.0 - uNight );

	// clouds on a gently curved shell so they meet the horizon naturally
	if ( dir.y > -0.03 ) {
		float H = ${CLOUD_ALTITUDE.toFixed(1)} - uCamY;
		float R = 120000.0;
		float dy = max( dir.y, 0.0 );
		float t = sqrt( R * R * dy * dy + 2.0 * R * H + H * H ) - R * dy;
		vec2 P = uCamXZ + dir.xz * t;
		float fade = smoothstep( -0.02, 0.07, dir.y ) * exp( -t / 52000.0 );
		vec3 skyCol = col;

		// cirrus: thin, stretched, very high
		vec2 cp = ( uCamXZ * 0.15 + dir.xz * t * 2.6 ) / 420000.0 + uCloudOffset * 0.3;
		float ci = pwFbm( vec2( cp.x * 2.1 + cp.y * 0.5, cp.y * 1.3 ) );
		ci = smoothstep( 0.56, 0.9, ci ) * uCirrus * fade;
		col = mix( col, uCloudLight * 0.75 + uCloudAmbient * 0.5, ci * 0.55 );

		float d = pwCloudDensity( P );
		if ( d > 0.001 ) {
			float dSun = pwCloudDensity( P + uSunDir.xz * 420.0 );
			float lit = exp( -2.4 * dSun );
			float edge = 1.0 - d;
			vec3 c = uCloudAmbient * ( 0.5 + 0.5 * edge ) + uCloudLight * ( 0.18 + 0.82 * lit ) * ( 0.62 + 0.38 * edge );
			c += uCloudLight * pow( max( mu, 0.0 ), 10.0 ) * edge * 1.6;
			// far clouds sink into the haze colour
			c = mix( skyCol, c, exp( -t / 38000.0 ) );
			col = mix( col, c, d * fade );
		}
	}
	gl_FragColor = vec4( col, 1.0 );
}
`;

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

export function fullscreenTriangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

/**
 * Sky, sun and image-based lighting. The atmosphere is integrated once per map into a small
 * equirect HDR texture; that one texture then drives the visible sky, the environment lighting and
 * the colour of distance haze, so all three always agree.
 */
export class Sky {
  readonly mesh: Mesh;
  readonly skyTexture: Texture;
  readonly sun: SunState = { direction: new Vector3(0, 1, 0), color: new Color(1, 1, 1), intensity: 1 };
  readonly cloudOffset = new Vector2();
  params!: SkyParams;
  envTexture: Texture | null = null;

  private bakeRT: WebGLRenderTarget;
  private bakeMat: ShaderMaterial;
  private bakeScene = new Scene();
  private bakeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private pmrem: PMREMGenerator;
  private envRT: WebGLRenderTarget | null = null;
  private mat: ShaderMaterial;
  private projInv = new Matrix4();

  constructor(private renderer: WebGLRenderer, readonly noise: Texture) {
    this.bakeRT = new WebGLRenderTarget(512, 512, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.bakeRT.texture.wrapS = RepeatWrapping;
    this.bakeRT.texture.wrapT = ClampToEdgeWrapping;
    this.skyTexture = this.bakeRT.texture;
    this.bakeMat = new ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: BAKE_FRAG,
      uniforms: {
        uSunDir: { value: new Vector3() },
        uTurbidity: { value: 2 },
        uIntensity: { value: 20 },
        uGroundAlbedo: { value: new Vector3(0.1, 0.1, 0.08) },
        uHorizonGlow: { value: new Vector3() },
        uBase: { value: new Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const tri = fullscreenTriangle();
    const bakeMesh = new Mesh(tri, this.bakeMat);
    bakeMesh.frustumCulled = false;
    this.bakeScene.add(bakeMesh);
    this.pmrem = new PMREMGenerator(renderer);

    this.mat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uSky: { value: this.skyTexture },
        uNoise: { value: noise },
        uSunDir: { value: this.sun.direction },
        uSunColor: { value: new Vector3() },
        uCloudLight: { value: new Vector3() },
        uCloudAmbient: { value: new Vector3() },
        uCloudOffset: { value: this.cloudOffset },
        uCloudCover: { value: 0.4 },
        uCirrus: { value: 0.5 },
        uNight: { value: 0 },
        uTime: { value: 0 },
        uCamY: { value: 0 },
        uCamXZ: { value: new Vector2() },
        uProjInv: { value: this.projInv },
        uCamWorld: { value: new Matrix4() },
      },
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new Mesh(tri, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
    this.mesh.name = 'sky';
  }

  /** Re-integrate the atmosphere for a new time of day and rebuild the environment lighting. */
  apply(p: SkyParams): SunState {
    this.params = p;
    const el = p.elevation * DEG;
    const az = p.azimuth * DEG;
    const dir = this.sun.direction.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();

    // a moonlit night reuses the same integrator with a far weaker source
    const source = p.night ? 0.055 : 20;
    const u = this.bakeMat.uniforms;
    u.uSunDir.value.copy(dir);
    u.uTurbidity.value = p.turbidity;
    u.uIntensity.value = source;
    u.uGroundAlbedo.value.set(...p.groundAlbedo);
    u.uHorizonGlow.value.set(...p.horizonGlow);
    u.uBase.value.set(...(p.night ? [0.0035, 0.0048, 0.0085] : [0, 0, 0]));

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.bakeRT);
    this.renderer.render(this.bakeScene, this.bakeCam);
    this.renderer.setRenderTarget(prev);

    this.envRT?.dispose();
    this.envRT = this.pmrem.fromEquirectangular(this.skyTexture);
    this.envTexture = this.envRT.texture;

    const tr = sunTransmittance(el, p.turbidity);
    const peak = Math.max(tr[0], tr[1], tr[2], 1e-4);
    this.sun.color.setRGB(tr[0] / peak, tr[1] / peak, tr[2] / peak);
    // direct light, with a soft fade as the disc sinks into the horizon haze
    this.sun.intensity = source * peak * (p.night ? 9 : 1) * Math.min(1, Math.max(0, (p.elevation + 1.5) / 4));

    const lightRgb = new Vector3(this.sun.color.r, this.sun.color.g, this.sun.color.b).multiplyScalar(this.sun.intensity);
    const m = this.mat.uniforms;
    m.uSunColor.value.copy(lightRgb).multiplyScalar(p.night ? 14 : 5.5);
    m.uCloudLight.value.copy(lightRgb).multiplyScalar(0.3);
    // ambient cloud light ≈ zenith sky radiance
    const zen = p.night ? new Vector3(0.012, 0.016, 0.028) : new Vector3(0.55, 0.85, 1.35).multiplyScalar(0.5 + 0.5 * Math.max(0, Math.sin(el)));
    m.uCloudAmbient.value.copy(zen);
    m.uCloudCover.value = p.cloudCover;
    m.uCirrus.value = p.cirrus;
    m.uNight.value = p.night ? 1 : 0;
    return this.sun;
  }

  update(time: number, camera: PerspectiveCamera, windX: number, windZ: number, dt: number): void {
    const m = this.mat.uniforms;
    this.cloudOffset.x += (windX * dt) / 153600;
    this.cloudOffset.y += (windZ * dt) / 153600;
    m.uTime.value = time;
    m.uCamY.value = camera.position.y;
    m.uCamXZ.value.set(camera.position.x, camera.position.z);
    this.projInv.copy(camera.projectionMatrixInverse);
    m.uCamWorld.value.copy(camera.matrixWorld);
  }

  dispose(): void {
    this.bakeRT.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.mat.dispose();
    this.bakeMat.dispose();
  }
}
