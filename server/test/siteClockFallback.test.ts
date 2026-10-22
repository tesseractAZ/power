import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (review 3) — THE UNCONFIRMED-RATE FALLBACK AND THE ALERT CLOCK ARE ON THE SITE CLOCK.
 *
 * Plan F2 judges the legacy on-peak window on the site's hour. analytics.ts onPeakAt still read the
 * host's (getHours / getDay); it decides every unconfirmed hour of hourlyRateCents and isOnPeakHour:
 * the cost figures' tally, the dispatch planner's on-peak hours and the MPC tariff vector, which is
 * built on site-zone instants. alerts.ts fmtClock printed the gap and outage texts and their
 * Started / Detected / Ended fields on the host clock too. Both matter only where the site zone is
 * not the host's (SITE_TIMEZONE set to another zone than TZ, the case that option exists for): a New
 * York two_tier plan, on-peak 14-19, on a Phoenix host was priced on-peak 17:00-21:00, against its own
 * model's window, and an outage at 14:00 read 11:00 AM.
 *
 * The site zone is resolved once at load, so each case runs in a child process
 * (helpers/siteClockFallbackProbe.ts).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const PROBE = resolve(HERE, 'helpers/siteClockFallbackProbe.ts');

const TWO_TIER = {
  TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_HOURS: '14-19', TARIFF_ON_PEAK_DAYS: '1-5',
  TARIFF_ON_PEAK_CENTS: '32', TARIFF_OFF_PEAK_CENTS: '11', TARIFF_APS_RATES_CONFIRMED: 'false',
};

interface Hour { ymd: string; hour: number; onPeakAt: boolean; isOnPeakHour: boolean; modelOnPeak: boolean; cost: number; mpc: number }
interface Probe { zone: string; planId: string; ratesConfirmed: boolean; hostZone: string; hours: Hour[]; clock: Record<string, string> }

function probe(env: Record<string, string>): Promise<Probe> {
  return new Promise((res, rej) => {
    const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE ?? '', ...env };
    execFile(process.execPath, ['--import', 'tsx', PROBE], { cwd: SERVER, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return rej(new Error(`probe failed: ${err.message}\n${stderr}`));
      try { res(JSON.parse(stdout) as Probe); } catch (e) { rej(new Error(`probe wrote non-JSON: ${(e as Error).message}\n${stdout.slice(0, 400)}`)); }
    });
  });
}

const runs = {
  nyOnPhoenixHost: probe({ ...TWO_TIER, TZ: 'America/Phoenix', SITE_TIMEZONE: 'America/New_York' }),
  phoenixOnNyHost: probe({ ...TWO_TIER, TZ: 'America/New_York', SITE_TIMEZONE: 'America/Phoenix' }),
  sameZone: probe({ ...TWO_TIER, TZ: 'America/New_York' }),
  // A site east of UTC on a UTC host: the weekday turns at the site's midnight, not the host's.
  tokyoOnUtcHost: probe({ ...TWO_TIER, TARIFF_ON_PEAK_HOURS: '0-3', TZ: 'UTC', SITE_TIMEZONE: 'Asia/Tokyo' }),
  // The reference install: TZ America/Phoenix, SITE_TIMEZONE unset, TARIFF_PLAN unset (the legacy 15-20 Mon-Fri window).
  reference: probe({ TZ: 'America/Phoenix', TARIFF_APS_RATES_CONFIRMED: 'false' }),
};

/** The week the probe walks, Monday 2026-10-19 first. */
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
/** Site-local on-peak by the plan: hours [start, end) on Monday to Friday. */
const expectOnPeak = (h: Hour, start: number, end: number) => {
  const i = WEEK.indexOf(h.ymd);
  assert.ok(i >= 0, `${h.ymd} is not in the probed week`);
  return i <= 4 && h.hour >= start && h.hour < end;
};

test('precondition: each probe resolved the zones it was given (an unconfirmed two_tier plan)', async () => {
  const ny = await runs.nyOnPhoenixHost;
  assert.deepEqual([ny.zone, ny.hostZone, ny.planId, ny.ratesConfirmed], ['America/New_York', 'America/Phoenix', 'two_tier', false]);
  const phx = await runs.phoenixOnNyHost;
  assert.deepEqual([phx.zone, phx.hostZone], ['America/Phoenix', 'America/New_York']);
  assert.equal(ny.hours.length, 7 * 24);
});

test('★★★ the unconfirmed fallback prices the plan\'s own window on the site clock, whatever the host\'s zone', async () => {
  for (const name of ['nyOnPhoenixHost', 'phoenixOnNyHost', 'sameZone'] as const) {
    const r = await runs[name];
    for (const h of r.hours) {
      const want = expectOnPeak(h, 14, 19);
      const at = `${name} ${h.ymd} ${h.hour}:30`;
      assert.equal(h.modelOnPeak, want, `${at}: the model's window (precondition)`);
      assert.equal(h.onPeakAt, want, `${at}: onPeakAt agrees with the model's window`);
      assert.equal(h.isOnPeakHour, want, `${at}: isOnPeakHour`);
      assert.equal(h.cost, want ? 32 : 11, `${at}: the cost figures' rate`);
      assert.equal(h.mpc, want ? 32 : 11, `${at}: the MPC vector's rate`);
    }
  }
});

test('★★ the weekday is the site\'s too: Tokyo on a UTC host turns the day at Tokyo\'s midnight', async () => {
  const r = await runs.tokyoOnUtcHost;
  assert.equal(r.zone, 'Asia/Tokyo');
  for (const h of r.hours) {
    const want = expectOnPeak(h, 0, 3);
    assert.equal(h.modelOnPeak, want, `${h.ymd} ${h.hour}:30: the model's window (precondition)`);
    assert.equal(h.onPeakAt, want, `${h.ymd} ${h.hour}:30: onPeakAt`);
  }
  // Monday 00:30 Tokyo is Sunday 15:30 UTC: on-peak by the site's weekday, off-peak by the host's.
  assert.equal(r.hours[0].onPeakAt, true);
  // Saturday 00:30 Tokyo is Friday 15:30 UTC: off-peak by the site's weekday.
  assert.equal(r.hours[5 * 24].onPeakAt, false);
});

test('★★★ the alert clock (gap and outage texts, Started / Detected / Ended) reads the site\'s time', async () => {
  for (const name of ['nyOnPhoenixHost', 'phoenixOnNyHost', 'sameZone', 'tokyoOnUtcHost'] as const) {
    const r = await runs[name];
    assert.deepEqual(r.clock, {
      '2026-10-21T14:00': 'Oct 21, 2:00 PM',
      '2026-10-21T15:05': 'Oct 21, 3:05 PM',
      '2026-01-15T23:59': 'Jan 15, 11:59 PM',
    }, name);
  }
});

test('★★★ the reference install is unchanged: the legacy 15-20 Mon-Fri window on its own clock', async () => {
  const r = await runs.reference;
  assert.deepEqual([r.zone, r.hostZone, r.planId, r.ratesConfirmed], ['America/Phoenix', 'America/Phoenix', 'aps_r_ev', false]);
  for (const h of r.hours) {
    const want = expectOnPeak(h, 15, 20);
    assert.equal(h.onPeakAt, want, `${h.ymd} ${h.hour}:30: onPeakAt`);
    assert.equal(h.isOnPeakHour, want, `${h.ymd} ${h.hour}:30: isOnPeakHour (unconfirmed: the fallback answers)`);
    assert.equal(h.cost, 17, 'the flat default prices every hour');
  }
});

test('★ wiring: every alert clock text goes through fmtClock, and onPeakAt reads no host clock', () => {
  const alerts = readFileSync(resolve(SERVER, 'src/alerts.ts'), 'utf8');
  assert.ok(alerts.includes("new Date(ms).toLocaleString('en-US', { timeZone: siteTimeZone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });"));
  assert.equal((alerts.match(/toLocale(?:String|TimeString|DateString)\(/g) ?? []).length, 1, 'one clock formatter in alerts.ts');
  const an = readFileSync(resolve(SERVER, 'src/analytics.ts'), 'utf8');
  const body = an.slice(an.indexOf('export function onPeakAt('), an.indexOf('export interface TariffReport'));
  assert.ok(body.includes('const h = siteHour(ts);') && body.includes('const day = siteDow(ts);'));
  assert.ok(!/\.get(?:Hours|Day)\(\)/.test(body), 'no host-clock read left in onPeakAt');
});
