import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { withEnv } from './golden/support/env.js';

/**
 * v1.191.0 (S2) — config.ts reads its deployment constants through the option table, so the rules
 * that used to live in eleven inline expressions are pinned here: the DB_PATH default inside the add-on
 * (v1.7.2: /data, absolute, so a dropped export can never redirect state writes under /app, which the
 * AppArmor profile denies), the relative default outside it, `isAddon`, `dataRoot` / `dataFile`, and
 * the secret getters that throw on first use rather than at import.
 */
let seq = 0;
type Cfg = typeof import('../src/config.js');
const fresh = async (): Promise<Cfg> => (await import(`../src/config.ts?dbpath=${++seq}`)) as Cfg;

test('DB_PATH defaults to the absolute /data path inside the add-on and the relative path outside it', async () => {
  // isAddon reads at call time, so it is evaluated inside the scope that sets the token.
  await withEnv({ DB_PATH: undefined, SUPERVISOR_TOKEN: 'tok' }, async () => {
    const inside = await fresh();
    assert.equal(inside.config.dbPath, '/data/ecoflow.db');
    assert.equal(inside.config.isAddon, true);
  });
  await withEnv({ DB_PATH: undefined, SUPERVISOR_TOKEN: undefined }, async () => {
    const outside = await fresh();
    assert.equal(outside.config.dbPath, '../data/ecoflow.db');
    assert.equal(outside.config.isAddon, false);
  });
  const explicit = await withEnv({ DB_PATH: '/tmp/x/ecoflow.db', SUPERVISOR_TOKEN: 'tok' }, fresh);
  assert.equal(explicit.config.dbPath, '/tmp/x/ecoflow.db');
});

test('dataRoot is the directory beside the database and dataFile honours an explicit override', async () => {
  const c = await withEnv({ DB_PATH: '/tmp/x/ecoflow.db' }, fresh);
  assert.equal(c.config.dataRoot, resolve(process.cwd(), '/tmp/x/ecoflow.db', '..'));
  assert.equal(c.config.dataFile('grid-reading.json'), resolve('/tmp/x', 'grid-reading.json'));
  assert.equal(c.config.dataFile('grid-reading.json', '/elsewhere/g.json'), '/elsewhere/g.json');
  assert.equal(c.config.dataFile('grid-reading.json', ''), resolve('/tmp/x', 'grid-reading.json'));
  assert.equal(await withEnv({ DATA_DIR: undefined }, async () => (await fresh()).config.dataDir), '/data');
  assert.equal(await withEnv({ DATA_DIR: '/tmp/d' }, async () => (await fresh()).config.dataDir), '/tmp/d');
});

test('the secret getters throw on first access, not at import, and cache the value', async () => {
  await withEnv({ ECOFLOW_ACCESS_KEY: undefined, ECOFLOW_SECRET_KEY: '' }, async () => {
    const c = await fresh(); // importing with the keys absent does not throw
    assert.throws(() => c.config.accessKey, /Missing required env var: ECOFLOW_ACCESS_KEY/);
    assert.throws(() => c.config.secretKey, /Missing required env var: ECOFLOW_SECRET_KEY/);
  });
  await withEnv({ ECOFLOW_ACCESS_KEY: 'k', ECOFLOW_SECRET_KEY: 's' }, async () => {
    const ok = await fresh();
    assert.equal(ok.config.accessKey, 'k');
    assert.equal(ok.config.secretKey, 's');
    process.env.ECOFLOW_ACCESS_KEY = 'changed';
    assert.equal(ok.config.accessKey, 'k', 'the first value read is cached for the process');
  });
});

test('option() reads a registered key at call time and refuses an unregistered one', async () => {
  const c = await fresh();
  assert.throws(() => c.option('NOT_A_KEY'), /not a registered option/);
  await withEnv({ LOG_LEVEL: 'debug' }, () => { assert.equal(c.option('LOG_LEVEL'), 'debug'); });
  await withEnv({ LOG_LEVEL: undefined }, () => { assert.equal(c.option('LOG_LEVEL'), 'info'); });
  // the snapshot fields keep their load-time semantics (the SSH block through resolveSshConfig: both
  // enabled options off, SSH_PORT at its default so the deprecated TELNET_PORT applies)
  const snap = await withEnv({ PORT: '9999', HOST: '0.0.0.0', SSH_ENABLED: '0', SSH_PORT: undefined, TELNET_ENABLED: '0', TELNET_PORT: '2325', SSH_HOST: undefined, TELNET_HOST: undefined, SSH_HOST_KEY: undefined, LOG_LEVEL: 'warn', FORECAST_LAT: '1.5', FORECAST_LON: '-2.5', ECOFLOW_API_HOST: undefined }, fresh);
  assert.deepEqual(
    { port: snap.config.port, host: snap.config.host, ssh: snap.config.ssh, logLevel: snap.config.logLevel, lat: snap.config.forecastLat, lon: snap.config.forecastLon, api: snap.config.apiHost },
    { port: 9999, host: '0.0.0.0', ssh: { enabled: false, host: '::', port: 2325, hostKeyPath: '/data/ssh_host_ed25519_key', deprecationNotes: ['SSH_PORT is at its default and the deprecated TELNET_PORT is 2325: TELNET_PORT applies; set SSH_PORT instead'] }, logLevel: 'warn', lat: 1.5, lon: -2.5, api: 'https://api-a.ecoflow.com' },
  );
});
