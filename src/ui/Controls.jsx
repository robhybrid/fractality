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

export function Controls({ snap, engine }) {
  if (!engine) return null;
  const stop = snap.stops[snap.selectedStop] || snap.stops[0];
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
      </header>
      <p className="coords">
        {snap.family === "ray"
          ? `yaw ${snap.yaw.toFixed(2)} · pitch ${snap.pitch.toFixed(2)} · gap ${snap.gap.toExponential(2)}`
          : snap.frameDepth
            ? `depth ${snap.frameDepth} · zoom ${zoomText(snap.zoomLog10)}`
            : `${snap.cx.toFixed(5)}  ${snap.cy >= 0 ? "+" : "−"} ${Math.abs(snap.cy).toFixed(5)}i · r ${snap.radius.toExponential(2)}`}
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
        {snap.viewW}×{snap.viewH} · {snap.backend === "SVG" ? "vector" : `${snap.iters} ${snap.family === "ray" ? "steps" : "iters"}`}
        {" · "}
        {snap.backend || "CPU"}
        {snap.antialiased ? " · antialiased" : ""}
        {snap.throttled ? " · easing off, frames were slow" : ""}
        {snap.paused ? " · paused" : ""}
      </p>

      {snap.movie ? <MoviePanel movie={snap.movie} engine={engine} /> : null}
      {snap.movie?.exporting ? null : (
        <>
          <label className="field">
            Fractal
            <select value={snap.index} onChange={(event) => engine.setFractal(Number(event.target.value))}>
              {snap.fractals.map((item) => (
                <option key={item.name} value={item.index}>
                  {item.hotkey ? `${item.hotkey}  ` : ""}
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <div className="modes">
            {snap.modes.map((mode) => (
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
            {snap.family === "ray"
              ? snap.name.includes("Julia") || snap.name.includes("Hybrid") || snap.name.includes("Quaternion")
                ? "Hold to fly toward the surface. C or Julia mode sets the constant; Extra blends or sets the third component. Shift-drag orbits."
                : "Hold to fly toward the surface under the cursor. Right-click backs away. Shift-drag or arrows orbit. R returns home."
              : snap.backend === "SVG"
                ? "Vector geometry — crisp at every zoom. Hold to zoom; structure subdivides instead of blurring."
                : `${snap.modeBlurb}. Right-click zooms out. Wheel changes palette speed.`}
          </p>

          <Slider label="Power" min={-2} max={10} step={0.01} value={snap.power} onChange={(v) => engine.setPower(v)} />
          <Slider
            label="Iterations"
            min={24}
            max={400}
            step={1}
            value={snap.autoIter ? snap.iters : snap.iterBias}
            disabled={snap.autoIter}
            format={(v) => String(Math.round(v))}
            onChange={(v) => engine.setIterBias(v)}
          />
          <label className="check">
            <input type="checkbox" checked={snap.autoIter} onChange={(event) => engine.setAutoIter(event.target.checked)} />
            Auto iterations, rising with zoom
          </label>
          <Slider label="Palette speed" min={-2} max={2} step={0.01} value={snap.paletteSpeed} onChange={(v) => engine.setPaletteSpeed(v)} />
          <Slider label="Color density" min={0.004} max={0.2} step={0.001} value={snap.density} onChange={(v) => engine.setDensity(v)} />
          <Slider label="Rotation" min={-3.14} max={3.14} step={0.01} value={snap.rotation} onChange={(v) => engine.setRotation(v)} />
          <Slider label="Bailout" min={4} max={512} step={1} value={snap.bailout} format={(v) => String(Math.round(v))} onChange={(v) => engine.setBailout(v)} />
          <Slider label="Julia real" min={-2} max={2} step={0.001} value={snap.juliaRe} onChange={(v) => engine.setJulia(v, snap.juliaIm)} />
          <Slider label="Julia imag" min={-2} max={2} step={0.001} value={snap.juliaIm} onChange={(v) => engine.setJulia(snap.juliaRe, v)} />
          <Slider label="Extra" min={-2} max={2} step={0.01} value={snap.extra} onChange={(v) => engine.setExtra(v)} />
          <Slider label="Detail" min={0.45} max={1} step={0.01} value={snap.detail} onChange={(v) => engine.setDetail(v)} />

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

          <details open={snap.help} onToggle={(event) => engine.setHelp(event.currentTarget.open)}>
            <summary>Keys, including while this panel is hidden</summary>
            <ul className="keys">
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
