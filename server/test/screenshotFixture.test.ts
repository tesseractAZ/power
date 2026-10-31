import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  COMMENT_ONLY, CORE_SNS, FIXTURE_NAMES, FIXTURE_NOW_MS, FIXTURE_SERIALS, IDENTITIES, PANEL_SN, ROUTES, WRITE_ONLY,
  fixtureAlerts, fixtureSnapshot, historySeries, localDayStart, poolSocNow,
} from '../../scripts/screenshots/fixture.mjs';
import { DEFAULT_NAME_TAIL, isPlaceholderSerial, ocrTextProblems, renderedTextProblems } from '../../scripts/screenshots/leakGate.mjs';
import { route, snapshotFrame, startFixtureServer } from '../../scripts/screenshots/serve.mjs';
import { ApiIdle, REPORTS_UNAVAILABLE, STILL_LOADING, TABS, clockScript, distIsStale } from '../../scripts/screenshots/capture.mjs';
import { energyFlowModel } from '../../web/src/cards/energyFlowModel.js';
import { linkState, oldestHomeTelemetryAt } from '../../web/src/freshness.js';
import { holdsLabel, troughTight } from '../../web/src/cards/runwayText.js';
import type { DpuProjection, RunwayProjection, Shp2Projection } from '../../web/src/types.js';

/**
 * v1.193.0 — the README screenshots are rendered from the synthetic fleet in scripts/screenshots/
 * (fixture.mts, served by serve.mts, photographed by capture.mts), never from an installation. The
 * images this replaced were live captures masked by serial SHAPE: an EcoFlow default device name
 * ("<product>-<last four serial digits>") is not serial-shaped and reached two of them. These tests
 * hold the fixture to placeholders, the replay server to serving only what it models, and the leak
 * gate to firing on exactly that name shape.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const PLACEHOLDER = /^[A-Z0-9]{4}[X0]{10}\d{2}$/;
const SERIAL_TOKEN = /(?<![A-Za-z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const serialShaped = (t: string) => /[A-Z]/.test(t) && /\d/.test(t);
const everyPayload = (): string => JSON.stringify([
  fixtureSnapshot(),
  ...Object.entries(ROUTES).map(([k, f]) => f(new URLSearchParams(k === 'api/history' ? { sn: PANEL_SN, metric: 'backup_pct' } : k === 'api/circuit/history' ? { sn: PANEL_SN, pair: '3' } : {}))),
]);

test('T1: every serial is a placeholder, and the payloads carry no other serial-shaped token', () => {
  // 7 devices + 3 Cores x 5 packs.
  assert.equal(FIXTURE_SERIALS.length, 22);
  assert.equal(new Set(FIXTURE_SERIALS).size, 22);
  for (const sn of FIXTURE_SERIALS) assert.match(sn, PLACEHOLDER, `${sn.slice(0, 4)}… is not a placeholder`);
  // The leak gate's own test agrees: 'COREXXX00XXX0001' keeps the model code, then ten of X/0 and the
  // index 01.
  for (const sn of FIXTURE_SERIALS) assert.ok(isPlaceholderSerial(sn), `${sn.slice(0, 4)}… fails the gate's placeholder test`);
  const tokens = [...everyPayload().matchAll(SERIAL_TOKEN)].map((m) => m[0]).filter(serialShaped);
  assert.ok(tokens.length > 50, `expected the payloads to name the fixture's serials, found ${tokens.length}`);
  const known = new Set(FIXTURE_SERIALS);
  const strays = tokens.filter((t) => !known.has(t));
  assert.deepEqual(strays.map((t) => t.slice(0, 4)), [], 'a serial-shaped token the fixture does not define');
});

test('T2: device names are product names; 6 of the 7 devices are online', () => {
  const snap = fixtureSnapshot();
  const devices = Object.values(snap.devices);
  assert.deepEqual(
    new Set(devices.map((d) => d.deviceName)),
    new Set(['Smart Home Panel 2', 'Core 1', 'Core 2', 'Core 3', 'EV Charger', 'DELTA 3 Plus', 'Smart Generator']),
  );
  assert.deepEqual([...FIXTURE_NAMES].sort(), devices.map((d) => d.deviceName).sort());
  for (const d of devices) assert.doesNotMatch(d.deviceName, DEFAULT_NAME_TAIL);
  // The page header: "7 devices · 6 online".
  assert.equal(devices.length, 7);
  assert.equal(devices.filter((d) => d.online).length, 6);
  assert.equal(snap.devices['GENRXXX00XXX0001']?.online, false);
  // The Cores keep the product name the UI selects them by (App.tsx: 'delta pro ultra').
  assert.deepEqual(devices.filter((d) => /delta pro ultra/i.test(d.productName)).map((d) => d.sn), [...CORE_SNS]);
  assert.equal(IDENTITIES.length, 7);
});

/** Every 'api/…' path literal in web/src (trailing slash dropped), with the files it appears in. */
function webApiLiterals(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/(?<![A-Za-z0-9_])api\/[a-z][a-z0-9_\-/]*/g)) {
          const k = m[0].replace(/\/+$/, '');
          out.set(k, [...(out.get(k) ?? []), relative(ROOT, p)]);
        }
      }
    }
  };
  walk(join(ROOT, 'web', 'src'));
  return out;
}

test('T3: every API path the web UI names is served, write-only or comment-only — and no list entry is dead', () => {
  const literals = webApiLiterals();
  // Pinned: a new endpoint in the UI changes this count and must be given a builder (or a reason).
  assert.equal(literals.size, 41);
  const accounted = new Set([...Object.keys(ROUTES), ...Object.keys(WRITE_ONLY), ...Object.keys(COMMENT_ONLY)]);
  assert.deepEqual([...literals.keys()].filter((k) => !accounted.has(k)), [], 'web/src names an API path the fixture does not account for');
  assert.deepEqual([...accounted].filter((k) => !literals.has(k)), [], 'the fixture lists a path web/src no longer names');
  assert.equal(Object.keys(ROUTES).length + Object.keys(WRITE_ONLY).length + Object.keys(COMMENT_ONLY).length, 41);
  // A comment-only path appears only on comment lines.
  for (const path of Object.keys(COMMENT_ONLY)) {
    for (const file of new Set(literals.get(path))) {
      for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
        const at = line.indexOf(path);
        if (at < 0) continue;
        const t = line.trim();
        const comment = t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || line.slice(0, at).includes('//');
        assert.ok(comment, `${file}: ${path} outside a comment`);
      }
    }
  }
});

test('T4: the leak gate fires on a default device name, a real serial shape and an empty read — and not on dates or channels', () => {
  const serials = new Set(FIXTURE_SERIALS);
  const must = ['Power', 'Core 1', PANEL_SN];
  const page = `Power … Core 1 … ${PANEL_SN}`;
  assert.deepEqual(renderedTextProblems(page, { serials, mustContain: must }), []);
  // The shape of the leak this replaced: an EcoFlow default name, "<product>-<last four digits>".
  const named = renderedTextProblems(`${page} Smart Generator 3000 (Dual Fuel)-1234 is offline`, { serials, mustContain: must });
  assert.deepEqual(named, ['a device name ending in four digits']);
  assert.ok(!named.join(' ').includes('1234'), 'a finding must not echo what it matched');
  assert.deepEqual(renderedTextProblems(`${page} DELTA Pro Ultra-0042`, { serials, mustContain: must }), ['a device name ending in four digits']);
  // A product name ending in a model number — the panel's own default name among them — with or
  // without a space, and up to four digits long.
  for (const name of ['Smart Home Panel 2-1234', 'DELTA 2-5521', 'DELTA Pro 3-0042', 'SHP2-1234', 'Smart Generator 3000-1234']) {
    assert.deepEqual(renderedTextProblems(`${page} ${name} is offline`, { serials, mustContain: must }), ['a device name ending in four digits'], name);
  }
  // A real serial shape (split so this file does not hold one): flagged by its public model code only.
  const real = 'Y711ABC12' + 'DEF3456';
  const r = renderedTextProblems(`${page} id=${real}`, { serials, mustContain: must });
  assert.deepEqual(r, ['serial-shaped token (model code Y711)']);
  assert.ok(!r.join(' ').includes('ABC12'));
  // A placeholder the fixture does not define is not on the page's list either.
  assert.deepEqual(renderedTextProblems(`${page} Y711XXX00XXX0099`, { serials, mustContain: must }), ['a placeholder serial the fixture does not define']);
  // A reader that read nothing reports every positive control missing, never clean.
  assert.deepEqual(renderedTextProblems('', { serials, mustContain: must }), must.map((m) => `positive control missing: ${m}`));
  // No false positive on the UI's dates, times, channel pairs or voltages.
  assert.deepEqual(renderedTextProblems(`${page} 2026-06-17 10:40a–2:40p ch2+4 240V 12:31 PM v1.192.0 R-EV 602-555-0142 12.4-1234`, { serials, mustContain: must }), []);
  // OCR: the name rule and the controls, and a floor on what was read (no serial rule: OCR reads 0 as O).
  assert.deepEqual(ocrTextProblems(['Power', 'Core 1'], { mustContain: ['Power', 'Core 1'], minLines: 20 }), ['OCR read 2 line(s), fewer than 20']);
  const lines = Array.from({ length: 24 }, (_, i) => (i === 0 ? 'Power' : i === 1 ? 'Core 1' : `line ${i}`));
  assert.deepEqual(ocrTextProblems(lines, { mustContain: ['Power', 'Core 1'], minLines: 20 }), []);
  assert.deepEqual(ocrTextProblems([...lines, 'Smart Generator-5521'], { mustContain: ['Power'], minLines: 20 }), ['a device name ending in four digits']);
  assert.deepEqual(ocrTextProblems([...lines, 'Smart Home Panel 2-5521'], { mustContain: ['Power'], minLines: 20 }), ['a device name ending in four digits']);
  // A placeholder read with its zeros as letters ('O') is not a finding on the OCR side.
  assert.deepEqual(ocrTextProblems(['CORE' + 'XXXOOXXXOOO1', ...lines], { mustContain: ['Power'], minLines: 20 }), []);
});

test('T5: the replay server serves what it models, reports what it does not, and never acts', async () => {
  const unknown = new Set<string>();
  assert.deepEqual(route('GET', '/api/nope', unknown), { status: 404, body: null });
  assert.deepEqual([...unknown], ['api/nope']);
  // Writes: refused, whichever path.
  assert.equal(route('POST', '/api/night-charge/cancel', unknown).status, 405);
  assert.equal(route('POST', '/api/site', unknown).status, 405);
  assert.equal(route('DELETE', '/api/chimes/abc', unknown).status, 405);
  assert.deepEqual([...unknown], ['api/nope']);
  // A GET to a write-only path: refused too, and reported. A card that started reading one would
  // otherwise be photographed in its error state with gate (i) clean.
  assert.equal(route('GET', '/api/night-charge/cancel', unknown).status, 405);
  assert.equal(route('GET', `/api/device/refresh-cloud/${PANEL_SN}`, unknown).status, 405);
  assert.deepEqual([...unknown], [
    'api/nope',
    'api/night-charge/cancel (a read of a write-only path)',
    `api/device/refresh-cloud/${PANEL_SN} (a read of a write-only path)`,
  ]);
  // A history metric the fixture does not model is a 404 and is reported, not an empty chart.
  assert.equal(route('GET', `/api/history?sn=${PANEL_SN}&metric=pack9_vol_diff_mv`, unknown).status, 404);
  assert.ok(unknown.has('api/history?metric=pack9_vol_diff_mv'));
  const since = FIXTURE_NOW_MS - 3_600_000;
  const h = route('GET', `/api/history?sn=${CORE_SNS[0]}&metric=pv_total&since=${since}`, unknown);
  assert.equal(h.status, 200);
  const pts = (h.body as { points: Array<{ ts: number; value: number }> }).points;
  // One point a minute over the hour: 60 or 61 of them, none after the fixture's clock.
  assert.ok(pts.length >= 60 && pts.length <= 61, `${pts.length} points`);
  assert.ok(pts.every((p) => p.ts >= since && p.ts <= FIXTURE_NOW_MS));
  assert.ok(pts.every((p) => p.value > 2000), 'midday PV on a clear June day');

  const frame = JSON.parse(snapshotFrame()) as { type: string; serverNowMs: number; data: { generatedAt: number } };
  assert.equal(frame.type, 'snapshot');
  assert.equal(frame.serverNowMs, FIXTURE_NOW_MS);

  // The real server, on an ephemeral port: static files, /api, the /ws stream and the unknown list.
  const dist = mkdtempSync(join(tmpdir(), 'shots-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>fixture</title>');
  const s = await startFixtureServer({ port: 0, distDir: dist });
  try {
    assert.equal((await fetch(s.url)).status, 200);
    assert.equal((await fetch(`${s.url}missing.js`)).status, 404);
    const site = (await (await fetch(`${s.url}api/site`)).json()) as { siteTimeZone: string };
    assert.equal(site.siteTimeZone, 'America/Phoenix');
    assert.equal((await fetch(`${s.url}api/grid-veto/clear`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${s.url}api/not-a-route`)).status, 404);
    assert.deepEqual(await (await fetch(`${s.url}__fixture/unknown`)).json(), ['api/not-a-route']);
    const { WebSocket } = createRequire(join(ROOT, 'server', 'package.json'))('ws') as { WebSocket: new (u: string) => { on(e: string, f: (d: unknown) => void): void; close(): void } };
    const first = await new Promise<{ type: string; serverNowMs: number }>((ok, fail) => {
      const ws = new WebSocket(`${s.url.replace('http', 'ws')}ws`);
      ws.on('message', (d) => { ok(JSON.parse(String(d))); ws.close(); });
      ws.on('error', (e) => fail(e as Error));
    });
    assert.equal(first.type, 'snapshot');
    assert.equal(first.serverNowMs, FIXTURE_NOW_MS);
  } finally {
    await s.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test('T6: one clock — the snapshot, its readings and every series stop at FIXTURE_NOW_MS', () => {
  const snap = fixtureSnapshot();
  // Wed 17 Jun 2026 12:30 in America/Phoenix (UTC-7).
  assert.equal(FIXTURE_NOW_MS, Date.UTC(2026, 5, 17, 19, 30));
  assert.equal(new Date(FIXTURE_NOW_MS).getUTCDay(), 3);
  assert.equal(localDayStart(FIXTURE_NOW_MS), Date.UTC(2026, 5, 17, 7, 0));
  assert.equal(snap.generatedAt, FIXTURE_NOW_MS);
  for (const d of Object.values(snap.devices)) {
    if (d.lastTelemetryAtMs == null) continue;
    assert.ok(d.lastTelemetryAtMs >= FIXTURE_NOW_MS - 60_000 && d.lastTelemetryAtMs <= FIXTURE_NOW_MS, d.deviceName);
  }
  // The header pill reads LIVE, and "updated" is the oldest home reading: Core 3's, 9 + 2x4 = 17 s old.
  assert.equal(oldestHomeTelemetryAt(snap.devices), FIXTURE_NOW_MS - 17_000);
  assert.equal(linkState('open', snap.devices, FIXTURE_NOW_MS + 20_000), 'live');
  const day = historySeries(PANEL_SN, 'panel_load', FIXTURE_NOW_MS - 86_400_000, FIXTURE_NOW_MS + 86_400_000, 60);
  // One a minute from 24 h ago to the clock, both ends included; nothing after it.
  assert.equal(day.length, 1441);
  assert.equal(day[0].ts, FIXTURE_NOW_MS - 86_400_000);
  assert.ok(day[day.length - 1].ts <= FIXTURE_NOW_MS);
  const fc = ROUTES['api/forecast'](new URLSearchParams()) as { hours: Array<{ ts: number }> };
  assert.equal(fc.hours.length, 24);
  assert.ok(fc.hours[0].ts > FIXTURE_NOW_MS && fc.hours[0].ts - FIXTURE_NOW_MS <= 3_600_000);
});

test('T7: the dashboard reads one consistent plant — energy flow, panel, Cores and history agree', () => {
  const snap = fixtureSnapshot();
  const panel = snap.devices[PANEL_SN].projection as Shp2Projection;
  const cores = CORE_SNS.map((sn) => snap.devices[sn].projection as DpuProjection);
  const m = energyFlowModel(snap.devices, snap.grid);
  // Loads = the panel's channels; Solar = the Cores' own PV; three Cores on their own meters.
  assert.equal(m.load, panel.circuits.reduce((s, c) => s + (c.watts ?? 0), 0));
  assert.equal(m.pv, cores.reduce((s, p) => s + (p.pvTotalWatts ?? 0), 0));
  assert.equal(m.dpuCount, 3);
  assert.equal(m.gridState, 'standby');
  assert.equal(m.panelState, 'ok');
  // Charging at midday: PV well above the house, the pool between its reserve and its charge limit.
  assert.ok(m.pv! > 10_000 && m.load! > 2_000 && m.pv! > m.load! * 3);
  const pool = poolSocNow();
  assert.ok(pool > 70 && pool < 85, `pool ${pool}`);
  assert.equal(panel.backupBatPercent, Math.round(pool * 10) / 10);
  // The 24 h chart ends where the panel card starts.
  const last = historySeries(PANEL_SN, 'backup_pct', FIXTURE_NOW_MS - 600_000, FIXTURE_NOW_MS).at(-1)!;
  assert.ok(Math.abs(last.value - pool) < 0.2, `chart ${last.value} vs card ${pool}`);
  // Each slot's watts are its Core's own AC exchange (no "behind" panel), as the panel signs them.
  panel.sourceWatts.forEach((w, i) => assert.equal(w, -(cores[i].acOutWatts ?? 0)));
  assert.deepEqual(panel.sources.map((s) => s.sn), [...CORE_SNS]);
  // The panel's circuits keep its own default names.
  assert.ok(panel.circuits.every((c) => c.name === `Circuit ${c.ch}`));
});

test('T8: each README caption has its element — a sized plan, the EV window, the projections, every severity', () => {
  const q = new URLSearchParams();
  // Strategy: a SIZED night-charge plan, fresh (the card's 12 h horizon), charging, advisory.
  const nc = ROUTES['api/night-charge/status'](q) as { mode: string; plan: { generatedAt: number; basisComplete: boolean; chargeTonight: boolean; expectedBuyKwh: number; window: { startMs: number; endMs: number } } };
  assert.equal(nc.mode, 'advisory');
  assert.ok(nc.plan.basisComplete && nc.plan.chargeTonight);
  assert.ok(FIXTURE_NOW_MS - nc.plan.generatedAt < 12 * 3_600_000);
  assert.equal(nc.plan.expectedBuyKwh, 7.4);
  // 23:00–05:00 tonight, site time.
  assert.equal(nc.plan.window.startMs, Date.UTC(2026, 5, 18, 6, 0));
  assert.equal(nc.plan.window.endMs, Date.UTC(2026, 5, 18, 12, 0));
  // The EV window: Wednesdays 18:30, 1.5 h at 7.7 kW = 11.6 kWh, seen 4 times; tonight's predicted.
  const ev = ROUTES['api/ev-window-prediction'](q) as { patterns: Array<{ dayOfWeek: number; startHour: number; typicalDurationHours: number; typicalWatts: number; energyKwh: number; recurrences: number }>; upcomingNext24h: Array<{ ts: number }> };
  assert.deepEqual(ev.patterns.map((p) => [p.dayOfWeek, p.startHour, p.typicalDurationHours, p.typicalWatts, p.energyKwh, p.recurrences]), [[3, 18, 1.5, 7700, 11.6, 4]]);
  assert.deepEqual(ev.upcomingNext24h.map((u) => u.ts), [Date.UTC(2026, 5, 18, 1, 30)]);
  // The runway headline: the reserve holds 24 h, its low not "tight" (green, not neutral).
  const rw = ROUTES['api/runway'](q) as RunwayProjection;
  assert.equal(rw.hoursToReserve, null);
  assert.equal(troughTight(rw), false);
  // The low falls on Thursday morning at the site (UTC-7). The label prints it in the zone the page
  // runs in (the capture pins America/Phoenix), so here the weekday is this process's.
  assert.ok(rw.troughAtMs != null);
  assert.equal(new Date(rw.troughAtMs - 7 * 3_600_000).getUTCDay(), 4);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(rw.troughAtMs).getDay()];
  assert.match(holdsLabel(rw), new RegExp(`^lowest ≈ \\d+\\.\\d kWh around ${wd} .*kWh above the reserve floor$`));
  // Battery: an end-of-life projection with a peer outlier.
  const deg = ROUTES['api/degradation'](q) as { packs: Array<{ status: string; peerOutlier: boolean; eolDate: number | null }> };
  assert.equal(deg.packs.length, 15);
  assert.equal(deg.packs.filter((p) => p.status === 'projecting' && p.eolDate != null).length, 3);
  assert.equal(deg.packs.filter((p) => p.peerOutlier).length, 1);
  // Alerts: every severity, threshold and learned, and the offline accessory under its product name.
  const alerts = fixtureAlerts();
  assert.deepEqual(new Set(alerts.map((a) => a.severity)), new Set(['critical', 'warning', 'info']));
  assert.ok(alerts.some((a) => a.source === 'learned') && alerts.some((a) => a.source === 'threshold'));
  const offline = alerts.find((a) => a.title === 'Device offline (per EcoFlow Cloud)');
  assert.equal(offline?.device, 'Smart Generator');
  assert.match(offline!.detail, /^Smart Generator is flagged offline/);
  // The incident digest: two pack clusters and the system-scoped accessory.
  const inc = (ROUTES['api/incidents'](q) as { incidents: Array<{ scope: string; alertCount: number }> }).incidents;
  assert.deepEqual(inc.map((i) => [i.scope, i.alertCount]), [['pack', 3], ['pack', 2], ['system', 1]]);
});

test('T9: the capture tool refuses a stale bundle, waits out loading cards and pins the page clock', () => {
  assert.equal(distIsStale(null, 1), true);
  assert.equal(distIsStale(1_000, 2_000), true);
  assert.equal(distIsStale(2_000, 2_000), false);
  assert.deepEqual(TABS.map((t) => t.file), ['dashboard.png', 'solar.png', 'battery.png', 'strategy.png', 'alerts.png']);
  for (const t of TABS) assert.ok(t.mustContain.includes('Power') && t.ocrMustContain.includes('Power'), t.label);
  assert.ok(TABS[0].mustContain.includes(PANEL_SN) && FIXTURE_NAMES.every((n) => TABS[0].mustContain.includes(n)));
  for (const s of ['Loading view…', 'Computing off-grid runway…', 'collecting…', 'Loading forecast…']) assert.match(s, STILL_LOADING);
  assert.doesNotMatch('Off-grid runway · reserve holds 24 h', STILL_LOADING);
  assert.match('Off-grid runway unavailable — see add-on log.', REPORTS_UNAVAILABLE);
  // The page clock: the fixture's instant, standing still (so every printed age is the same each run);
  // a dated Date is untouched.
  const sandbox = { Date } as { Date: DateConstructor };
  new Function('globalThis', clockScript(FIXTURE_NOW_MS))(sandbox);
  assert.equal(sandbox.Date.now(), FIXTURE_NOW_MS);
  assert.equal(new sandbox.Date().getTime(), FIXTURE_NOW_MS);
  assert.equal(new sandbox.Date(5).getTime(), 5);
  assert.equal(sandbox.Date.UTC(2026, 5, 17), Date.UTC(2026, 5, 17));
  assert.ok(new sandbox.Date() instanceof Date);
  // Only /api requests count toward "idle".
  let now = 0;
  const idle = new ApiIdle(() => now);
  idle.started('1', 'http://127.0.0.1:8799/assets/x.js');
  assert.equal(idle.idle(1_500), false);
  now = 1_500;
  assert.equal(idle.idle(1_500), true);
  idle.started('2', 'http://127.0.0.1:8799/api/runway');
  now = 5_000;
  assert.equal(idle.idle(1_500), false);
  idle.ended('2');
  assert.equal(idle.idle(1_500), false);
  now = 6_500;
  assert.equal(idle.idle(1_500), true);
  assert.deepEqual([...idle.seen], ['/api/runway']);
});
