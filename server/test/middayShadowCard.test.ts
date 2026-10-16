import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { middayShadowView, MIDDAY_SHADOW_NOTE, type MiddayShadowStatus } from '../../web/src/cards/nightChargeText.js';

/**
 * R4 (v1.189.0) — the charge card's read-only section for the winter mid-day cycle computed in
 * shadow. Its words are pure (nightChargeText.ts middayShadowView) and tested here; the section's
 * component is checked from the card's source: it has no Cancel and no other control (nothing of
 * the shadow is armed), and it sits in every shape whose status is known.
 */

const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const hhmm = (ms: number): string => {
  const d = new Date(ms - 7 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const leg = (role: 'backup' | 'cost', a: number, b: number, o: Record<string, unknown> = {}) => ({
  role, windowStartMs: a, windowEndMs: b, basisComplete: true, chargeTonight: true, reservePct: 50,
  levelPct: role === 'cost' ? 89.5 : 50, buyKwh: 47.8, expectedBuyKwh: role === 'cost' ? 19 : 0, wouldArm: true, disposition: 'would arm', ...o,
});
const shadow = (o: Partial<MiddayShadowStatus> = {}): MiddayShadowStatus => ({
  day: '2026-10-14',
  backup: leg('backup', phx(10, 14, 23), phx(10, 15, 5)),
  cost: leg('cost', phx(10, 15, 10), phx(10, 15, 15)),
  refresh: null,
  ...o,
});

test('★★★ the section states each leg, whether it would arm, and that nothing of it is armed', () => {
  assert.deepEqual(middayShadowView(shadow(), hhmm), {
    title: 'Mid-day charge (shadow)',
    lines: [
      'Outage backup 23:00–05:00: reserve held at 50%, no charge expected · would arm',
      'Mid-day charge 10:00–15:00: to ~89.5%, ~19 kWh expected, reserve 50% from the open · would arm',
      'Morning refresh: due 30 minutes before 10:00',
    ],
    note: MIDDAY_SHADOW_NOTE,
  });
  assert.match(MIDDAY_SHADOW_NOTE, /Nothing is armed, written or announced for it, and there is nothing to cancel\./);
  // A refresh made; a cancel; a hold; a backup not needed; a leg that would not arm.
  const r = middayShadowView(shadow({ refresh: { atMs: phx(10, 15, 9, 31), disposition: 'lowered', levelPct: 80, reservePct: 50, expectedBuyKwh: 12, reason: 'lowered to ~80% (announced 89.5%)' } }), hhmm)!;
  assert.equal(r.lines[2], 'Morning refresh 09:31: lowered, ~80%, ~12 kWh expected — lowered to ~80% (announced 89.5%)');
  const c = middayShadowView(shadow({ refresh: { atMs: phx(10, 15, 9, 31), disposition: 'cancelled', levelPct: null, reservePct: null, expectedBuyKwh: 0, reason: 'the refreshed plan holds: no charge is needed' } }), hhmm)!;
  assert.equal(c.lines[2], 'Morning refresh 09:31: cancelled — the refreshed plan holds: no charge is needed');
  const hold = middayShadowView(shadow({ cost: leg('cost', phx(10, 15, 10), phx(10, 15, 15), { chargeTonight: false, disposition: 'not armed — the plan holds (no buy needed)' }) }), hhmm)!;
  assert.equal(hold.lines[1], 'Mid-day charge 10:00–15:00: no charge needed · not armed — the plan holds (no buy needed)');
  assert.equal(hold.lines.length, 2, 'nothing to refresh');
  const nb = middayShadowView(shadow({ backup: leg('backup', phx(10, 14, 23), phx(10, 15, 5), { chargeTonight: false, wouldArm: false, disposition: 'not armed — the plan holds (no buy needed)' }) }), hhmm)!;
  assert.equal(nb.lines[0], 'Outage backup 23:00–05:00: not needed — the pool holds the line without it · not armed — the plan holds (no buy needed)');
  // No mid-day leg (or no record): nothing.
  assert.equal(middayShadowView(shadow({ cost: null }), hhmm), null);
  assert.equal(middayShadowView(null, hhmm), null);
  assert.equal(middayShadowView(undefined, hhmm), null);
});

test('★★★ the card: a read-only section, in every shape whose status is known — no Cancel, no control, no request', () => {
  const card = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  const fn = card.slice(card.indexOf('function MiddayShadowSection('), card.indexOf('function AdvisoryNote('));
  assert.ok(fn.length > 100, 'the section is found');
  for (const banned of ['<button', 'Cancel', 'postCancel', 'onClick', 'fetch(', 'useState']) {
    assert.ok(!fn.includes(banned), `${banned} in the shadow section`);
  }
  assert.match(fn, /const view = middayShadowView\(shadow, phoenixHHMM\);\n\s+if \(view == null\) return null;/);
  const body = card.slice(card.indexOf('export const NightChargeCard = memo('), card.indexOf('\n});\n'));
  assert.equal(body.split('<MiddayShadowSection shadow={status.middayShadow} />').length - 1, 3, 'the no-plan, hold and charge shapes');
  // The status-blind shape (no status) has none: there is no record to show.
  const unavailable = body.slice(body.indexOf('if (!status) {'), body.indexOf('const actuation = withConfirmedCancel('));
  assert.ok(!unavailable.includes('MiddayShadowSection'));
});
