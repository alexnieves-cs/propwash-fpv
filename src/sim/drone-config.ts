/**
 * Physical description of each airframe. Every number here is in SI units and is meant to be
 * plausible for the real hardware it names — the flight feel emerges from these, not from
 * hand-tuned "arcade" constants.
 */

export interface AxisRates {
  /** deg/s per unit stick around centre */
  center: number;
  /** deg/s at full deflection */
  max: number;
  /** 0..1, how much of the extra rate is pushed out towards the stick edges */
  expo: number;
}

export interface Rates {
  roll: AxisRates;
  pitch: AxisRates;
  yaw: AxisRates;
}

export interface DroneConfig {
  id: string;
  name: string;
  tagline: string;
  blurb: string;
  /** all-up weight, kg */
  mass: number;
  /** principal moments of inertia, kg·m² — x: pitch axis, y: yaw axis, z: roll axis */
  inertia: { x: number; y: number; z: number };
  /** motor offsets from the centre of mass, m */
  armX: number;
  armZ: number;
  propRadius: number;
  blades: number;
  /** static thrust per motor at the reference (sagged) voltage, N */
  maxThrust: number;
  /** loaded rotor speed at the reference voltage, rad/s */
  maxOmega: number;
  /** rotor drag torque per newton of thrust, m */
  torqueRatio: number;
  /** prop + bell inertia, kg·m² */
  rotorInertia: number;
  /** motor spin-up / spin-down time constants, s */
  tauUp: number;
  tauDown: number;
  /** idle motor signal when armed (0..1) */
  idle: number;
  /** axial inflow speed at which thrust reaches zero, per rad/s of rotor speed */
  inflowFactor: number;
  /** drag area (Cd·A) along each body axis, m² */
  cdA: { x: number; y: number; z: number };
  /** rotor H-force: N per (m/s of in-plane airspeed) per (rad/s of rotor speed) */
  rotorDrag: number;
  angDragLin: number;
  angDragQuad: number;
  battery: { cells: number; capacityMah: number; resistance: number };
  /** peak electro-mechanical efficiency of the power train */
  efficiency: number;
  /** no-load current per motor, A */
  idleCurrent: number;
  collider: { body: [number, number, number]; guardRadius: number; guardHalfHeight: number };
  ducted: boolean;
  /** FPV camera uptilt, degrees */
  camTilt: number;
  rates: Rates;
  /** closed-loop rate controller targets */
  ctrl: { bandwidth: number; damping: number; ki: number; ff: number; yawScale: number };
  /** visual scale hints for the procedural model */
  visual: { frame: 'freestyle' | 'race' | 'cinewhoop' | 'whoop'; accent: number };
}

/** Per-cell voltage the motor constants are quoted at. */
export const CELL_REF_VOLTS = 3.9;

const freestyle5: DroneConfig = {
  id: 'freestyle5',
  name: 'Vandal 5″',
  tagline: 'Freestyle · 6S',
  blurb: 'A 680 g five-inch freestyle rig carrying an action cam. Smooth, powerful and forgiving — the one to learn tricks on.',
  mass: 0.68,
  inertia: { x: 0.003, y: 0.0046, z: 0.0024 },
  armX: 0.08,
  armZ: 0.076,
  propRadius: 0.0648,
  blades: 3,
  maxThrust: 14.5,
  maxOmega: 3040,
  torqueRatio: 0.0135,
  rotorInertia: 6.0e-6,
  tauUp: 0.03,
  tauDown: 0.045,
  idle: 0.055,
  inflowFactor: 0.0226,
  cdA: { x: 0.01, y: 0.017, z: 0.008 },
  rotorDrag: 5.5e-5,
  angDragLin: 2.5e-4,
  angDragQuad: 1.5e-5,
  battery: { cells: 6, capacityMah: 1300, resistance: 0.03 },
  efficiency: 0.78,
  idleCurrent: 0.55,
  collider: { body: [0.024, 0.02, 0.085], guardRadius: 0.066, guardHalfHeight: 0.012 },
  ducted: false,
  camTilt: 28,
  rates: {
    roll: { center: 220, max: 800, expo: 0.45 },
    pitch: { center: 220, max: 800, expo: 0.45 },
    yaw: { center: 200, max: 620, expo: 0.4 },
  },
  ctrl: { bandwidth: 46, damping: 0.82, ki: 260, ff: 0.75, yawScale: 0.62 },
  visual: { frame: 'freestyle', accent: 0xff5a1f },
};

const race5: DroneConfig = {
  id: 'race5',
  name: 'Kestrel R5',
  tagline: 'Race · 6S',
  blurb: 'A stripped 560 g stretch-X racer on aggressive props. Violent acceleration, 190 km/h on the straights, and no patience.',
  mass: 0.56,
  inertia: { x: 0.0023, y: 0.0036, z: 0.0017 },
  armX: 0.071,
  armZ: 0.084,
  propRadius: 0.0648,
  blades: 3,
  maxThrust: 16.5,
  maxOmega: 3350,
  torqueRatio: 0.0125,
  rotorInertia: 5.6e-6,
  tauUp: 0.026,
  tauDown: 0.04,
  idle: 0.055,
  inflowFactor: 0.0245,
  cdA: { x: 0.008, y: 0.014, z: 0.0055 },
  rotorDrag: 5.0e-5,
  angDragLin: 2.0e-4,
  angDragQuad: 1.2e-5,
  battery: { cells: 6, capacityMah: 1100, resistance: 0.028 },
  efficiency: 0.8,
  idleCurrent: 0.6,
  collider: { body: [0.02, 0.016, 0.09], guardRadius: 0.066, guardHalfHeight: 0.011 },
  ducted: false,
  camTilt: 40,
  rates: {
    roll: { center: 190, max: 720, expo: 0.3 },
    pitch: { center: 190, max: 720, expo: 0.3 },
    yaw: { center: 170, max: 560, expo: 0.3 },
  },
  ctrl: { bandwidth: 52, damping: 0.8, ki: 280, ff: 0.8, yawScale: 0.62 },
  visual: { frame: 'race', accent: 0x19d3ff },
};

const cinewhoop3: DroneConfig = {
  id: 'cinewhoop3',
  name: 'Lantern 3″',
  tagline: 'Cinewhoop · 4S',
  blurb: 'A ducted three-inch camera ship. Modest power and a lot of drag make it calm, floaty and happy in tight spaces.',
  mass: 0.39,
  inertia: { x: 0.0011, y: 0.0018, z: 0.001 },
  armX: 0.056,
  armZ: 0.056,
  propRadius: 0.038,
  blades: 5,
  maxThrust: 4.7,
  maxOmega: 4400,
  torqueRatio: 0.0085,
  rotorInertia: 1.2e-6,
  tauUp: 0.028,
  tauDown: 0.05,
  idle: 0.06,
  inflowFactor: 0.0157,
  cdA: { x: 0.014, y: 0.022, z: 0.014 },
  rotorDrag: 6.0e-5,
  angDragLin: 1.6e-4,
  angDragQuad: 1.0e-5,
  battery: { cells: 4, capacityMah: 850, resistance: 0.04 },
  efficiency: 0.72,
  idleCurrent: 0.4,
  collider: { body: [0.03, 0.022, 0.05], guardRadius: 0.047, guardHalfHeight: 0.016 },
  ducted: true,
  camTilt: 12,
  rates: {
    roll: { center: 150, max: 480, expo: 0.3 },
    pitch: { center: 150, max: 480, expo: 0.3 },
    yaw: { center: 140, max: 400, expo: 0.3 },
  },
  ctrl: { bandwidth: 40, damping: 0.85, ki: 220, ff: 0.6, yawScale: 0.6 },
  visual: { frame: 'cinewhoop', accent: 0xb6ff3c },
};

const whoop65: DroneConfig = {
  id: 'whoop65',
  name: 'Gnat 65',
  tagline: 'Tiny whoop · 1S',
  blurb: 'Twenty-seven grams of ducted mischief. Bounces off everything, sags like mad, and fits through any gap in the bando.',
  mass: 0.027,
  inertia: { x: 1.8e-5, y: 3.0e-5, z: 1.7e-5 },
  armX: 0.023,
  armZ: 0.023,
  propRadius: 0.0155,
  blades: 3,
  maxThrust: 0.27,
  maxOmega: 5200,
  torqueRatio: 0.0036,
  rotorInertia: 2.5e-8,
  tauUp: 0.035,
  tauDown: 0.06,
  idle: 0.07,
  inflowFactor: 0.00526,
  cdA: { x: 0.0022, y: 0.0042, z: 0.0022 },
  rotorDrag: 2.3e-6,
  angDragLin: 4.0e-6,
  angDragQuad: 2.0e-7,
  battery: { cells: 1, capacityMah: 300, resistance: 0.085 },
  efficiency: 0.6,
  idleCurrent: 0.12,
  collider: { body: [0.013, 0.012, 0.015], guardRadius: 0.021, guardHalfHeight: 0.009 },
  ducted: true,
  camTilt: 20,
  rates: {
    roll: { center: 200, max: 700, expo: 0.4 },
    pitch: { center: 200, max: 700, expo: 0.4 },
    yaw: { center: 190, max: 600, expo: 0.4 },
  },
  ctrl: { bandwidth: 38, damping: 0.85, ki: 220, ff: 0.6, yawScale: 0.6 },
  visual: { frame: 'whoop', accent: 0xffd23c },
};

export const DRONES: DroneConfig[] = [freestyle5, race5, cinewhoop3, whoop65];

export function getDrone(id: string): DroneConfig {
  return DRONES.find((d) => d.id === id) ?? freestyle5;
}

/** Motor signal (0..1) that produces exactly one g of thrust at the reference voltage. */
export function hoverSignal(cfg: DroneConfig): number {
  return Math.sqrt((cfg.mass * 9.81) / (4 * cfg.maxThrust));
}

/** Throttle stick position (0..1) that hovers. */
export function hoverThrottle(cfg: DroneConfig): number {
  return (hoverSignal(cfg) - cfg.idle) / (1 - cfg.idle);
}

/** Motor layout, Betaflight "props in" order: rear-right, front-right, rear-left, front-left. */
export const MOTOR_LAYOUT: { sx: number; sz: number; spin: number }[] = [
  { sx: 1, sz: 1, spin: -1 },
  { sx: 1, sz: -1, spin: 1 },
  { sx: -1, sz: 1, spin: 1 },
  { sx: -1, sz: -1, spin: -1 },
];
