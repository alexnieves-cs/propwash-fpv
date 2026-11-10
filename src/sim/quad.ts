import { Quaternion, Vector3 } from 'three';
import { clamp, lerp, makeRng, saturate, smoothstep } from '../core/math';
import { CELL_REF_VOLTS, MOTOR_LAYOUT, type DroneConfig } from './drone-config';
import { FlightController, type RcCommand } from './flight-controller';
import { GRAVITY, RAPIER, type PhysicsWorld } from './physics-world';

/** Air and wind the quad is flying through. */
export interface Atmosphere {
  wind: Vector3;
  density: number;
}

export interface Impact {
  /** velocity change caused by the contact, m/s */
  strength: number;
  x: number;
  y: number;
  z: number;
  /** speed just before the hit, m/s */
  speed: number;
  hard: boolean;
}

const SOC_CURVE = [3.27, 3.5, 3.62, 3.7, 3.75, 3.79, 3.83, 3.87, 3.93, 4.0, 4.08, 4.2];
const SOC_KEYS = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function cellVoltage(soc: number): number {
  // past empty the cells collapse quickly: there is no flying on a flat pack
  if (soc < 0) return Math.max(2.5, SOC_CURVE[0] + soc * 7);
  const s = saturate(soc);
  for (let i = 1; i < SOC_KEYS.length; i++) {
    if (s <= SOC_KEYS[i]) {
      const t = (s - SOC_KEYS[i - 1]) / (SOC_KEYS[i] - SOC_KEYS[i - 1]);
      return lerp(SOC_CURVE[i - 1], SOC_CURVE[i], t);
    }
  }
  return SOC_CURVE[SOC_CURVE.length - 1];
}

const _up = new Vector3();
const _r = new Vector3();
const _vh = new Vector3();
const _vp = new Vector3();
const _f = new Vector3();
const _t = new Vector3();
const _tmp = new Vector3();
const _vb = new Vector3();
const _wb = new Vector3();
const _qi = new Quaternion();
const ZERO = { x: 0, y: 0, z: 0 };

/**
 * One quadcopter: a Rapier rigid body driven by per-motor thrust, rotor torque, aerodynamic drag
 * and a simulated battery, with a flight controller closing the loop at the physics rate.
 */
export class Quad {
  readonly fc: FlightController;
  readonly body: RAPIER.RigidBody;

  // --- kinematic state (world frame), refreshed after every physics step
  readonly pos = new Vector3();
  readonly quat = new Quaternion();
  readonly vel = new Vector3();
  readonly angVel = new Vector3();
  readonly prevPos = new Vector3();
  readonly prevQuat = new Quaternion();
  /** body-frame angular velocity */
  readonly gyro = new Vector3();
  readonly up = new Vector3(0, 1, 0);

  // --- motors
  readonly omega = new Float64Array(4);
  readonly thrust = new Float64Array(4);
  /** accumulated rotor angle, for drawing props */
  readonly propAngle = new Float64Array(4);
  private readonly noise = new Float64Array(4);

  // --- battery
  usedMah = 0;
  voltage: number;
  current = 0;
  unlimitedBattery = false;

  // --- telemetry
  agl = 100;
  speed = 0;
  airspeed = 0;
  gForce = 1;
  propwash = 0;
  contact = false;
  landed = false;
  /** seconds since the last contact with anything */
  airTime = 0;
  rpmFraction = 0;
  crashed = false;
  crashSpeed: number;
  readonly impacts: Impact[] = [];

  private readonly kT: number;
  private readonly vRef: number;
  private readonly force = new Vector3();
  private readonly torque = new Vector3();
  private readonly preVel = new Vector3();
  private aglTimer = 0;
  private impactCooldown = 0;
  private landedTimer = 0;
  private rng = makeRng(1234);
  private turtleTimer = 0;
  private aglMisses = 0;

  constructor(readonly physics: PhysicsWorld, readonly cfg: DroneConfig) {
    this.fc = new FlightController(cfg);
    this.kT = cfg.maxThrust / (cfg.maxOmega * cfg.maxOmega);
    this.vRef = cfg.battery.cells * CELL_REF_VOLTS;
    this.voltage = cfg.battery.cells * 4.2;
    this.crashSpeed = cfg.ducted ? 11 : 8;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 1, 0)
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setAdditionalMassProperties(cfg.mass, ZERO, cfg.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = physics.world.createRigidBody(desc);

    const add = (d: RAPIER.ColliderDesc) =>
      physics.world.createCollider(d.setDensity(0).setFriction(0.55).setRestitution(cfg.ducted ? 0.42 : 0.28), this.body);
    const b = cfg.collider.body;
    add(RAPIER.ColliderDesc.cuboid(b[0], b[1], b[2]));
    for (const m of MOTOR_LAYOUT) {
      add(
        RAPIER.ColliderDesc.cylinder(cfg.collider.guardHalfHeight, cfg.collider.guardRadius).setTranslation(
          m.sx * cfg.armX,
          cfg.collider.guardHalfHeight - b[1] + 0.004,
          m.sz * cfg.armZ,
        ),
      );
    }
    this.readBody();
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  /** Height of the body origin above the surface when resting on its skids. */
  get restHeight(): number {
    return this.cfg.collider.body[1];
  }

  reset(pos: Vector3, quat: Quaternion, freshPack = true): void {
    this.body.setTranslation(pos, true);
    this.body.setRotation(quat, true);
    this.body.setLinvel(ZERO, true);
    this.body.setAngvel(ZERO, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.omega.fill(0);
    this.thrust.fill(0);
    this.noise.fill(0);
    this.fc.reset();
    this.fc.armed = false;
    this.crashed = false;
    this.impacts.length = 0;
    this.propwash = 0;
    this.airTime = 0;
    this.landedTimer = 0;
    this.current = 0;
    if (freshPack) {
      this.usedMah = 0;
      this.voltage = this.cfg.battery.cells * 4.2;
    }
    this.readBody();
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.agl = 0;
    this.landed = true;
  }

  get soc(): number {
    return 1 - this.usedMah / this.cfg.battery.capacityMah;
  }

  get cellVolts(): number {
    return this.voltage / this.cfg.battery.cells;
  }

  /** Per-cell voltage with the load sag taken back out — what the pack would read at rest. */
  get restCellVolts(): number {
    return (this.voltage + this.current * this.cfg.battery.resistance) / this.cfg.battery.cells;
  }

  private readBody(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    this.vel.set(lv.x, lv.y, lv.z);
    this.angVel.set(av.x, av.y, av.z);
    _qi.copy(this.quat).invert();
    this.gyro.copy(this.angVel).applyQuaternion(_qi);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.speed = this.vel.length();
  }

  private gauss(): number {
    return (this.rng() + this.rng() + this.rng() + this.rng() - 2) * 1.732;
  }

  /** Flip the quad back onto its skids after it has come to rest upside down. */
  turtle(): boolean {
    if (this.up.y > 0.2 || this.speed > 1.5 || this.agl > 0.6) return false;
    this.turtleTimer = 1.4;
    return true;
  }

  /** Run the flight controller and apply all forces for the coming physics step. */
  preStep(dt: number, rc: RcCommand, air: Atmosphere): void {
    const cfg = this.cfg;
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);

    // ground distance, refreshed at 100 Hz
    this.aglTimer -= dt;
    if (this.aglTimer <= 0) {
      this.aglTimer = 0.01;
      // nudged off-axis: rays that graze a heightfield vertex exactly can slip through
      const d = this.physics.raycast(this.pos.x + 0.0137, this.pos.y, this.pos.z + 0.0071, 0, -1, 0, 600, this.body);
      if (d >= 0) this.agl = Math.max(0, d - this.restHeight);
      else if (this.aglMisses++ > 3) this.agl = 600;
      if (d >= 0) this.aglMisses = 0;
    }

    this.fc.update(dt, rc, {
      quat: this.quat,
      gyro: this.gyro,
      velWorld: this.vel,
      altitude: this.pos.y,
      agl: this.agl,
      landed: this.landed,
    });

    const up = _up.copy(this.up);
    const force = this.force.set(0, 0, 0);
    const torque = this.torque.set(0, 0, 0);
    const rho = air.density;
    const vScale = this.voltage / this.vRef;
    const discArea = Math.PI * cfg.propRadius * cfg.propRadius;

    // ---- prop wash: descending through our own wake shakes the airframe -------------------------
    let meanThrust = 0;
    for (let i = 0; i < 4; i++) meanThrust += this.thrust[i];
    meanThrust *= 0.25;
    const hoverThrust = (cfg.mass * GRAVITY) / 4;
    const vInd = Math.sqrt(Math.max(meanThrust, hoverThrust * 0.35) / (2 * rho * discArea));
    _tmp.copy(this.vel).sub(air.wind);
    const vAxBody = _tmp.dot(up);
    const vLat = Math.sqrt(Math.max(0, _tmp.lengthSq() - vAxBody * vAxBody));
    const descent = -vAxBody / vInd;
    const pwTarget =
      smoothstep(0.25, 0.75, descent) *
      (1 - smoothstep(1.4, 2.2, descent)) *
      saturate(1 - vLat / (vInd * 1.6)) *
      saturate((meanThrust / cfg.maxThrust) * 8);
    this.propwash += (pwTarget - this.propwash) * (1 - Math.exp(-dt / 0.07));

    // ---- ground effect ---------------------------------------------------------------------------
    const rEff = Math.hypot(cfg.armX, cfg.armZ) + cfg.propRadius;
    const zG = Math.max(this.agl + 0.02, rEff * 0.32);
    const groundEffect = up.y > 0.5 ? Math.min(1.45, 1 / (1 - (rEff / (4 * zG)) ** 2)) : 1;

    // ---- motors -----------------------------------------------------------------------------------
    let mechPower = 0;
    let rpmSum = 0;
    const noiseTau = 0.014;
    const nDecay = Math.exp(-dt / noiseTau);
    const nDrive = Math.sqrt(1 - nDecay * nDecay);
    for (let i = 0; i < 4; i++) {
      const m = MOTOR_LAYOUT[i];
      const w0 = this.omega[i];
      const target = this.fc.motors[i] * cfg.maxOmega * vScale;
      const tau = this.fc.armed ? (target > w0 ? cfg.tauUp : cfg.tauDown) : cfg.tauDown * 5;
      const w = w0 + (target - w0) * (1 - Math.exp(-dt / tau));
      const wDot = (w - w0) / dt;
      this.omega[i] = w;
      this.propAngle[i] += w * m.spin * dt;
      rpmSum += w;

      _r.set(m.sx * cfg.armX, 0, m.sz * cfg.armZ).applyQuaternion(this.quat);
      // hub velocity through the air
      _vh.copy(this.angVel).cross(_r).add(this.vel).sub(air.wind);
      const vAx = _vh.dot(up);
      const vZero = Math.max(cfg.inflowFactor * w, 0.5);
      const inflow = clamp(1 - vAx / vZero, 0, 1.3);

      this.noise[i] = this.noise[i] * nDecay + this.gauss() * nDrive;
      const wobble = 1 + this.noise[i] * (0.004 + 0.2 * this.propwash) - 0.16 * this.propwash;

      const staticThrust = this.kT * w * w * (rho / 1.225);
      const T = staticThrust * inflow * groundEffect * wobble;
      this.thrust[i] = T;
      const Q = cfg.torqueRatio * staticThrust * (0.55 + 0.45 * inflow);
      mechPower += Q * w;

      // thrust
      _f.copy(up).multiplyScalar(T);
      // rotor in-plane drag (H-force)
      _vp.copy(up).multiplyScalar(-vAx).add(_vh);
      _f.addScaledVector(_vp, -cfg.rotorDrag * w);
      force.add(_f);
      torque.add(_t.copy(_r).cross(_f));
      // reaction torque from rotor drag and from spinning the rotor up or down
      torque.addScaledVector(up, -m.spin * (Q + cfg.rotorInertia * wDot));
    }
    this.rpmFraction = rpmSum / (4 * cfg.maxOmega);

    // ---- airframe drag ----------------------------------------------------------------------------
    _qi.copy(this.quat).invert();
    _vb.copy(this.vel).sub(air.wind);
    this.airspeed = _vb.length();
    _vb.applyQuaternion(_qi);
    const q = 0.5 * rho * this.airspeed;
    _f.set(-q * cfg.cdA.x * _vb.x, -q * cfg.cdA.y * _vb.y, -q * cfg.cdA.z * _vb.z).applyQuaternion(this.quat);
    force.add(_f);

    _wb.copy(this.gyro);
    const wMag = _wb.length();
    _t.copy(_wb).multiplyScalar(-(cfg.angDragLin + cfg.angDragQuad * wMag)).applyQuaternion(this.quat);
    torque.add(_t);

    // ---- turtle mode: an assisted flip back onto the skids -------------------------------------
    if (this.turtleTimer > 0) {
      this.turtleTimer -= dt;
      const angle = Math.acos(clamp(up.y, -1, 1));
      _t.set(-up.z, 0, up.x); // up × world-up
      if (_t.lengthSq() < 0.01) _t.set(0, 0, 1).applyQuaternion(this.quat);
      _t.normalize().multiplyScalar(Math.min(angle * 6, 9));
      const iAvg = (cfg.inertia.x + cfg.inertia.y + cfg.inertia.z) / 3;
      _t.sub(this.angVel).multiplyScalar(iAvg * 45);
      torque.add(_t);
      if (angle > 0.35) force.y += cfg.mass * GRAVITY * 1.25;
      if (angle < 0.12) this.turtleTimer = 0;
    }

    // ---- battery ----------------------------------------------------------------------------------
    const eff = cfg.efficiency * (0.62 + 0.38 * saturate(this.rpmFraction * 2.2));
    const current = this.fc.armed ? mechPower / (eff * Math.max(this.voltage, 1)) + 4 * cfg.idleCurrent : 0;
    this.current += (current - this.current) * (1 - Math.exp(-dt / 0.02));
    if (!this.unlimitedBattery) this.usedMah += (this.current * dt * 1000) / 3600;
    const open = cfg.battery.cells * cellVoltage(this.unlimitedBattery ? 0.85 : this.soc);
    const sagged = Math.max(open - this.current * cfg.battery.resistance, cfg.battery.cells * 2.7);
    this.voltage += (sagged - this.voltage) * (1 - Math.exp(-dt / 0.03));

    this.gForce = force.length() / (cfg.mass * GRAVITY);
    this.preVel.copy(this.vel);

    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.body.addForce(force, true);
    this.body.addTorque(torque, true);
  }

  /** Read the integrated state back and work out whether we hit something. */
  postStep(dt: number): void {
    const speedBefore = this.preVel.length();
    this.readBody();

    // anything the applied forces + gravity can't explain is a contact impulse
    _tmp.copy(this.force).multiplyScalar(dt / this.cfg.mass);
    _tmp.y -= GRAVITY * dt;
    _tmp.add(this.preVel);
    const jolt = _tmp.distanceTo(this.vel);
    this.contact = jolt > 0.012;
    this.airTime = this.contact ? 0 : this.airTime + dt;

    this.impactCooldown -= dt;
    if (jolt > 0.35) {
      const hard = jolt >= this.crashSpeed;
      if (hard) this.crashed = true;
      if (this.impactCooldown <= 0 || hard) {
        this.impacts.push({ strength: jolt, x: this.pos.x, y: this.pos.y, z: this.pos.z, speed: speedBefore, hard });
        this.impactCooldown = 0.09;
      }
      // a spinning prop that touches something kicks the airframe around
      if (this.fc.armed && this.rpmFraction > 0.15 && !this.cfg.ducted) {
        const kick = Math.min(jolt, 6) * 1.6 * this.rpmFraction;
        const iAvg = (this.cfg.inertia.x + this.cfg.inertia.y + this.cfg.inertia.z) / 3;
        _t.set(this.gauss(), this.gauss() * 1.5, this.gauss()).multiplyScalar(kick * iAvg * 0.6);
        this.body.applyTorqueImpulse(_t, true);
      }
    }

    const resting = this.agl < 0.05 && this.speed < 0.35 && this.up.y > 0.7;
    this.landedTimer = resting ? this.landedTimer + dt : 0;
    this.landed = this.landedTimer > 0.12;
  }
}
