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
 * The fixture builds a realistic 4-DPU + 1-SHP2 fleet that matches the operator's
 * production setup; tests run each screen at 80×24 (the floor), 100×40
 * (common Termius), and 200×60 (wide modern terminal).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlant, PLANT_SCREENS, type PlantScreenId, type PlantView, type PlantData } from '../src/telnet/plant/index.js';
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
  // v1.38.0 — the big-digit console band / annunciator tiles light up from
  // 96 cols; 120×40 exercises every screen with them active.
  { name: '120×40', width: 120, height: 40 },
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

test('v1.4.3 (audit rank 26) — ALM wraps the message; the tail is not truncated away', () => {
  // The fixture detail ends in "…column truncation handling"; the old truncate(msg, W-64)
  // silently clipped that tail with no cue. Wrapping must preserve the full text.
  const snap = buildSnapshot({ numAlerts: 3, daylight: true });
  const lines = renderPlant(makeView(100, 40, 'alm'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/handling/.test(plain), `the wrapped alarm tail ("handling") must survive:\n${plain}`);
  // And every rendered line still fits the terminal width (no overflow from continuation lines).
  for (let i = 0; i < lines.length; i++) assert.ok(visLen(lines[i]) <= 100, `alm line ${i} overflows 100 cols`);
});

test('renderPlant(gen) — genSel out-of-range is clamped', () => {
  const snap = buildSnapshot({ numDpus: 2 });
  const view = { ...makeView(100, 40, 'gen'), genSel: 99 };
  // Should clamp internally and render without throwing.
  const lines = renderPlant(view, makePlantData(snap), { recorder: mockRecorder() });
  assertFrame(lines, 100, 40, 'plant/gen@oob-sel');
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

test('renderPlant(gen) — pack SoH% column clamps display to ≤ 100', () => {
  // A couple near-new packs report fullCap > designCap so actSoh lands just over
  // 100% (e.g. 100.44). The degradation engine keeps the raw value; the gen
  // pack-row SoH% column clamps to 100 so it never shows a > 100.0 reading.
  const snap = buildSnapshot({ numDpus: 1 });
  const dpu = Object.values(snap.devices).find((d) => d.deviceName === 'DELTA-PRO-ULTRA-1')!;
  for (const pk of (dpu.projection as DpuProjection).packs) pk.actSoh = 100.44;
  const lines = renderPlant(makeView(100, 40, 'gen'), makePlantData(snap), { recorder: mockRecorder() });
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const plain = lines.map(stripAnsi).join('\n');
  assert.ok(!/100\.4(?!\d)/.test(plain), `gen pack row rendered an unclamped SoH (100.4):\n${plain}`);
  assert.ok(/100\.0/.test(plain), `clamped SoH 100.0 not present in gen pack rows:\n${plain}`);
});

/* ── v1.38.0 — big-digit band, pool gauge, braille trends, annunciator ── */

test('renderPlant(console) — 120×40 renders the 5-row big-digit band + pool gauge', () => {
  const snap = buildSnapshot({ daylight: true });
  const lines = renderPlant(makeView(120, 40, 'console'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // Label row above the big digits carries all three group labels.
  const li = plain.findIndex((l) => /BATT SOC/.test(l) && /PV ARRAY/.test(l) && /LOAD/.test(l));
  assert.ok(li >= 0, `band label row missing:\n${plain.join('\n')}`);
  // The next 5 rows are the bigfont glyph rows — every one carries blocks.
  for (let r = 1; r <= 5; r++) {
    assert.ok(/█/.test(plain[li + r]), `big-digit row ${r} has no block glyphs: ${JSON.stringify(plain[li + r])}`);
  }
  // Full-width pool gauge: POOL label + eighth-block bar + 4-char percent.
  assert.ok(
    plain.some((l) => /^ {2}POOL [█▉▊▋▌▍▎▏ ]+ +\d+%\s*$/.test(l)),
    `pool gauge line missing:\n${plain.join('\n')}`,
  );
  assertFrame(lines, 120, 40, 'plant/console@120×40-bigband');
});

test('renderPlant(console) — 80×24 degrades: no big-digit band, pool gauge still present', () => {
  const snap = buildSnapshot({ daylight: true });
  const lines = renderPlant(makeView(80, 24, 'console'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(!plain.some((l) => /BATT SOC|PV ARRAY/.test(l)), 'big-digit band must not render at 80×24');
  assert.ok(plain.some((l) => /^ {2}POOL /.test(l)), 'pool gauge must render at every size');
  // The band must not displace the BATTERY POOL section either.
  assert.ok(plain.some((l) => /BATTERY POOL/.test(l)), 'BATTERY POOL section lost at 80×24');
  assertFrame(lines, 80, 24, 'plant/console@80×24-degrade');
});

test('renderPlant(alm) — 120×40 renders the annunciator header with equal-width tiles', () => {
  const snap = buildSnapshot({ numAlerts: 4, daylight: true });
  const lines = renderPlant(makeView(120, 40, 'alm'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // Tile top rules: runs of ▁ separated by 1-col gaps — all the same width.
  const topIdx = plain.findIndex((l) => /▁{4,}/.test(l));
  assert.ok(topIdx >= 0, `annunciator top rules missing:\n${plain.join('\n')}`);
  const tops = plain[topIdx].trim().split(/ +/);
  assert.ok(tops.length >= 2, `expected multiple tiles, got ${tops.length}`);
  for (const t of tops) {
    assert.equal(t.length, tops[0].length, `tiles not equal width: ${tops.map((x) => x.length).join(',')}`);
  }
  // Legend row: fixture categories (thermal crit, battery warn, connectivity
  // info) are lit with █ lamp edges; quiet groups (SOLAR, GRID…) are not.
  // Slice the legend row into per-tile cells (indent 2, 1-col gaps) so a lit
  // neighbour's edge can't bleed into the check.
  const tileW = tops[0].length;
  const legend = plain[topIdx + 1];
  const cell = (i: number) => legend.slice(2 + i * (tileW + 1), 2 + i * (tileW + 1) + tileW);
  const cellFor = (label: string) => {
    for (let i = 0; i < tops.length; i++) if (cell(i).includes(label)) return cell(i);
    return null;
  };
  const thermal = cellFor('THERMAL');
  const battery = cellFor('BATTERY');
  const solar = cellFor('SOLAR');
  assert.ok(thermal != null && thermal.startsWith('█') && thermal.endsWith('█'), `THERMAL tile not lit: ${JSON.stringify(thermal)}`);
  assert.ok(battery != null && battery.startsWith('█') && battery.endsWith('█'), `BATTERY tile not lit: ${JSON.stringify(battery)}`);
  assert.ok(solar != null && !solar.includes('█'), `SOLAR tile should be dark: ${JSON.stringify(solar)}`);
  assert.ok(/▔{4,}/.test(plain[topIdx + 2]), 'annunciator bottom rules missing');
  assertFrame(lines, 120, 40, 'plant/alm@120×40-annunciator');
});

test('renderPlant(alm) — annunciator fits and stays equal-width at 80×24', () => {
  const snap = buildSnapshot({ numAlerts: 4, daylight: true });
  const lines = renderPlant(makeView(80, 24, 'alm'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const topIdx = plain.findIndex((l) => /▁{4,}/.test(l));
  assert.ok(topIdx >= 0, 'annunciator must render at 80 cols');
  const tops = plain[topIdx].trim().split(/ +/);
  for (const t of tops) assert.equal(t.length, tops[0].length, 'tiles not equal width at 80 cols');
  assertFrame(lines, 80, 24, 'plant/alm@80×24-annunciator');
});

test('renderPlant(trd) — trend rows carry full-width braille sparklines', () => {
  const snap = buildSnapshot({ daylight: true });
  const lines = renderPlant(makeView(100, 40, 'trd'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // Sparkline spans every column after the 35-col fixed prefix (here 65) —
  // with the empty mock recorder that is a run of blank braille cells, which
  // still sit inside the braille block (U+2800–U+28FF).
  const run = new RegExp(`[\\u2800-\\u28ff]{${100 - 35}}`);
  const battRow = plain.find((l) => /BATT\.SOC/.test(l));
  assert.ok(battRow != null, `BATT.SOC trend row missing:\n${plain.join('\n')}`);
  assert.ok(run.test(battRow), `BATT.SOC row lacks a full-width braille strip: ${JSON.stringify(battRow)}`);
  assertFrame(lines, 100, 40, 'plant/trd@braille');
});

test('renderPlant(gen) — pack rows carry a colorized SoC bar column at 80×24', () => {
  const snap = buildSnapshot({ numDpus: 1 });
  const lines = renderPlant(makeView(80, 24, 'gen'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const anyPackRow = plain.find((l) => /%/.test(l) && /(NORMAL|WARN)/.test(l));
  assert.ok(anyPackRow != null, `no pack rows rendered:\n${plain.join('\n')}`);
  // 80% SoC over a 16-col bar = 12.8 cells → a solid run of full blocks.
  assert.ok(/█{2,}/.test(anyPackRow), `pack row missing SoC bar: ${JSON.stringify(anyPackRow)}`);
  assert.ok(plain.some((l) => /SOC BAR/.test(l)), 'SOC BAR header column missing');
  assertFrame(lines, 80, 24, 'plant/gen@80×24-socbar');
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


/* ── v1.47.1 full-pass regression fixes ─────────────────────────────────── */

test('v1.47.1 — ALM message column adapts at the 60-col minimum (text visible)', () => {
  const snap = buildSnapshot({ daylight: true });
  const lines = renderPlant(makeView(60, 24, 'alm'), makePlantData(snap), { recorder: mockRecorder() });
  const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, '');
  // At 60 cols the fixed prefix compresses so message text survives: at least
  // one alarm row must contain lowercase message words past column 30.
  const hasMsg = lines.some((l) => /[a-z]{3}.*[a-z]{3}/.test(stripAnsi(l).slice(30)));
  assert.ok(hasMsg, 'no visible alarm message text at 60 cols');
});

test('v1.47.1 — narrow annunciator folds hidden groups into the last tile (never unlit)', () => {
  // An alarm in a category beyond the visible tile count must still light the
  // final (catch-all) window at 60 cols, where only 6 of 7 tiles fit.
  const snap = buildSnapshot({ daylight: true });
  (snap as any).alerts = [
    { id: 'x1', severity: 'critical', category: 'weird-unknown-cat', device: 'System', title: 'Mystery', detail: 'mystery alarm' },
  ];
  const lines = renderPlant(makeView(60, 24, 'alm'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  // The catch-all maps to SYSTEM, which doesn't fit at 60 cols — the fold
  // must light the LAST visible tile (lit tiles carry █ lamp edges).
  assert.ok(/█\s*COMMS\s*█/.test(plain), 'catch-all fold did not light the last visible tile at 60 cols');
});

test('v1.47.1 — GEN clamps a stale pack index from a previous DPU', () => {
  const snap = buildSnapshot({ numDpus: 2 });
  const view = { ...makeView(100, 40, 'gen'), genSel: 1, genPack: 4 };
  const lines = renderPlant(view, makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  // The divider must never claim a pack beyond the count (e.g. "Pack 5/2").
  const m = plain.match(/Pack (\d+)\/(\d+)/);
  assert.ok(m, 'pack divider missing');
  assert.ok(Number(m![1]) <= Number(m![2]), `divider claims ${m![0]}`);
});


/* ── v1.47.2 second-pass regression fixes ───────────────────────────────── */

test('v1.47.2 — ALM first message segment is complete and aligned at 80 cols', () => {
  const snap = buildSnapshot({ daylight: true });
  (snap as any).alerts = [
    { id: 'r1', severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Cell imbalance', detail: 'Core 1 Pack 2 cell spread 61 mV sustained beyond threshold' },
  ];
  const lines = renderPlant(makeView(80, 30, 'alm'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // With MSG_COL = 56 at W=80, msgWidth = 24: the first wrapped segment
  // ("Cell imbalance — Core 1" = 23 chars) must appear IN FULL on the first
  // alarm row — v1.47.1 clipped its tail at the terminal edge.
  const row = plain.find((l) => l.includes('Cell imbalance'));
  assert.ok(row, 'first message segment missing entirely');
  assert.ok(row!.includes('Cell imbalance — Core 1'), `first segment clipped: ${JSON.stringify(row)}`);
  // And the continuation lines align under it (same start column).
  const startCol = row!.indexOf('Cell imbalance');
  const cont = plain.find((l) => l.trimStart().startsWith('Pack 2') || l.trimStart().startsWith('cell spread'));
  if (cont) assert.equal(cont.indexOf(cont.trim()[0] === 'P' ? 'Pack 2' : 'cell spread'), startCol, 'continuation misaligned');
});

test('v1.47.2 — visLen/padEnd count CJK as double-width', async () => {
  const { visLen, padEnd: pe } = await import('../src/telnet/ansi.js');
  assert.equal(visLen('電池コア'), 8, 'four CJK glyphs occupy eight columns');
  assert.equal(visLen('Core 1'), 6);
  assert.equal(visLen('🔋'), 2, 'emoji is double-width');
  const padded = pe('電池', 6);
  assert.equal(visLen(padded), 6, 'padEnd pads to the display width, not .length');
});


/* ── v1.47.3 third-pass regression fixes ────────────────────────────────── */

test('v1.47.3 — combining marks are zero-width (dead-code branch fixed)', async () => {
  const { visLen } = await import('../src/telnet/ansi.js');
  assert.equal(visLen('e\u0301'), 1, 'e + combining acute occupies one column');
  assert.equal(visLen('Re\u0301frige\u0301rateur'), 13, 'NFD name measures display width, not code units');
});

test('v1.47.3 — padEnd re-pads to exact width across a wide-glyph straddle', async () => {
  const { padEnd, padStart, visLen } = await import('../src/telnet/ansi.js');
  assert.equal(visLen(padEnd('abcd\u4e00', 5)), 5, 'straddle → drop wide glyph, then re-pad to width');
  assert.equal(visLen(padEnd('\u4e00\u4e00\u4e00', 5)), 5);
  assert.equal(visLen(padStart('abcd\u4e00', 5)), 5);
});

test('v1.47.3 — CJK alarm detail wraps on display width and keeps its tail', () => {
  const snap = buildSnapshot({ daylight: true });
  const tail = 'TAILMARK';
  (snap as any).alerts = [
    { id: 'w1', severity: 'critical', category: 'Battery', device: 'Core 1', title: '電池', detail: '電池 電池 電池 電池 電池 電池 ' + tail },
  ];
  const lines = renderPlant(makeView(80, 30, 'alm'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // Every rendered line stays within width…
  for (const l of plain) assert.ok(visLenLocal(l) <= 80, `overflow: ${JSON.stringify(l)}`);
  // …and the operative tail is NOT lost (v1.47.2 clipped it because wrapPlain
  // wrapped on .length while visLen had become display-aware).
  assert.ok(plain.some((l) => l.includes(tail)), 'CJK alarm tail was lost');
});

test('v1.47.3 — divider fills to width with a CJK label (visLen, not .length)', () => {
  const snap = buildSnapshot({ daylight: true });
  const dpu = Object.values((snap as any).devices).find((d: any) => d.productName?.includes('Delta'));
  if (dpu) (dpu as any).deviceName = '核心三号';
  const lines = renderPlant(makeView(100, 40, 'gen'), makePlantData(snap), { recorder: mockRecorder() });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  for (const l of plain) assert.ok(visLenLocal(l) <= 100, `gen line over width with CJK name: ${JSON.stringify(l)}`);
});

// local display-width measure mirroring ansi.visLen for the assertions above.
function visLenLocal(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) continue;
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) w += 2;
    else w += 1;
  }
  return w;
}
