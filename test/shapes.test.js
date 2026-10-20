import assert from "node:assert/strict";
import test from "node:test";
import { anchorPoint, childOffset, frameInfo, frameSpec, renormStep } from "../src/engine/frames.js";
import { createBuffer, fillAll, fillRows } from "../src/engine/kernel.js";

const H = 0.8660254037844386;
const W = 384;
const HT = 240;

function settle(kind, view) {
  const reach = () => view.radius * Math.hypot(1, view.w / view.h);
  for (let guard = 0; guard < 4096; guard += 1) {
    const step = renormStep(kind, view.digits, view.cx, view.cy, reach());
    if (!step) break;
    view.digits = step.digits;
    view.cx = (view.cx - step.ox) * step.S;
    view.cy = (view.cy - step.oy) * step.S;
    view.radius *= step.S;
  }
  return view;
}

function localState(formula, kind, view, rotation) {
  return {
    family: "shape",
    formula,
    cx: view.cx,
    cy: view.cy,
    radius: view.radius,
    rotation,
    w: view.w,
    h: view.h,
    frame: frameInfo(kind, view.digits),
  };
}

/** Plain world-coordinate render, iterating every level from the root. */
function reference(formula, cx, cy, radius, rotation, w, h, levels) {
  const out = { iter: new Float32Array(w * h), alpha: new Uint8Array(w * h), inside: new Uint8Array(w * h) };
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const aspect = w / h;
  for (let y = 0; y < h; y += 1) {
    const py = (1 - ((y + 0.5) / h) * 2) * radius;
    for (let x = 0; x < w; x += 1) {
      const px = (((x + 0.5) / w) * 2 - 1) * aspect * radius;
      const wx = cx + px * c - py * s;
      const wy = cy + px * s + py * c;
      const i = y * w + x;
      if (formula === 12) {
        let gz = wy / H;
        let gy = wx - 0.5 * gz;
        let gx = 1 - gy - gz;
        if (gx < 0 || gy < 0 || gz < 0) continue;
        out.inside[i] = 1;
        for (let k = 0; k < levels; k += 1) {
          if (gx < 0.5 && gy < 0.5 && gz < 0.5) {
            out.iter[i] = k * 3;
            out.alpha[i] = 1;
            break;
          }
          gx = gx >= 0.5 ? gx * 2 - 1 : gx * 2;
          gy = gy >= 0.5 ? gy * 2 - 1 : gy * 2;
          gz = gz >= 0.5 ? gz * 2 - 1 : gz * 2;
        }
      } else {
        if (wx < 0 || wy < 0 || wx >= 1 || wy >= 1) continue;
        out.inside[i] = 1;
        let u = wx;
        let v = wy;
        for (let k = 0; k < levels; k += 1) {
          u *= 3;
          v *= 3;
          const a = Math.min(2, Math.floor(u));
          const b = Math.min(2, Math.floor(v));
          if (a === 1 && b === 1) {
            out.iter[i] = k * 3;
            out.alpha[i] = 1;
            break;
          }
          u -= a;
          v -= b;
        }
      }
    }
  }
  return out;
}

function gasketPoint(path) {
  let x = 0;
  let y = 0;
  let size = 1;
  for (const d of path) {
    size /= 2;
    if (d === 1) x += size;
    if (d === 2) {
      x += size / 2;
      y += size * H;
    }
  }
  return [x + size * 0.4, y + size * 0.2];
}

function compare(formula, kind, wx, wy, depth, rotation) {
  const base = frameSpec(kind).scale;
  const radius = 0.3 * base ** -depth;
  const view = settle(kind, { digits: [], cx: wx, cy: wy, radius, w: W, h: HT });
  assert.ok(Math.abs(view.digits.length - depth) <= 2, `frame depth ${view.digits.length} near ${depth}`);
  const state = localState(formula, kind, view, rotation);
  const buf = createBuffer(W, HT);
  fillAll(buf, state);
  const pixel = (2 * view.radius) / HT;
  const extra = formula === 12 ? Math.ceil(Math.log2(1 / pixel)) + 3 : Math.ceil(Math.log(1 / pixel) / Math.log(3)) + 2;
  const ref = reference(formula, wx, wy, radius, rotation, W, HT, view.digits.length + extra);
  let inside = 0;
  let same = 0;
  let holes = new Set();
  for (let i = 0; i < W * HT; i += 1) {
    if (!ref.inside[i]) continue;
    inside += 1;
    if (ref.alpha[i] === buf.alpha[i] && (!ref.alpha[i] || ref.iter[i] === buf.iter[i])) same += 1;
    if (buf.alpha[i]) holes.add(buf.iter[i]);
  }
  return { inside, match: same / inside, holes: holes.size };
}

function structure(buf) {
  let lace = 0;
  const tones = new Set();
  for (let i = 0; i < buf.alpha.length; i += 1) {
    if (buf.alpha[i]) tones.add(buf.iter[i]);
    else lace += 1;
  }
  return { lace: lace / buf.alpha.length, tones: tones.size };
}

test("triangle matches a world-coordinate render 20 levels deep", (t) => {
  const spots = [
    [...gasketPoint([2, 0, 1, 1, 0, 2, 2, 1, 0, 0, 1, 2, 0, 1, 2, 2, 1, 0, 1, 0, 2, 2]), 0],
    [0.5 + 2e-7, 1e-7, 0.4],
    [0.25 + 4e-8, 0.4330127 + 1e-8, 1.1],
    [...gasketPoint([1, 1, 0, 2, 0, 1, 2, 0, 0, 2, 1, 1, 2, 0, 2, 1, 0, 0, 2, 1, 1, 2]), -0.7],
  ];
  for (const [x, y, rot] of spots) {
    const r = compare(12, "tri", x, y, 20, rot);
    t.diagnostic(`(${x}, ${y}) rot ${rot}: ${(r.match * 100).toFixed(3)}% of ${r.inside} pixels, ${r.holes} hole colors`);
    assert.ok(r.inside > 1000, "view is on the triangle");
    assert.ok(r.match > 0.995, `match ${r.match}`);
  }
});

test("carpet matches a world-coordinate render 12 levels deep", (t) => {
  const spots = [
    [0.1 + 1e-7, 0.27 + 3e-7, 0],
    [1 / 3 + 1e-8, 0.5 + 1e-8, 0.5],
    [0.70123, 0.04567, -1.2],
  ];
  for (const [x, y, rot] of spots) {
    const r = compare(13, "square", x, y, 12, rot);
    t.diagnostic(`(${x}, ${y}) rot ${rot}: ${(r.match * 100).toFixed(3)}% of ${r.inside} pixels, ${r.holes} hole colors`);
    assert.ok(r.inside > 1000, "view is on the carpet");
    assert.ok(r.match > 0.995, `match ${r.match}`);
  }
});

test("root views match too", () => {
  assert.ok(compare(12, "tri", 0.5, 0.433, 0, 0).match > 0.995);
  assert.ok(compare(13, "square", 0.5, 0.5, 0, 0.2).match > 0.995);
});

function zoomDeep(kind, formula, levels, seed) {
  let rand = seed;
  const next = () => {
    rand = (Math.imul(rand, 1103515245) + 12345) >>> 0;
    return rand / 2 ** 32;
  };
  const view = settle(kind, { digits: [], cx: 0.5, cy: kind === "tri" ? 0.433 : 0.5, radius: 0.62, w: W, h: HT });
  while (view.digits.length < levels) {
    const factor = 0.8;
    const tx = view.cx + (next() - 0.5) * view.radius;
    const ty = view.cy + (next() - 0.5) * view.radius;
    view.cx = tx + (view.cx - tx) * factor;
    view.cy = ty + (view.cy - ty) * factor;
    view.radius *= factor;
    const anchor = anchorPoint(frameInfo(kind, view.digits), view.cx, view.cy);
    if (anchor) {
      view.cx += (anchor[0] - view.cx) * 0.5;
      view.cy += (anchor[1] - view.cy) * 0.5;
    }
    settle(kind, view);
    assert.ok(view.radius > 0.05 && view.radius < 1.5, `local radius stays near 1 (${view.radius})`);
  }
  return view;
}

test("deep zoom keeps rendering structure", (t) => {
  for (const [kind, formula, levels] of [
    ["tri", 12, 260],
    ["square", 13, 160],
  ]) {
    for (const seed of [1, 7, 42]) {
      const view = zoomDeep(kind, formula, levels, seed);
      const buf = createBuffer(W, HT);
      fillAll(buf, localState(formula, kind, view, 0.3));
      const s = structure(buf);
      t.diagnostic(`${kind} seed ${seed} depth ${view.digits.length}: ${s.tones} hole colors, ${(s.lace * 100).toFixed(1)}% lace`);
      assert.ok(s.tones >= 6, `${kind} depth ${view.digits.length}: ${s.tones} hole colors`);
      assert.ok(s.lace > 0.003 && s.lace < 0.9, `${kind} depth ${view.digits.length}: lace ${s.lace}`);
    }
  }
});

test("hole colors are stable across a frame change", () => {
  const view = settle("tri", { digits: [], cx: 0.3125 + 1e-9, cy: 0.2 + 1e-9, radius: 0.3 * 2 ** -30, w: W, h: HT });
  const a = createBuffer(W, HT);
  fillAll(a, localState(12, "tri", view, 0));
  const [ox, oy] = childOffset("tri", view.digits[view.digits.length - 1]);
  const parent = { ...view, digits: view.digits.slice(0, -1), cx: view.cx / 2 + ox, cy: view.cy / 2 + oy, radius: view.radius / 2 };
  const b = createBuffer(W, HT);
  fillAll(b, localState(12, "tri", parent, 0));
  let same = 0;
  for (let i = 0; i < W * HT; i += 1) if (a.alpha[i] === b.alpha[i] && a.iter[i] === b.iter[i]) same += 1;
  assert.ok(same / (W * HT) > 0.995, `match ${same / (W * HT)}`);
});

test("every frame change during a zoom and pan leaves the image unchanged", (t) => {
  for (const [kind, formula] of [
    ["tri", 12],
    ["square", 13],
  ]) {
    const view = settle(kind, { digits: [], cx: 0.5, cy: kind === "tri" ? 0.3 : 0.5, radius: 0.62, w: 192, h: 120 });
    const reach = () => view.radius * Math.hypot(1, view.w / view.h);
    let changes = 0;
    let worst = 1;
    for (let tick = 0; tick < 900; tick += 1) {
      const zoom = tick < 600 ? 0.97 : 1.04;
      view.radius *= zoom;
      view.cx += Math.sin(tick * 0.05) * view.radius * 0.08;
      view.cy += Math.cos(tick * 0.031) * view.radius * 0.08;
      const anchor = anchorPoint(frameInfo(kind, view.digits), view.cx, view.cy);
      if (anchor && zoom < 1) {
        view.cx += (anchor[0] - view.cx) * 0.075;
        view.cy += (anchor[1] - view.cy) * 0.075;
      }
      const step = renormStep(kind, view.digits, view.cx, view.cy, reach());
      if (!step) continue;
      const before = createBuffer(view.w, view.h);
      fillAll(before, localState(formula, kind, view, 0.25));
      settle(kind, view);
      const after = createBuffer(view.w, view.h);
      fillAll(after, localState(formula, kind, view, 0.25));
      let same = 0;
      for (let i = 0; i < before.alpha.length; i += 1) {
        if (before.alpha[i] === after.alpha[i] && Math.abs(before.iter[i] - after.iter[i]) < 1e-3) same += 1;
      }
      worst = Math.min(worst, same / before.alpha.length);
      changes += 1;
    }
    t.diagnostic(`${kind}: ${changes} frame changes, worst match ${(worst * 100).toFixed(3)}%`);
    assert.ok(changes > 20);
    assert.ok(worst > 0.99, `${kind} worst ${worst}`);
  }
});

test("holding zoom at off-center points, even past the root's edge, stays on structure", (t) => {
  const w = 1024;
  const h = 640;
  for (const [sx, sy] of [
    [300, 500],
    [511, 541],
    [100, 100],
    [900, 620],
  ]) {
    const view = settle("tri", { digits: [], cx: 0.5, cy: 0.433, radius: 0.62, w, h });
    let info = frameInfo("tri", view.digits);
    for (let tick = 0; tick < 1500; tick += 1) {
      const f = Math.exp(-2.2 / 60);
      const mx = view.cx + ((sx / w) * 2 - 1) * (w / h) * view.radius;
      const my = view.cy + (1 - (sy / h) * 2) * view.radius;
      view.cx = mx + (view.cx - mx) * f;
      view.cy = my + (view.cy - my) * f;
      view.radius *= f;
      const anchor = anchorPoint(info, view.cx, view.cy);
      if (anchor) {
        const pull = Math.min(1, (1 - f) * 2.5);
        view.cx += (anchor[0] - view.cx) * pull;
        view.cy += (anchor[1] - view.cy) * pull;
      }
      const depth = view.digits.length;
      settle("tri", view);
      if (view.digits.length !== depth) info = frameInfo("tri", view.digits);
      assert.ok(Math.abs(view.cx) < 4 && Math.abs(view.cy) < 4, `center stays local (${view.cx}, ${view.cy})`);
    }
    const buf = createBuffer(192, 120);
    fillAll(buf, localState(12, "tri", { ...view, w: 192, h: 120 }, 0));
    const s = structure(buf);
    t.diagnostic(`mouse (${sx}, ${sy}): depth ${view.digits.length}, ${s.tones} hole colors, ${(s.lace * 100).toFixed(1)}% lace`);
    assert.ok(view.digits.length > 70);
    assert.ok(s.tones >= 6 && s.lace > 0.003);
  }
});

test("row bands fill the same pixels as a full frame", () => {
  const view = settle("tri", { digits: [], cx: 0.5 + 1e-6, cy: 1e-6, radius: 1e-5, w: W, h: HT });
  const state = localState(12, "tri", view, 0.2);
  const full = createBuffer(W, HT);
  fillAll(full, state);
  const band = createBuffer(W, 40);
  band.y0 = 100;
  fillRows(band, state, 100, 140);
  for (let i = 0; i < W * 40; i += 1) {
    assert.equal(band.iter[i], full.iter[100 * W + i]);
    assert.equal(band.alpha[i], full.alpha[100 * W + i]);
  }
});
