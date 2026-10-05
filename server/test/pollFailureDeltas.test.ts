/**
 * v1.187.10 (log review 10-03, C10 + C19) — quota-failure breadcrumbs per EPISODE and code, and the
 * poll's failure set logged as a DELTA.
 *
 * C10: the vendor answered 1020 ("Request frequency too fast") to three Cores for one poll, then to
 * Core 2 and the alarm-path panel 16 minutes later. The once-per-PROCESS, serial-keyed breadcrumb
 * printed the 1020 with the wording written for the permanent product-class 1006 ("serves from
 * device/list presence only (logged once per session)") — false for a Core back within 60 s — and
 * the Cores that failed again got no line; a third failure left no cause in the journal at all.
 *
 * C19: the set-change WARN fired on any change to the sorted failure set, so a recovery read exactly
 * like a new failure and every boot restated the standing 1006 accessory set at warn; the lines
 * carried serials only and no codes. Device ids are made up.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'ef-poll-deltas-'));
process.env.DB_PATH = join(TMP, 'ecoflow.db');
for (const k of ['GRID_READING_PATH', 'SHADOW_WITNESS_PATH', 'HOUSE_PANEL_PATH', 'POOL_UNKNOWN_PATH', 'PACK_GHOSTS_PATH']) {
  process.env[k] = join(TMP, `${k.toLowerCase()}.json`);
}
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { SnapshotStore, refreshAll, pollFailureLines, quotaErrorCode, startPollLoop, PERSISTING_FAILURE_HEARTBEAT_MS } = await import('../src/snapshot.js');
const { ecoflow } = await import('../src/ecoflow/rest.js');

const CORE1 = 'COREXXX00XXX0001';
const CORE2 = 'COREXXX00XXX0002';
const CORE3 = 'COREXXX00XXX0003';
const PANEL = 'PANEXXX00XXX0001';
const EVSE = 'EVSEXXX00XXX0001';
const LIST = [
  { sn: CORE1, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: 1 },
  { sn: CORE2, deviceName: 'Core 2', productName: 'DELTA Pro Ultra', online: 1 },
  { sn: CORE3, deviceName: 'Core 3', productName: 'DELTA Pro Ultra', online: 1 },
  { sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 },
  { sn: EVSE, deviceName: 'EVSE - Car Charger', productName: 'EVSE', online: 1 },
];
const E1020 = 'EcoFlow API error 1020: Request frequency too fast (trace n/a)';
const E1006 = 'EcoFlow API error 1006: device not allowed (trace n/a)';
/** The vendor's answer per SN this poll: an error message, or a quota. */
let plan: Record<string, string | undefined> = {};
let list = LIST;
(ecoflow as any).listDevices = async () => list.map((d) => ({ ...d }));
(ecoflow as any).getQuotaAll = async (sn: string) => {
  if (plan[sn]) throw new Error(plan[sn]);
  return {};
};

test('quotaErrorCode — the EcoFlow code, an HTTP status, a timeout, or "error"', () => {
  assert.equal(quotaErrorCode(E1020), '1020');
  assert.equal(quotaErrorCode(E1006), '1006');
  assert.equal(quotaErrorCode('HTTP 502 Bad Gateway'), 'HTTP 502');
  assert.equal(quotaErrorCode('Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)'), 'timeout');
  assert.equal(quotaErrorCode('request timed out'), 'timeout');
  assert.equal(quotaErrorCode('socket hang up'), 'error');
});

test('★★★ C10: the breadcrumb logs each failure EPISODE once with its code, closes it with a recovery line, and says "presence only" for the product-class 1006 alone; the alarm-path panel logs at warn', async () => {
  const store = new SnapshotStore();
  const logs: string[] = [];
  const warns: string[] = [];
  const poll = () => refreshAll(store, (m) => logs.push(m), (m) => warns.push(m));
  const reason = (sn: string) => logs.concat(warns).filter((l) => l.startsWith('snapshot: quota fetch failed for') && l.includes(sn));

  plan = { [CORE1]: E1020, [EVSE]: E1006 };
  const r1 = await poll();
  assert.deepEqual(r1.failureCodes, { [CORE1]: '1020', [EVSE]: '1006' });
  assert.deepEqual(r1.standingFailedSns, [EVSE]);
  assert.deepEqual(reason(CORE1), [
    `snapshot: quota fetch failed for Core 1 (${CORE1}) (${E1020}) — serving its cached quota and MQTT this poll; logged once per failure episode, with a recovery line`,
  ]);
  assert.deepEqual(reason(EVSE), [
    `snapshot: quota fetch failed for EVSE - Car Charger (${EVSE}) (${E1006}) — device serves from device/list presence only (product-class limit; logged once per process)`,
  ]);
  assert.deepEqual(warns, [], 'not the alarm path');

  await poll(); // the same episode
  assert.equal(reason(CORE1).length, 1, 'once per episode');
  assert.equal(reason(EVSE).length, 1);

  plan = { [EVSE]: E1006 };
  await poll(); // Core 1 answers
  assert.ok(logs.includes(`snapshot: quota fetch for Core 1 (${CORE1}) recovered (was failing: 1020)`), logs.join('\n'));

  plan = { [CORE1]: E1020, [EVSE]: E1006 };
  await poll(); // a NEW episode
  assert.equal(reason(CORE1).length, 2, 'a later episode logs its cause again');
  assert.equal(reason(EVSE).length, 1, 'the standing 1006 device: once per process');

  plan = { [CORE1]: 'Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)', [EVSE]: E1006 };
  await poll(); // the same device, a different cause
  assert.equal(reason(CORE1).length, 3, 'a new code is a new line');

  plan = { [PANEL]: E1020, [EVSE]: E1006 };
  await poll();
  assert.equal(warns.length, 1);
  assert.match(warns[0], new RegExp(`^snapshot: quota fetch failed for Smart Home Panel 2 \\(${PANEL}\\) \\(EcoFlow API error 1020`));
});

const label = (sn: string) => `${LIST.find((d) => d.sn === sn)?.deviceName ?? sn} (${sn})`;
const base = {
  label, alarmPathSns: new Set([PANEL]), tookMs: 600, nowMs: 10 * PERSISTING_FAILURE_HEARTBEAT_MS,
  attemptedSns: LIST.map((d) => d.sn),
};

test('★★★ C19: the standing 1006 set at boot is info; NEW failures outside it are one warn line with names and codes; a recovery is info and names who recovered', () => {
  const boot = pollFailureLines({ ...base, prevFailedSns: [], failedSns: [EVSE], failureCodes: { [EVSE]: '1006' }, lastStatedMs: 0 });
  assert.deepEqual(boot.warn, [], 'the expected standing set does not warn at every boot');
  assert.deepEqual(boot.info, [`poll: 1 device(s) failing with product-class error 1006 (the standing accessory set, expected — served from device/list presence only): EVSE - Car Charger (${EVSE})`]);

  const codes = { [EVSE]: '1006', [CORE1]: '1020', [CORE3]: '1020' };
  const grow = pollFailureLines({ ...base, prevFailedSns: [EVSE], failedSns: [EVSE, CORE3, CORE1], failureCodes: codes, lastStatedMs: base.nowMs - 1 });
  assert.deepEqual(grow.warn, [
    `poll completed in 600ms with 2 NEW device fetch failure(s): Core 3 (${CORE3}): 1020, Core 1 (${CORE1}): 1020 — serving from cache/presence; 3 failing in total`,
  ]);
  assert.deepEqual(grow.info, []);

  const back = pollFailureLines({ ...base, prevFailedSns: [EVSE, CORE3, CORE1], failedSns: [EVSE], failureCodes: { [EVSE]: '1006' }, lastStatedMs: base.nowMs - 1 });
  assert.deepEqual(back.warn, [], 'a recovery is not a failure');
  assert.deepEqual(back.info, [`poll: device fetch recovered — Core 3 (${CORE3}), Core 1 (${CORE1}); 1 failing in total`]);
});

test('★★ C19: the alarm-path panel is marked and never standing (a 1006 from it still warns); a device that left the set unasked is not a recovery; the daily heartbeat', () => {
  const panel1020 = pollFailureLines({ ...base, prevFailedSns: [EVSE], failedSns: [EVSE, PANEL], failureCodes: { [EVSE]: '1006', [PANEL]: '1020' }, lastStatedMs: 0 });
  assert.equal(panel1020.warn.length, 1);
  assert.match(panel1020.warn[0], new RegExp(`Smart Home Panel 2 \\(${PANEL}\\): 1020 \\[alarm-path panel\\]`));
  const panel1006 = pollFailureLines({ ...base, prevFailedSns: [], failedSns: [PANEL], failureCodes: { [PANEL]: '1006' }, lastStatedMs: 0 });
  assert.equal(panel1006.warn.length, 1, 'fail loud: the alarm path is never part of the standing set');
  assert.deepEqual(panel1006.info, []);

  const unasked = pollFailureLines({ ...base, attemptedSns: [EVSE], prevFailedSns: [EVSE, CORE2], failedSns: [EVSE], failureCodes: { [EVSE]: '1006' }, lastStatedMs: base.nowMs - 1 });
  assert.deepEqual(unasked.info, [`poll: Core 2 (${CORE2}) no longer asked (listed offline) — not a recovery; 1 failing in total`]);

  const quiet = { ...base, prevFailedSns: [EVSE], failedSns: [EVSE], failureCodes: { [EVSE]: '1006' } };
  assert.deepEqual(pollFailureLines({ ...quiet, lastStatedMs: base.nowMs - PERSISTING_FAILURE_HEARTBEAT_MS + 1 }), { warn: [], info: [] });
  assert.deepEqual(pollFailureLines({ ...quiet, lastStatedMs: base.nowMs - PERSISTING_FAILURE_HEARTBEAT_MS }).info, [
    `poll: 1 device fetch failure(s) persisting (EVSE - Car Charger (${EVSE}): 1006) — daily heartbeat, set unchanged`,
  ]);
});

test('★★★ wiring: the live poll loop warns the delta with codes, logs the recovery and the boot standing set at info', { timeout: 15_000 }, async () => {
  const store = new SnapshotStore();
  const logs: string[] = [];
  const warns: string[] = [];
  const polls = () => logs.filter((l) => l.startsWith('poll:')).length + warns.filter((l) => l.startsWith('poll completed')).length;
  const until = async (pred: () => boolean, what: string) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > 5_000) throw new Error(`timed out waiting for ${what}\n${logs.concat(warns).join('\n')}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  plan = { [EVSE]: E1006 };
  const stop = startPollLoop(store, 40, (m) => logs.push(m), (m) => warns.push(m), () => {});
  try {
    await until(() => polls() >= 1, 'the boot line');
    assert.ok(logs.some((l) => l.startsWith('poll: 1 device(s) failing with product-class error 1006')));
    assert.equal(warns.length, 0, 'the standing set at boot does not warn');
    plan = { [EVSE]: E1006, [CORE2]: E1020 };
    await until(() => warns.some((l) => l.startsWith('poll completed')), 'the growth warn');
    assert.ok(warns.some((l) => l.includes(`1 NEW device fetch failure(s): Core 2 (${CORE2}): 1020`)), warns.join('\n'));
    plan = { [EVSE]: E1006 };
    await until(() => logs.some((l) => l.startsWith('poll: device fetch recovered')), 'the recovery line');
    assert.ok(logs.includes(`poll: device fetch recovered — Core 2 (${CORE2}); 1 failing in total`));
    assert.equal(warns.filter((l) => l.startsWith('poll completed')).length, 1, 'the recovery did not warn');
  } finally {
    stop();
  }
});
