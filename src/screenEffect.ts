import { MeshBasicMaterial, Texture } from 'three';

export interface ScreenEffect {
  power: number;
  frost: number;
}

const clamp = (value: number, low: number, high: number, fallback: number): number =>
  Number.isNaN(value) ? fallback : Math.min(high, Math.max(low, value));
const unit = (value: number, fallback = 0): number => clamp(value, 0, 1, fallback);
const smooth = (from: number, to: number, value: number): number => {
  const t = unit((value - from) / (to - from));
  return t * t * (3 - 2 * t);
};

/** Angle drives a reversible screen handoff; damage remains the caller's final authority. */
export function screenTarget(angle: number, outer: boolean, broken: boolean): ScreenEffect {
  if (broken) return { power: outer ? .65 : .8, frost: 0 };
  const degrees = clamp(angle, 0, 180, 180);
  return outer
    ? { power: 1 - smooth(18, 65, degrees), frost: smooth(0, 40, degrees) }
    : { power: smooth(12, 65, degrees), frost: 1 - smooth(35, 145, degrees) };
}

/** 55ms time constant: about 96% of a stationary transition completes within 180ms. */
export function followScreen(current: ScreenEffect, target: ScreenEffect, dt: number): ScreenEffect {
  const destination = { power: unit(target.power), frost: unit(target.frost) };
  const start = {
    power: unit(current.power, destination.power),
    frost: unit(current.frost, destination.frost),
  };
  const seconds = Number.isNaN(dt) || dt <= 0 ? 0 : dt;
  const blend = -Math.expm1(-seconds / .055);
  return {
    power: start.power + (destination.power - start.power) * blend,
    frost: start.frost + (destination.frost - start.frost) * blend,
  };
}

const GLASS_MAP = /* glsl */`
#ifdef USE_MAP
  vec2 duoUv = clamp(vMapUv, vec2(0.001), vec2(0.999));
  float duoFrost = clamp(duoGlassFrost, 0.0, 1.0);
  // Inner leaves share the same full-display UVs; their hinge meets at u = .5.
  float duoAcross = mix(abs(duoUv.x - 0.5) * 2.0, duoUv.x, duoGlassOuter);
  float duoGradient = 0.6 * (1.0 - duoUv.y) + 0.4 * duoAcross;
  float duoAmount = clamp(duoFrost + duoFrost * (1.0 - duoFrost) *
    (duoGradient - 0.5) * 0.8, 0.0, 1.0);
  vec2 duoRefraction = vec2(
    sin(duoUv.y * 6.283185 + duoAcross * 1.4),
    cos(duoUv.x * 5.0 + duoUv.y * 2.0)
  ) * (0.0022 * duoAmount);
  vec4 duoSharp = texture2D(map, clamp(duoUv + duoRefraction, vec2(0.001), vec2(0.999)));
  vec4 duoSoft = texture2D(duoBlurredMap, clamp(duoUv - duoRefraction * 0.5, vec2(0.001), vec2(0.999)));
  vec4 sampledDiffuseColor = mix(duoSharp, duoSoft, duoAmount);
  vec3 duoMilk = mix(vec3(0.73, 0.82, 0.89), vec3(0.98, 0.91, 0.79),
    clamp(duoUv.y * 0.52 + duoAcross * 0.18, 0.0, 1.0));
  float duoVeil = duoAmount * (0.10 + 0.13 * smoothstep(0.05, 0.95, 1.0 - duoUv.y));
  sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, duoMilk, duoVeil);
  // Multiply last so a powered-off or damaged display cannot be lit by the veil.
  diffuseColor *= sampledDiffuseColor;
#endif
`;

/** Reuses two cached textures; animation changes uniforms without recompiling or CPU blur. */
export class FoldScreenMaterial extends MeshBasicMaterial {
  readonly blurredMap: Texture;
  private readonly frostUniform = { value: 0 };

  constructor(sharp: Texture, blurred: Texture, outer: boolean) {
    super({ map: sharp, toneMapped: false, fog: false });
    this.blurredMap = blurred;
    this.onBeforeCompile = shader => {
      shader.uniforms.duoBlurredMap = { value: this.blurredMap };
      shader.uniforms.duoGlassFrost = this.frostUniform;
      shader.uniforms.duoGlassOuter = { value: outer ? 1 : 0 };
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_pars_fragment>', `
#include <map_pars_fragment>
uniform sampler2D duoBlurredMap;
uniform float duoGlassFrost;
uniform float duoGlassOuter;
`).replace('#include <map_fragment>', GLASS_MAP);
    };
  }

  setFrost(amount: number): void {
    this.frostUniform.value = unit(amount);
  }

  customProgramCacheKey(): string { return 'duo-fold-glass-v1'; }
}
