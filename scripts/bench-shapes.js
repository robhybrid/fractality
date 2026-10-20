// Times the Sierpinski triangle and carpet kernels: node scripts/bench-shapes.js
import { frameInfo, frameSpec, renormStep } from "../src/engine/frames.js";
import { createBuffer, fillAll } from "../src/engine/kernel.js";

const w = 1536;
const h = 960;

function settle(kind, view) {
  for (let guard = 0; guard < 4096; guard += 1) {
    const step = renormStep(kind, view.digits, view.cx, view.cy, view.radius * Math.hypot(1, w / h));
    if (!step) break;
    view.digits = step.digits;
    view.cx = (view.cx - step.ox) * step.S;
    view.cy = (view.cy - step.oy) * step.S;
    view.radius *= step.S;
  }
  return view;
}

function bench(name, formula, kind, cx, cy, depth, rotation) {
  const view = settle(kind, { digits: [], cx, cy, radius: 0.3 * frameSpec(kind).scale ** -depth });
  const state = { family: "shape", formula, cx: view.cx, cy: view.cy, radius: view.radius, rotation, w, h, frame: frameInfo(kind, view.digits) };
  const buf = createBuffer(w, h);
  for (let i = 0; i < 3; i += 1) fillAll(buf, state);
  const runs = 20;
  const t = performance.now();
  for (let i = 0; i < runs; i += 1) fillAll(buf, state);
  console.log(`${name.padEnd(28)} ${((performance.now() - t) / runs).toFixed(2)} ms`);
}

bench("triangle home", 12, "tri", 0.5, 0.433, -1, 0);
bench("triangle depth 30", 12, "tri", 0.453829, 0.453562, 30, 0.3);
bench("triangle touch point d30", 12, "tri", 0.5, 1e-9, 30, 0.3);
bench("carpet home", 13, "square", 0.5, 0.5, -1, 0);
bench("carpet depth 12", 13, "square", 0.10000001, 0.2700003, 12, 0.3);
