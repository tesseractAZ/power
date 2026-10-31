#!/usr/bin/env node
/**
 * mutate-screenshot-gate.mjs — v1.193.0: the README screenshots are rendered from a synthetic fleet
 * (scripts/screenshots/), and the capture tool refuses to write an image whose page text carries a
 * serial that is not a placeholder, whose page text or pixels carry an EcoFlow default device name
 * ("<product>-<last four serial digits>", the shape that reached the earlier live captures), whose
 * page asked for an endpoint the fixture does not serve, or that has nothing to read at all.
 * `check-no-secrets.py --stdin` gives the page text the repository scan's own rules.
 *
 *   Fixture   F-i..F-ii    (placeholder serials only; the offline accessory)
 *   Gate      G-i..G-viii  (the name rule, its parenthesis and its model number, the serial shape,
 *                           an undefined placeholder, the positive controls, the OCR line floor)
 *   Server    S-i..S-v     (an unknown endpoint, an unmodelled metric, write-only paths and a read
 *                           of one, writes)
 *   Capture   C-i          (a stale bundle)
 *   Stdin     N-i..N-v     (the verdict, the dispatch, the serial, shape and private rules)
 *
 *   node scripts/mutate-screenshot-gate.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = resolve(REPO, 'scripts/screenshots/fixture.mts');
const GATE = resolve(REPO, 'scripts/screenshots/leakGate.mts');
const SERVE = resolve(REPO, 'scripts/screenshots/serve.mts');
const CAP = resolve(REPO, 'scripts/screenshots/capture.mts');
const NS = resolve(REPO, 'scripts/check-no-secrets.py');
const SUBSET = [
  'test/screenshotFixture.test.ts',
  'test/checkNoSecretsStdin.test.ts',
];

const MUTANTS = [
  {
    id: 'F-i. ★★★ a non-placeholder serial in the fixture',
    file: FIX,
    find: "export const CORE_SNS = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'] as const;",
    to: "export const CORE_SNS = ['CORE' + 'ABC12DEF0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'] as const; /* MUTANT */",
    why: 'A serial-shaped token that is not a placeholder reaches every payload and the image.',
  },
  {
    id: 'F-ii. ★ the offline accessory is online',
    file: FIX,
    find: "  { sn: GENERATOR_SN, deviceName: 'Smart Generator', productName: 'Smart Generator', online: false },",
    to: "  { sn: GENERATOR_SN, deviceName: 'Smart Generator', productName: 'Smart Generator', online: true }, /* MUTANT */",
    why: 'The header reads "7 devices · 7 online" and the offline alert describes a device shown online.',
  },
  {
    id: 'G-i. ★★★ the default-name rule never fires',
    file: GATE,
    find: "  if (DEFAULT_NAME_TAIL.test(text)) out.push('a device name ending in four digits');",
    to: "  if (false && DEFAULT_NAME_TAIL.test(text)) out.push('a device name ending in four digits'); /* MUTANT */",
    why: 'A device name ending in the last four serial digits — the leak the earlier images carried — passes the gate.',
  },
  {
    id: 'G-ii. ★★★ the name rule misses a product name closed by a parenthesis',
    file: GATE,
    find: 'export const DEFAULT_NAME_TAIL = /(?<=[A-Za-z)]|[A-Za-z] ?\\d{1,4})-\\d{4}(?!\\d)/;',
    to: 'export const DEFAULT_NAME_TAIL = /(?<=[A-Za-z]|[A-Za-z] ?\\d{1,4})-\\d{4}(?!\\d)/; /* MUTANT */',
    why: '"Smart Generator 3000 (Dual Fuel)-NNNN", the exact form that leaked, is no longer matched.',
  },
  {
    id: 'G-vii. ★★★ the name rule misses a product name ending in a model number',
    file: GATE,
    find: 'export const DEFAULT_NAME_TAIL = /(?<=[A-Za-z)]|[A-Za-z] ?\\d{1,4})-\\d{4}(?!\\d)/;',
    to: 'export const DEFAULT_NAME_TAIL = /(?<=[A-Za-z)])-\\d{4}(?!\\d)/; /* MUTANT */',
    why: '"Smart Home Panel 2-NNNN", "DELTA 2-NNNN": the panel\'s own default name passes both the page and the OCR gate.',
  },
  {
    id: 'G-viii. ★★ the name rule takes a one-digit model number only',
    file: GATE,
    find: 'export const DEFAULT_NAME_TAIL = /(?<=[A-Za-z)]|[A-Za-z] ?\\d{1,4})-\\d{4}(?!\\d)/;',
    to: 'export const DEFAULT_NAME_TAIL = /(?<=[A-Za-z)]|[A-Za-z] ?\\d)-\\d{4}(?!\\d)/; /* MUTANT */',
    why: '"Smart Generator 3000-NNNN" or "DELTA 1300-NNNN" passes the gate.',
  },
  {
    id: 'G-iii. ★★★ a real serial reads as a placeholder',
    file: GATE,
    find: 'const PLACEHOLDER_TAIL = /^[X0]{10}[0-9]{2}$/;',
    to: 'const PLACEHOLDER_TAIL = /^[A-Z0-9]{10}[0-9]{2}$/; /* MUTANT */',
    why: 'Any 16-character serial is accepted as a placeholder, so a real one passes the DOM gate.',
  },
  {
    id: 'G-iv. ★ a placeholder the fixture does not define passes',
    file: GATE,
    find: "      else if (!opts.serials.has(tok)) out.push('a placeholder serial the fixture does not define');",
    to: "      else if (false) out.push('a placeholder serial the fixture does not define'); /* MUTANT */",
    why: 'The page may show a device that is not the fixture\'s, and the gate does not notice.',
  },
  {
    id: 'G-v. ★★★ a gate that read nothing reports clean',
    file: GATE,
    find: '    if (!text.includes(name)) out.push(`positive control missing: ${name}`);',
    to: '    if (false && !text.includes(name)) out.push(`positive control missing: ${name}`); /* MUTANT */',
    why: 'An empty page or a blank OCR read passes every rule: the detector cannot fire and says clean.',
  },
  {
    id: 'G-vi. ★★ an OCR read of a few words counts as a read of the page',
    file: GATE,
    find: '  if (lines.length < opts.minLines) out.push(`OCR read ${lines.length} line(s), fewer than ${opts.minLines}`);',
    to: '  if (false) out.push(`OCR read ${lines.length} line(s), fewer than ${opts.minLines}`); /* MUTANT */',
    why: 'An image too small to read (the earlier dashboard was 363 px wide) passes the pixel gate.',
  },
  {
    id: 'S-i. ★★★ an endpoint the fixture does not serve is answered and not reported',
    file: SERVE,
    find: '    unknown.add(key);\n    return { status: 404, body: null };',
    to: '    void key; /* MUTANT */\n    return { status: 200, body: null };',
    why: 'A card that starts reading a new endpoint is photographed empty and the capture writes it.',
  },
  {
    id: 'S-ii. ★★ a history metric the fixture does not model is not reported',
    file: SERVE,
    find: '      unknown.add(`${key}?metric=${metric}`);',
    to: '      void metric; /* MUTANT */',
    why: 'A sparkline reading "collecting…" for a metric nobody modelled reaches the image.',
  },
  {
    id: 'S-iii. ★★ a GET to a write-only path is not refused',
    file: SERVE,
    find: '  if (writeOnly(key)) {',
    to: '  if (false) { /* MUTANT */',
    why: 'The fixture no longer distinguishes the paths the UI writes to from the ones it reads.',
  },
  {
    id: 'S-v. ★★ a read of a write-only path is refused but not reported',
    file: SERVE,
    find: '    unknown.add(`${key} (a read of a write-only path)`);',
    to: '    void key; /* MUTANT */',
    why: 'A card that starts reading a write-only path is photographed in its error state and gate (i) is clean.',
  },
  {
    id: 'S-iv. ★★★ the replay server answers writes',
    file: SERVE,
    find: "  if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: null };",
    to: "  if (false) return { status: 405, body: null }; /* MUTANT */",
    why: 'A POST from the page under capture is answered as though it acted.',
  },
  {
    id: 'C-i. ★★ a bundle older than its source is photographed',
    file: CAP,
    find: 'export const distIsStale = (distBuiltMs: number | null, srcNewestMs: number): boolean => distBuiltMs == null || distBuiltMs < srcNewestMs;',
    to: 'export const distIsStale = (distBuiltMs: number | null, srcNewestMs: number): boolean => distBuiltMs == null; /* MUTANT */',
    why: 'The README shows a UI the source no longer renders.',
  },
  {
    id: 'N-i. ★★★ --stdin always reports clean',
    file: NS,
    find: '    return 1 if problems else 0',
    to: '    return 0  # MUTANT',
    why: 'The page text of a leaking capture passes the repository scan\'s own rules.',
  },
  {
    id: 'N-ii. ★★ --stdin scans the tree instead',
    file: NS,
    find: '    if "--stdin" in sys.argv[1:]:\n        return main_stdin()',
    to: '    pass  # MUTANT',
    why: 'The flag is ignored: the text piped in is never read.',
  },
  {
    id: 'N-iii. ★★★ --stdin skips the serial rule',
    file: NS,
    find: '                out.append(f"  <stdin>:{lineno}: serial-shaped token (model code {tok[:4]})")',
    to: '                pass  # MUTANT',
    why: 'A real serial in the page text passes.',
  },
  {
    id: 'N-iv. ★★ --stdin skips the shape rules',
    file: NS,
    find: '            out.append(f"  <stdin>:{lineno}:{col}: {why}")',
    to: '            pass  # MUTANT',
    why: 'A home subnet, an email address or a phone number in the page text passes.',
  },
  {
    id: 'N-v. ★★★ --stdin skips the private value rules',
    file: NS,
    find: '                out.append(f"  <stdin>:{lineno}: private pattern ({why})")',
    to: '                pass  # MUTANT',
    why: 'The owner-side values (the ones this public file must not list) are never checked on the page.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-screenshot-gate', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
