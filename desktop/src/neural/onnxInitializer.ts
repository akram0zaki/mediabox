/**
 * Minimal ONNX protobuf reader that extracts one initializer tensor (e.g. inswapper's `emap`
 * matrix) without loading the `onnx` library. Only the fields needed are decoded.
 */

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

interface Field {
  num: number;
  wire: number;
  start: number; // data start
  end: number; // data end (for length-delimited); for varint the value is in `value`
  value?: bigint;
}

function* fields(buf: Uint8Array, start: number, end: number): Generator<Field> {
  let pos = start;
  while (pos < end) {
    const [key, p1] = readVarint(buf, pos);
    const num = Number(key >> 3n);
    const wire = Number(key & 7n);
    pos = p1;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      yield { num, wire, start: pos, end: p2, value: v };
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      const s = p2;
      const e = s + Number(len);
      yield { num, wire, start: s, end: e };
      pos = e;
    } else if (wire === 1) {
      yield { num, wire, start: pos, end: pos + 8 };
      pos += 8;
    } else if (wire === 5) {
      yield { num, wire, start: pos, end: pos + 4 };
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

export interface Initializer {
  name: string;
  dims: number[];
  data: Float32Array;
}

/** Finds `name` among the model graph's initializers (ModelProto.graph = 7, GraphProto.initializer = 5). */
export function findInitializer(model: Uint8Array, name: string): Initializer | null {
  const dec = new TextDecoder();
  for (const f of fields(model, 0, model.length)) {
    if (f.num !== 7 || f.wire !== 2) continue;
    for (const g of fields(model, f.start, f.end)) {
      if (g.num !== 5 || g.wire !== 2) continue;
      // TensorProto: dims = 1, data_type = 2, float_data = 4, name = 8, raw_data = 9
      const dims: number[] = [];
      let tname = '';
      let raw: Uint8Array | null = null;
      let floats: Float32Array | null = null;
      for (const t of fields(model, g.start, g.end)) {
        if (t.num === 1 && t.wire === 0) dims.push(Number(t.value));
        else if (t.num === 8) tname = dec.decode(model.subarray(t.start, t.end));
        else if (t.num === 9) raw = model.subarray(t.start, t.end);
        else if (t.num === 4 && t.wire === 2) floats = new Float32Array(model.buffer.slice(model.byteOffset + t.start, model.byteOffset + t.end));
        else if (t.num === 4 && t.wire === 5) {
          // unpacked float — rare; ignore for brevity
        }
      }
      if (tname !== name) continue;
      if (raw) {
        const copy = new Uint8Array(raw.length);
        copy.set(raw);
        return { name, dims, data: new Float32Array(copy.buffer) };
      }
      if (floats) return { name, dims, data: floats };
      return null;
    }
  }
  return null;
}

/** Names and dims of every initializer (diagnostics). */
export function listInitializers(model: Uint8Array): { name: string; dims: number[]; bytes: number }[] {
  const dec = new TextDecoder();
  const out: { name: string; dims: number[]; bytes: number }[] = [];
  for (const f of fields(model, 0, model.length)) {
    if (f.num !== 7 || f.wire !== 2) continue;
    for (const g of fields(model, f.start, f.end)) {
      if (g.num !== 5 || g.wire !== 2) continue;
      const dims: number[] = [];
      let name = '';
      let bytes = 0;
      for (const t of fields(model, g.start, g.end)) {
        if (t.num === 1 && t.wire === 0) dims.push(Number(t.value));
        else if (t.num === 8) name = dec.decode(model.subarray(t.start, t.end));
        else if (t.num === 9 || t.num === 4) bytes = t.end - t.start;
      }
      out.push({ name, dims, bytes });
    }
  }
  return out;
}
