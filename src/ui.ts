import type { GameState, Mode, PhysicsSample, RoundResult } from './types';

type Callbacks = {
  onMode: (mode: Mode) => void; onReset: () => void; onFinish: () => void;
  onSound: () => void; onHelp: () => void; onExport: () => void;
};
const number = (n: number) => Math.round(n).toLocaleString('zh-CN');
const icons = {
  reset: '<path d="M3 10a9 9 0 1 1 2.5 8.2M3 4v6h6"/>',
  sound: '<path d="m11 5-6 4H2v6h3l6 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="m11 5-6 4H2v6h3l6 4zM16 9l6 6m0-6-6 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4M12 17h.01"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
const icon = (name: keyof typeof icons) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

export class GameUI {
  canvas: HTMLCanvasElement;
  private root: HTMLElement;
  private result: RoundResult | null = null;
  private resultImage = '';
  private toastTimer = 0;
  private hintTimer = 0;
  private previousFolds = 0;
  private refs: Record<string, HTMLElement> = {};
  private buttons: Record<string, HTMLButtonElement> = {};
  private rendered = new Map<string, string | number | boolean>();

  constructor(container: HTMLElement, private callbacks: Callbacks) {
    container.innerHTML = `
      <canvas class="play-canvas" aria-label="可抓取和折叠的 iPhone Duo 模拟机"></canvas>
      <div class="interface">
        <header class="masthead">
          <div class="brand"><div class="wordmark">Apple <strong>DUO</strong></div></div>
          <button class="icon-button menu-toggle" data-action="menu" aria-label="更多选项" aria-expanded="false" aria-controls="duo-menu">${icon('more')}</button>
        </header>
        <section class="options-panel" id="duo-menu" data-ref="menu" aria-label="更多选项" hidden>
          <nav class="mode-switch" aria-label="游玩模式"><button data-action="free" class="selected" aria-pressed="true">自由把玩</button><button data-action="challenge" aria-pressed="false">耐久挑战</button></nav>
          <div class="menu-options"><button data-action="sound" aria-label="关闭音效">${icon('sound')}<span data-ref="soundLabel">音效开启</span></button><button data-action="help">${icon('help')}<span>怎么玩</span></button></div>
          <div class="best-record" data-ref="record">本机纪录 <strong>0</strong></div>
        </section>
        <aside class="telemetry" data-ref="telemetry" aria-label="本局状态" hidden>
          <div class="score-row"><div class="main-stat"><span class="stat-label">完整开合</span><div><strong data-ref="folds">0</strong><span class="unit">次</span></div></div><div class="points-stat" data-ref="pointsBlock"><span class="stat-label">本局积分</span><strong data-ref="score">0</strong><span class="combo" data-ref="combo">×1.0</span></div></div>
          <div class="health-section">
            <div class="health-row"><span>屏幕</span><div class="health-track"><i data-ref="screenBar"></i></div><span data-ref="screen">100%</span></div>
            <div class="health-row"><span>铰链</span><div class="health-track"><i data-ref="hingeBar"></i></div><span data-ref="hinge">100%</span></div>
          </div>
        </aside>
        <div class="live-feedback" data-ref="feedback" hidden><span class="force-dot" data-ref="forceDot"></span><span data-ref="forceLabel">轻轻拿起</span><div class="force-track"><i data-ref="forceBar"></i></div></div>
        <div class="interaction-hint" data-ref="hint" hidden>按住机身拖动，松手落下</div>
        <footer class="footer">
          <div class="actions"><button class="reset-button" data-action="reset">${icon('reset')}<span>换新</span></button><button class="bank-button" data-action="finish" hidden>收手结算${icon('arrow')}</button></div>
        </footer>
      </div>
      <div class="loading-pill" role="status" data-ref="loading"><span class="spinner"></span>正在准备你的 DUO</div>
      <div class="toast" role="status" data-ref="toast" hidden></div>
      <section class="help-panel" data-ref="help" hidden aria-label="玩法说明"><button class="icon-button panel-close" data-action="closeHelp" aria-label="关闭说明">${icon('close')}</button><span class="eyebrow">上手很简单</span><h2>抓住。甩开。轻轻合上。</h2><p>按住可见机身拖动，松手就会落下。抓住不同位置，感受不同的惯性。</p><p>两个内屏都朝向你、抓点无遮挡时，双指可以各抓一半。抓住后翻转也不会脱手。</p><p><strong>电脑双手：</strong>按住 Shift，单击留住一个抓点，再拖另一半。松开 Shift 释放留住的抓点。</p><div class="help-rule"><strong>耐久挑战</strong><p>展开 → 合拢 → 再展开，算一次完整开合。平顺动作和连续节奏有额外积分。正常折叠不伤机，猛甩、硬掰和摔落才会损坏。</p><p>主动收手按剩余耐久获得加成。折坏仍保留已得积分。</p></div></section>
      <div class="modal-backdrop" data-ref="resultModal" hidden><section class="result-card" role="dialog" aria-modal="true" aria-labelledby="result-title"><div class="result-photo"><img data-ref="resultPhoto" alt="本局 DUO 的最终状态"/><span class="result-photo-label">APPLE DUO / FOLD SESSION</span></div><div class="result-content"><span class="eyebrow" data-ref="resultEyebrow">漂亮收手</span><h2 id="result-title" data-ref="resultTitle">留一点余地，下次再玩。</h2><div class="result-score"><strong data-ref="resultScore">0</strong><span>积分</span><div><b data-ref="resultFolds">0</b> 次完整开合</div></div><div class="result-detail" data-ref="resultDetail"></div><div class="result-buttons"><button class="primary-button" data-action="again">再玩一次${icon('arrow')}</button><button class="secondary-button" data-action="export">${icon('download')}保存结果卡</button></div><p class="result-note">本机纪录 · 每一次开合，都算数</p></div></section></div>
      <div class="modal-backdrop image-modal" data-ref="imageModal" hidden><section role="dialog" aria-modal="true" aria-label="保存结果图片"><button class="icon-button image-close" data-action="closeImage" aria-label="关闭图片">${icon('close')}</button><img data-ref="exportImage" alt="DUO 本局结果卡，可长按保存"/><p>长按图片保存，或<a data-ref="download" download="apple-duo-session.png">下载图片</a></p></section></div>`;
    this.root = container;
    this.canvas = container.querySelector('canvas')!;
    container.querySelectorAll<HTMLElement>('[data-ref]').forEach(el => this.refs[el.dataset.ref!] = el);
    container.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(el => this.buttons[el.dataset.action!] = el);
    for (const action of ['free', 'challenge', 'reset', 'finish']) this.buttons[action].disabled = true;
    this.action('free', () => this.changeMode('free'));
    this.action('challenge', () => this.changeMode('challenge'));
    this.action('reset', () => this.reset());
    this.action('again', () => this.reset());
    this.action('finish', () => callbacks.onFinish());
    this.action('sound', () => callbacks.onSound());
    this.action('menu', () => { this.setMenu(this.refs.menu.hidden); callbacks.onHelp(); });
    this.action('help', () => { this.showHelp(); callbacks.onHelp(); });
    this.action('closeHelp', () => this.refs.help.hidden = true);
    this.action('export', () => callbacks.onExport());
    this.action('closeImage', () => this.refs.imageModal.hidden = true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { this.setMenu(false); this.refs.help.hidden = true; this.refs.imageModal.hidden = true; } });
    document.addEventListener('pointerdown', event => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.options-panel, .menu-toggle')) this.setMenu(false);
    });
  }

  update(state: GameState, sample: PhysicsSample, gripCount: number) {
    const r = this.refs;
    this.text('folds', number(state.folds));
    this.text('score', number(state.score));
    this.text('combo', `×${state.multiplier.toFixed(1)}`);
    if (this.changed('comboActive', state.multiplier > 1)) r.combo.classList.toggle('active', state.multiplier > 1);
    if (this.changed('mode', state.mode)) {
      this.root.dataset.mode = state.mode;
      r.telemetry.hidden = state.mode === 'free';
      r.pointsBlock.hidden = state.mode === 'free';
      for (const mode of ['free', 'challenge']) {
        const button = this.buttons[mode];
        button.classList.toggle('selected', mode === state.mode);
        button.setAttribute('aria-pressed', String(mode === state.mode));
      }
    }
    if (this.changed('record', `${state.bestScore}:${state.bestFolds}`)) {
      r.record.innerHTML = `本机纪录 <strong>${number(state.bestScore)}</strong><span>分 · ${number(state.bestFolds)} 次</span>`;
    }
    for (const part of ['screen', 'hinge'] as const) {
      this.text(part, `${Math.ceil(state[part])}%`);
      this.style(`${part}Bar`, 'width', `${state[part].toFixed(2)}%`);
      this.style(`${part}Bar`, 'background', state[part] < 25 ? '#dc6a4b' : state[part] < 60 ? '#b79453' : '#69958b');
    }
    const danger = state.strain > 1 || sample.hardStop > 1;
    const warning = state.strain > .65;
    const label = state.broken ? '铰链已断开'
      : state.screen === 0 ? '屏幕已失效'
      : danger ? '力道过猛，轻一点'
      : warning ? '感受到阻力了'
      : gripCount > 1 ? '双指握持'
      : gripCount === 1 ? '握住了' : '轻轻拿起';
    this.text('forceLabel', label);
    const showFeedback = gripCount > 0 || danger || warning || state.broken || state.screen === 0;
    if (this.changed('showFeedback', showFeedback)) r.feedback.hidden = !showFeedback;
    if (gripCount > 0) this.hideHint();
    const forceColor = danger ? '#dc6a4b' : warning ? '#bd9b52' : '#69958b';
    this.style('forceDot', 'background', forceColor);
    this.style('forceBar', 'width', `${Math.round(Math.min(100, Math.max(3, state.strain * 80)))}%`);
    this.style('forceBar', 'background', forceColor);
    const hideFinish = state.mode !== 'challenge' || !state.running;
    if (this.changed('hideFinish', hideFinish)) this.buttons.finish.hidden = hideFinish;
    if (this.changed('sound', state.sound)) {
      const sound = this.buttons.sound;
      sound.innerHTML = `${icon(state.sound ? 'sound' : 'muted')}<span>${state.sound ? '音效开启' : '音效关闭'}</span>`;
      sound.setAttribute('aria-label', state.sound ? '关闭音效' : '开启音效');
    }
    if (state.folds !== this.previousFolds) {
      this.previousFolds = state.folds;
      r.folds.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 220 });
    }
    if (state.running && this.result) {
      this.result = null;
      this.refs.resultModal.hidden = true;
    }
  }

  showResult(result: RoundResult, image: string) {
    this.result = result;
    this.resultImage = image;
    const r = this.refs;
    (r.resultPhoto as HTMLImageElement).src = image;
    r.resultEyebrow.textContent = result.reason === 'banked' ? '漂亮收手' : '本次挑战结束';
    r.resultTitle.textContent = result.reason === 'banked' ? '留一点余地，下次再玩。' : result.reason === 'hinge' ? '这次，真的分开了。' : '屏幕熄了，纪录留下。';
    r.resultScore.textContent = number(result.score);
    r.resultFolds.textContent = number(result.folds);
    r.resultDetail.innerHTML = `<div><span>开合得分</span><b>${number(result.baseScore)}</b></div><div><span>完好收手奖励</span><b>+${number(result.bonus)}</b></div><div><span>屏幕 / 铰链</span><b>${Math.ceil(result.screen)}% / ${Math.ceil(result.hinge)}%</b></div>`;
    r.resultModal.hidden = false;
    this.root.querySelector<HTMLButtonElement>('[data-action="again"]')?.focus();
  }

  showHelp() { this.setMenu(false); this.hideHint(); this.refs.help.hidden = !this.refs.help.hidden; }

  showImage(dataUrl: string) {
    (this.refs.exportImage as HTMLImageElement).src = dataUrl;
    (this.refs.download as HTMLAnchorElement).href = dataUrl;
    this.refs.imageModal.hidden = false;
  }

  async exportCard(): Promise<string> {
    const result = this.result;
    if (!result) return this.resultImage;
    const c = document.createElement('canvas'); c.width = 1000; c.height = 1280;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f5f6f7'; ctx.fillRect(0, 0, 1000, 1280);
    const photo = new Image(); photo.src = this.resultImage;
    await photo.decode();
    const scale = Math.max(1000 / photo.width, 650 / photo.height);
    const sw = 1000 / scale, sh = 650 / scale;
    ctx.drawImage(photo, (photo.width - sw) / 2, (photo.height - sh) / 2, sw, sh, 0, 0, 1000, 650);
    const font = 'system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#202a2b'; ctx.font = `500 32px ${font}`; ctx.fillText('Apple DUO', 70, 75);
    ctx.font = `400 21px ${font}`; ctx.fillStyle = '#74807d'; ctx.fillText('折叠模拟器 / 本机挑战', 70, 115);
    ctx.fillStyle = '#69958b'; ctx.font = `500 23px ${font}`;
    ctx.fillText(result.reason === 'banked' ? '漂亮收手' : result.reason === 'hinge' ? '铰链断开 · 挑战结束' : '屏幕失效 · 挑战结束', 70, 722);
    ctx.fillStyle = '#202a2b'; ctx.font = `600 116px ${font}`; ctx.fillText(number(result.score), 65, 860);
    ctx.fillStyle = '#74807d'; ctx.font = `400 24px ${font}`; ctx.fillText('积分', 74, 906);
    ctx.fillStyle = '#202a2b'; ctx.font = `500 35px ${font}`; ctx.fillText(`${result.folds} 次完整开合`, 70, 983);
    ctx.strokeStyle = '#dce2df'; ctx.beginPath(); ctx.moveTo(70, 1020); ctx.lineTo(930, 1020); ctx.stroke();
    ctx.font = `400 24px ${font}`; ctx.fillStyle = '#74807d';
    ctx.fillText(`开合得分 ${number(result.baseScore)}    完好奖励 +${number(result.bonus)}`, 70, 1075);
    ctx.fillText(`屏幕 ${Math.ceil(result.screen)}%    铰链 ${Math.ceil(result.hinge)}%`, 70, 1125);
    ctx.font = `400 21px ${font}`; ctx.fillText('抓住。甩开。轻轻合上。', 70, 1215);
    return c.toDataURL('image/png');
  }

  toast(message: string) {
    const el = this.refs.toast;
    el.textContent = message; el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.hidden = true, 2800);
  }

  setReady() {
    this.refs.loading.hidden = true;
    for (const action of ['free', 'challenge', 'reset', 'finish']) this.buttons[action].disabled = false;
    this.refs.hint.hidden = false;
    this.hintTimer = window.setTimeout(() => this.hideHint(), 6500);
  }
  showError(message: string) {
    this.refs.loading.innerHTML = `<span class="error-dot"></span><span></span>`;
    this.refs.loading.lastElementChild!.textContent = message;
  }

  private action(name: string, handler: () => void) {
    this.buttons[name].addEventListener('click', handler);
  }
  private changed(key: string, value: string | number | boolean) {
    if (this.rendered.get(key) === value) return false;
    this.rendered.set(key, value);
    return true;
  }
  private text(name: string, value: string) {
    if (this.changed(`text:${name}`, value)) this.refs[name].textContent = value;
  }
  private style(name: string, property: 'width' | 'background', value: string) {
    if (this.changed(`style:${name}:${property}`, value)) this.refs[name].style[property] = value;
  }
  private changeMode(mode: Mode) {
    this.setMenu(false);
    this.hideHint();
    this.refs.resultModal.hidden = true;
    this.refs.help.hidden = true;
    this.callbacks.onMode(mode);
  }
  private reset() {
    this.setMenu(false);
    this.refs.resultModal.hidden = true;
    this.refs.imageModal.hidden = true;
    this.callbacks.onReset();
  }
  private setMenu(open: boolean) {
    this.refs.menu.hidden = !open;
    this.buttons.menu.setAttribute('aria-expanded', String(open));
    if (open) this.refs.help.hidden = true;
  }
  private hideHint() {
    window.clearTimeout(this.hintTimer);
    this.refs.hint.hidden = true;
  }
}
