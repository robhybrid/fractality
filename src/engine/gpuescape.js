/**
 * WebGL1 escape-time fill split into tiles, one draw per display frame, so
 * no single draw keeps the GPU busy for long (watchdog, heat).
 *
 * Two kernels share one shader:
 * - direct: z -> z^2 + c (and the other classic formulas) in f32, for views
 *   whose pixels are still far apart compared to f32 resolution;
 * - perturbation (Mandelbrot only): the CPU supplies a reference orbit Z_n,
 *   each pixel iterates its f32 offset d -> (2 Z + d) d + dc and is rebased
 *   onto the orbit start when |Z + d| < |d| (Zhuoran), so one reference
 *   stays glitch-free. Works until dc underflows f32 (~1e-30 view radius).
 *
 * Output contract matches kernel.js: smooth count in iter, stripe in extra,
 * alpha 0 for interior.
 */

export const MAX_GPU_ITER = 8192;
const ORBIT_W = 1024;

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `
uniform vec2 uFull;
uniform vec2 uTile;
uniform vec2 uCenter;
uniform float uRadius;
uniform vec2 uRot;
uniform float uPower;
uniform float uBailout;
uniform vec2 uJulia;
uniform float uExtra;
uniform int uFormula;
uniform int uMaxIter;
uniform int uSkip;
uniform int uPerturb;
uniform vec2 uOffset;
uniform float uOrbitN;
uniform vec2 uOrbitSize;
uniform sampler2D uOrbit;

vec2 cpowFast(vec2 z, float p) {
  if (abs(p - 2.0) < 0.0008) return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
  float r2 = dot(z, z);
  if (r2 < 1e-30) return vec2(0.0);
  float r = pow(r2, 0.5 * p);
  float a = atan(z.y, z.x) * p;
  return vec2(cos(a), sin(a)) * r;
}

bool cardioid(vec2 c) {
  float q = (c.x - 0.25) * (c.x - 0.25) + c.y * c.y;
  if (q * (q + (c.x - 0.25)) <= 0.25 * c.y * c.y) return true;
  float dx = c.x + 1.0;
  return dx * dx + c.y * c.y <= 0.0625;
}

vec2 orbitAt(float m) {
  float row = floor(m / ${ORBIT_W.toFixed(1)});
  float col = m - row * ${ORBIT_W.toFixed(1)};
  return texture2D(uOrbit, vec2((col + 0.5) / ${ORBIT_W.toFixed(1)}, (row + 0.5) / uOrbitSize.y)).xy;
}

vec4 encode(float iter, vec2 z) {
  float it = max(iter, 0.0);
  float whole = floor(it);
  float stripe = 0.5 + 0.5 * sin(atan(z.y, z.x) * 2.0);
  return vec4(floor(whole / 256.0) / 255.0, mod(whole, 256.0) / 255.0, floor(fract(it) * 255.0) / 255.0, (1.0 + floor(stripe * 254.0)) / 255.0);
}

float smoothIter(int i, float z2, float bail, float power) {
  float mag = sqrt(max(z2, 1.0001));
  float nu = log(log(mag) / log(sqrt(bail))) / log(max(power, 1.05));
  return float(i) + 1.0 - nu;
}

void main() {
  vec2 pix = vec2(uTile.x + gl_FragCoord.x, uFull.y - (uTile.y + gl_FragCoord.y));
  vec2 ndc = (pix / uFull) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  float aspect = uFull.x / uFull.y;
  vec2 p = vec2(ndc.x * aspect, ndc.y) * uRadius;
  p = vec2(p.x * uRot.x - p.y * uRot.y, p.x * uRot.y + p.y * uRot.x);
  float bail = max(uBailout, 4.0);
  if (uPerturb == 1) {
    vec2 dc = p + uOffset;
    vec2 d = vec2(0.0);
    float m = 0.0;
    vec2 Z = vec2(0.0);
    for (int i = 0; i < ${MAX_GPU_ITER}; i++) {
      if (i >= uMaxIter) break;
      d = vec2(2.0 * Z.x * d.x - 2.0 * Z.y * d.y + d.x * d.x - d.y * d.y, 2.0 * (Z.x * d.y + Z.y * d.x) + 2.0 * d.x * d.y) + dc;
      m += 1.0;
      Z = orbitAt(m);
      vec2 z = Z + d;
      float z2 = dot(z, z);
      if (z2 > bail) {
        gl_FragColor = encode(smoothIter(i, z2, bail, 2.0), z);
        return;
      }
      if (z2 < dot(d, d) || m >= uOrbitN - 1.0) {
        d = z;
        m = 0.0;
        Z = vec2(0.0);
      }
    }
    gl_FragColor = vec4(0.0);
    return;
  }
  p += uCenter;
  bool julia = uFormula == 1 || uFormula == 7;
  vec2 cc = julia ? uJulia : p;
  vec2 z = julia ? p : vec2(0.0);
  vec2 prev = vec2(0.0);
  float power = max(uPower, 0.35);
  if (uFormula == 0 && uSkip == 1 && abs(power - 2.0) < 0.02 && cardioid(cc)) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 check = z;
  for (int i = 0; i < ${MAX_GPU_ITER}; i++) {
    if (i >= uMaxIter) break;
    vec2 base = z;
    if (uFormula == 2) base = abs(z);
    if (uFormula == 3) base = vec2(z.x, -z.y);
    if (uFormula == 6) base = vec2(z.x, abs(z.y));
    vec2 w = cpowFast(base, power);
    if (uFormula == 4) w.x = abs(w.x);
    if (uFormula == 5) w = abs(w);
    if (uFormula == 7) w += vec2(uExtra, 0.0) * prev;
    prev = z;
    z = w + cc;
    float z2 = dot(z, z);
    if (z2 > bail) {
      gl_FragColor = encode(smoothIter(i, z2, bail, power), z);
      return;
    }
    if (uFormula == 0 && uSkip == 1 && i > 24 && mod(float(i), 16.0) < 0.5) {
      if (dot(z - check, z - check) < 1e-9) {
        gl_FragColor = vec4(0.0);
        return;
      }
      check = z;
    }
  }
  gl_FragColor = vec4(0.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Double-precision reference orbit at (cx, cy), interleaved [x0, y0, x1, y1, ...].
 * Enough for views down to ~1e-13; deeper views need a BigInt orbit (deep.js)
 * passed in through the same shape.
 */
export function referenceOrbit(cx, cy, maxIter, bail = 1e6) {
  const Z = new Float64Array(2 * (maxIter + 2));
  let x = 0;
  let y = 0;
  let n = 0;
  for (;;) {
    Z[2 * n] = x;
    Z[2 * n + 1] = y;
    n += 1;
    if (x * x + y * y > bail || n > maxIter) break;
    const nx = x * x - y * y + cx;
    y = 2 * x * y + cy;
    x = nx;
  }
  return { Z: Z.subarray(0, 2 * n), N: n };
}

/** Picks the longest-lived of a few candidate references around the view center. */
export function pickReference(state, maxIter) {
  const aspect = (state.w || 16) / (state.h || 9);
  const r = state.radius;
  let best = null;
  for (const [u, v] of [[0, 0], [0.31, 0.17], [-0.29, 0.23], [0.13, -0.37], [-0.41, -0.11], [0.47, 0.41], [-0.07, 0.49]]) {
    const ox = u * aspect * r;
    const oy = v * r;
    const ref = referenceOrbit(state.cx + ox, state.cy + oy, maxIter);
    if (!best || ref.N > best.N) best = { ...ref, ox: -ox, oy: -oy };
    if (ref.N > maxIter) break;
  }
  return best;
}

export function createGpuEscape() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });
  if (!gl) return null;
  const high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!high || high.precision < 23) return null;
  const floatTex = !!gl.getExtension("OES_texture_float");
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, `precision highp float;\n${FRAG}`);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const locs = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) {
    const info = gl.getActiveUniform(prog, i);
    locs[info.name] = gl.getUniformLocation(prog, info.name);
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.DITHER);
  const target = gl.createTexture();
  const fbo = gl.createFramebuffer();
  const orbitTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, orbitTex);
  for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  let targetW = 0;
  let targetH = 0;
  let orbitKey = null;
  let orbitN = 0;
  let orbitRows = 1;
  let lost = false;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
  });
  /** Pixel-iterations per millisecond, refined by synchronous probes. */
  let rate = 2e5;
  let latency = Infinity;
  const budgetMs = 6;

  function ensureTarget(w, h) {
    if (w <= targetW && h <= targetH) return;
    targetW = Math.max(w, targetW);
    targetH = Math.max(h, targetH);
    gl.bindTexture(gl.TEXTURE_2D, target);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("escape target incomplete");
  }

  /** orbit: { Z: interleaved Float64Array | Float32Array, N }. */
  function setOrbit(orbit) {
    if (orbitKey === orbit.Z) return;
    const N = orbit.N;
    orbitRows = Math.ceil(N / ORBIT_W);
    const data = new Float32Array(ORBIT_W * orbitRows * 4);
    for (let n = 0; n < N; n += 1) {
      data[n * 4] = orbit.Z[2 * n];
      data[n * 4 + 1] = orbit.Z[2 * n + 1];
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, orbitTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ORBIT_W, orbitRows, 0, gl.RGBA, gl.FLOAT, data);
    orbitKey = orbit.Z;
    orbitN = N;
  }

  function drawTile(job, t) {
    const { state } = job;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.useProgram(prog);
    gl.uniform2f(locs.uFull, job.w, job.h);
    gl.uniform2f(locs.uTile, t.x, job.h - t.y - t.h);
    gl.uniform2f(locs.uCenter, state.cx, state.cy);
    gl.uniform1f(locs.uRadius, state.radius);
    const rot = state.rotation || 0;
    gl.uniform2f(locs.uRot, Math.cos(rot), Math.sin(rot));
    gl.uniform1f(locs.uPower, state.power || 2);
    gl.uniform1f(locs.uBailout, state.bailout || 4);
    gl.uniform2f(locs.uJulia, state.juliaRe || 0, state.juliaIm || 0);
    gl.uniform1f(locs.uExtra, state.extra || 0);
    gl.uniform1i(locs.uFormula, state.formula | 0);
    gl.uniform1i(locs.uMaxIter, job.iters);
    gl.uniform1i(locs.uSkip, state.skipInterior ? 1 : 0);
    gl.uniform1i(locs.uPerturb, job.orbit ? 1 : 0);
    if (job.orbit) setOrbit(job.orbit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, orbitTex);
    gl.uniform1i(locs.uOrbit, 0);
    if (job.orbit) {
      gl.uniform2f(locs.uOffset, job.orbit.ox || 0, job.orbit.oy || 0);
      gl.uniform1f(locs.uOrbitN, orbitN);
      gl.uniform2f(locs.uOrbitSize, ORBIT_W, orbitRows);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
  }

  function readTile(job, t) {
    const px = new Uint8Array(t.w * t.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const { buf } = job;
    const W = buf.w;
    for (let row = 0; row < t.h; row += 1) {
      const src = (t.h - 1 - row) * t.w * 4;
      const dst = (t.y + row) * W + t.x;
      for (let x = 0; x < t.w; x += 1) {
        const s = src + x * 4;
        const i = dst + x;
        const a = px[s + 3];
        buf.alpha[i] = a ? 1 : 0;
        buf.iter[i] = px[s] * 256 + px[s + 1] + px[s + 2] / 255;
        buf.extra[i] = a ? (a - 1) / 254 : 0;
      }
    }
  }

  function nextTile(job) {
    if (job.y >= job.h) return null;
    const pixels = Math.max(1024, Math.floor((rate * budgetMs) / job.iters));
    const tw = Math.min(job.w, pixels);
    let th = Math.max(1, Math.floor(pixels / tw));
    if (tw < job.w) th = 1;
    th = Math.min(th, job.h - job.y);
    const t = { x: job.x, y: job.y, w: Math.min(tw, job.w - job.x), h: th };
    job.x += t.w;
    if (job.x >= job.w) {
      job.x = 0;
      job.y += th;
    }
    ensureTarget(t.w, t.h);
    return t;
  }

  return {
    floatTex,
    get lost() {
      return lost || gl.isContextLost();
    },
    get rate() {
      return rate;
    },
    /**
     * Starts a tiled fill of buf. Pass `orbit` ({ Z, N, ox, oy }: pixel dc =
     * pixel offset from the view center + (ox, oy)) for perturbation.
     */
    begin(buf, state, orbit = null) {
      if (orbit && !floatTex) throw new Error("perturbation needs float textures");
      const iters = Math.max(1, Math.min(MAX_GPU_ITER, state.iters | 0));
      buf.source = 0;
      return { buf, state, orbit, iters, w: buf.w, h: buf.h, x: 0, y: 0, pending: null, tiles: 0, done: false, gpuMs: 0 };
    },
    /**
     * Collects the previous tile and issues the next one. Every eighth tile
     * is timed synchronously to keep each draw near the time budget.
     */
    step(job) {
      if (job.pending) {
        readTile(job, job.pending);
        job.pending = null;
      }
      const t = nextTile(job);
      if (!t) {
        job.done = true;
        return true;
      }
      const probe = job.tiles % 8 === 0;
      const t0 = performance.now();
      drawTile(job, t);
      job.tiles += 1;
      if (probe) {
        readTile(job, t);
        const ms = performance.now() - t0;
        job.gpuMs = Math.max(job.gpuMs, ms);
        latency = Math.min(latency, ms);
        const measured = (t.w * t.h * job.iters) / Math.max(0.25, ms - latency * 0.9);
        rate = Math.max(2e4, Math.min(rate * 4, measured));
      } else {
        job.pending = t;
      }
      return false;
    },
    /** Synchronous whole-buffer fill, for tests. */
    fill(buf, state, orbit = null) {
      const job = this.begin(buf, state, orbit);
      while (!this.step(job));
      return job;
    },
    destroy() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/** Direct f32 while pixels are coarse; perturbation (Mandelbrot, power 2) below that. */
export function tilesPlan(gpu, state, h) {
  if (!gpu || state.family !== "escape" || (state.formula | 0) >= 8 || state.deep) return null;
  if ((state.iters | 0) > MAX_GPU_ITER) return null;
  const px = (2 * state.radius) / h;
  if (px > 3e-6 * Math.max(1, Math.hypot(state.cx, state.cy))) return "direct";
  const square = Math.abs((state.power || 2) - 2) < 0.0008;
  if ((state.formula | 0) === 0 && square && gpu.floatTex && state.radius > 1e-28) return "perturb";
  return null;
}

/** Small probe frames against the CPU kernel; both kernels must agree. */
export function escapeAgrees(gpu, createBuffer, fillAll) {
  const views = [
    { cx: -0.75, cy: 0, radius: 1.35, iters: 64, orbit: false },
    { cx: -0.743643887037151, cy: 0.13182590420533, radius: 3e-5, iters: 400, orbit: true },
  ];
  for (const v of views) {
    const state = { family: "escape", formula: 0, rotation: 0, power: 2, bailout: 64, skipInterior: true, juliaRe: 0, juliaIm: 0, extra: 0, w: 32, h: 18, ...v };
    if (v.orbit && !gpu.floatTex) continue;
    const cpu = createBuffer(32, 18);
    const out = createBuffer(32, 18);
    fillAll(cpu, state);
    gpu.fill(out, state, v.orbit ? pickReference(state, state.iters) : null);
    let bad = 0;
    for (let i = 0; i < 32 * 18; i += 1) {
      if (cpu.alpha[i] !== out.alpha[i] || (cpu.alpha[i] && Math.abs(cpu.iter[i] - out.iter[i]) > 1)) bad += 1;
    }
    if (bad > 32 * 18 * 0.1) return false;
  }
  return true;
}
