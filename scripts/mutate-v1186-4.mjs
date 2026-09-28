#!/usr/bin/env node
/**
 * mutate-v1186-4.mjs — committed harness for v1.186.4: the Alert Console's speaker preview
 * reaches every configured speaker (the Music Assistant targets AND the SIP cordless) and
 * reports each, and the all-clear rung can be previewed with the recovery broadcast's words.
 *
 *   node scripts/mutate-v1186-4.mjs
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
const BC = resolve(SERVER, 'src/broadcast.ts');
const TTS = resolve(SERVER, 'src/ttsService.ts');

const SUBSET = [
  'test/previewSpeakers.test.ts',
  'test/previewAllSpeakers.test.ts',
];

const MUTANTS = [
  {
    id: 'i. ★★★ the speaker preview skips the cordless',
    file: BC,
    find: '        playSipAnnounce(url),\n      ]);',
    to: '        Promise.resolve({ attempted: 0, ok: 0, errors: [] as string[] }), /* MUTANT */\n      ]);',
    why: 'The "On speakers" preview plays on the HomePod only, so the cordless path is never proved.',
  },
  {
    id: 'ii. ★★★ the all-clear previews with a priority message',
    file: BC,
    find: "      const spokenText = rung === 'clear' ? ALL_CLEAR_PREVIEW_MESSAGE : previewMessageFor(rung);",
    to: "      const spokenText = previewMessageFor(rung === 'clear' ? 'low' : rung); /* MUTANT */",
    why: 'The all-clear preview speaks an advisory instead of what a recovery says.',
  },
  {
    id: 'iii. ★★ a refused cordless is reported as a success',
    file: BC,
    find: "    else errors.push(`SIP play_media: ${sip.errors.join('; ')}`);",
    to: "    else notes.push(`SIP play_media: ${sip.errors.join('; ')}`); /* MUTANT */",
    why: 'The console says "Played" while the phone system refused the call.',
  },
  {
    id: 'iv. ★★ a timed-out cordless fails the preview',
    file: BC,
    find: "    if (sipTimeoutLike(sip.errors)) notes.push('the cordless did not confirm in time; it usually still rings');",
    to: "    if (false) notes.push('x'); /* MUTANT */",
    why: 'A preview the cordless played (response lost under HA load) is reported as failed.',
  },
  {
    id: 'v. ★ the delivered count leaves out the cordless',
    file: BC,
    find: '  let delivered = sip.ok;',
    to: '  let delivered = 0; /* MUTANT */',
    why: 'The console reports "Played on 1 speaker" when two played.',
  },
  {
    id: 'vi. ★ the recovery broadcast drifts from the previewed all-clear',
    file: TTS,
    find: '    return ALL_CLEAR_MESSAGE;',
    to: "    return 'All clear.'; /* MUTANT */",
    why: 'The all-clear preview no longer says what a real recovery says.',
  },
  {
    id: 'vii. ★★ the all-clear preview is the real recovery audio',
    file: BC,
    find: "  ALL_CLEAR_PREVIEW_MESSAGE,\n} from './alertPriority.js';",
    to: "  ALL_CLEAR_MESSAGE as ALL_CLEAR_PREVIEW_MESSAGE, /* MUTANT */\n} from './alertPriority.js';",
    why: 'A speaker preview renders the exact recovery file; the cordless dedupe then skips a real all-clear inside its window.',
  },
  {
    id: 'viii. ★ an unconfirmed Music Assistant play reads as heard',
    file: BC,
    find: "    if (ma.call.ok && ma.call.verified === false) notes.push('the Music Assistant speakers did not confirm playback');",
    to: "    /* MUTANT */",
    why: 'The console says "Played on N speakers" with no caveat when playback was never confirmed.',
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
  if (s.includes('/* MUTANT')) {
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
console.log(`mutate-v1186-4: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
