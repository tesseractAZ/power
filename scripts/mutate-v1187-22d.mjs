#!/usr/bin/env node
/**
 * mutate-v1187-22d.mjs — v1.187.22: the add-on CHANGELOG is rolled into the archive so Home
 * Assistant's Changelog dialog stays fast, and CI fails when it grows past the limit.
 *
 *   D-i    the roll ignores the size target (nothing is ever moved)
 *   D-ii   moved releases are dropped instead of archived
 *   D-iii  moved releases go to the END of the archive (history out of order)
 *   D-iv   --check never fails
 *   D-v    an existing "Older releases" section is kept as a release (the footer doubles)
 *   D-vi   the newest release is moved when it alone exceeds the target (an empty live file)
 *   D-vii  release.yml no longer rolls the changelog
 *   D-viii release.yml rolls but does not commit the archive (the moved releases are lost)
 *   D-ix   release.yml writes a dated heading again (the update dialog shows the whole file)
 *   D-x    release.yml leaves headings inside the notes (a section ends early)
 *   D-xi   the main guard compares the unresolved path again (a run through a symlink does nothing, exit 0)
 *   D-xii  the PR template asks for a `## vX.Y.Z` heading and an unchanged entry count again
 *   D-xiii check-release-pr.py's hint names `## v<version>` again
 *
 *   node scripts/mutate-v1187-22d.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROLL = resolve(REPO, 'scripts/roll-changelog.mjs');
const RELEASE_YML = resolve(REPO, '.github/workflows/release.yml');
const PR_TEMPLATE = resolve(REPO, '.github/PULL_REQUEST_TEMPLATE.md');
const PRCHECK = resolve(REPO, 'scripts/check-release-pr.py');
const SUBSET = ['test/changelogSize.test.ts'];

const MUTANTS = [
  {
    id: 'D-i. ★★★ the roll ignores the size target',
    file: ROLL,
    find: '    if (keep > 0 && used + size > targetBytes) break;',
    to: '    /* MUTANT */',
    why: 'The Changelog dialog keeps rendering every release ever shipped — the 330 KB file that loaded for minutes.',
  },
  {
    id: 'D-ii. ★★★ moved releases are dropped instead of archived',
    file: ROLL,
    find: '    : A.preamble + moved.map(withBlankLine).join(\'\') + A.sections.join(\'\');',
    to: '    : A.preamble + A.sections.join(\'\'); /* MUTANT */',
    why: 'Release history is destroyed — the v1.131.2 truncation, which cost 145 entries recovered from git.',
  },
  {
    id: 'D-iii. ★★ moved releases go to the end of the archive',
    file: ROLL,
    find: '    : A.preamble + moved.map(withBlankLine).join(\'\') + A.sections.join(\'\');',
    to: '    : A.preamble + A.sections.join(\'\') + moved.map(withBlankLine).join(\'\'); /* MUTANT */',
    why: 'The archive stops reading newest first: the most recently archived releases land below 0.73.0.',
  },
  {
    id: 'D-iv. ★★★ --check never fails',
    file: ROLL,
    find: '    if (size > LIVE_LIMIT_BYTES) {',
    to: '    if (false) { /* MUTANT */',
    why: 'CI stops guarding the size, and the file grows back exactly as it did after v1.38.3.',
  },
  {
    id: 'D-v. ★★ the "Older releases" section is kept as a release',
    file: ROLL,
    find: '  const releases = L.sections.filter((s) => !isFooter(s));',
    to: '  const releases = L.sections; /* MUTANT */',
    why: 'Every roll appends another archive link; the footer is then rolled into the archive as if it were a release.',
  },
  {
    id: 'D-vi. ★★ the newest release is moved when it alone exceeds the target',
    file: ROLL,
    find: '    if (keep > 0 && used + size > targetBytes) break;',
    to: '    if (used + size > targetBytes) break; /* MUTANT */',
    why: 'A long release empties the live file: the Changelog dialog shows no notes for the version just installed.',
  },
  {
    id: 'D-vii. ★★★ release.yml no longer rolls the changelog',
    file: RELEASE_YML,
    find: '          node scripts/roll-changelog.mjs\n',
    to: '          true # MUTANT\n',
    why: 'An automated release grows CHANGELOG.md past the limit; CI does not run on a PR opened with GITHUB_TOKEN, so nothing stops it.',
  },
  {
    id: 'D-viii. ★★★ release.yml does not commit the archive',
    file: RELEASE_YML,
    find: '          git add ecoflow_panel/config.yaml ecoflow_panel/CHANGELOG.md ecoflow_panel/CHANGELOG-ARCHIVE.md\n',
    to: '          git add ecoflow_panel/config.yaml ecoflow_panel/CHANGELOG.md # MUTANT\n',
    why: 'The roll removes releases from CHANGELOG.md and the commit leaves the archive copy behind — history lost on main.',
  },
  {
    id: 'D-ix. ★★ release.yml writes a dated heading again',
    file: RELEASE_YML,
    find: '          new_section = f"## {version}\\n\\n{notes}\\n\\n"\n',
    to: '          new_section = f"## {version} — 2026-01-01\\n\\n{notes}\\n\\n"  # MUTANT\n',
    why: "Home Assistant's update dialog stops slicing the notes and shows the whole changelog for every automated release.",
  },
  {
    id: 'D-x. ★★ release.yml leaves headings inside the notes',
    file: RELEASE_YML,
    find: '          notes = re.sub(r"(?m)^#{1,2}(?=\\s)", "###", notes)\n',
    to: '          pass  # MUTANT\n',
    why: 'A "## " line in the notes starts a new section: the published Release notes and the update dialog stop at it.',
  },
  {
    id: 'D-xi. ★★★ the main guard compares the unresolved path again',
    file: ROLL,
    find: '    real = realpathSync(entry);',
    to: '    real = resolve(entry); /* MUTANT */',
    why: 'Run through a symlink (macOS /tmp, a linked checkout) the script prints nothing and exits 0: --check passes an over-limit file and a hand roll is skipped.',
  },
  {
    id: 'D-xii. ★★ the PR template asks for `## vX.Y.Z` and an unchanged entry count again',
    file: PR_TEMPLATE,
    find: '- [ ] `ecoflow_panel/CHANGELOG.md` has a bare `## X.Y.Z` section',
    to: '- [ ] `ecoflow_panel/CHANGELOG.md` has a `## vX.Y.Z` section, check the entry count did not drop; MUTANT',
    why: 'A release author writes `## v1.187.23`, which the Server tests reject and Home Assistant\'s update dialog cannot slice.',
  },
  {
    id: 'D-xiii. ★ check-release-pr.py\'s hint names `## v<version>` again',
    file: PRCHECK,
    find: '                f"{CHANGELOG} has no \'## {new}\' section.\\n"',
    to: '                f"{CHANGELOG} has no \'## v{new}\' section.\\n"  # MUTANT',
    why: 'One required check tells the author to write a heading another required check rejects.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — changelogSize.test.ts is the only test that drives the roll script or reads
// release.yml's roll step.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-22d', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
