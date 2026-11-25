import { beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DRONES, hoverThrottle, type DroneConfig } from '../src/sim/drone-config';
import { FlightController, type FcInputs, type RcCommand } from '../src/sim/flight-controller';
import { PHYSICS_DT, PhysicsWorld, initPhysics } from '../src/sim/physics-world';
import { Quad, type Atmosphere } from '../src/sim/quad';

/**
 * Golden traces recorded from v1.0.0. They pin the default flight behaviour: any change to the
 * flight controller, the mixer or the physics that alters what an untuned airframe does fails
 * here. Numbers are rounded to 9 significant digits, and anything under 1e-9 counts as zero, so
 * last-bit maths differences between machines don't count as a change.
 */

const air: Atmosphere = { wind: new Vector3(), density: 1.225 };
const dt = PHYSICS_DT;

const r = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : Number(v.toPrecision(9)));

function rc(p: Partial<RcCommand> = {}): RcCommand {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0, climb: 0, ...p };
}

/** A scripted closed-loop flight: acro sticks on every axis, then angle mode, then altitude hold. */
function closedLoop(cfg: DroneConfig): number[][] {
  const world = new PhysicsWorld();
  world.addBox(0, -1, 0, 4000, 1, 4000);
  const quad = new Quad(world, cfg);
  quad.unlimitedBattery = true;
  quad.reset(new Vector3(0, 60, 0), new Quaternion());
  quad.fc.armed = true;
  const th = hoverThrottle(cfg);
  const script = (t: number): RcCommand => {
    if (t < 0.4) return rc({ throttle: th });
    if (t < 0.8) return rc({ throttle: th, roll: 0.7 });
    if (t < 1.1) return rc({ throttle: th * 1.3, pitch: -0.5, yaw: 0.4 });
    if (t < 1.4) return rc({ throttle: th, roll: -0.3, pitch: 0.9, yaw: -1 });
    return rc({ throttle: th * 0.9, roll: Math.sin(t * 9) * 0.6, pitch: Math.cos(t * 7) * 0.4, yaw: 0.2 });
  };
  const rows: number[][] = [];
  const n = Math.round(2.6 / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    if (i === Math.round(1.8 / dt)) quad.fc.mode = 'angle';
    if (i === Math.round(2.2 / dt)) quad.fc.altHold = true;
    quad.preStep(dt, script(t), air);
    world.step();
    quad.postStep(dt);
    if (i % 25 === 24) {
      rows.push(
        [quad.pos.x, quad.pos.y, quad.pos.z, quad.quat.x, quad.quat.y, quad.quat.z, quad.quat.w, quad.voltage, ...quad.fc.motors, ...quad.fc.setpoint].map(r),
      );
    }
  }
  world.dispose();
  return rows;
}

/** The flight controller alone, fed a fixed synthetic attitude/gyro sequence, so no physics is involved. */
function openLoop(cfg: DroneConfig): number[][] {
  const fc = new FlightController(cfg);
  fc.armed = true;
  const s: FcInputs = { quat: new Quaternion(), gyro: new Vector3(), velWorld: new Vector3(), altitude: 20, agl: 20, landed: false };
  const rows: number[][] = [];
  const axisAngle = new Vector3();
  for (let i = 0; i < 1500; i++) {
    const t = i * dt;
    if (i === 500) fc.mode = 'horizon';
    if (i === 1000) {
      fc.mode = 'angle';
      fc.altHold = true;
    }
    axisAngle.set(Math.sin(t * 3), 0.3, Math.cos(t * 2)).normalize();
    s.quat.setFromAxisAngle(axisAngle, 0.6 * Math.sin(t * 1.7));
    s.gyro.set(Math.sin(t * 13) * 4, Math.cos(t * 5) * 2, Math.sin(t * 7 + 1) * 6);
    s.velWorld.set(Math.sin(t), Math.cos(t * 0.7) * 2, 0);
    s.altitude = 20 + Math.sin(t * 0.9);
    const cmd = rc({ roll: Math.sin(t * 4.1), pitch: Math.cos(t * 3.3) * 0.8, yaw: Math.sin(t * 2.2 + 0.4), throttle: 0.5 + 0.5 * Math.sin(t * 1.3), climb: Math.sin(t * 0.8) });
    fc.update(dt, cmd, s);
    if (i % 20 === 19) rows.push([...fc.motors, ...fc.setpoint, fc.collective].map(r));
  }
  return rows;
}

beforeAll(async () => {
  await initPhysics();
});

describe('v1.0.0 golden traces', () => {
  for (const cfg of DRONES) {
    it(`${cfg.name}: flight controller output is unchanged`, () => {
      expect(openLoop(cfg)).toMatchSnapshot();
    });
    it(`${cfg.name}: closed-loop flight is unchanged`, () => {
      expect(closedLoop(cfg)).toMatchSnapshot();
    });
  }
});
