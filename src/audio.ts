type Sound = 'fold' | 'impact' | 'crack' | 'break';

export class DuoAudio {
  private context: AudioContext | null = null;
  private enabled = true;
  private lastRustle = 0;
  private noise: AudioBuffer | null = null;

  unlock() {
    if (!this.context) {
      try {
        this.context = new AudioContext();
        this.noise = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      } catch { return; }
    }
    void this.context.resume().catch(() => {});
  }

  setEnabled(enabled: boolean) { this.enabled = enabled; }

  play(kind: Sound, strength = 1) {
    const ctx = this.context;
    if (!this.enabled || !ctx || ctx.state !== 'running' || !this.noise) return;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const noise = ctx.createBufferSource();
    const duration = kind === 'break' ? .45 : kind === 'crack' ? .18 : kind === 'impact' ? .12 : .055;
    const level = (kind === 'break' ? .22 : kind === 'crack' ? .16 : kind === 'impact' ? .12 : .045) * Math.min(1.5, Math.max(.2, strength));
    filter.type = kind === 'impact' ? 'lowpass' : 'bandpass';
    filter.frequency.value = kind === 'impact' ? 480 : kind === 'fold' ? 1600 : 3400;
    filter.Q.value = kind === 'fold' ? 1.2 : .5;
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    noise.buffer = this.noise;
    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.start(now, Math.random() * .5, duration);
    noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
    if (kind === 'impact' || kind === 'break' || kind === 'fold') {
      const tone = ctx.createOscillator();
      const envelope = ctx.createGain();
      tone.type = 'sine';
      tone.frequency.setValueAtTime(kind === 'fold' ? 850 : 170, now);
      tone.frequency.exponentialRampToValueAtTime(kind === 'fold' ? 420 : 65, now + duration);
      envelope.gain.setValueAtTime(level * .38, now);
      envelope.gain.exponentialRampToValueAtTime(.0001, now + duration);
      tone.connect(envelope).connect(ctx.destination);
      tone.start(now);
      tone.stop(now + duration);
      tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
    }
  }

  tick(angularSpeed: number, strain: number) {
    const now = this.context?.currentTime ?? 0;
    if (Math.abs(angularSpeed) > 1.4 && now - this.lastRustle > .13) {
      this.lastRustle = now;
      this.play('fold', Math.min(.4, Math.abs(angularSpeed) * .025 + strain * .1));
    }
  }
}
