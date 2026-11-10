import { Quaternion, Vector3 } from 'three';
import { crossesGate, setGateState, type GateRuntime } from '../world/gates';
import type { TrackDef } from '../world/types';

export type RaceState = 'idle' | 'countdown' | 'running' | 'finished';

export interface GhostFrame {
  t: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface RaceResult {
  total: number;
  laps: number[];
  bestLap: number;
  /** 0 gold, 1 silver, 2 bronze, 3 none */
  medal: number;
  newRecord: boolean;
}

const GHOST_DT = 1 / 30;

/** Lap timing, gate sequencing and ghost recording for one track. */
export class Race {
  state: RaceState = 'idle';
  /** counts down from 3 before the start, then up */
  countdown = 0;
  time = 0;
  lap = 0;
  next = 0;
  lapStart = 0;
  lastSplit = 0;
  /** signed difference to the best run at the last gate, seconds (negative = ahead) */
  delta: number | null = null;
  readonly lapTimes: number[] = [];
  result: RaceResult | null = null;

  onCountdown: ((step: 3 | 2 | 1 | 0) => void) | null = null;
  onGate: ((index: number, lap: number, split: number, delta: number | null) => void) | null = null;
  onLap: ((lap: number, time: number) => void) | null = null;
  onFinish: ((r: RaceResult) => void) | null = null;

  private lastBeep = 4;
  private recording: GhostFrame[] = [];
  private recordTimer = 0;
  private splits: number[] = [];

  constructor(
    readonly track: TrackDef,
    readonly gates: GateRuntime[],
    /** fastest previous run: total time, per-gate cumulative splits and its ghost */
    public best: { total: number; splits: number[]; ghost: GhostFrame[] } | null,
  ) {}

  get totalGates(): number {
    return this.gates.length * this.track.laps;
  }

  get passed(): number {
    return this.lap * this.gates.length + this.next;
  }

  get nextGate(): GateRuntime | null {
    return this.state === 'finished' ? null : this.gates[this.next];
  }

  /** Last gate cleared, for respawning. */
  get lastGate(): GateRuntime | null {
    if (this.passed === 0) return null;
    return this.gates[(this.next - 1 + this.gates.length) % this.gates.length];
  }

  reset(): void {
    this.state = 'idle';
    this.time = 0;
    this.lap = 0;
    this.next = 0;
    this.lapStart = 0;
    this.lastSplit = 0;
    this.delta = null;
    this.lapTimes.length = 0;
    this.result = null;
    this.recording = [];
    this.splits = [];
    this.recordTimer = 0;
    this.lastBeep = 4;
  }

  begin(): void {
    this.reset();
    this.state = 'countdown';
    this.countdown = 3;
  }

  /** True while the pilot is held on the pad waiting for the tone. */
  get holding(): boolean {
    return this.state === 'countdown';
  }

  update(dt: number, p0: Vector3, p1: Vector3, quat: Quaternion): void {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const step = Math.ceil(this.countdown);
      if (step < this.lastBeep && step >= 1) {
        this.lastBeep = step;
        this.onCountdown?.(step as 3 | 2 | 1);
      }
      if (this.countdown <= 0) {
        this.state = 'running';
        this.time = 0;
        this.onCountdown?.(0);
      }
      return;
    }
    if (this.state !== 'running') return;
    this.time += dt;

    this.recordTimer -= dt;
    if (this.recordTimer <= 0) {
      this.recordTimer += GHOST_DT;
      this.recording.push({ t: this.time, x: p1.x, y: p1.y, z: p1.z, qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w });
    }

    const gate = this.gates[this.next];
    if (!crossesGate(gate, p0, p1)) return;
    const idx = this.passed;
    this.splits.push(this.time);
    this.delta = this.best && this.best.splits[idx] !== undefined ? this.time - this.best.splits[idx] : null;
    this.lastSplit = this.time;
    this.onGate?.(this.next, this.lap, this.time, this.delta);
    this.next++;
    if (this.next >= this.gates.length) {
      this.next = 0;
      const lapTime = this.time - this.lapStart;
      this.lapTimes.push(lapTime);
      this.lapStart = this.time;
      this.lap++;
      this.onLap?.(this.lap, lapTime);
      if (this.lap >= this.track.laps) this.finish();
    }
  }

  private finish(): void {
    this.state = 'finished';
    const total = this.time;
    const newRecord = !this.best || total < this.best.total;
    const m = this.track.medals;
    const medal = total <= m[0] ? 0 : total <= m[1] ? 1 : total <= m[2] ? 2 : 3;
    if (newRecord) this.best = { total, splits: this.splits.slice(), ghost: this.recording.slice() };
    this.result = { total, laps: this.lapTimes.slice(), bestLap: Math.min(...this.lapTimes), medal, newRecord };
    this.onFinish?.(this.result);
  }

  /** Light the gates: the next one pulses, the one after it is a steady cue. */
  paint(time: number): void {
    const n = this.gates.length;
    for (let i = 0; i < n; i++) {
      const g = this.gates[i];
      let s: 'idle' | 'next' | 'after' | 'done' = 'idle';
      if (this.state === 'finished') s = 'done';
      else if (i === this.next) s = 'next';
      else if (i === (this.next + 1) % n && n > 1) s = 'after';
      setGateState(g, s, time);
    }
  }

  /** Where the best run's ghost was at race time `t`; false if there is nothing to show. */
  sampleGhost(t: number, pos: Vector3, quat: Quaternion): boolean {
    const g = this.best?.ghost;
    if (!g || g.length < 2 || t > g[g.length - 1].t) return false;
    const f = Math.max(0, (t - g[0].t) / GHOST_DT);
    const i = Math.min(Math.floor(f), g.length - 2);
    const a = g[i];
    const b = g[i + 1];
    const k = Math.min(1, f - i);
    pos.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
    _qa.set(a.qx, a.qy, a.qz, a.qw);
    _qb.set(b.qx, b.qy, b.qz, b.qw);
    quat.slerpQuaternions(_qa, _qb, k);
    return true;
  }
}

const _qa = new Quaternion();
const _qb = new Quaternion();
