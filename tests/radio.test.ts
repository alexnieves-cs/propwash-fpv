import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/core/input';
import {
  AxisRecorder,
  RADIO_PRESETS,
  SwitchLatch,
  applyCalibration,
  applyDeadband,
  assignAxis,
  centredValue,
  defaultRadio,
  detectAxis,
  detectButton,
  getPreset,
  linearValue,
  readModeSwitch,
  readSticks,
  readSwitch,
  sanitizeRadio,
  switchPosition,
  type AxisCal,
  type RadioProfile,
} from '../src/core/radio';

/** Identical including the sign of zero not mattering. */
function same(a: number | null, b: number | null): void {
  expect(a === b, `${a} vs ${b}`).toBe(true);
}

/** The gamepad mapping hard-wired into v1.0.0's Input.update, kept here as the reference. */
function v100(axes: number[], hold: boolean): { roll: number; pitch: number; yaw: number; climb: number; throttle: number | null } {
  const dz = (v: number): number => (Math.abs(v) < 0.045 ? 0 : (v - Math.sign(v) * 0.045) / 0.955);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    yaw: dz(axes[0] ?? 0),
    roll: dz(axes[2] ?? 0),
    pitch: -dz(axes[3] ?? 0),
    climb: -dz(axes[1] ?? 0),
    throttle: hold ? clamp((1 - (axes[1] ?? 0)) / 2, 0, 1) : null,
  };
}

const cal = (p: Partial<AxisCal>): AxisCal => ({ axis: 0, invert: false, min: -1, center: 0, max: 1, ...p });

describe('default mapping', () => {
  it('reads sticks exactly as v1.0.0 did, for both throttle styles', () => {
    const values = [-1, -0.73, -0.3, -0.046, -0.045, -0.02, 0, 0.01, 0.044, 0.05, 0.31, 0.5, 0.999, 1];
    const p = defaultRadio();
    for (const hold of [false, true]) {
      for (let i = 0; i < 400; i++) {
        const axes = [0, 1, 2, 3].map((k) => values[(i * (k + 3) + k * 5) % values.length]);
        const got = readSticks(axes, p, hold ? 'hold' : 'spring');
        const want = v100(axes, hold);
        same(got.roll, want.roll);
        same(got.pitch, want.pitch);
        same(got.yaw, want.yaw);
        same(got.climb, want.climb);
        same(got.throttle, want.throttle);
      }
    }
  });
  it('is the Mode 2 gamepad preset and survives a save and load unchanged', () => {
    expect(getPreset('gamepad-mode2')!.make()).toEqual(defaultRadio());
    expect(sanitizeRadio(JSON.parse(JSON.stringify(defaultRadio())))).toEqual(defaultRadio());
  });
});

describe('calibrated axes', () => {
  it('maps an off-centre, asymmetric stick to -1..1', () => {
    const c = cal({ min: -0.8, center: 0.1, max: 0.9 });
    expect(centredValue(0.1, c)).toBe(0);
    expect(centredValue(0.9, c)).toBeCloseTo(1, 12);
    expect(centredValue(-0.8, c)).toBeCloseTo(-1, 12);
    expect(centredValue(0.5, c)).toBeCloseTo(0.5, 12);
    expect(centredValue(-0.35, c)).toBeCloseTo(-0.5, 12);
    expect(centredValue(1, c)).toBe(1);
    expect(centredValue(-1, { ...c, invert: true })).toBe(1);
  });
  it('maps a throttle end to end, either way round', () => {
    const c = cal({ min: -0.9, max: 0.95 });
    expect(linearValue(-0.9, c)).toBe(0);
    expect(linearValue(0.95, c)).toBe(1);
    expect(linearValue(0.025, c)).toBeCloseTo(0.5, 12);
    expect(linearValue(-1, c)).toBe(0);
    expect(linearValue(0.95, { ...c, invert: true })).toBe(0);
    expect(linearValue(-0.9, { ...c, invert: true })).toBe(1);
  });
  it('reads a collapsed calibration as centred rather than dividing by zero', () => {
    expect(centredValue(0.3, cal({ min: 0, center: 0, max: 0 }))).toBe(0);
    expect(linearValue(0.3, cal({ min: 0.2, max: 0.2 }))).toBe(0);
  });
  it('applies a deadband that still reaches full stick', () => {
    expect(applyDeadband(0.04, 0.05)).toBe(0);
    expect(applyDeadband(-0.04, 0.05)).toBe(0);
    expect(applyDeadband(1, 0.05)).toBe(1);
    expect(applyDeadband(-1, 0.05)).toBe(-1);
    expect(applyDeadband(0.525, 0.05)).toBeCloseTo(0.5, 12);
    expect(applyDeadband(0.3, 0)).toBe(0.3);
  });
});

describe('radio presets', () => {
  it('have unique ids, and say where their axis order comes from unless they ask you to calibrate', () => {
    expect(new Set(RADIO_PRESETS.map((p) => p.id)).size).toBe(RADIO_PRESETS.length);
    for (const p of RADIO_PRESETS) {
      expect(p.make().preset).toBe(p.id);
      expect(sanitizeRadio(p.make())).toEqual(p.make());
      if (p.calibrate) {
        expect(p.source).toBeNull();
        for (const c of Object.values(p.make().channels)) expect(c.axis).toBe(-1);
      } else expect(p.source).toBeTruthy();
    }
  });
  it('EdgeTX AETR reads channels 1 to 4 as roll, pitch, throttle and yaw', () => {
    const p = getPreset('edgetx-aetr')!.make();
    const r = readSticks([0.5, -0.25, 1, -1, 0, 0, 0, 0], p, 'spring');
    expect(r.roll).toBe(0.5);
    expect(r.pitch).toBe(-0.25);
    expect(r.yaw).toBe(-1);
    // radios read the throttle end to end whatever the keyboard setting
    expect(r.throttle).toBe(1);
    expect(readSticks([0, 0, -1, 0], p, 'spring').throttle).toBe(0);
  });
  it('an unmapped channel reads centred, and an unmapped throttle reads off', () => {
    const r = readSticks([1, 1, 1, 1], getPreset('custom')!.make(), 'hold');
    expect([r.roll, r.pitch, r.yaw, r.climb, r.throttle]).toEqual([0, 0, 0, 0, 0]);
  });
  it('a missing axis reads as centred', () => {
    const p = getPreset('edgetx-aetr')!.make();
    p.channels.yaw.axis = 9;
    expect(readSticks([0, 0, 0, 0], p, 'spring').yaw).toBe(0);
  });
});

describe('switches', () => {
  const buttons = (...on: number[]) => Array.from({ length: 8 }, (_, i) => ({ pressed: on.includes(i) }));
  it('read from buttons or from axes, optionally inverted', () => {
    expect(readSwitch({ kind: 'button', index: 2, invert: false }, [], buttons(2))).toBe(true);
    expect(readSwitch({ kind: 'button', index: 2, invert: true }, [], buttons(2))).toBe(false);
    expect(readSwitch({ kind: 'button', index: 12, invert: false }, [], buttons(2))).toBeNull();
    expect(readSwitch({ kind: 'axis', index: 1, invert: false }, [0, 1], [])).toBe(true);
    expect(readSwitch({ kind: 'axis', index: 1, invert: false }, [0, 0], [])).toBe(false);
    expect(readSwitch({ kind: 'axis', index: 1, invert: true }, [0, -1], [])).toBe(true);
    expect(readSwitch({ kind: 'none' }, [1], buttons(0))).toBeNull();
  });
  it('split an axis into thirds for a three-position mode switch', () => {
    expect(switchPosition(-1)).toBe(0);
    expect(switchPosition(-0.2)).toBe(1);
    expect(switchPosition(0)).toBe(1);
    expect(switchPosition(0.9)).toBe(2);
    const m = { kind: 'axis', index: 5, low: 'angle', mid: 'horizon', high: 'acro' } as const;
    expect(readModeSwitch(m, [0, 0, 0, 0, 0, -1])).toBe('angle');
    expect(readModeSwitch(m, [0, 0, 0, 0, 0, 0])).toBe('horizon');
    expect(readModeSwitch(m, [0, 0, 0, 0, 0, 1])).toBe('acro');
    expect(readModeSwitch(m, [0, 0, 0, 0])).toBeNull();
  });
  it('report changes but not the first reading', () => {
    const l = new SwitchLatch<boolean>();
    expect(l.update(true)).toBeNull();
    expect(l.update(true)).toBeNull();
    expect(l.update(false)).toBe(false);
    expect(l.update(true)).toBe(true);
    // device gone: the next reading counts as the first again
    expect(l.update(null)).toBeNull();
    expect(l.update(false)).toBeNull();
    expect(l.update(true)).toBe(true);
  });
});

describe('calibration', () => {
  function sweep(rec: AxisRecorder, ranges: [number, number][]): void {
    rec.observe(ranges.map(([lo, hi]) => (lo + hi) / 2));
    rec.observe(ranges.map(([lo]) => lo));
    rec.observe(ranges.map(([lo, hi]) => lo * 0.3 + hi * 0.7));
    rec.observe(ranges.map(([, hi]) => hi));
  }
  it('takes endpoints from the sweep and centres from the snapshot', () => {
    const p = getPreset('edgetx-aetr')!.make();
    const rec = new AxisRecorder();
    sweep(rec, [
      [-0.82, 0.86],
      [-0.9, 0.9],
      [-0.95, 0.97],
      [-0.7, 0.8],
    ]);
    const { profile, skipped } = applyCalibration(p, [0.03, -0.01, -0.95, 0.04], rec);
    expect(skipped).toEqual([]);
    expect(profile.channels.roll).toMatchObject({ min: -0.82, max: 0.86, center: 0.03 });
    expect(profile.channels.yaw).toMatchObject({ min: -0.7, max: 0.8, center: 0.04 });
    // the throttle was resting at the bottom: its centre falls back to mid-travel
    expect(profile.channels.throttle.center).toBeCloseTo(0.01, 12);
    expect(readSticks([0.86, -0.9, 0.97, 0.04], profile, 'spring')).toMatchObject({ roll: 1, pitch: -1, yaw: 0, throttle: 1 });
    // the input profile is not modified
    expect(p.channels.roll.min).toBe(-1);
  });
  it('skips a stick that was not moved', () => {
    const p = getPreset('edgetx-aetr')!.make();
    const rec = new AxisRecorder();
    sweep(rec, [
      [-1, 1],
      [-1, 1],
      [-1, 1],
      [-0.1, 0.1],
    ]);
    const { profile, skipped } = applyCalibration(p, [0, 0, 0, 0], rec);
    expect(skipped).toEqual(['yaw']);
    expect(profile.channels.yaw).toEqual(p.channels.yaw);
  });
});

describe('detection', () => {
  it('finds the axis that moved most, and which way', () => {
    expect(detectAxis([0, 0, -1, 0], [0.05, 0.1, 0.9, 0])).toEqual({ index: 2, sign: 1 });
    expect(detectAxis([0, 0, 0, 0], [0, -0.8, 0.2, 0])).toEqual({ index: 1, sign: -1 });
    expect(detectAxis([0, 0, 0, 0], [0.2, 0.3, 0, 0])).toBeNull();
    expect(detectAxis([0, 0, 0, 0], [0, -0.8, 0.6, 0], 0.5, [1])).toEqual({ index: 2, sign: 1 });
  });
  it('finds a button that changed', () => {
    expect(detectButton([false, true, false], [{ pressed: false }, { pressed: true }, { pressed: true }])).toBe(2);
    expect(detectButton([false, true], [{ pressed: false }, { pressed: true }])).toBeNull();
  });
  it('assigns an axis, sets its direction and frees it from any other channel', () => {
    const p = defaultRadio();
    const q = assignAxis(p, 'roll', { index: 0, sign: -1 });
    expect(q.channels.roll).toMatchObject({ axis: 0, invert: true });
    expect(q.channels.yaw.axis).toBe(-1);
    expect(p.channels.yaw.axis).toBe(0);
  });
});

describe('stored profiles', () => {
  it('fall back to the defaults for anything missing or malformed', () => {
    expect(sanitizeRadio(null)).toEqual(defaultRadio());
    expect(sanitizeRadio('nope')).toEqual(defaultRadio());
    const s = sanitizeRadio({
      channels: { roll: { axis: 4, invert: 'yes', min: 0.9, max: -0.9, center: 5 }, pitch: { axis: 2.5 } },
      deadband: 3,
      throttle: 'sideways',
      arm: { kind: 'button', index: 7 },
      mode: { kind: 'axis', index: 5, low: 'acro', mid: 'warp' },
    });
    expect(s.channels.roll).toEqual({ axis: 4, invert: false, min: -0.9, max: 0.9, center: 0.9 });
    expect(s.channels.pitch).toEqual(defaultRadio().channels.pitch);
    expect(s.deadband).toBe(0.3);
    expect(s.throttle).toBe('auto');
    expect(s.arm).toEqual({ kind: 'button', index: 7, invert: false });
    expect(s.mode).toEqual({ kind: 'axis', index: 5, low: 'acro', mid: 'angle', high: 'acro' });
  });
});

// -----------------------------------------------------------------------------------------------
// Input, end to end with a fake gamepad
// -----------------------------------------------------------------------------------------------

describe('Input with a gamepad', () => {
  let pad: { id: string; connected: boolean; axes: number[]; buttons: { pressed: boolean }[] };
  let stored: string | null;

  beforeEach(() => {
    const noop = (): void => {};
    pad = { id: 'Test Radio (Vendor: 1209 Product: 4f54)', connected: true, axes: [0, 0, 0, 0, -1, -1, 0, 0], buttons: Array.from({ length: 12 }, () => ({ pressed: false })) };
    stored = null;
    vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop });
    vi.stubGlobal('document', { addEventListener: noop, removeEventListener: noop, pointerLockElement: null });
    vi.stubGlobal('navigator', { getGamepads: () => [null, pad] });
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_k: string, v: string) => (stored = v) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function make(profile?: RadioProfile) {
    const { Input } = await import('../src/core/input');
    const { SettingsStore } = await import('../src/core/settings');
    const store = new SettingsStore();
    if (profile) store.data.radio = profile;
    const input = new Input({ addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLElement, store);
    input.enabled = true;
    const actions: Action[] = [];
    input.onAction = (a) => actions.push(a);
    return { input, store, actions };
  }

  it('flies with the v1.0 mapping by default', async () => {
    const { input, actions } = await make();
    pad.axes = [0.4, -0.6, -0.7, 0.2];
    input.update(0.016, { hover: 0.3, armed: true, landed: false });
    const want = v100(pad.axes, false);
    expect(input.usingGamepad).toBe(true);
    same(input.rc.roll, want.roll);
    same(input.rc.pitch, want.pitch);
    same(input.rc.yaw, want.yaw);
    same(input.rc.climb, want.climb);
    pad.buttons[0].pressed = true;
    input.update(0.016, { hover: 0.3, armed: true, landed: false });
    expect(actions).toEqual(['arm']);
  });

  it('arms on a switch only after it has been cycled, and never with the throttle up', async () => {
    const p = getPreset('edgetx-aetr')!.make();
    p.arm = { kind: 'axis', index: 4, invert: false };
    const { input, actions } = await make(p);
    const tick = (armed = false) => input.update(0.016, { hover: 0.3, armed, landed: true });
    pad.axes = [0, 0, -1, 0, 1, -1];
    tick();
    // already on when first seen: ignored
    expect(actions).toEqual([]);
    pad.axes[4] = -1;
    tick();
    pad.axes[4] = 1;
    tick();
    expect(actions).toEqual(['arm']);
    // switch off while armed disarms
    pad.axes[4] = -1;
    tick(true);
    expect(actions).toEqual(['arm', 'arm']);
    // throttle up: refused
    pad.axes[2] = 0.2;
    pad.axes[4] = 1;
    tick();
    expect(actions).toEqual(['arm', 'arm', 'armBlocked']);
    expect(input.rc.throttle).toBe(0);
  });

  it('sets the flight mode from a switch, on first sight and on every change', async () => {
    const p = getPreset('edgetx-aetr')!.make();
    p.mode = { kind: 'axis', index: 5, low: 'cruise', mid: 'horizon', high: 'acro' };
    const { input, actions } = await make(p);
    const tick = () => input.update(0.016, { hover: 0.3, armed: false, landed: true });
    pad.axes = [0, 0, -1, 0, -1, 1];
    tick();
    tick();
    expect(actions).toEqual(['mode4']);
    pad.axes[5] = 0;
    tick();
    pad.axes[5] = -1;
    tick();
    expect(actions).toEqual(['mode4', 'mode3', 'mode1']);
  });

  it('leaves the v1.0 gamepad buttons alone when a radio preset turns them off', async () => {
    const { input, actions } = await make(getPreset('edgetx-aetr')!.make());
    pad.buttons[0].pressed = true;
    pad.buttons[1].pressed = true;
    input.update(0.016, { hover: 0.3, armed: false, landed: true });
    expect(actions).toEqual([]);
  });

  it('prefers the device the profile names', async () => {
    const other = { id: 'Xbox Controller', connected: true, axes: [0, 0, 0, 0], buttons: [] };
    vi.stubGlobal('navigator', { getGamepads: () => [other, pad] });
    const p = defaultRadio();
    p.device = 'Test Radio';
    const { input } = await make(p);
    expect(input.findPad()?.id).toBe(pad.id);
    p.device = '';
    expect(input.findPad(p)?.id).toBe(other.id);
  });

  it('loads v1.0 settings with the default radio and no tunes, and keeps both through Restore defaults', async () => {
    stored = JSON.stringify({ quality: 'medium', controls: { throttle: 'hold', rateScale: 1.2 }, records: { x: { total: 1, bestLap: 1, splits: [] } } });
    const { SettingsStore } = await import('../src/core/settings');
    const store = new SettingsStore();
    expect(store.data.radio).toEqual(defaultRadio());
    expect(store.data.tuning).toEqual({});
    expect(store.data.controls.rateScale).toBe(1.2);
    store.data.radio = getPreset('edgetx-taer')!.make();
    store.data.tuning = { race5: { ctrl: { bandwidth: 50, damping: 0.8, ki: 280, ff: 0.8, yawScale: 0.62 } } };
    store.reset();
    expect(store.data.radio.preset).toBe('edgetx-taer');
    expect(store.data.tuning.race5).toBeDefined();
    expect(store.data.controls.rateScale).toBe(1);
  });
});
