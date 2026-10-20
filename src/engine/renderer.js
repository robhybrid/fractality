// Unused by the running app. Startup draws with the CPU presenter.
// This WebGL2 path stays here only as a reference; its vertex shader
// failed to compile on the target Mac with an empty driver log.
import { BLIT_FRAG, CLASSIC_FRAG, IFS_FRAG, IFS_VERT, RAY_FRAG, SHAPE_FRAG, SPECIAL_FRAG, VERT } from "./shaders.js";

function compile(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = (gl.getShaderInfoLog(shader) || "").trim();
    gl.deleteShader(shader);
    throw new Error(`${label} failed to compile.${log ? `\n${log}` : " The driver returned no log."}`);
  }
  return shader;
}

function link(gl, vsSource, fsSource, label) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource, `${label} vertex shader`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource, `${label} fragment shader`);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = (gl.getProgramInfoLog(prog) || "").trim();
    gl.deleteProgram(prog);
    throw new Error(`${label} failed to link.${log ? `\n${log}` : ""}`);
  }
  return prog;
}

function uniforms(gl, prog) {
  const locs = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i += 1) {
    const info = gl.getActiveUniform(prog, i);
    locs[info.name] = gl.getUniformLocation(prog, info.name);
  }
  return locs;
}

export function orbitCamera(yaw, pitch, dist) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const eye = [dist * cp * sy, dist * sp, dist * cp * cy];
  const len = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  const forward = [-eye[0] / len, -eye[1] / len, -eye[2] / len];
  let right = [-forward[2], 0, forward[0]];
  const rl = Math.hypot(right[0], right[1], right[2]);
  if (rl < 1e-5) right = [1, 0, 0];
  else right = right.map((v) => v / rl);
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { eye, forward, right, up };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.programs = {};
    this.locs = {};
    this.program("classic", VERT, CLASSIC_FRAG);
    this.program("blit", VERT, BLIT_FRAG);
    this.vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.palA = this.makePalette();
    this.palB = this.makePalette();
    this.dataTex = gl.createTexture();
    this.fbo = gl.createFramebuffer();
    this.texW = 0;
    this.texH = 0;
    this.lost = false;
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
    });
  }

  program(name, vs, fs) {
    const prog = link(this.gl, vs, fs, name);
    this.programs[name] = prog;
    this.locs[name] = uniforms(this.gl, prog);
    return prog;
  }

  makePalette() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256 * 4));
    return tex;
  }

  uploadPalette(which, pixels) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, which === "b" ? this.palB : this.palA);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  }

  ensureTarget(w, h) {
    if (this.texW === w && this.texH === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dataTex, 0);
    this.texW = w;
    this.texH = h;
  }

  drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(state) {
    if (this.lost) return null;
    const gl = this.gl;
    this.resizeDisplay(state.cssW, state.cssH, state.displayArea);
    this.ensureTarget(state.texW, state.texH);
    if (state.fractalDirty) this.drawFractal(state);
    this.blit(state);
    if (state.capture) return this.readFrame();
    return null;
  }

  resizeDisplay(cssW, cssH, maxArea) {
    const area = Math.max(1, cssW * cssH);
    const scale = area > maxArea ? Math.sqrt(maxArea / area) : 1;
    const w = Math.max(2, Math.round(cssW * scale));
    const h = Math.max(2, Math.round(cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  drawFractal(state) {
    const gl = this.gl;
    const vw = state.viewW;
    const vh = state.viewH;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, vw, vh);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (state.family === "ray") this.drawRay(state, vw, vh);
    else if (state.family === "ifs") this.drawIfs(state, vw, vh);
    else this.drawEscape(state, vw, vh);
    gl.disable(gl.SCISSOR_TEST);
  }

  drawEscape(state, vw, vh) {
    const gl = this.gl;
    const key = state.formula >= 12 ? "shape" : state.formula >= 8 ? "special" : "classic";
    if (!this.programs[key]) {
      const source = key === "shape" ? SHAPE_FRAG : SPECIAL_FRAG;
      this.program(key, VERT, source);
    }
    const prog = this.programs[key];
    const u = this.locs[key];
    gl.useProgram(prog);
    gl.uniform2f(u.uResolution, vw, vh);
    gl.uniform2f(u.uCenter, state.cx, state.cy);
    gl.uniform1f(u.uRadius, state.radius);
    gl.uniform1f(u.uRotation, state.rotation);
    gl.uniform1f(u.uPower, state.power);
    gl.uniform1f(u.uBailout, state.bailout);
    gl.uniform2f(u.uJulia, state.juliaRe, state.juliaIm);
    gl.uniform1f(u.uExtra, state.extra);
    gl.uniform1i(u.uFormula, state.formula);
    gl.uniform1i(u.uMaxIter, state.iters);
    gl.uniform1f(u.uTrap, state.trap);
    gl.uniform1i(u.uSkip, state.skipInterior ? 1 : 0);
    this.drawQuad();
  }

  drawRay(state, vw, vh) {
    if (!this.programs.ray) this.program("ray", VERT, RAY_FRAG);
    const gl = this.gl;
    const u = this.locs.ray;
    const cam = state.camera;
    gl.useProgram(this.programs.ray);
    gl.uniform2f(u.uResolution, vw, vh);
    gl.uniform3f(u.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform3f(u.uForward, cam.forward[0], cam.forward[1], cam.forward[2]);
    gl.uniform3f(u.uRight, cam.right[0], cam.right[1], cam.right[2]);
    gl.uniform3f(u.uUp, cam.up[0], cam.up[1], cam.up[2]);
    gl.uniform1f(u.uPower, state.power);
    gl.uniform1i(u.uShape, state.formula);
    gl.uniform1i(u.uSteps, state.steps);
    gl.uniform1i(u.uIters, state.rayIters);
    this.drawQuad();
  }

  drawIfs(state, vw, vh) {
    if (!this.programs.ifs) this.program("ifs", IFS_VERT, IFS_FRAG);
    const gl = this.gl;
    const u = this.locs.ifs;
    gl.useProgram(this.programs.ifs);
    gl.uniform2f(u.uCenter, state.cx, state.cy);
    gl.uniform1f(u.uRadius, state.radius);
    gl.uniform1f(u.uAspect, vw / vh);
    gl.uniform1f(u.uRotation, state.rotation);
    gl.uniform1i(u.uKind, state.formula);
    gl.uniform1i(u.uIters, state.ifsIters);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, state.ifsPoints);
    gl.disable(gl.BLEND);
  }

  blit(state) {
    const gl = this.gl;
    const u = this.locs.blit;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.programs.blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.uniform1i(u.uData, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palA);
    gl.uniform1i(u.uPalA, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.palB);
    gl.uniform1i(u.uPalB, 2);
    gl.uniform1f(u.uPalMix, state.palMix);
    gl.uniform2f(u.uValid, state.viewW / this.texW, state.viewH / this.texH);
    gl.uniform2f(u.uTexel, 1 / state.viewW, 1 / state.viewH);
    gl.uniform1f(u.uPhase, state.phase);
    gl.uniform1f(u.uDensity, state.density);
    gl.uniform1f(u.uBlur, state.blur);
    gl.uniform1f(u.uEdge, state.edge);
    gl.uniform1f(u.uBeat, state.beat);
    gl.uniform1f(u.uExposure, state.exposure);
    gl.uniform1i(u.uSource, state.family === "ifs" ? 1 : 0);
    gl.uniform1i(u.uColorInterior, state.colorInterior ? 1 : 0);
    gl.uniform1i(u.uPost, state.post);
    this.drawQuad();
  }

  readFrame() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { pixels, w, h };
  }

  destroy() {
    const lose = this.gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
  }
}
