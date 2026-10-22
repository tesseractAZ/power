#!/usr/bin/env node
/**
 * mutate-v1191-s7.mjs — v1.191.0 S7 (lane C): the PV array and site physics, GET /api/site, the
 * location notice and SITE_LOCATION_FROM_HA, CA20's reference-defaults notice, the web's solar
 * assumptions (CA24) and the spare label (plan 3.8 S3).
 *
 *   S7-i      pvSite() ignores PV_ARRAY_KWP (a 5 kWp array is sized as 16.8 kWp)
 *   S7-ii     the configured site still uses the placeholder's latitude and longitude
 *   S7-iii    the observation noise is pinned at 16 800 W
 *   S7-iv     the >50 km notice keys on FORECAST_LAT/LON equalling the default, not on HA's home
 *   S7-v      the legacy site is a copy, not the legacy object (isLegacyPvSite fails; the ambient follows the weather)
 *   S7-vi     only PV_ARRAY_KWP makes the site configured (tilt / azimuth / strings alone do not)
 *   S7-vii    a configured site ignores the weather cache's temperature
 *   S7-viii   the legacy site takes the weather's temperature (G5's 30 °C moves)
 *   S7-ix     a configured site's curtailment cap stays 900
 *   S7-x      a configured site's curtailment cap is not capped at 900
 *   S7-xi     the curtailment estimator keeps the literal 900
 *   S7-xii    a PV_STRINGS slot override is ignored
 *   S7-xiii   a slot override wins over a name override
 *   S7-xiv    a string an override leaves out takes today's layout, not the configured global one
 *   S7-xv     an unreadable PV_STRINGS keeps its readable parts (not fail-closed)
 *   S7-xvi    the per-DPU bench-spare flag is sent while BENCH_SPARE_SNS is unset (the Solar page changes)
 *   S7-xvii   a Home Assistant location saved during this run is applied in-run
 *   S7-xviii  SITE_LOCATION_FROM_HA is ignored
 *   S7-xix    CA20 fires on the far placeholder although a PV_* option is set
 *   S7-xx     CA20 fires on a foreign zone although TARIFF_PLAN is set
 *   S7-xxi    the boot's CA20 check judges the placeholder, not the site's location
 *   S7-xxii   the forecast fetch reads past siteCoordinates()
 *   S7-xxiii  the web keeps the shifted bands on the legacy site
 *   S7-xxiv   the web's bands ignore the southern hemisphere
 *   S7-xxv    the web's daylight band moves on the legacy site
 *   S7-xxvi   an absent bench-spare flag reads as "not on a panel"
 *   S7-xxvii  the Solar page's day start ignores the site zone
 *   S7-xxviii the physics endpoint keeps a fixed 30 °C on a configured site
 *   S7-xxix   the repair list leaves the site's items out
 *   S7-xxx    the energy bridge takes the placeholder from config.ts (loads the environment on a static import)
 *
 *   cd server && node ../scripts/mutate-v1191-s7.mjs      (or from the repo root)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(REPO, 'server/src/site.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const WX = resolve(REPO, 'server/src/weather.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const FACTS = resolve(REPO, 'web/src/siteFacts.ts');
const FLOW = resolve(REPO, 'web/src/cards/energyFlowModel.ts');
const SUBSET = ['test/pvSite.test.ts', 'test/site.test.ts', 'test/siteIndexWiring.test.ts'];

const MUTANTS = [
  {
    id: 'S7-i. ★★★ pvSite() ignores PV_ARRAY_KWP',
    file: SITE,
    find: '    pNamplate: kwp != null ? kwp * 1000 : PHOENIX_SITE.pNamplate,',
    to: '    pNamplate: PHOENIX_SITE.pNamplate, /* MUTANT */',
    why: 'A 5 kWp home is scored against a 16.8 kWp clear-sky maximum: "producing 30 % of physics" on a perfect day.',
  },
  {
    id: 'S7-ii. ★★★ the configured site still uses the placeholder\'s latitude and longitude',
    file: SITE,
    find: '    lat: usable ? loc.lat : DEFAULT_SITE_LAT,\n    lon: usable ? loc.lon : DEFAULT_SITE_LON,',
    to: '    lat: PHOENIX_SITE.lat,\n    lon: PHOENIX_SITE.lon, /* MUTANT */',
    why: 'Another home\'s array is modelled under the reference city\'s sun: noon, day length and the curtailment cap are all off.',
  },
  {
    id: 'S7-iii. ★★★ the observation noise is pinned at 16 800 W',
    file: AN,
    find: 'export const BAYES_OBS_SIGMA2 = (0.10 * pvSite().pNamplate) ** 2;',
    to: 'export const BAYES_OBS_SIGMA2 = (0.10 * 16_800) ** 2; /* MUTANT */',
    why: 'A 5 kWp array\'s learner treats ±1.7 kW as noise — a third of its output — and never moves its posterior.',
  },
  {
    id: 'S7-iv. ★★★ the >50 km notice keys on the default coordinates, not on Home Assistant\'s home',
    file: SITE,
    find: '  if (km > SITE_FAR_KM) {\n    const how',
    to: '  if (configured.lat === DEFAULT_SITE_LAT && configured.lon === DEFAULT_SITE_LON) { /* MUTANT */\n    const how',
    why: 'The reference install, whose FORECAST_LAT/LON are persisted at the default and match its home, gets a false repair item; a home that chose wrong coordinates gets none.',
  },
  {
    id: 'S7-v. ★★★ the legacy site is a copy, not the legacy object',
    file: SITE,
    find: '  if (!pvConfigured()) return PHOENIX_SITE;',
    to: '  if (!pvConfigured()) return { ...PHOENIX_SITE }; /* MUTANT */',
    why: 'isLegacyPvSite fails on the reference install: the physics ambient follows the weather and the web drops today\'s bands.',
  },
  {
    id: 'S7-vi. ★★ only PV_ARRAY_KWP makes the site configured',
    file: SITE,
    find: '  return PV_KEYS.some((k) => option<unknown>(k) != null);',
    to: "  return option<unknown>('PV_ARRAY_KWP') != null; /* MUTANT */",
    why: 'Setting the tilt or the strings leaves the array on the placeholder coordinates while the user believes it is configured.',
  },
  {
    id: 'S7-vii. ★★ a configured site ignores the weather cache\'s temperature',
    file: SITE,
    find: '  return h && Number.isFinite(h.tempC) ? h.tempC : LEGACY_PHYSICS_AMBIENT_C;',
    to: '  return LEGACY_PHYSICS_AMBIENT_C; /* MUTANT */',
    why: 'A cold, clear winter noon is modelled at 30 °C: the physics maximum is understated and the score reads above 100 %.',
  },
  {
    id: 'S7-viii. ★★★ the legacy site takes the weather\'s temperature',
    file: SITE,
    find: '  if (isLegacyPvSite(site)) return LEGACY_PHYSICS_AMBIENT_C;\n  const hourMs',
    to: '  /* MUTANT */\n  const hourMs',
    why: 'The reference install\'s /api/physics/pv-pmax moves with the weather: golden G5\'s 30 °C is gone.',
  },
  {
    id: 'S7-ix. ★★ a configured site\'s curtailment cap stays 900',
    file: SITE,
    find: '  return Math.min(LEGACY_CURTAIL_GHI_CAP_WM2, Math.round(maxNoonClearSkyGhiWm2(site.lat)));',
    to: '  return LEGACY_CURTAIL_GHI_CAP_WM2; /* MUTANT */',
    why: 'At 60° N the no-weather hour assumes more sun than the clear sky can give: curtailment is overstated.',
  },
  {
    id: 'S7-x. ★★ a configured site\'s curtailment cap is not capped at 900',
    file: SITE,
    find: '  return Math.min(LEGACY_CURTAIL_GHI_CAP_WM2, Math.round(maxNoonClearSkyGhiWm2(site.lat)));',
    to: '  return Math.round(maxNoonClearSkyGhiWm2(site.lat)); /* MUTANT */',
    why: 'A sunbelt site\'s cap rises past the conservative 900 W/m² the heuristic was written to guard.',
  },
  {
    id: 'S7-xi. ★★★ the curtailment estimator keeps the literal 900',
    file: AN,
    find: '    expectedW = post.posteriorMean * curtailGhiCapWm2();',
    to: '    expectedW = post.posteriorMean * 900; /* MUTANT */',
    why: 'The site cap is computed and never used: the no-weather hour is the reference city\'s everywhere.',
  },
  {
    id: 'S7-xii. ★★★ a PV_STRINGS slot override is ignored',
    file: SITE,
    find: '    ?? (core.slot != null ? spec.bySlot.get(core.slot) : undefined);',
    to: '    ?? undefined; /* MUTANT */',
    why: 'The Core in slot 2 is drawn with the global strings (CA23): the Solar page shows panels that are not on the roof.',
  },
  {
    id: 'S7-xiii. ★★ a slot override wins over a name override',
    file: SITE,
    find: '  const o = (core.name != null ? spec.byName.get(normName(core.name)) : undefined)\n    ?? (core.slot != null ? spec.bySlot.get(core.slot) : undefined);',
    to: '  const o = (core.slot != null ? spec.bySlot.get(core.slot) : undefined) /* MUTANT */\n    ?? (core.name != null ? spec.byName.get(normName(core.name)) : undefined);',
    why: 'A Core moved to another slot takes that slot\'s strings although its own name is listed.',
  },
  {
    id: 'S7-xiv. ★★ a string an override leaves out takes today\'s layout, not the configured one',
    file: SITE,
    find: '  return { hv: o?.hv ?? spec.global.hv, lv: o?.lv ?? spec.global.lv };',
    to: '  return { hv: o?.hv ?? DEFAULT_PV_STRINGS.hv, lv: o?.lv ?? DEFAULT_PV_STRINGS.lv }; /* MUTANT */',
    why: '`hv=12x410,lv=6x410; slot2=hv=8x450` draws slot 2\'s LV string as 4 × 400 W.',
  },
  {
    id: 'S7-xv. ★★★ an unreadable PV_STRINGS keeps its readable parts',
    file: SITE,
    find: '  if (errors.length > 0) return { ...spec, errors };',
    to: '  if (false) return { ...spec, errors }; /* MUTANT */',
    why: 'A typo is half-applied and no repair item is raised: the page shows a layout nobody wrote.',
  },
  {
    id: 'S7-xvi. ★★★ the per-DPU bench-spare flag is sent while BENCH_SPARE_SNS is unset',
    file: SITE,
    find: '    if (flagOn) perDpu[d.sn] = { benchSpare: isBenchSpareSn(d.sn, lastKnownRoster) };',
    to: '    perDpu[d.sn] = { benchSpare: isBenchSpareSn(d.sn, lastKnownRoster) }; /* MUTANT */',
    why: 'The reference install\'s real bench unit is not in the literal: the Solar page draws it with an array, "not on a panel" (plan 3.8 S3).',
  },
  {
    id: 'S7-xvii. ★★★ a Home Assistant location saved during this run is applied in-run',
    file: SITE,
    find: '  savedMemo = s && s.savedAt < PROCESS_START_MS ? { lat: s.lat, lon: s.lon } : null;',
    to: '  savedMemo = s ? { lat: s.lat, lon: s.lon } : null; /* MUTANT */',
    why: 'The analytics worker reads the file after the main thread saved it: two instances, two sites (CA17).',
  },
  {
    id: 'S7-xviii. ★★★ SITE_LOCATION_FROM_HA is ignored',
    file: SITE,
    find: "    const saved = savedForThisRun();\n    if (saved) return { ...saved, source: 'home-assistant' };",
    to: "    const saved = null as { lat: number; lon: number } | null; /* MUTANT */\n    if (saved) return { ...saved, source: 'home-assistant' };",
    why: 'The option is shown, saved and documented, and the forecast keeps the placeholder: an inert option.',
  },
  {
    id: 'S7-xix. ★★ CA20 fires on the far placeholder although a PV_* option is set',
    file: SITE,
    find: '  if (km > SITE_FAR_KM && !i.pvConfigured) {',
    to: '  if (km > SITE_FAR_KM) { /* MUTANT */',
    why: 'A home that configured its array is still told the reference array is in effect.',
  },
  {
    id: 'S7-xx. ★★ CA20 fires on a foreign zone although TARIFF_PLAN is set',
    file: SITE,
    find: '  if (i.zone !== REFERENCE_ZONE && i.tariffPlanUnset) {',
    to: '  if (i.zone !== REFERENCE_ZONE) { /* MUTANT */',
    why: 'A home on its own tariff is told the APS preset applies.',
  },
  {
    id: 'S7-xxi. ★★ the boot\'s CA20 check judges the placeholder, not the site\'s location',
    file: SITE,
    find: '  const reasons = referenceDefaultsReasons({ zone: siteZoneInput(), tariffPlanUnset: tariffPlanUnsetInput(), location: loc, pvConfigured: configured });',
    to: '  const reasons = referenceDefaultsReasons({ zone: siteZoneInput(), tariffPlanUnset: tariffPlanUnsetInput(), location: { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON }, pvConfigured: configured }); /* MUTANT */',
    why: 'A home far from the placeholder with no PV_* option is never told the reference array is in use.',
  },
  {
    id: 'S7-xxii. ★★ the forecast fetch reads past siteCoordinates()',
    file: WX,
    find: '  const { forecastLat: lat, forecastLon: lon } = siteCoordinates();',
    to: '  const { forecastLat: lat, forecastLon: lon } = { forecastLat: 33.4484, forecastLon: -112.074 }; /* MUTANT */',
    why: 'SITE_LOCATION_FROM_HA (and FORECAST_LAT/LON) stop reaching Open-Meteo: every solar prediction is the placeholder city\'s.',
  },
  {
    id: 'S7-xxiii. ★★★ the web keeps the shifted bands on the legacy site',
    file: FACTS,
    find: '  const legacy = !solar || solar.legacy;',
    to: '  const legacy = !solar; /* MUTANT */',
    why: 'The reference install\'s "Peak output around …" text moves by the half hour between clock noon and solar noon (CA24).',
  },
  {
    id: 'S7-xxiv. ★★ the web\'s bands ignore the southern hemisphere',
    file: FACTS,
    find: "  const equator = !legacy && solar.hemisphere === 'south' ? 'north' : 'south';",
    to: "  const equator = 'south'; /* MUTANT */",
    why: 'A north-facing southern roof is described as facing south.',
  },
  {
    id: 'S7-xxv. ★★ the web\'s daylight band moves on the legacy site',
    file: FACTS,
    find: '  if (!s || s.legacy) return [4, 21];',
    to: '  if (!s) return [4, 21]; /* MUTANT */',
    why: 'The reference install\'s learned-response chart gains or loses rows.',
  },
  {
    id: 'S7-xxvi. ★★★ an absent bench-spare flag reads as "not on a panel"',
    file: FLOW,
    find: '  const offPanelCount = m.nonHomeSns.filter((sn) => benchSpare(sn) === false).length;',
    to: '  const offPanelCount = m.nonHomeSns.filter((sn) => !benchSpare(sn)).length; /* MUTANT */',
    why: 'With BENCH_SPARE_SNS unset the energy-flow title stops saying "+1 spare" on the reference install.',
  },
  {
    id: 'S7-xxvii. ★★ the Solar page\'s day start ignores the site zone',
    file: FACTS,
    find: '  const off = zoneOffsetMin(nowMs, zone);\n  if (off == null) return browser();',
    to: '  const off = null as number | null; /* MUTANT */\n  if (off == null) return browser();',
    why: 'A viewer in another zone queries another "today" from the server (CA25).',
  },
  {
    id: 'S7-xxviii. ★★ the physics endpoint keeps a fixed 30 °C on a configured site',
    file: IDX,
    find: '  const result = physicsPmax(ts, ambient, site);',
    to: '  const result = physicsPmax(ts, 30, site); /* MUTANT */',
    why: 'The weather plumbing is computed and dropped (P2).',
  },
  {
    id: 'S7-xxix. ★★ the repair list leaves the site\'s items out',
    file: IDX,
    find: '  return cached(req, reply, { ...report, issues: [...report.issues, ...siteRepairIssues()] }, 60);',
    to: '  return cached(req, reply, report, 60); /* MUTANT */',
    why: 'The >50 km and reference-defaults notices reach the log only; nothing a Home Assistant automation can see.',
  },
  {
    id: 'S7-xxx. ★★ the energy bridge takes the placeholder from config.ts',
    file: resolve(REPO, 'server/src/energyBridge.ts'),
    find: "import { DEFAULT_SITE_LAT, DEFAULT_SITE_LON } from './siteDefaults.js';",
    to: "import { DEFAULT_SITE_LAT, DEFAULT_SITE_LON } from './config.js'; /* MUTANT */",
    why: 'A test that imports the bridge statically freezes config.ts before it sets DB_PATH: the recorder opens another database (the suite\'s held-sample and boot tests fail far from the cause).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants.
await runMutantsParallel({ name: 'mutate-v1191-s7', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
