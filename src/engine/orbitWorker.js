import { bigFromDouble, referenceOrbit } from "./deep.js";

self.onmessage = (event) => {
  const { id, x, y, bits, maxIter, julia, jre, jim } = event.data;
  const t0 = performance.now();
  let main;
  let crit = null;
  if (julia) {
    const cx = bigFromDouble(jre, bits);
    const cy = bigFromDouble(jim, bits);
    main = referenceOrbit({ zx: x, zy: y, cx, cy, bits, maxIter });
    crit = referenceOrbit({ zx: 0n, zy: 0n, cx, cy, bits, maxIter });
  } else {
    main = referenceOrbit({ zx: 0n, zy: 0n, cx: x, cy: y, bits, maxIter });
  }
  const Z = main.Z.slice();
  const C = crit ? crit.Z.slice() : null;
  self.postMessage(
    { id, Z, N: main.N, escaped: main.escaped && (!crit || crit.escaped), C, CN: crit ? crit.N : 0, ms: performance.now() - t0 },
    C ? [Z.buffer, C.buffer] : [Z.buffer],
  );
};
