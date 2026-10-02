/**
 * v1.187.3 — the peer cell-spread family's auto-tune verdict is re-earned under the v1.187.1 rule.
 *
 * v1.187.1 made a LOWER cell spread than the siblings' (the best-balanced pack, or the first to
 * settle after the knee) info + annunciate:false, so new low-side episodes no longer feed the
 * rollups; but TELEMETRY_FAMILY_BASIS listed only the MPPT families, so every peer-voldiff line
 * written before it still replayed. On 10-01 the family stood at 35 rises / 28 short-clears —
 * exactly Rule 2's 80% — and three low-side pairs (Core 2 pack 3, all short) were the margin:
 * 32 / 25 = 78.1% without them. An old line cannot say which side it was on, so none is trusted
 * (the v1.187.0 MPPT reasoning): this can only LIFT a demotion, and Rule 2 re-latches from the
 * current rule's events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryEntry, FamilyMeta } from '../src/alertTelemetry.js';

const tmp = mkdtempSync(join(tmpdir(), 'ef-peer-rebase-'));
process.env.ALERT_TELEMETRY_PATH = join(tmp, 'alert-telemetry.jsonl');
const { appendTelemetryEvent, telemetryBasisFor, TELEMETRY_FAMILY_BASIS, TELEMETRY_BASIS_DROPPED } = await import('../src/alertTelemetry.js');
const { replayTelemetryEvents, liftedAutoTuneVerdicts, rebasedReplayLine } = await import('../src/alertMonitor.js');

const FAM = 'peer-voldiff';
const T = 1_790_000_000_000;
const META: Record<string, FamilyMeta> = {
  [FAM]: { title: 'Cell-voltage spread — peer outlier', severity: 'warning', category: 'Battery', alertId: `${FAM}-COREXXX00XXX0005-1` },
};

/** `rises` rise/clear pairs, the first `short` of them short-clears (≤ 10 min), the rest long. */
function pairs(rises: number, short: number, basis?: string, core = 'COREXXX00XXX0005'): TelemetryEntry[] {
  const out: TelemetryEntry[] = [];
  for (let i = 0; i < rises; i++) {
    const id = `${FAM}-${core}-${(i % 5) + 1}`;
    const b = basis ? { basis } : {};
    out.push({ familyKey: FAM, alertId: id, event: 'rise', ts: T + i * 10, scope: 'annunciating', ...b });
    out.push(i < short
      ? { familyKey: FAM, alertId: id, event: 'shortClear', ts: T + i * 10 + 5, durationMs: 4 * 60_000, scope: 'annunciating', ...b }
      : { familyKey: FAM, alertId: id, event: 'clear', ts: T + i * 10 + 5, durationMs: 40 * 60_000, scope: 'annunciating', ...b });
  }
  return out;
}

test('★★★ the 10-01 rollup (35 rises / 28 short-clears, written before v1.187.3) is not replayed: the Rule 2 demotion is lifted', () => {
  const events = pairs(35, 28);
  const before = replayTelemetryEvents(events, META, { includeLegacy: true });
  const was = before.rollups.get(FAM)!;
  assert.equal(was.riseCount, 35);
  assert.equal(was.shortClearsCount, 28);
  assert.equal(was.warningDemotedToInfo, true, 'precondition: exactly 80% demotes a warning push to [Low]');
  const r = replayTelemetryEvents(events, META);
  assert.equal(r.rollups.has(FAM), false, 'no pre-v1.187.3 event of the family is counted');
  assert.equal(r.rebasedSkipped, 70);
  assert.deepEqual([...r.rebasedFamilies], [FAM]);
  const lifted = liftedAutoTuneVerdicts(before.rollups, r.rollups);
  assert.deepEqual(lifted, ['peer-voldiff (warning→info demotion; was 35 rises, 28 short-clears (80%), 0 long-active (0%); scoped no events yet)']);
});

test('★★★ events written under the current rule ARE replayed: a genuinely noisy high side re-latches Rule 2', () => {
  const basis = telemetryBasisFor(FAM);
  assert.equal(basis, 'peer-voldiff-high-side');
  const r = replayTelemetryEvents(pairs(10, 8, basis), META);
  assert.equal(r.rebasedSkipped, 0);
  assert.equal(r.rollups.get(FAM)?.riseCount, 10);
  assert.equal(r.rollups.get(FAM)?.warningDemotedToInfo, true, 'the rule still applies to its own evidence');
  const mixed = replayTelemetryEvents([...pairs(35, 28), ...pairs(4, 1, basis)], META);
  assert.equal(mixed.rollups.get(FAM)?.riseCount, 4, 'only the current-rule events count');
  assert.equal(mixed.rollups.get(FAM)?.warningDemotedToInfo, false, 'below the 10 rises Rule 2 needs: pushed at full tier');
});

test('★★ only peer-voldiff among the peer families is rebased (the low side changed for the cell spread alone)', () => {
  assert.deepEqual(Object.keys(TELEMETRY_FAMILY_BASIS).sort(), ['baseline-mppt_hv_temp', 'baseline-mppt_lv_temp', 'peer-voldiff']);
  for (const f of ['peer-soh', 'peer-soc', 'peer-temp', 'vdiff-warn']) assert.equal(telemetryBasisFor(f), undefined, f);
  // Every basis says what its earlier rule counted, for the boot line.
  for (const b of new Set(Object.values(TELEMETRY_FAMILY_BASIS))) assert.ok(TELEMETRY_BASIS_DROPPED[b], b);
});

test('★★★ the write chokepoint stamps the basis on a new peer-voldiff line (trusted on the next boot); other peer lines are unchanged', () => {
  appendTelemetryEvent({ familyKey: FAM, alertId: `${FAM}-COREXXX00XXX0001-1`, event: 'rise', ts: T, scope: 'annunciating' });
  appendTelemetryEvent({ familyKey: 'peer-soh', alertId: 'peer-soh-COREXXX00XXX0001-1', event: 'rise', ts: T, scope: 'annunciating' });
  const lines = readFileSync(process.env.ALERT_TELEMETRY_PATH!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TelemetryEntry);
  assert.equal(lines[0].basis, 'peer-voldiff-high-side');
  assert.equal('basis' in lines[1], false);
  const r = replayTelemetryEvents(lines, META);
  assert.equal(r.rollups.get(FAM)?.riseCount, 1);
  assert.equal(r.rebasedSkipped, 0);
});

test('★★ the boot line names what the earlier rule of each rebased family counted — not the MPPT reason for every family', () => {
  const peerOnly = rebasedReplayLine({ rebasedSkipped: 70, rebasedFamilies: new Set([FAM]) }, ['peer-voldiff (x)']);
  assert.equal(peerOnly,
    'alert-telemetry: 70 event(s) of peer-voldiff counted under an earlier emitter rule not replayed — they include '
    + 'lower-than-sibling cell-spread episodes (the best-balanced pack), which no longer annunciate; '
    + 'auto-tune verdicts are re-earned from the current rule. Lifted: peer-voldiff (x)');
  assert.doesNotMatch(peerOnly, /MPPT/);
  const both = rebasedReplayLine({ rebasedSkipped: 3, rebasedFamilies: new Set([FAM, 'baseline-mppt_lv_temp', 'baseline-mppt_hv_temp']) }, []);
  assert.match(both, /of baseline-mppt_hv_temp, baseline-mppt_lv_temp, peer-voldiff counted/);
  assert.match(both, /they include cooler-than-typical and load-explained MPPT episodes and lower-than-sibling cell-spread episodes \(the best-balanced pack\), which/);
  assert.match(both, /from the current rule$/, 'nothing lifted: no suffix');
});
