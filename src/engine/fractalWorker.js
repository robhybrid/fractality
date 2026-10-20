import { createBuffer, fillRows, shadeLevels } from "./kernel.js";

self.onmessage = (event) => {
  const { gen, y0, y1, state } = event.data;
  const buf = createBuffer(state.w, y1 - y0);
  buf.y0 = y0;
  buf.source = state.family === "ifs" ? 1 : 0;
  fillRows(buf, state, y0, y1);
  shadeLevels(buf);
  self.postMessage(
    { gen, y0, y1, iter: buf.iter, extra: buf.extra, alpha: buf.alpha, level: buf.level },
    [buf.iter.buffer, buf.extra.buffer, buf.alpha.buffer, buf.level.buffer],
  );
};
