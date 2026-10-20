// Headless Chrome checks of deep zoom: node scripts/deep-browser.mjs [baseUrl]
// Needs the dev server (npx vite --port 5174) and google-chrome.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9334);
const base = process.argv[2] || "http://127.0.0.1:5174/";
const outDir = process.env.OUT || "/tmp/deep-shots";
mkdirSync(outDir, { recursive: true });
const chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--user-data-dir=/tmp/chrome-deep",
  "--hide-scrollbars",
  "--window-size=1536,960",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i += 1) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.consoleAPICalled") logs.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  else if (msg.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
};
const send = (method, params = {}) =>
  new Promise((r) => {
    id += 1;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300));
  return res.result?.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.result.data, "base64"));
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1536, height: 960, deviceScaleFactor: 1, mobile: false });

const PROBE = `(() => {
  const e = window.fractality;
  if (!e) return null;
  const r = e.renderer;
  const buf = r.shown?.buf;
  let distinct = 0, inside = 0;
  if (buf) {
    const set = new Set();
    for (let i = 0; i < buf.iter.length; i += 1) {
      if (buf.alpha[i]) set.add(Math.floor(buf.iter[i] * 4)); else inside += 1;
    }
    distinct = set.size;
    inside = inside / buf.iter.length;
  }
  return { job: !!r.job, info: e.deepInfo, iters: e.view.iters, deep: !!e.anchor, radius: e.radius, status: document.querySelector('.status')?.textContent, coords: document.querySelector('.coords')?.textContent, w: buf?.w, h: buf?.h, distinct, inside: +inside.toFixed(3), soft: e.wasSoft, orbit: r.deepRef?.current ? { N: r.deepRef.current.N, ms: Math.round(r.deepRef.current.ms), bits: r.deepRef.current.bits } : null };
})()`;

async function settle(limitMs = 90000) {
  const t0 = Date.now();
  let last = "";
  let stableSince = 0;
  let p;
  while (Date.now() - t0 < limitMs) {
    await sleep(300);
    p = await evaluate(PROBE);
    if (!p) continue;
    const sig = JSON.stringify([p.job, p.iters, p.info?.serial, p.w]);
    if (!p.job && !p.soft && p.info && !p.info.soft && p.info.iters === p.iters && p.w > 400) {
      if (sig === last) {
        if (Date.now() - stableSince > 1200) return { ...p, settleMs: Date.now() - t0 };
      } else stableSince = Date.now();
    }
    last = sig;
  }
  return { ...p, settleMs: "timeout" };
}

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
  }
  if (process.env.DEBUG) console.log(await evaluate(`JSON.stringify({ hint: window.fractality.renderer.deepRef.hint, cur: { ...window.fractality.renderer.deepRef.current, x: 0, y: 0 }, pending: !!window.fractality.renderer.deepRef.pending, info: window.fractality.deepInfo, cx: window.fractality.cx, cy: window.fractality.cy, r: window.fractality.radius })`));
  report.push(row);
  console.log(JSON.stringify(row));
}
console.table(report.map(({ coords, ...r }) => r));
console.log("logs:", logs.filter((l) => !/vite|React DevTools/i.test(l)).slice(0, 20));
ws.close();
chrome.kill("SIGKILL");
process.exit(0);
