/**
 * v1.187.20 — hold SQLite checkpoints still while a Home Assistant backup copies /data.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Supervisor backs this add-on up HOT: it tars `/data` while the add-on runs, one file after
 * another, with no pause. `/data/ecoflow.db` is a WAL database (recorder.ts), so the copy is three
 * files — `ecoflow.db`, `ecoflow.db-wal`, `ecoflow.db-shm` — read at different moments. When a
 * checkpoint moves WAL pages into the main file while tar is part-way through it, the copied main
 * file mixes old and new pages and the copied WAL no longer covers the difference. A restore of
 * that backup opens a damaged database ("database disk image is malformed", "row missing from
 * index"). The 2026-10-03 bench reproduced it in 19 of 20 copies taken while checkpoints ran, and
 * in 0 of 40 copies taken with checkpoints held still. dbExport.ts makes the same point about a
 * non-atomic three-file copy.
 *
 * A COLD backup would avoid it by stopping the add-on, which stops the alarm engine for the length
 * of the copy every night. Instead the add-on declares `backup_pre` / `backup_post` (config.yaml),
 * which the Supervisor runs with `docker exec` inside the running container just before and just
 * after it copies `/data` (supervisor/apps/app.py begin_backup / end_backup, 2026.09.3). Both run
 * `/usr/bin/ecoflow-panel-backup-hook`, which calls the two loopback-only routes below.
 *
 *   pre:  PRAGMA wal_checkpoint(TRUNCATE)  — fold the WAL into the main file and empty it, so the
 *                                             copy starts from a small WAL;
 *         PRAGMA wal_autocheckpoint = 0     — no automatic checkpoint until `post`. While no
 *                                             checkpoint runs, SQLite never writes the main file
 *                                             (commits only append to the WAL), so the main file tar
 *                                             reads cannot change under it, and the WAL it reads is a
 *                                             valid prefix of committed frames.
 *         a dead-man timer (10 min)         — restores the checkpoint setting if `post` never
 *                                             arrives (a crashed backup), so the WAL cannot grow
 *                                             without bound.
 *   post: PRAGMA wal_autocheckpoint = RECORDER_WAL_AUTOCHECKPOINT, then wal_checkpoint(PASSIVE).
 *
 * WHICH CONNECTION. `wal_autocheckpoint` is a per-connection setting, and an automatic checkpoint
 * is run by the connection that commits. The recorder's main-thread connection is the only one
 * that commits: the analytics worker's connection is `query_only` (readRecorder.ts) and the export
 * worker runs `VACUUM INTO`, which reads the source. So the setting is applied to the recorder's
 * connection, on the main thread, where the route handlers and the dead-man timer also run. There
 * is no await between the checkpoint and the freeze.
 *
 * A LATE PRE IS REFUSED. The hook client gives up after 8 s and exits 0, and the Supervisor then
 * starts copying /data at once. A request it abandoned can still reach the pre handler afterwards:
 * when the main thread stalls, Fastify parses the queued request and runs the handler once the loop
 * frees, with the socket not yet seen as closed. A pre that ran then would checkpoint into
 * `ecoflow.db` and TRUNCATE `ecoflow.db-wal` to 0 bytes while tar reads them — a torn copy, or a
 * WAL that shrinks under tar (tarfile "unexpected end of data", which drops the add-on from that
 * backup). So the client sends BACKUP_DEADLINE_HEADER, the moment by which pre must START (its own
 * give-up time less a grace, so a checkpoint started on time ends before it gives up), and pre
 * refuses past it, or when the request's socket is already closed: no checkpoint, no freeze, no
 * dead-man, one `ok:false` "client gone" journal line, a warning, and 409. That backup's copy is
 * then unquiesced, as every copy was before v1.187.20, and the post line that follows says so
 * (`preRefused`) instead of reporting that no pre hook was seen. `post` is never refused: it only
 * restores, and it runs after the copy.
 *
 * EVIDENCE. A `docker exec`'d hook's stdout never reaches the add-on log (Switchboard v0.58.1), so
 * every phase appends one JSON line to `/share/ecoflow-panel/backup-window.jsonl` (`/share` is
 * mapped read-write; `/data/backup-window.jsonl` when it is not) and logs through the server log.
 * GET /api/backup-window reports the recorder connection's live `wal_autocheckpoint`, which no
 * other connection can read.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The recorder connection's automatic-checkpoint threshold in pages (SQLite's default, set
 *  explicitly at open in recorder.ts). The post hook and the dead-man restore THIS value. */
export const RECORDER_WAL_AUTOCHECKPOINT = 1000;

/** How long a window may stay open without its post hook before checkpoints are restored. */
export const BACKUP_DEAD_MAN_MS = 10 * 60_000;

/** Where the hook routes live. Loopback-only: see requireLoopbackPeer. */
export const BACKUP_WINDOW_ROUTE = '/api/internal/backup-window';

/** Request header from the hook client (backupHook.mjs): the epoch-ms moment by which `pre` must
 *  START. Past it the client may have given up and the Supervisor may be copying /data. */
export const BACKUP_DEADLINE_HEADER = 'x-backup-hook-deadline';

/** The journal is capped: past this size it is rotated to `<path>.1` (two lines a night). */
export const BACKUP_JOURNAL_MAX_BYTES = 1024 * 1024;

export type CheckpointMode = 'PASSIVE' | 'TRUNCATE';

export interface CheckpointResult {
  /** 1 when a reader or writer kept the checkpoint from finishing (it never waits: busy timeout 0). */
  busy: number;
  /** WAL frames before the checkpoint (0 after a successful TRUNCATE, which resets the WAL). */
  log: number;
  checkpointed: number;
}

/** The WAL controls the backup window needs from the recorder's connection. */
export interface WalControl {
  checkpoint(mode: CheckpointMode): CheckpointResult;
  /** Sets `PRAGMA wal_autocheckpoint` and returns the value read back. */
  setAutocheckpoint(pages: number): number;
  autocheckpoint(): number;
  /** Size of `<db>-wal` in bytes, or null when the file does not exist. */
  walBytes(): number | null;
}

interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: never[]): unknown };
}

/** WalControl over one node:sqlite connection. recorder.ts builds it over its write connection. */
export function walControlFor(db: SqliteHandle, dbPath: string): WalControl {
  const autocheckpoint = (): number =>
    Number((db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint);
  return {
    checkpoint: (mode) => {
      // The mode is interpolated into the statement, so only the two literals ever reach it.
      if (mode !== 'PASSIVE' && mode !== 'TRUNCATE') throw new Error(`unsupported checkpoint mode: ${String(mode)}`);
      const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as CheckpointResult;
      return { busy: Number(r.busy), log: Number(r.log), checkpointed: Number(r.checkpointed) };
    },
    setAutocheckpoint: (pages) => {
      db.exec(`PRAGMA wal_autocheckpoint = ${Math.max(0, Math.trunc(pages))}`);
      return autocheckpoint();
    },
    autocheckpoint,
    walBytes: () => {
      try { return statSync(`${dbPath}-wal`).size; } catch { return null; }
    },
  };
}

/**
 * True only for a TCP peer on this container's own loopback: 127.0.0.1, its IPv4-mapped form
 * (the server listens dual-stack on `::`) and ::1. Ingress arrives from the Supervisor
 * (172.30.32.x) and the published :8787 port from the client's LAN address; neither can present a
 * loopback source (Linux drops a packet with a 127/8 source on any interface but `lo`).
 */
export function isLoopbackPeer(addr: string | undefined | null): boolean {
  return addr === '127.0.0.1' || addr === '::ffff:127.0.0.1' || addr === '::1';
}

/**
 * Route-level onRequest hook for the hook routes. It reads the raw socket peer, never `req.ip` or a
 * forwarding header, so it stays correct even if trustProxy is ever turned on. It runs at the
 * route's first hook, while the socket is still open: a closed socket no longer reports its peer
 * unless it was read before (Node caches it then), so a client that leaves later still reaches the
 * pre handler as a loopback peer and is refused and journaled there as "client gone".
 */
export function requireLoopbackPeer(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  if (isLoopbackPeer(req.socket?.remoteAddress)) return done();
  reply.code(403).send({ ok: false, error: 'the backup-window hooks are reachable from loopback only' });
}

/** `/share/ecoflow-panel/backup-window.jsonl` when /share is mapped, else `<dataDir>/backup-window.jsonl`.
 *  BACKUP_WINDOW_LOG overrides both (tests). server/src/backupHook.mjs resolves the same paths. */
export function resolveBackupJournalPath(opts: { dataDir: string; shareRoot?: string; env?: NodeJS.ProcessEnv }): string {
  const env = opts.env ?? process.env;
  if (env.BACKUP_WINDOW_LOG) return env.BACKUP_WINDOW_LOG;
  const shareRoot = opts.shareRoot ?? '/share';
  return existsSync(shareRoot) ? join(shareRoot, 'ecoflow-panel', 'backup-window.jsonl') : join(opts.dataDir, 'backup-window.jsonl');
}

/** Append one JSON line. Best-effort: returns false instead of throwing. */
export function appendBackupJournal(path: string, rec: Record<string, unknown>): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    try { if (statSync(path).size > BACKUP_JOURNAL_MAX_BYTES) renameSync(path, `${path}.1`); } catch { /* absent: first line */ }
    appendFileSync(path, `${JSON.stringify(rec)}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface BackupWindowStatus {
  /** True between a pre hook and its post hook (or the dead-man). */
  windowOpen: boolean;
  openedAt: string | null;
  deadManDueAt: string | null;
  /** The recorder connection's live value, read now (null when the read fails). */
  autocheckpoint: number | null;
  restoreTo: number;
  journalPath: string;
  lastPre: Record<string, unknown> | null;
  lastPost: Record<string, unknown> | null;
  lastDeadMan: Record<string, unknown> | null;
}

/** What the pre route knows about the hook's request (see "A LATE PRE IS REFUSED"). */
export interface PreGuard {
  /** BACKUP_DEADLINE_HEADER, in epoch ms; null when the request carried none (a hand-run call). */
  deadlineMs?: number | null;
  /** The request's socket was already closed when the handler ran: the client has left. */
  clientGone?: boolean;
}

export interface BackupWindow {
  /** Refuses (ok:false, refused:true, nothing changed) when the guard says the client is gone. */
  pre(peer?: string, guard?: PreGuard): Record<string, unknown>;
  post(peer?: string): Record<string, unknown>;
  status(): BackupWindowStatus;
  /** Disarm the dead-man (shutdown). */
  stop(): void;
}

export interface BackupWindowOptions {
  wal: WalControl;
  journalPath: string;
  log: { info(m: string): void; warn(m: string): void };
  deadManMs?: number;
  restoreTo?: number;
  now?: () => number;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const kb = (n: number | null): string => (n == null ? 'absent' : `${(n / 1024).toFixed(1)} KB`);

export function createBackupWindow(opts: BackupWindowOptions): BackupWindow {
  const { wal, journalPath, log } = opts;
  const deadManMs = opts.deadManMs ?? BACKUP_DEAD_MAN_MS;
  const restoreTo = opts.restoreTo ?? RECORDER_WAL_AUTOCHECKPOINT;
  const now = opts.now ?? Date.now;

  let openedAtMs: number | null = null;
  let deadMan: ReturnType<typeof setTimeout> | null = null;
  let deadManDueMs: number | null = null;
  let lastPre: Record<string, unknown> | null = null;
  let lastPost: Record<string, unknown> | null = null;
  let lastDeadMan: Record<string, unknown> | null = null;
  /** The dead-man closed the current window before its post hook came. */
  let closedByDeadMan = false;
  /** When a pre was last refused (client gone), until an accepted pre or a post clears it: the
   *  post that follows reports that its copy ran unquiesced, not that no pre hook was seen. */
  let refusedPreAtMs: number | null = null;

  const disarm = () => {
    if (deadMan) clearTimeout(deadMan);
    deadMan = null;
    deadManDueMs = null;
  };

  /** Put the recorder's checkpoint setting back and fold the WAL in without waiting on readers. */
  const restore = () => {
    const out: Record<string, unknown> = {};
    try { out.autocheckpoint = wal.setAutocheckpoint(restoreTo); } catch (e) { out.autocheckpoint = null; out.autocheckpointError = errText(e); }
    try { out.checkpoint = wal.checkpoint('PASSIVE'); } catch (e) { out.checkpoint = null; out.checkpointError = errText(e); }
    out.walBytes = wal.walBytes();
    out.ok = out.autocheckpoint === restoreTo && out.checkpointError == null;
    return out;
  };

  const record = (rec: Record<string, unknown>) => {
    rec.journaled = appendBackupJournal(journalPath, rec);
    return rec;
  };

  const fireDeadMan = () => {
    deadMan = null;
    deadManDueMs = null;
    const t = now();
    const r = restore();
    const rec = record({ phase: 'deadman', ts: new Date(t).toISOString(), windowMs: openedAtMs == null ? null : t - openedAtMs, restoreTo, ...r });
    openedAtMs = null;
    closedByDeadMan = true;
    lastDeadMan = rec;
    log.warn(
      `backup-window: no post-backup hook within ${Math.round(deadManMs / 60_000)} min of the pre-backup hook — `
      + `WAL auto-checkpoint restored to ${String(r.autocheckpoint)} (a backup still copying /data may now be torn)`,
    );
  };

  return {
    pre(peer, guard) {
      const t = now();
      const deadlineMs = guard?.deadlineMs ?? null;
      const late = deadlineMs != null && t > deadlineMs;
      if (guard?.clientGone === true || late) {
        // The hook has given up and the Supervisor may already be copying /data: a TRUNCATE now
        // would rewrite ecoflow.db and shrink ecoflow.db-wal under tar. Change nothing.
        const reason = late
          ? `the hook's deadline passed ${t - (deadlineMs as number)} ms ago`
          : 'the hook connection was already closed';
        let autocheckpoint: number | null = null;
        try { autocheckpoint = wal.autocheckpoint(); } catch { /* reported as null */ }
        const rec = record({
          phase: 'pre', ts: new Date(t).toISOString(), peer: peer ?? null, ok: false, refused: true, error: 'client gone', reason,
          deadlineAt: deadlineMs == null ? null : new Date(deadlineMs).toISOString(), windowOpen: openedAtMs != null, autocheckpoint,
          walBytes: wal.walBytes(),
        });
        refusedPreAtMs = t;
        lastPre = rec;
        log.warn(`backup-window: pre refused — client gone (${reason}); no checkpoint and no freeze, so this backup copies /data `
          + `unquiesced (auto-checkpoint ${String(autocheckpoint)}${openedAtMs != null ? ', an earlier window is still open' : ''})`);
        return rec;
      }
      const rearmed = openedAtMs != null;
      const walBytesBefore = wal.walBytes();
      const rec: Record<string, unknown> = { phase: 'pre', ts: new Date(t).toISOString(), peer: peer ?? null, rearmed, walBytesBefore };
      try { rec.checkpoint = wal.checkpoint('TRUNCATE'); } catch (e) { rec.checkpoint = null; rec.checkpointError = errText(e); }
      try { rec.autocheckpoint = wal.setAutocheckpoint(0); } catch (e) { rec.autocheckpoint = null; rec.autocheckpointError = errText(e); }
      rec.walBytesAfter = wal.walBytes();
      // Armed even if the freeze failed: restoring an unchanged setting is harmless.
      disarm();
      deadMan = setTimeout(fireDeadMan, deadManMs);
      deadMan.unref?.();
      deadManDueMs = t + deadManMs;
      rec.deadManMs = deadManMs;
      openedAtMs = t;
      closedByDeadMan = false;
      refusedPreAtMs = null;
      rec.ok = rec.autocheckpoint === 0 && rec.checkpointError == null;
      record(rec);
      lastPre = rec;
      const cp = rec.checkpoint as CheckpointResult | null;
      const line = `backup-window: pre — WAL checkpoint(TRUNCATE) ${cp ? `busy=${cp.busy}` : `failed: ${String(rec.checkpointError)}`}, `
        + `WAL ${kb(walBytesBefore)} → ${kb(rec.walBytesAfter as number | null)}; auto-checkpoint ${String(rec.autocheckpoint)} `
        + `until the post hook (dead-man ${Math.round(deadManMs / 60_000)} min)${rearmed ? '; a window was already open' : ''}`;
      if (rec.ok) log.info(line); else log.warn(line);
      return rec;
    },

    post(peer) {
      const t = now();
      disarm();
      const preRefused = refusedPreAtMs != null;
      const hadPre = openedAtMs != null;
      const r = restore();
      const rec = record({ phase: 'post', ts: new Date(t).toISOString(), peer: peer ?? null, hadPre, deadManClosedWindow: closedByDeadMan, preRefused, windowMs: hadPre ? t - (openedAtMs as number) : null, restoreTo, ...r });
      refusedPreAtMs = null;
      openedAtMs = null;
      closedByDeadMan = false;
      lastPost = rec;
      const cp = rec.checkpoint as CheckpointResult | null;
      const tail = hadPre ? `; window ${Math.round((rec.windowMs as number) / 1000)} s`
        : rec.deadManClosedWindow ? '; the dead-man had already closed the window'
          : preRefused ? '; the pre hook was refused (client gone), so this copy was not quiesced'
            : '; no pre hook was seen';
      const line = `backup-window: post — auto-checkpoint ${String(rec.autocheckpoint)} (restored to ${restoreTo}), `
        + `WAL checkpoint(PASSIVE) ${cp ? `busy=${cp.busy} ${cp.checkpointed}/${cp.log} frames` : `failed: ${String(rec.checkpointError)}`}${tail}`;
      if (rec.ok) log.info(line); else log.warn(line);
      return rec;
    },

    status() {
      let autocheckpoint: number | null = null;
      try { autocheckpoint = wal.autocheckpoint(); } catch { /* reported as null */ }
      return {
        windowOpen: openedAtMs != null,
        openedAt: openedAtMs == null ? null : new Date(openedAtMs).toISOString(),
        deadManDueAt: deadManDueMs == null ? null : new Date(deadManDueMs).toISOString(),
        autocheckpoint,
        restoreTo,
        journalPath,
        lastPre,
        lastPost,
        lastDeadMan,
      };
    },

    stop() { disarm(); },
  };
}

/**
 * The pre route's guard: the hook's deadline header (digits only, else none) and whether the
 * request's socket is already closed. The socket check alone cannot see a client that gave up
 * during a main-thread stall: the handler runs in the same tick that parses the queued request,
 * before the close is read, so the deadline is the check that holds there.
 */
export function preGuardFor(req: FastifyRequest): PreGuard {
  const raw = req.headers[BACKUP_DEADLINE_HEADER];
  const deadlineMs = typeof raw === 'string' && /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : null;
  return { deadlineMs, clientGone: req.raw.socket?.destroyed === true };
}

/**
 * POST <route>/pre and /post (loopback-only, called by the hook) and GET /api/backup-window
 * (read-only status, for verification from outside the container). A refused pre answers 409.
 */
export function registerBackupWindowRoutes(app: FastifyInstance, bw: BackupWindow): void {
  app.post(`${BACKUP_WINDOW_ROUTE}/pre`, { onRequest: requireLoopbackPeer }, async (req, reply) => {
    const rec = bw.pre(req.socket?.remoteAddress, preGuardFor(req));
    if (rec.refused === true) reply.code(409);
    return rec;
  });
  app.post(`${BACKUP_WINDOW_ROUTE}/post`, { onRequest: requireLoopbackPeer }, async (req) => bw.post(req.socket?.remoteAddress));
  app.get('/api/backup-window', async () => ({ ok: true, ...bw.status() }));
}
