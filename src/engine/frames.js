/**
 * Self-similar fractals (Sierpinski triangle and carpet) are viewed through
 * a "frame": the sub-triangle or sub-square the view is inside, named by its
 * digits from the root. View coordinates are local to that frame, so they
 * never get small, and zoom has no floating-point floor.
 */
export const H = 0.8660254037844386;
const TRI = [
  [0, 0],
  [1, 0],
  [0.5, H],
];

const SPEC = {
  tri: { scale: 2, down: 0.1, up: 0.45 },
  square: { scale: 3, down: 0.07, up: 0.4 },
};

export function frameSpec(kind) {
  return SPEC[kind];
}

function triBary(x, y) {
  const gz = y / H;
  const gy = x - 0.5 * gz;
  return [1 - gy - gz, gy, gz];
}

/** Returns the child digit to descend into and its offset, or null to stay. */
export function pickChild(kind, x, y) {
  if (kind === "tri") {
    const g = triBary(x, y);
    if (Math.min(g[0], g[1], g[2]) < -0.35) return null;
    let k = 0;
    if (g[1] > g[k]) k = 1;
    if (g[2] > g[k]) k = 2;
    return { digit: k, ox: TRI[k][0] * 0.5, oy: TRI[k][1] * 0.5 };
  }
  if (x < -0.35 || y < -0.35 || x > 1.35 || y > 1.35) return null;
  let a = Math.min(2, Math.max(0, Math.floor(x * 3)));
  let b = Math.min(2, Math.max(0, Math.floor(y * 3)));
  if (a === 1 && b === 1) {
    const u = x * 3 - 1.5;
    const v = y * 3 - 1.5;
    if (Math.abs(u) > Math.abs(v)) a = u < 0 ? 0 : 2;
    else b = v < 0 ? 0 : 2;
  }
  return { digit: [a, b], ox: a / 3, oy: b / 3 };
}

export function childOffset(kind, digit) {
  if (kind === "tri") return [TRI[digit][0] * 0.5, TRI[digit][1] * 0.5];
  return [digit[0] / 3, digit[1] / 3];
}

/** Precomputed neighbor data the kernel needs for pixels outside the frame. */
export function frameInfo(kind, digits) {
  if (!kind) return null;
  const depth = digits.length;
  if (kind === "tri") {
    const offsets = [0, 1, 2].map((j) => {
      for (let i = depth - 1; i >= 0; i -= 1) {
        const k = digits[i];
        if (k !== j) return [TRI[j][0] - TRI[k][0], TRI[j][1] - TRI[k][1]];
      }
      return null;
    });
    const up = digits.slice(Math.max(0, depth - 48)).reverse();
    return { kind, depth, offsets, up };
  }
  const nb = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) nb.push(squareNeighbor(digits, dx, dy));
  }
  return { kind, depth, nb };
}

function shiftDigits(col, delta) {
  const out = col.slice();
  let carry = delta;
  for (let i = out.length - 1; i >= 0 && carry !== 0; i -= 1) {
    let v = out[i] + carry;
    carry = 0;
    if (v < 0) {
      v += 3;
      carry = -1;
    } else if (v > 2) {
      v -= 3;
      carry = 1;
    }
    out[i] = v;
  }
  return carry === 0 ? out : null;
}

function squareNeighbor(digits, dx, dy) {
  if (dx === 0 && dy === 0) return [2, 0];
  const xs = shiftDigits(digits.map((d) => d[0]), dx);
  const ys = shiftDigits(digits.map((d) => d[1]), dy);
  if (!xs || !ys) return [0, 0];
  for (let i = 0; i < xs.length; i += 1) {
    if (xs[i] === 1 && ys[i] === 1) return [1, i];
  }
  return [2, 0];
}

export function frameKey(digits) {
  let hash = 2166136261;
  for (const d of digits) {
    const v = Array.isArray(d) ? d[0] * 3 + d[1] : d;
    hash = Math.imul(hash ^ (v + 1), 16777619) >>> 0;
  }
  return `${digits.length}:${hash.toString(36)}`;
}

function closestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return [ax + dx * t, ay + dy * t];
}

/**
 * The nearest point of the child piece the view would descend into, or null
 * when the point is already on it. Zooming leans toward this point so the
 * view keeps landing on structure instead of an empty hole.
 */
export function anchorPoint(kind, x, y) {
  const child = pickChild(kind, x, y);
  if (!child) return null;
  if (kind === "square") {
    const cx = Math.min(child.ox + 1 / 3, Math.max(child.ox, x));
    const cy = Math.min(child.oy + 1 / 3, Math.max(child.oy, y));
    return cx === x && cy === y ? null : [cx, cy];
  }
  const v = TRI.map(([a, b]) => [child.ox + a * 0.5, child.oy + b * 0.5]);
  const g = triBary((x - child.ox) * 2, (y - child.oy) * 2);
  if (g[0] >= 0 && g[1] >= 0 && g[2] >= 0) return null;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const [ax, ay] = v[i];
    const [bx, by] = v[(i + 1) % 3];
    const p = closestOnSegment(x, y, ax, ay, bx, by);
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
