import { beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEG, RAD } from '../src/core/math';
import { DRONES, getDrone, hoverThrottle, type DroneConfig } from '../src/sim/drone-config';
import { actualRate, type RcCommand } from '../src/sim/flight-controller';
import { PHYSICS_DT, PhysicsWorld, initPhysics } from '../src/sim/physics-world';
import { Quad, type Atmosphere } from '../src/sim/quad';

const air: Atmosphere = { wind: new Vector3(), density: 1.225 };
const dt = PHYSICS_DT;

function rc(p: Partial<RcCommand> = {}): RcCommand {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0, climb: 0, ...p };
}

function setup(cfg: DroneConfig, altitude = 50): { world: PhysicsWorld; quad: Quad } {
  const world = new PhysicsWorld();
  world.addBox(0, -1, 0, 4000, 1, 4000);
  const quad = new Quad(world, cfg);
  quad.unlimitedBattery = true;
  quad.reset(new Vector3(0, altitude, 0), new Quaternion());
  return { world, quad };
}

function run(world: PhysicsWorld, quad: Quad, seconds: number, cmd: RcCommand | ((t: number) => RcCommand), each?: (t: number) => void): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    quad.preStep(dt, typeof cmd === 'function' ? cmd(t) : cmd, air);
    world.step();
    quad.postStep(dt);
    each?.(t);
  }
}

beforeAll(async () => {
  await initPhysics();
});

describe('physics world', () => {
  it('maps heightfield samples to the right world positions', () => {
    const world = new PhysicsWorld();
    const nx = 20;
    const nz = 30;
    const sx = 200;
    const sz = 300;
    const h = new Float32Array((nx + 1) * (nz + 1));
    const f = (x: number, z: number) => 0.1 * x + 0.3 * z + 5;
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) h[iz * (nx + 1) + ix] = f((ix / nx - 0.5) * sx, (iz / nz - 0.5) * sz);
    }
    world.addHeightfield(nx, nz, h, sx, sz);
    world.step();
    for (const [x, z] of [[11.3, -20.7], [-70.2, 113.1], [55, 5], [0.4, 0.3], [93.1, 141.7]]) {
      const d = world.raycast(x, 500, z, 0, -1, 0, 1000);
      expect(500 - d).toBeCloseTo(f(x, z), 1);
    }
  });
});

describe('rates', () => {
  it('hits centre sensitivity and max rate', () => {
    const r = { center: 200, max: 800, expo: 0.5 };
    expect(actualRate(1, r)).toBeCloseTo(800, 5);
    expect(actualRate(-1, r)).toBeCloseTo(-800, 5);
    expect(actualRate(0.001, r) / 0.001).toBeCloseTo(200, 0);
    expect(actualRate(0.5, r)).toBeLessThan(400);
  });
});

for (const cfg of DRONES) {
  describe(`${cfg.name} flight model`, () => {
    it('hovers at the computed hover throttle', () => {
      const { world, quad } = setup(cfg);
      quad.fc.armed = true;
      const th = hoverThrottle(cfg);
      // unlimited battery sits a little above the reference voltage, so expect a gentle climb at most
      run(world, quad, 2, rc({ throttle: th }));
      expect(Math.abs(quad.vel.y)).toBeLessThan(4);
      expect(quad.up.y).toBeGreaterThan(0.999);
      world.dispose();
    });

    it('tracks a full-stick roll at the configured max rate', () => {
      const { world, quad } = setup(cfg);
      quad.fc.armed = true;
      const th = hoverThrottle(cfg);
      run(world, quad, 0.5, rc({ throttle: th }));
      let peak = 0;
      let t63 = -1;
      const target = cfg.rates.roll.max * DEG;
      run(world, quad, 0.4, rc({ throttle: th, roll: 1 }), (t) => {
        const rate = -quad.gyro.z;
        peak = Math.max(peak, rate);
        if (t63 < 0 && rate > 0.63 * target) t63 = t;
      });
      const rate = -quad.gyro.z;
      expect(rate * RAD).toBeGreaterThan(cfg.rates.roll.max * 0.95);
      expect(rate * RAD).toBeLessThan(cfg.rates.roll.max * 1.05);
      expect(peak / target).toBeLessThan(1.15);
      expect(t63).toBeGreaterThan(0);
      expect(t63).toBeLessThan(0.09);
      world.dispose();
    });

    it('stops rotating when the stick is released', () => {
      const { world, quad } = setup(cfg);
      quad.fc.armed = true;
      const th = hoverThrottle(cfg);
      run(world, quad, 0.3, rc({ throttle: th, pitch: 1, yaw: 0.5 }));
      run(world, quad, 0.35, rc({ throttle: th }));
      expect(quad.gyro.length() * RAD).toBeLessThan(12);
      world.dispose();
    });

    it('self-levels in angle mode and holds a commanded tilt', () => {
      const { world, quad } = setup(cfg);
      quad.fc.armed = true;
      quad.fc.mode = 'angle';
      const th = hoverThrottle(cfg);
      run(world, quad, 1.0, rc({ throttle: th, roll: 0.5 }));
      const tilt = Math.acos(quad.up.y) * RAD;
      expect(tilt).toBeGreaterThan(24);
      expect(tilt).toBeLessThan(31);
      run(world, quad, 1.0, rc({ throttle: th }));
      expect(Math.acos(quad.up.y) * RAD).toBeLessThan(2);
      world.dispose();
    });

    it('holds altitude with altitude hold on', () => {
      const { world, quad } = setup(cfg);
      quad.fc.armed = true;
      quad.fc.mode = 'angle';
      quad.fc.altHold = true;
      run(world, quad, 1.5, rc());
      const y0 = quad.pos.y;
      run(world, quad, 3, rc({ pitch: 0.4 }));
      expect(Math.abs(quad.pos.y - y0)).toBeLessThan(0.8);
      run(world, quad, 1.5, rc({ climb: 1 }));
      expect(quad.vel.y).toBeGreaterThan(quad.fc.maxClimb * 0.6);
      world.dispose();
    });

    it('flies an automatic roll and flip and recovers upright', () => {
      for (const kind of ['rollRight', 'flipBack'] as const) {
        const { world, quad } = setup(cfg);
        quad.fc.armed = true;
        quad.fc.mode = 'angle';
        const th = hoverThrottle(cfg);
        run(world, quad, 0.5, rc({ throttle: th }));
        const y0 = quad.pos.y;
        expect(quad.fc.startTrick(kind, 50)).toBe(true);
        let minUp = 1;
        run(world, quad, 1.6, rc({ throttle: th }), () => {
          minUp = Math.min(minUp, quad.up.y);
        });
        expect(minUp).toBeLessThan(-0.9);
        expect(quad.up.y).toBeGreaterThan(0.97);
        expect(quad.fc.trick).toBeNull();
        expect(y0 - quad.pos.y).toBeLessThan(6);
        world.dispose();
      }
    });

    it('reports plausible performance', () => {
      const { world, quad } = setup(cfg, 400);
      quad.fc.armed = true;
      const th = hoverThrottle(cfg);
      run(world, quad, 1, rc({ throttle: th }));
      const hoverAmps = quad.current;
      // pitch over to ~80° and pin the throttle
      const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -80 * DEG);
      quad.body.setRotation(q, true);
      let top = 0;
      let amps = 0;
      run(world, quad, 14, rc({ throttle: 1 }), () => {
        top = Math.max(top, Math.hypot(quad.vel.x, quad.vel.z));
        amps = Math.max(amps, quad.current);
      });
      const twr = (4 * cfg.maxThrust) / (cfg.mass * 9.81);
      console.log(
        `${cfg.name}: TWR ${twr.toFixed(1)}, hover ${(th * 100).toFixed(0)}% / ${hoverAmps.toFixed(1)} A, ` +
          `top speed ${(top * 3.6).toFixed(0)} km/h, max ${amps.toFixed(0)} A`,
      );
      expect(top * 3.6).toBeGreaterThan(cfg.id === 'whoop65' ? 35 : 80);
      expect(top * 3.6).toBeLessThan(230);
      world.dispose();
    });
  });
}

describe('ground handling and crashes', () => {
  it('sits still on the ground when armed at idle', () => {
    const cfg = getDrone('freestyle5');
    const { world, quad } = setup(cfg, 0.05);
    run(world, quad, 0.6, rc());
    quad.fc.armed = true;
    run(world, quad, 2, rc());
    expect(quad.landed).toBe(true);
    expect(quad.pos.y).toBeLessThan(0.06);
    expect(Math.hypot(quad.pos.x, quad.pos.z)).toBeLessThan(0.05);
    expect(quad.up.y).toBeGreaterThan(0.999);
    world.dispose();
  });

  it('registers a hard crash after a long fall', () => {
    const cfg = getDrone('freestyle5');
    const { world, quad } = setup(cfg, 30);
    run(world, quad, 4, rc());
    expect(quad.crashed).toBe(true);
    expect(quad.impacts.some((i) => i.hard)).toBe(true);
    world.dispose();
  });

  it('does not flag a gentle landing as a crash', () => {
    const cfg = getDrone('freestyle5');
    const { world, quad } = setup(cfg, 1.5);
    quad.fc.armed = true;
    quad.fc.mode = 'angle';
    quad.fc.altHold = true;
    run(world, quad, 4, rc({ climb: -0.3 }));
    expect(quad.crashed).toBe(false);
    expect(quad.landed).toBe(true);
    world.dispose();
  });

  it('turtle mode rights an inverted quad', () => {
    const cfg = getDrone('freestyle5');
    const { world, quad } = setup(cfg, 0.1);
    quad.body.setRotation(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI), true);
    run(world, quad, 1, rc());
    expect(quad.up.y).toBeLessThan(-0.9);
    expect(quad.turtle()).toBe(true);
    run(world, quad, 2.5, rc());
    expect(quad.up.y).toBeGreaterThan(0.9);
    world.dispose();
  });
});
