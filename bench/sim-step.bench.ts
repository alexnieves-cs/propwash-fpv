import { Quaternion, Vector3 } from 'three';
import { bench, describe } from 'vitest';
import { DRONES, getDrone } from '../src/sim/drone-config';
import { FlightController, type FcInputs } from '../src/sim/flight-controller';
import { PHYSICS_DT, initPhysics } from '../src/sim/physics-world';
import { flatWorld, forestWorld, stepper, sticks } from './scenario';

/**
 * Cost of one 500 Hz simulation step, in Node, without rendering. Run with `npm run bench`.
 * Each benchmark iteration is exactly one step, so the reported times are per step.
 * Results and the machine they came from are in docs/PERFORMANCE.md.
 */

await initPhysics();

const dt = PHYSICS_DT;
const OPTS = { time: 1500, warmupTime: 300 };

describe('flight controller only (FlightController.update)', () => {
  for (const cfg of DRONES) {
    const fc = new FlightController(cfg);
    fc.armed = true;
    fc.mode = 'angle';
    const s: FcInputs = { quat: new Quaternion(), gyro: new Vector3(), velWorld: new Vector3(), altitude: 20, agl: 20, landed: false };
    const cmd = sticks(cfg);
    let i = 0;
    bench(cfg.name, () => {
      const t = i * dt;
      s.gyro.set(Math.sin(t * 13), Math.cos(t * 5), Math.sin(t * 7));
      fc.update(dt, cmd(i++), s);
    }, OPTS);
  }
});

describe('full step, flat ground (Quad.preStep + Rapier step + Quad.postStep)', () => {
  for (const cfg of DRONES) {
    const { step } = stepper(flatWorld(), cfg, new Vector3(0, 5, 0));
    bench(cfg.name, step, OPTS);
  }
});

describe('full step, terrain and 18k trees', () => {
  for (const id of ['freestyle5', 'whoop65']) {
    const cfg = getDrone(id);
    // a world each, so the other quad isn't in it; hover low in the clearing next to the trees
    const { step } = stepper(forestWorld(), cfg, new Vector3(0, 4, 0));
    bench(cfg.name, step, OPTS);
  }
});
