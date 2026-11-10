import { describe, expect, it } from 'vitest';
import { TrickTracker, type TrickEvent, type TrickSample } from '../src/game/tricks';

const DEG = Math.PI / 180;
/** physics rate the tracker is fed at in the game */
const DT = 0.002;

/** Stick/velocity state held over one segment of synthetic flight. Rates in deg/s, velocities in m/s. */
interface Controls {
  roll?: number;
  pitch?: number;
  yaw?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

/**
 * A scripted quad: integrates attitude and position from per-segment rates and
 * velocities and feeds the tracker a physically consistent sample each step.
 * Attitude is kept as independent roll/pitch angles, which is exact for the
 * single-axis manoeuvres flown here and gives upY = cos(roll) * cos(pitch).
 */
class Flight {
  readonly tracker = new TrickTracker();
  readonly events: TrickEvent[] = [];
  readonly comboEnds: Array<{ total: number; count: number }> = [];
  x = 0;
  y: number;
  z = 0;
  rollAngle = 0;
  pitchAngle = 0;
  airborne = true;
  dt: number;

  constructor(altitude = 60, dt = DT) {
    this.y = altitude;
    this.dt = dt;
    this.tracker.onTrick = (e) => this.events.push(e);
    this.tracker.onComboEnd = (total, count) => this.comboEnds.push({ total, count });
  }

  get ids(): string[] {
    return this.events.map((e) => e.id);
  }

  /** Flies `seconds` holding `controls` (or a function of time into the segment). Flat ground at y = 0. */
  fly(seconds: number, controls: Controls | ((t: number) => Controls) = {}): this {
    const steps = Math.round(seconds / this.dt);
    for (let i = 0; i < steps; i++) {
      const c = typeof controls === 'function' ? controls(i * this.dt) : controls;
      const rollRate = (c.roll ?? 0) * DEG;
      const pitchRate = (c.pitch ?? 0) * DEG;
      const vx = c.vx ?? 0;
      const vy = c.vy ?? 0;
      const vz = c.vz ?? 0;
      this.rollAngle += rollRate * this.dt;
      this.pitchAngle += pitchRate * this.dt;
      this.x += vx * this.dt;
      this.y += vy * this.dt;
      this.z += vz * this.dt;
      const sample: TrickSample = {
        dt: this.dt,
        rollRate,
        pitchRate,
        yawRate: (c.yaw ?? 0) * DEG,
        upY: Math.cos(this.rollAngle) * Math.cos(this.pitchAngle),
        x: this.x,
        y: this.y,
        z: this.z,
        vx,
        vy,
        vz,
        agl: this.y,
        airborne: this.airborne,
      };
      this.tracker.update(sample);
    }
    return this;
  }

  // ── manoeuvre library ──

  roll(turns = 1, rate = 720): this {
    return this.fly((turns * 360) / Math.abs(rate), { roll: rate });
  }

  backflip(turns = 1, rate = 720): this {
    return this.fly((turns * 360) / rate, { pitch: -rate });
  }

  frontflip(turns = 1, rate = 720): this {
    return this.fly((turns * 360) / rate, { pitch: rate });
  }

  yawSpin(turns = 1, rate = 720): this {
    return this.fly((turns * 360) / rate, { yaw: rate });
  }

  /** A circular loop pulled nose-up at `rate` deg/s from level flight at `speed` m/s: climbs over the top, then descends. */
  loop(speed = 15, rate = 300): this {
    const w = rate * DEG;
    return this.fly(360 / rate, (t) => ({
      pitch: -rate,
      vx: speed * Math.cos(w * t),
      vy: speed * Math.sin(w * t),
    }));
  }

  /** The second half of a split-S: from inverted level flight, pull through nose-down to upright on the reverse heading. */
  pullThrough(speed = 15, rate = 240): this {
    const w = rate * DEG;
    return this.fly(180 / rate, (t) => ({
      pitch: -rate,
      vx: speed * Math.cos(w * t),
      vy: -speed * Math.sin(w * t),
    }));
  }
}

/** Small deterministic noise source so "hover" is not suspiciously perfect. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 2147483648 - 1;
  };
}

describe('rolls', () => {
  it('awards a Roll for 360 degrees at 720 deg/s', () => {
    const f = new Flight().fly(0.5).roll().fly(0.5);
    expect(f.events).toEqual([{ id: 'roll', name: 'Roll', base: 100, multiplier: 1, points: 100 }]);
  });

  it('awards rolls in either direction', () => {
    expect(new Flight().roll(1, -720).fly(0.5).ids).toEqual(['roll']);
  });

  it('upgrades a 720 degree roll to Double Roll as a second event', () => {
    const f = new Flight().roll(2).fly(0.5);
    expect(f.ids).toEqual(['roll', 'roll2']);
    expect(f.events[1].name).toBe('Double Roll');
    expect(f.events[1].base).toBe(250);
  });

  it('names a third consecutive turn Triple Roll with rising base points', () => {
    const f = new Flight().roll(3).fly(0.5);
    expect(f.ids).toEqual(['roll', 'roll2', 'roll3']);
    expect(f.events.map((e) => e.name)).toEqual(['Roll', 'Double Roll', 'Triple Roll']);
    const bases = f.events.map((e) => e.base);
    expect(bases[1]).toBeGreaterThan(bases[0]);
    expect(bases[2]).toBeGreaterThan(bases[1]);
  });

  it('does not award a half roll', () => {
    expect(new Flight().roll(0.5).fly(2).ids).not.toContain('roll');
  });

  it('does not add two half rolls in opposite directions into a Roll', () => {
    const f = new Flight().fly(200 / 720, { roll: 720 }).fly(200 / 720, { roll: -720 }).fly(0.5);
    expect(f.events).toEqual([]);
  });

  it('counts a full roll the other way after an abandoned one', () => {
    // 300 degrees right, then a whole roll left: the reversal starts a fresh count
    const f = new Flight().fly(300 / 720, { roll: 720 }).roll(1, -720).fly(0.5);
    expect(f.ids).toEqual(['roll']);
  });

  it('rides out a small wobble back mid-roll', () => {
    const f = new Flight()
      .fly(200 / 720, { roll: 720 })
      .fly(20 / 720, { roll: -720 })
      .fly(180 / 720, { roll: 720 })
      .fly(0.5);
    expect(f.ids).toEqual(['roll']);
  });

  it('abandons a roll that pauses for longer than the idle window', () => {
    const f = new Flight().fly(200 / 720, { roll: 720 }).fly(0.5).fly(200 / 720, { roll: 720 }).fly(0.5);
    expect(f.ids).not.toContain('roll');
  });

  it('keeps a roll alive across a brief hesitation', () => {
    const f = new Flight().fly(200 / 720, { roll: 720 }).fly(0.2).fly(200 / 720, { roll: 720 }).fly(0.5);
    expect(f.ids).toEqual(['roll']);
  });

  it('starts counting again from one after the stream has reset', () => {
    const f = new Flight().roll().fly(1).roll().fly(0.5);
    expect(f.ids).toEqual(['roll', 'roll']);
  });

  it('never awards a roll accumulated at a crawl', () => {
    // 600 degrees in all, but far too slowly to be a roll (the time spent upside down is a hang, not a roll)
    const f = new Flight().fly(10, { roll: 60 }).fly(0.5);
    expect(f.ids.filter((id) => id.startsWith('roll'))).toEqual([]);
  });
});

describe('flips', () => {
  it('awards a Backflip for a nose-up flip on the spot', () => {
    const f = new Flight().backflip().fly(0.5);
    expect(f.events).toEqual([{ id: 'backflip', name: 'Backflip', base: 150, multiplier: 1, points: 150 }]);
  });

  it('awards a Front Flip for a nose-down flip', () => {
    const f = new Flight().frontflip().fly(0.5);
    expect(f.ids).toEqual(['frontflip']);
    expect(f.events[0].name).toBe('Front Flip');
    expect(f.events[0].base).toBe(150);
  });

  it('upgrades 720 degrees of flip to a Double worth 2.5x', () => {
    const back = new Flight().backflip(2).fly(0.5);
    expect(back.ids).toEqual(['backflip', 'backflip2']);
    expect(back.events[1].name).toBe('Double Backflip');
    expect(back.events[1].base).toBe(375);

    const front = new Flight().frontflip(2).fly(0.5);
    expect(front.ids).toEqual(['frontflip', 'frontflip2']);
    expect(front.events[1].name).toBe('Double Front Flip');
  });
});

describe('yaw spins', () => {
  it('awards a Yaw Spin for a brisk level 360', () => {
    const f = new Flight().yawSpin().fly(0.5);
    expect(f.events).toEqual([{ id: 'yawspin', name: 'Yaw Spin', base: 120, multiplier: 1, points: 120 }]);
  });

  it('awards an Inverted Yaw Spin, worth more, when upside down', () => {
    const f = new Flight();
    f.rollAngle = Math.PI;
    f.yawSpin();
    expect(f.ids).toEqual(['invyawspin']);
    expect(f.events[0].name).toBe('Inverted Yaw Spin');
    expect(f.events[0].base).toBeGreaterThan(120);
  });

  it('ignores a slow panning turn however far it goes', () => {
    expect(new Flight().fly(6, { yaw: 120 }).events).toEqual([]);
    // just too slow to get round inside 1.5 s
    expect(new Flight().fly(6, { yaw: 220 }).events).toEqual([]);
  });

  it('ignores yaw while steeply banked', () => {
    const f = new Flight();
    f.rollAngle = 70 * DEG;
    f.fly(3, { yaw: 400 });
    expect(f.events).toEqual([]);
  });
});

describe('power loop', () => {
  it('awards a Power Loop instead of a Backflip for a big loop from speed', () => {
    const f = new Flight().fly(1, { vx: 15 }).loop(15, 300).fly(0.5, { vx: 15 });
    expect(f.events).toEqual([{ id: 'powerloop', name: 'Power Loop', base: 400, multiplier: 1, points: 400 }]);
  });

  it('falls back to a Backflip when the entry is too slow', () => {
    // same 360 of pitch and a 4 m climb, but entered at walking pace
    const f = new Flight().fly(360 / 300, (t) => ({ pitch: -300, vx: 4, vy: t < 0.6 ? 7 : -7 })).fly(0.5);
    expect(f.ids).toEqual(['backflip']);
  });

  it('falls back to a Backflip when flipped on the spot at speed without climbing', () => {
    const f = new Flight().fly(1, { vx: 15 }).fly(0.5, { pitch: -720, vx: 15 }).fly(0.5, { vx: 15 });
    expect(f.ids).toEqual(['backflip']);
  });

  it('never pays a forward (nose-down) loop as a Power Loop', () => {
    const w = 300 * DEG;
    const f = new Flight()
      .fly(1, { vx: 15 })
      .fly(1.2, (t) => ({ pitch: 300, vx: 15 * Math.cos(w * t), vy: 15 * Math.sin(w * t) }))
      .fly(0.5);
    expect(f.ids).toEqual(['frontflip']);
  });

  it('does not also pay the downhill side of a big loop as a dive', () => {
    // 14 m radius: over 25 m shed at better than 12 m/s on the way back down
    const f = new Flight(120).fly(1, { vx: 30 }).loop(30, 120).fly(0.5, { vx: 30 });
    expect(f.ids).toEqual(['powerloop']);
  });

  it('judges each consecutive turn on its own, without inflating the flip count', () => {
    // a loop, then straight into a flip on the spot
    const f = new Flight().fly(1, { vx: 15 }).loop(15, 300).fly(0.5, { pitch: -720 }).fly(0.5);
    expect(f.ids).toEqual(['powerloop', 'backflip']);
  });
});

describe('split-S', () => {
  it('awards a Split-S for a half roll then a pull-through that loses height', () => {
    const f = new Flight().fly(1, { vx: 15 }).roll(0.5).fly(0.2, { vx: 15 });
    const top = f.y;
    f.pullThrough(15, 240).fly(1, { vx: -15 });
    expect(top - f.y).toBeGreaterThan(4);
    expect(f.events).toEqual([{ id: 'splits', name: 'Split-S', base: 350, multiplier: 1, points: 350 }]);
  });

  it('does not let its half roll be topped up into a Roll', () => {
    // a fast pull-through, then straight into another half roll the same way: 360 degrees of
    // roll inside the idle window, but half of it already belongs to the split-S
    const f = new Flight().fly(1, { vx: 30 }).roll(0.5).pullThrough(30, 600).roll(0.5).fly(0.5);
    expect(f.ids).toEqual(['splits']);
  });

  it('does not let its half loop be topped up into a Backflip', () => {
    // keep pulling after the split-S until the pitch has gone all the way round
    const w = 240 * DEG;
    const f = new Flight()
      .fly(1, { vx: 15 })
      .roll(0.5)
      .fly(360 / 240, (t) => ({ pitch: -240, vx: 15 * Math.cos(w * t), vy: -15 * Math.sin(w * t) }))
      .fly(0.3);
    expect(f.ids).toEqual(['splits']);
  });

  it('does not also pay a deep pull-through as a dive', () => {
    // 17 m radius: the pull-through alone sheds over 30 m at dive speed
    const f = new Flight(120).fly(1, { vx: 30 }).roll(0.5).pullThrough(30, 100).fly(0.5, { vx: -30 });
    expect(f.ids).toEqual(['splits']);
  });

  it('needs the pull-through to follow promptly', () => {
    const f = new Flight().fly(1, { vx: 15 }).roll(0.5).fly(2, { vx: 15 }).pullThrough(15, 240).fly(1);
    expect(f.ids).not.toContain('splits');
  });

  it('needs at least 4 m of height to be lost', () => {
    // a tight pull-through: radius under 1 m
    const f = new Flight().fly(1, { vx: 4 }).roll(0.5).fly(0.2, { vx: 4 }).pullThrough(4, 360).fly(1);
    expect(f.events).toEqual([]);
  });

  it('is not triggered by rolling inverted and rolling back out', () => {
    const f = new Flight().roll(0.5).fly(0.3).roll(0.5, -720).fly(1, { vy: -6 });
    expect(f.events).toEqual([]);
  });

  it('is not triggered by an ordinary roll passing through inverted', () => {
    expect(new Flight().roll().fly(1, { vy: -6 }).ids).toEqual(['roll']);
  });
});

describe('dive', () => {
  it('awards one Dive at the pull-out, not during the descent', () => {
    const f = new Flight(120).fly(0.5).fly(2, { vy: -20 });
    expect(f.events).toEqual([]);
    f.fly(0.5);
    expect(f.ids).toEqual(['dive']);
    expect(f.events[0].name).toBe('Dive');
    // 40 m lost: comfortably inside the 100-500 band
    expect(f.events[0].base).toBeGreaterThan(100);
    expect(f.events[0].base).toBeLessThan(500);
  });

  it('pays more for a longer dive and caps the award', () => {
    const base = (seconds: number) => new Flight(400).fly(seconds, { vy: -20 }).fly(0.5).events[0].base;
    expect(base(1)).toBeLessThan(base(2));
    expect(base(2)).toBeLessThan(base(3));
    expect(base(10)).toBe(500);
    // 15 m is the least that counts and earns the floor
    expect(base(0.76)).toBe(100);
  });

  it('ignores a drop that is too short or too gentle', () => {
    expect(new Flight(120).fly(0.5, { vy: -20 }).fly(0.5).events).toEqual([]);
    expect(new Flight(120).fly(10, { vy: -8 }).fly(0.5).events).toEqual([]);
  });

  it('still pays a dive that is flipped out of', () => {
    const f = new Flight(200).fly(2, { vy: -20 }).fly(0.5, { pitch: -720, vy: -20 }).fly(0.5);
    expect(f.ids).toEqual(['backflip', 'dive']);
    // the 40 m before the flip counts; the fall during the flip's second half does not
    expect(f.events[1].base).toBe(new Flight(200).fly(2.2, { vy: -20 }).fly(0.5).events[0].base);
  });

  it('treats a dive that hovers around the threshold as one dive', () => {
    const f = new Flight(300)
      .fly(1.5, { vy: -20 })
      .fly(0.2, { vy: -10 })
      .fly(1.5, { vy: -20 })
      .fly(0.5);
    expect(f.ids).toEqual(['dive']);
  });
});

describe('inverted hang', () => {
  it('awards an Inverted Hang when the quad rolls back upright', () => {
    const f = new Flight().roll(0.5).fly(2);
    expect(f.events).toEqual([]);
    f.roll(0.5, -720).fly(0.5);
    expect(f.ids).toEqual(['inverted']);
    expect(f.events[0].name).toBe('Inverted Hang');
    expect(f.events[0].base).toBeGreaterThan(50);
    expect(f.events[0].base).toBeLessThan(300);
  });

  it('scales with duration and is capped', () => {
    const base = (seconds: number) => new Flight().roll(0.5).fly(seconds).roll(0.5, -720).events[0].base;
    expect(base(1.5)).toBeLessThan(base(3));
    expect(base(20)).toBe(300);
    expect(base(60)).toBe(300);
  });

  it('ignores being briefly upside down', () => {
    expect(new Flight().roll(0.5).fly(0.5).roll(0.5, -720).fly(0.5).events).toEqual([]);
  });
});

describe('low skim', () => {
  it('awards a Low Skim when the quad climbs away', () => {
    const f = new Flight(0.8).fly(3, { vx: 15 });
    expect(f.events).toEqual([]);
    f.fly(0.5, { vx: 15, vy: 8 });
    expect(f.ids).toEqual(['skim']);
    expect(f.events[0].name).toBe('Low Skim');
    expect(f.events[0].base).toBeGreaterThan(50);
    expect(f.events[0].base).toBeLessThan(400);
  });

  it('scales with distance covered and is capped', () => {
    const base = (seconds: number) => new Flight(0.8).fly(seconds, { vx: 15 }).fly(0.5, { vy: 8 }).events[0].base;
    expect(base(2)).toBeLessThan(base(5));
    expect(base(60)).toBe(400);
  });

  it('ignores passes that are too short, too slow or too high', () => {
    expect(new Flight(0.8).fly(0.8, { vx: 15 }).fly(0.5, { vy: 8 }).events).toEqual([]);
    expect(new Flight(0.8).fly(5, { vx: 8 }).fly(0.5, { vy: 8 }).events).toEqual([]);
    expect(new Flight(3).fly(5, { vx: 15 }).fly(0.5, { vy: 8 }).events).toEqual([]);
  });
});

describe('gap', () => {
  it('awards a Gap when the game reports one', () => {
    const f = new Flight().fly(0.1);
    f.tracker.gap();
    expect(f.events).toEqual([{ id: 'gap', name: 'Gap', base: 250, multiplier: 1, points: 250 }]);
  });

  it('uses the supplied name but keeps the id stable', () => {
    const f = new Flight().fly(0.1);
    f.tracker.gap('Hangar Door');
    expect(f.events[0]).toMatchObject({ id: 'gap', name: 'Hangar Door' });
  });

  it('is ignored while the quad is not flying', () => {
    const f = new Flight();
    f.tracker.gap();
    f.airborne = false;
    f.fly(0.1);
    f.tracker.gap();
    expect(f.events).toEqual([]);
  });
});

describe('combo', () => {
  it('raises the multiplier by 0.5 per different trick and banks when the timer runs out', () => {
    const f = new Flight().roll().fly(1).backflip().fly(1).yawSpin();
    const t = f.tracker;

    expect(f.ids).toEqual(['roll', 'backflip', 'yawspin']);
    expect(f.events.map((e) => e.multiplier)).toEqual([1, 1.5, 2]);
    expect(f.events.map((e) => e.points)).toEqual([100, 225, 240]);
    expect(t.combo).toBe(565);
    expect(t.comboCount).toBe(3);
    expect(t.multiplier).toBe(2);
    // the spin is credited a few degrees early, so a sliver of the window has already gone
    expect(t.comboTimeLeft).toBeGreaterThan(2.95);
    expect(t.comboTimeLeft).toBeLessThanOrEqual(3);
    // an unbanked combo already shows in the score
    expect(t.score).toBe(565);
    expect(f.comboEnds).toEqual([]);

    f.fly(2);
    expect(t.comboTimeLeft).toBeCloseTo(1, 1);
    expect(t.comboCount).toBe(3);

    f.fly(1.1);
    expect(f.comboEnds).toEqual([{ total: 565, count: 3 }]);
    expect(t.score).toBe(565);
    expect(t.combo).toBe(0);
    expect(t.comboCount).toBe(0);
    expect(t.multiplier).toBe(1);
    expect(t.comboTimeLeft).toBe(0);
    expect(t.bestCombo).toBe(565);
  });

  it('starts a fresh combo once the previous one has banked', () => {
    const f = new Flight().roll().fly(3.5).backflip();
    expect(f.events.map((e) => e.multiplier)).toEqual([1, 1]);
    expect(f.tracker.score).toBe(250);
    expect(f.tracker.combo).toBe(150);
    expect(f.tracker.comboCount).toBe(1);
  });

  it('raises the multiplier by only 0.1 for the same trick back-to-back', () => {
    const f = new Flight().roll().fly(1).roll().fly(1).roll().fly(1).roll();
    expect(f.ids).toEqual(['roll', 'roll', 'roll', 'roll']);
    // exact tenths: the multiplier must not pick up floating-point dust
    expect(f.events.map((e) => e.multiplier)).toEqual([1, 1.1, 1.2, 1.3]);
    expect(f.events.map((e) => e.points)).toEqual([100, 110, 120, 130]);
  });

  it('caps the multiplier at x5', () => {
    const f = new Flight();
    for (let i = 0; i < 6; i++) f.roll().fly(0.5).backflip().fly(0.5);
    expect(f.events).toHaveLength(12);
    expect(f.events.map((e) => e.multiplier)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5, 5, 5]);
    expect(f.tracker.multiplier).toBe(5);
    expect(f.events[11].points).toBe(750);
  });

  it('holds the timer while a qualified sustained trick is being extended', () => {
    // a roll, then a six-second skim: the skim pays out long after the 3 s window
    const f = new Flight(0.8).roll().fly(6, { vx: 15 });
    expect(f.comboEnds).toEqual([]);
    expect(f.tracker.comboCount).toBe(1);
    f.fly(0.5, { vy: 8 });
    expect(f.ids).toEqual(['roll', 'skim']);
    expect(f.events[1].multiplier).toBe(1.5);
    expect(f.tracker.comboCount).toBe(2);
  });

  it('tracks the best banked combo', () => {
    const f = new Flight().roll().fly(3.5).roll().fly(1).backflip().fly(3.5).roll().fly(3.5);
    expect(f.comboEnds).toEqual([
      { total: 100, count: 1 },
      { total: 325, count: 2 },
      { total: 100, count: 1 },
    ]);
    expect(f.tracker.bestCombo).toBe(325);
    expect(f.tracker.score).toBe(525);
  });
});

describe('crash', () => {
  it('discards the running combo without banking it', () => {
    const f = new Flight().roll().fly(3.5).roll().fly(1).backflip();
    const t = f.tracker;
    expect(t.score).toBe(425);
    expect(t.combo).toBe(325);

    t.crash();
    expect(t.score).toBe(100);
    expect(t.combo).toBe(0);
    expect(t.comboCount).toBe(0);
    expect(t.multiplier).toBe(1);
    expect(t.comboTimeLeft).toBe(0);
    // lost, so it never becomes the best combo
    expect(t.bestCombo).toBe(100);
    expect(f.comboEnds).toEqual([
      { total: 100, count: 1 },
      { total: 0, count: 2 },
    ]);

    // nothing left over to bank later
    f.fly(4);
    expect(t.score).toBe(100);
    expect(f.comboEnds).toHaveLength(2);
  });

  it('says nothing when there was no combo to lose', () => {
    const f = new Flight().fly(1);
    f.tracker.crash();
    expect(f.comboEnds).toEqual([]);
  });

  it('forgets tricks that were in progress', () => {
    const f = new Flight(200).fly(2, { vy: -20 });
    f.tracker.crash();
    f.fly(1);
    expect(f.events).toEqual([]);

    const g = new Flight().fly(300 / 720, { roll: 720 });
    g.tracker.crash();
    g.fly(100 / 720, { roll: 720 }).fly(0.5);
    expect(g.events).toEqual([]);
  });
});

describe('ground handling', () => {
  it('recognises nothing while not airborne', () => {
    const f = new Flight();
    f.airborne = false;
    f.roll(2).backflip().yawSpin().fly(3, { vy: -20 });
    expect(f.events).toEqual([]);
    expect(f.tracker.score).toBe(0);
  });

  it('banks the running combo immediately on landing', () => {
    const f = new Flight().roll().fly(0.5).backflip().fly(0.5);
    expect(f.comboEnds).toEqual([]);
    f.airborne = false;
    f.fly(DT);
    expect(f.comboEnds).toEqual([{ total: 325, count: 2 }]);
    expect(f.tracker.score).toBe(325);
    expect(f.tracker.combo).toBe(0);
    expect(f.tracker.comboTimeLeft).toBe(0);
  });

  it('drops a sustained trick that ends on the ground rather than being flown out of', () => {
    const f = new Flight(0.8).fly(3, { vx: 15 });
    f.airborne = false;
    f.fly(0.1);
    f.airborne = true;
    f.fly(1, { vy: 5 });
    expect(f.events).toEqual([]);
  });

  it('does not carry a half-finished rotation across a touchdown', () => {
    const f = new Flight().fly(300 / 720, { roll: 720 });
    f.airborne = false;
    f.fly(DT);
    f.airborne = true;
    f.fly(100 / 720, { roll: 720 }).fly(0.5);
    expect(f.events).toEqual([]);
  });
});

describe('reset', () => {
  it('clears score, combo, best combo and in-flight state but keeps the callbacks', () => {
    const f = new Flight().roll().fly(3.5).backflip().fly(300 / 720, { roll: 720 });
    const t = f.tracker;
    expect(t.score).toBeGreaterThan(0);

    t.reset();
    expect(t.score).toBe(0);
    expect(t.combo).toBe(0);
    expect(t.comboCount).toBe(0);
    expect(t.multiplier).toBe(1);
    expect(t.comboTimeLeft).toBe(0);
    expect(t.bestCombo).toBe(0);

    // the 300 degrees rolled before the reset must not count towards a new roll
    f.events.length = 0;
    f.fly(100 / 720, { roll: 720 }).fly(0.5);
    expect(f.events).toEqual([]);

    f.roll();
    expect(f.ids).toEqual(['roll']);
    expect(t.score).toBe(100);
  });
});

describe('no false positives', () => {
  it('awards nothing for 30 s of hovering', () => {
    const rnd = noise(7);
    const f = new Flight(3).fly(30, () => ({
      roll: 15 * rnd(),
      pitch: 15 * rnd(),
      yaw: 15 * rnd(),
      vx: 0.3 * rnd(),
      vy: 0.3 * rnd(),
      vz: 0.3 * rnd(),
    }));
    expect(f.events).toEqual([]);
    expect(f.tracker.score).toBe(0);
    expect(f.tracker.comboCount).toBe(0);
    expect(f.comboEnds).toEqual([]);
  });

  it('awards nothing for 30 s of gentle turning', () => {
    const f = new Flight(20).fly(30, (t) => ({
      // steady turn with the bank and pitch breathing a few degrees either way
      yaw: 40 + 15 * Math.sin(0.7 * t),
      roll: 25 * Math.sin(2 * t),
      pitch: 15 * Math.sin(1.3 * t),
      vx: 8 * Math.cos(0.7 * t),
      vz: 8 * Math.sin(0.7 * t),
      vy: Math.sin(t),
    }));
    expect(f.events).toEqual([]);
    expect(f.tracker.score).toBe(0);
  });

  it('awards nothing for brisk cruising with sharp banked turns and a descent', () => {
    const f = new Flight(80);
    for (let i = 0; i < 6; i++) {
      // snap into a 60 degree bank, carve while pulling, snap back out, then nose over into a let-down
      f.fly(0.25, { roll: 240, vx: 14 })
        .fly(1.5, { yaw: 150, pitch: -40, vx: 10, vz: 10 })
        .fly(0.25, { roll: -240, vx: 14 })
        .fly(2, { pitch: 30, vx: 14, vy: -6 });
    }
    // the script must leave the quad the right way up, or the test proves nothing
    expect(Math.cos(f.rollAngle) * Math.cos(f.pitchAngle)).toBeCloseTo(1, 5);
    expect(f.events).toEqual([]);
    expect(f.tracker.score).toBe(0);
  });
});

describe('robustness', () => {
  it('recognises the same tricks at other time steps', () => {
    for (const dt of [1 / 60, 0.01, 0.0005]) {
      const f = new Flight(60, dt).fly(0.5).roll().fly(1).backflip().fly(1).yawSpin().fly(0.5);
      expect(f.ids, `dt=${dt}`).toEqual(['roll', 'backflip', 'yawspin']);
      expect(f.tracker.combo, `dt=${dt}`).toBe(565);
    }
  });

  it('reports every turn when one coarse step spans several', () => {
    const f = new Flight(60, 1).fly(1, { roll: 720 });
    expect(f.ids).toEqual(['roll', 'roll2']);
  });

  it('ignores samples with a zero or invalid dt', () => {
    const f = new Flight();
    for (const dt of [0, -0.002, Number.NaN, Number.POSITIVE_INFINITY]) {
      f.dt = dt;
      f.tracker.update({
        dt,
        rollRate: 100,
        pitchRate: 100,
        yawRate: 100,
        upY: 1,
        x: 0,
        y: 60,
        z: 0,
        vx: 0,
        vy: -30,
        vz: 0,
        agl: 60,
        airborne: true,
      });
    }
    expect(f.events).toEqual([]);
    expect(f.tracker.score).toBe(0);
    f.dt = DT;
    expect(f.roll().ids).toEqual(['roll']);
  });

  it('does not drift over a long session of repeated tricks', () => {
    const f = new Flight();
    for (let i = 0; i < 50; i++) f.roll().fly(4);
    expect(f.events).toHaveLength(50);
    expect(f.events.every((e) => e.id === 'roll' && e.points === 100)).toBe(true);
    expect(f.tracker.score).toBe(5000);
    expect(f.comboEnds).toHaveLength(50);
  });
});
