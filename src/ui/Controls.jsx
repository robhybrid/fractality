import { useEffect, useRef, useState } from "react";
import { MoviePanel } from "./MoviePanel.jsx";

function Slider({ label, min, max, step, value, onChange, disabled, format }) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  return (
    <label className={disabled ? "slider disabled" : "slider"}>
      <span>
        {label}
        <b>{format ? format(local) : Number(local).toFixed(2)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onChange={(event) => {
          const next = Number(event.target.value);
          setLocal(next);
          onChange(next);
        }}
      />
    </label>
  );
}

function zoomText(log10) {
  if (log10 < 6) return `${Math.round(10 ** log10).toLocaleString()}×`;
  const e = Math.floor(log10);
  return `${(10 ** (log10 - e)).toFixed(1)}e${e}×`;
}

function clip(text, keep = 18) {
  return text.length > keep ? `${text.slice(0, keep)}…` : text;
}

function coordsText(snap) {
  if (snap.family === "ray") return `yaw ${snap.yaw.toFixed(2)} · pitch ${snap.pitch.toFixed(2)} · dist ${snap.dist.toFixed(2)}`;
  if (snap.frameDepth) return `depth ${snap.frameDepth} · zoom ${zoomText(snap.zoomLog10)}`;
  if (snap.center) {
    const [re, im] = snap.center;
    const neg = im.startsWith("-");
    return `${clip(re)} ${neg ? "−" : "+"} ${clip(neg ? im.slice(1) : im)}i · zoom ${zoomText(snap.zoomLog10)}`;
  }
  const zoom = snap.zoomLog10 > 3 ? ` · zoom ${zoomText(snap.zoomLog10)}` : "";
  return `${snap.cx.toFixed(5)}  ${snap.cy >= 0 ? "+" : "−"} ${Math.abs(snap.cy).toFixed(5)}i · r ${snap.radius.toExponential(2)}${zoom}`;
}

const PAD_SPAN = 2;

/**
 * The Julia constant as a point on the complex plane: click or drag to place
 * it, Shift-drag to nudge it ten times finer.
 */
function JuliaPad({ snap, engine }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const re = snap.juliaRe;
  const im = snap.juliaIm;
  const toPad = (v) => ((v + PAD_SPAN) / (2 * PAD_SPAN)) * 100;
  const place = (event) => {
    const rect = ref.current.getBoundingClientRect();
    const d = drag.current;
    if (event.shiftKey && d) {
      const k = (2 * PAD_SPAN) / rect.width / 10;
      engine.setJulia(d.re + (event.clientX - d.x) * k, d.im - (event.clientY - d.y) * k);
      return;
    }
    const x = ((event.clientX - rect.left) / rect.width) * 2 * PAD_SPAN - PAD_SPAN;
    const y = PAD_SPAN - ((event.clientY - rect.top) / rect.height) * 2 * PAD_SPAN;
    engine.setJulia(Math.max(-PAD_SPAN, Math.min(PAD_SPAN, x)), Math.max(-PAD_SPAN, Math.min(PAD_SPAN, y)));
  };
  return (
    <div className="julia">
      <span>
        Julia constant <kbd>C</kbd>
        <b>
          {re.toFixed(4)} {im < 0 ? "−" : "+"} {Math.abs(im).toFixed(4)}i
        </b>
      </span>
      <div
        ref={ref}
        className="julia-pad"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, re, im };
          if (!event.shiftKey) place(event);
        }}
        onPointerMove={(event) => {
          if (drag.current) place(event);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <i className="axis-x" />
        <i className="axis-y" />
        <i className="dot" style={{ left: `${toPad(re)}%`, top: `${100 - toPad(im)}%` }} />
      </div>
    </div>
  );
}

const coarse = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
/** Same breakpoint as the bottom-sheet panel CSS: phones, tablets, and narrow windows. */
const mobileChrome = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse), (max-width: 700px)").matches;

function TouchHelp() {
  return (
    <ul className="keys touch-keys">
      <li><b>drag</b> pan · orbit in 3D</li>
      <li><b>pinch</b> zoom · fly in 3D</li>
      <li><b>twist</b> rotate</li>
      <li><b>hold</b> dive toward finger</li>
      <li><b>double tap</b> zoom in</li>
      <li><b>two-finger tap</b> zoom out</li>
    </ul>
  );
}

export function Controls({ snap, engine }) {
  if (!engine) return null;
  const touch = coarse();
  const mobile = mobileChrome();
  const stop = snap.stops[snap.selectedStop] || snap.stops[0];
  const helpRef = useRef(null);
  const algoRef = useRef(null);

  useEffect(() => {
    if (!snap.help) return undefined;
    const dismiss = (event) => {
      // Evaluate at tap time so a resize to the mobile sheet still dismisses help.
      if (!mobileChrome()) return;
      if (helpRef.current && !helpRef.current.contains(event.target)) engine.setHelp(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [snap.help, engine]);

  useEffect(() => {
    if (snap.custom) algoRef.current?.focus();
  }, [snap.custom]);

  return (
    <aside className="panel">
      <header className="title">
        <div>
          <p className="mark">Fractality</p>
          <h1>{snap.name}</h1>
        </div>
        <div className={snap.throttled ? "fps hot" : "fps"}>
          <strong>{snap.fps}</strong>
          <span>fps</span>
        </div>
        <button type="button" className="close" aria-label="Close panel" onClick={() => engine.setHidden(true)}>
          ×
        </button>
      </header>
      <p className="coords" title={snap.center ? `${snap.center[0]}\n${snap.center[1]}\nr ${snap.radius.toExponential(3)}` : undefined}>
        {coordsText(snap)}
      </p>
      <div
        className="livebar"
        style={{
          backgroundImage: snap.gradient,
          backgroundSize: "220% 100%",
          backgroundPositionX: `${(((snap.phase || 0) % 1) + 1) % 1 * 100}%`,
        }}
      />
      <p className="status">
        {snap.viewW}×{snap.viewH} · {snap.backend === "SVG" ? "vector" : snap.contIters > snap.iters ? `${Math.max(snap.iters, snap.contEscHi || 0).toLocaleString()} iters${snap.contDone ? "" : " and rising"}` : `${snap.iters} ${snap.family === "ray" ? "steps" : "iters"}`}
        {" · "}
        {snap.backend || "CPU"}
        {snap.antialiased ? " · antialiased" : ""}
        {snap.deep ? " · perturbation" : ""}
        {snap.throttled ? " · easing off, frames were slow" : ""}
        {snap.paused ? " · paused" : ""}
      </p>

      {snap.movie ? <MoviePanel movie={snap.movie} engine={engine} /> : null}
      {snap.movie?.exporting ? null : (
        <>
          {snap.custom ? (
            <label className="field">
              Algorithm
              <div className="algo-row">
                <input
                  ref={algoRef}
                  type="text"
                  className={snap.algorithmOk === false ? "algo bad" : "algo"}
                  value={snap.algorithm}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  aria-label="Custom fractal algorithm"
                  onChange={(event) => engine.setAlgorithm(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      engine.exitCustom();
                    }
                  }}
                />
                <button type="button" className="algo-back" aria-label="Back to fractal list" onClick={() => engine.exitCustom()}>
                  ✕
                </button>
              </div>
            </label>
          ) : (
            <label className="field">
              Fractal
              <select
                value={snap.index}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "custom") engine.enterCustom();
                  else engine.setFractal(Number(value));
                }}
              >
                {snap.fractals.map((item) => (
                  <option key={item.name} value={item.index}>
                    {item.hotkey ? `${item.hotkey}  ` : ""}
                    {item.name}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>
          )}

          <div className="actions">
            <button type="button" aria-label="Previous fractal" onClick={() => engine.setFractal(snap.index - 1)}>◀</button>
            <button type="button" aria-label="Next fractal" onClick={() => engine.setFractal(snap.index + 1)}>▶</button>
            <button type="button" onClick={() => engine.setPalette(snap.paletteIndex + 1)}>Palette</button>
            {snap.family === "escape" ? <button type="button" onClick={() => engine.flyNext()}>Next place</button> : null}
            <button type="button" className={snap.paused ? "on" : ""} onClick={() => engine.togglePause()}>{snap.paused ? "Play" : "Pause"}</button>
            <button type="button" onClick={() => engine.fullscreen()}>Full screen</button>
            <button type="button" onClick={() => engine.savePng()}>Save image</button>
          </div>

          <div className="modes">
            {snap.modes.filter((mode) => mode.id !== "julia" || snap.usesJulia || snap.canPickJulia).map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={mode.id === snap.mode ? "on" : ""}
                onClick={() => engine.setMode(mode.id)}
                title={`${mode.key} — ${mode.blurb}`}
              >
                <kbd>{mode.key}</kbd>
                {mode.label}
              </button>
            ))}
          </div>
          <p className="hint">
            {mobile || touch
              ? snap.family === "ray"
                ? "Drag to orbit, pinch or hold to fly toward the surface, double tap to hop closer."
                : "Drag to pan, pinch to zoom and twist to rotate, hold to dive, double tap to zoom in."
              : snap.family === "ray"
              ? snap.name.includes("Julia") || snap.name.includes("Hybrid") || snap.name.includes("Quaternion")
                ? "Hold to fly toward the surface. C or Julia mode sets the constant; Extra blends or sets the third component. Shift-drag orbits."
                : "Hold to fly toward the surface under the cursor. Right-click backs away. Shift-drag or arrows orbit. R returns home."
              : snap.backend === "SVG"
                ? "Vector geometry — crisp at every zoom. Hold to zoom; structure subdivides instead of blurring."
                : `${snap.modeBlurb}. Right-click zooms out. Wheel changes palette speed.`}
          </p>

          <Slider label="Power" min={snap.powerMin ?? 1} max={10} step={0.01} value={snap.power} onChange={(v) => engine.setPower(v)} />
          {snap.autoIter ? (
            <Slider
              label="Iterations"
              min={-2}
              max={3}
              step={0.05}
              value={Math.log2(snap.iterMul || 1)}
              format={(v) => `×${(2 ** v).toFixed(2)} · ${snap.iters}`}
              onChange={(v) => engine.setIterMul(2 ** v)}
            />
          ) : (
            <Slider
              label="Iterations"
              min={Math.log2(24)}
              max={Math.log2(snap.maxIter || 400)}
              step={0.01}
              value={Math.log2(Math.max(24, snap.iterBias))}
              format={(v) => String(Math.round(2 ** v))}
              onChange={(v) => engine.setIterBias(Math.round(2 ** v))}
            />
          )}
          <label className="check">
            <input type="checkbox" checked={snap.autoIter} onChange={(event) => engine.setAutoIter(event.target.checked)} />
            Auto iterations, rising with zoom (slider scales them)
          </label>
          <Slider label="Palette speed" min={-2} max={2} step={0.01} value={snap.paletteSpeed} onChange={(v) => engine.setPaletteSpeed(v)} />
          <Slider label="Color density" min={0.004} max={0.2} step={0.001} value={snap.density} onChange={(v) => engine.setDensity(v)} />
          <Slider label="Rotation" min={-3.14} max={3.14} step={0.01} value={snap.rotation} onChange={(v) => engine.setRotation(v)} />
          <Slider label="Bailout" min={4} max={512} step={1} value={snap.bailout} format={(v) => String(Math.round(v))} onChange={(v) => engine.setBailout(v)} />
          {snap.usesJulia ? <JuliaPad snap={snap} engine={engine} /> : null}
          {snap.extraLabel ? (
            <Slider label={snap.extraLabel} min={snap.extraRange[0]} max={snap.extraRange[1]} step={0.01} value={snap.extra} onChange={(v) => engine.setExtra(v)} />
          ) : null}
          <Slider label="Detail" min={0.45} max={1} step={0.01} value={snap.detail} onChange={(v) => engine.setDetail(v)} />

          {snap.family === "ray" ? (
            <label className="field">
              3D shading <kbd>`</kbd>
              <select value={snap.shade3d} onChange={(event) => engine.setShade3d(event.target.value)}>
                {(snap.shadeModes || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              Gradient mode <kbd>`</kbd>
              <select value={snap.colorMode} onChange={(event) => engine.setColorMode(Number(event.target.value))}>
                {(snap.colorModes || []).map((item, index) => (
                  <option key={item.id} value={index}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={!!snap.deRelief} onChange={(event) => engine.setDeRelief(event.target.checked)} />
            Distance relief: 3D light and boundary filaments on any mode
          </label>
          <div className="chips">
            {snap.palettes.map((item) => (
              <button key={item.name} type="button" className={item.index === snap.paletteIndex ? "on" : ""} onClick={() => engine.setPalette(item.index)}>
                {item.name}
              </button>
            ))}
          </div>
          <div
            className="gradient"
            style={{ background: snap.gradient }}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const t = (event.clientX - rect.left) / rect.width;
              if (event.target === event.currentTarget) engine.addStop(t);
            }}
          >
            {snap.stops.map((stopItem, index) => (
              <button
                key={`${stopItem.color}-${index}`}
                type="button"
                className={index === snap.selectedStop ? "stop on" : "stop"}
                style={{ left: `${stopItem.t * 100}%`, background: stopItem.color }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  engine.selectStop(index);
                  const bar = event.currentTarget.parentElement.getBoundingClientRect();
                  const move = (ev) => engine.moveStop(index, (ev.clientX - bar.left) / bar.width);
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
              />
            ))}
          </div>
          <div className="row">
            <input type="color" value={stop?.color || "#ffffff"} onChange={(event) => engine.setStopColor(snap.selectedStop, event.target.value)} />
            <button type="button" onClick={() => engine.removeStop(snap.selectedStop)}>
              Remove stop
            </button>
            <button type="button" onClick={() => engine.randomize()}>
              Random
            </button>
          </div>

          <div className="toggles">
            <button type="button" className={snap.animatePalette ? "on" : ""} onClick={() => engine.setAnimatePalette(!snap.animatePalette)}>
              L palette drift
            </button>
            <button type="button" className={snap.breathe ? "on" : ""} onClick={() => engine.setBreathe(!snap.breathe)}>
              Y power breathe
            </button>
            <button type="button" className={snap.colorInterior ? "on" : ""} onClick={() => engine.setColorInterior(!snap.colorInterior)}>
              D color the lake
            </button>
            <button type="button" onClick={() => engine.cycleBeat()}>
              K beat {["off", "color", "color + zoom"][snap.beatMode]}
            </button>
            <button type="button" onClick={() => engine.toggleMic()}>
              M {snap.audioOn ? "stop audio" : "mic"}
            </button>
            <button type="button" onClick={() => engine.resetView()}>
              R reset
            </button>
          </div>
          <div className="meter" title={snap.audioLabel}>
            <i style={{ height: `${Math.round(snap.bass * 100)}%` }} />
            <i style={{ height: `${Math.round(snap.mid * 100)}%` }} />
            <i style={{ height: `${Math.round(snap.high * 100)}%` }} />
            <span>{snap.audioLabel}{snap.bpm ? ` · ${Math.round(snap.bpm)} bpm` : ""}</span>
          </div>
          <p className="hint">Drop a song anywhere. Beat color is free. Beat zoom recomputes the set, so it stays on the cool preview.</p>

          <details ref={helpRef} open={snap.help} onToggle={(event) => engine.setHelp(event.currentTarget.open)}>
            <summary>{mobile || touch ? "Touch gestures" : "Keys, including while this panel is hidden"}</summary>
            {mobile || touch ? <TouchHelp /> : null}
            <ul className="keys desk-keys">
              <li><kbd>H</kbd> hide panel</li>
              <li><kbd>1</kbd>-<kbd>0</kbd> fractals</li>
              <li><kbd>[</kbd><kbd>]</kbd> cycle fractal</li>
              <li><kbd>,</kbd><kbd>.</kbd> palettes</li>
              <li><kbd>wheel</kbd> palette speed</li>
              <li><kbd>Z</kbd> hold zoom</li>
              <li><kbd>arrows</kbd> pan</li>
              <li><kbd>-</kbd><kbd>=</kbd> zoom</li>
              <li><kbd>J</kbd> Julia of this point</li>
              <li><kbd>N</kbd> next place</li>
              <li><kbd>Space</kbd> pause</li>
              <li><kbd>F</kbd> fullscreen</li>
              <li><kbd>S</kbd> save png</li>
              <li><kbd>\</kbd> random gradient</li>
              <li><kbd>`</kbd> cycle gradient mode</li>
              <li><kbd>shift</kbd> arrows edit stops</li>
              <li><kbd>Enter</kbd> add keyframe</li>
              <li><kbd>/</kbd> play movie</li>
            </ul>
          </details>
          <p className="foot">Crosshair zooms on press. The picture is drawn on the CPU, and a GPU pass joins in only when that browser can compile it. Palette drift keeps moving even while the set is still.</p>
        </>
      )}
    </aside>
  );
}
