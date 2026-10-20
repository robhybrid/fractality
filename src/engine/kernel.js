import { frameInfo, GASKET, REACH, SPAN } from "./frames.js";

const C1 = [0, 0, 0];
const C2 = [0, 0, 0];
const C3 = [0, 0, 0];

export function createBuffer(w, h) {
  return {
    w,
    h,
    iter: new Float32Array(w * h),
    extra: new Float32Array(w * h),
    alpha: new Uint8Array(w * h),
    source: 0,
    y0: 0,
    level: null,
  };
}

export function fillAll(buf, state) {
  fillRows(buf, state, 0, buf.h);
}

export function fillRows(buf, state, y0, y1) {
  if (state.family === "ifs") {
    if (y0 === 0) fillIfs(buf, state);
    return;
  }
  if (state.family === "ray") {
    fillRay(buf, state, y0, y1);
    return;
  }
  if (state.formula >= 12) fillShape(buf, state, y0, y1);
  else if (state.formula >= 8) fillSpecial(buf, state, y0, y1);
  else fillEscape(buf, state, y0, y1);
}

function clampIter(n, cap) {
  return Math.max(1, Math.min(cap, n | 0));
}

function planeOf(state) {
  const rotation = state.rotation || 0;
  return {
    c: Math.cos(rotation),
    s: Math.sin(rotation),
    aspect: state.w / state.h,
    radius: state.radius,
    cx: state.cx,
    cy: state.cy,
    w: state.w,
    h: state.h,
  };
}

function rowStart(p, y) {
  const ny = 1 - ((y + 0.5) / p.h) * 2;
  const py = ny * p.radius;
  const px0 = ((0.5 / p.w) * 2 - 1) * p.aspect * p.radius;
  const dpx = (2 / p.w) * p.aspect * p.radius;
  return {
    wx: p.cx + px0 * p.c - py * p.s,
    wy: p.cy + px0 * p.s + py * p.c,
    dwx: dpx * p.c,
    dwy: dpx * p.s,
  };
}

function insideSet(x, y) {
  const q = (x - 0.25) * (x - 0.25) + y * y;
  if (q * (q + (x - 0.25)) <= 0.25 * y * y) return true;
  const dx = x + 1;
  return dx * dx + y * y <= 0.0625;
}

function cpow(zx, zy, p) {
  if (Math.abs(p - 2) < 0.0008) return [zx * zx - zy * zy, 2 * zx * zy];
  if (Math.abs(p - 3) < 0.0008) {
    const sx = zx * zx - zy * zy;
    const sy = 2 * zx * zy;
    return [sx * zx - sy * zy, sx * zy + sy * zx];
  }
  const r2 = zx * zx + zy * zy;
  if (r2 < 1e-16) return [0, 0];
  const r = r2 ** (0.5 * p);
  const a = Math.atan2(zy, zx) * p;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function smoothIter(i, zx, zy, bail, power) {
  const mag = Math.hypot(zx, zy);
  const logBail = Math.log(Math.sqrt(bail));
  const logMag = Math.log(mag);
  let nu = 0;
  if (logMag > logBail) nu = Math.log(logMag / logBail) / Math.log(Math.max(power, 1.05));
  if (!Number.isFinite(nu)) nu = 0;
  return i + 1 - nu;
}

function paintEscape(buf, idx, escaped, smooth, stripe) {
  if (!escaped) {
    buf.iter[idx] = 0;
    buf.extra[idx] = 0;
    buf.alpha[idx] = 0;
    return;
  }
  buf.iter[idx] = smooth;
  buf.extra[idx] = stripe;
  buf.alpha[idx] = 1;
}

export function escapeContext(state) {
  const power = Math.max(state.power || 2, 0.35);
  const formula = state.formula | 0;
  const square = Math.abs(power - 2) < 0.0008;
  const px = (2 * state.radius) / Math.max(1, state.h || 1);
  return {
    n: clampIter(state.iters, 1200),
    bail: Math.max(state.bailout || 4, 4),
    power,
    formula,
    square,
    skip: !!(state.skipInterior && formula === 0 && Math.abs(power - 2) < 0.02),
    periodic: !!state.skipInterior && formula !== 7,
    tol2: (px * 0.05) ** 2,
    julia: formula === 1 || formula === 7,
    jx: state.juliaRe || 0,
    jy: state.juliaIm || 0,
    extraK: state.extra || 0,
  };
}

/**
 * One escape-time pixel. Points inside the main cardioid or period-2 bulb are
 * skipped outright; other interior points stop as soon as the orbit repeats
 * (Brent's cycle check: compare against a point saved at powers of two).
 */
export function escapePixel(buf, idx, wx, wy, c) {
  let cx;
  let cy;
  let zx;
  let zy;
  if (c.julia) {
    cx = c.jx;
    cy = c.jy;
    zx = wx;
    zy = wy;
  } else {
    cx = wx;
    cy = wy;
    zx = 0;
    zy = 0;
  }
  if (c.skip && insideSet(cx, cy)) {
    paintEscape(buf, idx, false, 0, 0);
    return;
  }
  const { n, bail, formula, square, periodic, tol2, extraK } = c;
  let prevX = 0;
  let prevY = 0;
  let saveX = zx;
  let saveY = zy;
  let checkpoint = 16;
  for (let i = 0; i < n; i += 1) {
    if (formula === 0 && square) {
      const xx = zx * zx - zy * zy + cx;
      zy = 2 * zx * zy + cy;
      zx = xx;
    } else {
      let bx = zx;
      let by = zy;
      if (formula === 2) {
        bx = Math.abs(zx);
        by = Math.abs(zy);
      } else if (formula === 3) by = -zy;
      else if (formula === 6) by = Math.abs(zy);
      let nx;
      let ny;
      if (square) {
        nx = bx * bx - by * by;
        ny = 2 * bx * by;
      } else {
        const r = cpow(bx, by, c.power);
        nx = r[0];
        ny = r[1];
      }
      if (formula === 4) nx = Math.abs(nx);
      else if (formula === 5) {
        nx = Math.abs(nx);
        ny = Math.abs(ny);
      } else if (formula === 7) {
        nx += extraK * prevX;
        ny += extraK * prevY;
      }
      prevX = zx;
      prevY = zy;
      zx = nx + cx;
      zy = ny + cy;
    }
    const z2 = zx * zx + zy * zy;
    if (z2 > bail) {
      paintEscape(buf, idx, true, smoothIter(i, zx, zy, bail, c.power), 0.5 + 0.5 * Math.sin(Math.atan2(zy, zx) * 2));
      return;
    }
    if (periodic && (i & 3) === 0) {
      const dx = zx - saveX;
      const dy = zy - saveY;
      if (dx * dx + dy * dy < tol2) break;
      if (i === checkpoint) {
        saveX = zx;
        saveY = zy;
        checkpoint *= 2;
      }
    }
  }
  paintEscape(buf, idx, false, 0, 0);
}

/**
 * Solid guessing: compute every other pixel on every other row, then fill a
 * gap pixel from its computed neighbors when they agree. "interior" only
 * fills when all neighbors are inside the set (always safe in practice);
 * "full" also fills matching escape bands, used while the view is moving.
 */
function fillEscape(buf, state, y0, y1) {
  const p = planeOf(state);
  const c = escapeContext(state);
  const w = buf.w;
  buf.source = 0;
  const guess = state.guess || (state.soft ? "full" : "off");
  const rows = y1 - y0;
  if (guess === "off" || rows < 3 || w < 3) {
    for (let y = y0; y < y1; y += 1) {
      const row = rowStart(p, y);
      const o = (y - buf.y0) * w;
      for (let x = 0; x < w; x += 1) escapePixel(buf, o + x, row.wx + x * row.dwx, row.wy + x * row.dwy, c);
    }
    return;
  }
  const full = guess === "full";
  const { iter, extra, alpha } = buf;
  const coarseRow = (ly) => (ly & 1) === 0 || ly === rows - 1;
  const coarseCol = (x) => (x & 1) === 0 || x === w - 1;
  const starts = new Array(rows);
  for (let ly = 0; ly < rows; ly += 1) starts[ly] = rowStart(p, y0 + ly);
  for (let ly = 0; ly < rows; ly += 1) {
    if (!coarseRow(ly)) continue;
    const row = starts[ly];
    const o = (y0 + ly - buf.y0) * w;
    for (let x = 0; x < w; x += 1) {
      if (coarseCol(x)) escapePixel(buf, o + x, row.wx + x * row.dwx, row.wy + x * row.dwy, c);
    }
  }
  for (let ly = 0; ly < rows; ly += 1) {
    const rowCoarse = coarseRow(ly);
    const row = starts[ly];
    const o = (y0 + ly - buf.y0) * w;
    for (let x = 0; x < w; x += 1) {
      const colCoarse = coarseCol(x);
      if (rowCoarse && colCoarse) continue;
      const idx = o + x;
      let a;
      let b;
      let cc = -1;
      let d = -1;
      if (rowCoarse) {
        a = idx - 1;
        b = idx + 1;
      } else if (colCoarse) {
        a = idx - w;
        b = idx + w;
      } else {
        a = idx - w - 1;
        b = idx - w + 1;
        cc = idx + w - 1;
        d = idx + w + 1;
      }
      const four = cc >= 0;
      const sumA = alpha[a] + alpha[b] + (four ? alpha[cc] + alpha[d] : 0);
      if (sumA === 0) {
        paintEscape(buf, idx, false, 0, 0);
        continue;
      }
      if (full && sumA === (four ? 4 : 2)) {
        const fa = Math.floor(iter[a]);
        if (Math.floor(iter[b]) === fa && (!four || (Math.floor(iter[cc]) === fa && Math.floor(iter[d]) === fa))) {
          const k = four ? 0.25 : 0.5;
          iter[idx] = (iter[a] + iter[b] + (four ? iter[cc] + iter[d] : 0)) * k;
          extra[idx] = (extra[a] + extra[b] + (four ? extra[cc] + extra[d] : 0)) * k;
          alpha[idx] = 1;
          continue;
        }
      }
      escapePixel(buf, idx, row.wx + x * row.dwx, row.wy + x * row.dwy, c);
    }
  }
}

function cdiv(ax, ay, bx, by) {
  const d = bx * bx + by * by;
  if (d < 1e-12) return [0, 0];
  return [(ax * bx + ay * by) / d, (ay * bx - ax * by) / d];
}

function fillSpecial(buf, state, y0, y1) {
  const p = planeOf(state);
  const formula = state.formula | 0;
  const power = Math.max(state.power || 2, 0.35);
  const bail = Math.max(state.bailout || 4, 4);
  const extraK = state.extra || 0;
  const n = clampIter(state.iters, formula === 8 ? 40 : formula === 11 ? 96 : 400);
  const w = buf.w;
  buf.source = 0;
  for (let y = y0; y < y1; y += 1) {
    const row = rowStart(p, y);
    let wx = row.wx;
    let wy = row.wy;
    const o = (y - buf.y0) * w;
    for (let x = 0; x < w; x += 1) {
      const idx = o + x;
      if (formula === 11) lyapunov(buf, idx, wx, wy, n);
      else if (formula === 8) newton(buf, idx, wx, wy, power, n);
      else if (formula === 9) nova(buf, idx, wx, wy, power, extraK, bail, n);
      else magnet(buf, idx, wx, wy, bail, n);
      wx += row.dwx;
      wy += row.dwy;
    }
  }
}

function lyapunov(buf, idx, px, py, n) {
  let x = 0.5;
  let sum = 0;
  let bad = false;
  for (let i = 0; i < n; i += 1) {
    const r = (i & 1) === 0 ? px : py;
    x = r * x * (1 - x);
    const deriv = Math.abs(r * (1 - 2 * x));
    if (!(deriv > 1e-8) || x < -1 || x > 2) {
      bad = true;
      break;
    }
    sum += Math.log(deriv);
  }
  const lam = sum / n;
  if (bad || lam >= 0) paintEscape(buf, idx, false, 0, 0);
  else paintEscape(buf, idx, true, Math.max(0, Math.min(80, -lam * 12)), 0.35);
}

function newton(buf, idx, zx, zy, power, n) {
  for (let i = 0; i < n; i += 1) {
    const zp = cpow(zx, zy, power);
    const dz = cpow(zx, zy, Math.max(power - 1, 0.2));
    dz[0] *= power;
    dz[1] *= power;
    const q = cdiv(zp[0] - 1, zp[1], dz[0], dz[1]);
    zx -= q[0];
    zy -= q[1];
    const ang = Math.atan2(zy, zx);
    const sector = 6.28318530718 / power;
    const k = Math.floor(ang / sector + 0.5);
    const target = k * sector;
    const dx = zx - Math.cos(target);
    const dy = zy - Math.sin(target);
    if (dx * dx + dy * dy < 0.004 * 0.004 && zx * zx + zy * zy < 1.6 * 1.6) {
      paintEscape(buf, idx, true, Math.abs(k) * 9 + i * 0.7, Math.abs(k * 0.17) % 1);
      return;
    }
  }
  paintEscape(buf, idx, false, 0, 0);
}

function nova(buf, idx, zx, zy, power, extraK, bail, n) {
  const cx = zx;
  const cy = zy;
  for (let i = 0; i < n; i += 1) {
    const zp = cpow(zx, zy, power);
    const dz = cpow(zx, zy, Math.max(power - 1, 0.2));
    dz[0] *= power;
    dz[1] *= power;
    const q = cdiv(zp[0] - 1, zp[1], dz[0], dz[1]);
    zx = zx - extraK * q[0] + cx;
    zy = zy - extraK * q[1] + cy;
    if (zx * zx + zy * zy > bail) {
      paintEscape(buf, idx, true, i, 0.4);
      return;
    }
  }
  paintEscape(buf, idx, false, 0, 0);
}

function magnet(buf, idx, cx, cy, bail, n) {
  let zx = cx;
  let zy = cy;
  for (let i = 0; i < n; i += 1) {
    const num = cpow(zx, zy, 2);
    num[0] += cx - 1;
    num[1] += cy;
    const denX = 2 * zx + cx - 2;
    const denY = 2 * zy + cy;
    const q = cdiv(num[0], num[1], denX, denY);
    const sq = cpow(q[0], q[1], 2);
    zx = sq[0];
    zy = sq[1];
    if (zx * zx + zy * zy > bail) {
      paintEscape(buf, idx, true, i, 0.5);
      return;
    }
  }
  paintEscape(buf, idx, false, 0, 0);
}

function levelsFor(state, base) {
  const px = (2 * state.radius) / Math.max(1, state.h);
  return Math.log(1 / Math.max(px, 1e-300)) / Math.log(base);
}

function fillShape(buf, state, y0, y1) {
  const formula = state.formula | 0;
  buf.source = 0;
  if (formula === 12) {
    fillSierpinski(buf, state, y0, y1);
    return;
  }
  if (formula === 13) {
    fillCarpet(buf, state, y0, y1);
    return;
  }
  const p = planeOf(state);
  let n;
  if (formula === 16) n = Math.max(3, Math.min(40, Math.ceil(levelsFor(state, 2)) + 3));
  else n = Math.max(3, Math.min(30, Math.ceil(levelsFor(state, 3) + Math.log(2) / Math.log(3)) + 2));
  const w = buf.w;
  for (let y = y0; y < y1; y += 1) {
    const row = rowStart(p, y);
    let wx = row.wx;
    let wy = row.wy;
    const o = (y - buf.y0) * w;
    for (let x = 0; x < w; x += 1) {
      const idx = o + x;
      if (formula === 14) koch(buf, idx, wx, wy, n, false);
      else if (formula === 15) koch(buf, idx, wx, wy, n, true);
      else kaleido(buf, idx, wx, wy, n, state.extra || 0);
      wx += row.dwx;
      wy += row.dwy;
    }
  }
}

const SH = 0.8660254037844386;
const LEVEL_TONE = 3;
const ROOT_TRI = frameInfo("tri", []);
const ROOT_SQUARE = frameInfo("square", []);

function frameOf(state, kind, root) {
  const f = state.frame;
  return f && f.kind === kind ? f : root;
}

const TRI_BITS = 28;
const TRI_GUARD = 8;

/**
 * The view is local to the frame cell, which is about the size of the screen.
 * Pixels are snapped to a fixed-point lattice `n` levels (plus guard bits)
 * finer than the frame, so each one costs a table lookup for its cell and a
 * carry test inside it: the highest carry of lu + lv names the first hole
 * level, and no carry above the guard bits means the pixel is still on the
 * gasket after n levels, drawn as dark lace. 5 * 2^TRI_BITS must fit in int32.
 */
function fillSierpinski(buf, state, y0, y1) {
  const p = planeOf(state);
  const frame = frameOf(state, "tri", ROOT_TRI);
  const cells = frame.cells;
  const n = Math.max(4, Math.min(TRI_BITS - TRI_GUARD, Math.ceil(levelsFor(state, 2)) + 3));
  const bits = n + TRI_GUARD;
  const M = 2 ** bits;
  const mask = M - 1;
  const lim = SPAN * M;
  const gasketTone = (frame.depth + n - 32) * LEVEL_TONE;
  const [rx, ry, rs] = frame.root;
  const { w, iter, extra, alpha } = buf;
  for (let y = y0; y < y1; y += 1) {
    const row = rowStart(p, y);
    let U = (row.wx - (0.5 / SH) * row.wy + REACH) * M;
    let V = (row.wy / SH + REACH) * M;
    const dU = (row.dwx - (0.5 / SH) * row.dwy) * M;
    const dV = (row.dwy / SH) * M;
    const o = (y - buf.y0) * w;
    for (let x = 0; x < w; x += 1, U += dU, V += dV) {
      const idx = o + x;
      if (U >= 0 && V >= 0 && U < lim && V < lim) {
        const ui = U | 0;
        const vi = V | 0;
        const lu = ui & mask;
        const lv = vi & mask;
        const s = lu + lv;
        const cell = cells[(((ui >> bits) * SPAN + (vi >> bits)) << 1) | (s >> bits)];
        if (cell === GASKET) {
          const carry = (s ^ lu ^ lv) >> TRI_GUARD;
          if (carry === 0) {
            iter[idx] = 0;
            extra[idx] = 0;
            alpha[idx] = 0;
          } else {
            iter[idx] = gasketTone + Math.clz32(carry) * LEVEL_TONE;
            extra[idx] = 0;
            alpha[idx] = 1;
          }
          continue;
        }
        if (cell >= 0) {
          iter[idx] = cell * LEVEL_TONE;
          extra[idx] = 0;
          alpha[idx] = 1;
          continue;
        }
      }
      const lx = (U / M - REACH) + (V / M - REACH) * 0.5;
      const ly = (V / M - REACH) * SH;
      const gz = (ry + ly * rs) / SH;
      const gy = rx + lx * rs - 0.5 * gz;
      const gx = 1 - gy - gz;
      const g = gx < gy ? (gx < gz ? gx : gz) : gy < gz ? gy : gz;
      iter[idx] = g >= 0 ? 0 : g < -40 / 22 ? 40 : -g * 22;
      extra[idx] = 0.15;
      alpha[idx] = 1;
    }
  }
}

const ONES_DIGITS = 11;
const ONES_SPAN = 3 ** ONES_DIGITS;
let ones = null;

/** For every 11-digit base-3 number, a bit mask of the digits that are 1. */
function onesTable() {
  if (ones) return ones;
  ones = new Uint16Array(ONES_SPAN);
  for (let i = 0; i < ONES_SPAN; i += 1) {
    let m = 0;
    for (let j = 0, d = i; j < ONES_DIGITS; j += 1, d = (d / 3) | 0) {
      if (d % 3 === 1) m |= 1 << j;
    }
    ones[i] = m;
  }
  return ones;
}

/**
 * Same as the triangle, in base 3: a pixel sits in a hole where a digit of
 * both coordinates is 1, so the hole level is the highest bit of
 * ones[lu] & ones[lv]. Up to 22 digits split into two table lookups.
 */
function fillCarpet(buf, state, y0, y1) {
  const p = planeOf(state);
  const frame = frameOf(state, "square", ROOT_SQUARE);
  const cells = frame.cells;
  const t = onesTable();
  const n = Math.max(3, Math.min(18, Math.ceil(levelsFor(state, 3)) + 2));
  const split = n > ONES_DIGITS;
  const M = 3 ** n;
  const lim = SPAN * M;
  const tone0 = (frame.depth + n - 32) * LEVEL_TONE;
  const [rx, ry, rs] = frame.root;
  const { w, iter, extra, alpha } = buf;
  for (let y = y0; y < y1; y += 1) {
    const row = rowStart(p, y);
    let U = (row.wx + REACH) * M;
    let V = (row.wy + REACH) * M;
    const dU = row.dwx * M;
    const dV = row.dwy * M;
    const o = (y - buf.y0) * w;
    for (let x = 0; x < w; x += 1, U += dU, V += dV) {
      const idx = o + x;
      if (U >= 0 && V >= 0 && U < lim && V < lim) {
        const ui = U | 0;
        const vi = V | 0;
        const a = (ui / M) | 0;
        const b = (vi / M) | 0;
        const cell = cells[a * SPAN + b];
        if (cell === GASKET) {
          const lu = ui - a * M;
          const lv = vi - b * M;
          let m;
          if (split) {
            const hu = (lu / ONES_SPAN) | 0;
            const hv = (lv / ONES_SPAN) | 0;
            m = ((t[hu] & t[hv]) << ONES_DIGITS) | (t[lu - hu * ONES_SPAN] & t[lv - hv * ONES_SPAN]);
          } else {
            m = t[lu] & t[lv];
          }
          if (m === 0) {
            iter[idx] = 0;
            extra[idx] = 0;
            alpha[idx] = 0;
          } else {
            iter[idx] = tone0 + Math.clz32(m) * LEVEL_TONE;
            extra[idx] = 0;
            alpha[idx] = 1;
          }
          continue;
        }
        if (cell >= 0) {
          iter[idx] = cell * LEVEL_TONE;
          extra[idx] = 0;
          alpha[idx] = 1;
          continue;
        }
      }
      const px = rx + (U / M - REACH) * rs;
      const py = ry + (V / M - REACH) * rs;
      const ex = px < 0 ? -px : px > 1 ? px - 1 : 0;
      const ey = py < 0 ? -py : py > 1 ? py - 1 : 0;
      iter[idx] = Math.sqrt(ex * ex + ey * ey) * 36;
      extra[idx] = 0.1;
      alpha[idx] = 1;
    }
  }
}

function fold(x, y, ang) {
  const nx = Math.cos(-ang);
  const ny = Math.sin(-ang);
  const d = x * nx + y * ny;
  if (d >= 0) return [x, y];
  return [x - 2 * d * nx, y - 2 * d * ny];
}

function kochFold(x, y) {
  x = Math.abs(x) - 0.5;
  return fold(x, y, Math.PI / 6);
}

function koch(buf, idx, px, py, n, snow) {
  const steps = n;
  let x = px;
  let y = py;
  if (snow) {
    x *= 0.7;
    y *= 0.7;
    x -= 0.5;
    y -= 0.3;
    [x, y] = fold(x, y, (-2 * Math.PI) / 3);
    x += 1;
    [x, y] = fold(x, y, -Math.PI / 3);
  } else {
    x = x * 0.5 + 0.5;
    y = y * 0.5 + 0.5;
  }
  for (let i = 0; i < steps; i += 1) {
    x *= 3;
    y *= 3;
    x -= 1.5;
    [x, y] = kochFold(x, y);
  }
  const hx = x - Math.min(1, Math.max(0, x));
  const dist = Math.hypot(hx, y) / 3 ** steps;
  const core = Math.exp(-dist * 700);
  const tone = Math.max(0, Math.min(96, -Math.log2(Math.max(dist, 1e-8)) * 1.35));
  paintEscape(buf, idx, true, tone, core);
}

function kaleido(buf, idx, px, py, n, extra) {
  let x = px * 0.8;
  let y = py * 0.8;
  for (let i = 0; i < n; i += 1) {
    x *= 2;
    y *= 2;
    x -= 1;
    [x, y] = fold(x, y, -2.9);
    [x, y] = fold(x, y, 0.9 + extra);
    y += 1 + extra * 0.35;
    [x, y] = fold(x, y, -1);
  }
  const hx = x - Math.min(1, Math.max(0, x));
  const dist = Math.hypot(hx, y) / 2 ** n;
  const core = Math.exp(-dist * 700);
  const tone = Math.max(0, Math.min(96, -Math.log2(Math.max(dist, 1e-8)) * 1.35));
  paintEscape(buf, idx, true, tone, core);
}

function splat(buf, x, y, shade) {
  const px = x | 0;
  const py = y | 0;
  if (px < 0 || py < 0 || px >= buf.w || py >= buf.h) return;
  const idx = py * buf.w + px;
  buf.iter[idx] = Math.min(1, buf.iter[idx] + 0.2 + shade * 0.05);
  buf.alpha[idx] = 1;
}

function fillIfs(buf, state) {
  buf.source = 1;
  buf.iter.fill(0);
  buf.alpha.fill(0);
  const kind = state.formula | 0;
  const n = Math.max(2000, Math.min(3000000, state.ifsPoints | 0 || 20000));
  const burn = 16;
  let x = 0;
  let y = 0;
  let seed = 17;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed & 2147483647) / 2147483647;
  };
  const p = planeOf(state);
  const aspect = buf.w / buf.h;
  for (let i = 0; i < n + burn; i += 1) {
    const h = rand();
    let shade = 0.5;
    if (kind === 0) {
      if (h < 0.01) {
        x = 0;
        y = 0.16 * y;
        shade = 0.2;
      } else if (h < 0.86) {
        const nx = 0.85 * x + 0.04 * y;
        y = -0.04 * x + 0.85 * y + 1.6;
        x = nx;
        shade = 0.55;
      } else if (h < 0.93) {
        const nx = 0.2 * x - 0.26 * y;
        y = 0.23 * x + 0.22 * y + 1.6;
        x = nx;
        shade = 0.75;
      } else {
        const nx = -0.15 * x + 0.28 * y;
        y = 0.26 * x + 0.24 * y + 0.44;
        x = nx;
        shade = 0.92;
      }
    } else if (kind === 1) {
      if (h < 0.5) {
        const nx = 0.5 * x - 0.5 * y;
        y = 0.5 * x + 0.5 * y;
        x = nx;
      } else {
        const nx = -0.5 * x - 0.5 * y + 1;
        y = 0.5 * x - 0.5 * y;
        x = nx;
      }
      shade = 0.35 + 0.5 * h;
    } else if (h < 0.25) {
      const nx = 0.14 * x + 0.01 * y - 0.08;
      y = 0.51 * y - 1.31;
      x = nx;
      shade = 0.25;
    } else if (h < 0.5) {
      const nx = 0.43 * x + 0.52 * y + 1.49;
      y = -0.45 * x + 0.5 * y - 0.75;
      x = nx;
      shade = 0.5;
    } else if (h < 0.75) {
      const nx = 0.45 * x - 0.49 * y - 1.62;
      y = 0.47 * x + 0.47 * y - 0.74;
      x = nx;
      shade = 0.72;
    } else {
      x = 0.49 * x + 0.02;
      y = 0.51 * y + 1.62;
      shade = 0.9;
    }
    if (i < burn) continue;
    const dx = x - p.cx;
    const dy = y - p.cy;
    const rx = dx * p.c + dy * p.s;
    const ry = -dx * p.s + dy * p.c;
    const ndcX = rx / (p.radius * aspect);
    const ndcY = ry / p.radius;
    splat(buf, (ndcX * 0.5 + 0.5) * buf.w, (0.5 - ndcY * 0.5) * buf.h, shade);
  }
}

function fillRay(buf, state, y0, y1) {
  const cam = state.camera || { eye: [0, 0, 3], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
  const w = buf.w;
  const h = state.h || buf.h;
  const aspect = w / h;
  const steps = Math.max(6, Math.min(18, state.steps | 0 || 12));
  const iters = Math.max(3, Math.min(5, state.rayIters | 0 || 4));
  const shape = state.formula | 0;
  const power = state.power || 8;
  const far = shape === 1 ? 18 : 7.5;
  buf.source = 0;
  const ex = cam.eye[0];
  const ey = cam.eye[1];
  const ez = cam.eye[2];
  for (let y = y0; y < y1; y += 1) {
    const gy = h - 1 - y;
    const uvY = ((gy + 0.5) / h) * 2 - 1;
    const o = (y - buf.y0) * w;
    for (let x = 0; x < w; x += 1) {
      const uvX = ((x + 0.5) / w) * 2 - 1;
      let dx = cam.forward[0] * 1.35 + cam.right[0] * uvX * aspect + cam.up[0] * uvY;
      let dy = cam.forward[1] * 1.35 + cam.right[1] * uvX * aspect + cam.up[1] * uvY;
      let dz = cam.forward[2] * 1.35 + cam.right[2] * uvX * aspect + cam.up[2] * uvY;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      let t = 0.2;
      let glow = 0;
      let hit = false;
      let used = 0;
      for (let i = 0; i < steps && t <= far && !hit; i += 1) {
        const dist = mapScene(ex + dx * t, ey + dy * t, ez + dz * t, shape, power, iters);
        glow += Math.exp(-Math.max(dist, 0) * 7) * 0.07;
        used = i;
        if (dist < 0.0025 + t * 0.002) hit = true;
        else t += Math.min(0.4, Math.max(0.002, dist * 0.92));
      }
      const idx = o + x;
      if (!hit && glow < 0.03) paintEscape(buf, idx, false, 0, 0);
      else {
        const shade = hit ? 1 - used / Math.max(steps, 1) : glow;
        paintEscape(buf, idx, true, shade * 36 + glow * 28, Math.min(1, glow));
      }
    }
  }
}

function mapScene(x, y, z, shape, power, iters) {
  if (shape === 0) return mapBulb(x, y, z, power, iters);
  if (shape === 1) return mapBox(x, y, z, power, iters);
  if (shape === 2) return mapMenger(x, y, z, iters);
  return mapTetra(x, y, z, iters);
}

function mapBulb(px, py, pz, power, iters) {
  let zx = px;
  let zy = py;
  let zz = pz;
  let dr = 1;
  let r = 0;
  const p = Math.max(2, Math.min(10, power));
  for (let i = 0; i < iters && r < 2; i += 1) {
    r = Math.hypot(zx, zy, zz);
    if (r > 0.0001 && r < 2) {
      const theta = Math.acos(Math.max(-1, Math.min(1, zz / r))) * p;
      const phi = Math.atan2(zy, zx) * p;
      dr = r ** (p - 1) * p * dr + 1;
      const zr = r ** p;
      const st = Math.sin(theta);
      zx = zr * st * Math.cos(phi) + px;
      zy = zr * st * Math.sin(phi) + py;
      zz = zr * Math.cos(theta) + pz;
    }
  }
  return (0.5 * Math.log(Math.max(r, 1e-3)) * r) / Math.max(dr, 1e-3);
}

function mapBox(px, py, pz, scale, iters) {
  let zx = px;
  let zy = py;
  let zz = pz;
  let dr = 1;
  for (let i = 0; i < iters; i += 1) {
    zx = Math.min(1, Math.max(-1, zx)) * 2 - zx;
    zy = Math.min(1, Math.max(-1, zy)) * 2 - zy;
    zz = Math.min(1, Math.max(-1, zz)) * 2 - zz;
    const r2 = zx * zx + zy * zy + zz * zz;
    if (r2 < 0.25) {
      zx *= 4;
      zy *= 4;
      zz *= 4;
      dr *= 4;
    } else if (r2 < 1) {
      const inv = 1 / r2;
      zx *= inv;
      zy *= inv;
      zz *= inv;
      dr *= inv;
    }
    zx = zx * scale + px;
    zy = zy * scale + py;
    zz = zz * scale + pz;
    dr = dr * Math.abs(scale) + 1;
  }
  return Math.hypot(zx, zy, zz) / Math.max(Math.abs(dr), 1e-4);
}

function mapMenger(px, py, pz, iters) {
  const dBox = sdBox(px, py, pz, 1.05);
  let d = dBox;
  let s = 1;
  const n = Math.min(4, iters);
  for (let i = 0; i < n; i += 1) {
    let ax = ((px * s) % 2) - 1;
    let ay = ((py * s) % 2) - 1;
    let az = ((pz * s) % 2) - 1;
    if (ax < -1) ax += 2;
    if (ay < -1) ay += 2;
    if (az < -1) az += 2;
    s *= 3;
    const rx = Math.abs(1 - 3 * Math.abs(ax));
    const ry = Math.abs(1 - 3 * Math.abs(ay));
    const rz = Math.abs(1 - 3 * Math.abs(az));
    const c = (Math.min(Math.max(rx, ry), Math.min(Math.max(ry, rz), Math.max(rz, rx))) - 1) / s;
    d = Math.max(d, c);
  }
  return d;
}

function sdBox(x, y, z, b) {
  const qx = Math.abs(x) - b;
  const qy = Math.abs(y) - b;
  const qz = Math.abs(z) - b;
  const mx = Math.max(qx, 0);
  const my = Math.max(qy, 0);
  const mz = Math.max(qz, 0);
  return Math.hypot(mx, my, mz) + Math.min(Math.max(qx, qy, qz), 0);
}

function mapTetra(px, py, pz, iters) {
  let x = px;
  let y = py;
  let z = pz;
  let scale = 1;
  const n = Math.min(6, iters);
  for (let i = 0; i < n; i += 1) {
    if (x + y < 0) {
      const tx = -y;
      y = -x;
      x = tx;
    }
    if (x + z < 0) {
      const tx = -z;
      z = -x;
      x = tx;
    }
    if (y + z < 0) {
      const ty = -z;
      z = -y;
      y = ty;
    }
    x = x * 2 - 1;
    y = y * 2 - 1;
    z = z * 2 - 1;
    scale *= 2;
  }
  return (Math.hypot(x, y, z) - 1.45) / scale;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Precomputes one byte per pixel so recoloring is a table lookup.
 * Escape levels 0-63 are stripe (16) x edge (4). IFS levels 64-79 are
 * density brightness, and IFS iter values become log density.
 */
export function shadeLevels(buf) {
  const { w, iter, extra, alpha } = buf;
  const n = iter.length;
  if (!buf.level || buf.level.length !== n) buf.level = new Uint8Array(n);
  const level = buf.level;
  if (buf.source === 1) {
    for (let i = 0; i < n; i += 1) {
      const v = iter[i];
      level[i] = 64 + Math.round(smoothstep(0.015, 0.22, v) * 15);
      iter[i] = Math.log(1 + v * 16);
      alpha[i] = 1;
    }
    return;
  }
  for (let i = 0; i < n; i += 1) {
    if (!alpha[i]) {
      level[i] = 0;
      continue;
    }
    let m = Math.round((extra[i] || 0) * 15);
    if (m > 15) m = 15;
    if (m < 0) m = 0;
    let el = 0;
    if (i % w < w - 1 && alpha[i + 1]) {
      const e = Math.abs(iter[i + 1] - iter[i]) * 0.25;
      el = e >= 1 ? 3 : Math.round(e * 3);
    }
    level[i] = el * 16 + m;
  }
}
