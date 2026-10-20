import { createBuffer, fillAll } from "../engine/kernel.js";
import { createGpuEscape, pickReference } from "../engine/gpuescape.js";
import { createWebGpuEscape } from "../engine/webgpu.js";

const W = 1536;
const H = 960;
const out = document.getElementById("out");
const log = (line) => {
  out.textContent += `${line}\n`;
};

function mismatch(ref, buf) {
  let bad = 0;
  for (let i = 0; i < ref.alpha.length; i += 1) if (ref.alpha[i] !== buf.alpha[i]) bad += 1;
  return `${((100 * bad) / ref.alpha.length).toFixed(3)}% inside/outside differ`;
}

async function workers(state, count) {
  const pool = Array.from({ length: count }, () => new Worker(new URL("../engine/fractalWorker.js", import.meta.url), { type: "module" }));
  const run = () =>
    new Promise((resolve) => {
      const rows = Math.max(4, Math.ceil(H / (count * 6)));
      const chunks = [];
      for (let y = 0; y < H; y += rows) chunks.push([y, Math.min(H, y + rows)]);
      let next = 0;
      let left = chunks.length;
      const go = (w) => {
        const [y0, y1] = chunks[next];
        next += 1;
        w.postMessage({ gen: 1, y0, y1, state });
      };
      for (const w of pool) {
        w.onmessage = () => {
          left -= 1;
          if (next < chunks.length) go(w);
          if (!left) resolve();
        };
        if (next < chunks.length) go(w);
      }
    });
  await run();
  const t0 = performance.now();
  await run();
  const ms = performance.now() - t0;
  for (const w of pool) w.terminate();
  return ms;
}

async function runAll() {
  out.textContent = "";
  const cores = navigator.hardwareConcurrency || 4;
  log(`cores ${cores}`);
  const views = [
    { tag: "100 iter, brute force", cx: -0.75, cy: 0, radius: 1.1, iters: 100, skipInterior: false },
    { tag: "100 iter, interior skip", cx: -0.75, cy: 0, radius: 1.1, iters: 100, skipInterior: true },
    { tag: "seahorse 1e-7, 1200 iter (perturbation on GPU)", cx: -0.743643887037151, cy: 0.13182590420533, radius: 1e-7, iters: 1200, skipInterior: true, perturb: true },
  ];
  const gl = createGpuEscape();
  const gpu = await createWebGpuEscape();
  log(`WebGL1 kernel: ${gl ? `ok (float textures ${gl.floatTex})` : "unavailable"}; WebGPU: ${gpu ? "ok" : "unavailable"}`);
  for (const v of views) {
    const state = { family: "escape", formula: 0, rotation: 0, power: 2, bailout: 4, juliaRe: 0, juliaIm: 0, extra: 0, w: W, h: H, ...v };
    log(`\n${v.tag}`);
    const ref = createBuffer(W, H);
    let t0 = performance.now();
    fillAll(ref, state);
    log(`  CPU 1 thread      ${(performance.now() - t0).toFixed(0)} ms`);
    for (const n of [Math.max(1, Math.min(6, Math.floor(cores / 2))), Math.max(1, cores - 1)]) log(`  CPU ${n} workers     ${(await workers(state, n)).toFixed(0)} ms`);
    const orbit = v.perturb ? pickReference(state, state.iters) : null;
    if (gl && (!orbit || gl.floatTex)) {
      gl.setBudget(1e9, 1e12);
      gl.fill(createBuffer(64, 40), { ...state, w: 64, h: 40 }, orbit);
      const buf = createBuffer(W, H);
      t0 = performance.now();
      gl.fill(buf, state, orbit);
      log(`  WebGL1 one draw   ${(performance.now() - t0).toFixed(0)} ms incl. readback, ${mismatch(ref, buf)}`);
      gl.setBudget(6, 2e5);
      t0 = performance.now();
      const job = gl.begin(createBuffer(W, H), state, orbit);
      while (!gl.step(job));
      log(`  WebGL1 6ms tiles  ${(performance.now() - t0).toFixed(0)} ms back-to-back, ${job.tiles} tiles, slowest probe ${job.gpuMs.toFixed(1)} ms`);
    }
    if (gpu) {
      await gpu.fill(createBuffer(64, 40), { ...state, w: 64, h: 40 }, { orbit, eager: true });
      const buf = createBuffer(W, H);
      t0 = performance.now();
      const r = await gpu.fill(buf, state, { orbit, eager: true, budgetMs: 1e9 });
      log(`  WebGPU            ${(performance.now() - t0).toFixed(0)} ms incl. readback (slowest dispatch ${r.worstMs.toFixed(1)} ms), ${mismatch(ref, buf)}`);
    }
  }
  log("\ndone");
}

document.getElementById("run").addEventListener("click", () => runAll().catch((e) => log(String(e?.stack || e))));
if (new URLSearchParams(location.search).has("auto")) runAll().catch((e) => log(String(e?.stack || e)));
