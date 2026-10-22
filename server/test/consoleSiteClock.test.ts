import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { consoleClocks, type ConsoleClocks } from './helpers/consoleClockProbe.js';

/**
 * v1.191.1 — THE ALARM AND BUS SCREENS' LIVENESS CLOCKS ARE ON THE SITE CLOCK.
 *
 * The ALARM LIST and MAIN BUS dividers of the Plant console (SSH and the browser /console, one
 * renderer) printed `new Date(…).toTimeString().slice(0, 8)`: the host's clock. v1.191.0 moved the
 * console's other stamps (the alarm rows, the annunciator banner, the CONSOLE header) to the site
 * zone, so wherever the site zone is not the host's the two dividers disagreed with those stamps
 * (the BUS screen has no timed rows of its own): SITE_TIMEZONE=America/New_York on a Phoenix host
 * read three hours behind, and a UTC host with the default Phoenix site seven hours ahead.
 * Identical where the site zone is the host's.
 *
 * The probe also reads the console's other clocks off the screens they are drawn on: the alarm
 * rows (ALARM), the alarm banner and the status header (CONSOLE). The site zone is resolved once
 * at load, so the split cases run in child processes (helpers/consoleClockProbe.ts); the
 * in-process case is judged on the runner's own zones.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const PROBE = resolve(HERE, 'helpers/consoleClockProbe.ts');

function probe(env: Record<string, string>): Promise<ConsoleClocks> {
  return new Promise((res, rej) => {
    // The listed alarm's onset is looked up in a sidecar that does not exist: its row carries the snapshot's time.
    const noOnsets = resolve(tmpdir(), 'consoleClockProbe-no-such-dir', 'alert-onset.json');
    const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE ?? '', ALERT_ONSET_PATH: noOnsets, ...env };
    execFile(process.execPath, ['--import', 'tsx', PROBE], { cwd: SERVER, env: childEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return rej(new Error(`probe failed: ${err.message}\n${stderr}`));
      try { res(JSON.parse(stdout) as ConsoleClocks); } catch (e) { rej(new Error(`probe wrote non-JSON: ${(e as Error).message}\n${stdout.slice(0, 400)}`)); }
    });
  });
}

const runs = {
  // SITE_TIMEZONE set to another zone than the container's: the site is three hours ahead.
  nyOnPhoenixHost: probe({ TZ: 'America/Phoenix', SITE_TIMEZONE: 'America/New_York' }),
  // A UTC host with a Phoenix site (CI's shape, and a container without TZ on the default zone).
  phoenixOnUtcHost: probe({ TZ: 'UTC', SITE_TIMEZONE: 'America/Phoenix' }),
  // The reference install: TZ America/Phoenix, SITE_TIMEZONE unset.
  reference: probe({ TZ: 'America/Phoenix' }),
};

test('★★ the ALARM LIST and MAIN BUS dividers read the site clock, not the host\'s (New York site, Phoenix host)', async () => {
  const r = await runs.nyOnPhoenixHost;
  assert.equal(r.zone, 'America/New_York');
  assert.equal(r.hostZone, 'America/Phoenix');
  assert.equal(r.siteHms, '14:30:15');
  assert.equal(r.alm, '14:30:15', 'ALARM LIST: the site\'s 14:30:15, not the host\'s 11:30:15');
  assert.equal(r.bus, '14:30:15', 'MAIN BUS: the site\'s 14:30:15, not the host\'s 11:30:15');
});

test('★★ … and with a UTC host and a Phoenix site', async () => {
  const r = await runs.phoenixOnUtcHost;
  assert.equal(r.zone, 'America/Phoenix');
  assert.equal(r.hostZone, 'UTC');
  assert.equal(r.alm, '11:30:15', 'ALARM LIST: the site\'s 11:30:15, not the host\'s 18:30:15');
  assert.equal(r.bus, '11:30:15', 'MAIN BUS: the site\'s 11:30:15, not the host\'s 18:30:15');
});

test('the reference install reads 11:30:15 on both screens, as before', async () => {
  const r = await runs.reference;
  assert.equal(r.zone, 'America/Phoenix');
  assert.deepEqual([r.siteHms, r.alm, r.bus], ['11:30:15', '11:30:15', '11:30:15']);
});

test('★★ the alarm rows, the alarm banner and the status header read the site clock (New York site, Phoenix host)', async () => {
  const r = await runs.nyOnPhoenixHost;
  assert.equal(r.almRow, '2026-10-22 14:30:15', 'ALARM row: the site\'s 14:30:15, not the host\'s 11:30:15');
  assert.equal(r.banner, '14:30:15', 'CONSOLE alarm banner: the site\'s 14:30:15');
  assert.equal(r.header, '2026-10-22 14:30', 'CONSOLE status header: the site\'s 14:30');
});

test('★★ … and with a UTC host and a Phoenix site; the reference install reads the same', async () => {
  for (const r of [await runs.phoenixOnUtcHost, await runs.reference]) {
    assert.equal(r.almRow, '2026-10-22 11:30:15', `ALARM row (host ${r.hostZone}): not the UTC host's 18:30:15`);
    assert.equal(r.banner, '11:30:15', `CONSOLE alarm banner (host ${r.hostZone})`);
    assert.equal(r.header, '2026-10-22 11:30', `CONSOLE status header (host ${r.hostZone})`);
  }
});

test('in this process: every console clock carries the site clock', () => {
  const r = consoleClocks();
  assert.ok(r.alm != null && r.bus != null, 'both dividers carry a clock');
  assert.equal(r.alm, r.siteHms, `ALARM LIST (site ${r.zone}, host ${r.hostZone})`);
  assert.equal(r.bus, r.siteHms, `MAIN BUS (site ${r.zone}, host ${r.hostZone})`);
  assert.equal(r.almRow, r.siteStampS, `ALARM row (site ${r.zone}, host ${r.hostZone})`);
  assert.equal(r.banner, r.siteHms, `CONSOLE alarm banner (site ${r.zone}, host ${r.hostZone})`);
  assert.equal(r.header, r.siteStamp, `CONSOLE status header (site ${r.zone}, host ${r.hostZone})`);
});

/** The Date methods that format or read a time on the host's clock, or set one in the host's zone. */
const HOST_CLOCK_METHODS = new Set([
  'toLocaleString', 'toLocaleTimeString', 'toLocaleDateString', 'toTimeString', 'toDateString',
  'getFullYear', 'getYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
  'setFullYear', 'setYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds',
  'getTimezoneOffset',
]);

/**
 * Every host-clock date helper `src` calls, as "line: call". The scan reads the parsed source, not
 * its lines: a call written across lines, or nested at any depth inside another call's arguments,
 * is one call, and a comment or a string that names one is not a call. Matched: a call of a
 * HOST_CLOCK_METHODS method (a get… field only with no argument, as a Date's has none), any
 * Intl.DateTimeFormat, and a Date built from local fields: `new Date(…)` with two or more
 * arguments or a spread (a trailing comma after one argument is not a second). The getUTC… fields,
 * Date.UTC and new Date(ms) read no zone and are not matched.
 */
function hostClockCalls(src: string): string[] {
  const sf = ts.createSourceFile('scan.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
  const nameOf = (e: ts.Expression): string | null => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return u.text;
    if (ts.isPropertyAccessExpression(u)) return u.name.text;
    if (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression)) return u.argumentExpression.text;
    return null;
  };
  const member = (e: ts.Expression): ts.PropertyAccessExpression | ts.ElementAccessExpression | null => {
    const u = unwrap(e);
    return ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u) ? u : null;
  };
  const isIntlDateTimeFormat = (e: ts.Expression): boolean => {
    const m = member(e);
    return m != null && nameOf(m) === 'DateTimeFormat' && nameOf(m.expression) === 'Intl';
  };
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    let hit = false;
    if (ts.isCallExpression(n)) {
      const m = member(n.expression);
      const name = m == null ? null : nameOf(m);
      hit = isIntlDateTimeFormat(n.expression)
        || (name != null && HOST_CLOCK_METHODS.has(name) && (!name.startsWith('get') || n.arguments.length === 0));
    } else if (ts.isNewExpression(n)) {
      const args = n.arguments ?? [];
      hit = isIntlDateTimeFormat(n.expression)
        || (nameOf(n.expression) === 'Date' && (args.length >= 2 || args.some(ts.isSpreadElement)));
    }
    if (hit) hits.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf).replace(/\s+/g, ' ')}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

test('no console source calls a host-clock date helper', () => {
  // siteTime.ts is the console's only clock formatter. Any of these in src/telnet formats or reads a
  // time on the host's clock (or the host's zone), with or without a locale and options: the
  // toLocale*/toTime/toDate string forms, Intl.DateTimeFormat, the local get*/set* fields, the
  // host's UTC offset, and a Date built from local fields (new Date(y, m, …), read in the host's
  // zone), on one line or across several and at any nesting depth (hostClockCalls parses the file).
  // The scan itself catches the forms it names (a scan that matches nothing passes every tree).
  for (const bad of [
    "new Date(t).toTimeString().slice(0, 8)", "new Date(t).toLocaleTimeString('en-US', { hour12: false })",
    "new Date().toLocaleString([], { hour12: false })", "d.toLocaleDateString()", "d.toDateString()", "new Intl.DateTimeFormat('en-US', { hour: 'numeric' })",
    "Intl.DateTimeFormat().resolvedOptions().timeZone",
    "d.getHours()", "d.getFullYear()", "d.getDay()", "d.getMilliseconds()", "d.setHours(0, 0, 0, 0)", "d.setDate(1)", "d.getTimezoneOffset()",
    "d\n  .getHours()", "d?.getHours()", "d['getHours']()", "(d).getMinutes()",
    "new Date(y, m, d)", "new Date(2026, 9, 22, 0, 0, 0)", "new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())",
    "new Date(Number(s.slice(0, 4)), 0, 1)", "new Date(...parts)",
    // Three calls deep in the first argument, and the arguments on lines of their own.
    "new Date(Number(s.slice(0, s.indexOf('-'))), 0, 1)",
    "void new Date(\n    2026, 9, 22,\n  );",
    "new Date(\n  now.getUTCFullYear(),\n  now.getUTCMonth(),\n  now.getUTCDate(),\n)",
  ]) assert.ok(hostClockCalls(bad).length > 0, `the scan catches ${JSON.stringify(bad)}`);
  for (const ok of [
    'fmtSiteHms(ms)', 'fmtSiteStamp(ms, true)', 'new Date(ms).getUTCSeconds()', 'Date.now()', 'new Date(ms).toISOString()',
    'new Date(Date.UTC(2026, 9, 22))', 'new Date(Math.max(a, b))', 'new Date(Math.max(f(a), g(b)))', 'new Date(data.snap.generatedAt ?? Date.now())',
    'new Date(\n  ms,\n)', "new Date(s + ',')", 'new Date()', 'cache.getDate(key)',
    "// was new Date(t).toTimeString(), then new Date(y, m, d)\nconst label = 'd.getHours()';",
  ]) {
    assert.deepEqual(hostClockCalls(ok), [], `the scan passes ${JSON.stringify(ok)}`);
  }
  // A hit names the line its call starts on.
  assert.deepEqual(hostClockCalls('const a = 1;\nvoid new Date(\n  2026, 9, 22,\n);'), ['2: new Date( 2026, 9, 22, )']);
  const telnet = resolve(SERVER, 'src/telnet');
  const files = readdirSync(telnet, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  assert.ok(files.includes('plant/alm.ts') || files.includes('plant\\alm.ts'), 'the walk reaches the plant screens');
  for (const f of files) {
    const hits = hostClockCalls(readFileSync(resolve(telnet, f), 'utf8'));
    assert.deepEqual(hits, [], `${f} uses a host-clock date helper (line: call); format with siteTime.ts`);
  }
});
