export const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const HELPERS = `
vec2 csqr(vec2 z) {
  return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
}
vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
vec2 cdiv(vec2 a, vec2 b) {
  float d = dot(b, b);
  if (d < 1e-12) return vec2(0.0);
  return vec2(dot(a, b), a.y * b.x - a.x * b.y) / d;
}
vec2 cpowFast(vec2 z, float p) {
  if (abs(p - 2.0) < 0.0008) return csqr(z);
  if (abs(p - 3.0) < 0.0008) return cmul(csqr(z), z);
  float r2 = dot(z, z);
  if (r2 < 1e-16) return vec2(0.0);
  float r = pow(r2, 0.5 * p);
  float a = atan(z.y, z.x) * p;
  return vec2(cos(a), sin(a)) * r;
}
vec4 encode(float iter, float extra, float alpha) {
  iter = clamp(iter, 0.0, 255.0);
  return vec4(floor(iter) / 255.0, fract(iter), clamp(extra, 0.0, 1.0), alpha);
}
vec4 interior() {
  return vec4(0.0, 0.0, 0.0, 0.0);
}
vec2 worldPos() {
  vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2(ndc.x * aspect, ndc.y) * uRadius;
  float c = cos(uRotation);
  float s = sin(uRotation);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  return p + uCenter;
}
bool cardioid(vec2 c) {
  float x = c.x;
  float y = c.y;
  float q = (x - 0.25) * (x - 0.25) + y * y;
  if (q * (q + (x - 0.25)) <= 0.25 * y * y) return true;
  float dx = x + 1.0;
  if (dx * dx + y * y <= 0.0625) return true;
  return false;
}
`;

const UNIFORMS = `
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
uniform float uTrap;
uniform int uSkip;
out vec4 fragColor;
`;

export const CLASSIC_FRAG = `#version 300 es
precision highp float;
${UNIFORMS}
${HELPERS}
vec2 stepZ(vec2 z, vec2 prev, vec2 c, float power, int formula) {
  vec2 base = z;
  if (formula == 2) base = abs(z);
  if (formula == 3) base = vec2(z.x, -z.y);
  if (formula == 6) base = vec2(z.x, abs(z.y));
  vec2 w = cpowFast(base, power);
  if (formula == 4) w.x = abs(w.x);
  if (formula == 5) w = abs(w);
  if (formula == 7) w += vec2(uExtra, 0.0) * prev;
  return w + c;
}
void main() {
  vec2 p = worldPos();
  int formula = uFormula;
  bool julia = formula == 1 || formula == 7;
  vec2 c = julia ? uJulia : p;
  vec2 z = julia ? p : vec2(0.0);
  vec2 prev = vec2(0.0);
  float power = max(uPower, 0.35);
  vec4 color = interior();
  if (!(formula == 0 && uSkip == 1 && abs(power - 2.0) < 0.02 && cardioid(c))) {
    float bail = max(uBailout, 4.0);
    float stripe = 0.0;
    float trap = 4.0;
    vec2 check = z;
    int n = uMaxIter;
    if (n > 64) n = 64;
    if (n < 1) n = 1;
    bool done = false;
    for (int i = 0; i < 64; i++) {
      if (done || i >= n) {
        done = true;
      } else {
        vec2 nz = stepZ(z, prev, c, power, formula);
        prev = z;
        z = nz;
        float z2 = dot(z, z);
        float ang = atan(z.y, z.x);
        stripe = stripe * 0.55 + 0.45 * (0.5 + 0.5 * sin(ang * 2.0));
        if (uTrap > 0.001) trap = min(trap, abs(length(z) - uTrap));
        if (z2 > bail) {
          float mag = sqrt(max(z2, 1.0001));
          float nu = log(log(mag) / log(sqrt(bail))) / log(max(power, 1.05));
          float extra = uTrap > 0.001 ? clamp(1.0 - trap / max(uTrap, 0.001), 0.0, 1.0) : clamp(stripe, 0.0, 1.0);
          color = encode(float(i) + 1.0 - nu, extra, 1.0);
          done = true;
        } else if (formula == 0 && uSkip == 1 && i > 24 && mod(float(i), 16.0) < 0.5) {
          if (dot(z - check, z - check) < 1e-5) done = true;
          check = z;
        }
      }
    }
  }
  fragColor = color;
}
`;

export const SPECIAL_FRAG = `#version 300 es
precision highp float;
${UNIFORMS}
${HELPERS}
vec4 lyapunov(vec2 p) {
  float x = 0.5;
  float sumv = 0.0;
  int n = uMaxIter;
  if (n > 48) n = 48;
  if (n < 8) n = 8;
  bool bad = false;
  for (int i = 0; i < 48; i++) {
    if (i < n && !bad) {
      float r = mod(float(i), 2.0) < 0.5 ? p.x : p.y;
      x = r * x * (1.0 - x);
      float deriv = abs(r * (1.0 - 2.0 * x));
      if (!(deriv > 1e-8) || x < -1.0 || x > 2.0) bad = true;
      else sumv += log(deriv);
    }
  }
  float lam = sumv / float(n);
  if (bad || lam >= 0.0) return interior();
  return encode(clamp(-lam * 12.0, 0.0, 80.0), 0.35, 1.0);
}
void main() {
  vec2 p = worldPos();
  int formula = uFormula;
  float power = max(uPower, 0.35);
  vec2 c = p;
  vec2 z = p;
  vec4 color = interior();
  if (formula == 11) {
    color = lyapunov(p);
  } else {
    float bail = max(uBailout, 4.0);
    int n = uMaxIter;
    if (formula == 8 && n > 32) n = 32;
    if (n > 64) n = 64;
    bool done = false;
    for (int i = 0; i < 64; i++) {
      if (done || i >= n) {
        done = true;
      } else if (formula == 8) {
        vec2 zp = cpowFast(z, power);
        vec2 dz = cpowFast(z, max(power - 1.0, 0.2)) * power;
        z = z - cdiv(zp - vec2(1.0, 0.0), dz);
        float ang = atan(z.y, z.x);
        float sector = 6.28318530718 / power;
        float k = floor(ang / sector + 0.5);
        float targetA = k * sector;
        if (length(z - vec2(cos(targetA), sin(targetA))) < 0.004 && length(z) < 1.6) {
          color = encode(abs(k) * 9.0 + float(i) * 0.7, fract(abs(k) * 0.17), 1.0);
          done = true;
        }
      } else if (formula == 9) {
        vec2 zp = cpowFast(z, power);
        vec2 dz = cpowFast(z, max(power - 1.0, 0.2)) * power;
        z = z - uExtra * cdiv(zp - vec2(1.0, 0.0), dz) + c;
        if (dot(z, z) > bail) {
          color = encode(float(i), 0.4, 1.0);
          done = true;
        }
      } else {
        vec2 num = csqr(z) + c - vec2(1.0, 0.0);
        vec2 den = 2.0 * z + c - vec2(2.0, 0.0);
        z = csqr(cdiv(num, den));
        if (dot(z, z) > bail) {
          color = encode(float(i), 0.5, 1.0);
          done = true;
        }
      }
    }
  }
  fragColor = color;
}
`;

export const SHAPE_FRAG = `#version 300 es
precision highp float;
${UNIFORMS}
${HELPERS}
vec2 fold2(vec2 p, float ang) {
  vec2 n = vec2(cos(-ang), sin(-ang));
  p -= 2.0 * min(0.0, dot(p, n)) * n;
  return p;
}
float d2hline(vec2 p) {
  p.x -= clamp(p.x, 0.0, 1.0);
  return length(p);
}
vec2 kochFold(vec2 pt) {
  pt.x = abs(pt.x);
  pt.x -= 0.5;
  return fold2(pt, 0.523598775598);
}
vec2 kochCurve(vec2 pt, int n) {
  for (int i = 0; i < 8; i++) {
    if (i < n) {
      pt *= 3.0;
      pt.x -= 1.5;
      pt = kochFold(pt);
    }
  }
  return pt;
}
vec4 bands(float trueD) {
  float core = exp(-trueD * 700.0);
  float tone = clamp(-log2(max(trueD, 1e-8)) * 1.35, 0.0, 96.0);
  return encode(tone, clamp(core, 0.0, 1.0), 1.0);
}
vec4 sierpinski(vec2 p) {
  const float H = 0.8660254037844386;
  float gz = p.y / H;
  float gy = p.x - 0.5 * gz;
  float gx = 1.0 - gy - gz;
  if (gx < 0.0 || gy < 0.0 || gz < 0.0) {
    return encode(clamp(-min(gx, min(gy, gz)) * 22.0, 0.0, 40.0), 0.15, 1.0);
  }
  int n = uMaxIter;
  if (n > 10) n = 10;
  if (n < 1) n = 1;
  for (int i = 0; i < 10; i++) {
    if (i < n) {
      if (gx < 0.5 && gy < 0.5 && gz < 0.5) return encode(float(i) * 7.0 + 2.0, float(i) / float(n), 1.0);
      gx = gx >= 0.5 ? gx * 2.0 - 1.0 : gx * 2.0;
      gy = gy >= 0.5 ? gy * 2.0 - 1.0 : gy * 2.0;
      gz = gz >= 0.5 ? gz * 2.0 - 1.0 : gz * 2.0;
    }
  }
  return interior();
}
vec4 carpet(vec2 p) {
  if (p.x <= 0.0 || p.y <= 0.0 || p.x >= 1.0 || p.y >= 1.0) {
    vec2 q = clamp(p, 0.0, 1.0);
    return encode(length(p - q) * 36.0, 0.1, 1.0);
  }
  float s = 1.0;
  int n = uMaxIter;
  if (n > 7) n = 7;
  for (int i = 0; i < 7; i++) {
    if (i < n) {
      s *= 3.0;
      vec2 local = fract(p * s);
      if (local.x > 0.333333 && local.x < 0.666667 && local.y > 0.333333 && local.y < 0.666667) {
        return encode(float(i) * 8.0 + 3.0, 0.45, 1.0);
      }
    }
  }
  return interior();
}
vec4 koch(vec2 p, int snow) {
  int n = uMaxIter;
  if (n > 7) n = 7;
  if (n < 3) n = 3;
  vec2 pt = p;
  if (snow == 1) {
    pt = pt * 0.7;
    pt -= vec2(0.5, 0.3);
    pt = fold2(pt, -2.09439510239);
    pt.x += 1.0;
    pt = fold2(pt, -1.0471975512);
  } else {
    pt = pt * 0.5 + 0.5;
  }
  pt = kochCurve(pt, n);
  return bands(d2hline(pt) / pow(3.0, float(n)));
}
vec4 kaleido(vec2 p) {
  int n = uMaxIter;
  if (n > 8) n = 8;
  if (n < 3) n = 3;
  vec2 pt = p * 0.8;
  for (int i = 0; i < 8; i++) {
    if (i < n) {
      pt *= 2.0;
      pt.x -= 1.0;
      pt = fold2(pt, -2.9);
      pt = fold2(pt, 0.9 + uExtra);
      pt.y += 1.0 + uExtra * 0.35;
      pt = fold2(pt, -1.0);
    }
  }
  return bands(d2hline(pt) / pow(2.0, float(n)));
}
void main() {
  vec2 p = worldPos();
  if (uFormula == 12) fragColor = sierpinski(p);
  else if (uFormula == 13) fragColor = carpet(p);
  else if (uFormula == 14) fragColor = koch(p, 0);
  else if (uFormula == 15) fragColor = koch(p, 1);
  else fragColor = kaleido(p);
}
`;

export const BLIT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uData;
uniform sampler2D uPalA;
uniform sampler2D uPalB;
uniform float uPalMix;
uniform vec2 uValid;
uniform vec2 uTexel;
uniform float uPhase;
uniform float uDensity;
uniform float uBlur;
uniform float uEdge;
uniform float uBeat;
uniform float uExposure;
uniform int uSource;
uniform int uColorInterior;
uniform int uPost;
in vec2 vUv;
out vec4 fragColor;

vec3 pal(float t) {
  vec3 a = texture(uPalA, vec2(fract(t), 0.5)).rgb;
  vec3 b = texture(uPalB, vec2(fract(t), 0.5)).rgb;
  return mix(a, b, uPalMix);
}
vec4 take(vec2 uv) {
  return texture(uData, clamp(uv, vec2(0.0), vec2(0.999)) * uValid);
}
float decode(vec4 d) {
  return d.r * 255.0 + d.g;
}
void main() {
  vec2 uv = vUv;
  vec4 d = take(uv);
  if (uBlur > 0.04) {
    vec2 o = uTexel;
    d = d * 0.4 + take(uv + vec2(o.x, 0.0)) * 0.15 + take(uv - vec2(o.x, 0.0)) * 0.15
      + take(uv + vec2(0.0, o.y)) * 0.15 + take(uv - vec2(0.0, o.y)) * 0.15;
  }
  vec3 col;
  if (uSource == 1) {
    float t = fract(uPhase + log(1.0 + d.r * 16.0) * (0.18 + uDensity * 6.0));
    col = pal(t) * smoothstep(0.015, 0.22, d.r);
  } else if (d.a < 0.05) {
    col = uColorInterior == 1 ? pal(uPhase * 0.22) * 0.32 : vec3(0.012, 0.013, 0.02);
  } else {
    float iter = decode(d);
    float t = fract(iter * uDensity + uPhase);
    col = mix(pal(t), pal(t + 0.16), d.b * 0.72);
    if (uEdge > 0.01) {
      float ix = decode(take(uv + vec2(uTexel.x, 0.0)));
      float e = clamp(abs(ix - iter) / 4.0, 0.0, 1.0);
      col += pal(t + 0.05) * e * uEdge;
    }
    if (uPost == 2) col = mix(col, vec3(pal(t - 0.012).r, pal(t).g, pal(t + 0.014).b), 0.7);
  }
  vec2 q = uv * 2.0 - 1.0;
  col *= mix(0.78, 1.0, smoothstep(1.28, 0.28, dot(q, q)));
  col *= uExposure * (1.0 + 0.38 * uBeat);
  fragColor = vec4(clamp(col, 0.0, 1.6), 1.0);
}
`;

export const RAY_FRAG = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec3 uEye;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uPower;
uniform int uShape;
uniform int uSteps;
uniform int uIters;
out vec4 fragColor;
vec4 encode(float iter, float extra, float alpha) {
  iter = clamp(iter, 0.0, 255.0);
  return vec4(floor(iter) / 255.0, fract(iter), clamp(extra, 0.0, 1.0), alpha);
}
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float mapBulb(vec3 pos) {
  vec3 z = pos;
  float dr = 1.0;
  float r = 0.0;
  float power = clamp(uPower, 2.0, 10.0);
  int iters = uIters;
  if (iters > 6) iters = 6;
  for (int i = 0; i < 6; i++) {
    if (i < iters && r < 2.0) {
      r = length(z);
      if (r > 0.0001 && r < 2.0) {
        float theta = acos(clamp(z.z / r, -1.0, 1.0));
        float phi = atan(z.y, z.x);
        dr = pow(r, power - 1.0) * power * dr + 1.0;
        float zr = pow(r, power);
        theta *= power;
        phi *= power;
        z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)) + pos;
      }
    }
  }
  return 0.5 * log(max(r, 1e-3)) * r / max(dr, 1e-3);
}
float mapBox(vec3 pos) {
  vec3 z = pos;
  float dr = 1.0;
  float scale = uPower;
  int iters = uIters;
  if (iters > 6) iters = 6;
  for (int i = 0; i < 6; i++) {
    if (i < iters) {
      z = clamp(z, -1.0, 1.0) * 2.0 - z;
      float r2 = dot(z, z);
      if (r2 < 0.25) { z *= 4.0; dr *= 4.0; }
      else if (r2 < 1.0) { float inv = 1.0 / r2; z *= inv; dr *= inv; }
      z = z * scale + pos;
      dr = dr * abs(scale) + 1.0;
    }
  }
  return length(z) / max(abs(dr), 1e-4);
}
float mapMenger(vec3 p) {
  float d = sdBox(p, vec3(1.05));
  float s = 1.0;
  int iters = uIters;
  if (iters > 4) iters = 4;
  for (int i = 0; i < 4; i++) {
    if (i < iters) {
      vec3 a = mod(p * s, 2.0) - 1.0;
      s *= 3.0;
      vec3 r = abs(1.0 - 3.0 * abs(a));
      float c = (min(max(r.x, r.y), min(max(r.y, r.z), max(r.z, r.x))) - 1.0) / s;
      d = max(d, c);
    }
  }
  return d;
}
float mapTetra(vec3 z) {
  float scale = 1.0;
  int iters = uIters;
  if (iters > 8) iters = 8;
  for (int i = 0; i < 8; i++) {
    if (i < iters) {
      if (z.x + z.y < 0.0) z.xy = -z.yx;
      if (z.x + z.z < 0.0) z.xz = -z.zx;
      if (z.y + z.z < 0.0) z.zy = -z.yz;
      z = z * 2.0 - vec3(1.0);
      scale *= 2.0;
    }
  }
  return (length(z) - 1.45) / scale;
}
float mapScene(vec3 p) {
  if (uShape == 0) return mapBulb(p);
  if (uShape == 1) return mapBox(p);
  if (uShape == 2) return mapMenger(p);
  return mapTetra(p);
}
void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 rd = normalize(uForward * 1.35 + uRight * (uv.x * aspect) + uUp * uv.y);
  float farPlane = uShape == 1 ? 18.0 : 7.5;
  float t = 0.2;
  float glow = 0.0;
  bool hit = false;
  int stepsUsed = 0;
  int steps = uSteps;
  if (steps > 24) steps = 24;
  for (int i = 0; i < 24; i++) {
    if (i < steps && t <= farPlane && !hit) {
      float d = mapScene(uEye + rd * t);
      glow += exp(-max(d, 0.0) * 7.0) * 0.07;
      stepsUsed = i;
      if (d < 0.0025 + t * 0.002) hit = true;
      else t += clamp(d * 0.92, 0.002, 0.4);
    }
  }
  if (!hit && glow < 0.03) fragColor = vec4(0.0);
  else {
    float shade = hit ? (1.0 - float(stepsUsed) / float(max(steps, 1))) : glow;
    fragColor = encode(shade * 36.0 + glow * 28.0, clamp(glow, 0.0, 1.0), 1.0);
  }
}
`;

export const IFS_VERT = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uAspect;
uniform float uRotation;
uniform int uKind;
uniform int uIters;
out float vShade;
float hashf(float n) {
  return fract(sin(n) * 43758.5453123);
}
void main() {
  float h = hashf(float(gl_VertexID) + 17.0);
  vec2 p = vec2(0.0);
  float shade = 0.4;
  int n = uIters;
  if (n > 20) n = 20;
  for (int i = 0; i < 20; i++) {
    if (i < n) {
      h = hashf(h + float(i) + 1.3);
      if (uKind == 0) {
        if (h < 0.01) { p = vec2(0.0, 0.16 * p.y); shade = 0.2; }
        else if (h < 0.86) { p = vec2(0.85 * p.x + 0.04 * p.y, -0.04 * p.x + 0.85 * p.y + 1.6); shade = 0.55; }
        else if (h < 0.93) { p = vec2(0.20 * p.x - 0.26 * p.y, 0.23 * p.x + 0.22 * p.y + 1.6); shade = 0.75; }
        else { p = vec2(-0.15 * p.x + 0.28 * p.y, 0.26 * p.x + 0.24 * p.y + 0.44); shade = 0.92; }
      } else if (uKind == 1) {
        if (h < 0.5) p = vec2(0.5 * p.x - 0.5 * p.y, 0.5 * p.x + 0.5 * p.y);
        else p = vec2(-0.5 * p.x - 0.5 * p.y + 1.0, 0.5 * p.x - 0.5 * p.y);
        shade = 0.35 + 0.5 * h;
      } else if (h < 0.25) {
        p = vec2(0.14 * p.x + 0.01 * p.y - 0.08, 0.51 * p.y - 1.31);
        shade = 0.25;
      } else if (h < 0.5) {
        p = vec2(0.43 * p.x + 0.52 * p.y + 1.49, -0.45 * p.x + 0.50 * p.y - 0.75);
        shade = 0.5;
      } else if (h < 0.75) {
        p = vec2(0.45 * p.x - 0.49 * p.y - 1.62, 0.47 * p.x + 0.47 * p.y - 0.74);
        shade = 0.72;
      } else {
        p = vec2(0.49 * p.x + 0.02, 0.51 * p.y + 1.62);
        shade = 0.9;
      }
    }
  }
  vec2 d = p - uCenter;
  float c = cos(-uRotation);
  float s = sin(-uRotation);
  d = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  gl_Position = vec4(d.x / (uRadius * uAspect), d.y / uRadius, 0.0, 1.0);
  gl_PointSize = 1.0;
  vShade = shade;
}
`;

export const IFS_FRAG = `#version 300 es
precision highp float;
in float vShade;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.42, vShade * 0.2, 0.0, 0.0);
}
`;
