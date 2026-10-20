import { refineRows } from "./antialias.js";
import { demSupported, refineDistanceRows } from "./distance.js";
import { createBuffer, fillRows, shadeLevels } from "./kernel.js";

self.onmessage = (event) => {
  const { gen, y0, y1, state, base } = event.data;
  if (base?.dist && state.dem && demSupported(state)) {
    const r = refineDistanceRows(state, base, y0, y1);
    self.postMessage(
      { gen, y0, y1, aa: true, iter: r.iter, extra: r.extra, alpha: r.alpha, band: r.band, cover: r.cover, dist: r.dist, lit: r.lit, fil: r.fil },
      [r.iter.buffer, r.extra.buffer, r.alpha.buffer, r.band.buffer, r.cover.buffer, r.dist.buffer, r.lit.buffer, r.fil.buffer],
    );
    return;
  }
  if (base) {
    const r = refineRows(state, base, y0, y1);
    self.postMessage(
      { gen, y0, y1, aa: true, iter: r.iter, extra: r.extra, alpha: r.alpha, band: r.band, cover: r.cover },
      [r.iter.buffer, r.extra.buffer, r.alpha.buffer, r.band.buffer, r.cover.buffer],
    );
    return;
  }
  const buf = createBuffer(state.w, y1 - y0);
  buf.y0 = y0;
  buf.source = state.family === "ifs" ? 1 : 0;
  fillRows(buf, state, y0, y1);
  shadeLevels(buf);
  const msg = { gen, y0, y1, iter: buf.iter, extra: buf.extra, alpha: buf.alpha, level: buf.level };
  const transfer = [buf.iter.buffer, buf.extra.buffer, buf.alpha.buffer, buf.level.buffer];
  if (buf.dist) {
    msg.dist = buf.dist;
    msg.lit = buf.lit;
    transfer.push(buf.dist.buffer, buf.lit.buffer);
  }
  self.postMessage(msg, transfer);
};
