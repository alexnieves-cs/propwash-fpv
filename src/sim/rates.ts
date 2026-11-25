/**
 * Betaflight rate curves: stick deflection (-1..1) to rotation rate (deg/s).
 *
 * Ported from Betaflight 4.5.1, src/main/fc/rc.c (applyBetaflightRates, applyRaceFlightRates,
 * applyKissRates, applyActualRates, applyQuickRates, and the per-axis rate_limit clamp in
 * calculateSetpointRate). Defaults and CLI limits come from src/main/fc/controlrate_profile.c,
 * src/main/fc/rc_controls.h and src/main/cli/settings.c of the same tag:
 * https://github.com/betaflight/betaflight/tree/4.5.1/src/main
 *
 * Parameters are kept in Betaflight's own integer CLI units (`roll_rc_rate = 7` and so on), so
 * a pasted `diff` round-trips exactly. Betaflight computes in 32-bit floats; this computes in
 * doubles, which differs by well under 0.01 deg/s.
 */

export type RatesType = 'BETAFLIGHT' | 'RACEFLIGHT' | 'KISS' | 'ACTUAL' | 'QUICK';
export const RATES_TYPES: RatesType[] = ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'];

export type RateAxis = 'roll' | 'pitch' | 'yaw';
export const RATE_AXES: RateAxis[] = ['roll', 'pitch', 'yaw'];

/** One axis in Betaflight CLI units. */
export interface AxisRateConfig {
  /** `<axis>_rc_rate`, 1..255 */
  rcRate: number;
  /** `<axis>_expo`, 0..100 */
  expo: number;
  /** `<axis>_srate`, 0..255 */
  rate: number;
  /** `<axis>_rate_limit`, 200..1998 deg/s */
  limit: number;
}

export interface RateProfile {
  type: RatesType;
  /** `quickrates_rc_expo`: Quick rates apply expo to the stick instead of to the super factor */
  quickRcExpo: boolean;
  roll: AxisRateConfig;
  pitch: AxisRateConfig;
  yaw: AxisRateConfig;
}

/** CLI ranges from settings.c and rc_controls.h. */
export const LIMITS = {
  rcRate: [1, 255],
  expo: [0, 100],
  rate: [0, 255],
  limit: [200, 1998],
} as const satisfies Record<keyof AxisRateConfig, readonly [number, number]>;

/** SETPOINT_RATE_LIMIT_MAX in rc.c. */
const SETPOINT_RATE_LIMIT = 1998;
/** RC_RATE_INCREMENTAL in rc.c: Betaflight-type rc_rate above 2.0 ramps up faster. */
const RC_RATE_INCREMENTAL = 14.54;

/** Betaflight's default rate profile (controlrate_profile.c, pgResetFn_controlRateProfiles). */
export function betaflightDefaults(): RateProfile {
  const axis = (): AxisRateConfig => ({ rcRate: 7, expo: 0, rate: 67, limit: 1998 });
  return { type: 'ACTUAL', quickRcExpo: false, roll: axis(), pitch: axis(), yaw: axis() };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const power3 = (x: number): number => x * x * x;
const power5 = (x: number): number => x * x * x * x * x;

function betaflight(c: number, a: AxisRateConfig): number {
  const abs = Math.abs(c);
  if (a.expo) {
    const expof = a.expo / 100;
    c = c * power3(abs) * expof + c * (1 - expof);
  }
  let rcRate = a.rcRate / 100;
  if (rcRate > 2) rcRate += RC_RATE_INCREMENTAL * (rcRate - 2);
  let angleRate = 200 * rcRate * c;
  if (a.rate) {
    const superFactor = 1 / clamp(1 - abs * (a.rate / 100), 0.01, 1);
    angleRate *= superFactor;
  }
  return angleRate;
}

function raceflight(c: number, a: AxisRateConfig): number {
  const abs = Math.abs(c);
  c = (1 + 0.01 * a.expo * (c * c - 1)) * c;
  let angleRate = 10 * a.rcRate * c;
  angleRate *= 1 + abs * a.rate * 0.01;
  return angleRate;
}

function kiss(c: number, a: AxisRateConfig): number {
  const abs = Math.abs(c);
  const rcCurve = a.expo / 100;
  const useRates = 1 / clamp(1 - abs * (a.rate / 100), 0.01, 1);
  const cmd = (power3(c) * rcCurve + c * (1 - rcCurve)) * (a.rcRate / 1000);
  return clamp(2000 * useRates * cmd, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT);
}

function actual(c: number, a: AxisRateConfig): number {
  const abs = Math.abs(c);
  const e = a.expo / 100;
  const expof = abs * (power5(c) * e + c * (1 - e));
  const centerSensitivity = a.rcRate * 10;
  const stickMovement = Math.max(0, a.rate * 10 - centerSensitivity);
  return c * centerSensitivity + stickMovement * expof;
}

function quick(c: number, a: AxisRateConfig, rcExpo: boolean): number {
  const abs = Math.abs(c);
  // Betaflight holds these two in uint16_t: both are whole numbers here as well
  const rcRate = a.rcRate * 2;
  const maxDps = Math.max(a.rate * 10, rcRate);
  const e = a.expo / 100;
  const superFactorConfig = (maxDps / rcRate - 1) / (maxDps / rcRate);
  if (rcExpo) {
    const curve = power3(c) * e + c * (1 - e);
    const superFactor = 1 / clamp(1 - abs * superFactorConfig, 0.01, 1);
    return clamp(curve * rcRate * superFactor, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT);
  }
  const curve = power3(abs) * e + abs * (1 - e);
  const superFactor = 1 / clamp(1 - curve * superFactorConfig, 0.01, 1);
  return clamp(c * rcRate * superFactor, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT);
}

/** The curve alone, before the per-axis rate limit (Betaflight's applyRates). */
export function curveDps(stick: number, type: RatesType, a: AxisRateConfig, quickRcExpo = false): number {
  const c = clamp(stick, -1, 1);
  switch (type) {
    case 'RACEFLIGHT':
      return raceflight(c, a);
    case 'KISS':
      return kiss(c, a);
    case 'ACTUAL':
      return actual(c, a);
    case 'QUICK':
      return quick(c, a, quickRcExpo);
    case 'BETAFLIGHT':
    default:
      return betaflight(c, a);
  }
}

/** Rate setpoint in deg/s for one axis, with Betaflight's `rate_limit` clamp applied. */
export function rateDps(stick: number, p: RateProfile, axis: RateAxis): number {
  const a = p[axis];
  const v = curveDps(stick, p.type, a, p.quickRcExpo);
  return clamp(v, -a.limit, a.limit);
}

/** Slope at the stick centre, deg/s per unit of stick (taken over the first 0.001% of travel). */
export function centreSensitivity(p: RateProfile, axis: RateAxis): number {
  return rateDps(1e-5, p, axis) / 1e-5;
}

// ---------------------------------------------------------------------------------------------
// CLI import and export
// ---------------------------------------------------------------------------------------------

export interface RateImport {
  profile: RateProfile;
  /** the `rateprofile` the result came from, when the text named one */
  rateProfile: number | null;
  /** settings that were read, as `name = value` */
  applied: string[];
  /** lines that were not understood or were out of range */
  problems: string[];
  /** count of other `set` lines, which belong to settings this importer does not use */
  otherSettings: number;
  /** settings found under rate profiles other than the selected one */
  otherProfiles: number[];
}

const AXIS_KEYS: Record<string, keyof AxisRateConfig> = { rc_rate: 'rcRate', expo: 'expo', srate: 'rate', rate_limit: 'limit' };

/**
 * Read Betaflight CLI output (`diff`, `diff all`, `dump`, or hand-written `set` lines) and pull
 * out the rate settings. `diff` only lists values that differ from the defaults, so anything not
 * mentioned keeps Betaflight's defaults (those of 4.3 and later: Actual rates, 70 deg/s centre,
 * 670 deg/s max). With several rate profiles, the one selected at the end of the text is used,
 * which is how `diff all` restores the active profile.
 */
export function parseBetaflightRates(text: string): RateImport {
  const profiles = new Map<number, Map<string, string>>();
  const loose = new Map<string, string>();
  let current: number | null = null;
  const problems: string[] = [];
  let otherSettings = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const rp = /^rateprofile\s+(\d+)$/i.exec(line);
    if (rp) {
      current = Number(rp[1]);
      if (!profiles.has(current)) profiles.set(current, new Map());
      continue;
    }
    const m = /^(?:set\s+)?([a-z0-9_]+)\s*=\s*(\S+)\s*$/i.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const value = m[2];
    if (!isRateSetting(name)) {
      if (/^set\s/i.test(line)) otherSettings++;
      continue;
    }
    (current === null ? loose : profiles.get(current)!).set(name, value);
  }

  // settings before any `rateprofile` line apply to whichever profile is active
  const chosen = new Map<string, string>(loose);
  if (current !== null) for (const [k, v] of profiles.get(current) ?? []) chosen.set(k, v);
  const otherProfiles = [...profiles.entries()].filter(([i, s]) => i !== current && s.size > 0).map(([i]) => i);

  const profile = betaflightDefaults();
  const applied: string[] = [];
  for (const [name, value] of chosen) {
    if (name === 'rates_type') {
      const t = value.toUpperCase() as RatesType;
      if (RATES_TYPES.includes(t)) {
        profile.type = t;
        applied.push(`${name} = ${t}`);
      } else problems.push(`${name} = ${value}: not a rate type this sim knows`);
      continue;
    }
    if (name === 'quickrates_rc_expo') {
      const v = value.toUpperCase();
      if (v === 'ON' || v === 'OFF') {
        profile.quickRcExpo = v === 'ON';
        applied.push(`${name} = ${v}`);
      } else problems.push(`${name} = ${value}: expected ON or OFF`);
      continue;
    }
    const [axis, ...rest] = name.split('_');
    const key = AXIS_KEYS[rest.join('_')];
    const n = Number(value);
    const [lo, hi] = LIMITS[key];
    if (!Number.isInteger(n) || n < lo || n > hi) {
      problems.push(`${name} = ${value}: outside Betaflight's range ${lo} to ${hi}`);
      continue;
    }
    profile[axis as RateAxis][key] = n;
    applied.push(`${name} = ${n}`);
  }
  return { profile, rateProfile: current, applied, problems, otherSettings, otherProfiles };
}

function isRateSetting(name: string): boolean {
  if (name === 'rates_type' || name === 'quickrates_rc_expo') return true;
  const m = /^(roll|pitch|yaw)_(rc_rate|expo|srate|rate_limit)$/.exec(name);
  return m !== null;
}

/** The profile as Betaflight CLI `set` lines, ready to paste into the CLI. */
export function formatBetaflightRates(p: RateProfile): string {
  const lines = [`set rates_type = ${p.type}`];
  if (p.type === 'QUICK') lines.push(`set quickrates_rc_expo = ${p.quickRcExpo ? 'ON' : 'OFF'}`);
  for (const axis of RATE_AXES) {
    const a = p[axis];
    lines.push(`set ${axis}_rc_rate = ${a.rcRate}`, `set ${axis}_expo = ${a.expo}`, `set ${axis}_srate = ${a.rate}`, `set ${axis}_rate_limit = ${a.limit}`);
  }
  return lines.join('\n');
}

/** Rebuild a rate profile from stored JSON; anything missing or out of range falls back to Betaflight's defaults. */
export function sanitizeRateProfile(x: unknown): RateProfile {
  const d = betaflightDefaults();
  if (!x || typeof x !== 'object') return d;
  const o = x as Record<string, unknown>;
  const axis = (v: unknown, base: AxisRateConfig): AxisRateConfig => {
    const a = (v ?? {}) as Record<string, unknown>;
    const out = { ...base };
    for (const key of Object.keys(LIMITS) as (keyof AxisRateConfig)[]) {
      const n = a[key];
      const [lo, hi] = LIMITS[key];
      if (typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi) out[key] = n;
    }
    return out;
  };
  return {
    type: RATES_TYPES.includes(o.type as RatesType) ? (o.type as RatesType) : d.type,
    quickRcExpo: o.quickRcExpo === true,
    roll: axis(o.roll, d.roll),
    pitch: axis(o.pitch, d.pitch),
    yaw: axis(o.yaw, d.yaw),
  };
}
