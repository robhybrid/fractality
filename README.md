# fractality

Fullscreen fractal instrument. The picture is rendered on the CPU so it still appears when a GPU shader will not compile. A WebGL1 pass is used only as an enhancement.

```bash
npm install
npm run dev
```

Open http://localhost:5173. Press `H` to hide the panel. The same keys work while it is hidden.

The animated palette is cycled by a small WebGL1 pass when it compiles and matches the CPU on a test frame; otherwise the CPU paints every frame. URL switches: `?present=2d` forces CPU painting, `?present=blit` copies the GL result into the 2D canvas instead of layering it on top, `?gpu=tiles` lets an experimental tiled WebGL1 escape kernel (f32, with perturbation for deep Mandelbrot views) compute frames. `/bench.html` on the dev server times the CPU workers, WebGL1 and WebGPU kernels on your machine.
