// Node checks for the perturbation kernel: node scripts/deep-test.mjs
import { createBuffer, fillAll } from "../src/engine/kernel.js";
import { bigFromDecimal, bigFromDouble, bigToDecimal, bitsFor, putOrbit, referenceOrbit } from "../src/engine/deep.js";

const W = Number(process.env.W || 320);
const H = Number(process.env.H || 200);
let nextId = 1;

function orbitAt(X, Y, bits, iters) {
  const t0 = performance.now();
  const o = referenceOrbit({ zx: 0n, zy: 0n, cx: X, cy: Y, bits, maxIter: iters });
  const id = nextId++;
  putOrbit(id, o.Z, o.N);
  return { id, ms: performance.now() - t0, N: o.N };
}

function deepState(radius, iters, id, extra = {}) {
  return { family: "escape", formula: 0, cx: 0, cy: 0, radius, rotation: 0, power: 2, bailout: 64, iters, skipInterior: true, w: W, h: H, guess: "off", deep: { id, ox: 0, oy: 0, ...extra } };
}

function render(state) {
  const buf = createBuffer(state.w, state.h);
  const t0 = performance.now();
  fillAll(buf, state);
  return { buf, ms: performance.now() - t0 };
}

function compare(a, b, tol = 0.02) {
  let same = 0;
  for (let i = 0; i < a.iter.length; i += 1) {
    if (a.alpha[i] === 0 && b.alpha[i] === 0) same += 1;
    else if (a.alpha[i] && b.alpha[i] && Math.abs(a.iter[i] - b.iter[i]) < tol) same += 1;
  }
  return same / a.iter.length;
}

function describe(buf) {
  const set = new Set();
  let inside = 0;
  let max = 0;
  for (let i = 0; i < buf.iter.length; i += 1) {
    if (!buf.alpha[i]) inside += 1;
    else {
      set.add(Math.floor(buf.iter[i]));
      max = Math.max(max, buf.iter[i]);
    }
  }
  return { distinct: set.size, inside: +(inside / buf.iter.length).toFixed(3), maxIter: Math.round(max) };
}

/** Escape count of one pixel with every iteration in BigInt: the ground truth. */
function bigEscape(X, Y, bits, iters) {
  const B = BigInt(bits);
  const four = 64n << B;
  let zx = 0n;
  let zy = 0n;
  for (let n = 1; n <= iters; n += 1) {
    const xx = (zx * zx) >> B;
    const yy = (zy * zy) >> B;
    zy = ((zx * zy) >> (B - 1n)) + Y;
    zx = xx - yy + X;
    if (((zx * zx + zy * zy) >> B) > four) return n;
  }
  return 0;
}

function sampleTruth(X, Y, bits, radius, iters, buf, count = 60) {
  let agree = 0;
  let tried = 0;
  for (let k = 0; k < count; k += 1) {
    const px = (k * 7919) % W;
    const py = (k * 104729) % H;
    const ox = ((2 * (px + 0.5)) / W - 1) * (W / H) * radius;
    const oy = (1 - (2 * (py + 0.5)) / H) * radius;
    const truth = bigEscape(X + bigFromDouble(ox, bits), Y + bigFromDouble(oy, bits), bits, iters);
    const i = py * W + px;
    const got = buf.alpha[i] ? Math.floor(buf.iter[i] + 1e-9) : 0;
    const gotCeil = buf.alpha[i] ? Math.ceil(buf.iter[i]) : 0;
    tried += 1;
    if (truth === got || truth === gotCeil || (truth === 0 && !buf.alpha[i])) agree += 1;
  }
  return `${agree}/${tried}`;
}

/** Walk toward the boundary: recenter on the slowest escaping pixel and shrink. */
function dive(startX, startY, depths) {
  let bitsNow = 400 * 4;
  let X = bigFromDecimal(startX, bitsNow);
  let Y = bigFromDecimal(startY, bitsNow);
  let r = 1e-3;
  const out = [];
  const wanted = [...depths];
  while (wanted.length) {
    const iters = Math.min(60000, Math.round(400 + -Math.log2(r) * 40));
    const o = orbitAt(X, Y, bitsNow, iters);
    const s = { ...deepState(r, iters, o.id), w: 48, h: 30 };
    const { buf } = render(s);
    let best = -1;
    let bestI = 0;
    for (let i = 0; i < buf.iter.length; i += 1) if (buf.alpha[i] && buf.iter[i] > best) {
      best = buf.iter[i];
      bestI = i;
    }
    const px = bestI % s.w;
    const py = (bestI / s.w) | 0;
    const ox = ((2 * (px + 0.5)) / s.w - 1) * (s.w / s.h) * r;
    const oy = (1 - (2 * (py + 0.5)) / s.h) * r;
    X += bigFromDouble(ox, bitsNow);
    Y += bigFromDouble(oy, bitsNow);
    r /= 8;
    if (r < wanted[0]) {
      out.push({ r: wanted.shift(), x: bigToDecimal(X, bitsNow, Math.ceil(-Math.log10(r)) + 6), y: bigToDecimal(Y, bitsNow, Math.ceil(-Math.log10(r)) + 6) });
    }
  }
  return out;
}

const results = [];

/** Of the pixels where a and b disagree, how many each gets right according to BigInt. */
function arbitrate(a, b, x, y, r, iters, limit = 40) {
  const bits = 220;
  const B = BigInt(bits);
  const lim = 64n << B;
  const truth = (cx, cy) => {
    let zx = 0n;
    let zy = 0n;
    for (let n = 1; n <= iters; n += 1) {
      const xx = (zx * zx) >> B;
      const yy = (zy * zy) >> B;
      zy = ((zx * zy) >> (B - 1n)) + cy;
      zx = xx - yy + cx;
      if (((zx * zx + zy * zy) >> B) > lim) {
        const fx = Number(zx >> (B - 40n)) / 2 ** 40;
        const fy = Number(zy >> (B - 40n)) / 2 ** 40;
        return n - Math.log(0.5 * Math.log(fx * fx + fy * fy) / Math.log(8)) / Math.LN2;
      }
    }
    return 0;
  };
  let ra = 0;
  let rb = 0;
  let n = 0;
  for (let i = 0; i < a.iter.length && n < limit; i += 1) {
    if (!a.alpha[i] || !b.alpha[i] || Math.abs(a.iter[i] - b.iter[i]) < 0.02) continue;
    n += 1;
    const px = i % W;
    const py = (i / W) | 0;
    const ox = ((2 * (px + 0.5)) / W - 1) * (W / H) * r;
    const oy = (1 - (2 * (py + 0.5)) / H) * r;
    const t = truth(bigFromDouble(x, bits) + bigFromDouble(ox, bits), bigFromDouble(y, bits) + bigFromDouble(oy, bits));
    if (Math.abs(a.iter[i] - t) < 0.02) ra += 1;
    if (Math.abs(b.iter[i] - t) < 0.02) rb += 1;
  }
  return `direct ${ra}/${n}, perturbation ${rb}/${n}`;
}

for (const [x, y] of [[-0.7746806106269039, -0.1374168856037867], [0.2549870375144766, 0.0005679790528465]]) {
  for (const r of [1e-6, 1e-8, 1e-10]) {
    // Perturbation against the direct double kernel.
    const iters = 1200;
    const direct = render({ family: "escape", formula: 0, cx: x, cy: y, radius: r, rotation: 0, power: 2, bailout: 64, iters, skipInterior: true, w: W, h: H, guess: "off" });
    const bits = bitsFor(r);
    const o = orbitAt(bigFromDouble(x, bits), bigFromDouble(y, bits), bits, iters);
    const pert = render(deepState(r, iters, o.id, { bla: false }));
    const bla = render(deepState(r, iters, o.id));
    results.push({
      test: `direct r=${r} @${x.toFixed(3)}`,
      directMs: Math.round(direct.ms),
      perturbMs: Math.round(pert.ms),
      blaMs: Math.round(bla.ms),
      perturbMatch: compare(direct.buf, pert.buf).toFixed(4),
      blaMatch: compare(direct.buf, bla.buf).toFixed(4),
      truth: arbitrate(direct.buf, bla.buf, x, y, r, iters),
      image: describe(direct.buf),
    });
  }
}

const spots = process.env.SPOTS ? JSON.parse(process.env.SPOTS) : dive("-0.743643887037151", "0.13182590420533", [1e-20, 1e-30, 1e-50, 1e-60, 1e-100, 1e-150, 1e-200, 1e-280]);
for (const spot of spots) {
  const r = spot.r;
  const bits = bitsFor(r) + 32;
  const X = bigFromDecimal(spot.x, bits);
  const Y = bigFromDecimal(spot.y, bits);
  const iters = Math.min(100000, Math.round(200 + -Math.log2(r) * 30));
  const o = orbitAt(X, Y, bits, iters);
  const stats = { steps: 0, blaSteps: 0, rebases: 0 };
  const bla = render(deepState(r, iters, o.id, { stats }));
  const plain = r >= 1e-60 ? render(deepState(r, iters, o.id, { bla: false })) : null;
  let offRef = "-";
  if (r >= 1e-60) {
    // Reference off the view center must give the same image.
    const qx = 0.3 * r;
    const qy = -0.2 * r;
    const o2 = orbitAt(X + bigFromDouble(qx, bits), Y + bigFromDouble(qy, bits), bits, iters);
    const moved = render(deepState(r, iters, o2.id, { ox: -qx, oy: -qy }));
    offRef = compare(bla.buf, moved.buf, 0.05).toFixed(4);
  }
  results.push({
    test: `r=${r}`,
    iters,
    refN: o.N,
    orbitMs: Math.round(o.ms),
    blaMs: Math.round(bla.ms),
    plainMs: plain ? Math.round(plain.ms) : "-",
    blaVsPlain: plain ? compare(plain.buf, bla.buf, 0.05).toFixed(4) : "-",
    offRef,
    truth: r >= 1e-60 ? sampleTruth(X, Y, bits, r, iters, bla.buf, 40) : "-",
    image: describe(bla.buf),
    perPixel: `${((stats.steps + stats.blaSteps) / (W * H)).toFixed(0)} (bla ${(stats.blaSteps / (W * H)).toFixed(1)})`,
    perPixel: `${((stats.steps + stats.blaSteps) / (W * H)).toFixed(0)} (bla ${(stats.blaSteps / (W * H)).toFixed(0)})`,
  });
  if (process.env.SHOW) console.log(spot);
}
console.table(results.map(({ image, ...rest }) => ({ ...rest, distinct: image.distinct, inside: image.inside, maxEsc: image.maxIter })));
if (process.env.SPOTS_OUT) console.log(JSON.stringify(spots));
