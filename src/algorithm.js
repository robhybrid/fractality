/**
 * Fractal algorithm strings shown in the Custom expression field.
 * Known presets match exactly (after normalize); a few patterns also compile.
 */

export function normalizeAlgo(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/×/g, "*")
    .replace(/·/g, "*");
}

function fromFractal(fractal) {
  return {
    id: fractal.id,
    name: fractal.name,
    family: fractal.family,
    formula: fractal.formula,
    power: fractal.power,
    bail: fractal.bail,
    home: fractal.home,
    julia: fractal.julia,
    extra: fractal.extra,
    extraLabel: fractal.extraLabel,
    extraRange: fractal.extraRange,
    frame: fractal.frame,
    algorithm: fractal.algorithm,
  };
}

/**
 * Parse an algorithm expression into fractal fields.
 * `current` is the live custom fractal (used to disambiguate shared strings
 * like z^2+c for Mandelbrot vs Julia).
 */
export function parseAlgorithm(raw, fractals, current = null) {
  const s = normalizeAlgo(raw);
  if (!s) return null;

  const matches = fractals.filter((f) => normalizeAlgo(f.algorithm) === s);
  if (matches.length === 1) return fromFractal(matches[0]);
  if (matches.length > 1) {
    const keep =
      matches.find((f) => current && f.id === current.id) ||
      matches.find((f) => current && f.family === current.family && f.formula === current.formula) ||
      matches[0];
    return fromFractal(keep);
  }

  // z^c — The Phoenix map (also accepted with optional +0)
  if (s === "z^c" || s === "z^c+0") {
    return {
      id: "thephoenix",
      name: "The Phoenix",
      family: "escape",
      formula: 17,
      power: 2,
      bail: 64,
      home: { x: 0, y: 0, r: 1.8, rot: 0 },
      algorithm: "z^c",
    };
  }

  // Multibrot / Mandelbrot-like: z^N+c for a numeric power
  const powerMatch = /^z\^(\d+(?:\.\d+)?)\+c$/.exec(s);
  if (powerMatch) {
    const power = Number(powerMatch[1]);
    if (Number.isFinite(power) && power > 0) {
      return {
        id: "custom",
        name: "Custom",
        family: "escape",
        formula: 0,
        power,
        bail: 64,
        home: { x: -0.75, y: 0, r: 1.35, rot: 0 },
        algorithm: raw.trim(),
      };
    }
  }

  // z^p+c / z^n+c — keep the current power slider
  if (s === "z^p+c" || s === "z^n+c") {
    return {
      id: "custom",
      name: "Custom",
      family: "escape",
      formula: 0,
      bail: 64,
      home: { x: -0.75, y: 0, r: 1.35, rot: 0 },
      algorithm: raw.trim(),
      keepPower: true,
    };
  }

  return null;
}
