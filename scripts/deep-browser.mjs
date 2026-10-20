// Headless Chrome checks of deep zoom: node scripts/deep-browser.mjs [baseUrl]
// Needs the dev server (npx vite --port 5174) and google-chrome.
import { PROBE, openChrome, settle as settleWith, sleep } from "./cdp.mjs";

const base = process.argv[2] || "http://127.0.0.1:5174/";
const { send, evaluate, shot, logs, close } = await openChrome();
const settle = () => settleWith(evaluate);

const FRAMES = `(() => { window.__ft = []; let last = performance.now(); const tick = (now) => { window.__ft.push(now - last); last = now; if (window.__ft.length < 100000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`;
const FRAME_STATS = `(() => { const a = window.__ft.slice(2); window.__ft = []; a.sort((x, y) => x - y); const avg = a.reduce((s, v) => s + v, 0) / a.length; return { n: a.length, avgMs: +avg.toFixed(1), p95Ms: +a[Math.floor(a.length * 0.95)].toFixed(1), maxMs: +a[a.length - 1].toFixed(1) }; })()`;

const spots = JSON.parse(process.env.SPOTS || "null") || [
  { r: 1e-20, x: "-0.742958017245381840661709909", y: "0.131858595813222370239207399" },
  { r: 1e-50, x: "-0.742958017245381840652804495146849146106104564112693466796", y: "0.131858595813222370238146495121027483795731191149383086815" },
  { r: 1e-100, x: "-0.74295801724538184065280449514684914610610456411269338545430353956317474430376390862856477348244741536589892", y: "0.13185859581322237023814649512102748379573119114938349696378653604109679462431979749077787147407710066571111" },
  { r: 1e-200, x: "-0.742958017245381840652804495146849146106104564112693385454303539563174744303763908628564773482447415391553693548643226407021216623833131793522607315562034826046525107463154932692819646859164728353793684144078", y: "0.131858595813222370238146495121027483795731191149383496963786536041096794624319797490777871474077100674205836417219928814131041464468088717369225767115043927450145734051964933067254483139797314974891071931154" },
];

const report = [];
for (const spot of spots) {
  await send("Page.navigate", { url: `${base}?re=${spot.x}&im=${spot.y}&r=${spot.r}` });
  await sleep(1500);
  const p = await settle();
  await shot(`still-${spot.r}`);
  const row = { r: spot.r, settleMs: p.settleMs, frameMs: p.info?.ms, size: `${p.w}x${p.h}`, iters: p.iters, distinct: p.distinct, inside: p.inside, orbitN: p.orbit?.N, orbitMs: p.orbit?.ms, coords: p.coords };
  if (process.env.ZOOM !== "0") {
    const serial0 = (await evaluate(PROBE)).info?.serial || 0;
    await evaluate(FRAMES);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 420 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 900, y: 420, button: "left", buttons: 1, clickCount: 1 });
    const fps = [];
    for (let i = 0; i < 10; i += 1) {
      await sleep(300);
      fps.push(await evaluate("Math.round(window.fractality.fps)"));
    }
    await shot(`zooming-${spot.r}`);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 900, y: 420, button: "left", buttons: 0, clickCount: 1 });
    const ft = await evaluate(FRAME_STATS);
    const after = await evaluate(PROBE);
    row.zoomFrames = `${ft.avgMs}/${ft.p95Ms}/${ft.maxMs}`;
    row.zoomFps = fps.join(",");
    row.radiusAfterZoom = after.radius.toExponential(2);
    row.motionSize = `${after.w}x${after.h}`;
    row.framesDuringZoom = (after.info?.serial || 0) - serial0;
    row.lastMotionMs = after.info?.ms;
  }
  if (process.env.DEBUG) console.log(await evaluate(`JSON.stringify({ desc: window.fractality.renderer.shown && window.fractality.renderer.job, dbg: (() => { const e = window.fractality; const r = e.renderer; const cur = r.deepRef.current; return { anchorBits: e.anchor?.bits, curBits: cur?.bits, sample: Array.from(r.shown.buf.iter.slice(0, 5)), state: r.lastJobSig.slice(0, 200) }; })(), hint: window.fractality.renderer.deepRef.hint, cur: { ...window.fractality.renderer.deepRef.current, x: 0, y: 0 }, pending: !!window.fractality.renderer.deepRef.pending, info: window.fractality.deepInfo, cx: window.fractality.cx, cy: window.fractality.cy, r: window.fractality.radius })`));
  report.push(row);
  console.log(JSON.stringify(row));
}
console.table(report.map(({ coords, ...r }) => r));
console.log("logs:", logs.filter((l) => !/vite|React DevTools/i.test(l)).slice(0, 20));
close();
process.exit(0);
