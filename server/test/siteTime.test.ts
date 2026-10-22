import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSiteTimeZone, checkTimeZone, LEGACY_ZONE_LINKS, siteTimeZoneLogLine,
  zonedParts, zonedDayStartMs, zonedNoonIso, zonedWallTimeMs, zonedShiftDaysMs, zoneOffsetMs, addDaysYmd,
  siteTimeZone, siteTimeZoneSource, siteYmd, siteHour, siteDow, siteMinuteOfDay, siteDayStartMs, siteNoonIso,
  siteDayStartOf, siteNextDayStartOf, siteYmdOrRaw, fmtSiteClock, fmtSiteWeekday, fmtSiteHm, fmtSiteDayHm, WEEKDAY_ES,
  phoenixYmd, fmtPhoenixHm, fmtPhoenixDayHm, noonPhoenixIso,
} from '../src/siteTime.js';
import { localParts } from '../src/tariff.js';
import { DEFAULT_SITE_TIME_ZONE, OPTIONS } from '../src/config.js';
import { checkHaTimeZone, haZoneDiffers, siteTimeRepairIssues, siteTimeBootLines, resetHaZoneCheckForTesting } from '../src/siteTimeHa.js';

/**
 * v1.191.0 (lane A, S4) — the site clock (plan 2.4, T1–T18, CA11, CA16, CA19, CA26).
 *
 * Three parts: the resolution chain (pure), the zone arithmetic over a matrix of zones (pure,
 * zone-parameterised), and the same functions end to end in child processes whose environment sets
 * SITE_TIMEZONE / TZ, because the site zone is resolved once at import (test/helpers/siteZoneProbe.ts).
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/* ───────────────────────────── the chain ───────────────────────────── */

test('★ the chain: SITE_TIMEZONE, then TZ, then America/Phoenix', () => {
  assert.equal(DEFAULT_SITE_TIME_ZONE, 'America/Phoenix');
  assert.deepEqual(resolveSiteTimeZone('Europe/Berlin', 'Asia/Tokyo'), { zone: 'Europe/Berlin', source: 'SITE_TIMEZONE', rejected: [], mappedFrom: null });
  assert.deepEqual(resolveSiteTimeZone(null, 'Asia/Tokyo'), { zone: 'Asia/Tokyo', source: 'TZ', rejected: [], mappedFrom: null });
  assert.deepEqual(resolveSiteTimeZone(undefined, undefined), { zone: 'America/Phoenix', source: 'default', rejected: [], mappedFrom: null });
  // blank is unset (a has_value export never sends one, but TZ may be blank)
  assert.equal(resolveSiteTimeZone('  ', '').source, 'default');
  // the reference install: TZ exactly America/Phoenix
  assert.deepEqual(resolveSiteTimeZone(null, 'America/Phoenix'), { zone: 'America/Phoenix', source: 'TZ', rejected: [], mappedFrom: null });
  // POSIX ":zone" form of TZ
  assert.equal(resolveSiteTimeZone(null, ':Europe/Paris').zone, 'Europe/Paris');
});

test('★ an invalid zone fails closed: it is recorded and the chain falls through — never UTC', () => {
  const r = resolveSiteTimeZone('Mars/Olympus_Mons', 'Europe/Berlin');
  assert.equal(r.zone, 'Europe/Berlin');
  assert.equal(r.source, 'TZ');
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].source, 'SITE_TIMEZONE');
  assert.equal(r.rejected[0].value, 'Mars/Olympus_Mons');
  const both = resolveSiteTimeZone('Not/AZone', 'null');
  assert.equal(both.zone, 'America/Phoenix');
  assert.equal(both.source, 'default');
  assert.deepEqual(both.rejected.map((x) => x.source), ['SITE_TIMEZONE', 'TZ']);
  // A POSIX TZ string Intl cannot read falls through too.
  assert.equal(resolveSiteTimeZone(null, 'MST7MDT,M3.2.0,M11.1.0').source, 'default');
  // UTC itself is a valid site zone when asked for by name.
  assert.equal(resolveSiteTimeZone('UTC', null).zone, 'UTC');
  assert.equal(resolveSiteTimeZone('Etc/UTC', null).zone, 'Etc/UTC');
});

test('★ CA19: links of the legacy zone resolve to America/Phoenix (the tariff zone string stays)', () => {
  assert.deepEqual(Object.keys(LEGACY_ZONE_LINKS).sort(), ['MST', 'US/Arizona']);
  for (const link of ['US/Arizona', 'us/arizona', 'MST', 'mst', 'america/phoenix', 'AMERICA/PHOENIX']) {
    const r = checkTimeZone(link);
    assert.ok('zone' in r && r.zone === 'America/Phoenix', `${link} → ${JSON.stringify(r)}`);
  }
  const viaTz = resolveSiteTimeZone(null, 'US/Arizona');
  assert.deepEqual(viaTz, { zone: 'America/Phoenix', source: 'TZ', rejected: [], mappedFrom: 'US/Arizona' });
  assert.equal(siteTimeZoneLogLine(viaTz), 'site time zone America/Phoenix (source: TZ; US/Arizona is a link of it)');
  // A different zone keeps its spelling (not the runtime's legacy canonical alias).
  const kolkata = checkTimeZone('Asia/Kolkata');
  assert.ok('zone' in kolkata && kolkata.zone === 'Asia/Kolkata');
  const lower = checkTimeZone('europe/berlin');
  assert.ok('zone' in lower && lower.zone === 'Europe/Berlin');
});

test('the boot log line names the zone and its source', () => {
  assert.equal(siteTimeZoneLogLine(resolveSiteTimeZone(null, 'America/Phoenix')), 'site time zone America/Phoenix (source: TZ)');
  assert.equal(siteTimeZoneLogLine(resolveSiteTimeZone(null, null)), 'site time zone America/Phoenix (source: default)');
  assert.equal(siteTimeZoneLogLine(resolveSiteTimeZone('Asia/Tokyo', null)), 'site time zone Asia/Tokyo (source: SITE_TIMEZONE)');
});

test('SITE_TIMEZONE and TZ are registered: the option schema-only (has_value), TZ a deployment value', () => {
  assert.equal(OPTIONS.SITE_TIMEZONE.source, 'option');
  assert.equal(OPTIONS.SITE_TIMEZONE.exportForm, 'has_value');
  assert.equal(OPTIONS.TZ.source, 'deploy');
  const env = { get: () => undefined };
  assert.equal(OPTIONS.SITE_TIMEZONE.parse(undefined, env), null);
  assert.equal(OPTIONS.SITE_TIMEZONE.parse('  Europe/Berlin ', env), 'Europe/Berlin');
  assert.equal(OPTIONS.TZ.parse('', env), null);
});

/* ───────────────────────────── zone arithmetic (pure) ───────────────────────────── */

const ZONES = ['America/Phoenix', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Honolulu', 'Asia/Kolkata', 'America/Santiago', 'Asia/Kathmandu'];

test('★ the fast local-parts path equals Intl at every hour (and the half hours) of 2024–2028 in eight zones', () => {
  for (const zone of ZONES) {
    const mismatches: string[] = [];
    for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2029, 0, 1); t += HOUR / 2) {
      const fast = zonedParts(t, zone);
      const slow = localParts(t, zone);
      if (fast.ymd !== slow.ymd || fast.hour !== slow.hour || fast.dow !== slow.dow) {
        mismatches.push(`${new Date(t).toISOString()}: ${JSON.stringify(fast)} vs ${JSON.stringify(slow)}`);
        if (mismatches.length > 3) break;
      }
    }
    assert.deepEqual(mismatches, [], zone);
  }
});

test('★ local midnight: Phoenix is 07:00Z every day; Berlin follows its DST (a 23 h and a 25 h day)', () => {
  for (const ymd of ['2025-01-01', '2026-03-08', '2026-07-01', '2026-11-01', '2027-12-31']) {
    const [y, m, d] = ymd.split('-').map(Number);
    assert.equal(zonedDayStartMs(ymd, 'America/Phoenix'), Date.UTC(y, m - 1, d, 7));
  }
  assert.equal(zonedDayStartMs('2026-07-01', 'Europe/Berlin'), Date.UTC(2026, 5, 30, 22));
  assert.equal(zonedDayStartMs('2026-01-15', 'Europe/Berlin'), Date.UTC(2026, 0, 14, 23));
  // DST week: Sunday 2026-03-29 has 23 hours, Sunday 2026-10-25 has 25.
  assert.equal(zonedDayStartMs('2026-03-30', 'Europe/Berlin') - zonedDayStartMs('2026-03-29', 'Europe/Berlin'), 23 * HOUR);
  assert.equal(zonedDayStartMs('2026-10-26', 'Europe/Berlin') - zonedDayStartMs('2026-10-25', 'Europe/Berlin'), 25 * HOUR);
  // southern hemisphere: Sydney ends DST on 2026-04-05 (25 h) and starts it on 2026-10-04 (23 h)
  assert.equal(zonedDayStartMs('2026-04-06', 'Australia/Sydney') - zonedDayStartMs('2026-04-05', 'Australia/Sydney'), 25 * HOUR);
  assert.equal(zonedDayStartMs('2026-10-05', 'Australia/Sydney') - zonedDayStartMs('2026-10-04', 'Australia/Sydney'), 23 * HOUR);
  assert.equal(zonedDayStartMs('2026-07-01', 'Pacific/Honolulu'), Date.UTC(2026, 6, 1, 10));
  assert.equal(zonedDayStartMs('2026-08-15', 'Asia/Kolkata'), Date.UTC(2026, 7, 14, 18, 30));
  assert.equal(zonedDayStartMs('2026-08-15', 'Asia/Kathmandu'), Date.UTC(2026, 7, 14, 18, 15));
  assert.ok(Number.isNaN(zonedDayStartMs('2026-8-15', 'Europe/Berlin')));
});

test('★ a day whose midnight does not exist starts at the transition (America/Santiago, 2026-09-06)', () => {
  const start = zonedDayStartMs('2026-09-06', 'America/Santiago');
  const p = zonedParts(start, 'America/Santiago');
  assert.equal(p.ymd, '2026-09-06');
  assert.equal(p.hour, 1);
  assert.equal(zonedParts(start - 60_000, 'America/Santiago').ymd, '2026-09-05');
  // a repeated wall time takes its first occurrence (Berlin 2026-10-25 02:30 CEST = 00:30Z)
  assert.equal(zonedWallTimeMs('2026-10-25', 2, 30, 'Europe/Berlin'), Date.UTC(2026, 9, 25, 0, 30));
  // a skipped wall time is the first instant after the gap (Berlin 2026-03-29 02:30 → 03:00 CEST = 01:00Z)
  assert.equal(zonedWallTimeMs('2026-03-29', 2, 30, 'Europe/Berlin'), Date.UTC(2026, 2, 29, 1, 0));
});

test('★ CA11: the statistics noon is local noon on the right date, floored to the UTC hour, in the exact string form', () => {
  // Phoenix: the string this always wrote.
  assert.equal(zonedNoonIso('2026-08-15', 'America/Phoenix'), '2026-08-15T19:00:00+00:00');
  assert.equal(zonedNoonIso('2026-01-15', 'America/Phoenix'), '2026-01-15T19:00:00+00:00');
  // East of UTC: Tokyo's noon is 03:00Z the same date (a fixed 19:00Z would be 04:00 the NEXT day there).
  assert.equal(zonedNoonIso('2026-08-15', 'Asia/Tokyo'), '2026-08-15T03:00:00+00:00');
  // Berlin, summer and winter — and on the DST days themselves, where midnight + 12 h is NOT noon.
  assert.equal(zonedNoonIso('2026-07-01', 'Europe/Berlin'), '2026-07-01T10:00:00+00:00');
  assert.equal(zonedNoonIso('2026-01-15', 'Europe/Berlin'), '2026-01-15T11:00:00+00:00');
  assert.equal(zonedNoonIso('2026-03-29', 'Europe/Berlin'), '2026-03-29T10:00:00+00:00');
  assert.equal(zonedNoonIso('2026-10-25', 'Europe/Berlin'), '2026-10-25T11:00:00+00:00');
  assert.equal(zonedNoonIso('2026-04-05', 'Australia/Sydney'), '2026-04-05T02:00:00+00:00');
  // Sydney in its summer (AEDT, +11): the UTC date is the day before.
  assert.equal(zonedNoonIso('2026-01-15', 'Australia/Sydney'), '2026-01-15T01:00:00+00:00');
  assert.equal(zonedNoonIso('2026-07-01', 'Pacific/Honolulu'), '2026-07-01T22:00:00+00:00');
  // 30- and 45-minute offsets: noon is off the hour, and is floored onto it.
  assert.equal(zonedNoonIso('2026-08-15', 'Asia/Kolkata'), '2026-08-15T06:00:00+00:00');
  assert.equal(zonedNoonIso('2026-08-15', 'Asia/Kathmandu'), '2026-08-15T06:00:00+00:00');
  for (const zone of ZONES) {
    const iso = zonedNoonIso('2026-08-15', zone);
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+00:00$/, zone);
    assert.equal(zonedParts(Date.parse(iso), zone).ymd, '2026-08-15', `${zone}: ${iso} is not on the local date`);
  }
});

test('★ CA26: shifting by calendar days keeps the local wall time across a DST change; a fixed 24 h step does not', () => {
  const sat = zonedDayStartMs('2026-03-28', 'Europe/Berlin');
  const mon = zonedDayStartMs('2026-03-30', 'Europe/Berlin');
  assert.equal(zonedShiftDaysMs(mon, -2, 'Europe/Berlin'), sat);
  assert.notEqual(mon - 2 * DAY, sat, 'the fixture must actually cross the change');
  // Phoenix: identical to the fixed step, for any instant (a midnight or not, with seconds).
  for (const t of [Date.UTC(2026, 6, 4, 7), Date.UTC(2026, 6, 4, 0), Date.UTC(2026, 10, 1, 9, 13, 27, 450)]) {
    for (const n of [-30, -7, -1, 1, 7]) assert.equal(zonedShiftDaysMs(t, n, 'America/Phoenix'), t + n * DAY);
  }
  assert.equal(addDaysYmd('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysYmd('2028-03-01', -1), '2028-02-29');
  assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysYmd('bad', 1), 'bad');
});

test('the zone offset helper and its fast path agree at a transition minute', () => {
  // Berlin spring forward at 01:00Z.
  assert.equal(zoneOffsetMs('Europe/Berlin', Date.UTC(2026, 2, 29, 0, 59)), HOUR);
  assert.equal(zoneOffsetMs('Europe/Berlin', Date.UTC(2026, 2, 29, 1, 0)), 2 * HOUR);
  assert.equal(zonedParts(Date.UTC(2026, 2, 29, 0, 59), 'Europe/Berlin').hour, 1);
  assert.equal(zonedParts(Date.UTC(2026, 2, 29, 1, 0), 'Europe/Berlin').hour, 3);
});

/* ─────────────── the site clock in THIS process (no SITE_TIMEZONE: the runner's TZ or the default) ─────────────── */

test('the site clock functions agree with the zone-parameterised ones for the resolved zone', () => {
  const zone = siteTimeZone();
  assert.ok(['SITE_TIMEZONE', 'TZ', 'default'].includes(siteTimeZoneSource()));
  const t = Date.UTC(2026, 6, 4, 19, 45);
  const p = zonedParts(t, zone);
  assert.equal(siteYmd(t), p.ymd);
  assert.equal(siteHour(t), p.hour);
  assert.equal(siteDow(t), p.dow);
  assert.equal(siteMinuteOfDay(t), p.hour * 60 + p.minute);
  assert.equal(siteDayStartMs('2026-07-04'), zonedDayStartMs('2026-07-04', zone));
  assert.equal(siteNoonIso('2026-07-04'), zonedNoonIso('2026-07-04', zone));
  assert.equal(siteDayStartOf(t), zonedDayStartMs(p.ymd, zone));
  assert.equal(siteNextDayStartOf(t), zonedDayStartMs(addDaysYmd(p.ymd, 1), zone));
  // invalid instants: the date throws (as localParts did), hour/weekday read NaN (as Date#getHours did)
  assert.throws(() => siteYmd(NaN), RangeError);
  assert.ok(Number.isNaN(siteHour(NaN)));
  assert.ok(Number.isNaN(siteDow(Number.POSITIVE_INFINITY)));
  assert.equal(siteYmdOrRaw(1e20), '1000000000');
  assert.equal(siteYmdOrRaw(NaN), 'NaN');
});

test('the deprecated names are the site functions', () => {
  assert.equal(phoenixYmd, siteYmd);
  assert.equal(fmtPhoenixHm, fmtSiteHm);
  assert.equal(fmtPhoenixDayHm, fmtSiteDayHm);
  assert.equal(noonPhoenixIso, siteNoonIso);
});

test('CA16: Spanish weekday names come from the fixed map; no es locale', () => {
  assert.deepEqual(Object.values(WEEKDAY_ES), ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']);
  const t = Date.UTC(2026, 6, 4, 19); // a Saturday at local noon in every zone west of +5
  const en = fmtSiteWeekday(t);
  assert.equal(fmtSiteWeekday(t, 'es'), WEEKDAY_ES[en]);
  assert.match(fmtSiteClock(t), /^\d{1,2}:\d{2} (AM|PM)$/);
  assert.match(fmtSiteHm(t), /^\d{2}:\d{2}$/);
  assert.equal(fmtSiteDayHm(t, t - HOUR), fmtSiteHm(t));
  assert.match(fmtSiteDayHm(t, t - 25 * HOUR), /^[A-Z][a-z]{2} \d{2}:\d{2}$/);
});

/* ───────────────────────────── end to end, per zone (child processes) ───────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const PROBE = resolve(HERE, 'helpers/siteZoneProbe.ts');

/** Run the probe with exactly this site environment (and a fixed host TZ unless given). */
function probe(env: { SITE_TIMEZONE?: string; TZ?: string }): Promise<Record<string, any>> {
  return new Promise((res, rej) => {
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TSX_DISABLE_CACHE: process.env.TSX_DISABLE_CACHE ?? '' };
    if (env.SITE_TIMEZONE !== undefined) childEnv.SITE_TIMEZONE = env.SITE_TIMEZONE;
    if (env.TZ !== undefined) childEnv.TZ = env.TZ;
    execFile(process.execPath, ['--import', 'tsx', PROBE], { cwd: SERVER, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return rej(new Error(`probe failed: ${err.message}\n${stderr}`));
      try { res(JSON.parse(stdout)); } catch (e) { rej(new Error(`probe wrote non-JSON: ${(e as Error).message}\n${stdout.slice(0, 400)}`)); }
    });
  });
}

const runs = {
  phoenixTz: probe({ TZ: 'America/Phoenix' }),
  unset: probe({ TZ: 'UTC', SITE_TIMEZONE: undefined }),
  berlin: probe({ SITE_TIMEZONE: 'Europe/Berlin', TZ: 'UTC' }),
  tokyo: probe({ SITE_TIMEZONE: 'Asia/Tokyo', TZ: 'UTC' }),
  sydney: probe({ SITE_TIMEZONE: 'Australia/Sydney', TZ: 'UTC' }),
  honolulu: probe({ SITE_TIMEZONE: 'Pacific/Honolulu', TZ: 'UTC' }),
  kolkata: probe({ SITE_TIMEZONE: 'Asia/Kolkata', TZ: 'UTC' }),
  arizonaLink: probe({ TZ: 'US/Arizona' }),
  invalid: probe({ SITE_TIMEZONE: 'Mars/Olympus_Mons', TZ: 'Europe/Berlin' }),
  invalidAll: probe({ SITE_TIMEZONE: 'Not/AZone' }),
  phoenixOnUtcHost: probe({ SITE_TIMEZONE: 'America/Phoenix', TZ: 'UTC' }),
};

test('★ the reference install (TZ = America/Phoenix): the zone, the source, the model zone, the old fixed-offset values', async () => {
  const r = await runs.phoenixTz;
  assert.equal(r.zone, 'America/Phoenix');
  assert.equal(r.source, 'TZ');
  assert.equal(r.logLine, 'site time zone America/Phoenix (source: TZ)');
  assert.equal(r.modelTimezone, 'America/Phoenix');
  assert.equal(r.flatModelTimezone, 'America/Phoenix');
  assert.equal(r.dayStart['2026-07-01'], Date.UTC(2026, 6, 1, 7));
  assert.equal(r.noon['2026-08-15'], '2026-08-15T19:00:00+00:00');
  assert.equal(r.haNoon['2026-08-15'], '2026-08-15T19:00:00+00:00');
  assert.deepEqual(r.bounds['2026-07-01'], {
    windowStartMs: Date.UTC(2026, 6, 2, 6), windowEndMs: Date.UTC(2026, 6, 2, 12),
    scoreSpanEndMs: Date.UTC(2026, 6, 3, 4), completeMs: Date.UTC(2026, 6, 3, 4),
  });
  assert.deepEqual(r.repairIds, []);
});

test('★ unset everywhere (a bare runner): the default zone, source default', async () => {
  const r = await runs.unset;
  // TZ=UTC is a valid zone, so it is the source; the default needs both absent (invalidAll covers it).
  assert.equal(r.zone, 'UTC');
  assert.equal(r.source, 'TZ');
  const d = await runs.invalidAll;
  assert.equal(d.zone, 'America/Phoenix');
  assert.equal(d.source, 'default');
  assert.deepEqual(d.repairIds, ['site-timezone-invalid-SITE_TIMEZONE']);
});

test('★ Europe/Berlin: the site option wins over TZ; midnight, noon and the plan-date bounds follow DST', async () => {
  const r = await runs.berlin;
  assert.equal(r.zone, 'Europe/Berlin');
  assert.equal(r.source, 'SITE_TIMEZONE');
  assert.equal(r.modelTimezone, 'Europe/Berlin');
  assert.equal(r.dayStart['2026-07-01'], Date.UTC(2026, 5, 30, 22)); // a fixed −7 h would be 07:00Z
  assert.equal(r.dayStart['2026-01-15'], Date.UTC(2026, 0, 14, 23));
  assert.equal(r.noon['2026-07-01'], '2026-07-01T10:00:00+00:00');
  assert.equal(r.bounds['2026-07-01'].windowStartMs, Date.UTC(2026, 5, 30, 22) + 23 * HOUR);
  // the DST week: day starts step 24, 24, 23 (into Monday after the change)… and the day keys are local
  assert.deepEqual(r.dstWeekStarts.map((x: number, i: number, a: number[]) => (i ? (x - a[i - 1]) / HOUR : 0)), [0, 24, 24, 24, 23, 24, 24]);
  assert.deepEqual(r.dstWeekKeys, ['2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01']);
});

test('★ Asia/Tokyo: the statistics noon lands on the right date, and an idle-floor night is not split', async () => {
  const r = await runs.tokyo;
  assert.equal(r.zone, 'Asia/Tokyo');
  assert.equal(r.noon['2026-08-15'], '2026-08-15T03:00:00+00:00');
  assert.equal(r.haNoon['2026-08-15'], '2026-08-15T03:00:00+00:00');
  // Two nights of samples (local 19:00 → 06:00): one floor per night, each from 12 samples.
  assert.equal(r.idleNights.length, 2, JSON.stringify(r.idleNights));
  // a bucket begins at 17:00 local (08:00Z)
  for (const b of r.idleNights) assert.equal(((b.ts % DAY) + DAY) % DAY, 8 * HOUR);
});

test('Australia/Sydney (southern DST) and Pacific/Honolulu (no DST, west of Phoenix)', async () => {
  const s = await runs.sydney;
  assert.equal(s.noon['2026-01-15'], '2026-01-15T01:00:00+00:00');
  assert.equal(s.dayStart['2026-07-01'], Date.UTC(2026, 5, 30, 14));
  const h = await runs.honolulu;
  assert.equal(h.dayStart['2026-07-01'], Date.UTC(2026, 6, 1, 10));
  assert.equal(h.noon['2026-08-15'], '2026-08-15T22:00:00+00:00');
});

test('★ Asia/Kolkata (a 30-minute offset): noon floors onto the UTC hour', async () => {
  const r = await runs.kolkata;
  assert.equal(r.zone, 'Asia/Kolkata');
  assert.equal(r.noon['2026-08-15'], '2026-08-15T06:00:00+00:00');
  assert.equal(r.dayStart['2026-08-15'], Date.UTC(2026, 7, 14, 18, 30));
});

test('★ CA19: TZ = US/Arizona keeps every zone string America/Phoenix (G2 deep-equal holds)', async () => {
  const r = await runs.arizonaLink;
  assert.equal(r.zone, 'America/Phoenix');
  assert.equal(r.source, 'TZ');
  assert.equal(r.mappedFrom, 'US/Arizona');
  assert.equal(r.modelTimezone, 'America/Phoenix');
  assert.equal(r.flatModelTimezone, 'America/Phoenix');
});

test('★ an invalid SITE_TIMEZONE raises a repair issue and falls through to TZ', async () => {
  const r = await runs.invalid;
  assert.equal(r.zone, 'Europe/Berlin');
  assert.equal(r.source, 'TZ');
  assert.deepEqual(r.repairIds, ['site-timezone-invalid-SITE_TIMEZONE']);
  assert.match(r.repairText, /Mars\/Olympus_Mons/);
});

test('★ T9/T15: the MPC hour index and the quiet-hours clock follow the site zone, not the host clock', async () => {
  const r = await runs.phoenixOnUtcHost;
  assert.equal(r.zone, 'America/Phoenix');
  // 19:00Z is 12:00 in Phoenix; the host (TZ=UTC) reads 19.
  assert.equal(r.hostHourAt19z, 19);
  assert.equal(r.mpcSpikeStep, (15 - 12 + 24) % 24, 'the tariff spike at hour-of-day 15 is three steps after a 12:00 start');
  // 07:00Z is 00:00 in Phoenix: inside a 22-06 quiet window there, outside it on the host clock.
  assert.equal(r.quietAt07z, true);
});

/* ───────────────────────────── the main thread's side (siteTimeHa.ts) ───────────────────────────── */

test('★ Home Assistant\'s zone is compared in the background: a difference warns and raises a repair issue; the zone never switches', async () => {
  resetHaZoneCheckForTesting();
  const booted = siteTimeZone();
  const r = resolveSiteTimeZone(null, 'America/Phoenix');
  const warns: string[] = [];
  // the reference install: HA is America/Phoenix — silent, no issue
  const same = await checkHaTimeZone((m) => warns.push(m), async () => 'America/Phoenix', r, () => 1000);
  assert.deepEqual(same, { haZone: 'America/Phoenix', siteZone: 'America/Phoenix', mismatch: false, checkedAtMs: 1000 });
  assert.equal(warns.length, 0, warns.join(' | '));
  assert.deepEqual(siteTimeRepairIssues(r), []);
  // a link of the same zone is the same zone
  assert.equal(haZoneDiffers('America/Phoenix', 'US/Arizona'), false);
  // HA cannot be read (outside the add-on, a timeout): silent, nothing recorded
  assert.equal(await checkHaTimeZone((m) => warns.push(m), async () => null, r), null);
  assert.equal(await checkHaTimeZone((m) => warns.push(m), async () => { throw new Error('boom'); }, r), null);
  assert.equal(warns.length, 0, warns.join(' | '));
  // a different zone: one warning, one repair issue, and the site zone is unchanged
  const diff = await checkHaTimeZone((m) => warns.push(m), async () => 'Europe/Berlin', r, () => 2000);
  assert.equal(diff?.mismatch, true);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /site time zone America\/Phoenix \(source: TZ\) differs from Home Assistant's Europe\/Berlin; the add-on keeps its zone until restarted/);
  const issues = siteTimeRepairIssues(r);
  assert.deepEqual(issues.map((i) => i.id), ['site-timezone-differs-from-ha']);
  assert.equal(issues[0].category, 'Configuration');
  assert.equal(issues[0].firstSeenAt, 2000);
  assert.equal(siteTimeZone(), booted, 'the comparison never changes the zone the process booted with');
  resetHaZoneCheckForTesting();
});

test('the boot lines: the zone and its source, then one warning per configured value that did not resolve', () => {
  const r = resolveSiteTimeZone('Mars/Olympus_Mons', 'Europe/Berlin');
  const lines = siteTimeBootLines(r);
  assert.equal(lines.info, 'site time zone Europe/Berlin (source: TZ)');
  assert.equal(lines.warnings.length, 1);
  assert.match(lines.warnings[0], /^SITE_TIMEZONE="Mars\/Olympus_Mons" is not a usable time zone \(.+\); using Europe\/Berlin \(source: TZ\)$/);
  const issues = siteTimeRepairIssues(r, null);
  assert.deepEqual(issues.map((i) => i.id), ['site-timezone-invalid-SITE_TIMEZONE']);
  assert.equal(issues[0].severity, 'warning');
  assert.ok(issues[0].fixSteps.some((x) => /Site Time Zone/.test(x)));
});
