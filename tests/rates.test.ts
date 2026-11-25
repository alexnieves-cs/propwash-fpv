import { describe, expect, it } from 'vitest';
import {
  betaflightDefaults,
  centreSensitivity,
  curveDps,
  formatBetaflightRates,
  parseBetaflightRates,
  rateDps,
  sanitizeRateProfile,
  type AxisRateConfig,
  type RateProfile,
} from '../src/sim/rates';

/**
 * Expected values are worked by hand from the formulas in Betaflight 4.5.1 src/main/fc/rc.c,
 * so these check the port, not just that it runs.
 */

const ax = (rcRate: number, rate: number, expo = 0, limit = 1998): AxisRateConfig => ({ rcRate, expo, rate, limit });
const profile = (type: RateProfile['type'], a: AxisRateConfig, quickRcExpo = false): RateProfile => ({ type, quickRcExpo, roll: a, pitch: a, yaw: a });

describe('Actual rates (applyActualRates)', () => {
  it("Betaflight's defaults: 70 deg/s centre, 670 deg/s max", () => {
    const p = betaflightDefaults();
    expect(p.type).toBe('ACTUAL');
    expect(rateDps(1, p, 'roll')).toBeCloseTo(670, 9);
    expect(rateDps(-1, p, 'yaw')).toBeCloseTo(-670, 9);
    expect(centreSensitivity(p, 'pitch')).toBeCloseTo(70, 1);
    // expo 0: 0.5 * 70 + (670 - 70) * 0.5 * 0.5
    expect(rateDps(0.5, p, 'roll')).toBeCloseTo(185, 9);
  });
  it('with expo', () => {
    // centre 200, max 800, expo 0.5 at half stick: 0.5*200 + 600 * 0.5*(0.5^5*0.5 + 0.5*0.5)
    expect(curveDps(0.5, 'ACTUAL', ax(20, 80, 50))).toBeCloseTo(179.6875, 9);
    expect(curveDps(1, 'ACTUAL', ax(20, 80, 50))).toBeCloseTo(800, 9);
  });
  it('max below centre sensitivity gives a straight line', () => {
    expect(curveDps(1, 'ACTUAL', ax(50, 30))).toBeCloseTo(500, 9);
    expect(curveDps(0.3, 'ACTUAL', ax(50, 30))).toBeCloseTo(150, 9);
  });
});

describe('Betaflight rates (applyBetaflightRates)', () => {
  it('rc rate 1.00, super rate 0.70: 200 deg/s centre, 666.7 deg/s max', () => {
    const a = ax(100, 70);
    expect(curveDps(1, 'BETAFLIGHT', a)).toBeCloseTo(200 / 0.3, 6);
    expect(curveDps(0.5, 'BETAFLIGHT', a)).toBeCloseTo(100 / 0.65, 6);
    expect(curveDps(0.01, 'BETAFLIGHT', a) / 0.01).toBeCloseTo(200 / (1 - 0.007), 6);
  });
  it('rc rate above 2.0 ramps by RC_RATE_INCREMENTAL', () => {
    // 2.5 + 14.54 * 0.5 = 9.77, times 200
    expect(curveDps(1, 'BETAFLIGHT', ax(250, 0))).toBeCloseTo(1954, 6);
  });
  it('rc expo is cubic', () => {
    // 0.5 * 0.5^3 * 0.3 + 0.5 * 0.7 = 0.36875, times 200
    expect(curveDps(0.5, 'BETAFLIGHT', ax(100, 0, 30))).toBeCloseTo(73.75, 9);
  });
  it('the super factor saturates at 100x and the rate limit clamps the result', () => {
    expect(curveDps(1, 'BETAFLIGHT', ax(100, 100))).toBeCloseTo(20000, 6);
    expect(rateDps(1, profile('BETAFLIGHT', ax(100, 100)), 'roll')).toBe(1998);
    expect(rateDps(1, profile('BETAFLIGHT', ax(100, 70, 0, 500)), 'roll')).toBe(500);
  });
});

describe('Raceflight rates (applyRaceFlightRates)', () => {
  it('rate 370, acro+ 80, expo 50', () => {
    expect(curveDps(1, 'RACEFLIGHT', ax(37, 80, 50))).toBeCloseTo(666, 9);
    // (1 + 0.5 * (0.25 - 1)) * 0.5 = 0.3125; 370 * 0.3125 * (1 + 0.4)
    expect(curveDps(0.5, 'RACEFLIGHT', ax(37, 80, 50))).toBeCloseTo(161.875, 9);
  });
});

describe('KISS rates (applyKissRates)', () => {
  it('rc rate 1.00, rate 0.70, no curve', () => {
    expect(curveDps(1, 'KISS', ax(100, 70))).toBeCloseTo(2000 * 0.1 / 0.3, 6);
    expect(curveDps(0.5, 'KISS', ax(100, 70))).toBeCloseTo((2000 * 0.05) / 0.65, 6);
  });
  it('clamps to the setpoint limit inside the curve', () => {
    expect(curveDps(1, 'KISS', ax(100, 90))).toBe(1998);
    expect(curveDps(-1, 'KISS', ax(100, 90))).toBe(-1998);
  });
});

describe('Quick rates (applyQuickRates)', () => {
  it('rc rate 1.00 (200 deg/s centre), max 670 deg/s', () => {
    const a = ax(100, 67);
    expect(curveDps(1, 'QUICK', a)).toBeCloseTo(670, 6);
    // superFactorConfig = (670/200 - 1) / (670/200) = 2.35 / 3.35
    expect(curveDps(0.5, 'QUICK', a)).toBeCloseTo((0.5 * 200 * 3.35) / (3.35 - 0.5 * 2.35), 6);
    expect(curveDps(0.001, 'QUICK', a) / 0.001).toBeCloseTo(200, 0);
  });
  it('expo on the super factor (quickrates_rc_expo off)', () => {
    // curve = 0.5^3 * 0.4 + 0.5 * 0.6 = 0.35; super factor 1 / (1 - 0.35 * 2.35/3.35)
    const expected = (0.5 * 200) / (1 - (0.35 * 2.35) / 3.35);
    expect(curveDps(0.5, 'QUICK', ax(100, 67, 40))).toBeCloseTo(expected, 6);
  });
  it('expo on the stick (quickrates_rc_expo on)', () => {
    // curve = 0.35 as above; super factor from the plain stick: 1 / (1 - 0.5 * 2.35/3.35)
    const expected = (0.35 * 200) / (1 - (0.5 * 2.35) / 3.35);
    expect(curveDps(0.5, 'QUICK', ax(100, 67, 40), true)).toBeCloseTo(expected, 6);
  });
  it('max below the centre rate gives a straight line', () => {
    expect(curveDps(1, 'QUICK', ax(100, 10))).toBeCloseTo(200, 9);
    expect(curveDps(0.25, 'QUICK', ax(100, 10))).toBeCloseTo(50, 9);
  });
});

describe('every curve', () => {
  const types = ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'] as const;
  it('is odd, zero at centre and increasing', () => {
    for (const t of types) {
      const a = ax(t === 'RACEFLIGHT' ? 37 : t === 'ACTUAL' ? 20 : 100, t === 'RACEFLIGHT' ? 80 : 70, 30);
      expect(curveDps(0, t, a)).toBeCloseTo(0, 12);
      let prev = -Infinity;
      for (let s = -1; s <= 1.0001; s += 0.02) {
        const v = curveDps(s, t, a);
        expect(curveDps(-s, t, a)).toBeCloseTo(-v, 9);
        expect(v).toBeGreaterThan(prev);
        prev = v;
      }
    }
  });
  it('treats stick beyond full deflection as full deflection', () => {
    for (const t of types) expect(curveDps(1.4, t, ax(100, 70))).toBe(curveDps(1, t, ax(100, 70)));
  });
});

describe('Betaflight CLI import', () => {
  it('reads a diff, keeping defaults for everything it does not mention', () => {
    const r = parseBetaflightRates(['# diff', '', '# rateprofile', 'rateprofile 0', '', 'set roll_rc_rate = 12', 'set pitch_srate = 80', 'set yaw_expo = 20', 'set p_roll = 52'].join('\n'));
    expect(r.problems).toEqual([]);
    expect(r.rateProfile).toBe(0);
    expect(r.profile.type).toBe('ACTUAL');
    expect(r.profile.roll).toEqual({ rcRate: 12, expo: 0, rate: 67, limit: 1998 });
    expect(r.profile.pitch).toEqual({ rcRate: 7, expo: 0, rate: 80, limit: 1998 });
    expect(r.profile.yaw).toEqual({ rcRate: 7, expo: 20, rate: 67, limit: 1998 });
    expect(r.applied).toHaveLength(3);
    expect(r.otherSettings).toBe(1);
  });
  it('takes the rate profile selected at the end of a diff all', () => {
    const text = [
      'rateprofile 0',
      'set rates_type = BETAFLIGHT',
      'set roll_rc_rate = 100',
      'rateprofile 1',
      'set rates_type = QUICK',
      'set quickrates_rc_expo = ON',
      'set roll_rc_rate = 110',
      'set roll_srate = 75',
      'rateprofile 2',
      '# restore original rateprofile selection',
      'rateprofile 1',
      'save',
    ].join('\r\n');
    const r = parseBetaflightRates(text);
    expect(r.rateProfile).toBe(1);
    expect(r.profile.type).toBe('QUICK');
    expect(r.profile.quickRcExpo).toBe(true);
    expect(r.profile.roll).toEqual({ rcRate: 110, expo: 0, rate: 75, limit: 1998 });
    expect(r.otherProfiles).toEqual([0]);
  });
  it('reads `get` output and lower-case lookups', () => {
    const r = parseBetaflightRates('roll_rc_rate = 15\nAllowed range: 1 - 255\n\nrates_type = actual\nroll_rate_limit = 1200');
    expect(r.profile.type).toBe('ACTUAL');
    expect(r.profile.roll.rcRate).toBe(15);
    expect(r.profile.roll.limit).toBe(1200);
  });
  it('reports values outside Betaflight’s ranges and unknown rate types instead of using them', () => {
    const r = parseBetaflightRates('set roll_rc_rate = 0\nset roll_expo = 101\nset yaw_rate_limit = 2500\nset rates_type = BOGUS\nset pitch_srate = 7.5');
    expect(r.problems).toHaveLength(5);
    expect(r.profile).toEqual(betaflightDefaults());
  });
  it('round-trips through the CLI text it writes', () => {
    const p: RateProfile = { type: 'QUICK', quickRcExpo: true, roll: ax(110, 75, 10, 1500), pitch: ax(105, 72, 5), yaw: ax(90, 60, 0, 800) };
    expect(parseBetaflightRates(formatBetaflightRates(p)).profile).toEqual(p);
    const q: RateProfile = { ...p, type: 'ACTUAL', quickRcExpo: false };
    const text = formatBetaflightRates(q);
    expect(text).not.toContain('quickrates_rc_expo');
    expect(parseBetaflightRates(text).profile).toEqual(q);
  });
});

describe('stored rate profiles', () => {
  it('fall back to the defaults for anything malformed', () => {
    expect(sanitizeRateProfile(undefined)).toEqual(betaflightDefaults());
    const s = sanitizeRateProfile({ type: 'KISS', roll: { rcRate: 300, expo: 20 }, pitch: 'x', yaw: { limit: 150, rate: 50 } });
    expect(s.type).toBe('KISS');
    expect(s.roll).toEqual({ rcRate: 7, expo: 20, rate: 67, limit: 1998 });
    expect(s.pitch).toEqual(betaflightDefaults().pitch);
    expect(s.yaw).toEqual({ rcRate: 7, expo: 0, rate: 50, limit: 1998 });
  });
});
