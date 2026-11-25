import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../src/game/game';

/**
 * The repo has no browser test runner, so this drives the Radio and Tuning tabs against a very
 * small fake DOM: enough to build them, press their buttons and feed them a fake gamepad. It
 * catches crashes and wiring mistakes, not layout. Layout still needs a look in a real browser.
 */

class FakeEl {
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  style: Record<string, string> & { setProperty: (k: string, v: string) => void };
  className = '';
  value = '';
  checked = false;
  textContent = '';
  isConnected = true;
  width = 0;
  height = 0;
  constructor(readonly tagName: string) {
    const style = {} as Record<string, string> & { setProperty: (k: string, v: string) => void };
    style.setProperty = (k, v) => (style[k] = v);
    this.style = style;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'width') this.width = Number(v);
    if (k === 'height') this.height = Number(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  toggleAttribute(k: string, on?: boolean): void {
    if (on === false || (on === undefined && k in this.attrs)) delete this.attrs[k];
    else this.attrs[k] = '';
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  append(...kids: (FakeEl | string)[]): void {
    for (const k of kids) if (typeof k !== 'string') this.children.push(k);
      else this.textContent += k;
  }
  getContext(): null {
    return null;
  }
  fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn({ target: this });
  }
  /** Depth-first search for elements whose own text (or a child string) matches. */
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => {
      if (pred(e)) out.push(e);
      e.children.forEach(walk);
    };
    walk(this);
    return out;
  }
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join('');
  }
}

function tree(els: FakeEl[]): FakeEl {
  const root = new FakeEl('root');
  root.children = els;
  return root;
}

function button(root: FakeEl, label: string): FakeEl {
  const b = root.find((e) => e.tagName === 'button' && e.text() === label)[0];
  if (!b) throw new Error(`no button "${label}" in ${root.text().slice(0, 400)}`);
  return b;
}

describe('Radio and Tuning tabs', () => {
  let stored: string | null;
  let pad: { id: string; connected: boolean; mapping: string; axes: number[]; buttons: { pressed: boolean }[] } | null;

  beforeEach(() => {
    stored = null;
    pad = { id: 'EdgeTX Radiomaster TX16S Joystick', connected: true, mapping: '', axes: [0, 0, -1, 0, -1, -1, 0, 0], buttons: Array.from({ length: 24 }, () => ({ pressed: false })) };
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag) });
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_k: string, v: string) => (stored = v) });
    vi.stubGlobal('navigator', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  async function radio() {
    const { SettingsStore } = await import('../src/core/settings');
    const { RadioPanel } = await import('../src/ui/setup');
    const store = new SettingsStore();
    let view = tree([]);
    const game = { input: { findPad: () => pad } } as unknown as Game;
    const panel: InstanceType<typeof RadioPanel> = new RadioPanel(store, game, () => (view = tree(panel.render() as unknown as FakeEl[])));
    view = tree(panel.render() as unknown as FakeEl[]);
    return { store, panel, view: () => view };
  }

  it('renders with and without a controller', async () => {
    const r = await radio();
    r.panel.tick();
    expect(r.view().text()).toContain('EdgeTX Radiomaster TX16S Joystick');
    pad = null;
    r.panel.tick();
    expect(r.view().text()).toContain('No gamepad or radio found');
  });

  it('loads a preset, detects a stick and calibrates', async () => {
    const r = await radio();
    button(r.view(), 'EdgeTX radio, AETRdocumented order').fire('click');
    expect(r.store.data.radio.preset).toBe('edgetx-aetr');
    expect(r.store.data.radio.throttle).toBe('absolute');

    // detect yaw: the pilot pushes the stick on axis 3 to the left, so it reads inverted
    const yawRow = r.view().find((e) => e.className === 'chan' && e.text().startsWith('Yaw'))[0];
    button(yawRow, 'Detect').fire('click');
    expect(r.view().text()).toContain('Push the yaw stick to the right');
    pad!.axes[3] = -0.9;
    r.panel.tick();
    expect(r.store.data.radio.channels.yaw).toMatchObject({ axis: 3, invert: true });

    // calibrate: centre snapshot, then a sweep
    button(r.view(), 'Calibrate').fire('click');
    pad!.axes = [0.02, -0.03, -0.97, 0.01, -1, -1, 0, 0];
    button(r.view(), 'Next').fire('click');
    for (const v of [-0.9, 0.92]) {
      pad!.axes = [v, v, v, v, -1, -1, 0, 0];
      r.panel.tick();
    }
    button(r.view(), 'Done').fire('click');
    expect(r.view().text()).toContain('Calibrated.');
    expect(r.store.data.radio.channels.roll).toMatchObject({ min: -0.9, max: 0.92, center: 0.02 });
    // saved to local storage
    expect(JSON.parse(stored!).radio.channels.roll.max).toBe(0.92);
  });

  it('detects an arm switch on a button and a mode switch on an axis', async () => {
    const r = await radio();
    button(r.view(), 'EdgeTX radio, AETRdocumented order').fire('click');
    const armRow = r.view().find((e) => e.className === 'chan chan--switch' && e.text().startsWith('Arm'))[0];
    button(armRow, 'Detect').fire('click');
    pad!.buttons[6].pressed = true;
    r.panel.tick();
    expect(r.store.data.radio.arm).toEqual({ kind: 'button', index: 6, invert: false });

    const modeRow = r.view().find((e) => e.className === 'chan chan--switch' && e.text().startsWith('Flight mode'))[0];
    button(modeRow, 'Detect').fire('click');
    pad!.axes[5] = 1;
    r.panel.tick();
    expect(r.store.data.radio.mode).toMatchObject({ kind: 'axis', index: 5 });
    const high = r.view().find((e) => e.tagName === 'select' && e.attrs['aria-label'] === 'Mode switch high')[0];
    high.value = 'horizon';
    high.fire('change');
    expect(r.store.data.radio.mode).toMatchObject({ high: 'horizon' });
  });

  it('imports Betaflight rates, edits the rate loop and goes back to stock', async () => {
    const { SettingsStore } = await import('../src/core/settings');
    const { TuningPanel } = await import('../src/ui/setup');
    const store = new SettingsStore();
    let view = tree([]);
    const panel: InstanceType<typeof TuningPanel> = new TuningPanel(store, () => (view = tree(panel.render() as unknown as FakeEl[])));
    view = tree(panel.render() as unknown as FakeEl[]);
    expect(view.text()).toContain('flies its stock tune');

    const box = view.find((e) => e.tagName === 'textarea')[0];
    box.value = 'rateprofile 0\nset rates_type = BETAFLIGHT\nset roll_rc_rate = 120\nset roll_srate = 70';
    box.fire('input');
    button(view, 'Import from Betaflight').fire('click');
    expect(store.data.tuning.freestyle5.rates).toMatchObject({ type: 'BETAFLIGHT', roll: { rcRate: 120, rate: 70 } });
    expect(view.text()).toContain('Imported Betaflight rates from rate profile 0');

    const response = view.find((e) => e.tagName === 'input' && e.attrs['aria-label'] === 'Response')[0];
    response.value = '55';
    response.fire('change');
    expect(store.data.tuning.freestyle5.ctrl).toMatchObject({ bandwidth: 55 });

    button(view, 'Use stock rates').fire('click');
    button(view, 'Use stock rate loop').fire('click');
    expect(store.data.tuning.freestyle5).toBeUndefined();
  });
});
