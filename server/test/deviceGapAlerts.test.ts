import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  outageAlerts, outageTracking, systemOutageFields, deviceGapCount, telemetryGapLedgerSummary,
  outageAlertId, deviceGapAlertId, isDeviceGapAlertId, isOutageEventFamily, devicesDarkAlongside, heldGapPhrase,
} from '../src/alerts.js';
import {
  shouldSendResolve, bootSeedNotified, notifyLocator,
  fallingEdgeFrozenByEvidence, isEvidenceExemptFamily,
} from '../src/alertMonitor.js';
import { conditionFromAlerts } from '../src/broadcast.js';
import { familyOf } from '../src/alertOutcomes.js';
import { SENSORS } from '../src/mqttDiscovery.js';

/**
 * v1.155.0 — PER-DEVICE telemetry gaps were rendered and counted as FLEET outages.
 *
 * The recorder's gap ledger holds two kinds of record. A FLEET gap (no `sn`) means no
 * home device wrote: an MQTT/broker stall, or a restart the alarm was dark across. A
 * PER-DEVICE gap (`sn` set, v1.150.0) means ONE device went silent while the others
 * kept writing — the detector exists because a Core was dark for nine days while the
 * fleet detector, reset by the surviving Cores, recorded nothing.
 *
 * `outageAlerts` never read `sn`. A per-device record carries no `restartSpanning`, so
 * it took the in-process fleet branch: "Telemetry gap — no data for N min … No
 * home-device samples reached the recorder … an MQTT/broker stall; writes have since
 * resumed". Every clause was false for it. `outageTracking` counted it too, so one dark
 * Core added hours of outage minutes and flipped `system_outage_active_24h`.
 *
 * Fixtures use the recorder's shape for a per-device record: `startMs` is the SN's last
 * sample and `endMs` == `detectedAt` is the sweep that noticed — the device is still
 * dark at that instant.
 */

const MIN = 60_000;
const H = 3_600_000;
const now = 1_800_000_000_000;
const OPTS = { enabled: true, recentWindowMs: 24 * H, minDurationMs: 15 * MIN, restartMinDurationMs: 5 * MIN };
const CORE2 = 'TESTCORE00000002';
const CORE3 = 'TESTCORE00000003';
const names: Record<string, string> = { [CORE2]: 'Core 2', [CORE3]: 'Core 3' };
const nameOf = (sn: string) => names[sn];
const __dir = dirname(fileURLToPath(import.meta.url));

type Gap = {
  startMs: number; endMs: number; durationMs: number; detectedAt: number; restartSpanning?: boolean; graceful?: boolean; sn?: string;
  alertStartMs?: number; held?: Array<{ sn: string; shadow: boolean }>; unmeasured?: string[];
};
/** Silent from 7 h ago, detected 10 min ago: 410 min. */
const deviceGap = (sn: string, over: Partial<Gap> = {}): Gap => ({
  startMs: now - 7 * H, endMs: now - 10 * MIN, durationMs: 7 * H - 10 * MIN, detectedAt: now - 10 * MIN, sn, ...over,
});
/** An in-process fleet stall: 90 min, ended 10 min ago. */
const fleetGap = (over: Partial<Gap> = {}): Gap => ({
  startMs: now - 100 * MIN, endMs: now - 10 * MIN, durationMs: 90 * MIN, detectedAt: now - 10 * MIN, ...over,
});

/* ── rendering ─────────────────────────────────────────────────────────── */

test('outageAlerts — a per-device gap renders as a DEVICE gap naming the device, not as a fleet stall', () => {
  const alerts = outageAlerts([deviceGap(CORE2)], now, OPTS, nameOf);
  assert.equal(alerts.length, 1);
  const [a] = alerts;
  assert.equal(a.title, 'Device telemetry gap — no data for 410 min');
  assert.equal(a.device, 'Core 2');
  // The push title is title + notifyLocator(alert): that is where the name reaches the phone.
  assert.equal(`${a.title} — ${notifyLocator(a)}`, 'Device telemetry gap — no data for 410 min — Core 2');
  assert.match(a.detail, /^Core 2 \(TESTCORE00000002\) wrote no samples for 410 min \(/);
  assert.match(a.detail, /while other home devices kept reporting/);
  assert.match(a.detail, /may still be silent/);
  // What it means for everything downstream: fleet sums over that window are short.
  assert.match(a.detail, /Anything summed across the fleet in that window \(production, load, forecast inputs\) under-counts\.$/);
  // Every clause of the fleet in-process text was false for this record.
  assert.doesNotMatch(a.detail, /No home-device samples|MQTT|broker stall|writes have since resumed|process stayed up/);
  assert.doesNotMatch(a.title, /^Telemetry gap/);
  assert.equal(a.severity, 'warning');
  assert.equal(a.priority, 'medium');
  assert.equal(a.category, 'Connectivity');
  assert.deepEqual(a.facts?.map((f) => f.label), ['Device', 'Duration', 'Started', 'Detected', 'Type']);
  assert.equal(a.facts?.find((f) => f.label === 'Device')?.value, `Core 2 (${CORE2})`);
  assert.equal(a.facts?.find((f) => f.label === 'Type')?.value, 'per-device (other home devices kept reporting)');
});

test('outageAlerts — with no resolvable name the device is named by its serial', () => {
  for (const resolver of [undefined, () => undefined, () => null, () => '', () => '   ']) {
    const [a] = outageAlerts([deviceGap(CORE2)], now, OPTS, resolver);
    assert.equal(a.device, CORE2, `resolver ${String(resolver)}`);
    assert.match(a.detail, /^TESTCORE00000002 wrote no samples for 410 min \(/);
    assert.equal(`${a.title} — ${notifyLocator(a)}`, `Device telemetry gap — no data for 410 min — ${CORE2}`);
  }
});

/* ── identity ──────────────────────────────────────────────────────────── */

test('deviceGapAlertId — the exact shape: inside the system-outage- prefix, SN, start, duration tier', () => {
  assert.equal(deviceGapAlertId(CORE2, 123, 7 * H), `system-outage-device-${CORE2}-123-3`);
  assert.equal(deviceGapAlertId(CORE2, 123, 90 * MIN), `system-outage-device-${CORE2}-123-2`);
  assert.equal(deviceGapAlertId(CORE2, 123), `system-outage-device-${CORE2}-123`);
  assert.equal(isDeviceGapAlertId(deviceGapAlertId(CORE2, 123, 7 * H)), true);
  assert.equal(isDeviceGapAlertId(outageAlertId(123, 7 * H)), false);
});

test('outageAlerts — ids stay unique when devices and a fleet gap share one startMs; fleet id and text unchanged', () => {
  // Every SN written in one batch shares that batch's timestamp as its last sample,
  // and so does the fleet clock — a fleet-shaped id would collide three ways here.
  const t0 = now - 7 * H;
  const dur = 7 * H - 10 * MIN;
  const alerts = outageAlerts(
    [fleetGap({ startMs: t0, durationMs: dur }), deviceGap(CORE2, { startMs: t0 }), deviceGap(CORE3, { startMs: t0 })],
    now, OPTS, nameOf,
  );
  assert.equal(alerts.length, 3);
  assert.equal(new Set(alerts.map((a) => a.id)).size, 3, `ids: ${alerts.map((a) => a.id).join(', ')}`);
  const fleet = alerts.find((a) => a.device === 'System');
  assert.ok(fleet, 'the fleet gap still renders as a System alert');
  assert.equal(fleet.id, outageAlertId(t0, dur));
  assert.equal(fleet.title, 'Telemetry gap — no data for 410 min');
  assert.match(fleet.detail, /^No home-device samples reached the recorder for 410 min/);
  assert.equal(alerts.find((a) => a.device === 'Core 2')?.id, deviceGapAlertId(CORE2, t0, dur));
  assert.equal(alerts.find((a) => a.device === 'Core 3')?.id, deviceGapAlertId(CORE3, t0, dur));
});

test('outageAlerts — newest gap first ACROSS kinds (a per-device id must not outrank a fresher outage)', () => {
  const oldDevice = deviceGap(CORE2, { startMs: now - 9 * H, durationMs: 9 * H - 10 * MIN });
  assert.deepEqual(outageAlerts([oldDevice, fleetGap()], now, OPTS, nameOf).map((a) => a.device), ['System', 'Core 2']);
  const oldStall = fleetGap({ startMs: now - 20 * H, endMs: now - 19 * H, durationMs: H, detectedAt: now - 19 * H });
  assert.deepEqual(outageAlerts([oldStall, deviceGap(CORE3)], now, OPTS, nameOf).map((a) => a.device), ['Core 3', 'System']);
});

/* ── lifecycle: the same event semantics as a fleet gap ─────────────────── */

test('a per-device gap alert keeps the outage EVENT lifecycle: no resolve push, not boot-seeded, never audible', () => {
  const [a] = outageAlerts([deviceGap(CORE2)], now, OPTS, nameOf);
  assert.equal(isOutageEventFamily(a), true);
  const tracked = { pushSent: true, notifiedSeverity: 'warning' as const, alert: { id: a.id, severity: 'warning' as const, annunciate: undefined } };
  assert.equal(shouldSendResolve(tracked, true, 'info'), false);
  assert.equal(bootSeedNotified({ alert: { id: a.id, severity: a.severity }, firstRun: true, alreadyNotified: false }), false);
  assert.equal(conditionFromAlerts([a]).level, 'green');
  // Its own family, so the tuner's statistics for fleet outages are not mixed with it.
  assert.equal(familyOf(a.id), 'system-outage-device');
  assert.equal(familyOf(outageAlertId(123, 7 * H)), 'system-outage');
});

test('the evidence gate does not hold a per-device gap alert open because its device is dark', () => {
  // The id names the SN, so without the exemption the falling edge would be judged
  // by the very silence the alert reports, and frozen for as long as it lasts.
  const id = deviceGapAlertId(CORE2, now - 7 * H, 7 * H);
  const dark = { [CORE2]: { online: false, lastUpdated: now - 7 * H } };
  assert.equal(isEvidenceExemptFamily(id), true);
  assert.equal(fallingEdgeFrozenByEvidence({ id, deviceSns: [CORE2], devices: dark, nowMs: now }), false);
  // Control: an ordinary alert on the same dark device IS frozen, so the exemption is the difference.
  assert.equal(fallingEdgeFrozenByEvidence({ id: `dpu-err-${CORE2}`, deviceSns: [CORE2], devices: dark, nowMs: now }), true);
});

/* ── counters ──────────────────────────────────────────────────────────── */

test('a per-device gap is not a fleet outage — outageTracking and every system_outage_* field ignore it', () => {
  const dg = deviceGap(CORE2);
  assert.deepEqual(outageTracking([dg], now, 24 * H), {
    count: 0, powerOutageCount: 0, gracefulRestartCount: 0, telemetryGapCount: 0,
    totalMinutes: 0, lastEndedMs: null, lastDurationMinutes: null,
  });
  // Beside a real in-process stall only the stall counts, and "last" is the stall —
  // not the per-device record that ended (was detected) later.
  const stall = fleetGap({ startMs: now - 3 * H, endMs: now - 2 * H, durationMs: H, detectedAt: now - 2 * H });
  const t = outageTracking([stall, dg], now, 24 * H);
  assert.equal(t.count, 1);
  assert.equal(t.telemetryGapCount, 1);
  assert.equal(t.totalMinutes, 60);
  assert.equal(t.lastEndedMs, now - 2 * H);
  assert.equal(t.lastDurationMinutes, 60);

  const f = systemOutageFields([dg], now);
  assert.equal(f.system_outage_active_24h, false);
  assert.equal(f.system_outage_count_24h, 0);
  assert.equal(f.system_power_outage_count_24h, 0);
  assert.equal(f.system_telemetry_gap_count_24h, 0);
  assert.equal(f.system_outage_total_minutes_24h, 0);
  assert.equal(f.system_outage_last_ended, null);
  assert.equal(f.system_outage_last_duration_minutes, null);
  assert.equal(f.system_device_gap_count_24h, 1);
});

test('system_device_gap_count_24h counts per-device gaps in the window, and only those', () => {
  const stall = fleetGap({ startMs: now - 3 * H, endMs: now - 2 * H, durationMs: H, detectedAt: now - 2 * H });
  const aged = deviceGap(CORE2, { startMs: now - 40 * H, endMs: now - 30 * H, durationMs: 10 * H, detectedAt: now - 30 * H });
  const gaps = [stall, deviceGap(CORE2), deviceGap(CORE3), aged];
  const f = systemOutageFields(gaps, now);
  assert.equal(f.system_device_gap_count_24h, 2, 'the 30 h-old record aged out; the fleet stall is not a device gap');
  assert.equal(f.system_outage_count_24h, 1);
  assert.equal(deviceGapCount(gaps, now, 24 * H), 2);
  assert.equal(deviceGapCount([stall], now, 24 * H), 0);
  assert.equal(systemOutageFields([], now).system_device_gap_count_24h, 0);
});

test('the per-device count is published as its own HA diagnostic sensor', () => {
  const s = SENSORS.find((x) => x.unique_id === 'ecoflow_system_device_gap_count_24h');
  assert.ok(s, 'a count with no entity is invisible in HA');
  assert.match(s.value_template ?? '', /value_json\.system_device_gap_count_24h\b/);
  assert.equal(s.entity_category, 'diagnostic');
});

/* ── /api/telemetry-gaps ───────────────────────────────────────────────── */

test('/api/telemetry-gaps rollups — longest_gap_min is FLEET only; per-device records are counted apart', () => {
  // A multi-day single-Core record folded into longest_gap_min read as a multi-day fleet
  // blackout on the one endpoint that summarises the ledger.
  const restart = fleetGap({ startMs: now - 10 * H, endMs: now - 9 * H, durationMs: 40 * MIN, detectedAt: now - 9 * H, restartSpanning: true });
  const nineDays = deviceGap(CORE2, { startMs: now - 9 * 24 * H, durationMs: 9 * 24 * H - 10 * MIN });
  assert.deepEqual(telemetryGapLedgerSummary([fleetGap(), restart, nineDays, deviceGap(CORE3)]), {
    count: 4,                      // every record, so it still matches the gaps array beside it
    fleet_gap_count: 2,
    longest_gap_min: 90,           // the 90-min stall, not the nine-day Core
    device_gap_count: 2,
    longest_device_gap_min: 12950,
  });
  assert.deepEqual(telemetryGapLedgerSummary([]), { count: 0, fleet_gap_count: 0, longest_gap_min: 0, device_gap_count: 0, longest_device_gap_min: 0 });
});

/* ── the production bridges ────────────────────────────────────────────── */

test('★ BRIDGE: the alert monitor hands the device map\'s names to outageAlerts', () => {
  // SOURCE PIN, deliberately: the call sits inside startAlertMonitor's tick closure,
  // which no test drives (cf. blindPanelWording's BRIDGE pin). Without the resolver
  // every function above stays correct and the live alert names the device by serial.
  const mon = readFileSync(resolve(__dir, '../src/alertMonitor.ts'), 'utf8');
  assert.match(mon, /\.\.\.outageAlerts\(recorder\.telemetryGaps\(\), Date\.now\(\), OUTAGE_ALERT_OPTS, \(sn\) => snap\.devices\[sn\]\?\.deviceName\),/);
});

test('★ BRIDGE: /api/telemetry-gaps serves the split rollups, not a mixed one of its own', () => {
  // SOURCE PIN, deliberately: the route is registered on the Fastify app in index.ts,
  // which no test boots.
  const idx = readFileSync(resolve(__dir, '../src/index.ts'), 'utf8');
  const i = idx.indexOf("app.get('/api/telemetry-gaps'");
  assert.ok(i > 0, 'the route must still be findable');
  const route = idx.slice(i, idx.indexOf('}, 30);', i));
  assert.match(route, /\.\.\.telemetryGapLedgerSummary\(gaps\),/);
  assert.doesNotMatch(route, /longest_gap_min:/, 'the route must not re-derive a mixed rollup');
});

/* ── v1.188.1 dry run: the text states what was measured ───────────────── */

const CORE1 = 'TESTCORE00000001';
const CORE5 = 'TESTCORE00000005';
const PANEL = 'TESTPANEL0000001';
const fmt = (ms: number) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

test('★★ several devices dark at once: the detail says how many, not "one device went dark"', () => {
  // The 10-17 deploy: four Cores' records, all from the same instant.
  const four = [CORE1, CORE2, CORE3, CORE5].map((sn) => deviceGap(sn));
  const alerts = outageAlerts(four, now, OPTS, nameOf);
  assert.equal(alerts.length, 4);
  for (const a of alerts) {
    assert.match(a.detail, /while other home devices kept reporting — 4 home devices were dark at the same time, not the whole feed\./, a.detail);
    assert.doesNotMatch(a.detail, /one device went dark/);
  }
  const [one] = outageAlerts([deviceGap(CORE2)], now, OPTS, nameOf);
  assert.match(one.detail, /while other home devices kept reporting — this device went dark, not the whole feed\./);
  // Overlap, not identity: a record that ended before another began is not "at the same time".
  const earlier = deviceGap(CORE3, { startMs: now - 20 * H, endMs: now - 12 * H, durationMs: 8 * H, detectedAt: now - 12 * H });
  assert.equal(devicesDarkAlongside(deviceGap(CORE2), [deviceGap(CORE2), earlier]), 1);
  assert.equal(devicesDarkAlongside(deviceGap(CORE2), [deviceGap(CORE2), deviceGap(CORE3), fleetGap()]), 2, 'a fleet record is no device');
  assert.equal(devicesDarkAlongside(deviceGap(CORE2), [deviceGap(CORE2), deviceGap(CORE2, { startMs: now - 6.5 * H })]), 1, 'one device, however many records');
});

test('★★ v1.188.1 review 3: "N home devices were dark at the same time" counts the devices dark at ONE instant, not every record overlapping the window', () => {
  // X dark 30 h → 20 h ago; Y 22 h → 1 h ago; Z 12 h → 6 h ago. Y overlaps both, but X had ended
  // 8 h before Z began: at most two were dark at any instant.
  const span = (sn: string, fromH: number, toH: number) => deviceGap(sn, { startMs: now - fromH * H, endMs: now - toH * H, durationMs: (fromH - toH) * H, detectedAt: now - toH * H });
  const x = span(CORE1, 30, 20);
  const y = span(CORE2, 22, 1);
  const z = span(CORE3, 12, 6);
  assert.equal(devicesDarkAlongside(y, [x, y, z]), 2, '★★ two at once, never three');
  assert.equal(devicesDarkAlongside(x, [x, y, z]), 2);
  assert.equal(devicesDarkAlongside(z, [x, y, z]), 2);
  const [ay] = outageAlerts([x, y, z], now, OPTS, nameOf).filter((a) => a.id.includes(CORE2));
  assert.match(ay.detail, /— 2 home devices were dark at the same time, not the whole feed\./, ay.detail);
  // Three that are dark together are three; one that ends as another begins is not at the same time.
  const w = span(CORE5, 14, 8);
  assert.equal(devicesDarkAlongside(y, [x, y, z, w]), 3, 'Y, Z and W at 10 h ago');
  const touching = span(CORE3, 40, 30);
  assert.equal(devicesDarkAlongside(x, [x, touching]), 1, 'a record that ends as another begins');
  // v1.188.1 (review 4) — and the other way round: one that BEGINS as this one ends.
  const after = span(CORE3, 20, 10);
  assert.equal(devicesDarkAlongside(x, [x, after]), 1, '★ a record that begins as this one ends is not at the same time');
  const [ax] = outageAlerts([x, after], now, OPTS, nameOf).filter((a) => a.id.includes(CORE1));
  assert.match(ax.detail, /— this device went dark, not the whole feed\./, ax.detail);
  assert.equal(devicesDarkAlongside(y, [y, span(CORE3, 30, 21), span(CORE5, 21, 15)]), 2, 'two in turn, each with Y');
});

test('★★★ a re-dated record keeps the id it was first filed with; its text and facts give the true start', () => {
  const firstFiled = now - 7 * H;
  const lastFresh = now - 47 * H;
  const g = deviceGap(CORE2, { startMs: lastFresh, durationMs: now - 10 * MIN - lastFresh, alertStartMs: firstFiled });
  const [a] = outageAlerts([g], now, OPTS, nameOf);
  assert.equal(a.id, deviceGapAlertId(CORE2, firstFiled, 7 * H), '★★★ the id already delivered: no second push');
  assert.equal(a.title, `Device telemetry gap — no data for ${Math.round(g.durationMs / MIN)} min`);
  assert.ok(a.detail.includes(`(${fmt(lastFresh)} → ${fmt(g.endMs)})`), a.detail);
  assert.equal(a.facts?.find((f) => f.label === 'Started')?.value, fmt(lastFresh));
  const [plain] = outageAlerts([deviceGap(CORE2)], now, OPTS, nameOf);
  assert.equal(plain.id, deviceGapAlertId(CORE2, now - 7 * H, 7 * H - 10 * MIN), 'never re-dated: keyed on its start as before');
});

test('★★ an in-process fleet gap the gate explains names what was held, not an MQTT/broker stall', () => {
  const pname = (sn: string) => ({ [PANEL]: 'Smart Home Panel 2', ...names } as Record<string, string>)[sn];
  const shadowed = fleetGap({ held: [{ sn: PANEL, shadow: true }] });
  const [a] = outageAlerts([shadowed], now, OPTS, pname);
  assert.equal(a.title, 'Telemetry gap — no data for 90 min', 'the same title and id as any in-process gap');
  assert.equal(a.id, outageAlertId(shadowed.startMs, shadowed.durationMs));
  assert.equal(a.detail, `No fresh home-device readings reached the recorder for 90 min (${fmt(shadowed.startMs)} → ${fmt(shadowed.endMs)}): `
    + 'the add-on kept checking the fleet, but every home device it had a reading for was held — the EcoFlow cloud replayed the last payload of Smart Home Panel 2 (cloud shadow), '
    + 'so nothing was recorded (only fresh readings are saved). Writes have since resumed. History in that window is missing but the process stayed up.');
  assert.equal(a.facts?.find((f) => f.label === 'Type')?.value, 'in-process (held readings)');
  assert.equal(heldGapPhrase([{ sn: PANEL, shadow: false }, { sn: CORE2, shadow: false }, { sn: CORE3, shadow: false }], pname),
    'every home device it had a reading for was held — Smart Home Panel 2, Core 2 and Core 3 sent no new readings');
  assert.equal(heldGapPhrase([{ sn: PANEL, shadow: true }, { sn: CORE2, shadow: false }], () => null),
    `every home device it had a reading for was held — the EcoFlow cloud replayed the last payload of ${PANEL} (cloud shadow); ${CORE2} sent no new readings`, 'by serial when unnamed');
  // v1.188.1 review 3 — a device read fresh with nothing measurable is named, and the phrase does
  // not say that every home device it read was held.
  assert.equal(heldGapPhrase([{ sn: CORE2, shadow: false }], pname, [PANEL, CORE3]),
    'no home device it had a reading for gave one to record — Core 2 sent no new readings; Smart Home Panel 2 and Core 3 reported nothing measurable');
  const mixed = fleetGap({ held: [{ sn: CORE2, shadow: false }], unmeasured: [PANEL] });
  const [m] = outageAlerts([mixed], now, OPTS, pname);
  assert.equal(m.detail, `No home-device reading could be recorded for 90 min (${fmt(mixed.startMs)} → ${fmt(mixed.endMs)}): `
    + 'the add-on kept checking the fleet, but no home device it had a reading for gave one to record — Core 2 sent no new readings; Smart Home Panel 2 reported nothing measurable, '
    + 'so nothing was recorded (only fresh readings are saved). Writes have since resumed. History in that window is missing but the process stayed up.');
  assert.equal(m.facts?.find((f) => f.label === 'Type')?.value, 'in-process (held readings)');
  assert.equal(m.id, outageAlertId(mixed.startMs, mixed.durationMs), 'the same id');
  // Without a held set (no evaluation found anything held), and on a restart gap, the text is unchanged.
  assert.match(outageAlerts([fleetGap()], now, OPTS)[0].detail, /— an MQTT\/broker stall; writes have since resumed\./);
  assert.match(outageAlerts([fleetGap({ held: [] })], now, OPTS)[0].detail, /— an MQTT\/broker stall;/);
  const restart = fleetGap({ restartSpanning: true, held: [{ sn: PANEL, shadow: true }] });
  assert.match(outageAlerts([restart], now, OPTS)[0].detail, /spanning a restart/);
});
