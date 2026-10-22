import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePvStrings, pvStringsFor, pvStringsArrayMismatch, DEFAULT_PV_STRINGS,
  siteResponse, siteLocation, siteCoordinates, pvSite, isLegacyPvSite,
  checkHaHomeLocation, siteBootNotices, siteRepairIssues, referenceDefaultsReasons, resetSiteForTesting,
  distanceKm, SITE_REPAIR_IDS, SITE_FAR_KM, zoneOffsetMinutes, solarNoonLocalHour, daylightHours,
  fetchHaCoreConfig, type HaCoreConfig,
} from '../src/site.js';
import { config, DEFAULT_SITE_LAT, DEFAULT_SITE_LON } from '../src/config.js';
import { siteTimeZone, siteTimeZoneSource } from '../src/siteTime.js';
import { PHOENIX_SITE } from '../src/physics/clearSky.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { Site } from '../../web/src/types.js';
import {
  stringsFor, arrayCaption, flowCaption, orientationText, daylightBand, benchSpareFlag, offPanelNotSpare, noPvDetail,
  zoneDayStartMs, DEFAULT_PV_STRINGS as WEB_DEFAULT_PV_STRINGS,
} from '../../web/src/siteFacts.js';
import { energyFlowModel, batteriesTitle, offPanelSplit } from '../../web/src/cards/energyFlowModel.js';
import { benchNote, offPanelPackCount } from '../../web/src/cards/batteryScope.js';

/**
 * v1.191.0 (S7, lane C) — the site facts: PV strings (P4, CA23), GET /api/site, the location
 * (OWNER DECISION 5: the >50 km notice and SITE_LOCATION_FROM_HA), CA20's reference-home notice,
 * the web's solar assumptions (CA24) and the spare label (plan 3.8 S3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = ['PV_ARRAY_KWP', 'PV_TILT_DEG', 'PV_AZIMUTH_DEG', 'PV_STRINGS', 'SITE_LOCATION_FROM_HA', 'SITE_LOCATION_PATH', 'FORECAST_LAT', 'FORECAST_LON', 'SUPERVISOR_TOKEN'];
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  // FORECAST_LAT / FORECAST_LON are config.ts module values (read once at import, as in production):
  // the test sets them on the config object, the way recorderEnergyBridge.test.ts does.
  const savedCfg = [config.forecastLat, config.forecastLon];
  if (vars.FORECAST_LAT !== undefined) config.forecastLat = Number(vars.FORECAST_LAT);
  if (vars.FORECAST_LON !== undefined) config.forecastLon = Number(vars.FORECAST_LON);
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  resetSiteForTesting();
  try {
    return await fn();
  } finally {
    [config.forecastLat, config.forecastLon] = savedCfg;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetSiteForTesting();
  }
}
const quiet = () => {
  const lines: { level: 'info' | 'warn'; m: string }[] = [];
  return { lines, log: { info: (m: string) => lines.push({ level: 'info', m }), warn: (m: string) => lines.push({ level: 'warn', m }) } };
};

/* ── fixtures: one panel with three Cores, one DPU off the panel (placeholder serials) ─── */

const SN = { panel: 'HD31XXX00XXX0001', c1: 'Y711XXX00XXX0001', c2: 'Y711XXX00XXX0002', c3: 'Y711XXX00XXX0003', off: 'Y711XXX00XXX0004' };
function dpu(sn: string, name: string): DeviceSnapshot {
  return { sn, deviceName: name, productName: 'DELTA Pro Ultra', online: true, lastUpdated: 1, projection: { kind: 'dpu', soc: 50, packs: [] } } as unknown as DeviceSnapshot;
}
function plant(): Record<string, DeviceSnapshot> {
  const panel = {
    sn: SN.panel, deviceName: 'Panel', productName: 'Smart Home Panel 2', online: true, lastUpdated: 1,
    projection: { kind: 'shp2', backupBatPercent: 50, circuits: [], sources: [
      { slot: 1, sn: SN.c1, isConnected: true, hwConnect: true },
      { slot: 2, sn: SN.c2, isConnected: true, hwConnect: true },
      { slot: 3, sn: SN.c3, isConnected: true, hwConnect: true },
    ] },
  } as unknown as DeviceSnapshot;
  return { [SN.panel]: panel, [SN.c1]: dpu(SN.c1, 'Core 1'), [SN.c2]: dpu(SN.c2, 'Core 2'), [SN.c3]: dpu(SN.c3, 'Core 3'), [SN.off]: dpu(SN.off, 'Core 4') };
}

/* ── PV_STRINGS grammar ─────────────────────────────────────────────────────────────── */

test('★★★ PV_STRINGS unset is today\'s 10 + 4 × 400 W on every Core', () => {
  const spec = parsePvStrings(null);
  assert.deepEqual(spec.global, { hv: { count: 10, watts: 400 }, lv: { count: 4, watts: 400 } });
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(pvStringsFor(spec, { name: 'Core 2', slot: 2 }), DEFAULT_PV_STRINGS);
  assert.deepEqual(parsePvStrings('   ').global, DEFAULT_PV_STRINGS);
  assert.deepEqual(WEB_DEFAULT_PV_STRINGS, DEFAULT_PV_STRINGS, 'the web\'s fallback equals the server\'s default');
});

test('★★★ PV_STRINGS: a global layout with a slot override and a name override (CA23)', () => {
  const spec = parsePvStrings('hv=12x410,lv=6x410; slot2=hv=8x450; Core  3 = lv=0');
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(spec.global, { hv: { count: 12, watts: 410 }, lv: { count: 6, watts: 410 } });
  // slot 2 overrides only its HV string; its LV string keeps the global one
  assert.deepEqual(pvStringsFor(spec, { name: 'Core 2', slot: 2 }), { hv: { count: 8, watts: 450 }, lv: { count: 6, watts: 410 } });
  // the name override, case and spacing ignored, wins over the slot; lv=0 is no string
  assert.deepEqual(pvStringsFor(spec, { name: 'core 3', slot: 3 }), { hv: { count: 12, watts: 410 }, lv: { count: 0, watts: 0 } });
  assert.deepEqual(pvStringsFor(spec, { name: 'Core 3', slot: 2 }), { hv: { count: 12, watts: 410 }, lv: { count: 0, watts: 0 } });
  assert.deepEqual(pvStringsFor(spec, { name: 'Core 1', slot: 1 }), spec.global);
  assert.deepEqual(pvStringsFor(spec, { name: 'Core 9', slot: null }), spec.global, 'an off-panel Core takes the global layout');
});

test('PV_STRINGS: a global entry that names one string keeps today\'s other one; × and spaces read', () => {
  assert.deepEqual(parsePvStrings('hv = 9 × 400').global, { hv: { count: 9, watts: 400 }, lv: DEFAULT_PV_STRINGS.lv });
  assert.deepEqual(parsePvStrings('slot1=lv=2x300').global, DEFAULT_PV_STRINGS, 'overrides alone leave the global layout as today');
});

test('★★★ PV_STRINGS that cannot be read falls back to the default layout everywhere (fail closed)', () => {
  for (const bad of ['hv=ten x 400', 'slot4=hv=8x450', 'hv=10x400; hv=4x400', 'slot2=hv=8x450; slot2=lv=1x400', 'hv=10x400,hv=4x400', 'hv=10x0', 'hv=101x400', 'garbage', 'slot1=']) {
    const spec = parsePvStrings(bad);
    assert.ok(spec.errors.length > 0, `${bad} must be an error`);
    assert.deepEqual(spec.global, DEFAULT_PV_STRINGS, bad);
    assert.equal(spec.bySlot.size + spec.byName.size, 0, `${bad}: no override survives an invalid spec`);
  }
});

test('PV_STRINGS against PV_ARRAY_KWP: the boot check (5 % tolerance, overrides counted once each)', async () => {
  await withEnv({ PV_STRINGS: 'hv=10x400,lv=4x400' }, () => {
    const spec = parsePvStrings(process.env.PV_STRINGS);
    assert.equal(pvStringsArrayMismatch(spec, 16.8, 3), null, '3 × 5.6 kWp = 16.8 kWp');
    assert.deepEqual(pvStringsArrayMismatch(spec, 5, 3), { stringsW: 16_800, nameplateW: 5000 });
    assert.equal(pvStringsArrayMismatch(spec, 5, 0), null, 'no roster yet: no verdict');
    assert.equal(pvStringsArrayMismatch(spec, null, 3), null);
  });
  await withEnv({ PV_STRINGS: 'hv=10x400,lv=4x400; slot2=hv=8x450' }, () => {
    const spec = parsePvStrings(process.env.PV_STRINGS);
    // 5600 + (3600 + 1600) + 5600 = 16 400 W
    assert.equal(pvStringsArrayMismatch(spec, 16.4, 3), null);
    assert.ok(pvStringsArrayMismatch(spec, 14, 3));
  });
});

/* ── GET /api/site ─────────────────────────────────────────────────────────────────── */

test('★★★ /api/site with nothing set: today\'s values (lane 0\'s stub shape), the legacy PV site, no spare flag', async () => {
  await withEnv({}, () => {
    const r = siteResponse(plant(), new Set([SN.c1, SN.c2, SN.c3]), Date.UTC(2026, 5, 21, 19));
    // The zone and its source are lane A's resolution (siteTime.ts; the chain is tested in siteTime.test.ts):
    // with neither SITE_TIMEZONE nor TZ set, the default zone.
    assert.equal(r.siteTimeZone, siteTimeZone());
    assert.equal(r.source, siteTimeZoneSource());
    if (process.env.SITE_TIMEZONE == null && process.env.TZ == null) assert.deepEqual([r.siteTimeZone, r.source], ['America/Phoenix', 'default']);
    assert.equal(r.lat, DEFAULT_SITE_LAT);
    assert.equal(r.lon, DEFAULT_SITE_LON);
    assert.equal(r.locationSource, 'FORECAST_LAT/LON');
    assert.equal(r.currency, 'USD');
    assert.deepEqual(r.pvStrings, { hv: { count: 10, watts: 400 }, lv: { count: 4, watts: 400 } });
    assert.equal(r.pvStringsSource, 'default');
    for (const sn of [SN.c1, SN.c2, SN.c3, SN.off]) assert.deepEqual(r.pvStringsPerDpu[sn], DEFAULT_PV_STRINGS);
    assert.deepEqual(r.pv, { source: 'legacy', nameplateW: 16_800, tiltDeg: 25, azimuthDeg: 180 });
    assert.equal(r.solar.legacy, true);
    assert.deepEqual(r.solar.daylightHours, [4, 21]);
    assert.equal(r.solar.hemisphere, 'north');
    assert.deepEqual(r.mainsV, { line: 120, split: 240 });
    assert.deepEqual(r.perDpu, {}, 'the per-DPU bench-spare flag is withheld while BENCH_SPARE_SNS is unset (plan 3.8 S3)');
  });
});

test('★★★ /api/site with PV_STRINGS and a slot override: each DPU\'s own strings (web SolarPanel input)', async () => {
  await withEnv({ PV_STRINGS: 'hv=10x400,lv=4x400; slot2=hv=8x450; Core 4=hv=6x300,lv=0' }, () => {
    const r = siteResponse(plant(), null);
    assert.equal(r.pvStringsSource, 'PV_STRINGS');
    assert.deepEqual(r.pvStringsPerDpu[SN.c1], DEFAULT_PV_STRINGS);
    assert.deepEqual(r.pvStringsPerDpu[SN.c2], { hv: { count: 8, watts: 450 }, lv: { count: 4, watts: 400 } });
    assert.deepEqual(r.pvStringsPerDpu[SN.off], { hv: { count: 6, watts: 300 }, lv: { count: 0, watts: 0 } });
    assert.equal(r.pv.source, 'configured', 'PV_STRINGS is a PV_* option: the PV site is the configured one');
    // the web reads it: per-DPU strings, the caption, the flow caption
    const site = r as unknown as Site;
    const panelCores = [SN.c1, SN.c2, SN.c3].map((sn) => stringsFor(site, sn));
    assert.deepEqual(stringsFor(site, SN.c2), { hv: { count: 8, watts: 450 }, lv: { count: 4, watts: 400 } });
    // 5 600 + (3 600 + 1 600) + 5 600 W
    assert.equal(arrayCaption(panelCores), '40 panels · 16.4 kWp · strings differ per DPU');
    assert.equal(flowCaption(panelCores, panelCores.slice(0, 2)), '40 installed · 26 shown · 16.4 kWp');
  });
  await withEnv({ PV_STRINGS: 'hv=10x400,lv=4x400; slot2=hv=nonsense' }, () => {
    const r = siteResponse(plant(), null);
    assert.equal(r.pvStringsSource, 'default', 'an unreadable PV_STRINGS is served as the default layout');
    assert.deepEqual(r.pvStringsPerDpu[SN.c2], DEFAULT_PV_STRINGS);
  });
});

test('★★★ /api/site with a 5 kWp array: the configured PV site and its solar assumptions', async () => {
  await withEnv({ PV_ARRAY_KWP: '5', PV_TILT_DEG: '30', FORECAST_LAT: '-33.87', FORECAST_LON: '151.21' }, () => {
    const r = siteResponse(plant(), null, Date.UTC(2026, 5, 21, 2));
    assert.deepEqual(r.pv, { source: 'configured', nameplateW: 5000, tiltDeg: 30, azimuthDeg: 180 });
    assert.equal(r.lat, -33.87);
    assert.equal(r.solar.legacy, false);
    assert.equal(r.solar.hemisphere, 'south');
    assert.ok(Array.isArray(r.solar.daylightHours) && r.solar.daylightHours[0] < r.solar.daylightHours[1]);
  });
});

/* ── solar assumptions (CA24) ──────────────────────────────────────────────────────── */

test('zone offsets, solar noon and the daylight band follow the site', () => {
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 5, 21, 12), 'America/Phoenix'), -420);
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 5, 21, 12), 'Europe/Berlin'), 120);
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 0, 21, 12), 'Europe/Berlin'), 60);
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 0, 21, 12), 'Asia/Kolkata'), 330);
  const phx = solarNoonLocalHour(Date.UTC(2026, 5, 21, 19), DEFAULT_SITE_LON, 'America/Phoenix');
  assert.ok(phx > 12.3 && phx < 12.7, `reference solar noon ~12:28 MST, got ${phx}`);
  const ber = solarNoonLocalHour(Date.UTC(2026, 5, 21, 11), 13.405, 'Europe/Berlin');
  assert.ok(ber > 13.0 && ber < 13.3, `Berlin solar noon ~13:10 CEST, got ${ber}`);
  assert.deepEqual(daylightHours(DEFAULT_SITE_LAT, DEFAULT_SITE_LON, 'America/Phoenix'), [4, 20]);
  const oslo = daylightHours(59.91, 10.75, 'Europe/Oslo');
  assert.ok(oslo[0] <= 3 && oslo[1] >= 22, `a high-latitude summer is not cut at 4..21: ${oslo}`);
  assert.deepEqual(daylightHours(69.65, 18.96, 'Europe/Oslo'), [0, 23], 'midnight sun');
});

test('a zone Intl cannot resolve gives today\'s bands, not UTC arithmetic', async () => {
  const { siteSolar } = await import('../src/site.js');
  await withEnv({ PV_ARRAY_KWP: '5' }, () => {
    const s = siteSolar(pvSite(), 'Not/AZone', Date.UTC(2026, 5, 21, 19));
    assert.deepEqual(s, { legacy: true, hemisphere: 'north', solarNoonHour: 12, daylightHours: [4, 21] });
  });
});

const solar = (o: Partial<NonNullable<Site['solar']>>): NonNullable<Site['solar']> => ({ legacy: false, hemisphere: 'north', solarNoonHour: 12, daylightHours: [4, 21], ...o });
const TODAY_BANDS: Record<number, string> = {
  8: 'strongly morning-biased — east-facing, or shaded later in the day',
  10: 'morning-biased — array faces east of south',
  13: 'near solar noon — array faces close to true south',
  15: 'afternoon-biased — array faces west of south',
  16: 'strongly afternoon-biased — west-facing, or shaded in the morning',
};

test('★★★ the orientation bands are today\'s while the site is the legacy site (or unknown)', () => {
  for (const [h, text] of Object.entries(TODAY_BANDS)) {
    assert.equal(orientationText(Number(h), null), text);
    assert.equal(orientationText(Number(h), undefined), text);
    // a legacy site keeps today's bands even if its solar noon and hemisphere say otherwise
    assert.equal(orientationText(Number(h), solar({ legacy: true, solarNoonHour: 14.5, hemisphere: 'south' })), text);
  }
});

test('★★★ a configured site: bands around its solar noon, facing the equator of its hemisphere', () => {
  // solar noon at 14:00 (a western edge of a zone): peak at 15 is still "near solar noon"
  assert.equal(orientationText(15, solar({ solarNoonHour: 14 })), 'near solar noon — array faces close to true south');
  assert.equal(orientationText(12, solar({ solarNoonHour: 14 })), 'morning-biased — array faces east of south');
  // southern hemisphere: the array faces north
  assert.equal(orientationText(12, solar({ hemisphere: 'south' })), 'near solar noon — array faces close to true north');
  assert.equal(orientationText(10, solar({ hemisphere: 'south' })), 'morning-biased — array faces east of north');
});

test('★★★ the learned-response chart spans today\'s 4..21 on the legacy site, the site\'s daylight otherwise', () => {
  assert.deepEqual(daylightBand(null), [4, 21]);
  const legacy = { solar: solar({ legacy: true, daylightHours: [0, 23] }) } as unknown as Site;
  assert.deepEqual(daylightBand(legacy), [4, 21]);
  const north = { solar: solar({ daylightHours: [2, 23] }) } as unknown as Site;
  assert.deepEqual(daylightBand(north), [2, 23]);
});

/* ── the Solar page's captions are today's text with today's layout ───────────────────── */

test('★★★ the Solar page captions are word for word today\'s with the default layout', () => {
  const three = [DEFAULT_PV_STRINGS, DEFAULT_PV_STRINGS, DEFAULT_PV_STRINGS];
  assert.equal(arrayCaption(three), '42 panels · 400 W each · 10 HV + 4 LV per DPU');
  assert.equal(arrayCaption([]), '0 panels · 400 W each · 10 HV + 4 LV per DPU');
  assert.equal(flowCaption(three, three), '42 panels · 400 W each');
  assert.equal(flowCaption(three, three.slice(0, 2)), '42 installed · 28 shown · 400 W each');
  assert.equal(flowCaption([], []), '0 panels · 400 W each');
  assert.deepEqual(stringsFor(null, SN.c1), DEFAULT_PV_STRINGS);
});

test('the Solar page reads its strings, its day start and its spare rule from the site (source pins)', () => {
  const page = readFileSync(resolve(HERE, '../../web/src/pages/SolarPanel.tsx'), 'utf8');
  for (const pin of [
    'const site = useSite();',
    '{arrayCaption(equippedLayouts)}',
    '{flowCaption(installed, drawn.map((d) => stringsFor(site, d.sn)))}',
    '{strings.hv.count} × {strings.hv.watts} W',
    '{strings.lv.count} × {strings.lv.watts} W',
    'const since = zoneDayStartMs(Date.now(), siteZoneRef.current);',
    'if (panelSns.size > 0) for (const d of dpus) if (offPanelNotSpare(site, d.sn)) arraySns.add(d.sn);',
  ]) assert.ok(page.includes(pin), `SolarPanel.tsx: missing ${pin}`);
  for (const gone of ['HV_PANELS', 'LV_PANELS', 'PANEL_W', 'PANELS_PER_DPU', 'dayStart.setHours(0, 0, 0, 0)']) {
    assert.ok(!page.includes(gone), `SolarPanel.tsx still has ${gone}`);
  }
  const fd = readFileSync(resolve(HERE, '../../web/src/cards/ForecastDetail.tsx'), 'utf8');
  assert.ok(fd.includes('return orientationText(hour, site?.solar);'));
  assert.ok(fd.includes(': noPvDetail(benchSpareFlag(site, dm.sn))'));
  const src = readFileSync(resolve(HERE, '../../web/src/cards/SolarResponseCard.tsx'), 'utf8');
  assert.ok(src.includes('const [dayFrom, dayTo] = daylightBand(site);'));
  assert.ok(!src.includes('for (let h = 4; h <= 21; h++)'));
});

/* ── the site's day start (CA25) ───────────────────────────────────────────────────── */

test('★★ the Solar page\'s "today" starts at the site\'s midnight', () => {
  const now = Date.UTC(2026, 5, 21, 3, 0); // 12:00 in Tokyo, 20:00 the day before in Phoenix
  assert.equal(zoneDayStartMs(now, 'Asia/Tokyo'), Date.UTC(2026, 5, 20, 15, 0));
  assert.equal(zoneDayStartMs(now, 'America/Phoenix'), Date.UTC(2026, 5, 20, 7, 0));
  const browser = new Date(now); browser.setHours(0, 0, 0, 0);
  assert.equal(zoneDayStartMs(now, null), browser.getTime(), 'no site yet: the browser\'s midnight, as before');
  assert.equal(zoneDayStartMs(now, 'Not/AZone'), browser.getTime(), 'an unresolvable zone: the browser\'s midnight');
  // a DST day: Berlin's midnight before the March change is +01:00
  assert.equal(zoneDayStartMs(Date.UTC(2026, 2, 29, 12), 'Europe/Berlin'), Date.UTC(2026, 2, 28, 23, 0));
});

/* ── the spare label (plan 3.8 S3) ─────────────────────────────────────────────────── */

function siteWithFlags(flags: Record<string, boolean>): Site {
  return { perDpu: Object.fromEntries(Object.entries(flags).map(([sn, b]) => [sn, { benchSpare: b }])) } as unknown as Site;
}

test('★★★ without the server\'s flag every DPU off the panels stays a spare (today\'s rule)', () => {
  const none = siteWithFlags({});
  assert.equal(benchSpareFlag(none, SN.off), undefined);
  assert.equal(benchSpareFlag(null, SN.off), undefined);
  assert.equal(offPanelNotSpare(none, SN.off), false);
  assert.equal(noPvDetail(benchSpareFlag(none, SN.off)), "No recorded PV — offline gaps or an unwired spare; orientation can't be inferred yet.");
  const m = energyFlowModel(plant());
  assert.deepEqual(m.nonHomeSns, [SN.off]);
  const split = offPanelSplit(m, (sn) => benchSpareFlag(none, sn));
  assert.deepEqual(split, { spareCount: m.spareCount, offPanelCount: 0 });
  assert.equal(batteriesTitle({ ...m, ...split }), batteriesTitle(m), 'the title is today\'s');
  assert.equal(batteriesTitle(m), 'Batteries (3 DPU, +1 spare)');
  assert.equal(benchNote(5, offPanelPackCount([{ sn: SN.off, home: false }], (sn) => benchSpareFlag(none, sn))), '5 bench packs excluded');
});

test('★★★ with the flag: a unit it names is a spare; one it does not is "not on a panel" and keeps its array', () => {
  const site = siteWithFlags({ [SN.c1]: false, [SN.off]: false });
  assert.equal(offPanelNotSpare(site, SN.off), true);
  const m = energyFlowModel(plant());
  const split = offPanelSplit(m, (sn) => benchSpareFlag(site, sn));
  assert.deepEqual(split, { spareCount: 0, offPanelCount: 1 });
  assert.equal(batteriesTitle({ ...m, ...split }), 'Batteries (3 DPU, +1 not on a panel)');
  const packs = [{ sn: SN.c1, home: true }, { sn: SN.off, home: false }, { sn: SN.off, home: false }, { sn: 'Y711XXX00XXX0099', home: false }];
  assert.equal(offPanelPackCount(packs, (sn) => benchSpareFlag(site, sn)), 2);
  assert.equal(benchNote(3, 2), '1 bench pack and 2 packs not on a panel excluded');
  assert.equal(noPvDetail(false), "No recorded PV — offline gaps, or a Core with no array wired; orientation can't be inferred yet.");
  const spare = siteWithFlags({ [SN.off]: true });
  assert.deepEqual(offPanelSplit(m, (sn) => benchSpareFlag(spare, sn)), { spareCount: 1, offPanelCount: 0 });
  assert.equal(noPvDetail(true), "No recorded PV — a bench spare with no array; orientation can't be inferred.");
  assert.equal(benchNote(0, 0), null);
  assert.equal(benchNote(1), '1 bench pack excluded');
});

/* ── location: OWNER DECISION 5 ─────────────────────────────────────────────────────── */

const fetched = (lat: unknown, lon: unknown) => async (): Promise<HaCoreConfig> => ({ latitude: lat, longitude: lon });
const NEAR_PLACEHOLDER = { lat: DEFAULT_SITE_LAT + 0.2, lon: DEFAULT_SITE_LON - 0.2 }; // ~29 km
const BERLIN = { lat: 52.52, lon: 13.405 };

test('★★★ Home Assistant\'s home within 50 km of FORECAST_LAT/LON: silent (this install\'s shape)', async () => {
  await withEnv({}, async () => {
    assert.ok(distanceKm(NEAR_PLACEHOLDER, { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON }) < SITE_FAR_KM);
    const q = quiet();
    // FORECAST_LAT/LON hold the shipped default — the notice must NOT key on that
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(NEAR_PLACEHOLDER.lat, NEAR_PLACEHOLDER.lon) }), 'within');
    assert.deepEqual(q.lines, []);
    assert.deepEqual(siteRepairIssues(), []);
  });
});

test('★★★ Home Assistant\'s home more than 50 km away: a boot notice and a repair item, keyed on HA\'s coordinates', async () => {
  // at the default coordinates
  await withEnv({}, async () => {
    const q = quiet();
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(BERLIN.lat, BERLIN.lon) }), 'far');
    assert.equal(q.lines.filter((l) => l.level === 'warn').length, 1);
    assert.match(q.lines[0].m, /km from FORECAST_LAT\/LON/);
    assert.deepEqual(siteRepairIssues().map((i) => i.id), [SITE_REPAIR_IDS.locationFar]);
    // the issue clears once Home Assistant's home agrees again
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(NEAR_PLACEHOLDER.lat, NEAR_PLACEHOLDER.lon) }), 'within');
    assert.deepEqual(siteRepairIssues(), []);
  });
  // at deliberately chosen, non-default coordinates far from Home Assistant's home
  await withEnv({ FORECAST_LAT: '45.52', FORECAST_LON: '-122.68' }, async () => {
    const q = quiet();
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(NEAR_PLACEHOLDER.lat, NEAR_PLACEHOLDER.lon) }), 'far');
    assert.deepEqual(siteRepairIssues().map((i) => i.id), [SITE_REPAIR_IDS.locationFar]);
  });
  // and silent at non-default coordinates that match Home Assistant's home
  await withEnv({ FORECAST_LAT: '45.52', FORECAST_LON: '-122.68' }, async () => {
    const q = quiet();
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(45.6, -122.7) }), 'within');
    assert.deepEqual(siteRepairIssues(), []);
  });
});

test('no Home Assistant answer (outside the add-on, an error, no coordinates): nothing is raised', async () => {
  await withEnv({}, async () => {
    const q = quiet();
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: async () => null }), 'unavailable');
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(null, undefined) }), 'unavailable');
    assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(95, 0) }), 'unavailable');
    assert.equal(await fetchHaCoreConfig(), null, 'no SUPERVISOR_TOKEN: the default reader does not try the network');
    assert.deepEqual(q.lines, []);
    assert.deepEqual(siteRepairIssues(), []);
  });
});

test('★★★ SITE_LOCATION_FROM_HA: the home location is saved in the background and applies from the NEXT start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-location-'));
  const path = join(dir, 'site-location.json');
  try {
    await withEnv({ SITE_LOCATION_FROM_HA: 'true', SITE_LOCATION_PATH: path }, async () => {
      assert.equal(siteLocation().source, 'FORECAST_LAT/LON', 'nothing saved yet: FORECAST_LAT/LON');
      const q = quiet();
      assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(BERLIN.lat, BERLIN.lon) }), 'saved');
      assert.ok(existsSync(path));
      assert.match(q.lines[0].m, /from the next start/);
      // this run's coordinates do not change
      assert.deepEqual(siteLocation(), { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON, source: 'FORECAST_LAT/LON' });
      assert.deepEqual(siteRepairIssues().map((i) => i.id), [SITE_REPAIR_IDS.locationPending]);
      assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(BERLIN.lat, BERLIN.lon) }), 'unchanged');
      resetSiteForTesting(); // even a fresh read in this run ignores a location saved during it
      assert.equal(siteLocation().source, 'FORECAST_LAT/LON');
      // no >50 km notice while the option is on: Home Assistant's home IS the location
      assert.ok(!siteRepairIssues().some((i) => i.id === SITE_REPAIR_IDS.locationFar));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ SITE_LOCATION_FROM_HA: a location saved before this run is the site\'s, everywhere it is read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-location-'));
  const path = join(dir, 'site-location.json');
  writeFileSync(path, JSON.stringify({ lat: BERLIN.lat, lon: BERLIN.lon, savedAt: Date.now() - 86_400_000 }));
  try {
    await withEnv({ SITE_LOCATION_FROM_HA: 'true', SITE_LOCATION_PATH: path, PV_ARRAY_KWP: '5' }, async () => {
      assert.deepEqual(siteLocation(), { lat: BERLIN.lat, lon: BERLIN.lon, source: 'home-assistant' });
      assert.deepEqual(siteCoordinates(), { forecastLat: BERLIN.lat, forecastLon: BERLIN.lon }, 'the forecast, the storm alerts and the bridge read this');
      assert.equal(pvSite().lat, BERLIN.lat);
      assert.equal(siteResponse(plant(), null).locationSource, 'home-assistant');
      // Home Assistant moves the home: saved for the next start, this run unchanged, a restart asked for
      const q = quiet();
      assert.equal(await checkHaHomeLocation({ log: q.log, fetchConfig: fetched(48.14, 11.58) }), 'saved');
      assert.equal(siteLocation().lat, BERLIN.lat);
      assert.deepEqual(siteRepairIssues().map((i) => i.id), [SITE_REPAIR_IDS.locationPending]);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).lat, 48.14);
    });
    // the option off: the saved file is ignored
    await withEnv({ SITE_LOCATION_PATH: path }, () => {
      assert.equal(siteLocation().source, 'FORECAST_LAT/LON');
    });
    // a corrupt file reads as none
    writeFileSync(path, '{not json');
    await withEnv({ SITE_LOCATION_FROM_HA: 'true', SITE_LOCATION_PATH: path }, () => {
      assert.equal(siteLocation().source, 'FORECAST_LAT/LON');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── CA20: the reference home's defaults ───────────────────────────────────────────── */

test('★★★ CA20: silent on the reference install; each condition raises its own reason', () => {
  const ref = { zone: 'America/Phoenix', tariffPlanUnset: true, location: { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON }, pvConfigured: false };
  assert.deepEqual(referenceDefaultsReasons(ref), []);
  assert.equal(referenceDefaultsReasons({ ...ref, zone: 'Europe/Berlin' }).length, 1);
  assert.deepEqual(referenceDefaultsReasons({ ...ref, zone: 'Europe/Berlin', tariffPlanUnset: false }), [], 'a tariff plan is set');
  assert.equal(referenceDefaultsReasons({ ...ref, location: BERLIN }).length, 1);
  assert.deepEqual(referenceDefaultsReasons({ ...ref, location: BERLIN, pvConfigured: true }), [], 'a PV_* option is set');
  assert.deepEqual(referenceDefaultsReasons({ ...ref, location: NEAR_PLACEHOLDER }), [], 'within 50 km of the placeholder');
  assert.equal(referenceDefaultsReasons({ ...ref, zone: 'Asia/Tokyo', location: BERLIN }).length, 2);
});

test('★★★ the boot notices on this install\'s shape: one info line, no warning, no repair item', async () => {
  await withEnv({}, () => {
    const q = quiet();
    siteBootNotices(q.log, { rosterSize: 3 });
    assert.deepEqual(q.lines.map((l) => l.level), ['info']);
    assert.doesNotMatch(q.lines[0].m, /\d+\.\d{3}/, 'the line carries no coordinates');
    assert.deepEqual(siteRepairIssues(), []);
  });
});

test('the boot notices: the reference array far from the placeholder, an unreadable PV_STRINGS, strings against the nameplate', async () => {
  await withEnv({ FORECAST_LAT: String(BERLIN.lat), FORECAST_LON: String(BERLIN.lon) }, () => {
    const q = quiet();
    siteBootNotices(q.log, { rosterSize: 3 });
    assert.ok(q.lines.some((l) => l.level === 'warn' && /reference home's defaults/.test(l.m)));
    assert.deepEqual(siteRepairIssues().map((i) => i.id), [SITE_REPAIR_IDS.referenceDefaults]);
  });
  await withEnv({ PV_STRINGS: 'hv=lots' }, () => {
    const q = quiet();
    siteBootNotices(q.log, { rosterSize: 3 });
    assert.ok(q.lines.some((l) => l.level === 'warn' && /PV_STRINGS is not valid/.test(l.m)));
    assert.ok(siteRepairIssues().some((i) => i.id === SITE_REPAIR_IDS.pvStringsInvalid));
  });
  await withEnv({ PV_STRINGS: 'hv=10x400,lv=4x400', PV_ARRAY_KWP: '5' }, () => {
    const q = quiet();
    siteBootNotices(q.log, { rosterSize: 3 });
    assert.ok(q.lines.some((l) => l.level === 'warn' && /adds up to 16\.80 kWp over 3 panel Core\(s\) but PV_ARRAY_KWP is 5\.00 kWp/.test(l.m)));
  });
});

test('the legacy PV site stays the legacy object through /api/site\'s path', async () => {
  await withEnv({}, () => {
    assert.equal(isLegacyPvSite(pvSite()), true);
    assert.equal(pvSite(), PHOENIX_SITE);
  });
});

/* ── wiring: every reader of the coordinates and the array goes through site.ts ──────────── */

test('★★★ production reads the site through site.ts: the forecast, the storm alerts, the bridge, the noise, the curtailment cap', () => {
  const src = (f: string) => readFileSync(resolve(HERE, '../src', f), 'utf8');
  assert.ok(src('weather.ts').includes('  const { forecastLat: lat, forecastLon: lon } = siteCoordinates();'));
  assert.equal(src('nws.ts').split('  const { forecastLat: lat, forecastLon: lon } = siteCoordinates();').length - 1, 2);
  assert.ok(src('recorder.ts').includes('    site: () => bridgeSite(siteCoordinates()),'));
  assert.ok(src('analytics.ts').includes('export const BAYES_OBS_SIGMA2 = (0.10 * pvSite().pNamplate) ** 2;'));
  assert.ok(src('analytics.ts').includes('    expectedW = post.posteriorMean * curtailGhiCapWm2();'));
  for (const f of ['analytics.ts', 'energyBridge.ts', 'weather.ts', 'nws.ts', 'recorder.ts']) {
    assert.ok(!src(f).includes('forecastLat: lat, forecastLon: lon } = config'), `${f} reads the coordinates past site.ts`);
  }
});
