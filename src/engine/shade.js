export const LUT_SIZE = 1024;
const LEVELS = 80;
const STRIPE_MIX = 0.72 / 15;

function mixPalette(palA, palB, mix) {
  const out = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = palA[i * 4 + k];
      const b = palB[i * 4 + k];
      out[i * 3 + k] = (a + (b - a) * mix) / 255;
    }
  }
  return out;
}

function sample(pal, t, out) {
  const u = t - Math.floor(t);
  const x = u * 255;
  const i = x | 0;
  const f = x - i;
  const j = (i + 1) & 255;
  out[0] = pal[i * 3] + (pal[j * 3] - pal[i * 3]) * f;
  out[1] = pal[i * 3 + 1] + (pal[j * 3 + 1] - pal[i * 3 + 1]) * f;
  out[2] = pal[i * 3 + 2] + (pal[j * 3 + 2] - pal[i * 3 + 2]) * f;
  return out;
}

function pack(r, g, b) {
  const R = r <= 0 ? 0 : r >= 255 ? 255 : r | 0;
  const G = g <= 0 ? 0 : g >= 255 ? 255 : g | 0;
  const B = b <= 0 ? 0 : b >= 255 ? 255 : b | 0;
  return (0xff000000 | (B << 16) | (G << 8) | R) >>> 0;
}

/**
 * Bakes palette, stripe mix, edge glow, prism shift, exposure and beat into
 * one table. Painting a frame is then a single lookup per pixel.
 */
export function buildLut({ palA, palB, mix, post, edge, gain }) {
  const lut = new Uint32Array(LEVELS * LUT_SIZE);
  const pal = mixPalette(palA, palB, mix);
  const c1 = [0, 0, 0];
  const c2 = [0, 0, 0];
  const ce = [0, 0, 0];
  const pr = [0, 0, 0];
  const tmp = [0, 0, 0];
  const edgeAmt = post === 0 ? 0 : edge;
  const k = gain * 255;
  for (let j = 0; j < LUT_SIZE; j += 1) {
    const t = j / LUT_SIZE;
    sample(pal, t, c1);
    sample(pal, t + 0.16, c2);
    sample(pal, t + 0.05, ce);
    if (post === 2) {
      pr[0] = sample(pal, t - 0.012, tmp)[0];
      pr[1] = c1[1];
      pr[2] = sample(pal, t + 0.014, tmp)[2];
    }
    for (let m = 0; m < 16; m += 1) {
      const mm = m * STRIPE_MIX;
      const br = c1[0] + (c2[0] - c1[0]) * mm;
      const bg = c1[1] + (c2[1] - c1[1]) * mm;
      const bb = c1[2] + (c2[2] - c1[2]) * mm;
      for (let el = 0; el < 4; el += 1) {
        const e = (el / 3) * edgeAmt;
        let r = br + ce[0] * e;
        let g = bg + ce[1] * e;
        let b = bb + ce[2] * e;
        if (post === 2) {
          r = r * 0.3 + pr[0] * 0.7;
          g = g * 0.3 + pr[1] * 0.7;
          b = b * 0.3 + pr[2] * 0.7;
        }
        lut[(el * 16 + m) * LUT_SIZE + j] = pack(r * k, g * k, b * k);
      }
    }
    for (let l = 0; l < 16; l += 1) {
      const s = (l / 15) * k;
      lut[(64 + l) * LUT_SIZE + j] = pack(c1[0] * s, c1[1] * s, c1[2] * s);
    }
  }
  return { lut, pal };
}

export function interiorColor(pal, phase, colorInterior, gain) {
  if (!colorInterior) return pack(0.012 * 255 * gain, 0.013 * 255 * gain, 0.02 * 255 * gain);
  const c = sample(pal, phase * 0.22, [0, 0, 0]);
  const k = 0.32 * 255 * gain;
  return pack(c[0] * k, c[1] * k, c[2] * k);
}

/** Color modes: 0 solid band per iteration, 1 bands blended smoothly, 2 gradient with stripes and edges. */
export function paint(buf, out32, lut, phase, density, interior, mode = 0) {
  const { iter, alpha, level } = buf;
  const n = iter.length;
  const ph = (phase - Math.floor(phase)) * LUT_SIZE;
  const dens = (buf.source === 1 ? 0.18 + density * 6 : density) * LUT_SIZE;
  const mask = LUT_SIZE - 1;
  if (mode === 0 && buf.source !== 1) {
    for (let i = 0; i < n; i += 1) {
      if (alpha[i] === 0) out32[i] = interior;
      else out32[i] = lut[((Math.floor(iter[i]) * dens + ph) | 0) & mask];
    }
    return;
  }
  if (mode === 1 && buf.source !== 1) {
    for (let i = 0; i < n; i += 1) {
      if (alpha[i] === 0) out32[i] = interior;
      else out32[i] = lut[((iter[i] * dens + ph) | 0) & mask];
    }
    return;
  }
  for (let i = 0; i < n; i += 1) {
    if (alpha[i] === 0) {
      out32[i] = interior;
    } else {
      const idx = ((iter[i] * dens + ph) | 0) & mask;
      out32[i] = lut[(level[i] << 10) | idx];
    }
  }
}
