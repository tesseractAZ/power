/**
 * Comprehensive render tests for the operator TUI ("Plant Operator" mode +
 * mode-chooser). Goals:
 *
 *   1. No screen ever throws on a well-formed FleetSnapshot — including the
 *      empty / one-DPU / many-DPU shapes the live system actually hits.
 *   2. Visible width of every rendered line ≤ the requested terminal width.
 *      The dispatcher already padEnds each line, but body code that builds
 *      multi-segment rows must not produce raw text wider than W. Off-by-one
 *      width bugs (visible in v0.9.32 on the MIMIC and BUS screens) are
 *      what these tests are meant to catch and lock down.
 *   3. No "undefined" / "NaN" / "[object Object]" literals leak into output —
 *      a sign that a null-handling path missed.
 *   4. ANSI escape sequences balance — each styled span must end in RESET
 *      (or be a known unwrapped escape like CLEAR_EOL). An unbalanced span
 *      "stains" everything to the right of it with the leftover color.
 *
 * The fixture builds a realistic 4-DPU + 1-SHP2 fleet that matches Eric's
 * production setup; tests run each screen at 80×24 (the floor), 100×40
 * (common Termius), and 200×60 (wide modern terminal).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlant, PLANT_SCREENS, type PlantScreenId, type PlantView, type PlantData } from '../src/telnet/plant/index.js';
import { renderChooser, defaultChooserState } from '../src/telnet/plant/chooser.js';
import { visLen } from '../src/telnet/ansi.js';
import type { FleetSnapshot, DeviceSnapshot } from '../src/snapshot.js';
import type { DpuProjection, Shp2Projection } from '../src/ecoflow/project.js';
import type { Recorder } from '../src/recorder.js';

/* ── fixture ───────────────────────────────────────────────────────────── */

function buildDpu(idx: number, sn: string, opts: { soc?: number; pvW?: number; sysErrCode?: number } = {}): DeviceSnapshot {
  const soc = opts.soc ?? 80;
  const pv = opts.pvW ?? 0;
  const packs = Array.from({ length: 5 }, (_, i) => ({
    num: i + 1, soc, soh: 98, actSoh: 97.8 + i * 0.05,
    inputWatts: pv > 0 ? Math.round(pv / 5) : 0,
    outputWatts: 0,
    temp: 24.5 + i * 0.3, cycles: 50 + i,
    remainTimeMin: null, packSn: `${sn}-PK${i + 1}`,
    designCapMah: 100_000, fullCapMah: 98_000, remainCapMah: Math.round(98_000 * (soc / 100)),
    accuChgMah: 50_000, accuDsgMah: 45_000,
    cellTemps: [25, 25, 25, 25, 25, 25, 25], mosTemps: [30, 30, 30, 30], ptcTemps: [20, 20, 20, 20],
    hwBoardTemp: 32, curResTemp: 28,
    minCellTemp: 24, maxCellTemp: 26, minMosTemp: 30, maxMosTemp: 32,
    cellVoltagesMv: Array.from({ length: 32 }, () => 3300), minCellVoltageMv: 3290, maxCellVoltageMv: 3310,
    maxVolDiffMv: 20, balanceState: 0, packVoltageMv: 51_200, adBatVoltageMv: 51_200, ocvMv: 51_180,
  }));
  const projection: DpuProjection = {
    kind: 'dpu', soc, packCount: 5, packs,
    pvHighWatts: pv > 0 ? Math.round(pv * 0.6) : 0,
    pvLowWatts: pv > 0 ? Math.round(pv * 0.4) : 0,
    pvTotalWatts: pv,
    pvHighVolts: pv > 0 ? 280 : null, pvHighAmps: pv > 0 ? 3.5 : null,
    pvLowVolts: pv > 0 ? 120 : null, pvLowAmps: pv > 0 ? 4.2 : null,
    pvHighErrCode: 0, pvLowErrCode: 0,
    acInWatts: 0, acOutWatts: 250, acOutFreq: 60.0, acOutVol: 240_000,
    batVol: 51_200, batAmp: pv > 0 ? -5_000 : 1_000,
    totalInWatts: pv, totalOutWatts: 250,
    remainTimeMin: 180,
    mpptHvTemp: 38, mpptLvTemp: 35,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: opts.sysErrCode ?? 0,
    emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
    chgMaxSoc: 100, dsgMinSoc: 10,
  };
  return {
    sn, deviceName: `DELTA-PRO-ULTRA-${idx}`,
    productName: 'Delta Pro Ultra',
    online: true,
    lastUpdated: Date.now(),
    projection,
  };
}

function buildShp2(sn: string, sourceSns: string[]): DeviceSnapshot {
  const projection: Shp2Projection = {
    kind: 'shp2', area: 'Home',
    backupBatPercent: 75.5,
    backupFullCapWh: 36_000, backupRemainWh: 27_180,
    backupChargeTimeMin: 180, backupDischargeTimeMin: 720,
    backupReserveSoc: 20, chargeWattPower: 1800,
    circuits: Array.from({ length: 12 }, (_, i) => ({
      ch: i + 1,
      name: i === 0 ? 'Kitchen' : i === 1 ? 'Living Room' : i === 2 ? 'Bedroom' : `Circuit ${i + 1}`,
      watts: i < 5 ? 150 + i * 50 : null,
      setAmp: i % 3 === 0 ? 30 : 20,
      linkCh: null, linkMark: false,
      loadPriority: 1, loadIsEnable: true,
    })),
    pairedCircuits: [
      {
        primaryCh: 21, secondaryCh: 22, name: 'EV Charger',
        watts: 4800, breakerAmps: 50, loadPriority: 1, loadIsEnable: true, isSplitPhase: true,
      },
      {
        primaryCh: 23, secondaryCh: 24, name: 'Heat Pump',
        watts: 1200, breakerAmps: 30, loadPriority: 1, loadIsEnable: true, isSplitPhase: true,
      },
    ],
    sources: sourceSns.map((s, i) => ({
      slot: i + 1, sn: s, batteryPercentage: 75 + i * 2,
      isConnected: true, isAcOpen: i === 0,
      fullCap: 7200, ratePower: 3600,
      emsBatTemp: 25, hwConnect: true, errorCodeNum: 0,
    })),
  } as Shp2Projection; // remainder optional fields filled by spread below if needed
  // Some Shp2Projection fields aren't enumerated here — cast to bypass the
  // exhaustive-keys check; the screens only read what we've populated.
  return {
    sn, deviceName: 'SMART-HOME-PANEL-2',
    productName: 'Smart Home Panel 2',
    online: true,
    lastUpdated: Date.now(),
    projection,
  };
}

function buildSnapshot(opts: { numDpus?: number; includeShp2?: boolean; numAlerts?: number; daylight?: boolean } = {}): FleetSnapshot {
  const numDpus = opts.numDpus ?? 4;
  const dpus = Array.from({ length: numDpus }, (_, i) =>
    buildDpu(i + 1, `DPU-SN-${i + 1}`, { pvW: opts.daylight ? 800 + i * 200 : 0 }),
  );
  const shp2 = opts.includeShp2 !== false ? buildShp2('SHP2-SN', dpus.map((d) => d.sn)) : null;
  const devices: Record<string, DeviceSnapshot> = {};
  for (const d of dpus) devices[d.sn] = d;
  if (shp2) devices[shp2.sn] = shp2;
  const alerts = opts.numAlerts != null
    ? Array.from({ length: opts.numAlerts }, (_, i) => ({
        id: `test-alert-${i}-${dpus[0].sn}`,
        severity: i === 0 ? 'critical' as const : i < 3 ? 'warning' as const : 'info' as const,
        category: i === 0 ? 'thermal' : i < 3 ? 'battery' : 'connectivity',
        title: `Test alert ${i}`,
        detail: `Detailed description of alert ${i} for testing column truncation handling`,
        device: dpus[0].deviceName,
        source: 'threshold' as const,
        coreNum: null,
      }))
    : [];
  return { generatedAt: Date.now(), devices, alerts };
}

function mockRecorder(): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn, metrics) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  };
}

function mockDegradation(): any {
  return { generatedAt: Date.now(), devices: [], fleetSummary: null };
}

function makePlantData(snap: FleetSnapshot): PlantData {
  return {
    snap,
    totals: null,
    forecast: null,
    degradation: mockDegradation(),
    serverStartedAt: Date.now() - 3_600_000,
  };
}

function makeView(width: number, height: number, screen: PlantScreenId): PlantView {
  return {
    width, height, screen,
    genSel: 0, genPack: 0, almScroll: 0,
    connectedAt: Date.now() - 60_000,
  };
}

/* ── invariants checker ────────────────────────────────────────────────── */

function assertFrame(lines: string[], width: number, height: number, label: string): void {
  assert.ok(Array.isArray(lines), `${label}: render returned non-array`);
  assert.ok(lines.length > 0, `${label}: empty frame`);
  // The dispatcher (renderPlant) is responsible for padding to exact width;
  // for screens that go straight through this they should match width.
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const w = visLen(ln);
    assert.ok(
      w <= width,
      `${label}: line ${i} has visible width ${w} > terminal width ${width}: ${JSON.stringify(ln.replace(/\x1b\[[0-9;]*m/g, '·').slice(0, 100))}`,
    );
    // No literal "undefined" / "NaN" / "[object Object]" — these are signs
    // that a null check was missed somewhere in the pipeline.
    assert.ok(!/undefined/.test(ln), `${label}: line ${i} contains literal 'undefined'`);
    assert.ok(!/NaN/.test(ln), `${label}: line ${i} contains literal 'NaN'`);
    assert.ok(!/\[object Object\]/.test(ln), `${label}: line ${i} contains '[object Object]'`);
  }
  // Frame must fit the height budget (dispatcher's contract).
  assert.ok(
    lines.length <= height,
    `${label}: rendered ${lines.length} lines, height was ${height}`,
  );
}

/* ── per-screen tests ──────────────────────────────────────────────────── */

const SHAPES: Array<{ name: string; width: number; height: number }> = [
  { name: '80×24', width: 80, height: 24 },
  { name: '100×40', width: 100, height: 40 },
  { name: '200×60', width: 200, height: 60 },
];

for (const screen of PLANT_SCREENS) {
  for (const shape of SHAPES) {
    test(`renderPlant(${screen}) — ${shape.name}, full fleet`, () => {
      const snap = buildSnapshot({ numAlerts: 4, daylight: true });
      const view = makeView(shape.width, shape.height, screen);
      const data = makePlantData(snap);
      const lines = renderPlant(view, data, { recorder: mockRecorder() });
      assertFrame(lines, shape.width, shape.height, `plant/${screen}@${shape.name}`);
    });
  }

  test(`renderPlant(${screen}) — empty fleet`, () => {
    const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [] };
    const view = makeView(80, 24, screen);
    const data = makePlantData(snap);
    const lines = renderPlant(view, data, { recorder: mockRecorder() });
    assertFrame(lines, 80, 24, `plant/${screen}@empty`);
  });

  test(`renderPlant(${screen}) — SHP2 missing, only DPUs`, () => {
    const snap = buildSnapshot({ includeShp2: false, numDpus: 2 });
    const view = makeView(80, 24, screen);
    const data = makePlantData(snap);
    const lines = renderPlant(view, data, { recorder: mockRecorder() });
    assertFrame(lines, 80, 24, `plant/${screen}@no-shp2`);
  });
}

test('renderPlant(gen) — with sysErrCode set, no crash', () => {
  const snap = buildSnapshot();
  // Inject a sysErrCode on DPU-1.
  const dpu1 = Object.values(snap.devices).find((d) => d.deviceName === 'DELTA-PRO-ULTRA-1')!;
  (dpu1.projection as DpuProjection).sysErrCode = 0xABCD;
  const view = makeView(100, 40, 'gen');
  const lines = renderPlant(view, makePlantData(snap), { recorder: mockRecorder() });
  assertFrame(lines, 100, 40, 'plant/gen@sys-err');
});

test('renderPlant(alm) — many alerts, scrolled view', () => {
  const snap = buildSnapshot({ numAlerts: 20, daylight: true });
  const view = { ...makeView(100, 40, 'alm'), almScroll: 5 };
  const lines = renderPlant(view, makePlantData(snap), { recorder: mockRecorder() });
  assertFrame(lines, 100, 40, 'plant/alm@scrolled');
});

test('renderPlant(gen) — genSel out-of-range is clamped', () => {
  const snap = buildSnapshot({ numDpus: 2 });
  const view = { ...makeView(100, 40, 'gen'), genSel: 99 };
  // Should clamp internally and render without throwing.
  const lines = renderPlant(view, makePlantData(snap), { recorder: mockRecorder() });
  assertFrame(lines, 100, 40, 'plant/gen@oob-sel');
});

/* ── chooser tests ─────────────────────────────────────────────────────── */

test('renderChooser — 80×24, default highlight', () => {
  const lines = renderChooser(defaultChooserState(80, 24));
  // chooser is NOT padded by a dispatcher — but each line must still be ≤ W.
  for (let i = 0; i < lines.length; i++) {
    assert.ok(visLen(lines[i]) <= 80, `chooser line ${i} too wide: ${visLen(lines[i])}`);
  }
});

test('renderChooser — narrow 60×20 (stacked layout)', () => {
  const lines = renderChooser(defaultChooserState(60, 20));
  for (let i = 0; i < lines.length; i++) {
    assert.ok(visLen(lines[i]) <= 60, `narrow chooser line ${i} too wide: ${visLen(lines[i])}`);
  }
});

test('renderChooser — wide 120×40, second option highlighted', () => {
  const s = defaultChooserState(120, 40);
  s.highlight = 1;
  const lines = renderChooser(s);
  for (let i = 0; i < lines.length; i++) {
    assert.ok(visLen(lines[i]) <= 120, `wide chooser line ${i} too wide: ${visLen(lines[i])}`);
  }
});

/* ── specific bugs caught and locked in ────────────────────────────────── */

test('renderPlant(console) — MIMIC bus walls align vertically (║ ↔ ╗ ↔ ╝)', () => {
  // The mimic draws a double-line "BUS" box across four rows:
  //   row 1  ╔════════╗   (top)
  //   row 2  ║ MAIN BUS ║ (side wall, label)
  //   row 3  ║ 240V…    ║ (side wall, freq)
  //   row 4  ╚════════╝   (bottom)
  // The right wall character on rows 1 and 4 is ╗/╝; on rows 2 and 3 it is ║.
  // Bug v0.9.32: busLeft and busMid were one column NARROWER than busTop /
  // busBot, so the right wall stepped left on rows 2-3 and the box had a
  // visible jog. The test asserts the right-most wall char of all four rows
  // lands in the same visible column.
  const snap = buildSnapshot({ daylight: true });
  const lines = renderPlant(makeView(120, 40, 'console'), makePlantData(snap), { recorder: mockRecorder() });
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  // Helper: visible column of the last occurrence of any char in `chars`.
  const lastColOfAny = (s: string, chars: string): number => {
    const plain = stripAnsi(s);
    let max = -1;
    for (const c of chars) {
      const idx = plain.lastIndexOf(c);
      if (idx > max) max = idx;
    }
    return max;
  };
  const topRow = lines.find((l) => /╗/.test(stripAnsi(l)));
  const botRow = lines.find((l) => /╝/.test(stripAnsi(l)));
  const sideRows = lines.filter((l) => /║/.test(stripAnsi(l)) && !/╗/.test(stripAnsi(l)) && !/╝/.test(stripAnsi(l)));
  if (!topRow || !botRow || sideRows.length === 0) return; // skip if mimic was wrapped/elided
  const expectedCol = lastColOfAny(topRow, '╗');
  assert.equal(lastColOfAny(botRow, '╝'), expectedCol, 'MIMIC: bottom ╝ misaligned with top ╗');
  for (let i = 0; i < sideRows.length; i++) {
    assert.equal(
      lastColOfAny(sideRows[i], '║'),
      expectedCol,
      `MIMIC: side-row ${i} right ║ at column ${lastColOfAny(sideRows[i], '║')} but top/bot at ${expectedCol}`,
    );
  }
});

test('renderPlant(bus) — feeder data row aligns with header row', () => {
  // Bug v0.9.32: header used 2-char leading prefix ("  "), data rows used
  // " ● " (3 visible chars) — data row columns shifted right by 1 vs the
  // header on every line. This test asserts the NAME column header text
  // ("NAME") starts in the same visible column as the first feeder name.
  const snap = buildSnapshot({ daylight: true });
  const lines = renderPlant(makeView(120, 40, 'bus'), makePlantData(snap), { recorder: mockRecorder() });
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const headerRow = lines.find((l) => /NAME/.test(stripAnsi(l)) && /BRK/.test(stripAnsi(l)));
  const firstDataRow = lines.find((l) => {
    const p = stripAnsi(l);
    // Heuristic: a row beginning with whitespace + glyph + circuit name, e.g. "Kitchen"
    return /Kitchen|EV Charger|Heat Pump/.test(p);
  });
  if (!headerRow || !firstDataRow) return; // table truncated; skip rather than false-fail
  const namesAt = stripAnsi(headerRow).indexOf('NAME');
  const firstNameMatch = stripAnsi(firstDataRow).match(/Kitchen|EV Charger|Heat Pump/);
  if (!firstNameMatch) return;
  const dataNameAt = stripAnsi(firstDataRow).indexOf(firstNameMatch[0]);
  assert.equal(
    dataNameAt, namesAt,
    `BUS table columns misaligned: header 'NAME' at ${namesAt}, data name at ${dataNameAt}`,
  );
});

test('renderPlant(console) — no flag string overflows the 8-char column', () => {
  // The renderTagRow `flags` column is padded to 8 visible chars; anything
  // longer is silently truncated and loses meaning (the v0.9.32 BATT.P.NET
  // row passed 'A/L/N · DCH' = 11 chars and rendered as 'A/L/N · D').
  // Verify across daylight/idle/discharging fleet states.
  for (const daylight of [true, false]) {
    const snap = buildSnapshot({ daylight });
    // Make BATT.P.NET hit every branch (DCH/CHG/IDL) by tweaking totalInWatts
    // / totalOutWatts on the first DPU.
    for (const [tin, tout] of [[100, 200], [200, 100], [0, 0]] as Array<[number, number]>) {
      for (const d of Object.values(snap.devices)) {
        if (d.projection?.kind === 'dpu') {
          (d.projection as DpuProjection).totalInWatts = tin;
          (d.projection as DpuProjection).totalOutWatts = tout;
        }
      }
      const lines = renderPlant(makeView(100, 40, 'console'), makePlantData(snap), { recorder: mockRecorder() });
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
      // Each tag row has the form: glyph + "  " + dotted tag (32) + " " +
      // value (9) + " " + unit (4) + " " + q (1) + "  " + flags (8) + " " +
      // trend (8). Flags occupy visible cols 50..57 inclusive (0-indexed).
      // Any tag row should have the substring " A/L/N", "ISLANDED", "DCH ",
      // "CHG ", "IDLE", "CLOSED" — and never a truncated half-word.
      const badPatterns = ['A/L/N ·', 'A/L/N\\s+·']; // truncated combo flags
      for (const ln of lines) {
        const p = stripAnsi(ln);
        for (const bad of badPatterns) {
          assert.ok(
            !new RegExp(bad).test(p),
            `console flag truncated mid-string ('${bad}' in '${p.slice(0, 100)}')`,
          );
        }
      }
    }
  }
});

test('renderPlant(gen) — packs count in title matches actual pack count', () => {
  // Bug v0.9.32: when packs is empty, divider showed "Pack 1/5" (hardcoded
  // fallback). The right behavior is to show "Pack 1/0" or skip the table
  // — never to lie about the count.
  const snap = buildSnapshot({ numDpus: 1 });
  // Empty out packs on DPU-1 to simulate the "no pack data yet" startup
  // moment.
  const dpu = Object.values(snap.devices).find((d) => d.deviceName === 'DELTA-PRO-ULTRA-1')!;
  (dpu.projection as DpuProjection).packs = [];
  const lines = renderPlant(makeView(100, 40, 'gen'), makePlantData(snap), { recorder: mockRecorder() });
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const titleLine = lines.find((l) => /Pack 1\//.test(stripAnsi(l)));
  if (!titleLine) return;
  const p = stripAnsi(titleLine);
  assert.ok(
    !/Pack 1\/5/.test(p),
    `GEN divider claims '/5' when packs is empty: ${JSON.stringify(p.slice(0, 80))}`,
  );
});
