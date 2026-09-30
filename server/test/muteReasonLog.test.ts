/**
 * v1.187.0 — the silent-critical log line names the device, the pack and the REAL reason.
 *
 * 09-29 15:29:48, 15:32:08 and 15:34:28: three "held non-annunciating by policy (bench spare or
 * off-panel Core)" lines. All three were HOME-pool packs — Core 5 pack 3 (90 mV), Core 1 pack 1
 * (93 mV), Core 5 pack 1 (101 mV) — muted by the BMS-balancing gate, and both pushed as
 * [Critical] the moment balancing stopped. The line named no device or pack and blamed the wrong
 * policy, which misdirected the review of a life-safety alarm path. Each muting site now stamps
 * Alert.muteReason; the line reads it. muteReason is DIAGNOSTIC ONLY.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAlerts, MUTE_REASON_BALANCING, MUTE_REASON_PLATEAU, MUTE_REASON_BENCH_SPARE, MUTE_REASON_OFF_PANEL, type Alert } from '../src/alerts.js';
import { silentCriticalEdges, silentCriticalLine, monitorMuteReason, shouldDemoteAnnunciation, autoTuneCounts } from '../src/alertMonitor.js';
import { conditionFromAlerts } from '../src/broadcast.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

function dpu(sn: string, name: string, pack: Record<string, unknown>, soc = 50): Record<string, DeviceSnapshot> {
  const projection = {
    kind: 'dpu', soc,
    packs: [{ num: 3, ...pack }],
    pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
    pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
    batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
  };
  return { [sn]: { sn, deviceName: name, productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(), projection } as unknown as DeviceSnapshot };
}

test('★★★ the 15:29:48 shape: a home Core pack muted while BALANCING is named, with the balancing reason', () => {
  const alerts = computeAlerts(dpu('COREXXX00XXX0005', 'Core 5', { maxVolDiffMv: 90, balanceState: 1, packSn: 'PACKXXX00XXX0042' }));
  const crit = alerts.find((a) => a.id === 'vdiff-crit-COREXXX00XXX0005-3');
  assert.ok(crit, 'the critical is raised (visible)');
  assert.equal(crit!.annunciate, false);
  assert.equal(crit!.muteReason, MUTE_REASON_BALANCING);
  const fresh = silentCriticalEdges(new Set<string>(), alerts);
  assert.deepEqual(fresh.map((a) => a.id), ['vdiff-crit-COREXXX00XXX0005-3']);
  const line = silentCriticalLine(fresh[0]);
  assert.match(line, /— Core 5 pack 3 \(SN …XX0042\) is CRITICAL but held non-annunciating \(the BMS is balancing the cells\)/);
  assert.doesNotMatch(line, /bench spare|off-panel/, 'the old line blamed a policy that did not apply');
});

test('★★ the plateau mute names itself', () => {
  // 96% SoC, warn-band spread, BMS idle: the v1.45.0 top-of-charge quiet.
  const alerts = computeAlerts(dpu('COREXXX00XXX0001', 'Core 1', { maxVolDiffMv: 30, balanceState: 0 }, 96));
  const warn = alerts.find((a) => a.id === 'vdiff-warn-COREXXX00XXX0001-3');
  assert.equal(warn?.annunciate, false);
  assert.equal(warn?.muteReason, MUTE_REASON_PLATEAU);
});

test('★★ the monitor gate says bench spare or off-panel by WHICH list muted it', () => {
  assert.equal(monitorMuteReason({ id: 'vdiff-crit-SPARXXX00XXX0003-2' }, ['SPARXXX00XXX0003']), MUTE_REASON_BENCH_SPARE);
  assert.equal(monitorMuteReason({ id: 'vdiff-crit-COREXXX00XXX0004-2' }, ['SPARXXX00XXX0003']), MUTE_REASON_OFF_PANEL);
  assert.equal(monitorMuteReason({ id: 'vdiff-crit-COREXXX00XXX0004-2' }, []), MUTE_REASON_OFF_PANEL);
  const line = silentCriticalLine({ title: 'Cell imbalance', device: 'Core 4', coreNum: 4, packNum: 2, muteReason: MUTE_REASON_OFF_PANEL });
  assert.equal(line, 'alerts: "Cell imbalance" — Core 4 pack 2 is CRITICAL but held non-annunciating (off-panel Core — not on the panel roster) — on-screen only, never spoken or pushed');
});

test('a mute stamped with no reason says so instead of guessing one', () => {
  const line = silentCriticalLine({ title: 'Something', device: 'System', muteReason: undefined });
  assert.equal(line, 'alerts: "Something" is CRITICAL but held non-annunciating (by policy — reason not recorded) — on-screen only, never spoken or pushed');
});

test('★★★ muteReason is diagnostic only: no mute, audible or auto-tune decision reads it', () => {
  // An alert carrying a reason but NOT muted behaves exactly as an annunciating alert.
  const a: Alert = { id: 'vdiff-crit-COREXXX00XXX0001-1', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Cell imbalance', detail: 'x', muteReason: MUTE_REASON_BALANCING };
  assert.equal(conditionFromAlerts([a]).level, 'red', 'still raises the audible condition');
  assert.equal(autoTuneCounts(a), true);
  assert.equal(shouldDemoteAnnunciation(a, []), false);
  assert.deepEqual(silentCriticalEdges(new Set<string>(), [a]), [], 'not a silent critical: annunciate is the gate');
  // And in the source: the only READ of the field is the log line.
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const reads: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(join(dir, e.name)); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const text = readFileSync(join(dir, e.name), 'utf8');
      const lines = text.split('\n');
      for (const m of text.matchAll(/\.muteReason\b(?!\s*=[^=])/g)) {
        const n = text.slice(0, m.index).split('\n').length;
        if (/^\s*(\*|\/\/|\/\*)/.test(lines[n - 1])) continue; // prose in a comment is not a read
        reads.push(`${e.name}:${n}`);
      }
    }
  };
  walk(src);
  const monitor = readFileSync(join(src, 'alertMonitor.ts'), 'utf8');
  const lineOf = (i: number) => monitor.slice(0, i).split('\n').length;
  // v1.187.0 review — the two log-line functions: the line itself, and its once-per-(id, reason) edge.
  const spans = ['export function silentCriticalLine(', 'export function silentCriticalEdges<'].map((sig) => {
    const fnStart = monitor.indexOf(sig);
    const fnEnd = monitor.indexOf('\n}\n', fnStart);
    assert.ok(fnStart > 0 && fnEnd > fnStart, sig);
    return [lineOf(fnStart), lineOf(fnEnd)] as const;
  });
  assert.deepEqual(
    reads.filter((r) => { const [f, l] = r.split(':'); return !(f === 'alertMonitor.ts' && spans.some(([a, b]) => +l >= a && +l <= b)); }),
    [],
    'muteReason is read only by the silent-critical log line and its edge detector',
  );
});
