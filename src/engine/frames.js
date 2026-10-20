/**
 * Self-similar fractals (Sierpinski triangle and carpet) are viewed through
 * a "frame": one lattice cell at the level whose size matches the screen,
 * named by its digits from the root. View coordinates are local to that cell,
 * so they never get small, and zoom has no floating-point floor.
 *
 * The triangle lattice is skewed: a cell is the rhombus spanned by
 * E1 = (1, 0) and E2 = (0.5, H). Its lower half is an upward sub-triangle of
 * the gasket hierarchy (or a hole), its upper half always lies in a hole.
 * A triangle digit is du + 2 * dv. The carpet lattice is plain squares in
 * base 3 with digits [a, b].
 *
 * frameInfo() classifies the 5x5 block of same-level cells around the frame,
 * which always covers the screen, so the kernel only iterates from the frame
 * level down to the pixel level and never touches larger triangles.
 */
export const H = 0.8660254037844386;

export const SPAN = 5;
export const REACH = 2;
export const GASKET = -2;
export const OUTSIDE = -1;

const SPEC = {
  tri: { scale: 2, down: 0.4, up: 1, e1: [1, 0], e2: [0.5, H] },
  square: { scale: 3, down: 0.3, up: 1.2, e1: [1, 0], e2: [0, 1] },
};

export function frameSpec(kind) {
  return SPEC[kind];
}

export function toLattice(kind, x, y) {
  if (kind === "tri") {
    const v = y / H;
    return [x - 0.5 * v, v];
  }
  return [x, y];
}

function fromLattice(kind, u, v) {
  const { e1, e2 } = SPEC[kind];
  return [u * e1[0] + v * e2[0], u * e1[1] + v * e2[1]];
}

function axes(kind, digits) {
  if (kind === "tri") return [digits.map((d) => d & 1), digits.map((d) => d >> 1)];
  return [digits.map((d) => d[0]), digits.map((d) => d[1])];
}

function join(kind, xs, ys) {
  if (kind === "tri") return xs.map((x, i) => x + 2 * ys[i]);
  return xs.map((x, i) => [x, ys[i]]);
}

/** The child cell holding (x, y), clamped so points just outside still pick one. */
export function childFor(kind, x, y) {
  const n = SPEC[kind].scale;
  const [u, v] = toLattice(kind, x, y);
  const a = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
  const b = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
  const digit = kind === "tri" ? a + 2 * b : [a, b];
  const [ox, oy] = childOffset(kind, digit);
  return { digit, ox, oy };
}

export function childOffset(kind, digit) {
  const n = SPEC[kind].scale;
  const [a, b] = kind === "tri" ? [digit & 1, digit >> 1] : digit;
  return fromLattice(kind, a / n, b / n);
}

function shiftAxis(col, delta, base) {
  const out = col.slice();
  let carry = delta;
  for (let i = out.length - 1; i >= 0 && carry !== 0; i -= 1) {
    const v = out[i] + carry;
    out[i] = ((v % base) + base) % base;
    carry = Math.floor(v / base);
  }
  return carry === 0 ? out : null;
}

/**
 * Moves the frame by whole cells at the same level. Returns the new digits
 * and the local offset of the new cell, or null when that leaves the root.
 */
export function shiftFrame(kind, digits, du, dv) {
  const base = SPEC[kind].scale;
  const [xs, ys] = axes(kind, digits);
  const nx = shiftAxis(xs, du, base);
  const ny = shiftAxis(ys, dv, base);
  if (!nx || !ny) return null;
  const [ox, oy] = fromLattice(kind, du, dv);
  return { digits: join(kind, nx, ny), ox, oy };
}

/**
 * One step toward the frame that fits the screen: shift sideways so the view
 * center is inside the frame cell, go up while the screen is larger than the
 * cell, go down while it is small enough that a child cell still fits it.
 * Past the root's edge the frame cannot follow the center; once the center
 * is a whole cell away the screen is all outside, so it stops descending.
 * `reach` is the distance from the view center to a screen corner. Returns
 * null when the frame already fits, otherwise the new digits and the map
 * new = (old - [ox, oy]) * S to apply to view coordinates.
 */
export function renormStep(kind, digits, cx, cy, reach) {
  const spec = SPEC[kind];
  const [u, v] = toLattice(kind, cx, cy);
  if (digits.length) {
    const du = Math.floor(u);
    const dv = Math.floor(v);
    for (const [su, sv] of [
      [du, 0],
      [0, dv],
    ]) {
      if (!su && !sv) continue;
      const moved = shiftFrame(kind, digits, su, sv);
      if (moved) return { digits: moved.digits, S: 1, ox: moved.ox, oy: moved.oy };
    }
    if (reach > spec.up) {
      const next = digits.slice(0, -1);
      const [ox, oy] = childOffset(kind, digits[digits.length - 1]);
      return { digits: next, S: 1 / spec.scale, ox: -ox * spec.scale, oy: -oy * spec.scale };
    }
  }
  const near = u >= -1 && v >= -1 && u < 2 && v < 2;
  if (reach < spec.down && near) {
    const child = childFor(kind, cx, cy);
    return { digits: [...digits, child.digit], S: spec.scale, ox: child.ox, oy: child.oy };
  }
  return null;
}

function toBig(col, base) {
  const b = BigInt(base);
  let out = 0n;
  for (const d of col) out = out * b + BigInt(d);
  return out;
}

function bitLength(n) {
  return n === 0n ? 0 : n.toString(2).length;
}

/** Absolute hole depth of a cell at `level`, GASKET, or OUTSIDE. */
function triCell(X, Y, level, down) {
  const size = 1n << BigInt(level);
  if (X < 0n || Y < 0n || X >= size || Y >= size) return OUTSIDE;
  if (!down) {
    if (X + Y >= size) return OUTSIDE;
    const carry = (X + Y) ^ X ^ Y;
    return carry === 0n ? GASKET : level - bitLength(carry);
  }
  if (X + Y + 2n > size) return OUTSIDE;
  const x = 2n * X + 1n;
  const y = 2n * Y + 1n;
  return level + 1 - bitLength((x + y) ^ x ^ y);
}

function squareCell(X, Y, level) {
  const size = 3n ** BigInt(level);
  if (X < 0n || Y < 0n || X >= size || Y >= size) return OUTSIDE;
  const xs = X.toString(3).padStart(level, "0");
  const ys = Y.toString(3).padStart(level, "0");
  for (let i = 0; i < level; i += 1) {
    if (xs[i] === "1" && ys[i] === "1") return i;
  }
  return GASKET;
}

/** Everything the kernel needs to render around the frame. */
export function frameInfo(kind, digits) {
  if (!kind) return null;
  const depth = digits.length;
  const base = SPEC[kind].scale;
  const [xs, ys] = axes(kind, digits);
  const P = toBig(xs, base);
  const Q = toBig(ys, base);
  const halves = kind === "tri" ? 2 : 1;
  const cells = new Int32Array(SPAN * SPAN * halves);
  for (let a = -REACH; a <= REACH; a += 1) {
    for (let b = -REACH; b <= REACH; b += 1) {
      const X = P + BigInt(a);
      const Y = Q + BigInt(b);
      const at = ((a + REACH) * SPAN + (b + REACH)) * halves;
      if (kind === "tri") {
        cells[at] = triCell(X, Y, depth, false);
        cells[at + 1] = triCell(X, Y, depth, true);
      } else {
        cells[at] = squareCell(X, Y, depth);
      }
    }
  }
  let rx = 0;
  let ry = 0;
  let scale = 1;
  for (const d of digits) {
    scale /= base;
    const [ox, oy] = childOffset(kind, d);
    rx += ox * scale * base;
    ry += oy * scale * base;
  }
  return { kind, depth, cells, root: [rx, ry, scale] };
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

function closestOnPolygon(x, y, pts) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const p = closestOnSegment(x, y, ax, ay, bx, by);
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return [best, bestD];
}

function cellShape(kind, a, b) {
  if (kind === "tri") return [fromLattice(kind, a, b), fromLattice(kind, a + 1, b), fromLattice(kind, a, b + 1)];
  return [[a, b], [a + 1, b], [a + 1, b + 1], [a, b + 1]];
}

/** The hole within the next two levels of a gasket cell that holds (u, v), as a polygon. */
function holeInside(kind, a, b, u, v) {
  let fu = u - a;
  let fv = v - b;
  let ou = a;
  let ov = b;
  let size = 1;
  const n = SPEC[kind].scale;
  for (let i = 0; i < 2; i += 1) {
    const cu = Math.min(n - 1, Math.floor(fu * n));
    const cv = Math.min(n - 1, Math.floor(fv * n));
    const s = size / n;
    if (kind === "tri") {
      if (cu === 0 && cv === 0 && fu + fv >= 0.5) {
        return [fromLattice(kind, ou + s, ov), fromLattice(kind, ou + s, ov + s), fromLattice(kind, ou, ov + s)];
      }
    } else if (cu === 1 && cv === 1) {
      return cellShape(kind, 0, 0).map(([x, y]) => [ou + s + x * s, ov + s + y * s]);
    }
    fu = fu * n - cu;
    fv = fv * n - cv;
    ou += cu * s;
    ov += cv * s;
    size = s;
  }
  return null;
}

/**
 * The nearest point on the fractal when the view center sits in a hole about
 * the size of the screen, or null when it is already on structure. Zooming
 * leans toward this point so the view keeps landing on detail.
 */
export function anchorPoint(info, x, y) {
  if (!info) return null;
  const { kind, cells } = info;
  const halves = kind === "tri" ? 2 : 1;
  const [u, v] = toLattice(kind, x, y);
  const a = Math.floor(u);
  const b = Math.floor(v);
  const down = kind === "tri" && u - a + (v - b) >= 1;
  const inBlock = Math.abs(a) <= REACH && Math.abs(b) <= REACH;
  const at = ((a + REACH) * SPAN + (b + REACH)) * halves + (down ? 1 : 0);
  if (inBlock && cells[at] === GASKET) {
    const hole = holeInside(kind, a, b, u, v);
    return hole ? closestOnPolygon(x, y, hole)[0] : null;
  }
  let best = null;
  let bestD = 2.25;
  for (let i = -REACH; i <= REACH; i += 1) {
    for (let j = -REACH; j <= REACH; j += 1) {
      if (cells[((i + REACH) * SPAN + (j + REACH)) * halves] !== GASKET) continue;
      const [p, d] = closestOnPolygon(x, y, cellShape(kind, i, j));
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}
