/**
 * Freestyle trick recognition and combo scoring.
 *
 * Pure logic: no rendering, physics-engine or DOM dependency, so it can be fed
 * straight from the fixed-step simulation and unit-tested with synthetic flight.
 *
 * Two families of trick are recognised:
 *  - rotation tricks (roll, flip, yaw spin, power loop, split-S) are awarded the
 *    instant the rotation completes;
 *  - sustained tricks (dive, inverted hang, low skim) are awarded when the pilot
 *    flies out of them, because their value depends on how long they were held.
 */

export interface TrickSample {
  dt: number;
  /** body-frame rotation rates, rad/s. roll: + = right wing down. pitch: + = nose DOWN (forward flip). yaw: + = nose right. */
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  /** y component of the quad's up vector in world space: 1 = upright, 0 = on its side or vertical, -1 = inverted */
  upY: number;
  /** world position, metres (y is up) */
  x: number;
  y: number;
  z: number;
  /** world velocity, m/s */
  vx: number;
  vy: number;
  vz: number;
  /** height above the ground directly below, metres */
  agl: number;
  /** true while armed and not sitting on the ground */
  airborne: boolean;
}

export interface TrickEvent {
  /** stable machine id, e.g. 'roll', 'backflip', 'powerloop' */
  id: string;
  /** display name, e.g. 'Double Roll', 'Power Loop' */
  name: string;
  /** points awarded for this trick AFTER the multiplier */
  points: number;
  /** base points before the multiplier */
  base: number;
  /** combo multiplier that applied */
  multiplier: number;
}

// ── Tunables ────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Below this an axis is drifting or being corrected, not being thrown around. */
const SPIN_MIN_RATE = 90 * DEG;
/** How long an axis may dawdle below its minimum rate before the rotation is abandoned. */
const SPIN_IDLE_RESET = 0.35;
/** Turning back this far is a change of mind; anything less is a wobble or an overshoot settling. */
const SPIN_REVERSAL = 45 * DEG;
/**
 * A turn is credited slightly short of 360°. Pilots rarely start from dead level
 * or stop exactly on the mark, and summing hundreds of small steps never lands
 * on exactly 2π either.
 */
const TURN_TOLERANCE = 10 * DEG;

/** Bank limit for a yaw spin: steeper than this and "yaw" is really a carving turn. */
const YAW_LEVEL_UPY = 0.6;
const YAW_SPIN_MAX_TIME = 1.5;
/**
 * A steady spin slower than this cannot finish a turn inside the time limit, so
 * gating on rate enforces the limit without keeping a history of samples.
 */
const YAW_SPIN_MIN_RATE = TAU / YAW_SPIN_MAX_TIME;

const POWER_LOOP_MIN_ENTRY_SPEED = 6;
const POWER_LOOP_MIN_CLIMB = 3;

const SPLIT_S_INVERTED_UPY = -0.7;
const SPLIT_S_UPRIGHT_UPY = 0.7;
/** Generous on purpose: the half roll may start from a bank, and only has to rule out arriving inverted by flipping. */
const SPLIT_S_ROLL_MIN = 90 * DEG;
const SPLIT_S_ROLL_MAX = 270 * DEG;
/** The pull-through has to be under way this soon after reaching inverted. */
const SPLIT_S_PULL_WINDOW = 1.2;
const SPLIT_S_PULL_STARTED = 30 * DEG;
/** Deliberately under 180°: the upright check supplies the rest, this only has to tell a pull-through from rolling back out. */
const SPLIT_S_HALF_LOOP = 120 * DEG;
const SPLIT_S_OVER_ROTATED = 270 * DEG;
const SPLIT_S_TIMEOUT = 4;
const SPLIT_S_MIN_DROP = 4;

const DIVE_ENTER_VY = -12;
/** Slacker than the entry speed so a dive hovering around the threshold stays one dive. */
const DIVE_EXIT_VY = -8;
const DIVE_MIN_DROP = 15;
const DIVE_MAX_DROP = 65;
/** More pitch rotation than any pull-out needs: past this the quad is going over the top of a loop. */
const DIVE_LOOPING_ANGLE = 150 * DEG;

const HANG_UPY = -0.75;
const HANG_MIN_TIME = 0.8;
const HANG_MAX_TIME = 5;

const SKIM_MIN_SPEED = 10;
const SKIM_MAX_AGL = 1.2;
const SKIM_MIN_TIME = 1;
const SKIM_MAX_DISTANCE = 150;

const COMBO_WINDOW = 3;
const MULTIPLIER_STEP = 0.5;
const MULTIPLIER_REPEAT_STEP = 0.1;
const MULTIPLIER_MAX = 5;

const POINTS = {
  roll: 100,
  flip: 150,
  yawSpin: 120,
  invertedYawSpin: 200,
  powerLoop: 400,
  splitS: 350,
  gap: 250,
  dive: [100, 500],
  hang: [50, 300],
  skim: [50, 400],
} as const;

/** Name prefix per consecutive turn; beyond the table the count is spelled out ("5x Roll"). */
const TURN_PREFIX = ['', 'Double ', 'Triple ', 'Quad '];
/** Each extra consecutive turn is worth this much more of the base (so a double is x2.5). */
const TURN_BONUS = 1.5;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Maps `v` in [v0, v1] onto a points range, clamped, rounded to a HUD-friendly multiple of 10. */
function scaledPoints(v: number, v0: number, v1: number, range: readonly [number, number]): number {
  const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
  return Math.round((range[0] + t * (range[1] - range[0])) / 10) * 10;
}

/**
 * Follows the rotation about one body axis and reports each full turn made in
 * one direction.
 *
 * The angle is integrated signed rather than as |rate|, so stick wobble cancels
 * out instead of inflating the count. A "stream" opens when the rate first
 * becomes decisive and dies when the axis goes quiet or the pilot turns back,
 * which is what keeps slow drift from ever adding up to a trick.
 */
class SpinAccumulator {
  /** +1 / -1 while a rotation is being followed, 0 when idle. */
  dir = 0;
  /** Rotation in `dir` since the stream opened, radians. */
  angle = 0;
  /** Full turns already reported for this stream. */
  turns = 0;
  /** True for the one step in which a stream (re)opened, so the owner can snapshot entry conditions. */
  started = false;

  private readonly minRate: number;
  private peak = 0;
  private idle = 0;

  constructor(minRate: number) {
    this.minRate = minRate;
  }

  reset(): void {
    this.dir = 0;
    this.angle = 0;
    this.turns = 0;
    this.started = false;
    this.peak = 0;
    this.idle = 0;
  }

  /** Integrates one step and returns how many full turns it completed (more than one only at very coarse dt). */
  step(rate: number, dt: number): number {
    this.started = false;
    const decisive = Math.abs(rate) >= this.minRate;

    if (this.dir === 0) {
      if (!decisive) return 0;
      this.dir = rate > 0 ? 1 : -1;
      this.started = true;
    } else if (decisive) {
      this.idle = 0;
    } else {
      this.idle += dt;
      if (this.idle > SPIN_IDLE_RESET) {
        this.reset();
        return 0;
      }
    }

    this.angle += this.dir * rate * dt;
    if (this.angle > this.peak) {
      this.peak = this.angle;
    } else if (this.peak - this.angle > SPIN_REVERSAL) {
      // The retreat is already rotation the other way, so it seeds the new stream
      // rather than being thrown away.
      const reversed = this.peak - this.angle;
      this.dir = -this.dir;
      this.angle = reversed;
      this.peak = reversed;
      this.turns = 0;
      this.idle = 0;
      this.started = true;
    }

    let completed = 0;
    while (this.angle >= (this.turns + 1) * TAU - TURN_TOLERANCE) {
      this.turns++;
      completed++;
    }
    return completed;
  }
}

// ── Tracker ─────────────────────────────────────────────────────────────────

/**
 * Feed it one {@link TrickSample} per physics step; it reports tricks through
 * {@link onTrick} and keeps the score and combo state.
 *
 * Sustained tricks that are still in progress are dropped, not paid out, when the
 * quad lands or crashes: a trick only counts once it has been flown out of.
 */
export class TrickTracker {
  /** assign to be told about each trick as it is recognised */
  onTrick: ((e: TrickEvent) => void) | null = null;
  /**
   * assign to be told when a combo ends: total banked, number of tricks in it.
   * A crash reports a total of 0, so a HUD can tell "banked" from "lost".
   */
  onComboEnd: ((total: number, count: number) => void) | null = null;

  private banked = 0;
  private best = 0;
  private comboPoints = 0;
  private comboTricks = 0;
  private comboMultiplier = 1;
  private comboTimer = 0;
  private lastId: string | null = null;
  /** Airborne flag of the latest sample; gates gap(), which arrives outside update(). */
  private airborne = false;

  private readonly rollSpin = new SpinAccumulator(SPIN_MIN_RATE);
  private readonly pitchSpin = new SpinAccumulator(SPIN_MIN_RATE);
  private readonly yawSpin = new SpinAccumulator(YAW_SPIN_MIN_RATE);

  /** Flips already paid as plain flips in the current pitch stream (power loops don't count towards "Double"). */
  private plainFlips = 0;
  // Entry conditions of the pitch turn in progress, for telling a power loop from a flip on the spot.
  private lapEntrySpeed = 0;
  private lapEntryY = 0;
  private lapPeakY = 0;

  private wasInverted = false;
  private splitArmed = false;
  private splitTime = 0;
  private splitPulled = 0;
  private splitEntryY = 0;

  private diving = false;
  private diveDrop = 0;

  private hangTime = 0;

  private skimTime = 0;
  private skimDistance = 0;

  /** total banked + current combo */
  get score(): number {
    return this.banked + this.comboPoints;
  }

  /** points in the running combo (0 when none) */
  get combo(): number {
    return this.comboPoints;
  }

  /** tricks in the running combo */
  get comboCount(): number {
    return this.comboTricks;
  }

  /** current multiplier (1 when no combo) */
  get multiplier(): number {
    return this.comboMultiplier;
  }

  /** seconds until the running combo banks (0 when none) */
  get comboTimeLeft(): number {
    return this.comboTricks > 0 ? Math.max(0, this.comboTimer) : 0;
  }

  /** largest combo actually banked; a combo lost to a crash never counts */
  get bestCombo(): number {
    return this.best;
  }

  update(s: TrickSample): void {
    if (!s.airborne) {
      this.airborne = false;
      this.resetDetectors();
      if (this.comboTricks > 0) this.bank();
      return;
    }
    this.airborne = true;

    // A paused or first frame carries no motion to integrate.
    const dt = s.dt;
    if (!(dt > 0) || !Number.isFinite(dt)) return;

    // Ticked before detection so a trick landed this step starts with the full window.
    this.tickCombo(dt);

    this.trackRoll(s);
    this.trackPitch(s);
    this.trackYaw(s);
    this.trackSplitS(s);
    this.trackDive(s);
    this.trackInvertedHang(s);
    this.trackSkim(s);
  }

  /**
   * the game calls this when the quad threads a gap or gate in freestyle.
   * Ignored unless the latest sample was airborne, so a wreck tumbling through
   * a gate after a crash scores nothing.
   */
  gap(name?: string): void {
    if (!this.airborne) return;
    this.award('gap', name ?? 'Gap', POINTS.gap);
  }

  /** the quad crashed: the running combo is LOST (not banked) */
  crash(): void {
    const count = this.comboTricks;
    this.airborne = false;
    this.clearCombo();
    this.resetDetectors();
    if (count > 0) this.onComboEnd?.(0, count);
  }

  /** Back to a fresh session: score, best combo and all in-flight state are cleared; callbacks stay wired. */
  reset(): void {
    this.banked = 0;
    this.best = 0;
    this.airborne = false;
    this.clearCombo();
    this.resetDetectors();
  }

  // ── Rotation tricks ───────────────────────────────────────────────────────

  private trackRoll(s: TrickSample): void {
    const spin = this.rollSpin;
    const completed = spin.step(s.rollRate, s.dt);
    const first = spin.turns - completed + 1;
    for (let i = 0; i < completed; i++) this.awardTurn('roll', 'Roll', POINTS.roll, first + i);
  }

  private trackPitch(s: TrickSample): void {
    const spin = this.pitchSpin;
    const completed = spin.step(s.pitchRate, s.dt);
    if (spin.started) {
      this.plainFlips = 0;
      this.beginPitchLap(s);
    }
    if (spin.dir === 0) return;
    if (s.y > this.lapPeakY) this.lapPeakY = s.y;

    // pitchRate > 0 is nose-down, so a negative stream is the pull-back direction.
    const backward = spin.dir < 0;
    for (let i = 0; i < completed; i++) {
      const looped =
        backward &&
        this.lapEntrySpeed > POWER_LOOP_MIN_ENTRY_SPEED &&
        this.lapPeakY - this.lapEntryY >= POWER_LOOP_MIN_CLIMB;
      if (looped) {
        // Replaces the backflip the same 360° would otherwise have earned.
        this.award('powerloop', 'Power Loop', POINTS.powerLoop);
      } else {
        this.plainFlips++;
        if (backward) this.awardTurn('backflip', 'Backflip', POINTS.flip, this.plainFlips);
        else this.awardTurn('frontflip', 'Front Flip', POINTS.flip, this.plainFlips);
      }
      // Each consecutive turn is judged on its own entry, so a loop followed by a
      // flip on the spot is not paid as two loops.
      this.beginPitchLap(s);
    }
  }

  private beginPitchLap(s: TrickSample): void {
    this.lapEntrySpeed = Math.hypot(s.vx, s.vz);
    this.lapEntryY = s.y;
    this.lapPeakY = s.y;
  }

  private trackYaw(s: TrickSample): void {
    // Leaving the level band abandons the spin: yaw rate while banked or vertical
    // is what a coordinated turn or a rolling dive looks like, not a flat spin.
    if (Math.abs(s.upY) <= YAW_LEVEL_UPY) {
      this.yawSpin.reset();
      return;
    }
    const completed = this.yawSpin.step(s.yawRate, s.dt);
    for (let i = 0; i < completed; i++) {
      // The stream cannot have crossed from upright to inverted without passing
      // through the banked band above, so the current side holds for the whole turn.
      if (s.upY < 0) this.award('invyawspin', 'Inverted Yaw Spin', POINTS.invertedYawSpin);
      else this.award('yawspin', 'Yaw Spin', POINTS.yawSpin);
    }
  }

  /**
   * Split-S: half roll to inverted, then pull back through nose-down to upright.
   * Armed at the moment the quad becomes inverted by rolling; paid when it is
   * upright again having pulled the half loop and given up the height.
   */
  private trackSplitS(s: TrickSample): void {
    const inverted = s.upY < SPLIT_S_INVERTED_UPY;
    if (inverted && !this.wasInverted) {
      // Modulo a turn, so a roll-and-a-half entry still counts: its first 360°
      // was paid as a Roll and only the last half belongs to the split-S.
      const rolled = this.rollSpin.angle % TAU;
      if (rolled >= SPLIT_S_ROLL_MIN && rolled <= SPLIT_S_ROLL_MAX) {
        this.splitArmed = true;
        this.splitTime = 0;
        this.splitPulled = 0;
        this.splitEntryY = s.y;
      }
    }
    this.wasInverted = inverted;
    if (!this.splitArmed) return;

    this.splitTime += s.dt;
    // Inverted, pulling back (negative pitch rate) swings the nose down through the ground side.
    this.splitPulled -= s.pitchRate * s.dt;

    const hesitated = this.splitTime > SPLIT_S_PULL_WINDOW && this.splitPulled < SPLIT_S_PULL_STARTED;
    if (hesitated || this.splitTime > SPLIT_S_TIMEOUT || this.splitPulled > SPLIT_S_OVER_ROTATED) {
      this.splitArmed = false;
      return;
    }
    if (s.upY <= SPLIT_S_UPRIGHT_UPY) return;

    if (this.splitPulled < SPLIT_S_HALF_LOOP) {
      // Upright again without the pull-through: the pilot simply rolled back out.
      this.splitArmed = false;
      return;
    }
    // Rotation done but not yet enough height lost: stay armed, the quad may still be sinking.
    if (this.splitEntryY - s.y < SPLIT_S_MIN_DROP) return;

    this.splitArmed = false;
    this.award('splits', 'Split-S', POINTS.splitS);
    // The half roll and half loop are spent: left in the accumulators they could
    // be topped up into a Roll or Backflip the pilot never flew in full.
    this.rollSpin.reset();
    this.pitchSpin.reset();
  }

  // ── Sustained tricks ──────────────────────────────────────────────────────

  private trackDive(s: TrickSample): void {
    if (s.vy < DIVE_ENTER_VY) {
      this.diving = true;
      // Summed from vertical speed rather than read off the altitude so that the
      // stretches excluded below simply don't count, and so the pull-out's tail
      // (slower than the entry speed) doesn't pad the drop.
      if (!this.descendingInFigure()) this.diveDrop -= s.vy * s.dt;
    } else if (this.diving && s.vy > DIVE_EXIT_VY) {
      const drop = this.diveDrop;
      this.diving = false;
      this.diveDrop = 0;
      if (drop >= DIVE_MIN_DROP) {
        this.award('dive', 'Dive', scaledPoints(drop, DIVE_MIN_DROP, DIVE_MAX_DROP, POINTS.dive));
      }
    }
  }

  /**
   * True on the downhill side of a loop or split-S. A big one sheds enough
   * height fast enough to look like a dive, but that height is already paid
   * for by the figure itself.
   */
  private descendingInFigure(): boolean {
    return (
      (this.pitchSpin.dir !== 0 && this.pitchSpin.angle >= DIVE_LOOPING_ANGLE) ||
      (this.splitArmed && this.splitPulled >= SPLIT_S_PULL_STARTED)
    );
  }

  private trackInvertedHang(s: TrickSample): void {
    if (s.upY < HANG_UPY) {
      this.hangTime += s.dt;
      return;
    }
    const held = this.hangTime;
    this.hangTime = 0;
    if (held > HANG_MIN_TIME) {
      this.award('inverted', 'Inverted Hang', scaledPoints(held, HANG_MIN_TIME, HANG_MAX_TIME, POINTS.hang));
    }
  }

  private trackSkim(s: TrickSample): void {
    // Ground speed, not airspeed: plunging through the last metre is not skimming,
    // and the award is for ground covered.
    const speed = Math.hypot(s.vx, s.vz);
    if (speed > SKIM_MIN_SPEED && s.agl < SKIM_MAX_AGL) {
      this.skimTime += s.dt;
      this.skimDistance += speed * s.dt;
      return;
    }
    const held = this.skimTime;
    const distance = this.skimDistance;
    this.skimTime = 0;
    this.skimDistance = 0;
    if (held > SKIM_MIN_TIME) {
      const shortest = SKIM_MIN_SPEED * SKIM_MIN_TIME;
      this.award('skim', 'Low Skim', scaledPoints(distance, shortest, SKIM_MAX_DISTANCE, POINTS.skim));
    }
  }

  /** True while a sustained trick has already earned its award and is only being extended. */
  private sustaining(): boolean {
    return (
      (this.diving && this.diveDrop >= DIVE_MIN_DROP) ||
      this.hangTime > HANG_MIN_TIME ||
      this.skimTime > SKIM_MIN_TIME
    );
  }

  private resetDetectors(): void {
    this.rollSpin.reset();
    this.pitchSpin.reset();
    this.yawSpin.reset();
    this.plainFlips = 0;
    this.lapEntrySpeed = 0;
    this.lapEntryY = 0;
    this.lapPeakY = 0;
    this.wasInverted = false;
    this.splitArmed = false;
    this.splitTime = 0;
    this.splitPulled = 0;
    this.splitEntryY = 0;
    this.diving = false;
    this.diveDrop = 0;
    this.hangTime = 0;
    this.skimTime = 0;
    this.skimDistance = 0;
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  /** Awards the n-th consecutive full turn of a roll or flip: 'roll', 'roll2' "Double Roll", ... */
  private awardTurn(id: string, name: string, base: number, turn: number): void {
    const prefix = TURN_PREFIX[turn - 1] ?? `${turn}x `;
    // Capped at the last named tier: holding the stick over forever should not pay ever more per turn.
    const tier = Math.min(turn, TURN_PREFIX.length);
    this.award(turn > 1 ? `${id}${turn}` : id, prefix + name, Math.round(base * (1 + TURN_BONUS * (tier - 1))));
  }

  private award(id: string, name: string, base: number): void {
    let multiplier = 1;
    if (this.comboTricks > 0) {
      const step = id === this.lastId ? MULTIPLIER_REPEAT_STEP : MULTIPLIER_STEP;
      // Rounded because repeated +0.1 steps would otherwise surface as 1.2000000000000002.
      multiplier = Math.min(MULTIPLIER_MAX, Math.round((this.comboMultiplier + step) * 10) / 10);
    }
    const points = Math.round(base * multiplier);

    this.comboMultiplier = multiplier;
    this.comboPoints += points;
    this.comboTricks++;
    this.comboTimer = COMBO_WINDOW;
    this.lastId = id;

    this.onTrick?.({ id, name, points, base, multiplier });
  }

  private tickCombo(dt: number): void {
    if (this.comboTricks === 0) return;
    // The clock is held while a sustained trick that has already qualified is
    // being stretched; otherwise extending a skim or dive, which pays out only
    // when it ends, would be punished by the combo expiring underneath it.
    if (this.sustaining()) return;
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) this.bank();
  }

  private bank(): void {
    const total = this.comboPoints;
    const count = this.comboTricks;
    this.banked += total;
    if (total > this.best) this.best = total;
    // Cleared before the callback so a listener reading the tracker sees the banked state.
    this.clearCombo();
    this.onComboEnd?.(total, count);
  }

  private clearCombo(): void {
    this.comboPoints = 0;
    this.comboTricks = 0;
    this.comboMultiplier = 1;
    this.comboTimer = 0;
    this.lastId = null;
  }
}
