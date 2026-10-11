#!/usr/bin/env node
/**
 * mutate-v1187-17.mjs — v1.187.17: each action runs at one pinned commit in every workflow.
 *
 *   P-i    tag-release.yml gains a checkout on another major (v5.0.1)
 *   P-ii   ci.yml gains an upload-artifact on v4.6.2
 *   P-iii  codeql.yml gains one codeql-action step from an older release
 *   P-iv   images.yml gains a registry login pinned by a movable tag, not a commit
 *   P-v    a comment line returns to ci.yml's smoke-build build-args block
 *   P-vi   a movable tag hides behind words after the version comment (the reader must not skip it)
 *   P-vii  a comment line inside a `|-` build-args block
 *
 *   node scripts/mutate-v1187-17.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = resolve(REPO, '.github/workflows/ci.yml');
const CODEQL = resolve(REPO, '.github/workflows/codeql.yml');
const IMAGES = resolve(REPO, '.github/workflows/images.yml');
const TAG = resolve(REPO, '.github/workflows/tag-release.yml');
const SUBSET = ['test/workflowActionPins.test.ts'];

// Each pin mutant INSERTS a drifted or movable `uses:` step next to a stable step name, so an
// ordinary pin bump (Dependabot) can never leave an anchor unresolved: anchoring on a pinned
// line itself turned 'Mutant anchors resolve' red on #518 when upload-artifact moved to v7.0.2.
const MUTANTS = [
  {
    id: 'P-i. ★★★ tag-release.yml gains a checkout on another major (v5.0.1)',
    file: TAG,
    find: '      - name: Create tag and dispatch the image build',
    to: '      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1\n      - name: Create tag and dispatch the image build',
    why: 'One workflow on another major; a grouped update then moves every copy to one version.',
  },
  {
    id: 'P-ii. ★★ ci.yml gains an upload-artifact on v4.6.2',
    file: CI,
    find: '      - name: Build .pdf (render the .docx)',
    to: '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n      - name: Build .pdf (render the .docx)',
    why: 'The docs job runs a Node-20 action that codeql.yml has already left.',
  },
  {
    id: 'P-iii. ★★ codeql.yml gains one codeql-action step from an older release',
    file: CODEQL,
    find: '      - name: Publish SARIF artifact',
    to: '      - uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2\n      - name: Publish SARIF artifact',
    why: 'Steps of one action from different releases (owner/repo is the unit).',
  },
  {
    id: 'P-iv. ★★ images.yml gains a registry login pinned by a movable tag',
    file: IMAGES,
    find: '      - name: Lowercase repo owner (GHCR requires it)',
    to: '      - uses: docker/login-action@v4 # v4.6.0\n      - name: Lowercase repo owner (GHCR requires it)',
    why: 'The step that holds the registry credentials runs whatever the tag points at.',
  },
  {
    id: 'P-v. ★ a comment line returns to ci.yml\'s smoke-build build-args block',
    file: CI,
    find: '          build-args: |\n            BUILD_FROM=ghcr.io/home-assistant/amd64-base',
    to: '          build-args: |\n            # MUTANT — keep in lockstep with images.yml\n            BUILD_FROM=ghcr.io/home-assistant/amd64-base',
    why: 'docker build receives the comment as a build arg.',
  },
  {
    id: 'P-vi. ★★ a movable tag hides behind words after the version comment',
    file: IMAGES,
    find: '      - name: Lowercase repo owner (GHCR requires it)',
    to: '      - uses: docker/login-action@v4 # v4.6.0 (GHCR login)\n      - name: Lowercase repo owner (GHCR requires it)',
    why: 'A line the strict pattern cannot parse must fail, not drop out of the check.',
  },
  {
    id: 'P-vii. ★ a comment line inside a `|-` build-args block',
    file: CI,
    find: '          build-args: |\n            BUILD_FROM=ghcr.io/home-assistant/amd64-base',
    to: '          build-args: |-\n            # MUTANT — keep in lockstep with images.yml\n            BUILD_FROM=ghcr.io/home-assistant/amd64-base',
    why: 'Chomping indicators do not make a `#` line a YAML comment inside the block.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-17', mutants: MUTANTS, subset: SUBSET, root: REPO });
