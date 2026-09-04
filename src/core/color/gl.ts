/**
 * WebGL2 implementation of the colour controls. One fullscreen pass; the math mirrors the CPU
 * version in operations/adjust.ts so previews and thumbnails look identical whichever path runs.
 */
import { createCanvas, getCtx, type Canvas2D } from '../canvas';
import type { ColorValues } from '../operations/adjust';

const VERT = `#version 300 es
precision highp float;
const vec2 pos[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = pos[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uExposure, uBrightness, uContrast, uHighlights, uShadows, uFade;
uniform vec3 uMul;
uniform float uSat, uVib, uVignette, uGrain, uSharpen, uSeed;
uniform mat3 uHue;
uniform bool uUseHue;
in vec2 vUv;
out vec4 outColor;

float tone(float x) {
  x *= uExposure;
  x += uBrightness;
  x = (x - 0.5) * uContrast + 0.5;
  x = clamp(x, 0.0, 1.0);
  x += uShadows * x * (1.0 - x) * (1.0 - x);
  x += uHighlights * x * x * (1.0 - x);
  x = uFade + x * (1.0 - uFade);
  return clamp(x, 0.0, 1.0);
}

float hash(vec2 p) {
  return fract(sin(dot(p + uSeed, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 c = texture(uTex, vUv).rgb;
  if (uSharpen > 0.0) {
    vec3 n = texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uTex, vUv - vec2(uTexel.x, 0.0)).rgb
           + texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb + texture(uTex, vUv - vec2(0.0, uTexel.y)).rgb;
    c = c * (1.0 + 4.0 * uSharpen) - uSharpen * n;
  }
  c = vec3(tone(c.r), tone(c.g), tone(c.b));
  c = clamp(c * uMul, 0.0, 1.0);
  if (uSat != 0.0 || uVib != 0.0) {
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    float factor = 1.0 + uSat;
    if (uVib != 0.0) {
      float mx = max(c.r, max(c.g, c.b));
      float mn = min(c.r, min(c.g, c.b));
      float s = mx > 0.0 ? (mx - mn) / mx : 0.0;
      factor *= 1.0 + uVib * (1.0 - s);
    }
    c = luma + (c - luma) * factor;
  }
  if (uUseHue) c = uHue * c;
  if (uVignette > 0.0) {
    vec2 n = (vUv - 0.5) * 2.0;
    float d2 = dot(n, n);
    c *= 1.0 - uVignette * 0.9 * clamp((d2 - 0.3) / 1.2, 0.0, 1.0);
  }
  if (uGrain > 0.0) {
    c += (hash(floor(vUv / uTexel)) - 0.5) * uGrain;
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

interface GlState {
  canvas: Canvas2D;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

let state: GlState | null | undefined;

function init(): GlState | null {
  if (state !== undefined) return state;
  try {
    const canvas = createCanvas(4, 4);
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 unavailable');
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error');
    gl.useProgram(program);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const names = ['uTex', 'uTexel', 'uExposure', 'uBrightness', 'uContrast', 'uHighlights', 'uShadows', 'uFade', 'uMul', 'uSat', 'uVib', 'uVignette', 'uGrain', 'uSharpen', 'uSeed', 'uHue', 'uUseHue'];
    const uniforms: GlState['uniforms'] = {};
    for (const n of names) uniforms[n] = gl.getUniformLocation(program, n);
    gl.uniform1i(uniforms.uTex, 0);
    state = { canvas, gl, program, texture, uniforms };
  } catch (err) {
    console.warn('[color] WebGL path unavailable, using CPU', err);
    state = null;
  }
  return state;
}

export function hasGlColor(): boolean {
  return init() !== null;
}

function hueMatrix(deg: number): number[] {
  const a = (deg * Math.PI) / 180;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  // Column-major for GLSL mat3 (transpose of the row-major CPU matrix).
  return [
    0.213 + 0.787 * cs - 0.213 * sn, 0.213 - 0.213 * cs + 0.143 * sn, 0.213 - 0.213 * cs - 0.787 * sn,
    0.715 - 0.715 * cs - 0.715 * sn, 0.715 + 0.285 * cs + 0.14 * sn, 0.715 - 0.715 * cs + 0.715 * sn,
    0.072 - 0.072 * cs + 0.928 * sn, 0.072 - 0.072 * cs - 0.283 * sn, 0.072 + 0.928 * cs + 0.072 * sn,
  ];
}

/** Renders `source` with colour values applied into a fresh 2D canvas of the same size. Returns null if WebGL is unavailable. */
export function applyColorGl(source: Canvas2D, c: ColorValues, frameIndex: number): Canvas2D | null {
  const s = init();
  if (!s) return null;
  const { gl, canvas, uniforms: u } = s;
  const w = source.width;
  const h = source.height;
  if (w > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.bindTexture(gl.TEXTURE_2D, s.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);

  const t = c.temperature / 100;
  const tint = c.tint / 100;
  gl.uniform2f(u.uTexel, 1 / w, 1 / h);
  gl.uniform1f(u.uExposure, Math.pow(2, (c.exposure / 100) * 2));
  gl.uniform1f(u.uBrightness, (c.brightness / 100) * 0.3);
  gl.uniform1f(u.uContrast, Math.max(0.05, 1 + c.contrast / 100));
  gl.uniform1f(u.uHighlights, c.highlights / 100);
  gl.uniform1f(u.uShadows, c.shadows / 100);
  gl.uniform1f(u.uFade, (c.fade / 100) * 0.25);
  gl.uniform3f(u.uMul, (1 + t * 0.25) * (1 + tint * 0.08), 1 - tint * 0.2, (1 - t * 0.25) * (1 + tint * 0.08));
  gl.uniform1f(u.uSat, c.saturation / 100);
  gl.uniform1f(u.uVib, c.vibrance / 100);
  gl.uniform1f(u.uVignette, c.vignette / 100);
  gl.uniform1f(u.uGrain, ((c.grain / 100) * 48) / 255);
  gl.uniform1f(u.uSharpen, (c.sharpen / 100) * 0.7);
  gl.uniform1f(u.uSeed, (frameIndex % 1000) * 0.618);
  gl.uniform1i(u.uUseHue, c.hue !== 0 ? 1 : 0);
  gl.uniformMatrix3fv(u.uHue, false, hueMatrix(c.hue));
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const out = createCanvas(w, h);
  getCtx(out).drawImage(canvas, 0, 0);
  return out;
}
