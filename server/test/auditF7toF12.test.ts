import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollLogLines } from '../src/snapshot.js';
import { computeAlerts } from '../src/alerts.js';
import { setReserveArbitrageRaised } from '../src/nightChargeActuator.js';

/**
 * v1.144.0 — F7 through F12 of the 2026-09-09 log audit.
 *
 * Two of the twelve were investigated and DELIBERATELY NOT CHANGED; both are
 * pinned here so the decision survives the next reader (see the bottom of the
 * file). The rest are small guards whose absence is, as ever in this codebase,
 * indistinguishable from their correct operation.
 */

const src = (f: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/', f), 'utf8');

// ── F9: recovery and duration are properties of the POLL ─────────────────────
/**
 * Four accessory devices fail /quota/all on EVERY poll by design, so
 * `failedCount === 0` is never true on this fleet and both branches were dead:
 * `grep -c 'poll ok in'` returned 0 across a 52.5 h log running at debug level.
 * v1.120.0 ungated the slow-poll line for exactly this reason and left these two.
 */
test('★ F9: a RECOVERY is logged even while the standing accessory set still fails', () => {
  const lines = pollLogLines({ tookMs: 420, failedCount: 4, lastPollFailed: true, slowMs: 5000, pollDebug: false });
  assert.ok(lines.some((l) => l.includes('(recovered)')),
    'after a total poll failure an operator greps for recovery and must find it');
});

test('★ F9: the duration line is obtainable at debug with accessories failing', () => {
  const lines = pollLogLines({ tookMs: 420, failedCount: 4, lastPollFailed: false, slowMs: 5000, pollDebug: true });
  assert.deepEqual(lines, ['poll ok in 420ms'],
    'otherwise there is no poll-duration distribution below the slow threshold at all');
});

test('F9: a healthy quiet poll still says nothing without debug', () => {
  assert.deepEqual(
    pollLogLines({ tookMs: 420, failedCount: 4, lastPollFailed: false, slowMs: 5000, pollDebug: false }), []);
});

test('F9: recovery outranks the debug duration line — one line, not two', () => {
  const lines = pollLogLines({ tookMs: 420, failedCount: 0, lastPollFailed: true, slowMs: 5000, pollDebug: true });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('(recovered)'));
});

test('F9: the slow line still fires independently, and can pair with recovery', () => {
  const lines = pollLogLines({ tookMs: 9000, failedCount: 4, lastPollFailed: true, slowMs: 5000, pollDebug: false });
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('(recovered)') && lines[1].includes('poll slow'));
});

// ── F8: the self-heal exception resolves by identity ─────────────────────────
test('★ F8: the alarm-critical heal exception uses the identity roster', () => {
  // `findShp2` needs `projection.kind === 'shp2'`, which only exists after a
  // SUCCESSFUL quota fetch — so a restart while the panel is dark disarms it.
  // Replaying the quorum gate over the observed window WITHOUT this exception
  // yields zero of the six heals that actually fired.
  const s = src('index.ts');
  const i = s.indexOf('const alarmCriticalStarved');
  assert.ok(i > 0, 'the exception is located');
  const block = s.slice(i - 700, i + 200);
  assert.match(block, /alarmPathShp2Sns\(devices\)/,
    'resolve the alarm-path panel by identity, not by projection');
  assert.ok(!/const shp2SnNow = findShp2\(devices\)\?\.sn/.test(block),
    'the projection singleton must not gate the only route self-heal has to the SHP2');
});

// ── F10: /api/health carries the poll verdict ────────────────────────────────
test('★ F10: /api/health surfaces poll_health and the shadow duration', () => {
  // telemetryBlind's docstring frames the whole feature around /api/health having
  // reported healthy while the add-on held zero telemetry. v1.140.0 computed the
  // verdict and published it to MQTT but not to the surface a watchdog polls.
  const s = src('index.ts');
  const i = s.indexOf("app.get('/api/health'");
  assert.ok(i > 0);
  const body = s.slice(i, s.indexOf('generatedAt: store.get().generatedAt', i));
  assert.match(body, /pollHealth: pollHealth\(\)/);
  assert.match(body, /shp2ContentFrozenMs: \(\(\) =>/, 'the exact key — a renamed property still contains the substring');
});

// ── F11: an unmeasured calibration says so ───────────────────────────────────
test('★ F11: the buy de-bias reports its BASIS, not just a bare 1.000', () => {
  // The learner's eligibility filter requires !(cushion_shortfall === 1) and that
  // flag is 1 on every ledger row, so it selects zero rows and returns the floor.
  // 1.000 read as "measured, no bias" while delivered/planned ran 1.44-1.55x.
  const adv = src('nightChargeAdvisor.ts');
  assert.match(adv, /buyDebiasBasis: 'measured' \| 'default';/);
  assert.match(adv, /buyDebiasSamples: number;/);
  const idx = src('index.ts');
  assert.match(idx, /buyDebiasBasis: buyDebiasCal\.basis/,
    'the real learner result must reach the plan, not a hardcoded default');
  // Pin the CONDITION, not the message: a mutant that makes the branch dead
  // leaves the string literal in place and a bare text scan still passes.
  assert.match(idx, /if \(buyDebiasCal\.basis !== 'measured'\) \{[\s\S]{0,400}announced-buy calibration UNMEASURED/,
    'the silent case must say so once, with the reason, from a live branch');
});

// ── F12: the housekeeping that makes state observable ────────────────────────
test('F12.1: a saturated cleared-alert ledger announces that it is dropping rows', () => {
  // It rehydrated at exactly 1500 on all ten boots — which is CLEARED_LOG_MAX,
  // recognisable as saturation only if you know the cap.
  const s = src('alertMonitor.ts');
  assert.match(s, /AT CAP \$\{CLEARED_LOG_MAX\} — older records are being dropped/);
  assert.match(s, /oldest retained/, 'and states how far back it actually reaches');
});

test('F12.2: the published DB snapshot is named at boot, and NOT swept', () => {
  // 1.72 GB sat in /share for four days riding in every nightly backup. It is
  // also the only recorder history reaching past the ~52 h log ring, and was used
  // for a real investigation — so it is surfaced, not deleted on a timer.
  assert.match(src('dbExport.ts'), /export function publishedSnapshotStatus/);
  assert.match(src('index.ts'), /db-export: published snapshot is/);
  assert.ok(!/unlinkSync|rmSync/.test(src('dbExport.ts')),
    'no TTL sweep — deleting forensic history to reclaim non-scarce disk is the wrong trade');
});

test('F12.3: the broker username is truncated in the connect log', () => {
  // The password is correctly never logged; this is the other half of the same
  // credential, and add-on logs get pasted into vendor tickets.
  const s = src('ecoflow/mqtt.ts');
  assert.match(s, /\$\{username\.slice\(0, 9\)\}…/);
  assert.ok(!/connecting to \$\{url\} as \$\{username\} /.test(s));
});

test('★ F12.5: the reserve alert says when WE raised the floor', () => {
  // Lit a measured median 7.4 h, longest 11.3 h across 45 rises. The severity
  // discriminator (v1.113.0) already keeps it off the phone; the TEXT still read
  // like a fault to anyone glancing at the panel during a deliberate fill.
  //
  // Driven through computeAlerts rather than grepped: a source scan for the new
  // string passes even when the branch that selects it is dead, which is exactly
  // what the mutation harness caught on the first run.
  const fleet = {
    SHP2: {
      sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2',
      online: true, lastUpdated: Date.now(),
      projection: { kind: 'shp2', backupReserveSoc: 50, backupBatPercent: 30, circuits: [], sources: [], pairedCircuits: [] },
    },
  } as never;
  const grid = { present: true, backstopping: true } as never;

  try {
    setReserveArbitrageRaised(true);
    const raised = computeAlerts(fleet, undefined, grid).find((a) => a.id === 'shp2-below-reserve');
    assert.ok(raised, 'the alert is still emitted — it stays visible, it just explains itself');
    assert.equal(raised!.title, 'Backup filling to arbitrage reserve');
    assert.match(raised!.detail ?? '', /not a shortfall/);
    assert.equal(raised!.severity, 'info', 'and the v1.113.0 severity contract is untouched');

    setReserveArbitrageRaised(false);
    const genuine = computeAlerts(fleet, undefined, grid).find((a) => a.id === 'shp2-below-reserve');
    assert.equal(genuine!.title, 'Backup at reserve — on grid', 'a REAL floor touch is unchanged');
    assert.equal(genuine!.severity, 'warning');
  } finally {
    setReserveArbitrageRaised(false);
  }
});

// ── the two deliberate NON-changes ───────────────────────────────────────────
/**
 * Pinned so a future reader does not "fix" them from the same log evidence.
 */
test('★ F7: the self-heal quorum of 2 stays, and the reasoning is in the source', () => {
  // A lone non-alarm-path device cannot trigger a session rebuild. Core 2 ran
  // 133 min at ~3 msg/min with budget free. Leaving it is deliberate: REST kept
  // refreshing it (resolution loss ~1 s → ~20 s), no heal in the record ever
  // cured a SOLO wedge, and the budget is SHARED with the alarm-critical
  // exception which reached 5 of 6 — solo heals could have starved the SHP2.
  const s = src('sessionSelfHeal.ts');
  assert.match(s, /DELIBERATELY NOT CHANGED/);
  assert.match(s, /budget is SHARED with the alarm-critical exception/);
  assert.match(s, /Do not simply lower the quorum/);
});

test('★ F12.4 was REFUTED: vdiff-crit already has a settle debounce, not 0 ms', () => {
  // The audit reported "0 ms debounce (criticals are exempt from all silencing)".
  // It is not: pushDebounceMsFor gives the family SETTLE_PUSH_DEBOUNCE_MS, and
  // isAlertEscalation requires a PRIOR NOTIFIED severity of lower rank — vdiff-warn
  // is a different id, so there is no escalation path within the family and the
  // 0 ms branch is unreachable for it. Live telemetry: rise 77, shortClears 1,
  // median == longest == 9.0 min. The two 8-minute transients that paged had
  // legitimately cleared a 5-minute gate on a pack with a CONFIRMED defect.
  // Raising it further would delay a genuine critical.
  const s = src('alertMonitor.ts');
  assert.match(s, /\/\^\(vdiff-crit-\|/, 'vdiff-crit is in the settle-debounce table');
  assert.match(s, /escalated && a\.severity === 'critical' \? 0 :/,
    'the 0 ms path is for ESCALATIONS only');
});
