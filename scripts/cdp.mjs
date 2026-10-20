// Minimal Chrome DevTools driver for the deep zoom scripts (Node 22 WebSocket).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openChrome({ port = Number(process.env.CDP_PORT || 9334), outDir = process.env.OUT || "/tmp/deep-shots" } = {}) {
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
  const close = () => {
    ws.close();
    chrome.kill("SIGKILL");
  };
  return { send, evaluate, shot, logs, close };
}

/** Engine and presenter state, plus how varied the shown frame is. */
export const PROBE = `(() => {
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

export async function settle(evaluate, limitMs = 120000) {
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
