#!/usr/bin/env node
/**
 * v0.9.55 — One-shot HA dashboard installer for the EcoFlow Panel cards.
 *
 * Decoupled sources by design:
 *   - **Card JS modules** load from jsdelivr's GitHub mirror, pinned to a
 *     git tag. Jsdelivr serves with `Cache-Control: immutable` and the
 *     correct CORS + MIME headers, so HA can `import()` them from any
 *     origin without browser blocking. No add-on update needed for the
 *     dashboard to render — handy when the add-on is installed from
 *     `local` source (Supervisor can't auto-update those from GHCR).
 *   - **Data** comes from the add-on at `http://<host>:8787`. Each card's
 *     `host:` config points here for `/api/snapshot`, WebSocket stream,
 *     `/api/history`, etc.
 *
 * What this script does, via HA's authenticated WebSocket API:
 *   1. Verifies the chosen RESOURCE_BASE serves a real JS bundle for each
 *      of the 7 cards. Refuses to proceed if not — otherwise the
 *      dashboard would render "Custom element doesn't exist".
 *   2. Adds Lovelace resources for any of the 7 cards that aren't already
 *      registered at the same URL. Existing resources at different URLs
 *      are left alone (won't double-register or clobber).
 *   3. Creates a storage-mode dashboard at url_path=ecoflow with sidebar
 *      entry "EcoFlow" / mdi:home-battery. Re-running is safe — if the
 *      dashboard already exists the create step is skipped, and the
 *      config save step always re-writes the tabs.
 *   4. Saves a 7-tab config: Fleet / Battery / Solar / Alerts / Strategy /
 *      Insights / Circuits.
 *
 * Usage:
 *   HA_TOKEN=<long-lived-token> \
 *     node scripts/setup-ha-dashboard.mjs
 *
 * Overrides (all optional):
 *   HA_HOST=homeassistant.local:8123
 *   ADDON_HOST=http://homeassistant.local:8787  # where the cards fetch data
 *   RESOURCE_BASE=https://cdn.jsdelivr.net/gh/tesseractAZ/ecoflow-panel@v0.9.55/lovelace/dist
 *   DASHBOARD_PATH=ecoflow
 *   DASHBOARD_TITLE=EcoFlow
 *
 * No external deps beyond the `ws` already in server/node_modules.
 */
import WebSocket from '../server/node_modules/ws/wrapper.mjs';

const HA_TOKEN = process.env.HA_TOKEN;
const HA_HOST = process.env.HA_HOST ?? 'homeassistant.local:8123';
const ADDON_HOST = process.env.ADDON_HOST ?? 'http://homeassistant.local:8787';
const RESOURCE_BASE =
  process.env.RESOURCE_BASE ??
  'https://cdn.jsdelivr.net/gh/tesseractAZ/ecoflow-panel@v0.9.55/lovelace/dist';
// HA's lovelace/dashboards/create requires a hyphen in url_path. Use one.
const DASHBOARD_PATH = process.env.DASHBOARD_PATH ?? 'ecoflow-dashboard';
const DASHBOARD_TITLE = process.env.DASHBOARD_TITLE ?? 'EcoFlow';

if (!HA_TOKEN) {
  console.error('FATAL: HA_TOKEN env var required (long-lived access token)');
  process.exit(1);
}

const CARDS = [
  { slug: 'ecoflow-fleet-card', title: 'EcoFlow Fleet' },
  { slug: 'ecoflow-battery-card', title: 'EcoFlow Battery' },
  { slug: 'ecoflow-solar-card', title: 'EcoFlow Solar' },
  { slug: 'ecoflow-alerts-card', title: 'EcoFlow Alerts' },
  { slug: 'ecoflow-strategy-card', title: 'EcoFlow Strategy' },
  { slug: 'ecoflow-insights-card', title: 'EcoFlow Advanced Insights' },
  { slug: 'ecoflow-circuit-card', title: 'Circuit Drill-Down' },
];

// Six 240V split-phase circuits that have user-assigned names — the other
// six channels are the paired half (linkCh) of these and the card already
// renders the combined view, so we don't double-list them.
const NAMED_CIRCUITS = [
  { ch: 1, label: 'East Wing' },
  { ch: 2, label: 'Closet Subpanel' },
  { ch: 5, label: 'Garage Subpanel & AC' },
  { ch: 6, label: 'West Air Conditioner' },
  { ch: 9, label: 'East Air Conditioner' },
  { ch: 10, label: 'Pool Pump' },
];

// ─── WebSocket plumbing ──────────────────────────────────────────────────
let _nextId = 1;
const _pending = new Map();

function send(ws, payload) {
  return new Promise((resolveP, rejectP) => {
    const id = _nextId++;
    _pending.set(id, { resolveP, rejectP });
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

function setupRouter(ws) {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'result' && _pending.has(msg.id)) {
      const { resolveP, rejectP } = _pending.get(msg.id);
      _pending.delete(msg.id);
      if (msg.success) resolveP(msg.result);
      else rejectP(new Error(`HA WS error: ${JSON.stringify(msg.error)}`));
    }
  });
}

async function authenticate(ws) {
  return new Promise((resolveP, rejectP) => {
    ws.once('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'auth_required') {
        return rejectP(new Error(`unexpected first frame: ${msg.type}`));
      }
      ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
      ws.once('message', (raw2) => {
        const ack = JSON.parse(raw2.toString());
        if (ack.type === 'auth_ok') {
          setupRouter(ws); // route subsequent result frames
          resolveP();
        } else {
          rejectP(new Error(`auth failed: ${JSON.stringify(ack)}`));
        }
      });
    });
  });
}

// ─── Verify the resource origin serves the card bundles ────────────────
async function verifyCards() {
  console.log(`\nProbing ${RESOURCE_BASE}/ for the 7 card bundles…`);
  let allOk = true;
  for (const { slug } of CARDS) {
    const url = `${RESOURCE_BASE}/${slug}.js`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const len = Number(res.headers.get('content-length') ?? 0);
      // jsdelivr returns 0 for content-length on HEAD sometimes; fall back to a
      // GET-and-check-bytes if needed.
      let ok = res.ok && len > 5000;
      if (res.ok && len === 0) {
        const buf = await (await fetch(url)).arrayBuffer();
        ok = buf.byteLength > 5000;
        console.log(`  ${ok ? '✓' : '✗'} ${slug}.js  status=${res.status} bytes=${buf.byteLength} (via GET)`);
      } else {
        console.log(`  ${ok ? '✓' : '✗'} ${slug}.js  status=${res.status} bytes=${len}`);
      }
      if (!ok) allOk = false;
    } catch (e) {
      console.log(`  ✗ ${slug}.js  fetch failed: ${e.message}`);
      allOk = false;
    }
  }
  return allOk;
}

// ─── Lovelace resources ─────────────────────────────────────────────────
async function ensureResources(ws) {
  console.log('\nReconciling Lovelace resources…');
  const existing = await send(ws, { type: 'lovelace/resources' });
  const wanted = new Set(CARDS.map(({ slug }) => `${RESOURCE_BASE}/${slug}.js`));
  const already = new Set(existing.filter((r) => wanted.has(r.url)).map((r) => r.url));
  for (const url of wanted) {
    if (already.has(url)) {
      console.log(`  · already present  ${url}`);
      continue;
    }
    const created = await send(ws, {
      type: 'lovelace/resources/create',
      res_type: 'module',
      url,
    });
    console.log(`  + created  ${url}  (id=${created.id ?? '?'})`);
  }
}

// ─── Dashboard creation ─────────────────────────────────────────────────
async function ensureDashboard(ws) {
  console.log('\nReconciling dashboard…');
  const dashboards = await send(ws, { type: 'lovelace/dashboards/list' });
  const existing = dashboards.find((d) => d.url_path === DASHBOARD_PATH);
  if (existing) {
    console.log(`  · dashboard '${DASHBOARD_PATH}' already exists (id=${existing.id})`);
    return existing;
  }
  const created = await send(ws, {
    type: 'lovelace/dashboards/create',
    url_path: DASHBOARD_PATH,
    mode: 'storage',
    title: DASHBOARD_TITLE,
    icon: 'mdi:home-battery',
    show_in_sidebar: true,
    require_admin: false,
  });
  console.log(`  + created  /${DASHBOARD_PATH}  (id=${created.id})`);
  return created;
}

// ─── Lovelace config (7 tabs) ───────────────────────────────────────────
function buildConfig() {
  // Defaults that every card shares — `refresh_seconds` ≥ 10s (the cards
  // clamp anything lower). Insights gets 60 because its 15 endpoints are
  // genuinely slow-data.
  const base = (slug, title, extra = {}, refreshSec = 30) => ({
    type: `custom:${slug}`,
    host: ADDON_HOST,
    title,
    refresh_seconds: refreshSec,
    ...extra,
  });
  return {
    title: DASHBOARD_TITLE,
    views: [
      {
        title: 'Fleet',
        path: 'fleet',
        icon: 'mdi:view-dashboard-variant',
        cards: [base('ecoflow-fleet-card', 'EcoFlow Fleet')],
      },
      {
        title: 'Battery',
        path: 'battery',
        icon: 'mdi:battery-high',
        cards: [base('ecoflow-battery-card', 'Battery')],
      },
      {
        title: 'Solar',
        path: 'solar',
        icon: 'mdi:solar-power',
        cards: [base('ecoflow-solar-card', 'Solar')],
      },
      {
        title: 'Alerts',
        path: 'alerts',
        icon: 'mdi:alert',
        cards: [base('ecoflow-alerts-card', 'Alerts')],
      },
      {
        title: 'Strategy',
        path: 'strategy',
        icon: 'mdi:cog-transfer',
        cards: [base('ecoflow-strategy-card', 'Strategy')],
      },
      {
        title: 'Insights',
        path: 'insights',
        icon: 'mdi:brain',
        cards: [base('ecoflow-insights-card', 'Advanced Insights', {}, 60)],
      },
      {
        title: 'Circuits',
        path: 'circuits',
        icon: 'mdi:lightning-bolt',
        cards: NAMED_CIRCUITS.map(({ ch, label }) =>
          base('ecoflow-circuit-card', label, { circuit: ch, cost_per_kwh: 0.17 }, 60)
        ),
      },
    ],
  };
}

async function saveConfig(ws) {
  console.log('\nSaving 7-tab dashboard config…');
  const config = buildConfig();
  await send(ws, {
    type: 'lovelace/config/save',
    url_path: DASHBOARD_PATH,
    config,
  });
  console.log(`  ✓ saved ${config.views.length} views (Circuits has ${config.views[6].cards.length} cards)`);
}

// ─── main ───────────────────────────────────────────────────────────────
(async () => {
  console.log(`HA WebSocket → ws://${HA_HOST}/api/websocket`);
  console.log(`Add-on host → ${ADDON_HOST}  (data: snapshot, WS stream, history)`);
  console.log(`Resource base → ${RESOURCE_BASE}  (card JS modules)`);

  const cardsOk = await verifyCards();
  if (!cardsOk) {
    console.error('\n✗ One or more card bundles are not reachable at RESOURCE_BASE.');
    console.error('  Check the URL — jsdelivr mirrors GitHub tags within minutes.');
    console.error('  Re-running is safe — the script is idempotent.');
    process.exit(2);
  }

  const ws = new WebSocket(`ws://${HA_HOST}/api/websocket`);
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  await authenticate(ws);
  console.log('✓ authenticated to HA');

  await ensureResources(ws);
  await ensureDashboard(ws);
  await saveConfig(ws);

  console.log(`\n✓ Done. Open http://${HA_HOST}/${DASHBOARD_PATH} in HA.`);
  console.log('  The sidebar entry "' + DASHBOARD_TITLE + '" may take a refresh to appear.');

  ws.close();
})().catch((e) => {
  console.error('\n✗ Setup failed:', e.message);
  process.exit(1);
});
