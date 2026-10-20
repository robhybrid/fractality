export const MODES = [
  { id: "zoom", key: "Z", label: "Zoom", blurb: "Hold to zoom in on the cursor" },
  { id: "zoomout", key: "X", label: "Out", blurb: "Hold to zoom out" },
  { id: "pan", key: "V", label: "Pan", blurb: "Drag to move the view" },
  { id: "julia", key: "C", label: "Julia", blurb: "Drag to set the Julia constant" },
  { id: "power", key: "P", label: "Power", blurb: "Drag sideways to change the exponent" },
  { id: "phase", key: "G", label: "Phase", blurb: "Drag to rotate the palette" },
  { id: "rotate", key: "T", label: "Turn", blurb: "Drag to rotate the plane" },
  { id: "bail", key: "B", label: "Bail", blurb: "Drag to change the escape radius" },
  { id: "iters", key: "I", label: "Iters", blurb: "Drag to set the iteration cap" },
  { id: "trap", key: "O", label: "Trap", blurb: "Drag to move the orbit trap" },
];

const home = (x, y, r) => ({ x, y, r, rot: 0 });

export const FRACTALS = [
  { id: "mandelbrot", name: "Mandelbrot", family: "escape", formula: 0, hotkey: "1", power: 2, bail: 64, home: home(-0.75, 0, 1.35) },
  { id: "julia", name: "Julia", family: "escape", formula: 1, hotkey: "2", power: 2, bail: 64, home: home(0, 0, 1.55), julia: [-0.8, 0.156] },
  { id: "burning", name: "Burning Ship", family: "escape", formula: 2, hotkey: "3", power: 2, bail: 64, home: home(-0.4, -0.55, 1.55) },
  { id: "tricorn", name: "Tricorn", family: "escape", formula: 3, hotkey: "4", power: 2, bail: 64, home: home(0, 0, 1.7) },
  { id: "celtic", name: "Celtic", family: "escape", formula: 4, hotkey: "5", power: 2, bail: 64, home: home(-0.5, 0, 1.55) },
  { id: "buffalo", name: "Buffalo", family: "escape", formula: 5, hotkey: "6", power: 2, bail: 64, home: home(-0.35, 0, 1.5) },
  { id: "perp", name: "Perpendicular Ship", family: "escape", formula: 6, hotkey: "7", power: 2, bail: 64, home: home(-0.4, -0.5, 1.55) },
  { id: "phoenix", name: "Phoenix", family: "escape", formula: 7, hotkey: "8", power: 2, bail: 64, home: home(0, 0, 1.6), julia: [0.566, 0], extra: -0.5 },
  { id: "newton", name: "Newton", family: "escape", formula: 8, hotkey: "9", power: 3, bail: 64, home: home(0, 0, 1.45) },
  { id: "nova", name: "Nova", family: "escape", formula: 9, hotkey: "0", power: 3, bail: 16, home: home(0, 0, 1.15), extra: 1 },
  { id: "magnet", name: "Magnet", family: "escape", formula: 10, power: 2, bail: 64, home: home(1, 0, 2.4) },
  { id: "lyapunov", name: "Lyapunov", family: "escape", formula: 11, power: 2, bail: 4, home: home(2, 2, 2.05) },
  { id: "sierpinski", name: "Sierpinski Triangle", family: "shape", formula: 12, power: 2, bail: 64, home: home(0.5, 0.433, 0.62) },
  { id: "carpet", name: "Sierpinski Carpet", family: "shape", formula: 13, power: 2, bail: 64, home: home(0.5, 0.5, 0.62) },
  { id: "koch", name: "Koch Curve", family: "shape", formula: 14, power: 2, bail: 64, home: home(0, 0, 1.15) },
  { id: "snowflake", name: "Koch Snowflake", family: "shape", formula: 15, power: 2, bail: 64, home: home(0, 0.05, 1.35) },
  { id: "kaleido", name: "Kaleidoscope", family: "shape", formula: 16, power: 2, bail: 64, home: home(0, 0, 1.4), extra: 0 },
  { id: "fern", name: "Barnsley Fern", family: "ifs", formula: 0, power: 2, bail: 64, home: home(0, 4.7, 5.5) },
  { id: "dragon", name: "Dragon Curve", family: "ifs", formula: 1, power: 2, bail: 64, home: home(0.55, 0.32, 0.72) },
  { id: "maple", name: "Maple Leaf", family: "ifs", formula: 2, power: 2, bail: 64, home: home(0.05, 0.1, 2.55) },
  { id: "bulb", name: "Mandelbulb", family: "ray", formula: 0, power: 8, bail: 64, home: { yaw: 0.55, pitch: 0.35, dist: 2.55 } },
  { id: "box", name: "Mandelbox", family: "ray", formula: 1, power: -1.5, bail: 64, home: { yaw: 0.45, pitch: 0.4, dist: 5.2 } },
  { id: "menger", name: "Menger Sponge", family: "ray", formula: 2, power: 3, bail: 64, home: { yaw: 0.6, pitch: 0.42, dist: 3.3 } },
  { id: "tetra", name: "Sierpinski Tetrahedron", family: "ray", formula: 3, power: 2, bail: 64, home: { yaw: 0.7, pitch: 0.38, dist: 2.7 } },
];

export const PRESETS = {
  mandelbrot: [
    { name: "The set", x: -0.75, y: 0, r: 1.35 },
    { name: "Seahorse valley", x: -0.745, y: 0.112, r: 0.018 },
    { name: "Elephant valley", x: 0.281, y: 0.008, r: 0.016 },
    { name: "Spiral", x: -0.761574, y: -0.08476, r: 0.004 },
    { name: "Mini set", x: -1.76877883, y: -0.00173891, r: 0.00045 },
  ],
  burning: [
    { name: "The ship", x: -0.4, y: -0.55, r: 1.55 },
    { name: "Antenna", x: -1.762, y: -0.028, r: 0.02 },
  ],
  julia: [
    { name: "Douady rabbit", x: 0, y: 0, r: 1.55, julia: [-0.123, 0.745] },
    { name: "Siegel", x: 0, y: 0, r: 1.4, julia: [-0.391, -0.587] },
    { name: "Classic", x: 0, y: 0, r: 1.55, julia: [-0.8, 0.156] },
  ],
};

const g = (stops) => stops.map(([t, color]) => ({ t, color }));

export const PALETTES = [
  {
    id: "classic",
    name: "Classic",
    stops: g([
      [0, "#070b2a"],
      [0.16, "#142a82"],
      [0.34, "#1f8a8a"],
      [0.5, "#d6f25a"],
      [0.66, "#ffe27a"],
      [0.82, "#fff7e8"],
      [1, "#070b2a"],
    ]),
  },
  {
    id: "ember",
    name: "Ember",
    stops: g([
      [0, "#140206"],
      [0.22, "#8a1020"],
      [0.42, "#e2471a"],
      [0.62, "#ffb03a"],
      [0.8, "#fff1c9"],
      [1, "#140206"],
    ]),
  },
  {
    id: "glacier",
    name: "Glacier",
    stops: g([
      [0, "#061018"],
      [0.25, "#163a66"],
      [0.48, "#79d4ff"],
      [0.7, "#f4fbff"],
      [0.86, "#9ecbff"],
      [1, "#061018"],
    ]),
  },
  {
    id: "neon",
    name: "Neon",
    stops: g([
      [0, "#0a0614"],
      [0.22, "#ff2bd6"],
      [0.45, "#2de2e6"],
      [0.68, "#f9f871"],
      [0.84, "#ffffff"],
      [1, "#0a0614"],
    ]),
  },
  {
    id: "aurora",
    name: "Aurora",
    stops: g([
      [0, "#07110e"],
      [0.2, "#0d6b4a"],
      [0.4, "#7dffa1"],
      [0.58, "#6d5efc"],
      [0.78, "#d7c6ff"],
      [1, "#07110e"],
    ]),
  },
  {
    id: "magma",
    name: "Magma",
    stops: g([
      [0, "#0c0614"],
      [0.28, "#5b1d78"],
      [0.5, "#d23a6a"],
      [0.72, "#ff8a3d"],
      [1, "#0c0614"],
    ]),
  },
  {
    id: "ink",
    name: "Ink",
    stops: g([
      [0, "#0c0c0c"],
      [0.35, "#f4efe6"],
      [0.55, "#0c0c0c"],
      [0.8, "#d9d2c5"],
      [1, "#0c0c0c"],
    ]),
  },
  {
    id: "candy",
    name: "Candy",
    stops: g([
      [0, "#2a1024"],
      [0.25, "#ff7ab6"],
      [0.5, "#9ef0d0"],
      [0.75, "#c9b6ff"],
      [1, "#2a1024"],
    ]),
  },
  {
    id: "copper",
    name: "Copper",
    stops: g([
      [0, "#140c08"],
      [0.3, "#6b3a22"],
      [0.52, "#e08a4f"],
      [0.74, "#f6d59a"],
      [1, "#140c08"],
    ]),
  },
  {
    id: "custom",
    name: "Custom",
    stops: g([
      [0, "#101424"],
      [0.33, "#3ec6c6"],
      [0.66, "#f2d16b"],
      [1, "#101424"],
    ]),
  },
];

export function cloneStops(stops) {
  return stops.map((s) => ({ t: s.t, color: s.color }));
}
