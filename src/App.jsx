import { useEffect, useRef, useState } from "react";
import { createEngine } from "./engine/engine.js";
import { Controls } from "./ui/Controls.jsx";

export default function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [snap, setSnap] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    let engine;
    try {
      engine = createEngine(canvas, { onChange: setSnap });
    } catch (error) {
      setSnap({ error: error.message || String(error), hidden: true });
      return undefined;
    }
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  return (
    <div className="app">
      <canvas ref={canvasRef} tabIndex={0} aria-label="Fractal view" />
      <div className="vignette" aria-hidden="true" />
      {snap?.error ? <div className="error">{snap.error}</div> : null}
      {snap?.name && !snap.hidden ? <Controls snap={snap} engine={engineRef.current} /> : null}
    </div>
  );
}
