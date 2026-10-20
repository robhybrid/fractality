/**
 * Thermal budget for a 2019 16-inch MacBook Pro on Intel UHD Graphics 630
 * (1536 MB shared). The fractal pass is the expensive one. Palette drift is
 * a fullscreen color lookup and stays cheap.
 *
 * The browser is asked for the low-power GPU (the integrated chip, not a
 * discrete card). Nothing here is allowed to exceed these ceilings, even
 * when frames are fast.
 */
export const BUDGET = {
  maxPixels2d: 1280 * 720,
  maxPixels3d: 512 * 288,
  maxPixelsIfs: 960 * 540,
  displayPixels: 1600 * 900,
  maxIter: 64,
  minIter: 24,
  defaultIter: 48,
  maxSteps: 28,
  defaultSteps: 20,
  minSteps: 10,
  bulbIter: 6,
  boxIter: 6,
  mengerIter: 4,
  tetraIter: 8,
  maxIfsPoints: 50000,
  interactArea: 0.38,
  minRadius: 0.00008,
  maxRadius: 16,
  minDist: 0.55,
  maxDist: 14,
};
