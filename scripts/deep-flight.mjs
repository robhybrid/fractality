// Long deep-zoom flight in headless Chrome: node scripts/deep-flight.mjs [baseUrl]
// Zooms from 1e-20 toward a deep spot past 1e-100, pans far enough to move the
// anchor, then resets to the home view, checking the image at each stage.
import { PROBE, openChrome, settle, sleep } from "./cdp.mjs";

const base = process.argv[2] || "http://127.0.0.1:5174/";
const target = process.env.DEPTH ? Number(process.env.DEPTH) : 1e-105;
const x = "-0.74295801724538184065280449514684914610610456411269338545430353956317474430376390862856477348244741536589892";
const y = "0.13185859581322237023814649512102748379573119114938349696378653604109679462431979749077787147407710066571111";
const { send, evaluate, shot, logs, close } = await openChrome();

await send("Page.navigate", { url: `${base}?re=${x}&im=${y}&r=1e-20` });
await sleep(1500);
await settle(evaluate, 60000);

// Hold the zoom button at the screen center, zooming ~3 decades per second
// (several times the normal rate) so frames are rendered as motion frames.
const flight = await evaluate(`new Promise((done) => {
  const e = window.fractality;
  const { w, h } = e.screenSize();
  const marks = [];
  const t0 = performance.now();
  let frames = 0;
  let worst = 0;
  let last = t0;
  let orbits = 0;
  let lastOrbit = null;
  let shownSerial = e.renderer.shown?.serial;
  let fresh = 0;
  e.mx = w / 2;
  e.my = h / 2;
  e.buttons.add(0);
  e.zoomTarget = 7;
  const tick = (now) => {
    frames += 1;
    worst = Math.max(worst, now - last);
    last = now;
    const cur = e.renderer.deepRef?.current;
    if (cur && cur !== lastOrbit) { orbits += 1; lastOrbit = cur; }
    if (e.renderer.shown?.serial !== shownSerial) { fresh += 1; shownSerial = e.renderer.shown?.serial; }
    if (frames % 60 === 0) marks.push({ r: e.radius.toExponential(1), bits: e.anchor?.bits, iters: e.view.iters, shown: e.renderer.shown?.buf.w + 'x' + e.renderer.shown?.buf.h, orbitN: cur?.N, orbitBits: cur?.bits, fresh });
    if (e.radius > ${target}) requestAnimationFrame(tick);
    else {
      e.buttons.clear();
      e.zoomTarget = 0;
      done({ seconds: +((now - t0) / 1000).toFixed(1), frames, avgFrameMs: +((now - t0) / frames).toFixed(1), worstFrameMs: +worst.toFixed(1), orbits, freshFrames: fresh, marks });
    }
  };
  requestAnimationFrame(tick);
})`);
console.log("flight", JSON.stringify({ ...flight, marks: undefined }));
console.table(flight.marks);
const watch = setInterval(async () => {
  const q = await evaluate(PROBE);
  if (process.env.WATCH) console.log("watch", JSON.stringify({ job: q.job, soft: q.soft, iters: q.iters, info: q.info && { serial: q.info.serial, iters: q.info.iters, soft: q.info.soft, ms: q.info.ms, w: q.info.w, escHi: Math.round(q.info.escHi), un: q.info.unresolved } }));
}, 3000);
let p = await settle(evaluate, 180000);
clearInterval(watch);
await shot("flight-end");
console.log("after flight", JSON.stringify({ radius: p.radius, iters: p.iters, distinct: p.distinct, inside: p.inside, settleMs: p.settleMs, frameMs: p.info?.ms, orbit: p.orbit, coords: p.coords }));

// Zoom toward an off-center point for a few decades: the cursor's offset from
// the anchor grows relative to the radius until the anchor moves (rebases).
const offCenter = await evaluate(`new Promise((done) => {
  const e = window.fractality;
  const { w, h } = e.screenSize();
  const key = e.anchor.key;
  let lastX = e.anchor.x;
  let rebases = 0;
  const r0 = e.radius;
  e.mx = w * 0.62;
  e.my = h * 0.4;
  e.buttons.add(0);
  e.zoomTarget = 7;
  const tick = () => {
    if (e.anchor.x !== lastX) { rebases += 1; lastX = e.anchor.x; }
    if (e.radius > r0 * 1e-7) requestAnimationFrame(tick);
    else {
      e.buttons.clear();
      e.zoomTarget = 0;
      done({ rebases, sameKey: e.anchor.key === key, bits: e.anchor.bits, cxOverR: +(e.cx / e.radius).toFixed(2), radius: e.radius });
    }
  };
  requestAnimationFrame(tick);
})`);
console.log("off-center zoom", JSON.stringify(offCenter));
p = await settle(evaluate, 180000);
await shot("after-off-center");
console.log("after off-center", JSON.stringify({ distinct: p.distinct, inside: p.inside, iters: p.iters, settleMs: p.settleMs, frameMs: p.info?.ms, coords: p.coords }));

await evaluate("window.fractality.resetView()");
await sleep(9000);
p = await evaluate(PROBE);
await shot("after-reset");
console.log("after reset", JSON.stringify({ deep: p.deep, radius: p.radius, status: p.status, coords: p.coords, distinct: p.distinct }));
console.log("logs:", logs.filter((l) => !/vite|React DevTools/i.test(l)).slice(0, 20));
close();
process.exit(0);
