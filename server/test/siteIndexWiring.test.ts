import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (S7, lane C) — index.ts reads the site through site.ts (plan 3.6 P2; OWNER DECISION 5;
 * CA20). The behaviour behind each line is tested in site.test.ts and pvSite.test.ts; this holds the
 * production wiring to it, so a module that is tested but not called cannot pass (the inert-option
 * failure this repository has shipped before).
 */
const HERE = dirname(fileURLToPath(import.meta.url));

test('★★★ index.ts: the physics endpoint, the repair list and the boot read the site through site.ts', () => {
  const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
  for (const pin of [
    '  const site = pvSite();',
    '  const ambient = physicsAmbientC(ts, site, isLegacyPvSite(site) ? null : await getWeather((m) => app.log.debug(m)));',
    '  const result = physicsPmax(ts, ambient, site);',
    'issues: [...report.issues, ...siteRepairIssues()]',
    'siteBootNotices(siteLog, { rosterSize: lastKnownRoster.size });',
    'checkHaHomeLocation({ log: siteLog })',
    "app.get('/api/site', async (req, reply) => cached(req, reply, siteResponse(store.get().devices, lastKnownRoster), 60));",
  ]) assert.ok(idx.includes(pin), `index.ts: missing ${pin}`);
  assert.ok(!/physicsPmax\([^)]*PHOENIX_SITE/.test(idx), 'the endpoint no longer pins the reference array');
  assert.ok(!idx.includes('forecastLat: lat, forecastLon: lon } = config'), 'index.ts reads the coordinates past site.ts');
  // the location read is background-only: scheduled, never awaited at boot
  assert.ok(!/await checkHaHomeLocation/.test(idx), 'boot must not wait on Home Assistant');
});
