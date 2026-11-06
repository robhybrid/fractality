import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAlgo, parseAlgorithm } from "../src/algorithm.js";
import { FRACTALS } from "../src/data.js";
import { cpowc, createBuffer, escapeContext, escapePixel, fillAll } from "../src/engine/kernel.js";

test("normalizeAlgo strips spaces and case", () => {
  assert.equal(normalizeAlgo(" Z^2 + C "), "z^2+c");
});

test("parseAlgorithm maps preset strings", () => {
  const phoenix = parseAlgorithm("z^c", FRACTALS);
  assert.equal(phoenix.formula, 17);
  assert.equal(phoenix.family, "escape");

  const burning = parseAlgorithm("(|x|+i|y|)^2+c", FRACTALS);
  assert.equal(burning.id, "burning");

  const multi = parseAlgorithm("z^3+c", FRACTALS);
  assert.equal(multi.formula, 0);
  assert.equal(multi.power, 3);
});

test("parseAlgorithm keeps Julia when z^2+c is ambiguous", () => {
  const julia = FRACTALS.find((f) => f.id === "julia");
  const parsed = parseAlgorithm("z^2+c", FRACTALS, julia);
  assert.equal(parsed.id, "julia");
  assert.equal(parsed.formula, 1);
});

test("The Phoenix fractal is registered", () => {
  const f = FRACTALS.find((item) => item.id === "thephoenix");
  assert.ok(f);
  assert.equal(f.name, "The Phoenix");
  assert.equal(f.algorithm, "z^c");
  assert.equal(f.formula, 17);
});

test("cpowc matches real powers on the real line", () => {
  const [re, im] = cpowc(2, 0, 3, 0);
  assert.ok(Math.abs(re - 8) < 1e-9);
  assert.ok(Math.abs(im) < 1e-9);
});

test("formula 17 paints escape bands", () => {
  const buf = createBuffer(48, 32);
  const state = {
    family: "escape",
    formula: 17,
    cx: 0,
    cy: 0,
    radius: 1.8,
    rotation: 0,
    power: 2,
    bailout: 64,
    iters: 64,
    w: 48,
    h: 32,
    skipInterior: false,
  };
  fillAll(buf, state);
  let escaped = 0;
  let inside = 0;
  for (let i = 0; i < buf.iter.length; i += 1) {
    if (buf.alpha[i]) escaped += 1;
    else inside += 1;
  }
  assert.ok(escaped > 10, `expected escaped pixels, got ${escaped}`);
  assert.ok(inside > 10, `expected interior pixels, got ${inside}`);

  const one = createBuffer(1, 1);
  const c = escapeContext(state);
  escapePixel(one, 0, 0.2, 0.1, c);
  assert.equal(one.alpha[0], 0);
  escapePixel(one, 0, 1.6, 1.2, c);
  assert.equal(one.alpha[0], 1);
});
