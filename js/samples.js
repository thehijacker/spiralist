// Sample images: procedural stand-ins for photographs (we cannot ship real photos).
//
// Each sample is one fragment shader, rendered supersampled on this module's own WebGL2 context
// and downsampled into a plain 2D canvas. The context lives in a worker where the browser allows
// it (shader compiles never block the page), else on the main thread (see GL runtime below).
// They are judged by how they read as a spiral of 60–80 rings, so every one is built around
// large, clearly separated tonal masses first and fine detail second.
//
//   bust   raymarched plaster portrait bust, soft key light from the upper left + occlusion
//   moon   full moon with the near-side maria, rayed craters and relief, on black
//   cat    raymarched tabby-and-white cat head with bright irises; whiskers drawn in 2D on top
//   peaks  layered ridges in evening haze under a large low sun
//
// Compile time, not GPU time, is the budget here (D3D compilers behind ANGLE inline every call
// and unroll every loop they can): each raymarcher calls its SDF from exactly ONE place — a
// single loop that marches, then takes the normal, occlusion and shadow taps — and every loop
// bound goes through the uZero uniform so it cannot be unrolled.
//
// Output is deterministic (no Math.random, fixed seeds); the same device gives the same pixels.

export const SAMPLES = [
  { id: 'bust', name: 'Plaster bust',
    alt: 'A classical plaster bust of a young man with wavy sculpted hair, lit softly from the upper left against a grey studio backdrop' },
  { id: 'moon', name: 'Full moon',
    alt: 'The full moon with its dark maria and bright rayed craters on a black sky' },
  { id: 'cat', name: 'Tabby cat',
    alt: 'Portrait of a tabby-and-white cat with bright amber-green eyes and white whiskers on a pale background' },
  { id: 'peaks', name: 'Mountain sunset',
    alt: 'Layered mountain ridges with glowing mist in the valleys between them, beneath a large pale setting sun' },
];

// ------------------------------------------------------------------------------ GLSL chunks
const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;      // render target size, px
uniform int uZero;      // always 0
uniform vec4 uView;     // dev overrides (yaw, pitch, roll, spare); zero = the shipped framing
out vec4 outColor;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float vnoise1(float x) { float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }
float vnoise2(vec2 x) {
  vec2 i = floor(x), f = fract(x); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float vnoise3(vec3 x) {
  vec3 i = floor(x), f = fract(x); vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = uZero; i < 5; i++) { s += a * vnoise2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1; a *= 0.5; }
  return s / 0.96875;
}

mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / k1; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float smax(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
// 1 below a, 0 above b (a < b): the falling edge without reversed smoothstep edges (undefined in GLSL)
float fall(float a, float b, float x) { return 1.0 - smoothstep(a, b, x); }

// Ray vs axis-aligned box (centre c, half size h): (tnear, tfar).
vec2 boxHit(vec3 ro, vec3 rd, vec3 c, vec3 h) {
  vec3 m = 1.0 / rd, n = m * (ro - c), k = abs(m) * h;
  vec3 t1 = -n - k, t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}
// Tetrahedral offsets for 4-tap normals.
vec3 tet(int i) { return 0.5773 * (2.0 * vec3(float(((i + 3) >> 1) & 1), float((i >> 1) & 1), float(i & 1)) - 1.0); }

vec3 acesFilm(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// Photographic finish: sRGB encode + a whisper of sensor grain (it also hides banding).
vec4 finish(vec3 lin) {
  vec3 c = toSRGB(lin);
  c += (hash12(gl_FragCoord.xy * 1.37 + 11.0) - 0.5) * (1.6 / 255.0);
  return vec4(c, 1.0);
}
`;

// Shared driver for the raymarchers: MAP(p) is called from one place only. Phases: 0 march,
// 1 four normal taps, 2 six occlusion taps, 3 soft shadow toward the key light, 4 done.
// Leaves: hit, pos, nrm, occ (raw occlusion sum), res (shadow 0..1), mat (MAP(p).y at the hit),
// dmin / pmin (closest approach of a ray that missed: soft silhouettes).
const MARCH = (MAP, { eps, stepK, maxSteps, nEps, aoStep, aoBase, aoFall, shK, shMin, shMax, shFar, onHit = '' }) => `
    int phase = 0, k = 0, steps = 0;
    float t = 0.0, occ = 0.0, sca = 1.0, res = 1.0, ts = ${shMin}, mat = 0.0, dmin = 1e3;
    vec3 P = o, pos = o, nrm = vec3(0.0), sp = o, pmin = o;
    for (int i = uZero; i < ${maxSteps + 90}; i++) {
      vec2 hm = ${MAP}(P);
      float h = hm.x;
      if (phase == 0) {
        if (h < ${eps}) { phase = 1; pos = P; mat = hm.y; k = 0; ${onHit} }
        else {
          if (h < dmin) { dmin = h; pmin = P; }
          t += h * ${stepK}; steps++;
          if (t > tmax || steps > ${maxSteps}) break;
          P = o + lrd * t;
          continue;
        }
      } else if (phase == 1) {
        nrm += tet(k) * h; k++;
        if (k == 4) { nrm = normalize(nrm); phase = 2; k = 0; }
      } else if (phase == 2) {
        occ += (${aoBase} + ${aoStep} * float(k) - h) * sca; sca *= ${aoFall}; k++;
        if (k == 6) { phase = 3; k = 0; sp = pos + nrm * ${nEps * 3}; }
      } else {
        res = min(res, ${shK} * h / ts);
        ts += clamp(h * 0.8, ${shMin}, ${shMax}); k++;
        if (res < 0.002 || ts > ${shFar} || k > 64) { phase = 4; break; }
      }
      if (phase == 1) P = pos + ${nEps} * tet(k);
      else if (phase == 2) P = pos + nrm * (${aoBase} + ${aoStep} * float(k));
      else P = sp + lk * ts;
    }
    bool hit = phase >= 3;
    res = clamp(res, 0.0, 1.0);
    res = res * res * (3.0 - 2.0 * res);
`;

// ---------------------------------------------------------------------------------- bust
// Units: centimetres, head space y up, z out of the face, origin between the eyes.
const BUST = HEAD + `
const float HALF = 17.5;   // half the frame height at the subject, cm
const float CAMD = 175.0;  // camera distance (a long portrait lens)
const float CY = -1.9;     // world height at the frame centre
const float CX = -2.2;     // the turned face sits left of the neck axis: centre on the nose bridge

const vec3 CAPC = vec3(0.0, 3.0, -0.9), CAPR = vec3(7.8, 9.3, 10.2);
float hairCapSd(vec3 p) { return sdEllipsoid(p - CAPC, CAPR); }
// Region above the hairline (negative inside): low at the temples, lower still behind the ears.
float hairlineSd(vec3 p) { return (4.3 - 0.045 * p.x * p.x + 0.46 * (p.z - 9.0)) - p.y; }

// Sculpted hair: broad locks combed out from a whorl at the crown, each with its own gentle
// S-wave and a few chiselled strands; the lock ends scallop the hairline.
float hairSd(vec3 p, float cap) {
  vec3 r = p - CAPC;
  vec3 w = normalize(vec3(0.0, 1.0, -0.5));          // whorl axis: up and back
  vec3 u = normalize(vec3(0.0, 0.0, 1.0) - w * dot(vec3(0.0, 0.0, 1.0), w));   // forward: seam at the back
  vec3 v = cross(w, u);
  float th = acos(clamp(dot(normalize(r), w), -1.0, 1.0));   // 0 at the crown
  float ph = atan(dot(r, v), dot(r, u));
  float s0 = ph * (27.0 / 6.2831853);
  float s = s0 + 0.45 * sin(th * 5.0 + 6.2831853 * vnoise1(s0 * 0.55 + 3.0));
  float f = fract(s) * 2.0 - 1.0;
  float lock = 1.0 - pow(abs(f), 2.4);               // flat-topped lock, V groove between locks
  lock -= 0.16 * (0.5 + 0.5 * cos(f * 12.566)) * lock;   // chiselled strands
  float amp = 0.55 * smoothstep(0.12, 0.45, th) * (0.6 + 0.8 * hash11(floor(s) + 7.0));
  float hair = cap + 0.2 - amp * lock;
  float cut = hairlineSd(p) - 0.9 * lock;            // rounded lock ends along the hairline
  return smax(hair, cut, 0.35) * 0.6;
}

// The broad forms are data, iterated by one loop each, so the compiler sees each primitive
// once (inlining ~25 primitives separately doubled the compile time).
// Ellipsoids blended in: (centre, blend k), (radii, mirrored in x).
const vec4 EC[8] = vec4[8](
  vec4(0.0, 2.2, -1.2, 0.01), vec4(0.0, 3.8, 4.8, 2.0),      // cranium, forehead
  vec4(0.0, -4.0, 3.6, 2.5), vec4(4.5, -1.2, 4.8, 2.2),      // face, cheekbones
  vec4(3.0, -2.3, 6.8, 1.6), vec4(0.0, -10.2, 8.0, 1.4),     // under the eye, chin
  vec4(0.0, -7.2, 7.0, 2.4), vec4(0.0, -30.0, -1.0, 3.0));   // mouth barrel, chest
const vec4 ER[8] = vec4[8](
  vec4(7.0, 8.8, 9.4, 0.0), vec4(5.4, 4.4, 4.5, 0.0),
  vec4(6.0, 6.2, 5.8, 0.0), vec4(1.9, 1.45, 2.4, 1.0),
  vec4(1.9, 1.5, 1.7, 1.0), vec4(2.1, 1.8, 1.9, 0.0),
  vec4(3.2, 2.7, 3.0, 0.0), vec4(17.5, 11.0, 9.5, 0.0));
// Capsules blended in, mirrored: (end a, radius), (end b, blend k).
const vec4 CA[8] = vec4[8](
  vec4(4.8, -1.3, 4.4, 0.7), vec4(5.4, -2.5, 0.0, 1.3),      // zygomatic arch, ramus
  vec4(4.9, -7.4, -0.6, 1.15), vec4(0.0, 1.5, 9.2, 0.95),    // jaw, brow ridge
  vec4(0.0, -22.0, 0.3, 5.5), vec4(4.8, -5.5, -3.0, 1.3),    // neck, neck muscle
  vec4(4.0, -18.5, -2.0, 4.6), vec4(1.8, -20.2, 4.6, 0.8));  // shoulder, clavicle
const vec4 CB[8] = vec4[8](
  vec4(6.4, -1.4, 0.6, 1.5), vec4(4.9, -7.4, -0.6, 2.0),
  vec4(0.0, -10.5, 7.2, 2.8), vec4(4.6, 1.9, 7.7, 1.4),
  vec4(0.0, -7.5, -2.4, 1.6), vec4(1.3, -19.5, 3.8, 1.5),
  vec4(16.0, -23.5, -1.5, 3.0), vec4(11.5, -19.0, 1.5, 1.2));

vec2 mapBust(vec3 p) {
  vec3 q = vec3(abs(p.x), p.yz);
  float d = 1e3;
  for (int i = uZero; i < 8; i++) {
    vec4 c = EC[i], r = ER[i];
    d = smin(d, sdEllipsoid((r.w > 0.5 ? q : p) - c.xyz, r.xyz), c.w);
  }
  for (int i = uZero; i < 8; i++) d = smin(d, sdCapsule(q, CA[i].xyz, CB[i].xyz, CA[i].w), CB[i].w);

  // eyes: a shallow socket, the eyeball, and lids = eyeball shells cut by two planes through
  // its centre (the planes meet at the corners: the almond), melted into brow and cheek
  d = smax(d, -sdEllipsoid(q - vec3(3.15, 0.3, 9.3), vec3(1.95, 1.2, 1.3)), 0.9);
  vec3 e = q - vec3(3.15, 0.0, 7.55);
  float le = length(e);
  float lidU = smax(le - 1.48, -dot(e, vec3(0.0, 0.96, -0.28)), 0.12);
  float lidL = smax(le - 1.36, -dot(e, vec3(0.0, -0.9, -0.44)), 0.1);
  d = smin(d, min(lidU, lidL), 0.6);
  float eye = le - 1.25;
  // drilled pupils (Roman style), turned a little toward the camera
  vec3 ec = p - vec3(sign(p.x) * 3.15, 0.0, 7.55);
  eye = smax(eye, -(length(ec - normalize(vec3(0.24, 0.02, 1.0)) * 1.28) - 0.3), 0.1);
  d = min(d, eye);

  // nose: a straight Greek bridge, the tip, the wings, the nostrils
  float nose = sdCapsule(p, vec3(0.0, 0.5, 9.2), vec3(0.0, -3.7, 11.3), 0.58);
  nose = smin(nose, sdEllipsoid(p - vec3(0.0, -4.0, 11.15), vec3(0.85, 0.75, 0.8)), 0.8);
  nose = smin(nose, sdEllipsoid(q - vec3(1.12, -4.3, 10.3), vec3(0.8, 0.7, 0.85)), 0.9);
  d = smin(d, nose, 0.9);
  d = smax(d, -sdEllipsoid(q - vec3(0.55, -4.95, 10.7), vec3(0.4, 0.24, 0.5)), 0.25);

  // lips on a bent axis (the mouth wraps round the teeth): an upper lip of two lobes under a
  // cupid's bow, a fuller lower lip, a parting line and small dimples at the corners
  vec3 m = p - vec3(0.0, -7.1, 9.9); m.z += 0.13 * m.x * m.x;
  vec3 mq = vec3(abs(m.x), m.yz);
  float ul = sdEllipsoid(mq - vec3(0.5, 0.04, 0.15), vec3(1.55, 0.66, 0.85));
  float ll = sdEllipsoid(m - vec3(0.0, -1.18, 0.05), vec3(1.7, 0.85, 1.05));
  d = smin(d, smin(ul, ll, 0.3), 0.3);
  // the parting ends inside the corners (an ellipsoid tapers to nothing at its ends), where a
  // small pit takes over; wider, it ran on across the cheeks as a knife cut
  d = smax(d, -sdEllipsoid(m - vec3(0.0, -0.6, 0.45), vec3(1.62, 0.07, 1.3)), 0.1);   // parting
  d = smax(d, -(length(mq - vec3(1.68, -0.62, -0.3)) - 0.22), 0.2);                   // corners
  d = smax(d, -sdEllipsoid(p - vec3(0.0, -5.95, 10.6), vec3(0.32, 0.55, 0.22)), 0.3);  // philtrum

  // ears: a flat shell with a hollow bowl, tipped back
  vec3 ea = q - vec3(7.05, -1.9, -0.8);
  ea.xz = rot2(0.3) * ea.xz;
  float ear = sdEllipsoid(ea, vec3(0.75, 3.0, 1.75));
  ear = smax(ear, -sdEllipsoid(ea - vec3(0.6, 0.35, 0.1), vec3(0.5, 2.2, 1.3)), 0.25);
  d = smin(d, ear, 0.6);

  // hair (bounded by its cap: the expensive lock pattern only runs near it)
  float cap = hairCapSd(p);
  float hairMat = 0.0;
  if (cap < 1.5) {
    float hair = hairSd(p, cap);
    hairMat = 1.0 - smoothstep(-0.2, 0.3, hair - d);
    d = smin(d, hair, 0.3);
  } else {
    // locks stand at most 0.2 - 0.55 * 1.4 = -0.57 from the cap surface: a safe bound far away
    d = min(d, cap - 0.6);
  }
  return vec2(d, hairMat);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 ro = vec3(CX, CY, CAMD);
  vec3 rd = normalize(vec3(uv * HALF, 0.0) + vec3(CX, CY, 0.0) - ro);
  float yaw = -0.33 + uView.x, pitch = 0.05 + uView.y, roll = 0.03 + uView.z;
  mat3 M = rotY(yaw) * rotX(pitch) * rotZ(roll);
  mat3 Mt = transpose(M);

  // Lights (world): soft key high on the left (loop lighting: both eye sockets, a short nose
  // shadow and the chin shadow all read as a spiral), dim fill right, a cool rim from behind.
  vec3 kP = vec3(-47.0, 64.0, 60.0) + vec3(CX, CY, 0.0);   // key: a large soft box ~1 m away
  vec3 kL = normalize(kP - vec3(CX, CY, 0.0));
  vec3 fL = normalize(vec3(0.85, 0.05, 0.55));
  vec3 rL = normalize(vec3(0.75, 0.35, -0.55));

  // studio backdrop, mid grey lit with counterchange: darker behind the lit side of the head,
  // a pool of light behind its shadow side, so both edges of the silhouette separate
  float pool = exp(-dot(uv - vec2(0.55, 0.2), uv - vec2(0.55, 0.2)) * 1.3);
  vec3 col = vec3(0.15, 0.146, 0.14) * (0.55 + 0.45 * smoothstep(-1.0, 1.0, uv.x) + 0.8 * pool);
  col *= (0.9 + 0.1 * uv.y) * (1.0 - 0.1 * dot(uv, uv));

  vec3 lro = Mt * ro, lrd = Mt * rd;
  vec3 lk = Mt * kL, lf = Mt * fL, lr = Mt * rL, lkP = Mt * kP;
  vec2 tb = boxHit(lro, lrd, vec3(0.0, -14.0, 0.0), vec3(22.0, 28.0, 15.0));
  if (tb.x < tb.y && tb.y > 0.0) {
    float t0 = max(tb.x, 0.0);
    vec3 o = lro + lrd * t0;
    float tmax = tb.y - t0;
${MARCH('mapBust', { eps: '0.004', stepK: '0.75', maxSteps: 230, nEps: 0.012, aoStep: '0.55', aoBase: '0.12', aoFall: '0.72', shK: '9.0', shMin: '0.06', shMax: '2.5', shFar: '60.0', onHit: 'lk = normalize(lkP - P);' })}
    if (hit) {
      float ao = clamp(1.0 - 0.28 * occ, 0.0, 1.0);
      vec3 n = nrm;
      // matte plaster; inverse-square falloff from the soft box keeps the chest and chin a
      // little darker than the brow
      float fallK = pow(length(kP) / length(lkP - pos), 2.0);
      float dif = clamp(dot(n, lk), 0.0, 1.0) * res * fallK;
      float fill = clamp(0.5 + 0.5 * dot(n, lf), 0.0, 1.0);
      float sky = clamp(0.5 + 0.5 * dot(n, Mt * vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
      float bounce = 1.0 - sky;
      float rim = pow(clamp(1.0 + dot(n, lrd), 0.0, 1.0), 3.0) * clamp(dot(n, lr) + 0.3, 0.0, 1.0);
      vec3 alb = vec3(0.80, 0.775, 0.735) * (0.965 + 0.07 * vnoise3(pos * 3.1));
      alb *= 1.0 - 0.16 * mat;      // old cast: dust has settled among the locks
      vec3 lin = vec3(1.0, 0.97, 0.92) * dif * 0.74
               + vec3(0.62, 0.66, 0.72) * sky * 0.16 * ao
               + vec3(0.75, 0.75, 0.78) * fill * 0.1 * ao
               + vec3(0.9, 0.82, 0.72) * bounce * 0.04 * ao;
      col = alb * lin * mix(1.0, ao, 0.7) + vec3(0.55, 0.6, 0.7) * rim * 0.32 * ao;
    }
  }
  col = acesFilm(col * 1.3);
  outColor = finish(col);
}
`;

// ---------------------------------------------------------------------------------- moon
const MOON = HEAD + `
const float R = 0.80;   // moon radius, fraction of the half frame

// The near-side maria as soft caps on the sphere: (disc x, disc y, angular radius, darkness).
const vec4 MARE[16] = vec4[16](
  vec4(-0.62, 0.16, 0.40, 0.8), vec4(-0.55, -0.14, 0.26, 0.75),   // Oceanus Procellarum
  vec4(-0.30, 0.50, 0.30, 0.95), vec4(-0.36, 0.79, 0.13, 0.65),   // Imbrium, Frigoris
  vec4(-0.06, 0.84, 0.12, 0.65), vec4(0.22, 0.80, 0.11, 0.6),
  vec4(0.22, 0.44, 0.18, 0.8), vec4(0.38, 0.14, 0.20, 1.0),       // Serenitatis, Tranquillitatis
  vec4(0.52, 0.02, 0.12, 0.9), vec4(0.74, 0.28, 0.12, 1.0),       // Crisium
  vec4(0.62, -0.13, 0.14, 0.85), vec4(0.40, -0.28, 0.10, 0.85),   // Fecunditatis, Nectaris
  vec4(0.05, 0.28, 0.09, 0.75), vec4(-0.18, -0.36, 0.20, 0.65),   // Vaporum, Nubium
  vec4(-0.52, -0.40, 0.11, 0.85), vec4(-0.30, -0.14, 0.12, 0.6)); // Humorum, Cognitum

// Young craters with bright ray systems: (disc x, disc y, ray length, strength).
const vec4 RAYED[5] = vec4[5](vec4(-0.12, -0.70, 0.7, 1.5), vec4(-0.32, 0.18, 0.16, 0.5),
                              vec4(-0.52, 0.12, 0.1, 0.6), vec4(-0.62, 0.36, 0.05, 1.0),
                              vec4(0.55, -0.45, 0.08, 0.5));

vec3 capDir(vec2 c) { return vec3(c, sqrt(max(0.0, 1.0 - dot(c, c)))); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec2 m = uv / R;
  float r2 = dot(m, m);
  float rr = sqrt(r2);
  // black sky with the faint scatter a lens gives a bright disc
  vec3 col = vec3(0.014, 0.014, 0.017) * exp(-max(0.0, rr - 1.0) * 6.0) + vec3(0.0015);
  float aa = 1.5 / (uRes.x * 0.5 * R);   // one pixel in disc units
  if (rr < 1.0 + aa) {
    vec3 n = vec3(m, sqrt(max(0.0, 1.0 - r2)));
    mat3 lib = rotY(0.06) * rotX(-0.04);    // a touch of libration
    vec3 s = lib * n;
    // maria: caps with outlines warped by noise, each with its own depth of tone
    vec3 wv = vec3(0.0);
    float a = 0.5; vec3 x = s * 3.0;
    for (int i = uZero; i < 4; i++) {
      wv += a * (vec3(vnoise3(x), vnoise3(x + 5.2), vnoise3(x + 9.7)) - 0.5);
      x = x * 2.1 + 1.3; a *= 0.5;
    }
    vec3 sw = normalize(s + wv * 0.4);
    float fine = vnoise3(s * 26.0) - 0.5;
    float mare = 0.0;
    for (int i = uZero; i < 16; i++) {
      vec4 M = MARE[i];
      float ang = acos(clamp(dot(sw, capDir(M.xy)), -1.0, 1.0));
      mare = max(mare, M.w * fall(M.z * 0.78, M.z * 1.04, ang + 0.05 * fine));
    }
    // crater layers: bowls with raised rims on jittered 3D grids, big and sparse to small and
    // many. Accumulate the height gradient (relief), freshness (young ejecta are bright), floors.
    vec3 grad = vec3(0.0); float fresh = 0.0, floorDark = 0.0;
    for (int L = uZero; L < 4; L++) {
      float fl = float(L);
      float scale = 6.0 * pow(2.3, fl);
      float keep = 0.3 + 0.1 * fl;
      float depth = 0.2 * pow(0.7, fl);
      vec3 xg = s * scale;
      vec3 ip = floor(xg), f = fract(xg);
      for (int k = uZero - 1; k <= 1; k++)
      for (int j = uZero - 1; j <= 1; j++)
      for (int i = uZero - 1; i <= 1; i++) {
        vec3 b = vec3(float(i), float(j), float(k));
        vec3 h = hash33(ip + b + scale);
        if (h.x > keep) continue;
        vec3 c = b + 0.15 + 0.7 * hash33(ip + b + 17.0 + scale);
        float rad = 0.14 + 0.28 * h.y * h.y;
        vec3 dv = f - c;
        dv -= s * dot(dv, s);
        float dl = length(dv);
        float r = dl / rad;
        if (r > 2.2) continue;
        float rim = r - 1.0;
        grad += dv / max(dl, 1e-5) * depth * ((r < 1.0 ? 1.8 * r : 0.0) - 9.8 * rim * exp(-rim * rim * 14.0));
        fresh += (h.z > 0.75 ? 1.0 : 0.3) * exp(-rim * rim * 7.0) * 0.55;
        floorDark += fall(0.5, 0.95, r) * 0.5;
      }
    }
    grad *= (1.0 - 0.7 * mare) * smoothstep(0.0, 0.35, n.z);   // smooth maria; a clean limb
    fresh *= 1.0 - 0.8 * mare;
    float ray = 0.0;
    for (int i = uZero; i < 5; i++) {
      vec4 R4 = RAYED[i];
      vec3 cc = capDir(R4.xy);
      vec3 t1 = normalize(cross(cc, vec3(0.0, 1.0, 0.0))), t2 = cross(cc, t1);
      vec3 dd = s - cc;
      float dist = length(dd);
      float ang = atan(dot(dd, t2), dot(dd, t1));
      float seed = float(i) * 4.1 + 1.0;
      // a few broad streaks that break up with distance, a bright ejecta blanket, a dark collar
      float streak = pow(vnoise1(ang * 5.0 + seed), 3.0) + 0.5 * pow(vnoise1(ang * 13.0 + seed * 3.0), 5.0);
      streak *= 0.4 + 1.1 * vnoise2(vec2(ang * 7.0 + seed, dist * 9.0));
      ray += R4.w * (streak * exp(-dist / R4.z) * smoothstep(0.02, 0.07, dist)
                   + 1.1 * exp(-dist * dist / 0.0018) - 0.35 * exp(-pow((dist - 0.016) / 0.006, 2.0)));
    }
    float speck = vnoise3(s * 45.0) - 0.5;
    float highland = 0.6 + 0.2 * wv.z + 0.05 * fine + 0.07 * speck;
    float sea = 0.2 + 0.1 * wv.y + 0.03 * fine;
    float alb = mix(highland, sea, mare);
    alb += 0.12 * min(fresh, 1.2) + 0.2 * clamp(ray, -0.3, 1.5);
    alb -= 0.04 * min(floorDark, 1.0) * (1.0 - mare);
    // slight colour: the maria lean blue (titanium-rich) or brown
    vec3 tint = mix(vec3(1.0, 0.97, 0.92), mix(vec3(0.93, 0.95, 1.0), vec3(1.0, 0.94, 0.86), smoothstep(-0.2, 0.2, wv.y)), mare);
    // near-full phase: Lommel-Seeliger (flat, bright to the limb) with a little Lambert for relief
    vec3 nn = normalize(n - transpose(lib) * grad * 0.28);
    vec3 L = normalize(vec3(-0.035, 0.02, 1.0));
    float mu0 = max(dot(nn, L), 0.03), mu = max(nn.z, 0.05);
    float brdf = mix(2.0 * mu0 / (mu0 + mu), mu0 * 1.2, 0.25);
    vec3 moon = tint * alb * brdf * 1.2;
    col = mix(col, moon, fall(1.0 - aa, 1.0 + aa, rr));
  }
  col = acesFilm(col * 0.62);
  outColor = finish(col);
}
`;

// ---------------------------------------------------------------------------------- cat
// Units: centimetres, head space y up, z out of the face, origin between the eyes.
const CAT = HEAD + `
const float HALF = 10.8;
const float CAMD = 95.0;
const float CY = -1.7;
const vec3 EYE = vec3(1.8, 0.3, 1.85);   // right eye centre (mirrored)
const float EYER = 1.2;

// Head, neck and shoulders as data (one loop: the compiler sees one ellipsoid).
// (centre, blend k), (radii, mirrored in x)
const vec4 KC[10] = vec4[10](
  vec4(0.0, 0.9, -0.7, 0.01), vec4(2.45, -1.35, 0.7, 1.6),   // cranium, cheeks
  vec4(3.5, -1.9, -0.3, 1.3), vec4(0.0, -0.8, 2.2, 1.2),     // cheek ruff, nose bridge
  vec4(0.95, -2.35, 3.15, 0.7), vec4(0.0, -3.2, 2.55, 0.6),  // whisker pads, chin
  vec4(0.0, -5.0, -0.8, 2.2), vec4(0.0, -11.8, -3.0, 2.8),   // neck ruff, shoulders
  vec4(0.0, -8.2, 0.3, 2.2), vec4(2.3, -14.0, 1.2, 1.2));    // chest, forelegs
const vec4 KR[10] = vec4[10](
  vec4(4.0, 3.5, 3.9, 0.0), vec4(2.75, 2.25, 2.6, 1.0),
  vec4(1.5, 1.9, 2.1, 1.0), vec4(1.5, 2.0, 1.8, 0.0),
  vec4(1.1, 0.95, 1.05, 1.0), vec4(0.95, 0.72, 0.9, 0.0),
  vec4(4.8, 3.5, 3.8, 0.0), vec4(7.0, 6.5, 5.0, 0.0),
  vec4(4.3, 4.2, 3.4, 0.0), vec4(1.5, 4.5, 1.5, 1.0));

// ear: a cone thinned along the direction it faces; only a shell of its back half is kept, so
// the hollow faces the camera. Returns (distance, 1 inside the hollow).
const vec3 EAR_B = vec3(2.55, 3.0, -0.5), EAR_T = vec3(3.9, 7.0, -1.0);
const vec3 EAR_F = vec3(0.2873, 0.0958, 0.9530);        // facing: forward and a little out
// Tapered capsule: cheaper than an exact round cone (no branches); scaled to stay a bound.
float sdTaper(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return (length(pa - ba * h) - mix(r1, r2, h)) * 0.9;
}
vec2 ears(vec3 q) {
  // one cone: keep a shell of its surface, then cut the front half away so the hollow shows
  vec3 v = q - EAR_B;
  float cone = sdTaper(EAR_B + v + EAR_F * dot(v, EAR_F) * 0.6, EAR_B, EAR_T, 1.75, 0.16) / 1.6;
  float front = dot(v, EAR_F) - 0.05;
  float ear = smax(abs(cone + 0.14) - 0.14, front, 0.12);
  return vec2(ear, step(cone, -0.05) * step(front, 0.2));
}

float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
// Philtrum and mouth, as lines on the muzzle seen from the front: distance in x/y. mapCat keeps
// the last value in gLip; the march saves it at the hit, so coat() inks the lines without a
// second inlined copy (compile time).
float gLip = 1.0;
float mouthLine(vec3 p) {
  vec2 q = vec2(abs(p.x), p.y);
  return min(sdSeg(q, vec2(0.0, -1.95), vec2(0.0, -2.58)),
             min(sdSeg(q, vec2(0.0, -2.58), vec2(0.4, -2.83)), sdSeg(q, vec2(0.4, -2.83), vec2(0.78, -2.76))));
}

// .x distance, .y material (0 fur, 1 eye, 2 inside of the ear)
vec2 mapCat(vec3 p) {
  vec3 q = vec3(abs(p.x), p.yz);
  float d = 1e3;
  for (int i = uZero; i < 10; i++) {
    vec4 c = KC[i], r = KR[i];
    d = smin(d, sdEllipsoid((r.w > 0.5 ? q : p) - c.xyz, r.xyz), c.w);
  }
  vec2 ea = ears(q);
  d = smin(d, ea.x, 0.6);
  // eye sockets, slanted up at the outer corner
  vec3 s = q - vec3(1.8, 0.35, 2.95);
  s.xy = rot2(-0.22) * s.xy;
  d = smax(d, -sdEllipsoid(s, vec3(1.2, 0.86, 1.0)), 0.4);
  // nose leather, nostrils, philtrum and mouth
  vec3 n = p - vec3(0.0, -1.6, 4.05);
  n.x *= 1.0 + 1.1 * clamp(-n.y, 0.0, 1.0);
  d = smin(d, sdEllipsoid(n, vec3(0.62, 0.42, 0.45)), 0.35);
  d = smax(d, -(length(q - vec3(0.3, -1.72, 4.42)) - 0.12), 0.08);
  // philtrum and mouth: a crease cut straight back into the muzzle along the drawn lines (3D
  // capsules only met the curved muzzle in two places and read as two pits); coat() inks it
  gLip = mouthLine(p);
  d = smax(d, -max(gLip - 0.02, 3.4 - p.z), 0.03);
  // fur: soft clumps roughen the surface; the short fur of the muzzle lies flat, so the mouth
  // and philtrum grooves stay one clean line
  float sleek = fall(0.9, 1.5, length((p.xy - vec2(0.0, -2.3)) * vec2(0.8, 1.0))) * step(2.8, p.z);
  if (d < 0.5) d -= 0.08 * (vnoise3(p * 2.6) - 0.5) * (1.0 - 0.85 * sleek);
  float eye = length(q - EYE) - EYER;
  float m = ea.y * step(abs(ea.x - d), 0.3) * 2.0;
  return eye < d ? vec2(eye, 1.0) : vec2(d, m);
}

// Tabby-and-white coat: dark mackerel stripes on a brown-grey ground, white muzzle, chin and
// bib, a light rim round the eyes and dark eyeliner.
vec3 coat(vec3 p, float earIn, float lipD) {
  vec3 q = vec3(abs(p.x), p.yz);
  vec3 ground = vec3(0.20, 0.155, 0.11);
  vec3 stripe = vec3(0.03, 0.024, 0.02);
  vec3 white = vec3(0.80, 0.76, 0.69);
  // fur: fine streaks that run away from the nose (one anisotropic noise)
  vec3 fl = normalize(p - vec3(0.0, -1.2, 5.0));
  vec3 ps = p * 13.0; ps -= fl * dot(ps, fl) * 0.85;
  float strands = vnoise3(ps);
  float warp = (strands - 0.5) * 0.35;
  float st = 0.0;
  // forehead: the tabby M of vertical bars
  st = max(st, smoothstep(1.2, 2.0, p.y) * fall(2.4, 3.2, q.x) * smoothstep(0.25, 0.75, sin(p.x * 3.4 + 0.5 * sin(p.y * 1.7) + warp)));
  // crown and back of the head: broad bars
  st = max(st, smoothstep(3.2, 4.2, p.y + 0.3 * q.x) * smoothstep(0.1, 0.7, sin(p.x * 2.2 + 1.0 + warp)));
  // cheeks: lines sweeping back from the outer eye corner
  st = max(st, smoothstep(2.3, 3.2, q.x) * fall(0.3, 1.2, p.y - 0.3) * smoothstep(0.35, 0.85, sin((p.y - 0.42 * q.x) * 4.2 + 0.8 + warp)));
  // mackerel bars down the shoulders
  st = max(st, fall(-5.2, -4.2, p.y) * smoothstep(1.2, 3.0, q.x + 0.35 * (p.y + 6.0)) * smoothstep(0.3, 0.8, sin(p.y * 2.1 + 0.6 * sin(p.x * 1.3) + warp * 2.0)));
  vec3 c = mix(ground, stripe, st * 0.92) * (0.72 + 0.56 * strands);
  // white: muzzle, chin, whisker pads, a blaze up the nose, a bib down the chest
  float muz = fall(0.9, 1.6, length((p.xy - vec2(0.0, -2.5)) * vec2(0.62, 1.0)));
  float blaze = fall(0.35, 0.75, abs(p.x) - 0.25 * (p.y + 1.0)) * fall(0.4, 1.6, p.y) * step(-2.0, p.y);
  float bib = fall(-4.2, -3.2, p.y) * fall(0.9, 2.1, q.x - 0.06 * (p.y + 4.0) + warp * 2.0);
  float w = clamp(max(max(muz, blaze * 0.9), bib) + warp * 0.6, 0.0, 1.0);
  c = mix(c, white * (0.72 + 0.4 * strands), w);
  // inside of the ears: pale pink skin behind light tufts
  c = mix(c, mix(vec3(0.34, 0.2, 0.18), white * 0.8, 0.3 * strands), earIn);
  // light rim above and below each eye, dark eyeliner right at the edge
  float ed = length(q - EYE) - EYER;
  c = mix(c, white * 0.7, fall(0.12, 0.42, ed) * 0.4);
  c = mix(c, stripe, fall(0.03, 0.13, ed));
  // dark lip skin along the mouth, fading up the philtrum
  float lip = fall(0.015, 0.08, lipD) * step(3.3, p.z) * mix(0.3, 0.9, smoothstep(-2.3, -2.6, p.y));
  c = mix(c, vec3(0.08, 0.055, 0.05), lip * (1.0 - 0.5 * smoothstep(0.35, 0.8, q.x)));
  return c;
}

vec3 irisColor(vec3 e) {
  // e: unit vector from the eye centre; the eye looks along +z
  vec2 t = e.xy;
  float r = length(t);
  float ang = atan(t.y, t.x);
  vec3 c = mix(vec3(0.6, 0.42, 0.08), vec3(0.3, 0.36, 0.09), smoothstep(0.15, 0.6, r));
  c *= 0.7 + 0.6 * vnoise2(vec2(ang * 16.0, r * 7.0));      // radial fibres
  c *= 0.5 + 0.5 * fall(0.1, 0.7, t.y);                     // the upper lid shades the iris
  c *= 1.0 - 0.8 * smoothstep(0.62, 0.76, r);             // dark limbal ring
  return mix(c, vec3(0.005), fall(0.9, 1.05, length(t / vec2(0.12, 0.46))));   // slit pupil
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 ro = vec3(0.0, CY, CAMD);
  vec3 rd = normalize(vec3(uv * HALF, 0.0) + vec3(0.0, CY, 0.0) - ro);
  mat3 M = rotY(-0.14 + uView.x) * rotX(0.06 + uView.y) * rotZ(0.08 + uView.z);
  mat3 Mt = transpose(M);
  vec3 kL = normalize(vec3(-0.6, 0.6, 0.6));
  vec3 rL = normalize(vec3(0.7, 0.45, -0.6));

  // clean, softly lit backdrop
  vec3 col = mix(vec3(0.60, 0.58, 0.54), vec3(0.78, 0.76, 0.72), smoothstep(-1.0, 1.0, uv.y - 0.4 * uv.x));
  col *= 1.0 - 0.12 * dot(uv, uv);

  vec3 lro = Mt * ro, lrd = Mt * rd;
  vec3 lk = Mt * kL, lr = Mt * rL;
  vec2 tb = boxHit(lro, lrd, vec3(0.0, -4.5, -1.0), vec3(9.5, 12.5, 7.5));
  if (tb.x < tb.y && tb.y > 0.0) {
    float t0 = max(tb.x, 0.0);
    vec3 o = lro + lrd * t0;
    float tmax = tb.y - t0;
    float hitLip = 1.0;
${MARCH('mapCat', { eps: '0.002', stepK: '0.7', maxSteps: 200, nEps: 0.01, aoStep: '0.3', aoBase: '0.06', aoFall: '0.75', shK: '7.0', shMin: '0.04', shMax: '1.2', shFar: '25.0', onHit: 'hitLip = gLip;' })}
    if (hit) {
      float ao = clamp(1.0 - 0.5 * occ, 0.0, 1.0);
      vec3 n = nrm;
      float sky = clamp(0.5 + 0.5 * n.y, 0.0, 1.0);
      if (mat > 0.5 && mat < 1.5) {
        // eye: iris under a glossy cornea, shaded by the upper lid
        vec3 q = vec3(abs(pos.x), pos.yz);
        vec3 alb = irisColor(normalize(q - EYE));
        float dif = clamp(dot(n, lk), 0.0, 1.0) * res;
        vec3 lin = vec3(1.0, 0.97, 0.9) * dif * 1.1 + vec3(0.7, 0.75, 0.8) * 0.45 * ao;
        col = alb * lin * 0.95 * mix(0.35, 1.0, ao);
        vec3 rf = reflect(lrd, n);
        float spec = pow(clamp(dot(rf, lk), 0.0, 1.0), 220.0) * 5.0 * res + pow(clamp(dot(rf, lk), 0.0, 1.0), 12.0) * 0.08;
        float fres = 0.04 + 0.5 * pow(1.0 - clamp(-dot(lrd, n), 0.0, 1.0), 5.0);
        col += vec3(spec) + fres * vec3(0.6, 0.62, 0.65) * ao;
      } else {
        vec3 alb = coat(pos, step(1.5, mat), hitLip);
        // nose leather: dusty pink
        vec3 nq = pos - vec3(0.0, -1.6, 4.05);
        nq.x *= 1.0 + 1.1 * clamp(-nq.y, 0.0, 1.0);
        alb = mix(alb, vec3(0.40, 0.19, 0.18), fall(0.35, 0.55, length(nq.xy / vec2(0.62, 0.5))) * step(3.9, pos.z));
        // fur: wrapped diffuse (light scatters through the coat) and a bright backlit rim
        float dif = clamp((dot(n, lk) + 0.35) / 1.35, 0.0, 1.0) * mix(0.25, 1.0, res);
        float rim = pow(clamp(1.0 + dot(n, lrd), 0.0, 1.0), 2.5) * clamp(dot(n, lr) + 0.5, 0.0, 1.0);
        vec3 lin = vec3(1.0, 0.96, 0.9) * dif * 1.8 + vec3(0.62, 0.68, 0.76) * sky * 0.45 * ao + vec3(0.4) * 0.12 * ao;
        col = alb * lin * mix(0.6, 1.0, ao) + vec3(0.9, 0.85, 0.75) * rim * 0.25 * (0.4 + alb.r * 2.0);
      }
    } else if (dmin < 0.35) {
      // a ray that grazed the coat: loose guard hairs catch the light, so the outline is soft —
      // a thin fringe round the ears, which are only a shell (a wide one read as smoke)
      vec3 dir = normalize(pmin - vec3(0.0, -1.0, 0.0));
      float hairs = vnoise2(vec2(atan(dir.y, dir.x) * 70.0, dmin * 6.0)) * 0.7 + 0.3;
      float band = mix(0.35, 0.08, smoothstep(3.0, 4.2, pmin.y));
      float a = fall(0.0, band, dmin) * hairs;
      col = mix(col, vec3(0.30, 0.26, 0.21), a * 0.85);
    }
  }
  col = acesFilm(col * 1.25);
  outColor = finish(col);
}
`;

// ---------------------------------------------------------------------------------- peaks
const PEAKS = HEAD + `
// Designed in display space (tone is what the spiral draws), linearised once at the end.
// Tonal plan: the sun is the one bright shape, a crisp disc in a mid-dark rose sky; every ridge
// is darkest at its crest and pales into mist at its foot, so each crest is a dark edge against
// the light mist of the layer behind it, stepping down to the black foreground.

// Ridged 1D fBm: sharp crests, rounded valleys.
float ridgeline(float x, float seed) {
  float s = 0.0, a = 0.5, f = 1.0;
  for (int i = uZero; i < 6; i++) {
    float n = 1.0 - abs(vnoise1(x * f + seed * 13.1) * 2.0 - 1.0);
    s += a * n * n;
    a *= 0.48; f *= 2.07;
  }
  return s;
}

// Ridge layers far to near: (base height, relief, frequency, mist band), crest and mist colours.
const vec4 RL[5] = vec4[5](vec4(0.405, 0.06, 3.4, 0.05), vec4(0.335, 0.085, 2.6, 0.06),
                           vec4(0.255, 0.11, 2.0, 0.07), vec4(0.165, 0.13, 1.6, 0.075),
                           vec4(0.06, 0.12, 1.3, 0.08));
const vec3 RC[5] = vec3[5](vec3(0.36, 0.22, 0.33), vec3(0.26, 0.15, 0.25), vec3(0.18, 0.10, 0.19),
                           vec3(0.10, 0.06, 0.12), vec3(0.04, 0.03, 0.05));
const vec3 RM[5] = vec3[5](vec3(0.76, 0.52, 0.50), vec3(0.64, 0.42, 0.45), vec3(0.50, 0.31, 0.38),
                           vec3(0.36, 0.22, 0.30), vec3(0.12, 0.08, 0.12));

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;       // 0..1, y up
  float px = 1.0 / uRes.y;
  // The sun sits on the spiral's centre; the farthest ridge hides its lower edge.
  vec2 sun = vec2(0.5, 0.5);
  float sunR = 0.105;
  float ds = length(uv - sun);
  float y = uv.y;
  // sky: dusky rose at the horizon, violet, then deep indigo overhead
  vec3 sky = mix(vec3(0.64, 0.39, 0.40), vec3(0.40, 0.25, 0.40), smoothstep(0.42, 0.66, y));
  sky = mix(sky, vec3(0.12, 0.11, 0.25), smoothstep(0.6, 1.0, y));
  // a warm glow that hugs the disc (narrow, so the disc keeps a hard edge against the sky)
  float glow = exp(-max(ds - sunR, 0.0) * 34.0);
  sky = mix(sky, vec3(0.86, 0.58, 0.46), glow * 0.45);
  // a few dark streaks of cloud high up
  float cl = fbm2(vec2(uv.x * 1.6, y * 16.0) + vec2(5.0, 0.0));
  float cloud = smoothstep(0.52, 0.72, cl) * smoothstep(0.64, 0.7, y) * fall(0.84, 0.92, y);
  sky = mix(sky, vec3(0.20, 0.14, 0.24), cloud * 0.7);
  // the sun: a pale disc, faintly limb-darkened
  vec3 sunCol = vec3(1.0, 0.96, 0.84) * (0.93 + 0.07 * sqrt(max(0.0, 1.0 - ds * ds / (sunR * sunR))));
  vec3 col = mix(sky, sunCol, fall(sunR - px, sunR + px, ds));

  for (int i = uZero; i < 5; i++) {
    float fi = float(i), k = fi / 4.0;
    vec4 L = RL[i];
    float h = L.x + L.y * ridgeline(uv.x * L.z + fi * 1.7, fi + 1.0);
    if (i == 4) {
      // a fringe of conifers along the nearest crest: narrow spires with tiers of branches
      float cell = 0.011;
      float c = floor(uv.x / cell), f = fract(uv.x / cell) - 0.5;
      float grove = vnoise1(c * 0.11 + 2.0);                          // trees grow in groves
      float th = cell * (1.6 + 2.6 * hash11(c + 3.0) + 2.5 * grove) * step(0.62 - 0.6 * grove, hash11(c + 7.0));
      float ty = clamp((y - h) / max(th, 1e-4), 0.0, 1.0);          // height up the tree
      float tier = 0.72 + 0.28 * fract(ty * (5.0 + 2.0 * hash11(c)) + hash11(c + 1.0));
      float hw = cell * 0.7 * (1.0 - ty) * tier;
      h += th * step(abs(f + 0.1 * (hash11(c + 5.0) - 0.5)) * cell, hw) * step(0.0, y - h);
    }
    float cover = fall(h - px, h + px, y);
    if (cover <= 0.0) continue;
    // darkest at the crest, paling into mist toward the foot (measured from the layer's mean
    // height, not the jagged crest, so the mist lies in level bands)
    float mist = smoothstep(0.0, L.w, L.x + L.y * 0.35 - y);
    // the mist is lit from behind: warm near the sun, rose to violet away from it
    vec3 rm = mix(RM[i], RM[i] * vec3(1.12, 0.98, 0.8), exp(-abs(uv.x - 0.5) * 3.0) * (1.0 - k));
    vec3 lc = mix(RC[i], rm, mist);
    // texture: rock and scrub on the slopes, stronger on the nearer layers
    lc *= 1.0 + (fbm2(uv * vec2(22.0, 80.0) + fi * 3.0) - 0.5) * (0.06 + 0.2 * k);
    // the far crests right under the sun catch a thin rim of light
    lc += vec3(0.5, 0.3, 0.2) * exp(-max(0.0, h - y) * 600.0) * exp(-abs(uv.x - 0.5) * 9.0) * (1.0 - k);
    col = mix(col, lc, cover);
  }
  col *= 1.0 - 0.12 * pow(length(uv - 0.5) * 1.3, 2.0);
  outColor = finish(pow(clamp(col, 0.0, 1.0), vec3(2.2)));
}
`;

const SHADERS = { bust: BUST, moon: MOON, cat: CAT, peaks: PEAKS };

// ------------------------------------------------------------------------------ GL runtime
// A runner owns one WebGL2 context and renders one job at a time, most urgent first. It runs in a
// module worker (this same file) where the browser supports WebGL2 on an OffscreenCanvas there,
// else on the main thread. The worker matters: Firefox has no KHR_parallel_shader_compile and
// compiles when the program is first queried, blocking the calling thread for 0.1–1 s per shader
// (plus ~0.6 s for its first context) — in a worker the page never feels it.
const IDLE_RELEASE_MS = 20000;
const PRECOMPILE_DELAY_MS = 1500;
const WORKER_NAME = 'spiralist-samples';
// Supersampling: the raymarched subjects are the expensive ones on a weak GPU, and 1.5x is
// already clean once the browser downsamples; the flat 2D subjects get a full 2x.
const SUPERSAMPLE = { bust: 1.5, cat: 1.5, moon: 2, peaks: 2 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
// A macrotask boundary without setTimeout's 4 ms clamp: lets the page paint (main thread) or
// queued requests arrive (worker) between jobs.
const yieldTask = () => new Promise(r => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); r(); };
  ch.port2.postMessage(null);
});
const codedError = (message, code) => Object.assign(new Error(message), { code });
const lostError = () => codedError('The graphics context was lost while making the sample image.', 'context-lost');

function createRunner(newCanvas, { background }) {
  let st = null;              // { canvas, gl, vao, programs: Map<id, prog>, parallel, maxN }
  let busy = false, seq = 0, idleTimer = 0, preTimer = 0;
  let wanted = false;         // a request came in since the last background pass
  const queue = [];

  function context() {
    if (st && !st.gl.isContextLost()) return st;
    st = null;
    const canvas = newCanvas();
    const gl = canvas && canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    if (!gl) throw codedError('Sample images need WebGL2, which this browser does not provide.', 'webgl2');
    st = { canvas, gl, vao: gl.createVertexArray(), programs: new Map(),
      parallel: gl.getExtension('KHR_parallel_shader_compile'),
      maxN: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], 4096) };
    return st;
  }

  async function program(s, id) {
    if (s.programs.has(id)) return s.programs.get(id);
    const { gl } = s;
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, SHADERS[id]);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    // Let the driver compile off this thread when it can.
    if (s.parallel) {
      while (!gl.getProgramParameter(p, s.parallel.COMPLETION_STATUS_KHR)) {
        if (gl.isContextLost()) return null;
        await sleep(2);
      }
    }
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (gl.isContextLost()) return null;
      throw codedError(`Sample shader '${id}' failed to compile: ${gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(p)}`, 'compile');
    }
    const prog = { p, uRes: gl.getUniformLocation(p, 'uRes'), uZero: gl.getUniformLocation(p, 'uZero'),
      uView: gl.getUniformLocation(p, 'uView') };
    s.programs.set(id, prog);
    return prog;
  }

  // Draw at N x N in horizontal strips flushed one by one (a slow GPU never sees one giant draw),
  // then read one pixel back: it waits for the GPU, and a context lost on the way (driver reset,
  // TDR) leaves it empty — alpha is always 255 on this opaque canvas otherwise.
  function draw(s, prog, N, view) {
    const { gl, canvas } = s;
    if (canvas.width !== N || canvas.height !== N) { canvas.width = N; canvas.height = N; }
    gl.viewport(0, 0, N, N);
    gl.useProgram(prog.p);
    gl.bindVertexArray(s.vao);
    gl.uniform2f(prog.uRes, N, N);
    gl.uniform1i(prog.uZero, 0);
    gl.uniform4f(prog.uView, view[0] || 0, view[1] || 0, view[2] || 0, view[3] || 0);
    gl.enable(gl.SCISSOR_TEST);
    const strip = 256;
    for (let y = 0; y < N; y += strip) {
      gl.scissor(0, y, N, Math.min(strip, N - y));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
    }
    gl.disable(gl.SCISSOR_TEST);
    const px = new Uint8Array(4);
    gl.readPixels(N >> 1, N >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return !gl.isContextLost() && px[3] === 255;
  }

  function drop(s) {
    if (st === s) st = null;
  }

  async function run(job) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let s;
      try { s = context(); } catch (e) {
        // no new context right after a loss (browsers block them for a moment after a GPU reset)
        if (attempt > 0) throw lostError();
        throw e;
      }
      let prog = null;
      try { prog = await program(s, job.id); } catch (e) {
        // on a context lost mid-call gl.createShader() gives null and the next call throws
        if (!s.gl.isContextLost()) throw e;
      }
      if (prog && !s.gl.isContextLost()) {
        if (job.compileOnly) return null;
        const ss = job.size <= 2048 ? SUPERSAMPLE[job.id] : 1;
        const N = Math.max(16, Math.min(s.maxN, Math.round(job.size * ss)));
        if (draw(s, prog, N, job.view)) return job.deliver(s.canvas, N);
      }
      // The context was lost while compiling or drawing: start over once on a fresh one.
      drop(s);
      if (job.compileOnly) return null;
    }
    throw lostError();
  }

  // Most urgent first: requests before background compiles, then the biggest (the image the
  // user is waiting for, not a thumbnail), then first come first served — so two clicks resolve
  // in the order they were made.
  const order = (a, b) => (a.bg - b.bg) || (b.size - a.size) || (a.seq - b.seq);

  async function pump() {
    if (busy) return;
    busy = true;
    clearTimeout(idleTimer); clearTimeout(preTimer);
    while (queue.length) {
      await yieldTask();
      queue.sort(order);
      const job = queue.shift();
      try { job.resolve(await run(job)); } catch (e) { job.reject(e); }
    }
    busy = false;
    idleTimer = setTimeout(release, IDLE_RELEASE_MS);
    preTimer = setTimeout(precompile, PRECOMPILE_DELAY_MS);
  }

  function submit(job) {
    if (!job.bg) wanted = true;
    return new Promise((resolve, reject) => {
      queue.push({ view: [], size: 0, bg: 0, ...job, seq: seq++, resolve, reject });
      pump();
    });
  }

  // Once a sample is on screen, compile the others in the background so switching is instant —
  // in the worker always, on the main thread only where the driver compiles off-thread. Once per
  // burst of requests, so a shader this GPU cannot compile is never retried in a loop.
  function precompile() {
    if (!wanted || !st || st.gl.isContextLost() || !(background || st.parallel)) return;
    wanted = false;
    for (const id of Object.keys(SHADERS)) {
      if (!st.programs.has(id)) submit({ id, compileOnly: true, bg: 1 }).catch(() => {});
    }
  }

  // Idle: give the GPU memory back. Where compiles are cheap and off-thread, hand the whole
  // context back too (the browser caps live contexts); elsewhere keep it and its programs, and
  // only shrink the canvas, so the next sample does not pay the blocking compile again.
  function release() {
    if (busy || !st) return;
    if (st.parallel) {
      st.gl.getExtension('WEBGL_lose_context')?.loseContext();
      st = null;
    } else {
      st.canvas.width = 1; st.canvas.height = 1;
    }
  }

  // dev: stop for good (timers, context)
  function dispose() {
    clearTimeout(idleTimer); clearTimeout(preTimer);
    for (const job of queue.splice(0)) job.reject(codedError('The sample renderer was reset.', 'reset'));
    if (st) st.gl.getExtension('WEBGL_lose_context')?.loseContext();
    st = null;
  }

  return { submit, dispose };
}

// ----------------------------------------------------------------------------- worker side
// This file is also the worker's module script: it renders there and posts ImageBitmaps back.
const IN_WORKER = typeof document === 'undefined' && typeof self !== 'undefined' &&
  self.name === WORKER_NAME && typeof self.postMessage === 'function';
if (IN_WORKER) {
  const runner = createRunner(() => new OffscreenCanvas(1, 1), { background: true });
  self.onmessage = async ({ data }) => {
    if (!data || data.type !== 'make') return;
    try {
      // downsample here: the page then only copies size x size pixels (drawing the big bitmap
      // there costs Chromium ~30 ms more on the main thread)
      const bitmap = await runner.submit({
        id: data.id, size: data.size, view: data.view,
        deliver: (canvas, N) => downsample(canvas, N, data.size).transferToImageBitmap(),
      });
      self.postMessage({ type: 'done', job: data.job, bitmap }, [bitmap]);
    } catch (e) {
      self.postMessage({ type: 'fail', job: data.job, code: e.code || '', message: String(e && e.message || e) });
    }
  };
  self.postMessage({ type: 'hello' });
}

// ------------------------------------------------------------------------------ 2D overlays
// Cat whiskers: 3D curves from the whisker pads, projected with the shader's camera.
function catWhiskers(ctx, size, view = []) {
  const HALF = 10.8, CAMD = 95, CY = -1.7;
  const yaw = -0.14 + (view[0] || 0), pitch = 0.06 + (view[1] || 0), roll = 0.08 + (view[2] || 0);
  const rot = ([x, y, z]) => {
    // M = rotY(yaw) * rotX(pitch) * rotZ(roll), applied right to left
    let c = Math.cos(roll), s = Math.sin(roll);
    [x, y] = [c * x - s * y, s * x + c * y];
    c = Math.cos(pitch); s = Math.sin(pitch);
    [y, z] = [c * y - s * z, s * y + c * z];
    c = Math.cos(yaw); s = Math.sin(yaw);
    [x, z] = [c * x + s * z, -s * x + c * z];
    return [x, y, z];
  };
  const project = p => {
    const [x, y, z] = rot(p);
    const k = CAMD / (CAMD - z) / HALF;
    return [(x * k + 1) * 0.5 * size, (1 - (y - CY) * k) * 0.5 * size];
  };
  const px = size / 1024;
  ctx.lineCap = 'round';
  const draw = (root, ctrl, tip, width, alpha) => {
    const a = project(root), b = project(ctrl), c = project(tip);
    // taper: three passes, each shorter and thicker toward the root
    for (const [f, w] of [[1, 0.55], [0.7, 0.8], [0.4, 1.0]]) {
      const bx = a[0] + (b[0] - a[0]) * f, by = a[1] + (b[1] - a[1]) * f;
      const cx = a[0] + 2 * (b[0] - a[0]) * f + (c[0] - 2 * b[0] + a[0]) * f * f;
      const cy = a[1] + 2 * (b[1] - a[1]) * f + (c[1] - 2 * b[1] + a[1]) * f * f;
      ctx.strokeStyle = `rgba(246, 242, 232, ${alpha})`;
      ctx.lineWidth = width * w * px;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(bx, by, cx, cy); ctx.stroke();
    }
  };
  for (const side of [-1, 1]) {
    // muzzle whiskers: rows fanning out, drooping with length
    for (let i = 0; i < 6; i++) {
      const row = i / 5;
      const root = [side * (0.85 + 0.35 * row), -2.05 - 0.55 * row, 3.95 - 0.35 * row];
      const spread = -0.25 + 0.5 * row;               // upper rows rise, lower rows fall
      const len = 5.4 + 1.2 * Math.sin(i * 1.7);
      const tip = [side * (root[0] * side + len * 0.95), root[1] - spread * len * 0.6 - 0.9, root[2] + 0.8];
      const ctrl = [side * (root[0] * side + len * 0.5), root[1] - spread * len * 0.2 + 0.35, root[2] + 1.0];
      draw(root, ctrl, tip, 1.8, 0.85 - 0.15 * row);
    }
    // brow whiskers
    for (let i = 0; i < 3; i++) {
      const root = [side * (1.3 + 0.35 * i), 1.75 + 0.1 * i, 2.9 - 0.2 * i];
      const tip = [side * (2.6 + 0.9 * i), 4.2 + 0.3 * i, 3.2];
      const ctrl = [side * (1.8 + 0.6 * i), 3.4 + 0.2 * i, 3.4];
      draw(root, ctrl, tip, 1.6, 0.7);
    }
  }
}

// ------------------------------------------------------------------------------ public API
const cache = new Map();     // key -> master canvas (callers always get their own copy)
const CACHE_MAX = 8;
const inflight = new Map();  // key -> Promise<master canvas>: identical concurrent calls share a render
const MAX_SIZE = 8192;
const WORKER_HELLO_MS = 5000;

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}

function copyOf(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// The supersampled render, downsampled by the browser into a plain size x size 2D canvas.
function downsample(src, N, size) {
  const out = makeCanvas(size, size);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, N, N, 0, 0, size, size);
  return out;
}

let mainRunner = null;
const main = () => mainRunner || (mainRunner = createRunner(() => makeCanvas(1, 1), { background: false }));

// Worker client. `worker` is null until first used; `workerOff` once the worker is known not to
// work here (no module workers, no WebGL2 on an OffscreenCanvas, a crash): the main thread takes over.
let worker = null, workerOff = false;
function workerClient() {
  if (worker || workerOff) return worker;
  const can = typeof document !== 'undefined' && typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function' &&
    typeof ImageBitmap === 'function';
  let w = null;
  try { if (can) w = new Worker(new URL(import.meta.url), { type: 'module', name: WORKER_NAME }); } catch { w = null; }
  if (!w) { workerOff = true; return null; }
  const jobs = new Map();
  let seq = 0, hello;
  const c = {
    ready: new Promise(r => { hello = r; setTimeout(() => r(false), WORKER_HELLO_MS); }),
    request(id, size, view) {
      return new Promise((resolve, reject) => {
        if (worker !== c) { reject(codedError('The sample worker stopped.', 'worker')); return; }
        const job = seq++;
        jobs.set(job, { resolve, reject });
        w.postMessage({ type: 'make', job, id, size, view });
      });
    },
    fail() {
      if (worker !== c) return;
      worker = null; workerOff = true;
      hello(false);
      w.terminate();
      for (const j of jobs.values()) j.reject(codedError('The sample worker stopped.', 'worker'));
      jobs.clear();
    },
  };
  w.onmessage = ({ data }) => {
    if (data.type === 'hello') { hello(true); return; }
    const j = jobs.get(data.job);
    if (!j) return;
    jobs.delete(data.job);
    if (data.type === 'done') j.resolve(data);
    else j.reject(codedError(data.message, data.code));
  };
  w.onerror = e => { e.preventDefault(); c.fail(); };
  w.onmessageerror = () => c.fail();
  c.ready.then(ok => { if (!ok) c.fail(); });
  return (worker = c);
}

// Render sample `id` into a new size x size canvas, in the worker when it can.
async function produce(id, size, view, engine) {
  if (engine !== 'main') {
    const c = workerClient();
    if (c && await c.ready) {
      try {
        const { bitmap } = await c.request(id, size, view);
        const out = makeCanvas(size, size);
        out.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        return out;
      } catch (e) {
        // A real answer from a working worker; anything else (no WebGL2 in workers, a crash)
        // means the worker cannot help here, so the main thread takes over for good.
        if (e.code === 'context-lost' || e.code === 'compile') throw e;
        c.fail();
      }
    }
    if (engine === 'worker') throw codedError('The sample worker is not available in this browser.', 'worker');
  }
  return main().submit({ id, size, view, deliver: (canvas, N) => downsample(canvas, N, size) });
}

function sizeOf(size) {
  if (size === undefined || size === null) return 1024;
  const n = Math.round(Number(size));
  if (!(n >= 1 && n <= MAX_SIZE)) throw new RangeError(`Sample size must be a number from 1 to ${MAX_SIZE} (got ${String(size)}).`);
  return n;
}

/**
 * Render sample `id` as a size x size canvas (a new canvas on every call). `size` is rounded;
 * anything that does not round to 1..8192 throws a RangeError.
 * Dev only: `opts.view` = [yaw, pitch, roll] offsets for the raymarched subjects;
 * `opts.engine` = 'worker' | 'main' forces where it renders.
 * Throws Error with .code 'webgl2' when WebGL2 is unavailable, 'context-lost' if the GPU context
 * cannot be kept, or a plain Error for an unknown id.
 */
export async function makeSample(id, size = 1024, opts = {}) {
  if (!Object.prototype.hasOwnProperty.call(SHADERS, id)) throw new Error(`Unknown sample '${id}'`);
  size = sizeOf(size);
  const view = opts.view || [];
  const key = `${id}@${size}@${view.join(',')}`;
  if (cache.has(key)) return copyOf(cache.get(key));
  if (!inflight.has(key)) {
    const job = produce(id, size, view, opts.engine).then(out => {
      if (id === 'cat') catWhiskers(out.getContext('2d'), size, view);
      // only a checked, complete image is ever cached
      cache.set(key, out);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return out;
    });
    inflight.set(key, job);
    job.then(() => inflight.delete(key), () => inflight.delete(key));
  }
  return copyOf(await inflight.get(key));
}

// DEV-ONLY: shader sources for the compile-time lab (dev/samples_compile.html) and runtime state
// for the tests (dev/samples_test.html). Not app API.
export const __dev = {
  SHADERS, VERT,
  engine: () => (worker ? 'worker' : mainRunner ? 'main' : null),
  // forget the worker / main runner so a test can start from scratch
  reset() {
    if (worker) worker.fail();
    if (mainRunner) mainRunner.dispose();
    worker = null; workerOff = false; mainRunner = null; cache.clear();
  },
};
