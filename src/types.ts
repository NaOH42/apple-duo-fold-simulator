import type { Vector3, Quaternion } from 'three';
export type HalfId = 0 | 1;
export type Mode = 'free' | 'challenge';
export interface BodyPose { position: Vector3; quaternion: Quaternion }
export type ContactMaterial = 'metal' | 'glass' | 'back';
export interface ContactSample {
  id: number; half: HalfId; material: ContactMaterial;
  point: Vector3; normal: Vector3; table: boolean;
  speed: number; tangentialSpeed: number; impulse: number;
  fragment?: boolean;
}
export interface FragmentPose extends BodyPose {
  id?: number; material?: ContactMaterial; size?: Vector3; generation?: number;
}
export interface RetiredPhone {
  id: number; poses: [BodyPose, BodyPose]; damage: DamageState;
  visible: [boolean, boolean];
}
export interface PhysicsSample {
  angle: number; angularSpeed: number; strain: number;
  impact: number; hardStop: number; speed: number;
  contacts?: ContactSample[];
  scrape?: ContactSample;
  fractures?: ContactSample[];
}
export type FeedbackKind = 'close' | 'open' | 'impact' | 'crack' | 'break' | 'chip';
export interface FeedbackEvent {
  kind: FeedbackKind; strength: number; pan?: number;
  material?: ContactMaterial; point?: Vector3; normal?: Vector3;
  table?: boolean; half?: HalfId; contactId?: number;
}
export interface FeedbackFrame {
  angularSpeed: number; signedSpeed: number; strain: number;
  hingeHealth: number; broken: boolean; pan: number;
  scrapeSpeed: number; scrapeMaterial: ContactMaterial;
}
/** screen and hinge are remaining health, 0..100; broken means detached hinge. */
export interface DamageState { screen: number; hinge: number; broken: boolean }
export interface RoundResult {
  reason: 'banked' | 'screen' | 'hinge'; folds: number; baseScore: number;
  bonus: number; score: number; screen: number; hinge: number;
}
export interface GameState {
  mode: Mode; folds: number; score: number; multiplier: number;
  screen: number; hinge: number; broken: boolean; strain: number;
  angle: number; running: boolean; result: RoundResult | null;
  bestScore: number; bestFolds: number; sound: boolean;
}
export interface Grip {
  id: number; half: HalfId; localPoint: Vector3; localNormal: Vector3;
  target: Vector3;
}
export interface SimPhysics {
  poses: [BodyPose, BodyPose]; grips: Map<number, Grip>;
  setGrip(grip: Grip): void; releaseGrip(id: number): void; releaseAll(): void;
  reset(): void; breakHinge(): void; step(dt: number): PhysicsSample;
  setDamage(damage: DamageState): void;
  fragments: BodyPose[];
  activeVisible?: [boolean, boolean];
}
