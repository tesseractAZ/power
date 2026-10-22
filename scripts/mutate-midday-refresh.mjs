#!/usr/bin/env node
/**
 * mutate-midday-refresh.mjs — R5 (v1.189.0): the winter mid-day cycle's words and its morning
 * refresh (plan §3.4, §5, §7). The live refresh of an armed mid-day cost leg is built and inert until
 * the mid-day switch (morningRefresh.ts, index.ts runMorningRefreshTickInner): lower-only against the
 * announced level, once, re-read after its await, stamped before it pushes, a push and never
 * speech, on a forecast the worker builds on weather at most 45 minutes old (the reports'
 * maxWeatherAgeMs, getWeather's maxAgeMs, getDayForecast's maxWeatherAgeMs). The day-aware words
 * (chargeText.ts) reach only a super off-peak leg (chargeAnnounce.ts); an overnight cycle keeps its
 * words byte for byte (overnightTextGolden.test.ts); the shadow logs and shows what the evening and
 * the refresh would say, and sends none of it.
 *
 *   Refresh    R-i..R-xxiii   (liveRefreshDue, refreshPastDeadline, refreshWeatherFresh, refreshAborted,
 *                              liveRefreshOutcome, applyLiveRefresh: inert on every overnight leg, once,
 *                              lower-only on every written value, a deadline after the await)
 *   Wiring     I-i..I-vii     (index.ts: fresh weather from the worker, defer, re-read, stamp first,
 *                              the deadline on the clock after the await)
 *   Worker     W-i..W-xi      (getWeather maxAgeMs, getDayForecast maxWeatherAgeMs, the band, the
 *                              reports, the planner's call, every other caller unchanged)
 *   Words      T-i..T-xix     (the 560 bound and the shapes within it by construction, no worst case
 *                              spoken or headlined, no placeholder spoken, the cushion clause, the
 *                              formatter, the restore and cancel times, the summary, the page)
 *   Route      A-i..A-vi      (overnight legs keep the overnight words; the summary and the page; the
 *                              missed-apply push's words through the formatter's clocks)
 *   Shadow     S-i..S-vi      (nothing of the preview is sent or spoken; the weather age; what it names)
 *   Basis      Q-i..Q-iv      (a refresh after the live overnight charge wrote is not comparable: not
 *                              re-sized, the evening figures stand)
 *   Page       T-xx           (the mid-day push says the restore is retried only while it is)
 *   Fix 2      R-xxiv..R-xxviii, T-xxi..T-xxii, I-viii (one refresh rule for the shadow and the live
 *                             refresh: a reserve above the announced one is a cap, and is said so)
 *   Fix 3      R-xxix (a cap keeps the announced worst case: the entity, the shadow ledger and the live
 *                             refreshed_buy_kwh hold the figure the leg runs on)
 *
 *   node scripts/mutate-midday-refresh.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MR = resolve(REPO, 'server/src/morningRefresh.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const WX = resolve(REPO, 'server/src/weather.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const REP = resolve(REPO, 'server/src/reports.ts');
const TXT = resolve(REPO, 'server/src/chargeText.ts');
const RT = resolve(REPO, 'server/src/chargeAnnounce.ts');
const MS = resolve(REPO, 'server/src/middayShadow.ts');
const NTF = resolve(REPO, 'server/src/notify.ts');
const SUBSET = [
  'test/morningRefresh.test.ts',
  'test/middayAnnounce.test.ts',
  'test/overnightTextGolden.test.ts',
  'test/middayShadow.test.ts',
  'test/legacyIdentity.test.ts',
];

const MUTANTS = [
  /* ── the live refresh: inert on every overnight leg, once, lower-only ── */
  {
    id: 'R-i. ★★★ the refresh finds an overnight cost leg',
    file: MR,
    find: "  if (leg.windowKind !== 'super_off_peak' || leg.leg !== 'cost') return null;",
    to: "  if (leg.leg !== 'cost') return null; /* MUTANT */",
    why: 'Inert no more: tonight\'s overnight leg is re-planned and lowered or cancelled at 22:30–22:55.',
  },
  {
    id: 'R-ii. ★★★ the refresh finds a backup leg',
    file: MR,
    find: "  if (leg.windowKind !== 'super_off_peak' || leg.leg !== 'cost') return null;",
    to: "  if (leg.windowKind !== 'super_off_peak') return null; /* MUTANT */",
    why: 'The outage backup is re-planned as a cost leg.',
  },
  {
    id: 'R-iii. ★★★ the refresh runs again after it ran (or after a restart)',
    file: MR,
    find: '  if (leg.applyAttemptedAtMs != null || leg.appliedAtMs != null || leg.refreshedAtMs != null) return null;',
    to: '  if (leg.applyAttemptedAtMs != null || leg.appliedAtMs != null) return null; /* MUTANT */',
    why: 'Each minute lowers again against the last refresh, and pushes again.',
  },
  {
    id: 'R-iv. ★★★ the refresh runs after the write was attempted',
    file: MR,
    find: '  if (leg.applyAttemptedAtMs != null || leg.appliedAtMs != null || leg.refreshedAtMs != null) return null;',
    to: '  if (leg.refreshedAtMs != null) return null; /* MUTANT */',
    why: 'A written leg is re-planned under the actuator.',
  },
  {
    id: 'R-v. ★★ the refresh runs on a cancelled leg',
    file: MR,
    find: '  if (leg.day == null || leg.announcedAtMs == null || leg.cancelled) return null;',
    to: '  if (leg.day == null || leg.announcedAtMs == null) return null; /* MUTANT */',
    why: 'A leg the owner cancelled is re-planned and announced again.',
  },
  {
    id: 'R-vi. ★★ the refresh ignores an open trailing leg',
    file: MR,
    find: '  if (c.trailing != null && !trailingResolved(c.trailing)) return null;',
    to: '  /* MUTANT */',
    why: 'A leg that cannot start (a force-charge OFF still unverified) is refreshed and pushed as if it would.',
  },
  {
    id: 'R-vii. ★★ the evening arm never stands: the refresh runs into the open',
    file: MR,
    find: "  if (nowMs >= open - REFRESH_DEADLINE_MS) return 'stand';",
    to: '  /* MUTANT */',
    why: 'A refresh can land in the minutes the write is being applied.',
  },
  {
    id: 'R-viii. ★★★ the refresh acts on weather two hours old',
    file: MR,
    find: 'export const REFRESH_MAX_WEATHER_AGE_MS = 45 * 60_000;',
    to: 'export const REFRESH_MAX_WEATHER_AGE_MS = 120 * 60_000; /* MUTANT */',
    why: 'The "morning solar forecast" is last night\'s worker cache.',
  },
  {
    id: 'R-ix. ★★★ weather of unknown age counts as fresh',
    file: MR,
    find: '  return weatherFetchedAtMs != null && Number.isFinite(weatherFetchedAtMs) && nowMs - weatherFetchedAtMs <= REFRESH_MAX_WEATHER_AGE_MS;',
    to: '  return weatherFetchedAtMs == null || nowMs - weatherFetchedAtMs <= REFRESH_MAX_WEATHER_AGE_MS; /* MUTANT */',
    why: 'A forecast with no weather behind it re-plans the charge.',
  },
  {
    id: 'R-x. ★★★ the re-read misses a cancel made during the await',
    file: MR,
    find: "  if (after.cancelled !== before.cancelled) return 'the leg was cancelled';",
    to: '  /* MUTANT */',
    why: 'The refresh writes the pre-cancel leg back over the owner\'s cancel.',
  },
  {
    id: 'R-xi. ★★ the re-read misses a write attempted during the await',
    file: MR,
    find: "  if (after.applyAttemptedAtMs !== before.applyAttemptedAtMs || after.appliedAtMs != null) return 'the write was attempted';",
    to: '  /* MUTANT */',
    why: 'The refresh overwrites the attempt stamps of a write in flight.',
  },
  {
    id: 'R-xii. ★★★ a leg with no announced level is refreshed (no consent ceiling)',
    file: MR,
    find: '  if (leg.announcedLevelPct == null || !Number.isFinite(leg.announcedLevelPct)) {',
    to: '  if (leg.announcedLevelPct == null || !Number.isFinite(leg.announcedLevelPct)) { leg = { ...leg, announcedLevelPct: 100 }; } /* MUTANT */\n  if (leg.announcedLevelPct == null) {',
    why: 'With nothing to cap it, the refresh raises the charge to whatever the morning asks.',
  },
  {
    id: 'R-xiii. ★★★ the outcome states a reserve above the armed one',
    file: MR,
    find: '  const reserve = armedReserve == null || capped ? armedReserve : Math.min(armedReserve, r.reservePct ?? armedReserve);',
    to: '  const reserve = r.reservePct ?? armedReserve; /* MUTANT */',
    why: 'The log, the ledger and the push name a raised reserve.',
  },
  {
    id: 'R-xiv. ★★★ the outcome raises the force-charge ceiling',
    file: MR,
    find: '  const ceiling = capped || armedCeiling == null ? armedCeiling : re == null ? null : Math.min(armedCeiling, re);',
    to: '  const ceiling = capped || armedCeiling == null ? armedCeiling : re; /* MUTANT */',
    why: 'A lowered level arrives with a higher Charge Now stop.',
  },
  {
    id: 'R-xx. ★★★ a higher reserve than announced is not a cap',
    file: MS,
    find: '    || (a.reservePct != null && r.reservePct > a.reservePct + 1e-9));',
    to: '    || false); /* MUTANT */',
    why: 'The morning asks for more reserve than the push announced: the refresh — live, and the shadow it is judged on — reads it as a lowering and states a figure sized on a reserve it will not write.',
  },
  {
    id: 'R-xxi. ★★ the push is judged on the re-plan, not on what is written',
    file: MR,
    find: '    wouldPush: capped || written || moved,',
    to: '    wouldPush: r.wouldPush, /* MUTANT */',
    why: 'A refresh that writes nothing new pushes "updated" (the shadow rule counts a reserve it will not write).',
  },
  {
    id: 'R-xxii. ★★★ a cap states the expected figure of a re-plan it will not write',
    file: MS,
    find: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true,",
    to: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: r.expectedBuyKwh, wouldPush: true, /* MUTANT */",
    why: 'The capped push and the ledger state a draw sized on a reserve or a level that is not written.',
  },
  {
    id: 'R-xxiv. ★★★ a shadow cap records the re-plan\'s reserve',
    file: MS,
    find: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true,",
    to: "      disposition: 'capped', levelPct: a.levelPct, reservePct: r.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true, /* MUTANT */",
    why: 'The ledger and the entity show a 45% reserve the live refresh would never write.',
  },
  {
    id: 'R-xxv. ★★ a shadow cap records the re-plan\'s lower level',
    file: MS,
    find: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true,",
    to: "      disposition: 'capped', levelPct: r.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true, /* MUTANT */",
    why: 'A cap that writes nothing is shown with the stop it did not lower.',
  },
  {
    id: 'R-xxvi. ★★ a cap is not pushed',
    file: MS,
    find: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true,",
    to: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: false, /* MUTANT */",
    why: 'The owner is not told the morning asked for more than was announced.',
  },
  {
    id: 'R-xxix. ★★★ a cap publishes the re-plan\'s worst case',
    file: MS,
    find: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: a.buyKwh, expectedBuyKwh: null, wouldPush: true,",
    to: "      disposition: 'capped', levelPct: a.levelPct, reservePct: a.reservePct, buyKwh: r.buyKwh, expectedBuyKwh: null, wouldPush: true, /* MUTANT */",
    why: 'midday_charge_buy_kwh, shadow_refreshed_buy_kwh and the live refreshed_buy_kwh hold a worst case sized on a level and reserve that are not written; the de-bias learner reads it as the figure the leg ran on.',
  },
  {
    id: 'R-xxvii. ★★ the shadow forgets the reserve the re-plan asked for',
    file: MS,
    find: '    neededReservePct: refreshedReserve,',
    to: '    neededReservePct: null, /* MUTANT */',
    why: 'The preview of a reserve cap cannot say what the morning called for.',
  },
  {
    id: 'R-xxviii. ★★ the live outcome drops the reserve the re-plan asked for',
    file: MR,
    find: '  const neededReservePct = refreshedReserve;',
    to: '  const neededReservePct = null; /* MUTANT */',
    why: 'The live push of a reserve cap cannot say what the morning called for.',
  },
  {
    id: 'R-xxiii. ★★★ the refresh has no deadline after its await',
    file: MR,
    find: '  return open == null || !Number.isFinite(open) || atMs >= open - REFRESH_DEADLINE_MS;',
    to: '  return open == null || !Number.isFinite(open); /* MUTANT */',
    why: 'A slow planner rewrites the leg at 09:59 or after the open, past the time the evening arm stands.',
  },
  {
    id: 'R-xv. ★★★ the write takes the outcome\'s reserve as stated',
    file: MR,
    find: '    targetPct: min(leg.targetPct, o.reservePct),',
    to: '    targetPct: o.reservePct ?? leg.targetPct, /* MUTANT */',
    why: 'One guard left: an outcome that ever states a higher reserve writes it.',
  },
  {
    id: 'R-xvi. ★★★ the write takes the outcome\'s ceiling as stated',
    file: MR,
    find: '    forceChargeCeilingPct: leg.forceChargeCeilingPct == null ? null : o.forceChargeCeilingPct == null ? null : Math.min(leg.forceChargeCeilingPct, o.forceChargeCeilingPct),',
    to: '    forceChargeCeilingPct: o.forceChargeCeilingPct, /* MUTANT */',
    why: 'One guard left: an outcome that ever states a higher ceiling writes it.',
  },
  {
    id: 'R-xvii. ★★★ a cap writes the re-plan',
    file: MR,
    find: "  if (o.disposition !== 'lowered') return stamped;",
    to: "  if (o.disposition === 'unchanged' || o.disposition === 'stood') return stamped; /* MUTANT */",
    why: 'A refresh that asked for more than the consent rewrites the leg anyway.',
  },
  {
    id: 'R-xviii. ★★★ a hold does not cancel the leg',
    file: MR,
    find: "  if (o.disposition === 'cancelled') return { ...stamped, cancelled: true };",
    to: "  if (o.disposition === 'cancelled') return stamped; /* MUTANT */",
    why: 'The push says "cancelled" and the 10:00 write still fires.',
  },
  {
    id: 'R-xix. ★★★ the refresh is never stamped',
    file: MR,
    find: '  const stamped: ChargeLegState = { ...leg, refreshedAtMs: nowMs };',
    to: '  const stamped: ChargeLegState = { ...leg }; /* MUTANT */',
    why: 'It runs every minute, and again after a restart.',
  },

  /* ── index.ts: the live refresh ── */
  {
    id: 'I-i. ★★★ the refresh reads the worker\'s cache as it stands (no maxWeatherAgeMs)',
    file: IDX,
    find: '  const r = await recomputeNightChargePlan({ shadowLeg: sizing, maxWeatherAgeMs: REFRESH_MAX_WEATHER_AGE_MS });',
    to: '  const r = await recomputeNightChargePlan({ shadowLeg: sizing }); /* MUTANT */',
    why: 'The re-plan runs on the 2 h weather cache and the 30 min forecast, not the morning forecast.',
  },
  {
    id: 'I-ii. ★★★ a forecast on stale weather does not defer',
    file: IDX,
    find: '  if (!refreshWeatherFresh(wxAt, at)) {',
    to: '  if (!refreshWeatherFresh(wxAt, at) && wxAt === -1) { /* MUTANT */',
    why: 'A failed weather fetch re-plans the charge on the evening\'s weather and calls it the morning\'s.',
  },
  {
    id: 'I-iii. ★★★ no re-read after the await',
    file: IDX,
    find: '  const aborted = refreshAborted(leg, live);',
    to: '  const aborted = null as string | null; /* MUTANT */',
    why: 'A cancel or a re-arm during the planner\'s await is overwritten.',
  },
  {
    id: 'I-iv. ★★★ stamped after the push',
    file: IDX,
    find: '  persistNightActuation(applyLiveRefresh(live, o, at)); // stamped before anything is pushed (plan §3.4 step 4)',
    to: '  setTimeout(() => persistNightActuation(applyLiveRefresh(live, o, at)), 0); /* MUTANT */',
    why: 'A crash between the push and the stamp refreshes — and pushes — again.',
  },
  {
    id: 'I-v. ★★★ the refresh is spoken',
    file: IDX,
    find: '  // A push, never speech (plan §3.4 step 5); not awaited.\n  if (msg != null) {',
    to: "  if (msg != null) void broadcast.announce('medium', msg.title, msg.title); /* MUTANT */\n  if (msg != null) {",
    why: 'A morning correction plays on the speakers.',
  },
  {
    id: 'I-vi. ★★★ the deadline is judged on the clock from before the await',
    file: IDX,
    find: '  if (refreshPastDeadline(leg, at)) {',
    to: '  if (refreshPastDeadline(leg, nowMs)) { /* MUTANT */',
    why: 'A planner answer that took six minutes is written at 09:58 against a 09:52 clock.',
  },
  {
    id: 'I-vii. ★★★ no deadline after the await',
    file: IDX,
    find: '  if (refreshPastDeadline(leg, at)) {',
    to: '  if (false) { /* MUTANT */',
    why: 'The refresh can lower the leg after the evening arm was due to stand, or after the open.',
  },

  /* ── the worker: fresh weather on request, every other caller unchanged ── */
  {
    id: 'W-i. ★★★ getWeather ignores the caller\'s maxAgeMs',
    file: WX,
    find: '  const ttl = weatherMaxAgeMs(opts.maxAgeMs);',
    to: '  const ttl = weatherMaxAgeMs(undefined); /* MUTANT */',
    why: 'The refresh is served 50-minute-old weather from the 2 h cache.',
  },
  {
    id: 'W-ii. ★★ a caller can lengthen the weather cache',
    file: WX,
    find: '  return maxAgeMs != null && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? Math.min(TTL_MS, maxAgeMs) : TTL_MS;',
    to: '  return maxAgeMs != null && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : TTL_MS; /* MUTANT */',
    why: 'A long max age would serve weather older than the cache\'s own TTL.',
  },
  {
    id: 'W-iii. ★★★ the fetch\'s re-check uses the 2 h TTL',
    file: WX,
    find: '  if (cache && Date.now() - cache.fetchedAt < ttl) return cache;\n  const { forecastLat: lat, forecastLon: lon } = siteCoordinates();',
    to: '  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache; /* MUTANT */\n  const { forecastLat: lat, forecastLon: lon } = siteCoordinates();',
    why: 'The refresh\'s own fetch returns the stale cache without fetching.',
  },
  {
    id: 'W-iv. ★★★ getDayForecast serves a forecast built on older weather',
    file: AN,
    find: '  if (dayForecastCacheUsable(devices, Date.now()) && onIt(dayForecastCache!.value)) return dayForecastCache!.value;',
    to: '  if (dayForecastCacheUsable(devices, Date.now())) return dayForecastCache!.value; /* MUTANT */',
    why: 'Fresh weather is fetched and the 30-minute-old forecast is served anyway.',
  },
  {
    id: 'W-v. ★★ the forecast\'s in-flight re-check ignores the weather',
    file: AN,
    find: '    && (onWeatherAtMs === undefined || (dayForecastCache!.value.weatherFetchedAtMs ?? null) === onWeatherAtMs)) {',
    to: '    ) { /* MUTANT */',
    why: 'The rebuild returns the cached forecast it was asked to replace.',
  },
  {
    id: 'W-vi. ★★★ the forecast does not say which weather it was built on',
    file: AN,
    find: '  value.weatherFetchedAtMs = weather?.fetchedAt ?? null;',
    to: '  value.weatherFetchedAtMs = null; /* MUTANT */',
    why: 'The refresh cannot judge its forecast\'s age, and always defers (or never, unchecked).',
  },
  {
    id: 'W-vii. ★★ the band drops the weather time',
    file: AN,
    find: '    weatherFetchedAtMs: forecast.weatherFetchedAtMs ?? null,',
    to: '    weatherFetchedAtMs: null, /* MUTANT */',
    why: 'The planner reads the band\'s weather age first: unknown, so the refresh never runs.',
  },
  {
    id: 'W-viii. ★★★ the forecast report ignores maxWeatherAgeMs',
    file: REP,
    find: '  forecast: (ctx, a) => getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log, weatherAgeOpts(a)),',
    to: '  forecast: (ctx) => getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log), /* MUTANT */',
    why: 'The load side of the band is built on the cached forecast.',
  },
  {
    id: 'W-ix. ★★★ the band report ignores maxWeatherAgeMs',
    file: REP,
    find: '    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log, weatherAgeOpts(a));',
    to: '    const fc = await getDayForecast(devicesOf(ctx), ctx.recorder, ctx.log); /* MUTANT */',
    why: 'The PV band the refresh sizes on is the cached one.',
  },
  {
    id: 'W-x. ★★★ the planner drops maxWeatherAgeMs for the band',
    file: IDX,
    find: "      ? analytics.report<ProbabilisticForecast>('probabilisticForecast', { maxWeatherAgeMs: wxAge })",
    to: "      ? analytics.report<ProbabilisticForecast>('probabilisticForecast') /* MUTANT */",
    why: 'The refresh asks for fresh weather and sizes on the cached band.',
  },
  {
    id: 'W-xi. ★★★ every caller asks for fresh weather',
    file: IDX,
    find: '  const wxAge = opts.maxWeatherAgeMs;',
    to: '  const wxAge = opts.maxWeatherAgeMs ?? 45 * 60_000; /* MUTANT */',
    why: 'Every 30-minute recompute and the 21:30 plan force weather fetches: not inert.',
  },
  {
    id: 'W-xii. ★★ a pinned leg\'s plan loses its weather time',
    file: IDX,
    find: '    ...(shadowLeg ? { weatherFetchedAtMs: prob?.weatherFetchedAtMs ?? dayAhead?.weatherFetchedAtMs ?? null } : {}),',
    to: '    /* MUTANT */',
    why: 'Neither refresh can say how old its weather was.',
  },

  /* ── the words ── */
  {
    id: 'T-i. ★★★ the spoken notice is not held to 560 characters',
    file: TXT,
    find: '  const fits = candidates.find((t) => t.en.length + t.es.length <= MAX_SPOKEN_ADVISORY_CHARS);\n  return fits ?? candidates[candidates.length - 1];',
    to: '  return candidates[0]; /* MUTANT */',
    why: 'A long two-leg evening holds both alarm speakers past the bound.',
  },
  {
    id: 'T-ii. ★★★ the two-leg notice drops the cushion clause',
    file: TXT,
    find: '          + `${cEn}${shortEn} Cancel on the Power panel by ${phxSpokenClock(bApply)}, or by ${cancelAt} for the daytime charge.`,',
    to: '          + `${cEn} Cancel on the Power panel by ${phxSpokenClock(bApply)}, or by ${cancelAt} for the daytime charge.`, /* MUTANT */',
    why: 'The speakers are quieter about residual risk than the push.',
  },
  {
    id: 'T-iii. ★★★ the push headline states the worst case',
    file: TXT,
    find: '  const figure = c.expectedKwh != null && Number.isFinite(c.expectedKwh) ? kwhPhrase(c.expectedKwh) : null;',
    to: '  const figure = c.buyKwh != null && Number.isFinite(c.buyKwh) ? kwhPhrase(c.buyKwh) : null; /* MUTANT */',
    why: 'The 2026-10-12 defect on the mid-day push: "about 58 kWh" for a charge expected to draw 34.',
  },
  {
    id: 'T-iv. ★★★ the notice speaks the worst case',
    file: TXT,
    find: '  const ck = spokenKwh(c.expectedKwh);',
    to: '  const ck = spokenKwh(c.buyKwh); /* MUTANT */',
    why: 'The speakers announce the sizing basis as the charge.',
  },
  {
    id: 'T-v. ★★ a small backup is spoken as a leg of its own',
    file: TXT,
    find: 'export const BACKUP_SPOKEN_LEG_KWH = 5;',
    to: 'export const BACKUP_SPOKEN_LEG_KWH = 0; /* MUTANT */',
    why: 'Every two-leg evening speaks the long form, a 2 kWh backup with its own window and cancel.',
  },
  {
    id: 'T-vi. ★★★ the midnight backup is "tomorrow"',
    file: TXT,
    find: "  if (t.ymd === ymdNext(n.ymd)) return t.hour < 6 && n.hour >= 12 ? 'tonight' : 'tomorrow';",
    to: "  if (t.ymd === ymdNext(n.ymd)) return 'tomorrow'; /* MUTANT */",
    why: 'Sunday\'s notice says the Monday 00:00 backup is tomorrow: the owner cancels too late.',
  },
  {
    id: 'T-vii. ★★ the cancel deadline is after the write',
    file: MS,
    find: '    costApplyAtMs: c.windowStartMs - APPLY_LEAD_MS,',
    to: '    costApplyAtMs: c.windowStartMs + 5 * MINUTE_MS, /* MUTANT */',
    why: '"Cancel before 10:05 AM" for a write at 10:00.',
  },
  {
    id: 'T-viii. ★★★ the restore time ignores the on-peak guard',
    file: MS,
    find: '    costRestoreAtMs: revertDueMs({ windowEndMs: c.windowEndMs, nextOnPeakStartMs: onPeakStart }) ?? c.windowEndMs,',
    to: '    costRestoreAtMs: c.windowEndMs + HOUR_MS, /* MUTANT */',
    why: 'The notice promises a 4:00 PM restore — inside on-peak.',
  },
  {
    id: 'T-ix. ★★ the summary states the figure beside legs it does not count',
    file: TXT,
    find: "  const figureFits = fc.kind === 'none' ? fc.expectedLeg === false : fc.kind === 'ran' && fc.expectedLeg === true;\n  const figure = o.expectedKwh",
    to: "  const figureFits = true; /* MUTANT */\n  const figure = o.expectedKwh",
    why: '"(about 34 kWh expected)" beside a Charge Now that never started.',
  },
  {
    id: 'T-x. ★★ the summary says "at ~90%" for a force-charge the window stopped',
    file: TXT,
    find: "        ? o.forceChargeOffReason === 'target' && stop",
    to: '        ? stop /* MUTANT */',
    why: 'A charge cut short by the close is reported as reaching its stop.',
  },
  {
    id: 'T-xi. ★★★ the critical page drops Charge Now',
    file: TXT,
    find: "  const fcEn = o.forceChargeOffOpen ? ' and switch Charge Now off' : '';",
    to: "  const fcEn = ''; /* MUTANT */",
    why: 'The owner restores the reserve and leaves Charge Now buying through on-peak.',
  },
  {
    id: 'T-xii. ★★★ the critical page is not held to 560 characters',
    file: TXT,
    find: '  return candidates.find((t) => t.en.length + t.es.length <= MAX_SPOKEN_ADVISORY_CHARS) ?? candidates[candidates.length - 1];',
    to: '  return candidates[0]; /* MUTANT */',
    why: 'The on-peak page with a reading runs to 630 characters.',
  },
  {
    id: 'T-xiii. ★★★ the critical page says "still reads" with no reading',
    file: TXT,
    find: '    candidates.push(o.unknown\n      ? {\n        en: `Critical. The ${span} charge could not be confirmed stopped:',
    to: '    candidates.push(false /* MUTANT */\n      ? {\n        en: `Critical. The ${span} charge could not be confirmed stopped:',
    why: 'A dark panel is said to read our 50%.',
  },
  {
    id: 'T-xiv. ★★ the push shape loses its refused form',
    file: TXT,
    find: '  if (i.refused != null) {\n    const write',
    to: '  if (i.refused != null && i.nowMs < 0) { /* MUTANT */\n    const write',
    why: 'A refused cycle is announced as a supervised charge.',
  },
  {
    id: 'T-xv. ★★★ the notice speaks a placeholder for a figure there is not',
    file: TXT,
    find: "const atPctEn = (v: number | null): string => (v != null ? ` at ${v} percent` : '');",
    to: "const atPctEn = (v: number | null): string => ` at ${v ?? '—'} percent`; /* MUTANT */",
    why: 'The speakers read out "held at dash percent".',
  },
  {
    id: 'T-xvi. ★★ the level does not fall back to the reserve the write holds',
    file: TXT,
    find: '  const level = c.levelPct != null ? Math.round(c.levelPct) : c.reservePct != null ? Math.round(c.reservePct) : null;',
    to: '  const level = c.levelPct != null ? Math.round(c.levelPct) : null; /* MUTANT */',
    why: 'An armed leg with no level on record is announced with no level at all.',
  },
  {
    id: 'T-xvii. ★★★ the notice has no shape within the bound by construction',
    file: TXT,
    find: '  candidates.push(minimalNotice());',
    to: '  /* MUTANT */',
    why: 'Figures long enough leave every shape over 560 characters, and the longest is spoken.',
  },
  {
    id: 'T-xviii. ★★★ the last shape drops the cushion clause',
    file: TXT,
    find: '      en: `Charge notice. ${dayTextCap(cDay)} ${cA} to ${cB}, ${costEn}.${bEn}${shortEn}${cancelEn}`,',
    to: '      en: `Charge notice. ${dayTextCap(cDay)} ${cA} to ${cB}, ${costEn}.${bEn}${cancelEn}`, /* MUTANT */',
    why: 'The shortest notice is the one that stops saying the cushion is short.',
  },
  {
    id: 'T-xix. ★★★ the critical page has no shape within the bound by construction',
    file: TXT,
    find: '  // The last shape, within the bound by construction: what to do, and why, in the fewest words.\n  candidates.push({',
    to: '  if (false) candidates.push({ /* MUTANT */',
    why: 'A page with long figures runs over the bound on both alarm speakers.',
  },

  /* ── the route ── */
  {
    id: 'A-i. ★★★ a record with no window kind takes the mid-day words',
    file: RT,
    find: "  return s.windowKind === 'super_off_peak';",
    to: "  return s.windowKind !== 'overnight'; /* MUTANT */",
    why: 'A record from before the cycle record (no window kind) is paged and summarised as a mid-day charge.',
  },
  {
    id: 'A-ii. ★★★ the overnight route drops the cushion clause',
    file: RT,
    find: '      cushionShortfall: plan.cushionShortfall === true,\n    }),',
    to: '      cushionShortfall: false, /* MUTANT */\n    }),',
    why: 'The overnight speech changes: not byte-identical.',
  },
  {
    id: 'A-iii. ★★★ the overnight route loses the refusal',
    file: RT,
    find: '  const push = buildNightChargeMessage(plan, shape, supervised, armRefused, mode);',
    to: '  const push = buildNightChargeMessage(plan, shape, supervised); /* MUTANT */',
    why: 'A refused night is announced through the route as recommended.',
  },
  {
    id: 'A-iv. ★★★ every restore sends the mid-day summary',
    file: IDX,
    // v1.189.0 (review) — re-pointed: the summary goes from sendRestoreSummary (index.ts).
    find: '  if (isMiddayLeg(state)) {\n    const onPeakAt = state.nextOnPeakStartMs ?? null;',
    to: '  if (isMiddayLeg(state) || state.day != null) { /* MUTANT */\n    const onPeakAt = state.nextOnPeakStartMs ?? null;',
    why: 'The overnight morning summary is replaced.',
  },
  {
    id: 'A-v. ★★★ every revert page is the mid-day page',
    file: IDX,
    find: '  const midday = isMiddayLeg(state as Partial<ChargeLegState>)',
    to: '  const midday = (true || isMiddayLeg(state as Partial<ChargeLegState>)) /* MUTANT */',
    why: 'The overnight revert-deadline page changes words.',
  },
  {
    id: 'A-vi. ★★ the missed-apply push calls a midnight window "Today\'s"',
    file: NTF,
    find: "  const when = sameDay ? (start.hour >= 18 || start.hour < 6 ? 'Tonight\\'s' : 'Today\\'s') : `${start.weekday}'s`;",
    to: "  const when = sameDay ? (start.hour >= 18 ? 'Tonight\\'s' : 'Today\\'s') : `${start.weekday}'s`; /* MUTANT */",
    why: 'The words moved onto the formatter\'s clocks drift from the release before: Sunday\'s missed backup reads "Today\'s 12am–5am".',
  },

  /* ── the shadow: nothing sent or spoken ── */
  {
    id: 'S-i. ★★★ the shadow\'s evening preview is pushed',
    file: IDX,
    find: '    for (const line of middayShadowPreviewLogLines(rec, model)) app.log.info(line);',
    to: '    void sendNotification(loadNotifyConfig(), middayShadowPreview(rec, model)!.push); /* MUTANT */',
    why: 'A shadow notice lands beside the live one: two plans for one evening.',
  },
  {
    id: 'S-ii. ★★★ the shadow\'s refresh preview is spoken',
    file: IDX,
    find: '  if (refreshPreview != null) app.log.info(refreshPreview);',
    to: "  if (refreshPreview != null) void broadcast.announce('medium', refreshPreview, refreshPreview); /* MUTANT */",
    why: 'A computation nobody armed plays on the speakers at 09:30.',
  },
  {
    id: 'S-iii. ★★ the shadow refresh does not record its weather age',
    file: MS,
    find: '    weatherAgeS: weatherAgeSeconds(sized?.weatherFetchedAtMs, nowMs),',
    to: '    weatherAgeS: null, /* MUTANT */',
    why: 'The shadow cannot be judged on the forecast age the live refresh will require.',
  },
  {
    id: 'S-iv. ★★ the weather age never reaches the ledger',
    file: MS,
    find: '    shadow_refresh_weather_age_s: r.weatherAgeS ?? null,',
    to: '    shadow_refresh_weather_age_s: null, /* MUTANT */',
    why: 'The column the 5-day shadow is graded on stays empty.',
  },
  {
    id: 'S-v. ★★ the preview announces a backup that would not arm',
    file: MS,
    find: '  const backupNamed = b != null && b.basisComplete && b.chargeTonight && (advisory || refused != null || b.wouldArm);',
    to: '  const backupNamed = b != null && b.basisComplete && b.chargeTonight; /* MUTANT */',
    why: 'The shadow says it would hold the reserve overnight when the backup would be refused.',
  },
  {
    id: 'S-vi. ★★★ the preview announces a refused cycle as armed',
    file: MS,
    find: '  const refused = !advisory && c.basisComplete && c.chargeTonight && !c.wouldArm',
    to: '  const refused = rec.computedAtMs < 0 && !advisory && c.basisComplete && c.chargeTonight && !c.wouldArm /* MUTANT */',
    why: 'The preview reads a charge nothing would arm.',
  },
  /* ── the shadow refresh's basis (fix round 1) ── */
  {
    id: 'Q-i. ★★★ the shadow refresh is re-sized after the live overnight charge wrote',
    file: IDX,
    find: '  let refresh = liveOvernightWrote(cur, nightActuationMem) ? notComparableRefresh(nowMs)',
    to: '  let refresh = (false as boolean) ? notComparableRefresh(nowMs) /* MUTANT */',
    why: 'The refresh sizes on a pool the live overnight leg filled and reads the mid-day leg as nearly done.',
  },
  {
    id: 'Q-ii. ★★ a force-charge alone does not count as a live write',
    file: MS,
    find: '  return live.day != null && live.day === rec.day && (live.appliedAtMs != null || live.forceChargeOnAtMs != null);',
    to: '  return live.day != null && live.day === rec.day && live.appliedAtMs != null; /* MUTANT */',
    why: 'A night whose force-charge filled the pool is re-sized on it.',
  },
  {
    id: 'Q-iii. ★★ another evening\'s leg counts as a live write',
    file: MS,
    find: '  return live.day != null && live.day === rec.day && (live.appliedAtMs != null || live.forceChargeOnAtMs != null);',
    to: '  return live.day != null && (live.appliedAtMs != null || live.forceChargeOnAtMs != null); /* MUTANT */',
    why: 'Yesterday\'s write makes today\'s refresh not comparable.',
  },
  {
    id: 'Q-iv. ★★ the entities show the not-comparable refresh\'s (empty) figures',
    file: MS,
    find: "  return r != null && r.disposition !== 'stood' && r.disposition !== 'not-comparable';",
    to: "  return r != null && r.disposition !== 'stood'; /* MUTANT */",
    why: 'The mid-day entities go unknown on every write night instead of keeping the evening plan.',
  },
  {
    id: 'T-xxi. ★★★ a reserve cap is pushed as "calls for more" than a level it did not ask above',
    file: TXT,
    find: '    if (!levelAsked) {',
    to: '    if ((false as boolean) && !levelAsked) { /* MUTANT */',
    why: '"The morning re-plan calls for more (~70%) … stays at ~70%": a push that is not true.',
  },
  {
    id: 'T-xxii. ★★★ the reserve-cap push names the asked reserve as the one held',
    file: TXT,
    find: "          + `${when} stays at ${aLevel}${held != null ? `, with the reserve held at ${held}% from the open` : ''}.${cancel}`,",
    to: "          + `${when} stays at ${aLevel}${needR != null ? `, with the reserve held at ${needR}% from the open` : ''}.${cancel}`, /* MUTANT */",
    why: 'The push says the reserve is held at 45% when 30% is what is written.',
  },
  {
    id: 'I-viii. ★★ the live refresh push is not told the reserve the re-plan asked for',
    file: IDX,
    find: '    neededReservePct: o.neededReservePct,',
    to: '    neededReservePct: null, /* MUTANT */',
    why: 'The live push of a reserve cap loses the figure the outcome carries.',
  },
  {
    id: 'T-xx. ★★★ the mid-day page always says the restore keeps being retried',
    file: TXT,
    find: "' and switch Charge Now off' : ''} in the EcoFlow app. ${revertRetryText(o.retrying, o.resendOnReport ?? null)}`,",
    to: "' and switch Charge Now off' : ''} in the EcoFlow app. ${revertRetryText(true)}`, /* MUTANT */",
    why: 'After the re-issues are spent the push still tells the owner a retry is coming.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-midday-refresh', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
