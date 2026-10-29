import type { ContactMaterial, FeedbackKind } from './types';

export type MechanicalSound = FeedbackKind | 'wear';
const TAU = Math.PI * 2;
const durations: Record<MechanicalSound, number> = {
  close: .105, open: .085, impact: .23, chip: .115, crack: .26, break: .43, wear: .065,
};
const bounded = (value: number, fallback = 0) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

/** Continuous force-to-level mapping; the bus keeps additional headroom for overlapping contacts. */
export function responseGain(kind: MechanicalSound, strength: number): number {
  const force = Math.pow(bounded(strength), .85);
  const ranges: Record<MechanicalSound, [number, number]> = {
    close: [.038, .14], open: [.03, .10], impact: [.016, .26], chip: [.012, .075],
    crack: [.09, .28], break: [.13, .34], wear: [.008, .028],
  };
  const [quiet, loud] = ranges[kind];
  return quiet + (loud - quiet) * force;
}

function randomGenerator(seed: number): () => number {
  let value = (seed | 0) || 0x48ab19;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 0x100000000 * 2 - 1;
  };
}

type Mode = [frequency: number, decay: number, gain: number];

/** Original short mechanical responses, built from damped modes and filtered pressure impulses. */
export function synthesizeTransient(kind: MechanicalSound, material: ContactMaterial = 'metal',
  sampleRate = 48000, seed = 1, table = true): Float32Array<ArrayBuffer> {
  const rate = Number.isFinite(sampleRate) ? Math.max(8000, Math.min(96000, Math.round(sampleRate))) : 48000;
  const out = new Float32Array(Math.ceil(rate * durations[kind]));
  const random = randomGenerator(seed);
  const variation = 1 + random() * .025;
  const pulse = (offset: number, level: number, decay: number, cutoff: number, brightness: number, modes: Mode[]) => {
    const start = Math.round(offset * rate);
    const count = Math.min(out.length - start, Math.ceil(decay * 8 * rate));
    const alpha = 1 - Math.exp(-TAU * cutoff / rate);
    let low = 0;
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      const white = random(); low += alpha * (white - low);
      const noise = low * (1 - brightness) + (white - low) * brightness;
      let value = noise * .42 * Math.exp(-t / decay);
      for (const [frequency, ring, gain] of modes) {
        value += Math.sin(TAU * frequency * variation * t) * Math.exp(-t / ring) * gain;
      }
      out[start + i] += value * level * Math.min(1, t / .00045);
    }
  };
  const frame: Mode[] = [[173, .026, .4], [947, .021, .17], [1637, .015, .12], [2861, .011, .07]];
  const glass: Mode[] = [[241, .026, .19], [1289, .048, .2], [2179, .035, .13], [3823, .022, .08]];
  const back: Mode[] = [[139, .034, .48], [319, .024, .19], [881, .013, .06]];
  if (kind === 'impact') {
    const modes = material === 'glass' ? glass : material === 'back' ? back : frame;
    pulse(0, 1, material === 'back' ? .023 : .012, material === 'back' ? 720 : 2600,
      material === 'glass' ? .5 : material === 'metal' ? .25 : .04, modes);
    if (table) pulse(.0025, .32, .025, 360, .02, [[113, .039, .48], [271, .022, .12]]);
  } else if (kind === 'close') {
    pulse(0, 1, .006, 2400, .24, [[1063, .012, .21], [2167, .008, .12]]);
    pulse(.006, .62, .009, 650, .05, [[191, .021, .38], [503, .014, .1]]);
  } else if (kind === 'open') {
    pulse(0, .7, .007, 1500, .13, [[239, .022, .31], [1217, .012, .12]]);
    pulse(.012, .22, .006, 1100, .1, [[617, .009, .12]]);
  } else if (kind === 'chip') {
    pulse(0, .72, .005, 4200, .64, [[2357, .026, .17], [4139, .014, .1]]);
    pulse(.027, .16, .004, 3500, .4, [[3181, .012, .12]]);
  } else if (kind === 'crack') {
    for (const [offset, level] of [[0, 1], [.008, .58], [.021, .38], [.044, .23], [.079, .12]]) {
      pulse(offset, level, .008, 3200, .72, [[1871, .017, .13], [4297, .012, .08]]);
    }
  } else if (kind === 'break') {
    pulse(0, .8, .014, 850, .18, [[181, .035, .39], [527, .02, .18]]);
    for (const [offset, level] of [[.006, 1], [.023, .55], [.059, .3], [.112, .19], [.187, .11]]) {
      pulse(offset, level, .014, 2700, .51, [[1139, .025, .16], [3169, .017, .13]]);
    }
  } else {
    pulse(0, .6, .003, 1800, .29, [[739, .008, .12], [1847, .006, .06]]);
  }
  // Remove residual DC and taper both boundaries, including the short debris sounds.
  let peak = 0;
  let previousInput = 0, previousOutput = 0;
  const dcDecay = Math.exp(-TAU * 18 / rate);
  const tail = Math.max(2, Math.round(rate * .012));
  for (let i = 0; i < out.length; i++) {
    const current = out[i];
    const filtered = current - previousInput + dcDecay * previousOutput;
    previousInput = current; previousOutput = filtered;
    out[i] = filtered * Math.min(1, i / (rate * .0004), (out.length - i - 1) / tail);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const scale = peak > 0 ? .72 / peak : 0;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  out[0] = 0; out[out.length - 1] = 0;
  return out;
}

/** One reusable, aperiodic noise bed; downstream filters shape the hinge and table friction. */
export function mechanicalNoise(sampleRate: number): Float32Array<ArrayBuffer> {
  const length = Number.isFinite(sampleRate) ? Math.max(8000, Math.min(96000, Math.round(sampleRate))) : 48000;
  const out = new Float32Array(length);
  const random = randomGenerator(0x315ae7);
  let low = 0;
  for (let i = 0; i < length; i++) {
    const white = random(); low += .13 * (white - low);
    out[i] = (white * .7 + low * .3) * .5;
  }
  return out;
}
