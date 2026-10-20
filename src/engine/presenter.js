import { BUDGET } from "../budget.js";
import { antialiasEligible } from "./antialias.js";
import { fitSize } from "./color.js";
import { applyDistance, paintDistance, storeDistance } from "./distance.js";
import { createBuffer, fillAll, fillRows, shadeLevels } from "./kernel.js";
import { buildLut, interiorColor, paint } from "./shade.js";

function q(n, places) {
  return Math.round(n * 10 ** places);
}

function paramKey(s) {
  return [
    s.family,
    s.formula,
    q(s.power, 4),
    q(s.bailout, 2),
    q(s.juliaRe || 0, 6),
    q(s.juliaIm || 0, 6),
    q(s.extra || 0, 4),
    s.iters | 0,
    q(s.trap || 0, 3),
    s.skipInterior ? 1 : 0,
    s.dem ? (s.deKoebe ? 2 : 1) : 0,
    s.frameKey || "",
    s.family === "ray" ? `${s.camKey}:${s.steps}:${s.rayIters}` : "",
  ].join(":");
}

function geomKey(s) {
  if (s.family === "ray") return "";
  return `${s.cx}:${s.cy}:${s.radius}:${s.rotation || 0}`;
}

function gpuAgrees(gpu) {
  const probe = {
    family: "escape",
    formula: 0,
    cx: -0.75,
    cy: 0,
    radius: 1.35,
    rotation: 0,
    power: 2,
    bailout: 64,
    iters: 32,
    skipInterior: true,
    juliaRe: 0,
    juliaIm: 0,
    extra: 0,
    w: 32,
    h: 18,
  };
  const cpu = createBuffer(32, 18);
  const gpuBuf = createBuffer(32, 18);
  fillAll(cpu, probe);
  try {
    gpu.fill(gpuBuf, probe);
  } catch {
    return false;
  }
  let cpuIn = 0;
  let gpuIn = 0;
  for (let i = 0; i < 32 * 18; i += 1) {
    if (!cpu.alpha[i]) cpuIn += 1;
    if (!gpuBuf.alpha[i]) gpuIn += 1;
  }
  if (cpuIn < 8) return false;
  return Math.abs(cpuIn - gpuIn) <= cpuIn * 0.4;
}

function workerCount() {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(6, Math.floor(cores / 2)));
}

/**
 * Draws on a 2D canvas. Fractal values are computed by a pool of CPU
 * workers (or a WebGL1 pass when it compiles and agrees with the CPU), at
 * screen resolution once the view settles. While the view moves, the last
 * finished frame is shifted and scaled into place every display frame, so
 * motion stays smooth even when a new frame takes several display frames.
 */
export class Presenter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!this.ctx) throw new Error("This browser could not open a 2D canvas.");
    this.palA = new Uint8Array(256 * 4);
    this.palB = new Uint8Array(256 * 4);
    this.palVersion = 0;
    this.lutKey = "";
    this.lut = null;
    this.lutPal = null;
    this.paintKey = "";
    this.scratch = document.createElement("canvas");
    this.sctx = this.scratch.getContext("2d", { alpha: false });
    this.image = null;
    this.out32 = null;
    this.shown = null;
    this.job = null;
    this.gen = 0;
    this.lastJobSig = "";
    this.motionShare = 0.3;
    this.gpu = null;
    this.gpuState = "idle";
    this.glp = null;
    this.glpState = "idle";
    this.dead = false;
    this.workers = [];
    this.idle = [];
    try {
      const count = workerCount();
      for (let i = 0; i < count; i += 1) {
        const worker = new Worker(new URL("./fractalWorker.js", import.meta.url), { type: "module" });
        worker.onmessage = (event) => this.onChunk(worker, event.data);
        worker.onerror = () => this.dropWorkers();
        this.workers.push(worker);
        this.idle.push(worker);
      }
    } catch {
      this.dropWorkers();
    }
    this.label = this.cpuLabel();
  }

  cpuLabel() {
    return this.workers.length ? `CPU ×${this.workers.length}` : "CPU";
  }

  dropWorkers() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idle = [];
    if (this.job?.kind === "workers") {
      this.job.kind = "main";
      this.job.y = 0;
    }
    this.label = this.gpu ? "GPU" : "CPU";
  }

  uploadPalette(which, pixels) {
    (which === "b" ? this.palB : this.palA).set(pixels.subarray(0, 256 * 4));
    this.palVersion += 1;
  }

  displaySize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return fitSize(cssW * dpr, cssH * dpr, BUDGET.displayPixels);
  }

  targetSize(state, W, H) {
    const quality = Math.max(0.2, Math.min(1, state.quality ?? 1));
    let cap = BUDGET.maxPixels2d;
    if (state.family === "ray") cap = BUDGET.maxPixels3d;
    else if (state.family === "ifs") cap = BUDGET.maxPixelsIfs;
    const full = Math.min(W * H, cap) * quality;
    let area = full;
    if (state.soft) area = full * this.motionShare;
    else if (!this.settled && full > BUDGET.settlePixels * 1.5) area = BUDGET.settlePixels * quality;
    return fitSize(W, H, Math.max(64 * 36, area));
  }

  makeJob(state, w, h, sig) {
    const s = { ...state, w, h, camera: state.camera };
    if (s.family === "ifs") s.ifsPoints = Math.min(BUDGET.maxIfsPoints, Math.round(w * h * 0.9));
    const buf = createBuffer(w, h);
    buf.source = s.family === "ifs" ? 1 : 0;
    buf.level = new Uint8Array(w * h);
    return {
      sig,
      soft: !!state.soft,
      state: s,
      buf,
      view: { family: s.family, cx: s.cx, cy: s.cy, radius: s.radius, rotation: s.rotation || 0 },
      ident: `${s.family}:${s.formula}`,
      started: performance.now(),
      gen: ++this.gen,
      next: 0,
      remaining: 0,
      chunks: [],
      kind: "main",
      y: 0,
    };
  }

  gpuEligible(state, h) {
    if (!this.gpu || state.family !== "escape" || state.formula >= 8) return false;
    if (state.dem) return false;
    if ((state.iters | 0) > 48) return false;
    return (2 * state.radius) / h > 3e-6;
  }

  startJob(job) {
    this.job = job;
    this.lastJobSig = job.sig;
    const { w, h } = job.buf;
    if (!job.still && this.gpuEligible(job.state, h)) {
      try {
        const t0 = performance.now();
        this.gpu.fill(job.buf, job.state);
        shadeLevels(job.buf);
        const ms = performance.now() - t0;
        this.label = "GPU";
        this.finish(job);
        if (ms > 30 + (w * h) / 60000) this.disableGpu();
        return;
      } catch {
        this.disableGpu();
      }
    }
    const plan = this.tiles ? this.tiles.plan(this.tiles.gpu, job.state, h) : null;
    if (plan) {
      try {
        job.kind = "tiles";
        job.tiles = this.tiles.gpu.begin(job.buf, job.state, plan === "perturb" ? this.tiles.pickReference(job.state, job.state.iters) : null);
        this.label = `GPU tiles (${plan})`;
        return;
      } catch {
        this.tiles = null;
      }
    }
    this.label = this.cpuLabel();
    if (!this.workers.length) {
      job.kind = "main";
      return;
    }
    job.kind = "workers";
    if (job.state.family === "ifs") job.chunks = [[0, h]];
    else {
      const rows = Math.max(4, Math.ceil(h / (this.workers.length * 6)));
      for (let y = 0; y < h; y += rows) job.chunks.push([y, Math.min(h, y + rows)]);
    }
    job.remaining = job.chunks.length;
    while (this.idle.length && job.next < job.chunks.length) this.dispatch(this.idle.pop(), job);
  }

  dispatch(worker, job) {
    const [y0, y1] = job.chunks[job.next];
    job.next += 1;
    if (!job.base) {
      worker.postMessage({ gen: job.gen, y0, y1, state: job.state });
      return;
    }
    const { w, h } = job.buf;
    const b0 = Math.max(0, y0 - 1);
    const b1 = Math.min(h, y1 + 1);
    const src = job.base;
    const base = {
      y0: b0,
      iter: src.iter.slice(b0 * w, b1 * w),
      extra: src.extra.slice(b0 * w, b1 * w),
      alpha: src.alpha.slice(b0 * w, b1 * w),
    };
    const transfer = [base.iter.buffer, base.extra.buffer, base.alpha.buffer];
    if (src.dist) {
      base.dist = src.dist.slice(b0 * w, b1 * w);
      base.lit = src.lit.slice(b0 * w, b1 * w);
      transfer.push(base.dist.buffer, base.lit.buffer);
    }
    worker.postMessage({ gen: job.gen, y0, y1, state: job.state, base }, transfer);
  }

  /** Final pass once a frame has settled at full size: extra samples on band edges. */
  startAntialias() {
    const job = this.antialiasJob(this.shown);
    this.job = job;
    this.aaSig = job.sig;
    while (this.idle.length && job.next < job.chunks.length) this.dispatch(this.idle.pop(), job);
  }

  antialiasJob({ buf, view, ident, sig, state }) {
    const { w, h } = buf;
    const out = createBuffer(w, h);
    out.iter.set(buf.iter);
    out.extra.set(buf.extra);
    out.alpha.set(buf.alpha);
    out.level = buf.level;
    if (buf.dist) {
      out.dist = buf.dist.slice();
      out.lit = buf.lit.slice();
    }
    out.band = new Float32Array(w * h);
    out.cover = new Uint8Array(w * h);
    const job = {
      sig,
      soft: false,
      aa: true,
      state,
      buf: out,
      base: buf,
      view: { ...view },
      ident,
      started: performance.now(),
      gen: ++this.gen,
      next: 0,
      remaining: 0,
      chunks: [],
      kind: "workers",
    };
    const rows = Math.max(4, Math.ceil(h / (this.workers.length * 8)));
    for (let y = 0; y < h; y += rows) job.chunks.push([y, Math.min(h, y + rows)]);
    job.remaining = job.chunks.length;
    return job;
  }

  onChunk(worker, msg) {
    const job = this.job;
    if (!job || msg.gen !== job.gen || job.kind !== "workers") {
      this.idle.push(worker);
      if (job && job.kind === "workers" && job.next < job.chunks.length) this.dispatch(this.idle.pop(), job);
      return;
    }
    const off = msg.y0 * job.buf.w;
    job.buf.iter.set(msg.iter, off);
    job.buf.extra.set(msg.extra, off);
    job.buf.alpha.set(msg.alpha, off);
    storeDistance(job.buf, msg, off);
    if (msg.aa) {
      job.buf.band.set(msg.band, off);
      job.buf.cover.set(msg.cover, off);
    } else {
      job.buf.level.set(msg.level, off);
    }
    job.remaining -= 1;
    if (job.next < job.chunks.length) this.dispatch(worker, job);
    else this.idle.push(worker);
    if (job.remaining === 0) this.finish(job);
  }

  stepMain(job) {
    const t0 = performance.now();
    const { buf, state } = job;
    while (job.y < buf.h && performance.now() - t0 < 8) {
      const y1 = Math.min(buf.h, job.y + (state.family === "ifs" ? buf.h : 4));
      fillRows(buf, state, job.y, y1);
      job.y = y1;
    }
    if (job.y >= buf.h) {
      shadeLevels(buf);
      this.finish(job);
    }
  }

  finish(job) {
    if (this.job !== job) return;
    const ms = performance.now() - job.started;
    if (job.aa) {
      const partial = [];
      const { cover } = job.buf;
      for (let i = 0; i < cover.length; i += 1) if (cover[i] > 0 && cover[i] < 255) partial.push(i);
      job.buf.partial = Int32Array.from(partial);
    }
    if (job.still) {
      this.job = null;
      job.resolve(job.buf);
      return;
    }
    if (job.aa) {
      this.aaMs = ms;
    } else if (job.soft) {
      if (ms > 48) this.motionShare = Math.max(0.05, this.motionShare * 0.8);
      else if (ms < 24) this.motionShare = Math.min(1, this.motionShare * 1.12);
    } else {
      this.settled = true;
    }
    this.job = null;
    this.show(job.buf, job.view, job.ident, job.sig, job.state);
  }

  show(buf, view, ident, sig, state) {
    this.serial = (this.serial || 0) + 1;
    this.shown = { buf, view, ident, sig, state, serial: this.serial };
    if (this.scratch.width !== buf.w || this.scratch.height !== buf.h) {
      this.scratch.width = buf.w;
      this.scratch.height = buf.h;
    }
    if (!this.image || this.image.width !== buf.w || this.image.height !== buf.h) {
      this.image = this.sctx.createImageData(buf.w, buf.h);
      this.out32 = new Uint32Array(this.image.data.buffer);
    }
    this.paintKey = "";
  }

  preview(state, W, H) {
    const area = state.family === "ray" ? 72 * 40 : 160 * 90;
    const [w, h] = fitSize(W, H, area);
    const job = this.makeJob({ ...state, soft: true }, w, h, "preview");
    fillAll(job.buf, job.state);
    shadeLevels(job.buf);
    this.show(job.buf, job.view, job.ident, "preview");
  }

  /**
   * A 2D canvas with the current picture. The GL overlay leaves the display
   * canvas unpainted, and a WebGL canvas cannot be read back after composite,
   * so thumbnails always recolor into the scratch buffer.
   */
  pictureCanvas() {
    if (!this.shown) return this.canvas;
    const state = this.lastState || {
      phase: 0,
      density: 0.085,
      exposure: 1,
      edge: 0,
      post: 1,
      palMix: 0,
      colorInterior: false,
      colorMode: 0,
      beat: 0,
      iters: this.shown.state?.iters || 48,
    };
    this.paintKey = "";
    this.colorize(state);
    return this.scratch.width ? this.scratch : this.canvas;
  }

  render(state) {
    this.lastState = state;
    const { cssW, cssH } = state;
    const [W, H] = this.displaySize(cssW, cssH);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.paintKey = "";
    }
    const ident = `${state.family}:${state.formula}`;
    if (!this.shown || this.shown.ident !== ident) {
      if (this.job) this.job = null;
      this.gen += 1;
      this.preview(state, W, H);
      this.lastJobSig = "";
    }
    if (state.soft) this.settled = false;
    if (this.job && state.soft && !this.job.soft) {
      this.job = null;
      this.gen += 1;
      this.lastJobSig = "";
    }
    const [w, h] = this.targetSize(state, W, H);
    const sig = `${paramKey(state)}|${geomKey(state)}|${w}x${h}`;
    if (this.job?.aa && sig !== this.job.sig) {
      this.job = null;
      this.gen += 1;
    }
    if (!this.job && sig !== this.lastJobSig) this.startJob(this.makeJob(state, w, h, sig));
    const shown = this.shown;
    if (!this.job && !state.soft && state.antialias !== false && this.workers.length && shown?.sig === sig && !shown.buf.cover && this.aaSig !== sig && antialiasEligible(shown.state)) {
      this.startAntialias();
    }
    if (this.job?.kind === "main") this.stepMain(this.job);
    else if (this.job?.kind === "tiles") this.stepTiles(this.job);
    this.draw(state, W, H);
    if (this.gpuState === "idle") this.armGpu();
    if (this.glpState === "idle") this.armGlPresent();
    if (this.tilesState === undefined) this.armTiles();
    const result = {
      pending: !!this.job,
      viewW: this.shown?.buf.w || 0,
      viewH: this.shown?.buf.h || 0,
      flip: false,
    };
    if (state.capture) {
      const pixels = this.ctx.getImageData(0, 0, W, H);
      result.pixels = pixels.data;
      result.w = W;
      result.h = H;
    }
    return result;
  }

  lutFor(state) {
    const gain = (state.exposure || 1) * (1 + 0.38 * (state.beat || 0));
    const lutKey = `${this.palVersion}:${q(state.palMix || 0, 3)}:${state.post}:${q(state.edge || 0, 3)}:${q(gain, 3)}`;
    if (lutKey !== this.lutKey) {
      const built = buildLut({ palA: this.palA, palB: this.palB, mix: state.palMix || 0, post: state.post | 0, edge: state.edge || 0, gain });
      this.lut = built.lut;
      this.lutPal = built.pal;
      this.lutKey = lutKey;
    }
    return { gain, lutKey };
  }

  colorize(state) {
    const { gain, lutKey } = this.lutFor(state);
    const phase = state.phase || 0;
    const shown = this.shown;
    const phaseStep = Math.floor((phase - Math.floor(phase)) * 1024);
    const key = `${shown.serial}:${lutKey}:${phaseStep}:${q(state.density, 5)}:${state.colorInterior ? 1 : 0}:${state.colorMode | 0}:${state.deShade || ""}`;
    if (key === this.paintKey) return;
    this.paintKey = key;
    const interior = interiorColor(this.lutPal, phase, state.colorInterior, gain);
    const density = state.density ?? 0.045;
    if (state.deShade === "distance" && shown.buf.dist) paintDistance(shown.buf, this.out32, this.lut, phase, density, interior);
    else {
      paint(shown.buf, this.out32, this.lut, phase, density, interior, state.colorMode | 0, shown.state?.iters || state.iters || 100);
      if (state.deShade && shown.buf.dist) applyDistance(shown.buf, this.out32, interior);
    }
    this.sctx.putImageData(this.image, 0, 0);
  }

  /** Buffer-pixel to screen-pixel affine [a, b, c, d, e, f], or null when it is one to one. */
  viewTransform(state, W, H) {
    const { buf, view } = this.shown;
    if (view.family === "ray" || state.family === "ray") {
      return buf.w === W && buf.h === H ? null : [W / buf.w, 0, 0, H / buf.h, 0, 0];
    }
    const map = this.mapper(view, buf.w, buf.h, state, W, H);
    const p00 = map(0, 0);
    const p10 = map(1, 0);
    const p01 = map(0, 1);
    const a = p10[0] - p00[0];
    const b = p10[1] - p00[1];
    const c = p01[0] - p00[0];
    const d = p01[1] - p00[1];
    const exact = Math.abs(a * buf.w - W) < 0.5 && Math.abs(d * buf.h - H) < 0.5 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && Math.abs(p00[0]) < 0.5 && Math.abs(p00[1]) < 0.5;
    if (exact && buf.w === W && buf.h === H) return null;
    if (exact) return [W / buf.w, 0, 0, H / buf.h, 0, 0];
    return [a, b, c, d, p00[0], p00[1]];
  }

  draw(state, W, H) {
    if (!this.shown) return;
    const m = this.viewTransform(state, W, H);
    if (this.glp && this.drawGl(state, W, H, m)) return;
    this.colorize(state);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    if (!m || (m[1] === 0 && m[2] === 0 && m[4] === 0 && m[5] === 0 && Math.abs(m[0] * this.shown.buf.w - W) < 0.5 && Math.abs(m[3] * this.shown.buf.h - H) < 0.5)) {
      ctx.drawImage(this.scratch, 0, 0, W, H);
      return;
    }
    ctx.fillStyle = "#07080c";
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(this.scratch, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Palette cycling and reprojection on the GPU; false hands the frame back to the 2D path. */
  drawGl(state, W, H, m) {
    const glp = this.glp;
    const shown = this.shown;
    const { buf } = shown;
    if (!glp.fits(buf.w, buf.h, W, H)) return false;
    try {
      const { gain, lutKey } = this.lutFor(state);
      if (lutKey !== this.glLutKey) {
        glp.setLut(this.lut);
        this.glLutKey = lutKey;
      }
      const density = state.density ?? 0.045;
      const mode = state.colorMode | 0;
      const maxIter = shown.state?.iters || state.iters || 100;
      const frameKey = `${shown.serial}:${q(density, 5)}:${mode}:${maxIter}`;
      if (frameKey !== this.glFrameKey) {
        glp.setFrame(buf, mode, density, maxIter);
        this.glFrameKey = frameKey;
      }
      const phase = state.phase || 0;
      const phaseStep = Math.floor((phase - Math.floor(phase)) * 1024);
      const interior = interiorColor(this.lutPal, phase, state.colorInterior, gain);
      const key = `${frameKey}:${lutKey}:${phaseStep}:${interior}:${m ? m.map((v) => v.toFixed(4)).join(",") : "1"}:${W}x${H}`;
      if (key === this.glDrawKey && !state.capture) return true;
      this.glDrawKey = key;
      const ok = glp.draw(W, H, m, phase, interior, [7, 8, 12]);
      if (this.glOverlay) {
        const place = `${state.cssW}x${state.cssH}:${W}x${H}`;
        if (place !== this.glPlace) {
          glp.place(this.canvas);
          this.glPlace = place;
        }
      }
      if (!this.glOverlay || state.capture) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.drawImage(glp.canvas, 0, 0);
      }
      if (!ok || glp.lost) this.dropGlPresent();
      return true;
    } catch {
      this.dropGlPresent();
      return false;
    }
  }

  stepTiles(job) {
    const gpu = this.tiles?.gpu;
    if (!gpu || gpu.lost) {
      this.tiles = null;
      job.kind = "main";
      job.y = 0;
      return;
    }
    try {
      if (!gpu.step(job.tiles)) return;
    } catch {
      this.tiles = null;
      job.kind = "main";
      job.y = 0;
      return;
    }
    this.tileStats = { ms: performance.now() - job.started, tiles: job.tiles.tiles, maxTileMs: job.tiles.gpuMs, rate: gpu.rate, pixels: job.buf.w * job.buf.h, iters: job.tiles.iters, perturb: !!job.tiles.orbit };
    shadeLevels(job.buf);
    this.finish(job);
  }

  /** Opt-in (?gpu=tiles): tiled WebGL1 escape fill, including perturbation. */
  armTiles() {
    this.tilesState = "off";
    if (this.dead || new URLSearchParams(location.search).get("gpu") !== "tiles") return;
    this.tilesState = "pending";
    import("./gpuescape.js")
      .then((mod) => {
        if (this.dead) return;
        const gpu = mod.createGpuEscape();
        if (!gpu || !mod.escapeAgrees(gpu, createBuffer, fillAll)) {
          gpu?.destroy();
          this.tilesState = "failed";
          return;
        }
        this.tiles = { gpu, plan: mod.tilesPlan, pickReference: mod.pickReference };
        this.tilesState = "ready";
        this.lastJobSig = "";
      })
      .catch(() => {
        this.tilesState = "failed";
      });
  }

  dropGlPresent() {
    try {
      this.glp?.destroy();
    } catch {
      /* already gone */
    }
    this.glp = null;
    this.glpState = "failed";
    this.glDrawKey = "";
    this.paintKey = "";
  }

  armGlPresent() {
    if (this.dead) return;
    this.glpState = "pending";
    const pick = new URLSearchParams(location.search).get("present");
    if (pick === "2d") {
      this.glpState = "off";
      return;
    }
    import("./glpresent.js")
      .then(({ createGlPresent, glPresentAgrees }) => {
        if (this.dead) return;
        let glp = null;
        try {
          glp = createGlPresent();
          if (glp && !glPresentAgrees(glp)) {
            glp.destroy();
            glp = null;
          }
        } catch {
          glp = null;
        }
        if (!glp) {
          this.glpState = "failed";
          return;
        }
        this.glp = glp;
        this.glpState = "ready";
        this.glOverlay = pick !== "blit" && glp.attach(this.canvas);
        this.glPlace = "";
        this.glLutKey = "";
        this.glFrameKey = "";
        this.glDrawKey = "";
      })
      .catch(() => {
        this.glpState = "failed";
      });
  }

  mapper(view, bw, bh, state, W, H) {
    const aspB = bw / bh;
    const cb = Math.cos(view.rotation);
    const sb = Math.sin(view.rotation);
    const rot = state.rotation || 0;
    const cc = Math.cos(rot);
    const sc = Math.sin(rot);
    const aspC = W / H;
    return (u, v) => {
      const nx = (u / bw) * 2 - 1;
      const ny = 1 - (v / bh) * 2;
      const px = nx * aspB * view.radius;
      const py = ny * view.radius;
      const dx = view.cx - state.cx + px * cb - py * sb;
      const dy = view.cy - state.cy + px * sb + py * cb;
      const qx = dx * cc + dy * sc;
      const qy = -dx * sc + dy * cc;
      const sx = (qx / (aspC * state.radius) + 1) * 0.5 * W;
      const sy = (1 - qy / state.radius) * 0.5 * H;
      return [sx, sy];
    };
  }

  /**
   * One finished export frame at w x h: the full job without guessing or GPU,
   * then the band-edge antialias pass, painted into a fresh ImageData. The
   * interactive view must not call render() meanwhile; it shares the workers.
   */
  async renderStill(state, w, h) {
    this.cancelStill();
    this.job = null;
    this.gen += 1;
    this.lastJobSig = "";
    this.aaSig = "";
    const job = this.makeJob({ ...state, soft: false, guess: "off", capture: false }, w, h, "still");
    let buf = await this.runStill(job);
    if (state.antialias !== false && this.workers.length && antialiasEligible(job.state)) {
      const aa = this.antialiasJob({ buf, view: job.view, ident: job.ident, sig: "still-aa", state: job.state });
      buf = await this.runStill(aa);
    }
    const image = new ImageData(w, h);
    const out32 = new Uint32Array(image.data.buffer);
    const { gain } = this.lutFor(state);
    const phase = state.phase || 0;
    const interior = interiorColor(this.lutPal, phase, state.colorInterior, gain);
    paint(buf, out32, this.lut, phase, state.density ?? 0.045, interior, state.colorMode | 0, job.state.iters || 100);
    return image;
  }

  runStill(job) {
    return new Promise((resolve, reject) => {
      job.still = true;
      job.resolve = resolve;
      job.reject = reject;
      if (job.aa) {
        this.job = job;
        while (this.idle.length && job.next < job.chunks.length) this.dispatch(this.idle.pop(), job);
      } else {
        this.startJob(job);
      }
      const pump = () => {
        if (this.job !== job) return;
        if (job.kind === "main") this.stepMain(job);
        setTimeout(pump, job.kind === "main" ? 0 : 40);
      };
      pump();
    });
  }

  cancelStill() {
    const job = this.job;
    if (!job?.still) return;
    this.job = null;
    this.gen += 1;
    job.reject(new Error("cancelled"));
  }

  reframe(S, ox, oy) {
    const move = (view) => {
      if (!view) return;
      view.cx = (view.cx - ox) * S;
      view.cy = (view.cy - oy) * S;
      view.radius *= S;
    };
    move(this.shown?.view);
    move(this.job?.view);
  }

  disableGpu() {
    try {
      this.gpu?.destroy();
    } catch {
      /* already gone */
    }
    this.gpu = null;
    this.gpuState = "failed";
    this.label = this.cpuLabel();
  }

  armGpu() {
    if (this.gpuState !== "idle" || this.dead) return;
    this.gpuState = "pending";
    import("./gpu.js")
      .then(({ createGpu }) => {
        if (this.dead) return;
        const gpu = createGpu();
        if (!gpu || !gpuAgrees(gpu)) {
          try {
            gpu?.destroy();
          } catch {
            /* ignore a driver that failed while shutting down */
          }
          this.gpuState = "failed";
          return;
        }
        this.gpu = gpu;
        this.gpuState = "ready";
        this.lastJobSig = "";
      })
      .catch(() => {
        this.gpuState = "failed";
      });
  }

  destroy() {
    this.dead = true;
    this.disableGpu();
    this.dropGlPresent();
    this.tiles?.gpu.destroy();
    this.tiles = null;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}
