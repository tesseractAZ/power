#!/usr/bin/env node
/**
 * mutate-v1187-17.mjs — v1.187.17: each action runs at one pinned commit in every workflow.
 *
 *   P-i    tag-release.yml's checkout drifts back to v5.0.1
 *   P-ii   ci.yml's docs upload drifts back to upload-artifact v4.6.2
 *   P-iii  codeql.yml's analyze step alone drifts back to codeql-action v4.38.2
 *   P-iv   images.yml's registry login is pinned by a movable tag, not a commit
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

const MUTANTS = [
  {
    id: 'P-i. ★★★ tag-release.yml\'s checkout drifts back to v5.0.1',
    file: TAG,
    find: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          fetch-depth: 0',
    to: '      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1\n        with:\n          fetch-depth: 0',
    why: 'One workflow on another major; a grouped update then moves every copy to one version.',
  },
  {
    id: 'P-ii. ★★ ci.yml\'s docs upload drifts back to upload-artifact v4.6.2',
    file: CI,
    find: '      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
    to: '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
    why: 'The docs job runs a Node-20 action that codeql.yml has already left.',
  },
  {
    id: 'P-iii. ★★ codeql.yml\'s analyze step alone drifts back to codeql-action v4.38.2',
    file: CODEQL,
    find: '        uses: github/codeql-action/analyze@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3',
    to: '        uses: github/codeql-action/analyze@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2',
    why: 'init and analyze from different releases of one action (owner/repo is the unit).',
  },
  {
    id: 'P-iv. ★★ images.yml\'s registry login is pinned by a movable tag',
    file: IMAGES,
    find: '      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0',
    to: '      - uses: docker/login-action@v4 # v4.6.0',
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
    find: '      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0',
    to: '      - uses: docker/login-action@v4 # v4.6.0 (GHCR login)',
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
