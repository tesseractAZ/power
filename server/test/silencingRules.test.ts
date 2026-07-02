import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySilencingRules, ENERGY_STATE_FAMILIES, type AlertActionStats } from '../src/alertMonitor.js';
import { familyOf } from '../src/alertOutcomes.js';

// v0.30.0 — the four auto-silencing rules were extracted from a closure into the
// pure exported applySilencingRules() so they're unit-testable. These tests pin
// the three pre-existing rules (regression for the extraction) AND the new
// high-volume rate guard (Rule 4) that catches churn the band rules miss.

function stats(over: Partial<AlertActionStats>): AlertActionStats {
  return {
    familyKey: 'fam', alertId: 'fam-x', title: 'Fam', severity: 'warning', category: 'Battery',
    riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
    downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
    neverClearedCount: 0, lastSeenAt: null,
    ...over,
  };
}

test('Rule 1 — info that recurs a lot and always short-clears is silenced', () => {
  const t = stats({ severity: 'info', riseCount: 10, shortClearsCount: 8 }); // 0.80 ≥ 0.70
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, true);
});

test('Rule 2 — warning that mostly short-clears is demoted to info', () => {
  const t = stats({ severity: 'warning', riseCount: 20, shortClearsCount: 17 }); // 0.85 ≥ 0.80
  applySilencingRules(t);
  assert.equal(t.warningDemotedToInfo, true);
});

test('Rule 3 — chronic noise (rarely cleared) is silenced', () => {
  const t = stats({ severity: 'warning', riseCount: 20, neverClearedCount: 12 }); // 0.60 ≥ 0.50
  applySilencingRules(t);
  assert.equal(t.chronicNoiseSilenced, true);
});

test('Rule 4 — high-volume warning churn is demoted even when short-frac misses the 0.80 band', () => {
  // The exact vdiff-warn / dpu-pvh-err live shape: fires constantly, self-clears,
  // but cumulative short-frac (0.50) sits below DEMOTE_WARN_SHORT_FRAC so Rule 2
  // never fires. Rule 4 catches it on volume + low persistence.
  const t = stats({ severity: 'warning', riseCount: 200, shortClearsCount: 100, neverClearedCount: 10 });
  // Sanity: Rule 2's band is genuinely missed here.
  assert.ok(t.shortClearsCount / t.riseCount < 0.8, 'precondition: short-frac below Rule 2 band');
  applySilencingRules(t);
  assert.equal(t.warningDemotedToInfo, true);
});

test('Rule 4 — high-volume info churn is silenced even when short-frac misses the 0.70 band', () => {
  const t = stats({ severity: 'info', riseCount: 200, shortClearsCount: 100, neverClearedCount: 10 }); // 0.50 < 0.70
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, true);
});

test('Rule 4 — critical is NEVER gated no matter how high-volume / transient', () => {
  const t = stats({ severity: 'critical', riseCount: 1000, shortClearsCount: 990, neverClearedCount: 0 });
  applySilencingRules(t);
  assert.equal(t.downgradedSilenced, false);
  assert.equal(t.warningDemotedToInfo, false);
  assert.equal(t.chronicNoiseSilenced, false);
});

test('Rule 4 — an infrequent warning (below the 150-rise floor) is NOT demoted (protects soc-low)', () => {
  // A warning the operator acts on, fires 149× and rarely self-clears: must stay
  // at warning so it keeps notifying.
  const t = stats({ severity: 'warning', riseCount: 149, shortClearsCount: 5, neverClearedCount: 0 });
  applySilencingRules(t);
  assert.equal(t.warningDemotedToInfo, false);
});

test('Rule 4 — a high-volume but PERSISTENT warning (a real standing condition) is NOT demoted', () => {
  // 200 rises but 25% are long-active → above the 0.20 persistence guard, so it's
  // treated as a standing condition, not churn. (Also below Rule 3's 0.50 floor.)
  const t = stats({ severity: 'warning', riseCount: 200, shortClearsCount: 40, neverClearedCount: 50 });
  applySilencingRules(t);
  assert.equal(t.warningDemotedToInfo, false);
  assert.equal(t.chronicNoiseSilenced, false);
});

/* ── v0.80.0 — energy-state families are exempt from every auto-tune rule ── */

test('v0.80.0 — an energy-state family is NEVER demoted/silenced, even with demote-qualifying stats', () => {
  // The live 68.9h shape: backup-soc boundary-flapped at the 20% band enough to
  // qualify for Rule 2 (warning, short-frac ≥ 0.80) AND Rule 4 (volume + low
  // persistence) — and a genuine backup-pool-at-17% event then pushed as "[Low]".
  // A fast clear on an energy-state family IS a real recovery, not sensor noise.
  for (const familyKey of ['backup-soc', 'shp2-below-reserve', 'shp2-near-reserve', 'soc-low', 'forecast-runtime']) {
    const t = stats({ familyKey, severity: 'warning', riseCount: 200, shortClearsCount: 180, neverClearedCount: 5 });
    applySilencingRules(t);
    assert.equal(t.warningDemotedToInfo, false, `${familyKey} must not demote`);
    assert.equal(t.downgradedSilenced, false, `${familyKey} must not silence`);
    assert.equal(t.chronicNoiseSilenced, false, `${familyKey} must not chronic-silence`);
  }
});

test('v0.80.0 — the exemption set matches familyOf() of the real alert ids', () => {
  // Pin the derivation so an alert-id rename can't silently orphan the exemption.
  assert.ok(ENERGY_STATE_FAMILIES.has(familyOf('backup-soc-20')));
  assert.ok(ENERGY_STATE_FAMILIES.has(familyOf('shp2-below-reserve')));
  assert.ok(ENERGY_STATE_FAMILIES.has(familyOf('soc-low-Y711ZAB59GBC0314-3')));
  assert.ok(ENERGY_STATE_FAMILIES.has(familyOf('forecast-runtime-HD31ZASAHH120432')));
});

test('v0.80.0 — non-exempt families still demote exactly as before (regression guard)', () => {
  const t = stats({ familyKey: 'vdiff-warn', severity: 'warning', riseCount: 20, shortClearsCount: 17 });
  applySilencingRules(t);
  assert.equal(t.warningDemotedToInfo, true);
});
