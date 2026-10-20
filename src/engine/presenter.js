import { fitSize } from "./color.js";
import { colorize, createBuffer, fillAll, fillRows } from "./kernel.js";

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
  const n = 32 * 18;
  for (let i = 0; i < n; i += 1) {
    if (!cpu.alpha[i]) cpuIn += 1;
    if (!gpuBuf.alpha[i]) gpuIn += 1;
  }
  if (cpuIn < 8) return false;
  return Math.abs(cpuIn - gpuIn) <= cpuIn * 0.4;
}

function quant(n, places) {
  const m = 10 ** places;
  return Math.round(n * m);
}

export class Presenter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!this.ctx) throw new Error("This browser could not open a 2D canvas.");
    this.palA = new Uint8Array(256 * 4);
    this.palB = new Uint8Array(256 * 4);
    this.label = "CPU";
    this.sig = "";
    this.buffer = null;
    this.work = null;
    this.scratch = document.createElement("canvas");
    this.sctx = this.scratch.getContext("2d", { alpha: false });
    this.image = null;
    this.gpu = null;
    this.gpuState = "idle";
    this.dead = false;
    this.coarseArea = 80 * 45;
    this.fineArea = 420 * 236;
    this.ctx.imageSmoothingEnabled = true;
  }

  uploadPalette(which, pixels) {
    (which === "b" ? this.palB : this.palA).set(pixels.subarray(0, 256 * 4));
  }

  resizeDisplay(cssW, cssH, maxArea) {
    const [w, h] = fitSize(cssW, cssH, maxArea || cssW * cssH);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  signature(state, w, h) {
    return [
      state.family,
      state.formula,
      w,
      h,
      quant(state.cx, 5),
      quant(state.cy, 5),
      quant(Math.log(Math.max(state.radius, 1e-8)), 4),
      quant(state.rotation || 0, 4),
      quant(state.power, 3),
      quant(state.bailout, 2),
      quant(state.juliaRe || 0, 4),
      quant(state.juliaIm || 0, 4),
      quant(state.extra || 0, 3),
      state.iters | 0,
      quant(state.trap || 0, 3),
      state.skipInterior ? 1 : 0,
      quant(state.yaw || 0, 3),
      quant(state.pitch || 0, 3),
      quant(state.dist || 0, 3),
    ].join(":");
  }

  previewCap(state) {
    if (state.family === "ray") return Math.min(this.coarseArea, 56 * 32);
    return this.coarseArea;
  }

  detailCap(state) {
    if (state.family === "ray") return 88 * 50;
    if (state.family === "ifs") return Math.min(this.fineArea, 360 * 200);
    return this.fineArea;
  }

  params(state, w, h) {
    return { ...state, w, h };
  }

  commit(buf) {
    this.buffer = buf;
    if (!this.image || this.image.width !== buf.w || this.image.height !== buf.h) {
      this.scratch.width = buf.w;
      this.scratch.height = buf.h;
      this.image = this.sctx.createImageData(buf.w, buf.h);
    }
  }

  fillSync(state, w, h) {
    const params = this.params(state, w, h);
    const buf = createBuffer(w, h);
    const started = performance.now();
    const gpuOk = this.gpu && state.family === "escape" && state.formula < 8 && w * h > this.coarseArea;
    if (gpuOk) {
      try {
        this.gpu.fill(buf, params);
        this.label = "GPU";
      } catch {
        this.disableGpu();
        fillAll(buf, params);
        this.label = "CPU";
      }
    } else {
      fillAll(buf, params);
      if (!this.gpu) this.label = "CPU";
    }
    const ms = performance.now() - started;
    if (!gpuOk && state.soft && ms > 22) this.coarseArea = Math.max(48 * 27, Math.round(this.coarseArea * 0.72));
    else if (!gpuOk && state.soft && ms < 7) this.coarseArea = Math.min(120 * 68, Math.round(this.coarseArea * 1.12));
    if (gpuOk && ms > 45) this.disableGpu();
    return buf;
  }

  disableGpu() {
    try {
      this.gpu?.destroy();
    } catch {
      /* already gone */
    }
    this.gpu = null;
    this.gpuState = "failed";
    this.label = "CPU";
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
          this.label = "CPU";
          return;
        }
        this.gpu = gpu;
        this.gpuState = "ready";
        this.sig = "";
      })
      .catch(() => {
        this.gpuState = "failed";
        this.label = "CPU";
      });
  }

  render(state) {
    this.resizeDisplay(state.cssW, state.cssH, state.displayArea);
    const cheap = state.family === "shape" || state.family === "ifs";
    const cap = state.soft && !cheap ? this.previewCap(state) : this.detailCap(state);
    const [w, h] = fitSize(state.cssW, state.cssH, cap);
    const sig = this.signature(state, w, h);
    if (sig !== this.sig) {
      this.sig = sig;
      this.work = null;
      const previewArea = cheap ? w * h : Math.min(w * h, this.previewCap(state));
      const [pw, ph] = fitSize(state.cssW, state.cssH, previewArea);
      this.commit(this.fillSync(state, pw, ph));
      const classic = state.family === "escape" && state.formula < 8;
      if ((pw !== w || ph !== h) && this.gpu && classic) {
        try {
          const fine = createBuffer(w, h);
          this.gpu.fill(fine, this.params(state, w, h));
          this.commit(fine);
          this.label = "GPU";
        } catch {
          this.disableGpu();
          this.work = { buf: createBuffer(w, h), y: 0, state: this.params(state, w, h) };
        }
      } else if (pw !== w || ph !== h) {
        this.work = { buf: createBuffer(w, h), y: 0, state: this.params(state, w, h) };
        this.label = "CPU";
      }
    } else if (this.work) {
      const job = this.work;
      const t0 = performance.now();
      while (job.y < job.buf.h && performance.now() - t0 < 9) {
        const y1 = Math.min(job.buf.h, job.y + 3);
        fillRows(job.buf, job.state, job.y, y1);
        job.y = y1;
      }
      if (job.y >= job.buf.h) {
        this.commit(job.buf);
        this.work = null;
        this.label = "CPU";
      }
    }
    this.paint(state);
    if (this.gpuState === "idle") this.armGpu();
    const result = {
      pending: !!this.work,
      viewW: this.buffer?.w || 0,
      viewH: this.buffer?.h || 0,
      flip: false,
    };
    if (state.capture) {
      const pixels = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      result.pixels = pixels.data;
      result.w = this.canvas.width;
      result.h = this.canvas.height;
    }
    return result;
  }

  paint(state) {
    if (!this.buffer || !this.image) return;
    colorize(this.buffer, this.image.data, this.palA, this.palB, state);
    this.sctx.putImageData(this.image, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.scratch, 0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    this.dead = true;
    this.disableGpu();
  }
}
