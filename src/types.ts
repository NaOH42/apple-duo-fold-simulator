import type { Vector3, Quaternion } from 'three';
export type HalfId = 0 | 1;
export type Mode = 'free' | 'challenge';
export interface BodyPose { position: Vector3; quaternion: Quaternion }
export interface PhysicsSample {
  angle: number; angularSpeed: number; strain: number;
  impact: number; hardStop: number; speed: number;
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
}
