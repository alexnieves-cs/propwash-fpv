import type { RcCommand } from '../sim/flight-controller';
import { approach, clamp } from './math';
import type { SettingsStore } from './settings';

export type Action =
  | 'arm'
  | 'reset'
  | 'restart'
  | 'camera'
  | 'mode1'
  | 'mode2'
  | 'mode3'
  | 'mode4'
  | 'rollLeft'
  | 'rollRight'
  | 'flipFront'
  | 'flipBack'
  | 'turtle'
  | 'pause'
  | 'hud'
  | 'tiltUp'
  | 'tiltDown'
  | 'fovUp'
  | 'fovDown'
  | 'mouse'
  | 'help';

/** One-shot actions and the keys that fire them. */
const ACTION_KEYS: Record<string, Action> = {
  Space: 'arm',
  KeyR: 'reset',
  Backspace: 'restart',
  KeyC: 'camera',
  Digit1: 'mode1',
  Digit2: 'mode2',
  Digit3: 'mode3',
  Digit4: 'mode4',
  KeyQ: 'rollLeft',
  KeyE: 'rollRight',
  KeyZ: 'flipFront',
  KeyX: 'flipBack',
  KeyT: 'turtle',
  Escape: 'pause',
  KeyP: 'pause',
  KeyH: 'hud',
  BracketRight: 'tiltUp',
  BracketLeft: 'tiltDown',
  Equal: 'fovUp',
  Minus: 'fovDown',
  KeyM: 'mouse',
  Tab: 'help',
};

const FLIGHT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'ShiftLeft', 'ShiftRight']);

export interface InputContext {
  /** throttle stick position that hovers this airframe, 0..1 */
  hover: number;
  armed: boolean;
  landed: boolean;
}

/**
 * Turns a laptop keyboard (and optionally trackpad or gamepad) into a four-channel radio.
 *
 * Keys are on/off, sticks are not — so each held key drives a virtual stick that travels towards
 * full deflection and springs back on release. A tap is a nudge, a hold is a full-rate roll.
 */
export class Input {
  enabled = false;
  readonly rc: RcCommand = { roll: 0, pitch: 0, yaw: 0, throttle: 0, climb: 0 };
  /** stick positions for the on-screen gimbals, each -1..1 */
  readonly left = { x: 0, y: -1 };
  readonly right = { x: 0, y: 0 };
  onAction: ((a: Action) => void) | null = null;
  pointerLocked = false;
  usingGamepad = false;

  private keys = new Set<string>();
  private roll = 0;
  private pitch = 0;
  private yaw = 0;
  private thrAxis = 0;
  private thrHold = 0;
  private launched = false;
  private lift = 0;
  private groundTime = 0;
  private mouseX = 0;
  private mouseY = 0;
  private padButtons: boolean[] = [];

  constructor(private canvas: HTMLElement, private settings: SettingsStore) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (FLIGHT_KEYS.has(e.code)) {
      e.preventDefault();
      this.keys.add(e.code);
      this.usingGamepad = false;
      return;
    }
    const action = ACTION_KEYS[e.code];
    if (action) {
      e.preventDefault();
      if (!e.repeat || action === 'tiltUp' || action === 'tiltDown' || action === 'fovUp' || action === 'fovDown') this.onAction?.(action);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onLockChange = (): void => {
    const was = this.pointerLocked;
    this.pointerLocked = document.pointerLockElement === this.canvas;
    // Esc silently drops the pointer lock, so treat losing it mid-flight as a pause request
    if (was && !this.pointerLocked && this.enabled) this.onAction?.('pause');
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled || !this.pointerLocked) return;
    const k = this.settings.data.controls.mouseSensitivity / 240;
    this.mouseX = clamp(this.mouseX + e.movementX * k, -1, 1);
    this.mouseY = clamp(this.mouseY - e.movementY * k, -1, 1);
  };

  private onMouseDown = (): void => {
    if (!this.enabled) return;
    if (this.settings.data.controls.mouseStick && !this.pointerLocked) {
      this.requestLock();
      return;
    }
    // a click recentres the mouse stick
    this.mouseX = 0;
    this.mouseY = 0;
  };

  requestLock(): void {
    try {
      const p = this.canvas.requestPointerLock() as unknown;
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
    } catch {
      // pointer lock unavailable (e.g. sandboxed frame): the keyboard still flies fine
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Forget everything held; used when flight is paused or the quad is reset. */
  clear(): void {
    this.keys.clear();
    this.roll = this.pitch = this.yaw = this.thrAxis = 0;
    this.thrHold = 0;
    this.launched = false;
    this.lift = 0;
    this.mouseX = this.mouseY = 0;
  }

  private held(a: string, b?: string): number {
    return this.keys.has(a) || (b !== undefined && this.keys.has(b)) ? 1 : 0;
  }

  update(dt: number, ctx: InputContext): void {
    const c = this.settings.data.controls;
    const precise = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 0.42 : 1;

    // ---- keyboard virtual sticks ----------------------------------------------------------------
    const attack = 7.5 * c.keyResponse;
    const release = 11 * c.keyResponse;
    const stick = (cur: number, target: number, up = attack): number => {
      const towardsCentre = Math.abs(target) < Math.abs(cur) || Math.sign(target) !== Math.sign(cur);
      return approach(cur, target, (towardsCentre ? release : up) * dt);
    };
    const rollT = (this.held('ArrowRight', 'KeyL') - this.held('ArrowLeft', 'KeyJ')) * precise;
    const pitchT = (this.held('ArrowUp', 'KeyI') - this.held('ArrowDown', 'KeyK')) * precise * (c.invertPitch ? -1 : 1);
    const yawT = (this.held('KeyD') - this.held('KeyA')) * precise;
    const thrT = (this.held('KeyW') - this.held('KeyS')) * (precise < 1 ? 0.5 : 1);
    this.roll = stick(this.roll, rollT);
    this.pitch = stick(this.pitch, pitchT);
    this.yaw = stick(this.yaw, yawT, attack * 0.8);
    this.thrAxis = approach(this.thrAxis, thrT, (Math.abs(thrT) < Math.abs(this.thrAxis) ? 5 : 3.6) * c.keyResponse * dt);
    this.thrHold = clamp(this.thrHold + thrT * 0.85 * dt, 0, 1);

    // ---- trackpad / mouse as the right stick --------------------------------------------------
    if (this.pointerLocked) {
      const centre = Math.exp(-dt * 2.4);
      this.mouseX *= centre;
      this.mouseY *= centre;
    } else {
      this.mouseX = this.mouseY = 0;
    }

    let roll = this.roll + this.mouseX;
    let pitch = this.pitch + this.mouseY;
    let yaw = this.yaw;
    let axis = this.thrAxis;
    let rawThrottle: number | null = null;

    // ---- gamepad ------------------------------------------------------------------------------------
    const pad = this.pollGamepad();
    if (pad && this.usingGamepad) {
      const dz = (v: number): number => (Math.abs(v) < 0.045 ? 0 : (v - Math.sign(v) * 0.045) / 0.955);
      yaw = dz(pad.axes[0] ?? 0);
      roll = dz(pad.axes[2] ?? 0);
      pitch = -dz(pad.axes[3] ?? 0);
      axis = -dz(pad.axes[1] ?? 0);
      if (c.throttle === 'hold') rawThrottle = clamp((1 - (pad.axes[1] ?? 0)) / 2, 0, 1);
    }

    roll = clamp(roll, -1, 1);
    pitch = clamp(pitch, -1, 1);
    yaw = clamp(yaw, -1, 1);

    // ---- throttle ---------------------------------------------------------------------------------
    let throttle: number;
    if (!ctx.armed) {
      this.launched = false;
      this.lift = 0;
      this.thrHold = 0;
      this.groundTime = 0;
      throttle = 0;
    } else if (rawThrottle !== null) {
      throttle = rawThrottle;
      axis = rawThrottle * 2 - 1;
    } else if (c.throttle === 'hold') {
      throttle = this.thrHold;
      axis = this.thrHold * 2 - 1;
    } else {
      // spring throttle: sits at hover once you've taken off, idles while on the ground
      if (!this.launched && axis > 0.05) this.launched = true;
      this.groundTime = ctx.landed && axis <= 0.02 ? this.groundTime + dt : 0;
      if (this.launched && this.groundTime > 0.35) this.launched = false;
      this.lift = approach(this.lift, this.launched ? 1 : 0, (this.launched ? 2.2 : 6) * dt);
      const mapped = axis >= 0 ? ctx.hover + axis * (1 - ctx.hover) : ctx.hover * (1 + axis);
      throttle = mapped * this.lift;
    }

    this.rc.roll = roll;
    this.rc.pitch = pitch;
    this.rc.yaw = yaw;
    this.rc.throttle = clamp(throttle, 0, 1);
    this.rc.climb = clamp(axis, -1, 1);
    this.left.x = yaw;
    this.left.y = this.rc.throttle * 2 - 1;
    this.right.x = roll;
    this.right.y = pitch;
  }

  private pollGamepad(): Gamepad | null {
    if (!this.enabled || !navigator.getGamepads) return null;
    let pad: Gamepad | null = null;
    for (const p of navigator.getGamepads()) {
      if (p && p.connected && p.axes.length >= 4) {
        pad = p;
        break;
      }
    }
    if (!pad) {
      this.usingGamepad = false;
      return null;
    }
    if (!this.usingGamepad) {
      for (const a of pad.axes) if (Math.abs(a) > 0.3) this.usingGamepad = true;
    }
    const map: [number, Action][] = [
      [0, 'arm'],
      [1, 'reset'],
      [2, 'turtle'],
      [3, 'camera'],
      [4, 'rollLeft'],
      [5, 'rollRight'],
      [9, 'pause'],
    ];
    for (const [i, action] of map) {
      const down = !!pad.buttons[i]?.pressed;
      if (down && !this.padButtons[i]) {
        this.usingGamepad = true;
        this.onAction?.(action);
      }
      this.padButtons[i] = down;
    }
    return pad;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
  }
}
