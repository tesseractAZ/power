#!/usr/bin/env node
/**
 * mutate-v1187-3i.mjs — committed harness for v1.187.3 (ledger and tooling).
 *
 * (1) delivered_kwh subtracted the hold span's whole house load from grid import, assuming the
 * house ran on the grid all window. On 2026-09-30 the SHP2 carried the house from the pack
 * before the just-in-time force-charge and after its OFF, and the row would have recorded 4.71
 * kWh against ~20.3 kWh into the Cores. It is now the charging part of the house panel's
 * source channels over the hold (nightLedgerScoring.deliveredIntoCores): the channels the hold
 * recorded plus any slot connected at capture (review: capture runs ~16 h after the close, so
 * its membership is not the night's), a per-channel coverage gate (the worst channel), an
 * import bound with slack, `delivered_basis` written exactly when the value is
 * (deliveredLedgerFields), the house panel's slots by its own serial (houseConnectedSlots), and
 * the buy de-bias learner reading only that basis (calibratedBuyDebiasFactor; earlier rows are
 * set aside, counted and named by buyDebiasUnmeasuredLogLine). Mutants i-xxx, xxxii-xxxiii.
 * The two call sites left in index.ts (`houseConnectedSlots(store.get().devices, shp2Sn)` and
 * `...deliveredLedgerFields(cols)`) are glue beside the query seam, which no test drives.
 *
 * (2) buildNightChargeInputs dropped buyDebiasBasis / buyDebiasSamples, so every plan reported
 * 'default' / 0 whatever the learner said. Mutant xxxi.
 *
 * (3) images.yml's best-effort docs steps had no bound: a stalled apt mirror ran the release
 * job into the 6 h platform limit, the job was cancelled and no GitHub Release was created.
 * The job, each docs step, apt itself and the docs tools are now bounded, the job above the sum
 * of its steps; ci.yml's docs gate likewise. A bounded step can be killed mid-write, so the
 * Release attaches a document only on its build step's own success (review). Mutants
 * xxxiv-xlviii (the Release step's script is RUN against a stub gh; the rest structural).
 *
 *   node scripts/mutate-v1187-3i.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const NLS = resolve(SERVER, 'src/nightLedgerScoring.ts');
const ADV = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const REC = resolve(SERVER, 'src/recorder.ts');
const IMG = resolve(REPO, '.github/workflows/images.yml');
const CI = resolve(REPO, '.github/workflows/ci.yml');

const SUBSET = [
  'test/ledgerDeliveredIntoCores.test.ts',
  'test/ledgerDeliveredBasis.test.ts',
  'test/ledgerScorerAssembly.test.ts',
  'test/buyDebiasCalibration.test.ts',
  'test/auditF7toF12.test.ts',
  'test/workflowTimeouts.test.ts',
];

const MUTANTS = [
  /* ── (1) the measurement ──────────────────────────────────────────────── */
  {
    id: 'i. ★★★ an actuated night measures nothing',
    file: NLS,
    find: '    delivered = deliveredIntoCores({ hold, connectedSlots: i.houseConnectedSlots, query: i.query });',
    to: '    delivered = null; /* MUTANT */',
    why: 'Every actuated night records NULL: the learner never measures again.',
  },
  {
    id: 'ii. ★★★ a channel carrying the house nets against the charge',
    file: NLS,
    find: '    wh += integrateWh(pts, true);',
    to: '    wh += integrateWh(pts, false); /* MUTANT */',
    why: 'The 09-30 night (15.5 kWh of discharge around a 20.5 kWh charge) records ~5 kWh again: the under-count this release removes.',
  },
  {
    id: 'iii. ★★★ no coverage gate',
    file: NLS,
    find: '  if (worst == null || !(worst.cov >= LEDGER_SPAN_MIN_COVERAGE)) {',
    to: '  if (worst == null) { /* MUTANT */',
    why: 'A channel dark for hours writes a deflated total into a never-pruned column, toward under-delivery.',
  },
  {
    id: 'iv. ★★★ the gate reads the first channel, not the worst',
    file: NLS,
    find: '    if (worst == null || cov < worst.cov) worst = { ch, cov };',
    to: '    if (worst == null) worst = { ch, cov }; /* MUTANT */',
    why: 'A dark third channel beside two healthy ones writes a two-thirds total (the Core 2 dark-nine-days shape).',
  },
  {
    id: 'v. ★★ the coverage line is exclusive',
    file: NLS,
    find: '  if (worst == null || !(worst.cov >= LEDGER_SPAN_MIN_COVERAGE)) {',
    to: '  if (worst == null || !(worst.cov > LEDGER_SPAN_MIN_COVERAGE)) { /* MUTANT */',
    why: 'A span covered exactly at the line is withheld, unlike every other ledger gate.',
  },
  {
    id: 'vi. ★★★ no channel and no connected Core reads as 0 kWh delivered',
    file: NLS,
    find: "      kwh: null, basis: null,\n      note: 'Delivered: unmeasured (no source channel recorded",
    to: "      kwh: 0, basis: DELIVERED_BASIS, /* MUTANT */\n      note: 'Delivered: unmeasured (no source channel recorded",
    why: 'A night whose channels recorded nothing writes a measured zero: a 0.0 ratio into the learner.',
  },
  {
    id: 'vii. ★★★ no import bound',
    file: NLS,
    find: '    if (kwh > impKwh * (1 + DELIVERED_IMPORT_SLACK_FRAC) + DELIVERED_IMPORT_SLACK_KWH) {',
    to: '    if (false) { /* MUTANT */',
    why: 'A channel read with the wrong sign counts the pack carrying the house as ~20 kWh of delivery.',
  },
  {
    id: 'viii. ★★ the import bound has no proportional slack',
    file: NLS,
    find: '    if (kwh > impKwh * (1 + DELIVERED_IMPORT_SLACK_FRAC) + DELIVERED_IMPORT_SLACK_KWH) {',
    to: '    if (kwh > impKwh + DELIVERED_IMPORT_SLACK_KWH) { /* MUTANT */',
    why: 'Two series on different clocks disagree by a few percent on a 20 kWh night: real deliveries are withheld.',
  },
  {
    id: 'ix. ★★ the import bound has no absolute slack',
    file: NLS,
    find: '    if (kwh > impKwh * (1 + DELIVERED_IMPORT_SLACK_FRAC) + DELIVERED_IMPORT_SLACK_KWH) {',
    to: '    if (kwh > impKwh * (1 + DELIVERED_IMPORT_SLACK_FRAC)) { /* MUTANT */',
    why: 'As viii, on the small nights where the proportional slack is a fraction of a kWh.',
  },
  {
    id: 'x. ★★ a deflated meter bounds the measurement',
    file: NLS,
    find: '  if (coverageFrac(imp, i.hold.startMs, i.hold.endMs) >= LEDGER_SPAN_MIN_COVERAGE) {',
    to: '  if (true) { /* MUTANT */',
    why: 'A grid_home_w hole across the charge withholds a fully covered delivery.',
  },
  {
    id: 'xi. ★★ a measured value is written without its basis',
    file: NLS,
    find: '    kwh, basis: DELIVERED_BASIS,',
    to: '    kwh, basis: null, /* MUTANT */',
    why: 'Every new night reads as legacy: the learner sets all of them aside and never measures again.',
  },
  /* ── (1, review) the channels come from the hold ──────────────────────── */
  {
    id: 'xii. ★★★ a channel the hold recorded is dropped when its slot is not connected at capture',
    file: NLS,
    find: '    if (pts.length > 0 || connected.has(ch)) read.push({ ch, pts });',
    to: '    if (connected.has(ch)) read.push({ ch, pts }); /* MUTANT */',
    why: 'A Core unplugged by the next evening, or a quota with no sources subtree, takes its night out of the column: a two-thirds sample, or NULL latched.',
  },
  {
    id: 'xiii. ★★★ a connected Core whose channel recorded nothing is not gated',
    file: NLS,
    find: '    if (pts.length > 0 || connected.has(ch)) read.push({ ch, pts });',
    to: '    if (pts.length > 0) read.push({ ch, pts }); /* MUTANT */',
    why: 'A dark channel beside two healthy ones is summed past: a two-thirds total on the trusted basis.',
  },
  {
    id: 'xiv. ★★ a slot neither recorded nor connected is gated',
    file: NLS,
    find: '    if (pts.length > 0 || connected.has(ch)) read.push({ ch, pts });',
    to: '    read.push({ ch, pts }); /* MUTANT */',
    why: 'A panel whose payload carries fewer channels than slots nulls every night on an empty slot.',
  },
  {
    id: 'xv. ★★★ only the slots connected at capture are scanned',
    file: NLS,
    find: '  for (const ch of [...new Set([...SOURCE_CHANNEL_SLOTS, ...i.connectedSlots])].sort((a, b) => a - b)) {',
    to: '  for (const ch of [...i.connectedSlots]) { /* MUTANT */',
    why: 'Capture-time membership decides the night again (the review finding).',
  },
  {
    id: 'xvi. ★★ the assembly drops the capture-time slots',
    file: NLS,
    find: '    delivered = deliveredIntoCores({ hold, connectedSlots: i.houseConnectedSlots, query: i.query });',
    to: '    delivered = deliveredIntoCores({ hold, connectedSlots: [], query: i.query }); /* MUTANT */',
    why: 'A connected Core whose channel recorded nothing no longer withholds the night.',
  },
  {
    id: 'xvii. ★★ the channels are integrated over the window, not the hold',
    file: NLS,
    find: '    delivered = deliveredIntoCores({ hold, connectedSlots: i.houseConnectedSlots, query: i.query });',
    to: '    delivered = deliveredIntoCores({ hold: { startMs: i.windowStartMs, endMs: i.windowEndMs }, connectedSlots: i.houseConnectedSlots, query: i.query }); /* MUTANT */',
    why: 'A night still charging at the close loses the restore tick and the device stop again (the v1.187.0 tail).',
  },
  {
    id: 'xviii. ★★ the delivered clause is dropped from score_notes',
    file: NLS,
    find: "${delivered ? ` ${delivered.note}.` : ''}",
    to: '/* MUTANT */',
    why: 'A NULL delivered_kwh no longer says why (dark channel, implausible, nothing recorded).',
  },
  /* ── (1) the house panel's slots ──────────────────────────────────────── */
  {
    id: 'xix. ★★ a disconnected slot is read as a Core',
    file: NLS,
    find: '    if (s.isConnected && s.sn && Number.isInteger(s.slot) && s.slot >= 1) out.add(s.slot);',
    to: '    if (s.sn && Number.isInteger(s.slot) && s.slot >= 1) out.add(s.slot); /* MUTANT */',
    why: 'A slot whose Core was unplugged is gated on: its silent channel nulls every night.',
  },
  {
    id: 'xx. ★★ a slot with no serial is read as a Core',
    file: NLS,
    find: '    if (s.isConnected && s.sn && Number.isInteger(s.slot) && s.slot >= 1) out.add(s.slot);',
    to: '    if (s.isConnected && Number.isInteger(s.slot) && s.slot >= 1) out.add(s.slot); /* MUTANT */',
    why: 'Membership drifts from panelRoster: a slot the rest of the app does not count is gated on.',
  },
  {
    id: 'xxi. ★ the slots are not sorted',
    file: NLS,
    find: '  return [...out].sort((a, b) => a - b);\n}\n\n/** v1.187.3 (review) — the HOUSE panel',
    to: '  return [...out]; /* MUTANT */\n}\n\n/** v1.187.3 (review) — the HOUSE panel',
    why: 'The slots follow the vendor payload order.',
  },
  {
    id: 'xxii. ★★★ the slots are read from the first panel in the map, not the house panel',
    file: NLS,
    find: '  const p = devices[shp2Sn]?.projection;',
    to: '  const p = Object.values(devices)[0]?.projection; /* MUTANT */',
    why: 'In a two-panel plant the garage panel (the lower serial) supplies the house night\'s slots.',
  },
  {
    id: 'xxiii. ★ any projection with a sources field is read as a panel',
    file: NLS,
    find: "  return p?.kind === 'shp2' ? connectedSourceSlots((p as Shp2Projection).sources) : [];",
    to: '  return connectedSourceSlots((p as Shp2Projection | undefined)?.sources); /* MUTANT */',
    why: 'Only an SHP2 projection has source slots.',
  },
  /* ── (1, review) the ledger fields, written together ──────────────────── */
  {
    id: 'xxiv. ★★★ the scorer never writes the basis',
    file: NLS,
    find: '    delivered_basis: cols.deliveredKwh == null ? null : cols.deliveredBasis,',
    to: '    delivered_basis: null, /* MUTANT */',
    why: 'Every new night reads as legacy: the learner never measures again.',
  },
  {
    id: 'xxv. ★★ a NULL value carries the basis',
    file: NLS,
    find: '    delivered_basis: cols.deliveredKwh == null ? null : cols.deliveredBasis,',
    to: '    delivered_basis: cols.deliveredBasis, /* MUTANT */',
    why: 'The column pair stops meaning "measured on this basis" exactly when a value is there.',
  },
  {
    id: 'xxvi. ★★★ the scorer never writes the value',
    file: NLS,
    find: '    delivered_kwh: cols.deliveredKwh,',
    to: '    delivered_kwh: null, /* MUTANT */',
    why: 'The learner has no samples, whatever the measurement said.',
  },
  /* ── (1) the learner: one basis ───────────────────────────────────────── */
  {
    id: 'xxvii. ★★★ the learner admits every basis',
    file: ADV,
    find: '  const onBasis = eligible.filter((r) => r.delivered_basis === DELIVERED_BASIS);',
    to: '  const onBasis = eligible; /* MUTANT */',
    why: 'The 09-30 0.26 ratio and its kind own the median again: a real upward correction stays hidden at the floor.',
  },
  {
    id: 'xxviii. ★★ set-aside counts ineligible rows',
    file: ADV,
    find: '  const setAside = eligible.length - onBasis.length;',
    to: '  const setAside = rows.length - onBasis.length; /* MUTANT */',
    why: 'The log overstates what the basis rule removed (advisory and shortfall nights counted as set aside).',
  },
  {
    id: 'xxix. ★ the UNMEASURED line ignores a change in the set-aside count',
    file: ADV,
    find: '    key: `unmeasured:${cal.samples}:${cal.setAside}`,',
    to: '    key: `unmeasured:${cal.samples}`, /* MUTANT */',
    why: 'A legacy row scored after the upgrade changes the count with no line saying so.',
  },
  {
    id: 'xxx. ★★ the UNMEASURED line does not name the set-aside rows',
    file: ADV,
    find: '      + `${cal.setAside} set aside for a pre-v1.187.3 delivered_kwh) — the announcement carries no `',
    to: '      + `) — the announcement carries no ` /* MUTANT */',
    why: 'After the upgrade the learner reads unmeasured with no reason given.',
  },
  /* ── (2) the plan reports the learner ─────────────────────────────────── */
  {
    id: 'xxxi. ★★★ the inputs drop the learner\'s basis and samples',
    file: ADV,
    find: '    // v1.187.3 — forwarded verbatim; see the destructure note above.\n    buyDebiasBasis,\n    buyDebiasSamples,\n',
    to: '    /* MUTANT */\n',
    why: 'Every plan reports default / 0 whatever the learner said: the surface the log points to is wrong.',
  },
  /* ── (1) the ledger column ────────────────────────────────────────────── */
  {
    id: 'xxxii. ★★★ the basis drops out of the ledger allowlist (SILENT)',
    file: REC,
    find: "  // v1.187.3 — the method behind delivered_kwh.\n  'delivered_basis',\n",
    to: '  /* MUTANT */\n',
    why: 'recordNightOutcome ignores unknown columns: the basis vanishes with no error and every new night reads as legacy.',
  },
  {
    id: 'xxxiii. ★★★ the basis column is never migrated',
    file: REC,
    find: "    'delivered_basis TEXT',\n",
    to: '    /* MUTANT */\n',
    why: 'The outcome write fails on an existing database: no night is captured.',
  },
  /* ── (3) the release workflow ─────────────────────────────────────────── */
  {
    id: 'xxxiv. ★★★ the release job is unbounded',
    file: IMG,
    find: '    timeout-minutes: 45\n',
    to: '    # MUTANT\n',
    why: 'A stall anywhere runs the job to the 6 h limit and cancels the Release (v1.187.1).',
  },
  {
    id: 'xxxv. ★★★ the best-effort pandoc step is unbounded',
    file: IMG,
    find: '        continue-on-error: true\n        timeout-minutes: 6\n',
    to: '        continue-on-error: true # MUTANT\n',
    why: 'continue-on-error covers a failure, not a hang: the job dies at its own bound before the Release.',
  },
  {
    id: 'xxxvi. ★★ a docs step\'s bound exceeds what the job can absorb',
    file: IMG,
    find: '        continue-on-error: true\n        timeout-minutes: 10\n',
    to: '        continue-on-error: true\n        timeout-minutes: 60 # MUTANT\n',
    why: 'LibreOffice running to its limit takes the job, and the Release, with it.',
  },
  {
    id: 'xxxvii. ★★★ apt runs unbounded in the release job',
    file: IMG,
    find: '        continue-on-error: true\n        timeout-minutes: 6\n        env:\n          APT_OPTS: -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20\n        run: |\n          command -v pandoc >/dev/null || {\n            sudo timeout -k 10 120 apt-get $APT_OPTS update &&',
    to: '        continue-on-error: true\n        timeout-minutes: 6\n        env:\n          APT_OPTS: -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20\n        run: |\n          command -v pandoc >/dev/null || {\n            sudo apt-get update && # MUTANT',
    why: 'The 17:46:07Z stall again, ended only by the step bound.',
  },
  {
    id: 'xxxviii. ★★ apt has no network timeouts in the release job',
    file: IMG,
    find: '        continue-on-error: true\n        timeout-minutes: 10\n        env:\n          APT_OPTS: -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20\n',
    to: "        continue-on-error: true\n        timeout-minutes: 10\n        env:\n          APT_OPTS: '' # MUTANT\n",
    why: 'A stalled connection is held until the outer timeout instead of retried.',
  },
  {
    id: 'xxxix. ★★ the pdf render is unbounded in the release job',
    file: IMG,
    find: '          timeout -k 10 240 libreoffice --headless -env:UserInstallation=file:///tmp/loprofile \\\n            --convert-to pdf --outdir . "EcoFlow-Panel-Documentation-v${V}.docx"',
    to: '          libreoffice --headless -env:UserInstallation=file:///tmp/loprofile \\\n            --convert-to pdf --outdir . "EcoFlow-Panel-Documentation-v${V}.docx" # MUTANT',
    why: 'A wedged headless LibreOffice holds the step to its bound on every release.',
  },
  {
    id: 'xl. ★★★ the Release step becomes best-effort',
    file: IMG,
    find: "        if: steps.gate.outputs.skip != 'true'\n        timeout-minutes: 10\n",
    to: "        if: steps.gate.outputs.skip != 'true'\n        continue-on-error: true # MUTANT\n        timeout-minutes: 10\n",
    why: 'A release with no GitHub Release reads green.',
  },
  {
    id: 'xli. ★★ the Release step is unbounded',
    file: IMG,
    find: "        if: steps.gate.outputs.skip != 'true'\n        timeout-minutes: 10\n",
    to: "        if: steps.gate.outputs.skip != 'true' # MUTANT\n",
    why: 'A stalled API call holds the job to its bound.',
  },
  /* ── (3, review) a bounded docs step must not seal a truncated asset ───── */
  {
    id: 'xlii. ★★★ the .docx is attached on its file alone',
    file: IMG,
    find: '          if [ "$DOCX_OUTCOME" = success ] && [ -s "$doc" ]; then assets+=("$doc"); fi',
    to: '          if [ -s "$doc" ]; then assets+=("$doc"); fi # MUTANT',
    why: 'A .docx build killed mid-write by its bound leaves a truncated file, and an immutable Release seals it forever.',
  },
  {
    id: 'xliii. ★★★ the .pdf is attached on its file alone',
    file: IMG,
    find: '          if [ "$PDF_OUTCOME" = success ] && [ -s "$pdf" ]; then assets+=("$pdf"); fi',
    to: '          if [ -s "$pdf" ]; then assets+=("$pdf"); fi # MUTANT',
    why: 'As xlii, for a LibreOffice conversion stalled after writing part of the PDF.',
  },
  {
    id: 'xliv. ★★ the Release reads the step conclusion, which continue-on-error turns green',
    file: IMG,
    find: '          DOCX_OUTCOME: ${{ steps.docx.outcome }}',
    to: '          DOCX_OUTCOME: ${{ steps.docx.conclusion }} # MUTANT',
    why: 'A failed best-effort step concludes success: the outcome check passes everything.',
  },
  {
    id: 'xlv. ★★ the PDF renders from a .docx whose build failed',
    file: IMG,
    find: "steps.gate.outputs.skip != 'true' && steps.docx.outcome == 'success' && hashFiles",
    to: "steps.gate.outputs.skip != 'true' && hashFiles /* MUTANT */",
    why: 'A truncated .docx renders a truncated PDF, attached on the PDF step\'s own success.',
  },
  {
    id: 'xlvi. ★ a missing PDF is a green step',
    file: IMG,
    find: '          test -s "EcoFlow-Panel-Documentation-v${V}.pdf"\n',
    to: '          # MUTANT\n',
    why: 'LibreOffice exits 0 without writing a PDF and the step reports success.',
  },
  {
    id: 'xlvii. ★★ the PR docs gate is unbounded',
    file: CI,
    find: '    timeout-minutes: 30\n',
    to: '    # MUTANT\n',
    why: 'A mirror stall holds a pull request\'s check for six hours.',
  },
  {
    id: 'xlviii. ★★ the PR docs build is unbounded',
    file: CI,
    find: '          timeout -k 10 240 python3 scripts/build-docs-docx.py \\\n            --ref',
    to: '          python3 scripts/build-docs-docx.py \\\n            --ref # MUTANT',
    why: 'A hung pandoc conversion holds the check to the step bound on every PR.',
  },
];

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (typeof e?.status === 'number' && e?.signal == null) return false;
    throw e;
  }
}
const subsetPasses = () => passes('node', ['--import', 'tsx', '--test', ...SUBSET]);
const fullPasses = () => passes('npm', ['test', '--silent']);

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const restoreAll = () => { for (const [f, s] of originals) writeFileSync(f, s); };

for (const [f, s] of originals) {
  if (s.includes('/* MUTANT') || s.includes('# MUTANT')) {
    console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`);
    process.exit(2);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); console.error(`\ninterrupted (${sig}) — tree restored`); process.exit(130); });
}
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    process.exit(2);
  }
}
if (!subsetPasses()) {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-v1187-3i: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !subsetPasses();
    if (!died) {
      if (!fullBaselineChecked) {
        writeFileSync(m.file, original);
        const ok = fullPasses();
        writeFileSync(m.file, mutated);
        fullBaselineChecked = true;
        if (!ok) {
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.');
          restoreAll();
          process.exit(2);
        }
      }
      died = !fullPasses();
    }
    writeFileSync(m.file, original);
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
