#!/usr/bin/env node
/**
 * mutate-ci-apt-mirror.mjs — 2026-11-19: the PR docs job (ci.yml docs-docx) leaves the runner's
 * regional apt mirror on either cloud, and its apt installs download before they unpack.
 *
 * The runner's /etc/apt/apt-mirrors.txt lists a regional mirror first, and the runner's cloud picks
 * it (azure.archive.ubuntu.com on Azure, <region>.ec2.archive.ubuntu.com on AWS). The 10-26 filter
 * matched only the Azure name, so an AWS runner kept its slow first mirror. The step now drops any
 * *.archive.ubuntu.com entry while archive.ubuntu.com stays listed; server/test/workflowTimeouts
 * runs the step's own script against both clouds' lists.
 *
 *   node scripts/mutate-ci-apt-mirror.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = resolve(REPO, '.github/workflows/ci.yml');
const SUBSET = ['test/workflowTimeouts.test.ts'];

const MUTANTS = [
  /* ── the mirror filter ──────────────────────────────────────────────────── */
  {
    id: 'AM-i. ★★★ the filter matches only the Azure mirror again',
    file: CI,
    find: "          regional='://[^/]+\\.archive\\.ubuntu\\.com/'\n",
    to: "          regional='://azure\\.archive\\.ubuntu\\.com/' # MUTANT\n",
    why: 'An AWS runner keeps us-east-2.ec2.archive.ubuntu.com first: LibreOffice in 1-2 min instead of seconds, 10+ min on a slow day.',
  },
  {
    id: 'AM-ii. ★★★ the regional mirror is dropped with no main archive left',
    file: CI,
    find: `          if [ -f "$f" ] && grep -q '://archive\\.ubuntu\\.com/' "$f"; then\n`,
    to: '          if [ -f "$f" ]; then # MUTANT\n',
    why: 'An image whose list holds only the regional mirror and the security pocket leaves apt the security pocket alone.',
  },
  {
    id: 'AM-iii. ★★ the filter drops the main archive too',
    file: CI,
    find: "          regional='://[^/]+\\.archive\\.ubuntu\\.com/'\n",
    to: "          regional='archive\\.ubuntu\\.com/' # MUTANT\n",
    why: 'The main archive goes with the regional mirror; apt is left the security pocket.',
  },
  {
    id: 'AM-iv. ★★ the filtered list is never written back',
    file: CI,
    find: '            sudo cp "$RUNNER_TEMP/apt-mirrors.txt" "$f"\n',
    to: '            : # MUTANT\n',
    why: 'The log says "dropped:" and apt still uses the slow mirror.',
  },
  /* ── download, then install ─────────────────────────────────────────────── */
  {
    id: 'AM-v. ★★ LibreOffice installs straight from the mirror again',
    file: CI,
    find: '            sudo timeout -k 10 420 apt-get $APT_OPTS install -y --download-only --no-install-recommends libreoffice-writer &&\n',
    to: '            # MUTANT\n',
    why: 'The bound can fire while dpkg unpacks: a half-configured package and a held lock (10-26).',
  },
  {
    id: 'AM-vi. ★★ the pandoc fallback installs straight from the mirror again',
    file: CI,
    find: '              sudo timeout -k 10 300 apt-get $APT_OPTS install -y --download-only pandoc &&\n',
    to: '              : && # MUTANT\n',
    why: 'As AM-v, for the pandoc fallback.',
  },
  {
    id: "AM-vii. ★★ LibreOffice's apt fails at once on a held dpkg lock",
    file: CI,
    find: '        timeout-minutes: 13\n        env:\n          APT_OPTS: -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=60\n',
    to: '        timeout-minutes: 13\n        env:\n          APT_OPTS: -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 # MUTANT\n',
    why: 'A dpkg the pandoc fallback left running fails the LibreOffice install instead of being waited for.',
  },
  /* ── the pinned .deb ────────────────────────────────────────────────────── */
  {
    id: 'AM-viii. ★★★ the apt fallback is silent',
    file: CI,
    find: '            { echo "::warning::The pinned pandoc .deb did not install; installing pandoc with apt." &&\n',
    to: '            { # MUTANT\n',
    why: 'A pin that stopped matching passes as a green check, with apt quietly doing the work.',
  },
  {
    id: 'AM-ix. ★★★ the .deb is installed unchecked',
    file: CI,
    find: '              echo "$PANDOC_DEB_SHA256  /tmp/pandoc.deb" | sha256sum -c - &&\n',
    to: '              : && # MUTANT\n',
    why: 'Whatever the URL serves runs as root on the runner.',
  },
  /* ── the bounds ─────────────────────────────────────────────────────────── */
  {
    id: "AM-x. ★ the pandoc step's bound falls below its commands' bounds",
    file: CI,
    find: '        timeout-minutes: 14\n',
    to: '        timeout-minutes: 12 # MUTANT\n',
    why: 'The step bound fires first and the commands\' own bounds are fiction.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-ci-apt-mirror', mutants: MUTANTS, subset: SUBSET, root: REPO });
