// Desk material previews: each material rendered as a small product shot (window light, soft
// sheet shadow, a spiral drawing on the sheet), saved as a contact sheet via /__shot.
//   /dev/desks.html?w=720&h=480&ids=nero,calacatta   (default: all)
//   /dev/desks.html?w=264&h=176&swatch=1   one small file per desk (shots/swatch_<id>.jpg), framed
//   on the sheet's upper-left corner, for the Film dialog's background picker
import { DESKS, DESK_GLSL } from '../js/desks.js';

const q = new URLSearchParams(location.search);
const W = +(q.get('w') || 720), H = +(q.get('h') || 480);
const ids = (q.get('ids') || DESKS.map(d => d.id).join(',')).split(',');

const FRAG = `#version 300 es
precision highp float;
out vec4 frag;
uniform vec2 uRes;
uniform int uId;
uniform float uZoom;
uniform vec2 uOff;
${DESK_GLSL}
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float portrait(vec2 q) {
  // a stand-in subject: head and shoulders, so the drawing on the sheet reads as spiral art
  float head = 1.0 - smoothstep(0.0, 0.03, length(vec2(q.x, (q.y + 0.07) * 0.82)) - 0.2);
  float hair = 1.0 - smoothstep(0.0, 0.03, length(vec2(q.x, q.y + 0.15)) - 0.2);
  float body = 1.0 - smoothstep(0.0, 0.04, length(vec2(q.x * 0.7, q.y - 0.42)) - 0.26);
  float eyes = 0.0;
  for (int s = -1; s <= 1; s += 2) eyes = max(eyes, 1.0 - smoothstep(0.0, 0.015, length(vec2(q.x - float(s) * 0.075, (q.y + 0.08) * 1.8)) - 0.03));
  float shade = smoothstep(-0.2, 0.2, q.x) * 0.35;
  return clamp(max(hair * (1.0 - head) * 0.95, max(body * 0.8, head * (0.12 + shade) + eyes * 0.8)), 0.0, 1.0);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  uv.y = 1.0 - uv.y;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 1.55 / uZoom + uOff;   // sheet ~ 1.0 wide, 2/3 of the frame height
  Desk d = deskMaterial(uId, p);
  // relief normal from the material height
  float e = 1.5 / uRes.y;
  float hx = deskHeight(uId, p + vec2(e, 0.0)) - deskHeight(uId, p - vec2(e, 0.0));
  float hy = deskHeight(uId, p + vec2(0.0, e)) - deskHeight(uId, p - vec2(0.0, e));
  vec3 n = normalize(vec3(-hx * 0.9, -hy * 0.9, 1.0));
  vec3 L = normalize(vec3(-0.55, -0.65, 0.55));
  float key = 0.5 + 0.65 * smoothstep(1.5, -0.6, dot(p, vec2(0.62, 0.78)));   // window at the upper left
  float lambert = max(0.0, dot(n, L)) / L.z;
  vec3 light = vec3(1.0, 0.97, 0.92) * key * mix(1.0, lambert, 0.8) + vec3(0.12, 0.13, 0.15);
  float sun = 1.0;
  if (uId == 6) {
    sun = dkLeafShadow(p);
    light *= mix(vec3(0.66, 0.66, 0.72), vec3(1.16, 1.04, 0.86), sun);
  }
  vec3 col = d.albedo * light;
  // polished stones mirror the window as a soft diagonal band plus a clear-coat sheen
  float band = exp(-pow((p.x * 0.55 + p.y * 0.85 + 0.45) / 0.32, 2.0));
  col += d.gloss * (band * 0.28 + 0.025) * vec3(1.0, 0.98, 0.95) * (uId == 6 ? sun : 1.0);
  col += d.sheen * vec3(0.07, 0.3, 0.2) * (0.5 + 0.6 * key);
  col += d.albedo * d.emit;

  // the sheet: slightly turned, a contact shadow and a soft cast shadow toward the lower right
  float a = -0.045;
  vec2 ps = mat2(cos(a), -sin(a), sin(a), cos(a)) * (p - vec2(0.0, -0.02));
  float sheet = sdBox(ps, vec2(0.5));
  float castD = sdBox(ps - vec2(0.028, 0.045), vec2(0.5));
  float shadow = mix(0.38, 1.0, smoothstep(-0.03, 0.11, castD)) * mix(0.72, 1.0, smoothstep(0.0, 0.012, sheet));
  col *= sheet > 0.0 ? shadow : 1.0;
  if (sheet <= 0.0) {
    vec3 paper = vec3(0.955, 0.93, 0.872) * (1.0 + 0.018 * dkNoise(ps * 180.0));
    // spiral drawing: rings thicken with the subject's darkness
    float r = length(ps);
    float th = atan(ps.y, ps.x);
    float rings = 34.0;
    float t = r / 0.42 * rings - th / 6.2831853;
    float fl = abs(fract(t) - 0.5);
    float dark = r < 0.42 ? portrait(ps / 1.05) * smoothstep(0.42, 0.36, r) : 0.0;
    float w = 0.06 + 0.4 * dark;
    float aa = fwidth(t) * 0.8;
    float ink = r < 0.42 ? 1.0 - smoothstep(w - aa, w + aa, fl) : 0.0;
    paper = mix(paper, vec3(0.1, 0.095, 0.09), ink * 0.92);
    vec3 plight = vec3(1.0, 0.98, 0.94) * (0.72 + 0.35 * key) * (uId == 6 ? mix(vec3(0.62, 0.66, 0.76), vec3(1.12, 1.02, 0.88), sun) : vec3(1.0));
    col = paper * plight;
    col *= 1.0 - 0.06 * smoothstep(-0.01, 0.0, sheet);         // edge
  }
  // grade: filmic curve, a touch of warmth, vignette, fine grain
  col *= 1.0 - 0.28 * pow(length((uv - 0.5) * vec2(1.0, 1.1)) * 1.3, 2.2);
  col = aces(col * 1.05);
  col = pow(col, vec3(0.97, 1.0, 1.04));
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 180.0;
  frag = vec4(col, 1.0);
}`;

const VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

function render() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr);
  gl.useProgram(pr);
  gl.bindVertexArray(gl.createVertexArray());
  gl.uniform2f(gl.getUniformLocation(pr, 'uRes'), W, H);
  const swatch = q.get('swatch') === '1';
  gl.uniform1f(gl.getUniformLocation(pr, 'uZoom'), swatch ? 1.2 : 1);
  gl.uniform2f(gl.getUniformLocation(pr, 'uOff'), swatch ? -0.89 : 0, swatch ? -0.69 : 0);
  if (swatch) {
    return ids.map(id => {
      const d = DESKS.find(x => x.id === id);
      gl.uniform1i(gl.getUniformLocation(pr, 'uId'), d.shader);
      gl.viewport(0, 0, W, H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return { name: 'swatch_' + id, data: c.toDataURL('image/jpeg', 0.86) };
    });
  }
  const cols = Math.min(4, ids.length), rows = Math.ceil(ids.length / cols);
  const sheetC = document.createElement('canvas');
  const pad = 14, label = 40;
  sheetC.width = cols * (W + pad) + pad; sheetC.height = rows * (H + pad + label) + pad;
  const g = sheetC.getContext('2d');
  g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, sheetC.width, sheetC.height);
  ids.forEach((id, i) => {
    const d = DESKS.find(x => x.id === id);
    gl.uniform1i(gl.getUniformLocation(pr, 'uId'), d.shader);
    gl.viewport(0, 0, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const x = pad + (i % cols) * (W + pad), y = pad + Math.floor(i / cols) * (H + pad + label);
    g.drawImage(c, x, y);
    g.fillStyle = '#1c1b19'; g.font = '600 20px system-ui';
    g.fillText(`${i + 1}. ${d.name}`, x + 4, y + H + 26);
    g.fillStyle = '#6e6a63'; g.font = '16px system-ui';
    g.fillText(d.note, x + 20 + g.measureText(`${i + 1}. ${d.name}`).width, y + H + 26);
  });
  return sheetC;
}

(async () => {
  try {
    const out = render();
    if (Array.isArray(out)) {
      const files = [];
      for (const f of out) files.push((await (await fetch('/__shot', { method: 'POST', body: JSON.stringify(f) })).json()).file);
      window.__done = { ok: true, files };
    } else {
      const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: q.get('shot') || 'desks', data: out.toDataURL('image/jpeg', 0.92) }) });
      window.__done = { ok: true, ...(await r.json()) };
    }
  } catch (e) { console.error(e); window.__done = { ok: false, error: String(e.stack || e) }; }
})();
