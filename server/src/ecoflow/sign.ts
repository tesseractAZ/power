import { createHmac, randomInt } from 'node:crypto';

/**
 * EcoFlow IoT Open API signing.
 * Spec: flatten params (dot for nested objects, [i] for arrays), sort keys ASCII,
 * join as k=v&k=v, append &accessKey=..&nonce=..&timestamp=..,
 * HMAC-SHA256 with secretKey, hex (lowercase).
 */

type Primitive = string | number | boolean | null | undefined;
type AnyParams = Record<string, unknown>;

function flatten(input: unknown, prefix = '', out: Record<string, Primitive> = {}): Record<string, Primitive> {
  if (input === null || input === undefined) {
    if (prefix) out[prefix] = '';
    return out;
  }
  if (Array.isArray(input)) {
    input.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as AnyParams)) {
      const key = prefix ? `${prefix}.${k}` : k;
      flatten(v, key, out);
    }
    return out;
  }
  out[prefix] = input as Primitive;
  return out;
}

export interface SignedHeaders {
  accessKey: string;
  nonce: string;
  timestamp: string;
  sign: string;
}

export function signRequest(opts: {
  accessKey: string;
  secretKey: string;
  params?: AnyParams;
}): SignedHeaders {
  const nonce = String(randomInt(100000, 999999));
  const timestamp = String(Date.now());
  const flat: Record<string, Primitive> = opts.params ? flatten(opts.params) : {};
  // EcoFlow IoT Open API: business params sorted alphabetically, then literally
  // append &accessKey=X&nonce=Y&timestamp=Z (NOT sorted with the others).
  const sortedKeys = Object.keys(flat).sort();
  const paramStr = sortedKeys.map((k) => `${k}=${flat[k] ?? ''}`).join('&');
  const suffix = `accessKey=${opts.accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const toSign = paramStr ? `${paramStr}&${suffix}` : suffix;
  if (process.env.ECOFLOW_DEBUG_SIGN === '1') {
    console.error('[sign] toSign =', toSign);
  }
  const sign = createHmac('sha256', opts.secretKey).update(toSign).digest('hex');
  return { accessKey: opts.accessKey, nonce, timestamp, sign };
}

/** Build a sorted query string for GET requests (matches what was signed). */
export function buildQuery(params?: AnyParams): string {
  if (!params) return '';
  const flat = flatten(params);
  const sortedKeys = Object.keys(flat).sort();
  if (!sortedKeys.length) return '';
  return (
    '?' +
    sortedKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(flat[k] ?? ''))}`)
      .join('&')
  );
}
