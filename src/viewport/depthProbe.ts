// i18n-ignore-file GPU diagnostics only: English so a bug report stays searchable
// How many depth bits the canvas really resolves, measured rather than asked.
//
// Doug's reports say `depth bits: 24` and his view draws the way a 16-bit buffer
// does in a rig (.fable/doug-squiggles2/RESULT.md). DEPTH_BITS is what the
// context was GRANTED on paper; a stack can answer 24 and still resolve less.
// This draws two flat quads into one pixel, the second a step 2^-k nearer than
// the first, and reads back which one won: the largest k where the nearer one
// still wins is the precision the buffer actually has. It runs once, before the
// first frame, whose clear paints over it.
//
// It clears the WHOLE buffer, never a scissored part: 0.1.269 cleared a 1x1
// scissor, and on Doug's Ivy Bridge (Mesa crocus, where partial depth clears are
// reported broken) it came back "?" with no way to tell why. Every way it can
// fail now says which.

/** The largest k in [lo, hi] for which `resolves(k)` holds, scanning upward and
 *  stopping at the first failure (precision does not come back at finer steps),
 *  or `lo - 1` when even the coarsest step fails. */
export function highestResolved(lo: number, hi: number, resolves: (k: number) => boolean): number {
  let best = lo - 1;
  for (let k = lo; k <= hi; k++) {
    if (!resolves(k)) break;
    best = k;
  }
  return best;
}

const VS = `#version 300 es
in vec2 p;
uniform float z;
void main() { gl_Position = vec4(p, z, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform vec4 c;
out vec4 o;
void main() { o = c; }`;

export interface DepthMeasure {
  /** bits resolved, 0 when the depth test does not work at all, null when unknown */
  bits: number | null;
  /** why `bits` is 0 or null, for the bug report */
  why?: string;
}

/** Effective depth bits of the default framebuffer (or `fb`, for a test). The
 *  caller must reset its GL state tracking afterwards (three:
 *  renderer.resetState()). */
export function measureDepthBits(gl: WebGL2RenderingContext, fb: WebGLFramebuffer | null = null): DepthMeasure {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray();
  try {
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { bits: null, why: `link failed: ${(gl.getProgramInfoLog(prog) || gl.getShaderInfoLog(vs) || gl.getShaderInfoLog(fs) || "no log").slice(0, 80)}` };
    }
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uz = gl.getUniformLocation(prog, "z"), uc = gl.getUniformLocation(prog, "c");
    gl.viewport(0, 0, 1, 1);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.depthRange(0, 1);
    const px = new Uint8Array(4);
    // window depth 0.75, so a fixed-point step and a float one both mean 2^-k
    const base = 0.75;
    const draw = (wz: number, r: number, g: number) => {
      gl.uniform1f(uz, wz * 2 - 1); // window depth -> NDC
      gl.uniform4f(uc, r, g, 0, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    /** red at `base`, then green at `base + dz`: what is in the pixel? */
    const read = (dz: number) => {
      gl.clearDepth(1);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);
      draw(base, 1, 0);
      draw(base + dz, 0, 1);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px[1]! > 128 && px[0]! < 128 ? "green" : px[0]! > 128 && px[1]! < 128 ? "red" : `rgb ${px[0]},${px[1]},${px[2]}`;
    };
    // controls: a quad clearly BEHIND must lose and one clearly in FRONT must
    // win, or the readings below mean nothing
    const behind = read(2 ** -6), front = read(-(2 ** -6));
    if (behind !== "red" || front !== "green") {
      return { bits: behind === "green" && front === "green" ? 0 : null, why: `controls: behind=${behind} front=${front}` };
    }
    const bits = highestResolved(8, 24, (k) => read(-(2 ** -k)) === "green");
    return bits >= 8 ? { bits } : { bits: null, why: "even a 2^-8 step did not resolve" };
  } catch (e) {
    // a diagnostic must never break startup
    return { bits: null, why: `threw: ${String((e as Error)?.message ?? e).slice(0, 80)}` };
  } finally {
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
  }
}
