/**
 * Ceilings for a 2019 16-inch MacBook Pro (Intel UHD Graphics 630, 1536 MB
 * shared). Fractal values are computed by CPU workers at up to these sizes
 * once the view settles; while it moves, the presenter shrinks the work to
 * keep a new frame arriving every few display frames. The optional GPU pass
 * only runs the simple escape formulas at shallow zoom, where 32-bit floats
 * are still exact enough.
 */
export const BUDGET = {
  maxPixels2d: 3072 * 1920,
  maxPixels3d: 560 * 315,
  maxPixelsIfs: 1920 * 1200,
  displayPixels: 3072 * 1920,
  settlePixels: 1536 * 960,
  maxIter: 400,
  minIter: 24,
  defaultIter: 48,
  maxSteps: 28,
  defaultSteps: 20,
  minSteps: 10,
  bulbIter: 6,
  boxIter: 6,
  mengerIter: 4,
  tetraIter: 8,
  maxIfsPoints: 2000000,
  interactArea: 0.38,
  minRadius: 1e-11,
  maxRadius: 16,
  minDist: 0.55,
  maxDist: 14,
};
