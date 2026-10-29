import type { FeedbackEvent, FeedbackFrame, GameState, PhysicsSample } from './types';

const unit = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
const initialFrame = (): FeedbackFrame => ({ angularSpeed: 0, signedSpeed: 0, strain: 0,
  hingeHealth: 100, broken: false, pan: 0, scrapeSpeed: 0, scrapeMaterial: 'back' });

/** Per-step physical cues, independent of score and damage thresholds. */
export class DuoFeedback {
  frame = initialFrame();
  private angle: number | null = null;
  private openArmed = false;
  private closeArmed = false;
  private peakSpeed = 0;
  private fallbackImpact = false;
  private seen = new Set<number>();

  reset(): void {
    this.frame = initialFrame(); this.angle = null; this.openArmed = this.closeArmed = false;
    this.peakSpeed = 0; this.fallbackImpact = false; this.seen.clear();
  }

  step(sample: PhysicsSample, state: Pick<GameState, 'hinge' | 'broken' | 'screen'>,
    damageEvents: readonly string[], dt: number): FeedbackEvent[] {
    if (!Number.isFinite(dt) || dt <= 0) return [];
    const events: FeedbackEvent[] = [];
    const angle = Math.max(0, Math.min(180, sample.angle));
    const signed = this.angle === null ? 0 : Math.max(-40, Math.min(40, (angle - this.angle) * Math.PI / 180 / dt));
    this.frame.signedSpeed += (signed - this.frame.signedSpeed) * -Math.expm1(-dt * 22);
    this.frame.angularSpeed = state.broken ? 0 : sample.angularSpeed;
    this.frame.strain = sample.strain;
    this.frame.hingeHealth = state.hinge;
    this.frame.broken = state.broken;
    this.frame.scrapeSpeed = sample.scrape?.tangentialSpeed ?? 0;
    this.frame.scrapeMaterial = sample.scrape?.material ?? 'back';
    this.peakSpeed = Math.max(sample.angularSpeed, this.peakSpeed * Math.exp(-dt * 8));
    if (this.angle !== null && !state.broken) {
      if (angle >= 24) this.closeArmed = true;
      if (angle <= 155) this.openArmed = true;
      if (this.closeArmed && angle <= 7) {
        events.push({ kind: 'close', strength: .2 + unit(this.peakSpeed / 14) * .8, material: 'metal' });
        this.closeArmed = false;
      }
      if (this.openArmed && angle >= 174) {
        events.push({ kind: 'open', strength: .15 + unit(this.peakSpeed / 14) * .65, material: 'metal' });
        this.openArmed = false;
      }
    }
    this.angle = angle;

    for (const contact of [...(sample.contacts ?? []), ...(sample.fractures ?? [])]) {
      if (this.seen.has(contact.id)) continue;
      this.seen.add(contact.id);
      if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
      const fracture = sample.fractures?.includes(contact);
      const body = contact.impulse > 0 ? Math.min(1, .3 + Math.sqrt(contact.impulse * 8)) : .5;
      const strength = Math.max(.04, unit((contact.speed - .12) / 7.5) * body);
      events.push({ kind: fracture || contact.fragment ? 'chip' : 'impact', strength,
        material: contact.material, point: contact.point, normal: contact.normal, table: contact.table,
        half: contact.half, contactId: contact.id });
    }
    // Compatibility for an engine sample without detailed contact data, never double-play new contacts.
    if (!sample.contacts && sample.impact > 1 && !this.fallbackImpact) {
      events.push({ kind: 'impact', strength: unit(sample.impact / 9), material: 'metal' });
    }
    this.fallbackImpact = sample.impact > 1;
    if (damageEvents.includes('break')) events.push({ kind: 'break', strength: .85, material: 'metal' });
    else if (damageEvents.includes('crack')) events.push({ kind: 'crack', strength: .35 + unit(sample.strain) * .4, material: 'glass' });
    const priority = (event: FeedbackEvent) => (event.kind === 'break' ? 5 : event.kind === 'crack' ? 4 : event.kind === 'chip' ? 2 : 1) + event.strength;
    return events.sort((a, b) => priority(b) - priority(a)).slice(0, 5);
  }
}
