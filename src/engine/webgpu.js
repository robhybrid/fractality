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
  let idx = y * w + x;
  let ndc = vec2f(((f32(x) + 0.5) / P.size.x) * 2.0 - 1.0, 1.0 - ((f32(y) + 0.5) / P.size.y) * 2.0);
  var p = vec2f(ndc.x * (P.size.x / P.size.y), ndc.y) * P.radius;
  p = vec2f(p.x * P.rot.x - p.y * P.rot.y, p.x * P.rot.y + p.y * P.rot.x);
  let bail = max(P.bail, 4.0);
  outBuf[idx] = vec2f(-1.0, 1.0);
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
  if (P.formula == 0u && P.skip == 1u && abs(power - 2.0) < 0.02 && cardioid(cc)) {
    outBuf[idx] = vec2f(-1.0, 0.0);
    return;
  }
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
      if (dot(z - check, z - check) < 1e-9) {
        outBuf[idx] = vec2f(-1.0, 0.0);
        return;
      }
      check = z;
    }
  }
}
`;

export async function createWebGpuEscape({ powerPreference = "low-power" } = {}) {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  let device;
  let adapterName = "";
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) return null;
    const info = adapter.info || (await adapter.requestAdapterInfo?.()) || {};
    adapterName = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ");
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

  function params(buf, state, orbit, row0) {
    const f = new Float32Array(20);
    const u = new Uint32Array(f.buffer);
    const rot = state.rotation || 0;
    f.set([buf.w, buf.h, state.cx, state.cy, Math.cos(rot), Math.sin(rot), orbit?.ox || 0, orbit?.oy || 0, state.juliaRe || 0, state.juliaIm || 0, state.radius, state.power || 2, state.bailout || 4, state.extra || 0]);
    u[14] = Math.max(1, state.iters | 0);
    u[15] = state.formula | 0;
    u[16] = state.skipInterior ? 1 : 0;
    u[17] = orbit ? 1 : 0;
    u[18] = orbitN;
    u[19] = row0;
    return f;
  }

  /**
   * The whole frame in one submission: bands of rows, each its own dispatch
   * so no single GPU command runs long, then one readback. Waiting on the
   * GPU per band costs a round trip each (100+ ms on some drivers).
   */
  async function frame(buf, state, orbit, budgetOps) {
    const { w, h } = buf;
    const bytes = w * h * 8;
    ensure(bytes);
    if (orbit) setOrbit(orbit);
    const iters = Math.max(1, state.iters | 0);
    const rows = Math.max(8, Math.min(h, Math.floor(budgetOps / (w * iters)) & ~7));
    const enc = device.createCommandEncoder();
    const uniforms = [];
    let bands = 0;
    for (let y = 0; y < h; y += rows) {
      const n = Math.min(rows, h - y);
      const ub = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ub, 0, params(buf, state, orbit, y));
      uniforms.push(ub);
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ub } },
          { binding: 1, resource: { buffer: orbitBuf } },
          { binding: 2, resource: { buffer: outBuf, size: bytes } },
        ],
      });
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(n / 8));
      pass.end();
      bands += 1;
    }
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, bytes);
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    const ms = performance.now() - t0;
    const data = new Float32Array(readBuf.getMappedRange(0, bytes));
    const { iter, extra, alpha } = buf;
    for (let i = 0; i < w * h; i += 1) {
      const it = data[2 * i];
      if (it < 0) {
        alpha[i] = 0;
        iter[i] = 0;
        extra[i] = data[2 * i + 1];
      } else {
        alpha[i] = 1;
        iter[i] = it;
        extra[i] = data[2 * i + 1];
      }
    }
    readBuf.unmap();
    for (const ub of uniforms) ub.destroy();
    return { ms, bands };
  }

  return {
    adapterName,
    get lost() {
      return lost;
    },
    /**
     * Fills buf; orbit { Z, N, ox, oy } enables perturbation. budgetOps caps
     * pixel-iterations per dispatch (about 1-3 ms each on a mid-range GPU).
     */
    async fill(buf, state, { orbit = null, budgetOps = 2e8 } = {}) {
      buf.source = 0;
      const r = await frame(buf, state, orbit, budgetOps);
      return { worstMs: r.ms, gpuMs: r.ms, bands: r.bands };
    },
    destroy() {
      device.destroy();
    },
  };
}
