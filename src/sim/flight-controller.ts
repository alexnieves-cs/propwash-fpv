import { Euler, Quaternion, Vector3 } from 'three';
import { DEG, clamp, pt1Gain, saturate } from '../core/math';
import { MOTOR_LAYOUT, hoverThrottle, type AxisRates, type DroneConfig, type Rates } from './drone-config';
import { rateDps, type RateProfile } from './rates';

export type FlightMode = 'acro' | 'horizon' | 'angle';
export type TrickKind = 'rollLeft' | 'rollRight' | 'flipFront' | 'flipBack';

/** Normalised stick commands. Positive roll = right, pitch = nose down, yaw = right. */
export interface RcCommand {
  roll: number;
  pitch: number;
  yaw: number;
  /** throttle stick, 0..1 */
  throttle: number;
  /** climb axis used by altitude hold, -1..1 */
  climb: number;
}

export interface FcInputs {
  /** body → world attitude */
  quat: Quaternion;
  /** body-frame angular velocity, rad/s (three.js axes) */
  gyro: Vector3;
  velWorld: Vector3;
  altitude: number;
  agl: number;
  landed: boolean;
}

interface TrickState {
  kind: TrickKind;
  axis: 0 | 1;
  dir: number;
  rate: number;
  total: number;
  angle: number;
  phase: 0 | 1 | 2;
  t: number;
  pop: number;
}

/** Betaflight "Actual" rates: stick (-1..1) → deg/s. */
export function actualRate(stick: number, r: AxisRates): number {
  const a = Math.abs(stick);
  const expof = a * (Math.pow(stick, 5) * r.expo + stick * (1 - r.expo));
  return stick * r.center + Math.max(0, r.max - r.center) * expof;
}

const _fwd = new Vector3();
const _right = new Vector3();
const _v = new Vector3();
const _qT = new Quaternion();
const _qE = new Quaternion();
const _qI = new Quaternion();
const _eul = new Euler();

/**
 * A compact Betaflight-style flight controller: rate setpoints from sticks, a PID+FF rate loop
 * that works in physical units (rad/s²), self-levelling outer loops, altitude hold, and an
 * airmode mixer that keeps full attitude authority at zero throttle.
 */
export class FlightController {
  mode: FlightMode = 'acro';
  altHold = false;
  armed = false;
  /** stock-style Actual rates, used when `rateProfile` is null (v1.0 behaviour) */
  rates: Rates;
  /** a Betaflight rate profile from the tuning screen; replaces `rates` when set */
  rateProfile: RateProfile | null = null;
  /** output multiplier for `rateProfile` (the Settings rate slider) */
  rateScale = 1;
  /** max tilt in angle mode, rad */
  maxAngle = 55 * DEG;
  levelGain = 9;
  maxClimb = 7;
  maxSink = 5;
  throttleLimit = 1;

  /** motor signals, 0..1 */
  readonly motors = new Float64Array(4);
  /** rate setpoint, rad/s: roll, pitch, yaw */
  readonly setpoint = new Float64Array(3);
  /** collective motor signal actually commanded (telemetry) */
  collective = 0;
  trick: TrickState | null = null;

  private readonly kp = new Float64Array(3);
  private readonly kd = new Float64Array(3);
  private readonly ki = new Float64Array(3);
  private readonly kff = new Float64Array(3);
  private readonly inertia = new Float64Array(3);
  private readonly iTerm = new Float64Array(3);
  private readonly prevGyro = new Float64Array(3);
  private readonly dFilt = new Float64Array(3);
  private readonly spSmooth = new Float64Array(3);
  private readonly prevSp = new Float64Array(3);
  private readonly ffFilt = new Float64Array(3);
  private readonly du = new Float64Array(4);
  private ahI = 0;
  private ahTarget = NaN;
  private readonly hover: number;

  constructor(readonly cfg: DroneConfig) {
    this.rates = JSON.parse(JSON.stringify(cfg.rates)) as Rates;
    this.hover = hoverThrottle(cfg);
    this.setCtrl(cfg.ctrl);
    this.inertia[0] = cfg.inertia.z;
    this.inertia[1] = cfg.inertia.x;
    this.inertia[2] = cfg.inertia.y;
  }

  /**
   * Set the rate-loop gains from closed-loop targets. Called with the airframe's own `ctrl`
   * block on construction; the tuning screen calls it again with the pilot's values. Running
   * state (integrators, filters) is kept, so this is safe mid-flight.
   */
  setCtrl(ctrl: DroneConfig['ctrl']): void {
    const cfg = this.cfg;
    const tau = (cfg.tauUp + cfg.tauDown) / 2;
    for (let a = 0; a < 2; a++) {
      // second-order response through the motor lag: pick P and D for the wanted bandwidth/damping
      const wn = ctrl.bandwidth;
      this.kp[a] = tau * wn * wn;
      this.kd[a] = Math.max(0, 2 * ctrl.damping * tau * wn - 1);
      this.ki[a] = ctrl.ki;
      this.kff[a] = ctrl.ff;
    }
    // Yaw is different: spinning a rotor up or down reacts on the frame immediately, so the yaw
    // plant has a strong lead (zero at `z`). P only, sized for the wanted crossover; no D.
    const kT = cfg.maxThrust / (cfg.maxOmega * cfg.maxOmega);
    const wHover = Math.sqrt((cfg.mass * 9.81) / (4 * kT));
    const z = (2 * cfg.torqueRatio * kT * wHover) / cfg.rotorInertia;
    const wc = ctrl.bandwidth * ctrl.yawScale;
    this.kp[2] = (wc * Math.sqrt(1 + (wc * tau) ** 2)) / Math.sqrt(1 + (wc / z) ** 2);
    this.kd[2] = 0;
    this.ki[2] = this.kp[2] * 9;
    this.kff[2] = 0.12;
  }

  /** Full-stick roll rate, deg/s, with whichever rates are active. */
  maxRollRate(): number {
    return this.rateProfile ? rateDps(1, this.rateProfile, 'roll') * this.rateScale : this.rates.roll.max;
  }

  private stickRate(stick: number, axis: 'roll' | 'pitch' | 'yaw'): number {
    const rp = this.rateProfile;
    return rp ? rateDps(stick, rp, axis) * this.rateScale : actualRate(stick, this.rates[axis]);
  }

  reset(): void {
    this.iTerm.fill(0);
    this.prevGyro.fill(0);
    this.dFilt.fill(0);
    this.spSmooth.fill(0);
    this.prevSp.fill(0);
    this.ffFilt.fill(0);
    this.motors.fill(0);
    this.setpoint.fill(0);
    this.ahI = 0;
    this.ahTarget = NaN;
    this.trick = null;
    this.collective = 0;
  }

  /** Start an automatic flip/roll. Returns false when it can't be flown right now. */
  startTrick(kind: TrickKind, agl: number): boolean {
    if (!this.armed || this.trick) return false;
    if (agl < 1.2) return false;
    const roll = kind === 'rollLeft' || kind === 'rollRight';
    this.trick = {
      kind,
      axis: roll ? 0 : 1,
      dir: kind === 'rollRight' || kind === 'flipFront' ? 1 : -1,
      rate: Math.min(roll ? 900 : 780, Math.max(this.maxRollRate(), 540)) * DEG,
      total: Math.PI * 2,
      angle: 0,
      phase: 0,
      t: 0,
      pop: roll ? 0.09 : 0.16,
    };
    return true;
  }

  update(dt: number, rc: RcCommand, s: FcInputs): void {
    const cfg = this.cfg;
    if (!this.armed) {
      this.reset();
      return;
    }

    const g0 = -s.gyro.z;
    const g1 = -s.gyro.x;
    const g2 = -s.gyro.y;

    let sp0 = this.stickRate(rc.roll, 'roll') * DEG;
    let sp1 = this.stickRate(rc.pitch, 'pitch') * DEG;
    let sp2 = this.stickRate(rc.yaw, 'yaw') * DEG;
    let throttle = rc.throttle;
    let useAltHold = this.altHold;

    // ---- self-levelling outer loop -------------------------------------------------------
    if (this.mode !== 'acro' && !this.trick) {
      _fwd.set(0, 0, -1).applyQuaternion(s.quat);
      _right.set(1, 0, 0).applyQuaternion(s.quat);
      const fh = _fwd.x * _fwd.x + _fwd.z * _fwd.z;
      const rh = _right.x * _right.x + _right.z * _right.z;
      const heading = rh >= fh ? Math.atan2(-_right.z, _right.x) : Math.atan2(-_fwd.x, -_fwd.z);
      const angle = this.mode === 'angle';
      const tp = angle ? rc.pitch * this.maxAngle : 0;
      const tr = angle ? rc.roll * this.maxAngle : 0;
      _qT.setFromEuler(_eul.set(-tp, heading, -tr, 'YXZ'));
      _qI.copy(s.quat).invert();
      _qE.copy(_qI).multiply(_qT);
      if (_qE.w < 0) _qE.set(-_qE.x, -_qE.y, -_qE.z, -_qE.w);
      const sinHalf = Math.sqrt(_qE.x * _qE.x + _qE.y * _qE.y + _qE.z * _qE.z);
      const ang = 2 * Math.atan2(sinHalf, _qE.w);
      const k = sinHalf > 1e-6 ? (ang / sinHalf) * this.levelGain : 2 * this.levelGain;
      let lx = _qE.x * k;
      let lz = _qE.z * k;
      const lim = 9;
      const lm = Math.hypot(lx, lz);
      if (lm > lim) {
        lx *= lim / lm;
        lz *= lim / lm;
      }
      if (angle) {
        // yaw about the world vertical so turns stay coordinated while tilted
        _v.set(0, -sp2, 0).applyQuaternion(_qI);
        sp0 = -(lz + _v.z);
        sp1 = -(lx + _v.x);
        sp2 = -_v.y;
      } else {
        const strength = saturate(1 - Math.max(Math.abs(rc.roll), Math.abs(rc.pitch)) * 1.3);
        sp0 += -lz * strength;
        sp1 += -lx * strength;
      }
    }

    // ---- automatic tricks ------------------------------------------------------------------
    const tk = this.trick;
    if (tk) {
      useAltHold = false;
      tk.t += dt;
      if (tk.phase === 0) {
        throttle = Math.max(throttle, Math.min(1, this.hover * 2.6));
        sp0 = 0;
        sp1 = 0;
        if (tk.t >= tk.pop) {
          tk.phase = 1;
          tk.t = 0;
        }
      } else if (tk.phase === 1) {
        tk.angle += (tk.axis === 0 ? g0 : g1) * tk.dir * dt;
        const remaining = tk.total - tk.angle;
        const rate = Math.min(tk.rate, Math.sqrt(2 * 55 * Math.max(remaining, 0)) + 0.8);
        sp0 = tk.axis === 0 ? tk.dir * rate : 0;
        sp1 = tk.axis === 1 ? tk.dir * rate : 0;
        const c = Math.cos(tk.angle);
        throttle = c > 0.3 ? this.hover * c * 1.1 : 0;
        if (remaining < 0.1 || tk.t > 1.8) {
          tk.phase = 2;
          tk.t = 0;
        }
      } else {
        if (s.velWorld.y < -0.5) throttle = Math.max(throttle, Math.min(1, this.hover * 1.9));
        if (tk.t > 0.2) this.trick = null;
      }
    }

    // ---- collective thrust -----------------------------------------------------------------
    const idleU = cfg.idle * cfg.idle;
    let uColl: number;
    let idling = false;
    if (useAltHold) {
      const dead = Math.abs(rc.climb) < 0.06;
      if (s.landed && rc.climb <= 0.06) {
        uColl = idleU;
        idling = true;
        this.ahI = 0;
        this.ahTarget = NaN;
      } else {
        let vCmd = rc.climb >= 0 ? rc.climb * this.maxClimb : rc.climb * this.maxSink;
        if (dead) {
          if (Number.isNaN(this.ahTarget)) this.ahTarget = s.altitude + s.velWorld.y * 0.25;
          vCmd = clamp((this.ahTarget - s.altitude) * 1.6, -3, 3);
        } else {
          this.ahTarget = NaN;
        }
        const err = vCmd - s.velWorld.y;
        this.ahI = clamp(this.ahI + err * dt * 1.5, -5, 5);
        const az = clamp(err * 5.5 + this.ahI, -8.5, 16);
        _v.set(0, 1, 0).applyQuaternion(s.quat);
        const thrust = (cfg.mass * (9.81 + az)) / clamp(_v.y, 0.4, 1);
        uColl = clamp(thrust / (4 * cfg.maxThrust), idleU, 1);
      }
    } else {
      this.ahI = 0;
      this.ahTarget = NaN;
      const t = saturate(throttle) * this.throttleLimit;
      const c = cfg.idle + (1 - cfg.idle) * t;
      uColl = c * c;
      idling = t < 0.02;
    }
    this.collective = Math.sqrt(uColl);

    // ---- rate loop (rad/s → rad/s²) ----------------------------------------------------------
    const spIn = [sp0, sp1, sp2];
    const gyro = [g0, g1, g2];
    const kSmooth = pt1Gain(45, dt);
    const kD = pt1Gain(110, dt);
    const kFf = pt1Gain(35, dt);
    const grounded = s.landed && idling;
    const torque = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      this.spSmooth[a] += (spIn[a] - this.spSmooth[a]) * kSmooth;
      const sp = this.spSmooth[a];
      this.setpoint[a] = sp;
      const err = sp - gyro[a];
      const spRate = (sp - this.prevSp[a]) / dt;
      this.prevSp[a] = sp;
      this.ffFilt[a] += (spRate - this.ffFilt[a]) * kFf;
      const dRaw = (gyro[a] - this.prevGyro[a]) / dt;
      this.prevGyro[a] = gyro[a];
      this.dFilt[a] += (dRaw - this.dFilt[a]) * kD;
      // I-term relax: don't wind up while the setpoint itself is moving fast
      const relax = 1 / (1 + (this.ffFilt[a] / 60) ** 2);
      const iLim = a === 2 ? 45 : 90;
      if (grounded) this.iTerm[a] *= 1 - Math.min(1, dt * 12);
      else this.iTerm[a] = clamp(this.iTerm[a] + err * this.ki[a] * relax * dt, -iLim, iLim);
      let alpha = this.kp[a] * err + this.iTerm[a] - this.kd[a] * this.dFilt[a] + this.kff[a] * this.ffFilt[a];
      if (grounded) alpha *= 0.2;
      torque[a] = alpha * this.inertia[a];
    }

    // ---- mixer (thrust-fraction space, airmode desaturation) -----------------------------------
    const duRoll = torque[0] / (4 * cfg.armX * cfg.maxThrust);
    const duPitch = torque[1] / (4 * cfg.armZ * cfg.maxThrust);
    const duYaw = torque[2] / (4 * cfg.torqueRatio * cfg.maxThrust);
    const span = 1 - idleU;
    const du = this.du;
    let yawScale = 1;
    let lo = 0;
    let hi = 0;
    for (let pass = 0; pass < 6; pass++) {
      lo = Infinity;
      hi = -Infinity;
      for (let i = 0; i < 4; i++) {
        const m = MOTOR_LAYOUT[i];
        du[i] = -m.sx * duRoll + m.sz * duPitch + m.spin * duYaw * yawScale;
        if (du[i] < lo) lo = du[i];
        if (du[i] > hi) hi = du[i];
      }
      if (hi - lo <= span || yawScale <= 0.02) break;
      yawScale *= 0.55; // give up yaw authority first
    }
    let scale = 1;
    if (hi - lo > span) scale = span / (hi - lo);
    let base = uColl;
    if (base + hi * scale > 1) base = 1 - hi * scale;
    if (base + lo * scale < idleU) base = idleU - lo * scale;
    for (let i = 0; i < 4; i++) {
      this.motors[i] = Math.sqrt(clamp(base + du[i] * scale, idleU, 1));
    }
  }
}
