import { useState } from "react";
import { CONTAINERS, EASINGS, FRAME_RATES, QUALITIES, RESOLUTIONS, bitrateFor } from "../engine/movie.js";

function seconds(t) {
  return `${t.toFixed(1)} s`;
}

function clock(s) {
  if (!Number.isFinite(s)) return "…";
  const m = Math.floor(s / 60);
  return m ? `${m} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`;
}

function megabytes(n) {
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function MoviePanel({ movie, engine }) {
  const [open, setOpen] = useState(movie.keys.length > 0);
  const m = engine.movie;
  const { settings, job, result } = movie;
  const res = RESOLUTIONS.find((item) => item.id === settings.resolution) || RESOLUTIONS[1];
  const busy = movie.exporting;
  const frames = Math.max(1, Math.round(movie.total * settings.fps));
  const rate = bitrateFor(res.w, res.h, settings.fps, settings.quality);
  return (
    <details className="movie" open={open || busy} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Movie
        <span>
          {movie.keys.length} key{movie.keys.length === 1 ? "" : "s"}
          {movie.total ? ` · ${seconds(movie.total)}` : ""}
        </span>
      </summary>
      <div className="row movie-actions">
        <button type="button" disabled={busy} onClick={() => m.addKey()} title="Enter">
          <kbd>⏎</kbd>Add keyframe
        </button>
        <button type="button" className={movie.playing ? "on" : ""} disabled={busy || movie.keys.length < 2} onClick={() => m.togglePlay()} title="/">
          <kbd>/</kbd>
          {movie.playing ? "Stop" : "Play"}
        </button>
        <button type="button" className={movie.loop ? "on" : ""} disabled={busy} onClick={() => m.setLoop(!movie.loop)}>
          Loop
        </button>
      </div>
      {movie.message ? <p className="hint">{movie.message}</p> : null}
      {movie.keys.length > 1 ? (
        <div className="timeline">
          <input
            type="range"
            min={0}
            max={movie.total}
            step={0.01}
            value={movie.time}
            disabled={busy}
            aria-label="Movie time"
            onChange={(event) => {
              m.stop();
              m.seek(Number(event.target.value));
            }}
          />
          <div className="ticks" aria-hidden="true">
            {movie.keys.map((key) => (
              <i key={key.id} style={{ left: `${(key.at / movie.total) * 100}%` }} />
            ))}
          </div>
          <p className="status">
            {seconds(movie.time)} of {seconds(movie.total)}
          </p>
        </div>
      ) : (
        <p className="hint">Frame a view and press Enter to add a keyframe. Two or more keys play as one smooth flight.</p>
      )}
      <ol className="keylist">
        {movie.keys.map((key, i) => (
          <li key={key.id}>
            <button type="button" className="thumb" disabled={busy} onClick={() => m.goTo(i)} title="Go to this keyframe">
              {key.thumb ? <img src={key.thumb} alt="" /> : null}
              <span>{i + 1}</span>
            </button>
            <div className="keyinfo">
              <b>{key.name}</b>
              <span>
                at {seconds(key.at)}
                {key.depth ? ` · depth ${key.depth}` : ""}
              </span>
              {i < movie.keys.length - 1 ? (
                <div className="keyfields">
                  <label>
                    <input
                      type="number"
                      min={0.1}
                      max={600}
                      step={0.5}
                      value={key.duration}
                      disabled={busy}
                      onChange={(event) => m.setDuration(i, Number(event.target.value))}
                    />
                    s
                  </label>
                  <select value={key.easing} disabled={busy} onChange={(event) => m.setEasing(i, event.target.value)} aria-label="Easing">
                    {EASINGS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <span>end</span>
              )}
            </div>
            <div className="keytools">
              <button type="button" disabled={busy || i === 0} onClick={() => m.moveKey(i, -1)} title="Move up">
                ↑
              </button>
              <button type="button" disabled={busy || i === movie.keys.length - 1} onClick={() => m.moveKey(i, 1)} title="Move down">
                ↓
              </button>
              <button type="button" disabled={busy} onClick={() => m.replaceKey(i)} title="Replace with the current view">
                ⟳
              </button>
              <button type="button" disabled={busy} onClick={() => m.removeKey(i)} title="Delete">
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="exportgrid">
        <label className="field">
          Resolution
          <select value={settings.resolution} disabled={busy} onChange={(event) => m.setSetting("resolution", event.target.value)}>
            {RESOLUTIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Frame rate
          <select value={settings.fps} disabled={busy} onChange={(event) => m.setSetting("fps", Number(event.target.value))}>
            {FRAME_RATES.map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Quality
          <select value={settings.quality} disabled={busy} onChange={(event) => m.setSetting("quality", event.target.value)}>
            {QUALITIES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Supersample
          <select value={settings.supersample} disabled={busy} onChange={(event) => m.setSetting("supersample", event.target.value)}>
            <option value="auto">Auto (3D, IFS)</option>
            <option value="1">Off, edge AA only</option>
            <option value="2">2×2 everywhere</option>
          </select>
        </label>
        <label className="field wide">
          File
          <select value={settings.container} disabled={busy} onChange={(event) => m.setSetting("container", event.target.value)}>
            {CONTAINERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        {frames} frames · {(rate / 1e6).toFixed(1)} Mbit/s. Every frame is computed at full size with antialiased band edges, so export takes far longer than playback.
      </p>
      {busy ? (
        <div className="progress">
          <div className="bar">
            <i style={{ width: `${(100 * (job?.frame || 0)) / Math.max(1, job?.frames || 1)}%` }} />
          </div>
          <p className="status">
            {job?.stage} · frame {job?.frame || 0}/{job?.frames || 0}
            {job?.frame ? ` · ${clock(job.eta)} left` : ""}
            {job?.codec ? ` · ${job.codec}` : ""}
          </p>
          <button type="button" className="wide" onClick={() => m.cancelExport()}>
            <kbd>Esc</kbd>Cancel export
          </button>
        </div>
      ) : (
        <button type="button" className="export" disabled={!movie.keys.length} onClick={() => m.exportVideo()}>
          Export video
        </button>
      )}
      {job?.done && job.error ? <p className="hint warn">Export failed: {job.error}</p> : null}
      {job?.done && !job.error && job.stage === "Cancelled" ? <p className="hint">Export cancelled.</p> : null}
      {result && !busy ? (
        <p className="hint">
          <a href={result.url} download={result.name}>
            {result.name}
          </a>{" "}
          · {result.w}×{result.h} · {result.frames} frames · {megabytes(result.size)} · {result.codec}
        </p>
      ) : null}
    </details>
  );
}
