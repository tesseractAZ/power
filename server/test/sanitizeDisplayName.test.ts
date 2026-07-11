/**
 * v1.7.0 (security #2, CWE-150) — sanitizeDisplayName regression tests.
 *
 * A device name (EcoFlow app) or SHP2 breaker-circuit name is cloud/MQTT
 * sourced and flows into the telnet/console ANSI render stream + the JSON
 * snapshot. Without stripping, a name like "Kitchen\x1b]0;pwned\x07" would let
 * whoever can set it inject terminal escape sequences (OSC title-set, OSC 52
 * clipboard-write, cursor moves, screen clears) that EXECUTE in the operator's
 * terminal the moment they open the TUI. These tests lock down that the ESC/
 * BEL/C1 bytes that ARM such sequences are removed, while ordinary names
 * (including non-ASCII) survive intact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDisplayName } from '../src/logSanitize.js';

// C0 controls (0x00-0x1f), DEL (0x7f), and C1 controls (0x80-0x9f).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

test('sanitizeDisplayName — plain names pass through (trimmed), non-ASCII kept', () => {
  assert.equal(sanitizeDisplayName('Kitchen'), 'Kitchen');
  assert.equal(sanitizeDisplayName('  Living Room  '), 'Living Room');
  // Printable non-ASCII (U+00B7 middle dot, U+00E9 e-acute) are ABOVE the C1
  // block (0x9f) and must be preserved — they're legitimate in circuit names.
  assert.equal(sanitizeDisplayName('Core 5 · Café'), 'Core 5 · Café');
});

test('sanitizeDisplayName — strips the ESC that arms an OSC title-set injection', () => {
  // ESC ] 0 ; pwned BEL Kitchen → the ESC (0x1b) and BEL (0x07) are removed,
  // so the residual "]0;pwned" is inert text and can never open an OSC.
  const out = sanitizeDisplayName('\x1b]0;pwned\x07Kitchen');
  assert.ok(!out.includes('\x1b'), 'ESC must be stripped');
  assert.ok(!CONTROL_RE.test(out), 'no control chars may remain');
  assert.equal(out, ']0;pwned Kitchen');
});

test('sanitizeDisplayName — strips CSI (clear-screen), OSC 52 clipboard, and 8-bit C1 CSI', () => {
  // ESC [ 2 J (clear screen) — ESC stripped.
  assert.ok(!sanitizeDisplayName('\x1b[2JGarage').includes('\x1b'));
  // ESC ] 52 ; c ; <b64> BEL (OSC 52 clipboard write) — ESC + BEL stripped.
  const osc52 = sanitizeDisplayName('\x1b]52;c;ZWNobw==\x07Den');
  assert.ok(!CONTROL_RE.test(osc52));
  assert.match(osc52, /Den$/);
  // 0x9b is the 8-bit CSI some terminals honor — it lives in the C1 block and
  // must also go, else a name could inject CSI without a leading ESC.
  assert.ok(!CONTROL_RE.test(sanitizeDisplayName('\u009b2KBedroom')));
});

test('sanitizeDisplayName — newline/CR can never forge a TUI row or log line', () => {
  const out = sanitizeDisplayName('Garage\r\nALARM: grid down');
  assert.ok(!out.includes('\n') && !out.includes('\r'), 'CR/LF must be collapsed');
  assert.equal(out, 'Garage ALARM: grid down');
});

test('sanitizeDisplayName — runs of controls collapse to a SINGLE space', () => {
  assert.equal(sanitizeDisplayName('A\x00\x01\x02B'), 'A B');
});

test('sanitizeDisplayName — non-string / empty / all-control inputs yield the fallback', () => {
  assert.equal(sanitizeDisplayName(undefined, 64, 'SN123'), 'SN123');
  assert.equal(sanitizeDisplayName(null, 64, 'SN123'), 'SN123');
  assert.equal(sanitizeDisplayName(42, 64, 'SN123'), 'SN123');
  assert.equal(sanitizeDisplayName({}, 64, 'SN123'), 'SN123');
  assert.equal(sanitizeDisplayName('', 64, 'SN123'), 'SN123');
  assert.equal(sanitizeDisplayName('   ', 64, 'SN123'), 'SN123'); // whitespace-only trims to ''
  assert.equal(sanitizeDisplayName('\x1b\x1b\x07', 64, 'SN123'), 'SN123'); // all control
  // Default fallback is the empty string.
  assert.equal(sanitizeDisplayName(undefined), '');
});

test('sanitizeDisplayName — clamps length AFTER control-collapse + trim', () => {
  assert.equal(sanitizeDisplayName('A'.repeat(100), 48), 'A'.repeat(48));
  assert.equal(sanitizeDisplayName('x'.repeat(60), 10), 'x'.repeat(10));
  // Default max is 64.
  assert.equal(sanitizeDisplayName('B'.repeat(80)).length, 64);
});
