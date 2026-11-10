/** Small numeric toolkit shared by the simulation and the renderer. */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TAU = Math.PI * 2;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const saturate = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number): number => (x - a) / (b - a);
export const remap = (x: number, a: number, b: number, c: number, d: number): number =>
  c + (d - c) * saturate((x - a) / (b - a));

export function smoothstep(a: number, b: number, x: number): number {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Move `current` towards `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1];

/** Seeded 2D simplex noise with fractal helpers. Output of `noise` is in roughly [-1, 1]. */
export class Noise2D {
  private perm = new Uint8Array(512);

  constructor(seed = 1) {
    const rng = makeRng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise(x: number, y: number): number {
    const perm = this.perm;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) {
      const g = (perm[ii + perm[jj]] & 7) * 2;
      tt *= tt;
      n += tt * tt * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) {
      const g = (perm[ii + i1 + perm[jj + j1]] & 7) * 2;
      tt *= tt;
      n += tt * tt * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) {
      const g = (perm[ii + 1 + perm[jj + 1]] & 7) * 2;
      tt *= tt;
      n += tt * tt * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * n;
  }

  /** Fractal Brownian motion, normalised to about [-1, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq + o * 17.31, y * freq - o * 9.77);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1] — sharp crests, good for mountains. */
  ridged(x: number, y: number, octaves = 5, lacunarity = 2.1, gain = 0.5): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let prev = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const v = this.noise(x * freq + o * 31.7, y * freq + o * 11.3);
      // rounded crest: a hard crease aliases badly on coarse terrain cells
      let n = 1 - Math.sqrt(v * v + 0.012);
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = n;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/** First-order low-pass coefficient for a cutoff frequency (Hz) at step dt. */
export function pt1Gain(cutoffHz: number, dt: number): number {
  const rc = 1 / (TAU * cutoffHz);
  return dt / (rc + dt);
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
