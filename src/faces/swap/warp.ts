/**
 * WebGL2 mesh warp: draws a source face texture onto a target face mesh, triangle by triangle,
 * with a per-channel colour gain so the swapped face matches the target's lighting.
 */
import { createCanvas, getCtx, type Canvas2D } from '../../core/canvas';
import { meshTriangles, type Mesh } from '../landmarker';

const VERT = `#version 300 es
precision highp float;
in vec2 aPos;
in vec2 aUv;
uniform vec4 uRegion; // x, y, w, h of the output region in frame pixels
out vec2 vUv;
void main() {
  vec2 p = (aPos - uRegion.xy) / uRegion.zw;   // 0..1 within region
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  vUv = aUv;
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec3 uGain;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb * uGain;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

interface State {
  canvas: Canvas2D;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uRegion: WebGLUniformLocation | null;
  uGain: WebGLUniformLocation | null;
  textures: Map<string, WebGLTexture>;
  indexCount: number;
}

let state: State | null | undefined;

function init(): State | null {
  if (state !== undefined) return state;
  try {
    const canvas = createCanvas(4, 4);
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: true }) as WebGL2RenderingContext | null;
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

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    const aUv = gl.getAttribLocation(program, 'aUv');
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    const tris = meshTriangles();
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tris, gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);

    state = {
      canvas, gl, program, posBuf, uvBuf, idxBuf, vao,
      uRegion: gl.getUniformLocation(program, 'uRegion'),
      uGain: gl.getUniformLocation(program, 'uGain'),
      textures: new Map(),
      indexCount: tris.length,
    };
  } catch (err) {
    console.warn('[swap] WebGL warp unavailable', err);
    state = null;
  }
  return state;
}

export function hasMeshWarp(): boolean {
  return init() !== null;
}

function textureFor(s: State, id: string, image: ImageBitmap): WebGLTexture {
  let tex = s.textures.get(id);
  if (tex) return tex;
  const { gl } = s;
  tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  s.textures.set(id, tex);
  return tex;
}

export interface WarpInput {
  sourceId: string;
  source: ImageBitmap;
  /** Source mesh in source-image pixels. */
  sourceMesh: Mesh;
  /** Target mesh in frame pixels. */
  targetMesh: Mesh;
  /** Output region in frame pixels. */
  region: { x: number; y: number; w: number; h: number };
  /** Per-channel colour gain (1 = unchanged). */
  gain?: [number, number, number];
}

/** Renders the warped source face into a canvas the size of `region`. Returns null without WebGL. */
export function warpFace(input: WarpInput): Canvas2D | null {
  const s = init();
  if (!s) return null;
  const { gl, canvas } = s;
  const w = Math.max(1, Math.round(input.region.w));
  const h = Math.max(1, Math.round(input.region.h));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(s.program);
  gl.bindVertexArray(s.vao);

  const uv = new Float32Array(input.sourceMesh.length);
  for (let i = 0; i < input.sourceMesh.length; i += 2) {
    uv[i] = input.sourceMesh[i] / input.source.width;
    uv[i + 1] = input.sourceMesh[i + 1] / input.source.height;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, input.targetMesh, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
  gl.uniform4f(s.uRegion, input.region.x, input.region.y, input.region.w, input.region.h);
  const g = input.gain ?? [1, 1, 1];
  gl.uniform3f(s.uGain, g[0], g[1], g[2]);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textureFor(s, input.sourceId, input.source));
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.idxBuf);
  gl.drawElements(gl.TRIANGLES, s.indexCount, gl.UNSIGNED_SHORT, 0);

  const out = createCanvas(w, h);
  getCtx(out).drawImage(canvas, 0, 0);
  return out;
}
