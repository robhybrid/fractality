export function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

export function smoothDamp(current, target, vel, smoothTime, dt, maxSpeed = Infinity) {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * st;
  change = clamp(change, -maxChange, maxChange);
  const temp = (vel + omega * change) * dt;
  const newVel = (vel - omega * temp) * exp;
  let next = target + (change + temp) * exp;
  if (target - current > 0 === next > target) {
    return [target, 0];
  }
  return [next, newVel];
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function toLin(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function toSrgb(x) {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  return clamp(Math.round(c * 255), 0, 255);
}

function sample(stops, t) {
  if (!stops.length) return [0, 0, 0];
  if (t <= stops[0].t) return hexToRgb(stops[0].color);
  if (t >= stops[stops.length - 1].t) return hexToRgb(stops[stops.length - 1].color);
  let i = 1;
  while (i < stops.length && stops[i].t < t) i += 1;
  const a = stops[i - 1];
  const b = stops[i];
  const span = Math.max(1e-6, b.t - a.t);
  const u = (t - a.t) / span;
  const ca = hexToRgb(a.color).map(toLin);
  const cb = hexToRgb(b.color).map(toLin);
  return ca.map((v, k) => toSrgb(v + (cb[k] - v) * u));
}

export function rasterize(stops, size = 256) {
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i += 1) {
    const [r, g, b] = sample(sorted, i / (size - 1));
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

export function cssGradient(stops) {
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  return `linear-gradient(90deg, ${sorted.map((s) => `${s.color} ${Math.round(s.t * 100)}%`).join(", ")})`;
}

export function shiftHue(hex, degrees) {
  let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  h = (h + degrees + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rr = 0;
  let gg = 0;
  let bb = 0;
  if (hp < 1) [rr, gg, bb] = [c, x, 0];
  else if (hp < 2) [rr, gg, bb] = [x, c, 0];
  else if (hp < 3) [rr, gg, bb] = [0, c, x];
  else if (hp < 4) [rr, gg, bb] = [0, x, c];
  else if (hp < 5) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  const m = l - c / 2;
  return rgbToHex((rr + m) * 255, (gg + m) * 255, (bb + m) * 255);
}

export function randomPalette() {
  const n = 3 + Math.floor(Math.random() * 3);
  const hue = Math.random() * 360;
  const stops = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const h = (hue + i * (40 + Math.random() * 50)) % 360;
    const l = 8 + (i % 2 === 0 ? 10 : 55 + Math.random() * 25);
    stops.push({ t, color: hslHex(h, 70, l) });
  }
  stops[stops.length - 1].color = stops[0].color;
  return stops;
}

function hslHex(h, s, l) {
  const sv = s / 100;
  const lv = l / 100;
  const c = (1 - Math.abs(2 * lv - 1)) * sv;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lv - c / 2;
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

export function fitSize(w, h, maxArea) {
  const area = Math.max(1, w * h);
  const scale = area > maxArea ? Math.sqrt(maxArea / area) : 1;
  let rw = Math.max(2, Math.round(w * scale));
  let rh = Math.max(2, Math.round(h * scale));
  rw -= rw % 2;
  rh -= rh % 2;
  return [Math.max(2, rw), Math.max(2, rh)];
}
