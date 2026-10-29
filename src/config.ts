/** 1 model unit = 100 mm. width is ONE leaf; the spine adds 1.8 mm when closed.
 * Source: https://www.apple.com/iphone-duo/specs/ (checked 2026-10-28).
 * Open 164.6 × 117.8 × 5.2 mm; closed envelope 84.1 × 117.8 × 11.3 mm.
 */
export const PHONE = {
  width: 0.823, height: 1.178, thickness: 0.052, gap: 0,
  hingeZ: (0.113 - 0.052) / 2,
  closedWidth: 0.841, closedThickness: 0.113, spineOverhang: 0.018,
  cornerRadius: 0.085,
} as const;
/** Approximate rear module envelope measured from the official Star White reference images. */
export const CAMERA = {
  width: 0.64, height: 0.25, centerX: 0,
  centerY: PHONE.height / 2 - 0.185,
  islandDepth: 0.009, lensProtrusion: 0.027,
} as const;
export const FIXED_DT = 1 / 120;
export const MAX_FRAGMENTS = 24;
