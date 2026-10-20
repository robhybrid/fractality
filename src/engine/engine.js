import { BUDGET } from "../budget.js";
import { FRACTALS, MODES, PALETTES, PRESETS, cloneStops } from "../data.js";
import { BeatListener } from "./audio.js";
import { clamp, cssGradient, fitSize, randomPalette, rasterize, shiftHue, smoothDamp } from "./color.js";
import { Presenter, orbitCamera } from "./presenter.js";

const HOTKEY = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 0: 9 };

export function createEngine(canvas, { onChange }) {
  const renderer = new Presenter(canvas);
  const audio = new BeatListener();
  const engine = new Engine(canvas, renderer, audio, onChange);
  engine.start();
  return engine;
}

class Engine {
  constructor(canvas, renderer, audio, onChange) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.audio = audio;
    this.onChange = onChange;
    this.raf = 0;
    this.last = performance.now();
    this.frameEma = 16;
    this.stress = 0;
    this.relax = 0;
    this.iterScale = 1;
    this.pixelScale = 1;
    this.throttled = false;
    this.detail = 1;
    this.time = 0;
    this.hidden = false;
    this.paused = false;
    this.mode = "zoom";
    this.fractalIndex = 0;
    this.memory = new Map();
    this.paletteIndex = 0;
    this.stops = cloneStops(PALETTES[0].stops);
    this.paletteSpeed = 0.08;
    this.animatePalette = true;
    this.phase = 0;
    this.density = 0.085;
    this.exposure = 1.12;
    this.edge = 0.55;
    this.post = 1;
    this.banded = true;
    this.colorInterior = false;
    this.autoIter = true;
    this.iterBias = 48;
    this.breathe = false;
    this.breathBase = 2;
    this.beatMode = 0;
    this.beatPulse = 0;
    this.help = true;
    this.selectedStop = 0;
    this.presetCursor = 0;
    this.trap = 0;
    this.skipInterior = true;
    this.palMix = 0;
    this.fade = 1;
    this.pendingStops = null;
    this.dirty = true;
    this.capture = false;
    this.mx = 0;
    this.my = 0;
    this.drag = null;
    this.zoomTarget = 0;
    this.zoomRate = 0;
    this.buttons = new Set();
    this.alt = false;
    this.ease = 0.62;
    this.lastPublish = 0;
    this.fps = 60;
    this.error = "";
    this.view = {};
    this.applyHome(FRACTALS[0], true);
    this.renderer.uploadPalette("a", rasterize(this.stops));
    this.renderer.uploadPalette("b", rasterize(this.stops));
    this.onKey = this.onKey.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onContext = (event) => event.preventDefault();
    this.onDrop = this.onDrop.bind(this);
    this.onDragOver = (event) => event.preventDefault();
    this.onDbl = (event) => this.nudgeZoom(event, 0.62);
    this.onResize = () => {
      this.dirty = true;
    };
    this.wasSoft = true;
    window.addEventListener("keydown", this.onKey);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContext);
    canvas.addEventListener("dblclick", this.onDbl);
    window.addEventListener("dragover", this.onDragOver);
    window.addEventListener("drop", this.onDrop);
    window.addEventListener("resize", this.onResize);
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(canvas);
  }

  get fractal() {
    return FRACTALS[this.fractalIndex];
  }

  start() {
    const once = new URLSearchParams(location.search).has("once");
    const loop = (now) => {
      this.frame(now);
      this.frames = (this.frames || 0) + 1;
      if (!once || this.frames < 3) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.publish(true);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKey);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContext);
    this.canvas.removeEventListener("dblclick", this.onDbl);
    window.removeEventListener("dragover", this.onDragOver);
    window.removeEventListener("drop", this.onDrop);
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver.disconnect();
    this.audio.stop();
    this.renderer.destroy();
  }

  applyHome(fractal, snapPower = true) {
    const home = fractal.home;
    if (fractal.family === "ray") {
      this.yaw = home.yaw;
      this.pitch = home.pitch;
      this.dist = home.dist;
      this.yawT = home.yaw;
      this.pitchT = home.pitch;
      this.distT = home.dist;
      this.vYaw = this.vPitch = this.vDist = 0;
      this.cx = 0;
      this.cy = 0;
      this.radius = 1;
      this.logR = 0;
    } else {
      this.cx = home.x;
      this.cy = home.y;
      this.radius = home.r;
      this.logR = Math.log(home.r);
      this.rotation = home.rot || 0;
    }
    this.tcx = this.cx;
    this.tcy = this.cy;
    this.tLogR = this.logR;
    this.tRot = this.rotation || 0;
    this.rotation = this.rotation || 0;
    this.vCx = this.vCy = this.vLogR = this.vRot = 0;
    if (snapPower) {
      this.power = fractal.power;
      this.powerT = fractal.power;
      this.vPower = 0;
      this.breathBase = fractal.power;
    }
    this.bailout = fractal.bail;
    this.bailT = fractal.bail;
    this.vBail = 0;
    this.juliaRe = fractal.julia?.[0] ?? this.juliaRe ?? -0.8;
    this.juliaIm = fractal.julia?.[1] ?? this.juliaIm ?? 0.156;
    this.juliaReT = this.juliaRe;
    this.juliaImT = this.juliaIm;
    this.vJr = this.vJi = 0;
    this.extra = fractal.extra ?? this.extra ?? 0;
    this.extraT = this.extra;
    this.vExtra = 0;
    this.dirty = true;
  }

  remember() {
    const f = this.fractal;
    this.memory.set(f.id, {
      cx: this.cx,
      cy: this.cy,
      logR: this.logR,
      rotation: this.rotation,
      yaw: this.yaw,
      pitch: this.pitch,
      dist: this.dist,
      power: this.powerT,
      bail: this.bailT,
      juliaRe: this.juliaReT,
      juliaIm: this.juliaImT,
      extra: this.extraT,
    });
  }

  restore(mem) {
    this.cx = mem.cx;
    this.cy = mem.cy;
    this.logR = mem.logR;
    this.radius = Math.exp(mem.logR);
    this.rotation = mem.rotation;
    this.yaw = mem.yaw ?? 0.5;
    this.pitch = mem.pitch ?? 0.3;
    this.dist = mem.dist ?? 2.5;
    this.tcx = this.cx;
    this.tcy = this.cy;
    this.tLogR = this.logR;
    this.tRot = this.rotation;
    this.yawT = this.yaw;
    this.pitchT = this.pitch;
    this.distT = this.dist;
    this.vCx = this.vCy = this.vLogR = this.vRot = 0;
    this.vYaw = this.vPitch = this.vDist = 0;
    this.power = mem.power;
    this.powerT = mem.power;
    this.bailout = mem.bail;
    this.bailT = mem.bail;
    this.juliaRe = mem.juliaRe;
    this.juliaIm = mem.juliaIm;
    this.juliaReT = mem.juliaRe;
    this.juliaImT = mem.juliaIm;
    this.extra = mem.extra;
    this.extraT = mem.extra;
    this.dirty = true;
  }

  setFractal(index) {
    const next = (index + FRACTALS.length) % FRACTALS.length;
    if (next === this.fractalIndex) return;
    this.remember();
    this.fractalIndex = next;
    const mem = this.memory.get(FRACTALS[next].id);
    if (mem) this.restore(mem);
    else this.applyHome(FRACTALS[next], true);
    this.presetCursor = 0;
    this.publish(true);
  }

  setMode(id) {
    this.mode = id;
    this.publish(true);
  }

  setPalette(index) {
    this.paletteIndex = (index + PALETTES.length) % PALETTES.length;
    this.stops = cloneStops(PALETTES[this.paletteIndex].stops);
    this.selectedStop = 0;
    this.renderer.uploadPalette("b", rasterize(this.stops));
    this.fade = 0;
    this.publish(true);
  }

  editStops(stops) {
    this.stops = stops;
    this.renderer.uploadPalette("a", rasterize(stops));
    this.fade = 1;
    this.palMix = 0;
  }

  screenSize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.canvas.clientWidth || window.innerWidth;
    const h = rect.height || this.canvas.clientHeight || window.innerHeight;
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  screenToWorld(x, y) {
    const { w, h } = this.screenSize();
    const nx = (x / w) * 2 - 1;
    const ny = 1 - (y / h) * 2;
    const aspect = w / h;
    const px = nx * aspect * this.radius;
    const py = ny * this.radius;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    return {
      x: this.cx + px * c - py * s,
      y: this.cy + px * s + py * c,
    };
  }

  zoomAt(x, y, factor) {
    if (this.fractal.family === "ray") {
      const { w, h } = this.screenSize();
      const nx = (x / w) * 2 - 1;
      const ny = ((y / h) * 2 - 1);
      this.yaw += nx * (1 - factor) * 0.35;
      this.pitch = clamp(this.pitch + ny * (1 - factor) * 0.22, -1.15, 1.15);
      this.dist = clamp(this.dist * factor, BUDGET.minDist, BUDGET.maxDist);
      this.yawT = this.yaw;
      this.pitchT = this.pitch;
      this.distT = this.dist;
      this.vYaw = this.vPitch = this.vDist = 0;
      return;
    }
    const world = this.screenToWorld(x, y);
    this.cx = world.x + (this.cx - world.x) * factor;
    this.cy = world.y + (this.cy - world.y) * factor;
    this.logR = Math.log(clamp(this.radius * factor, BUDGET.minRadius, BUDGET.maxRadius));
    this.radius = Math.exp(this.logR);
    this.syncTargets();
  }

  syncTargets() {
    this.tcx = this.cx;
    this.tcy = this.cy;
    this.tLogR = this.logR;
    this.tRot = this.rotation;
    this.vCx = this.vCy = this.vLogR = this.vRot = 0;
  }

  panBy(dx, dy) {
    const a = this.screenToWorld(this.mx - dx, this.my - dy);
    const b = this.screenToWorld(this.mx, this.my);
    this.cx += a.x - b.x;
    this.cy += a.y - b.y;
    this.syncTargets();
  }

  nudgeZoom(event, factor) {
    if (this.fractal.family === "ray") {
      this.distT = clamp(this.dist * factor, BUDGET.minDist, BUDGET.maxDist);
      return;
    }
    const world = this.screenToWorld(event?.offsetX ?? this.mx, event?.offsetY ?? this.my);
    this.tcx = world.x + (this.cx - world.x) * factor;
    this.tcy = world.y + (this.cy - world.y) * factor;
    this.tLogR = Math.log(clamp(this.radius * factor, BUDGET.minRadius, BUDGET.maxRadius));
    this.ease = 0.7;
  }

  effectiveIters() {
    const f = this.fractal;
    let wanted = this.iterBias;
    if (this.autoIter && f.family !== "ray") {
      const base = f.home.r || 1.35;
      const zoom = Math.max(0, Math.log2(base / Math.max(this.radius, 1e-8)));
      wanted = f.family === "shape" ? 6 + zoom * 0.4 : 40 + zoom * 8;
    }
    if (f.family === "ray") wanted = BUDGET.defaultSteps;
    return Math.round(clamp(wanted * this.iterScale, f.family === "ray" ? BUDGET.minSteps : BUDGET.minIter, f.family === "ray" ? BUDGET.maxSteps : BUDGET.maxIter));
  }

  frame(now) {
    const dt = clamp((now - this.last) / 1000, 0, 0.05);
    this.last = now;
    this.time += dt;
    this.frameEma = this.frameEma * 0.9 + dt * 1000 * 0.1;
    this.fps = 1000 / Math.max(1, this.frameEma);
    this.govern();
    const sound = this.audio.sample(this.time, dt);
    if (sound.beat) this.onBeat();
    this.beatPulse *= Math.exp(-3.2 * dt);
    if (!this.paused && this.animatePalette) this.phase += this.paletteSpeed * dt;
    if (!this.paused && this.breathe) {
      this.powerT = this.breathBase + (1 - Math.cos(this.time * 0.35)) * 1.15;
    }
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / 0.45);
      this.palMix = this.fade;
      if (this.fade >= 1) {
        this.renderer.uploadPalette("a", rasterize(this.stops));
        this.palMix = 0;
      }
    }
    const holding = this.buttons.size > 0;
    this.zoomRate += (this.zoomTarget - this.zoomRate) * (1 - Math.exp(-8 * dt));
    let geometry = false;
    if (Math.abs(this.zoomRate) > 0.01) {
      this.zoomAt(this.mx, this.my, Math.exp(-this.zoomRate * dt));
      geometry = true;
    } else if (!holding) {
      geometry = this.easeView(dt) || geometry;
    }
    const beforePower = this.power;
    [this.power, this.vPower] = smoothDamp(this.power, this.powerT, this.vPower, this.breathe ? 0.45 : 0.35, dt);
    [this.bailout, this.vBail] = smoothDamp(this.bailout, this.bailT, this.vBail, 0.4, dt);
    [this.juliaRe, this.vJr] = smoothDamp(this.juliaRe, this.juliaReT, this.vJr, 0.35, dt);
    [this.juliaIm, this.vJi] = smoothDamp(this.juliaIm, this.juliaImT, this.vJi, 0.35, dt);
    [this.extra, this.vExtra] = smoothDamp(this.extra, this.extraT, this.vExtra, 0.35, dt);
    if (Math.abs(this.power - beforePower) > 0.002) geometry = true;
    if (Math.abs(this.bailout - this.bailT) > 0.05 && Math.abs(this.vBail) > 0.01) geometry = true;
    if (Math.abs(this.juliaRe - this.juliaReT) > 0.0002 || Math.abs(this.juliaIm - this.juliaImT) > 0.0002) {
      if (Math.abs(this.vJr) + Math.abs(this.vJi) > 0.00001) geometry = true;
    }
    if (Math.abs(this.extra - this.extraT) > 0.001 && Math.abs(this.vExtra) > 0.0001) geometry = true;
    if (geometry) this.dirty = true;
    const soft = holding || Math.abs(this.zoomRate) > 0.02 || this.breathe || this.moving();
    if (soft !== this.wasSoft) {
      this.dirty = true;
      this.wasSoft = soft;
    }
    if (!this.moving() && Math.abs(this.zoomRate) < 0.02 && !this.breathe) this.ease = 0.62;
    this.draw(soft);
    this.publish(false, sound);
  }

  moving() {
    return Math.abs(this.vCx) + Math.abs(this.vCy) + Math.abs(this.vLogR) + Math.abs(this.vRot) + Math.abs(this.vYaw || 0) + Math.abs(this.vPitch || 0) + Math.abs(this.vDist || 0) > 0.0004;
  }

  easeView(dt) {
    const smooth = this.ease;
    let changed = false;
    const step = (value, target, vel) => {
      const [next, v] = smoothDamp(value, target, vel, smooth, dt);
      if (Math.abs(next - value) > 1e-6) changed = true;
      return [next, v];
    };
    if (this.fractal.family === "ray") {
      [this.yaw, this.vYaw] = step(this.yaw, this.yawT, this.vYaw || 0);
      [this.pitch, this.vPitch] = step(this.pitch, this.pitchT, this.vPitch || 0);
      [this.dist, this.vDist] = step(this.dist, this.distT, this.vDist || 0);
    } else {
      [this.cx, this.vCx] = step(this.cx, this.tcx, this.vCx);
      [this.cy, this.vCy] = step(this.cy, this.tcy, this.vCy);
      [this.logR, this.vLogR] = step(this.logR, this.tLogR, this.vLogR);
      this.radius = Math.exp(this.logR);
      [this.rotation, this.vRot] = step(this.rotation, this.tRot, this.vRot);
    }
    return changed;
  }

  govern() {
    if (this.frameEma > 50) {
      this.stress += 1;
      this.relax = 0;
      if (this.stress === 12 || this.stress === 28) this.reduce();
    } else if (this.frameEma < 22) {
      this.stress = 0;
      this.relax += 1;
      if (this.relax > 120) {
        this.increase();
        this.relax = 0;
      }
    } else {
      this.stress = Math.max(0, this.stress - 1);
      this.relax = 0;
    }
  }

  reduce() {
    this.iterScale = Math.max(0.4, this.iterScale * 0.82);
    this.pixelScale = Math.max(0.5, this.pixelScale * 0.86);
    this.throttled = true;
    this.dirty = true;
  }

  increase() {
    const before = this.iterScale + this.pixelScale;
    this.iterScale = Math.min(1, this.iterScale * 1.06);
    this.pixelScale = Math.min(1, this.pixelScale * 1.04);
    if (this.iterScale > 0.98 && this.pixelScale > 0.98) this.throttled = false;
    if (this.iterScale + this.pixelScale > before + 0.01) this.dirty = true;
  }

  onBeat() {
    if (this.beatMode >= 1) {
      this.phase += 0.16;
      this.beatPulse = 1;
    }
    if (this.beatMode >= 2 && !this.paused) {
      if (this.fractal.family === "ray") this.distT = clamp(this.dist * 0.94, BUDGET.minDist, BUDGET.maxDist);
      else this.tLogR = Math.log(clamp(this.radius * 0.94, BUDGET.minRadius, BUDGET.maxRadius));
      this.ease = 0.22;
    }
  }

  draw(soft) {
    const { w, h } = this.screenSize();
    const family = this.fractal.family;
    const cap = (family === "ray" ? BUDGET.maxPixels3d : family === "ifs" ? BUDGET.maxPixelsIfs : BUDGET.maxPixels2d) * this.detail * this.pixelScale;
    const [texW, texH] = fitSize(w, h, cap);
    const viewCap = soft ? texW * texH * BUDGET.interactArea : texW * texH;
    const [viewW, viewH] = soft ? fitSize(texW, texH, viewCap) : [texW, texH];
    const iters = this.effectiveIters();
    let rayIters = BUDGET.bulbIter;
    if (this.fractal.id === "box") rayIters = BUDGET.boxIter;
    if (this.fractal.id === "menger") rayIters = BUDGET.mengerIter;
    if (this.fractal.id === "tetra") rayIters = BUDGET.tetraIter;
    rayIters = Math.max(3, Math.round(rayIters * this.iterScale));
    const upscale = Math.max(w / viewW, h / viewH);
    const blur = soft ? 1.15 : upscale > 1.08 ? 0.45 : 0;
    let pixels = null;
    try {
      pixels = this.renderer.render({
        cssW: w,
        cssH: h,
        displayArea: BUDGET.displayPixels,
        texW,
        texH,
        viewW,
        viewH,
        fractalDirty: this.dirty,
        family,
        formula: this.fractal.formula,
        cx: this.cx,
        cy: this.cy,
        radius: this.radius,
        rotation: this.rotation || 0,
        power: this.power,
        bailout: this.bailout,
        juliaRe: this.juliaRe,
        juliaIm: this.juliaIm,
        extra: this.extra,
        iters: family === "ray" ? this.effectiveIters() : iters,
        steps: family === "ray" ? iters : BUDGET.defaultSteps,
        rayIters,
        trap: this.trap,
        skipInterior: this.skipInterior,
        ifsPoints: Math.round(BUDGET.maxIfsPoints * this.detail * this.pixelScale),
        ifsIters: 18,
        camera: orbitCamera(this.yaw || 0.5, this.pitch || 0.3, this.dist || 2.6),
        yaw: this.yaw || 0,
        pitch: this.pitch || 0,
        dist: this.dist || 0,
        phase: this.phase,
        density: this.density,
        soft,
        quality: this.detail * this.pixelScale,
        blur,
        edge: this.post === 0 ? 0 : this.edge,
        beat: this.beatPulse,
        exposure: this.exposure,
        palMix: this.palMix,
        colorInterior: this.colorInterior,
        post: this.post,
        banded: this.banded,
        capture: this.capture,
      });
      this.error = "";
    } catch (error) {
      this.error = error.message || String(error);
      this.publish(true);
      return;
    }
    this.dirty = !!pixels?.pending;
    this.view = {
      texW,
      texH,
      viewW: pixels?.viewW || viewW,
      viewH: pixels?.viewH || viewH,
      iters,
      blur,
    };
    if (pixels?.pixels) this.download(pixels);
    this.capture = false;
  }

  download({ pixels, w, h, flip = true }) {
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    const image = ctx.createImageData(w, h);
    if (!flip) image.data.set(pixels);
    else {
      for (let y = 0; y < h; y += 1) {
        const src = (h - 1 - y) * w * 4;
        image.data.set(pixels.subarray(src, src + w * 4), y * w * 4);
      }
    }
    ctx.putImageData(image, 0, 0);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fractality-${this.fractal.id}.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  publish(force, sound = null) {
    const now = performance.now();
    if (!force && now - this.lastPublish < 180) return;
    this.lastPublish = now;
    const f = this.fractal;
    const mode = MODES.find((item) => item.id === this.mode);
    this.onChange({
      hidden: this.hidden,
      error: this.error,
      help: this.help,
      name: f.name,
      family: f.family,
      index: this.fractalIndex,
      count: FRACTALS.length,
      mode: this.mode,
      modeLabel: mode?.label || this.mode,
      modeBlurb: mode?.blurb || "",
      fps: Math.round(this.fps),
      throttled: this.throttled,
      backend: this.renderer.label || "CPU",
      phase: this.phase,
      viewW: this.view.viewW || 0,
      viewH: this.view.viewH || 0,
      iters: this.view.iters || 0,
      power: this.powerT,
      iterBias: this.iterBias,
      autoIter: this.autoIter,
      paletteIndex: this.paletteIndex,
      paletteName: PALETTES[this.paletteIndex].name,
      paletteSpeed: this.paletteSpeed,
      density: this.density,
      rotation: this.tRot || 0,
      bailout: this.bailT,
      juliaRe: this.juliaReT,
      juliaIm: this.juliaImT,
      extra: this.extraT,
      animatePalette: this.animatePalette,
      breathe: this.breathe,
      beatMode: this.beatMode,
      beatEnv: sound?.envelope ?? this.beatPulse,
      bass: sound?.bass ?? 0,
      mid: sound?.mid ?? 0,
      high: sound?.high ?? 0,
      bpm: sound?.bpm ?? 0,
      audioLabel: this.audio.label,
      audioOn: this.audio.active,
      colorInterior: this.colorInterior,
      post: this.post,
      banded: this.banded,
      detail: this.detail,
      paused: this.paused,
      stops: this.stops,
      gradient: cssGradient(this.stops),
      selectedStop: this.selectedStop,
      cx: this.cx,
      cy: this.cy,
      radius: this.radius,
      yaw: this.yaw || 0,
      pitch: this.pitch || 0,
      dist: this.dist || 0,
      fractals: FRACTALS.map((item, index) => ({ index, name: item.name, hotkey: item.hotkey || "" })),
      palettes: PALETTES.map((item, index) => ({ index, name: item.name })),
      modes: MODES,
    });
  }

  typing(event) {
    const tag = event.target?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
  }

  onKey(event) {
    if (this.typing(event)) return;
    const key = event.key;
    if (key.startsWith("Arrow") || key === " ") event.preventDefault();
    if (event.repeat && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "-", "=", "+", "_"].includes(key)) return;
    if (HOTKEY[key] !== undefined && !event.shiftKey) {
      this.setFractal(HOTKEY[key]);
      return;
    }
    if (key === "h" || key === "H") {
      this.hidden = !this.hidden;
      this.publish(true);
      return;
    }
    if (key === "?" ) {
      this.help = !this.help;
      this.publish(true);
      return;
    }
    if (key === "Tab") {
      event.preventDefault();
      const i = MODES.findIndex((item) => item.id === this.mode);
      this.setMode(MODES[(i + (event.shiftKey ? -1 : 1) + MODES.length) % MODES.length].id);
      return;
    }
    if (key === "Escape") {
      this.setMode("zoom");
      return;
    }
    const modeKey = MODES.find((item) => item.key.toLowerCase() === key.toLowerCase() && key.length === 1 && !event.metaKey && !event.ctrlKey);
    if (modeKey && ["z", "x", "v", "c", "p", "g", "t", "b", "i", "o"].includes(key.toLowerCase())) {
      this.setMode(modeKey.id);
      return;
    }
    if (key === "[") this.setFractal(this.fractalIndex - 1);
    else if (key === "]") this.setFractal(this.fractalIndex + 1);
    else if (key === "," && !event.shiftKey) this.setPalette(this.paletteIndex - 1);
    else if (key === "." && !event.shiftKey) this.setPalette(this.paletteIndex + 1);
    else if (key === "ArrowLeft" && event.shiftKey) this.moveStop(this.selectedStop, this.stops[this.selectedStop].t - 0.02);
    else if (key === "ArrowRight" && event.shiftKey) this.moveStop(this.selectedStop, this.stops[this.selectedStop].t + 0.02);
    else if (key === "ArrowUp" && event.shiftKey) this.recolorStop(14);
    else if (key === "ArrowDown" && event.shiftKey) this.recolorStop(-14);
    else if (key === "ArrowLeft") this.nudgePan(-1, 0);
    else if (key === "ArrowRight") this.nudgePan(1, 0);
    else if (key === "ArrowUp") this.nudgePan(0, 1);
    else if (key === "ArrowDown") this.nudgePan(0, -1);
    else if (key === "=" || key === "+") {
      if (event.shiftKey) this.bumpIter(8);
      else this.bumpZoom(0.72);
    } else if (key === "-" || key === "_") {
      if (event.shiftKey) this.bumpIter(-8);
      else this.bumpZoom(1.38);
    } else if (key === "q" || key === "Q") this.bumpRot(-0.18);
    else if (key === "e" || key === "E") this.bumpRot(0.18);
    else if (key === ";") this.setPaletteSpeed(this.paletteSpeed - 0.02);
    else if (key === "'") this.setPaletteSpeed(this.paletteSpeed + 0.02);
    else if (key === "n" || key === "N") this.flyNext();
    else if (key === "r" || key === "R") this.resetView();
    else if (key === "j" || key === "J") this.toggleJulia();
    else if (key === " ") {
      event.preventDefault();
      this.paused = !this.paused;
      this.publish(true);
    } else if (key === "f" || key === "F") this.fullscreen();
    else if (key === "m" || key === "M") this.toggleMic();
    else if (key === "k" || key === "K") this.cycleBeat();
    else if (key === "y" || key === "Y") this.setBreathe(!this.breathe);
    else if (key === "l" || key === "L") this.setAnimatePalette(!this.animatePalette);
    else if (key === "d" || key === "D") {
      this.colorInterior = !this.colorInterior;
      this.publish(true);
    } else if (key === "`" || key === "~") {
      this.setBanded(!this.banded);
    } else if (key === "w" || key === "W") {
      this.post = (this.post + 1) % 3;
      this.publish(true);
    } else if (key === "a" || key === "A") {
      this.autoIter = !this.autoIter;
      this.dirty = true;
      this.publish(true);
    } else if (key === "s" || key === "S") this.capture = true;
    else if (key === "\\") {
      this.paletteIndex = PALETTES.findIndex((item) => item.id === "custom");
      this.editStops(randomPalette());
      this.publish(true);
    } else if (key === "u" || key === "U") this.setExtra(this.extraT + (event.shiftKey ? 0.08 : -0.08));
    else if (key === "PageUp") this.setPower(this.powerT + 0.15);
    else if (key === "PageDown") this.setPower(this.powerT - 0.15);
    else if (key === "Delete" || key === "Backspace") this.removeStop(this.selectedStop);
    else if (key === "Enter" && event.shiftKey) this.addStop(0.5);
  }

  nudgePan(sx, sy) {
    eventSafe();
    if (this.fractal.family === "ray") {
      this.yawT += sx * 0.08;
      this.pitchT = clamp(this.pitchT + sy * 0.06, -1.15, 1.15);
      this.ease = 0.45;
      return;
    }
    const step = this.radius * 0.12;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    this.tcx += (sx * c - sy * s) * step;
    this.tcy += (sx * s + sy * c) * step;
    this.ease = 0.45;
  }

  bumpZoom(factor) {
    if (this.fractal.family === "ray") this.distT = clamp(this.dist * factor, BUDGET.minDist, BUDGET.maxDist);
    else this.tLogR = Math.log(clamp(Math.exp(this.tLogR) * factor, BUDGET.minRadius, BUDGET.maxRadius));
    this.ease = 0.55;
  }

  bumpRot(delta) {
    if (this.fractal.family === "ray") this.yawT += delta;
    else this.tRot += delta;
    this.ease = 0.45;
  }

  bumpIter(delta) {
    this.autoIter = false;
    this.iterBias = clamp(this.iterBias + delta, BUDGET.minIter, BUDGET.maxIter);
    this.dirty = true;
    this.publish(true);
  }

  setPaletteSpeed(value) {
    this.paletteSpeed = clamp(value, -2, 2);
    this.publish(true);
  }

  setPower(value) {
    this.breathe = false;
    this.powerT = clamp(value, -2.5, 10);
    this.breathBase = this.powerT;
    this.publish(true);
  }

  setDensity(value) {
    this.density = clamp(value, 0.004, 0.35);
    this.publish(true);
  }

  setBailout(value) {
    this.bailT = clamp(value, 4, 1024);
    this.publish(true);
  }

  setRotation(value) {
    this.tRot = value;
    this.ease = 0.4;
    this.publish(true);
  }

  setJulia(re, im) {
    this.juliaReT = re;
    this.juliaImT = im;
    this.publish(true);
  }

  setExtra(value) {
    this.extraT = clamp(value, -2, 3);
    this.publish(true);
  }

  setBanded(value) {
    this.banded = value;
    this.publish(true);
  }

  setColorInterior(value) {
    this.colorInterior = value;
    this.publish(true);
  }

  setHelp(value) {
    this.help = value;
    this.publish(true);
  }

  randomize() {
    const index = PALETTES.findIndex((item) => item.id === "custom");
    this.paletteIndex = index < 0 ? this.paletteIndex : index;
    this.editStops(randomPalette());
    this.publish(true);
  }

  setDetail(value) {
    this.detail = clamp(value, 0.45, 1);
    this.dirty = true;
    this.publish(true);
  }

  setAnimatePalette(value) {
    this.animatePalette = value;
    this.publish(true);
  }

  setBreathe(value) {
    this.breathe = value;
    if (value) this.breathBase = this.powerT;
    this.publish(true);
  }

  setAutoIter(value) {
    this.autoIter = value;
    this.dirty = true;
    this.publish(true);
  }

  setIterBias(value) {
    this.autoIter = false;
    this.iterBias = clamp(value, BUDGET.minIter, BUDGET.maxIter);
    this.dirty = true;
    this.publish(true);
  }

  cycleBeat() {
    this.beatMode = (this.beatMode + 1) % 3;
    this.publish(true);
  }

  async toggleMic() {
    try {
      if (this.audio.active) this.audio.stop();
      else await this.audio.startMic();
      this.error = "";
    } catch (error) {
      this.error = "Microphone permission was blocked.";
    }
    this.publish(true);
  }

  resetView() {
    const home = this.fractal.home;
    this.ease = 0.85;
    if (this.fractal.family === "ray") {
      this.yawT = home.yaw;
      this.pitchT = home.pitch;
      this.distT = home.dist;
    } else {
      this.tcx = home.x;
      this.tcy = home.y;
      this.tLogR = Math.log(home.r);
      this.tRot = 0;
    }
    this.powerT = this.fractal.power;
    this.breathBase = this.fractal.power;
  }

  flyNext() {
    const list = PRESETS[this.fractal.id] || [this.fractal.home.x !== undefined ? { ...this.fractal.home, name: "Home" } : null];
    const presets = list.filter(Boolean);
    if (!presets.length) return;
    this.presetCursor = (this.presetCursor + 1) % presets.length;
    const spot = presets[this.presetCursor];
    this.ease = 0.95;
    if (spot.x !== undefined) {
      this.tcx = spot.x;
      this.tcy = spot.y;
      this.tLogR = Math.log(spot.r);
    }
    if (spot.julia) {
      this.juliaReT = spot.julia[0];
      this.juliaImT = spot.julia[1];
    }
  }

  toggleJulia() {
    const julia = FRACTALS.findIndex((item) => item.id === "julia");
    if (this.fractal.id === "julia") this.setFractal(0);
    else {
      const re = this.cx;
      const im = this.cy;
      this.setFractal(julia);
      this.juliaRe = re;
      this.juliaIm = im;
      this.juliaReT = re;
      this.juliaImT = im;
      this.dirty = true;
    }
  }

  fullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  selectStop(index) {
    this.selectedStop = index;
    this.publish(true);
  }

  moveStop(index, t) {
    if (!this.stops[index]) return;
    const next = this.stops.map((stop, i) => (i === index ? { ...stop, t: clamp(t, 0, 1) } : stop));
    next.sort((a, b) => a.t - b.t);
    this.selectedStop = next.findIndex((stop) => stop.color === this.stops[index].color && Math.abs(stop.t - clamp(t, 0, 1)) < 0.001);
    if (this.selectedStop < 0) this.selectedStop = 0;
    this.editStops(next);
    this.publish(true);
  }

  setStopColor(index, color) {
    const next = this.stops.map((stop, i) => (i === index ? { ...stop, color } : stop));
    this.editStops(next);
    this.publish(true);
  }

  recolorStop(delta) {
    const stop = this.stops[this.selectedStop];
    if (!stop) return;
    this.setStopColor(this.selectedStop, shiftHue(stop.color, delta));
  }

  addStop(t) {
    const color = this.stops[this.selectedStop]?.color || "#ffffff";
    const next = [...this.stops, { t: clamp(t, 0, 1), color }];
    next.sort((a, b) => a.t - b.t);
    this.selectedStop = next.findIndex((stop) => stop.t === clamp(t, 0, 1));
    this.editStops(next);
    this.publish(true);
  }

  removeStop(index) {
    if (this.stops.length <= 2) return;
    const next = this.stops.filter((_, i) => i !== index);
    this.selectedStop = Math.max(0, index - 1);
    this.editStops(next);
    this.publish(true);
  }

  onPointerDown(event) {
    this.canvas.focus();
    this.buttons.add(event.button);
    this.mx = event.offsetX;
    this.my = event.offsetY;
    this.alt = event.altKey;
    if (event.button === 2 || event.altKey) this.zoomTarget = -1.15;
    else if (event.button === 1 || event.shiftKey) this.drag = "pan";
    else if (this.mode === "zoom") this.zoomTarget = 1.2;
    else if (this.mode === "zoomout") this.zoomTarget = -1.15;
    else {
      this.drag = this.mode;
      if (this.mode === "julia") this.pickJulia(event);
    }
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  pickJulia(event) {
    const julia = FRACTALS.findIndex((item) => item.id === "julia");
    if (this.fractal.family === "escape" && this.fractal.id !== "julia") {
      const world = this.screenToWorld(event.offsetX, event.offsetY);
      this.setFractal(julia);
      this.juliaRe = world.x;
      this.juliaIm = world.y;
      this.juliaReT = world.x;
      this.juliaImT = world.y;
    }
  }

  onPointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const dx = x - this.mx;
    const dy = y - this.my;
    this.mx = x;
    this.my = y;
    if (!this.drag) return;
    if (this.drag === "pan") {
      if (this.fractal.family === "ray") {
        this.yaw += dx * 0.005;
        this.pitch = clamp(this.pitch - dy * 0.004, -1.15, 1.15);
        this.yawT = this.yaw;
        this.pitchT = this.pitch;
        this.dirty = true;
      } else this.panBy(dx, dy);
    } else if (this.drag === "power") this.setPower(this.powerT + dx * 0.012);
    else if (this.drag === "phase") this.phase += dx * 0.003;
    else if (this.drag === "rotate") {
      this.rotation += dx * 0.005;
      this.syncTargets();
      this.dirty = true;
    } else if (this.drag === "bail") this.setBailout(this.bailT * Math.exp(dx * 0.01));
    else if (this.drag === "iters") this.bumpIter(dx * 0.25);
    else if (this.drag === "trap") {
      this.trap = clamp(this.trap + dx * 0.004, 0, 2.5);
      this.dirty = true;
    } else if (this.drag === "julia") {
      this.juliaReT += dx * 0.0025;
      this.juliaImT -= dy * 0.0025;
    }
  }

  onPointerUp(event) {
    this.buttons.delete(event.button);
    if (!this.buttons.size) {
      this.zoomTarget = 0;
      this.drag = null;
      this.alt = false;
      return;
    }
    if (this.buttons.has(2) || this.alt) this.zoomTarget = -1.15;
    else if (this.buttons.has(0) && this.mode === "zoom") this.zoomTarget = 1.2;
    else if (this.buttons.has(0) && this.mode === "zoomout") this.zoomTarget = -1.15;
    else this.zoomTarget = 0;
  }

  onWheel(event) {
    event.preventDefault();
    const ticks = clamp(event.deltaY / 80, -3, 3);
    if (!ticks) return;
    if (event.shiftKey) this.setDensity(this.density * (ticks > 0 ? 0.92 : 1.08));
    else if (event.altKey) this.setPower(this.powerT - ticks * 0.08);
    else this.setPaletteSpeed(this.paletteSpeed - ticks * 0.02);
  }

  async onDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      await this.audio.playFile(buffer, file.name);
      this.error = "";
    } catch {
      this.error = "That file could not be decoded as audio.";
    }
    this.publish(true);
  }
}

function eventSafe() {
  /* pan helper is only used from keys */
}
