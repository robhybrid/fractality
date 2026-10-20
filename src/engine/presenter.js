import { BUDGET } from "../budget.js";
import { fitSize } from "./color.js";
import { createBuffer, fillAll, fillRows, shadeLevels } from "./kernel.js";
import { buildLut, interiorColor, paint } from "./shade.js";

export function orbitCamera(yaw, pitch, dist) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const eye = [dist * cp * sy, dist * sp, dist * cp * cy];
  const len = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  const forward = [-eye[0] / len, -eye[1] / len, -eye[2] / len];
  let right = [-forward[2], 0, forward[0]];
  const rl = Math.hypot(right[0], right[1], right[2]);
  if (rl < 1e-5) right = [1, 0, 0];
  else right = right.map((v) => v / rl);
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { eye, forward, right, up };
}

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
    s.family === "ray" ? `${q(s.yaw, 4)}:${q(s.pitch, 4)}:${q(s.dist, 4)}:${s.steps}:${s.rayIters}` : "",
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
    const area = state.soft ? full * this.motionShare : full;
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
    if ((state.iters | 0) > 48) return false;
    return (2 * state.radius) / h > 3e-6;
  }

  startJob(job) {
    this.job = job;
    this.lastJobSig = job.sig;
    const { w, h } = job.buf;
    if (this.gpuEligible(job.state, h)) {
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
    worker.postMessage({ gen: job.gen, y0, y1, state: job.state });
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
    job.buf.level.set(msg.level, off);
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
    if (job.soft) {
      if (ms > 48) this.motionShare = Math.max(0.05, this.motionShare * 0.8);
      else if (ms < 24) this.motionShare = Math.min(1, this.motionShare * 1.12);
    }
    this.job = null;
    this.show(job.buf, job.view, job.ident, job.sig);
  }

  show(buf, view, ident, sig) {
    this.serial = (this.serial || 0) + 1;
    this.shown = { buf, view, ident, sig, serial: this.serial };
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

  render(state) {
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
    if (this.job && state.soft && !this.job.soft) {
      this.job = null;
      this.gen += 1;
      this.lastJobSig = "";
    }
    const [w, h] = this.targetSize(state, W, H);
    const sig = `${paramKey(state)}|${geomKey(state)}|${w}x${h}`;
    if (!this.job && sig !== this.lastJobSig) this.startJob(this.makeJob(state, w, h, sig));
    if (this.job?.kind === "main") this.stepMain(this.job);
    this.draw(state, W, H);
    if (this.gpuState === "idle") this.armGpu();
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

  colorize(state) {
    const gain = (state.exposure || 1) * (1 + 0.38 * (state.beat || 0));
    const lutKey = `${this.palVersion}:${q(state.palMix || 0, 3)}:${state.post}:${q(state.edge || 0, 3)}:${q(gain, 3)}`;
    if (lutKey !== this.lutKey) {
      const built = buildLut({ palA: this.palA, palB: this.palB, mix: state.palMix || 0, post: state.post | 0, edge: state.edge || 0, gain });
      this.lut = built.lut;
      this.lutPal = built.pal;
      this.lutKey = lutKey;
    }
    const phase = state.phase || 0;
    const shown = this.shown;
    const phaseStep = Math.floor((phase - Math.floor(phase)) * 1024);
    const key = `${shown.serial}:${lutKey}:${phaseStep}:${q(state.density, 5)}:${state.colorInterior ? 1 : 0}:${state.colorMode | 0}`;
    if (key === this.paintKey) return;
    this.paintKey = key;
    const interior = interiorColor(this.lutPal, phase, state.colorInterior, gain);
    paint(shown.buf, this.out32, this.lut, phase, state.density ?? 0.045, interior, state.colorMode | 0);
    this.sctx.putImageData(this.image, 0, 0);
  }

  draw(state, W, H) {
    if (!this.shown) return;
    this.colorize(state);
    const ctx = this.ctx;
    const { buf, view } = this.shown;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    if (view.family === "ray" || state.family === "ray") {
      ctx.drawImage(this.scratch, 0, 0, W, H);
      return;
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
    if (exact) {
      ctx.drawImage(this.scratch, 0, 0, W, H);
      return;
    }
    ctx.fillStyle = "#07080c";
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(a, b, c, d, p00[0], p00[1]);
    ctx.drawImage(this.scratch, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}
