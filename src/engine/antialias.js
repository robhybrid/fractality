import { createBuffer, escapeContext, escapePixel, fillRows } from "./kernel.js";

/** Rotated-grid offsets (in pixels) added to the existing center sample. */
const OFFSETS = [
  [0.125, -0.375],
  [0.375, 0.125],
  [-0.125, 0.375],
  [-0.375, -0.125],
];

export function antialiasEligible(state) {
  if (state.family === "ray" || state.family === "ifs") return false;
  const px = (2 * state.radius) / Math.max(1, state.h || 1);
  return state.formula >= 8 || px > 1e-12;
}

function sampler(state) {
  const one = createBuffer(1, 1);
  if (state.family === "escape" && state.formula < 8) {
    const c = escapeContext(state);
    return (wx, wy) => {
      escapePixel(one, 0, wx, wy, c);
      return one;
    };
  }
  const px = (2 * state.radius) / state.h;
  const st = { ...state, w: 1, h: 1, radius: px / 2, rotation: 0, soft: false, guess: "off" };
  return (wx, wy) => {
    st.cx = wx;
    st.cy = wy;
    fillRows(one, st, 0, 1);
    return one;
  };
}

/**
 * Adds four more samples to every pixel whose neighbors land in a different
 * band or on the other side of the set boundary. Flat areas keep their single
 * sample, so the pass costs a fraction of full supersampling. `base` holds
 * rows y0-1 .. y1 of the finished frame (clamped at the image edges).
 * Output: averaged iter/extra, a fractional band for the solid-band mode,
 * and `cover`, the share of escaping samples (0 = untouched pixel).
 */
export function refineRows(state, base, y0, y1) {
  const { w, h } = state;
  const rows = y1 - y0;
  const n = w * rows;
  const iter = new Float32Array(n);
  const extra = new Float32Array(n);
  const alpha = new Uint8Array(n);
  const band = new Float32Array(n);
  const cover = new Uint8Array(n);
  const sample = sampler(state);
  const rot = state.rotation || 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const aspect = w / h;
  const bi = base.iter;
  const ba = base.alpha;
  const bandOf = (k) => (ba[k] ? Math.floor(bi[k]) : -1);
  let refined = 0;
  for (let y = y0; y < y1; y += 1) {
    const by = (y - base.y0) * w;
    const up = y > 0 ? by - w : by;
    const down = y < h - 1 ? by + w : by;
    const ny = 1 - ((y + 0.5) / h) * 2;
    for (let x = 0; x < w; x += 1) {
      const k = by + x;
      const o = (y - y0) * w + x;
      const b0 = bandOf(k);
      iter[o] = bi[k];
      extra[o] = base.extra[k];
      alpha[o] = ba[k];
      band[o] = b0 < 0 ? 0 : b0;
      const edge =
        (x > 0 && bandOf(k - 1) !== b0) ||
        (x < w - 1 && bandOf(k + 1) !== b0) ||
        bandOf(up + x) !== b0 ||
        bandOf(down + x) !== b0;
      if (!edge) continue;
      refined += 1;
      let out = b0 < 0 ? 0 : 1;
      let sumI = out ? bi[k] : 0;
      let sumE = out ? base.extra[k] : 0;
      let sumB = out ? b0 : 0;
      const nx = ((x + 0.5) / w) * 2 - 1;
      for (const [ox, oy] of OFFSETS) {
        const px = (nx + (ox * 2) / w) * aspect * state.radius;
        const py = (ny - (oy * 2) / h) * state.radius;
        const s = sample(state.cx + px * cs - py * sn, state.cy + px * sn + py * cs);
        if (!s.alpha[0]) continue;
        out += 1;
        sumI += s.iter[0];
        sumE += s.extra[0];
        sumB += Math.floor(s.iter[0]);
      }
      if (out === 0) continue;
      iter[o] = sumI / out;
      extra[o] = sumE / out;
      band[o] = sumB / out;
      alpha[o] = 1;
      cover[o] = Math.max(1, Math.round((out / 5) * 255));
    }
  }
  return { iter, extra, alpha, band, cover, refined };
}
