import assert from "node:assert/strict";
import test from "node:test";
import { childOffset, frameSpec, renormStep } from "../src/engine/frames.js";
import { buildTracks, centerInFrame, samplePose, totalTime, zoomWeights } from "../src/engine/movie.js";

const STOPS = [
  { t: 0, color: "#000000" },
  { t: 1, color: "#ffffff" },
];

function key(view, { fractal = 0, family = "escape", frameKind = null, duration = 4, easing = "smooth", color = {}, params = {} } = {}) {
  return {
    fractal,
    family,
    frameKind,
    view: { frame: [], rotation: 0, yaw: 0, pitch: 0, dist: 3, ...view },
    params: { power: 2, bailout: 64, juliaRe: 0, juliaIm: 0, extra: 0, ...params },
    iter: { autoIter: true, iterBias: 48 },
    color: { phase: 0, paletteSpeed: 0, animatePalette: false, density: 0.085, exposure: 1, edge: 0.5, post: 1, colorMode: 0, colorInterior: false, paletteIndex: 0, stops: STOPS, ...color },
    duration,
    easing,
  };
}

function samples(keys, n = 400) {
  const tracks = buildTracks(keys);
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push(samplePose(keys, (tracks.total * i) / n, tracks));
  return out;
}

/** Root coordinates of a framed pose. */
function toRoot(kind, view) {
  const scale = frameSpec(kind).scale;
  let x = view.cx;
  let y = view.cy;
  let logR = view.logR;
  for (let j = view.frame.length - 1; j >= 0; j -= 1) {
    const [ox, oy] = childOffset(kind, view.frame[j]);
    x = x / scale + ox;
    y = y / scale + oy;
    logR -= Math.log(scale);
  }
  return { x, y, logR };
}

test("zoom keeps one point fixed on screen and lands exactly on the deep key", () => {
  const a = key({ cx: -0.75, cy: 0, logR: Math.log(1.35) });
  const b = key({ cx: -0.745, cy: 0.112, logR: Math.log(0.018) });
  const poses = samples([a, b]);
  const ra = 1.35;
  const rb = 0.018;
  const px = -0.745 - ((-0.75 - -0.745) * rb) / (ra - rb);
  const py = 0.112 - ((0 - 0.112) * rb) / (ra - rb);
  let prev = null;
  for (const pose of poses) {
    const r = Math.exp(pose.view.logR);
    const sx = (px - pose.view.cx) / r;
    const sy = (py - pose.view.cy) / r;
    assert.ok(Math.abs(sx - (px + 0.75) / ra) < 1e-9);
    assert.ok(Math.abs(sy - py / ra) < 1e-9);
    if (prev) {
      assert.ok(pose.view.logR <= prev.view.logR + 1e-12, "zoom is monotone");
      assert.ok(Math.abs(pose.view.logR - prev.view.logR) < 0.05, "no jump in log radius");
      const step = Math.hypot(pose.view.cx - prev.view.cx, pose.view.cy - prev.view.cy) / Math.exp(pose.view.logR);
      assert.ok(step < 0.05, `center moves at most a few % of the screen per step (${step})`);
    }
    prev = pose;
  }
  assert.equal(poses[0].view.cx, -0.75);
  assert.equal(poses.at(-1).view.cx, -0.745);
  assert.equal(poses.at(-1).view.cy, 0.112);
});

test("zoom weights stay finite and exact for huge zoom ratios", () => {
  const [s, rest] = zoomWeights(0, -1500, -1500);
  assert.ok(Math.abs(s) < 1e-300);
  assert.equal(rest, 1);
  const [s2, rest2] = zoomWeights(-1500, 0, -1500);
  assert.equal(s2, 1);
  assert.ok(Math.abs(rest2) < 1e-300);
  const [s3, r3] = zoomWeights(0, -2, -1);
  assert.ok(Math.abs(s3 + r3 - 1) < 1e-15);
});

test("monotone tangents never overshoot a key", () => {
  const keys = [key({ cx: 0, cy: 0, logR: 0 }), key({ cx: 0, cy: 0, logR: -4 }), key({ cx: 0, cy: 0, logR: -4.1 })];
  for (const pose of samples(keys)) {
    assert.ok(pose.view.logR <= 1e-12 && pose.view.logR >= -4.1 - 1e-12);
  }
  const tracks = buildTracks(keys);
  const at = (t) => samplePose(keys, t, tracks).view.logR;
  const e = 1e-5;
  const left = (at(4) - at(4 - e)) / e;
  const right = (at(4 + e) - at(4)) / e;
  assert.ok(Math.abs(left - right) < 1e-3, "velocity is continuous through the middle key");
});

test("rotation takes the short way around", () => {
  const keys = [key({ cx: 0, cy: 0, logR: 0, rotation: 3 }), key({ cx: 0, cy: 0, logR: 0, rotation: -3 })];
  const mid = samplePose(keys, totalTime(keys) / 2);
  assert.ok(Math.abs(Math.abs(mid.view.rotation) - Math.PI) < 1e-9);
});

test("palette phase drifts at the key's speed and lands on the next key's phase", () => {
  const keys = [
    key({ cx: 0, cy: 0, logR: 0 }, { color: { phase: 0.2, paletteSpeed: 0.1, animatePalette: true } }),
    key({ cx: 0, cy: 0, logR: 0 }, { color: { phase: 0.9, paletteSpeed: 0.1, animatePalette: true } }),
  ];
  const tracks = buildTracks(keys);
  const end = samplePose(keys, 4, tracks).color.phase;
  assert.ok(Math.abs(end - Math.round(end - 0.9) - 0.9) < 1e-12);
  const v0 = (samplePose(keys, 1e-5, tracks).color.phase - 0.2) / 1e-5;
  assert.ok(Math.abs(v0 - 0.1) < 1e-3);
});

test("palettes crossfade and discrete fields cut at the key", () => {
  const other = [{ t: 0, color: "#ff0000" }, { t: 0.5, color: "#00ff00" }, { t: 1, color: "#0000ff" }];
  const keys = [key({ cx: 0, cy: 0, logR: 0 }), key({ cx: 0, cy: 0, logR: 0 }, { color: { stops: other, colorMode: 3 } })];
  const mid = samplePose(keys, 2);
  assert.equal(mid.palette.a, STOPS);
  assert.equal(mid.palette.b, other);
  assert.ok(mid.palette.mix > 0.4 && mid.palette.mix < 0.6);
  assert.equal(mid.color.colorMode, 0);
  assert.equal(samplePose(keys, 4).color.colorMode, 3);
});

test("a change of fractal holds the first view, then cuts", () => {
  const keys = [key({ cx: -0.75, cy: 0, logR: 0 }), key({ yaw: 1, pitch: 0.2, dist: 4 }, { fractal: 3, family: "ray" })];
  const mid = samplePose(keys, 3.9);
  assert.equal(mid.fractal, 0);
  assert.equal(mid.view.cx, -0.75);
  const end = samplePose(keys, 4);
  assert.equal(end.fractal, 3);
  assert.equal(end.view.yaw, 1);
});

test("3D orbit keys interpolate yaw, pitch and distance smoothly", () => {
  const ray = { fractal: 3, family: "ray" };
  const keys = [key({ yaw: 0.45, pitch: 0.4, dist: 5.2 }, ray), key({ yaw: 1.6, pitch: 0.1, dist: 2.2 }, ray)];
  let prev = null;
  for (const pose of samples(keys)) {
    if (prev) {
      assert.ok(Math.abs(pose.view.yaw - prev.view.yaw) < 0.02);
      assert.ok(Math.abs(Math.log(pose.view.dist / prev.view.dist)) < 0.01);
    }
    prev = pose;
  }
  assert.ok(Math.abs(prev.view.dist - 2.2) < 1e-12);
});

function settle(kind, view, aspect = 16 / 9) {
  for (let guard = 0; guard < 4096; guard += 1) {
    const step = renormStep(kind, view.frame, view.cx, view.cy, Math.exp(view.logR) * Math.hypot(1, aspect));
    if (!step) break;
    view.frame = step.digits;
    view.cx = (view.cx - step.ox) * step.S;
    view.cy = (view.cy - step.oy) * step.S;
    view.logR += Math.log(step.S);
  }
  return view;
}

for (const kind of ["tri", "square"]) {
  test(`framed ${kind} keys at different depths interpolate in root terms`, () => {
    const opts = { fractal: kind === "tri" ? 16 : 17, family: "shape", frameKind: kind };
    const shallow = settle(kind, { frame: [], cx: 0.5, cy: 0.4, logR: Math.log(0.62), rotation: 0 });
    const target = kind === "tri" ? [0.25, 0.0] : [1 / 3, 1 / 3];
    const deep = settle(kind, { frame: [], cx: target[0] + 1e-9, cy: target[1] + 2e-9, logR: Math.log(0.62), rotation: 0 });
    for (let i = 0; i < 40; i += 1) {
      deep.logR -= Math.log(2);
      settle(kind, deep);
    }
    assert.ok(deep.frame.length > 20, `deep key is many frames down (${deep.frame.length})`);
    const keys = [key(shallow, opts), key({ ...deep, frame: deep.frame.slice() }, opts)];
    const [dx, dy] = centerInFrame(keys[0], deep.frame);
    assert.ok(Number.isFinite(dx) && Number.isFinite(dy));
    const span = Math.abs(toRoot(kind, shallow).logR - toRoot(kind, deep).logR);
    let prev = null;
    for (const pose of samples(keys)) {
      const view = settle(kind, { ...pose.view, frame: pose.view.frame.slice() });
      const root = toRoot(kind, view);
      const direct = toRoot(kind, pose.view);
      assert.ok(Math.abs(root.logR - direct.logR) < 1e-9, "renormalizing keeps the zoom");
      if (prev) {
        assert.ok(Math.abs(root.logR - prev.logR) < (2 * span) / 400, "no jump in zoom");
        const r = Math.exp(Math.max(root.logR, prev.logR));
        assert.ok(Math.hypot(root.x - prev.x, root.y - prev.y) / r < 0.1, "no jump in center");
      }
      prev = root;
    }
    const end = samplePose(keys, totalTime(keys));
    assert.deepEqual(end.view.frame, deep.frame);
    assert.equal(end.view.cx, deep.cx);
    assert.equal(end.view.cy, deep.cy);
    const start = toRoot(kind, samplePose(keys, 0).view);
    const s0 = toRoot(kind, shallow);
    assert.ok(Math.abs(start.x - s0.x) < 1e-12 && Math.abs(start.logR - s0.logR) < 1e-12);
  });
}
