/**
 * v1.187.20 — the client half of the Home Assistant backup hooks.
 *
 *   node backupHook.mjs pre|post
 *
 * Run by /usr/bin/ecoflow-panel-backup-hook, which the Supervisor runs with `docker exec` inside
 * the running add-on (config.yaml backup_pre / backup_post). It POSTs to the server's loopback-only
 * route (backupWindow.ts), which holds SQLite checkpoints still while /data is copied.
 *
 * It ALWAYS exits 0, within TIMEOUT_MS plus a short grace. The Supervisor treats a non-zero exit as
 * a failed hook and leaves the whole add-on out of that backup (supervisor/apps/app.py
 * _backup_command raises AppPrePostBackupCommandReturnedError; backups/backup.py store_apps then
 * skips the add-on). A hook that cannot reach the server costs one unquiesced copy, which is what
 * every backup was before this hook existed. A failed exit would cost the copy itself.
 *
 * The server journals a successful phase itself. When the server cannot be reached or answers
 * with an error, this client appends the line instead, to the same journal (the hook's stdout goes
 * only to the Supervisor's debug log), so every hook run leaves evidence.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const phase = process.argv[2];
const port = Number(process.env.PORT) || 8787;
// The exec environment carries the image's ENV (PORT=8787), not the options the run script exports.
const TIMEOUT_MS = Math.min(8000, Math.max(100, Number(process.env.BACKUP_HOOK_TIMEOUT_MS) || 8000));
// The server must START pre by t0 + TIMEOUT_MS - START_GRACE_MS (sent as x-backup-hook-deadline,
// backupWindow.ts BACKUP_DEADLINE_HEADER) and refuses past it. Once this client gives up, the
// Supervisor starts copying /data, and a pre that ran after that (a request queued behind a stalled
// main thread) would rewrite ecoflow.db and shrink ecoflow.db-wal under tar. The grace lets a
// checkpoint that started on time finish before this client gives up.
const START_GRACE_MS = Math.min(2000, Math.floor(TIMEOUT_MS / 4));
// Same resolution as backupWindow.ts resolveBackupJournalPath (dataDir /data).
const journal = process.env.BACKUP_WINDOW_LOG
  || (existsSync('/share') ? '/share/ecoflow-panel/backup-window.jsonl' : '/data/backup-window.jsonl');

function note(rec) {
  try {
    mkdirSync(dirname(journal), { recursive: true });
    appendFileSync(journal, `${JSON.stringify({ ...rec, by: 'hook' })}\n`);
  } catch { /* nowhere left to write: stderr below still says what happened */ }
}

async function main() {
  const t0 = Date.now();
  if (phase !== 'pre' && phase !== 'post') {
    note({ phase: String(phase), ts: new Date().toISOString(), ok: false, error: 'usage: backupHook.mjs pre|post' });
    console.error('ecoflow-panel backup hook: usage: backupHook.mjs pre|post');
    return false;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/backup-window/${phase}`, {
      method: 'POST',
      headers: { 'x-backup-hook-deadline': String(t0 + TIMEOUT_MS - START_GRACE_MS) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) {
      note({ phase, ts: new Date().toISOString(), ok: false, status: res.status, elapsedMs: Date.now() - t0, error: body.slice(0, 300) });
      console.error(`ecoflow-panel backup ${phase}: server answered ${res.status}: ${body.slice(0, 300)}`);
      return false;
    }
    console.log(`ecoflow-panel backup ${phase}: ${body.slice(0, 1000)}`);
    return true;
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS} ms` : `server unreachable: ${e?.cause?.code ?? e?.message ?? e}`;
    note({ phase, ts: new Date().toISOString(), ok: false, elapsedMs: Date.now() - t0, error: why });
    console.error(`ecoflow-panel backup ${phase}: ${why} — the backup continues without the quiesce`);
    return false;
  }
}

// Backstop for anything that keeps the event loop alive past the fetch timeout.
const watchdog = setTimeout(() => {
  note({ phase: String(phase), ts: new Date().toISOString(), ok: false, error: 'watchdog: hook client overran' });
  process.exit(0);
}, TIMEOUT_MS + 2000);

main()
  .catch(() => false)
  .then(() => { clearTimeout(watchdog); process.exit(0); });
