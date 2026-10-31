import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forceChargeSlotCores, forceChargeFailedSlotsText, DPU_WORK_MODE_NAMES, type ForceChargeSlotCore,
} from '../src/nightForceCharge.js';
import { buildNightForceChargeOnFailure } from '../src/notify.js';

/**
 * v1.196.0 — THE FORCE-CHARGE ON-FAILURE WARNING NAMES THE CORE, AND WHAT ABOUT IT DIFFERS.
 *
 * On 2026-10-06 slot 3 did not take Charge Now, and the warning said only "still reads slot(s) 3
 * OFF … if this repeats, check the SHP2 cloud link". The fact that explained the repeats was in the
 * store and in no message: the Core in slot 3 (Core 5) ran work mode 3 (time-of-use) with its own
 * backup reserve at 60%, where the other Cores read work mode 0 and 50%. The warning and its log line
 * now name each failed slot's Core, say when the cloud does not have it, and name its work mode or
 * its own backup reserve when that differs from the other Cores'.
 */

const core = (slot: number, label: string | null, workMode: number | null, backupSocPct: number | null, online: boolean | null = true): ForceChargeSlotCore =>
  ({ slot, label, online, workMode, backupSocPct });
/** The 10-06 panel: Cores 1 and 2 in slots 1 and 2 at work mode 0 / 50%, Core 5 in slot 3 at 3 / 60%. */
const PANEL_1006 = [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', 3, 60)];
const warn = (slots: number[], ours: number[] | null, cores: ForceChargeSlotCore[] | null | undefined) =>
  buildNightForceChargeOnFailure({ day: '2026-10-06', slots, ourSlots: ours, retries: 1, noRetry: false, ceilingPct: 80.4, cores }).body;

test('★★★ THE 10-06 SHAPE: slot 3 is named as Core 5, with its work mode and its own reserve against the other Cores\'', () => {
  const b = warn([3], [1, 2, 3], PANEL_1006);
  assert.equal(b, 'The night-charge for 2026-10-06 switched force-charge ("Charge Now") ON, but the Smart Home Panel 2 still reads '
    + 'slot(s) 3 (Core 5 — work mode 3 (time-of-use), where the other Cores read 0 (default); its own backup reserve 60%, where the other Cores read 50%) '
    + "OFF after 1 re-issue(s). Tonight's buy above the 50% reserve (toward ~80%) will not happen on those slot(s); the reserve charge is unaffected. "
    + "No action needed tonight — but if this repeats, check the SHP2 cloud link, and compare that Core's work mode and backup reserve with the other Cores' in the EcoFlow app.");
  assert.deepEqual(forceChargeFailedSlotsText([3], [1, 2, 3], PANEL_1006), {
    text: '3 (Core 5 — work mode 3 (time-of-use), where the other Cores read 0 (default); its own backup reserve 60%, where the other Cores read 50%)',
    differing: 1,
  });
});

test('★★★ a Core whose settings match the others\' is named, with nothing to compare', () => {
  const same = [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', 0, 50)];
  const b = warn([3], [1, 2, 3], same);
  assert.match(b, /still reads slot\(s\) 3 \(Core 5\) OFF after 1 re-issue\(s\)\./);
  assert.match(b, /check the SHP2 cloud link\.$/);
  assert.doesNotMatch(b, /work mode|backup reserve \d|compare/);
  // One setting differs: only that one is named.
  assert.equal(forceChargeFailedSlotsText([3], [1, 2, 3], [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', 0, 60)]).text,
    '3 (Core 5 — its own backup reserve 60%, where the other Cores read 50%)');
});

test('★★★ every slot failed: each named, none compared (there is no other Core)', () => {
  const r = forceChargeFailedSlotsText([1, 2, 3], [1, 2, 3], PANEL_1006);
  assert.deepEqual(r, { text: '1 (Core 1), 2 (Core 2), 3 (Core 5)', differing: 0 });
  assert.match(warn([1, 2, 3], [1, 2, 3], PANEL_1006), /slot\(s\) 1 \(Core 1\), 2 \(Core 2\), 3 \(Core 5\) OFF after .* will not happen; .*cloud link\.$/);
});

test('★★ the other Cores\' values, each named once and in order; a value one of them shares is no difference', () => {
  const mixed = [core(1, 'Core 1', 2, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', 3, 50), core(4, 'Core 4', 0, 50)];
  assert.equal(forceChargeFailedSlotsText([3], [1, 2, 3, 4], mixed).text,
    '3 (Core 5 — work mode 3 (time-of-use), where the other Cores read 0 (default) / 2 (scheduled))');
  const shared = [core(1, 'Core 1', 2, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', 0, 50)];
  assert.equal(forceChargeFailedSlotsText([3], [1, 2, 3], shared).text, '3 (Core 5)');
  // Two failed slots that both differ: "those Cores'".
  const two = [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 3, 50), core(3, 'Core 5', 3, 60)];
  const r = forceChargeFailedSlotsText([2, 3], [1, 2, 3], two);
  assert.equal(r.differing, 2);
  assert.match(warn([2, 3], [1, 2, 3], two), /and compare those Cores' work mode and backup reserve with the other Cores' in the EcoFlow app\.$/);
});

test('★★ an unknown mode is not compared; a mode with no name is given as its number', () => {
  assert.equal(forceChargeFailedSlotsText([3], [1, 2, 3], [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', null, 50)]).text, '3 (Core 5)');
  assert.equal(forceChargeFailedSlotsText([3], [1, 2, 3], [core(1, 'Core 1', null, null), core(2, 'Core 2', null, null), core(3, 'Core 5', 3, 60)]).text,
    '3 (Core 5)', 'nothing known on the others: nothing to compare with');
  assert.equal(forceChargeFailedSlotsText([3], [1, 2, 3], [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', 7, 50)]).text,
    '3 (Core 5 — work mode 7, where the other Cores read 0 (default))');
  assert.deepEqual({ ...DPU_WORK_MODE_NAMES }, { 0: 'default', 1: 'self-powered', 2: 'scheduled', 3: 'time-of-use' });
});

test('★★★ a Core the cloud does not have is said to be offline — its settings are its last report', () => {
  const off = [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 0, 50), core(3, 'Core 5', 3, 60, false)];
  assert.equal(forceChargeFailedSlotsText([3], [1, 2, 3], off).text,
    '3 (Core 5 — offline in the cloud; work mode 3 (time-of-use), where the other Cores read 0 (default); its own backup reserve 60%, where the other Cores read 50%)');
  assert.deepEqual(forceChargeFailedSlotsText([3], [1, 2, 3], [core(1, 'Core 1', 0, 50), core(3, 'Core 5', 0, 50, false)]),
    { text: '3 (Core 5 — offline in the cloud)', differing: 0 });
});

test('★★ a slot whose Core is not in the store keeps its bare number; others keep theirs', () => {
  const r = forceChargeFailedSlotsText([2, 3], [1, 2, 3], [core(1, 'Core 1', 0, 50), core(2, null, null, null, null), core(3, 'Core 5', 0, 50)]);
  assert.deepEqual(r, { text: '2, 3 (Core 5)', differing: 0 });
  // ourSlots unknown: every listed slot but the failed ones is "the other Cores".
  assert.equal(forceChargeFailedSlotsText([3], null, PANEL_1006).differing, 1);
});

test('★★★ "the other Cores" are OURS: a listed slot the force-charge does not drive is never compared', () => {
  // The panel lists slots 1-3 and the night drives 1 and 3. Slot 3 fails at work mode 3; slot 1 (ours)
  // reads 0; slot 2 (not ours) reads 3 too, and must not make the failed Core's mode look shared.
  const listed = [core(1, 'Core 1', 0, 50), core(2, 'Core 2', 3, 60), core(3, 'Core 5', 3, 60)];
  assert.deepEqual(forceChargeFailedSlotsText([3], [1, 3], listed), {
    text: '3 (Core 5 — work mode 3 (time-of-use), where the other Cores read 0 (default); its own backup reserve 60%, where the other Cores read 50%)',
    differing: 1,
  });
  assert.match(warn([3], [1, 3], listed), /and compare that Core's work mode and backup reserve with the other Cores' in the EcoFlow app\.$/);
  // Every listed slot is "the other Cores" only when the record names none of its own.
  assert.deepEqual(forceChargeFailedSlotsText([3], null, listed), { text: '3 (Core 5)', differing: 0 });
});

test('★★★ no cores (no readback, a caller before v1.196.0): the words before v1.196.0, exactly', () => {
  const before = 'The night-charge for 2026-10-06 switched force-charge ("Charge Now") ON, but the Smart Home Panel 2 still reads '
    + "slot(s) 1, 3 OFF after 1 re-issue(s). Tonight's buy above the 50% reserve (toward ~80%) will not happen on those slot(s); the reserve "
    + 'charge is unaffected. No action needed tonight — but if this repeats, check the SHP2 cloud link.';
  for (const cores of [undefined, null, []]) assert.equal(warn([1, 3], [1, 2, 3], cores), before);
  assert.deepEqual(forceChargeFailedSlotsText([1, 3], [1, 2, 3], []), { text: '1, 3', differing: 0 });
});

/* ══ from the store ═══════════════════════════════════════════════════════ */

// Synthetic serials, digits included, so a leak would show as a run of digits in the text.
const SN_PANEL = 'TESTSHP2000000001';
const SN_A = 'TESTDPU0000011111';
const SN_B = 'TESTDPU0000022222';
const SN_C = 'TESTDPU0000033333';
const dpu = (sn: string, deviceName: string, sysWordMode: number | null, sysBackupSoc: number | null, o: { nameFallback?: boolean; online?: boolean } = {}) =>
  ({ sn, deviceName, online: o.online ?? true, ...(o.nameFallback ? { nameFallback: true } : {}), projection: { kind: 'dpu', sysWordMode, sysBackupSoc } });
const DEVICES = {
  [SN_PANEL]: { sn: SN_PANEL, deviceName: 'Smart Home Panel 2', online: true, projection: { kind: 'shp2', sources: [
    { slot: 1, sn: SN_A, isConnected: true }, { slot: 2, sn: SN_B, isConnected: true }, { slot: 3, sn: SN_C, isConnected: true },
  ] } },
  [SN_A]: dpu(SN_A, 'Core 1', 0, 50),
  [SN_B]: dpu(SN_B, 'Core 2', 0, 50),
  // Never named by the owner: its label comes from its slot, never from its serial.
  [SN_C]: dpu(SN_C, 'DELTA Pro Ultra', 3, 60, { nameFallback: true }),
};
const SOURCES = [
  { slot: 1, sn: SN_A, forceCharge: 'FORCE_CHARGE_ON' },
  { slot: 2, sn: SN_B, forceCharge: 'FORCE_CHARGE_ON' },
  { slot: 3, sn: SN_C, forceCharge: 'FORCE_CHARGE_OFF' },
  { slot: 4, sn: null, forceCharge: null },
];

test('★★★ forceChargeSlotCores joins each listed slot to its DPU: label, online, sysWordMode, sysBackupSoc', () => {
  assert.deepEqual(forceChargeSlotCores(SOURCES, DEVICES), [
    { slot: 1, label: 'Core 1', online: true, workMode: 0, backupSocPct: 50 },
    { slot: 2, label: 'Core 2', online: true, workMode: 0, backupSocPct: 50 },
    { slot: 3, label: 'Core 3', online: true, workMode: 3, backupSocPct: 60 },
    { slot: 4, label: null, online: null, workMode: null, backupSocPct: null },
  ]);
  // A DPU with no DPU projection keeps its name; a non-integer slot is skipped; no sources at all is none.
  const noPj = { ...DEVICES, [SN_B]: { sn: SN_B, deviceName: 'Core 2', online: false, projection: null } };
  assert.deepEqual(forceChargeSlotCores([{ slot: 2, sn: SN_B }, { slot: 'x', sn: SN_A }], noPj),
    [{ slot: 2, label: 'Core 2', online: false, workMode: null, backupSocPct: null }]);
  assert.deepEqual(forceChargeSlotCores(null, DEVICES), []);
  assert.deepEqual(forceChargeSlotCores(undefined, DEVICES), []);
});

test('★★★ end to end from the store: the warning names the Core and its settings, and never a serial', () => {
  const b = warn([3], [1, 2, 3], forceChargeSlotCores(SOURCES, DEVICES));
  assert.match(b, /slot\(s\) 3 \(Core 3 — work mode 3 \(time-of-use\), where the other Cores read 0 \(default\); its own backup reserve 60%, where the other Cores read 50%\) OFF/);
  for (const sn of [SN_PANEL, SN_A, SN_B, SN_C]) {
    assert.ok(!b.includes(sn), 'no serial');
    assert.ok(!b.includes(sn.slice(-4)), 'not even its last four');
  }
  assert.doesNotMatch(b, /\d{5,}/, 'no run of five digits');
});

test('★★★ index.ts: the log line and the push name the failed slots from the verify\'s own readback', async () => {
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const at = idx.indexOf("if (action.kind === 'onFailed') {");
  const b = idx.slice(at, idx.indexOf('\n    return;\n  }', at));
  assert.ok(b.includes('const slotCores = forceChargeSlotCores(sources, store.get().devices);'));
  assert.ok(b.includes('const failedSlots = forceChargeFailedSlotsText(action.slots, state.forceChargeSlots, slotCores);'));
  assert.ok(b.includes('ON NEVER TOOK EFFECT for ${state.day} — slot(s) ${failedSlots.text} still read FORCE_CHARGE_OFF'));
  assert.ok(b.includes('cores: slotCores,'));
  // `sources` is the fresh readback runForceChargeTick reads slotsOn from (onFailed needs one).
  const tick = idx.slice(idx.indexOf('async function runForceChargeTick('), at);
  assert.ok(tick.includes("const sources: any[] | null = Array.isArray(sp?.sources) ? sp.sources : null;"));
});
