import { mechanicalNoise, responseGain, synthesizeTransient, type MechanicalSound } from './audioSynthesis';
import type { ContactMaterial, FeedbackEvent, FeedbackFrame } from './types';

export const MAX_AUDIO_VOICES = 8;
const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const panValue = (value: number) => Number.isFinite(value) ? Math.max(-.8, Math.min(.8, value)) : 0;
const priorities: Record<MechanicalSound, number> = { wear: 0, chip: 1, close: 2, open: 2, impact: 2, crack: 3, break: 4 };
const cooldowns: Record<MechanicalSound, number> = { wear: .17, chip: .04, close: .085, open: .1, impact: .032, crack: .14, break: .22 };

interface Voice {
  source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode | null;
  kind: MechanicalSound; started: number;
}
interface Friction {
  source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode | null;
}

export interface FrictionResponse { hinge: number; scrape: number; hingeFrequency: number; scrapeFrequency: number }
export function frictionResponse(frame: FeedbackFrame): FrictionResponse {
  const velocity = Math.min(24, Math.abs(Number.isFinite(frame.signedSpeed) ? frame.signedSpeed : frame.angularSpeed || 0));
  const speed = Math.min(1, velocity / 10);
  const wear = unit(1 - frame.hingeHealth / 100);
  const load = unit(frame.strain);
  const scrapeSpeed = Math.min(1, Math.max(0, Number.isFinite(frame.scrapeSpeed) ? frame.scrapeSpeed / 4 : 0));
  return {
    hinge: frame.broken ? 0 : (velocity <= .08 ? 0 : .045 * Math.pow(speed, .7) * (1 + wear * .45)) + Math.max(0, load - .7) * .008,
    scrape: scrapeSpeed <= .018 ? 0 : .035 * Math.pow(scrapeSpeed, .7),
    hingeFrequency: 410 + speed * 790 + wear * 280 + load * 180 + (frame.signedSpeed > 0 ? 60 : -30),
    scrapeFrequency: frame.scrapeMaterial === 'glass' ? 1900 : frame.scrapeMaterial === 'metal' ? 1400 : 680,
  };
}

export class DuoAudio {
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private master: GainNode | null = null;
  private readonly bus: AudioNode[] = [];
  private enabled = true;
  private readonly voices = new Set<Voice>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly lastPlayed = new Map<string, number>();
  private hinge: Friction | null = null;
  private scrape: Friction | null = null;
  private lastTick = -Infinity;
  private lastRattle = -Infinity;
  private sequence = 0;

  /** Read-only nodes support local output measurement without a player-visible diagnostic UI. */
  get context(): AudioContext | null { return this.ctx; }
  get output(): GainNode | null { return this.master; }
  get activeVoices(): number { return this.voices.size; }

  unlock(): void {
    if (!this.ctx || this.ctx.state === 'closed') {
      try { this.initialize(new AudioContext()); }
      catch { return; }
    }
    void this.ctx!.resume().catch(() => {});
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (!enabled) this.stop();
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(enabled ? .8 : 0, ctx.currentTime, .006);
  }

  play(event: FeedbackEvent): void {
    this.emit(event.kind, event.strength, event.material ?? 'metal', event.pan ?? 0, event.table !== false, event.contactId);
  }

  tick(frame: FeedbackFrame): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || ctx.state !== 'running' || !this.hinge || !this.scrape) return;
    const now = ctx.currentTime;
    if (now - this.lastTick < .025) return;
    this.lastTick = now;
    const response = frictionResponse(frame);
    for (const [loop, level, frequency] of [
      [this.hinge, response.hinge, response.hingeFrequency], [this.scrape, response.scrape, response.scrapeFrequency],
    ] as const) {
      loop.gain.gain.cancelScheduledValues(now);
      loop.gain.gain.setTargetAtTime(level, now, level > 0 ? .035 : .018);
      loop.filter.frequency.setTargetAtTime(frequency, now, .045);
      loop.pan?.pan.setTargetAtTime(panValue(frame.pan), now, .04);
    }
    const wear = unit(1 - frame.hingeHealth / 100);
    if (!frame.broken && wear > .55 && response.hinge > .012 && now - this.lastRattle > .22 + .05 * Math.sin(now * 13)) {
      this.lastRattle = now;
      this.emit('wear', .07 + wear * .13, 'metal', frame.pan, false);
    }
  }

  /** Stop active sound immediately; no delayed events are retained for the next interaction. */
  stop(): void {
    const now = this.ctx?.currentTime ?? 0;
    for (const voice of [...this.voices]) this.finishVoice(voice, true);
    for (const loop of [this.hinge, this.scrape]) if (loop) {
      loop.gain.gain.cancelScheduledValues(now);
      loop.gain.gain.setValueAtTime(0, now);
    }
    this.lastTick = -Infinity;
    this.lastRattle = -Infinity;
  }

  reset(): void {
    this.stop(); this.lastPlayed.clear(); this.sequence = 0;
  }

  dispose(): void {
    this.stop();
    for (const loop of [this.hinge, this.scrape]) if (loop) {
      try { loop.source.stop(); } catch { /* Already stopped by context shutdown. */ }
      loop.source.disconnect(); loop.filter.disconnect(); loop.gain.disconnect(); loop.pan?.disconnect();
    }
    for (const node of this.bus) node.disconnect();
    this.bus.length = 0; this.buffers.clear(); this.lastPlayed.clear();
    const ctx = this.ctx;
    this.ctx = null; this.input = null; this.master = null; this.hinge = null; this.scrape = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  }

  private initialize(ctx: AudioContext): void {
    this.ctx = ctx;
    const input = ctx.createGain(), dc = ctx.createBiquadFilter(), compressor = ctx.createDynamicsCompressor();
    const limiter = ctx.createWaveShaper(), master = ctx.createGain();
    dc.type = 'highpass'; dc.frequency.value = 35; dc.Q.value = .7;
    compressor.threshold.value = -15; compressor.knee.value = 12; compressor.ratio.value = 5;
    compressor.attack.value = .002; compressor.release.value = .16;
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = i / (curve.length - 1) * 2 - 1;
      curve[i] = Math.tanh(x * 1.8) / 1.8;
    }
    limiter.curve = curve; limiter.oversample = '2x';
    master.gain.value = this.enabled ? .8 : 0;
    input.connect(dc).connect(compressor).connect(limiter).connect(master).connect(ctx.destination);
    this.input = input; this.master = master; this.bus.push(input, dc, compressor, limiter, master);
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    noise.getChannelData(0).set(mechanicalNoise(ctx.sampleRate));
    this.hinge = this.makeFriction(noise, 'bandpass', 680, .7, 0);
    this.scrape = this.makeFriction(noise, 'lowpass', 1200, .5, .37);
  }

  private makeFriction(buffer: AudioBuffer, type: BiquadFilterType, frequency: number, q: number, offset: number): Friction {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    source.buffer = buffer; source.loop = true;
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = q; gain.gain.value = 0;
    source.connect(filter).connect(gain);
    if (pan) gain.connect(pan).connect(this.input!); else gain.connect(this.input!);
    source.start(ctx.currentTime, offset);
    return { source, filter, gain, pan };
  }

  private emit(kind: MechanicalSound, strength: number, material: ContactMaterial, pan: number, table: boolean, contactId?: number): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || ctx.state !== 'running' || !this.input || strength <= 0 || !Number.isFinite(strength)) return;
    const now = ctx.currentTime;
    if (now - (this.lastPlayed.get(kind) ?? -Infinity) < cooldowns[kind]) return;
    const key = contactId === undefined ? null : kind + ':' + contactId;
    if (key && now - (this.lastPlayed.get(key) ?? -Infinity) < .1) return;
    if (this.voices.size >= MAX_AUDIO_VOICES) {
      const candidate = [...this.voices].sort((a, b) => priorities[a.kind] - priorities[b.kind] || a.started - b.started)[0];
      if (priorities[candidate.kind] >= priorities[kind]) return;
      this.finishVoice(candidate, true);
    }
    this.lastPlayed.set(kind, now); if (key) this.lastPlayed.set(key, now);
    if (this.lastPlayed.size > 128) for (const [entry, played] of this.lastPlayed) {
      if (now - played > 1) this.lastPlayed.delete(entry);
    }
    const variant = this.sequence++ % 4;
    const cacheKey = kind + ':' + material + ':' + Number(table) + ':' + variant;
    let buffer = this.buffers.get(cacheKey);
    if (!buffer) {
      const samples = synthesizeTransient(kind, material, ctx.sampleRate, variant + 17, table);
      buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate); buffer.getChannelData(0).set(samples);
      if (this.buffers.size >= 24) this.buffers.delete(this.buffers.keys().next().value!);
      this.buffers.set(cacheKey, buffer);
    }
    const source = ctx.createBufferSource(), gain = ctx.createGain();
    const stereo = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    source.buffer = buffer; source.playbackRate.value = .985 + (variant / 3) * .03;
    gain.gain.value = responseGain(kind, strength);
    source.connect(gain);
    if (stereo) { stereo.pan.value = panValue(pan); gain.connect(stereo).connect(this.input); }
    else gain.connect(this.input);
    const voice: Voice = { source, gain, pan: stereo, kind, started: now };
    this.voices.add(voice); source.onended = () => this.finishVoice(voice, false);
    source.start(now);
  }

  private finishVoice(voice: Voice, stop: boolean): void {
    if (!this.voices.delete(voice)) return;
    if (stop) {
      voice.gain.gain.cancelScheduledValues(this.ctx?.currentTime ?? 0);
      voice.gain.gain.value = 0;
      try { voice.source.stop(); } catch { /* A source can finish in the same audio quantum. */ }
    }
    voice.source.disconnect(); voice.gain.disconnect(); voice.pan?.disconnect();
  }
}
