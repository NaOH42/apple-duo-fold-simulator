import type { FeedbackEvent, FeedbackKind } from './types';

const STORAGE_KEY = 'apple-duo:haptics:v1';
const priority: Record<FeedbackKind, number> = { chip: 1, open: 2, close: 3, impact: 4, crack: 5, break: 6 };

export interface HapticEnvironment {
  supported: boolean;
  vibrate: (pattern: VibratePattern) => boolean;
  now: () => number;
  visible: () => boolean;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  documentEvents?: EventTarget;
  windowEvents?: EventTarget;
}

function browserEnvironment(): HapticEnvironment {
  const mobile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const available = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  let storage: Storage | undefined;
  try { storage = typeof localStorage === 'undefined' ? undefined : localStorage; } catch { /* Private storage may be blocked. */ }
  return {
    supported: mobile && available,
    vibrate: pattern => available ? navigator.vibrate(pattern) : false,
    now: () => performance.now(),
    visible: () => typeof document === 'undefined' || !document.hidden,
    storage,
    documentEvents: typeof document === 'undefined' ? undefined : document,
    windowEvents: typeof window === 'undefined' ? undefined : window,
  };
}

function patternFor(event: FeedbackEvent): VibratePattern | null {
  const strength = Number.isFinite(event.strength) ? Math.max(0, Math.min(1, event.strength)) : 0;
  if (strength <= 0) return null;
  switch (event.kind) {
    case 'open': return 6;
    case 'close': return 8 + Math.round(strength * 3);
    case 'impact': return strength < .08 ? null : 6 + Math.round(strength * 18);
    case 'chip': return strength < .18 ? null : 5 + Math.round(strength * 6);
    case 'crack': return [11, 16, 9];
    case 'break': return [16, 20, 10, 16, 18];
  }
}

/** Short optional actuator cues; unsupported browsers continue without a substitute vibration. */
export class DuoHaptics {
  private readonly environment: HapticEnvironment;
  private preference = true;
  private interacted = false;
  private active = false;
  private disposed = false;
  private lastPulse = -Infinity;
  private lastPriority = 0;
  private contacts = new Map<number, number>();

  constructor(environment: HapticEnvironment = browserEnvironment()) {
    this.environment = environment;
    try {
      const saved = JSON.parse(environment.storage?.getItem(STORAGE_KEY) ?? 'null') as { version?: number; enabled?: boolean } | null;
      if (saved?.version === 1 && typeof saved.enabled === 'boolean') this.preference = saved.enabled;
    } catch { /* The current preference remains usable without storage. */ }
    environment.documentEvents?.addEventListener('visibilitychange', this.visibilityChange);
    environment.documentEvents?.addEventListener('pointercancel', this.cancel);
    environment.windowEvents?.addEventListener('blur', this.cancel);
    environment.windowEvents?.addEventListener('pagehide', this.cancel);
  }

  get supported(): boolean { return this.environment.supported; }
  get enabled(): boolean { return this.preference; }

  unlock(): void {
    if (!this.disposed && this.environment.visible()) this.interacted = true;
  }

  toggle(): boolean {
    this.preference = !this.preference;
    if (!this.preference) this.stop();
    try { this.environment.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, enabled: this.preference })); }
    catch { /* A disabled storage backend does not prevent changing this session. */ }
    return this.preference;
  }

  /** A physics frame can contain many contacts; play at most its strongest useful cue. */
  play(events: readonly FeedbackEvent[]): boolean {
    if (this.disposed || !this.supported || !this.preference || !this.interacted || !this.environment.visible()) return false;
    const now = this.environment.now();
    if (!Number.isFinite(now)) return false;
    let chosen: FeedbackEvent | undefined;
    let pattern: VibratePattern | null = null;
    for (const event of events) {
      const candidate = patternFor(event);
      if (candidate === null) continue;
      if (event.contactId !== undefined && now - (this.contacts.get(event.contactId) ?? -Infinity) < 250) continue;
      if (!chosen || priority[event.kind] > priority[chosen.kind]
        || (priority[event.kind] === priority[chosen.kind] && event.strength > chosen.strength)) {
        chosen = event; pattern = candidate;
      }
    }
    if (!chosen || pattern === null) return false;
    const importance = priority[chosen.kind];
    // A genuine fracture can replace a lighter tap; ordinary taps never form a buzzing stream.
    if (now - this.lastPulse < 110 && !(importance >= 5 && this.lastPriority < 5)) return false;
    this.lastPulse = now;
    this.lastPriority = importance;
    if (chosen.contactId !== undefined) this.contacts.set(chosen.contactId, now);
    for (const [id, time] of this.contacts) if (now - time > 1500) this.contacts.delete(id);
    try {
      this.active = this.environment.vibrate(pattern);
      return this.active;
    } catch { this.active = false; return false; }
  }

  /** Cancel the native pattern immediately and require another interaction before new cues. */
  stop(): void {
    if (this.supported && this.active) {
      try { this.environment.vibrate(0); } catch { /* Cancellation can also be rejected by the device. */ }
    }
    this.active = false;
    this.interacted = false;
  }

  reset(): void {
    this.stop();
    this.lastPulse = -Infinity;
    this.lastPriority = 0;
    this.contacts.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.environment.documentEvents?.removeEventListener('visibilitychange', this.visibilityChange);
    this.environment.documentEvents?.removeEventListener('pointercancel', this.cancel);
    this.environment.windowEvents?.removeEventListener('blur', this.cancel);
    this.environment.windowEvents?.removeEventListener('pagehide', this.cancel);
  }

  private readonly cancel = (): void => this.stop();
  private readonly visibilityChange = (): void => { if (!this.environment.visible()) this.stop(); };
}
