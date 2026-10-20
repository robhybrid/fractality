const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uRotation;
uniform float uPower;
uniform float uBailout;
uniform vec2 uJulia;
uniform float uExtra;
uniform int uFormula;
uniform int uMaxIter;
uniform int uSkip;

vec2 cpowFast(vec2 z, float p) {
  if (abs(p - 2.0) < 0.0008) return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
  float r2 = dot(z, z);
  if (r2 < 1e-16) return vec2(0.0);
  float r = pow(r2, 0.5 * p);
  float a = atan(z.y, z.x) * p;
  return vec2(cos(a), sin(a)) * r;
}

bool cardioid(vec2 c) {
  float q = (c.x - 0.25) * (c.x - 0.25) + c.y * c.y;
  if (q * (q + (c.x - 0.25)) <= 0.25 * c.y * c.y) return true;
  float dx = c.x + 1.0;
  return dx * dx + c.y * c.y <= 0.0625;
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(ndc.x * aspect, ndc.y) * uRadius;
  float c = cos(uRotation);
  float s = sin(uRotation);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + uCenter;
  bool julia = uFormula == 1 || uFormula == 7;
  vec2 cc = julia ? uJulia : p;
  vec2 z = julia ? p : vec2(0.0);
  vec2 prev = vec2(0.0);
  float power = max(uPower, 0.35);
  if (uFormula == 0 && uSkip == 1 && abs(power - 2.0) < 0.02 && cardioid(cc)) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float bail = max(uBailout, 4.0);
  int n = uMaxIter;
  if (n > 48) n = 48;
  if (n < 1) n = 1;
  vec2 check = z;
  for (int i = 0; i < 48; i++) {
    if (i >= n) break;
    vec2 base = z;
    if (uFormula == 2) base = abs(z);
    if (uFormula == 3) base = vec2(z.x, -z.y);
    if (uFormula == 6) base = vec2(z.x, abs(z.y));
    vec2 w = cpowFast(base, power);
    if (uFormula == 4) w.x = abs(w.x);
    if (uFormula == 5) w = abs(w);
    if (uFormula == 7) w += vec2(uExtra, 0.0) * prev;
    prev = z;
    z = w + cc;
    float z2 = dot(z, z);
    if (z2 > bail) {
      float mag = sqrt(max(z2, 1.0001));
      float nu = log(log(mag) / log(sqrt(bail))) / log(max(power, 1.05));
      float iter = float(i) + 1.0 - nu;
      float stripe = 0.5 + 0.5 * sin(atan(z.y, z.x) * 2.0);
      gl_FragColor = vec4(floor(iter) / 255.0, fract(iter), stripe, 1.0);
      return;
    }
    if (uFormula == 0 && uSkip == 1 && i > 24 && mod(float(i), 16.0) < 0.5) {
      if (dot(z - check, z - check) < 1e-5) {
        gl_FragColor = vec4(0.0);
        return;
      }
      check = z;
    }
  }
  gl_FragColor = vec4(0.0);
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

export function createGpu() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  const locs = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) {
    const info = gl.getActiveUniform(prog, i);
    locs[info.name] = gl.getUniformLocation(prog, info.name);
  }
  return {
    fill(buf, state) {
      const w = buf.w;
      const h = buf.h;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      }
      gl.useProgram(prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.uniform2f(locs.uResolution, w, h);
      gl.uniform2f(locs.uCenter, state.cx, state.cy);
      gl.uniform1f(locs.uRadius, state.radius);
      gl.uniform1f(locs.uRotation, state.rotation || 0);
      gl.uniform1f(locs.uPower, state.power);
      gl.uniform1f(locs.uBailout, state.bailout);
      gl.uniform2f(locs.uJulia, state.juliaRe || 0, state.juliaIm || 0);
      gl.uniform1f(locs.uExtra, state.extra || 0);
      gl.uniform1i(locs.uFormula, state.formula | 0);
      gl.uniform1i(locs.uMaxIter, Math.max(1, Math.min(48, state.iters | 0)));
      gl.uniform1i(locs.uSkip, state.skipInterior ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      buf.source = 0;
      for (let y = 0; y < h; y += 1) {
        const src = (h - 1 - y) * w * 4;
        const dst = y * w;
        for (let x = 0; x < w; x += 1) {
          const s = src + x * 4;
          const i = dst + x;
          const a = pixels[s + 3];
          buf.alpha[i] = a < 13 ? 0 : 1;
          buf.iter[i] = pixels[s] + pixels[s + 1] / 255;
          buf.extra[i] = pixels[s + 2] / 255;
        }
      }
      return true;
    },
    destroy() {
      const lose = gl.getExtension("WEBGL_lose_context");
      lose?.loseContext();
    },
  };
}
