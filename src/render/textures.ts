import {
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  OrthographicCamera,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { fullscreenTriangle } from './atmosphere';

/**
 * Every surface texture in the simulator is synthesised on the GPU at start-up from the recipes
 * below — tileable albedo, a normal map derived from the recipe's height field, and a packed
 * occlusion/roughness/height map. No image files ship with the project.
 */

export interface TexSet {
  /** sRGB albedo. Alpha holds height for opaque recipes and coverage for cut-outs. */
  map: Texture;
  normalMap: Texture;
  /** R = ambient occlusion, G = roughness, B = height */
  orm: Texture;
}

const LIB = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTexel;
uniform float uBump;
const float PI = 3.14159265;

vec2 hash2( vec2 p, float seed ) {
	uvec2 q = uvec2( ivec2( p ) );
	uint n = q.x * 1597334677u ^ q.y * 3812015801u ^ uint( seed ) * 2654435769u;
	n = ( n ^ ( n >> 15 ) ) * 2246822519u;
	n ^= n >> 13;
	n *= 3266489917u;
	n ^= n >> 16;
	uint m = n * 747796405u + 2891336453u;
	m ^= m >> 15;
	return vec2( float( n & 0xffffu ), float( m & 0xffffu ) ) / 65535.0;
}
float hash1( vec2 p, float seed ) { return hash2( p, seed ).x; }

// periodic gradient noise, ~[0,1]
float gnoise( vec2 p, vec2 per, float seed ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	vec2 ga = hash2( mod( i, per ), seed ) * 2.0 - 1.0;
	vec2 gb = hash2( mod( i + vec2( 1.0, 0.0 ), per ), seed ) * 2.0 - 1.0;
	vec2 gc = hash2( mod( i + vec2( 0.0, 1.0 ), per ), seed ) * 2.0 - 1.0;
	vec2 gd = hash2( mod( i + vec2( 1.0, 1.0 ), per ), seed ) * 2.0 - 1.0;
	float a = dot( ga, f );
	float b = dot( gb, f - vec2( 1.0, 0.0 ) );
	float c = dot( gc, f - vec2( 0.0, 1.0 ) );
	float d = dot( gd, f - vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 0.7071 + 0.5;
}
float fbm( vec2 uv, vec2 freq, int oct, float seed ) {
	float s = 0.0, a = 0.5, n = 0.0;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= oct ) break;
		s += a * gnoise( uv * freq, freq, seed + float( i ) * 17.0 );
		n += a;
		a *= 0.5;
		freq *= 2.0;
	}
	return s / n;
}
float fbm( vec2 uv, float freq, int oct, float seed ) { return fbm( uv, vec2( freq ), oct, seed ); }
float ridged( vec2 uv, vec2 freq, int oct, float seed ) {
	float s = 0.0, a = 0.5, n = 0.0;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= oct ) break;
		float v = 1.0 - abs( gnoise( uv * freq, freq, seed + float( i ) * 13.0 ) * 2.0 - 1.0 );
		s += a * v * v;
		n += a;
		a *= 0.5;
		freq *= 2.0;
	}
	return s / n;
}
// periodic cellular noise: x = F1, y = F2, z = cell id
vec3 worley( vec2 uv, vec2 freq, float seed ) {
	vec2 p = uv * freq;
	vec2 i = floor( p );
	vec2 f = fract( p );
	float f1 = 9.0, f2 = 9.0, id = 0.0;
	for ( int y = -1; y <= 1; y ++ ) {
		for ( int x = -1; x <= 1; x ++ ) {
			vec2 o = vec2( float( x ), float( y ) );
			vec2 c = mod( i + o, freq );
			vec2 r = o + hash2( c, seed ) - f;
			float d = dot( r, r );
			if ( d < f1 ) { f2 = f1; f1 = d; id = hash1( c, seed + 7.0 ); }
			else if ( d < f2 ) { f2 = d; }
		}
	}
	return vec3( sqrt( f1 ), sqrt( f2 ), id );
}
vec3 worley( vec2 uv, float freq, float seed ) { return worley( uv, vec2( freq ), seed ); }
float sat( float x ) { return clamp( x, 0.0, 1.0 ); }
// sRGB hex-ish colour → linear
vec3 lin( vec3 c ) { return pow( c, vec3( 2.2 ) ); }
float sdSeg( vec2 p, vec2 a, vec2 b ) {
	vec2 pa = p - a, ba = b - a;
	float h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
	return length( pa - ba * h );
}
`;

const MAIN = /* glsl */ `
void main() {
	vec3 col; float h; float rough; float ao; float alpha;
	surf( vUv, col, h, rough, ao, alpha );
	#if OUTPUT == 0
		gl_FragColor = vec4( max( col, vec3( 0.0 ) ), alpha );
	#elif OUTPUT == 1
		vec3 c2; float hx; float hy; float r2; float a2; float l2;
		surf( vUv + vec2( uTexel, 0.0 ), c2, hx, r2, a2, l2 );
		surf( vUv + vec2( 0.0, uTexel ), c2, hy, r2, a2, l2 );
		vec3 n = normalize( vec3( ( h - hx ) / uTexel * uBump, ( h - hy ) / uTexel * uBump, 1.0 ) );
		gl_FragColor = vec4( n * 0.5 + 0.5, 1.0 );
	#else
		gl_FragColor = vec4( sat( ao ), sat( rough ), sat( h ), 1.0 );
	#endif
}
`;

interface Recipe {
  /** surface relief depth divided by the physical tile size */
  bump: number;
  size?: number;
  cutout?: boolean;
  glsl: string;
}

const RECIPES = {
  grass: {
    bump: 0.012,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 3.0, 4, 1.0 );
	float mid = fbm( uv, 11.0, 4, 2.0 );
	vec3 w = worley( uv, 22.0, 3.0 );
	vec3 w2 = worley( uv, 64.0, 4.0 );
	float streakA = fbm( uv, vec2( 160.0, 26.0 ), 2, 5.0 );
	float streakB = fbm( uv, vec2( 26.0, 160.0 ), 2, 6.0 );
	float blades = max( streakA, streakB );
	float clump = 1.0 - sat( w.x * 1.5 );
	h = sat( clump * 0.28 + blades * 0.42 + ( 1.0 - w2.x ) * 0.3 + mid * 0.25 - 0.1 );
	vec3 deep = vec3( 0.04, 0.072, 0.02 );
	vec3 green = vec3( 0.085, 0.15, 0.034 );
	vec3 lush = vec3( 0.11, 0.19, 0.042 );
	vec3 dry = vec3( 0.2, 0.19, 0.075 );
	col = mix( deep, green, sat( 0.62 + h * 0.6 ) );
	col = mix( col, lush, sat( ( blades - 0.5 ) * 2.2 ) * 0.5 );
	col = mix( col, dry, smoothstep( 0.62, 0.8, fbm( uv, 40.0, 2, 8.0 ) ) * 0.45 * ( 0.4 + big ) );
	col *= 0.82 + 0.36 * mid;
	col = mix( col, col * vec3( 1.25, 1.12, 0.7 ), smoothstep( 0.45, 0.75, big ) * 0.3 );
	ao = 0.55 + 0.45 * h;
	rough = 0.82 + 0.12 * ( 1.0 - h );
	alpha = h;
}`,
  },
  forestFloor: {
    bump: 0.035,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 4.0, 5, 11.0 );
	float fine = fbm( uv, 48.0, 3, 12.0 );
	// fallen needles: short directional streaks in several axes
	float n1 = fbm( uv, vec2( 220.0, 34.0 ), 2, 13.0 );
	float n2 = fbm( uv, vec2( 34.0, 220.0 ), 2, 14.0 );
	float needles = smoothstep( 0.56, 0.74, max( n1, n2 ) );
	// twigs
	vec3 w = worley( uv, 9.0, 15.0 );
	float twig = smoothstep( 0.05, 0.02, abs( w.y - w.x ) ) * step( 0.72, w.z );
	vec3 cone = worley( uv, 14.0, 16.0 );
	float cones = smoothstep( 0.09, 0.05, cone.x ) * step( 0.82, cone.z );
	h = sat( big * 0.5 + fine * 0.25 + needles * 0.15 + twig * 0.3 + cones * 0.5 );
	vec3 soil = vec3( 0.07, 0.05, 0.034 );
	vec3 litter = vec3( 0.19, 0.125, 0.068 );
	vec3 rust = vec3( 0.27, 0.145, 0.055 );
	col = mix( soil, litter, sat( big * 1.4 - 0.1 ) );
	col = mix( col, rust, needles * 0.65 );
	col = mix( col, vec3( 0.07, 0.055, 0.04 ), twig * 0.8 );
	col = mix( col, vec3( 0.1, 0.065, 0.04 ), cones );
	// a little moss
	col = mix( col, vec3( 0.05, 0.085, 0.02 ), smoothstep( 0.6, 0.78, fbm( uv, 7.0, 3, 17.0 ) ) * 0.55 );
	col *= 0.75 + 0.5 * fine;
	ao = 0.6 + 0.4 * h;
	rough = 0.92;
	alpha = h;
}`,
  },
  dirt: {
    bump: 0.03,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 3.0, 5, 21.0 );
	float fine = fbm( uv, 70.0, 3, 22.0 );
	vec3 st = worley( uv, 26.0, 23.0 );
	vec3 st2 = worley( uv, 70.0, 24.0 );
	float stone = smoothstep( 0.34, 0.18, st.x ) * step( 0.45, st.z );
	float pebble = smoothstep( 0.3, 0.14, st2.x ) * step( 0.55, st2.z );
	h = sat( big * 0.45 + fine * 0.12 + stone * 0.5 * ( 1.0 - st.x ) * 2.0 + pebble * 0.2 );
	vec3 earth = mix( vec3( 0.11, 0.08, 0.055 ), vec3( 0.2, 0.155, 0.105 ), big );
	vec3 rock = mix( vec3( 0.17, 0.165, 0.155 ), vec3( 0.33, 0.31, 0.28 ), st.z );
	col = earth * ( 0.8 + 0.4 * fine );
	col = mix( col, rock, stone * 0.9 );
	col = mix( col, rock * 0.85, pebble * 0.8 );
	// tyre / foot wear: slightly paler, smoother streaks
	float wear = smoothstep( 0.5, 0.7, fbm( uv, vec2( 2.0, 14.0 ), 3, 25.0 ) );
	col = mix( col, col * 1.2 + 0.01, wear * 0.3 );
	ao = 0.6 + 0.4 * h;
	rough = 0.9 - stone * 0.15;
	alpha = h;
}`,
  },
  rock: {
    bump: 0.09,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 2.0, 6, 31.0 );
	float strata = ridged( uv, vec2( 2.0, 7.0 ), 5, 32.0 );
	float fine = fbm( uv, 40.0, 4, 33.0 );
	vec3 w = worley( uv + ( fbm( uv, 5.0, 3, 34.0 ) - 0.5 ) * 0.08, 5.0, 35.0 );
	float crack = smoothstep( 0.0, 0.07, w.y - w.x );
	vec3 w2 = worley( uv, 13.0, 36.0 );
	float crack2 = smoothstep( 0.0, 0.05, w2.y - w2.x );
	h = sat( big * 0.45 + strata * 0.4 + fine * 0.08 + w.z * 0.12 ) * ( 0.35 + 0.65 * crack ) * ( 0.8 + 0.2 * crack2 );
	vec3 grey = mix( vec3( 0.11, 0.105, 0.1 ), vec3( 0.3, 0.285, 0.265 ), sat( big * 0.8 + strata * 0.5 ) );
	grey = mix( grey, vec3( 0.24, 0.2, 0.16 ), smoothstep( 0.4, 0.8, fbm( uv, 6.0, 4, 37.0 ) ) * 0.5 );
	col = grey * ( 0.72 + 0.56 * fine );
	col *= 0.45 + 0.55 * crack;
	col *= 0.85 + 0.15 * crack2;
	// lichen: pale green and rusty orange freckles
	float li = smoothstep( 0.62, 0.72, fbm( uv, 18.0, 3, 38.0 ) ) * smoothstep( 0.45, 0.6, fbm( uv, 3.0, 2, 39.0 ) );
	col = mix( col, vec3( 0.2, 0.23, 0.11 ), li * 0.6 );
	float li2 = smoothstep( 0.7, 0.78, fbm( uv, 30.0, 2, 40.0 ) );
	col = mix( col, vec3( 0.32, 0.17, 0.05 ), li2 * 0.35 );
	ao = 0.45 + 0.55 * sat( h * 1.6 );
	rough = 0.78 + 0.14 * fine;
	alpha = h;
}`,
  },
  sand: {
    bump: 0.02,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 3.0, 4, 41.0 );
	float warp = fbm( uv, 4.0, 3, 42.0 );
	float ripple = sin( ( uv.y * 34.0 + warp * 5.0 ) * 2.0 * PI ) * 0.5 + 0.5;
	float grain = fbm( uv, 150.0, 2, 43.0 );
	vec3 st = worley( uv, 30.0, 44.0 );
	float pebble = smoothstep( 0.22, 0.1, st.x ) * step( 0.7, st.z );
	h = sat( big * 0.4 + ripple * 0.2 + grain * 0.1 + pebble * 0.5 );
	col = mix( vec3( 0.23, 0.19, 0.13 ), vec3( 0.42, 0.36, 0.26 ), sat( big + ripple * 0.25 ) );
	col *= 0.85 + 0.3 * grain;
	col = mix( col, vec3( 0.2, 0.2, 0.19 ) * ( 0.6 + st.z ), pebble );
	ao = 0.7 + 0.3 * h;
	rough = 0.88;
	alpha = h;
}`,
  },
  bark: {
    bump: 0.12,
    size: 512,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float warp = fbm( uv, vec2( 4.0, 2.0 ), 3, 51.0 );
	vec3 w = worley( uv + vec2( warp * 0.06, 0.0 ), vec2( 9.0, 2.0 ), 52.0 );
	float plate = smoothstep( 0.0, 0.16, w.y - w.x );
	float fine = fbm( uv, vec2( 60.0, 12.0 ), 3, 53.0 );
	h = sat( plate * ( 0.55 + 0.45 * w.z ) + fine * 0.2 );
	vec3 crev = vec3( 0.03, 0.022, 0.018 );
	vec3 body = mix( vec3( 0.105, 0.075, 0.055 ), vec3( 0.2, 0.15, 0.115 ), w.z );
	col = mix( crev, body, plate ) * ( 0.75 + 0.5 * fine );
	col = mix( col, vec3( 0.16, 0.17, 0.13 ), smoothstep( 0.62, 0.8, fbm( uv, 6.0, 3, 54.0 ) ) * 0.35 );
	ao = 0.4 + 0.6 * plate;
	rough = 0.93;
	alpha = h;
}`,
  },
  birchBark: {
    bump: 0.03,
    size: 512,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float n = fbm( uv, vec2( 3.0, 14.0 ), 4, 61.0 );
	float mark = smoothstep( 0.62, 0.7, fbm( uv, vec2( 5.0, 22.0 ), 3, 62.0 ) );
	vec3 w = worley( uv, vec2( 3.0, 6.0 ), 63.0 );
	float knot = smoothstep( 0.2, 0.08, w.x ) * step( 0.7, w.z );
	h = sat( 0.6 + n * 0.2 - mark * 0.4 - knot * 0.5 );
	col = mix( vec3( 0.55, 0.53, 0.48 ), vec3( 0.78, 0.76, 0.7 ), n );
	col = mix( col, vec3( 0.05, 0.045, 0.04 ), max( mark, knot ) );
	ao = 0.75 + 0.25 * h;
	rough = 0.7;
	alpha = h;
}`,
  },
  concrete: {
    bump: 0.012,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 2.0, 6, 71.0 );
	float mid = fbm( uv, 9.0, 4, 72.0 );
	float fine = fbm( uv, 90.0, 3, 73.0 );
	vec3 pore = worley( uv, 90.0, 74.0 );
	float pores = smoothstep( 0.16, 0.06, pore.x ) * step( 0.55, pore.z );
	vec3 cr = worley( uv + ( fbm( uv, 6.0, 3, 75.0 ) - 0.5 ) * 0.1, 3.0, 76.0 );
	float crack = 1.0 - smoothstep( 0.0, 0.012, cr.y - cr.x ) * 1.0;
	crack *= smoothstep( 0.35, 0.6, fbm( uv, 2.0, 2, 77.0 ) );
	// formwork board lines every third of the tile
	float board = smoothstep( 0.012, 0.0, abs( fract( uv.y * 3.0 ) - 0.5 ) - 0.488 );
	h = sat( 0.6 + mid * 0.2 + fine * 0.1 - pores * 0.5 - crack * 0.7 - board * 0.25 );
	col = mix( vec3( 0.2, 0.2, 0.19 ), vec3( 0.36, 0.355, 0.335 ), sat( big * 1.3 - 0.15 ) );
	col *= 0.85 + 0.3 * mid;
	// rain streaks and damp staining
	float streak = fbm( uv, vec2( 26.0, 2.0 ), 3, 78.0 );
	col *= 1.0 - smoothstep( 0.5, 0.78, streak ) * 0.28;
	col = mix( col, col * vec3( 0.75, 0.8, 0.62 ), smoothstep( 0.6, 0.85, fbm( uv, 3.0, 4, 79.0 ) ) * 0.35 );
	col *= 1.0 - pores * 0.5;
	col *= 1.0 - crack * 0.75;
	col *= 1.0 - board * 0.2;
	ao = 0.7 + 0.3 * h;
	rough = 0.86 - mid * 0.1;
	alpha = h;
}`,
  },
  asphalt: {
    bump: 0.014,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 2.0, 5, 81.0 );
	vec3 ag = worley( uv, 120.0, 82.0 );
	vec3 ag2 = worley( uv, 55.0, 83.0 );
	float stone = smoothstep( 0.42, 0.2, ag.x );
	float stone2 = smoothstep( 0.3, 0.14, ag2.x ) * step( 0.6, ag2.z );
	vec3 cr = worley( uv + ( fbm( uv, 7.0, 3, 84.0 ) - 0.5 ) * 0.12, 4.0, 85.0 );
	float crack = ( 1.0 - smoothstep( 0.0, 0.014, cr.y - cr.x ) ) * smoothstep( 0.4, 0.62, fbm( uv, 2.0, 3, 86.0 ) );
	h = sat( 0.45 + stone * 0.3 + stone2 * 0.2 - crack * 0.8 );
	col = mix( vec3( 0.022, 0.022, 0.024 ), vec3( 0.06, 0.06, 0.062 ), big );
	col = mix( col, vec3( 0.1, 0.1, 0.098 ) * ( 0.5 + ag.z ), stone * 0.7 );
	col = mix( col, vec3( 0.17, 0.16, 0.15 ) * ( 0.5 + ag2.z ), stone2 * 0.6 );
	// worn, paler patches and oil stains
	col = mix( col, col * 1.6 + 0.008, smoothstep( 0.52, 0.72, fbm( uv, 3.0, 4, 87.0 ) ) * 0.5 );
	col *= 1.0 - smoothstep( 0.68, 0.8, fbm( uv, 5.0, 3, 88.0 ) ) * 0.45;
	col *= 1.0 - crack * 0.8;
	ao = 0.75 + 0.25 * h;
	rough = 0.8 + stone * 0.1 - smoothstep( 0.68, 0.8, fbm( uv, 5.0, 3, 88.0 ) ) * 0.35;
	alpha = h;
}`,
  },
  brick: {
    bump: 0.016,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	vec2 g = vec2( 8.0, 24.0 );
	float row = floor( uv.y * g.y );
	vec2 p = vec2( uv.x * g.x + mod( row, 2.0 ) * 0.5, uv.y * g.y );
	vec2 id = mod( floor( p ), g );
	vec2 f = fract( p );
	float edge = min( min( f.x, 1.0 - f.x ) * 3.0, min( f.y, 1.0 - f.y ) );
	float wobble = fbm( uv, 40.0, 3, 91.0 ) * 0.06;
	float brick = smoothstep( 0.05 + wobble, 0.13 + wobble, edge );
	float tone = hash1( id, 92.0 );
	float tone2 = hash1( id, 93.0 );
	float fine = fbm( uv, 110.0, 3, 94.0 );
	float chips = smoothstep( 0.62, 0.75, fbm( uv, 26.0, 3, 95.0 ) );
	h = sat( brick * ( 0.7 + tone * 0.2 - chips * 0.25 ) + fine * 0.12 );
	vec3 base = mix( vec3( 0.19, 0.065, 0.04 ), vec3( 0.34, 0.14, 0.085 ), tone );
	base = mix( base, vec3( 0.12, 0.07, 0.055 ), step( 0.82, tone2 ) * 0.8 );
	base *= 0.75 + 0.5 * fine;
	vec3 mortar = vec3( 0.32, 0.3, 0.27 ) * ( 0.7 + 0.5 * fine );
	col = mix( mortar, base, brick );
	// soot and efflorescence
	col *= 1.0 - smoothstep( 0.45, 0.8, fbm( uv, vec2( 12.0, 2.0 ), 4, 96.0 ) ) * 0.4;
	col = mix( col, vec3( 0.4, 0.38, 0.35 ), smoothstep( 0.66, 0.85, fbm( uv, 4.0, 4, 97.0 ) ) * 0.25 * brick );
	ao = 0.55 + 0.45 * brick;
	rough = 0.9;
	alpha = h;
}`,
  },
  corrugated: {
    bump: 0.035,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float rib = 0.5 + 0.5 * cos( uv.x * 12.0 * 2.0 * PI );
	rib = smoothstep( 0.15, 0.85, rib );
	float fine = fbm( uv, 60.0, 3, 101.0 );
	float big = fbm( uv, 3.0, 5, 102.0 );
	float rustM = smoothstep( 0.5, 0.72, fbm( uv, vec2( 7.0, 3.0 ), 5, 103.0 ) + ( 1.0 - rib ) * 0.08 );
	float drip = smoothstep( 0.55, 0.8, fbm( uv, vec2( 40.0, 2.0 ), 3, 104.0 ) ) * smoothstep( 0.3, 0.7, big );
	h = sat( rib * 0.85 + fine * 0.05 - rustM * 0.06 );
	vec3 paint = vec3( 0.72, 0.72, 0.7 ) * ( 0.82 + 0.3 * big );
	vec3 rust = mix( vec3( 0.16, 0.06, 0.025 ), vec3( 0.36, 0.15, 0.05 ), fine );
	col = mix( paint, rust, rustM * 0.92 );
	col = mix( col, rust * 0.8, drip * 0.45 );
	col *= 0.88 + 0.12 * rib;
	ao = 0.6 + 0.4 * rib;
	rough = mix( 0.42, 0.88, rustM ) + fine * 0.08;
	alpha = h;
}`,
  },
  rust: {
    bump: 0.02,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 3.0, 6, 111.0 );
	float fine = fbm( uv, 70.0, 4, 112.0 );
	vec3 w = worley( uv, 30.0, 113.0 );
	float flake = smoothstep( 0.0, 0.1, w.y - w.x );
	h = sat( big * 0.5 + fine * 0.3 ) * ( 0.6 + 0.4 * flake );
	vec3 a = vec3( 0.1, 0.035, 0.018 );
	vec3 b = vec3( 0.3, 0.115, 0.04 );
	vec3 c = vec3( 0.45, 0.22, 0.07 );
	col = mix( a, b, sat( big * 1.5 - 0.2 ) );
	col = mix( col, c, smoothstep( 0.55, 0.8, fine ) * 0.6 );
	col = mix( col, vec3( 0.07, 0.07, 0.075 ), smoothstep( 0.62, 0.75, fbm( uv, 5.0, 3, 114.0 ) ) * 0.6 );
	col *= 0.7 + 0.3 * flake;
	ao = 0.6 + 0.4 * h;
	rough = 0.86;
	alpha = h;
}`,
  },
  metal: {
    bump: 0.004,
    size: 512,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 3.0, 5, 121.0 );
	float scratch = fbm( uv, vec2( 4.0, 220.0 ), 3, 122.0 );
	float scratch2 = fbm( uv, vec2( 180.0, 6.0 ), 2, 123.0 );
	float fine = fbm( uv, 90.0, 2, 124.0 );
	h = sat( 0.5 + ( scratch - 0.5 ) * 0.5 + ( scratch2 - 0.5 ) * 0.3 );
	col = vec3( 0.74, 0.74, 0.74 ) * ( 0.84 + 0.22 * big ) * ( 0.94 + 0.12 * fine );
	col *= 1.0 - smoothstep( 0.6, 0.85, fbm( uv, 6.0, 4, 125.0 ) ) * 0.25;
	ao = 1.0;
	rough = 0.36 + ( scratch - 0.5 ) * 0.3 + big * 0.2;
	alpha = h;
}`,
  },
  planks: {
    bump: 0.03,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float n = 6.0;
	float pid = floor( uv.y * n );
	float fy = fract( uv.y * n );
	float tone = hash1( vec2( pid, 3.0 ), 131.0 );
	float off = hash1( vec2( pid, 9.0 ), 132.0 );
	vec2 q = vec2( uv.x + off, uv.y );
	float grain = fbm( q, vec2( 3.0, 90.0 ), 4, 133.0 + pid );
	float grain2 = fbm( q, vec2( 8.0, 240.0 ), 2, 134.0 );
	vec3 kn = worley( q, vec2( 2.0, 6.0 ), 135.0 );
	float knot = smoothstep( 0.14, 0.03, kn.x ) * step( 0.78, kn.z );
	float gap = smoothstep( 0.0, 0.035, min( fy, 1.0 - fy ) );
	// butt joints
	float jx = fract( uv.x * 2.0 + off );
	float joint = smoothstep( 0.0, 0.006, min( jx, 1.0 - jx ) );
	h = sat( ( 0.55 + ( grain - 0.5 ) * 0.5 + ( grain2 - 0.5 ) * 0.15 - knot * 0.2 ) * gap * joint );
	vec3 wood = mix( vec3( 0.13, 0.095, 0.065 ), vec3( 0.33, 0.25, 0.17 ), tone * 0.6 + grain * 0.5 );
	wood = mix( wood, vec3( 0.36, 0.35, 0.33 ), smoothstep( 0.4, 0.8, fbm( uv, 3.0, 3, 136.0 ) ) * 0.45 );
	col = wood * ( 0.8 + 0.4 * grain2 );
	col = mix( col, vec3( 0.06, 0.04, 0.03 ), knot );
	col *= ( 0.25 + 0.75 * gap ) * ( 0.4 + 0.6 * joint );
	ao = 0.5 + 0.5 * gap * joint;
	rough = 0.82;
	alpha = h;
}`,
  },
  carbon: {
    bump: 0.006,
    size: 256,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	vec2 p = uv * 16.0;
	vec2 c = floor( p );
	vec2 f = fract( p );
	float twill = mod( c.x + c.y, 4.0 ) < 2.0 ? 1.0 : 0.0;
	float along = twill > 0.5 ? f.x : f.y;
	float across = twill > 0.5 ? f.y : f.x;
	float fibre = 0.5 + 0.5 * sin( across * 6.0 * PI );
	float arch = sin( along * PI );
	h = sat( 0.4 + arch * 0.4 + fibre * 0.15 );
	col = vec3( 0.022 ) + vec3( 0.055 ) * arch * ( 0.5 + 0.5 * fibre );
	ao = 0.8 + 0.2 * arch;
	rough = 0.28 + 0.2 * ( 1.0 - arch );
	alpha = h;
}`,
  },
  fabric: {
    bump: 0.004,
    size: 256,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float wx = 0.5 + 0.5 * sin( uv.x * 96.0 * 2.0 * PI );
	float wy = 0.5 + 0.5 * sin( uv.y * 96.0 * 2.0 * PI );
	float big = fbm( uv, 3.0, 4, 141.0 );
	h = sat( wx * wy * 0.6 + 0.3 );
	col = vec3( 0.86 ) * ( 0.84 + 0.16 * wx * wy ) * ( 0.9 + 0.2 * big );
	ao = 0.9 + 0.1 * h;
	rough = 0.78;
	alpha = h;
}`,
  },
  plaster: {
    bump: 0.008,
    glsl: /* glsl */ `
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	float big = fbm( uv, 2.0, 6, 151.0 );
	float fine = fbm( uv, 80.0, 3, 152.0 );
	float peel = smoothstep( 0.56, 0.6, fbm( uv, 5.0, 5, 153.0 ) );
	float streak = fbm( uv, vec2( 30.0, 2.0 ), 3, 154.0 );
	h = sat( 0.7 - peel * 0.4 + fine * 0.1 );
	vec3 paint = vec3( 0.62, 0.61, 0.56 ) * ( 0.85 + 0.25 * big );
	vec3 under = vec3( 0.3, 0.29, 0.27 ) * ( 0.8 + 0.4 * fine );
	col = mix( paint, under, peel );
	col *= 1.0 - smoothstep( 0.5, 0.8, streak ) * 0.22;
	col = mix( col, col * vec3( 0.7, 0.72, 0.55 ), smoothstep( 0.55, 0.85, fbm( uv, 3.0, 4, 155.0 ) ) * 0.4 );
	ao = 0.8 + 0.2 * h;
	rough = 0.85;
	alpha = h;
}`,
  },
  // ---- cut-outs -------------------------------------------------------------------------------
  needles: {
    bump: 0.02,
    size: 512,
    cutout: true,
    glsl: /* glsl */ `
// a conifer bough: a twig along +U with needle fans and a few side shoots
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	vec2 p = vec2( uv.x, ( uv.y - 0.55 ) * 0.5 / 0.9 );
	float d = 1e3;
	float shade = 0.0;
	float twig = sdSeg( p, vec2( 0.0, 0.0 ), vec2( 0.97, 0.0 ) ) - mix( 0.012, 0.003, uv.x );
	for ( int s = 0; s < 14; s ++ ) {
		// side shoots, alternating sides, shorter towards the tip
		float fs = float( s );
		float t0 = 0.04 + fs * 0.066;
		float side = mod( fs, 2.0 ) < 1.0 ? 1.0 : -1.0;
		float len = ( 0.34 - t0 * 0.26 ) * ( 0.8 + 0.4 * hash1( vec2( fs, 1.0 ), 161.0 ) );
		vec2 a = vec2( t0, 0.0 );
		vec2 dirS = normalize( vec2( 0.78, side * 0.6 ) );
		vec2 b = a + dirS * len;
		twig = min( twig, sdSeg( p, a, b ) - 0.004 );
		for ( int k = 0; k < 22; k ++ ) {
			float fk = float( k ) / 21.0;
			vec2 base = mix( a, b, fk );
			float sgn = mod( float( k ), 2.0 ) < 1.0 ? 1.0 : -1.0;
			vec2 nd = normalize( dirS * 0.75 + vec2( -dirS.y, dirS.x ) * sgn * 0.7 );
			float nl = 0.06 * ( 1.0 - fk * 0.4 ) * ( 0.75 + 0.5 * hash1( vec2( fs, float( k ) ), 162.0 ) );
			float dn = sdSeg( p, base, base + nd * nl ) - 0.0042;
			if ( dn < d ) { d = dn; shade = fk; }
		}
	}
	for ( int k = 0; k < 64; k ++ ) {
		float fk = float( k ) / 63.0;
		vec2 base = vec2( 0.02 + fk * 0.95, 0.0 );
		float sgn = mod( float( k ), 2.0 ) < 1.0 ? 1.0 : -1.0;
		vec2 nd = normalize( vec2( 0.62, sgn * 0.78 ) );
		float nl = 0.065 * ( 1.0 - fk * 0.45 ) * ( 0.75 + 0.5 * hash1( vec2( float( k ), 5.0 ), 163.0 ) );
		float dn = sdSeg( p, base, base + nd * nl ) - 0.0042;
		if ( dn < d ) { d = dn; shade = fk; }
	}
	float needle = smoothstep( 0.003, -0.002, d );
	float wood = smoothstep( 0.002, -0.002, twig );
	alpha = max( needle, wood );
	float n = fbm( uv, 30.0, 3, 164.0 );
	vec3 green = mix( vec3( 0.022, 0.05, 0.022 ), vec3( 0.07, 0.125, 0.04 ), sat( shade * 0.7 + n * 0.5 ) );
	col = mix( green, vec3( 0.07, 0.05, 0.035 ), wood * ( 1.0 - needle * 0.6 ) );
	h = alpha * ( 0.5 + 0.5 * n );
	ao = 0.7 + 0.3 * shade;
	rough = 0.6;
	// opaque strip along the bottom edge: trunk bark, so one material covers the whole tree
	if ( uv.y < 0.075 ) {
		vec3 w = worley( uv, vec2( 6.0, 26.0 ), 165.0 );
		float plate = smoothstep( 0.0, 0.2, w.y - w.x );
		float fine = fbm( uv, vec2( 16.0, 90.0 ), 3, 166.0 );
		col = mix( vec3( 0.03, 0.022, 0.018 ), mix( vec3( 0.1, 0.07, 0.05 ), vec3( 0.19, 0.14, 0.1 ), w.z ), plate ) * ( 0.75 + 0.5 * fine );
		alpha = 1.0;
		h = plate;
	}
}`,
  },
  leaves: {
    bump: 0.02,
    size: 512,
    cutout: true,
    glsl: /* glsl */ `
// a spray of small broad leaves
void surf( vec2 uv, out vec3 col, out float h, out float rough, out float ao, out float alpha ) {
	alpha = 0.0;
	col = vec3( 0.0 );
	h = 0.0;
	float tw = sdSeg( uv, vec2( 0.5, 0.12 ), vec2( 0.5, 0.75 ) ) - 0.006;
	for ( int k = 0; k < 46; k ++ ) {
		float fk = float( k );
		vec2 r = hash2( vec2( fk, 3.0 ), 171.0 );
		vec2 r2 = hash2( vec2( fk, 7.0 ), 172.0 );
		vec2 c = vec2( 0.5 + ( r.x - 0.5 ) * 0.84 * ( 0.35 + r.y ), 0.2 + r.y * 0.72 );
		float ang = ( r2.x - 0.5 ) * 2.6 + ( c.x - 0.5 ) * 2.0;
		float sz = 0.055 + r2.y * 0.04;
		vec2 q = uv - c;
		q = mat2( cos( ang ), -sin( ang ), sin( ang ), cos( ang ) ) * q;
		// pointed oval
		float lw = sz * 0.55 * ( 1.0 - smoothstep( 0.0, 1.0, abs( q.y ) / sz ) * 0.9 );
		float inside = smoothstep( 0.003, -0.003, abs( q.x ) - lw ) * step( abs( q.y ), sz );
		if ( inside > alpha ) {
			alpha = inside;
			float vein = smoothstep( 0.004, 0.0, abs( q.x ) );
			float tone = hash1( vec2( fk, 11.0 ), 173.0 );
			vec3 g = mix( vec3( 0.07, 0.14, 0.02 ), vec3( 0.2, 0.26, 0.035 ), tone );
			g = mix( g, vec3( 0.36, 0.3, 0.03 ), step( 0.82, tone ) * 0.8 );
			col = g * ( 0.8 + 0.4 * ( 1.0 - abs( q.x ) / max( lw, 0.001 ) ) ) * ( 1.0 - vein * 0.25 );
			h = 0.5 + 0.5 * ( 1.0 - abs( q.x ) / max( lw, 0.001 ) );
		}
	}
	float wood = smoothstep( 0.002, -0.002, tw );
	if ( wood > alpha ) { alpha = wood; col = vec3( 0.08, 0.06, 0.04 ); h = 0.5; }
	ao = 0.85;
	rough = 0.55;
	// opaque strip along the bottom edge: pale birch bark
	if ( uv.y < 0.075 ) {
		float n = fbm( uv, vec2( 8.0, 40.0 ), 3, 174.0 );
		float mark = smoothstep( 0.6, 0.68, fbm( uv, vec2( 30.0, 20.0 ), 3, 175.0 ) );
		col = mix( mix( vec3( 0.5, 0.48, 0.43 ), vec3( 0.74, 0.72, 0.66 ), n ), vec3( 0.05, 0.045, 0.04 ), mark );
		alpha = 1.0;
		h = 0.6;
	}
}`,
  },
} satisfies Record<string, Recipe>;

export type TexName = keyof typeof RECIPES;

/** Renders recipes into mip-mapped, tileable texture sets, once each. */
export class TextureForge {
  private cache = new Map<string, TexSet>();
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private scene = new Scene();
  private mesh: Mesh;

  constructor(private renderer: WebGLRenderer, public anisotropy: number) {
    this.mesh = new Mesh(fullscreenTriangle());
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get(name: TexName): TexSet {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const recipe = RECIPES[name] as Recipe;
    const size = recipe.size ?? 1024;
    const out: Texture[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const rt = new WebGLRenderTarget(size, size, {
        type: UnsignedByteType,
        format: RGBAFormat,
        depthBuffer: false,
        generateMipmaps: true,
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
        wrapS: RepeatWrapping,
        wrapT: RepeatWrapping,
        colorSpace: pass === 0 ? SRGBColorSpace : LinearSRGBColorSpace,
        anisotropy: this.anisotropy,
      });
      const mat = new ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
        fragmentShader: LIB + recipe.glsl + MAIN,
        uniforms: { uTexel: { value: 1 / size }, uBump: { value: recipe.bump } },
        defines: { OUTPUT: pass },
        depthTest: false,
        depthWrite: false,
      });
      this.mesh.material = mat;
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, this.cam);
      this.renderer.setRenderTarget(prev);
      mat.dispose();
      out.push(rt.texture);
    }
    const set: TexSet = { map: out[0], normalMap: out[1], orm: out[2] };
    this.cache.set(name, set);
    return set;
  }
}
