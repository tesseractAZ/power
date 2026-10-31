import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAINT_CHOICES_MIN, MAINT_DEFAULT_MS, MAINT_MAX_MS, MAINT_MIN_MS, MAINT_NOTE_MAX, MAINT_RETURN_DWELL_MS, STILL_SOUNDS,
} from '../src/maintenanceWindow.js';

/**
 * v1.197.0 (review) — pin the Core card's maintenance control (web/src/components/MaintenanceControl.tsx)
 * to the server's contract (maintenanceWindow.ts).
 *
 * `web` and `server` share no types, and the card keeps its own copies: the durations it offers, the
 * default, the note's length and the "still sounds" list the start push also carries. A comment
 * ("Mirrors the server's STILL_SOUNDS") is not a mechanism: change MAINT_MAX_MS or STILL_SOUNDS on
 * the server alone and both packages typecheck while the card offers a length the server refuses
 * (400) and lists what still sounds differently from the push. This reads the web source and
 * compares the literals, as alarmLevelWebMirror does.
 */

const WEB_SRC = resolve(import.meta.dirname, '../../web/src/components/MaintenanceControl.tsx');

function block(src: string, decl: string, end: string): string {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `MaintenanceControl.tsx no longer declares ${decl} — update this test with the rename`);
  return src.slice(i, src.indexOf(end, i));
}

test('★★ the card offers exactly the server\'s durations, its default, and nothing outside the limits', () => {
  const src = readFileSync(WEB_SRC, 'utf8');
  const choices = [...block(src, 'const CHOICES', '];').matchAll(/minutes: (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(choices, [...MAINT_CHOICES_MIN], 'CHOICES = MAINT_CHOICES_MIN');
  for (const m of choices) assert.ok(m * 60_000 >= MAINT_MIN_MS && m * 60_000 <= MAINT_MAX_MS, `${m} min is within the server's limits`);
  const def = /const DEFAULT_MINUTES = (\d+);/.exec(src);
  assert.ok(def, 'DEFAULT_MINUTES');
  assert.equal(Number(def[1]) * 60_000, MAINT_DEFAULT_MS);
  assert.ok(choices.includes(Number(def[1])), 'the default is one of the choices');
});

test('★★ the card\'s "still sounds" list is the server\'s STILL_SOUNDS, word for word', () => {
  const src = readFileSync(WEB_SRC, 'utf8');
  const body = block(src, 'const STILL_SOUNDS', '];');
  const web = [...body.matchAll(/^\s+(['"])(.*)\1,$/gm)].map((m) => m[2]);
  assert.deepEqual(web, [...STILL_SOUNDS]);
});

test('the note limit and the return-to-normal wording match the server', () => {
  const src = readFileSync(WEB_SRC, 'utf8');
  assert.ok(src.includes(`maxLength={${MAINT_NOTE_MAX}}`), `the note input is capped at ${MAINT_NOTE_MAX} characters`);
  assert.ok(src.includes(`back to normal for ${MAINT_RETURN_DWELL_MS / 60_000} minutes`), 'the dwell the card describes');
});
