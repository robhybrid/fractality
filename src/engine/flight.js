import { BUDGET } from "../budget.js";
import { RAY_FOCAL, RAY_ITER_CAP, mapScene, sceneRadius } from "./kernel.js";

/**
 * Free-flight camera for the ray-marched fractals. The camera is a position
 * plus a view direction given as yaw and pitch, so the old orbit view
 * (looking at the origin from `dist` away) is just one particular pose.
 * Every move is scaled by the distance estimate at the camera, which is a
 * lower bound on the distance to the surface, so flying in never passes
 * through it and the same input keeps working at any depth.
 */

const BASE_ITERS = [BUDGET.bulbIter, BUDGET.boxIter, BUDGET.mengerIter, BUDGET.tetraIter];
// Extra fractal iterations per halving of the gap to the surface, roughly log(2) / log(per-iteration scale).
const ITER_RATE = [0.3, 0.3, 0.63, 1];
const MAX_PITCH = 1.45;

export function basis(yaw, pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward = [-cp * Math.sin(yaw), -sp, -cp * Math.cos(yaw)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { forward, right, up };
}

export function lookCamera(eye, yaw, pitch) {
  return { eye: eye.slice(), ...basis(yaw, pitch) };
}

/** Where the old orbit camera sat: `dist` from the origin, looking at it. */
export function orbitEye(yaw, pitch, dist) {
  const cp = Math.cos(pitch);
  return [dist * cp * Math.sin(yaw), dist * Math.sin(pitch), dist * cp * Math.cos(yaw)];
}

export function angles(dir) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return {
    yaw: Math.atan2(-dir[0], -dir[2]),
    pitch: clampPitch(Math.asin(Math.max(-1, Math.min(1, -dir[1] / len)))),
  };
}

export function clampPitch(p) {
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p));
}

export function wrapAngle(a) {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

/** Unit ray through screen point (nx, ny) in [-1, 1], with +ny up, matching the kernel. */
export function pixelRay(cam, nx, ny, aspect) {
  const d = [0, 1, 2].map((k) => cam.forward[k] * RAY_FOCAL + cam.right[k] * nx * aspect + cam.up[k] * ny);
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / len, d[1] / len, d[2] / len];
}

export function itersAt(shape, depth) {
  const base = BASE_ITERS[shape] ?? 5;
  return Math.min(RAY_ITER_CAP[shape] ?? base, base + Math.max(0, depth) * (ITER_RATE[shape] ?? 0.5));
}

function rawGap(eye, shape, power, iters) {
  const r = Math.hypot(eye[0], eye[1], eye[2]);
  const bound = sceneRadius(shape, power);
  // Far outside the bounding sphere the estimators get loose; the sphere is a safe lower bound there.
  if (r > bound * 1.5) return r - bound;
  return mapScene(eye[0], eye[1], eye[2], shape | 0, power, Math.round(iters));
}

/**
 * Distance estimate at the camera and the iteration count to render with.
 * More iterations carve the shape finer, so the gap is only a safe bound
 * for the surface drawn with the same count. The count moves one step at a
 * time and refuses a step that would suddenly put the camera next to new
 * surface, which keeps the detail from running away on dense formulas.
 */
export function probe(eye, shape, power, homeGap, prev = null) {
  const base = BASE_ITERS[shape] ?? 5;
  let iters = prev ?? base;
  let gap = rawGap(eye, shape, power, iters);
  const want = itersAt(shape, depthOf(gap, homeGap));
  if (want >= iters + 0.6 && iters < (RAY_ITER_CAP[shape] ?? base)) {
    const finer = rawGap(eye, shape, power, iters + 1);
    if (finer > gap * 0.75) {
      iters += 1;
      gap = finer;
    }
  } else if (want <= iters - 0.6 && iters > base) {
    iters -= 1;
    gap = rawGap(eye, shape, power, iters);
  }
  return { gap: gap > 0 ? gap : 0, iters };
}

export function gapAt(eye, shape, power, homeGap, iters) {
  return probe(eye, shape, power, homeGap, iters).gap;
}

export function baseGap(eye, shape, power) {
  return Math.max(1e-3, rawGap(eye, shape, power, BASE_ITERS[shape] ?? 5));
}

export function depthOf(gap, homeGap) {
  return Math.max(0, Math.log2(homeGap / Math.max(gap, BUDGET.minGap)));
}

/** March one ray on the main thread; returns the hit distance or -1. */
export function march(eye, dir, shape, power, iters, maxSteps = 300) {
  const bound = sceneRadius(shape, power);
  const b = eye[0] * dir[0] + eye[1] * dir[1] + eye[2] * dir[2];
  const c = eye[0] ** 2 + eye[1] ** 2 + eye[2] ** 2 - bound * bound;
  const disc = b * b - c;
  if (disc <= 0) return -1;
  const far = -b + Math.sqrt(disc);
  if (far <= 0) return -1;
  let t = Math.max(0, -b - Math.sqrt(disc));
  for (let i = 0; i < maxSteps && t <= far; i += 1) {
    const d = mapScene(eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t, shape, power, Math.round(iters));
    const eps = Math.max(1e-13, t * 1e-3);
    if (d < eps) return t;
    t += Math.min(0.4, Math.max(eps * 0.5, d * 0.92));
  }
  return -1;
}

/**
 * Distance from the eye to the point the view orbits around. Far from the
 * object that is the point on the view line nearest the origin, so the
 * home view still spins around the middle; close in it is the surface
 * under the screen center.
 */
export function pivotDistance(eye, yaw, pitch, shape, power, gap, iters) {
  const { forward } = basis(yaw, pitch);
  const toCenter = -(eye[0] * forward[0] + eye[1] * forward[1] + eye[2] * forward[2]);
  const hit = march(eye, forward, shape, power, iters);
  const near = hit > 0 ? hit : Math.max(gap * 2, toCenter);
  const r = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  const s = Math.max(0, Math.min(1, (gap / r - 0.1) / 0.2));
  const far = toCenter > gap ? toCenter : near;
  return Math.max(gap * 0.5, near + (far - near) * s, BUDGET.minGap);
}

/** Ray-march work for a camera this close to the surface. */
export function rayDetail(shape, gap, homeGap, iterScale, iters = null) {
  const depth = depthOf(gap, homeGap);
  const steps = Math.round(Math.min(BUDGET.maxRaySteps, (BUDGET.defaultSteps + depth * 2.5) * iterScale));
  return { iters: iters ?? Math.max(3, Math.round(itersAt(shape, depth))), steps: Math.max(BUDGET.minSteps, steps), depth };
}
