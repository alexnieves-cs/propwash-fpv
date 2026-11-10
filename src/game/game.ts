import { Group, Quaternion, Vector3 } from 'three';
import { AudioEngine } from '../core/audio';
import { Input, type Action } from '../core/input';
import { DEG, RAD, clamp, damp, makeRng, saturate, smoothstep } from '../core/math';
import { loadGhost, saveGhost, type CameraView, type FlightModeId, type SettingsStore } from '../core/settings';
import { MAPS, getMap } from '../maps';
import { DroneModel } from '../render/drone-model';
import { QUALITY, type Engine } from '../render/engine';
import type { TextureForge } from '../render/textures';
import { getDrone, hoverThrottle, type DroneConfig } from '../sim/drone-config';
import type { RcCommand, TrickKind } from '../sim/flight-controller';
import { PHYSICS_DT, PhysicsWorld } from '../sim/physics-world';
import { Quad, type Atmosphere } from '../sim/quad';
import { buildGates, crossesGate, setGateState, type GateRuntime } from '../world/gates';
import { Kit } from '../world/kit';
import type { BuiltWorld, MapDef, TrackDef } from '../world/types';
import { Race, type GhostFrame, type RaceResult } from './race';
import { TrickTracker, type TrickEvent } from './tricks';

export type GameState = 'boot' | 'loading' | 'menu' | 'flying' | 'paused' | 'results';

export interface GameEvents {
  state: GameState;
  progress: { fraction: number; label: string };
  message: { text: string; tone: 'info' | 'warn' | 'good'; ms: number };
  trick: TrickEvent;
  combo: { total: number; count: number };
  gate: { passed: number; total: number; split: number; delta: number | null };
  lap: { lap: number; laps: number; time: number };
  finish: RaceResult;
  countdown: number;
  crash: { strength: number };
  armed: boolean;
  flightMode: FlightModeId;
  view: CameraView;
  help: void;
}

type Handler<T> = (payload: T) => void;

/** Everything the HUD needs, refreshed once per frame. */
export interface Telemetry {
  speed: number;
  climb: number;
  altitude: number;
  agl: number;
  throttle: number;
  cellVolts: number;
  battery: number;
  current: number;
  mah: number;
  gForce: number;
  heading: number;
  pitch: number;
  roll: number;
  armed: boolean;
  crashed: boolean;
  landed: boolean;
  link: number;
  propwash: number;
  distance: number;
  fps: number;
  raceTime: number;
  raceState: string;
  lap: number;
  laps: number;
  gatesPassed: number;
  gatesTotal: number;
  delta: number | null;
  countdown: number;
  /** next gate on screen: x,y in -1..1, or pointing off-screen */
  gateX: number;
  gateY: number;
  gateVisible: boolean;
  gateDistance: number;
  hasGate: boolean;
  score: number;
  combo: number;
  comboCount: number;
  multiplier: number;
  comboLeft: number;
  best: number | null;
}

const _v = new Vector3();
const _f = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _pos = new Vector3();
const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);

const MODES: FlightModeId[] = ['cruise', 'angle', 'horizon', 'acro'];
const VIEWS: CameraView[] = ['fpv', 'chase', 'los'];

export class Game {
  state: GameState = 'boot';
  readonly input: Input;
  readonly audio = new AudioEngine();
  readonly tricks = new TrickTracker();
  readonly telemetry: Telemetry;
  map: MapDef = MAPS[0];
  world: BuiltWorld | null = null;
  track: TrackDef | null = null;
  cfg: DroneConfig;
  quad: Quad | null = null;
  race: Race | null = null;
  gates: GateRuntime[] = [];
  /** for automated testing: when set, replaces the pilot's sticks */
  rcOverride: RcCommand | null = null;
  /** for automated testing: leave the camera wherever it has been put */
  freeCamera = false;
  /** pause when the tab is hidden; tests switch this off */
  autoPause = true;

  private physics: PhysicsWorld | null = null;
  private root: Group | null = null;
  private kit: Kit | null = null;
  private model: DroneModel | null = null;
  private ghost: DroneModel | null = null;
  private handlers: { [K in keyof GameEvents]?: Handler<GameEvents[K]>[] } = {};
  private air: Atmosphere = { wind: new Vector3(), density: 1.225 };
  private gust = new Vector3();
  private rng = makeRng(4242);
  private acc = 0;
  private time = 0;
  private renderPos = new Vector3();
  private renderQuat = new Quaternion();
  private camPos = new Vector3();
  private camLook = new Vector3();
  private chaseYaw = 0;
  private pilot = new Vector3();
  private impactGlitch = 0;
  private lastDistance = 0;
  private lowBattTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private orbit = 0;
  private freeGate = -1;
  private heldRc: RcCommand = { roll: 0, pitch: 0, yaw: 0, throttle: 0, climb: -1 };
  private loadToken = 0;
  private failsafe = false;

  constructor(readonly engine: Engine, readonly forge: TextureForge, readonly settings: SettingsStore, canvas: HTMLCanvasElement) {
    this.input = new Input(canvas, settings);
    this.input.onAction = (a) => this.handleAction(a);
    this.cfg = getDrone(settings.data.drone);
    this.telemetry = {
      speed: 0, climb: 0, altitude: 0, agl: 0, throttle: 0, cellVolts: 4.2, battery: 1, current: 0, mah: 0, gForce: 1, heading: 0, pitch: 0, roll: 0,
      armed: false, crashed: false, landed: true, link: 1, propwash: 0, distance: 0, fps: 60, raceTime: 0, raceState: 'idle', lap: 0, laps: 0,
      gatesPassed: 0, gatesTotal: 0, delta: null, countdown: 0, gateX: 0, gateY: 0, gateVisible: false, gateDistance: 0, hasGate: false,
      score: 0, combo: 0, comboCount: 0, multiplier: 1, comboLeft: 0, best: null,
    };
    this.tricks.onTrick = (e) => {
      this.emit('trick', e);
      this.audio.trick(e.points);
    };
    this.tricks.onComboEnd = (total, count) => {
      this.emit('combo', { total, count });
      const key = this.recordKey();
      if (total > (settings.data.bestCombo[key] ?? 0)) settings.update((s) => (s.bestCombo[key] = Math.round(total)));
    };
    settings.subscribe(() => this.applySettings());
    engine.onStruggle = () => {
      if (this.state === 'flying' && !document.hidden) this.say('Running slow — try a lower Graphics quality in Settings › Display', 'warn', 6000);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'flying' && this.autoPause) this.pause();
    });
  }

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): void {
    (this.handlers[type] ??= [] as never[]).push(fn as never);
  }

  private emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    for (const h of this.handlers[type] ?? []) (h as Handler<GameEvents[K]>)(payload);
  }

  private setState(s: GameState): void {
    this.state = s;
    this.input.enabled = s === 'flying';
    if (s !== 'flying') this.input.releaseLock();
    this.audio.setPaused(s !== 'flying');
    this.emit('state', s);
  }

  say(text: string, tone: 'info' | 'warn' | 'good' = 'info', ms = 2200): void {
    this.emit('message', { text, tone, ms });
  }

  recordKey(): string {
    return `${this.map.id}:${this.track?.id ?? 'free'}:${this.cfg.id}`;
  }

  // ------------------------------------------------------------------------------------------------
  // world loading
  // ------------------------------------------------------------------------------------------------

  /** Build (or rebuild) the selected map, track and airframe. */
  async load(): Promise<void> {
    const token = ++this.loadToken;
    const s = this.settings.data;
    this.setState('loading');
    const progress = async (fraction: number, label: string): Promise<void> => {
      this.emit('progress', { fraction, label });
      // let the browser paint the loading bar
      await new Promise<void>((r) => setTimeout(r, 16));
    };
    await progress(0.02, 'Clearing the field');
    this.unload();

    this.map = getMap(s.map);
    this.cfg = getDrone(s.drone);
    this.engine.setQuality(QUALITY[s.quality]);
    this.forge.anisotropy = this.engine.maxAnisotropy;
    this.engine.setEnvironment(this.map.sky, this.map.look);

    const physics = new PhysicsWorld();
    const root = new Group();
    this.engine.scene.add(root);
    this.physics = physics;
    this.root = root;
    const ctx = { engine: this.engine, forge: this.forge, physics, root };
    const world = await this.map.build(ctx, (f, l) => progress(0.05 + f * 0.8, l));
    if (token !== this.loadToken) return;
    this.world = world;
    this.engine.post.waterLevel = world.waterLevel;

    // course
    await progress(0.88, 'Setting gates');
    this.track = world.tracks.find((t) => t.id === s.track) ?? world.tracks[0] ?? null;
    const kit = new Kit(ctx);
    this.kit = kit;
    this.gates = [];
    if (this.track) this.gates = buildGates(ctx, kit, this.track.gates, world.heightAt).gates;
    this.buildPad(kit, world);
    kit.build();
    // one step so the new colliders answer the ray casts that place the quad
    physics.step();

    // airframe
    await progress(0.94, 'Plugging in a fresh pack');
    this.quad = new Quad(physics, this.cfg);
    this.model = new DroneModel(this.cfg, this.forge);
    root.add(this.model.group);
    this.ghost = new DroneModel(this.cfg, this.forge, true);
    this.ghost.group.visible = false;
    root.add(this.ghost.group);

    this.makeRace();
    this.applySettings();
    this.respawn(true);
    // settle the physics and let shaders compile behind the loading screen
    for (let i = 0; i < 30; i++) this.step();
    this.updateCamera(0.016, true);
    this.engine.render(0.016);
    await progress(1, 'Ready');
    if (token !== this.loadToken) return;
    this.setState('menu');
  }

  private makeRace(): void {
    const s = this.settings.data;
    this.race = null;
    if (s.mode !== 'race' || !this.track || !this.gates.length) return;
    const key = this.recordKey();
    const rec = s.records[key];
    const flat = loadGhost(key);
    const ghost: GhostFrame[] = [];
    if (flat) for (let i = 0; i + 7 < flat.length; i += 8) ghost.push({ t: flat[i], x: flat[i + 1], y: flat[i + 2], z: flat[i + 3], qx: flat[i + 4], qy: flat[i + 5], qz: flat[i + 6], qw: flat[i + 7] });
    this.race = new Race(this.track, this.gates, rec ? { total: rec.total, splits: rec.splits, ghost } : null);
    this.wireRace(this.race);
  }

  /** Switch between freestyle and race without rebuilding the world. */
  refreshSession(): void {
    if (!this.world || !this.quad) return;
    this.makeRace();
    this.tricks.reset();
    this.respawn(true);
  }

  /** Swap the airframe in place. */
  swapDrone(): void {
    if (!this.world || !this.physics || !this.root || !this.quad) return;
    this.physics.world.removeRigidBody(this.quad.body);
    this.model?.group.removeFromParent();
    this.ghost?.group.removeFromParent();
    this.model?.dispose();
    this.ghost?.dispose();
    this.cfg = getDrone(this.settings.data.drone);
    this.quad = new Quad(this.physics, this.cfg);
    this.model = new DroneModel(this.cfg, this.forge);
    this.ghost = new DroneModel(this.cfg, this.forge, true);
    this.ghost.group.visible = false;
    this.root.add(this.model.group, this.ghost.group);
    this.applySettings();
    this.refreshSession();
  }

  private unload(): void {
    this.world?.dispose();
    this.kit?.dispose();
    this.model?.dispose();
    this.ghost?.dispose();
    if (this.root) this.engine.scene.remove(this.root);
    this.physics?.dispose();
    this.world = null;
    this.kit = null;
    this.model = null;
    this.ghost = null;
    this.root = null;
    this.physics = null;
    this.quad = null;
    this.race = null;
    this.gates = [];
  }

  private startPoint(): { x: number; z: number; heading: number } {
    if (this.settings.data.mode === 'race' && this.track) return this.track.start;
    const sp = this.world!.spawn;
    return { x: sp.pos.x, z: sp.pos.z, heading: sp.heading };
  }

  private buildPad(kit: Kit, world: BuiltWorld): void {
    const mat = kit.mat('pad', 'fabric', { color: 0x34373b, tile: 0.35, roughness: 0.92 });
    const edge = kit.mat('pad-edge', null, { color: 0x111214, emissive: 0xff5a1f, emissiveIntensity: 0.9 });
    const pts = [{ x: world.spawn.pos.x, z: world.spawn.pos.z, heading: world.spawn.heading }];
    if (this.track) pts.push(this.track.start);
    for (const p of pts) {
      const y = world.heightAt(p.x, p.z);
      kit.box(mat, p.x, y + 0.02, p.z, 1.4, 0.06, 1.4, { yaw: p.heading, friction: 1 });
      kit.box(edge, p.x, y + 0.02, p.z, 1.5, 0.03, 1.5, { yaw: p.heading, collide: false });
    }
  }

  private wireRace(race: Race): void {
    race.onCountdown = (step) => {
      this.audio.countdown(step);
      this.emit('countdown', step);
    };
    race.onGate = (index, lap, split, delta) => {
      const last = index === this.gates.length - 1;
      this.audio.gate(last);
      this.emit('gate', { passed: lap * this.gates.length + index + 1, total: race.totalGates, split, delta });
    };
    race.onLap = (lap, time) => this.emit('lap', { lap, laps: race.track.laps, time });
    race.onFinish = (r) => {
      const key = this.recordKey();
      if (r.newRecord && race.best) {
        const best = race.best;
        this.settings.update((s) => (s.records[key] = { total: r.total, bestLap: r.bestLap, splits: best.splits }));
        const flat: number[] = [];
        for (const f of best.ghost) flat.push(+f.t.toFixed(3), +f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2), +f.qx.toFixed(4), +f.qy.toFixed(4), +f.qz.toFixed(4), +f.qw.toFixed(4));
        saveGhost(key, flat);
      }
      this.emit('finish', r);
      setTimeout(() => {
        if (this.state === 'flying' && this.race === race) this.setState('results');
      }, 1600);
    };
  }

  applySettings(): void {
    const s = this.settings.data;
    this.audio.setVolumes(s.audio);
    this.engine.dynamicResolution = s.dynamicResolution;
    const post = this.engine.post;
    post.motionBlur = s.camera.motionBlur * 0.85;
    post.chroma = s.camera.lensEffects ? 0.012 : 0;
    post.vignette = s.camera.lensEffects ? 0.28 : 0;
    post.grain = s.camera.lensEffects ? 0.028 : 0;
    const q = this.quad;
    if (!q) return;
    q.unlimitedBattery = !s.sim.battery;
    const fc = q.fc;
    fc.mode = s.flightMode === 'cruise' || s.flightMode === 'angle' ? 'angle' : s.flightMode;
    fc.altHold = s.flightMode === 'cruise';
    for (const axis of ['roll', 'pitch', 'yaw'] as const) {
      fc.rates[axis].center = this.cfg.rates[axis].center * s.controls.rateScale;
      fc.rates[axis].max = this.cfg.rates[axis].max * s.controls.rateScale;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // flow
  // ------------------------------------------------------------------------------------------------

  /** Leave the menu and hand the sticks to the pilot. */
  fly(): void {
    if (!this.world || !this.quad) return;
    void this.audio.unlock();
    this.respawn(true);
    this.race?.reset();
    this.tricks.reset();
    this.setState('flying');
    this.engine.post.cut();
    if (this.settings.data.controls.mouseStick) this.input.requestLock();
  }

  pause(): void {
    if (this.state === 'flying') this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.setState('flying');
    if (this.settings.data.controls.mouseStick) this.input.requestLock();
  }

  restart(): void {
    if (!this.quad) return;
    this.race?.reset();
    this.tricks.reset();
    this.respawn(true);
    this.setState('flying');
    this.engine.post.cut();
  }

  toMenu(): void {
    if (!this.world) return;
    this.respawn(true);
    this.race?.reset();
    this.setState('menu');
  }

  /** Put the quad back on the ground: at the start, or at the last gate cleared in a race. */
  respawn(toStart: boolean): void {
    const q = this.quad;
    const w = this.world;
    if (!q || !w) return;
    let p = this.startPoint();
    const last = this.race?.state === 'running' ? this.race.lastGate : null;
    if (!toStart && last) p = { x: last.respawn.x, z: last.respawn.z, heading: last.heading };
    const ground = this.physics!.raycast(p.x + 0.01, w.heightAt(p.x, p.z) + 30, p.z + 0.01, 0, -1, 0, 80);
    const y = (ground >= 0 ? w.heightAt(p.x, p.z) + 30 - ground : w.heightAt(p.x, p.z)) + q.restHeight + 0.03;
    _q.setFromAxisAngle(UP, -p.heading * DEG);
    q.reset(_v.set(p.x, y, p.z), _q, true);
    this.pilot.set(p.x - Math.sin(p.heading * DEG) * 3.5, y + 1.65, p.z + Math.cos(p.heading * DEG) * 3.5);
    this.input.clear();
    this.acc = 0;
    this.failsafe = false;
    this.impactGlitch = 0;
    this.chaseYaw = -p.heading * DEG;
    this.renderPos.copy(q.pos);
    this.renderQuat.copy(q.quat);
    this.engine.post.cut();
    this.engine.shadows.invalidate();
    this.emit('armed', false);
  }

  private handleAction(a: Action): void {
    const q = this.quad;
    if (!q) return;
    const s = this.settings;
    switch (a) {
      case 'pause':
        this.pause();
        break;
      case 'arm':
        this.toggleArm();
        break;
      case 'reset':
        this.tricks.crash();
        this.respawn(false);
        break;
      case 'restart':
        this.restart();
        break;
      case 'camera': {
        const next = VIEWS[(VIEWS.indexOf(s.data.view) + 1) % VIEWS.length];
        s.update((d) => (d.view = next));
        this.engine.post.cut();
        this.emit('view', next);
        break;
      }
      case 'mode1':
      case 'mode2':
      case 'mode3':
      case 'mode4': {
        const mode = MODES[Number(a.slice(4)) - 1];
        s.update((d) => (d.flightMode = mode));
        this.emit('flightMode', mode);
        break;
      }
      case 'rollLeft':
      case 'rollRight':
      case 'flipFront':
      case 'flipBack':
        if (!q.fc.armed) this.say('Arm first — press Space', 'warn');
        else if (!q.fc.startTrick(a as TrickKind, q.agl)) this.say(q.agl < 1.2 ? 'Too low for that — climb a little' : 'Finish the last one first', 'warn', 1400);
        break;
      case 'turtle':
        if (q.fc.armed) this.say('Disarm before flipping over', 'warn');
        else if (q.turtle()) {
          q.crashed = false;
          this.say('Turtle mode', 'info', 1200);
        }
        break;
      case 'hud':
        s.update((d) => (d.hud.minimal = !d.hud.minimal));
        break;
      case 'tiltUp':
      case 'tiltDown': {
        const cur = s.data.camera.tilt ?? this.cfg.camTilt;
        const next = clamp(cur + (a === 'tiltUp' ? 2 : -2), 0, 60);
        s.update((d) => (d.camera.tilt = next));
        this.say(`Camera tilt ${next}°`, 'info', 900);
        break;
      }
      case 'fovUp':
      case 'fovDown': {
        const next = clamp(s.data.camera.fov + (a === 'fovUp' ? 2 : -2), 70, 130);
        s.update((d) => (d.camera.fov = next));
        this.say(`Field of view ${next}°`, 'info', 900);
        break;
      }
      case 'mouse': {
        const on = !s.data.controls.mouseStick;
        s.update((d) => (d.controls.mouseStick = on));
        if (on) this.input.requestLock();
        else this.input.releaseLock();
        this.say(on ? 'Trackpad stick on — move to pitch and roll, click to centre' : 'Trackpad stick off', 'info', 2600);
        break;
      }
      case 'help':
        this.emit('help', undefined);
        break;
    }
  }

  private toggleArm(): void {
    const q = this.quad!;
    if (q.fc.armed) {
      q.fc.armed = false;
      this.audio.arm(false);
      this.emit('armed', false);
      return;
    }
    if (this.failsafe) {
      this.say('Link lost — press R to reset', 'warn');
      return;
    }
    if (q.up.y < 0.45) {
      this.say('Upside down — press T to flip over', 'warn');
      return;
    }
    if (q.soc <= 0.02 && !q.unlimitedBattery) {
      this.say('Pack is empty — press R for a fresh one', 'warn');
      return;
    }
    q.crashed = false;
    q.fc.reset();
    q.fc.armed = true;
    this.input.clear();
    this.audio.arm(true);
    this.emit('armed', true);
    if (this.race && this.race.state === 'idle') this.race.begin();
  }

  // ------------------------------------------------------------------------------------------------
  // simulation
  // ------------------------------------------------------------------------------------------------

  private step(): void {
    const q = this.quad!;
    const w = this.world!;
    const dt = PHYSICS_DT;

    // wind: a steady breeze plus slowly wandering gusts
    if (this.settings.data.sim.wind) {
      const k = Math.exp(-dt / 2.5);
      const drive = Math.sqrt(1 - k * k) * w.wind.gust;
      this.gust.x = this.gust.x * k + (this.rng() * 2 - 1) * 1.7 * drive;
      this.gust.z = this.gust.z * k + (this.rng() * 2 - 1) * 1.7 * drive;
      this.gust.y = this.gust.y * k + (this.rng() * 2 - 1) * 0.6 * drive;
      // the breeze dies away close to the ground
      const shear = saturate(q.agl / 12) * 0.75 + 0.25;
      this.air.wind.set(w.wind.x + this.gust.x, this.gust.y, w.wind.z + this.gust.z).multiplyScalar(shear);
    } else this.air.wind.set(0, 0, 0);

    let rc = this.rcOverride ?? this.input.rc;
    if (this.race?.holding || this.state !== 'flying') rc = this.heldRc;

    q.preStep(dt, rc, this.air);
    this.physics!.step();
    q.postStep(dt);

    // ---- crashes ---------------------------------------------------------------------------------
    for (const hit of q.impacts) {
      this.audio.impact(hit.strength, hit.hard);
      this.impactGlitch = Math.max(this.impactGlitch, saturate(hit.strength / 9));
      this.emit('crash', { strength: hit.strength });
    }
    q.impacts.length = 0;
    if (q.crashed && q.fc.armed) {
      if (this.settings.data.sim.crashDisarm) {
        q.fc.armed = false;
        this.tricks.crash();
        this.emit('armed', false);
        this.say('Crashed — R to reset · T to flip over', 'warn', 4000);
      } else q.crashed = false;
    }
    if (q.pos.y < w.waterLevel - 0.02 && q.fc.armed) {
      q.fc.armed = false;
      q.crashed = true;
      this.tricks.crash();
      this.audio.splash();
      this.emit('armed', false);
      this.say('In the drink — press R for a dry one', 'warn', 4000);
    }

    // ---- radio range -----------------------------------------------------------------------------
    const range = Math.hypot(q.pos.x, q.pos.z);
    if ((range > w.boundsRadius + 55 || q.pos.y - w.heightAt(q.pos.x, q.pos.z) > w.ceiling + 80) && q.fc.armed) {
      q.fc.armed = false;
      this.failsafe = true;
      this.tricks.crash();
      this.emit('armed', false);
      this.say('FAILSAFE — out of range. Press R to reset', 'warn', 5000);
    }

    // ---- racing and freestyle scoring -----------------------------------------------------------
    if (this.state === 'flying') {
      if (this.race) this.race.update(dt, q.prevPos, q.pos, q.quat);
      else {
        for (let i = 0; i < this.gates.length; i++) {
          if (i !== this.freeGate && crossesGate(this.gates[i], q.prevPos, q.pos)) {
            this.freeGate = i;
            this.tricks.gap('Gate');
            this.audio.gate(false);
          }
        }
        this.tricks.update({
          dt,
          rollRate: -q.gyro.z,
          pitchRate: -q.gyro.x,
          yawRate: -q.gyro.y,
          upY: q.up.y,
          x: q.pos.x,
          y: q.pos.y,
          z: q.pos.z,
          vx: q.vel.x,
          vy: q.vel.y,
          vz: q.vel.z,
          agl: q.agl,
          airborne: q.fc.armed && !q.landed,
        });
      }
    }
  }

  /** Advance one rendered frame. */
  frame(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.time += dt;
    this.fpsAcc += dtRaw;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.telemetry.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    const q = this.quad;
    const w = this.world;
    if (!q || !w || this.state === 'loading' || this.state === 'boot') return;

    if (this.state === 'flying') {
      this.input.update(dt, { hover: hoverThrottle(this.cfg), armed: q.fc.armed, landed: q.landed });
      this.acc += dt;
      let guard = 0;
      while (this.acc >= PHYSICS_DT && guard++ < 60) {
        this.step();
        this.acc -= PHYSICS_DT;
      }
      if (guard >= 60) this.acc = 0;
    } else if (this.state === 'menu' || this.state === 'results') {
      // keep the world alive behind the menu, quad sitting on its pad
      this.acc += dt;
      let guard = 0;
      while (this.acc >= PHYSICS_DT && guard++ < 20) {
        this.step();
        this.acc -= PHYSICS_DT;
      }
    }

    const alpha = this.state === 'paused' ? 1 : clamp(this.acc / PHYSICS_DT, 0, 1);
    this.renderPos.lerpVectors(q.prevPos, q.pos, alpha);
    this.renderQuat.slerpQuaternions(q.prevQuat, q.quat, alpha);

    const m = this.model!;
    m.group.position.copy(this.renderPos);
    m.group.quaternion.copy(this.renderQuat);
    m.update(q.propAngle, q.omega, this.cfg.maxOmega);
    m.setArmed(q.fc.armed);

    // ghost of the best run
    const g = this.ghost!;
    g.group.visible = false;
    if (this.race && this.race.state === 'running' && this.settings.data.sim.ghost) {
      if (this.race.sampleGhost(this.race.time, _pos, _q2)) {
        g.group.visible = _pos.distanceTo(this.renderPos) > 1.5;
        g.group.position.copy(_pos);
        g.group.quaternion.copy(_q2);
        g.update(q.propAngle, q.omega, this.cfg.maxOmega);
      }
    }
    if (this.race) this.race.paint(this.time);
    else for (const gate of this.gates) setGateState(gate, 'idle', this.time);

    this.updateCamera(dt, false);
    w.update(dt, this.time, this.engine.camera);
    this.updatePost(dt);
    this.updateAudio(dt);
    this.updateTelemetry();
    this.engine.render(dt, w.wind.x, w.wind.z);
  }

  private updateCamera(dt: number, snap: boolean): void {
    if (this.freeCamera) {
      this.model!.group.visible = true;
      return;
    }
    const q = this.quad!;
    const cam = this.engine.camera;
    const s = this.settings.data;
    const view: CameraView | 'orbit' = this.state === 'menu' || this.state === 'loading' ? 'orbit' : s.view;
    const pos = this.renderPos;
    this.model!.group.visible = view !== 'fpv';
    let fov = 60;

    if (view === 'fpv') {
      const tilt = (s.camera.tilt ?? this.cfg.camTilt) * DEG;
      _v.set(0, this.cfg.collider.body[1] * 0.5, -this.cfg.collider.body[2] * 0.9).applyQuaternion(this.renderQuat);
      cam.position.copy(pos).add(_v);
      cam.quaternion.copy(this.renderQuat).multiply(_q.setFromAxisAngle(X, tilt));
      // prop wash and hard pulls shake the picture a little
      const shake = q.propwash * 0.006 + Math.max(0, q.gForce - 6) * 0.0006;
      if (shake > 0 && q.fc.armed) {
        _q.set((this.rng() - 0.5) * shake, (this.rng() - 0.5) * shake, (this.rng() - 0.5) * shake, 1).normalize();
        cam.quaternion.multiply(_q);
      }
      fov = s.camera.fov;
    } else if (view === 'chase') {
      _f.set(0, 0, -1).applyQuaternion(this.renderQuat);
      const hyp = Math.hypot(_f.x, _f.z);
      if (hyp > 0.2) {
        const target = Math.atan2(-_f.x, -_f.z);
        let d = target - this.chaseYaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.chaseYaw += d * (1 - Math.exp(-dt * 5));
      }
      const back = this.cfg.visual.frame === 'whoop' ? 0.75 : 2.6;
      const upOff = this.cfg.visual.frame === 'whoop' ? 0.22 : 0.85;
      _v.set(pos.x + Math.sin(this.chaseYaw) * back, pos.y + upOff, pos.z + Math.cos(this.chaseYaw) * back);
      const floor = this.world!.heightAt(_v.x, _v.z) + 0.25;
      if (_v.y < floor) _v.y = floor;
      if (snap) this.camPos.copy(_v);
      else this.camPos.lerp(_v, 1 - Math.exp(-dt * 12));
      cam.position.copy(this.camPos);
      this.camLook.copy(pos).addScaledVector(q.vel, 0.06);
      cam.lookAt(this.camLook);
      fov = 72;
    } else if (view === 'los') {
      cam.position.copy(this.pilot);
      const floor = this.world!.heightAt(this.pilot.x, this.pilot.z) + 1.65;
      cam.position.y = floor;
      if (snap) this.camLook.copy(pos);
      else this.camLook.lerp(pos, 1 - Math.exp(-dt * 14));
      cam.lookAt(this.camLook);
      const d = cam.position.distanceTo(pos);
      fov = clamp(2 * Math.atan(4.2 / Math.max(d, 1)) * RAD, 9, 62);
    } else {
      // menu: a slow orbit around the quad on its pad
      this.orbit += dt * 0.07;
      const whoop = this.cfg.visual.frame === 'whoop';
      const r = whoop ? 0.42 : 1.5;
      const h = whoop ? 0.11 : 0.42;
      // keep the quad right of centre: the menu owns the left third of the frame
      const side = whoop ? 0.1 : 0.36;
      const ox = Math.cos(this.orbit) * side;
      const oz = -Math.sin(this.orbit) * side;
      cam.position.set(pos.x + Math.sin(this.orbit) * r, pos.y + h + Math.sin(this.orbit * 0.7) * h * 0.2, pos.z + Math.cos(this.orbit) * r);
      const floor = this.world!.heightAt(cam.position.x, cam.position.z) + 0.12;
      if (cam.position.y < floor) cam.position.y = floor;
      cam.lookAt(pos.x - ox, pos.y + (whoop ? 0.03 : 0.16), pos.z - oz);
      fov = 40;
    }
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = snap || view === 'fpv' || view === 'orbit' ? fov : damp(cam.fov, fov, 6, dt);
      cam.updateProjectionMatrix();
    }
    cam.near = view === 'orbit' ? 0.03 : 0.1;
    cam.updateMatrixWorld();
  }

  private updatePost(dt: number): void {
    const q = this.quad!;
    const w = this.world!;
    const s = this.settings.data;
    const post = this.engine.post;
    const fpv = this.state !== 'menu' && s.view === 'fpv';
    post.distortion = fpv ? s.camera.distortion * 0.42 : 0.04;
    this.impactGlitch *= Math.exp(-dt * 5);
    const range = Math.hypot(q.pos.x, q.pos.z);
    const rangeLoss = smoothstep(w.boundsRadius * 0.9, w.boundsRadius + 50, range);
    const link = 1 - rangeLoss;
    this.telemetry.link = link;
    post.glitch = fpv ? clamp(Math.max(this.impactGlitch * 0.9, rangeLoss * 0.85, this.failsafe ? 1 : 0), 0, 1) : 0;
  }

  private updateAudio(dt: number): void {
    const q = this.quad!;
    const cam = this.engine.camera;
    const fpv = this.settings.data.view === 'fpv' && this.state !== 'menu';
    const d = fpv ? 0 : cam.position.distanceTo(this.renderPos);
    const radial = dt > 0 ? (d - this.lastDistance) / dt : 0;
    this.lastDistance = d;
    this.audio.update(
      {
        armed: q.fc.armed,
        omega: q.omega,
        maxOmega: this.cfg.maxOmega,
        blades: this.cfg.blades,
        ducted: this.cfg.ducted,
        mass: this.cfg.mass,
        airspeed: q.airspeed,
        propwash: q.propwash,
        distance: d,
        radialVelocity: clamp(radial, -80, 80),
      },
      dt,
    );
    // battery alarm
    if (q.fc.armed && !q.unlimitedBattery && q.cellVolts < 3.5) {
      this.lowBattTimer -= dt;
      if (this.lowBattTimer <= 0) {
        this.lowBattTimer = q.cellVolts < 3.3 ? 0.7 : 2.2;
        this.audio.lowBattery();
      }
    }
  }

  private updateTelemetry(): void {
    const q = this.quad!;
    const t = this.telemetry;
    const cam = this.engine.camera;
    t.speed = q.speed;
    t.climb = q.vel.y;
    t.altitude = q.pos.y;
    t.agl = q.agl;
    t.throttle = q.fc.armed ? saturate((q.fc.collective - this.cfg.idle) / (1 - this.cfg.idle)) : 0;
    t.cellVolts = q.cellVolts;
    t.battery = q.unlimitedBattery ? 1 : saturate(q.soc);
    t.current = q.current;
    t.mah = q.usedMah;
    t.gForce = q.gForce;
    _f.set(0, 0, -1).applyQuaternion(this.renderQuat);
    t.heading = (Math.atan2(_f.x, -_f.z) * RAD + 360) % 360;
    t.pitch = Math.asin(clamp(_f.y, -1, 1)) * RAD;
    _v.set(1, 0, 0).applyQuaternion(this.renderQuat);
    t.roll = Math.atan2(-_v.y, q.up.y) * RAD;
    t.armed = q.fc.armed;
    t.crashed = q.crashed;
    t.landed = q.landed;
    t.propwash = q.propwash;
    t.distance = Math.hypot(q.pos.x - this.pilot.x, q.pos.z - this.pilot.z);

    const r = this.race;
    t.raceState = r ? r.state : 'none';
    t.raceTime = r ? r.time : 0;
    t.lap = r ? Math.min(r.lap + 1, r.track.laps) : 0;
    t.laps = r ? r.track.laps : 0;
    t.gatesPassed = r ? r.passed : 0;
    t.gatesTotal = r ? r.totalGates : 0;
    t.delta = r ? r.delta : null;
    t.countdown = r && r.state === 'countdown' ? r.countdown : 0;
    t.best = r?.best ? r.best.total : null;
    const gate = r?.nextGate ?? null;
    t.hasGate = !!gate && r!.state !== 'idle';
    if (gate) {
      _v.copy(gate.center).project(cam);
      _f.copy(gate.center).sub(cam.position);
      t.gateDistance = _f.length();
      cam.getWorldDirection(_pos);
      const behind = _f.dot(_pos) < 0;
      t.gateVisible = !behind && Math.abs(_v.x) < 0.92 && Math.abs(_v.y) < 0.9;
      // behind the camera the projection flips, so mirror it back to get a usable direction
      t.gateX = behind ? -_v.x : _v.x;
      t.gateY = behind ? -_v.y : _v.y;
      if (behind && Math.hypot(t.gateX, t.gateY) < 0.2) t.gateY = -1;
    }
    t.score = this.tricks.score;
    t.combo = this.tricks.combo;
    t.comboCount = this.tricks.comboCount;
    t.multiplier = this.tricks.multiplier;
    t.comboLeft = this.tricks.comboTimeLeft;
  }

  /** Test hook: run the simulation for a while without a display loop. */
  debugAdvance(seconds: number, render = true): void {
    const n = Math.round(seconds / PHYSICS_DT);
    const prev = this.state;
    this.state = 'flying';
    for (let i = 0; i < n; i++) this.step();
    this.state = prev;
    if (render) this.frame(0);
  }
}
