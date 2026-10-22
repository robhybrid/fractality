import { H, REACH, SPAN, GASKET, OUTSIDE, frameInfo } from "./frames.js";

const NS = "http://www.w3.org/2000/svg";
const LEVEL_TONE = 3;
const MIN_PX = 2.0;
const MAX_TRIS = 12000;

function sampleStops(stops, t) {
  if (!stops?.length) return [140, 180, 200];
  const u = ((t % 1) + 1) % 1;
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t < u) i += 1;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  const span = Math.max(1e-6, b.t - a.t);
  const f = Math.min(1, Math.max(0, (u - a.t) / span));
  const ca = hexRgb(a.color);
  const cb = hexRgb(b.color);
  return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
}

function hexRgb(hex) {
  const h = (hex || "#888").replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function rgb(c, gain = 1) {
  const k = 255 * gain;
  return `rgb(${(c[0] * k) | 0},${(c[1] * k) | 0},${(c[2] * k) | 0})`;
}

function toneColor(stops, phase, density, tone, gain) {
  return rgb(sampleStops(stops, phase + tone * density), gain);
}

function mapper(state) {
  const w = state.cssW;
  const h = state.cssH;
  const aspect = w / h;
  const c = Math.cos(state.rotation || 0);
  const s = Math.sin(state.rotation || 0);
  const { cx, cy, radius } = state;
  return (wx, wy) => {
    const dx = wx - cx;
    const dy = wy - cy;
    const qx = dx * c + dy * s;
    const qy = -dx * s + dy * c;
    return [(qx / (aspect * radius) + 1) * 0.5 * w, (1 - qy / radius) * 0.5 * h];
  };
}

function bounds(pts, map) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    const [sx, sy] = map(x, y);
    if (sx < minX) minX = sx;
    if (sy < minY) minY = sy;
    if (sx > maxX) maxX = sx;
    if (sy > maxY) maxY = sy;
  }
  return { minX, minY, maxX, maxY, size: Math.hypot(maxX - minX, maxY - minY) };
}

function onScreen(b, w, h, pad = 40) {
  return b.maxX >= -pad && b.minX <= w + pad && b.maxY >= -pad && b.minY <= h + pad;
}

function poly(pts, map) {
  return pts.map(([x, y]) => map(x, y).map((v) => v.toFixed(2)).join(",")).join(" ");
}

function fromLat(u, v) {
  return [u + 0.5 * v, v * H];
}

/**
 * Geometric shapes as crisp SVG. Recurses only while a piece is larger than a
 * pixel on screen, so deep zoom adds triangles instead of re-rasterizing a
 * bitmap. Koch curves are polylines; kaleidoscope stays on the pixel path.
 */
export function paintVector(svg, state, stops) {
  if (!svg) return;
  const w = state.cssW;
  const h = state.cssH;
  const gain = (state.exposure || 1) * (1 + 0.2 * (state.beat || 0));
  const phase = state.phase || 0;
  const density = state.density ?? 0.085;
  const bg = rgb(sampleStops(stops, phase + 0.62).map((v) => v / 255), gain * 0.22);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.display = "block";
  const parts = [`<rect width="100%" height="100%" fill="${bg}"/>`];
  const map = mapper(state);
  const ctx = { parts, map, stops, phase, density, gain, count: 0, w, h };
  const f = state.formula | 0;
  if (f === 12) paintTri(ctx, state);
  else if (f === 13) paintCarpet(ctx, state);
  else if (f === 14) paintKoch(ctx, state, false);
  else if (f === 15) paintKoch(ctx, state, true);
  svg.innerHTML = parts.join("");
}

export function clearVector(svg) {
  if (!svg) return;
  svg.style.display = "none";
  svg.innerHTML = "";
}

export function isVectorShape(fractal) {
  const f = fractal?.formula | 0;
  return fractal?.family === "shape" && f >= 12 && f <= 15;
}

function emitTri(ctx, pts, tone) {
  if (ctx.count >= MAX_TRIS) return;
  ctx.count += 1;
  const fill = toneColor(ctx.stops, ctx.phase, ctx.density, tone, ctx.gain);
  ctx.parts.push(`<polygon points="${poly(pts, ctx.map)}" fill="${fill}"/>`);
}

function emitLace(ctx, pts) {
  if (ctx.count >= MAX_TRIS) return;
  ctx.count += 1;
  const fill = rgb([0.02, 0.022, 0.03], ctx.gain);
  ctx.parts.push(`<polygon points="${poly(pts, ctx.map)}" fill="${fill}"/>`);
}

/** Largest pieces first so the screen fills with real structure before the triangle budget runs out. */
function subdivideTri(ctx, root, frameDepth, maxDepth) {
  const queue = [{ pts: root, depth: 0, abs: frameDepth, size: bounds(root, ctx.map).size }];
  while (queue.length && ctx.count < MAX_TRIS) {
    queue.sort((a, b) => b.size - a.size);
    const item = queue.shift();
    const b = bounds(item.pts, ctx.map);
    if (!onScreen(b, ctx.w, ctx.h)) continue;
    if (item.depth >= maxDepth || b.size < MIN_PX) {
      emitLace(ctx, item.pts);
      continue;
    }
    const [a, b0, c] = item.pts;
    const ab = [(a[0] + b0[0]) * 0.5, (a[1] + b0[1]) * 0.5];
    const bc = [(b0[0] + c[0]) * 0.5, (b0[1] + c[1]) * 0.5];
    const ca = [(c[0] + a[0]) * 0.5, (c[1] + a[1]) * 0.5];
    emitTri(ctx, [ab, bc, ca], (item.abs + 1) * LEVEL_TONE);
    for (const pts of [[a, ab, ca], [ab, b0, bc], [ca, bc, c]]) {
      const bb = bounds(pts, ctx.map);
      if (onScreen(bb, ctx.w, ctx.h)) queue.push({ pts, depth: item.depth + 1, abs: item.abs + 1, size: bb.size });
    }
  }
  for (const item of queue) {
    if (ctx.count >= MAX_TRIS) break;
    if (onScreen(bounds(item.pts, ctx.map), ctx.w, ctx.h)) emitLace(ctx, item.pts);
  }
}

function paintTri(ctx, state) {
  const frame = state.frame && state.frame.kind === "tri" ? state.frame : frameInfo("tri", []);
  const cells = frame.cells;
  const px = (2 * state.radius) / Math.max(1, state.cssH);
  const maxDepth = Math.max(2, Math.min(11, Math.ceil(Math.log2(1 / Math.max(px, 1e-12))) + 1));
  for (let a = -REACH; a <= REACH; a += 1) {
    for (let b = -REACH; b <= REACH; b += 1) {
      const at = ((a + REACH) * SPAN + (b + REACH)) * 2;
      const low = cells[at];
      const up = cells[at + 1];
      const base = [fromLat(a, b), fromLat(a + 1, b), fromLat(a, b + 1)];
      const upper = [fromLat(a + 1, b), fromLat(a + 1, b + 1), fromLat(a, b + 1)];
      paintTriCell(ctx, base, low, frame.depth, maxDepth);
      paintTriCell(ctx, upper, up, frame.depth, maxDepth);
    }
  }
}

function paintTriCell(ctx, pts, cell, frameDepth, maxDepth) {
  if (cell === OUTSIDE) return;
  const b = bounds(pts, ctx.map);
  if (!onScreen(b, ctx.w, ctx.h)) return;
  if (cell === GASKET) {
    subdivideTri(ctx, pts, frameDepth, maxDepth);
    return;
  }
  if (cell >= 0) emitTri(ctx, pts, cell * LEVEL_TONE);
}

function subdivideCarpet(ctx, x, y, s, depth, absDepth, maxDepth) {
  if (ctx.count >= MAX_TRIS) return;
  const pts = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const b = bounds(pts, ctx.map);
  if (!onScreen(b, ctx.w, ctx.h)) return;
  if (depth >= maxDepth || b.size < MIN_PX) {
    emitLace(ctx, pts);
    return;
  }
  const t = s / 3;
  emitTri(ctx, [[x + t, y + t], [x + 2 * t, y + t], [x + 2 * t, y + 2 * t], [x + t, y + 2 * t]], (absDepth + 1) * LEVEL_TONE);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (i === 1 && j === 1) continue;
      subdivideCarpet(ctx, x + i * t, y + j * t, t, depth + 1, absDepth + 1, maxDepth);
    }
  }
}

function paintCarpet(ctx, state) {
  const frame = state.frame && state.frame.kind === "square" ? state.frame : frameInfo("square", []);
  const cells = frame.cells;
  const px = (2 * state.radius) / Math.max(1, state.cssH);
  const maxDepth = Math.max(2, Math.min(10, Math.ceil(Math.log(1 / Math.max(px, 1e-12)) / Math.log(3)) + 2));
  for (let a = -REACH; a <= REACH; a += 1) {
    for (let b = -REACH; b <= REACH; b += 1) {
      const cell = cells[(a + REACH) * SPAN + (b + REACH)];
      if (cell === OUTSIDE) continue;
      if (cell === GASKET) subdivideCarpet(ctx, a, b, 1, 0, frame.depth, maxDepth);
      else if (cell >= 0) emitTri(ctx, [[a, b], [a + 1, b], [a + 1, b + 1], [a, b + 1]], cell * LEVEL_TONE);
    }
  }
}

function kochSegment(ax, ay, bx, by, depth, out) {
  if (depth <= 0) {
    out.push([bx, by]);
    return;
  }
  const dx = bx - ax;
  const dy = by - ay;
  const x1 = ax + dx / 3;
  const y1 = ay + dy / 3;
  const x2 = ax + (2 * dx) / 3;
  const y2 = ay + (2 * dy) / 3;
  const mx = (ax + bx) * 0.5;
  const my = (ay + by) * 0.5;
  const px = mx - dy * (Math.sqrt(3) / 6);
  const py = my + dx * (Math.sqrt(3) / 6);
  kochSegment(ax, ay, x1, y1, depth - 1, out);
  kochSegment(x1, y1, px, py, depth - 1, out);
  kochSegment(px, py, x2, y2, depth - 1, out);
  kochSegment(x2, y2, bx, by, depth - 1, out);
}

function paintKoch(ctx, state, snowflake) {
  const px = (2 * state.radius) / Math.max(1, state.cssH);
  const depth = Math.max(1, Math.min(8, Math.ceil(Math.log(1 / Math.max(px, 1e-6)) / Math.log(3))));
  const stroke = toneColor(ctx.stops, ctx.phase, ctx.density, 12, ctx.gain);
  const width = Math.max(1.2, Math.min(3.5, 2.2 * (state.cssH / 900)));
  const edges = snowflake
    ? [
        [-0.8, -0.5, 0.8, -0.5],
        [0.8, -0.5, 0, 0.9],
        [0, 0.9, -0.8, -0.5],
      ]
    : [[-1, 0, 1, 0]];
  for (const [ax, ay, bx, by] of edges) {
    const pts = [[ax, ay]];
    kochSegment(ax, ay, bx, by, depth, pts);
    const d = pts.map((p, i) => {
      const [sx, sy] = ctx.map(p[0], p[1]);
      return `${i ? "L" : "M"}${sx.toFixed(2)},${sy.toFixed(2)}`;
    }).join("");
    ctx.parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
}

/** Rasterize the current vector view into a canvas for movie export / capture. */
export function rasterizeVector(state, stops, canvas) {
  const w = state.cssW;
  const h = state.cssH;
  const svg = document.createElementNS(NS, "svg");
  paintVector(svg, state, stops);
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#07080c";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(ctx.getImageData(0, 0, w, h));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG rasterize failed"));
    };
    img.src = url;
  });
}
