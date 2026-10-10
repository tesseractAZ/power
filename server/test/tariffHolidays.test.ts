/**
 * v1.187.13 — APS off-peak holidays from Rate Schedule R-EV (A.C.C. No. 6152, effective
 * 2024-03-08): all-day off-peak, observed-date shifts for the fixed-date holidays, Nth-weekday
 * holidays, and Christmas Eve / New Year's Eve on the day itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apsOffPeakHolidays, APS_OFF_PEAK_HOLIDAYS, buildApsREvModel, rateAt } from '../src/tariff.js';

test('★★★ the 2026 and 2027 R-EV holiday lists, observed shifts included', () => {
  assert.deepEqual(apsOffPeakHolidays(2026), [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-03-31', '2026-05-25', '2026-06-19', '2026-07-03',
    '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-24', '2026-12-25', '2026-12-31',
  ]);
  // 2027: Jun 19 Sat → Fri 18; Jul 4 Sun → Mon 5; Dec 25 Sat → Fri 24 (= Christmas Eve, once).
  assert.deepEqual(apsOffPeakHolidays(2027), [
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-31', '2027-05-31', '2027-06-18', '2027-07-05',
    '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-31',
  ]);
  // 2028: Jan 1 is a Saturday → observed on Friday 2027-12-31.
  assert.ok(apsOffPeakHolidays(2028).includes('2027-12-31'));
  assert.ok(APS_OFF_PEAK_HOLIDAYS.includes('2026-11-11') && APS_OFF_PEAK_HOLIDAYS.includes('2045-12-25'));
});

test('★★★ the APS model prices a holiday as off-peak all day — no on-peak, no overnight', () => {
  const m = buildApsREvModel({ onPeak: { summer: 44, winter: 40 }, overnight: { summer: 12, winter: 12 }, offPeak: { summer: 17, winter: 17 }, superOffPeak: { summer: null, winter: 8 }, confirmed: true });
  const at = (s: string) => rateAt(m, new Date(s).getTime());
  assert.equal(at('2026-11-11T17:00:00-07:00').periodId, 'off_peak', 'Veterans Day 5 pm is not on-peak');
  assert.equal(at('2026-11-11T17:00:00-07:00').isOnPeak, false);
  assert.equal(at('2026-11-11T03:00:00-07:00').periodId, 'off_peak', 'its early hours are not overnight');
  assert.equal(at('2026-11-11T12:00:00-07:00').periodId, 'off_peak', 'no super off-peak on a holiday');
  assert.equal(at('2026-11-10T23:30:00-07:00').periodId, 'overnight', 'the weekday night before is still overnight to midnight');
  assert.equal(at('2026-11-12T17:00:00-07:00').isOnPeak, true, 'the next weekday is on-peak again');
  assert.deepEqual(buildApsREvModel({ holidays: ['2026-10-14'] }).holidays, ['2026-10-14'], 'explicit rates still override');
});
