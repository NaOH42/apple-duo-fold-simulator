export const MAX_BUFFER_PIXELS = 2_500_000;

export interface RenderHints {
  width: number;
  height: number;
  devicePixelRatio: number;
  coarsePointer: boolean;
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

export interface RenderQuality {
  readonly tier: 'desktop' | 'mobile' | 'low';
  readonly mobile: boolean;
  readonly pixelRatio: number;
  readonly shadowMapSize: 512 | 1024;
  readonly maxBufferPixels: number;
}

const positive = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Limit raster work without changing geometry, touch coordinates, or simulation timing. */
export function renderQuality(hints: RenderHints): RenderQuality {
  const width = positive(hints.width) ? Math.max(1, Math.floor(hints.width)) : 1;
  const height = positive(hints.height) ? Math.max(1, Math.floor(hints.height)) : 1;
  const mobile = hints.coarsePointer || Math.min(width, height) < 700;
  const lowMemory = positive(hints.deviceMemory) && hints.deviceMemory <= 4;
  const lowConcurrency = positive(hints.hardwareConcurrency) && hints.hardwareConcurrency <= 4;
  const low = lowMemory || lowConcurrency;
  const cap = low ? 1.25 : mobile ? 1.5 : 1.75;
  const nativeRatio = positive(hints.devicePixelRatio) ? hints.devicePixelRatio : 1;
  const budgetRatio = Math.sqrt(MAX_BUFFER_PIXELS / (width * height));
  return {
    tier: low ? 'low' : mobile ? 'mobile' : 'desktop',
    mobile,
    pixelRatio: Math.min(nativeRatio, cap, budgetRatio),
    shadowMapSize: low ? 512 : 1024,
    maxBufferPixels: MAX_BUFFER_PIXELS,
  };
}
