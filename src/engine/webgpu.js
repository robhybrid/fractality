/**
 * Optional WebGPU compute kernel for escape-time fractals (WGSL, f32).
 * Same output contract as kernel.js. Never required: createWebGpuEscape()
 * resolves to null when navigator.gpu, an adapter or the shader is missing.
 *
 * Direct mode iterates z -> z^2 + c (classic formulas 0..7). Perturbation
 * mode (Mandelbrot, power 2) takes a CPU reference orbit, interleaved
 * [x0, y0, x1, y1, ...] in a Float64Array or Float32Array, and iterates f32
 * offsets with rebasing, like gpuescape.js.
 */

const WGSL = /* wgsl */ `
struct Params {
  size: vec2f,
  center: vec2f,
  rot: vec2f,
  offset: vec2f,
  julia: vec2f,
  radius: f32,
  power: f32,
  bail: f32,
  extra: f32,
  maxIter: u32,
  formula: u32,
  skip: u32,
  perturb: u32,
  orbitN: u32,
  row0: u32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> orbit: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> outBuf: array<vec2f>;

fn cpowFast(z: vec2f, p: f32) -> vec2f {
  if (abs(p - 2.0) < 0.0008) { return vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y); }
  let r2 = dot(z, z);
  if (r2 < 1e-30) { return vec2f(0.0); }
  let r = pow(r2, 0.5 * p);
  let a = atan2(z.y, z.x) * p;
  return vec2f(cos(a), sin(a)) * r;
}

fn cardioid(c: vec2f) -> bool {
  let q = (c.x - 0.25) * (c.x - 0.25) + c.y * c.y;
  if (q * (q + (c.x - 0.25)) <= 0.25 * c.y * c.y) { return true; }
  let dx = c.x + 1.0;
  return dx * dx + c.y * c.y <= 0.0625;
}

fn smoothIter(i: u32, z2: f32, bail: f32, power: f32) -> f32 {
  let mag = sqrt(max(z2, 1.0001));
  let nu = log(log(mag) / log(sqrt(bail))) / log(max(power, 1.05));
  return f32(i) + 1.0 - nu;
}

fn stripe(z: vec2f) -> f32 {
  return 0.5 + 0.5 * sin(atan2(z.y, z.x) * 2.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(P.size.x);
  let h = u32(P.size.y);
  let x = gid.x;
  let y = gid.y + P.row0;
  if (x >= w || y >= h) { return; }
  let idx = (y - P.row0) * w + x;
  let ndc = vec2f(((f32(x) + 0.5) / P.size.x) * 2.0 - 1.0, 1.0 - ((f32(y) + 0.5) / P.size.y) * 2.0);
  var p = vec2f(ndc.x * (P.size.x / P.size.y), ndc.y) * P.radius;
  p = vec2f(p.x * P.rot.x - p.y * P.rot.y, p.x * P.rot.y + p.y * P.rot.x);
  let bail = max(P.bail, 4.0);
  outBuf[idx] = vec2f(-1.0, 0.0);
  if (P.perturb == 1u) {
    let dc = p + P.offset;
    var d = vec2f(0.0);
    var Z = vec2f(0.0);
    var m = 0u;
    for (var i = 0u; i < P.maxIter; i++) {
      d = vec2f(2.0 * (Z.x * d.x - Z.y * d.y) + d.x * d.x - d.y * d.y, 2.0 * (Z.x * d.y + Z.y * d.x) + 2.0 * d.x * d.y) + dc;
      m++;
      Z = orbit[m];
      let z = Z + d;
      let z2 = dot(z, z);
      if (z2 > bail) {
        outBuf[idx] = vec2f(smoothIter(i, z2, bail, 2.0), stripe(z));
        return;
      }
      if (z2 < dot(d, d) || m + 1u >= P.orbitN) {
        d = z;
        m = 0u;
        Z = vec2f(0.0);
      }
    }
    return;
  }
  p += P.center;
  let julia = P.formula == 1u || P.formula == 7u;
  let cc = select(p, P.julia, julia);
  var z = select(vec2f(0.0), p, julia);
  var prev = vec2f(0.0);
  let power = max(P.power, 0.35);
  if (P.formula == 0u && P.skip == 1u && abs(power - 2.0) < 0.02 && cardioid(cc)) { return; }
  var check = z;
  for (var i = 0u; i < P.maxIter; i++) {
    var base = z;
    if (P.formula == 2u) { base = abs(z); }
    if (P.formula == 3u) { base = vec2f(z.x, -z.y); }
    if (P.formula == 6u) { base = vec2f(z.x, abs(z.y)); }
    var nz = cpowFast(base, power);
    if (P.formula == 4u) { nz.x = abs(nz.x); }
    if (P.formula == 5u) { nz = abs(nz); }
    if (P.formula == 7u) { nz += vec2f(P.extra, 0.0) * prev; }
    prev = z;
    z = nz + cc;
    let z2 = dot(z, z);
    if (z2 > bail) {
      outBuf[idx] = vec2f(smoothIter(i, z2, bail, power), stripe(z));
      return;
    }
    if (P.formula == 0u && P.skip == 1u && i > 24u && (i & 15u) == 0u) {
      if (dot(z - check, z - check) < 1e-9) { return; }
      check = z;
    }
  }
}
`;

export async function createWebGpuEscape() {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  let device;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) return null;
    device = await adapter.requestDevice();
  } catch {
    return null;
  }
  let lost = false;
  device.lost.then(() => {
    lost = true;
  });
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code: WGSL });
  const info = await module.getCompilationInfo?.();
  if (info?.messages?.some((m) => m.type === "error")) {
    device.destroy();
    return null;
  }
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  if (await device.popErrorScope()) {
    device.destroy();
    return null;
  }
  const uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let orbitBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  let orbitKey = null;
  let orbitN = 1;
  let outBuf = null;
  let readBuf = null;
  let cap = 0;

  function ensure(bytes) {
    if (bytes <= cap) return;
    outBuf?.destroy();
    readBuf?.destroy();
    cap = bytes;
    outBuf = device.createBuffer({ size: cap, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    readBuf = device.createBuffer({ size: cap, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  function setOrbit(orbit) {
    if (orbitKey === orbit.Z) return;
    const data = Float32Array.from(orbit.Z.subarray(0, 2 * orbit.N));
    orbitBuf.destroy();
    orbitBuf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(orbitBuf, 0, data);
    orbitKey = orbit.Z;
    orbitN = orbit.N;
  }

  /** One band of rows, awaited; returns GPU+readback wall time. */
  async function band(buf, state, orbit, row0, rows) {
    const w = buf.w;
    const bytes = w * rows * 8;
    ensure(bytes);
    const f = new Float32Array(20);
    const u = new Uint32Array(f.buffer);
    const rot = state.rotation || 0;
    f.set([w, buf.h, state.cx, state.cy, Math.cos(rot), Math.sin(rot), orbit?.ox || 0, orbit?.oy || 0, state.juliaRe || 0, state.juliaIm || 0, state.radius, state.power || 2, state.bailout || 4, state.extra || 0]);
    u[14] = Math.max(1, state.iters | 0);
    u[15] = state.formula | 0;
    u[16] = state.skipInterior ? 1 : 0;
    u[17] = orbit ? 1 : 0;
    u[18] = orbitN;
    u[19] = row0;
    if (orbit) setOrbit(orbit);
    device.queue.writeBuffer(uniform, 0, f);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: orbitBuf } },
        { binding: 2, resource: { buffer: outBuf, size: bytes } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(rows / 8));
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, bytes);
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    const ms = performance.now() - t0;
    const data = new Float32Array(readBuf.getMappedRange(0, bytes).slice(0));
    readBuf.unmap();
    const off = row0 * w;
    for (let i = 0; i < w * rows; i += 1) {
      const it = data[2 * i];
      const o = off + i;
      if (it < 0) {
        buf.alpha[o] = 0;
        buf.iter[o] = 0;
        buf.extra[o] = 0;
      } else {
        buf.alpha[o] = 1;
        buf.iter[o] = it;
        buf.extra[o] = data[2 * i + 1];
      }
    }
    return ms;
  }

  return {
    get lost() {
      return lost;
    },
    /**
     * Fills buf in bands sized so each dispatch stays near budgetMs, one band
     * per animation frame unless `eager`. orbit: { Z, N, ox, oy } enables
     * perturbation.
     */
    async fill(buf, state, { orbit = null, budgetMs = 6, eager = false } = {}) {
      buf.source = 0;
      let rows = 8;
      let worst = 0;
      let total = 0;
      for (let y = 0; y < buf.h; ) {
        const n = Math.min(rows, buf.h - y);
        const ms = await band(buf, state, orbit, y, n);
        worst = Math.max(worst, ms);
        total += ms;
        y += n;
        const perRow = ms / n;
        rows = Math.max(8, Math.min(buf.h, Math.floor(budgetMs / Math.max(perRow, 1e-3)) & ~7));
        if (!eager) await new Promise((r) => requestAnimationFrame(r));
      }
      return { worstMs: worst, gpuMs: total };
    },
    destroy() {
      device.destroy();
    },
  };
}
