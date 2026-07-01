import { createHmac, randomInt } from 'node:crypto';

/**
 * EcoFlow IoT Open API signing.
 * Spec: flatten params (dot for nested objects, [i] for arrays), sort keys ASCII,
 * join as k=v&k=v, append &accessKey=..&nonce=..&timestamp=..,
 * HMAC-SHA256 with secretKey, hex (lowercase).
 */

type Primitive = string | number | boolean | null | undefined;
type AnyParams = Record<string, unknown>;

/**
 * Flatten params into key → primitive entries. The accumulator is a Map, NOT a
 * plain object: flattened key names derive from request params (device SNs,
 * quota keys) that can originate from HTTP input, so writing them onto a
 * `{}`-prototyped object is a prototype-pollution-shaped sink (CodeQL
 * js/remote-property-injection). A Map has no prototype chain to pollute.
 *
 * Byte-equivalence note (pinned by test/sign.test.ts): for every well-formed
 * input the produced key/value pairs — and therefore the signed string — are
 * identical to the previous plain-object accumulator; the ONLY divergence is a
 * hostile key spelled exactly "__proto__" with a primitive value, which the
 * old code silently DROPPED from the signature (the inherited __proto__ setter
 * swallowed the write) while it still appeared in the request body — i.e. a
 * guaranteed signature mismatch. The Map now signs it faithfully.
 */
function flatten(input: unknown, prefix = '', out = new Map<string, Primitive>()): Map<string, Primitive> {
  if (input === null || input === undefined) {
    if (prefix) out.set(prefix, '');
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
  out.set(prefix, input as Primitive);
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
  const flat: Map<string, Primitive> = opts.params ? flatten(opts.params) : new Map();
  // EcoFlow IoT Open API: business params sorted alphabetically, then literally
  // append &accessKey=X&nonce=Y&timestamp=Z (NOT sorted with the others).
  const sortedKeys = [...flat.keys()].sort();
  const paramStr = sortedKeys.map((k) => `${k}=${flat.get(k) ?? ''}`).join('&');
  const suffix = `accessKey=${opts.accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const toSign = paramStr ? `${paramStr}&${suffix}` : suffix;
  if (process.env.ECOFLOW_DEBUG_SIGN === '1') {
    // JSON.stringify so param-derived newlines can't forge extra log lines
    // (CodeQL js/log-injection).
    console.error('[sign] toSign =', JSON.stringify(toSign));
  }
  const sign = createHmac('sha256', opts.secretKey).update(toSign).digest('hex');
  return { accessKey: opts.accessKey, nonce, timestamp, sign };
}

/** Build a sorted query string for GET requests (matches what was signed). */
export function buildQuery(params?: AnyParams): string {
  if (!params) return '';
  const flat = flatten(params);
  const sortedKeys = [...flat.keys()].sort();
  if (!sortedKeys.length) return '';
  return (
    '?' +
    sortedKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(flat.get(k) ?? ''))}`)
      .join('&')
  );
}
