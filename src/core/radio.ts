import type { FlightModeId } from './settings';

/**
 * Radio and gamepad setup: which raw axis drives which stick, which way round, its calibrated
 * endpoints, and the arm and flight-mode switches. Everything here is plain data and pure
 * functions, so it can be unit-tested without a browser. `Input` applies it to the Gamepad API.
 */

export type StickChannel = 'roll' | 'pitch' | 'yaw' | 'throttle';
export const STICK_CHANNELS: StickChannel[] = ['roll', 'pitch', 'yaw', 'throttle'];

/** One stick channel: the raw axis it reads and how that axis is calibrated. */
export interface AxisCal {
  /** index into `Gamepad.axes`, or -1 for not assigned (reads as centred, or throttle off) */
  axis: number;
  invert: boolean;
  /** raw reading at the low end, centre and high end of travel */
  min: number;
  center: number;
  max: number;
}

/** A two-position control, read from a button or from an axis (on above half travel). */
export type SwitchSource = { kind: 'none' } | { kind: 'button'; index: number; invert: boolean } | { kind: 'axis'; index: number; invert: boolean };

/** A flight-mode switch on an axis: low, middle and high thirds of travel pick a mode each. */
export type ModeSwitch = { kind: 'none' } | { kind: 'axis'; index: number; low: FlightModeId; mid: FlightModeId; high: FlightModeId };

/**
 * How the throttle channel is read.
 * - `auto`: as in v1.0. A centred stick that springs around hover, unless the keyboard
 *   throttle setting is Hold, in which case stick position is throttle.
 * - `absolute`: stick position is throttle (bottom is off). What a radio's throttle gimbal wants.
 * - `centred`: always the spring-to-hover stick, whatever the keyboard setting.
 */
export type ThrottleStyle = 'auto' | 'absolute' | 'centred';

export interface RadioProfile {
  /** id of the preset this profile started from */
  preset: string;
  /** prefer the device whose `Gamepad.id` contains this text; empty takes the first one found */
  device: string;
  channels: Record<StickChannel, AxisCal>;
  /** fraction of travel around centre that reads as zero, for roll, pitch, yaw and a centred throttle */
  deadband: number;
  throttle: ThrottleStyle;
  arm: SwitchSource;
  mode: ModeSwitch;
  /** the v1.0 gamepad buttons: A arm, B reset, X turtle, Y camera, bumpers auto-roll, Start pause */
  padButtons: boolean;
}

const cal = (axis: number, invert = false): AxisCal => ({ axis, invert, min: -1, center: 0, max: 1 });

/** v1.0.0's hard-wired mapping: standard gamepad layout, Mode 2. */
export function defaultRadio(): RadioProfile {
  return {
    preset: 'gamepad-mode2',
    device: '',
    channels: { yaw: cal(0), throttle: cal(1, true), roll: cal(2), pitch: cal(3, true) },
    deadband: 0.045,
    throttle: 'auto',
    arm: { kind: 'none' },
    mode: { kind: 'none' },
    padButtons: true,
  };
}

export interface RadioPreset {
  id: string;
  name: string;
  /** what the preset assumes, shown in the setup screen */
  note: string;
  /** where the axis order comes from; null when there is no documented order */
  source: string | null;
  /** true when the axis order is not documented, so the pilot has to map the sticks */
  calibrate: boolean;
  make: () => RadioProfile;
}

export const RADIO_PRESETS: RadioPreset[] = [
  {
    id: 'gamepad-mode2',
    name: 'Gamepad, Mode 2',
    note: 'Left stick throttle and yaw, right stick pitch and roll. The v1.0 default.',
    source: 'W3C Gamepad, "Standard Gamepad" mapping: axes 0 and 1 are the left stick X and Y, axes 2 and 3 the right stick, up is negative.',
    calibrate: false,
    make: defaultRadio,
  },
  {
    id: 'gamepad-mode1',
    name: 'Gamepad, Mode 1',
    note: 'Left stick pitch and yaw, right stick throttle and roll.',
    source: 'W3C Gamepad, "Standard Gamepad" mapping (as for Mode 2), with pitch and throttle swapped.',
    calibrate: false,
    make: () => ({ ...defaultRadio(), preset: 'gamepad-mode1', channels: { yaw: cal(0), pitch: cal(1, true), roll: cal(2), throttle: cal(3, true) } }),
  },
  {
    id: 'edgetx-aetr',
    name: 'EdgeTX radio, AETR',
    note: 'EdgeTX USB joystick in Classic mode, channel order AETR. Stick directions are not documented: run Detect on each stick, then Calibrate.',
    source:
      'EdgeTX manual, USB Joystick: Classic mode sends channels 1 to 6 as the X, Y, Z, X-rotation, Y-rotation and Z-rotation axes in order. Chrome assigns gamepad axes in HID usage order, X first (w3c/gamepad issue 56, comment of 2020-08-01).',
    calibrate: false,
    make: () => radioPreset('edgetx-aetr', { roll: 0, pitch: 1, throttle: 2, yaw: 3 }),
  },
  {
    id: 'edgetx-taer',
    name: 'EdgeTX radio, TAER',
    note: 'As AETR, for radios whose channel order puts throttle first.',
    source: 'Same sources as the AETR preset; only the channel order differs.',
    calibrate: false,
    make: () => radioPreset('edgetx-taer', { throttle: 0, roll: 1, pitch: 2, yaw: 3 }),
  },
  {
    id: 'custom',
    name: 'Other radio (calibrate yourself)',
    note: 'No assumed axis order. Use Detect on each stick, then Calibrate. Covers radios whose joystick layout we have not found documented, such as the DJI FPV and TBS controllers.',
    source: null,
    calibrate: true,
    make: () => radioPreset('custom', { roll: -1, pitch: -1, throttle: -1, yaw: -1 }),
  },
];

function radioPreset(id: string, axes: Record<StickChannel, number>): RadioProfile {
  return {
    preset: id,
    device: '',
    channels: { roll: cal(axes.roll), pitch: cal(axes.pitch), yaw: cal(axes.yaw), throttle: cal(axes.throttle) },
    deadband: 0,
    throttle: 'absolute',
    arm: { kind: 'none' },
    mode: { kind: 'none' },
    padButtons: false,
  };
}

export function getPreset(id: string): RadioPreset | undefined {
  return RADIO_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------------------------
// reading the sticks
// ---------------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function rawAxis(axes: ArrayLike<number>, index: number): number {
  if (index < 0 || index >= axes.length) return 0;
  const v = axes[index];
  return Number.isFinite(v) ? v : 0;
}

/** A self-centring stick, -1..1, from its raw reading and calibration (deadband not applied). */
export function centredValue(raw: number, c: AxisCal): number {
  const span = raw >= c.center ? c.max - c.center : c.center - c.min;
  const v = span > 1e-6 ? clamp((raw - c.center) / span, -1, 1) : 0;
  return c.invert ? -v : v;
}

/** A stick read end to end, 0..1: the calibrated low end is 0, the high end 1 (both swap when inverted). */
export function linearValue(raw: number, c: AxisCal): number {
  const span = c.max - c.min;
  if (span <= 1e-6) return 0;
  return clamp((c.invert ? c.max - raw : raw - c.min) / span, 0, 1);
}

/** Zero inside the deadband, and rescaled outside it so full stick is still 1. */
export function applyDeadband(v: number, db: number): number {
  if (db <= 0) return v;
  return Math.abs(v) < db ? 0 : (v - Math.sign(v) * db) / (1 - db);
}

export interface StickReading {
  roll: number;
  pitch: number;
  yaw: number;
  /** throttle read as a centred stick, -1..1 (the spring throttle and altitude-hold climb rate) */
  climb: number;
  /** throttle read end to end, 0..1, when this profile reads it that way; otherwise null */
  throttle: number | null;
}

/** Turn raw `Gamepad.axes` into the four sticks. `keyboardThrottle` is the Settings throttle style. */
export function readSticks(axes: ArrayLike<number>, p: RadioProfile, keyboardThrottle: 'spring' | 'hold'): StickReading {
  const ch = p.channels;
  const stick = (c: AxisCal): number => (c.axis < 0 ? 0 : applyDeadband(centredValue(rawAxis(axes, c.axis), c), p.deadband));
  const t = ch.throttle;
  const absolute = p.throttle === 'absolute' || (p.throttle === 'auto' && keyboardThrottle === 'hold');
  return {
    roll: stick(ch.roll),
    pitch: stick(ch.pitch),
    yaw: stick(ch.yaw),
    climb: stick(t),
    throttle: absolute ? (t.axis < 0 ? 0 : linearValue(rawAxis(axes, t.axis), t)) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// switches
// ---------------------------------------------------------------------------------------------

export interface ButtonLike {
  pressed: boolean;
}

/** Whether a switch is on, or null when it isn't mapped or the device doesn't have that input. */
export function readSwitch(s: SwitchSource, axes: ArrayLike<number>, buttons: ArrayLike<ButtonLike | null | undefined>): boolean | null {
  if (s.kind === 'button') {
    if (s.index < 0 || s.index >= buttons.length) return null;
    const on = !!buttons[s.index]?.pressed;
    return s.invert ? !on : on;
  }
  if (s.kind === 'axis') {
    if (s.index < 0 || s.index >= axes.length) return null;
    const v = rawAxis(axes, s.index);
    return (s.invert ? -v : v) > 0.5;
  }
  return null;
}

/** Which third of its travel an axis sits in: 0 low, 1 middle, 2 high. */
export function switchPosition(v: number): 0 | 1 | 2 {
  return v < -1 / 3 ? 0 : v > 1 / 3 ? 2 : 1;
}

export function readModeSwitch(m: ModeSwitch, axes: ArrayLike<number>): FlightModeId | null {
  if (m.kind !== 'axis' || m.index < 0 || m.index >= axes.length) return null;
  const pos = switchPosition(rawAxis(axes, m.index));
  return pos === 0 ? m.low : pos === 1 ? m.mid : m.high;
}

/**
 * Remembers a switch's last state and reports when it changes. The first reading after the
 * device appears is only remembered, never reported, so a radio plugged in with its arm switch
 * already up does not arm the quad (Betaflight refuses to arm in that case too).
 */
export class SwitchLatch<T> {
  private prev: T | null = null;
  private seen = false;

  /** Returns the new state when it changed since the last call, otherwise null. */
  update(cur: T | null): T | null {
    if (cur === null) {
      this.seen = false;
      this.prev = null;
      return null;
    }
    if (!this.seen) {
      this.seen = true;
      this.prev = cur;
      return null;
    }
    if (cur === this.prev) return null;
    this.prev = cur;
    return cur;
  }

  /** Forget the last state, so the next reading counts as the first. */
  forget(): void {
    this.seen = false;
    this.prev = null;
  }

  get current(): T | null {
    return this.prev;
  }
}

// ---------------------------------------------------------------------------------------------
// calibration and detection
// ---------------------------------------------------------------------------------------------

/** Records the range each raw axis travels through while the pilot sweeps the sticks. */
export class AxisRecorder {
  readonly min: number[] = [];
  readonly max: number[] = [];

  observe(axes: ArrayLike<number>): void {
    for (let i = 0; i < axes.length; i++) {
      const v = axes[i];
      if (!Number.isFinite(v)) continue;
      this.min[i] = Math.min(this.min[i] ?? v, v);
      this.max[i] = Math.max(this.max[i] ?? v, v);
    }
  }

  travel(i: number): number {
    return (this.max[i] ?? 0) - (this.min[i] ?? 0);
  }
}

/** Least travel, in raw units, for a sweep to count as a calibration of that axis. */
export const MIN_TRAVEL = 0.5;

export interface CalibrationResult {
  profile: RadioProfile;
  /** channels whose axis did not move enough and kept their old calibration */
  skipped: StickChannel[];
}

/**
 * Apply a calibration: endpoints from the recorded sweep, centres from a snapshot taken with the
 * sticks let go. Inversion and axis assignment are kept. An axis that barely moved keeps its old
 * calibration rather than getting a range that would amplify noise.
 */
export function applyCalibration(p: RadioProfile, centres: ArrayLike<number>, rec: AxisRecorder): CalibrationResult {
  const out = structuredClone(p);
  const skipped: StickChannel[] = [];
  for (const ch of STICK_CHANNELS) {
    const c = out.channels[ch];
    if (c.axis < 0 || rec.travel(c.axis) < MIN_TRAVEL) {
      skipped.push(ch);
      continue;
    }
    c.min = rec.min[c.axis];
    c.max = rec.max[c.axis];
    const mid = (c.min + c.max) / 2;
    const centre = c.axis < centres.length && Number.isFinite(centres[c.axis]) ? centres[c.axis] : mid;
    // a centre jammed against one end would make half the stick dead: fall back to mid-travel
    const margin = (c.max - c.min) * 0.2;
    c.center = centre > c.min + margin && centre < c.max - margin ? centre : mid;
  }
  return { profile: out, skipped };
}

export interface Detection {
  index: number;
  /** +1 when the axis moved towards its positive end */
  sign: 1 | -1;
}

/** The axis that moved most since `baseline`, if it moved at least `minDelta`. */
export function detectAxis(baseline: ArrayLike<number>, current: ArrayLike<number>, minDelta = 0.5, exclude: number[] = []): Detection | null {
  let best = -1;
  let bestDelta = 0;
  const n = Math.min(baseline.length, current.length);
  for (let i = 0; i < n; i++) {
    if (exclude.includes(i)) continue;
    const d = current[i] - baseline[i];
    if (Number.isFinite(d) && Math.abs(d) > Math.abs(bestDelta)) {
      best = i;
      bestDelta = d;
    }
  }
  if (best < 0 || Math.abs(bestDelta) < minDelta) return null;
  return { index: best, sign: bestDelta > 0 ? 1 : -1 };
}

/** The first button whose state differs from `baseline`. */
export function detectButton(baseline: boolean[], buttons: ArrayLike<ButtonLike | null | undefined>): number | null {
  for (let i = 0; i < buttons.length; i++) if (!!buttons[i]?.pressed !== !!baseline[i]) return i;
  return null;
}

/**
 * Assign a detected axis to a channel. The pilot moved the stick in the channel's positive
 * direction (roll right, pitch forward, yaw right, throttle up), so a negative move means the
 * axis is inverted. Any other channel that was on the same axis is unassigned.
 */
export function assignAxis(p: RadioProfile, ch: StickChannel, d: Detection): RadioProfile {
  const out = structuredClone(p);
  for (const other of STICK_CHANNELS) if (other !== ch && out.channels[other].axis === d.index) out.channels[other].axis = -1;
  const c = out.channels[ch];
  if (c.axis !== d.index) {
    c.min = -1;
    c.center = 0;
    c.max = 1;
  }
  c.axis = d.index;
  c.invert = d.sign < 0;
  return out;
}

// ---------------------------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------------------------

const MODES: FlightModeId[] = ['cruise', 'angle', 'horizon', 'acro'];
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const int = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= -1 && v < 64 ? v : fallback);
const mode = (v: unknown, fallback: FlightModeId): FlightModeId => (MODES.includes(v as FlightModeId) ? (v as FlightModeId) : fallback);

/** Rebuild a profile from stored JSON, falling back to the defaults for anything missing or malformed. */
export function sanitizeRadio(x: unknown): RadioProfile {
  const d = defaultRadio();
  if (!x || typeof x !== 'object') return d;
  const o = x as Record<string, unknown>;
  const chans = (o.channels ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const channels = {} as Record<StickChannel, AxisCal>;
  for (const ch of STICK_CHANNELS) {
    const c = chans[ch] ?? {};
    const base = d.channels[ch];
    const min = num(c.min, base.min);
    const max = num(c.max, base.max);
    channels[ch] = {
      axis: int(c.axis, base.axis),
      invert: typeof c.invert === 'boolean' ? c.invert : base.invert,
      min: Math.min(min, max),
      max: Math.max(min, max),
      center: clamp(num(c.center, base.center), Math.min(min, max), Math.max(min, max)),
    };
  }
  const sw = (s: unknown): SwitchSource => {
    const v = (s ?? {}) as Record<string, unknown>;
    if ((v.kind === 'button' || v.kind === 'axis') && int(v.index, -1) >= 0) return { kind: v.kind, index: v.index as number, invert: v.invert === true };
    return { kind: 'none' };
  };
  const m = (o.mode ?? {}) as Record<string, unknown>;
  const modeSwitch: ModeSwitch =
    m.kind === 'axis' && int(m.index, -1) >= 0 ? { kind: 'axis', index: m.index as number, low: mode(m.low, 'cruise'), mid: mode(m.mid, 'angle'), high: mode(m.high, 'acro') } : { kind: 'none' };
  return {
    preset: typeof o.preset === 'string' ? o.preset : d.preset,
    device: typeof o.device === 'string' ? o.device : d.device,
    channels,
    deadband: clamp(num(o.deadband, d.deadband), 0, 0.3),
    throttle: o.throttle === 'absolute' || o.throttle === 'centred' || o.throttle === 'auto' ? o.throttle : d.throttle,
    arm: sw(o.arm),
    mode: modeSwitch,
    padButtons: typeof o.padButtons === 'boolean' ? o.padButtons : d.padButtons,
  };
}
