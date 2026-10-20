import { cpow, escapeContext, insideSet, planeOf, rowStart, smoothIter } from "./kernel.js";

/**
 * Distance estimation for the 2D escape-time fractals.
 *
 * Exterior: alongside z the orbit carries dz/dc (dz/dz0 for Julia sets, a
 * 2x2 Jacobian for the folded formulas). At escape b = 2 |z| log|z| / |dz|;
 * the true distance to the set lies between b/4 and b. buf.dist holds b in
 * pixels (0 inside), buf.lit the normal-map light (0..255) from the
 * direction of z/dz, which is the gradient of the escape potential.
 *
 * Interior (Mandelbrot, power 2): once an orbit settles, its period comes
 * from the length of the cycle the Brent check found, Newton finds the
 * attracting cycle, and the interior estimate bounds a disk of
 * radius b/4 around c that lies wholly inside the set. Every pixel in that
 * disk is filled without iterating.
 */

const ESCAPE2 = 1e10;
const OVERSHOOT = 64;
const FIL_W = 0.7;
const AA_PX = 2;
const AA_OFFSETS = [
  [0.125, -0.375],
  [0.375, 0.125],
  [-0.125, 0.375],
  [-0.375, -0.125],
];
const LIGHT_ANGLE = (135 * Math.PI) / 180;
const LIGHT_HEIGHT = 1.5;
const DISK_MIN_PX = 1.5;
const GUESS_PX = 3;
const KOEBE_K = 0.3;

/** Filament weight for a distance in pixels: 1 on the boundary, 0 far away. */
export function filament(dpx) {
  const t = dpx / FIL_W;
  return Math.exp(-t * t);
}

const FIL_LUT = new Uint8Array(64 * 4);
for (let i = 0; i < FIL_LUT.length; i += 1) FIL_LUT[i] = Math.round(filament(i / 64) * 255);

function filamentByte(dpx) {
  const j = (dpx * 64) | 0;
  return j < FIL_LUT.length ? FIL_LUT[j] : 0;
}

export function demSupported(state) {
  if (state.family !== "escape") return false;
  const formula = state.formula | 0;
  if (formula > 6) return false;
  const square = Math.abs((state.power || 2) - 2) < 0.0008;
  if (formula > 1 && !square) return false;
  return (2 * state.radius) / Math.max(1, state.h || 1) > 1e-13;
}

function kindOf(c) {
  if ((c.formula === 0 || c.formula === 1) && c.square) return 0;
  return c.formula <= 1 ? 1 : 2;
}

function context(state) {
  const c = escapeContext(state);
  const px = (2 * state.radius) / Math.max(1, state.h || 1);
  const formula = c.formula;
  const rot = state.rotation || 0;
  const la = LIGHT_ANGLE + rot;
  const mandel2 = formula === 0 && c.square;
  return {
    ...c,
    px,
    invPx: 1 / px,
    kind: kindOf(c),
    lx: Math.cos(la),
    ly: Math.sin(la),
    disk: mandel2 && c.periodic && state.deDisk !== false,
    koebe: kindOf(c) === 0 && state.deKoebe !== false,
    koebeK: 0.25 * (state.deKoebeK ?? KOEBE_K),
  };
}

/** One sample: escaped?, smooth iteration, stripe, DE in world units, light 0..1, interior disk radius. */
const S = { esc: false, iter: 0, extra: 0, b: 0, lit: 1, ux: 0, uy: 0, inR: 0, Ax: 0, Ay: 0, Bx: 0, By: 0, Cx: 0, Cy: 0, L: 1 };

/** The orbit passed the user's bailout: smooth count and stripe exactly as the plain kernel has them. */
function crossed(k, i, zx, zy) {
  S.iter = smoothIter(i, zx, zy, k.bail, k.power);
  S.extra = 0.5 + 0.5 * Math.sin(Math.atan2(zy, zx) * 2);
}

/** Past the large radius: distance estimate and light from the gradient direction. */
function escaped(k, zx, zy, gx, gy, dmag) {
  const z2 = zx * zx + zy * zy;
  const mag = Math.sqrt(z2);
  S.esc = true;
  let b = dmag > 0 ? (2 * mag * Math.log(mag)) / dmag : Infinity;
  if (!(b >= 0)) b = 0;
  S.b = b;
  const gl = Math.hypot(gx, gy);
  if (gl > 0 && Number.isFinite(gl)) {
    S.ux = gx / gl;
    S.uy = gy / gl;
  } else {
    S.ux = 0;
    S.uy = 0;
  }
  const t = (S.ux * k.lx + S.uy * k.ly + LIGHT_HEIGHT) / (1 + LIGHT_HEIGHT);
  S.lit = t < 0 ? 0 : t;
}

function inside() {
  S.esc = false;
  S.iter = 0;
  S.extra = 0;
  S.b = 0;
  S.lit = 1;
}

/**
 * The orbit near z repeats after m steps (a multiple of the period). The
 * period is the first q <= m at which it comes back about as close.
 */
function exactPeriod(cx, cy, zx, zy, m) {
  if (m < 1 || m > 4096) return 0;
  let wx = zx;
  let wy = zy;
  for (let q = 0; q < m; q += 1) {
    const nx = wx * wx - wy * wy + cx;
    wy = 2 * wx * wy + cy;
    wx = nx;
  }
  const limit = ((wx - zx) * (wx - zx) + (wy - zy) * (wy - zy)) * 4 + 1e-30;
  wx = zx;
  wy = zy;
  for (let q = 1; q < m; q += 1) {
    const nx = wx * wx - wy * wy + cx;
    wy = 2 * wx * wy + cy;
    wx = nx;
    if (m % q !== 0) continue;
    const ex = wx - zx;
    const ey = wy - zy;
    if (ex * ex + ey * ey <= limit) return q;
  }
  return m;
}

/** True if the cycle through z (exact, period p) already closes at a proper divisor of p. */
function smallerPeriod(cx, cy, zx, zy, p) {
  let wx = zx;
  let wy = zy;
  const tol = 1e-16 * (1 + zx * zx + zy * zy);
  for (let q = 1; q < p; q += 1) {
    const nx = wx * wx - wy * wy + cx;
    wy = 2 * wx * wy + cy;
    wx = nx;
    if (p % q !== 0) continue;
    const ex = wx - zx;
    const ey = wy - zy;
    if (ex * ex + ey * ey < tol) return true;
  }
  return false;
}

/**
 * Interior distance (Heiland-Allen / Wikipedia) for z^2 + c with period p,
 * starting Newton from a point near the cycle. Returns the radius of a disk
 * around c that is certainly inside the set, or 0 when the cycle is not
 * attracting or Newton fails.
 */
export function interiorRadius(cx, cy, zx, zy, m) {
  const p = exactPeriod(cx, cy, zx, zy, m);
  if (p < 1 || p > 4096) return 0;
  for (let step = 0; step < 12; step += 1) {
    let wx = zx;
    let wy = zy;
    let dx = 1;
    let dy = 0;
    for (let k = 0; k < p; k += 1) {
      const ndx = 2 * (wx * dx - wy * dy);
      dy = 2 * (wx * dy + wy * dx);
      dx = ndx;
      const nx = wx * wx - wy * wy + cx;
      wy = 2 * wx * wy + cy;
      wx = nx;
    }
    const fx = wx - zx;
    const fy = wy - zy;
    const gx = dx - 1;
    const gy = dy;
    const g2 = gx * gx + gy * gy;
    if (!(g2 > 1e-300)) return 0;
    const sx = (fx * gx + fy * gy) / g2;
    const sy = (fy * gx - fx * gy) / g2;
    zx -= sx;
    zy -= sy;
    if (!Number.isFinite(zx) || !Number.isFinite(zy)) return 0;
    if (sx * sx + sy * sy < 1e-28 * (1 + zx * zx + zy * zy)) break;
  }
  let wx = zx;
  let wy = zy;
  let dzx = 1;
  let dzy = 0;
  let dcx = 0;
  let dcy = 0;
  let zzx = 0;
  let zzy = 0;
  let czx = 0;
  let czy = 0;
  for (let k = 0; k < p; k += 1) {
    const nczx = 2 * (dzx * dcx - dzy * dcy + wx * czx - wy * czy);
    const nczy = 2 * (dzx * dcy + dzy * dcx + wx * czy + wy * czx);
    const nzzx = 2 * (dzx * dzx - dzy * dzy + wx * zzx - wy * zzy);
    const nzzy = 2 * (2 * dzx * dzy + wx * zzy + wy * zzx);
    const ndcx = 2 * (wx * dcx - wy * dcy) + 1;
    const ndcy = 2 * (wx * dcy + wy * dcx);
    const ndzx = 2 * (wx * dzx - wy * dzy);
    const ndzy = 2 * (wx * dzy + wy * dzx);
    const nx = wx * wx - wy * wy + cx;
    wy = 2 * wx * wy + cy;
    wx = nx;
    czx = nczx;
    czy = nczy;
    zzx = nzzx;
    zzy = nzzy;
    dcx = ndcx;
    dcy = ndcy;
    dzx = ndzx;
    dzy = ndzy;
  }
  const ex = wx - zx;
  const ey = wy - zy;
  if (ex * ex + ey * ey > 1e-18 * (1 + zx * zx + zy * zy)) return 0;
  if (smallerPeriod(cx, cy, zx, zy, p)) return 0;
  const l2 = dzx * dzx + dzy * dzy;
  if (!(l2 < 1)) return 0;
  const ox = 1 - dzx;
  const oy = -dzy;
  const o2 = ox * ox + oy * oy;
  const qx = (dcx * ox + dcy * oy) / o2;
  const qy = (dcy * ox - dcx * oy) / o2;
  const tx = czx + zzx * qx - zzy * qy;
  const ty = czy + zzx * qy + zzy * qx;
  const den = Math.hypot(tx, ty);
  if (!(den > 0)) return 0;
  const b = (1 - l2) / den;
  return Number.isFinite(b) ? b * 0.25 : 0;
}

/** z^2 + c (or the Julia map) with the complex derivative. */
function sampleSquare(k, wx, wy) {
  let cx;
  let cy;
  let zx;
  let zy;
  let dx;
  let dy;
  const julia = k.julia;
  if (julia) {
    cx = k.jx;
    cy = k.jy;
    zx = wx;
    zy = wy;
    dx = 1;
    dy = 0;
  } else {
    cx = wx;
    cy = wy;
    zx = 0;
    zy = 0;
    dx = 0;
    dy = 0;
  }
  S.inR = 0;
  if (k.skip && insideSet(cx, cy)) {
    inside();
    return;
  }
  const { n, periodic, tol2, disk } = k;
  const one = julia ? 0 : 1;
  let saveX = zx;
  let saveY = zy;
  let checkpoint = 16;
  let saved = -1;
  let limit = n;
  let out = false;
  for (let i = 0; i < limit; i += 1) {
    const ndx = 2 * (zx * dx - zy * dy) + one;
    dy = 2 * (zx * dy + zy * dx);
    dx = ndx;
    const xx = zx * zx - zy * zy + cx;
    zy = 2 * zx * zy + cy;
    zx = xx;
    const z2 = zx * zx + zy * zy;
    if (z2 > k.bail) {
      if (!out) {
        out = true;
        crossed(k, i, zx, zy);
        limit = i + OVERSHOOT;
      }
      if (z2 > ESCAPE2 || i + 1 === limit) {
        escaped(k, zx, zy, zx * dx + zy * dy, zy * dx - zx * dy, Math.hypot(dx, dy));
        return;
      }
      continue;
    }
    if (periodic && (i & 3) === 0) {
      const ex = zx - saveX;
      const ey = zy - saveY;
      if (ex * ex + ey * ey < tol2) {
        if (disk) S.inR = interiorRadius(cx, cy, zx, zy, i - saved);
        break;
      }
      if (i === checkpoint) {
        saveX = zx;
        saveY = zy;
        saved = i;
        checkpoint *= 2;
      }
    }
  }
  inside();
}

/** Other powers of z^p + c and its Julia set: complex derivative p z^(p-1) dz. */
function samplePower(k, wx, wy) {
  let cx;
  let cy;
  let zx;
  let zy;
  let dx;
  let dy;
  const julia = k.julia;
  if (julia) {
    cx = k.jx;
    cy = k.jy;
    zx = wx;
    zy = wy;
    dx = 1;
    dy = 0;
  } else {
    cx = wx;
    cy = wy;
    zx = 0;
    zy = 0;
    dx = 0;
    dy = 0;
  }
  S.inR = 0;
  const { n, periodic, tol2, power } = k;
  const one = julia ? 0 : 1;
  let saveX = zx;
  let saveY = zy;
  let checkpoint = 16;
  let limit = n;
  let out = false;
  for (let i = 0; i < limit; i += 1) {
    const q = cpow(zx, zy, power - 1);
    const qx = power * q[0];
    const qy = power * q[1];
    const ndx = qx * dx - qy * dy + one;
    dy = qx * dy + qy * dx;
    dx = ndx;
    const r = cpow(zx, zy, power);
    zx = r[0] + cx;
    zy = r[1] + cy;
    const z2 = zx * zx + zy * zy;
    if (z2 > k.bail) {
      if (!out) {
        out = true;
        crossed(k, i, zx, zy);
        limit = i + OVERSHOOT;
      }
      if (z2 > ESCAPE2 || i + 1 === limit) {
        escaped(k, zx, zy, zx * dx + zy * dy, zy * dx - zx * dy, Math.hypot(dx, dy));
        return;
      }
      continue;
    }
    if (periodic && (i & 3) === 0) {
      const ex = zx - saveX;
      const ey = zy - saveY;
      if (ex * ex + ey * ey < tol2) break;
      if (i === checkpoint) {
        saveX = zx;
        saveY = zy;
        checkpoint *= 2;
      }
    }
  }
  inside();
}

/**
 * Burning Ship, Tricorn, Celtic, Buffalo, Perpendicular: the maps are not
 * holomorphic, so the orbit carries the real Jacobian d(z)/d(c). Folds are
 * reflections, so |dz| is taken as the RMS of its singular values.
 */
function sampleFolded(k, wx, wy) {
  const cx = wx;
  const cy = wy;
  let zx = 0;
  let zy = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  S.inR = 0;
  const { n, periodic, tol2, formula } = k;
  let saveX = zx;
  let saveY = zy;
  let checkpoint = 16;
  let limit = n;
  let out = false;
  for (let i = 0; i < limit; i += 1) {
    let bx = zx;
    let by = zy;
    if (formula === 2) {
      if (zx < 0) {
        bx = -zx;
        a = -a;
        b = -b;
      }
      if (zy < 0) {
        by = -zy;
        c = -c;
        d = -d;
      }
    } else if (formula === 3) {
      by = -zy;
      c = -c;
      d = -d;
    } else if (formula === 6 && zy < 0) {
      by = -zy;
      c = -c;
      d = -d;
    }
    let nx = bx * bx - by * by;
    const ny = 2 * bx * by;
    let na = 2 * (bx * a - by * c);
    let nb = 2 * (bx * b - by * d);
    let nc = 2 * (by * a + bx * c);
    let nd = 2 * (by * b + bx * d);
    if (formula === 4 || formula === 5) {
      if (nx < 0) {
        nx = -nx;
        na = -na;
        nb = -nb;
      }
    }
    let fy = ny;
    if (formula === 5 && ny < 0) {
      fy = -ny;
      nc = -nc;
      nd = -nd;
    }
    a = na + 1;
    b = nb;
    c = nc;
    d = nd + 1;
    zx = nx + cx;
    zy = fy + cy;
    const z2 = zx * zx + zy * zy;
    if (z2 > k.bail) {
      if (!out) {
        out = true;
        crossed(k, i, zx, zy);
        limit = i + OVERSHOOT;
      }
      if (z2 > ESCAPE2 || i + 1 === limit) {
        const dmag = Math.sqrt((a * a + b * b + c * c + d * d) * 0.5);
        escaped(k, zx, zy, a * zx + c * zy, b * zx + d * zy, dmag);
        return;
      }
      continue;
    }
    if (periodic && (i & 3) === 0) {
      const ex = zx - saveX;
      const ey = zy - saveY;
      if (ex * ex + ey * ey < tol2) break;
      if (i === checkpoint) {
        saveX = zx;
        saveY = zy;
        checkpoint *= 2;
      }
    }
  }
  inside();
}

function sample(k, wx, wy) {
  if (k.kind === 0) sampleSquare(k, wx, wy);
  else if (k.kind === 1) samplePower(k, wx, wy);
  else sampleFolded(k, wx, wy);
}

function store(buf, idx, k) {
  if (!S.esc) {
    buf.iter[idx] = 0;
    buf.extra[idx] = 0;
    buf.alpha[idx] = 0;
    buf.dist[idx] = 0;
    buf.lit[idx] = 255;
    return;
  }
  buf.iter[idx] = S.iter;
  buf.extra[idx] = S.extra;
  buf.alpha[idx] = 1;
  buf.dist[idx] = Math.min(S.b * k.invPx, 1e6);
  buf.lit[idx] = Math.round(S.lit * 255);
}

function ensure(buf) {
  const n = buf.iter.length;
  if (!buf.dist || buf.dist.length !== n) buf.dist = new Float32Array(n);
  if (!buf.lit || buf.lit.length !== n) buf.lit = new Uint8Array(n);
}

/** Marks every pixel center within r pixels of (x, y) inside the set. Rows above are already done. */
function fillInteriorDisk(buf, mask, w, ly0, rows, x, ly, r) {
  const ri = Math.floor(r);
  const r2 = r * r;
  const yB = Math.min(rows - 1, ly + ri);
  for (let yy = ly; yy <= yB; yy += 1) {
    const dy = yy - ly;
    const half = Math.floor(Math.sqrt(r2 - dy * dy));
    const xA = dy === 0 ? x + 1 : Math.max(0, x - half);
    const xB = Math.min(w - 1, x + half);
    const mo = yy * w;
    const o = (ly0 + yy) * w;
    for (let xx = xA; xx <= xB; xx += 1) {
      if (mask[mo + xx]) continue;
      mask[mo + xx] = 1;
      const idx = o + xx;
      buf.iter[idx] = 0;
      buf.extra[idx] = 0;
      buf.alpha[idx] = 0;
      buf.dist[idx] = 0;
      buf.lit[idx] = 255;
    }
  }
}

/**
 * z^2 + c that also carries the second and third derivatives, for the Koebe
 * fill below. At escape it keeps A = z'/z, B = A', C = B' and log|z|: the
 * derivatives of the complex potential log(z_n) / 2^n up to the factor 2^-n.
 */
function sampleSquare2(k, wx, wy) {
  let cx;
  let cy;
  let zx;
  let zy;
  let dx;
  let dy;
  let ex = 0;
  let ey = 0;
  let fx = 0;
  let fy = 0;
  const julia = k.julia;
  if (julia) {
    cx = k.jx;
    cy = k.jy;
    zx = wx;
    zy = wy;
    dx = 1;
    dy = 0;
  } else {
    cx = wx;
    cy = wy;
    zx = 0;
    zy = 0;
    dx = 0;
    dy = 0;
  }
  const one = julia ? 0 : 1;
  const limit = k.n + OVERSHOOT;
  for (let i = 0; i < limit; i += 1) {
    const nfx = 2 * (zx * fx - zy * fy + 3 * (dx * ex - dy * ey));
    fy = 2 * (zx * fy + zy * fx + 3 * (dx * ey + dy * ex));
    fx = nfx;
    const nex = 2 * (dx * dx - dy * dy + zx * ex - zy * ey);
    ey = 2 * (2 * dx * dy + zx * ey + zy * ex);
    ex = nex;
    const ndx = 2 * (zx * dx - zy * dy) + one;
    dy = 2 * (zx * dy + zy * dx);
    dx = ndx;
    const xx = zx * zx - zy * zy + cx;
    zy = 2 * zx * zy + cy;
    zx = xx;
    const z2 = zx * zx + zy * zy;
    if (z2 > ESCAPE2) {
      const ax = (dx * zx + dy * zy) / z2;
      const ay = (dy * zx - dx * zy) / z2;
      const ux = (ex * zx + ey * zy) / z2;
      const uy = (ey * zx - ex * zy) / z2;
      const bx = ux - (ax * ax - ay * ay);
      const by = uy - 2 * ax * ay;
      S.Ax = ax;
      S.Ay = ay;
      S.Bx = bx;
      S.By = by;
      S.Cx = (fx * zx + fy * zy) / z2 - (ax * ux - ay * uy) - 2 * (ax * bx - ay * by);
      S.Cy = (fy * zx - fx * zy) / z2 - (ax * uy + ay * ux) - 2 * (ax * by + ay * bx);
      S.L = 0.5 * Math.log(z2);
      return Number.isFinite(S.Cx + S.Cy + S.Bx + S.By);
    }
  }
  return false;
}

/**
 * Koebe 1/4: the disk of radius b/4 around an escaping c holds no point of
 * the set, so the potential is holomorphic there. Pixels within KOEBE_K of
 * that radius take the third-order Taylor expansion of the potential
 * (smooth count, distance and normal) instead of iterating. The stripe is
 * copied from the center, so this is only for modes that ignore stripes.
 */
function fillExteriorDisk(buf, mask, w, ly0, rows, x, ly, r, k, row) {
  const ri = Math.floor(r);
  const r2 = r * r;
  const { Ax, Ay, Bx, By, L } = S;
  const extra0 = S.extra;
  const Cx = S.Cx / 6;
  const Cy = S.Cy / 6;
  const iter0 = S.iter;
  const px = k.px;
  const sx = row.dwx;
  const sy = row.dwy;
  const lx = k.lx;
  const ly2 = k.ly;
  const invL = 1 / L;
  const yB = Math.min(rows - 1, ly + ri);
  for (let yy = ly; yy <= yB; yy += 1) {
    const oy = yy - ly;
    const half = Math.floor(Math.sqrt(r2 - oy * oy));
    const xA = oy === 0 ? x + 1 : Math.max(0, x - half);
    const xB = Math.min(w - 1, x + half);
    const mo = yy * w;
    const o = (ly0 + yy) * w;
    for (let xx = xA; xx <= xB; xx += 1) {
      if (mask[mo + xx]) continue;
      mask[mo + xx] = 1;
      const ox = xx - x;
      const qx = ox * sx + oy * sy;
      const qy = ox * sy - oy * sx;
      const sqx = qx * qx - qy * qy;
      const sqy = 2 * qx * qy;
      const cux = sqx * qx - sqy * qy;
      const cuy = sqx * qy + sqy * qx;
      const tx = Ax * qx - Ay * qy + 0.5 * (Bx * sqx - By * sqy) + Cx * cux - Cy * cuy;
      const apx = Ax + Bx * qx - By * qy + 3 * (Cx * sqx - Cy * sqy);
      const apy = Ay + Bx * qy + By * qx + 3 * (Cx * sqy + Cy * sqx);
      const am = Math.sqrt(apx * apx + apy * apy);
      const lp = L + tx;
      const idx = o + xx;
      buf.iter[idx] = iter0 - Math.log(lp * invL) * Math.LOG2E;
      buf.extra[idx] = extra0;
      buf.alpha[idx] = 1;
      buf.dist[idx] = (2 * lp) / (am * px);
      const t = ((apx * lx - apy * ly2) / am + LIGHT_HEIGHT) / (1 + LIGHT_HEIGHT);
      buf.lit[idx] = t < 0 ? 0 : Math.round(t * 255);
    }
  }
}

/**
 * Antialiasing pass for a settled distance frame, same contract as
 * antialias.js refineRows: `base` holds rows y0-1 .. y1 of the frame. Only
 * pixels within AA_PX of the boundary (and interior pixels touching the
 * outside) get four more samples; everything farther is a smooth gradient.
 * Distance and light are averaged over the escaping samples; the filament
 * weight (`fil`, 0..255) over all of them with inside samples counting as
 * fully filament, so coverage is already in `fil` and `cover` stays 0.
 */
export function refineDistanceRows(state, base, y0, y1, select = "de") {
  const k = context(state);
  const p = planeOf(state);
  const { w, h } = state;
  const rows = y1 - y0;
  const n = w * rows;
  const iter = new Float32Array(n);
  const extra = new Float32Array(n);
  const alpha = new Uint8Array(n);
  const band = new Float32Array(n);
  const cover = new Uint8Array(n);
  const dist = new Float32Array(n);
  const lit = new Uint8Array(n);
  const fil = new Uint8Array(n);
  const bi = base.iter;
  const ba = base.alpha;
  const bd = base.dist;
  const bl = base.lit;
  let refined = 0;
  for (let y = y0; y < y1; y += 1) {
    const by = (y - base.y0) * w;
    const up = y > 0 ? by - w : by;
    const down = y < h - 1 ? by + w : by;
    const row = rowStart(p, y);
    for (let x = 0; x < w; x += 1) {
      const kk = by + x;
      const o = (y - y0) * w + x;
      iter[o] = bi[kk];
      extra[o] = base.extra[kk];
      alpha[o] = ba[kk];
      band[o] = ba[kk] ? Math.floor(bi[kk]) : 0;
      dist[o] = bd[kk];
      lit[o] = bl[kk];
      fil[o] = ba[kk] ? filamentByte(bd[kk]) : 255;
      let pick;
      if (select === "all") pick = true;
      else if (select === "band") {
        const b0 = ba[kk] ? Math.floor(bi[kk]) : -1;
        const bandOf = (j) => (ba[j] ? Math.floor(bi[j]) : -1);
        pick = (x > 0 && bandOf(kk - 1) !== b0) || (x < w - 1 && bandOf(kk + 1) !== b0) || bandOf(up + x) !== b0 || bandOf(down + x) !== b0;
      } else if (ba[kk]) pick = bd[kk] < AA_PX;
      else pick = (x > 0 && ba[kk - 1]) || (x < w - 1 && ba[kk + 1]) || ba[up + x] || ba[down + x];
      if (!pick) continue;
      refined += 1;
      let out = ba[kk] ? 1 : 0;
      let sumF = out ? filament(bd[kk]) : 1;
      let sumI = out ? bi[kk] : 0;
      let sumE = out ? base.extra[kk] : 0;
      let sumL = out ? bl[kk] / 255 : 0;
      let sumD = out ? bd[kk] : 0;
      let sumB = out ? Math.floor(bi[kk]) : 0;
      const wx = row.wx + x * row.dwx;
      const wy = row.wy + x * row.dwy;
      for (let s = 0; s < 4; s += 1) {
        const ox = AA_OFFSETS[s][0];
        const oy = AA_OFFSETS[s][1];
        sample(k, wx + ox * row.dwx + oy * row.dwy, wy + ox * row.dwy - oy * row.dwx);
        if (!S.esc) {
          sumF += 1;
          continue;
        }
        out += 1;
        const d = S.b * k.invPx;
        sumF += filament(d);
        sumD += d;
        sumI += S.iter;
        sumE += S.extra;
        sumL += S.lit;
        sumB += Math.floor(S.iter);
      }
      if (out === 0) continue;
      iter[o] = sumI / out;
      extra[o] = sumE / out;
      band[o] = sumB / out;
      lit[o] = Math.round((sumL / out) * 255);
      dist[o] = sumD / out;
      fil[o] = Math.round((sumF / 5) * 255);
      alpha[o] = 1;
    }
  }
  return { iter, extra, alpha, band, cover, dist, lit, fil, refined };
}

/** Copies the distance fields of a worker message into the frame buffer at `off`. */
export function storeDistance(buf, msg, off) {
  if (!msg.dist) return;
  const n = buf.iter.length;
  if (!buf.dist || buf.dist.length !== n) buf.dist = new Float32Array(n);
  if (!buf.lit || buf.lit.length !== n) buf.lit = new Uint8Array(n);
  buf.dist.set(msg.dist, off);
  buf.lit.set(msg.lit, off);
  if (msg.fil) {
    if (!buf.fil || buf.fil.length !== n) buf.fil = new Uint8Array(n);
    buf.fil.set(msg.fil, off);
  }
}

/**
 * Escape-time rows with distance estimates. Fills iter/extra/alpha like the
 * plain kernel plus buf.dist and buf.lit. Returns how many pixels were
 * iterated; the rest were filled from interior or Koebe disks.
 */
export function fillDistance(buf, state, y0, y1) {
  const p = planeOf(state);
  const k = context(state);
  const w = buf.w;
  const rows = y1 - y0;
  buf.source = 0;
  ensure(buf);
  const koebe = k.koebe;
  const useMask = k.disk || koebe;
  const mask = useMask ? new Uint8Array(w * rows) : null;
  const ly0 = y0 - buf.y0;
  const starts = new Array(rows);
  for (let ly = 0; ly < rows; ly += 1) starts[ly] = rowStart(p, y0 + ly);
  let iterated = 0;
  const visit = (x, ly) => {
    const row = starts[ly];
    const wx = row.wx + x * row.dwx;
    const wy = row.wy + x * row.dwy;
    sample(k, wx, wy);
    iterated += 1;
    store(buf, (ly0 + ly) * w + x, k);
    if (!useMask) return;
    mask[ly * w + x] = 1;
    if (S.esc) {
      if (!koebe) return;
      const r = S.b * k.koebeK * k.invPx;
      if (r >= DISK_MIN_PX && sampleSquare2(k, wx, wy)) fillExteriorDisk(buf, mask, w, ly0, rows, x, ly, r, k, row);
    } else if (S.inR > 0) {
      const r = S.inR * k.invPx;
      if (r >= DISK_MIN_PX) fillInteriorDisk(buf, mask, w, ly0, rows, x, ly, r);
    }
  };
  const guess = state.soft && rows >= 3 && w >= 3;
  if (!guess) {
    for (let ly = 0; ly < rows; ly += 1) {
      const mo = ly * w;
      for (let x = 0; x < w; x += 1) if (!useMask || !mask[mo + x]) visit(x, ly);
    }
    return iterated;
  }
  const coarseRow = (ly) => (ly & 1) === 0 || ly === rows - 1;
  const coarseCol = (x) => (x & 1) === 0 || x === w - 1;
  for (let ly = 0; ly < rows; ly += 1) {
    if (!coarseRow(ly)) continue;
    const mo = ly * w;
    for (let x = 0; x < w; x += 1) if (coarseCol(x) && (!useMask || !mask[mo + x])) visit(x, ly);
  }
  for (let ly = 0; ly < rows; ly += 1) {
    const rowCoarse = coarseRow(ly);
    const mo = ly * w;
    for (let x = 0; x < w; x += 1) {
      if ((rowCoarse && coarseCol(x)) || (useMask && mask[mo + x])) continue;
      if (!guessGap(buf, (ly0 + ly) * w + x, w, rowCoarse, coarseCol(x))) visit(x, ly);
    }
  }
  return iterated;
}

/**
 * Solid guessing while the view moves: a gap pixel takes the average of its
 * computed neighbors when they are all inside, or all outside in one band and
 * well clear of the boundary, so filaments are always iterated.
 */
function guessGap(buf, idx, w, rowCoarse, colCoarse) {
  const { iter, extra, alpha, dist, lit } = buf;
  let a;
  let b;
  let c = -1;
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
    c = idx + w - 1;
    d = idx + w + 1;
  }
  const four = c >= 0;
  const out = alpha[a] + alpha[b] + (four ? alpha[c] + alpha[d] : 0);
  if (out === 0) {
    iter[idx] = 0;
    extra[idx] = 0;
    alpha[idx] = 0;
    dist[idx] = 0;
    lit[idx] = 255;
    return true;
  }
  if (out !== (four ? 4 : 2)) return false;
  const band = Math.floor(iter[a]);
  if (Math.floor(iter[b]) !== band || dist[a] < GUESS_PX || dist[b] < GUESS_PX) return false;
  if (four && (Math.floor(iter[c]) !== band || Math.floor(iter[d]) !== band || dist[c] < GUESS_PX || dist[d] < GUESS_PX)) return false;
  const m = four ? 0.25 : 0.5;
  iter[idx] = (iter[a] + iter[b] + (four ? iter[c] + iter[d] : 0)) * m;
  extra[idx] = (extra[a] + extra[b] + (four ? extra[c] + extra[d] : 0)) * m;
  dist[idx] = (dist[a] + dist[b] + (four ? dist[c] + dist[d] : 0)) * m;
  lit[idx] = Math.round((lit[a] + lit[b] + (four ? lit[c] + lit[d] : 0)) * m);
  alpha[idx] = 1;
  return true;
}

const LUT_SIZE = 1024;
const OCTAVE = 3.2;

const litTable = new Float32Array(256);
for (let i = 0; i < 256; i += 1) litTable[i] = 0.38 + 0.82 * (i / 255);


/**
 * Per-pixel factors, rebuilt only when a new frame arrives: light (8.8 fixed
 * point), filament weight 0..255, and a halo that brightens the last few
 * pixels before the boundary.
 */
function shadeTables(buf) {
  const n = buf.iter.length;
  if (buf.deMul && buf.deMulFor === buf.dist && buf.deMul.length === n) return;
  const mul = (buf.deMul = new Uint16Array(n));
  const mix = (buf.deMix = new Uint8Array(n));
  const halo = (buf.deHalo = new Uint16Array(n));
  buf.deMulFor = buf.dist;
  const { alpha, dist, lit, fil } = buf;
  for (let i = 0; i < n; i += 1) {
    if (!alpha[i]) {
      mul[i] = 256;
      mix[i] = 255;
      halo[i] = 256;
      continue;
    }
    const d = dist[i];
    mix[i] = fil ? fil[i] : filamentByte(d);
    mul[i] = Math.round(litTable[lit[i]] * 256);
    halo[i] = Math.round((1 + 0.3 / (1 + d * 0.5)) * 256);
  }
}

/** Palette step per pixel from the distance in pixels: one band per few octaves, the same at every zoom. */
function distanceSteps(buf, density) {
  const n = buf.iter.length;
  if (buf.deStep && buf.deStepFor === buf.dist && buf.deStepDensity === density) return buf.deStep;
  const step = buf.deStep && buf.deStep.length === n ? buf.deStep : new Uint16Array(n);
  const { alpha, dist, iter } = buf;
  const k = density * OCTAVE * LUT_SIZE;
  const ki = density * 0.2 * LUT_SIZE;
  for (let i = 0; i < n; i += 1) {
    if (!alpha[i]) continue;
    step[i] = (Math.log2(1 + dist[i]) * k + iter[i] * ki) & (LUT_SIZE - 1);
  }
  buf.deStep = step;
  buf.deStepFor = buf.dist;
  buf.deStepDensity = density;
  return step;
}

function packRgb(r, g, b) {
  return (0xff000000 | ((b > 255 ? 255 : b) << 16) | ((g > 255 ? 255 : g) << 8) | (r > 255 ? 255 : r)) >>> 0;
}

/**
 * The Distance color mode: palette by log distance to the boundary, lit
 * from the upper left by the normal of the potential, with the boundary
 * itself drawn as bright filaments a pixel wide at any zoom.
 */
export function paintDistance(buf, out32, lut, phase, density, interior) {
  shadeTables(buf);
  const step = distanceSteps(buf, density);
  const { deMul: mul, deMix: mix, deHalo: halo, alpha } = buf;
  const n = out32.length;
  const mask = LUT_SIZE - 1;
  const ph = ((phase - Math.floor(phase)) * LUT_SIZE) | 0;
  for (let i = 0; i < n; i += 1) {
    if (!alpha[i]) {
      out32[i] = interior;
      continue;
    }
    const c = lut[(step[i] + ph) & mask];
    const f = mix[i];
    const m = (mul[i] * halo[i]) >> 8;
    const r = c & 255;
    const g = (c >> 8) & 255;
    const b = (c >> 16) & 255;
    const keep = m * (255 - f);
    const lift = f * 128;
    out32[i] = packRgb(
      (r * keep + (r * 320 + 30000) * f - (r * lift * r) / 255) >> 16,
      (g * keep + (g * 320 + 30000) * f - (g * lift * g) / 255) >> 16,
      (b * keep + (b * 320 + 30000) * f - (b * lift * b) / 255) >> 16,
    );
  }
}

/**
 * Relief over any other color mode: the same normal-map light, and the
 * filaments drawn in the interior color so the set and its hairs read as one
 * shape.
 */
export function applyDistance(buf, out32, interior) {
  if (!buf.dist || buf.source === 1) return;
  shadeTables(buf);
  const { deMul: mul, deMix: mix } = buf;
  const n = out32.length;
  const ir = interior & 255;
  const ig = (interior >> 8) & 255;
  const ib = (interior >> 16) & 255;
  for (let i = 0; i < n; i += 1) {
    const f = mix[i];
    if (f === 255) {
      out32[i] = interior;
      continue;
    }
    const c = out32[i];
    const m = mul[i] * (255 - f);
    out32[i] = packRgb(
      ((c & 255) * m + ir * f * 256) >> 16,
      (((c >> 8) & 255) * m + ig * f * 256) >> 16,
      (((c >> 16) & 255) * m + ib * f * 256) >> 16,
    );
  }
}
