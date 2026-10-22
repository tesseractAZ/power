/**
 * Golden value encoding. JSON cannot carry NaN, ±Infinity or undefined (JSON.stringify turns NaN
 * into null and drops undefined), and the parse-parity table (G3) depends on exactly those
 * distinctions: `Number('null')` is NaN while `Number('')` is 0, and an absent variable reads
 * as `undefined` where a cleared field reads as ''. Every golden value goes through `encode`
 * before it is written or compared, so the file and the live result are compared in one shape.
 */
export type Encoded = unknown;

export function encode(v: unknown): Encoded {
  if (v === undefined) return { $undef: true };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $nan: true };
    if (v === Infinity) return { $inf: 1 };
    if (v === -Infinity) return { $inf: -1 };
    return v;
  }
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (typeof v === 'function') return { $fn: v.name || 'anonymous' };
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Set) return { $set: [...v].map(encode) };
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [encode(k), encode(x)]) };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(encode);
  const out: Record<string, Encoded> = {};
  for (const k of Object.keys(v).sort()) out[k] = encode((v as Record<string, unknown>)[k]);
  return out;
}

/** Stable JSON text: sorted keys through `encode`, one element per line down to depth 3 so a golden
 *  diff names the hour or the key that moved, compact below that. */
export function goldenJson(v: unknown): string {
  return fmt(encode(v), 0) + '\n';
}

function fmt(v: unknown, depth: number): string {
  if (depth >= 3 || v === null || typeof v !== 'object') return JSON.stringify(v);
  const ind = (d: number) => ' '.repeat(d);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => ind(depth + 1) + fmt(x, depth + 1)).join(',\n')}\n${ind(depth)}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((k) => `${ind(depth + 1)}${JSON.stringify(k)}: ${fmt(o[k], depth + 1)}`).join(',\n')}\n${ind(depth)}}`;
}
