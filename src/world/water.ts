import { Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3, type PerspectiveCamera, type Texture } from 'three';
import { CLOUD_ALTITUDE, CLOUD_GLSL, EQUIRECT_GLSL, NOISE_GLSL } from '../render/atmosphere';

export interface WaterOpts {
  level: number;
  size: number;
  x: number;
  z: number;
  heightTexture: Texture;
  gridN: number;
  innerHalf: number;
  cell: number;
  sky: Texture;
  noise: Texture;
  cloudOffset: Vector2;
  cloudCover: number;
  sunDir: Vector3;
  sunColor: Vector3;
  shallow: [number, number, number];
  deep: [number, number, number];
}

/**
 * A lake surface: wind ripples, Fresnel reflection of the baked sky and the live cloud layer, a
 * sun glitter path, and depth-tinted shallows read from the terrain height texture.
 */
export class Water {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;

  constructor(o: WaterOpts) {
    this.mat = new ShaderMaterial({
      uniforms: {
        uLevel: { value: o.level },
        tHeight: { value: o.heightTexture },
        uGridN: { value: o.gridN },
        uInnerHalf: { value: o.innerHalf },
        uCell: { value: o.cell },
        uSky: { value: o.sky },
        uNoise: { value: o.noise },
        uCloudOffset: { value: o.cloudOffset },
        uCloudCover: { value: o.cloudCover },
        uSunDir: { value: o.sunDir },
        uSunColor: { value: o.sunColor },
        uShallow: { value: new Vector3(...o.shallow) },
        uDeep: { value: new Vector3(...o.deep) },
        uTime: { value: 0 },
        uCam: { value: new Vector3() },
      },
      vertexShader: /* glsl */ `
varying vec3 vWorld;
void main() {
	vec4 w = modelMatrix * vec4( position, 1.0 );
	vWorld = w.xyz;
	gl_Position = projectionMatrix * viewMatrix * w;
}`,
      fragmentShader: /* glsl */ `
uniform float uLevel;
uniform highp sampler2D tHeight;
uniform int uGridN;
uniform float uInnerHalf;
uniform float uCell;
uniform sampler2D uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uTime;
uniform vec3 uCam;
varying vec3 vWorld;
${NOISE_GLSL}
${CLOUD_GLSL}
${EQUIRECT_GLSL}
float ground( vec2 xz ) {
	vec2 g = ( xz + uInnerHalf ) / uCell;
	if ( g.x < 0.0 || g.y < 0.0 || g.x > float( uGridN ) || g.y > float( uGridN ) ) return uLevel - 12.0;
	ivec2 i = ivec2( floor( g ) );
	vec2 f = fract( g );
	ivec2 mx = ivec2( uGridN );
	float a = texelFetch( tHeight, clamp( i, ivec2( 0 ), mx ), 0 ).r;
	float b = texelFetch( tHeight, clamp( i + ivec2( 1, 0 ), ivec2( 0 ), mx ), 0 ).r;
	float c = texelFetch( tHeight, clamp( i + ivec2( 0, 1 ), ivec2( 0 ), mx ), 0 ).r;
	float d = texelFetch( tHeight, clamp( i + ivec2( 1, 1 ), ivec2( 0 ), mx ), 0 ).r;
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float waves( vec2 p ) {
	float t = uTime;
	float h = pwNoise( p * 0.0045 + vec2( t * 0.006, t * 0.004 ) ) * 0.5;
	h += pwNoise( p * 0.017 - vec2( t * 0.016, -t * 0.012 ) ) * 0.32;
	h += pwNoise( p * 0.052 + vec2( -t * 0.026, t * 0.034 ) ) * 0.18;
	return h;
}
void main() {
	vec3 V = normalize( uCam - vWorld );
	float dist = length( uCam - vWorld );
	float depth = uLevel - ground( vWorld.xz );

	// ripple normal, calmed with distance and in the lee of the shore
	float e = 0.22;
	float calm = smoothstep( 0.0, 1.6, depth ) * ( 1.0 - smoothstep( 120.0, 900.0, dist ) * 0.65 );
	float h0 = waves( vWorld.xz );
	float hx = waves( vWorld.xz + vec2( e, 0.0 ) );
	float hz = waves( vWorld.xz + vec2( 0.0, e ) );
	// ripples flatten out towards the horizon, where they are smaller than a pixel
	float amp = 0.5 * calm / ( 1.0 + dist * 0.012 );
	vec3 N = normalize( vec3( ( h0 - hx ) * amp, e, ( h0 - hz ) * amp ) );
	if ( V.y < 0.0 ) N = -N;

	float ndv = max( dot( N, V ), 0.0 );
	float fres = 0.02 + 0.98 * pow( 1.0 - ndv, 5.0 );

	// what the surface reflects
	vec3 R = reflect( -V, N );
	R.y = abs( R.y );
	vec3 refl = texture2D( uSky, pwEquirect( R ) ).rgb;
	if ( R.y > 0.02 ) {
		float tC = ( ${CLOUD_ALTITUDE.toFixed(1)} - uLevel ) / R.y;
		float cd = pwCloudDensity( vWorld.xz + R.xz * tC ) * exp( -tC / 45000.0 );
		refl = mix( refl, uSunColor * 0.07 + vec3( 0.5, 0.6, 0.75 ) * 0.6, cd * 0.8 );
	}
	float spec = pow( max( dot( R, uSunDir ), 0.0 ), 900.0 ) * 26.0 + pow( max( dot( R, uSunDir ), 0.0 ), 90.0 ) * 0.22;
	refl += uSunColor * spec * smoothstep( 0.0, 0.05, uSunDir.y );

	// what you see through it
	float sunUp = max( uSunDir.y, 0.0 );
	vec3 light = uSunColor * sunUp * 0.32 + texture2D( uSky, vec2( 0.25, 0.98 ) ).rgb * 0.9;
	vec3 body = mix( uShallow, uDeep, 1.0 - exp( -max( depth, 0.0 ) * 0.55 ) ) * light;

	vec3 col = mix( body, refl, fres );

	// a thin line of foam where water meets land
	float foam = smoothstep( 0.2, 0.0, depth ) * ( 0.5 + 0.5 * pwNoise( vWorld.xz * 0.6 + uTime * 0.05 ) );
	col = mix( col, light * 0.75, foam * 0.55 );
	gl_FragColor = vec4( col, 1.0 );
}`,
    });
    const geo = new PlaneGeometry(o.size, o.size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.position.set(o.x, o.level, o.z);
    this.mesh.name = 'water';
    this.mesh.updateMatrixWorld();
  }

  update(time: number, camera: PerspectiveCamera): void {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uCam.value.copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
