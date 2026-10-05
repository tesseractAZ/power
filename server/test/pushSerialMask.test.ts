/**
 * v1.187.10 (log review 10-03, C33) — device serials do not leave the host in a phone push.
 *
 * The companion-app push (title, message, data.tag) travels through Apple's or Google's push
 * service. The per-device telemetry-gap alert put "<name> (<serial>)" in its text (and a device with
 * no display name was labelled by its serial alone), and every per-device alert id — the push tag —
 * embeds a serial. The drawer card and the logs stay on the host and keep full serials. Device ids
 * are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMobilePushPayload, maskDeviceSerials, maskSerialsInId, haNotifyCall } from '../src/notify.js';
import { outageAlerts } from '../src/alerts.js';

const SN = 'COREXXX00XXX0002';
const TWIN = 'PANEXXX00XXX0002'; // shares its last six characters with SN
const SERIAL = /(?<![A-Za-z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])/i;

test('maskDeviceSerials — a 16-character serial shows its last six; everything else is untouched', () => {
  assert.equal(maskDeviceSerials(`Core 2 (${SN}) wrote no samples`), 'Core 2 (…XX0002) wrote no samples');
  for (const keep of [
    'Severe Thunderstorm Warning', '1790972417926 ms', 'ABCDEFGHIJKLMNOP (no digits)', '1234567890123456 (no letters)',
    'COREXXX00XXX00021 (17 characters)', 'pack 1 (SN …abc123)', 'corexxx00xxx0002 (lower case is not a serial)',
  ]) assert.equal(maskDeviceSerials(keep), keep);
  assert.equal(maskSerialsInId(`soc-low-${SN}-1`), maskSerialsInId(`soc-low-${SN.toLowerCase()}-1`), 'case does not change the digest');
  assert.notEqual(maskSerialsInId(`x-${SN}`), maskSerialsInId(`x-${TWIN}`), 'two serials with one tail never share a tag');
});

test('★★★ the per-device telemetry-gap push carries no serial in its title, message or tag; fire and resolve share the tag; the drawer card is unchanged', () => {
  const now = Date.now();
  const gap = { startMs: now - 25 * 60_000, endMs: now - 60_000, durationMs: 24 * 60_000, detectedAt: now - 60_000, sn: SN };
  const opts = { enabled: true, recentWindowMs: 24 * 3_600_000, minDurationMs: 15 * 60_000, restartMinDurationMs: 5 * 60_000 };
  for (const name of [(_: string) => 'Core 2', (_: string) => null]) {
    const [alert] = outageAlerts([gap], now, opts, name);
    assert.ok(SERIAL.test(alert.detail) || SERIAL.test(alert.device ?? ''), 'the alert itself names the serial (it stays on the host)');
    const msg = { title: `EcoFlow · [Medium] ${alert.title} — ${alert.device}`, body: alert.detail, severity: 'warning' as const, dedupId: alert.id };
    const p = buildMobilePushPayload(msg, { criticalBypassDnd: true }) as { title: string; message: string; data: { tag: string } };
    assert.ok(!SERIAL.test(JSON.stringify(p)), `no serial leaves in the push: ${JSON.stringify(p)}`);
    assert.ok(p.message.includes('…XX0002'), 'the operator can still tell which device: its last six characters');
    const resolved = buildMobilePushPayload({ ...msg, severity: 'resolved' }, { criticalBypassDnd: true }) as { data: { tag: string } };
    assert.equal(resolved.data.tag, p.data.tag, 'a resolve replaces its own alert on the phone');
    assert.match(p.data.tag, /^[a-z0-9_]+$/);
    // The HA drawer card (on the host) keeps the id it always had, so a resolve still dismisses it.
    assert.ok(haNotifyCall(msg).notificationId.includes(SN.toLowerCase()));
  }
});
