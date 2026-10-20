/**
 * Deep zoom for z -> z^2 + c (Mandelbrot and Julia) by perturbation.
 *
 * One reference orbit Z_n is iterated in BigInt fixed point and rounded to
 * doubles. Each pixel only iterates its offset d from that orbit,
 * d -> (2 Z + d) d + dc, so doubles are enough down to about 1e-290.
 * When |Z + d| < |d| the pixel is rebased onto the start of the orbit
 * (Zhuoran's method), which makes a single reference glitch-free.
 * Bilinear approximation (BLA) tables let a pixel jump 2^k iterations at a
 * time, d -> A d + B dc, while |d| stays inside each step's validity radius.
 *
 * Fixed-point numbers are BigInt X meaning X / 2^bits.
 */

const VIEW = new DataView(new ArrayBuffer(8));

export function bitsFor(radius) {
  return Math.max(64, Math.ceil(-Math.log2(radius)) + 64);
}

export function bigFromDouble(d, bits) {
  if (!d || !Number.isFinite(d)) return 0n;
  VIEW.setFloat64(0, d);
  const hi = VIEW.getUint32(0);
  const lo = VIEW.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = exp - 1075;
  }
  const shift = e + bits;
  const mag = shift >= 0 ? m << BigInt(shift) : m >> BigInt(-shift);
  return d < 0 ? -mag : mag;
}

function ldexp(x, e) {
  while (e > 1000) {
    x *= 2 ** 1000;
    e -= 1000;
  }
  while (e < -1000) {
    x *= 2 ** -1000;
    e += 1000;
  }
  return x * 2 ** e;
}

function bitLength(X) {
  return X === 0n ? 0 : X.toString(16).length * 4;
}

export function bigToDouble(X, bits) {
  if (X === 0n) return 0;
  const neg = X < 0n;
  const mag = neg ? -X : X;
  const shift = Math.max(0, bitLength(mag) - 64);
  const v = ldexp(Number(mag >> BigInt(shift)), shift - bits);
  return neg ? -v : v;
}

export function rebits(X, from, to) {
  if (to === from) return X;
  return to > from ? X << BigInt(to - from) : X >> BigInt(from - to);
}

/** (a - b) as a double, for fixed-point values at possibly different precisions. */
export function bigDiff(a, aBits, b, bBits) {
  const bits = Math.max(aBits, bBits);
  return bigToDouble(rebits(a, aBits, bits) - rebits(b, bBits, bits), bits);
}

export function bigFromDecimal(text, bits) {
  const s = String(text).trim().replace(/^\+/, "").replace("−", "-");
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) return bigFromDouble(Number(s) || 0, bits);
  const [, sign, whole = "", frac = "", ex = "0"] = m;
  let digits = BigInt((whole + frac) || "0");
  let scale = frac.length - Number(ex);
  let X;
  if (scale <= 0) X = (digits * 10n ** BigInt(-scale)) << BigInt(bits);
  else X = (digits << BigInt(bits)) / 10n ** BigInt(scale);
  return sign ? -X : X;
}

export function bigToDecimal(X, bits, digits) {
  const neg = X < 0n;
  const mag = neg ? -X : X;
  const whole = mag >> BigInt(bits);
  const frac = ((mag - (whole << BigInt(bits))) * 10n ** BigInt(digits)) >> BigInt(bits);
  const fracText = digits > 0 ? `.${frac.toString().padStart(digits, "0")}` : "";
  return `${neg ? "-" : ""}${whole}${fracText}`;
}

/**
 * Z_0 .. Z_{N-1} for z -> z^2 + c from z0, stopping after the first point
 * past the bailout or after maxIter steps. Returns interleaved re/im doubles.
 */
export function referenceOrbit({ zx: z0x, zy: z0y, cx, cy, bits, maxIter, bail = 1e6 }) {
  const B = BigInt(bits);
  const B1 = BigInt(bits - 1);
  const top = bits - 60;
  const TB = BigInt(Math.max(0, top));
  const unit = 2 ** -60;
  const out = new Float64Array(2 * (maxIter + 1));
  let zx = z0x;
  let zy = z0y;
  let n = 0;
  const toD = (v) => {
    if (top > 0) {
      const h = Number(v >> TB);
      if (h >= 2 ** 53 || h <= -(2 ** 53)) return h * unit;
    }
    return bigToDouble(v, bits);
  };
  for (;;) {
    const x = toD(zx);
    const y = toD(zy);
    out[2 * n] = x;
    out[2 * n + 1] = y;
    n += 1;
    if (x * x + y * y > bail || n > maxIter) break;
    const nx = ((zx * zx - zy * zy) >> B) + cx;
    zy = ((zx * zy) >> B1) + cy;
    zx = nx;
  }
  return { Z: out.subarray(0, 2 * n), N: n, escaped: n <= maxIter };
}

const EPS = 2 ** -40;
const STRIDE = 5;

/**
 * Level k entry i advances from m = 1 + i 2^k by 2^k steps:
 * d -> A d + B dc, valid while |d| < R. R is stored divided by sqrt 2 so a
 * max-norm test on d is enough and nothing underflows at extreme depth.
 */
export function buildBla(Z, N, dcMax, julia) {
  const count0 = N - 2;
  if (count0 < 1) return null;
  const levels = [];
  let cur = new Float64Array(count0 * STRIDE);
  for (let i = 0; i < count0; i += 1) {
    const m = i + 1;
    const x = Z[2 * m];
    const y = Z[2 * m + 1];
    const e = i * STRIDE;
    cur[e] = 2 * x;
    cur[e + 1] = 2 * y;
    cur[e + 2] = julia ? 0 : 1;
    cur[e + 3] = 0;
    cur[e + 4] = EPS * Math.hypot(x, y);
  }
  let count = count0;
  levels.push({ data: cur, count });
  const dc = julia ? 0 : dcMax;
  while (count >= 2) {
    const nextCount = count >> 1;
    const next = new Float64Array(nextCount * STRIDE);
    for (let j = 0; j < nextCount; j += 1) {
      const a = 2 * j * STRIDE;
      const b = a + STRIDE;
      const axr = cur[a];
      const axi = cur[a + 1];
      const bxr = cur[a + 2];
      const bxi = cur[a + 3];
      const ayr = cur[b];
      const ayi = cur[b + 1];
      const byr = cur[b + 2];
      const byi = cur[b + 3];
      const e = j * STRIDE;
      next[e] = ayr * axr - ayi * axi;
      next[e + 1] = ayr * axi + ayi * axr;
      next[e + 2] = ayr * bxr - ayi * bxi + byr;
      next[e + 3] = ayr * bxi + ayi * bxr + byi;
      const ax = Math.hypot(axr, axi);
      const ry = ax > 0 ? Math.max(0, (cur[b + 4] - Math.hypot(bxr, bxi) * dc) / ax) : 0;
      next[e + 4] = Math.min(cur[a + 4], ry);
    }
    levels.push({ data: next, count: nextCount });
    cur = next;
    count = nextCount;
  }
  for (const level of levels) {
    const d = level.data;
    for (let e = 4; e < d.length; e += STRIDE) d[e] *= Math.SQRT1_2;
  }
  return levels;
}

const orbits = new Map();

export function putOrbit(id, Z, N) {
  orbits.set(id, { Z, N, bla: new Map() });
  while (orbits.size > 6) orbits.delete(orbits.keys().next().value);
}

export function hasOrbit(id) {
  return orbits.has(id);
}

function blaFor(orbit, dcMax, julia) {
  const key = julia ? 0 : 2 ** Math.ceil(Math.log2(Math.max(dcMax, 1e-300)));
  let levels = orbit.bla.get(key);
  if (levels === undefined) {
    levels = buildBla(orbit.Z, orbit.N, key, julia);
    if (orbit.bla.size > 3) orbit.bla.delete(orbit.bla.keys().next().value);
    orbit.bla.set(key, levels);
  }
  return levels;
}

/**
 * Per-frame constants for deepPixel. state.cx/cy are relative to the
 * high-precision anchor and deep.ox/oy is anchor minus reference point, so a
 * pixel's offset from the reference is its anchor-relative position plus ox/oy.
 */
export function deepContext(state) {
  const deep = state.deep;
  const main = orbits.get(deep.id);
  if (!main) throw new Error("Reference orbit missing");
  const julia = (state.formula | 0) === 1;
  const crit = julia ? orbits.get(deep.critId) : main;
  if (!crit) throw new Error("Critical orbit missing");
  const aspect = state.w / state.h;
  const rx = aspect * state.radius;
  const ry = state.radius;
  const c = Math.cos(state.rotation || 0);
  const s = Math.sin(state.rotation || 0);
  let dcMax = 0;
  for (const [ux, uy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = state.cx + deep.ox + ux * rx * c - uy * ry * s;
    const y = state.cy + deep.oy + ux * rx * s + uy * ry * c;
    dcMax = Math.max(dcMax, Math.hypot(x, y));
  }
  const useBla = deep.bla !== false;
  const px = (2 * state.radius) / Math.max(1, state.h || 1);
  return {
    julia,
    ox: deep.ox,
    oy: deep.oy,
    main,
    crit,
    mainBla: useBla ? blaFor(main, dcMax, julia) : null,
    critBla: useBla ? (crit === main ? null : blaFor(crit, dcMax, julia)) : null,
    n: Math.max(1, state.iters | 0),
    bail: Math.max(state.bailout || 4, 4),
    periodic: !!state.skipInterior,
    tol: px * 0.05,
    stats: deep.stats || null,
  };
}

/**
 * Same output contract as the direct escape kernel: smooth count in iter,
 * alpha 0 inside. Inside pixels that ran out of iterations instead of
 * settling into a cycle get extra = 1, so the caller can raise the limit.
 */
export function deepPixel(buf, idx, wx, wy, k) {
  const julia = k.julia;
  let dcx = wx + k.ox;
  let dcy = wy + k.oy;
  let dx = 0;
  let dy = 0;
  if (julia) {
    dx = dcx;
    dy = dcy;
    dcx = 0;
    dcy = 0;
  }
  let orbit = k.main;
  let levels = k.mainBla;
  let Z = orbit.Z;
  let last = orbit.N - 1;
  const { n: maxIter, bail, periodic, tol } = k;
  let m = 0;
  let n = 0;
  let rebases = 0;
  let checkpoint = 1;
  let sx = 0;
  let sy = 0;
  let steps = 0;
  let blaSteps = 0;
  let zx = Z[0] + dx;
  let zy = Z[1] + dy;
  let z2 = zx * zx + zy * zy;
  let escaped = z2 > bail;
  let cycled = false;
  while (!escaped && n < maxIter) {
    let stepped = false;
    const j = m - 1;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    let r0 = 0;
    if (levels && m > 0 && j < levels[0].count) r0 = levels[0].data[j * STRIDE + 4];
    if (ax < r0 && ay < r0) {
      let top = levels.length - 1;
      if (j > 0) top = Math.min(top, 31 - Math.clz32(j & -j));
      for (let lv = top; lv >= 0; lv -= 1) {
        const level = levels[lv];
        const i = j >> lv;
        if (i >= level.count) continue;
        const D = level.data;
        const e = i * STRIDE;
        const r = D[e + 4];
        const len = 1 << lv;
        if (ax < r && ay < r && n + len <= maxIter) {
          const Ar = D[e];
          const Ai = D[e + 1];
          const Br = D[e + 2];
          const Bi = D[e + 3];
          const nx = Ar * dx - Ai * dy + Br * dcx - Bi * dcy;
          dy = Ar * dy + Ai * dx + Br * dcy + Bi * dcx;
          dx = nx;
          m += len;
          n += len;
          blaSteps += 1;
          stepped = true;
          break;
        }
      }
    }
    if (!stepped) {
      const tx = 2 * Z[2 * m] + dx;
      const ty = 2 * Z[2 * m + 1] + dy;
      const nx = tx * dx - ty * dy + dcx;
      dy = tx * dy + ty * dx + dcy;
      dx = nx;
      m += 1;
      n += 1;
      steps += 1;
    }
    zx = Z[2 * m] + dx;
    zy = Z[2 * m + 1] + dy;
    z2 = zx * zx + zy * zy;
    if (z2 > bail) {
      escaped = true;
      break;
    }
    const d2 = dx * dx + dy * dy;
    if (z2 < d2 || m >= last || (z2 < 1e-280 && Math.max(Math.abs(zx), Math.abs(zy)) < Math.max(Math.abs(dx), Math.abs(dy)))) {
      dx = zx;
      dy = zy;
      m = 0;
      if (julia) {
        orbit = k.crit;
        levels = k.critBla || k.mainBla;
        if (orbit === k.main) levels = k.mainBla;
        Z = orbit.Z;
        last = orbit.N - 1;
        dx = zx - Z[0];
        dy = zy - Z[1];
      }
      rebases += 1;
      if (periodic) {
        if (rebases > 1 && Math.abs(zx - sx) + Math.abs(zy - sy) < tol) {
          cycled = true;
          break;
        }
        if (rebases === checkpoint) {
          sx = zx;
          sy = zy;
          checkpoint *= 2;
        }
      }
    }
  }
  if (k.stats) {
    k.stats.steps += steps;
    k.stats.blaSteps += blaSteps;
    k.stats.rebases += rebases;
  }
  if (!escaped) {
    buf.iter[idx] = 0;
    buf.extra[idx] = cycled ? 0 : 1;
    buf.alpha[idx] = 0;
    return;
  }
  const logBail = Math.log(Math.sqrt(bail));
  const logMag = 0.5 * Math.log(z2);
  let nu = logMag > logBail ? Math.log(logMag / logBail) / Math.LN2 : 0;
  if (!Number.isFinite(nu)) nu = 0;
  buf.iter[idx] = n - nu;
  buf.extra[idx] = 0.5 + 0.5 * Math.sin(Math.atan2(zy, zx) * 2);
  buf.alpha[idx] = 1;
}
