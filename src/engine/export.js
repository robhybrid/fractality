import { RESOLUTIONS, bitrateFor, samplePose } from "./movie.js";
import { isVectorShape, rasterizeVector } from "./vector.js";

/** Largest supersampled frame; 2x of 1080p is ~8.3 Mpx, about 170 MB of buffers. */
const MAX_SUPERSAMPLED = 3840 * 2160;

function supersampleFor(setting, family, w, h) {
  const fits = w * h * 4 <= MAX_SUPERSAMPLED;
  if (setting === "2") return fits ? 2 : 1;
  if (setting === "auto") return fits && (family === "ray" || family === "ifs") ? 2 : 1;
  return 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Picks container and codec: H.264 for MP4/MOV, else VP9/AV1/VP8 in WebM. */
async function pickEncoder(mb, container, w, h, fps, bitrate) {
  const opts = { width: w, height: h, bitrate, frameRate: fps };
  if (container !== "webm") {
    const codec = await mb.getFirstEncodableVideoCodec(["avc"], opts);
    if (codec) {
      const format = container === "mov" ? new mb.MovOutputFormat({ fastStart: "in-memory" }) : new mb.Mp4OutputFormat({ fastStart: "in-memory" });
      return { codec, format, ext: container === "mov" ? "mov" : "mp4" };
    }
  }
  const codec = await mb.getFirstEncodableVideoCodec(["vp9", "av1", "vp8"], opts);
  if (!codec) return null;
  return { codec, format: new mb.WebMOutputFormat(), ext: "webm" };
}

function webCodecsSink(mb, pick, canvas, bitrate, fps) {
  const output = new mb.Output({ format: pick.format, target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec: pick.codec, bitrate, keyFrameInterval: 2, latencyMode: "quality" });
  output.addVideoTrack(source, { frameRate: fps });
  return {
    label: `${pick.codec.toUpperCase()} · ${pick.ext.toUpperCase()}`,
    ext: pick.ext,
    start: () => output.start(),
    add: (n) => source.add(n / fps, 1 / fps),
    finish: async () => {
      await output.finalize();
      return new Blob([output.target.buffer], { type: pick.format.mimeType });
    },
    abort: () => output.cancel().catch(() => {}),
  };
}

/**
 * Without WebCodecs: record the canvas stream, paused while a frame renders
 * and resumed for exactly one frame period around each requestFrame(), so the
 * recorded timeline matches the movie's even though frames take seconds.
 */
function recorderSink(canvas, bitrate, fps) {
  const types = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = types.find((type) => window.MediaRecorder?.isTypeSupported?.(type));
  if (!mimeType) return null;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  return {
    label: `MediaRecorder · ${ext.toUpperCase()}`,
    ext,
    start: async () => {
      recorder.start();
      recorder.pause();
    },
    add: async () => {
      recorder.resume();
      track.requestFrame();
      await sleep(1000 / fps);
      recorder.pause();
    },
    finish: () =>
      new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
        recorder.resume();
        recorder.stop();
        track.stop();
      }),
    abort: () => {
      try {
        recorder.stop();
        track.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}

function download(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Renders every frame of the movie offline at full quality and encodes it. */
export async function runExport(movie) {
  const engine = movie.engine;
  const renderer = engine.renderer;
  const { resolution, fps, quality, container, supersample } = movie.settings;
  const res = RESOLUTIONS.find((item) => item.id === resolution) || RESOLUTIONS[1];
  const { w, h } = res;
  const keys = movie.keys.slice();
  const tracks = movie.tracks;
  const frames = Math.max(1, Math.round(tracks.total * fps));
  const bitrate = bitrateFor(w, h, fps, quality);
  const job = { frame: 0, frames, eta: 0, stage: "Preparing encoder", codec: "", cancel: false, done: false, error: "" };
  movie.job = job;
  if (movie.result) URL.revokeObjectURL(movie.result.url);
  movie.result = null;
  const home = { ...movie.capture(), thumb: "" };
  const homeTime = movie.time;
  engine.publish(true);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  const big = document.createElement("canvas");
  const bctx = big.getContext("2d", { alpha: false });
  let sink = null;
  try {
    if (typeof VideoEncoder !== "undefined") {
      const mb = await import("mediabunny");
      const pick = await pickEncoder(mb, container, w, h, fps, bitrate);
      if (pick) sink = webCodecsSink(mb, pick, canvas, bitrate, fps);
    }
    if (!sink) sink = recorderSink(canvas, bitrate, fps);
    if (!sink) throw new Error("This browser has no video encoder (WebCodecs or MediaRecorder).");
    job.codec = sink.label;
    await sink.start();
    const t0 = performance.now();
    for (let n = 0; n < frames; n += 1) {
      if (job.cancel) throw new Error("cancelled");
      job.frame = n;
      job.stage = "Rendering";
      const pose = samplePose(keys, Math.min(tracks.total, n / fps), tracks);
      movie.apply(pose, w / h);
      const ss = supersampleFor(supersample, engine.fractal.family, w, h);
      const W = w * ss;
      const H = h * ss;
      const state = engine.renderState(false, { w: W, h: H });
      const image = isVectorShape(engine.fractal)
        ? await rasterizeVector({ ...state, cssW: W, cssH: H }, engine.stops, document.createElement("canvas"))
        : await renderer.renderStill(state, W, H);
      if (ss === 1) ctx.putImageData(image, 0, 0);
      else {
        if (big.width !== W || big.height !== H) {
          big.width = W;
          big.height = H;
        }
        bctx.putImageData(image, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(big, 0, 0, w, h);
      }
      if (job.cancel) throw new Error("cancelled");
      job.stage = "Encoding";
      await sink.add(n);
      const spent = (performance.now() - t0) / 1000;
      job.frame = n + 1;
      job.eta = (spent / (n + 1)) * (frames - n - 1);
      engine.publish(true);
    }
    job.stage = "Finishing file";
    engine.publish(true);
    const blob = await sink.finish();
    const name = `fractality-${keys[0].fractalId || "movie"}.${sink.ext}`;
    const url = URL.createObjectURL(blob);
    movie.result = { url, name, size: blob.size, codec: sink.label, w, h, frames, seconds: frames / fps, blob };
    job.stage = "Done";
    download(url, name);
  } catch (error) {
    sink?.abort();
    const cancelled = job.cancel || error?.message === "cancelled";
    job.error = cancelled ? "" : error?.message || String(error);
    job.stage = cancelled ? "Cancelled" : "Failed";
  } finally {
    job.done = true;
    big.width = big.height = 0;
    movie.apply(samplePose([home], 0));
    movie.time = homeTime;
    movie.settle();
    engine.dirty = true;
    renderer.lastJobSig = "";
    engine.publish(true);
  }
}
