/**
 * Procedural audio. Every sound is synthesised with the Web Audio API at run time — there are no
 * sample files — so the motors can follow the physics continuously instead of cross-fading loops.
 *
 * Signal graph (built once, inside `unlock()`):
 *
 *   motor voice ×4 ───┐
 *   prop noise ───────┼→ thin → body → formant → air → reach → [motors] ─┐
 *   prop-wash rumble ─┘                                                   ├→ flight ─┐
 *   wind bed → tone → gusts → level → [wind] ────────────────────────────┘          │
 *   one-shots and UI ticks → [effects] ──────────────────────────────────────────────┼→ compressor → soft clip → [master] → out
 *
 * A motor voice is three oscillators (shaft, blade-pass, 2× blade-pass) → low-pass → level →
 * flutter → pan. `[name]` is a user volume; `flight` is the pause fade.
 *
 * Continuous controls are steered with `setTargetAtTime` rather than by writing `.value`, which
 * turns a 60 Hz stream of targets into click-free audio-rate glides.
 */

export interface AudioFrame {
  armed: boolean;
  /** rotor speed of each of the 4 motors, rad/s */
  omega: ArrayLike<number>;
  /** rotor speed at full throttle, rad/s (≈3000 for a 5-inch quad, ≈5200 for a tiny whoop) */
  maxOmega: number;
  /** blades per prop (3 or 5) */
  blades: number;
  /** true for ducted craft (cinewhoop / tiny whoop) — more hissy, more whine */
  ducted: boolean;
  /** all-up mass in kg (0.027 … 0.68) — lighter craft should sound smaller and thinner */
  mass: number;
  /** airspeed, m/s (0 … 55) */
  airspeed: number;
  /** 0..1 prop-wash turbulence: the quad is descending through its own wake and the motors are fighting it */
  propwash: number;
  /** distance from the listener to the quad in metres. 0 means the listener is on board (FPV camera) */
  distance: number;
  /** rate of change of that distance, m/s (positive = moving away), for Doppler */
  radialVelocity: number;
}

/** Linear gains, each 0..1. */
export interface AudioVolumes {
  master: number;
  motors: number;
  effects: number;
  wind: number;
}

// ---- tuning ---------------------------------------------------------------------------------------

const MOTORS = 4;
const TWO_PI = Math.PI * 2;
const SPEED_OF_SOUND = 343;

/** Pitch glide: short enough to read as instant, long enough that a per-frame step never clicks. */
const PITCH_TC = 0.012;
const CUTOFF_TC = 0.02;
const LEVEL_TC = 0.015;
/** Four time constants ≈ −35 dB, which is the "silent within ~200 ms" a disarm needs. */
const DISARM_TC = 0.05;
/** Camera cuts and craft swaps: slow enough to cross-fade the two mixes rather than switch them. */
const MIX_TC = 0.06;
const VOLUME_TC = 0.03;
/** ~96 % of the way after 150 ms. */
const PAUSE_TC = 0.045;

/** Mass range the craft-size scale is fitted to: tiny whoop … 5-inch freestyle quad, kg. */
const MASS_SMALL = 0.027;
const MASS_LARGE = 0.68;
const INV_LOG_MASS_SPAN = 1 / Math.log(MASS_LARGE / MASS_SMALL);

/** The listener counts as riding on the quad inside NEAR and as a bystander beyond FAR, metres. */
const ONBOARD_NEAR = 0.25;
const ONBOARD_FAR = 1;
const REFERENCE_DISTANCE = 3;
/** Inverse-distance never reaches zero, so the last stretch is faded out by hand. */
const FADE_OUT_START = 300;
const FADE_OUT_END = 400;
/** Distance at which air absorption has halved the motor bus bandwidth, metres. */
const AIR_HALF_DISTANCE = 30;
const AIR_OPEN_HZ = 18000;
/** An action camera in its case hears a duller world than a bystander's ears do. */
const ONBOARD_MIC_HZ = 11000;
/** Caller-side differencing can spike on a camera cut; keep the Doppler ratio sane and smoothed. */
const MAX_RADIAL_SPEED = 120;
const DOPPLER_SMOOTH = 0.05;

/** Per-voice gain at full throttle: four motors flat out push the compressor about 6 dB into gain reduction. */
const VOICE_LEVEL = 0.2;
/**
 * Loudness is `IDLE_FLOOR·x^0.4 + (1−IDLE_FLOOR)·x^1.6` with x = omega/maxOmega: close to
 * thrust (x²) at the top, but with a floor that keeps a 5 % idle about 23 dB down rather than 50.
 */
const IDLE_FLOOR = 0.2;
/** Shaft-rate rumble and motor whine relative to the blade-pass tone. */
const SHAFT_LEVEL = 0.2;
/** Riding on the frame you hear the shaft through the airframe, not just through the air. */
const SHAFT_ONBOARD_BOOST = 0.5;
/** 2× blade-pass: a hint at idle, a rasp at full throttle. */
const EDGE_IDLE = 0.1;
const EDGE_THROTTLE = 0.26;
/** The filter never closes below this, or idle would vanish on small speakers. */
const CUTOFF_FLOOR_HZ = 800;

/** Broadband prop noise at full thrust; a duct adds roughly 5 dB of it. */
const NOISE_OPEN = 0.22;
const NOISE_DUCTED = 0.38;
/** Prop-wash rumble at propwash = 1: level with the motors' own tone in a hover, not above it. */
const RUMBLE_LEVEL = 1.1;
/** Wind at 50 m/s and up: as loud as the motors at full throttle. */
const WIND_LEVEL = 1.5;
/** Peak pitch and amplitude wobble of a motor at full prop wash (cents, fraction). */
const FLUTTER_CENTS = 30;
const FLUTTER_DEPTH = 0.45;

/**
 * No two motor/prop pairs are identical, and a simulated hover can command four equal speeds.
 * A fixed trim plus a slow wander keeps the voices beating against each other the way real ones do.
 */
const TRIM = [-0.008, 0.0045, -0.003, 0.0075];
const WANDER_SLOW_HZ = [0.37, 0.53, 0.71, 0.89];
const WANDER_FAST_HZ = [2.3, 3.1, 1.9, 2.7];
const WANDER_SLOW = 0.0025;
const WANDER_FAST = 0.0015;
/** Motors 0,1 sit on the right of the frame and 2,3 on the left (the sim's MOTOR_LAYOUT order). */
const PAN = [0.5, 0.36, -0.5, -0.36];
/** Each motor reads the flutter buffer at its own speed so their wobbles never line up. */
const FLUTTER_RATE = [0.83, 1, 1.19, 1.37];

const WHITE_SECONDS = 2;
const PINK_SECONDS = 5;
const FLUTTER_SECONDS = 3;
const PINK_RMS = 0.25;
const FLUTTER_RMS = 1 / 3;

/** The shaper passes everything below the knee untouched and lands on exactly ±1 at ±CLIP_RANGE. */
const CLIP_KNEE = 0.85;
const CLIP_RANGE = 2;

/** One-shots start a hair in the future so their attack ramp is never truncated by scheduling jitter. */
const LEAD = 0.005;
/** A pluck is this many time constants long, i.e. about −52 dB when its source stops. */
const PLUCK_TCS = 6;
const STOP_PAD = 0.005;
/** A collision arrives as several contacts over a few frames; only the first, or a clearly bigger one, sounds. */
const IMPACT_GAP = 0.06;
const IMPACT_LEVEL = 0.6;

const GATE_NOTES = [1174.66, 1760]; // D6 → A6
const FINISH_NOTES = [1174.66, 1760, 2349.32]; // D6 → A6 → D7
const ARM_NOTES = [1046.5, 1318.5, 1568]; // C6 E6 G6
const DISARM_NOTES = [1318.5, 987.77]; // E6 B5

// ---- small helpers --------------------------------------------------------------------------------

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const saturate = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** A NaN reaching an AudioParam throws, so everything that comes from the sim goes through this. */
const finite = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);
const noop = (): void => {};

function smoothstep(a: number, b: number, x: number): number {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Deterministic PRNG (mulberry32) so the noise beds are identical every session. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An AudioParam plus the last target sent to it. Steady inputs then cost a comparison instead of
 * a new automation event, which matters when ~40 params are driven every frame.
 */
class Control {
  private readonly param: AudioParam;
  private last: number;

  constructor(param: AudioParam, initial: number) {
    param.value = initial;
    this.param = param;
    this.last = initial;
  }

  /** Glide towards `value`; ignored while the target is within `tolerance` (relative) of the last one. */
  to(value: number, time: number, timeConstant: number, tolerance = 1e-3): void {
    const last = this.last;
    const delta = value > last ? value - last : last - value;
    const scale = (value < 0 ? -value : value) + (last < 0 ? -last : last);
    if (delta <= tolerance * 0.5 * scale + 1e-7) return;
    this.param.setTargetAtTime(value, time, timeConstant);
    this.last = value;
  }
}

// ---- generated material ---------------------------------------------------------------------------

function whiteNoise(ctx: BaseAudioContext, rand: () => number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * WHITE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
  return buffer;
}

/** Stereo pink noise with independent channels, so the wind surrounds the head instead of sitting in it. */
function pinkNoise(ctx: BaseAudioContext, rand: () => number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * PINK_SECONDS);
  // Pink noise has enough low end for a loop seam to thump, so the tail is cross-faded into the head.
  const fade = Math.floor(ctx.sampleRate * 0.25);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const raw = new Float32Array(length + fade);
  for (let channel = 0; channel < 2; channel++) {
    // Paul Kellett's economy filter: −3 dB/octave within half a dB from ~10 Hz up.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < raw.length; i++) {
      const white = rand() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      raw[i] = b0 + b1 + b2 + white * 0.1848;
    }
    const data = buffer.getChannelData(channel);
    let power = 0;
    for (let i = 0; i < length; i++) {
      let sample = raw[i];
      if (i < fade) {
        const k = i / fade;
        // Equal-power, because the two ends are uncorrelated.
        sample = sample * Math.sqrt(k) + raw[length + i] * Math.sqrt(1 - k);
      }
      data[i] = sample;
      power += sample * sample;
    }
    const gain = PINK_RMS / Math.sqrt(power / length);
    for (let i = 0; i < length; i++) data[i] *= gain;
  }
  return buffer;
}

/**
 * Band-limited 20–80 Hz noise used as a control signal for prop-wash flutter and wind gusts.
 * It is a sum of sinusoids that each complete a whole number of cycles in the buffer, which makes
 * the loop seamless and the level exact — neither is true of filtered white noise.
 */
function flutterNoise(ctx: BaseAudioContext, rand: () => number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * FLUTTER_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const partials = 20;
  const amplitude = FLUTTER_RMS / Math.sqrt(partials / 2);
  for (let p = 0; p < partials; p++) {
    const cycles = Math.round((20 + 60 * rand()) * FLUTTER_SECONDS);
    const w = (TWO_PI * cycles) / length;
    const phase = rand() * TWO_PI;
    // Two-multiply resonator instead of a sin() per sample; this runs inside the unlock gesture.
    const k = 2 * Math.cos(w);
    let y1 = Math.sin(phase - w);
    let y2 = Math.sin(phase - 2 * w);
    for (let i = 0; i < length; i++) {
      const y = k * y1 - y2;
      y2 = y1;
      y1 = y;
      data[i] += y * amplitude;
    }
  }
  return buffer;
}

/** Builds a normalised PeriodicWave from per-harmonic sine/cosine amplitudes. */
function makeWave(
  ctx: BaseAudioContext,
  partials: number,
  sine: (n: number) => number,
  cosine: (n: number) => number,
): PeriodicWave {
  const real = new Float32Array(partials + 1);
  const imag = new Float32Array(partials + 1);
  for (let n = 1; n <= partials; n++) {
    real[n] = cosine(n);
    imag[n] = sine(n);
  }
  return ctx.createPeriodicWave(real, imag);
}

/**
 * Blade-pass tone. Each passing blade is a pressure pulse, so the harmonics stay phase-aligned
 * (saw-like) — that is what makes idle a purr of separate pulses. The cosine ripple bends the
 * spectrum away from a textbook sawtooth, which is instantly recognisable as a synth.
 */
function bladeWave(ctx: BaseAudioContext): PeriodicWave {
  return makeWave(
    ctx,
    32,
    (n) => Math.pow(n, -1.05) * (1 + 0.3 * Math.cos(1.7 * (n - 1))),
    (n) => 0.35 * Math.pow(n, -1.05) * Math.sin(2.4 * n),
  );
}

/** Flatter, odd-heavy spectrum for the 2× blade-pass voice: the rasp that appears at high throttle. */
function edgeWave(ctx: BaseAudioContext): PeriodicWave {
  return makeWave(
    ctx,
    16,
    (n) => Math.pow(n, -0.9) * (n % 2 === 1 ? 1.3 : 0.8),
    () => 0,
  );
}

/**
 * Once-per-rev imbalance plus the motor's electrical whine. A 14-pole outrunner sings at 7× and
 * 14× shaft speed, which is not a multiple of the blade-pass frequency — that inharmonic pair is
 * the metallic edge of a real quad. Ducts reflect it straight back at the listener, hence `whine`.
 */
function shaftWave(ctx: BaseAudioContext, whine: number): PeriodicWave {
  const amplitudes = new Float32Array(29);
  amplitudes[1] = 1;
  amplitudes[2] = 0.5;
  amplitudes[4] = 0.15;
  amplitudes[7] = whine;
  amplitudes[14] = whine * 0.65;
  amplitudes[21] = whine * 0.28;
  amplitudes[28] = whine * 0.12;
  return makeWave(
    ctx,
    28,
    (n) => amplitudes[n],
    () => 0,
  );
}

function softClipCurve(): Float32Array<ArrayBuffer> {
  // An odd length puts a sample exactly on zero, so silence stays silence (no DC offset).
  const length = 2049;
  const curve = new Float32Array(length);
  const shoulder = 1 - CLIP_KNEE;
  for (let i = 0; i < length; i++) {
    const x = ((i / (length - 1)) * 2 - 1) * CLIP_RANGE;
    const magnitude = Math.abs(x);
    const y = magnitude <= CLIP_KNEE ? magnitude : CLIP_KNEE + shoulder * Math.tanh((magnitude - CLIP_KNEE) / shoulder);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

// ---- graph ----------------------------------------------------------------------------------------

interface MotorVoice {
  shaft: OscillatorNode;
  /** tapped by the prop-noise chopper */
  blade: OscillatorNode;
  shaftFreq: Control;
  bladeFreq: Control;
  edgeFreq: Control;
  shaftGain: Control;
  edgeGain: Control;
  cutoff: Control;
  level: Control;
  pan: Control;
  flutterPitch: Control;
  flutterAmp: Control;
}

interface Graph {
  ctx: AudioContext;
  nyquist: number;
  white: AudioBuffer;
  /** every free-running source, so `dispose()` can stop them */
  sources: AudioScheduledSourceNode[];
  openShaft: PeriodicWave;
  ductedShaft: PeriodicWave;
  voices: MotorVoice[];

  thin: Control;
  body: Control;
  formant: Control;
  air: Control;
  reach: Control;

  noiseBand: Control;
  noiseQ: AudioParam;
  noiseLevel: Control;
  rumbleTone: Control;
  rumbleLevel: Control;
  windTone: Control;
  windLevel: Control;
  gustRate: Control;

  motorVolume: Control;
  windVolume: Control;
  effectsVolume: Control;
  masterVolume: Control;
  flight: Control;

  /** where one-shots plug in */
  effects: GainNode;
  /** last node before the speakers */
  output: AudioNode;
}

function gainNode(ctx: BaseAudioContext, value: number): GainNode {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

function filterNode(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

function loopSource(ctx: BaseAudioContext, buffer: AudioBuffer, rate: number, offset: number): AudioBufferSourceNode {
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  node.playbackRate.value = rate;
  node.start(0, offset);
  return node;
}

function buildGraph(ctx: AudioContext, volumes: AudioVolumes, paused: boolean): Graph {
  const rand = makeRng(0x50f7a5e);
  const white = whiteNoise(ctx, rand);
  const pink = pinkNoise(ctx, rand);
  const flutter = flutterNoise(ctx, rand);
  const sources: AudioScheduledSourceNode[] = [];

  // ---- master: compressor → soft clip → master volume ---------------------------------------------
  // The compressor is the glue and does the level riding; its attack still lets the first few
  // milliseconds of a crash through, so the shaper behind it is what actually guarantees |x| ≤ 1.
  // Master volume comes last so that turning it down can never push the mix back into the shaper.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 10;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.2;
  const clipDrive = gainNode(ctx, 1 / CLIP_RANGE);
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  const master = gainNode(ctx, volumes.master);
  compressor.connect(clipDrive).connect(clip).connect(master).connect(ctx.destination);

  const flight = gainNode(ctx, paused ? 0 : 1);
  const effects = gainNode(ctx, volumes.effects);
  flight.connect(compressor);
  effects.connect(compressor);

  // ---- motor bus: everything the airframe radiates, then the path to the listener -----------------
  const motorBus = gainNode(ctx, 1);
  const thin = filterNode(ctx, 'highpass', 45, 0.7);
  const body = filterNode(ctx, 'lowshelf', 300, 0);
  body.gain.value = 0;
  // A fixed resonance is what stops pitch-tracking oscillators from sounding like a synth sweep:
  // real airframes colour every RPM the same way.
  const formant = filterNode(ctx, 'peaking', 1000, 1.1);
  formant.gain.value = 4;
  const air = filterNode(ctx, 'lowpass', AIR_OPEN_HZ, 0.5);
  const reach = gainNode(ctx, 1);
  const motorVolume = gainNode(ctx, volumes.motors);
  motorBus.connect(thin).connect(body).connect(formant).connect(air).connect(reach).connect(motorVolume).connect(flight);

  // ---- motor voices -------------------------------------------------------------------------------
  const blades = bladeWave(ctx);
  const edges = edgeWave(ctx);
  const openShaft = shaftWave(ctx, 0.16);
  const ductedShaft = shaftWave(ctx, 0.42);
  const voices: MotorVoice[] = [];
  for (let i = 0; i < MOTORS; i++) {
    const shaft = ctx.createOscillator();
    const blade = ctx.createOscillator();
    const edge = ctx.createOscillator();
    shaft.setPeriodicWave(openShaft);
    blade.setPeriodicWave(blades);
    edge.setPeriodicWave(edges);

    const shaftGain = gainNode(ctx, SHAFT_LEVEL);
    const edgeGain = gainNode(ctx, EDGE_IDLE);
    const lowpass = filterNode(ctx, 'lowpass', CUTOFF_FLOOR_HZ, 0.8);
    const level = gainNode(ctx, 0);
    const tremolo = gainNode(ctx, 1);
    const pan = ctx.createStereoPanner();
    shaft.connect(shaftGain).connect(lowpass);
    blade.connect(lowpass);
    edge.connect(edgeGain).connect(lowpass);
    lowpass.connect(level).connect(tremolo).connect(pan).connect(motorBus);

    // Prop wash: the flight controller is sawing at this motor, so wobble both its pitch and level.
    const wobble = loopSource(ctx, flutter, FLUTTER_RATE[i], i * 0.61);
    const flutterPitch = gainNode(ctx, 0);
    const flutterAmp = gainNode(ctx, 0);
    wobble.connect(flutterPitch);
    flutterPitch.connect(shaft.detune);
    flutterPitch.connect(blade.detune);
    flutterPitch.connect(edge.detune);
    wobble.connect(flutterAmp);
    flutterAmp.connect(tremolo.gain);

    shaft.start();
    blade.start();
    edge.start();
    sources.push(shaft, blade, edge, wobble);
    voices.push({
      shaft,
      blade,
      shaftFreq: new Control(shaft.frequency, 10),
      bladeFreq: new Control(blade.frequency, 30),
      edgeFreq: new Control(edge.frequency, 60),
      shaftGain: new Control(shaftGain.gain, SHAFT_LEVEL),
      edgeGain: new Control(edgeGain.gain, EDGE_IDLE),
      cutoff: new Control(lowpass.frequency, CUTOFF_FLOOR_HZ),
      level: new Control(level.gain, 0),
      pan: new Control(pan.pan, 0),
      flutterPitch: new Control(flutterPitch.gain, 0),
      flutterAmp: new Control(flutterAmp.gain, 0),
    });
  }

  // ---- broadband prop noise -----------------------------------------------------------------------
  const whiteLoop = loopSource(ctx, white, 1, 0);
  const noiseBand = filterNode(ctx, 'bandpass', 3000, 0.9);
  const noiseChop = gainNode(ctx, 1);
  const noiseLevel = gainNode(ctx, 0);
  whiteLoop.connect(noiseBand).connect(noiseChop).connect(noiseLevel).connect(motorBus);
  // Vortex noise is shed blade by blade, so it pulses at blade-pass rate. Chopping the hiss with
  // two of the blade oscillators is what makes it sound torn rather than like a steady leak.
  const chopDepth = gainNode(ctx, 0.2);
  voices[0].blade.connect(chopDepth);
  voices[3].blade.connect(chopDepth);
  chopDepth.connect(noiseChop.gain);

  // ---- prop-wash rumble ---------------------------------------------------------------------------
  const pinkLoop = loopSource(ctx, pink, 1, 0);
  // Band-pass, not low-pass: the bottom octave of pink noise is all headroom and no growl.
  const rumbleTone = filterNode(ctx, 'bandpass', 110, 0.8);
  const rumbleChop = gainNode(ctx, 0.5);
  const rumbleLevel = gainNode(ctx, 0);
  pinkLoop.connect(rumbleTone).connect(rumbleChop).connect(rumbleLevel).connect(motorBus);
  // Over-modulated on purpose (depth > bias): the gain crosses zero and the rumble stutters.
  const rumbleWobble = loopSource(ctx, flutter, 0.9, 1.3);
  const rumbleDepth = gainNode(ctx, 1.2);
  rumbleWobble.connect(rumbleDepth);
  rumbleDepth.connect(rumbleChop.gain);

  // ---- wind ---------------------------------------------------------------------------------------
  // A second read head on the pink buffer, at another speed, so wind and rumble never correlate.
  const windLoop = loopSource(ctx, pink, 0.83, 2.1);
  // Pink noise is mostly sub-bass; left in, it would eat the compressor's headroom unheard.
  const windRumbleCut = filterNode(ctx, 'highpass', 70, 0.7);
  const windTone = filterNode(ctx, 'lowpass', 220, 0.6);
  const gusts = gainNode(ctx, 1);
  const windLevel = gainNode(ctx, 0);
  const windVolume = gainNode(ctx, volumes.wind);
  windLoop.connect(windRumbleCut).connect(windTone).connect(gusts).connect(windLevel).connect(windVolume).connect(flight);
  // The flutter buffer slowed ~10× becomes 2–8 Hz buffeting.
  const gustLoop = loopSource(ctx, flutter, 0.1, 0.4);
  const gustDepth = gainNode(ctx, 0.4);
  gustLoop.connect(gustDepth);
  gustDepth.connect(gusts.gain);

  sources.push(whiteLoop, pinkLoop, rumbleWobble, windLoop, gustLoop);

  return {
    ctx,
    nyquist: ctx.sampleRate / 2,
    white,
    sources,
    openShaft,
    ductedShaft,
    voices,
    thin: new Control(thin.frequency, 45),
    body: new Control(body.gain, 0),
    formant: new Control(formant.frequency, 1000),
    air: new Control(air.frequency, AIR_OPEN_HZ),
    reach: new Control(reach.gain, 1),
    noiseBand: new Control(noiseBand.frequency, 3000),
    noiseQ: noiseBand.Q,
    noiseLevel: new Control(noiseLevel.gain, 0),
    rumbleTone: new Control(rumbleTone.frequency, 110),
    rumbleLevel: new Control(rumbleLevel.gain, 0),
    windTone: new Control(windTone.frequency, 220),
    windLevel: new Control(windLevel.gain, 0),
    gustRate: new Control(gustLoop.playbackRate, 0.1),
    motorVolume: new Control(motorVolume.gain, volumes.motors),
    windVolume: new Control(windVolume.gain, volumes.wind),
    effectsVolume: new Control(effects.gain, volumes.effects),
    masterVolume: new Control(master.gain, volumes.master),
    flight: new Control(flight.gain, paused ? 0 : 1),
    effects,
    output: master,
  };
}

// ---- one-shot primitives --------------------------------------------------------------------------

/** `pluck` rings out exponentially; `beep` holds its level and is gated off. */
type Envelope = 'pluck' | 'beep';

function applyEnvelope(gain: AudioParam, shape: Envelope, at: number, duration: number, peak: number, attack: number): void {
  gain.setValueAtTime(0, at);
  gain.linearRampToValueAtTime(peak, at + attack);
  if (shape === 'pluck') {
    gain.setTargetAtTime(0, at + attack, (duration - attack) / PLUCK_TCS);
  } else {
    const release = Math.min(0.012, duration * 0.25);
    gain.setValueAtTime(peak, at + duration - release);
    gain.linearRampToValueAtTime(0, at + duration);
  }
}

/**
 * One oscillator note. `to`/`glide` bend the pitch exponentially over `glide` seconds (pass
 * `to === from` for a steady note); `lowpass` > 0 rounds off a square wave.
 */
function tone(
  g: Graph,
  type: OscillatorType,
  from: number,
  to: number,
  glide: number,
  at: number,
  duration: number,
  peak: number,
  shape: Envelope,
  lowpass = 0,
): void {
  const ctx = g.ctx;
  const ceiling = g.nyquist * 0.9;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.min(from, ceiling), at);
  if (glide > 0 && to !== from) osc.frequency.exponentialRampToValueAtTime(Math.min(to, ceiling), at + glide);
  const amp = ctx.createGain();
  applyEnvelope(amp.gain, shape, at, duration, peak, shape === 'pluck' ? 0.002 : 0.004);
  if (lowpass > 0) osc.connect(filterNode(ctx, 'lowpass', Math.min(lowpass, ceiling), 0.7)).connect(amp);
  else osc.connect(amp);
  amp.connect(g.effects);
  osc.start(at);
  osc.stop(at + duration + STOP_PAD);
  // Unhooking the tail lets the whole chain be collected instead of idling on the bus.
  osc.onended = () => amp.disconnect();
}

/** One burst of the shared white-noise buffer through a filter that sweeps `from` → `to` Hz. */
function burst(
  g: Graph,
  type: BiquadFilterType,
  from: number,
  to: number,
  q: number,
  at: number,
  duration: number,
  peak: number,
  attack: number,
): void {
  const ctx = g.ctx;
  const ceiling = g.nyquist * 0.9;
  const source = ctx.createBufferSource();
  source.buffer = g.white;
  source.loop = true;
  const filter = filterNode(ctx, type, Math.min(from, ceiling), q);
  filter.frequency.setValueAtTime(Math.min(from, ceiling), at);
  if (to !== from) filter.frequency.exponentialRampToValueAtTime(Math.min(to, ceiling), at + duration);
  const amp = ctx.createGain();
  applyEnvelope(amp.gain, 'pluck', at, duration, peak, attack);
  source.connect(filter).connect(amp).connect(g.effects);
  // A random read position, or every hit would be the same recording.
  source.start(at, Math.random() * (WHITE_SECONDS - 0.01));
  source.stop(at + duration + STOP_PAD);
  source.onended = () => amp.disconnect();
}

function contextConstructor(): typeof AudioContext | undefined {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

// ---- engine ---------------------------------------------------------------------------------------

export class AudioEngine {
  private graph: Graph | null = null;
  private disposed = false;
  private paused = false;
  /** Kept here as well as in the graph so settings made before `unlock()` are not lost. */
  private readonly volumes: AudioVolumes = { master: 0.5, motors: 1, effects: 1, wind: 1 };

  // Per-frame state lives on the instance so `update()` allocates nothing.
  private doppler = 1;
  private ducted = false;
  private readonly wanderSlow = Float64Array.of(0.3, 1.7, 3.1, 4.9);
  private readonly wanderFast = Float64Array.of(2.2, 0.4, 5.1, 3.6);

  private impactAt = -1;
  private impactLevel = 0;

  /**
   * requestAnimationFrame stops in a hidden tab, so `update()` would never get the chance to
   * bring the motors down and they would drone on at their last pitch. Freeze the clock instead.
   */
  private readonly onVisibility = (): void => {
    const g = this.graph;
    if (g === null) return;
    if (document.hidden) {
      if (g.ctx.state === 'running') void g.ctx.suspend().catch(noop);
    } else if (g.ctx.state !== 'closed') {
      void g.ctx.resume().catch(noop);
    }
  };

  /** Call from a user gesture. Creates the AudioContext on first call and resumes it. Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.graph === null) {
        const Context = contextConstructor();
        if (Context === undefined) return;
        const ctx = new Context({ latencyHint: 'interactive' });
        try {
          this.graph = buildGraph(ctx, this.volumes, this.paused);
        } catch (error) {
          void ctx.close().catch(noop);
          throw error;
        }
        document.addEventListener('visibilitychange', this.onVisibility);
      }
      const ctx = this.graph.ctx;
      if (ctx.state !== 'running') {
        // Outside a gesture Chrome leaves resume() pending indefinitely; a caller awaiting
        // unlock() must not hang with it, so give up waiting (not resuming) after a moment.
        await Promise.race([ctx.resume(), new Promise<void>((resolve) => setTimeout(resolve, 500))]);
      }
    } catch {
      // No output device, or the browser refused: stay silent rather than break the game.
    }
  }

  /** True once the context exists and is running. */
  get ready(): boolean {
    return this.live() !== null;
  }

  setVolumes(v: AudioVolumes): void {
    const volumes = this.volumes;
    volumes.master = saturate(finite(v.master, volumes.master));
    volumes.motors = saturate(finite(v.motors, volumes.motors));
    volumes.effects = saturate(finite(v.effects, volumes.effects));
    volumes.wind = saturate(finite(v.wind, volumes.wind));
    const g = this.graph;
    if (g === null) return;
    const t = g.ctx.currentTime;
    g.masterVolume.to(volumes.master, t, VOLUME_TC);
    g.motorVolume.to(volumes.motors, t, VOLUME_TC);
    g.effectsVolume.to(volumes.effects, t, VOLUME_TC);
    g.windVolume.to(volumes.wind, t, VOLUME_TC);
  }

  /** Called once per rendered frame with the current flight state. Cheap and allocation-free. */
  update(frame: AudioFrame, dt: number): void {
    const g = this.live();
    if (g === null) return;
    const t = g.ctx.currentTime;
    const step = dt > 0 ? Math.min(dt, 0.1) : 0;

    const armed = frame.armed === true;
    const maxOmega = Math.max(finite(frame.maxOmega, 3000), 1);
    const blades = clamp(Math.round(finite(frame.blades, 3)), 1, 8);
    /** 0 = tiny whoop … 1 = 5-inch; mass is log-distributed across craft, so interpolate in log space. */
    const size = saturate(Math.log(Math.max(finite(frame.mass, MASS_LARGE), 1e-3) / MASS_SMALL) * INV_LOG_MASS_SPAN);
    const distance = Math.max(finite(frame.distance, 0), 0);
    const onboard = 1 - smoothstep(ONBOARD_NEAR, ONBOARD_FAR, distance);
    const propwash = armed ? saturate(finite(frame.propwash, 0)) : 0;
    if ((frame.ducted === true) !== this.ducted) this.applyDucting(g, frame.ducted === true);
    const ducted = this.ducted;

    const radial = clamp(finite(frame.radialVelocity, 0), -MAX_RADIAL_SPEED, MAX_RADIAL_SPEED);
    const dopplerTarget = lerp(SPEED_OF_SOUND / (SPEED_OF_SOUND + radial), 1, onboard);
    this.doppler += (dopplerTarget - this.doppler) * (1 - Math.exp(-step / DOPPLER_SMOOTH));
    const doppler = this.doppler;

    // ---- motors ------------------------------------------------------------------------------------
    // Highest shaft frequency whose 2× blade-pass partner still sits safely below Nyquist.
    const shaftCeiling = (g.nyquist * 0.9) / (2 * blades);
    const cutoffCeiling = Math.min(13000, g.nyquist * 0.9);
    const levelTc = armed ? LEVEL_TC : DISARM_TC;
    const shaftGain = SHAFT_LEVEL * lerp(0.4, 1, size) * (1 + SHAFT_ONBOARD_BOOST * onboard);
    const flutterCents = propwash * FLUTTER_CENTS;
    const flutterDepth = propwash * FLUTTER_DEPTH;
    let thrust = 0;
    let spin = 0;
    for (let i = 0; i < MOTORS; i++) {
      const voice = g.voices[i];
      const omega = Math.abs(finite(frame.omega[i], 0));
      const x = Math.min(omega / maxOmega, 1.3);

      const slow = (this.wanderSlow[i] + TWO_PI * WANDER_SLOW_HZ[i] * step) % TWO_PI;
      const fast = (this.wanderFast[i] + TWO_PI * WANDER_FAST_HZ[i] * step) % TWO_PI;
      this.wanderSlow[i] = slow;
      this.wanderFast[i] = fast;
      const detune = 1 + TRIM[i] + WANDER_SLOW * Math.sin(slow) + WANDER_FAST * Math.sin(fast);

      const shaftHz = Math.min((omega / TWO_PI) * doppler * detune, shaftCeiling);
      const bladeHz = shaftHz * blades;
      // A 1e-3 tolerance would be a 1 Hz error at 1 kHz — as large as the beating we want to keep.
      voice.shaftFreq.to(shaftHz, t, PITCH_TC, 5e-5);
      voice.bladeFreq.to(bladeHz, t, PITCH_TC, 5e-5);
      voice.edgeFreq.to(bladeHz * 2, t, PITCH_TC, 5e-5);
      // Tracks pitch so the timbre is the same at any RPM, and opens with throttle so load adds bite.
      voice.cutoff.to(clamp(bladeHz * (3 + 6.5 * x * Math.sqrt(x)), CUTOFF_FLOOR_HZ, cutoffCeiling), t, CUTOFF_TC);
      const loudness = armed ? IDLE_FLOOR * Math.pow(x, 0.4) + (1 - IDLE_FLOOR) * Math.pow(x, 1.6) : 0;
      voice.level.to(loudness * VOICE_LEVEL, t, levelTc);
      voice.edgeGain.to(EDGE_IDLE + EDGE_THROTTLE * Math.min(x, 1), t, MIX_TC);
      voice.shaftGain.to(shaftGain, t, MIX_TC);
      // A quad overhead is a point source; only from the camera's seat do the motors surround you.
      voice.pan.to(PAN[i] * onboard, t, MIX_TC);
      voice.flutterPitch.to(flutterCents, t, MIX_TC);
      voice.flutterAmp.to(flutterDepth, t, MIX_TC);

      thrust += x * x;
      spin += x;
    }
    thrust *= 1 / MOTORS;
    spin *= 1 / MOTORS;

    // ---- airframe colour and the path to the listener ----------------------------------------------
    g.thin.to(lerp(200, 45, size), t, MIX_TC);
    g.formant.to(lerp(2600, 1000, size), t, MIX_TC);
    g.body.to(onboard * lerp(1.5, 6, size), t, MIX_TC);
    g.air.to(Math.min(lerp(AIR_OPEN_HZ / (1 + distance / AIR_HALF_DISTANCE), ONBOARD_MIC_HZ, onboard), g.nyquist * 0.9), t, MIX_TC);
    const inverseDistance = REFERENCE_DISTANCE / Math.max(distance, REFERENCE_DISTANCE);
    const fadeOut = 1 - smoothstep(FADE_OUT_START, FADE_OUT_END, distance);
    g.reach.to(inverseDistance * fadeOut * lerp(0.42, 1, size), t, MIX_TC);

    // ---- prop noise and prop wash ------------------------------------------------------------------
    const rms = Math.sqrt(thrust);
    // The √spin term is bearing and windage noise: it is what is left of the hiss at idle, where thrust is nil.
    const hiss = armed ? (0.06 * Math.sqrt(Math.min(spin, 1)) + Math.pow(thrust, 0.75)) * (ducted ? NOISE_DUCTED : NOISE_OPEN) : 0;
    g.noiseLevel.to(hiss, t, armed ? 0.03 : DISARM_TC);
    const band = (2200 + 3000 * Math.min(rms, 1)) * (ducted ? 1.2 : 1) * lerp(1.25, 1, size) * doppler;
    g.noiseBand.to(Math.min(band, 8000, g.nyquist * 0.9), t, 0.04);
    g.rumbleTone.to(lerp(260, 110, size), t, MIX_TC);
    g.rumbleLevel.to(propwash * RUMBLE_LEVEL * (0.4 + 0.6 * Math.min(spin, 1)), t, MIX_TC);

    // ---- wind --------------------------------------------------------------------------------------
    // Only the on-board microphone sits in the airflow; a bystander hears none of it.
    const blow = saturate((clamp(finite(frame.airspeed, 0), 0, 80) - 2) / 48);
    g.windLevel.to(onboard * Math.pow(blow, 1.4) * WIND_LEVEL, t, 0.12);
    g.windTone.to(Math.min(220 + 4200 * Math.pow(blow, 1.3), g.nyquist * 0.9), t, 0.12);
    g.gustRate.to(0.08 + 0.22 * blow, t, 0.2, 0.02);
  }

  /** strength = velocity change in m/s (0.4 … 25). hard = crash. */
  impact(strength: number, hard: boolean): void {
    const g = this.live();
    if (g === null) return;
    const now = g.ctx.currentTime;
    const s = saturate((finite(strength, 0) - 0.4) / 24.6);
    // Perceptual curve: a 1 m/s tap still reads, a 25 m/s crash is not 60× louder.
    const level = (0.14 + 0.86 * Math.pow(s, 0.6)) * (hard ? 1 : 0.7);
    if (now - this.impactAt < IMPACT_GAP && level < this.impactLevel * 1.4) return;
    this.impactAt = now;
    this.impactLevel = level;

    const at = now + LEAD;
    const peak = level * IMPACT_LEVEL;
    // No two hits land on the same spot of the frame.
    const vary = 0.9 + Math.random() * 0.2;

    if (!hard) {
      // Plastic and carbon ring briefly in the mids: a noise tick for the contact, two damped
      // partials for the "tock" of the part that was struck, and a little weight underneath.
      burst(g, 'bandpass', 2900 * vary, 1700 * vary, 1.6, at, 0.05 + 0.04 * s, peak * 1.6, 0.001);
      tone(g, 'triangle', 640 * vary, 600 * vary, 0.04, at, 0.05, peak * 0.5, 'pluck');
      tone(g, 'sine', 1480 * vary, 1480 * vary, 0, at, 0.032, peak * 0.3, 'pluck');
      if (s > 0.02) tone(g, 'sine', 150, 70, 0.06, at, 0.11, peak * 0.9 * Math.sqrt(s), 'pluck');
      return;
    }

    // Crash: the crack of first contact, a crunch whose brightness collapses as the frame folds,
    // a scatter of debris, and a thud that falls in pitch the way a heavy object settling does.
    burst(g, 'bandpass', 2200 * vary, 900, 1.1, at, 0.07, peak * 1.6, 0.001);
    burst(g, 'lowpass', 5500, 450, 0.7, at, 0.32 + 0.3 * s, peak * 1.1, 0.004);
    const debris = 3 + Math.floor(4 * s);
    for (let i = 0; i < debris; i++) {
      const when = at + 0.04 + Math.random() * 0.26;
      const pitch = 1200 + Math.random() * 3300;
      burst(g, 'bandpass', pitch, pitch, 4, when, 0.018 + Math.random() * 0.02, peak * 1.2 * (1 - (0.6 * i) / debris), 0.001);
    }
    tone(g, 'sine', 170, 38, 0.24, at, 0.45, peak * 1.4, 'pluck');
    // Small speakers cannot reproduce the fundamental; its octave keeps the thud audible on them.
    tone(g, 'triangle', 340, 76, 0.24, at, 0.22, peak * 0.4, 'pluck');
  }

  /** Race gate passed; `final` = lap/race finished. */
  gate(final: boolean): void {
    const g = this.live();
    if (g === null) return;
    const at = g.ctx.currentTime + LEAD;
    const notes = final ? FINISH_NOTES : GATE_NOTES;
    const spacing = final ? 0.1 : 0.08;
    const ring = final ? 0.9 : 0.42;
    for (let i = 0; i < notes.length; i++) {
      const when = at + i * spacing;
      const f = notes[i];
      tone(g, 'sine', f, f, 0, when, ring, 0.28, 'pluck');
      // A short-lived octave partial gives the strike its glint without any harshness in the tail.
      tone(g, 'sine', f * 2, f * 2, 0, when, ring * 0.45, final ? 0.09 : 0.05, 'pluck');
      if (final) tone(g, 'sine', f * 3.01, f * 3.01, 0, when, ring * 0.3, 0.035, 'pluck');
    }
  }

  /** Race start beeps; 0 is the higher, longer GO tone. */
  countdown(step: 3 | 2 | 1 | 0): void {
    const g = this.live();
    if (g === null) return;
    const at = g.ctx.currentTime + LEAD;
    if (step === 0) tone(g, 'triangle', 1320, 1320, 0, at, 0.4, 0.32, 'beep');
    else tone(g, 'triangle', 880, 880, 0, at, 0.12, 0.3, 'beep');
  }

  /** ESC arming jingle (rising tones) / disarm (falling). */
  arm(on: boolean): void {
    const g = this.live();
    if (g === null) return;
    const at = g.ctx.currentTime + LEAD;
    const notes = on ? ARM_NOTES : DISARM_NOTES;
    // ESCs beep by pulsing the motor windings: a square wave heard through a very poor speaker.
    for (let i = 0; i < notes.length; i++) {
      tone(g, 'square', notes[i], notes[i], 0, at + i * 0.1, 0.075, on ? 0.1 : 0.08, 'beep', 3200);
    }
  }

  /** Short urgent double beep; the caller rate-limits. */
  lowBattery(): void {
    const g = this.live();
    if (g === null) return;
    const at = g.ctx.currentTime + LEAD;
    tone(g, 'square', 2093, 2093, 0, at, 0.08, 0.11, 'beep', 5000);
    tone(g, 'square', 2093, 2093, 0, at + 0.14, 0.08, 0.11, 'beep', 5000);
  }

  /** Subtle reward blip, slightly higher in pitch for bigger scores. */
  trick(points: number): void {
    const g = this.live();
    if (g === null) return;
    const at = g.ctx.currentTime + LEAD;
    // Scores span orders of magnitude, so pitch follows their logarithm: 1 → A5, 10 000 → F♯6.
    const rank = saturate(Math.log10(Math.max(finite(points, 0), 1)) / 4);
    const f = 880 * Math.pow(2, rank * 0.75);
    tone(g, 'sine', f, f * 1.5, 0.05, at, 0.14, 0.1, 'pluck');
    tone(g, 'sine', f * 2, f * 3, 0.05, at, 0.08, 0.028, 'pluck');
  }

  /** Quad hit water. */
  splash(): void {
    const g = this.live();
    if (g === null) return;
    const at = g.ctx.currentTime + LEAD;
    // The slap and the collapsing column of water, the plunge underneath it, then spray and bubbles.
    burst(g, 'lowpass', 4200, 380, 0.7, at, 0.75, 0.75, 0.012);
    tone(g, 'sine', 180, 52, 0.2, at, 0.3, 0.45, 'pluck');
    burst(g, 'bandpass', 5200, 6800, 0.8, at + 0.03, 1, 0.3, 0.05);
    for (let i = 0; i < 5; i++) {
      const f = 500 + Math.random() * 900;
      tone(g, 'sine', f, f * 1.7, 0.05, at + 0.15 + Math.random() * 0.6, 0.07, 0.04 + Math.random() * 0.04, 'pluck');
    }
  }

  /** Very quiet interface ticks, all under 60 ms. */
  ui(kind: 'hover' | 'select' | 'back' | 'toggle'): void {
    const g = this.live();
    if (g === null) return;
    const at = g.ctx.currentTime + LEAD;
    switch (kind) {
      case 'hover':
        tone(g, 'sine', 2400, 2400, 0, at, 0.022, 0.03, 'pluck');
        break;
      case 'select':
        tone(g, 'sine', 1300, 1950, 0.03, at, 0.05, 0.065, 'pluck');
        break;
      case 'back':
        tone(g, 'sine', 1100, 740, 0.03, at, 0.05, 0.06, 'pluck');
        break;
      case 'toggle':
        tone(g, 'triangle', 1700, 1700, 0, at, 0.03, 0.055, 'pluck');
        break;
    }
  }

  /** Fade the flight sounds out/in over ~150 ms (menus); one-shots and UI ticks keep playing. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const g = this.graph;
    if (g !== null) g.flight.to(paused ? 0 : 1, g.ctx.currentTime, PAUSE_TC);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const g = this.graph;
    this.graph = null;
    if (g === null) return;
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const source of g.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    g.output.disconnect();
    if (g.ctx.state !== 'closed') void g.ctx.close().catch(noop);
  }

  /** The graph, but only while it can make sound; null before `unlock()`, while suspended, and after `dispose()`. */
  private live(): Graph | null {
    const g = this.graph;
    return g !== null && g.ctx.state === 'running' ? g : null;
  }

  /** Craft type changes in a menu, not in flight, so swapping the wavetable outright is fine. */
  private applyDucting(g: Graph, ducted: boolean): void {
    this.ducted = ducted;
    const wave = ducted ? g.ductedShaft : g.openShaft;
    for (let i = 0; i < MOTORS; i++) g.voices[i].shaft.setPeriodicWave(wave);
    // A duct smears the vortex noise over a wider band.
    g.noiseQ.value = ducted ? 0.6 : 0.9;
  }
}
