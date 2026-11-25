import { beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { RAD } from '../src/core/math';
import { DRONES, hoverThrottle, type DroneConfig } from '../src/sim/drone-config';
import { actualRate, type RcCommand } from '../src/sim/flight-controller';
import { PHYSICS_DT, PhysicsWorld, initPhysics } from '../src/sim/physics-world';
import { Quad, type Atmosphere } from '../src/sim/quad';
import { betaflightDefaults, rateDps, type RateProfile } from '../src/sim/rates';
import { CTRL_FIELDS, sanitizeCtrl, sanitizeTune, stockRateProfile, type CtrlTune } from '../src/sim/tuning';

const air: Atmosphere = { wind: new Vector3(), density: 1.225 };
const dt = PHYSICS_DT;

function rc(p: Partial<RcCommand> = {}): RcCommand {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0, climb: 0, ...p };
}

function setup(cfg: DroneConfig): { world: PhysicsWorld; quad: Quad } {
  const world = new PhysicsWorld();
  world.addBox(0, -1, 0, 4000, 1, 4000);
  const quad = new Quad(world, cfg);
  quad.unlimitedBattery = true;
  quad.reset(new Vector3(0, 80, 0), new Quaternion());
  quad.fc.armed = true;
  return { world, quad };
}

function run(world: PhysicsWorld, quad: Quad, seconds: number, cmd: RcCommand, each?: () => void): void {
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) {
    quad.preStep(dt, cmd, air);
    world.step();
    quad.postStep(dt);
    each?.();
  }
}

/** Full-stick roll, then release. Returns the roll rate reached and the body rate left after letting go. */
function rollAndRelease(cfg: DroneConfig, ctrl?: CtrlTune, rates?: RateProfile): { reached: number; target: number; residual: number; finite: boolean } {
  const { world, quad } = setup(cfg);
  if (ctrl) quad.fc.setCtrl(ctrl);
  if (rates) quad.fc.rateProfile = rates;
  const th = hoverThrottle(cfg);
  let finite = true;
  const check = (): void => {
    if (!Number.isFinite(quad.gyro.x + quad.gyro.y + quad.gyro.z + quad.pos.y)) finite = false;
  };
  run(world, quad, 0.4, rc({ throttle: th }), check);
  run(world, quad, 0.45, rc({ throttle: th, roll: 1 }), check);
  const reached = -quad.gyro.z * RAD;
  run(world, quad, 0.5, rc({ throttle: th }), check);
  const residual = quad.gyro.length() * RAD;
  world.dispose();
  return { reached, target: quad.fc.maxRollRate(), residual, finite };
}

beforeAll(async () => {
  await initPhysics();
});

describe('stock rates as a Betaflight profile', () => {
  for (const cfg of DRONES) {
    it(`${cfg.name}: the Actual-rates profile is the same curve as the stock rates`, () => {
      const p = stockRateProfile(cfg);
      for (const axis of ['roll', 'pitch', 'yaw'] as const) {
        for (let s = -1; s <= 1.0001; s += 0.05) expect(rateDps(s, p, axis)).toBeCloseTo(actualRate(s, cfg.rates[axis]), 9);
      }
    });
  }
});

describe('imported rates fly', () => {
  for (const cfg of DRONES) {
    it(`${cfg.name}: tracks Betaflight's default 670 deg/s full-stick roll`, () => {
      const r = rollAndRelease(cfg, undefined, betaflightDefaults());
      expect(r.target).toBeCloseTo(670, 6);
      expect(r.reached).toBeGreaterThan(670 * 0.95);
      expect(r.reached).toBeLessThan(670 * 1.05);
      expect(r.residual).toBeLessThan(12);
    });
  }
});

describe('rate-loop editor ranges stay flyable', () => {
  // every corner of the response/damping box, with I and feed-forward at both ends
  const corners: Partial<CtrlTune>[] = [];
  const f = Object.fromEntries(CTRL_FIELDS.map((x) => [x.key, x]));
  for (const bandwidth of [f.bandwidth.min, f.bandwidth.max])
    for (const damping of [f.damping.min, f.damping.max])
      for (const [ki, ff] of [
        [f.ki.min, f.ff.min],
        [f.ki.max, f.ff.max],
      ])
        for (const yawScale of [f.yawScale.min, f.yawScale.max]) corners.push({ bandwidth, damping, ki, ff, yawScale });

  for (const cfg of DRONES) {
    it(`${cfg.name}: every corner tracks a roll and settles`, () => {
      for (const c of corners) {
        const ctrl = sanitizeCtrl(c, cfg.ctrl);
        const r = rollAndRelease(cfg, ctrl);
        const label = `${cfg.id} ${JSON.stringify(ctrl)}`;
        expect(r.finite, label).toBe(true);
        expect(r.reached / r.target, label).toBeGreaterThan(0.85);
        expect(r.reached / r.target, label).toBeLessThan(1.15);
        expect(r.residual, label).toBeLessThan(25);
      }
    });
  }
});

describe('stored tunes', () => {
  const cfg = DRONES[0];
  it('drops malformed parts and clamps the rate loop to the editor ranges', () => {
    expect(sanitizeTune(null, cfg)).toEqual({});
    expect(sanitizeTune('x', cfg)).toEqual({});
    const t = sanitizeTune({ ctrl: { bandwidth: 999, damping: 'soft', ki: -5 } }, cfg);
    expect(t.rates).toBeUndefined();
    expect(t.ctrl).toEqual({ ...cfg.ctrl, bandwidth: 70, ki: 0 });
  });
  it('keeps a valid rate profile', () => {
    const p = { ...betaflightDefaults(), type: 'QUICK' as const };
    expect(sanitizeTune({ rates: p }, cfg).rates).toEqual(p);
  });
});
