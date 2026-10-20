import { rasterize } from "./color.js";
import { childOffset, frameSpec } from "./frames.js";

export const RESOLUTIONS = [
  { id: "720p", label: "1280 × 720 · 720p", w: 1280, h: 720 },
  { id: "1080p", label: "1920 × 1080 · 1080p", w: 1920, h: 1080 },
  { id: "1440p", label: "2560 × 1440 · 1440p", w: 2560, h: 1440 },
  { id: "2160p", label: "3840 × 2160 · 4K", w: 3840, h: 2160 },
  { id: "square", label: "1080 × 1080 · square", w: 1080, h: 1080 },
  { id: "vertical", label: "1080 × 1920 · vertical", w: 1080, h: 1920 },
];

export const FRAME_RATES = [24, 30, 60];

/** Bits per pixel per frame. Fractal detail is all edges, so this runs higher than camera footage. */
export const QUALITIES = [
  { id: "standard", label: "Standard", bpp: 0.1 },
  { id: "high", label: "High", bpp: 0.2 },
  { id: "max", label: "Maximum", bpp: 0.35 },
];

export const CONTAINERS = [
  { id: "mp4", label: "MP4 (H.264)" },
  { id: "mov", label: "MOV (H.264)" },
  { id: "webm", label: "WebM (VP9)" },
];

export const EASINGS = [
  { id: "smooth", label: "Smooth" },
  { id: "ease", label: "Ease in/out" },
  { id: "linear", label: "Linear" },
];

export const DEFAULT_DURATION = 4;
const MIN_DURATION = 0.1;
const TAU = Math.PI * 2;

export function bitrateFor(w, h, fps, quality) {
  const q = QUALITIES.find((item) => item.id === quality) || QUALITIES[1];
  return Math.round(Math.min(100e6, Math.max(2e6, w * h * fps * q.bpp)));
}

export function keyTimes(keys) {
  const times = [0];
  for (let i = 0; i < keys.length - 1; i += 1) times.push(times[i] + Math.max(MIN_DURATION, keys[i].duration || DEFAULT_DURATION));
  return times;
}

export function totalTime(keys) {
  const times = keyTimes(keys);
  return times[times.length - 1];
}

function frameScale(key) {
  return key.frameKind ? frameSpec(key.frameKind).scale : 1;
}

/** Log radius in root coordinates, so keys in different frames compare. */
function rootLog(key) {
  return key.view.logR - (key.view.frame?.length || 0) * Math.log(frameScale(key));
}

function sameDigit(a, b) {
  return Array.isArray(a) ? a[0] === b[0] && a[1] === b[1] : a === b;
}

/**
 * The key's center in the coordinates of frame `digits`: up to the common
 * prefix with parent = child / scale + offset, then down with
 * child = (parent - offset) * scale.
 */
export function centerInFrame(key, digits) {
  const own = key.view.frame || [];
  let x = key.view.cx;
  let y = key.view.cy;
  if (!key.frameKind) return [x, y];
  const kind = key.frameKind;
  const scale = frameSpec(kind).scale;
  let p = 0;
  while (p < own.length && p < digits.length && sameDigit(own[p], digits[p])) p += 1;
  for (let j = own.length - 1; j >= p; j -= 1) {
    const [ox, oy] = childOffset(kind, own[j]);
    x = x / scale + ox;
    y = y / scale + oy;
  }
  for (let j = p; j < digits.length; j += 1) {
    const [ox, oy] = childOffset(kind, digits[j]);
    x = (x - ox) * scale;
    y = (y - oy) * scale;
  }
  return [x, y];
}

function wrapHalf(x) {
  return x - Math.round(x);
}

function unwrapAngles(values, linked) {
  const out = values.slice();
  for (let i = 1; i < out.length; i += 1) {
    if (!linked(i - 1)) continue;
    out[i] = out[i - 1] + (((values[i] - out[i - 1]) % TAU) + TAU + Math.PI) % TAU - Math.PI;
  }
  return out;
}

/** Monotone (Fritsch-Butland) tangents: smooth through the keys, never overshooting them. */
function tangents(values, times, linked, flat) {
  const n = values.length;
  const m = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    if (!linked(i - 1) || !linked(i) || flat[i]) continue;
    const h0 = times[i] - times[i - 1];
    const h1 = times[i + 1] - times[i];
    const d0 = (values[i] - values[i - 1]) / h0;
    const d1 = (values[i + 1] - values[i]) / h1;
    if (d0 * d1 <= 0) continue;
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
  }
  return m;
}

function hermite(p0, p1, m0, m1, h, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1;
}

function smoothstep(u) {
  return u * u * (3 - 2 * u);
}

/**
 * Center during a zoom from radius ra to rb with the similarity that keeps
 * one point fixed on screen: c = cb + (ca - cb) * s, s = (r - rb) / (ra - rb).
 * s and 1 - s come from expm1 of log differences, so neither overflows nor
 * cancels near the deep end, and the deep key's center is reproduced exactly.
 */
export function zoomWeights(La, Lb, L) {
  if (La >= Lb) {
    const den = Math.expm1(Lb - La);
    return [(Math.exp(L - La) * Math.expm1(Lb - L)) / den, Math.expm1(L - La) / den];
  }
  const den = Math.expm1(La - Lb);
  return [Math.expm1(L - Lb) / den, (Math.exp(L - Lb) * Math.expm1(La - L)) / den];
}

/**
 * Precomputed per-key tracks. View and fractal parameters only link keys
 * that show the same fractal (other segments hold, then cut at the next
 * key); color tracks always link.
 */
export function buildTracks(keys) {
  const n = keys.length;
  const times = keyTimes(keys);
  const sameFractal = (i) => i >= 0 && i < n - 1 && keys[i].fractal === keys[i + 1].fractal;
  const always = (i) => i >= 0 && i < n - 1;
  const flat = new Uint8Array(n);
  keys.forEach((key, i) => {
    if (i < n - 1 && key.easing === "ease") {
      flat[i] = 1;
      flat[i + 1] = 1;
    }
  });
  const track = (get, linked = sameFractal, angle = false) => {
    let values = keys.map(get);
    if (angle) values = unwrapAngles(values, linked);
    return { values, m: tangents(values, times, linked, flat), linked };
  };
  const speeds = keys.map((key) => (key.color.animatePalette ? key.color.paletteSpeed : 0));
  const phase = [keys[0]?.color.phase || 0];
  for (let i = 1; i < n; i += 1) {
    const drift = phase[i - 1] + 0.5 * (speeds[i - 1] + speeds[i]) * (times[i] - times[i - 1]);
    phase.push(drift + wrapHalf(keys[i].color.phase - drift));
  }
  const phaseM = Float64Array.from(speeds);
  for (let i = 0; i < n; i += 1) if (flat[i]) phaseM[i] = 0;
  return {
    times,
    total: times[n - 1] || 0,
    L: track(rootLog),
    rotation: track((k) => k.view.rotation || 0, sameFractal, true),
    yaw: track((k) => k.view.yaw || 0, sameFractal, true),
    pitch: track((k) => k.view.pitch || 0),
    dist: track((k) => Math.log(k.view.dist || 2.5)),
    power: track((k) => k.params.power),
    bailout: track((k) => Math.log(k.params.bailout)),
    juliaRe: track((k) => k.params.juliaRe),
    juliaIm: track((k) => k.params.juliaIm),
    extra: track((k) => k.params.extra),
    iterBias: track((k) => k.iter.iterBias),
    density: track((k) => Math.log(k.color.density), always),
    exposure: track((k) => k.color.exposure, always),
    edge: track((k) => k.color.edge, always),
    paletteSpeed: track((k) => k.color.paletteSpeed, always),
    phase: { values: phase, m: phaseM, linked: always },
  };
}

function poseOfKey(key, phase = key.color.phase) {
  return {
    fractal: key.fractal,
    family: key.family,
    frameKind: key.frameKind || null,
    view: { ...key.view, frame: (key.view.frame || []).slice() },
    params: { ...key.params },
    iter: { ...key.iter },
    color: { ...key.color, phase, stops: undefined },
    palette: { a: key.color.stops, b: key.color.stops, mix: 0 },
    segment: 0,
    u: 0,
  };
}

/** The interpolated state at time t (seconds) along the keyframes. */
export function samplePose(keys, t, tracks = buildTracks(keys)) {
  const n = keys.length;
  if (!n) return null;
  if (n === 1) return poseOfKey(keys[0]);
  const { times } = tracks;
  const time = Math.min(tracks.total, Math.max(0, t));
  let i = 0;
  while (i < n - 2 && times[i + 1] <= time) i += 1;
  const h = times[i + 1] - times[i];
  const u = Math.min(1, Math.max(0, (time - times[i]) / h));
  const a = keys[i];
  const b = keys[i + 1];
  const easing = a.easing || "smooth";
  const eased = easing === "linear" ? u : smoothstep(u);
  const ev = (tr) => {
    const v0 = tr.values[i];
    const v1 = tr.values[i + 1];
    if (!tr.linked(i)) return u >= 1 ? v1 : v0;
    if (easing === "linear") return v0 + (v1 - v0) * u;
    return hermite(v0, v1, tr.m[i], tr.m[i + 1], h, u);
  };
  const same = a.fractal === b.fractal;
  const pose = poseOfKey(same || u < 1 ? a : b, ev(tracks.phase));
  pose.segment = i;
  pose.u = u;
  pose.color.paletteSpeed = ev(tracks.paletteSpeed);
  pose.color.density = Math.exp(ev(tracks.density));
  pose.color.exposure = ev(tracks.exposure);
  pose.color.edge = ev(tracks.edge);
  pose.palette = { a: a.color.stops, b: b.color.stops, mix: eased };
  if (u >= 1) {
    pose.color.post = b.color.post;
    pose.color.colorMode = b.color.colorMode;
    pose.color.colorInterior = b.color.colorInterior;
  }
  if (!same) return pose;
  pose.params = {
    power: ev(tracks.power),
    bailout: Math.exp(ev(tracks.bailout)),
    juliaRe: ev(tracks.juliaRe),
    juliaIm: ev(tracks.juliaIm),
    extra: ev(tracks.extra),
  };
  pose.iter = { autoIter: u >= 1 ? b.iter.autoIter : a.iter.autoIter, iterBias: ev(tracks.iterBias) };
  if (a.family === "ray") {
    pose.view = { ...pose.view, yaw: ev(tracks.yaw), pitch: ev(tracks.pitch), dist: Math.exp(ev(tracks.dist)) };
    return pose;
  }
  const deep = (b.view.frame?.length || 0) > (a.view.frame?.length || 0) ? b : a;
  const digits = (deep.view.frame || []).slice();
  const ca = centerInFrame(a, digits);
  const cb = centerInFrame(b, digits);
  const La = tracks.L.values[i];
  const Lb = tracks.L.values[i + 1];
  const L = ev(tracks.L);
  const lin = [ca[0] + (cb[0] - ca[0]) * eased, ca[1] + (cb[1] - ca[1]) * eased];
  let center = lin;
  const gap = Math.abs(La - Lb);
  if (gap > 1e-9) {
    const [s, rest] = zoomWeights(La, Lb, L);
    const zoom = [ca[0] * s + cb[0] * rest, ca[1] * s + cb[1] * rest];
    const w = gap >= 0.05 ? 1 : smoothstep(gap / 0.05);
    center = w >= 1 ? zoom : [lin[0] + (zoom[0] - lin[0]) * w, lin[1] + (zoom[1] - lin[1]) * w];
  }
  pose.view = {
    ...pose.view,
    frame: digits,
    cx: center[0],
    cy: center[1],
    logR: L + digits.length * Math.log(frameScale(deep)),
    rotation: ev(tracks.rotation),
  };
  return pose;
}

/**
 * Keyframes, live playback and export for one engine. Keys are full
 * snapshots; the engine owns only view capture/apply (captureView,
 * applyView), everything else is read and written here.
 */
export class MovieMaker {
  constructor(engine) {
    this.engine = engine;
    this.keys = [];
    this.tracks = null;
    this.time = 0;
    this.playing = false;
    this.loop = false;
    this.nextId = 1;
    this.palRefs = { a: null, b: null };
    this.posed = false;
    this.settings = { resolution: "1080p", fps: 30, quality: "high", container: "mp4", supersample: "auto" };
    this.job = null;
    this.result = null;
    this.message = "";
  }

  get total() {
    return this.tracks?.total || 0;
  }

  get exporting() {
    return !!this.job && !this.job.done;
  }

  changed() {
    this.tracks = this.keys.length ? buildTracks(this.keys) : null;
    this.time = Math.min(this.time, this.total);
    this.engine.publish(true);
  }

  capture() {
    this.settle();
    const e = this.engine;
    const f = e.fractal;
    return {
      fractal: e.fractalIndex,
      fractalId: f.id,
      name: f.name,
      family: f.family,
      frameKind: f.frame || null,
      view: e.captureView(),
      params: { power: e.powerT, bailout: e.bailT, juliaRe: e.juliaReT, juliaIm: e.juliaImT, extra: e.extraT },
      iter: { autoIter: e.autoIter, iterBias: e.iterBias },
      color: {
        phase: e.phase - Math.floor(e.phase),
        paletteSpeed: e.paletteSpeed,
        animatePalette: e.animatePalette,
        density: e.density,
        exposure: e.exposure,
        edge: e.edge,
        post: e.post,
        colorMode: e.colorMode,
        colorInterior: e.colorInterior,
        paletteIndex: e.paletteIndex,
        stops: (e.fade < 1 && e.pendingStops ? e.pendingStops : e.stops).map((s) => ({ ...s })),
      },
      duration: DEFAULT_DURATION,
      easing: "smooth",
      thumb: this.thumbnail(),
    };
  }

  thumbnail() {
    try {
      const src = this.engine.canvas;
      const c = document.createElement("canvas");
      c.width = 112;
      c.height = Math.max(1, Math.round((112 * src.height) / Math.max(1, src.width)));
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.8);
    } catch {
      return "";
    }
  }

  addKey() {
    if (this.exporting) return;
    this.stop();
    const key = { ...this.capture(), id: this.nextId++ };
    this.keys.push(key);
    this.changed();
    this.time = this.total;
    this.flash(`Keyframe ${this.keys.length} added`);
  }

  replaceKey(index) {
    const old = this.keys[index];
    if (!old || this.exporting) return;
    this.stop();
    this.keys[index] = { ...this.capture(), id: old.id, duration: old.duration, easing: old.easing };
    this.changed();
  }

  removeKey(index) {
    if (this.exporting) return;
    this.stop();
    this.keys.splice(index, 1);
    this.changed();
  }

  moveKey(index, dir) {
    const j = index + dir;
    if (this.exporting || j < 0 || j >= this.keys.length) return;
    this.stop();
    [this.keys[index], this.keys[j]] = [this.keys[j], this.keys[index]];
    this.changed();
  }

  setDuration(index, seconds) {
    if (!this.keys[index] || !Number.isFinite(seconds)) return;
    this.keys[index].duration = Math.min(600, Math.max(MIN_DURATION, seconds));
    this.changed();
  }

  setEasing(index, easing) {
    if (!this.keys[index]) return;
    this.keys[index].easing = easing;
    this.changed();
  }

  clear() {
    if (this.exporting) return;
    this.stop();
    this.keys = [];
    this.time = 0;
    this.changed();
  }

  setSetting(name, value) {
    this.settings = { ...this.settings, [name]: value };
    this.engine.publish(true);
  }

  setLoop(value) {
    this.loop = value;
    this.engine.publish(true);
  }

  keyTime(index) {
    return this.tracks?.times[index] ?? 0;
  }

  goTo(index) {
    if (!this.keys[index] || this.exporting) return;
    this.stop();
    this.seek(this.keyTime(index));
  }

  seek(t) {
    if (!this.keys.length || this.exporting) return;
    this.time = Math.min(this.total, Math.max(0, t));
    this.apply(samplePose(this.keys, this.time, this.tracks));
    this.engine.publish(true);
  }

  togglePlay() {
    if (this.playing) this.stop();
    else this.play();
  }

  play() {
    if (this.keys.length < 2 || this.exporting) return;
    if (this.time >= this.total - 1e-6) this.time = 0;
    this.playing = true;
    this.engine.publish(true);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.engine.publish(true);
  }

  /** Advances playback; true when it drove the view this frame. */
  tick(dt) {
    if (!this.playing) return false;
    this.time += dt;
    if (this.time >= this.total) {
      if (this.loop) this.time %= Math.max(1e-6, this.total);
      else this.time = this.total;
    }
    this.apply(samplePose(this.keys, this.time, this.tracks));
    if (!this.loop && this.time >= this.total) {
      this.playing = false;
      this.engine.publish(true);
    }
    return true;
  }

  /** Writes a pose into the engine: targets equal values, so nothing eases after it. */
  apply(pose, aspect = null) {
    if (!pose) return;
    const e = this.engine;
    if (pose.fractal !== e.fractalIndex) {
      e.fractalIndex = pose.fractal;
      e.presetCursor = 0;
    }
    e.applyView(pose.view, aspect);
    const p = pose.params;
    e.power = e.powerT = e.breathBase = p.power;
    e.bailout = e.bailT = p.bailout;
    e.juliaRe = e.juliaReT = p.juliaRe;
    e.juliaIm = e.juliaImT = p.juliaIm;
    e.extra = e.extraT = p.extra;
    e.vPower = e.vBail = e.vJr = e.vJi = e.vExtra = 0;
    e.breathe = false;
    e.autoIter = pose.iter.autoIter;
    e.iterBias = pose.iter.iterBias;
    const c = pose.color;
    e.phase = c.phase;
    e.paletteSpeed = c.paletteSpeed;
    e.animatePalette = c.animatePalette;
    e.density = c.density;
    e.exposure = c.exposure;
    e.edge = c.edge;
    e.post = c.post;
    e.colorMode = c.colorMode;
    e.colorInterior = c.colorInterior;
    e.paletteIndex = c.paletteIndex;
    const { a, b, mix } = pose.palette;
    if (this.palRefs.a !== a) e.renderer.uploadPalette("a", rasterize(a));
    if (this.palRefs.b !== b) e.renderer.uploadPalette("b", rasterize(b));
    this.palRefs = { a, b };
    e.fade = 1;
    e.pendingStops = null;
    e.palMix = a === b ? 0 : mix;
    e.stops = mix < 0.5 ? a : b;
    e.dirty = true;
    this.posed = true;
  }

  /** Drops a mid-segment palette blend in favor of the nearer key's palette. */
  settle() {
    if (!this.posed) return;
    const e = this.engine;
    e.stops = e.stops.map((s) => ({ ...s }));
    e.renderer.uploadPalette("a", rasterize(e.stops));
    e.renderer.uploadPalette("b", rasterize(e.stops));
    e.palMix = 0;
    e.fade = 1;
    e.selectedStop = 0;
    e.dirty = true;
    this.palRefs = { a: null, b: null };
    this.posed = false;
  }

  flash(text) {
    this.message = text;
    this.messageAt = performance.now();
  }

  async exportVideo() {
    if (this.exporting || this.keys.length < 1) return;
    this.stop();
    const { runExport } = await import("./export.js");
    await runExport(this);
  }

  cancelExport() {
    if (this.job && !this.job.done) this.job.cancel = true;
    this.engine.renderer.cancelStill?.();
  }

  snapshot() {
    const job = this.job;
    return {
      keys: this.keys.map((key, i) => ({
        id: key.id,
        name: key.name,
        thumb: key.thumb,
        duration: key.duration,
        easing: key.easing,
        at: this.keyTime(i),
        depth: key.view.frame?.length || 0,
      })),
      time: this.time,
      total: this.total,
      playing: this.playing,
      loop: this.loop,
      settings: this.settings,
      exporting: this.exporting,
      job: job
        ? {
            frame: job.frame,
            frames: job.frames,
            eta: job.eta,
            stage: job.stage,
            codec: job.codec,
            done: !!job.done,
            error: job.error || "",
          }
        : null,
      result: this.result ? { url: this.result.url, name: this.result.name, size: this.result.size, codec: this.result.codec, w: this.result.w, h: this.result.h, frames: this.result.frames, seconds: this.result.seconds } : null,
      message: this.message && performance.now() - (this.messageAt || 0) < 1800 ? this.message : "",
    };
  }
}

