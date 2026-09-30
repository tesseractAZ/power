/**
 * v1.187.0 — the MPPT self-baseline families' auto-tune verdicts are re-earned under the new rule.
 *
 * Before v1.187.0 the idle-Core (cooler-than-typical) episodes annunciated, so they were counted:
 * live telemetry on 09-29 read baseline-mppt_lv_temp 10 rises / 6 long-active, Rule 3 latched,
 * and that latch would have silenced a HOT-side LV-MPPT warning's push for the rest of the 30-day
 * replay window. Those events cannot say which side of the baseline they were on, so — like the
 * v1.186.0 scope reset — they are not replayed; every new event of the family carries the basis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryEntry } from '../src/alertTelemetry.js';

const tmp = mkdtempSync(join(tmpdir(), 'ef-mppt-rebase-'));
process.env.ALERT_TELEMETRY_PATH = join(tmp, 'alert-telemetry.jsonl');
const { appendTelemetryEvent, telemetryBasisFor, TELEMETRY_FAMILY_BASIS } = await import('../src/alertTelemetry.js');
const { replayTelemetryEvents, liftedAutoTuneVerdicts } = await import('../src/alertMonitor.js');

const LV = 'baseline-mppt_lv_temp';
const T = 1_790_000_000_000;

/** The 09-29 rollup: 10 rises, 1 short-clear, 6 long-active — every line scoped, none with a basis. */
function preFixLv(basis?: string): TelemetryEntry[] {
  const out: TelemetryEntry[] = [];
  for (let i = 0; i < 10; i++) out.push({ familyKey: LV, alertId: `${LV}-COREXXX00XXX0005`, event: 'rise', ts: T + i, scope: 'annunciating', ...(basis ? { basis } : {}) });
  out.push({ familyKey: LV, alertId: `${LV}-COREXXX00XXX0005`, event: 'shortClear', ts: T + 20, durationMs: 60_000, scope: 'annunciating', ...(basis ? { basis } : {}) });
  for (let i = 0; i < 6; i++) out.push({ familyKey: LV, alertId: `${LV}-COREXXX00XXX0005`, event: 'longActive', ts: T + 30 + i, durationMs: 25 * 3_600_000, scope: 'annunciating', ...(basis ? { basis } : {}) });
  return out;
}

test('★★★ the latched LV-MPPT family is not replayed from pre-v1.187.0 events: its chronic-noise silence is lifted', () => {
  const other: TelemetryEntry[] = [{ familyKey: 'vdiff-warn', alertId: 'vdiff-warn-COREXXX00XXX0001-1', event: 'rise', ts: T, scope: 'annunciating' }];
  const events = [...preFixLv(), ...other];
  const before = replayTelemetryEvents(events, {}, { includeLegacy: true });
  assert.equal(before.rollups.get(LV)?.chronicNoiseSilenced, true, 'precondition: the old evidence latches Rule 3');
  const r = replayTelemetryEvents(events, {});
  assert.equal(r.rollups.has(LV), false, 'no pre-fix event of the family is counted');
  assert.equal(r.rebasedSkipped, 17);
  assert.deepEqual([...r.rebasedFamilies], [LV]);
  assert.equal(r.legacySkipped, 0, 'these were scoped lines: a different reset from v1.186.0’s');
  assert.equal(r.rollups.get('vdiff-warn')?.riseCount, 1, 'every other family replays as before');
  const lifted = liftedAutoTuneVerdicts(before.rollups, r.rollups);
  assert.equal(lifted.length, 1);
  assert.match(lifted[0], /^baseline-mppt_lv_temp \(chronic-noise silence; was 10 rises, 1 short-clears \(10%\), 6 long-active \(60%\); scoped no events yet\)$/);
});

test('★★ events written under the current rule ARE replayed (a genuinely chronic hot side re-latches)', () => {
  const r = replayTelemetryEvents(preFixLv(telemetryBasisFor(LV)), {});
  assert.equal(r.rebasedSkipped, 0);
  assert.equal(r.rollups.get(LV)?.riseCount, 10);
  assert.equal(r.rollups.get(LV)?.chronicNoiseSilenced, true, 'the rule still applies to its own evidence');
});

test('both MPPT families are rebased, and only they', () => {
  assert.deepEqual(Object.keys(TELEMETRY_FAMILY_BASIS).sort(), ['baseline-mppt_hv_temp', 'baseline-mppt_lv_temp']);
  assert.equal(telemetryBasisFor('baseline-pack1_temp'), undefined, 'pack thermal baselines keep their history');
  assert.equal(telemetryBasisFor('toString'), undefined, 'no prototype key reads as a family');
});

test('★★★ the write chokepoint stamps the basis, so a new line of the family is trusted on the next boot', () => {
  appendTelemetryEvent({ familyKey: 'baseline-mppt_hv_temp', alertId: 'baseline-mppt_hv_temp-COREXXX00XXX0001', event: 'rise', ts: T, scope: 'annunciating' });
  appendTelemetryEvent({ familyKey: 'vdiff-warn', alertId: 'vdiff-warn-COREXXX00XXX0001-1', event: 'rise', ts: T, scope: 'annunciating' });
  const lines = readFileSync(process.env.ALERT_TELEMETRY_PATH!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TelemetryEntry);
  assert.equal(lines[0].basis, telemetryBasisFor('baseline-mppt_hv_temp'));
  assert.equal('basis' in lines[1], false, 'other families are written exactly as before');
  const r = replayTelemetryEvents(lines, {});
  assert.equal(r.rollups.get('baseline-mppt_hv_temp')?.riseCount, 1);
  assert.equal(r.rebasedSkipped, 0);
});
