/**
 * Rectangle checking (Mariani–Silver) for escape-time sets that have no
 * holes: the Mandelbrot set and its integer-power relatives, and connected
 * Julia sets. Every border pixel of a rectangle is computed; when they are
 * all inside the set the whole rectangle is, because the points that stay
 * bounded for n iterations form a full set (each |p_k(c)| <= R is a filled
 * lemniscate, by the maximum modulus principle). Otherwise the rectangle is
 * split in two along its longer side, sharing the cut line, until it is
 * small enough to compute directly.
 *
 * With `exterior`, a rectangle whose border escapes in one dwell band is
 * also filled, interpolating the smooth count and stripe across it from its
 * four edges (a Coons patch). That is an approximation: within a band the
 * smooth count is a smooth function, but not an exactly bilinear one.
 */
const MIN_SIDE = 3;

export function rectFill(buf, state, y0, y1, pixel, c, plane, rowStart, exterior = false) {
  const w = buf.w;
  const rows = y1 - y0;
  if (w < 4 || rows < 4) return false;
  const done = new Uint8Array(w * rows);
  const starts = new Array(rows);
  for (let ly = 0; ly < rows; ly += 1) starts[ly] = rowStart(plane, y0 + ly);
  const { iter, extra, alpha } = buf;
  const off = (y0 - buf.y0) * w;
  const calc = (x, ly) => {
    const k = ly * w + x;
    if (done[k]) return;
    done[k] = 1;
    const r = starts[ly];
    pixel(buf, off + k, r.wx + x * r.dwx, r.wy + x * r.dwy, c);
  };
  // Inside and settled: alpha 0 with extra 0 (the deep kernel marks pixels that merely ran out of iterations with extra 1).
  const inside = (k) => alpha[off + k] === 0 && extra[off + k] === 0;
  const stack = [[0, 0, w - 1, rows - 1]];
  while (stack.length) {
    const [x0, ly0, x1, ly1] = stack.pop();
    for (let x = x0; x <= x1; x += 1) {
      calc(x, ly0);
      calc(x, ly1);
    }
    for (let ly = ly0 + 1; ly < ly1; ly += 1) {
      calc(x0, ly);
      calc(x1, ly);
    }
    if (x1 - x0 < 2 || ly1 - ly0 < 2) continue;
    let allIn = true;
    let band = -1;
    let sameBand = exterior;
    const look = (k) => {
      if (allIn && !inside(k)) allIn = false;
      if (sameBand) {
        if (!alpha[off + k]) sameBand = false;
        else {
          const b = Math.floor(iter[off + k]);
          if (band < 0) band = b;
          else if (b !== band) sameBand = false;
        }
      }
    };
    for (let x = x0; x <= x1 && (allIn || sameBand); x += 1) {
      look(ly0 * w + x);
      look(ly1 * w + x);
    }
    for (let ly = ly0 + 1; ly < ly1 && (allIn || sameBand); ly += 1) {
      look(ly * w + x0);
      look(ly * w + x1);
    }
    if (allIn) {
      for (let ly = ly0 + 1; ly < ly1; ly += 1) {
        for (let x = x0 + 1; x < x1; x += 1) {
          const k = ly * w + x;
          if (done[k]) continue;
          done[k] = 1;
          iter[off + k] = 0;
          extra[off + k] = 0;
          alpha[off + k] = 0;
        }
      }
      continue;
    }
    if (sameBand) {
      coons(buf, off, w, x0, ly0, x1, ly1, done);
      continue;
    }
    const sw = x1 - x0;
    const sh = ly1 - ly0;
    if (sw <= MIN_SIDE * 2 && sh <= MIN_SIDE * 2) {
      for (let ly = ly0 + 1; ly < ly1; ly += 1) for (let x = x0 + 1; x < x1; x += 1) calc(x, ly);
      continue;
    }
    if (sw >= sh) {
      const mid = (x0 + x1) >> 1;
      stack.push([x0, ly0, mid, ly1], [mid, ly0, x1, ly1]);
    } else {
      const mid = (ly0 + ly1) >> 1;
      stack.push([x0, ly0, x1, mid], [x0, mid, x1, ly1]);
    }
  }
  return true;
}

function coons(buf, off, w, x0, ly0, x1, ly1, done) {
  const { iter, extra, alpha } = buf;
  const at = (x, ly) => off + ly * w + x;
  const c00 = at(x0, ly0);
  const c10 = at(x1, ly0);
  const c01 = at(x0, ly1);
  const c11 = at(x1, ly1);
  for (let ly = ly0 + 1; ly < ly1; ly += 1) {
    const v = (ly - ly0) / (ly1 - ly0);
    const l = at(x0, ly);
    const r = at(x1, ly);
    for (let x = x0 + 1; x < x1; x += 1) {
      const k = ly * w + x;
      if (done[k]) continue;
      done[k] = 1;
      const u = (x - x0) / (x1 - x0);
      const t = at(x, ly0);
      const b = at(x, ly1);
      const corner = (arr) => (1 - u) * (1 - v) * arr[c00] + u * (1 - v) * arr[c10] + (1 - u) * v * arr[c01] + u * v * arr[c11];
      const blend = (arr) => (1 - v) * arr[t] + v * arr[b] + (1 - u) * arr[l] + u * arr[r] - corner(arr);
      iter[off + k] = blend(iter);
      extra[off + k] = blend(extra);
      alpha[off + k] = 1;
    }
  }
}

/** Formulas whose sets are full, so an all-inside border proves the inside. */
export function rectSafe(state) {
  const f = state.formula | 0;
  const p = state.power || 2;
  if (Math.abs(p - Math.round(p)) > 1e-6 || p < 2) return false;
  if (f === 0) return true;
  if (f !== 1) return false;
  // A Julia set is connected (full) exactly when the critical orbit stays bounded.
  let x = 0;
  let y = 0;
  const cx = state.juliaRe || 0;
  const cy = state.juliaIm || 0;
  for (let i = 0; i < 2000; i += 1) {
    const nx = x * x - y * y + cx;
    y = 2 * x * y + cy;
    x = nx;
    if (x * x + y * y > 4) return false;
  }
  return Math.round(p) === 2;
}
