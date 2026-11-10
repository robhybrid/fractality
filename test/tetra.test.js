import assert from "node:assert/strict";
import test from "node:test";
import { lookCamera, orbitEye } from "../src/engine/flight.js";
import { RAY_FOCAL, createBuffer, fillAll, mapScene, setTetraLod } from "../src/engine/kernel.js";

function reference(px, py, pz, iters) {
  let x = px;
  let y = py;
  let z = pz;
  let scale = 1;
  for (let i = 0; i < iters; i += 1) {
    if (x + y < 0) {
      const tx = -y;
      y = -x;
      x = tx;
    }
    if (x + z < 0) {
      const tx = -z;
      z = -x;
      x = tx;
    }
    if (y + z < 0) {
      const ty = -z;
      z = -y;
      y = ty;
    }
    x = x * 2 - 1;
    y = y * 2 - 1;
    z = z * 2 - 1;
    scale *= 2;
  }
  return (Math.hypot(x, y, z) - 1.45) / scale;
}

function at(x, y, z, iters = 16) {
  return mapScene(x, y, z, 3, 2, iters);
}

test("tetrahedron distance matches the fold when screen splitting is off", () => {
  setTetraLod(null);
  const points = [
    [0.2, 0.3, 0.4],
    [-0.4, 0.2, 0.7],
    [0.9, -0.2, -0.3],
    [0, 0, 0],
  ];
  for (const [x, y, z] of points) {
    for (const n of [1, 3, 6, 10]) assert.ok(Math.abs(at(x, y, z, n) - reference(x, y, z, n)) < 1e-12);
  }
});

test("a sphere smaller than the threshold stays one sphere", () => {
  const p = [0.2, 0.15, 0.4];
  const root = Math.hypot(...p) - 1.45;
  // Camera on the z axis, 8 away. Root diameter is about 0.182 * focalH pixels.
  setTetraLod([0, 0, 8], 40, 8);
  assert.ok(Math.abs(at(...p) - root) < 1e-12);
  setTetraLod([0, 0, 8], 40, 1);
  assert.ok(Math.abs(at(...p) - root) > 1e-4);
});

test("splitting never goes past one sphere per pixel", () => {
  const p = [0.25, 0.2, 0.35];
  setTetraLod([0, 0, 2.2], 900, 0.25);
  const asked = at(...p, 24);
  setTetraLod([0, 0, 2.2], 900, 1);
  const capped = at(...p, 24);
  assert.equal(asked, capped);
  setTetraLod(null);
  const full = at(...p, 24);
  assert.notEqual(capped, full);
});

test("a closer viewpoint splits spheres a far one still draws whole", () => {
  const p = [0.3, 0.25, 0.2];
  setTetraLod(null);
  const levels = [0, 1, 2, 3, 4, 5, 6, 8, 12].map((n) => reference(...p, n));
  const match = (eye, focalH) => {
    setTetraLod(eye, focalH, 1);
    const d = at(...p, 24);
    let best = 0;
    let err = Infinity;
    levels.forEach((value, i) => {
      const e = Math.abs(value - d);
      if (e < err) {
        err = e;
        best = i;
      }
    });
    assert.ok(err < 1e-9);
    return best;
  };
  const far = match([0, 0, 12], 220);
  const near = match([0, 0, 1.7], 220);
  assert.ok(near > far);
});

test("the tetrahedron frame paints with per-sphere detail", () => {
  const eye = orbitEye(0.7, 0.38, 2.7);
  const buf = createBuffer(24, 16);
  fillAll(buf, {
    family: "ray",
    formula: 3,
    w: 24,
    h: 16,
    rayIters: 16,
    steps: 24,
    spherePx: 1,
    power: 2,
    shade3d: "glow",
    camera: lookCamera(eye, 0.7, 0.38),
  });
  let hit = 0;
  for (let i = 0; i < buf.alpha.length; i += 1) if (buf.alpha[i]) hit += 1;
  assert.ok(hit > 8);
  setTetraLod(null);
});
