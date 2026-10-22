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
  maxPixels3d: 960 * 540,
  maxPixelsIfs: 1920 * 1200,
  displayPixels: 3072 * 1920,
  settlePixels: 1920 * 1080,
  maxIter: 400,
  minIter: 24,
  defaultIter: 48,
  maxSteps: 28,
  defaultSteps: 20,
  minSteps: 10,
  maxRaySteps: 44,
  bulbIter: 5,
  boxIter: 5,
  mengerIter: 4,
  tetraIter: 5,
  juliabulbIter: 5,
  quatIter: 6,
  hybridIter: 5,
  maxIfsPoints: 2000000,
  interactArea: 0.55,
  zoomIn: 0.52,
  zoomOut: -0.48,
  minRadius: 1e-11,
  maxRadius: 16,
  maxDist: 14,
  minGap: 1e-9,
};
