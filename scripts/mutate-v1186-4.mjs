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

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1186-4', mutants: MUTANTS, subset: SUBSET, root: REPO });
