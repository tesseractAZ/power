#!/usr/bin/env node
/**
 * mutate-v1187-10-g2.mjs — committed harness for v1.187.10 group g2: what Home Assistant is sent.
 *
 *  C6  — a Smart Home Panel 2 that fails shp2ReadbackFresh (cloud-offline, no REST quota for
 *        SHP2_READBACK_STALE_MS, or replaying a cloud shadow) is not a reading: its live figures
 *        (panel load, grid power and status, backup pool / remaining / timers, every
 *        circuit_<ch>_watts) publish null (publishReadiness `panel` / `panelLive`,
 *        READINESS_PATTERNS). Mutants P-i..P-vi.
 *  C11 — before the first audible-health probe the "Audible Alarm Channel" reads unknown, not
 *        disabled (broadcastHealth.audibleStatus). Mutants A-i..A-ii.
 *  C12 — a forecast or runway built while a connected home Core listed ONLINE has no projection
 *        yet (analytics.homeBasisPending, bounded by HOME_BASIS_PENDING_MAX_MS) is structurally
 *        incomplete, is not cached, does not arm the to-empty hysteresis, does not advance the
 *        lighting posture, and its Projected Low SoC / runway fields publish null. Mutants B-i..B-xii.
 *  C13 — the process's FIRST broker connect leaves availability to the state cycle, which asserts
 *        'online' only after the fresh state payload (and when the build fails); a RECONNECT still
 *        asserts it first (v1.14.1). Mutants S-i..S-iv.
 *  C22 — the re-estimated daily figures (PV Curtailed Today, PV Clipped Today) are state_class
 *        'total' with a last_reset at the local midnight of their own report's day, carry no
 *        expire_after, and the table audit refuses a `_today` total without last_reset. Mutants D-i..D-vii.
 *  C27 — the offline hint reads the restart-persistent "first seen listed offline" stamp
 *        (repairIssues.syncCloudOfflineFirstSeen / cloudOfflineFirstSeenAt) when it predates this
 *        process; the stamp is set on the first offline listing, cleared only by an ONLINE listing,
 *        and persisted on each change. Mutants O-i..O-ix.
 *
 * Not mutated: `i.nowMs ?? Date.now()` in publishReadiness (every test passes a clock or uses the
 * real one, so the default is the same value); the REST twin's `_since` keys in index.ts (the same
 * dailyFigureResetIso call as the MQTT payload, pinned there); the comment-only broadcast.ts hunk.
 *
 *   node scripts/mutate-v1187-10-g2.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const READY = resolve(SERVER, 'src/publishReadiness.ts');
const DISC = resolve(SERVER, 'src/mqttDiscovery.ts');
const BH = resolve(SERVER, 'src/broadcastHealth.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const FMT = resolve(SERVER, 'src/haPayloadFmt.ts');
const ALERTS = resolve(SERVER, 'src/alerts.ts');
const REPAIR = resolve(SERVER, 'src/repairIssues.ts');
const MON = resolve(SERVER, 'src/alertMonitor.ts');

const SUBSET = [
  'test/panelFreshPublish.test.ts',
  'test/publishReadiness.test.ts',
  'test/audibleStatusBoot.test.ts',
  'test/bootBasisPending.test.ts',
  'test/stateCycleOrder.test.ts',
  'test/discoveryInvariants.test.ts',
  'test/dailyFigureTotal.test.ts',
  'test/mqttDiscovery.test.ts',
  'test/offlineSinceCarried.test.ts',
];

const MUTANTS = [
  // ── C6 — a frozen panel is not a reading ────────────────────────────────────────────────
  {
    id: 'P-i. ★★★ panel load publishes from a shadowed panel',
    file: READY,
    find: '\n      && allShp2s(asSnapshots).every((p) => shp2ReadbackFresh(p, nowMs)),',
    to: ', /* MUTANT */',
    why: 'THE DEFECT: Panel Load sat at 1611 W through a stale shadow while the Cores discharged ~4.1 kW.',
  },
  {
    id: 'P-ii. ★★★ the house panel\'s live figures publish whatever its freshness',
    file: READY,
    find: '    panelLive: !!panel && shp2ReadbackFresh(panel, nowMs),',
    to: '    panelLive: !!panel, /* MUTANT */',
    why: 'Grid power, backup pool and every circuit replay the frozen projection as live values.',
  },
  {
    id: 'P-iii. ★★ grid power is not governed',
    file: READY,
    find: "    'grid_home_watts', 'shp2_grid_status', 'backup_pool_percent', 'backup_remaining_kwh',",
    to: "    'shp2_grid_status', 'backup_pool_percent', 'backup_remaining_kwh', /* MUTANT */",
    why: 'A frozen 0 W grid reads as a measured "no import" during the freeze.',
  },
  {
    id: 'P-iv. ★★ the backup timers are not governed',
    file: READY,
    find: "    'backup_charge_minutes', 'backup_discharge_minutes',",
    to: '    /* MUTANT */',
    why: 'A frozen time-to-empty reads as current.',
  },
  {
    id: 'P-v. ★★★ the dynamic per-circuit keys are never withheld',
    file: READY,
    find: '        if (patterns.some((p) => p.test(key))) (state as Record<string, unknown>)[key] = null;',
    to: '        if (false && patterns.some((p) => p.test(key))) (state as Record<string, unknown>)[key] = null; /* MUTANT */',
    why: 'Every circuit_<ch>_watts keeps publishing the frozen channel watts.',
  },
  {
    id: 'P-vi. ★★ the circuit pattern also catches the lifetime counters',
    file: READY,
    find: '  panelLive: [/^circuit_\\d+_watts$/],',
    to: '  panelLive: [/^circuit_\\d+_/], /* MUTANT */',
    why: 'A freeze would null a total_increasing lifetime counter: HA reads the return as a reset and double-counts.',
  },
  // ── C11 — pre-probe audible status ──────────────────────────────────────────────────────
  {
    id: 'A-i. ★★★ the pre-probe default reads "disabled"',
    file: BH,
    find: "  if (h.lastProbeAt == null) return 'unknown';\n",
    to: '  /* MUTANT */\n',
    why: 'THE DEFECT: every restart published "disabled" for a channel configured on.',
  },
  {
    id: 'A-ii. ★★ the publisher tests enabled first again',
    file: DISC,
    find: '          audible_status: audibleStatus(h),',
    to: "          audible_status: !h.enabled ? 'disabled' : audibleStatus(h), /* MUTANT */",
    why: 'The fixed classifier is bypassed in the payload HA reads.',
  },
  // ── C12 — a pending home basis ──────────────────────────────────────────────────────────
  {
    id: 'B-i. ★★ unbounded: a Core whose quota keeps failing is pending forever',
    file: AN,
    find: '  if (nowMs - sinceMs > HOME_BASIS_PENDING_MAX_MS) return false;\n',
    to: '  /* MUTANT */\n',
    why: 'Projected Low SoC and the runway read unknown indefinitely while one Core stays listed online with no quota.',
  },
  {
    id: 'B-ii. ★★★ a WEDGED Core (listed offline) counts as pending',
    file: AN,
    find: "    if (d?.online === true && d.projection?.kind !== 'dpu') return true;",
    to: "    if (d.projection?.kind !== 'dpu') return true; /* MUTANT */",
    why: 'A genuine cloud wedge loses its conservative figures for the boot window.',
  },
  {
    id: 'B-iii. ★★★ a pending basis is not structurally incomplete',
    file: AN,
    find: '  const structurallyIncomplete = loadCold || pvCold || socBasisMissing || basisPending || historyDays <= 0;',
    to: '  const structurallyIncomplete = loadCold || pvCold || socBasisMissing || historyDays <= 0; /* MUTANT */',
    why: 'THE DEFECT: forecast_basis_incomplete reads OFF on a forecast with every Core\'s PV missing, and it caches for the full TTL.',
  },
  {
    id: 'B-iv. ★★★ the forecast does not carry the flag',
    file: AN,
    find: '  value.homeBasisPending = basisPending;\n',
    to: '  /* MUTANT */\n',
    why: 'The publishers cannot see it: Projected Low SoC 0 % publishes as a value.',
  },
  {
    id: 'B-v. ★★★ a pending runway arms the to-empty hysteresis',
    file: AN,
    find: '  const pubHoursToEmpty = basisPending ? hoursToEmpty : applyEmptyHysteresis(hoursToEmpty, runwayEmptyState);',
    to: '  const pubHoursToEmpty = applyEmptyHysteresis(hoursToEmpty, runwayEmptyState); /* MUTANT */',
    why: 'The boot to-empty crossing latches and clamps the next complete reserve crossing to it (both read 15.9 h).',
  },
  {
    id: 'B-vi. ★★ a pending runway is cached',
    file: AN,
    find: '  if (!basisPending) runwayCache = { ts: now, value };',
    to: '  runwayCache = { ts: now, value }; /* MUTANT */',
    why: 'The boot figures are served for RUNWAY_TTL_MS after the Cores have joined.',
  },
  {
    id: 'B-vii. ★★ a forecast built pending does not mark the runway',
    file: AN,
    find: '  const basisPending = homeBasisPending(devices, now) || forecast?.homeBasisPending === true;',
    to: '  const basisPending = homeBasisPending(devices, now); /* MUTANT */',
    why: 'A cached partial forecast still feeds a published finite runway on the complete map.',
  },
  {
    id: 'B-viii. ★★★ the runway does not carry the flag',
    file: AN,
    find: '    ...(basisPending ? { basisPending: true } : {}),',
    to: '    /* MUTANT */',
    why: 'A finite boot runway publishes as a value.',
  },
  {
    id: 'B-ix. ★★ the posture advances on a pending projection',
    file: DISC,
    find: '    const posture = runway && fc && curtailment && !basisPending',
    to: '    const posture = runway && fc && curtailment /* MUTANT */',
    why: 'Escalation is immediate and de-escalation holds 15 min: a posture nothing measured stands.',
  },
  {
    id: 'B-x. ★★★ the forecast readiness ignores the pending flag',
    file: READY,
    find: '    forecastPv: !!i.forecast && i.forecast.pvForecastUnavailable !== true && i.forecast.homeBasisPending !== true,',
    to: '    forecastPv: !!i.forecast && i.forecast.pvForecastUnavailable !== true, /* MUTANT */',
    why: 'Projected Low SoC 0 % at boot.',
  },
  {
    id: 'B-xi. ★★★ the runway readiness ignores the pending flag',
    file: READY,
    find: '    runwayBasis: !!i.runway && i.runway.basisPending !== true,',
    to: '    runwayBasis: !!i.runway, /* MUTANT */',
    why: 'A finite runway to reserve and to empty at boot.',
  },
  {
    id: 'B-xii. ★★ Projected Low SoC is not governed',
    file: READY,
    find: "  forecastPv: ['forecast_pv_next_24h_kwh', 'typical_pv_per_day_kwh', 'projected_low_soc_percent', 'projected_low_soc_at'],",
    to: "  forecastPv: ['forecast_pv_next_24h_kwh', 'typical_pv_per_day_kwh', 'projected_low_soc_at'], /* MUTANT */",
    why: 'THE DEFECT\'s headline value: Projected Low SoC 0 %.',
  },
  // ── C13 — the first connect does not replay the pre-restart values ─────────────────────
  {
    id: 'S-i. ★★★ the first connect asserts availability before any fresh state',
    file: DISC,
    find: '  if (reconnect) fx.publishAvailability();\n  if (!latch.legacyCleared) {',
    to: '  fx.publishAvailability(); /* MUTANT */\n  if (!latch.legacyCleared) {',
    why: 'THE DEFECT: HA re-shows every pre-restart value; a "to normal" trigger fires twice per deploy.',
  },
  {
    id: 'S-ii. ★★★ no connect is ever a reconnect',
    file: DISC,
    find: '  latch.connectedBefore = true;\n',
    to: '  /* MUTANT */\n',
    why: 'A broker reconnect leaves the retained LWT "offline" standing until the next state build (v1.14.1).',
  },
  {
    id: 'S-iii. ★★★ the cycle asserts availability before the state payload',
    file: DISC,
    find: '    fx.publishCircuitDiscovery();\n    fx.publishStatePayload(await fx.buildState());',
    to: '    fx.publishAvailability(); /* MUTANT */\n    fx.publishCircuitDiscovery();\n    fx.publishStatePayload(await fx.buildState());',
    why: 'The first connect\'s state cycle re-shows the pre-restart values for the ~5 s the build takes.',
  },
  {
    id: 'S-iv. ★★★ a failed build leaves availability unasserted',
    file: DISC,
    find: '    fx.publishStatePayload(await fx.buildState());\n  } catch (e) {\n    fx.onError(e);\n  } finally {\n    fx.publishAvailability();\n  }',
    to: '    fx.publishStatePayload(await fx.buildState());\n    fx.publishAvailability(); /* MUTANT */\n  } catch (e) {\n    fx.onError(e);\n  } finally {\n  }',
    why: 'A first build that throws holds every entity unavailable although the add-on is alive.',
  },
  // ── C22 — re-estimated daily figures are revisable totals ──────────────────────────────
  {
    id: 'D-i. ★★★ PV Curtailed Today is total_increasing again',
    file: DISC,
    find: "state_class: 'total', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_curtailment_kwh_today }}', last_reset_value_template: '{{ value_json.pv_curtailment_kwh_today_since }}' },",
    to: "state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_curtailment_kwh_today }}' }, /* MUTANT */",
    why: 'THE DEFECT: a revision of 10 % or more is a meter reset and HA counts the day again.',
  },
  {
    id: 'D-ii. ★★ PV Clipped Today has no last_reset',
    file: DISC,
    find: ", last_reset_value_template: '{{ value_json.pv_clipped_kwh_today_since }}' },",
    to: ' }, /* MUTANT */',
    why: "A 'total' without last_reset never resets: the midnight drop books a negative day.",
  },
  {
    id: 'D-iii. ★★ a total gets expire_after',
    file: DISC,
    find: "      : s.state_class !== 'total_increasing' && s.state_class !== 'total'",
    to: "      : s.state_class !== 'total_increasing' /* MUTANT */",
    why: 'An accumulating statistic expires to unavailable and gaps its history.',
  },
  {
    id: 'D-iv. ★★★ the reset follows the publish clock, not the report',
    file: FMT,
    find: "  const at = typeof reportGeneratedAtMs === 'number' && Number.isFinite(reportGeneratedAtMs) ? reportGeneratedAtMs : nowMs;",
    to: '  const at = nowMs; /* MUTANT */',
    why: "Yesterday's last-good figure republished after midnight is booked into today.",
  },
  {
    id: 'D-v. ★★ the table audit never checks daily figures',
    file: DISC,
    find: "    if (/_today$/.test(valueKey) && (sc === 'total' || sc === 'total_increasing')",
    to: "    if (false && /_today$/.test(valueKey) && (sc === 'total' || sc === 'total_increasing') /* MUTANT */",
    why: 'A new daily figure declared total_increasing ships unnoticed.',
  },
  {
    id: 'D-vi. ★★ the curtailment reset ignores its own report',
    file: DISC,
    find: '      pv_curtailment_kwh_today_since: dailyFigureResetIso(curtailment?.generatedAt),',
    to: '      pv_curtailment_kwh_today_since: dailyFigureResetIso(null), /* MUTANT */',
    why: "The reset key disagrees with the day the figure covers across midnight.",
  },
  {
    id: 'D-vii. ★★ the clipping reset ignores its own report',
    file: DISC,
    find: '      pv_clipped_kwh_today_since: dailyFigureResetIso(clipping?.generatedAt),',
    to: '      pv_clipped_kwh_today_since: dailyFigureResetIso(null), /* MUTANT */',
    why: "As D-vi, for clipping.",
  },
  // ── C27 — the offline hint's persisted onset ────────────────────────────────────────────
  {
    id: 'O-i. ★★ a stamp from this process is reported as carried',
    file: ALERTS,
    find: '      const carriedSince = offlineSince != null && (listedAt == null || offlineSince < listedAt) ? offlineSince : null;',
    to: '      const carriedSince = offlineSince; /* MUTANT */',
    why: 'A device first seen offline in this session is said to predate the restart.',
  },
  {
    id: 'O-ii. ★★★ the hint never reads the persisted stamp',
    file: ALERTS,
    find: '          : carriedSince != null',
    to: '          : false && carriedSince != null /* MUTANT */',
    why: 'THE DEFECT: "since the add-on\'s first device list (5 h ago)" of a device on record offline for 104 days.',
  },
  {
    id: 'O-iii. ★★★ an online listing never clears the stamp',
    file: REPAIR,
    find: '      if (d.online === true) {',
    to: '      if (false) { /* MUTANT */',
    why: '"Not seen online since" becomes false after the device comes back.',
  },
  {
    id: 'O-iv. ★★★ the stamp is re-taken on every evaluation',
    file: REPAIR,
    find: '!isBenchSpareSn(d.sn) && !firstSeenById.has(id)) {',
    to: '!isBenchSpareSn(d.sn)) { /* MUTANT */',
    why: 'The onset becomes "now" each tick: the carried duration is lost.',
  },
  {
    id: 'O-v. ★★ a bench spare is stamped',
    file: REPAIR,
    find: '      } else if (d.online === false && !isBenchSpareSn(d.sn) && ',
    to: '      } else if (d.online === false && /* MUTANT */ ',
    why: 'An expected-offline spare gains an outage record the repair card never shows.',
  },
  {
    id: 'O-vi. ★★★ a change is not persisted',
    file: REPAIR,
    find: '    if (changed) persistFirstSeen();\n',
    to: '    /* MUTANT */\n',
    why: 'The record does not survive the restart it exists for.',
  },
  {
    id: 'O-vii. ★★ the repair fetch clears a stamp on absence',
    file: REPAIR,
    find: '    if (id.startsWith(CLOUD_OFFLINE_REPAIR_PREFIX)) {',
    to: '    if (false) { /* MUTANT */',
    why: 'A /api/repair-issues fetch on a map without the device erases the onset without evidence.',
  },
  {
    id: 'O-viii. ★★★ the monitor never keeps the stamps',
    file: MON,
    find: '    syncCloudOfflineFirstSeen(snap.devices);\n',
    to: '    /* MUTANT */\n',
    why: 'The stamp exists only if someone fetches /api/repair-issues.',
  },
  {
    id: 'O-ix. ★★★ the monitor does not hand the stamp to the alert engine',
    file: MON,
    find: '        offlineSinceMs: cloudOfflineFirstSeenAt(d.sn),\n',
    to: '        /* MUTANT */\n',
    why: 'As O-ii, at the wiring.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-10-g2', mutants: MUTANTS, subset: SUBSET, root: REPO });
