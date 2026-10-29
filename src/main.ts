import './style.css';
import type { DuoPhysics } from './physics';
import type { DuoView } from './view';
import type { DuoInput } from './input';
import { GameRules } from './rules';
import { GameUI } from './ui';
import { DuoAudio } from './audio';
import { FIXED_DT } from './config';
import type { Mode, PhysicsSample, RoundResult } from './types';

const rules = new GameRules();
const audio = new DuoAudio();
let physics: DuoPhysics;
let view: DuoView;
let input: DuoInput;
let ready = false;
let lastFrame = 0;
let accumulator = 0;
let roundToken = 0;
let displayedResult: RoundResult | null = null;
let resultImage = '';
let sample: PhysicsSample = { angle: 180, angularSpeed: 0, strain: 0, impact: 0, hardStop: 0, speed: 0 };

const ui = new GameUI(document.querySelector<HTMLElement>('#app')!, {
  onMode: mode => reset(mode),
  onReset: () => reset(rules.state.mode),
  onFinish: () => { input?.releaseAll(); rules.finish(); },
  onSound: () => { audio.unlock(); rules.toggleSound(); audio.setEnabled(rules.state.sound); },
  onHelp: () => { input?.releaseAll(); audio.unlock(); },
  onExport: () => exportResult(),
});

function reset(mode: Mode) {
  if (!ready) return;
  roundToken++;
  input.releaseAll();
  physics.reset();
  physics.setViewBounds(view.camera);
  rules.reset(mode);
  sample = { angle: 170, angularSpeed: 0, strain: 0, impact: 0, hardStop: 0, speed: 0 };
  displayedResult = null;
  resultImage = '';
  accumulator = 0;
  view.sync(physics.poses, rules.state, sample, physics.fragments);
  ui.update(rules.state, sample, 0);
}

function simulate() {
  sample = physics.step(FIXED_DT);
  rules.step(sample, FIXED_DT);
  physics.setDamage(rules.state);
  for (const event of rules.events) audio.play(event, event === 'impact' ? sample.impact / 8 : Math.max(.3, sample.strain));
}

function update(now: number) {
  requestAnimationFrame(update);
  if (!ready || document.hidden) { lastFrame = now; return; }
  const dt = Math.min(.05, Math.max(0, (now - (lastFrame || now)) / 1000));
  lastFrame = now;
  accumulator += dt;
  while (accumulator >= FIXED_DT) {
    simulate();
    accumulator -= FIXED_DT;
  }
  view.sync(physics.poses, rules.state, sample, physics.fragments);
  view.render(now / 1000, physics.grips.values());
  audio.tick(sample.angularSpeed, sample.strain);
  ui.update(rules.state, sample, physics.grips.size);
  if (rules.state.result && rules.state.result !== displayedResult) {
    displayedResult = rules.state.result;
    input.releaseAll();
    const result = displayedResult;
    const token = roundToken;
    window.setTimeout(() => {
      if (token !== roundToken) return;
      resultImage = view.capture();
      ui.showResult(result, resultImage);
    }, 700);
  }
}

async function exportResult() {
  if (!resultImage) return;
  const card = await ui.exportCard();
  ui.showImage(card);
  if (matchMedia('(pointer: fine)').matches) {
    const a = document.createElement('a'); a.href = card;
    a.download = `apple-duo-${rules.state.result?.score ?? 0}.png`; a.click();
  }
}

function resize() {
  const bounds = ui.canvas.getBoundingClientRect();
  if (view) view.resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)));
  if (ready) { input.releaseAll(); physics.setViewBounds(view.camera); }
}
let resizeFrame = 0;
function scheduleResize() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; resize(); });
}
window.addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);
new ResizeObserver(scheduleResize).observe(ui.canvas);
ui.canvas.addEventListener('contextmenu', event => event.preventDefault());
ui.canvas.addEventListener('pointerdown', () => { audio.unlock(); audio.setEnabled(rules.state.sound); }, { passive: true });
document.addEventListener('visibilitychange', () => { input?.releaseAll(); accumulator = 0; lastFrame = performance.now(); });
window.addEventListener('blur', () => input?.releaseAll());
window.addEventListener('pagehide', () => { input?.releaseAll(); });

async function start() {
  try {
    // Paint the lightweight interface while mobile browsers fetch the 3D engine and WASM.
    const [{ DuoView }, { DuoPhysics }, { DuoInput }] = await Promise.all([
      import('./view'), import('./physics'), import('./input'),
    ]);
    view = new DuoView(ui.canvas);
    resize();
    physics = await DuoPhysics.create();
    physics.setViewBounds(view.camera);
    view.sync(physics.poses, rules.state, sample, physics.fragments);
    input = new DuoInput(ui.canvas, view.camera, view.halves, view.pickables, physics,
      () => { audio.unlock(); audio.setEnabled(rules.state.sound); }, message => ui.toast(message));
    ready = true;
    audio.setEnabled(rules.state.sound);
    ui.setReady();
    // Development-only diagnostics. Never part of the production player interface.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('qa')) {
      Object.assign(window, { __duo: { physics, rules, view, input,
        get sample() { return sample; },
        advance: (count = 1) => { for (let i = 0; i < count; i++) simulate(); view.sync(physics.poses, rules.state, sample, physics.fragments); },
      } });
    }
    requestAnimationFrame(update);
  } catch (error) {
    console.error(error);
    ui.showError('画面未能启动。请使用支持 3D 图形的浏览器，或刷新重试。');
  }
}
void start();
