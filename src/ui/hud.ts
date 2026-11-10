import { formatTime } from '../core/math';
import type { Settings } from '../core/settings';
import type { Game } from '../game/game';
import { h } from './dom';

const MODE_LABEL: Record<string, string> = { cruise: 'CRUISE', angle: 'ANGLE', horizon: 'HORIZON', acro: 'ACRO' };
const VIEW_LABEL: Record<string, string> = { fpv: 'FPV', chase: 'CHASE', los: 'LINE OF SIGHT' };

/**
 * In-flight overlay. Text lives in the DOM (crisp, cheap to update a few times a second); the
 * things that must track the picture every frame — horizon, gate marker, stick monitors — are
 * drawn on a canvas.
 */
export class Hud {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private mode = h('span', { class: 'tag' });
  private arm = h('span', { class: 'tag' });
  private viewLabel = h('span');
  private fps = h('span');
  private link = h('span');
  private top = h('div', { class: 'hud-tc' });
  private timer = h('div', { class: 'timer' });
  private sub = h('div', { class: 'sub' });
  private comboBar = h('i');
  private speed = h('b', null, '0');
  private speedUnit = h('i', null, 'km/h');
  private alt = h('b', null, '0');
  private prompt = h('div', { class: 'prompt' });
  private volts = h('span');
  private cellFill = h('i');
  private draw = h('div', { class: 'small' });
  private toasts = h('div', { class: 'toasts' });
  private tricks = h('div', { class: 'tricks' });
  private countdown = h('div', { class: 'countdown' });
  private frame = 0;
  private lastPrompt = '';
  private w = 0;
  private hgt = 0;
  private dpr = 1;

  constructor(private game: Game) {
    this.canvas = h('canvas');
    this.g = this.canvas.getContext('2d')!;
    this.el = h(
      'div',
      { class: 'hud' },
      this.canvas,
      h('div', { class: 'hud-tl' }, this.mode, this.arm),
      h('div', { class: 'hud-tr' }, this.viewLabel, this.link, this.fps),
      this.top,
      h(
        'div',
        { class: 'hud-bc' },
        this.prompt,
        h('div', { class: 'readouts' }, h('div', { class: 'readout' }, this.speed, this.speedUnit), h('div', { class: 'readout' }, this.alt, h('i', null, 'm'))),
      ),
      h('div', { class: 'hud-br' }, h('div', { class: 'volts' }, this.volts, h('i', null, 'V/cell')), h('div', { class: 'cell' }, this.cellFill), this.draw),
      this.toasts,
      this.tricks,
      this.countdown,
    );
    this.top.append(this.timer, this.sub, h('div', { class: 'combo-bar' }, this.comboBar));

    game.on('message', (m) => this.toast(m.text, m.tone, m.ms));
    game.on('trick', (e) => this.trick(e.name, e.points, e.multiplier));
    game.on('combo', (c) => {
      if (c.count > 1) this.toast(`Combo banked · ${Math.round(c.total).toLocaleString()}`, 'good', 2400);
    });
    game.on('countdown', (n) => this.count(n));
    game.on('lap', (l) => {
      if (l.lap < l.laps) this.toast(`Lap ${l.lap} · ${formatTime(l.time)}`, 'info', 2600);
    });
    game.on('flightMode', (m) => this.toast(`${MODE_LABEL[m]} mode`, 'info', 1300));
    game.on('view', (v) => this.toast(VIEW_LABEL[v], 'info', 1100));
  }

  show(on: boolean): void {
    this.el.toggleAttribute('data-on', on);
    if (!on) {
      this.toasts.replaceChildren();
      this.tricks.replaceChildren();
      this.countdown.replaceChildren();
    }
  }

  private toast(text: string, tone: string, ms: number): void {
    const el = h('div', { class: 'toast', 'data-tone': tone }, text);
    this.toasts.append(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild!.remove();
    setTimeout(() => el.setAttribute('data-out', ''), ms);
    setTimeout(() => el.remove(), ms + 320);
  }

  private trick(name: string, points: number, mult: number): void {
    const el = h('div', { class: 'trick' }, name, h('small', null, `+${Math.round(points).toLocaleString()}${mult > 1 ? ` ×${mult.toFixed(1)}` : ''}`));
    this.tricks.append(el);
    while (this.tricks.children.length > 4) this.tricks.firstElementChild!.remove();
    setTimeout(() => el.setAttribute('data-out', ''), 1900);
    setTimeout(() => el.remove(), 2350);
  }

  private count(n: number): void {
    const el = h('span', n === 0 ? { 'data-go': '' } : null, n === 0 ? 'GO' : String(n));
    this.countdown.replaceChildren(el);
    setTimeout(() => el.remove(), 950);
  }

  private setPrompt(key: string, parts: (string | [string])[]): void {
    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    this.prompt.replaceChildren(...parts.map((p) => (typeof p === 'string' ? h('span', null, p) : h('kbd', null, p[0]))));
  }

  update(s: Settings): void {
    const t = this.game.telemetry;
    this.drawCanvas(s);
    if (this.frame++ % 4 !== 0) return;

    const mph = s.hud.units === 'mph';
    this.speed.textContent = String(Math.round(t.speed * (mph ? 2.23694 : 3.6)));
    this.speedUnit.textContent = mph ? 'mph' : 'km/h';
    this.alt.textContent = t.agl < 10 ? t.agl.toFixed(1) : String(Math.round(t.agl));

    this.mode.textContent = MODE_LABEL[s.flightMode];
    this.arm.textContent = t.crashed ? 'CRASHED' : t.armed ? 'ARMED' : 'DISARMED';
    this.arm.setAttribute('data-tone', t.crashed ? 'bad' : t.armed ? 'live' : 'idle');
    this.viewLabel.textContent = VIEW_LABEL[s.view];
    this.fps.textContent = `${Math.round(t.fps)} FPS`;
    this.link.textContent = `LINK ${Math.round(t.link * 100)}%`;
    this.link.style.color = t.link < 0.5 ? 'var(--bad)' : '';

    this.volts.textContent = t.cellVolts.toFixed(2);
    this.cellFill.style.transform = `scaleX(${t.battery.toFixed(3)})`;
    this.draw.textContent = s.sim.battery ? `${Math.round(t.mah)} mAh · ${Math.round(t.current)} A` : `${Math.round(t.current)} A`;
    const batt = !s.sim.battery ? 'ok' : t.cellVolts < 3.3 ? 'critical' : t.cellVolts < 3.5 ? 'low' : 'ok';
    this.el.setAttribute('data-batt', batt);
    this.el.toggleAttribute('data-minimal', s.hud.minimal);

    // top centre: race clock or freestyle score
    if (t.raceState !== 'none') {
      this.timer.textContent = t.raceState === 'idle' ? formatTime(0) : formatTime(t.raceTime);
      const parts: (Node | string)[] = [h('span', null, 'LAP ', h('b', null, `${t.lap}/${t.laps}`)), h('span', null, 'GATE ', h('b', null, `${t.gatesPassed}/${t.gatesTotal}`))];
      if (t.delta !== null) {
        const sign = t.delta <= 0 ? '-' : '+';
        parts.push(h('span', { class: 'delta', 'data-sign': sign }, `${sign}${Math.abs(t.delta).toFixed(3)}`));
      } else if (t.best !== null) parts.push(h('span', null, 'BEST ', h('b', null, formatTime(t.best))));
      this.sub.replaceChildren(...parts);
      this.comboBar.style.transform = 'scaleX(0)';
    } else {
      this.timer.textContent = Math.round(t.score).toLocaleString();
      if (t.comboCount > 0) {
        this.sub.replaceChildren(h('span', null, 'COMBO ', h('b', null, `×${t.multiplier.toFixed(1)}`)), h('span', null, h('b', null, Math.round(t.combo).toLocaleString())));
        this.comboBar.style.transform = `scaleX(${Math.min(1, t.comboLeft / 3).toFixed(3)})`;
      } else {
        this.sub.replaceChildren(h('span', null, 'FREESTYLE'));
        this.comboBar.style.transform = 'scaleX(0)';
      }
    }

    // one line of coaching, only when it is useful
    if (t.crashed) this.setPrompt('crash', [['R'], 'reset', ['T'], 'flip over']);
    else if (!t.armed) this.setPrompt('arm', [['Space'], 'arm the motors']);
    else if (t.raceState === 'countdown') this.setPrompt('hold', ['Hold steady — launch on the tone']);
    else if (t.landed && s.controls.throttle === 'spring') this.setPrompt('lift', [['W'], 'take off', ['S'], 'descend']);
    else if (t.landed) this.setPrompt('lift2', [['W'], 'raise throttle']);
    else if (s.sim.battery && t.cellVolts < 3.3) this.setPrompt('land', ['Battery critical — land now']);
    else this.setPrompt('', []);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.el.clientWidth;
    const hh = this.el.clientHeight;
    if (w === this.w && hh === this.hgt && dpr === this.dpr) return;
    this.w = w;
    this.hgt = hh;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hh * dpr);
  }

  private drawCanvas(s: Settings): void {
    this.resize();
    const g = this.g;
    const t = this.game.telemetry;
    const W = this.w;
    const H = this.hgt;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const ink = 'rgba(243,241,236,0.92)';
    const dim = 'rgba(243,241,236,0.5)';
    g.lineCap = 'round';
    g.shadowColor = 'rgba(0,0,0,0.75)';
    g.shadowBlur = 3;

    const fpv = s.view === 'fpv';
    if (fpv && s.hud.horizon && !s.hud.minimal) {
      // artificial horizon: where level flight sits in this camera, with a pitch ladder
      const tilt = s.camera.tilt ?? this.game.cfg.camTilt;
      const fov = (s.camera.fov * Math.PI) / 180;
      const pxPerRad = H / 2 / Math.tan(fov / 2);
      const camPitch = ((t.pitch + tilt) * Math.PI) / 180;
      g.save();
      g.translate(cx, cy);
      g.rotate((-t.roll * Math.PI) / 180);
      const y0 = Math.tan(camPitch) * pxPerRad;
      g.lineWidth = 1.25;
      for (let deg = -60; deg <= 60; deg += 10) {
        const y = y0 - Math.tan((deg * Math.PI) / 180) * pxPerRad * Math.cos(camPitch) ** 2;
        if (Math.abs(y) > H * 0.36) continue;
        const half = deg === 0 ? Math.min(210, W * 0.2) : 34;
        const gap = deg === 0 ? 46 : 14;
        g.strokeStyle = deg === 0 ? ink : dim;
        g.beginPath();
        g.moveTo(-half, y);
        g.lineTo(-gap, y);
        g.moveTo(gap, y);
        g.lineTo(half, y);
        g.stroke();
        if (deg !== 0) {
          g.fillStyle = dim;
          g.font = '10px "B612 Mono", monospace';
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          g.fillText(String(Math.abs(deg)), half + 6, y);
        }
      }
      g.restore();
    }

    if (fpv) {
      // fixed aircraft symbol
      g.strokeStyle = ink;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, 3, 0, Math.PI * 2);
      g.moveTo(cx - 20, cy);
      g.lineTo(cx - 8, cy);
      g.moveTo(cx + 8, cy);
      g.lineTo(cx + 20, cy);
      g.moveTo(cx, cy - 8);
      g.lineTo(cx, cy - 13);
      g.stroke();
    }

    // next gate: brackets when it's in view, a chevron on the frame edge when it isn't
    if (t.hasGate) {
      const go = 'rgba(43,245,154,0.95)';
      g.strokeStyle = go;
      g.fillStyle = go;
      g.lineWidth = 2;
      if (t.gateVisible) {
        const x = cx + t.gateX * cx;
        const y = cy - t.gateY * cy;
        const r = Math.max(14, Math.min(70, 900 / Math.max(t.gateDistance, 4)));
        const c = r * 0.38;
        g.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          g.moveTo(x + sx * r, y + sy * (r - c));
          g.lineTo(x + sx * r, y + sy * r);
          g.lineTo(x + sx * (r - c), y + sy * r);
        }
        g.stroke();
        g.font = '700 11px "B612 Mono", monospace';
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillText(`${Math.round(t.gateDistance)} m`, x, y + r + 6);
      } else {
        const a = Math.atan2(-t.gateY, t.gateX);
        const rx = cx - 70;
        const ry = cy - 70;
        const k = Math.min(rx / Math.abs(Math.cos(a) || 1e-6), ry / Math.abs(Math.sin(a) || 1e-6));
        const x = cx + Math.cos(a) * k;
        const y = cy + Math.sin(a) * k;
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.beginPath();
        g.moveTo(14, 0);
        g.lineTo(-8, -11);
        g.lineTo(-2, 0);
        g.lineTo(-8, 11);
        g.closePath();
        g.fill();
        g.restore();
        g.font = '700 11px "B612 Mono", monospace';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(`${Math.round(t.gateDistance)} m`, x - Math.cos(a) * 34, y - Math.sin(a) * 26);
      }
    }

    // stick monitors
    if (s.hud.sticks && !s.hud.minimal) {
      const size = 62;
      const y = H - 28 - size;
      const input = this.game.input;
      const pairs: [number, { x: number; y: number }][] = [
        [28, input.left],
        [28 + size + 12, input.right],
      ];
      for (const [x, st] of pairs) {
        g.lineWidth = 1;
        g.strokeStyle = dim;
        g.fillStyle = 'rgba(10,11,12,0.34)';
        g.shadowBlur = 0;
        g.beginPath();
        g.roundRect(x, y, size, size, 6);
        g.fill();
        g.stroke();
        g.strokeStyle = 'rgba(243,241,236,0.18)';
        g.beginPath();
        g.moveTo(x + size / 2, y + 6);
        g.lineTo(x + size / 2, y + size - 6);
        g.moveTo(x + 6, y + size / 2);
        g.lineTo(x + size - 6, y + size / 2);
        g.stroke();
        const px = x + size / 2 + st.x * (size / 2 - 7);
        const py = y + size / 2 - st.y * (size / 2 - 7);
        g.fillStyle = ink;
        g.shadowBlur = 3;
        g.beginPath();
        g.arc(px, py, 4, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}
