#!/usr/bin/env node
/**
 * mutate-v1187-16.mjs — v1.187.16: every write route behind the write gate.
 *
 *   W-i   the alert-outcome route loses its write gate
 *   W-ii  the vendor-backfill route loses its write gate
 *   W-iii (v1.187.20) a backup-window hook route outside index.ts loses its loopback gate
 *
 *   node scripts/mutate-v1187-16.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDX = resolve(REPO, 'server/src/index.ts');
const BACKUP_WINDOW = resolve(REPO, 'server/src/backupWindow.ts');
const SUBSET = ['test/writeRoutesGated.test.ts'];

const MUTANTS = [
  {
    id: 'W-i. ★★ the alert-outcome route loses its write gate',
    file: IDX,
    find: "  '/api/alerts/outcome',\n  { preHandler: requireWriteAuth },",
    to: "  '/api/alerts/outcome', /* MUTANT */",
    why: 'A bare LAN POST writes the learning ledger again.',
  },
  {
    id: 'W-ii. ★★ the vendor-backfill route loses its write gate',
    file: IDX,
    find: "'/api/energy-history/backfill', { preHandler: requireWriteAuth }, async (req) => {",
    to: "'/api/energy-history/backfill', async (req) => { /* MUTANT */",
    why: 'A bare LAN POST starts vendor fetches and ledger writes.',
  },
  {
    id: 'W-iii. ★★ a backup-window hook route outside index.ts loses its loopback gate',
    file: BACKUP_WINDOW,
    find: "  app.post(`${BACKUP_WINDOW_ROUTE}/post`, { onRequest: requireLoopbackPeer }, async (req)",
    to: "  app.post(`${BACKUP_WINDOW_ROUTE}/post`, async (req)",
    why: 'A LAN POST lifts the checkpoint freeze mid-copy.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-16', mutants: MUTANTS, subset: SUBSET, root: REPO });
