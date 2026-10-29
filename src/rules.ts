import type { GameState, Mode, PhysicsSample, RoundResult } from './types';

const STORAGE_KEY = 'apple-duo:v1';
type Saved = { version: 1; bestScore: number; bestFolds: number; sound: boolean };
const bounded = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export class GameRules {
  state: GameState;
  events: Array<'fold' | 'impact' | 'crack' | 'break'> = [];
  private elapsed = 0;
  private lastFold = -Infinity;
  private phase: 'waiting' | 'open' | 'closed' = 'waiting';
  private clean = true;
  private cyclePeak = 0;
  private chain = 0;

  constructor() {
    const saved = this.load();
    this.state = {
      mode: 'free', folds: 0, score: 0, multiplier: 1,
      screen: 100, hinge: 100, broken: false, strain: 0, angle: 180,
      running: true, result: null, bestScore: saved.bestScore,
      bestFolds: saved.bestFolds, sound: saved.sound,
    };
  }

  reset(mode: Mode) {
    Object.assign(this.state, { mode, folds: 0, score: 0, multiplier: 1,
      screen: 100, hinge: 100, broken: false, strain: 0, angle: 180,
      running: true, result: null });
    this.elapsed = 0;
    this.lastFold = -Infinity;
    this.phase = 'waiting';
    this.clean = true;
    this.cyclePeak = 0;
    this.chain = 0;
    this.events.length = 0;
  }

  step(sample: PhysicsSample, dt: number) {
    this.events.length = 0;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const step = Math.min(dt, .05);
    this.elapsed += step;
    this.state.angle = bounded(sample.angle, 0, 180);
    this.state.strain = bounded(sample.strain, 0, 2);
    if (!this.state.running) return;
    if (this.elapsed - this.lastFold > 6) {
      this.chain = 0;
      this.state.multiplier = 1;
    }

    const oldScreen = this.state.screen;
    const oldHinge = this.state.hinge;
    // Only over-speed relative hinge motion, external hard stops, or effective impacts hurt.
    const overspeed = Math.max(0, Math.abs(sample.angularSpeed) - 12);
    const hardStop = Math.max(0, sample.hardStop - 1);
    this.state.hinge -= (overspeed * overspeed * .3 + hardStop * hardStop * 22) * step;
    if (sample.impact > 5) {
      const excess = sample.impact - 5;
      this.state.screen -= excess * excess * 2.4;
      this.state.hinge -= excess * excess * .85;
      this.events.push('impact');
    } else if (sample.impact > 1) this.events.push('impact');
    this.state.screen = bounded(this.state.screen);
    this.state.hinge = bounded(this.state.hinge);
    const hurt = this.state.screen < oldScreen || this.state.hinge < oldHinge;
    if (hurt) {
      this.clean = false;
      this.chain = 0;
      this.lastFold = -Infinity;
      this.state.multiplier = 1;
      if (Math.ceil(oldScreen / 20) > Math.ceil(this.state.screen / 20)
        || Math.ceil(oldHinge / 25) > Math.ceil(this.state.hinge / 25)) this.events.push('crack');
    }
    if (this.state.hinge === 0 && !this.state.broken) {
      this.state.broken = true;
      this.events.push('break');
    }
    if (this.state.mode === 'challenge' && (this.state.screen === 0 || this.state.broken)) {
      this.end(this.state.broken ? 'hinge' : 'screen');
      return;
    }
    if (this.state.broken) return;

    if (this.phase !== 'waiting') this.cyclePeak = Math.max(this.cyclePeak, sample.strain);
    if (this.phase === 'waiting') {
      if (sample.angle >= 155) {
        this.phase = 'open';
        this.clean = !hurt;
        this.cyclePeak = sample.strain;
      }
    } else if (this.phase === 'open' && sample.angle <= 25) {
      this.phase = 'closed';
    } else if (this.phase === 'closed' && sample.angle >= 155) {
      this.chain = this.elapsed - this.lastFold <= 6 ? this.chain + 1 : 0;
      this.state.multiplier = Math.min(2, 1 + this.chain * .1);
      const points = 100 + (this.clean && this.cyclePeak <= .65 ? 25 : 0);
      this.state.score += Math.round(points * this.state.multiplier);
      this.state.folds += 1;
      this.lastFold = this.elapsed;
      this.events.push('fold');
      this.phase = 'open';
      this.clean = !hurt;
      this.cyclePeak = sample.strain;
    }
  }

  finish(): RoundResult | null {
    if (this.state.mode !== 'challenge' || !this.state.running) return this.state.result;
    return this.end('banked');
  }

  toggleSound() {
    this.state.sound = !this.state.sound;
    this.save();
  }

  private end(reason: RoundResult['reason']): RoundResult {
    const bonus = reason === 'banked'
      ? Math.round(this.state.score * .2 * Math.min(this.state.screen, this.state.hinge) / 100) : 0;
    const result: RoundResult = { reason, folds: this.state.folds, baseScore: this.state.score,
      bonus, score: this.state.score + bonus, screen: this.state.screen, hinge: this.state.hinge };
    this.state.result = result;
    this.state.running = false;
    this.state.bestScore = Math.max(this.state.bestScore, result.score);
    this.state.bestFolds = Math.max(this.state.bestFolds, result.folds);
    this.save();
    return result;
  }

  private load(): Saved {
    const fallback: Saved = { version: 1, bestScore: 0, bestFolds: 0, sound: true };
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Partial<Saved> | null;
      if (!raw || raw.version !== 1) return fallback;
      const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
      return { version: 1, bestScore: valid(raw.bestScore) ? raw.bestScore : 0,
        bestFolds: valid(raw.bestFolds) ? raw.bestFolds : 0,
        sound: typeof raw.sound === 'boolean' ? raw.sound : true };
    } catch { return fallback; }
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1,
      bestScore: this.state.bestScore, bestFolds: this.state.bestFolds, sound: this.state.sound })); }
    catch { /* Storage may be disabled; the active session remains playable. */ }
  }
}
