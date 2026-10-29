import { CanvasTexture, SRGBColorSpace } from 'three';
import { PHONE } from './config';
import { deviceClock, type DeviceClock } from './clock';

function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

function seeded(seed: number): () => number {
  let value = seed;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
}

/** The original generated landscape and controls are cached independently of the clock. */
function paintBase(target: HTMLCanvasElement): void {
  const { width, height } = target;
  const ctx = target.getContext('2d')!;
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#7ea6c1'); bg.addColorStop(.44, '#d2ccb7'); bg.addColorStop(.58, '#dcc8a3'); bg.addColorStop(1, '#b3a48e');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  const random = seeded(5829);
  for (let ridge = 0; ridge < 5; ridge++) {
    const baseline = height * (.45 + ridge * .032);
    ctx.beginPath(); ctx.moveTo(-20, baseline + 100);
    for (let x = -20; x <= width + 24; x += 22) {
      const y = baseline + Math.sin(x / width * 10 + ridge * .8) * 17 + Math.sin(x / width * 65 + ridge) * (4 + ridge * 2) + (random() - .5) * 9;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width + 20, height); ctx.lineTo(-20, height); ctx.closePath();
    ctx.fillStyle = ['#a69f87', '#92917e', '#7f806f', '#a69e87', '#8e8a77'][ridge]; ctx.fill();
  }
  const sand = ctx.createLinearGradient(0, height * .55, width * .7, height);
  sand.addColorStop(0, '#e5d8b8'); sand.addColorStop(.46, '#d1bea0'); sand.addColorStop(1, '#ad9b80');
  ctx.fillStyle = sand; ctx.beginPath(); ctx.moveTo(0, height * .64);
  ctx.bezierCurveTo(width * .27, height * .78, width * .47, height * .67, width, height * .55);
  ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.closePath(); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.moveTo(0, height * .64);
  ctx.bezierCurveTo(width * .27, height * .78, width * .47, height * .67, width, height * .55);
  ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.clip();
  for (let line = 0; line < 460; line++) {
    const y = height * .55 + line * 1.35;
    ctx.strokeStyle = line % 3 === 0 ? '#fff6de42' : '#6b5c4529'; ctx.lineWidth = .7;
    ctx.beginPath(); ctx.moveTo(-10, y + height * .07);
    ctx.bezierCurveTo(width * .28, y + height * .2, width * .56, y + height * .04, width + 10, y - height * .075);
    ctx.stroke();
  }
  ctx.restore();
  const r = height * .018;
  ctx.strokeStyle = '#ffffffd9'; ctx.lineWidth = 2.3;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath(); ctx.arc(width - r * 2.1, height * .058, r * (1 - i * .27), Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  }
  for (let i = 0; i < 2; i++) {
    const cx = width - r * 2.05, cy = height * (.86 + i * .075);
    ctx.fillStyle = '#fffbea30'; ctx.beginPath(); ctx.arc(cx, cy, r * 1.12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fffbeecb'; ctx.lineWidth = 2;
    if (i) { ctx.strokeRect(cx - r * .43, cy - r * .31, r * .86, r * .6); ctx.beginPath(); ctx.arc(cx, cy, r * .15, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(cx - r * .22, cy - r * .37); ctx.lineTo(cx + r * .2, cy - r * .37); ctx.lineTo(cx + r * .12, cy + r * .35); ctx.lineTo(cx - r * .12, cy + r * .35); ctx.closePath(); ctx.stroke(); }
  }
  ctx.fillStyle = '#fffcebbd'; ctx.beginPath(); ctx.roundRect(width * .28, height - 21, width * .44, 5, 2.5); ctx.fill();
}

function softCopy(source: HTMLCanvasElement, target: HTMLCanvasElement, radius: number): void {
  const ctx = target.getContext('2d')!;
  ctx.clearRect(0, 0, target.width, target.height);
  // Keep texture edges opaque even though a canvas blur samples outside the image.
  ctx.fillStyle = '#c9c4b1'; ctx.fillRect(0, 0, target.width, target.height);
  if (typeof ctx.filter !== 'string') {
    // Downsample and reconstruct on browsers without Canvas 2D filters.
    const low = canvas(Math.max(1, Math.round(target.width / (radius * 1.5))),
      Math.max(1, Math.round(target.height / (radius * 1.5))));
    low.getContext('2d')!.drawImage(source, 0, 0, low.width, low.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(low, 0, 0, target.width, target.height);
    return;
  }
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(source, 0, 0, target.width, target.height);
  ctx.filter = 'none';
}

/** Two reusable images: a detailed screen and a small, pre-frosted screen. */
export class ScreenTexture {
  readonly sharp: CanvasTexture;
  readonly blurred: CanvasTexture;
  private readonly base: HTMLCanvasElement;
  private readonly softBase: HTMLCanvasElement;
  private readonly display: HTMLCanvasElement;
  private readonly frost: HTMLCanvasElement;
  private readonly clockLayer: HTMLCanvasElement;
  private readonly fontSize: number;
  private readonly clockTop: number;
  private key = '';

  constructor(private readonly outer = false, clock: DeviceClock = deviceClock()) {
    const height = 1152;
    const width = outer ? 816 : Math.round(height * PHONE.width * 2 / PHONE.height);
    this.base = canvas(width, height);
    paintBase(this.base);
    this.softBase = canvas(Math.round(width / 4), Math.round(height / 4));
    softCopy(this.base, this.softBase, 4);
    this.display = canvas(width, height);
    this.frost = canvas(this.softBase.width, this.softBase.height);
    this.fontSize = height * (outer ? .26 : .36);
    this.clockTop = height * (outer ? .315 : .39) - this.fontSize;
    this.clockLayer = canvas(width, Math.ceil(this.fontSize + 8));
    this.sharp = new CanvasTexture(this.display);
    this.blurred = new CanvasTexture(this.frost);
    this.sharp.colorSpace = this.blurred.colorSpace = SRGBColorSpace;
    this.sharp.name = outer ? 'outer-lock-screen' : 'inner-lock-screen';
    this.blurred.name = `${this.sharp.name}-frosted`;
    this.refresh(clock);
  }

  /** No canvas work or GPU uploads while the local calendar minute is unchanged. */
  refresh(clock: DeviceClock = deviceClock()): boolean {
    if (this.key === clock.key) return false;
    this.key = clock.key;
    const { width, height } = this.display;
    const ctx = this.display.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.base, 0, 0);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff8df';
    ctx.font = `400 ${this.outer ? 27 : 29}px -apple-system, BlinkMacSystemFont, Arial, sans-serif`;
    ctx.fillText(clock.date, width * .5, height * .091);
    this.paintClock(clock.time);
    ctx.drawImage(this.clockLayer, 0, this.clockTop);
    softCopy(this.display, this.frost, 10);
    this.sharp.userData.clock = { ...clock };
    this.blurred.userData.clock = { ...clock };
    this.sharp.needsUpdate = true;
    this.blurred.needsUpdate = true;
    return true;
  }

  private paintClock(time: string): void {
    const ctx = this.clockLayer.getContext('2d')!;
    const { width, height } = this.clockLayer;
    const font = `200 ${this.fontSize}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
    const scale = this.outer ? .71 : .74;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width * .5, this.fontSize);
    ctx.scale(scale, 1);
    ctx.font = font; ctx.textAlign = 'center';
    ctx.fillStyle = '#fff'; ctx.fillText(time, 0, 0);
    ctx.restore();

    // Refract a soft version of the wallpaper inside the text's alpha mask.
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(this.softBase, -8, -this.clockTop - 6, this.display.width + 16, this.display.height + 12);
    ctx.globalCompositeOperation = 'source-atop';
    const glass = ctx.createLinearGradient(0, 0, 0, height);
    glass.addColorStop(0, '#fffef7ed'); glass.addColorStop(.45, '#fff9dfc9'); glass.addColorStop(1, '#fff9df91');
    ctx.fillStyle = glass; ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.translate(width * .5, this.fontSize); ctx.scale(scale, 1);
    ctx.font = font; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    const edge = ctx.createLinearGradient(0, -this.fontSize, 0, 0);
    edge.addColorStop(0, '#fffffffa'); edge.addColorStop(.6, '#fffbe3a6'); edge.addColorStop(1, '#fff9df59');
    ctx.strokeStyle = edge; ctx.lineWidth = 1.3;
    ctx.shadowColor = '#27323a24'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1.5;
    ctx.strokeText(time, 0, 0);
    ctx.restore();
  }
}
