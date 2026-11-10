import type { QualityId } from '../render/engine';

export type FlightModeId = 'cruise' | 'angle' | 'horizon' | 'acro';
export type CameraView = 'fpv' | 'chase' | 'los';
export type GameMode = 'freestyle' | 'race';

export interface Settings {
  quality: QualityId;
  dynamicResolution: boolean;
  drone: string;
  map: string;
  track: string;
  mode: GameMode;
  flightMode: FlightModeId;
  view: CameraView;
  camera: {
    /** vertical field of view of the FPV camera, degrees */
    fov: number;
    /** uptilt override in degrees, or null to use the airframe's own */
    tilt: number | null;
    /** 0..1 fisheye amount */
    distortion: number;
    /** 0..1 */
    motionBlur: number;
    /** film grain, chromatic aberration and vignette */
    lensEffects: boolean;
  };
  controls: {
    /** 'spring': throttle rests at hover and W/S push away from it. 'hold': W/S move a throttle that stays put. */
    throttle: 'spring' | 'hold';
    mouseStick: boolean;
    mouseSensitivity: number;
    /** how quickly a held key reaches full deflection: 0.5 gentle … 2 twitchy */
    keyResponse: number;
    /** multiplier on the airframe's rates */
    rateScale: number;
    invertPitch: boolean;
  };
  sim: {
    battery: boolean;
    crashDisarm: boolean;
    wind: boolean;
    ghost: boolean;
  };
  audio: { master: number; motors: number; effects: number; wind: number };
  hud: { sticks: boolean; horizon: boolean; units: 'kmh' | 'mph'; minimal: boolean };
  /** best total time per `${track}:${drone}` */
  records: Record<string, { total: number; bestLap: number; splits: number[] }>;
  bestCombo: Record<string, number>;
  seenIntro: boolean;
}

export const DEFAULTS: Settings = {
  quality: 'high',
  dynamicResolution: true,
  drone: 'freestyle5',
  map: 'alpine',
  track: '',
  mode: 'freestyle',
  flightMode: 'cruise',
  view: 'fpv',
  camera: { fov: 104, tilt: null, distortion: 0.5, motionBlur: 0.45, lensEffects: true },
  controls: { throttle: 'spring', mouseStick: false, mouseSensitivity: 1, keyResponse: 1, rateScale: 1, invertPitch: false },
  sim: { battery: true, crashDisarm: true, wind: true, ghost: true },
  audio: { master: 0.7, motors: 0.8, effects: 0.8, wind: 0.7 },
  hud: { sticks: true, horizon: true, units: 'kmh', minimal: false },
  records: {},
  bestCombo: {},
  seenIntro: false,
};

const KEY = 'propwash.settings.v1';

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return (over === undefined ? base : (over as T)) ?? base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? merge(out[k], v) : v;
  }
  return out as T;
}

/** Persistent user settings with change notification. */
export class SettingsStore {
  data: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor() {
    let saved: unknown = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      saved = null;
    }
    this.data = merge(structuredClone(DEFAULTS), saved ?? {});
  }

  subscribe(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mutate settings and persist. */
  update(fn: (s: Settings) => void): void {
    fn(this.data);
    this.save();
    for (const l of this.listeners) l(this.data);
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // storage full or unavailable: settings simply won't persist
    }
  }

  reset(): void {
    const keep = { records: this.data.records, bestCombo: this.data.bestCombo };
    this.data = { ...structuredClone(DEFAULTS), ...keep, seenIntro: true };
    this.save();
    for (const l of this.listeners) l(this.data);
  }
}

/** Ghost recordings are bulky, so they live under their own keys. */
export function loadGhost(key: string): number[] | null {
  try {
    const raw = localStorage.getItem('propwash.ghost.' + key);
    return raw ? (JSON.parse(raw) as number[]) : null;
  } catch {
    return null;
  }
}

export function saveGhost(key: string, flat: number[]): void {
  try {
    localStorage.setItem('propwash.ghost.' + key, JSON.stringify(flat));
  } catch {
    // ignore: a missing ghost is harmless
  }
}
