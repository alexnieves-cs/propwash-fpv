import type { DroneConfig } from './drone-config';
import { sanitizeRateProfile, type RateProfile } from './rates';

/**
 * A pilot's tune for one airframe. Either part may be missing, and an airframe with no tune at
 * all flies exactly as in v1.0.0.
 */
export interface AirframeTune {
  /** Betaflight-style rates, replacing the airframe's stock rates */
  rates?: RateProfile;
  /** rate-loop targets, replacing the airframe's stock `ctrl` block */
  ctrl?: CtrlTune;
}

/**
 * The rate loop's knobs. These are not Betaflight PID numbers: the sim's controller works in
 * physical units and derives P and D from the wanted closed-loop bandwidth and damping through
 * the motor lag (see FlightController.setCtrl), so Betaflight P/I/D values do not carry over.
 */
export type CtrlTune = DroneConfig['ctrl'];

export interface CtrlField {
  key: keyof CtrlTune;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}

/**
 * Editor ranges. tests/tuning.test.ts flies every airframe at the corners of these ranges and
 * checks it still tracks a roll and settles, so the editor can't produce an unflyable quad.
 */
export const CTRL_FIELDS: CtrlField[] = [
  { key: 'bandwidth', label: 'Response', help: 'Roll and pitch closed-loop bandwidth, rad/s. Higher is snappier and less forgiving of motor lag.', min: 30, max: 70, step: 1 },
  { key: 'damping', label: 'Damping', help: 'Damping ratio of the roll and pitch loop. Below about 0.7 it overshoots; above 1 it feels soft.', min: 0.55, max: 1.2, step: 0.01 },
  { key: 'ki', label: 'I gain', help: 'How hard the loop leans on accumulated error, (rad/s²) per rad. Holds attitude against wind and uneven props.', min: 0, max: 500, step: 5 },
  { key: 'ff', label: 'Feed-forward', help: 'Share of the stick’s rate of change sent straight to the motors. Higher makes the quad follow fast stick moves with less lag.', min: 0, max: 1.2, step: 0.05 },
  { key: 'yawScale', label: 'Yaw response', help: 'Yaw loop crossover as a fraction of the roll/pitch bandwidth.', min: 0.35, max: 0.9, step: 0.01 },
];

/** The airframe's stock rates written as a Betaflight Actual-rates profile (identical curve). */
export function stockRateProfile(cfg: DroneConfig): RateProfile {
  const axis = (r: DroneConfig['rates']['roll']) => ({ rcRate: Math.round(r.center / 10), expo: Math.round(r.expo * 100), rate: Math.round(r.max / 10), limit: 1998 });
  return { type: 'ACTUAL', quickRcExpo: false, roll: axis(cfg.rates.roll), pitch: axis(cfg.rates.pitch), yaw: axis(cfg.rates.yaw) };
}

export function sanitizeCtrl(x: unknown, stock: CtrlTune): CtrlTune {
  const o = (x ?? {}) as Record<string, unknown>;
  const out = { ...stock };
  for (const f of CTRL_FIELDS) {
    const v = o[f.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[f.key] = Math.min(f.max, Math.max(f.min, v));
  }
  return out;
}

/** Rebuild a stored tune, dropping anything malformed. */
export function sanitizeTune(x: unknown, cfg: DroneConfig): AirframeTune {
  if (!x || typeof x !== 'object') return {};
  const o = x as Record<string, unknown>;
  const out: AirframeTune = {};
  if (o.rates) out.rates = sanitizeRateProfile(o.rates);
  if (o.ctrl) out.ctrl = sanitizeCtrl(o.ctrl, cfg.ctrl);
  return out;
}
