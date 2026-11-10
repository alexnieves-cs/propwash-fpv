import './ui/ui.css';
import { SettingsStore } from './core/settings';
import { Game } from './game/game';
import { Engine, QUALITY } from './render/engine';
import { TextureForge } from './render/textures';
import { initPhysics } from './sim/physics-world';
import { h } from './ui/dom';
import { Shell } from './ui/shell';

async function boot(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const ui = document.getElementById('ui') as HTMLElement;
  if (!canvas.getContext('webgl2')) {
    ui.append(h('p', { style: 'position:absolute;left:44px;top:44px;max-width:44ch;pointer-events:auto' }, 'Propwash needs WebGL 2, which this browser or GPU does not provide. Try a current version of Chrome, Edge, Firefox or Safari.'));
    return;
  }
  const store = new SettingsStore();
  const engine = new Engine(canvas, QUALITY[store.data.quality]);
  const forge = new TextureForge(engine.renderer, engine.maxAnisotropy);
  const game = new Game(engine, forge, store, canvas);
  const shell = new Shell(ui, game, store);
  await initPhysics();
  // handy when poking at the sim from the console
  (window as unknown as Record<string, unknown>).propwash = { game, engine, store };

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    game.frame(dt);
    shell.frame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await game.load();
}

void boot();
