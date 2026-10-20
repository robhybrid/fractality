import { LUT_SIZE, indexFor, paint } from "./shade.js";

const LEVELS = 80;
const INTERIOR = 0xffffffff;

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const COLOR_FRAG = `
uniform sampler2D uIdx;
uniform sampler2D uLut;
uniform vec2 uSize;
uniform float uFlip;
uniform float uPhase;
uniform vec3 uInterior;

void main() {
  vec2 p = gl_FragCoord.xy;
  if (uFlip > 0.5) p.y = uSize.y - p.y;
  vec4 b = floor(texture2D(uIdx, p / uSize) * 255.0 + 0.5);
  vec3 c = uInterior;
  if (b.a > 0.5) {
    float idx = mod(b.r * 256.0 + b.g + uPhase, ${LUT_SIZE.toFixed(1)});
    vec3 l = floor(texture2D(uLut, vec2((idx + 0.5) / ${LUT_SIZE.toFixed(1)}, (b.b + 0.5) / ${LEVELS.toFixed(1)})).rgb * 255.0 + 0.5);
    if (b.a < 254.5) l = uInterior + floor((l - uInterior) * b.a / 256.0);
    c = l;
  }
  gl_FragColor = vec4(c / 255.0, 1.0);
}
`;

const PRESENT_FRAG = `
uniform sampler2D uColor;
uniform vec2 uBuf;
uniform float uOutH;
uniform vec3 uRowX;
uniform vec3 uRowY;
uniform vec3 uBg;

void main() {
  vec3 s = vec3(gl_FragCoord.x, uOutH - gl_FragCoord.y, 1.0);
  vec2 u = vec2(dot(uRowX, s), dot(uRowY, s));
  if (u.x < 0.0 || u.y < 0.0 || u.x > uBuf.x || u.y > uBuf.y) {
    gl_FragColor = vec4(uBg, 1.0);
    return;
  }
  gl_FragColor = vec4(texture2D(uColor, u / uBuf).rgb, 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function program(gl, frag) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, `precision highp float;\n${frag}`);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const locs = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) {
    const info = gl.getActiveUniform(prog, i);
    locs[info.name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, locs };
}

function texture(gl, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function rgb(packed) {
  return [packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255];
}

/**
 * Packs paint()'s per-pixel table index into RGBA8 so the palette can cycle
 * on the GPU: step in RG, table row in B, and in A 0 for interior, 255 for
 * full coverage, otherwise the antialias coverage.
 */
export function encodeFrame(buf, mode, density, maxIter, out) {
  const pidx = indexFor(buf, mode, density, maxIter);
  const n = pidx.length;
  for (let i = 0, o = 0; i < n; i += 1, o += 4) {
    const v = pidx[i];
    if (v === INTERIOR) {
      out[o + 3] = 0;
      continue;
    }
    out[o] = (v >>> 8) & 3;
    out[o + 1] = v & 255;
    out[o + 2] = v >>> 10;
    out[o + 3] = 255;
  }
  if (buf.partial) {
    const { partial, cover } = buf;
    for (let j = 0; j < partial.length; j += 1) {
      const i = partial[j];
      if (out[i * 4 + 3]) out[i * 4 + 3] = cover[i];
    }
  }
}

/**
 * WebGL1 palette pass: colors a finished frame from an index texture and
 * the baked palette table, then optionally reprojects it with an affine
 * transform. Returns null when anything fails to compile or link, so the
 * caller keeps painting on the CPU.
 */
export function createGlPresent() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });
  if (!gl) return null;
  const high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!high || high.precision < 23) return null;
  const color = program(gl, COLOR_FRAG);
  const present = program(gl, PRESENT_FRAG);
  if (!color || !present) return null;
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.disable(gl.DITHER);
  const idxTex = texture(gl, gl.NEAREST);
  const lutTex = texture(gl, gl.NEAREST);
  const colorTex = texture(gl, gl.LINEAR);
  const fbo = gl.createFramebuffer();
  let lost = false;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
  });
  let bw = 0;
  let bh = 0;
  let colorW = 0;
  let colorH = 0;
  let staging = null;
  let probes = 0;
  let slow = 0;
  let hidden = false;

  function colorPass(toScreen, phase, interior) {
    gl.useProgram(color.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, idxTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.uniform1i(color.locs.uIdx, 0);
    gl.uniform1i(color.locs.uLut, 1);
    gl.uniform2f(color.locs.uSize, bw, bh);
    gl.uniform1f(color.locs.uFlip, toScreen ? 1 : 0);
    gl.uniform1f(color.locs.uPhase, ((phase - Math.floor(phase)) * LUT_SIZE) | 0);
    gl.uniform3fv(color.locs.uInterior, rgb(interior));
    gl.viewport(0, 0, bw, bh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    canvas,
    get lost() {
      return lost || gl.isContextLost();
    },
    fits(w, h, W, H) {
      return Math.max(w, h, W, H) <= maxTex;
    },
    setLut(lut) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, LEVELS, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(lut.buffer, lut.byteOffset, LUT_SIZE * LEVELS * 4));
    },
    setFrame(buf, mode, density, maxIter) {
      const n = buf.w * buf.h * 4;
      if (!staging || staging.length !== n) staging = new Uint8Array(n);
      encodeFrame(buf, mode, density, maxIter, staging);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, idxTex);
      if (bw === buf.w && bh === buf.h) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, staging);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, buf.w, buf.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, staging);
      bw = buf.w;
      bh = buf.h;
    },
    /**
     * Draws into this canvas at W x H. `m` = [a, b, c, d, e, f] maps buffer
     * pixels to screen pixels like CanvasRenderingContext2D.setTransform;
     * null means the buffer covers the screen one to one.
     */
    draw(W, H, m, phase, interior, bg) {
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      if (!m) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        colorPass(true, phase, interior);
      } else {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, colorTex);
        if (colorW !== bw || colorH !== bh) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("color target incomplete");
          colorW = bw;
          colorH = bh;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        colorPass(false, phase, interior);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const [a, b, c, d, e, f] = m;
        const det = a * d - b * c;
        if (!det) throw new Error("singular view transform");
        gl.useProgram(present.prog);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, colorTex);
        gl.uniform1i(present.locs.uColor, 2);
        gl.uniform2f(present.locs.uBuf, bw, bh);
        gl.uniform1f(present.locs.uOutH, H);
        gl.uniform3f(present.locs.uRowX, d / det, -c / det, (c * f - d * e) / det);
        gl.uniform3f(present.locs.uRowY, -b / det, a / det, (b * e - a * f) / det);
        gl.uniform3fv(present.locs.uBg, bg.map((v) => v / 255));
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (hidden) {
        canvas.style.visibility = "";
        hidden = false;
      }
      probes += 1;
      if (probes % 90 === 0) {
        const px = new Uint8Array(4);
        const t0 = performance.now();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        slow = performance.now() - t0 > 12 ? slow + 1 : 0;
      }
      return slow < 3;
    },
    /** Shows this canvas over `under` instead of copying into it; false if it cannot. */
    attach(under) {
      const parent = under.parentNode;
      if (!parent) return false;
      const s = canvas.style;
      s.position = "fixed";
      s.pointerEvents = "none";
      s.zIndex = "0";
      s.margin = "0";
      s.visibility = "hidden";
      hidden = true;
      parent.insertBefore(canvas, under.nextSibling);
      this.place(under);
      return true;
    },
    place(under) {
      const rect = under.getBoundingClientRect();
      const s = canvas.style;
      s.left = `${rect.left}px`;
      s.top = `${rect.top}px`;
      s.width = `${rect.width}px`;
      s.height = `${rect.height}px`;
    },
    read(W, H) {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    },
    destroy() {
      canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

function synthetic(w, h, source, partial) {
  const n = w * h;
  const buf = { w, h, source, iter: new Float32Array(n), alpha: new Uint8Array(n), level: new Uint8Array(n), extra: new Float32Array(n) };
  for (let i = 0; i < n; i += 1) {
    const x = i % w;
    const y = (i / w) | 0;
    buf.iter[i] = ((x * 7.31 + y * 3.17) % 97) + ((x * y) % 13) / 13.7;
    buf.alpha[i] = (x * 5 + y * 3) % 11 === 0 ? 0 : 1;
    buf.level[i] = (x + y * 3) % LEVELS;
  }
  if (partial) {
    buf.cover = new Uint8Array(n);
    const list = [];
    for (let i = 0; i < n; i += 3) {
      buf.cover[i] = 1 + ((i * 37) % 253);
      list.push(i);
    }
    buf.partial = Int32Array.from(list);
  }
  return buf;
}

/** Renders small synthetic frames both ways and insists on a byte match. */
export function glPresentAgrees(gp) {
  const w = 64;
  const h = 40;
  const lut = new Uint32Array(LUT_SIZE * LEVELS);
  for (let i = 0; i < lut.length; i += 1) lut[i] = (0xff000000 | (Math.imul(i, 0x9e3779b1) >>> 8)) >>> 0;
  const interior = (0xff000000 | (20 << 16) | (9 << 8) | 5) >>> 0;
  const out32 = new Uint32Array(w * h);
  gp.setLut(lut);
  const cases = [
    [0, 0, false, 0.3711],
    [1, 0, true, 0.8123],
    [2, 0, true, 0.05],
    [1, 1, false, 0.61],
    [4, 0, false, 0.2],
  ];
  for (const [mode, source, partial, phase] of cases) {
    const buf = synthetic(w, h, source, partial);
    paint(buf, out32, lut, phase, 0.045, interior, mode, 100);
    gp.setFrame(buf, mode, 0.045, 100);
    for (const m of [null, [1, 0, 0, 1, 0, 0]]) {
      gp.draw(w, h, m, phase, interior, [7, 8, 12]);
      const px = gp.read(w, h);
      let bad = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const c = out32[y * w + x];
          const o = ((h - 1 - y) * w + x) * 4;
          const err = Math.max(Math.abs(px[o] - (c & 255)), Math.abs(px[o + 1] - ((c >>> 8) & 255)), Math.abs(px[o + 2] - ((c >>> 16) & 255)));
          if (err > 2) bad += 1;
        }
      }
      if (bad > w * h * 0.01) return false;
    }
  }
  return true;
}
