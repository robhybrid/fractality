/**
 * WebGPU ray marcher for the 3D fractals, drawing straight into its own
 * canvas laid over the 2D one. Nothing is read back to JavaScript.
 *
 * Two passes: the march writes palette position, light and kind per pixel
 * into a float texture (only when the camera or shape changes); a cheap
 * second pass colors that texture every frame, so palette cycling does not
 * re-march the scene. The canvas is rendered at the march size and CSS
 * stretches it, so the browser filters the finished colors.
 *
 * Same formulas, distance estimators and shading as fillRay in kernel.js,
 * in 32-bit floats, which hold until the camera is within ~1e-5 of the surface.
 */

const COMMON = /* wgsl */ `
struct U {
  eye: vec3f, aspect: f32,
  fwd: vec3f, focal: f32,
  right: vec3f, pixel: f32,
  up: vec3f, bound: f32,
  julia: vec3f, power: f32,
  light: vec3f, phase: f32,
  bg: vec3f, density: f32,
  size: vec2f, steps: u32, iters: u32,
  shape: u32, mode: u32, gain: f32, floorEps: f32,
};
@group(0) @binding(0) var<uniform> P: U;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}
`;

const MARCH = /* wgsl */ `
fn bulb(p: vec3f, c: vec3f, grow: f32) -> f32 {
  var z = p;
  var dr = 1.0;
  var r = 0.0;
  let pw = clamp(P.power, 2.0, 10.0);
  for (var i = 0u; i < P.iters; i++) {
    r = length(z);
    if (r >= 2.0) { break; }
    if (r > 0.0001) {
      let theta = acos(clamp(z.z / r, -1.0, 1.0)) * pw;
      let phi = atan2(z.y, z.x) * pw;
      let rp = pow(r, pw - 1.0);
      dr = rp * pw * dr + grow;
      let zr = rp * r;
      z = zr * vec3f(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)) + c;
    }
  }
  return 0.5 * log(max(r, 1e-3)) * r / max(dr, 1e-3);
}

fn mbox(p: vec3f) -> f32 {
  var z = p;
  var dr = 1.0;
  let s = P.power;
  for (var i = 0u; i < P.iters; i++) {
    z = clamp(z, vec3f(-1.0), vec3f(1.0)) * 2.0 - z;
    let r2 = dot(z, z);
    if (r2 < 0.25) {
      z *= 4.0;
      dr *= 4.0;
    } else if (r2 < 1.0) {
      z /= r2;
      dr /= r2;
    }
    z = z * s + p;
    dr = dr * abs(s) + 1.0;
  }
  return length(z) / max(abs(dr), 1e-4);
}

fn sdBox(p: vec3f, b: f32) -> f32 {
  let q = abs(p) - vec3f(b);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn menger(p: vec3f) -> f32 {
  var d = sdBox(p, 1.05);
  var s = 1.0;
  for (var i = 0u; i < P.iters; i++) {
    var a = (p * s) % vec3f(2.0) - vec3f(1.0);
    a = select(a, a + vec3f(2.0), a < vec3f(-1.0));
    s *= 3.0;
    let r = abs(vec3f(1.0) - 3.0 * abs(a));
    let c = (min(max(r.x, r.y), min(max(r.y, r.z), max(r.z, r.x))) - 1.0) / s;
    d = max(d, c);
  }
  return d;
}

fn tetra(p: vec3f) -> f32 {
  var z = p;
  var scale = 1.0;
  for (var i = 0u; i < P.iters; i++) {
    if (z.x + z.y < 0.0) { z = vec3f(-z.y, -z.x, z.z); }
    if (z.x + z.z < 0.0) { z = vec3f(-z.z, z.y, -z.x); }
    if (z.y + z.z < 0.0) { z = vec3f(z.x, -z.z, -z.y); }
    z = z * 2.0 - vec3f(1.0);
    scale *= 2.0;
  }
  return (length(z) - 1.45) / scale;
}

fn quat(p: vec3f) -> f32 {
  var q = vec4f(p, 0.0);
  var dr = 1.0;
  var r2 = 0.0;
  for (var i = 0u; i < P.iters; i++) {
    r2 = dot(q, q);
    if (r2 > 1e4) { break; }
    dr = 2.0 * sqrt(r2) * dr;
    q = vec4f(q.x * q.x - q.y * q.y - q.z * q.z - q.w * q.w + P.julia.x, 2.0 * q.x * q.y + P.julia.y, 2.0 * q.x * q.z + P.julia.z, 2.0 * q.x * q.w);
  }
  let r = sqrt(max(r2, 1e-8));
  return 0.5 * log(r) * r / max(dr, 1e-3);
}

fn scene(p: vec3f) -> f32 {
  switch P.shape {
    case 0u: { return bulb(p, p, 1.0); }
    case 1u: { return mbox(p); }
    case 2u: { return menger(p); }
    case 3u: { return tetra(p); }
    case 4u: { return bulb(p, P.julia, 0.0); }
    case 5u: { return quat(p); }
    default: {
      let t = clamp(P.julia.z, 0.0, 1.0);
      return bulb(p, vec3f(p.x + (P.julia.x - p.x) * t, p.y + (P.julia.y - p.y) * t, p.z * (1.0 - t)), 1.0 - t);
    }
  }
}

@fragment
fn march(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(pos.x / P.size.x * 2.0 - 1.0, 1.0 - pos.y / P.size.y * 2.0);
  let dir = normalize(P.fwd * P.focal + P.right * uv.x * P.aspect + P.up * uv.y);
  let b = dot(P.eye, dir);
  let disc = b * b - (dot(P.eye, P.eye) - P.bound * P.bound);
  if (disc <= 0.0) { return vec4f(0.0); }
  let far = -b + sqrt(disc);
  if (far <= 0.0) { return vec4f(0.0); }
  var t = max(0.0, -b - sqrt(disc));
  var glow = 0.0;
  var hit = false;
  var used = 0u;
  var near = 1e9;
  var nearT = t;
  let glowGain = 0.07 * min(1.0, 18.0 / f32(P.steps));
  for (var i = 0u; i < P.steps; i++) {
    if (t > far) { break; }
    let d = scene(P.eye + dir * t);
    let eps = max(P.floorEps, t * P.pixel);
    glow += exp(-max(d, 0.0) / max(t, eps) * 17.0) * glowGain;
    used = i;
    if (d / eps < near) {
      near = d / eps;
      nearT = t;
    }
    if (d < eps) {
      hit = true;
      break;
    }
    t += min(0.4, max(eps * 0.5, d * 0.92));
  }
  let lit = P.mode > 0u;
  if (lit && !hit && near < 6.0) {
    hit = true;
    t = nearT;
  }
  let marchShade = 1.0 - f32(used) / max(f32(P.steps), 1.0);
  if (!lit) {
    if (!hit && glow < 0.03) { return vec4f(0.0); }
    let shade = select(glow, marchShade, hit);
    return vec4f(shade * 36.0 + glow * 28.0, 1.0, 0.0, 1.0);
  }
  if (!hit) { return vec4f(0.0); }
  let p = P.eye + dir * t;
  let eps = max(P.floorEps, t * P.pixel);
  let h = eps * 0.7;
  let ka = scene(p + vec3f(h, -h, -h));
  let kb = scene(p + vec3f(-h, -h, h));
  let kc = scene(p + vec3f(-h, h, -h));
  let kd = scene(p + vec3f(h, h, h));
  var n = normalize(vec3f(ka - kb - kc + kd, -ka - kb + kc + kd, -ka + kb - kc + kd) + vec3f(1e-12));
  let nv = -dot(n, dir);
  if (nv < 0.0) { n = -n; }
  let probe = eps * 14.0;
  let occ = clamp(scene(p + n * probe) / probe, 0.0, 1.0);
  let ao = clamp((0.35 + 0.65 * occ) * (0.4 + 0.6 * marchShade), 0.15, 1.0);
  let nL = dot(n, P.light);
  let diff = max(0.0, nL);
  let refl = 2.0 * nL * n - P.light;
  let spec = select(0.0, pow(max(0.0, -dot(refl, dir)), 28.0), diff > 0.0);
  let rim = pow(1.0 - max(0.0, abs(nv)), 3.0);
  let sky = max(0.0, dot(n, P.up));
  let light = min(1.0, 0.1 + 0.72 * diff * ao + 0.18 * sky * ao + 0.38 * spec + 0.14 * rim);
  if (P.mode == 1u) { return vec4f(length(p) * 9.0 + marchShade * 14.0, sqrt(light), 0.0, 1.0); }
  if (P.mode == 4u) { return vec4f(-log2(max(t, 1e-12)) * 6.0, sqrt(min(1.0, 0.2 + 0.8 * ao * (0.4 + 0.6 * diff))), 0.0, 1.0); }
  if (P.mode == 2u) {
    let k = sqrt(light);
    let warm = 0.04 * sky;
    return vec4f(k * (0.9 - warm), k * 0.86, k * (0.8 + warm * 2.0), 2.0);
  }
  let k = sqrt(0.3 + 0.7 * light * 1.1);
  return vec4f((n * 0.5 + 0.5) * k, 2.0);
}
`;

const COLOR = /* wgsl */ `
@group(0) @binding(1) var marched: texture_2d<f32>;
@group(0) @binding(2) var lut: texture_2d<f32>;

@fragment
fn color(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let m = textureLoad(marched, vec2i(pos.xy), 0);
  if (m.w < 0.5) { return vec4f(P.bg, 1.0); }
  if (m.w > 1.5) { return vec4f(min(m.xyz * P.gain, vec3f(1.0)), 1.0); }
  let step = i32(floor(m.x * P.density * 1024.0 + P.phase * 1024.0));
  let c = textureLoad(lut, vec2i(((step % 1024) + 1024) % 1024, 0), 0).rgb;
  return vec4f(c * m.y, 1.0);
}
`;

export const SHAPE_COUNT = 7;

export async function createRay3d({ powerPreference = "low-power" } = {}) {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  let device;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) return null;
    device = await adapter.requestDevice();
  } catch {
    return null;
  }
  let lost = false;
  device.lost.then(() => {
    lost = true;
  });
  const format = navigator.gpu.getPreferredCanvasFormat();
  const canvas = document.createElement("canvas");
  canvas.className = "ray3d-layer";
  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    return null;
  }
  context.configure({ device, format, alphaMode: "opaque" });
  device.pushErrorScope("validation");
  const marchModule = device.createShaderModule({ code: COMMON + MARCH });
  const colorModule = device.createShaderModule({ code: COMMON + COLOR });
  const infos = await Promise.all([marchModule.getCompilationInfo?.(), colorModule.getCompilationInfo?.()]);
  if (infos.some((info) => info?.messages?.some((m) => m.type === "error"))) {
    device.destroy();
    return null;
  }
  const marchPipe = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: marchModule, entryPoint: "vs" },
    fragment: { module: marchModule, entryPoint: "march", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list" },
  });
  const colorPipe = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: colorModule, entryPoint: "vs" },
    fragment: { module: colorModule, entryPoint: "color", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  if (await device.popErrorScope()) {
    device.destroy();
    return null;
  }
  const uniform = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lutTex = device.createTexture({ size: [1024, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  let marchTex = null;
  let marchGroup = null;
  let colorGroup = null;
  let w = 0;
  let h = 0;
  let marchKey = "";
  let colorKey = "";
  let lutKey = "";
  let shown = false;
  const data = new ArrayBuffer(144);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);

  function resize(nw, nh) {
    if (nw === w && nh === h && marchTex) return;
    w = nw;
    h = nh;
    canvas.width = w;
    canvas.height = h;
    marchTex?.destroy();
    marchTex = device.createTexture({ size: [w, h], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    marchGroup = device.createBindGroup({ layout: marchPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    colorGroup = device.createBindGroup({
      layout: colorPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: marchTex.createView() },
        { binding: 2, resource: lutTex.createView() },
      ],
    });
    marchKey = "";
    colorKey = "";
  }

  return {
    canvas,
    get lost() {
      return lost;
    },
    /**
     * s: { camera, steps, rayIters, formula, power, julia [x,y,z], shade (0..4),
     * pixel, floorEps, bound, light [x,y,z], phase, density, gain, bg [r,g,b] }
     * in 0..1; lut: Uint32Array, its first 1024 entries are the palette row.
     */
    draw(s, nw, nh, lut, key) {
      resize(nw, nh);
      if (key.lut !== lutKey) {
        device.queue.writeTexture({ texture: lutTex }, new Uint8Array(lut.buffer, lut.byteOffset, 1024 * 4), { bytesPerRow: 1024 * 4 }, [1024, 1]);
        lutKey = key.lut;
      }
      const cam = s.camera;
      f.set([...cam.eye, w / h, ...cam.forward, s.focal, ...cam.right, s.pixel, ...cam.up, s.bound, ...s.julia, s.power, ...s.light, s.phase - Math.floor(s.phase), ...s.bg, s.density, w, h]);
      u[30] = s.steps;
      u[31] = s.iters;
      u[32] = s.shape;
      u[33] = s.mode;
      f[34] = s.gain;
      f[35] = s.floorEps;
      device.queue.writeBuffer(uniform, 0, data);
      const enc = device.createCommandEncoder();
      const remarch = key.march !== marchKey;
      if (remarch) {
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: marchTex.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
        pass.setPipeline(marchPipe);
        pass.setBindGroup(0, marchGroup);
        pass.draw(3);
        pass.end();
        marchKey = key.march;
      }
      if (remarch || key.color !== colorKey) {
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
        pass.setPipeline(colorPipe);
        pass.setBindGroup(0, colorGroup);
        pass.draw(3);
        pass.end();
        colorKey = key.color;
      }
      device.queue.submit([enc.finish()]);
      return remarch;
    },
    /** Lays the canvas over `under` (fixed, no pointer events) and shows it. */
    show(under) {
      if (!canvas.parentNode && under.parentNode) under.parentNode.insertBefore(canvas, under.nextSibling);
      const rect = under.getBoundingClientRect();
      const st = canvas.style;
      st.position = "fixed";
      st.left = `${rect.left}px`;
      st.top = `${rect.top}px`;
      st.width = `${rect.width}px`;
      st.height = `${rect.height}px`;
      st.pointerEvents = "none";
      st.zIndex = "0";
      if (!shown) {
        st.visibility = "";
        shown = true;
      }
    },
    hide() {
      if (!shown) return;
      canvas.style.visibility = "hidden";
      shown = false;
    },
    get visible() {
      return shown;
    },
    destroy() {
      canvas.remove();
      device.destroy();
    },
  };
}
