/**
 * v1.188.0 — the documentation layout is held by scripts/check-docs.mjs (rules D1–D11) and its
 * fence-aware scanner scripts/lib/markdownScan.mjs. This file:
 *
 *   - builds a complete, valid fixture tree (guide, add-on card, options and entity pages,
 *     reference manifest and chapters, a frozen history file, config.yaml, baselines), proves it
 *     passes, then breaks it once per rule and proves that rule fails; every fixture is a
 *     mkdtemp directory removed in `finally`;
 *   - pins the size limits at their byte boundaries (49,152 passes, 49,153 fails, and a guide of
 *     49,000 two-byte characters fails: size is counted in bytes);
 *   - pins the scanner to CommonMark (fences, setext, HTML blocks, code spans) and the slugger to
 *     the ids GitHub gives this repository's headings;
 *   - holds the WRITERS map to the writers in server/src/ecoflow/commands.ts, the name allowlist to
 *     server/src, and the entity table to the unique_ids the discovery publishers build;
 *   - runs `--check` on the repository and on a tree containing this file and the checker
 *     themselves (their banned-pattern literals are built by concatenation and must not match).
 *
 * STAGING. The repository reaches the checked layout across the v1.188.0 commits (split, guide,
 * consumers). The two whole-tree tests below enable themselves when ecoflow_panel/config.yaml
 * reaches 1.188.0, the release commit, so the release cannot ship with them skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { discoveryUniqueIds, SENSORS, BINARY_SENSORS } from '../src/mqttDiscovery.js';
import { ALARM_PRIORITY_ORDER } from '../src/alertPriority.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-docs.mjs');
const SCANNER = join(ROOT, 'scripts', 'lib', 'markdownScan.mjs');

type Violation = { rule: string; file: string; line: number; message: string };
interface Heading { line: number; level: number; raw: string; text: string; base: string; slug: string; setext: boolean }
interface Link { line: number; kind: string; image: boolean; dest: string }
interface Scan {
  headings: Heading[];
  links: Link[];
  html: { line: number; tag: string; close: boolean; comment: boolean; raw: string }[];
  codeSpans: { line: number; content: string }[];
  paragraphs: { line: number; text: string }[];
  fences: { open: number; close: number | null }[];
  unclosedFence: number | null;
  lineKinds: string[];
}
interface InventoryReport {
  ok: boolean;
  totals: Record<string, number>;
  rows: { status: string; path: string; missing?: { text: string }[] }[];
  added: { path: string }[];
}
interface CheckDocs {
  runChecks(root: string, opts?: { only?: string[] | null }): { violations: Violation[]; notes: string[]; checked: number };
  inventory(oldPath: string, newPaths: string[]): InventoryReport;
  parseAddonConfig(text: string): { options: Map<string, string>; schema: Map<string, string>; version: string | null };
  ratchetCounts(text: string): Record<string, number>;
  entityIds(scan: Scan): { id: string; line: number }[];
  WRITERS: Record<string, string[]>;
  WRITE_SECTION: string;
  PRIORITIES: string[];
  BASELINES: string;
  GUIDE_LIMIT_BYTES: number;
  GUIDE_FLOOR_BYTES: number;
}
interface MarkdownScan {
  scanMarkdown(src: string): Scan;
  githubSlug(text: string): string;
  createSlugger(): (text: string) => string;
}
const cd = (await import(pathToFileURL(SCRIPT).href)) as CheckDocs;
const ms = (await import(pathToFileURL(SCANNER).href)) as MarkdownScan;

/* ── fixture paths, built so this file names no Markdown path that is not in the tree ── */

const D = 'docs';
const MD = '.md';
const SECT = String.fromCharCode(0xa7);
const LQ = String.fromCharCode(0x201c);
const MONO = 'DO' + 'CS';
const GH = 'https://github.com/tesseractAZ/power';
const P = {
  guide: 'ecoflow_panel/DOCS' + MD,
  card: 'ecoflow_panel/README' + MD,
  options: `${D}/guide/options${MD}`,
  entities: `${D}/guide/entities${MD}`,
  index: `${D}/reference/README${MD}`,
  ref1: `${D}/reference/01-alpha${MD}`,
  ref21: `${D}/reference/02-1-beta-start${MD}`,
  ref22: `${D}/reference/02-2-beta-rest${MD}`,
  refA: `${D}/reference/A-inventory${MD}`,
  hist: `${D}/history/old-log${MD}`,
  readme: 'README' + MD,
  security: 'SECURITY' + MD,
  config: 'ecoflow_panel/config.yaml',
  changelog: 'ecoflow_panel/CHANGELOG' + MD,
  baselines: 'scripts/docs-baselines.json',
  code: 'server/src/sample.ts',
  template: '.github/PULL_REQUEST_TEMPLATE' + MD,
};

type Files = Record<string, string | Buffer | null>;
const sha = (c: string | Buffer) => createHash('sha256').update(c).digest('hex');
const lines = (...ls: string[]) => `${ls.join('\n')}\n`;

function guideText(): string {
  const rows = Object.entries(cd.WRITERS).flatMap(([fn, phrases]) => phrases.map((p) => `| ${p} | when \`${fn}\` runs | bounded |`));
  const filler = Array.from({ length: 90 }, (_, i) => `Filler paragraph ${i + 1} keeps the guide above its size floor without saying anything new.`);
  return lines(
    '# Power',
    '',
    'Power watches an EcoFlow home battery and warns before it runs out.',
    '',
    '> [!WARNING]',
    '> Power warns only while the host, the network and the speakers work. Set `HEARTBEAT_URL`.',
    '',
    `## ${cd.WRITE_SECTION}`,
    '',
    '| Writer | When it writes | Bound |',
    '|---|---|---|',
    ...rows,
    '',
    '## Names',
    '',
    'Options `LOG_LEVEL` and `NOTIFY_*`; the state `LEARNING`; entities `ecoflow_circuit_3_watts`, `ecoflow_alerts_critical`',
    'and `ecoflow_fleet_pv_watts`; the add-on `ecoflow_panel` and its topic `ecoflow_panel/state`.',
    '',
    `See the [options](${GH}/blob/main/${P.options}), the [reference](${GH}/tree/main/${D}/reference),`,
    `[chapter one](${GH}/blob/main/${P.ref1}#1-alpha), the [releases](${GH}/releases), [issues](${GH}/issues/new)`,
    'and [mail](mailto:security@example.com).',
    '',
    '<!-- maintained by hand -->',
    '<details><summary>More</summary>',
    '',
    'First line<br>second line.',
    '',
    '</details>',
    '',
    '## Filler',
    '',
    ...filler.flatMap((f) => [f, '']),
  );
}

function baseFiles(): Files {
  return {
    [P.config]: lines(
      'name: Power',
      'version: "9.9.9"',
      '# Options are documented in the options page.',
      'options:',
      '  LOG_LEVEL: info',
      '  NOTIFY_CHANNEL: none',
      '  NOTIFY_QUIET_HOURS: "22-06"',
      '  HEARTBEAT_URL: ""',
      '  HEARTBEAT_INTERVAL_S: 300',
      '  LOAD_SHEDDING_RUNWAY_THRESHOLD_H: 4.0',
      'schema:',
      '  LOG_LEVEL: list(trace|debug|info)',
      '  NOTIFY_CHANNEL: list(none|ha)',
      '  NOTIFY_QUIET_HOURS: "str?"',
      '  HEARTBEAT_URL: "str?"',
      '  HEARTBEAT_INTERVAL_S: "int(60,3600)?"',
      '  LOAD_SHEDDING_RUNWAY_THRESHOLD_H: float(0,168)',
    ),
    [P.guide]: guideText(),
    [P.card]: lines('# Power', '', `Monitors an EcoFlow home battery. The [operator guide](${GH}/blob/main/${P.guide}) is the Documentation tab.`),
    [P.options]: lines(
      '# Options',
      '',
      '| Option / Env | Default | Schema | Purpose |',
      '|---|---|---|---|',
      '| `LOG_LEVEL` | `info` | `list(trace\\|debug\\|info)` | Log level. |',
      '| `NOTIFY_CHANNEL` | `none` | `list(none\\|ha)` | Push channel. |',
      '| `NOTIFY_QUIET_HOURS` | `"22-06"` | `str?` | Quiet window. |',
      '| `HEARTBEAT_URL` | empty | `str?` | Dead-man receiver. |',
      '| `HEARTBEAT_INTERVAL_S` | `300` | `int(60,3600)?` (seconds) | Ping period. |',
      '| `LOAD_SHEDDING_RUNWAY_THRESHOLD_H` | `4` | `float(0,168)` | Runway threshold. |',
    ),
    [P.entities]: lines(
      '# Entities',
      '',
      '| entity_id | unique_id | Meaning | Unit |',
      '|---|---|---|---|',
      '| `sensor.power_fleet_pv` | `ecoflow_fleet_pv_watts` | Solar power | W |',
      '| `sensor.power_circuit_<ch>_watts` | `ecoflow_circuit_<ch>_watts` | One circuit | W |',
      '| `switch.power_alarms_<p>` | `ecoflow_alerts_<p>` | One priority | on/off |',
    ),
    [P.index]: lines(
      '# Engineering reference',
      '',
      'Section numbers are chapter-local.',
      '',
      '<!-- chapters:start -->',
      '1. [Alpha](01-alpha.md)',
      '2. [Beta, part 1](02-1-beta-start.md)',
      '3. [Beta, part 2](02-2-beta-rest.md)',
      '4. [Appendix A](A-inventory.md)',
      '<!-- chapters:end -->',
      '',
      '## Moved sections',
      '',
      '| Old anchor | New place |',
      '|---|---|',
      '| `1-alpha` | [Alpha](01-alpha.md#1-alpha) |',
    ),
    [P.ref1]: lines(
      '## 1. Alpha',
      '',
      `Alpha cites \`analytics.ts:120\` and ${SECT}2.`,
      '',
      '**v1.100.0 — a release note.** Body.',
      '',
      '### 1.1 Detail',
      '',
      'Tab\there. See [beta](02-1-beta-start.md#2-beta), [detail](#11-detail) and [the index](README.md).',
      '',
      '```sh',
      '# a comment, not a heading',
      '## nor this',
      '```',
      '',
      '~~~',
      '## not a heading either',
      '~~~',
      '',
      '  ````md',
      '  # an indented fence is still code',
      '  ```',
      '  ````',
      '',
      '    # indented code, not a heading',
    ),
    [P.ref21]: lines('## 2. Beta', '', '- **v1.101.0 — a list-item release note.** Body.', '', `See ${SECT}1.`),
    [P.ref22]: lines('### 3. More beta', '', 'Cites `index.ts:4065`.'),
    [P.refA]: lines('## Appendix A — Inventory', '', `Covers ${SECT}1.`),
    [P.hist]: lines(
      '> [!NOTE]',
      '> Historical: moved unedited from the single-file manual, and may be superseded by the reference.',
      '',
      `**v1.50.0 — old note.** It cites ${MONO}.md ${SECT}6 and [a dead link](nowhere.md); history is frozen.`,
    ),
    [P.readme]: lines(
      '# Fixture',
      '',
      `Read the [reference index](${P.index}) and [chapter one](${P.ref1}#1-alpha).`,
      '',
      `![A screenshot](${D}/shot.png)`,
    ),
    [`${D}/shot.png`]: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    [P.security]: lines('# Security', '', 'Report privately.'),
    [P.changelog]: lines('## 1.188.0', '', `- Notes for 2026-10-14 citing ${MONO} ${SECT}9, v1.187.22 and [a page since removed](../gone${MD}).`),
    [P.code]: lines(`// The option table is ${D}/guide/options${MD}.`, 'export const sample = 1;'),
    [P.template]: lines('## Checklist', '', '- [ ] `node scripts/check-docs.mjs --check` passes', '<!-- notes -->'),
  };
}

interface Baselines {
  reference: { chapters: number; appendices: string[] };
  ratchet: Record<string, number | null>;
  history: Record<string, string | null>;
  nameAllowlist: string[];
}

function baselinesFor(files: Files): Baselines {
  const history: Record<string, string | null> = {};
  for (const [rel, c] of Object.entries(files)) {
    if (c !== null && rel.startsWith(`${D}/history/`) && rel.endsWith(MD)) history[rel] = sha(c);
  }
  return {
    reference: { chapters: 2, appendices: ['A'] },
    ratchet: { releaseParagraphs: 2, fileLineCitations: 2, sectionSigns: 3 },
    history,
    nameAllowlist: ['LEARNING'],
  };
}

function withFixture<T>(mutate: ((f: Files) => void) | undefined, editBaselines: ((b: Baselines) => void) | undefined, fn: (dir: string) => T): T {
  const files = baseFiles();
  mutate?.(files);
  if (!(P.baselines in files)) {
    const b = baselinesFor(files);
    editBaselines?.(b);
    files[P.baselines] = JSON.stringify(b, null, 2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'check-docs-'));
  try {
    for (const [rel, c] of Object.entries(files)) {
      if (c === null) continue;
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runFixture = (mutate?: (f: Files) => void, editBaselines?: (b: Baselines) => void) =>
  withFixture(mutate, editBaselines, (dir) => cd.runChecks(dir).violations);

const show = (vs: Violation[]) => vs.map((v) => `${v.rule} ${v.file}:${v.line} ${v.message}`).join('\n');

function expectPass(mutate?: (f: Files) => void, editBaselines?: (b: Baselines) => void) {
  const vs = runFixture(mutate, editBaselines);
  assert.deepEqual(vs, [], show(vs));
}

function expectFail(rule: string, mutate: (f: Files) => void, match?: RegExp, editBaselines?: (b: Baselines) => void) {
  const vs = runFixture(mutate, editBaselines);
  assert.ok(
    vs.some((v) => v.rule === rule && (!match || match.test(`${v.file}:${v.line} ${v.message}`))),
    `expected a ${rule} violation${match ? ` matching ${match}` : ''}; got:\n${show(vs) || '(none)'}`,
  );
}

const text = (f: Files, rel: string) => String(f[rel]);
const append = (f: Files, rel: string, add: string) => { f[rel] = text(f, rel) + add; };
const replace = (f: Files, rel: string, from: string, to: string) => {
  const t = text(f, rel);
  assert.ok(t.includes(from), `fixture ${rel} lacks ${JSON.stringify(from)}`);
  f[rel] = t.replace(from, to);
};

/** `text` padded with one paragraph of `ch` to exactly `bytes` UTF-8 bytes. */
function padTo(t: string, bytes: number): string {
  const need = bytes - Buffer.byteLength(t) - 2;
  assert.ok(need >= 0, `fixture text is already ${Buffer.byteLength(t)} bytes, over ${bytes}`);
  const out = `${t}\n${'x'.repeat(need)}\n`;
  assert.equal(Buffer.byteLength(out), bytes);
  return out;
}

/* ── the fixture passes ─────────────────────────────────────────────────── */

test('the fixture tree passes every rule (the CHANGELOG and frozen history are outside the content rules)', () => {
  expectPass();
});

test('a tree holding this test file and the checker itself passes: their banned-pattern literals are built by concatenation', () => {
  expectPass((f) => {
    f['server/test/docsLayout.test.ts'] = readFileSync(join(ROOT, 'server', 'test', 'docsLayout.test.ts'));
    f['scripts/check-docs.mjs'] = readFileSync(SCRIPT);
    f['scripts/lib/markdownScan.mjs'] = readFileSync(SCANNER);
    f['scripts/roll-changelog.mjs'] = readFileSync(join(ROOT, 'scripts', 'roll-changelog.mjs'));
  });
});

test('the CLI exits 0 on a clean tree and 1, naming the rule, on a violation', () => {
  withFixture(undefined, undefined, (dir) => {
    const ok = spawnSync(process.execPath, [SCRIPT, '--check', '--root', dir], { encoding: 'utf8' });
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /no violations/);
  });
  withFixture((f) => append(f, P.guide, '\nSee [here](#names).\n'), undefined, (dir) => {
    const bad = spawnSync(process.execPath, [SCRIPT, '--check', '--root', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1, `${bad.stdout}${bad.stderr}`);
    assert.match(bad.stderr, /^D3 ecoflow_panel\/DOCS\.md:\d+: in-page link/m);
  });
});

/* ── D1 sizes ───────────────────────────────────────────────────────────── */

test('D1: the guide passes at 49,152 bytes and fails at 49,153', () => {
  assert.equal(cd.GUIDE_LIMIT_BYTES, 49_152);
  expectPass((f) => { f[P.guide] = padTo(guideText(), 49_152); });
  expectFail('D1', (f) => { f[P.guide] = padTo(guideText(), 49_153); }, /DOCS\.md:0 49153 bytes, over the 49152-byte limit/);
});

test('D1: a guide of 49,000 two-byte characters fails (size is UTF-8 bytes, not characters)', () => {
  const head = guideText();
  const k = 49_000 - head.length - 1;
  const t = `${head}${'é'.repeat(k)}\n`;
  assert.equal(t.length, 49_000);
  assert.ok(Buffer.byteLength(t) > 49_152);
  expectFail('D1', (f) => { f[P.guide] = t; }, /over the 49152-byte limit/);
});

test('D1: the guide floor — 8,192 bytes passes, 8,191 fails', () => {
  assert.equal(cd.GUIDE_FLOOR_BYTES, 8_192);
  const small = guideText().split('## Filler')[0];
  expectPass((f) => { f[P.guide] = padTo(small, 8_192); });
  expectFail('D1', (f) => { f[P.guide] = padTo(small, 8_191); }, /under the 8192-byte floor/);
});

test('D1: each other budget holds at its boundary', () => {
  const cases: [string, number][] = [
    [P.card, 4_096],
    [P.options, 65_536],
    [P.entities, 65_536],
    [P.index, 16_384],
    [P.ref1, 131_072],
    [P.hist, 131_072],
    [P.security, 131_072],
    [P.readme, 131_072],
    [P.template, 131_072],
  ];
  for (const [rel, limit] of cases) {
    expectPass((f) => { f[rel] = padTo(text(f, rel), limit); });
    expectFail('D1', (f) => { f[rel] = padTo(text(f, rel), limit + 1); }, new RegExp(`over the ${limit}-byte limit`));
  }
});

test('D1: a required page that is missing fails', () => {
  for (const rel of [P.guide, P.card, P.options, P.entities, P.index]) {
    expectFail('D1', (f) => { f[rel] = null; }, /required file is missing/);
  }
});

/* ── D2 bytes ───────────────────────────────────────────────────────────── */

test('D2: NUL, CR, other C0 controls, DEL and invalid UTF-8 fail; a tab passes', () => {
  for (const [rel, ch] of [[P.guide, '\x00'], [P.ref1, '\r'], [P.readme, '\x7f'], [P.hist, '\x0b'], [P.template, '\x1f']] as const) {
    expectFail('D2', (f) => append(f, rel, `bad ${ch} byte\n`), /control byte 0x/);
  }
  expectFail('D2', (f) => { f[P.security] = Buffer.concat([Buffer.from('# Security\n\n'), Buffer.from([0xff, 0x0a])]); }, /not valid UTF-8/);
});

/* ── D3 Home Assistant surfaces ─────────────────────────────────────────── */

test('D3: links on the HA surfaces are absolute, https, and main-only for this repository', () => {
  const bad: [string, RegExp][] = [
    ['[x](#names)', /in-page link/],
    [`[x](${D}/guide/options${MD})`, /relative link/],
    ['[x](options.md)', /relative link/],
    ['[x](http://example.com/a)', /http: link/],
    ['http://homeassistant.local:8787', /http: link/],
    [`[x](${GH}/blob/dev/README.md)`, /repository link/],
    [`[x](${GH}/blob/v1/README.md)`, /repository link/],
    [`[x](${GH})`, /repository link/],
    [`[x](${GH}/pulls)`, /repository link/],
    [`[x](${GH}/blob/main/README.md?plain=1)`, /repository link/],
    [`[x](https://raw.githubusercontent.com/tesseractAZ/power/main/README.md)`, /repository link/],
  ];
  for (const [link, why] of bad) {
    expectFail('D3', (f) => append(f, P.guide, `\nA link: ${link}\n`), why);
    expectFail('D3', (f) => append(f, P.card, `\nA link: ${link}\n`), why);
  }
});

test('D3: images, <a> and raw HTML other than comments, details, summary and br fail', () => {
  const bad: [string, RegExp][] = [
    ['![x](https://example.com/a.png)', /image/],
    [`[![x](https://example.com/a.png)](${GH}/releases)`, /image/],
    ['<img src="https://example.com/a.png">', /raw HTML/],
    ['<a href="https://example.com">x</a>', /no <a> shims/],
    ['<a id="names"></a>', /no <a> shims/],
    ['<div>block</div>', /raw HTML/],
    ['Waits <age> seconds.', /raw HTML <age>/],
    ['<span>x</span>', /raw HTML/],
  ];
  for (const [html, why] of bad) expectFail('D3', (f) => append(f, P.guide, `\n${html}\n`), why);
  expectPass((f) => append(f, P.guide, '\nWaits `<age>` seconds; `<a href>` in code is text.\n\n```html\n<div><a href="x">y</a></div>\n```\n'));
});

test('D3: exactly one h1, no section sign, no add-on version or ISO date (the version and date bans cover docs/guide too)', () => {
  expectFail('D3', (f) => append(f, P.guide, '\n# A second title\n'), /2 level-1 headings/);
  expectFail('D3', (f) => append(f, P.guide, '\nSecond title\n============\n'), /2 level-1 headings/);
  expectFail('D3', (f) => { f[P.card] = text(f, P.card).replace('# Power\n', ''); }, /0 level-1 headings/);
  expectFail('D3', (f) => append(f, P.guide, `\nSee ${SECT}8.\n`), /section sign/);
  for (const rel of [P.guide, P.card, P.options, P.entities]) {
    expectFail('D3', (f) => append(f, rel, '\nNew in 1.188.0.\n'), /version 1\.188\.0/);
    expectFail('D3', (f) => append(f, rel, '\nSince v1.187.22.\n'), /version v1\.187\.22/);
    expectFail('D3', (f) => append(f, rel, '\nMeasured 2026-10-14.\n'), /date 2026-10-14/);
  }
  expectPass((f) => append(f, P.guide, '\nA dotted 10.1.2.3, 1.2.3.4 or 1.5 is not a version; MQTT v5 is not one either.\n'));
});

/* ── D4 names ───────────────────────────────────────────────────────────── */

test('D4: a backticked option name, PREFIX_* or allowlisted name passes; anything else fails', () => {
  for (const rel of [P.guide, P.card, P.options, P.entities]) {
    expectFail('D4', (f) => append(f, rel, '\nSet `NOT_AN_OPTION`.\n'), /`NOT_AN_OPTION` is not an option key/);
    expectFail('D4', (f) => append(f, rel, '\nSet `NOPE_*`.\n'), /`NOPE_\*` is not an option key pattern/);
  }
  expectFail('D4', (f) => append(f, P.guide, '\nThe `BLOCKED` state.\n'), /`BLOCKED`/);
  expectPass((f) => append(f, P.guide, '\nThe `BLOCKED` state.\n'), (b) => { b.nameAllowlist.push('BLOCKED'); });
  expectPass((f) => append(f, P.guide, '\nSet `HEARTBEAT_*` or `*_URL`; `_MINUTE` and `HH-HH` are not names.\n'));
});

test('D4: a backticked ecoflow_ id must be a unique_id in the entity page (patterns <ch> and <p>)', () => {
  expectFail('D4', (f) => append(f, P.guide, '\nSee `ecoflow_not_published`.\n'), /`ecoflow_not_published` is not a unique_id/);
  expectFail('D4', (f) => append(f, P.guide, '\nSee `ecoflow_alerts_urgent`.\n'), /`ecoflow_alerts_urgent`/);
  expectFail('D4', (f) => append(f, P.guide, '\nSee `ecoflow_circuit_x_watts`.\n'), /`ecoflow_circuit_x_watts`/);
  expectFail('D4', (f) => append(f, P.entities, '| `sensor.power_dup` | `ecoflow_fleet_pv_watts` | Again | W |\n'), /has two rows/);
  expectFail('D4', (f) => { f[P.entities] = null; }, /missing — every backticked ecoflow_/);
  expectFail('D4', (f) => append(f, P.guide, '\nWhen `ecoflow_fleet_pv_watt > 0`.\n'), /`ecoflow_fleet_pv_watt` is not a unique_id/);
  expectFail('D4', (f) => append(f, P.guide, '\nThe old `ecoflow_panel_ecoflow_fleet_pv_watts`.\n'), /`ecoflow_panel_ecoflow_fleet_pv_watts`/);
  expectPass((f) => append(f, P.guide, '\n`ecoflow_circuit_12_watts`, `ecoflow_alerts_low`, `ecoflow_circuit_<ch>_watts`, `ecoflow_fleet_pv_watts > 0`, `ecoflow_panel:8787` and `ecoflow_panel/alerts/critical/set`.\n'));
});

/* ── D5 link targets and fragments ──────────────────────────────────────── */

test('D5: relative and blob/main targets must exist', () => {
  expectFail('D5', (f) => append(f, P.ref1, '\nSee [nine](09-missing.md).\n'), /09-missing\.md.*does not exist/);
  expectFail('D5', (f) => append(f, P.readme, `\nSee [x](${D}/nowhere${MD}).\n`), /does not exist/);
  expectFail('D5', (f) => append(f, P.guide, `\nSee [x](${GH}/blob/main/${D}/nowhere${MD}).\n`), /does not exist on this tree/);
  expectFail('D5', (f) => append(f, P.guide, `\nSee [x](${GH}/tree/main/${D}/nowhere).\n`), /does not exist on this tree/);
  expectFail('D5', (f) => append(f, P.ref1, '\nSee [up](../../../outside.md).\n'), /leaves the repository/);
  expectPass((f) => append(f, P.ref1, `\nSee [code](../../server/src/sample.ts), [root](/SECURITY.md) and [tree](${GH}/tree/main/server/src).\n`));
});

test('D5: a fragment must be the unsuffixed slug of exactly one heading in its target; no #L line anchors', () => {
  expectFail('D5', (f) => append(f, P.ref1, '\nSee [x](#no-such-heading).\n'), /#no-such-heading matches no heading/);
  expectFail('D5', (f) => append(f, P.readme, `\nSee [x](${P.ref1}#no-such-heading).\n`), /matches no heading/);
  expectFail('D5', (f) => append(f, P.guide, `\nSee [x](${GH}/blob/main/${P.ref1}#no-such-heading).\n`), /matches no heading/);
  expectFail('D5', (f) => { append(f, P.ref22, '\n### Same\n\n### Same\n\nSee [x](#same).\n'); }, /#same is shared by several headings/);
  expectFail('D5', (f) => { append(f, P.ref22, '\n### Same\n\n### Same\n\nSee [x](#same-1).\n'); }, /#same-1 is a -N duplicate suffix/);
  expectFail('D5', (f) => { append(f, P.ref22, '\n### Same\n\n### Same\n\n### Same 1\n\nSee [x](#same-1).\n'); }, /#same-1/);
  expectFail('D5', (f) => append(f, P.guide, `\nSee [x](${GH}/blob/main/server/src/sample.ts#L2).\n`), /line anchors/);
  expectFail('D5', (f) => append(f, P.ref1, '\nSee [x](../../server/src/sample.ts#sample).\n'), /needs a Markdown file target/);
  expectFail('D5', (f) => append(f, P.guide, `\nSee [x](${GH}/blob/main/${P.ref1}#%E0%A4%A).\n`), /bad escape/);
  expectFail('D5', (f) => append(f, P.ref1, '\nSee [x](02-1-beta-start.md#%E0%A4%A).\n'), /bad escape/);
  expectPass((f) => append(f, P.ref22, `\n### Same\n\n### Same again\n\nSee [x](#same), [y](#same-again), [z](01-alpha.md#11-detail) and [w](${GH}/blob/main/${P.ref21}#2-beta).\n`));
});

/* ── D6 manifest and structure ──────────────────────────────────────────── */

test('D6: every reference file is listed once, in order, and every listed file exists', () => {
  expectFail('D6', (f) => { f[`${D}/reference/03-gamma${MD}`] = '## 3. Gamma\n'; }, /03-gamma\.md:0 not listed in the manifest/, (b) => { b.reference.chapters = 3; });
  expectFail('D6', (f) => replace(f, P.index, '4. [Appendix A](A-inventory.md)', '4. [Appendix A](A-inventory.md)\n5. [Gone](05-gone.md)'), /05-gone\.md is listed but missing/);
  expectFail('D6', (f) => replace(f, P.index, '2. [Beta, part 1](02-1-beta-start.md)\n3. [Beta, part 2](02-2-beta-rest.md)', '2. [Beta, part 2](02-2-beta-rest.md)\n3. [Beta, part 1](02-1-beta-start.md)'), /listed after/);
  expectFail('D6', (f) => replace(f, P.index, '1. [Alpha](01-alpha.md)', '1. [Alpha](01-alpha.md)\n1. [Alpha again](01-alpha.md)'), /listed twice/);
  expectFail('D6', (f) => replace(f, P.index, '<!-- chapters:end -->', ''), /no <!-- chapters:start -->/);
});

test('D6: chapters open with ## N. / ## Appendix X, later parts with ###, and the chapter set is complete', () => {
  expectFail('D6', (f) => replace(f, P.ref1, '## 1. Alpha', '## 7. Alpha'), /must open with "## 1\./);
  expectFail('D6', (f) => replace(f, P.ref22, '### 3. More beta', '## 3. More beta'), /must open with a ### heading/);
  expectFail('D6', (f) => replace(f, P.refA, '## Appendix A', '## Appendix B'), /must open with "## Appendix A/);
  expectFail('D6', (f) => append(f, P.ref1, '\n## 2. A second chapter in one file\n'), /one chapter per file/);
  expectFail('D6', (f) => {
    f[P.ref21] = null;
    f[P.ref22] = null;
    replace(f, P.index, '2. [Beta, part 1](02-1-beta-start.md)\n3. [Beta, part 2](02-2-beta-rest.md)\n', '');
    replace(f, P.ref1, 'See [beta](02-1-beta-start.md#2-beta), ', 'See ');
    append(f, P.ref1, `\n**v1.101.0 — moved.** Body. ${SECT}1 and \`index.ts:4065\`.\n`);
  }, /chapters 1 — expected 1–2/);
  expectFail('D6', (f) => {
    f[P.refA] = null;
    replace(f, P.index, '4. [Appendix A](A-inventory.md)\n', '');
    append(f, P.ref22, `\n${SECT}1\n`);
  }, /appendices none — expected A/);
  expectFail('D6', (f) => { f[P.ref22] = null; replace(f, P.index, '3. [Beta, part 2](02-2-beta-rest.md)\n', ''); f[`${D}/reference/02-3-beta-end${MD}`] = '### 4. End\n\nCites `index.ts:4065`.\n'; replace(f, P.index, '4. [Appendix A]', '3. [Beta, part 3](02-3-beta-end.md)\n4. [Appendix A]'); }, /part 3 of chapter 2 does not follow part 2/);
});

test('D6: an unclosed code fence fails, wherever it is', () => {
  expectFail('D6', (f) => append(f, P.ref22, '\n```js\nconst open = true;\n'), /02-2-beta-rest\.md:\d+ code fence opened here is never closed/);
  expectFail('D6', (f) => append(f, P.guide, '\n~~~~\nnever closed\n~~~\n'), /never closed/);
});

/* ── D7 options page ────────────────────────────────────────────────────── */

test('D7: one row per option key, and its default and schema equal config.yaml', () => {
  expectFail('D7', (f) => replace(f, P.options, '| `HEARTBEAT_URL` | empty | `str?` | Dead-man receiver. |\n', ''), /HEARTBEAT_URL has no row/);
  expectFail('D7', (f) => append(f, P.options, '| `LOG_LEVEL` | `info` | `list(trace\\|debug\\|info)` | Again. |\n'), /LOG_LEVEL has a second row/);
  expectFail('D7', (f) => replace(f, P.options, '| `HEARTBEAT_INTERVAL_S` | `300` |', '| `HEARTBEAT_INTERVAL_S` | `301` |'), /HEARTBEAT_INTERVAL_S default "301" ≠ config\.yaml "300"/);
  expectFail('D7', (f) => replace(f, P.options, '`list(none\\|ha)`', '`list(none\\|ha\\|sms)`'), /NOTIFY_CHANNEL schema "list\(none\|ha\|sms\)" ≠ config\.yaml "list\(none\|ha\)"/);
  expectFail('D7', (f) => append(f, P.options, '| `NOT_A_KEY` | `1` | `int` | Unknown. |\n'), /NOT_A_KEY is not an option/);
  expectFail('D7', (f) => replace(f, P.options, '| `HEARTBEAT_URL` |', '| `HEARTBEAT_URL` / `HEARTBEAT_INTERVAL_S` |'), /is not one backticked option key/);
  expectFail('D7', (f) => { f[P.options] = null; }, /docs\/guide\/options\.md:0 missing/);
  expectFail('D7', (f) => replace(f, P.config, '  LOG_LEVEL: list(trace|debug|info)\n', ''), /LOG_LEVEL has a default but no schema/);
});

/* ── D8 ratchets and release headings ───────────────────────────────────── */

test('D8: the reference ratchets equal their baselines; a fall names the new number', () => {
  expectFail('D8', (f) => append(f, P.ref22, '\n**v1.102.0 — a new release note.** Body.\n'), /releaseParagraphs rose to 3 \(baseline 2\)/);
  expectFail('D8', (f) => append(f, P.ref22, '\n- **v1.102.0 — a release note as a list item.** Body.\n'), /releaseParagraphs rose to 3/);
  expectFail('D8', (f) => append(f, P.ref22, '\nSee `recorder.ts:671`.\n'), /fileLineCitations rose to 3/);
  expectFail('D8', (f) => append(f, P.ref22, `\nSee ${SECT}4.\n`), /sectionSigns rose to 4/);
  expectFail('D8', (f) => replace(f, P.refA, `Covers ${SECT}1.`, 'Covers chapter 1.'), /sectionSigns fell to 2 \(baseline 3\): lower ratchet\.sectionSigns .* to 2/);
  expectFail('D8', (f) => replace(f, P.ref21, '- **v1.101.0 — a list-item release note.** Body.', '- A plain note.'), /releaseParagraphs fell to 1/);
  expectFail('D8', () => {}, /ratchet\.fileLineCitations is not set; the reference measures 2/, (b) => { b.ratchet.fileLineCitations = null; });
  expectPass((f) => append(f, P.guide, '\nNo `**v1.x` paragraphs here; `v1` alone is not a version.\n'));
});

test('D8: no release-log or changelog heading outside the CHANGELOG', () => {
  expectFail('D8', (f) => append(f, P.ref22, '\n#### 3.1 Release log\n'), /heading "3\.1 Release log"/);
  expectFail('D8', (f) => append(f, P.ref22, '\n#### Release notes (all subsystems)\n'), /Release notes/);
  expectFail('D8', (f) => append(f, P.guide, '\n## Changelog\n'), /heading "Changelog"/);
  expectFail('D8', (f) => append(f, P.options, '\n## Changelog\n'), /heading "Changelog"/);
  expectPass((f) => append(f, P.ref22, '\n#### 3.1 Engineering history (moved)\n'));
});

/* ── D9 frozen history ──────────────────────────────────────────────────── */

test('D9: history holds exactly the pinned files, byte-identical, each with its banner', () => {
  expectFail('D9', (f) => append(f, P.hist, 'An edit.\n'), /changed: sha256 [0-9a-f]{64}, pinned/, (b) => { b.history[P.hist] = sha(baseFiles()[P.hist] as string); });
  expectFail('D9', (f) => { f[`${D}/history/extra${MD}`] = '> [!NOTE]\n> Historical; may be superseded.\n'; }, /extra\.md:0 not pinned/, (b) => { delete b.history[`${D}/history/extra${MD}`]; });
  expectFail('D9', (f) => { f[P.hist] = null; }, /pinned history file is missing/, (b) => { b.history[P.hist] = 'a'.repeat(64); });
  expectFail('D9', () => {}, /sha256 is not pinned \(it is [0-9a-f]{64}\)/, (b) => { b.history[P.hist] = null; });
  expectFail('D9', (f) => replace(f, P.hist, '> [!NOTE]\n', '> [!TIP]\n'), /must open with a "> \[!NOTE\]" banner/);
  expectFail('D9', (f) => replace(f, P.hist, 'may be superseded', 'is current'), /must open with a "> \[!NOTE\]" banner/);
  expectFail('D9', (f) => { f[`${D}/history/data.json`] = '{}'; }, /docs\/history holds only pinned Markdown/);
});

/* ── D10 pointers into the old monolith ─────────────────────────────────── */

test('D10: a section-sign or quoted-heading pointer into the old manual fails in code, config, .github and Markdown', () => {
  const pointers = [
    `${MONO}.md ${SECT}8b`,
    `${MONO} ${SECT}6`,
    `${MONO}${SECT}9`,
    `${MONO}.md ${LQ}Options${String.fromCharCode(0x201d)}`,
    `${MONO} "Grid presence"`,
  ];
  const sites: [string, (p: string) => string][] = [
    [P.code, (p) => `// see ${p}\nexport const x = 1;\n`],
    ['server/test/x.test.ts', (p) => `// see ${p}\n`],
    [P.config, (p) => `${text(baseFiles(), P.config)}# see ${p}\n`],
    ['.github/workflows/ci.yml', (p) => `# see ${p}\non: push\n`],
    ['rootfs/usr/bin/run', (p) => `#!/bin/sh\n# see ${p}\n`],
    [`${D}/PERF${MD}`, (p) => `# Perf\n\nSee ${p}.\n`],
  ];
  for (const p of pointers) {
    for (const [rel, body] of sites) expectFail('D10', (f) => { f[rel] = body(p); }, /points into the old single-file manual/);
  }
  expectPass((f) => { f[P.code] = `const docs = "${MONO}.md";\nexport const y = readFile(docs);\n`; });
});

test('D10: every docs/…/*.md mention must exist', () => {
  expectFail('D10', (f) => { f[P.code] = `// see ${D}/guide/missing${MD}\n`; }, /docs\/guide\/missing\.md does not exist/);
  expectFail('D10', (f) => append(f, P.readme, `\nThe ${D}/history/gone${MD} file.\n`), /docs\/history\/gone\.md does not exist/);
  expectFail('D10', (f) => { f['scripts/x.mjs'] = `// ${GH}/blob/main/${D}/gone${MD}\n`; }, /docs\/gone\.md does not exist/);
  expectPass((f) => { f[P.code] = `// ${D}/guide/options${MD}, ${D}/reference/ (a directory), https://example.com/${D}/x${MD} (another host)\n`; });
});

/* ── D11 the write list ─────────────────────────────────────────────────── */

test('D11: the write section names every WRITERS phrase', () => {
  // every phrase of every writer, not just the first: a writer with two families of call sites
  // (the reserve setpoint and the reserve floor) must keep both rows
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [fn, phrases] of Object.entries(cd.WRITERS)) {
    for (const p of phrases) expectFail('D11', (f) => replace(f, P.guide, `| ${p} |`, '| Something |'), new RegExp(`does not name "${esc(p)}" \\(${fn}`));
  }
  expectFail('D11', (f) => replace(f, P.guide, `## ${cd.WRITE_SECTION}`, '## What Power writes'), /no "## What Power changes on your system" section/);
  const last = Object.values(cd.WRITERS).flat().at(-1)!;
  expectFail('D11', (f) => { replace(f, P.guide, `| ${last} |`, '| Something |'); append(f, P.guide, `\n${last} is mentioned elsewhere.\n`); }, new RegExp(`does not name "${last}"`));
});

test('WRITERS names exactly the writers exported from server/src/ecoflow/commands.ts', () => {
  const src = readFileSync(join(ROOT, 'server', 'src', 'ecoflow', 'commands.ts'), 'utf8');
  const exported = [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]).sort();
  assert.ok(exported.length >= 5, `found ${exported.length} writers`);
  assert.deepEqual(Object.keys(cd.WRITERS).sort(), exported);
  for (const [fn, phrases] of Object.entries(cd.WRITERS)) assert.ok(phrases.length > 0 && phrases.every((p) => p.trim() !== ''), fn);
});

test('every nameAllowlist entry is a string literal in server/src', () => {
  const b = JSON.parse(readFileSync(join(ROOT, cd.BASELINES), 'utf8')) as Baselines;
  assert.ok(b.nameAllowlist.length >= 3);
  for (const s of ['LEARNING', 'READY_TO_CONSIDER_WRITES', 'BLOCKED']) assert.ok(b.nameAllowlist.includes(s), s);
  const corpus: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile() && /\.(ts|mjs)$/.test(e.name)) corpus.push(readFileSync(join(dir, e.name), 'utf8'));
    }
  };
  walk(join(ROOT, 'server', 'src'));
  const all = corpus.join('\n');
  for (const name of b.nameAllowlist) {
    assert.ok(all.includes(`'${name}'`) || all.includes(`"${name}"`) || all.includes(`\`${name}\``), `${name} is not a string literal in server/src`);
  }
});

/* ── entities: the discovery publishers ─────────────────────────────────── */

test('the <p> placeholder is the alarm-priority order, and discoveryUniqueIds covers every publisher', () => {
  assert.deepEqual(cd.PRIORITIES, [...ALARM_PRIORITY_ORDER]);
  const ids = discoveryUniqueIds([{ ch: 3, name: 'East' }, { ch: 11, name: 'West' }]);
  assert.equal(ids.length, SENSORS.length + BINARY_SENSORS.length + ALARM_PRIORITY_ORDER.length + 2 * 2);
  assert.equal(new Set(ids).size, ids.length, 'unique_ids are unique');
  assert.ok(ids.every((id) => id.startsWith('ecoflow_')));
  // a new discovery component (number, select, …) must be added to discoveryUniqueIds
  const src = readFileSync(join(ROOT, 'server', 'src', 'mqttDiscovery.ts'), 'utf8');
  const components = new Set([...src.matchAll(/\$\{prefix\}\/([a-z_]+)\//g)].map((m) => m[1]));
  assert.deepEqual([...components].sort(), ['binary_sensor', 'sensor', 'switch']);
});

/* ── the scanner and the slugger ────────────────────────────────────────── */

test('slugs match the ids GitHub gives this repository\'s headings', () => {
  const cases: [string, string][] = [
    ['1. System Architecture & Data Flow', '1-system-architecture--data-flow'],
    ['AppArmor profile (`ecoflow_panel/apparmor.txt`)', 'apparmor-profile-ecoflow_panelapparmortxt'],
    ['Cloud-wedge vs. real-outage classification (`deviceLink.ts`)', 'cloud-wedge-vs-real-outage-classification-devicelinkts'],
    ['The EcoFlow IoT-Open cloud protocol (no LAN)', 'the-ecoflow-iot-open-cloud-protocol-no-lan'],
    ['3. The tariff model (`tariff.ts`, v1.36.0)', '3-the-tariff-model-tariffts-v1360'],
    ['★★ The sizing authority — bisection', '-the-sizing-authority--bisection'],
    ['8. How a `/api/<report>` request resolves', '8-how-a-apireport-request-resolves'],
    ['PHOENIX_SITE constants (the real, in-code values)', 'phoenix_site-constants-the-real-in-code-values'],
    ['Energy Dashboard **power** wiring', 'energy-dashboard-power-wiring'],
    ['A _quiet_ [link](https://example.com/x) &amp; more', 'a-quiet-link--more'],
    ['Ünïcödé Ça', 'ünïcödé-ça'],
  ];
  for (const [heading, slug] of cases) {
    const scan = ms.scanMarkdown(`## ${heading}\n`);
    assert.equal(scan.headings[0].slug, slug, heading);
  }
  const s = ms.createSlugger();
  assert.deepEqual(['Foo', 'Foo', 'Foo 1', 'Foo'].map(s), ['foo', 'foo-1', 'foo-1-1', 'foo-2']);
});

test('the scanner is fence-aware: backtick and tilde fences, 0–3 space indent, length and character must match', () => {
  const src = [
    '# Title', '',
    '```', '# in a backtick fence', '~~~', '# still in it', '```', '',
    '~~~~', '# in a tilde fence', '~~~', '# still in it (closer too short)', '~~~~', '',
    '   ```', '# fence indented 3', '   ```', '',
    '    ```', '    # four spaces: indented code, not a fence', '',
    '``` js `x`', '## an info string with a backtick is not a fence, so this is a heading', '',
    '> ```', '> # quoted fence', '> ```', '',
    '1. Step', '', '    ```', '    # list-item fence (content indent 3, fence indent 4)', '    ```', '',
    '## Real heading', '',
    '<!--', '# inside an HTML comment block', '-->', '',
    '<div>', '# inside an HTML block', '</div>', '',
    '## Last',
  ].join('\n');
  const scan = ms.scanMarkdown(src);
  assert.deepEqual(scan.headings.map((h) => h.text), [
    'Title',
    'an info string with a backtick is not a fence, so this is a heading',
    'Real heading',
    'Last',
  ]);
  assert.equal(scan.unclosedFence, null);
  assert.equal(ms.scanMarkdown('```\n# open\n').unclosedFence, 1);
  assert.equal(ms.scanMarkdown('> ```\n> code\n\nafter\n').unclosedFence, null, 'a fence inside a blockquote ends with it');
});

test('the scanner reads setext headings, thematic breaks and paragraphs as CommonMark does', () => {
  const scan = ms.scanMarkdown([
    'Setext one', '==========', '',
    'Setext two', '----------', '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '---', '',
    '[ref]: https://example.com', '---', '',
    '- item', '---', '',
    'para', '', '***', '',
  ].join('\n'));
  assert.deepEqual(scan.headings.map((h) => [h.level, h.text]), [[1, 'Setext one'], [2, 'Setext two']]);
  const p = ms.scanMarkdown('**v1.1 — a.** x\n\n- **v1.2 — b.** y\n\n> **v1.3 — c.** z\n\n   **v1.4 — d.** w\n');
  assert.deepEqual(p.paragraphs.map((x) => x.text.slice(0, 6)), ['**v1.1', '**v1.2', '**v1.3', '**v1.4']);
  // an ordered item interrupts a paragraph only from 1; a table is not a paragraph
  const q = ms.scanMarkdown('In\n2. **v1.5 — e.** continues\n\nOut\n1. **v1.6 — f.** starts a list\n\n| **v1.7** | x |\n|---|---|\n');
  assert.deepEqual(q.paragraphs.map((x) => x.text.slice(0, 6)), ['In', 'Out', '**v1.6']);
});

test('the scanner finds links, images, code spans and raw HTML, and ignores them inside code', () => {
  const scan = ms.scanMarkdown([
    '# T', '',
    'An [inline](a.md#x "title"), an ![image](i.png), a [ref][r], a [shortcut], <https://auto.example/x>,',
    'a bare https://bare.example/y. and `[code](not-a-link.md)` and \\[escaped](no.md) and [angle](<b c.md>).',
    'Raw <span class="x">html</span>, a `<b>` in code, a comment <!-- c --> and a 1 < 2 comparison.',
    '', '[r]: ref.md', '[shortcut]: short.md',
  ].join('\n'));
  assert.deepEqual(scan.links.map((l) => [l.kind, l.image, l.dest]), [
    ['inline', false, 'a.md#x'],
    ['inline', true, 'i.png'],
    ['reference', false, 'ref.md'],
    ['reference', false, 'short.md'],
    ['autolink', false, 'https://auto.example/x'],
    ['bare', false, 'https://bare.example/y'],
    ['inline', false, 'b c.md'],
    ['definition', false, 'ref.md'],
    ['definition', false, 'short.md'],
  ]);
  assert.deepEqual(scan.codeSpans.map((c) => c.content), ['[code](not-a-link.md)', '<b>']);
  assert.deepEqual(scan.html.map((h) => h.tag), ['span', 'span', '!--']);
});

test('ratchetCounts counts release paragraphs in any container, file:line citations and section signs', () => {
  const t = [
    '**v1.10.0 — a.** x `a.ts:12`', '', '- **v1.11.0 — b.** y', '', '> **v0.9.1 — c.** z', '',
    `Not one: **bold** v1.2 and ${SECT}3, ${SECT}4 and see index.ts:1 or config.yaml:80 but not .ts:9 alone.`,
  ].join('\n');
  assert.deepEqual(cd.ratchetCounts(t), { releaseParagraphs: 3, fileLineCitations: 3, sectionSigns: 2 });
});

/* ── --inventory ────────────────────────────────────────────────────────── */

test('--inventory accounts for every section by sha256: moved, changed or duplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-docs-inv-'));
  try {
    const old = '# Title\n\nIntro.\n\n## 1. One\n\nBody one.\n\n```\n# not a section\n```\n\n## 2. Two\n\nBody two.\n\nSecond block.\n';
    writeFileSync(join(dir, 'old.md'), old);
    writeFileSync(join(dir, 'a.md'), '# Title\n\nIntro.\n\n## 1. One\n\nBody one.\n\n```\n# not a section\n```\n\n');
    writeFileSync(join(dir, 'b.md'), '## 2. Two\n\nBody two.\n\nSecond block.\n');
    const ok = cd.inventory(join(dir, 'old.md'), [join(dir, 'a.md'), join(dir, 'b.md')]);
    assert.equal(ok.ok, true, JSON.stringify(ok.totals));
    assert.equal(ok.totals.sections, 3);
    assert.equal(ok.totals.sameBytes, Buffer.byteLength(old));

    writeFileSync(join(dir, 'b.md'), '## 2. Two\n\nBody two, edited.\n\nSecond block.\n');
    const changed = cd.inventory(join(dir, 'old.md'), [join(dir, 'a.md'), join(dir, 'b.md')]);
    assert.equal(changed.ok, false);
    const row = changed.rows.find((r) => r.status === 'changed')!;
    assert.equal(row.path, '# Title › ## 2. Two');
    assert.deepEqual(row.missing!.map((m) => m.text), ['Body two.']);
    assert.equal(changed.added.length, 1);

    writeFileSync(join(dir, 'b.md'), '## 2. Two\n\nBody two.\n\nSecond block.\n');
    writeFileSync(join(dir, 'c.md'), '## 2. Two\n\nBody two.\n\nSecond block.\n');
    const dup = cd.inventory(join(dir, 'old.md'), [join(dir, 'a.md'), join(dir, 'b.md'), join(dir, 'c.md')]);
    assert.equal(dup.ok, false);
    assert.equal(dup.totals.duplicated, 1);

    const cli = spawnSync(process.execPath, [SCRIPT, '--inventory', join(dir, 'old.md'), '--', join(dir, 'a.md'), join(dir, 'b.md')], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /3 old sections — 3 byte-identical/);
    const cliBad = spawnSync(process.execPath, [SCRIPT, '--inventory', join(dir, 'old.md'), '--', join(dir, 'a.md')], { encoding: 'utf8' });
    assert.equal(cliBad.status, 1);
    assert.match(cliBad.stdout, /^CHANGED # Title › ## 2\. Two/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── the repository itself (staged: enabled by the 1.188.0 release commit) ── */

function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
const ADDON_VERSION = cd.parseAddonConfig(readFileSync(join(ROOT, 'ecoflow_panel', 'config.yaml'), 'utf8')).version ?? '0.0.0';
const WHOLE_TREE: string | false = versionAtLeast(ADDON_VERSION, '1.188.0')
  ? false
  : `staged until the 1.188.0 release commit (config.yaml is ${ADDON_VERSION}): the split, the guide and the consumers land in separate commits`;

test('the repository passes check-docs --check', { skip: WHOLE_TREE }, () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('the entity page lists exactly the unique_ids the discovery publishers build (2 circuits, every priority)', { skip: WHOLE_TREE }, () => {
  const scan = ms.scanMarkdown(readFileSync(join(ROOT, 'docs', 'guide', 'entities' + MD), 'utf8'));
  const norm = (id: string) => {
    const m = /^ecoflow_circuit_(\d+|<ch>)_(.+)$/.exec(id);
    if (m) return `ecoflow_circuit_<ch>_${m[2]}`;
    for (const p of ALARM_PRIORITY_ORDER) if (id === `ecoflow_alerts_${p}`) return 'ecoflow_alerts_<p>';
    return id;
  };
  const documented = new Set(cd.entityIds(scan).map((x) => norm(x.id)));
  const published = new Set(discoveryUniqueIds([{ ch: 3, name: 'East' }, { ch: 11, name: 'West' }]).map(norm));
  assert.deepEqual([...documented].sort(), [...published].sort());
});
