#!/usr/bin/env node
/**
 * v1.187.22 — keep the add-on CHANGELOG small enough for Home Assistant to render.
 *
 * WHY THIS EXISTS. Home Assistant's add-on "Changelog" dialog renders the whole of
 * `ecoflow_panel/CHANGELOG.md` as markdown in the browser. v1.38.3 trimmed the file to the
 * 20 newest releases for exactly that reason, but the limit lived only in a sentence at the
 * top of the archive, and the file grew back to 109 releases and ~330 KB, enough to keep the
 * dialog loading for a long time. This script is the mechanism. It keeps the newest releases
 * whose combined size fits ROLL_TARGET_BYTES, moves every older release, unedited, to the TOP
 * of `CHANGELOG-ARCHIVE.md` (newest first, ahead of the releases archived earlier), and ends the
 * live file with an "Older releases" section linking the archive. `--check` fails once the live
 * file passes LIVE_LIMIT_BYTES; server/test/changelogSize.test.ts runs it in CI.
 *
 *   node scripts/roll-changelog.mjs          roll (idempotent: a file already within the target is untouched)
 *   node scripts/roll-changelog.mjs --check  exit 1 when the live file is over the limit
 *   --live <path> --archive <path>           operate on other files (tests)
 *
 * Both files are read in full before either is written, and the release headers on both sides
 * are compared before anything is written: the v1.131.2 release commit truncated the live file
 * by opening it for writing before it had been read, and 145 entries had to be recovered from
 * git history.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The live file is rolled back down to this many bytes of release sections. */
export const ROLL_TARGET_BYTES = 40 * 1024;
/** CI fails past this: headroom for roughly a dozen ordinary releases between rolls. */
export const LIVE_LIMIT_BYTES = 64 * 1024;

export const FOOTER_HEADING = '## Older releases';
export const FOOTER = `${FOOTER_HEADING}

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
`;

/** Split markdown into the text before the first `## ` heading and the `## ` sections. */
export function splitSections(text) {
  const idx = text.search(/^## /m);
  if (idx < 0) return { preamble: text, sections: [] };
  const preamble = text.slice(0, idx);
  const sections = text.slice(idx).split(/^(?=## )/m);
  return { preamble, sections };
}

const isFooter = (s) => s.startsWith(`${FOOTER_HEADING}\n`) || s.trimEnd() === FOOTER_HEADING;
const headingOf = (s) => s.split('\n', 1)[0];
const withBlankLine = (s) => s.replace(/\n*$/, '\n\n');

/**
 * Pure. Keep the newest release sections that fit `targetBytes` (always at least the newest
 * one), move the rest to the top of the archive, and re-append the footer. Throws if a release
 * heading would be lost or duplicated.
 */
export function rollChangelog(live, archive, targetBytes = ROLL_TARGET_BYTES) {
  const L = splitSections(live);
  const A = splitSections(archive);
  const releases = L.sections.filter((s) => !isFooter(s));

  let used = 0;
  let keep = 0;
  for (const s of releases) {
    const size = Buffer.byteLength(s);
    if (keep > 0 && used + size > targetBytes) break;
    used += size;
    keep += 1;
  }
  const kept = releases.slice(0, keep);
  const moved = releases.slice(keep);

  const nextLive = L.preamble + kept.map(withBlankLine).join('') + FOOTER;
  const nextArchive = moved.length === 0
    ? archive
    : A.preamble + moved.map(withBlankLine).join('') + A.sections.join('');

  const before = [...releases, ...A.sections].map(headingOf);
  const after = [...splitSections(nextLive).sections.filter((s) => !isFooter(s)), ...splitSections(nextArchive).sections].map(headingOf);
  if (before.length !== after.length || before.some((h, i) => h !== after[i])) {
    throw new Error(`roll-changelog: release headings changed (${before.length} before, ${after.length} after) — nothing written`);
  }
  return { live: nextLive, archive: nextArchive, kept: kept.length, moved: moved.length };
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const livePath = resolve(arg('--live', resolve(ROOT, 'ecoflow_panel/CHANGELOG.md')));
  const archivePath = resolve(arg('--archive', resolve(ROOT, 'ecoflow_panel/CHANGELOG-ARCHIVE.md')));
  const live = readFileSync(livePath, 'utf8');

  if (argv.includes('--check')) {
    const size = Buffer.byteLength(live);
    if (size > LIVE_LIMIT_BYTES) {
      console.error(
        `CHANGELOG.md is ${size} bytes, over the ${LIVE_LIMIT_BYTES}-byte limit — Home Assistant's Changelog dialog renders all of it. `
        + 'Run `node scripts/roll-changelog.mjs` to move older releases to CHANGELOG-ARCHIVE.md.',
      );
      process.exit(1);
    }
    console.log(`CHANGELOG.md is ${size} bytes (limit ${LIVE_LIMIT_BYTES}).`);
    return;
  }

  const archive = readFileSync(archivePath, 'utf8');
  const out = rollChangelog(live, archive);
  if (out.live === live && out.archive === archive) {
    console.log(`roll-changelog: nothing to do (${out.kept} release(s) in CHANGELOG.md).`);
    return;
  }
  writeFileSync(archivePath, out.archive);
  writeFileSync(livePath, out.live);
  console.log(`roll-changelog: kept ${out.kept} release(s), moved ${out.moved} to the archive; CHANGELOG.md is now ${Buffer.byteLength(out.live)} bytes.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
