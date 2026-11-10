import { formatTime } from '../core/math';
import type { FlightModeId, Settings, SettingsStore } from '../core/settings';
import type { Game, GameState } from '../game/game';
import type { RaceResult } from '../game/race';
import { MAPS } from '../maps';
import { QUALITY, type QualityId } from '../render/engine';
import { DRONES } from '../sim/drone-config';
import { h } from './dom';
import { Hud, clock } from './hud';

type ScreenId = 'loading' | 'menu' | 'settings' | 'controls' | 'pause' | 'results';

const MODE_NOTES: Record<FlightModeId, [string, string]> = {
  cruise: ['Cruise', 'Self-levelling with altitude hold. W and S climb and descend; let go and it hovers. Start here.'],
  angle: ['Angle', 'Self-levelling with manual throttle. The sticks set the tilt, up to 55°.'],
  horizon: ['Horizon', 'Levels itself near centre stick, but full deflection flips and rolls.'],
  acro: ['Acro', 'Rate mode, no self-levelling: the sticks set how fast it rotates. This is how FPV is really flown.'],
};

const MEDALS = ['Gold', 'Silver', 'Bronze', 'No medal'];

interface FieldBase {
  label: string;
  help?: string;
  /** rebuild the world after changing this */
  reload?: boolean;
}
type Field =
  | (FieldBase & { kind: 'range'; get: (s: Settings) => number; set: (s: Settings, v: number) => void; min: number; max: number; step: number; fmt: (v: number) => string })
  | (FieldBase & { kind: 'toggle'; get: (s: Settings) => boolean; set: (s: Settings, v: boolean) => void })
  | (FieldBase & { kind: 'choice'; get: (s: Settings) => string; set: (s: Settings, v: string) => void; options: [string, string][] });

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const deg = (v: number): string => `${Math.round(v)}°`;

const TABS: { id: string; label: string; fields: Field[] }[] = [
  {
    id: 'flight',
    label: 'Flight',
    fields: [
      {
        kind: 'choice',
        label: 'Throttle keys',
        help: 'Spring: throttle rests at hover, W and S push away from it. Hold: W and S move a throttle that stays where you leave it, like a real radio.',
        get: (s) => s.controls.throttle,
        set: (s, v) => (s.controls.throttle = v as 'spring' | 'hold'),
        options: [
          ['spring', 'Spring'],
          ['hold', 'Hold'],
        ],
      },
      { kind: 'range', label: 'Rates', help: 'How fast full stick rotates the quad, relative to the airframe’s own tune.', get: (s) => s.controls.rateScale, set: (s, v) => (s.controls.rateScale = v), min: 0.5, max: 1.5, step: 0.05, fmt: pct },
      { kind: 'range', label: 'Key response', help: 'How quickly a held key reaches full stick. Lower is smoother, higher is twitchier.', get: (s) => s.controls.keyResponse, set: (s, v) => (s.controls.keyResponse = v), min: 0.5, max: 2, step: 0.05, fmt: pct },
      { kind: 'toggle', label: 'Trackpad as right stick', help: 'Move the pointer to pitch and roll; click to centre. Press M in flight to switch.', get: (s) => s.controls.mouseStick, set: (s, v) => (s.controls.mouseStick = v) },
      { kind: 'range', label: 'Trackpad sensitivity', get: (s) => s.controls.mouseSensitivity, set: (s, v) => (s.controls.mouseSensitivity = v), min: 0.3, max: 3, step: 0.1, fmt: pct },
      { kind: 'toggle', label: 'Invert pitch', get: (s) => s.controls.invertPitch, set: (s, v) => (s.controls.invertPitch = v) },
      { kind: 'toggle', label: 'Battery drains', help: 'Voltage sags under load and the pack runs down in a few minutes. Reset swaps in a fresh one.', get: (s) => s.sim.battery, set: (s, v) => (s.sim.battery = v) },
      { kind: 'toggle', label: 'Disarm on hard crash', help: 'Off: the motors keep running through impacts, so you can bounce and carry on.', get: (s) => s.sim.crashDisarm, set: (s, v) => (s.sim.crashDisarm = v) },
      { kind: 'toggle', label: 'Wind', get: (s) => s.sim.wind, set: (s, v) => (s.sim.wind = v) },
      { kind: 'toggle', label: 'Ghost of your best run', get: (s) => s.sim.ghost, set: (s, v) => (s.sim.ghost = v) },
    ],
  },
  {
    id: 'camera',
    label: 'Camera',
    fields: [
      { kind: 'range', label: 'Field of view', get: (s) => s.camera.fov, set: (s, v) => (s.camera.fov = v), min: 70, max: 130, step: 1, fmt: deg },
      { kind: 'toggle', label: 'Custom camera tilt', help: 'Off uses the tilt the airframe was built with. More tilt suits faster flying.', get: (s) => s.camera.tilt !== null, set: (s, v) => (s.camera.tilt = v ? 30 : null) },
      { kind: 'range', label: 'Camera tilt', get: (s) => s.camera.tilt ?? 30, set: (s, v) => (s.camera.tilt = v), min: 0, max: 60, step: 1, fmt: deg },
      { kind: 'range', label: 'Fisheye', help: 'Barrel distortion of the lens.', get: (s) => s.camera.distortion, set: (s, v) => (s.camera.distortion = v), min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'range', label: 'Motion blur', get: (s) => s.camera.motionBlur, set: (s, v) => (s.camera.motionBlur = v), min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'toggle', label: 'Lens character', help: 'Vignette, chromatic fringing and sensor grain.', get: (s) => s.camera.lensEffects, set: (s, v) => (s.camera.lensEffects = v) },
    ],
  },
  {
    id: 'display',
    label: 'Display',
    fields: [
      {
        kind: 'choice',
        label: 'Graphics quality',
        help: 'Shadows, foliage, grass density and effects. Changing it reloads the map.',
        reload: true,
        get: (s) => s.quality,
        set: (s, v) => (s.quality = v as QualityId),
        options: (Object.keys(QUALITY) as QualityId[]).map((k) => [k, QUALITY[k].label]),
      },
      { kind: 'toggle', label: 'Adaptive resolution', help: 'Lowers render resolution a little when the frame rate drops.', get: (s) => s.dynamicResolution, set: (s, v) => (s.dynamicResolution = v) },
      {
        kind: 'choice',
        label: 'Speed units',
        get: (s) => s.hud.units,
        set: (s, v) => (s.hud.units = v as 'kmh' | 'mph'),
        options: [
          ['kmh', 'km/h'],
          ['mph', 'mph'],
        ],
      },
      { kind: 'toggle', label: 'Stick monitors', get: (s) => s.hud.sticks, set: (s, v) => (s.hud.sticks = v) },
      { kind: 'toggle', label: 'Artificial horizon', get: (s) => s.hud.horizon, set: (s, v) => (s.hud.horizon = v) },
    ],
  },
  {
    id: 'sound',
    label: 'Sound',
    fields: [
      { kind: 'range', label: 'Master', get: (s) => s.audio.master, set: (s, v) => (s.audio.master = v), min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'range', label: 'Motors', get: (s) => s.audio.motors, set: (s, v) => (s.audio.motors = v), min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'range', label: 'Wind', get: (s) => s.audio.wind, set: (s, v) => (s.audio.wind = v), min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'range', label: 'Effects', get: (s) => s.audio.effects, set: (s, v) => (s.audio.effects = v), min: 0, max: 1, step: 0.05, fmt: pct },
    ],
  },
];

/** Menus, pause, results and loading screens, plus the HUD. */
export class Shell {
  readonly hud: Hud;
  private screens = {} as Record<ScreenId, HTMLElement>;
  private current: ScreenId | null = null;
  private back: ScreenId = 'menu';
  private tab = 'flight';
  private loadBar = h('i');
  private loadLabel = h('span');
  private loadPct = h('span');
  private lastResult: RaceResult | null = null;
  private previousBest: number | null = null;
  private firstRun = false;

  constructor(private root: HTMLElement, private game: Game, private store: SettingsStore) {
    this.hud = new Hud(game);
    root.append(this.hud.el);
    for (const id of ['loading', 'menu', 'settings', 'controls', 'pause', 'results'] as ScreenId[]) {
      const el = h('section', { class: `screen screen--${id}` });
      this.screens[id] = el;
      root.append(el);
    }
    this.screens.loading.append(
      h('div', { class: 'column' }, h('header', { class: 'brand' }, this.wordmark(), h('p', null, 'FPV flight simulator'))),
      h('div', { class: 'loading' }, h('div', { class: 'loading-label' }, this.loadLabel, this.loadPct), h('div', { class: 'loading-bar' }, this.loadBar)),
    );

    game.on('state', (s) => this.onState(s));
    game.on('progress', (p) => {
      this.loadBar.style.transform = `scaleX(${p.fraction})`;
      this.loadLabel.textContent = p.label;
      this.loadPct.textContent = `${Math.round(p.fraction * 100)}%`;
    });
    game.on('finish', (r) => (this.lastResult = r));
    game.on('help', () => {
      game.pause();
      this.back = 'pause';
      this.open('controls');
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.open('loading');
  }

  private wordmark(): HTMLElement {
    return h('h1', { class: 'wordmark' }, 'Prop', h('span', null, 'wash'));
  }

  private onState(s: GameState): void {
    document.body.setAttribute('data-state', s);
    this.hud.show(s === 'flying');
    if (s === 'flying' && this.game.race?.state === 'idle') this.noteBest();
    if (s === 'loading') this.open('loading');
    else if (s === 'menu') this.open('menu');
    else if (s === 'paused') this.open('pause');
    else if (s === 'results') this.open('results');
    else if (s === 'flying') {
      this.open(null);
      // hand keyboard focus back to the view so no hidden button swallows Space
      (document.activeElement as HTMLElement | null)?.blur();
      document.getElementById('view')?.focus({ preventScroll: true });
    }
  }

  private open(id: ScreenId | null): void {
    this.current = id;
    for (const [key, el] of Object.entries(this.screens)) el.toggleAttribute('data-open', key === id);
    if (id === 'menu') this.renderMenu();
    else if (id === 'settings') this.renderSettings();
    else if (id === 'controls') this.renderControls();
    else if (id === 'pause') this.renderPause();
    else if (id === 'results') this.renderResults();
  }

  private onKey(e: KeyboardEvent): void {
    // the flight controls saw this key first (Esc to pause): don't also act on it here
    if (e.defaultPrevented || !this.current || this.current === 'loading') return;
    const t = e.target as HTMLElement;
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.current === 'settings' || this.current === 'controls') this.goBack();
      else if (this.current === 'pause') this.game.resume();
      else if (this.current === 'results') this.game.toMenu();
    } else if (e.code === 'Enter' && t.tagName !== 'BUTTON') {
      e.preventDefault();
      if (this.current === 'menu') this.fly();
      else if (this.current === 'pause') this.game.resume();
      else if (this.current === 'results') this.game.restart();
      else if (this.current === 'controls') {
        if (this.firstRun) this.takeOff();
        else this.goBack();
      }
    }
  }

  private takeOff(): void {
    this.firstRun = false;
    this.game.fly();
  }

  private goBack(): void {
    if (this.back === 'pause' && this.game.state !== 'paused') this.back = 'menu';
    this.open(this.back);
  }

  private fly(): void {
    this.game.audio.ui('select');
    if (!this.store.data.seenIntro) {
      this.store.update((s) => (s.seenIntro = true));
      this.back = 'menu';
      this.firstRun = true;
      this.renderControls(true);
      this.current = 'controls';
      for (const [key, el] of Object.entries(this.screens)) el.toggleAttribute('data-open', key === 'controls');
      return;
    }
    this.game.fly();
  }

  private click(fn: () => void, sound: 'select' | 'toggle' | 'back' = 'toggle'): () => void {
    return () => {
      void this.game.audio.unlock();
      this.game.audio.ui(sound);
      fn();
    };
  }

  // ---------------------------------------------------------------------------------------------

  private renderMenu(): void {
    const s = this.store.data;
    const g = this.game;
    const track = g.track;
    const key = g.recordKey();

    const maps = h(
      'ul',
      { class: 'rows', role: 'radiogroup', 'aria-label': 'Location' },
      ...MAPS.map((m) =>
        h(
          'li',
          null,
          h(
            'button',
            {
              class: 'row',
              role: 'radio',
              'aria-checked': String(m.id === s.map),
              onclick: this.click(() => {
                if (m.id === s.map) return;
                this.store.update((d) => {
                  d.map = m.id;
                  d.track = '';
                });
                void g.load();
              }, 'select'),
            },
            h('span', { class: 'row-name' }, m.name),
            h('span', { class: 'row-sub' }, m.tagline),
          ),
        ),
      ),
    );

    const session = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': 'Session' },
      ...(['freestyle', 'race'] as const).map((m) =>
        h(
          'button',
          {
            role: 'radio',
            'aria-checked': String(s.mode === m),
            onclick: this.click(() => {
              this.store.update((d) => (d.mode = m));
              g.refreshSession();
              this.renderMenu();
            }),
          },
          m === 'freestyle' ? 'Freestyle' : 'Race',
        ),
      ),
    );
    let sessionNote: HTMLElement;
    if (s.mode === 'race' && track) {
      const rec = s.records[key];
      sessionNote = h(
        'p',
        { class: 'note' },
        h('b', null, track.name),
        ` · ${track.gates.length} gates · ${track.laps} ${track.laps === 1 ? 'lap' : 'laps'}. `,
        rec ? h('span', null, 'Your best ', h('span', { class: 'mono' }, clock(formatTime(rec.total))), '.') : 'No time set yet.',
        ' Gold is ',
        h('span', { class: 'mono' }, clock(formatTime(track.medals[0]))),
        '.',
      );
    } else {
      const best = s.bestCombo[g.recordKey()] ?? 0;
      sessionNote = h('p', { class: 'note' }, 'Fly anywhere. Tricks score, and chaining them builds a multiplier.', best > 0 ? h('span', null, ' Best combo ', h('span', { class: 'mono' }, best.toLocaleString()), '.') : null);
    }

    const drones = h(
      'ul',
      { class: 'rows', role: 'radiogroup', 'aria-label': 'Airframe' },
      ...DRONES.map((d) =>
        h(
          'li',
          null,
          h(
            'button',
            {
              class: 'row',
              role: 'radio',
              'aria-checked': String(d.id === s.drone),
              title: d.blurb,
              onclick: this.click(() => {
                if (d.id === s.drone) return;
                this.store.update((x) => (x.drone = d.id));
                g.swapDrone();
                this.renderMenu();
              }, 'select'),
            },
            h('span', { class: 'row-name' }, d.name),
            h('span', { class: 'row-meta' }, `${d.mass >= 0.1 ? Math.round(d.mass * 1000) : (d.mass * 1000).toFixed(0)} g · ${((4 * d.maxThrust) / (d.mass * 9.81)).toFixed(1)}:1`),
            h('span', { class: 'row-sub' }, d.tagline),
          ),
        ),
      ),
    );

    const modes = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': 'Flight mode' },
      ...(Object.keys(MODE_NOTES) as FlightModeId[]).map((m) =>
        h(
          'button',
          {
            role: 'radio',
            'aria-checked': String(s.flightMode === m),
            onclick: this.click(() => {
              this.store.update((d) => (d.flightMode = m));
              this.renderMenu();
            }),
          },
          MODE_NOTES[m][0],
        ),
      ),
    );

    this.screens.menu.replaceChildren(
      h('div', { class: 'scrim' }),
      h(
        'div',
        { class: 'column' },
        h('header', { class: 'brand' }, this.wordmark(), h('p', null, this.game.map.description)),
        h(
          'div',
          { class: 'scroll' },
          h('div', { class: 'group' }, h('h2', null, 'Location'), maps),
          h('div', { class: 'group' }, h('h2', null, 'Session'), session, sessionNote),
          h('div', { class: 'group' }, h('h2', null, 'Airframe'), drones),
          h('div', { class: 'group' }, h('h2', null, 'Flight mode'), modes, h('p', { class: 'note' }, MODE_NOTES[s.flightMode][1])),
        ),
        h(
          'footer',
          { class: 'actions' },
          h('button', { class: 'btn btn--primary', onclick: () => this.fly() }, 'Fly', h('kbd', null, 'Enter')),
          h('button', { class: 'btn', onclick: this.click(() => ((this.back = 'menu'), this.open('controls'))) }, 'Controls'),
          h('button', { class: 'btn', onclick: this.click(() => ((this.back = 'menu'), this.open('settings'))) }, 'Settings'),
        ),
      ),
    );
  }

  private renderSettings(): void {
    const tab = TABS.find((t) => t.id === this.tab) ?? TABS[0];
    const s = this.store.data;
    const fields = tab.fields
      .filter((f) => !(f.label === 'Camera tilt' && s.camera.tilt === null))
      .map((f) => {
        let control: HTMLElement;
        if (f.kind === 'range') {
          const value = h('span', { class: 'field-value' }, f.fmt(f.get(s)));
          const input = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, 'aria-label': f.label });
          input.value = String(f.get(s));
          const paint = (): void => input.style.setProperty('--fill-pct', `${((Number(input.value) - f.min) / (f.max - f.min)) * 100}%`);
          paint();
          input.addEventListener('input', () => {
            const v = Number(input.value);
            this.store.update((d) => f.set(d, v));
            value.textContent = f.fmt(v);
            paint();
          });
          control = h('div', { class: 'field-control' }, input, value);
        } else if (f.kind === 'toggle') {
          const on = f.get(s);
          control = h(
            'div',
            { class: 'field-control' },
            h('button', {
              class: 'switch',
              role: 'switch',
              'aria-checked': String(on),
              'aria-label': f.label,
              onclick: this.click(() => {
                this.store.update((d) => f.set(d, !f.get(d)));
                this.renderSettings();
              }),
            }),
          );
        } else {
          control = h(
            'div',
            { class: 'field-control' },
            h(
              'div',
              { class: 'seg', role: 'radiogroup', 'aria-label': f.label },
              ...f.options.map(([value, label]) =>
                h(
                  'button',
                  {
                    role: 'radio',
                    'aria-checked': String(f.get(s) === value),
                    onclick: this.click(() => {
                      if (f.get(this.store.data) === value) return;
                      this.store.update((d) => f.set(d, value));
                      if (f.reload) void this.game.load();
                      else this.renderSettings();
                    }),
                  },
                  label,
                ),
              ),
            ),
          );
        }
        return h('div', { class: 'field' }, h('div', { class: 'field-label' }, f.label), f.help ? h('div', { class: 'field-help' }, f.help) : null, control);
      });

    this.screens.settings.replaceChildren(
      h('div', { class: 'scrim', style: 'background: rgba(7,8,9,0.86)' }),
      h(
        'div',
        { class: 'column column--wide' },
        h('h1', { class: 'title' }, 'Settings'),
        h(
          'div',
          { class: 'tabs', role: 'tablist' },
          ...TABS.map((t) =>
            h(
              'button',
              {
                role: 'tab',
                'aria-selected': String(t.id === tab.id),
                onclick: this.click(() => {
                  this.tab = t.id;
                  this.renderSettings();
                }),
              },
              t.label,
            ),
          ),
        ),
        h('div', { class: 'scroll' }, ...fields),
        h(
          'footer',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: this.click(() => this.goBack(), 'back') }, 'Done', h('kbd', null, 'Esc')),
          h(
            'button',
            {
              class: 'btn btn--quiet',
              onclick: this.click(() => {
                this.store.reset();
                this.renderSettings();
              }),
            },
            'Restore defaults',
          ),
        ),
      ),
    );
  }

  private renderControls(first = false): void {
    const k = (...keys: string[]): HTMLElement => h('dt', null, ...keys.map((x) => h('kbd', null, x)));
    const line = (keys: string[], ...text: (Node | string)[]): HTMLElement[] => [k(...keys), h('dd', null, ...text)];
    const pad = (keys: (string | null)[]): HTMLElement => h('div', { class: 'pad' }, ...keys.map((x) => (x ? h('kbd', null, x) : h('kbd', { class: 'gap' }, ''))));

    this.screens.controls.replaceChildren(
      h('div', { class: 'scrim', style: 'background: rgba(7,8,9,0.86)' }),
      h(
        'div',
        { class: 'column column--wide' },
        h('h1', { class: 'title' }, first ? 'Two hands, two sticks' : 'Controls'),
        h(
          'div',
          { class: 'scroll' },
          h(
            'div',
            { class: 'sticks' },
            h(
              'div',
              { class: 'stick-card' },
              h('h3', null, 'Left hand — throttle and yaw'),
              pad([null, 'W', null, 'A', 'S', 'D']),
              h('dl', { class: 'keys' }, ...line(['W', 'S'], h('b', null, 'Climb / descend'), ' — let go to hover'), ...line(['A', 'D'], h('b', null, 'Yaw'), ' — turn left / right')),
            ),
            h(
              'div',
              { class: 'stick-card' },
              h('h3', null, 'Right hand — pitch and roll'),
              pad([null, '↑', null, '←', '↓', '→']),
              h('dl', { class: 'keys' }, ...line(['↑', '↓'], h('b', null, 'Pitch'), ' — nose down / up'), ...line(['←', '→'], h('b', null, 'Roll'), ' — bank left / right')),
            ),
          ),
          h('p', { class: 'note' }, 'A tap is a nudge; holding a key pushes the stick all the way. Hold ', h('kbd', null, 'Shift'), ' for fine control. A gamepad or radio works too.'),
          h('hr', { class: 'hr' }),
          h(
            'dl',
            { class: 'keys' },
            ...line(['Space'], h('b', null, 'Arm / disarm'), ' the motors'),
            ...line(['R'], h('b', null, 'Reset'), ' to the pad, or to the last gate in a race'),
            ...line(['T'], h('b', null, 'Turtle'), ' — flip back over after a crash'),
            ...line(['1', '2', '3', '4'], h('b', null, 'Flight mode'), ' — Cruise, Angle, Horizon, Acro'),
            ...line(['Q', 'E'], h('b', null, 'Auto roll'), ' left / right'),
            ...line(['Z', 'X'], h('b', null, 'Auto flip'), ' forward / back'),
            ...line(['C'], h('b', null, 'Camera'), ' — FPV, chase, line of sight'),
            ...line(['[', ']'], h('b', null, 'Camera tilt'), ' down / up'),
            ...line(['−', '='], h('b', null, 'Field of view'), ' narrower / wider'),
            ...line(['M'], h('b', null, 'Trackpad stick'), ' — pointer becomes pitch and roll'),
            ...line(['H'], h('b', null, 'Minimal HUD')),
            ...line(['⌫'], h('b', null, 'Restart'), ' the session'),
            ...line(['Esc'], h('b', null, 'Pause')),
          ),
          h('hr', { class: 'hr' }),
          h(
            'p',
            { class: 'note' },
            'In Acro there is no self-levelling, so every trick is yours to fly: hold ',
            h('kbd', null, '→'),
            ' for a roll, ',
            h('kbd', null, '↓'),
            ' with ',
            h('kbd', null, 'W'),
            ' for a power loop, half a roll then pull through for a split-S.',
          ),
        ),
        h(
          'footer',
          { class: 'actions' },
          first
            ? h('button', { class: 'btn btn--primary', onclick: () => this.takeOff() }, 'Take off', h('kbd', null, 'Enter'))
            : h('button', { class: 'btn', onclick: this.click(() => this.goBack(), 'back') }, 'Done', h('kbd', null, 'Esc')),
        ),
      ),
    );
    if (first) this.back = 'menu';
  }

  private renderPause(): void {
    const g = this.game;
    this.screens.pause.replaceChildren(
      h('div', { class: 'scrim' }),
      h(
        'div',
        { class: 'column' },
        h('header', { class: 'brand' }, h('h1', { class: 'title' }, 'Paused'), h('p', null, `${g.map.name} · ${g.cfg.name} · ${MODE_NOTES[this.store.data.flightMode][0]}`)),
        h(
          'div',
          { class: 'actions', style: 'flex-direction: column; align-items: stretch; max-width: 250px' },
          h('button', { class: 'btn btn--primary', style: 'justify-content: space-between', onclick: () => g.resume() }, 'Resume', h('kbd', null, 'Esc')),
          h('button', { class: 'btn', onclick: this.click(() => g.restart(), 'select') }, 'Restart'),
          h('button', { class: 'btn', onclick: this.click(() => ((this.back = 'pause'), this.open('controls'))) }, 'Controls'),
          h('button', { class: 'btn', onclick: this.click(() => ((this.back = 'pause'), this.open('settings'))) }, 'Settings'),
          h('button', { class: 'btn', onclick: this.click(() => g.toMenu(), 'back') }, 'Back to the hangar'),
        ),
      ),
    );
  }

  /** Remember the standing record before a run, so the results can show the margin. */
  noteBest(): void {
    this.previousBest = this.store.data.records[this.game.recordKey()]?.total ?? null;
  }

  private renderResults(): void {
    const r = this.lastResult;
    const g = this.game;
    if (!r) return;
    const prev = this.previousBest;
    let margin: HTMLElement | null = null;
    if (prev !== null) {
      const d = r.total - prev;
      margin = h('p', { class: 'note' }, d < 0 ? `${Math.abs(d).toFixed(3)} s inside your previous best.` : `${d.toFixed(3)} s off your best of ${formatTime(prev)}.`);
    }
    this.screens.results.replaceChildren(
      h('div', { class: 'scrim' }),
      h(
        'div',
        { class: 'column' },
        h(
          'header',
          { class: 'brand' },
          h('h1', { class: 'title' }, r.newRecord ? 'New personal best' : 'Run complete'),
          h('p', null, `${g.track?.name ?? ''} · ${g.cfg.name}`),
        ),
        h(
          'div',
          null,
          h('div', { class: 'result-time' }, clock(formatTime(r.total))),
          h('div', { class: 'medal', 'data-medal': r.medal }, h('i'), MEDALS[r.medal]),
          margin,
          h(
            'ul',
            { class: 'laps' },
            ...r.laps.map((t, i) => h('li', t === r.bestLap && r.laps.length > 1 ? { 'data-best': '' } : null, h('span', null, `Lap ${i + 1}`), h('span', null, clock(formatTime(t))))),
          ),
        ),
        h(
          'footer',
          { class: 'actions' },
          h('button', { class: 'btn btn--primary', onclick: () => g.restart() }, 'Go again', h('kbd', null, 'Enter')),
          h('button', { class: 'btn', onclick: this.click(() => g.toMenu(), 'back') }, 'Hangar'),
        ),
      ),
    );
    this.previousBest = this.store.data.records[g.recordKey()]?.total ?? null;
  }

  frame(): void {
    if (this.game.state === 'flying') this.hud.update(this.store.data);
  }
}
