import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { signRequest, buildQuery } from '../src/ecoflow/sign.js';

/**
 * sign.ts characterization + injection-hardening tests.
 *
 * ★★ The signing string (`toSign`) signs EVERY EcoFlow cloud API call — any
 * byte of drift breaks all polling. The tests below pin the EXACT bytes for a
 * representative nested fixture (objects → dots, arrays → [i], null → empty,
 * ASCII key sort, &accessKey/&nonce/&timestamp suffix) so the accumulator can
 * be refactored (plain object → Map, for CodeQL js/remote-property-injection)
 * with proof of byte-identical output. nonce/timestamp are generated inside
 * signRequest, so we reconstruct the expected toSign from the returned header
 * fields and compare HMACs — equal HMACs ⇒ byte-identical toSign.
 */

const ACCESS = 'ak_fixture';
const SECRET = 'sk_fixture';

/** Nested fixture in deliberately unsorted key order. */
const FIXTURE = {
  z: null,
  a: { b: 1 },
  arr: [1, 2],
  flag: true,
  s: 'x-1',
  n: 0,
  deep: { c: { d: 'v' } },
  objArr: [{ k: 'a' }, { k: 'b' }],
};

/** The pinned flatten+sort result for FIXTURE (ASCII key sort, null → ''). */
const EXPECTED_PARAM_STR =
  'a.b=1&arr[0]=1&arr[1]=2&deep.c.d=v&flag=true&n=0&objArr[0].k=a&objArr[1].k=b&s=x-1&z=';

function expectedSign(paramStr: string, nonce: string, timestamp: string): string {
  const suffix = `accessKey=${ACCESS}&nonce=${nonce}&timestamp=${timestamp}`;
  const toSign = paramStr ? `${paramStr}&${suffix}` : suffix;
  return createHmac('sha256', SECRET).update(toSign).digest('hex');
}

test('signRequest — toSign is byte-identical to the pinned characterization string', () => {
  const h = signRequest({ accessKey: ACCESS, secretKey: SECRET, params: FIXTURE });
  assert.equal(h.accessKey, ACCESS);
  assert.match(h.nonce, /^\d{6}$/);
  assert.match(h.timestamp, /^\d+$/);
  assert.equal(h.sign, expectedSign(EXPECTED_PARAM_STR, h.nonce, h.timestamp));
});

test('signRequest — no params → suffix-only toSign', () => {
  const h = signRequest({ accessKey: ACCESS, secretKey: SECRET });
  assert.equal(h.sign, expectedSign('', h.nonce, h.timestamp));
});

test('signRequest — empty params object → suffix-only toSign', () => {
  const h = signRequest({ accessKey: ACCESS, secretKey: SECRET, params: {} });
  assert.equal(h.sign, expectedSign('', h.nonce, h.timestamp));
});

test('signRequest — undefined leaf flattens to empty value like null', () => {
  const h = signRequest({ accessKey: ACCESS, secretKey: SECRET, params: { sn: 'DEV1', u: undefined } });
  assert.equal(h.sign, expectedSign('sn=DEV1&u=', h.nonce, h.timestamp));
});

test('buildQuery — byte-exact sorted, URL-encoded query for the same fixture', () => {
  assert.equal(
    buildQuery(FIXTURE),
    '?a.b=1&arr%5B0%5D=1&arr%5B1%5D=2&deep.c.d=v&flag=true&n=0&objArr%5B0%5D.k=a&objArr%5B1%5D.k=b&s=x-1&z=',
  );
  assert.equal(buildQuery(), '');
  assert.equal(buildQuery({}), '');
});

test('flatten accumulator — hostile __proto__/constructor keys cannot pollute Object.prototype', () => {
  // JSON.parse creates OWN "__proto__"/"constructor" data properties (unlike an
  // object literal), which is exactly what a hostile HTTP payload would yield.
  const hostile = JSON.parse(
    '{"sn":"DEV1","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"alsoPolluted":1}},'
    + '"nested":{"__proto__":{"deepPolluted":true}}}',
  ) as Record<string, unknown>;
  const h = signRequest({ accessKey: ACCESS, secretKey: SECRET, params: hostile });
  assert.match(h.sign, /^[a-f0-9]{64}$/);
  const probe = {} as Record<string, unknown>;
  assert.equal(probe.polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(probe.alsoPolluted, undefined);
  assert.equal(probe.deepPolluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  // buildQuery shares the same flatten path.
  buildQuery(hostile);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('flatten accumulator — inherited-name keys (hasOwnProperty/toString) are signed normally', () => {
  const params = JSON.parse('{"hasOwnProperty":"a","toString":"b"}') as Record<string, unknown>;
  const h = signRequest({ accessKey: ACCESS, secretKey: SECRET, params });
  assert.equal(h.sign, expectedSign('hasOwnProperty=a&toString=b', h.nonce, h.timestamp));
});
