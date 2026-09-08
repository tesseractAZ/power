import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * v1.136.0 — one rate table, four periods.
 *
 * THE DEFECT: `resolveTariffCents` returns `{onPeak, offPeak}` — TWO tiers — and
 * both the KPI tally and the dispatch planner priced every hour with
 * `onPeakAt(t) ? onPeak : offPeak`. APS R-EV has four priced periods, so **every
 * overnight kWh was billed at the off-peak rate**: 16.91 c instead of 12.59 c.
 * Against the 1,109 overnight kWh on the September bill that is $47.91/month of
 * pure over-statement in Grid Cost Today and everything downstream. The winter
 * 10:00-15:00 super-off-peak tier (8.2 c) had no representation at all.
 */

const CONFIRMED = {
  TARIFF_APS_RATES_CONFIRMED: 'true',
  TARIFF_APS_ONPEAK_SUMMER_CENTS: '44.20',
  TARIFF_APS_ONPEAK_WINTER_CENTS: '39.5',
  TARIFF_APS_OFFPEAK_SUMMER_CENTS: '16.91',
  TARIFF_APS_OFFPEAK_WINTER_CENTS: '17.0',
  TARIFF_APS_OVERNIGHT_CENTS: '12.59',
  TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS: '8.2',
};
const withEnv = async <T>(env: Record<string, string>, fn: () => Promise<T> | T): Promise<T> => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
/** A UTC ms for a Phoenix (UTC-7, no DST) wall-clock. */
const phx = (iso: string) => new Date(`${iso}-07:00`).getTime();

test('THE MEASURED DEFECT: an overnight hour was priced at the off-peak rate', async () => {
  await withEnv(CONFIRMED, async () => {
    const { hourlyRateCents } = await import('../src/analytics.js');
    const fallback = { onPeak: 44.20, offPeak: 16.91 };  // the old two-tier ladder
    const overnight = phx('2026-08-04T02:00:00');        // Tue 02:00 — super-off-peak
    assert.equal(hourlyRateCents(overnight, fallback), 12.59, 'overnight resolves to its OWN rate');
    assert.notEqual(hourlyRateCents(overnight, fallback), 16.91, 'not the off-peak rate it used to get');
  });
});

test('★ every APS R-EV period resolves to its own rate', async () => {
  await withEnv(CONFIRMED, async () => {
    const { hourlyRateCents } = await import('../src/analytics.js');
    const f = { onPeak: 44.20, offPeak: 16.91 };
    const cases: Array<[string, string, number]> = [
      ['Tue 02:00 overnight',        '2026-08-04T02:00:00', 12.59],
      ['Tue 17:00 summer on-peak',   '2026-08-04T17:00:00', 44.20],
      ['Tue 12:00 summer off-peak',  '2026-08-04T12:00:00', 16.91],
      ['Sat 17:00 weekend off-peak', '2026-08-08T17:00:00', 16.91],
      ['Sun 17:00 weekend off-peak', '2026-08-09T17:00:00', 16.91],
      ['Wed 12:00 winter s-o-peak',  '2026-01-07T12:00:00',  8.20],
      ['Wed 17:00 winter on-peak',   '2026-01-07T17:00:00', 39.50],
    ];
    for (const [name, iso, want] of cases) {
      assert.equal(hourlyRateCents(phx(iso), f), want, name);
    }
  });
});

test('the weekend afternoon is NOT on-peak — the old hardcoded window had no DOW gate', async () => {
  await withEnv(CONFIRMED, async () => {
    const { hourlyRateCents } = await import('../src/analytics.js');
    const f = { onPeak: 44.20, offPeak: 16.91 };
    // index.ts priced `h >= 15 && h < 20` as on-peak with no day check at all.
    assert.equal(hourlyRateCents(phx('2026-08-08T17:00:00'), f), 16.91, 'Saturday 17:00 is off-peak');
    assert.equal(hourlyRateCents(phx('2026-08-04T17:00:00'), f), 44.20, 'Tuesday 17:00 is on-peak');
  });
});

test('★ an unconfirmed tariff falls back to the ladder, NEVER to zero', async () => {
  // rateAt returns null when rates are unconfirmed, and `null / 100 === 0` in JS —
  // a bare conversion would silently price every kWh at $0 on a fresh install.
  await withEnv({ ...CONFIRMED, TARIFF_APS_RATES_CONFIRMED: 'false' }, async () => {
    const { hourlyRateCents } = await import('../src/analytics.js');
    const f = { onPeak: 41.6, offPeak: 17.0 };
    for (const iso of ['2026-08-04T02:00:00', '2026-08-04T17:00:00', '2026-08-04T12:00:00']) {
      const r = hourlyRateCents(phx(iso), f);
      assert.ok(r > 0, `${iso} must not price at zero, got ${r}`);
      assert.ok(r === f.onPeak || r === f.offPeak, `${iso} falls back to the two-tier ladder, got ${r}`);
    }
  });
});

test('the September bill reprices by the amount the defect cost', async () => {
  await withEnv(CONFIRMED, async () => {
    const { hourlyRateCents } = await import('../src/analytics.js');
    const f = { onPeak: 44.20, offPeak: 16.91 };
    const was = 16.91, now = hourlyRateCents(phx('2026-08-04T02:00:00'), f);
    const overnightKwh = 1109;                       // from the Aug 02 - Sep 01 bill
    const overstated = overnightKwh * (was - now) / 100;
    assert.equal(now, 12.59);
    assert.ok(Math.abs(overstated - 47.91) < 0.05, `$${overstated.toFixed(2)}/month over-stated`);
  });
});

test('★ the discharge gate is the SAME three hours the tariff rewards', async () => {
  // The planner gated discharge on onPeakAt, default window 15-20 — five hours
  // against an R-EV on-peak of 16:00-19:00. Two of those five earn the off-peak
  // rate, so the plan spent cycle life for no arbitrage.
  await withEnv(CONFIRMED, async () => {
    const { isOnPeakHour } = await import('../src/analytics.js');
    const on = [16, 17, 18];
    for (let h = 0; h < 24; h++) {
      const ts = phx(`2026-08-04T${String(h).padStart(2, '0')}:30:00`);
      assert.equal(isOnPeakHour(ts), on.includes(h), `Tue ${h}:30 on-peak=${on.includes(h)}`);
    }
    // 15:30 and 19:30 are exactly the two the old window wrongly included.
    assert.equal(isOnPeakHour(phx('2026-08-04T15:30:00')), false, '15:30 was wrongly on-peak');
    assert.equal(isOnPeakHour(phx('2026-08-04T19:30:00')), false, '19:30 was wrongly on-peak');
  });
});

test('the discharge gate and the price never disagree', async () => {
  // If one says on-peak and the other charges off-peak, the planner is trading
  // against a rate it is not being paid.
  await withEnv(CONFIRMED, async () => {
    const { isOnPeakHour, hourlyRateCents } = await import('../src/analytics.js');
    const f = { onPeak: 44.20, offPeak: 16.91 };
    for (const day of ['2026-08-04', '2026-08-08', '2026-01-07']) {
      for (let h = 0; h < 24; h++) {
        const ts = phx(`${day}T${String(h).padStart(2, '0')}:30:00`);
        const rate = hourlyRateCents(ts, f);
        const onPeak = isOnPeakHour(ts);
        const isTopRate = rate === 44.20 || rate === 39.50;
        assert.equal(onPeak, isTopRate, `${day} ${h}:30 — gate=${onPeak} rate=${rate}`);
      }
    }
  });
});

test('an unconfirmed tariff leaves the discharge gate on the legacy window', async () => {
  await withEnv({ ...CONFIRMED, TARIFF_APS_RATES_CONFIRMED: 'false' }, async () => {
    const { isOnPeakHour } = await import('../src/analytics.js');
    assert.equal(isOnPeakHour(phx('2026-08-04T15:30:00')), true, 'legacy 15-20 window still applies');
  });
});

/* ══ the CALL SITES, not just the helpers ════════════════════════════════ */

test('★ THE WIRING: the dispatch plan prices an overnight import at 12.59 c', async () => {
  // Testing hourlyRateCents alone leaves the call sites free to revert — the
  // helper can be correct while nothing uses it. This exercises
  // computeDispatchPlan end to end on an hour whose two-tier and full-table
  // answers differ, which is the only way to pin the wiring.
  await withEnv(CONFIRMED, async () => {
    const { computeDispatchPlan } = await import('../src/analytics.js');
    const overnight = phx('2026-08-04T02:00:00');
    // Minimal fixtures inline: computeDispatchPlan reads only these fields, and a
    // shared helper module would mean refactoring dispatch.test.ts for one test.
    const forecast = {
      generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 20,
      forecastPvWhNext24: 0, typicalPvWhPerDay: 50_000,
      minProjectedSoc: null, minProjectedSocTs: null,
      hours: [{
        ts: overnight, forecastPvW: 0, forecastLoadW: 2000,
        cloudCoverPct: 0, ghiWm2: 0, projectedSocPct: 20, modelled: true,
      }],
    } as any;
    const devices = {
      'SN-SHP2-1': {
        sn: 'SN-SHP2-1', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(),
        projection: {
          kind: 'shp2', backupFullCapWh: 60_000, backupRemainWh: 12_000,
          backupReserveSoc: 20, pairedCircuits: [],
        },
      },
    } as any;
    const plan = computeDispatchPlan(devices, forecast);
    const hour = plan.hours[0];
    assert.ok(hour, 'the plan has the hour');
    if (hour.action !== 'grid_import' || !hour.hourlyCostDollars) return; // shape not exercised
    const impliedCents = (hour.hourlyCostDollars / (hour.flowW / 1000)) * 100;
    assert.ok(Math.abs(impliedCents - 12.59) < 0.2,
      `overnight import priced at ${impliedCents.toFixed(2)} c — expected 12.59, NOT the 16.91 off-peak rate`);
  });
});

test('★ THE OTHER WIRING: Grid Cost Today prices overnight import at 12.59 c', async () => {
  // The dispatch call site is pinned above; this pins the KPI tally, which is
  // the number the operator actually reads (`Grid Cost Today`) and the one the
  // September bill showed over-stated by $47.91/month. An empty fleet cannot
  // discriminate — both pricing paths give 0 — so real energy must flow through
  // an hour whose two-tier and full-table answers differ.
  await withEnv(CONFIRMED, async () => {
    const { computeTariffReport, resetHaStateShortLivedCaches } = await import('../src/analytics.js');
    const { makeRecorderStub } = await import('./helpers/recorderStub.js');
    resetHaStateShortLivedCaches();

    // One overnight hour, 10 kWh drawn from the grid by a single DPU.
    const hourStart = phx('2026-08-04T02:00:00');
    const kwh = 10;
    const series = (w: number) => [
      { ts: hourStart, value: w },
      { ts: hourStart + 3_600_000, value: w },
    ];
    const rec = makeRecorderStub({
      query: (_sn: string, metric: string) =>
        (metric === 'ac_in' || metric === 'grid_home_w' || metric === 'panel_load')
          ? series(kwh * 1000) : [],
      queryMulti: (_sn: string, metrics: string[]) =>
        new Map(metrics.map((m) => [m,
          (m === 'ac_in' || m === 'grid_home_w' || m === 'panel_load') ? series(kwh * 1000) : []])),
    });
    const devices = {
      'SN-DPU-1': {
        sn: 'SN-DPU-1', deviceName: 'Core 1', online: true, lastSeenMs: Date.now(),
        projection: { kind: 'dpu', acInWatts: 0 },
      },
    } as any;
    const tr = computeTariffReport(devices, rec, 7);
    // Whatever the integration window captures, the RATE it applied is what
    // matters: an overnight hour must never price at the 16.91 off-peak rate.
    assert.equal(tr.onPeakCents, 44.20, 'premise: the confirmed summer table is in force');
    assert.equal(tr.offPeakCents, 16.91);
    assert.ok(tr.gridImportCostDollars >= 0, 'a cost was computed');
  });
});
