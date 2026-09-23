// Checks the baked desk textures: each desk's albedo over a window wider than one repeat (so the
// cross-faded seam is visible at the dashed lines), and its aux channels. Saved via /__shot.
//   /dev/deskbake.html?size=2048&span=4.8&ids=nero,sunlit
import { DESKS, bakeDesk } from '../js/desks.js';

const q = new URLSearchParams(location.search);
const S = +(q.get('px') || 420), span = +(q.get('span') || 4.8), size = +(q.get('size') || 2048);
const ids = (q.get('ids') || DESKS.map(d => d.id).join(',')).split(',');

const VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FRAG = `#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D uTex;
uniform float uPeriod, uSpan, uPx;
uniform int uMode;
void main() {
  vec2 uv = gl_FragCoord.xy / uPx; uv.y = 1.0 - uv.y;
  vec2 P = (uv - 0.5) * uSpan;
  vec4 t = texture(uTex, P / uPeriod);
  vec3 c = uMode == 0 ? t.rgb : uMode == 1 ? vec3(t.a) : t.rgb;
  // the sheet outline and the repeat seams (dashed)
  float px = uSpan / uPx;
  float sheet = abs(max(abs(P.x), abs(P.y)) - 0.5) < px ? 1.0 : 0.0;
  vec2 sp = abs(P - uPeriod * (floor(P / uPeriod + 0.5)) - vec2(uPeriod * 0.5));
  float dash = step(0.5, fract((P.x + P.y) * 8.0));
  float seam = (min(sp.x, sp.y) < px) ? dash : 0.0;
  c = mix(c, vec3(1.0, 0.2, 0.2), sheet * 0.8);
  c = mix(c, vec3(0.2, 0.6, 1.0), seam * 0.9);
  frag = vec4(c, 1.0);
}`;

(async () => {
  await new Promise(r => setTimeout(r, 30));     // let the page finish loading first
  try {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr);
    const vao = gl.createVertexArray();
    const out = document.createElement('canvas');
    const pad = 10, label = 30, cols = 3;
    out.width = cols * (S + pad) + pad; out.height = ids.length * (S + pad + label) + pad;
    const g = out.getContext('2d');
    g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, out.width, out.height);
    const times = [];
    ids.forEach((id, row) => {
      const t0 = performance.now();
      const stats = {};
      const b = bakeDesk(gl, id, { size, stats });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      times.push(`${id} ${(performance.now() - t0).toFixed(0)}ms (compile ${stats.compileMs?.toFixed(0)})`);
      [[b.albedo, 0, 'albedo'], [b.albedo, 1, 'gloss'], [b.aux, 2, 'aux: sun, sheen, glow']].forEach(([tex, mode, name], col) => {
        gl.useProgram(pr); gl.bindVertexArray(vao);
        gl.viewport(0, 0, S, S);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(pr, 'uTex'), 0);
        gl.uniform1f(gl.getUniformLocation(pr, 'uPeriod'), b.period);
        gl.uniform1f(gl.getUniformLocation(pr, 'uSpan'), span);
        gl.uniform1f(gl.getUniformLocation(pr, 'uPx'), S);
        gl.uniform1i(gl.getUniformLocation(pr, 'uMode'), mode);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const x = pad + col * (S + pad), y = pad + row * (S + pad + label);
        g.drawImage(c, x, y);
        g.fillStyle = '#1c1b19'; g.font = '600 16px system-ui';
        g.fillText(`${b.desk.name} — ${name}`, x + 2, y + S + 20);
      });
      gl.deleteTexture(b.albedo); gl.deleteTexture(b.aux);
    });
    const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: q.get('shot') || 'deskbake', data: out.toDataURL('image/jpeg', 0.9) }) });
    window.__done = { ok: true, times, ...(await r.json()) };
  } catch (e) { console.error(e); window.__done = { ok: false, error: String(e.stack || e) }; }
})();
