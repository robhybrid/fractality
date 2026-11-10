import { normalizeAlgo, parseAlgorithm } from "../algorithm.js";
import { BUDGET } from "../budget.js";
import { COLOR_MODES, FRACTALS, MODES, PALETTES, PRESETS, SHADE_MODES_3D, cloneStops } from "../data.js";
import { BeatListener } from "./audio.js";
import { clamp, cssGradient, fitSize, randomPalette, rasterize, shiftHue, smoothDamp } from "./color.js";
import { anchorPoint, childOffset, frameInfo, frameKey, frameSpec, renormStep } from "./frames.js";
import { angles, baseGap, basis, clampPitch, lookCamera, march, probe, orbitEye, pivotDistance, pixelRay, rayDetail, wrapAngle } from "./flight.js";
import { RAY_FOCAL, setTetraLod } from "./kernel.js";
import { MovieMaker } from "./movie.js";
import { Presenter } from "./presenter.js";
import { clearVector, isVectorShape, paintVector, rasterizeVector } from "./vector.js";
import { bigFromDecimal, bigFromDouble, bigToDecimal, bigToDouble, bitsFor, rebits } from "./deep.js";

const HOTKEY = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 0: 9 };
// Minimum on-screen diameter, in pixels, before a Sierpinski sphere splits.
// 1 is the finest the picture is allowed to get: one sphere per pixel.
const SPHERE_PX = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 36];
/** Below DEEP_ON the view center moves to a BigInt anchor and pixels are rendered by perturbation. */
const DEEP_ON = 5e-10;
const DEEP_OFF = 2e-9;
const DEEP_MIN = 1e-280;

export function createEngine(canvas, { onChange }) {
  const renderer = new Presenter(canvas);
  const audio = new BeatListener();
  const engine = new Engine(canvas, renderer, audio, onChange);
  engine.start();
  window.fractality = engine;
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
    this.sphereLevel = 0;
    this.sphereStress = 0;
    this.sphereRelax = 0;
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
    this.colorMode = 1;
    this.shade3d = "lit";
    this.colorInterior = false;
    this.deRelief = false;
    this.autoIter = true;
    this.iterBias = 48;
    this.breathe = false;
    this.breathBase = 2;
    this.beatMode = 0;
    this.beatPulse = 0;
    this.help = true;
    this.custom = false;
    this.customFractal = null;
    this.algorithm = FRACTALS[0].algorithm;
    this.algorithmOk = true;
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
    this.shift = false;
    this.buttons = new Set();
    this.touches = new Map();
    this.gesture = null;
    this.lastTap = null;
    this.alt = false;
    this.ease = 0.62;
    this.lastPublish = 0;
    this.fps = 60;
    this.error = "";
    this.view = {};
    this.frameDigits = [];
    this.frameData = null;
    this.frameSig = "";
    this.anchor = null;
    this.anchorKey = 0;
    this.iterMul = 1;
    this.deepFloor = 0;
    this.floorDepth = 0;
    this.nextFloor = 0;
    this.deepInfo = null;
    this.applyHome(FRACTALS[0], true);
    this.renderer.uploadPalette("a", rasterize(this.stops));
    this.renderer.uploadPalette("b", rasterize(this.stops));
    this.movie = new MovieMaker(this);
    this.onKey = this.onKey.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onContext = (event) => event.preventDefault();
    this.onDrop = this.onDrop.bind(this);
    this.onDragOver = (event) => event.preventDefault();
    this.onDbl = (event) => {
      // Touch double taps are handled by the gesture code; ignore the synthesized dblclick.
      if (performance.now() - (this.lastTouchAt || 0) < 900) return;
      this.nudgeZoom(event, this.mode === "zoom" && event.shiftKey ? 1.62 : 0.62);
    };
    this.onResize = () => {
      this.dirty = true;
    };
    this.wasSoft = true;
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
    this.onBlur = () => {
      if (!this.shift) return;
      this.shift = false;
      this.applyZoomHold();
    };
    window.addEventListener("blur", this.onBlur);
    this.onSelectStart = (event) => event.preventDefault();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("selectstart", this.onSelectStart);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContext);
    canvas.addEventListener("dblclick", this.onDbl);
    window.addEventListener("dragover", this.onDragOver);
    window.addEventListener("drop", this.onDrop);
    window.addEventListener("resize", this.onResize);
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(canvas);
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("vector-layer");
    this.svg.setAttribute("aria-hidden", "true");
    canvas.parentElement?.appendChild(this.svg);
    clearVector(this.svg);
  }

  /** Home views are framed for landscape; on a portrait screen widen them so the whole shape fits across. */
  portraitFit() {
    const rect = this.canvas.getBoundingClientRect?.();
    const w = rect?.width || window.innerWidth || 1;
    const h = rect?.height || window.innerHeight || 1;
    return w < h ? Math.min(3, (h / w) * 0.95) : 1;
  }

  get fractal() {
    if (this.custom && this.customFractal) return this.customFractal;
    return FRACTALS[this.fractalIndex];
  }

  start() {
    const params = new URLSearchParams(location.search);
    const once = params.has("once");
    if (params.has("re") && params.has("im")) this.goTo(params.get("re"), params.get("im"), params.get("r") || 1);
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
    this.movie.cancelExport();
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("selectstart", this.onSelectStart);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContext);
    this.canvas.removeEventListener("dblclick", this.onDbl);
    window.removeEventListener("dragover", this.onDragOver);
    window.removeEventListener("drop", this.onDrop);
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver.disconnect();
    this.audio.stop();
    this.renderer.destroy();
    this.svg?.remove();
  }

  applyHome(fractal, snapPower = true) {
    const home = fractal.home;
    this.frameDigits = [];
    this.anchor = null;
    this.deepFloor = 0;
    this.floorDepth = 0;
    this.nextFloor = 0;
    this.refreshFrame(fractal);
    if (fractal.family === "ray") {
      this.yaw = home.yaw;
      this.pitch = home.pitch;
      this.eye = orbitEye(home.yaw, home.pitch, home.dist);
      this.gapIters = null;
      this.syncFlight();
      this.cx = 0;
      this.cy = 0;
      this.radius = 1;
      this.logR = 0;
    } else {
      this.cx = home.x;
      this.cy = home.y;
      this.radius = home.r * this.portraitFit();
      this.logR = Math.log(this.radius);
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
      ...(f.family === "ray" ? { yaw: this.yawT, pitch: this.pitchT, eye: this.eyeT.slice(), gapIters: this.gapIters } : {}),
      power: this.powerT,
      bail: this.bailT,
      juliaRe: this.juliaReT,
      juliaIm: this.juliaImT,
      extra: this.extraT,
      frame: this.frameDigits.slice(),
      anchor: this.anchor,
      deepFloor: this.deepFloor,
    });
  }

  restore(mem) {
    this.frameDigits = (mem.frame || []).slice();
    this.refreshFrame();
    this.anchor = mem.anchor || null;
    this.anchorKey += 1;
    this.deepFloor = mem.deepFloor || 0;
    this.cx = mem.cx;
    this.cy = mem.cy;
    this.logR = mem.logR;
    this.radius = Math.exp(mem.logR);
    this.rotation = mem.rotation;
    const home = this.fractal.home;
    this.yaw = mem.yaw ?? home.yaw ?? 0.5;
    this.pitch = mem.pitch ?? home.pitch ?? 0.3;
    this.eye = mem.eye?.slice() ?? (this.fractal.family === "ray" ? orbitEye(this.yaw, this.pitch, home.dist) : null);
    this.gapIters = mem.gapIters ?? null;
    if (this.eye) this.syncFlight();
    this.tcx = this.cx;
    this.tcy = this.cy;
    this.tLogR = this.logR;
    this.tRot = this.rotation;
    this.vCx = this.vCy = this.vLogR = this.vRot = 0;
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

  /** The view in a form that keyframes store; applyView(v) puts it back exactly. */
  captureView() {
    return {
      frame: this.frameDigits.slice(),
      cx: this.tcx,
      cy: this.tcy,
      logR: this.tLogR,
      rotation: this.tRot || 0,
      yaw: this.yawT ?? this.yaw,
      pitch: this.pitchT ?? this.pitch,
      ...(this.fractal.family === "ray"
        ? { eye: (this.eyeT || this.eye).slice(), gap: this.flightGap(this.eyeT || this.eye), gapIters: this.gapIters }
        : {}),
    };
  }

  applyView(v, aspect = null) {
    this.frameDigits = (v.frame || []).slice();
    this.refreshFrame();
    this.cx = this.tcx = v.cx;
    this.cy = this.tcy = v.cy;
    this.logR = this.tLogR = v.logR;
    this.radius = Math.exp(v.logR);
    this.rotation = this.tRot = v.rotation || 0;
    if (v.eye) {
      this.yaw = v.yaw;
      this.pitch = v.pitch;
      this.eye = v.eye.slice();
      this.gapIters = v.gapIters ?? this.gapIters;
      this.syncFlight();
      this.flyLock = null;
      this.gap = this.flightGap();
    }
    this.vCx = this.vCy = this.vLogR = this.vRot = 0;
    this.zoomTarget = this.zoomRate = 0;
    this.renormalize(aspect);
    this.dirty = true;
  }

  setFractal(index) {
    const next = (index + FRACTALS.length) % FRACTALS.length;
    if (!this.custom && next === this.fractalIndex) return;
    this.custom = false;
    this.customFractal = null;
    this.remember();
    this.fractalIndex = next;
    const mem = this.memory.get(FRACTALS[next].id);
    if (mem) this.restore(mem);
    else this.applyHome(FRACTALS[next], true);
    this.algorithm = FRACTALS[next].algorithm;
    this.algorithmOk = true;
    this.presetCursor = 0;
    this.publish(true);
  }

  enterCustom() {
    const f = this.fractal;
    this.custom = true;
    this.algorithm = f.algorithm || "z^2+c";
    this.algorithmOk = true;
    this.customFractal = {
      ...f,
      name: "Custom",
      id: "custom",
      algorithm: this.algorithm,
    };
    this.publish(true);
  }

  exitCustom() {
    if (!this.custom) return;
    const text = this.algorithm;
    this.custom = false;
    this.customFractal = null;
    const match = FRACTALS.findIndex((item) => normalizeAlgo(item.algorithm) === normalizeAlgo(text));
    if (match >= 0) this.setFractal(match);
    else {
      this.algorithm = this.fractal.algorithm;
      this.algorithmOk = true;
      this.publish(true);
    }
  }

  setAlgorithm(text) {
    this.algorithm = text;
    const spec = parseAlgorithm(text, FRACTALS, this.customFractal || this.fractal);
    if (!spec) {
      this.algorithmOk = false;
      this.publish(true);
      return;
    }
    this.algorithmOk = true;
    const prevFamily = this.fractal.family;
    const prevFormula = this.fractal.formula;
    this.customFractal = {
      ...this.customFractal,
      ...spec,
      name: "Custom",
      id: "custom",
      algorithm: text.trim() || spec.algorithm,
      julia: spec.julia,
      extra: spec.extra,
      extraLabel: spec.extraLabel,
      extraRange: spec.extraRange,
      frame: spec.frame,
    };
    if (!spec.keepPower && spec.power != null) {
      this.power = spec.power;
      this.powerT = spec.power;
      this.breathBase = spec.power;
    }
    if (spec.bail != null) {
      this.bailout = spec.bail;
      this.bailT = spec.bail;
    }
    if (spec.julia) {
      this.juliaRe = spec.julia[0];
      this.juliaIm = spec.julia[1];
      this.juliaReT = spec.julia[0];
      this.juliaImT = spec.julia[1];
    }
    if (spec.extra != null) {
      this.extra = spec.extra;
      this.extraT = spec.extra;
    }
    if (spec.family !== prevFamily || spec.formula !== prevFormula) {
      if (spec.home) this.applyHome(this.customFractal, !spec.keepPower);
    }
    this.refreshFrame(this.customFractal);
    this.dirty = true;
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
      this.flyAt(x, y, factor);
      return;
    }
    const world = this.screenToWorld(x, y);
    this.cx = world.x + (this.cx - world.x) * factor;
    this.cy = world.y + (this.cy - world.y) * factor;
    this.logR = Math.log(clamp(this.radius * factor, this.minRadius(), BUDGET.maxRadius));
    this.radius = Math.exp(this.logR);
    if (this.fractal.frame && factor < 1) {
      const anchor = anchorPoint(this.frameData, this.cx, this.cy);
      if (anchor) {
        const pull = Math.min(1, (1 - factor) * 2.5);
        this.cx += (anchor[0] - this.cx) * pull;
        this.cy += (anchor[1] - this.cy) * pull;
      }
    }
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

  syncFlight() {
    this.eyeT = this.eye.slice();
    this.yawT = this.yaw;
    this.pitchT = this.pitch;
    this.vEye = [0, 0, 0];
    this.vYaw = this.vPitch = 0;
  }

  julia3() {
    return [this.juliaRe || 0, this.juliaIm || 0, this.extra || 0];
  }

  /** Point the tetrahedron's screen-size split at this viewpoint. */
  bindTetra(eye) {
    const tetra = this.fractal.family === "ray" && (this.fractal.formula | 0) === 3;
    if (!tetra) {
      setTetraLod(null);
      return;
    }
    const h = this.view?.viewH || this.screenSize().h || 1;
    setTetraLod(eye, Math.max(1, h) * RAY_FOCAL, SPHERE_PX[this.sphereLevel] || 1);
  }

  flightGap(eye = this.eye) {
    const f = this.fractal;
    const [jx, jy, jz] = this.julia3();
    const lodKey = (f.formula | 0) === 3 ? `:${this.sphereLevel}:${Math.round(this.view?.viewH || 0)}` : "";
    const key = `${f.id}:${Math.round(this.power * 1000)}:${Math.round(jx * 1e4)}:${Math.round(jy * 1e4)}:${Math.round(jz * 1e4)}${lodKey}`;
    if (this.homeKey !== key) {
      this.homeKey = key;
      this.bindTetra(orbitEye(f.home.yaw, f.home.pitch, f.home.dist));
      this.homeGap = baseGap(orbitEye(f.home.yaw, f.home.pitch, f.home.dist), f.formula, this.power, jx, jy, jz);
    }
    this.bindTetra(eye);
    const found = probe(eye, f.formula, this.power, this.homeGap, this.gapIters, jx, jy, jz);
    if (eye === this.eye) this.gapIters = found.iters;
    return found.gap;
  }

  /** Continuous zoom: fly along the ray under the cursor and steer the view toward it. */
  flyAt(x, y, factor) {
    const { w, h } = this.screenSize();
    this.bindTetra(this.eye);
    const cam = lookCamera(this.eye, this.yaw, this.pitch);
    const gap = this.gap ?? this.flightGap();
    if (factor < 1) {
      const k = 1 - factor;
      let lock = this.flyLock;
      let toward = lock?.point ? lock.point.map((v, i) => v - this.eye[i]) : null;
      const reach = toward ? Math.hypot(...toward) : 0;
      if (!lock || lock.iters !== this.gapIters || Math.hypot(x - lock.x, y - lock.y) > 2 || (toward && reach < gap * 1.5)) {
        const ray = pixelRay(cam, (x / w) * 2 - 1, 1 - (y / h) * 2, w / h);
        const f = this.fractal;
        const [jx, jy, jz] = this.julia3();
        const t = march(this.eye, ray, f.formula, this.power, this.gapIters, 300, jx, jy, jz);
        lock = this.flyLock = { x, y, ray, iters: this.gapIters, point: t > 0 ? this.eye.map((v, i) => v + ray[i] * t) : null };
        toward = lock.point ? ray : null;
      }
      // Aiming at a surface point: fly to it and turn it toward the center. Aiming at empty space: drift along the ray.
      const dir = toward ? toward.map((v) => v / (Math.hypot(...toward) || 1)) : pixelRay(cam, (x / w) * 2 - 1, 1 - (y / h) * 2, w / h);
      // The marched ray is clear up to the locked point, so the approach can follow the distance left along it.
      const left = toward ? Math.hypot(...toward) : 0;
      if (gap > BUDGET.minGap) {
        const move = Math.min(gap * 4, Math.max(gap * 0.8, left * 0.7)) * k;
        this.eye = clampEye(this.eye.map((v, i) => v + dir[i] * move));
      }
      if (toward) {
        const aim = angles(dir);
        this.yaw += wrapAngle(aim.yaw - this.yaw) * k * 0.3;
        this.pitch = clampPitch(this.pitch + (aim.pitch - this.pitch) * k * 0.3);
      }
    } else {
      const move = Math.max(gap, this.homeGap * 0.02) * (factor - 1) * 0.8;
      this.eye = clampEye(this.eye.map((v, i) => v - cam.forward[i] * move));
    }
    this.gap = this.flightGap();
    this.syncFlight();
  }

  /** Eased move along the view direction by a fraction of the gap (negative backs away). */
  flyBy(fraction, x = null, y = null, turn = 0) {
    const gap = this.flightGap(this.eyeT);
    const cam = lookCamera(this.eyeT, this.yawT, this.pitchT);
    let dir = cam.forward;
    if (x !== null) {
      const { w, h } = this.screenSize();
      dir = pixelRay(cam, (x / w) * 2 - 1, 1 - (y / h) * 2, w / h);
      const aim = angles(dir);
      this.yawT += wrapAngle(aim.yaw - this.yawT) * turn;
      this.pitchT = clampPitch(this.pitchT + (aim.pitch - this.pitchT) * turn);
    }
    const move = fraction > 0 ? (gap > BUDGET.minGap ? gap * Math.min(fraction, 0.85) : 0) : Math.max(gap, this.homeGap * 0.02) * fraction;
    this.eyeT = clampEye(this.eyeT.map((v, i) => v + dir[i] * move));
  }

  orbitPivot(eye, yaw, pitch) {
    const f = this.fractal;
    const gap = this.flightGap(eye);
    const [jx, jy, jz] = this.julia3();
    const r = pivotDistance(eye, yaw, pitch, f.formula, this.power, gap, this.gapIters, jx, jy, jz);
    const { forward } = basis(yaw, pitch);
    return { r, point: eye.map((v, i) => v + forward[i] * r) };
  }

  /** Eased orbit around the point under the screen center. */
  orbitBy(dYaw, dPitch) {
    const pivot = this.orbitPivot(this.eyeT, this.yawT, this.pitchT);
    this.yawT += dYaw;
    this.pitchT = clampPitch(this.pitchT + dPitch);
    const { forward } = basis(this.yawT, this.pitchT);
    this.eyeT = clampEye(pivot.point.map((v, i) => v - forward[i] * pivot.r));
  }

  camKey() {
    const q = Math.max(this.gap || 0, BUDGET.minGap) * 2e-4;
    return `${this.eye.map((v) => Math.round(v / q)).join(",")}:${Math.round(this.yaw * 1e5)}:${Math.round(this.pitch * 1e5)}`;
  }

  nudgeZoom(event, factor) {
    if (this.fractal.family === "ray") {
      this.flyBy(1 - factor, event?.offsetX ?? this.mx, event?.offsetY ?? this.my, 0.3);
      this.ease = 0.7;
      return;
    }
    const world = this.screenToWorld(event?.offsetX ?? this.mx, event?.offsetY ?? this.my);
    this.tcx = world.x + (this.cx - world.x) * factor;
    this.tcy = world.y + (this.cy - world.y) * factor;
    this.tLogR = Math.log(clamp(this.radius * factor, this.minRadius(), BUDGET.maxRadius));
    this.ease = 0.7;
  }

  effectiveIters(iterScale = this.iterScale, screenH = 0) {
    const f = this.fractal;
    if (f.family === "shape") {
      const h = screenH || this.screenSize().h;
      const per = f.frame === "square" || f.formula === 14 || f.formula === 15 ? Math.log(3) : Math.log(2);
      return Math.max(3, Math.round(this.frameDigits.length + Math.log(h / (2 * this.radius)) / per + 3));
    }
    const deep = this.deepCapable();
    let wanted = this.iterBias;
    if (this.autoIter && f.family !== "ray") {
      const base = f.home.r || 1.35;
      const zoom = Math.max(0, Math.log2(base / Math.max(this.radius, deep ? DEEP_MIN : 1e-8)));
      wanted = f.family === "shape" ? 6 + zoom * 0.4 : 40 + zoom * 8;
      if (this.anchor) {
        // A floor learned at some depth keeps growing in step with the zoom past it.
        const grow = this.floorDepth > 0 && zoom > this.floorDepth ? zoom / this.floorDepth : 1;
        wanted = Math.max(wanted, this.deepFloor * grow);
        // Steps of ~9%, so a deep frame in progress is not restarted for a one-iteration change every display frame.
        wanted = 2 ** (Math.round(Math.log2(Math.max(1, wanted)) * 8) / 8);
      }
      wanted *= this.iterMul;
    }
    if (f.family === "ray") wanted = BUDGET.defaultSteps;
    const cap = f.family === "ray" ? BUDGET.maxSteps : deep ? BUDGET.maxDeepIter : BUDGET.maxIter;
    return Math.round(clamp(wanted * iterScale, f.family === "ray" ? BUDGET.minSteps : BUDGET.minIter, cap));
  }

  frame(now) {
    const dt = clamp((now - this.last) / 1000, 0, 0.05);
    this.last = now;
    this.time += dt;
    this.frameEma = this.frameEma * 0.9 + dt * 1000 * 0.1;
    this.fps = 1000 / Math.max(1, this.frameEma);
    if (this.movie.exporting) {
      this.publish(false);
      return;
    }
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
    const playing = this.movie.tick(dt);
    const holding = this.buttons.size > 0;
    this.zoomRate += (this.zoomTarget - this.zoomRate) * (1 - Math.exp(-8 * dt));
    if (this.fractal.family === "ray") this.gap = this.flightGap();
    let geometry = false;
    if (Math.abs(this.zoomRate) > 0.01) {
      this.zoomAt(this.mx, this.my, Math.exp(-this.zoomRate * dt));
      geometry = true;
    } else if (!holding && !playing) {
      geometry = this.easeView(dt) || geometry;
    }
    this.renormalize();
    this.deepSync();
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
    const soft = playing || holding || Math.abs(this.zoomRate) > 0.02 || this.breathe || this.moving();
    if (soft && !this.wasSoft && this.nextFloor && this.anchor) {
      this.deepFloor = Math.max(this.deepFloor, Math.min(BUDGET.maxDeepIter, this.nextFloor));
      this.floorDepth = this.zoomOctaves();
    }
    if (soft !== this.wasSoft) {
      this.nextFloor = 0;
      this.dirty = true;
      this.wasSoft = soft;
    }
    if (!this.moving() && Math.abs(this.zoomRate) < 0.02 && !this.breathe) this.ease = 0.62;
    this.draw(soft);
    this.publish(false, sound);
  }

  minRadius() {
    if (this.fractal.frame) return 1e-280;
    if (this.deepCapable()) return DEEP_MIN;
    return 1e-13 * Math.max(1, Math.abs(this.cx), Math.abs(this.cy));
  }

  /** Mandelbrot and Julia at power 2 can zoom past double precision. */
  deepCapable() {
    const f = this.fractal;
    return f.family === "escape" && (f.formula === 0 || f.formula === 1) && Math.abs(this.power - 2) < 0.0008 && Math.abs(this.powerT - 2) < 0.0008;
  }

  /**
   * While anchored, cx/cy (and their targets) are offsets from the BigInt
   * anchor. The anchor absorbs the offset whenever it grows large next to
   * the radius, so offsets keep full double precision at any depth.
   */
  deepSync() {
    const want = this.deepCapable() && this.radius < (this.anchor ? DEEP_OFF : DEEP_ON);
    if (want && !this.anchor) {
      const bits = bitsFor(this.radius) + 32;
      this.anchor = { x: bigFromDouble(this.cx, bits), y: bigFromDouble(this.cy, bits), bits, key: ++this.anchorKey };
      this.shiftView(this.cx, this.cy);
    } else if (!want && this.anchor) {
      const [ax, ay] = this.anchorDouble();
      this.anchor = null;
      this.deepFloor = 0;
      this.floorDepth = 0;
      this.nextFloor = 0;
        this.shiftView(-ax, -ay);
      const floor = Math.log(this.minRadius());
      if (this.logR < floor) {
        this.logR = floor;
        this.radius = Math.exp(floor);
      }
      this.tLogR = Math.max(this.tLogR, floor);
    } else if (this.anchor) {
      const need = bitsFor(this.radius) + 32;
      const far = Math.max(Math.abs(this.cx), Math.abs(this.cy)) > this.radius * 1e4;
      if (far || need > this.anchor.bits) {
        const a = this.anchor;
        const bits = Math.max(a.bits, need);
        const x = rebits(a.x, a.bits, bits) + bigFromDouble(this.cx, bits);
        const y = rebits(a.y, a.bits, bits) + bigFromDouble(this.cy, bits);
        this.anchor = { x, y, bits, key: a.key };
        this.shiftView(this.cx, this.cy);
      }
    }
  }

  shiftView(dx, dy) {
    if (!dx && !dy) return;
    this.cx -= dx;
    this.cy -= dy;
    this.tcx -= dx;
    this.tcy -= dy;
    this.renderer.shiftOrigin?.(dx, dy);
  }

  anchorDouble() {
    const a = this.anchor;
    return a ? [bigToDouble(a.x, a.bits), bigToDouble(a.y, a.bits)] : [0, 0];
  }

  absolute(x, y) {
    const [ax, ay] = this.anchorDouble();
    return [ax + x, ay + y];
  }

  relative(x, y) {
    const [ax, ay] = this.anchorDouble();
    return [x - ax, y - ay];
  }

  /** Jump to a location given as decimal strings, deep or not. */
  goTo(re, im, r) {
    const radius = clamp(Number(r) || 1, this.minRadius(), BUDGET.maxRadius);
    this.toRoot();
    this.anchor = null;
    this.deepFloor = 0;
    this.floorDepth = 0;
    this.nextFloor = 0;
    if (this.deepCapable() && radius < DEEP_ON) {
      const digits = Math.max(String(re).length, String(im).length);
      const bits = Math.max(bitsFor(radius) + 32, Math.ceil(digits * 3.33) + 16);
      this.anchor = { x: bigFromDecimal(re, bits), y: bigFromDecimal(im, bits), bits, key: ++this.anchorKey };
      this.cx = 0;
      this.cy = 0;
    } else {
      this.cx = Number(re) || 0;
      this.cy = Number(im) || 0;
    }
    this.radius = radius;
    this.logR = Math.log(radius);
    this.syncTargets();
    this.dirty = true;
    this.publish(true);
  }

  /** Decimal center with enough digits for the current zoom. */
  centerText() {
    const digits = Math.max(6, Math.ceil(-Math.log10(this.radius)) + 3);
    if (!this.anchor) return [this.cx.toFixed(Math.min(digits, 17)), this.cy.toFixed(Math.min(digits, 17))];
    const a = this.anchor;
    const x = a.x + bigFromDouble(this.cx, a.bits);
    const y = a.y + bigFromDouble(this.cy, a.bits);
    return [bigToDecimal(x, a.bits, digits), bigToDecimal(y, a.bits, digits)];
  }

  refreshFrame(fractal = this.fractal) {
    this.frameData = fractal.frame ? frameInfo(fractal.frame, this.frameDigits) : null;
    this.frameSig = fractal.frame ? frameKey(this.frameDigits) : "";
  }

  reframe(S, ox, oy) {
    const map = (x, y) => [(x - ox) * S, (y - oy) * S];
    [this.cx, this.cy] = map(this.cx, this.cy);
    [this.tcx, this.tcy] = map(this.tcx, this.tcy);
    this.logR += Math.log(S);
    this.radius = Math.exp(this.logR);
    this.tLogR += Math.log(S);
    this.vCx *= S;
    this.vCy *= S;
    this.renderer.reframe?.(S, ox, oy);
  }

  renormalize(aspect = null) {
    const kind = this.fractal.frame;
    if (!kind) return;
    const { w, h } = this.screenSize();
    const corner = Math.hypot(1, aspect || w / h);
    let changed = false;
    for (let guard = 0; guard < 2048; guard += 1) {
      const step = renormStep(kind, this.frameDigits, this.cx, this.cy, this.radius * corner);
      if (!step) break;
      this.frameDigits = step.digits;
      this.reframe(step.S, step.ox, step.oy);
      changed = true;
    }
    if (changed) this.refreshFrame();
  }

  zoomLog10() {
    const f = this.fractal;
    if (f.family === "ray") return 0;
    const scale = f.frame ? frameSpec(f.frame).scale : 1;
    return this.frameDigits.length * Math.log10(scale) + Math.log10((f.home.r || 1) / this.radius);
  }

  toRoot() {
    const kind = this.fractal.frame;
    if (!kind) return;
    const spec = frameSpec(kind);
    while (this.frameDigits.length) {
      const [ox, oy] = childOffset(kind, this.frameDigits.pop());
      this.reframe(1 / spec.scale, -ox * spec.scale, -oy * spec.scale);
    }
    this.refreshFrame();
  }

  moving() {
    let flight = 0;
    if (this.fractal.family === "ray" && this.vEye) {
      flight = Math.abs(this.vYaw) + Math.abs(this.vPitch) + (Math.hypot(...this.vEye) / Math.max(this.gap || 0, BUDGET.minGap)) * 0.02;
    }
    return Math.abs(this.vCx) + Math.abs(this.vCy) + Math.abs(this.vLogR) + Math.abs(this.vRot) + flight > 0.0004;
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
      [this.yaw, this.vYaw] = step(this.yaw, this.yawT, this.vYaw);
      [this.pitch, this.vPitch] = step(this.pitch, this.pitchT, this.vPitch);
      const tiny = Math.max(this.gap || 0, BUDGET.minGap) * 1e-5;
      for (let i = 0; i < 3; i += 1) {
        const [next, v] = smoothDamp(this.eye[i], this.eyeT[i], this.vEye[i], smooth, dt);
        if (Math.abs(next - this.eye[i]) > tiny) changed = true;
        this.eye[i] = next;
        this.vEye[i] = v;
      }
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
    this.adaptSphere();
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

  /**
   * While the tetrahedron is on screen, a slow frame means spheres have to
   * cover more pixels before they split. A run of fast frames walks that
   * requirement back toward one pixel, which is the finest split allowed.
   */
  adaptSphere() {
    const tetra = this.fractal.family === "ray" && (this.fractal.formula | 0) === 3;
    if (!tetra) {
      this.sphereStress = 0;
      this.sphereRelax = 0;
      return;
    }
    const ms = this.frameEma;
    if (ms > 40) {
      this.sphereRelax = 0;
      this.sphereStress += 1;
      if (this.sphereStress >= 3 && this.sphereLevel < SPHERE_PX.length - 1) {
        this.sphereLevel += ms > 70 && this.sphereLevel < SPHERE_PX.length - 2 ? 2 : 1;
        this.sphereStress = 0;
      }
    } else if (ms < 18) {
      this.sphereStress = 0;
      this.sphereRelax += 1;
      if (this.sphereRelax >= 36 && this.sphereLevel > 0) {
        this.sphereLevel -= 1;
        this.sphereRelax = 0;
      }
    } else {
      this.sphereStress = Math.max(0, this.sphereStress - 1);
      this.sphereRelax = 0;
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
      if (this.fractal.family === "ray") this.flyBy(0.1);
      else this.tLogR = Math.log(clamp(this.radius * 0.94, this.minRadius(), BUDGET.maxRadius));
      this.ease = 0.22;
    }
  }

  /**
   * The state the presenter renders. With `size` it describes an offline
   * export frame at exactly that many pixels, ignoring the frame-rate governor.
   */
  renderState(soft, size = null) {
    const offline = !!size;
    const { w, h } = size || this.screenSize();
    const family = this.fractal.family;
    const iterScale = offline ? 1 : this.iterScale;
    const quality = offline ? 1 : this.detail * this.pixelScale;
    const cap = (family === "ray" ? BUDGET.maxPixels3d : family === "ifs" ? BUDGET.maxPixelsIfs : BUDGET.maxPixels2d) * quality;
    const [texW, texH] = offline ? [w, h] : fitSize(w, h, cap);
    const viewCap = soft ? texW * texH * BUDGET.interactArea : texW * texH;
    const [viewW, viewH] = soft ? fitSize(texW, texH, viewCap) : [texW, texH];
    const ray = family === "ray" ? rayDetail(this.fractal.formula, this.gap ?? this.flightGap(), this.homeGap, iterScale * (soft ? 0.7 : 1), this.gapIters) : null;
    const iters = ray ? ray.steps : this.effectiveIters(iterScale, offline ? h : 0);
    const upscale = Math.max(w / viewW, h / viewH);
    const blur = soft ? 0.28 : 0;
    return {
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
      iters,
      steps: ray ? ray.steps : BUDGET.defaultSteps,
      rayIters: ray ? ray.iters : 0,
      spherePx: (this.fractal.formula | 0) === 3 ? (offline ? 1 : SPHERE_PX[this.sphereLevel] || 1) : 0,
      trap: this.trap,
      skipInterior: this.skipInterior,
      ifsPoints: Math.round(BUDGET.maxIfsPoints * quality),
      ifsIters: 18,
      camera: ray ? lookCamera(this.eye, this.yaw, this.pitch) : null,
      camKey: ray ? this.camKey() : "",
      gap: ray ? this.gap ?? 0 : 0,
      frame: this.frameData,
      frameKey: this.frameSig,
      deep: this.anchor ? { ax: this.anchor.x, ay: this.anchor.y, bits: this.anchor.bits, key: this.anchor.key } : null,
      keepCont: !!this.anchor && this.autoIter && !soft && !offline,
      phase: this.phase,
      density: this.density,
      soft,
      quality,
      blur,
      edge: this.post === 0 ? 0 : this.edge,
      beat: offline ? 0 : this.beatPulse,
      exposure: this.exposure,
      palMix: this.palMix,
      colorInterior: this.colorInterior,
      post: this.post,
      colorMode: this.distanceMode() ? 1 : this.colorMode,
      shade3d: this.shade3d,
      ...this.distanceState(),
      capture: offline ? false : this.capture,
    };
  }

  draw(soft) {
    if (isVectorShape(this.fractal)) {
      this.drawVector();
      return;
    }
    clearVector(this.svg);
    const state = this.renderState(soft);
    const { texW, texH, viewW, viewH, iters, blur } = state;
    let pixels = null;
    try {
      pixels = this.renderer.render(state);
      this.error = "";
    } catch (error) {
      this.error = error.message || String(error);
      this.publish(true);
      return;
    }
    this.dirty = !!pixels?.pending;
    if (pixels?.deepInfo) this.adaptDeep(pixels.deepInfo, iters);
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

  /** Crisp SVG for Sierpinski / Koch — no bitmap blur, detail to the pixel. */
  drawVector() {
    const { w, h } = this.screenSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#07080c";
      ctx.fillRect(0, 0, bw, bh);
    }
    const state = {
      cssW: w,
      cssH: h,
      formula: this.fractal.formula,
      cx: this.cx,
      cy: this.cy,
      radius: this.radius,
      rotation: this.rotation || 0,
      frame: this.frameData,
      phase: this.phase,
      density: this.density,
      exposure: this.exposure,
      beat: this.beatPulse,
    };
    try {
      paintVector(this.svg, state, this.stops);
      this.error = "";
    } catch (error) {
      this.error = error.message || String(error);
    }
    this.dirty = false;
    this.view = { texW: w, texH: h, viewW: w, viewH: h, iters: this.effectiveIters(), blur: 0 };
    if (this.capture) {
      rasterizeVector(state, this.stops, document.createElement("canvas"))
        .then((image) => this.download({ pixels: image.data, w: image.width, h: image.height, flip: false }))
        .catch(() => {});
      this.capture = false;
    }
    if (this.renderer.label !== "SVG") {
      this.renderer.label = "SVG";
      this.publish(true);
    }
  }

  /**
   * Deep views need far more iterations than the zoom formula guesses, and
   * how many depends on the spot. When the slowest escaping pixels get close
   * to the limit, raise it; drop it again when escapes finish far below.
   */
  zoomOctaves() {
    return Math.max(1, Math.log2((this.fractal.home.r || 1.35) / this.radius));
  }

  /**
   * Deep views need far more iterations than the zoom formula guesses, and
   * how many depends on the spot. Moving frames raise the limit when escapes
   * reach near it, or when most of the view is still undecided while escapes
   * are happening (bounded, so a view full of interior cannot run away).
   * Settled frames are carried further by continuation passes; what they
   * learn becomes the starting limit the next time the view moves.
   */
  adaptDeep(info, iters) {
    if (info.serial === this.deepInfo?.serial) return;
    this.deepInfo = info;
    if (!this.anchor || !this.autoIter) return;
    const quant = (v) => 2 ** (Math.ceil(Math.log2(Math.max(1, v)) * 4) / 4);
    const scale = this.iterMul * this.iterScale;
    if (info.contEscHi) {
      if (info.contEscHi * 1.25 > iters) this.nextFloor = quant((info.contEscHi * 1.25) / scale);
      return;
    }
    // Settled frames are carried on by continuation, which only revisits the undecided pixels.
    if (info.iters !== iters || !info.soft) return;
    const depth = this.zoomOctaves();
    let want = iters;
    if (info.escHi > iters * 0.55) want = Math.min(info.escHi * 2, iters * 2);
    else if (info.unresolved > 0.2) want = iters * 1.3;
    else if (info.escHi * 2.5 < iters * 0.6 && info.unresolved < 0.002) want = Math.max(info.escHi * 2.5, BUDGET.minIter);
    const cap = Math.max((40 + depth * 8) * 8, this.deepFloor);
    const next = Math.min(BUDGET.maxDeepIter, cap, quant(want / scale));
    if (Math.abs(next - this.deepFloor) > 1 && Math.abs(want - iters) > iters * 0.1) {
      this.deepFloor = next;
      this.floorDepth = depth;
      this.dirty = true;
    }
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
      custom: this.custom,
      algorithm: this.algorithm,
      algorithmOk: this.algorithmOk,
      count: FRACTALS.length,
      mode: this.mode,
      modeLabel: mode?.label || this.mode,
      modeBlurb: mode?.blurb || "",
      fps: Math.round(this.fps),
      throttled: this.throttled,
      backend: this.renderer.label || "CPU",
      antialiased: isVectorShape(this.fractal) ? true : !!this.renderer.shown?.buf.cover,
      contIters: this.anchor ? this.renderer.shown?.contIters || 0 : 0,
      contEscHi: this.anchor && this.renderer.shown?.contIters ? Math.round(this.renderer.deepInfo?.contEscHi || 0) : 0,
      contDone: !!this.renderer.shown?.contDone,
      phase: this.phase,
      viewW: this.view.viewW || 0,
      viewH: this.view.viewH || 0,
      iters: this.view.iters || 0,
      power: this.powerT,
      powerMin: this.powerMin(),
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
      usesJulia: !!f.julia,
      canPickJulia: f.id === "mandelbrot",
      extraLabel: f.extraLabel || null,
      extraRange: f.extraRange || [-2, 2],
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
      colorMode: this.colorMode,
      colorModes: COLOR_MODES,
      shade3d: this.shade3d,
      shadeModes: SHADE_MODES_3D,
      deRelief: this.deRelief,
      detail: this.detail,
      paused: this.paused,
      stops: this.stops,
      gradient: cssGradient(this.stops),
      selectedStop: this.selectedStop,
      cx: this.absolute(this.cx, this.cy)[0],
      cy: this.absolute(this.cx, this.cy)[1],
      deep: !!this.anchor,
      center: this.anchor ? this.centerText() : null,
      iterMul: this.iterMul,
      maxIter: this.deepCapable() ? BUDGET.maxDeepIter : BUDGET.maxIter,
      deepInfo: this.deepInfo,
      radius: this.radius,
      frameDepth: this.frameDigits.length,
      zoomLog10: this.zoomLog10(),
      yaw: this.yaw || 0,
      pitch: this.pitch || 0,
      dist: this.eye ? Math.hypot(...this.eye) : 0,
      gap: f.family === "ray" ? this.gap || 0 : 0,
      fractals: FRACTALS.map((item, index) => ({ index, name: item.name, hotkey: item.hotkey || "" })),
      palettes: PALETTES.map((item, index) => ({ index, name: item.name })),
      modes: MODES,
      movie: this.movie.snapshot(),
    });
  }

  typing(event) {
    const tag = event.target?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
  }

  onKeyUp(event) {
    if (event.key !== "Shift") return;
    this.shift = false;
    this.applyZoomHold();
  }

  /** Left-button zoom follows the mode. In Zoom, Shift backs out instead of diving in. */
  applyZoomHold() {
    if (this.buttons.has(2) || this.alt) this.zoomTarget = BUDGET.zoomOut;
    else if (this.buttons.has(0) && this.mode === "zoom") this.zoomTarget = this.shift ? BUDGET.zoomOut : BUDGET.zoomIn;
    else if (this.buttons.has(0) && this.mode === "zoomout") this.zoomTarget = BUDGET.zoomOut;
    else this.zoomTarget = 0;
  }

  onKey(event) {
    if (event.key === "Shift") {
      this.shift = true;
      this.applyZoomHold();
      return;
    }
    if (this.typing(event)) return;
    const key = event.key;
    if (this.movie.exporting) {
      if (key === "Escape") this.movie.cancelExport();
      if (key !== "h" && key !== "H") return;
    }
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
      if (this.movie.playing) this.movie.stop();
      else this.setMode("zoom");
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
      if (this.fractal.family === "ray") this.cycleShade3d(event.shiftKey ? -1 : 1);
      else this.setColorMode(this.colorMode + (event.shiftKey ? -1 : 1));
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
    else if (key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) this.movie.addKey();
    else if (key === "/") this.movie.togglePlay();
  }

  nudgePan(sx, sy) {
    eventSafe();
    if (this.fractal.family === "ray") {
      this.orbitBy(sx * 0.08, sy * 0.06);
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
    if (this.fractal.family === "ray") this.flyBy((1 - factor) * 1.4);
    else this.tLogR = Math.log(clamp(Math.exp(this.tLogR) * factor, this.minRadius(), BUDGET.maxRadius));
    this.ease = 0.55;
  }

  bumpRot(delta) {
    if (this.fractal.family === "ray") this.orbitBy(delta, 0);
    else this.tRot += delta;
    this.ease = 0.45;
  }

  bumpIter(delta) {
    if (this.autoIter) this.iterBias = this.effectiveIters();
    this.autoIter = false;
    const cap = this.deepCapable() ? BUDGET.maxDeepIter : BUDGET.maxIter;
    this.iterBias = Math.round(clamp(this.iterBias * Math.exp(delta / 80), BUDGET.minIter, cap));
    this.dirty = true;
    this.publish(true);
  }

  setPaletteSpeed(value) {
    this.paletteSpeed = clamp(value, -2, 2);
    this.publish(true);
  }

  /** Mandelbox reads power as its fold scale, which is usually negative. */
  powerMin() {
    return this.fractal.id === "box" ? -2.5 : 1;
  }

  setPower(value) {
    this.breathe = false;
    this.powerT = clamp(value, this.powerMin(), 10);
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

  setColorMode(value) {
    this.colorMode = (value + COLOR_MODES.length) % COLOR_MODES.length;
    this.publish(true);
  }

  setShade3d(id) {
    if (!SHADE_MODES_3D.some((item) => item.id === id)) return;
    this.shade3d = id;
    this.dirty = true;
    this.publish(true);
  }

  cycleShade3d(step) {
    const i = SHADE_MODES_3D.findIndex((item) => item.id === this.shade3d);
    this.setShade3d(SHADE_MODES_3D[(i + step + SHADE_MODES_3D.length) % SHADE_MODES_3D.length].id);
  }

  distanceMode() {
    return COLOR_MODES[this.colorMode]?.id === "distance";
  }

  /** Distance estimation is computed for the Distance color mode, or for relief shading over any mode. */
  distanceState() {
    const distance = this.distanceMode();
    if (!distance && !this.deRelief) return { dem: false, deShade: "" };
    return { dem: true, deKoebe: distance, deShade: distance ? "distance" : "relief" };
  }

  setDeRelief(value) {
    this.deRelief = value;
    this.publish(true);
  }

  setColorInterior(value) {
    this.colorInterior = value;
    this.publish(true);
  }

  setHidden(value) {
    this.hidden = !!value;
    this.publish(true);
  }

  togglePause() {
    this.paused = !this.paused;
    this.publish(true);
  }

  savePng() {
    this.capture = true;
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
    this.iterBias = Math.round(clamp(value, BUDGET.minIter, this.deepCapable() ? BUDGET.maxDeepIter : BUDGET.maxIter));
    this.dirty = true;
    this.publish(true);
  }

  setIterMul(value) {
    this.iterMul = clamp(value, 0.25, 8);
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
    this.toRoot();
    const home = this.fractal.home;
    this.ease = 0.85;
    if (this.fractal.family === "ray") {
      this.yawT = this.yaw + wrapAngle(home.yaw - this.yaw);
      this.pitchT = home.pitch;
      this.eyeT = orbitEye(this.yawT, home.pitch, home.dist);
    } else {
      [this.tcx, this.tcy] = this.relative(home.x, home.y);
      this.tLogR = Math.log(home.r);
      this.tRot = 0;
    }
    this.powerT = this.fractal.power;
    this.breathBase = this.fractal.power;
  }

  flyNext() {
    this.toRoot();
    const list = PRESETS[this.fractal.id] || [this.fractal.home.x !== undefined ? { ...this.fractal.home, name: "Home" } : null];
    const presets = list.filter(Boolean);
    if (!presets.length) return;
    this.presetCursor = (this.presetCursor + 1) % presets.length;
    const spot = presets[this.presetCursor];
    this.ease = 0.95;
    if (spot.x !== undefined) {
      [this.tcx, this.tcy] = this.relative(spot.x, spot.y);
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
      const [re, im] = this.absolute(this.cx, this.cy);
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
    if (event.pointerType === "touch") {
      this.touchDown(event);
      return;
    }
    this.canvas.focus();
    this.flyLock = null;
    this.movie.stop();
    this.buttons.add(event.button);
    this.mx = event.offsetX;
    this.my = event.offsetY;
    this.alt = event.altKey;
    this.shift = event.shiftKey;
    const reverseZoom = this.mode === "zoom" && event.shiftKey;
    if (event.button === 2 || event.altKey) this.zoomTarget = BUDGET.zoomOut;
    else if ((event.button === 1 || event.shiftKey) && !reverseZoom) {
      this.drag = "pan";
      if (this.fractal.family === "ray") this.pivot = this.orbitPivot(this.eye, this.yaw, this.pitch);
    }
    else if (this.mode === "zoom") this.zoomTarget = reverseZoom ? BUDGET.zoomOut : BUDGET.zoomIn;
    else if (this.mode === "zoomout") this.zoomTarget = BUDGET.zoomOut;
    else {
      this.drag = this.mode;
      if (this.mode === "julia") this.pickJulia(event);
    }
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  /*
   * Touch: one finger drags (pan, orbit in 3D, or the current mode's drag),
   * holding still dives toward the finger, a double tap zooms in a step.
   * Two fingers pinch to zoom (fly in 3D), twist to rotate, and a quick
   * two-finger tap zooms out a step.
   */
  touchPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  pinchState() {
    const [a, b] = [...this.touches.values()];
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  touchDown(event) {
    this.lastTouchAt = performance.now();
    this.canvas.setPointerCapture?.(event.pointerId);
    this.movie.stop();
    this.flyLock = null;
    const p = this.touchPoint(event);
    this.touches.set(event.pointerId, p);
    this.buttons.add("touch");
    const now = performance.now();
    clearTimeout(this.holdTimer);
    if (this.touches.size === 1) {
      this.mx = p.x;
      this.my = p.y;
      const tap = this.lastTap;
      this.gesture = { kind: "one", start: p, t0: now, moved: false, double: !!tap && now - tap.t < 320 && Math.hypot(tap.x - p.x, tap.y - p.y) < 40 };
      this.holdTimer = setTimeout(() => {
        const g = this.gesture;
        if (g?.kind === "one" && !g.moved && this.touches.size === 1 && ["zoom", "zoomout", "pan"].includes(this.mode)) {
          g.kind = "hold";
          this.zoomTarget = this.mode === "zoomout" ? BUDGET.zoomOut : BUDGET.zoomIn;
        }
      }, 260);
    } else if (this.touches.size === 2) {
      this.zoomTarget = 0;
      this.drag = null;
      this.gesture = { kind: "pinch", t0: now, moved: false, travel: 0, ...this.pinchState() };
    }
  }

  touchMove(event) {
    const p = this.touchPoint(event);
    this.touches.set(event.pointerId, p);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "hold") {
      this.mx = p.x;
      this.my = p.y;
      return;
    }
    if (g.kind === "one") {
      if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) < 9) return;
      if (!g.moved) {
        g.moved = true;
        clearTimeout(this.holdTimer);
        this.drag = ["zoom", "zoomout", "pan"].includes(this.mode) ? "pan" : this.mode;
        if (this.drag === "julia") this.pickJulia({ offsetX: p.x, offsetY: p.y });
      }
      this.pointerDrag(event);
      return;
    }
    if (g.kind !== "pinch" || this.touches.size < 2) return;
    const s = this.pinchState();
    const factor = g.dist / Math.max(1, s.dist);
    g.travel += Math.abs(Math.log(factor)) * 200 + Math.hypot(s.cx - g.cx, s.cy - g.cy);
    if (g.travel > 12) g.moved = true;
    this.mx = s.cx;
    this.my = s.cy;
    if (this.fractal.family === "ray") {
      if (Math.abs(factor - 1) > 1e-4) this.zoomAt(s.cx, s.cy, factor);
    } else {
      this.mx = g.cx;
      this.my = g.cy;
      this.panBy(s.cx - g.cx, s.cy - g.cy);
      this.mx = s.cx;
      this.my = s.cy;
      if (Math.abs(factor - 1) > 1e-4) this.zoomAt(s.cx, s.cy, factor);
      let turn = s.angle - g.angle;
      turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.abs(turn) > 1e-4) {
        const before = this.screenToWorld(s.cx, s.cy);
        this.rotation -= turn;
        const after = this.screenToWorld(s.cx, s.cy);
        this.cx += before.x - after.x;
        this.cy += before.y - after.y;
        this.syncTargets();
      }
    }
    Object.assign(g, s);
    this.dirty = true;
  }

  touchUp(event) {
    const g = this.gesture;
    this.touches.delete(event.pointerId);
    const now = performance.now();
    if (g?.kind === "pinch" && this.touches.size === 1) {
      if (!g.moved && now - g.t0 < 320) this.nudgeZoom({ offsetX: g.cx, offsetY: g.cy }, 1.6);
      this.gesture = { kind: "rest" };
      this.lastTap = null;
    }
    if (this.touches.size > 0) return;
    clearTimeout(this.holdTimer);
    if (g?.kind === "one" && !g.moved && now - g.t0 < 260) {
      if (g.double) {
        this.nudgeZoom({ offsetX: g.start.x, offsetY: g.start.y }, 0.5);
        this.lastTap = null;
      } else this.lastTap = { t: now, x: g.start.x, y: g.start.y };
    }
    this.buttons.delete("touch");
    this.zoomTarget = 0;
    this.drag = null;
    this.pivot = null;
    this.gesture = null;
  }

  pickJulia(event) {
    const julia = FRACTALS.findIndex((item) => item.id === "julia");
    if (this.fractal.family === "escape" && this.fractal.id !== "julia") {
      const world = this.screenToWorld(event.offsetX, event.offsetY);
      const [re, im] = this.absolute(world.x, world.y);
      this.setFractal(julia);
      this.juliaRe = re;
      this.juliaIm = im;
      this.juliaReT = re;
      this.juliaImT = im;
    }
  }

  onPointerMove(event) {
    if (event.pointerType === "touch" && this.touches.has(event.pointerId)) {
      this.touchMove(event);
      return;
    }
    this.pointerDrag(event);
  }

  pointerDrag(event) {
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
        const pivot = this.pivot || (this.pivot = this.orbitPivot(this.eye, this.yaw, this.pitch));
        this.yaw += dx * 0.005;
        this.pitch = clampPitch(this.pitch - dy * 0.004);
        const { forward } = basis(this.yaw, this.pitch);
        this.eye = pivot.point.map((v, i) => v - forward[i] * pivot.r);
        this.syncFlight();
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
    if (event.pointerType === "touch") {
      if (this.touches.has(event.pointerId)) this.touchUp(event);
      return;
    }
    this.buttons.delete(event.button);
    if (!this.buttons.size) {
      this.zoomTarget = 0;
      this.drag = null;
      this.pivot = null;
      this.alt = false;
      return;
    }
    this.applyZoomHold();
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

function clampEye(eye) {
  const r = Math.hypot(eye[0], eye[1], eye[2]);
  if (r <= BUDGET.maxDist) return eye;
  return eye.map((v) => (v * BUDGET.maxDist) / r);
}

function eventSafe() {
  /* pan helper is only used from keys */
}
