import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { poolOutDelivery, POOL_OUT_PUSH_IN_QUIET_HOURS } from '../src/poolOut.js';

/**
 * v1.208.0 — the delivery policy of the pool-out alarm, in ONE pure function with one constant.
 *
 * Under the shipped options an alarm raised at 23:46 would be one digest line at 07:00, with no detail and no codes.
 * As decided for this release it is pushed at once at any hour, the detail as the push body, and it is spoken as every
 * alarm is spoken today: a critical, outside quiet hours.
 *
 * `pushNow` is read (alerts.ts stamps the alert's flag from it). `speak` is read by NOTHING: speech is the broadcast's,
 * by its own two gates, and `speak` states what those gates give under the shipped options. The last test pins that
 * statement to the gates and the options it restates, so a change to either fails here.
 */

test('★ build default: pushed at once at any hour, a warning as well as a critical', () => {
  assert.equal(POOL_OUT_PUSH_IN_QUIET_HOURS, true);
  assert.equal(poolOutDelivery('warning', true).pushNow, true, 'a warning at night');
  assert.equal(poolOutDelivery('critical', true).pushNow, true, 'a critical at night');
  assert.equal(poolOutDelivery('warning', false).pushNow, true, 'a warning by day');
  assert.equal(poolOutDelivery('critical', false).pushNow, true, 'a critical by day');
});

test('★ spoken as every alarm is today: a critical, outside quiet hours — and nothing else', () => {
  assert.equal(poolOutDelivery('critical', false).speak, true);
  assert.equal(poolOutDelivery('critical', true).speak, false, 'never spoken in quiet hours');
  assert.equal(poolOutDelivery('warning', false).speak, false, 'a warning is pushed, not spoken');
  assert.equal(poolOutDelivery('warning', true).speak, false);
});

test('the whole table', () => {
  assert.deepEqual(
    (['warning', 'critical'] as const).flatMap((severity) => [false, true].map((quiet) => ({ severity, quiet, ...poolOutDelivery(severity, quiet) }))),
    [
      { severity: 'warning', quiet: false, pushNow: true, speak: false },
      { severity: 'warning', quiet: true, pushNow: true, speak: false },
      { severity: 'critical', quiet: false, pushNow: true, speak: true },
      { severity: 'critical', quiet: true, pushNow: true, speak: false },
    ],
  );
});

test('★★ `speak` is read by nothing: it states what the broadcast\'s own gates give under the shipped options, and is pinned to both', () => {
  const src = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
  // The shipped options (ecoflow_panel/config.yaml, the `options:` block).
  const yaml = readFileSync(new URL('../../ecoflow_panel/config.yaml', import.meta.url), 'utf8');
  const options = yaml.slice(yaml.indexOf('\noptions:\n'), yaml.indexOf('\nschema:\n'));
  assert.ok(options.length > 500, 'control: the options block was found');
  const shipped = (key: string): string => (new RegExp(`\\n  ${key}: "?([^"\\n]*)"?\\n`).exec(options) ?? [])[1];
  assert.deepEqual([shipped('BROADCAST_MIN_SEVERITY'), shipped('BROADCAST_QUIET_HOURS'), shipped('CRITICAL_BREAKS_QUIET_HOURS')], ['critical', '22-06', 'false']);
  // The broadcast's two gates, as written: a yellow (a warning) is not spoken below the minimum severity, and nothing
  // is spoken in its quiet hours unless criticals are set to break through.
  const broadcast = src('broadcast.ts');
  assert.equal(broadcast.includes("    if (level === 'yellow' && cfg.minSeverity === 'critical') return;"), true);
  assert.equal(broadcast.includes("    if (inQuiet() && !(level === 'red' && cfg.criticalBreakThrough)) {"), true);
  // What those gates give under those options, for each severity and hour: exactly `speak`.
  const minSeverity = shipped('BROADCAST_MIN_SEVERITY');
  const breaks = shipped('CRITICAL_BREAKS_QUIET_HOURS') === 'true';
  const gates = (severity: 'warning' | 'critical', quiet: boolean): boolean =>
    !(severity === 'warning' && minSeverity === 'critical') && !(quiet && !(severity === 'critical' && breaks));
  for (const severity of ['warning', 'critical'] as const) {
    for (const quiet of [false, true]) assert.equal(poolOutDelivery(severity, quiet).speak, gates(severity, quiet), `${severity}, quiet ${quiet}`);
  }
  // And no source file reads it: the one caller of the function takes `pushNow`.
  const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  const callers = files.filter((f) => f !== 'poolOut.ts' && src(f).includes('poolOutDelivery('));
  assert.deepEqual(callers, ['alerts.ts']);
  assert.equal(src('alerts.ts').split('poolOutDelivery(').length - 1, 1);
  assert.equal(src('alerts.ts').includes('...(poolOutDelivery(parts.severity, true).pushNow ? { pushInQuietHours: true } : {}),'), true);
  assert.deepEqual(files.filter((f) => /poolOutDelivery\([^)]*\)\.speak/.test(src(f))), []);
});
