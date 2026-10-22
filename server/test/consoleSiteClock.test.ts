import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleClocks, type ConsoleClocks } from './helpers/consoleClockProbe.js';

/**
 * v1.191.1 — THE ALARM AND BUS SCREENS' LIVENESS CLOCKS ARE ON THE SITE CLOCK.
 *
 * The ALARM LIST and MAIN BUS dividers of the Plant console (SSH and the browser /console, one
 * renderer) printed `new Date(…).toTimeString().slice(0, 8)`: the host's clock. v1.191.0 moved the
 * console's other stamps (the alarm rows, the annunciator banner, the CONSOLE header) to the site
 * zone, so wherever the site zone is not the host's the two dividers disagreed with the rows under
 * them: SITE_TIMEZONE=America/New_York on a Phoenix host read three hours behind, and a UTC host
 * with the default Phoenix site seven hours ahead. Identical where the site zone is the host's.
 *
 * The site zone is resolved once at load, so the split cases run in child processes
 * (helpers/consoleClockProbe.ts); the in-process case is judged on the runner's own zones.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const PROBE = resolve(HERE, 'helpers/consoleClockProbe.ts');

function probe(env: Record<string, string>): Promise<ConsoleClocks> {
  return new Promise((res, rej) => {
    const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE ?? '', ...env };
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

test('in this process: both dividers carry the site clock the console\'s other stamps use', () => {
  const r = consoleClocks();
  assert.ok(r.alm != null && r.bus != null, 'both dividers carry a clock');
  assert.equal(r.alm, r.siteHms, `ALARM LIST (site ${r.zone}, host ${r.hostZone})`);
  assert.equal(r.bus, r.siteHms, `MAIN BUS (site ${r.zone}, host ${r.hostZone})`);
});

test('no console source formats a time with the host clock', () => {
  const telnet = resolve(SERVER, 'src/telnet');
  const files = readdirSync(telnet, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  assert.ok(files.includes('plant/alm.ts') || files.includes('plant\\alm.ts'), 'the walk reaches the plant screens');
  for (const f of files) {
    const s = readFileSync(resolve(telnet, f), 'utf8');
    assert.ok(!/\.toTimeString\(|\.toDateString\(|\.toLocale(?:Time|Date)?String\(\)/.test(s), `${f} formats no time on the host clock`);
    assert.ok(!/\.get(?:Hours|Minutes|Seconds|Date|Day)\(\)/.test(s), `${f} reads no host-clock field`);
  }
});
