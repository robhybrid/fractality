import { BUDGET } from "../budget.js";
import { bigDiff, bigFromDouble, putOrbit, rebits } from "./deep.js";

/**
 * Keeps one reference orbit for deep views, computed in its own worker so
 * the display keeps reprojecting the last frame meanwhile. An orbit stays in
 * use while its precision covers the zoom and its point is near the view;
 * a replacement is fetched in the background before either runs out.
 */
export class DeepReference {
  constructor(onOrbit) {
    this.onOrbit = onOrbit;
    this.current = null;
    this.pending = null;
    this.seq = 0;
    this.hint = null;
    this.worker = new Worker(new URL("./orbitWorker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => this.receive(event.data);
  }

  matches(orbit, s) {
    if (orbit.formula !== (s.formula | 0)) return false;
    return orbit.formula !== 1 || (orbit.jre === s.juliaRe && orbit.jim === s.juliaIm);
  }

  /** Returns what the kernel needs for this view, or null while no usable orbit exists. */
  prepare(s) {
    const depth = Math.ceil(-Math.log2(s.radius));
    const cur = this.current;
    let desc = null;
    let refresh = true;
    if (cur && this.matches(cur, s) && cur.bits >= depth + 40) {
      const ox = bigDiff(s.deep.ax, s.deep.bits, cur.x, cur.bits);
      const oy = bigDiff(s.deep.ay, s.deep.bits, cur.y, cur.bits);
      const dist = Math.hypot(ox + s.cx, oy + s.cy);
      const aspect = Math.max(1, (s.cssW || 1) / (s.cssH || 1));
      if (dist < s.radius * 1e6) desc = { id: cur.id, critId: cur.critId, ox, oy };
      refresh = cur.bits < depth + 64 || dist > 1.5 * aspect * s.radius || (!cur.escaped && cur.N <= s.iters);
      const hint = this.hint;
      if (hint && !hint.tried && hint.key === s.deep.key && cur.N < Math.min(hint.n, s.iters) * 0.9) refresh = true;
    }
    if (refresh) this.request(s);
    return desc;
  }

  request(s) {
    if (this.pending) return;
    const depth = Math.ceil(-Math.log2(s.radius));
    const bits = depth + 112;
    let px = s.cx;
    let py = s.cy;
    const hint = this.hint;
    const aspect = Math.max(1, (s.cssW || 1) / (s.cssH || 1));
    if (hint && hint.key === s.deep.key && Math.hypot(hint.x - s.cx, hint.y - s.cy) < 1.2 * aspect * s.radius) {
      px = hint.x;
      py = hint.y;
      hint.tried = true;
    }
    const x = rebits(s.deep.ax, s.deep.bits, bits) + bigFromDouble(px, bits);
    const y = rebits(s.deep.ay, s.deep.bits, bits) + bigFromDouble(py, bits);
    const julia = (s.formula | 0) === 1;
    const id = ++this.seq * 2;
    const maxIter = Math.min(BUDGET.maxDeepIter * 2, Math.max(2000, (s.iters | 0) * 2));
    this.pending = { id, critId: julia ? id + 1 : 0, x, y, bits, formula: s.formula | 0, jre: s.juliaRe, jim: s.juliaIm, maxIter };
    this.worker.postMessage({ id, x, y, bits, maxIter, julia, jre: s.juliaRe, jim: s.juliaIm });
  }

  receive(msg) {
    const job = this.pending;
    this.pending = null;
    if (!job || job.id !== msg.id) return;
    putOrbit(job.id, msg.Z, msg.N);
    if (job.critId) putOrbit(job.critId, msg.C, msg.CN);
    this.current = { ...job, N: msg.N, escaped: msg.escaped, ms: msg.ms };
    this.onOrbit(job, msg);
  }

  /** The slowest pixel of the last frame (n iterations), relative to the anchor named by key. */
  setHint(key, x, y, n) {
    const old = this.hint;
    const same = old && old.key === key && old.x === x && old.y === y;
    this.hint = { key, x, y, n, tried: same ? old.tried : false };
  }

  shift(dx, dy) {
    if (!this.hint) return;
    this.hint.x -= dx;
    this.hint.y -= dy;
  }

  destroy() {
    this.worker.terminate();
  }
}
