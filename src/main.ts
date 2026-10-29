import './style.css';
import type { DuoPhysics } from './physics';
import type { DuoView } from './view';
import type { DuoInput } from './input';
import { GameRules } from './rules';
import { GameUI } from './ui';
import { DuoAudio } from './audio';
import { DuoFeedback } from './feedback';
import { DuoHaptics } from './haptics';
import { FIXED_DT } from './config';
import type { FeedbackEvent, Mode, PhysicsSample, RoundResult } from './types';

const rules = new GameRules();
const audio = new DuoAudio();
const feedback = new DuoFeedback();
const haptics = new DuoHaptics();
const pendingFeedback: FeedbackEvent[] = [];
let feedbackActive = false;
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
  onFinish: () => { input?.releaseAll(); stopFeedback(); rules.finish(); },
  onSound: () => { unlockFeedback(); rules.toggleSound(); audio.setEnabled(rules.state.sound); },
  onHelp: () => { input?.releaseAll(); unlockFeedback(); },
  onHaptics: () => { haptics.toggle(); haptics.unlock(); ui.setHaptics(haptics.enabled, haptics.supported); },
  onClearDesk: () => clearDesk(),
  onExport: () => exportResult(),
});

function reset(mode: Mode) {
  if (!ready) return;
  input.releaseAll();
  stopFeedback();
  if (!physics.replace()) {
    ui.toast('桌面放满了，先清一下再换新');
    ui.setDesk(true, true);
    return;
  }
  roundToken++;
  physics.setViewBounds(view.camera);
  rules.reset(mode);
  view.resetDisplay();
  sample = { angle: 170, angularSpeed: 0, strain: 0, impact: 0, hardStop: 0, speed: 0 };
  displayedResult = null;
  resultImage = '';
  accumulator = 0;
  syncView();
  ui.update(rules.state, sample, 0);
}

function simulate() {
  const wasRunning = rules.state.running;
  sample = physics.step(FIXED_DT);
  rules.step(sample, FIXED_DT);
  physics.setDamage(rules.state);
  input?.reconcile();
  if (wasRunning) pendingFeedback.push(...feedback.step(sample, rules.state, rules.events, FIXED_DT));
}

function syncView() {
  view.sync(physics.poses, rules.state, sample, physics.fragments, physics.retiredPhones, physics.activeVisible);
  ui.setDesk(physics.retiredPhones.length > 0 || physics.fragments.length > 0, physics.retiredPhones.length >= 6);
}

function stopFeedback() {
  feedbackActive = false;
  audio.stop(); haptics.stop(); feedback.reset(); pendingFeedback.length = 0;
  view?.clearFeedback();
}

function unlockFeedback() {
  audio.unlock(); haptics.unlock(); feedbackActive = true; pendingFeedback.length = 0;
}

function clearDesk() {
  if (!ready) return;
  input.releaseAll(); stopFeedback(); physics.clearDesk(); syncView();
}

function playFeedback() {
  if (!feedbackActive) { pendingFeedback.length = 0; return; }
  const centre = physics.poses[0].position.clone().add(physics.poses[1].position).multiplyScalar(.5);
  feedback.frame.pan = Math.max(-.85, Math.min(.85, centre.clone().project(view.camera).x));
  for (const event of pendingFeedback) {
    if (!event.point) event.point = centre.clone();
    event.pan = Math.max(-.85, Math.min(.85, event.point.clone().project(view.camera).x));
    audio.play(event); view.feedback(event);
  }
  haptics.play(pendingFeedback);
  pendingFeedback.length = 0;
  audio.tick(rules.state.running ? feedback.frame : { ...feedback.frame, angularSpeed: 0, signedSpeed: 0, scrapeSpeed: 0, broken: true });
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
  syncView();
  playFeedback();
  view.render(now / 1000, physics.grips.values());
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
ui.canvas.addEventListener('pointerdown', () => { unlockFeedback(); audio.setEnabled(rules.state.sound); }, { passive: true });
ui.canvas.addEventListener('pointercancel', () => haptics.stop());
document.addEventListener('visibilitychange', () => { input?.releaseAll(); stopFeedback(); accumulator = 0; lastFrame = performance.now(); });
window.addEventListener('blur', () => { input?.releaseAll(); stopFeedback(); });
window.addEventListener('pagehide', () => { input?.releaseAll(); stopFeedback(); });

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
    syncView();
    input = new DuoInput(ui.canvas, view.camera, view.halves, view.pickables, physics,
      () => { audio.unlock(); audio.setEnabled(rules.state.sound); }, message => ui.toast(message));
    ready = true;
    audio.setEnabled(rules.state.sound);
    ui.setReady();
    ui.setHaptics(haptics.enabled, haptics.supported);
    // Development-only diagnostics. Never part of the production player interface.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('qa')) {
      Object.assign(window, { __duo: { physics, rules, view, input, audio, haptics, feedback,
        get sample() { return sample; },
        advance: (count = 1) => { for (let i = 0; i < count; i++) simulate(); syncView(); },
      } });
    }
    requestAnimationFrame(update);
  } catch (error) {
    console.error(error);
    ui.showError('画面未能启动。请使用支持 3D 图形的浏览器，或刷新重试。');
  }
}
void start();
