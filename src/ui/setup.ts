import {
  AxisRecorder,
  RADIO_PRESETS,
  STICK_CHANNELS,
  applyCalibration,
  assignAxis,
  detectAxis,
  detectButton,
  getPreset,
  readModeSwitch,
  readSticks,
  readSwitch,
  sanitizeRadio,
  type RadioProfile,
  type StickChannel,
  type ThrottleStyle,
} from '../core/radio';
import type { FlightModeId, SettingsStore } from '../core/settings';
import type { Game } from '../game/game';
import { DRONES, getDrone } from '../sim/drone-config';
import { LIMITS, RATES_TYPES, RATE_AXES, centreSensitivity, formatBetaflightRates, parseBetaflightRates, rateDps, type AxisRateConfig, type RateAxis, type RateProfile, type RatesType } from '../sim/rates';
import { CTRL_FIELDS, sanitizeTune, stockRateProfile, type AirframeTune } from '../sim/tuning';
import { h } from './dom';

/**
 * The Radio and Tuning tabs of Settings. Both keep their working state here and write to the
 * settings store whenever something is committed; `rerender` asks the shell to redraw the tab.
 */

const CHANNEL_NAMES: Record<StickChannel, string> = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw', throttle: 'Throttle' };
const CHANNEL_MOVE: Record<StickChannel, string> = {
  roll: 'Push the roll stick to the right',
  pitch: 'Push the pitch stick forward (nose down)',
  yaw: 'Push the yaw stick to the right',
  throttle: 'Push the throttle from the bottom to the top',
};
const MODE_NAMES: Record<FlightModeId, string> = { cruise: 'Cruise', angle: 'Angle', horizon: 'Horizon', acro: 'Acro' };
const THROTTLE_STYLES: [ThrottleStyle, string, string][] = [
  ['auto', 'As keyboard', 'Like v1.0: a gamepad stick that springs around hover, or stick position when Throttle keys is set to Hold.'],
  ['absolute', 'Radio', 'Stick position is throttle, bottom is off. Use this for a radio’s throttle gimbal.'],
  ['centred', 'Spring', 'Always the spring-to-hover stick: centre hovers, up climbs, down sinks.'],
];

type Detecting =
  | { kind: 'stick'; channel: StickChannel; axes: number[] }
  | { kind: 'arm'; axes: number[]; buttons: boolean[] }
  | { kind: 'mode'; axes: number[] };

type Calibrating = { step: 'centre' } | { step: 'sweep'; centres: number[]; rec: AxisRecorder };

const pressed = (pad: Gamepad): boolean[] => Array.from(pad.buttons, (b) => !!b?.pressed);

export class RadioPanel {
  private detecting: Detecting | null = null;
  private calibrating: Calibrating | null = null;
  private notice = '';
  private axisCount = -1;
  private padId: string | null = null;
  // live elements refreshed every frame
  private live: { status: HTMLElement; axes: HTMLElement[]; outputs: Partial<Record<StickChannel, HTMLElement>>; arm: HTMLElement | null; mode: HTMLElement | null } | null = null;

  constructor(private store: SettingsStore, private game: Game, private rerender: () => void) {}

  private get profile(): RadioProfile {
    return sanitizeRadio(this.store.data.radio);
  }

  private commit(p: RadioProfile, notice = ''): void {
    this.notice = notice;
    this.store.update((d) => (d.radio = p));
    this.rerender();
  }

  private pad(): Gamepad | null {
    return this.game.input.findPad(this.profile);
  }

  render(): HTMLElement[] {
    const p = this.profile;
    const pad = this.pad();
    this.padId = pad?.id ?? null;
    this.axisCount = pad?.axes.length ?? 0;
    const preset = getPreset(p.preset);
    const axisOptions = Math.max(this.axisCount, 8);

    const status = h('p', { class: 'note' });
    const axes: HTMLElement[] = [];
    const axisMeters = h(
      'div',
      { class: 'axes' },
      ...Array.from({ length: this.axisCount }, (_, i) => {
        const fill = h('i');
        axes.push(fill);
        return h('div', { class: 'axis' }, h('span', { class: 'mono' }, String(i)), h('div', { class: 'meter meter--centred' }, fill));
      }),
    );

    // ---- preset
    const presets = h(
      'ul',
      { class: 'rows', role: 'radiogroup', 'aria-label': 'Radio preset' },
      ...RADIO_PRESETS.map((pr) =>
        h(
          'li',
          null,
          h(
            'button',
            {
              class: 'row',
              role: 'radio',
              'aria-checked': String(pr.id === p.preset),
              onclick: () => {
                const next = pr.make();
                next.device = p.device;
                this.detecting = null;
                this.calibrating = null;
                this.commit(next, pr.calibrate ? 'Now use Detect on each stick, then Calibrate.' : 'Preset loaded. Check each stick moves the right way, then Calibrate.');
              },
            },
            h('span', { class: 'row-name' }, pr.name),
            h('span', { class: 'row-sub' }, pr.calibrate ? 'calibrate yourself' : 'documented order'),
          ),
        ),
      ),
    );

    // ---- sticks
    const outputs: Partial<Record<StickChannel, HTMLElement>> = {};
    const used = new Set(STICK_CHANNELS.map((c) => p.channels[c].axis).filter((a) => a >= 0));
    const rows = STICK_CHANNELS.map((ch) => {
      const c = p.channels[ch];
      const select = h('select', { 'aria-label': `${CHANNEL_NAMES[ch]} axis` }, h('option', { value: '-1' }, 'Not set'), ...Array.from({ length: axisOptions }, (_, i) => h('option', { value: String(i) }, `Axis ${i}${used.has(i) && i !== c.axis ? ' (in use)' : ''}`)));
      select.value = String(c.axis);
      select.addEventListener('change', () => {
        const next = structuredClone(p);
        const axis = Number(select.value);
        for (const other of STICK_CHANNELS) if (other !== ch && next.channels[other].axis === axis) next.channels[other].axis = -1;
        next.channels[ch] = { ...next.channels[ch], axis, min: -1, center: 0, max: 1 };
        this.commit(next, axis >= 0 ? `${CHANNEL_NAMES[ch]} is on axis ${axis}. Calibrate when every stick is set.` : '');
      });
      const fill = h('i');
      outputs[ch] = fill;
      const detecting = this.detecting?.kind === 'stick' && this.detecting.channel === ch;
      return h(
        'div',
        { class: 'chan' },
        h('span', { class: 'chan-name' }, CHANNEL_NAMES[ch]),
        select,
        h('label', { class: 'check' }, this.checkbox(c.invert, (v) => this.commit(withChannel(p, ch, { invert: v }))), 'Invert'),
        h('div', { class: ch === 'throttle' && this.throttleAbsolute(p) ? 'meter' : 'meter meter--centred' }, fill),
        h('button', { class: 'btn btn--small', 'aria-pressed': String(detecting), disabled: !pad, onclick: () => this.startDetect({ kind: 'stick', channel: ch }) }, detecting ? 'Cancel' : 'Detect'),
      );
    });

    // ---- calibration
    let calib: HTMLElement;
    if (!this.calibrating) {
      calib = h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', disabled: !pad, onclick: () => ((this.calibrating = { step: 'centre' }), (this.detecting = null), (this.notice = ''), this.rerender()) }, 'Calibrate'),
      );
    } else if (this.calibrating.step === 'centre') {
      calib = h(
        'div',
        { class: 'prompt-box' },
        h('p', null, h('b', null, 'Step 1 of 2. '), 'Let go of the sticks so they centre. Leave the throttle wherever it is. Then press Next.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn--primary', onclick: () => this.calibrateNext() }, 'Next'), h('button', { class: 'btn btn--quiet', onclick: () => this.cancelCalibration() }, 'Cancel')),
      );
    } else {
      calib = h(
        'div',
        { class: 'prompt-box' },
        h('p', null, h('b', null, 'Step 2 of 2. '), 'Move every stick to both ends and round its full circle, two or three times. Then press Done.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn--primary', onclick: () => this.calibrateDone() }, 'Done'), h('button', { class: 'btn btn--quiet', onclick: () => this.cancelCalibration() }, 'Cancel')),
      );
    }

    // ---- switches
    const armLive = h('span', { class: 'tag' });
    const armDetecting = this.detecting?.kind === 'arm';
    const armRow = h(
      'div',
      { class: 'chan chan--switch' },
      h('span', { class: 'chan-name' }, 'Arm'),
      h('span', { class: 'chan-what' }, p.arm.kind === 'none' ? 'Not set' : p.arm.kind === 'button' ? `Button ${p.arm.index}` : `Axis ${p.arm.index}`),
      p.arm.kind === 'none' ? h('span') : h('label', { class: 'check' }, this.checkbox(p.arm.invert, (v) => this.commit({ ...p, arm: { ...(p.arm as { kind: 'axis'; index: number; invert: boolean }), invert: v } })), 'Invert'),
      armLive,
      h(
        'div',
        { class: 'chan-buttons' },
        h('button', { class: 'btn btn--small', 'aria-pressed': String(armDetecting), disabled: !pad, onclick: () => this.startDetect({ kind: 'arm' }) }, armDetecting ? 'Cancel' : 'Detect'),
        p.arm.kind !== 'none' ? h('button', { class: 'btn btn--small btn--quiet', onclick: () => this.commit({ ...p, arm: { kind: 'none' } }) }, 'Clear') : null,
      ),
    );

    const modeLive = h('span', { class: 'tag' });
    const modeDetecting = this.detecting?.kind === 'mode';
    const modePicker = (pos: 'low' | 'mid' | 'high'): HTMLElement | null => {
      if (p.mode.kind !== 'axis') return null;
      const m = p.mode;
      const sel = h('select', { 'aria-label': `Mode switch ${pos}` }, ...(Object.keys(MODE_NAMES) as FlightModeId[]).map((id) => h('option', { value: id }, MODE_NAMES[id])));
      sel.value = m[pos];
      sel.addEventListener('change', () => this.commit({ ...p, mode: { ...m, [pos]: sel.value as FlightModeId } }));
      return h('label', { class: 'mode-pos' }, h('span', null, pos === 'low' ? 'Low' : pos === 'mid' ? 'Middle' : 'High'), sel);
    };
    const modeRow = h(
      'div',
      { class: 'chan chan--switch' },
      h('span', { class: 'chan-name' }, 'Flight mode'),
      h('span', { class: 'chan-what' }, p.mode.kind === 'none' ? 'Not set' : `Axis ${p.mode.index}`),
      h('span'),
      modeLive,
      h(
        'div',
        { class: 'chan-buttons' },
        h('button', { class: 'btn btn--small', 'aria-pressed': String(modeDetecting), disabled: !pad, onclick: () => this.startDetect({ kind: 'mode' }) }, modeDetecting ? 'Cancel' : 'Detect'),
        p.mode.kind !== 'none' ? h('button', { class: 'btn btn--small btn--quiet', onclick: () => this.commit({ ...p, mode: { kind: 'none' } }) }, 'Clear') : null,
      ),
    );

    // ---- options
    const deadbandValue = h('span', { class: 'field-value' }, `${(p.deadband * 100).toFixed(1)}%`);
    const deadband = h('input', { type: 'range', min: 0, max: 0.15, step: 0.005, 'aria-label': 'Deadband' });
    deadband.value = String(p.deadband);
    deadband.addEventListener('input', () => (deadbandValue.textContent = `${(Number(deadband.value) * 100).toFixed(1)}%`));
    deadband.addEventListener('change', () => this.commit({ ...p, deadband: Number(deadband.value) }));

    const prompt = this.detecting ? h('div', { class: 'prompt-box' }, h('p', null, this.detectPrompt(this.detecting))) : null;

    this.live = { status, axes, outputs, arm: armLive, mode: modeLive };
    this.tick();

    return [
      h('div', { class: 'group' }, h('h2', null, 'Device'), status, axisMeters),
      h('div', { class: 'group' }, h('h2', null, 'Preset'), presets, h('p', { class: 'note' }, preset?.note ?? 'Custom mapping.', preset?.source ? h('span', null, ' Source: ', preset.source) : null)),
      h('div', { class: 'group' }, h('h2', null, 'Sticks'), prompt, ...rows, this.notice ? h('p', { class: 'note note--live' }, this.notice) : null, calib),
      h('div', { class: 'group' }, h('h2', null, 'Switches'), armRow, modeRow, p.mode.kind === 'axis' ? h('div', { class: 'mode-positions' }, modePicker('low'), modePicker('mid'), modePicker('high')) : null, h('p', { class: 'note' }, 'Flipping the arm switch on arms and flipping it off disarms. It must be cycled after the radio is plugged in, and it will not arm with the throttle up. Space still arms from the keyboard.')),
      h(
        'div',
        { class: 'group' },
        h('h2', null, 'Options'),
        this.field('Throttle', THROTTLE_STYLES.find((t) => t[0] === p.throttle)![2], this.seg(THROTTLE_STYLES.map(([id, label]) => [id, label]), p.throttle, (v) => this.commit({ ...p, throttle: v as ThrottleStyle }))),
        this.field('Deadband', 'Stick travel around centre that reads as zero. Gamepads need a little; radio gimbals rarely do.', h('div', { class: 'field-control' }, deadband, deadbandValue)),
        this.field('Gamepad buttons', 'A arms, B resets, X turtles, Y changes camera, the bumpers auto-roll, Start pauses. Turn off for radios, whose switches show up as buttons.', h('div', { class: 'field-control' }, this.switchControl(p.padButtons, (v) => this.commit({ ...p, padButtons: v })))),
        this.field(
          'This device only',
          this.padId ? `Use ${this.padId} even when other controllers are plugged in.` : 'Plug in the controller to pick it.',
          h('div', { class: 'field-control' }, this.switchControl(!!p.device, (v) => this.commit({ ...p, device: v && this.padId ? this.padId : '' }))),
        ),
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn--quiet', onclick: () => this.commit(RADIO_PRESETS[0].make(), 'Back to the v1.0 gamepad mapping.') }, 'Reset radio setup')),
    ];
  }

  /** Refresh the live readouts and run detection and calibration. Called every frame while the tab is open. */
  tick(): void {
    const live = this.live;
    if (!live || !live.status.isConnected) return;
    const p = this.profile;
    const pad = this.pad();
    if ((pad?.id ?? null) !== this.padId || (pad?.axes.length ?? 0) !== this.axisCount) {
      this.rerender();
      return;
    }
    if (!pad) {
      live.status.textContent = 'No gamepad or radio found. Plug it in, then move a stick or press a button: browsers only report a controller once it has been used.';
      return;
    }
    live.status.textContent = `${pad.id} · ${pad.axes.length} axes · ${pad.buttons.length} buttons${pad.mapping === 'standard' ? ' · standard gamepad layout' : ''}`;
    pad.axes.forEach((v, i) => setCentred(live.axes[i], v));

    const st = readSticks(pad.axes, p, this.store.data.controls.throttle);
    setCentred(live.outputs.roll, st.roll);
    setCentred(live.outputs.pitch, st.pitch);
    setCentred(live.outputs.yaw, st.yaw);
    if (st.throttle !== null) setLinear(live.outputs.throttle, st.throttle);
    else setCentred(live.outputs.throttle, st.climb);

    const arm = readSwitch(p.arm, pad.axes, pad.buttons);
    if (live.arm) {
      live.arm.textContent = arm === null ? '' : arm ? 'ON' : 'off';
      live.arm.toggleAttribute('data-tone', false);
      if (arm) live.arm.setAttribute('data-tone', 'live');
    }
    const mode = readModeSwitch(p.mode, pad.axes);
    if (live.mode) live.mode.textContent = mode ? MODE_NAMES[mode] : '';

    const d = this.detecting;
    if (d) {
      if (d.kind === 'stick') {
        const others = STICK_CHANNELS.filter((c) => c !== d.channel && p.channels[c].axis >= 0).map((c) => p.channels[c].axis);
        // prefer an axis no other stick uses; the throttle travels end to end, so it needs a bigger move
        const hit = detectAxis(d.axes, pad.axes, d.channel === 'throttle' ? 0.9 : 0.5, others) ?? detectAxis(d.axes, pad.axes, 0.9);
        if (hit) {
          this.detecting = null;
          this.commit(assignAxis(p, d.channel, hit), `${CHANNEL_NAMES[d.channel]} is on axis ${hit.index}${hit.sign < 0 ? ', inverted' : ''}.`);
        }
      } else if (d.kind === 'arm') {
        const button = detectButton(d.buttons, pad.buttons);
        const axis = detectAxis(d.axes, pad.axes, 0.8, STICK_CHANNELS.map((c) => p.channels[c].axis));
        if (button !== null) {
          this.detecting = null;
          // the pilot flipped the switch to "on": if that released the button, it reads inverted
          this.commit({ ...p, arm: { kind: 'button', index: button, invert: !pad.buttons[button]?.pressed } }, `Arm switch is button ${button}.`);
        } else if (axis) {
          this.detecting = null;
          this.commit({ ...p, arm: { kind: 'axis', index: axis.index, invert: axis.sign < 0 } }, `Arm switch is axis ${axis.index}.`);
        }
      } else {
        const axis = detectAxis(d.axes, pad.axes, 0.6, STICK_CHANNELS.map((c) => p.channels[c].axis));
        if (axis) {
          this.detecting = null;
          const m = p.mode.kind === 'axis' ? p.mode : { low: 'cruise' as const, mid: 'angle' as const, high: 'acro' as const };
          this.commit({ ...p, mode: { kind: 'axis', index: axis.index, low: m.low, mid: m.mid, high: m.high } }, `Flight-mode switch is axis ${axis.index}. Pick a mode for each position below.`);
        }
      }
    }
    if (this.calibrating?.step === 'sweep') this.calibrating.rec.observe(pad.axes);
  }

  private startDetect(kind: { kind: 'stick'; channel: StickChannel } | { kind: 'arm' } | { kind: 'mode' }): void {
    const pad = this.pad();
    const same = this.detecting && this.detecting.kind === kind.kind && (kind.kind !== 'stick' || (this.detecting as { channel?: StickChannel }).channel === kind.channel);
    this.calibrating = null;
    this.notice = '';
    if (same || !pad) {
      this.detecting = null;
    } else {
      const axes = Array.from(pad.axes);
      if (kind.kind === 'stick') this.detecting = { kind: 'stick', channel: kind.channel, axes };
      else if (kind.kind === 'arm') this.detecting = { kind: 'arm', axes, buttons: pressed(pad) };
      else this.detecting = { kind: 'mode', axes };
    }
    this.rerender();
  }

  private detectPrompt(d: Detecting): string {
    if (d.kind === 'stick') return `${CHANNEL_MOVE[d.channel]}. The axis that moves most is assigned.`;
    if (d.kind === 'arm') return 'Flip the switch you want to arm with to its ON position.';
    return 'Move the switch you want for flight modes from one end to the other.';
  }

  private calibrateNext(): void {
    const pad = this.pad();
    if (!pad) return this.cancelCalibration();
    const rec = new AxisRecorder();
    rec.observe(pad.axes);
    this.calibrating = { step: 'sweep', centres: Array.from(pad.axes), rec };
    this.rerender();
  }

  private calibrateDone(): void {
    const c = this.calibrating;
    if (!c || c.step !== 'sweep') return;
    this.calibrating = null;
    const { profile, skipped } = applyCalibration(this.profile, c.centres, c.rec);
    const named = skipped.map((s) => CHANNEL_NAMES[s]);
    this.commit(profile, skipped.length ? `Calibrated. ${named.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} not set or did not move enough, and kept the old range.` : 'Calibrated.');
  }

  private cancelCalibration(): void {
    this.calibrating = null;
    this.rerender();
  }

  private throttleAbsolute(p: RadioProfile): boolean {
    return p.throttle === 'absolute' || (p.throttle === 'auto' && this.store.data.controls.throttle === 'hold');
  }

  private checkbox(on: boolean, set: (v: boolean) => void): HTMLInputElement {
    const box = h('input', { type: 'checkbox' });
    box.checked = on;
    box.addEventListener('change', () => set(box.checked));
    return box;
  }

  private switchControl(on: boolean, set: (v: boolean) => void): HTMLElement {
    return h('button', { class: 'switch', role: 'switch', 'aria-checked': String(on), onclick: () => set(!on) });
  }

  private seg(options: [string, string][], value: string, set: (v: string) => void): HTMLElement {
    return h('div', { class: 'field-control' }, h('div', { class: 'seg', role: 'radiogroup' }, ...options.map(([id, label]) => h('button', { role: 'radio', 'aria-checked': String(id === value), onclick: () => id !== value && set(id) }, label))));
  }

  private field(label: string, help: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), h('div', { class: 'field-help' }, help), control);
  }
}

function withChannel(p: RadioProfile, ch: StickChannel, patch: Partial<RadioProfile['channels'][StickChannel]>): RadioProfile {
  const next = structuredClone(p);
  next.channels[ch] = { ...next.channels[ch], ...patch };
  return next;
}

function setCentred(el: HTMLElement | undefined, v: number): void {
  if (!el) return;
  const x = Math.max(-1, Math.min(1, v));
  el.style.left = `${50 + Math.min(0, x) * 50}%`;
  el.style.width = `${Math.abs(x) * 50}%`;
}

function setLinear(el: HTMLElement | undefined, v: number): void {
  if (!el) return;
  el.style.left = '0';
  el.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
}

// -----------------------------------------------------------------------------------------------
// tuning
// -----------------------------------------------------------------------------------------------

const TYPE_LABELS: Record<RatesType, string> = { BETAFLIGHT: 'Betaflight', RACEFLIGHT: 'Raceflight', KISS: 'KISS', ACTUAL: 'Actual', QUICK: 'Quick' };
/** What Betaflight's configurator calls each CLI number, per rate type: rc_rate, srate, expo. */
const PARAM_LABELS: Record<RatesType, [string, string, string]> = {
  BETAFLIGHT: ['RC rate', 'Super rate', 'Expo'],
  RACEFLIGHT: ['Rate', 'Acro+', 'Expo'],
  KISS: ['RC rate', 'Rate', 'RC curve'],
  ACTUAL: ['Centre', 'Max rate', 'Expo'],
  QUICK: ['RC rate', 'Max rate', 'Expo'],
};
const AXIS_NAMES: Record<RateAxis, string> = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw' };
const AXIS_COLOURS: Record<RateAxis, string> = { roll: '#ff5a1f', pitch: '#2bf59a', yaw: '#7cc4ff' };

export class TuningPanel {
  private droneId: string | null = null;
  private importText = '';
  private notice = '';

  constructor(private store: SettingsStore, private rerender: () => void) {}

  private get cfg() {
    return getDrone(this.droneId ?? this.store.data.drone);
  }

  private get tune(): AirframeTune {
    return sanitizeTune(this.store.data.tuning[this.cfg.id], this.cfg);
  }

  private commit(t: AirframeTune, notice = ''): void {
    const id = this.cfg.id;
    this.notice = notice;
    this.store.update((d) => {
      if (!t.rates && !t.ctrl) delete d.tuning[id];
      else d.tuning[id] = structuredClone(t);
    });
    this.rerender();
  }

  render(): HTMLElement[] {
    const cfg = this.cfg;
    const tune = this.tune;
    const rates = tune.rates ?? stockRateProfile(cfg);
    const scale = this.store.data.controls.rateScale;

    const drones = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': 'Airframe to tune' },
      ...DRONES.map((d) => h('button', { role: 'radio', 'aria-checked': String(d.id === cfg.id), onclick: () => ((this.droneId = d.id), (this.notice = ''), this.rerender()) }, d.name)),
    );

    // ---- rates
    const editRates = (fn: (r: RateProfile) => void): void => {
      const next = structuredClone(rates);
      fn(next);
      this.commit({ ...tune, rates: next });
    };
    const labels = PARAM_LABELS[rates.type];
    const keys: (keyof AxisRateConfig)[] = ['rcRate', 'rate', 'expo', 'limit'];
    const cli: Record<keyof AxisRateConfig, string> = { rcRate: 'rc_rate', rate: 'srate', expo: 'expo', limit: 'rate_limit' };
    const grid = h(
      'div',
      { class: 'rate-grid' },
      h('span'),
      ...keys.map((k, i) => h('span', { class: 'rate-head', title: `CLI: <axis>_${cli[k]}` }, i < 3 ? labels[i] : 'Limit')),
      h('span', { class: 'rate-head' }, 'Centre · max, °/s'),
      ...RATE_AXES.flatMap((axis) => [
        h('span', { class: 'chan-name', style: `color:${AXIS_COLOURS[axis]}` }, AXIS_NAMES[axis]),
        ...keys.map((k) => {
          const [lo, hi] = LIMITS[k];
          const input = h('input', { type: 'number', min: lo, max: hi, step: 1, 'aria-label': `${axis}_${cli[k]}` });
          input.value = String(rates[axis][k]);
          input.addEventListener('change', () => {
            const n = Math.round(Number(input.value));
            if (!Number.isFinite(n) || n < lo || n > hi) {
              input.value = String(rates[axis][k]);
              return;
            }
            editRates((r) => (r[axis][k] = n));
          });
          return input;
        }),
        h('span', { class: 'mono rate-out' }, `${Math.round(centreSensitivity(rates, axis) * scale)} · ${Math.round(rateDps(1, rates, axis) * scale)}`),
      ]),
    );

    const plot = h('canvas', { class: 'rate-plot', width: 520, height: 180, 'aria-label': 'Rate curves' });
    drawRates(plot, rates, scale);

    const textarea = h('textarea', { class: 'cli', rows: 5, spellcheck: 'false', placeholder: 'Paste Betaflight CLI output here: `diff`, `diff all`, or `set roll_rc_rate = …` lines.' });
    textarea.value = this.importText;
    textarea.addEventListener('input', () => (this.importText = textarea.value));

    const doImport = (): void => {
      const r = parseBetaflightRates(this.importText);
      if (!r.applied.length && !r.problems.length) {
        this.notice = 'No rate settings found in that text. Paste the output of `diff` or `diff all` from the Betaflight CLI.';
        this.rerender();
        return;
      }
      const parts = [`Imported ${TYPE_LABELS[r.profile.type]} rates${r.rateProfile !== null ? ` from rate profile ${r.rateProfile}` : ''}: ${r.applied.length} setting${r.applied.length === 1 ? '' : 's'} read, the rest at Betaflight’s defaults.`];
      if (r.problems.length) parts.push(`Skipped: ${r.problems.join('; ')}.`);
      if (r.otherProfiles.length) parts.push(`Rate profile${r.otherProfiles.length > 1 ? 's' : ''} ${r.otherProfiles.join(', ')} ignored.`);
      if (scale !== 1) parts.push(`The Rates slider in the Flight tab is at ${Math.round(scale * 100)}% and scales these too.`);
      this.importText = '';
      this.commit({ ...tune, rates: r.profile }, parts.join(' '));
    };

    const doCopy = (): void => {
      const text = formatBetaflightRates(rates);
      this.importText = text;
      const done = (ok: boolean): void => {
        this.notice = ok ? 'Copied as Betaflight CLI lines.' : 'Your browser blocked the clipboard; the lines are in the box above to copy by hand.';
        this.rerender();
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      else done(false);
    };

    // ---- rate loop
    const ctrl = tune.ctrl ?? cfg.ctrl;
    const ctrlFields = CTRL_FIELDS.map((f) => {
      const value = h('span', { class: 'field-value' }, fmtCtrl(ctrl[f.key], f.step));
      const input = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, 'aria-label': f.label });
      input.value = String(ctrl[f.key]);
      input.addEventListener('input', () => (value.textContent = fmtCtrl(Number(input.value), f.step)));
      input.addEventListener('change', () => this.commit({ ...tune, ctrl: { ...ctrl, [f.key]: Number(input.value) } }));
      return h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-label' }, f.label),
        h('div', { class: 'field-help' }, f.help, ` Stock: ${fmtCtrl(cfg.ctrl[f.key], f.step)}.`),
        h('div', { class: 'field-control' }, input, value),
      );
    });

    return [
      h('div', { class: 'group' }, h('h2', null, 'Airframe'), drones, h('p', { class: 'note' }, tune.rates || tune.ctrl ? `${cfg.name} has your tune: ${[tune.rates ? 'rates' : '', tune.ctrl ? 'rate loop' : ''].filter(Boolean).join(' and ')}.` : `${cfg.name} flies its stock tune.`)),
      h(
        'div',
        { class: 'group' },
        h('h2', null, tune.rates ? `Rates · ${TYPE_LABELS[rates.type]}` : 'Rates · stock (shown as Actual)'),
        this.typeSeg(rates.type, (t) => editRates((r) => (r.type = t))),
        rates.type === 'QUICK'
          ? h('label', { class: 'check', style: 'margin-top:8px' }, this.checkbox(rates.quickRcExpo, (v) => editRates((r) => (r.quickRcExpo = v))), 'Expo on the stick (quickrates_rc_expo)')
          : null,
        grid,
        plot,
        h('p', { class: 'note' }, 'Numbers are Betaflight CLI values, so they match a diff. Changing the type keeps them as they are, as the CLI does; check the curve. ', scale !== 1 ? `Rates slider (Flight tab) at ${Math.round(scale * 100)}% is applied.` : ''),
        textarea,
        this.notice ? h('p', { class: 'note note--live' }, this.notice) : null,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: doImport }, 'Import from Betaflight'),
          h('button', { class: 'btn btn--quiet', onclick: doCopy }, 'Copy as CLI'),
          tune.rates ? h('button', { class: 'btn btn--quiet', onclick: () => this.commit({ ...tune, rates: undefined }, 'Back to stock rates.') }, 'Use stock rates') : null,
        ),
      ),
      h(
        'div',
        { class: 'group' },
        h('h2', null, tune.ctrl ? 'Rate loop · yours' : 'Rate loop · stock'),
        h('p', { class: 'note' }, 'The sim’s rate controller works in physical units: P and D come from the response and damping you ask for and the motors’ lag. These are not Betaflight PID numbers, and Betaflight PIDs do not carry over.'),
        ...ctrlFields,
        tune.ctrl ? h('div', { class: 'actions' }, h('button', { class: 'btn btn--quiet', onclick: () => this.commit({ ...tune, ctrl: undefined }, 'Back to the stock rate loop.') }, 'Use stock rate loop')) : null,
      ),
    ];
  }

  private typeSeg(value: RatesType, set: (t: RatesType) => void): HTMLElement {
    return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Rate type' }, ...RATES_TYPES.map((t) => h('button', { role: 'radio', 'aria-checked': String(t === value), onclick: () => t !== value && set(t) }, TYPE_LABELS[t])));
  }

  private checkbox(on: boolean, set: (v: boolean) => void): HTMLInputElement {
    const box = h('input', { type: 'checkbox' });
    box.checked = on;
    box.addEventListener('change', () => set(box.checked));
    return box;
  }
}

function fmtCtrl(v: number, step: number): string {
  return step >= 1 ? String(Math.round(v)) : v.toFixed(2);
}

/** Stick (0..1) against rate (deg/s) for the three axes. */
function drawRates(canvas: HTMLCanvasElement, p: RateProfile, scale: number): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width;
  const H = canvas.height;
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const top = Math.max(200, ...RATE_AXES.map((a) => rateDps(1, p, a) * scale));
  const yMax = Math.ceil(top / 200) * 200;
  const x = (s: number): number => pad.l + s * (W - pad.l - pad.r);
  const y = (v: number): number => H - pad.b - (v / yMax) * (H - pad.t - pad.b);
  g.clearRect(0, 0, W, H);
  g.font = '11px "B612 Mono", monospace';
  g.fillStyle = 'rgba(243,241,236,0.55)';
  g.strokeStyle = 'rgba(243,241,236,0.12)';
  g.lineWidth = 1;
  for (let v = 0; v <= yMax; v += 200) {
    g.beginPath();
    g.moveTo(x(0), y(v));
    g.lineTo(x(1), y(v));
    g.stroke();
    g.fillText(String(v), 4, y(v) + 4);
  }
  g.fillText('stick', x(1) - 30, H - 6);
  g.lineWidth = 2;
  for (const axis of RATE_AXES) {
    g.strokeStyle = AXIS_COLOURS[axis];
    g.beginPath();
    for (let i = 0; i <= 100; i++) {
      const s = i / 100;
      const v = rateDps(s, p, axis) * scale;
      if (i === 0) g.moveTo(x(s), y(v));
      else g.lineTo(x(s), y(v));
    }
    g.stroke();
  }
}
