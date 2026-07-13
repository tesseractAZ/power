/**
 * v0.9.25 — Alert-outcome capture.
 *
 * Foundation for the supervised-learning track. When an alert fires, the
 * operator's RESPONSE to it is the ground-truth label we need to train
 * our models. The options are:
 *
 *   - **ack**         "I saw it, it's real, I'm dealing with it"  → true positive
 *   - **dismiss**     "I saw it, it's noise, stop nagging me"      → false positive
 *   - **failed**      "this alert preceded an actual failure"      → strong true positive
 *   - **resolved**    "the system cleared the condition itself"    → ambiguous (left out of P/R)
 *
 * Stored as JSON Lines at `/data/alert-outcomes.jsonl` so it survives
 * restarts + is grep-friendly. Append-only — we keep history forever
 * because the labeled dataset grows in value over time.
 *
 * Companion to v0.9.6's `writeLog.ts` audit log. Same pattern, different
 * purpose: writes log captures WHAT WE DID; this log captures WHAT THE
 * USER THOUGHT OF WHAT WE TOLD THEM.
 */

import { appendFileSync, mkdirSync, existsSync, fstatSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { cleanText, cleanMultilineText, finiteNumber } from './logSanitize.js';

export type AlertOutcome = 'ack' | 'dismiss' | 'failed' | 'resolved';

export interface AlertOutcomeEntry {
  /** Outcome submission time. */
  ts: number;
  /** Stable alert identifier, e.g. "pack-hot-Y711...-3". */
  alertId: string;
  /** Alert category at the time of submission (for fast grouping). */
  category?: string;
  /** Severity at the time of submission (critical/warning/info). */
  severity?: string;
  /** Operator-supplied verdict. */
  outcome: AlertOutcome;
  /** Optional free-text note ("compressor kicked in", "false alarm — sensor flake"). */
  notes?: string;
  /** Snapshot of the feature vector at alert-fire time, if available.
   *  Captured by featureSnapshot.ts. Letting future model-training code
   *  replay the exact inputs that produced this alert. */
  features?: Record<string, number>;
  /**
   * v0.9.59 — Normalized LR feature vector at alert-fire time (when the
   * alert is pack-level and `extractFeatures` could resolve the pack).
   * onlineLR.snapshotToLrFeatures prefers these over reconstructing
   * from `features` — they're the actual values the model SAW, not a
   * proxy derived after the fact.
   */
  lrFeatures?: Record<string, number> | null;
  /** When the alert was first observed (so we can compute time-to-action). */
  alertFiredAt?: number;
  /** Source of the submission. */
  source: { ip?: string; ua?: string };
}

const PATH = process.env.ALERT_OUTCOMES_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'alert-outcomes.jsonl');

const TAIL_MAX_BYTES = 1024 * 1024; // up to 1 MB tail re-read for stats

let initialized = false;
function ensureDir() {
  if (initialized) return;
  mkdirSync(dirname(PATH), { recursive: true });
  initialized = true;
}

/* ─── content sanitization (CodeQL js/http-to-file-access) ──────────────
 * PATH is a fixed constant (env override or a config-derived sibling of the
 * DB) — the PATH is never request-influenced. The CONTENT carries operator
 * input BY DESIGN (the outcome capture IS the labeled dataset), so instead of
 * writing the request-built object verbatim we re-serialize an explicit typed
 * shape: known fields only, the outcome allow-listed to fresh literals,
 * numbers coerced finite, strings control-stripped and length-bounded. */

/** Feature maps: bounded key count, cleaned keys, finite numeric values only. */
function cleanFeatureMap(v: Record<string, number> | undefined | null): Record<string, number> | undefined {
  if (v == null || typeof v !== 'object') return undefined;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [k, raw] of Object.entries(v)) {
    if (++count > 64) break;
    const n = Number(raw);
    const key = cleanText(k, 64);
    if (key !== undefined && Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/** Re-serialize into the explicit AlertOutcomeEntry shape. Backward-compatible:
 *  same field names, same JSONL row — loaders (tail/readAll) are unchanged. */
function sanitizeOutcomeEntry(entry: AlertOutcomeEntry): AlertOutcomeEntry {
  // Allow-list the verdict into a fresh literal (index.ts validates before
  // calling; 'resolved' is the neutral fallback for anything unexpected).
  const outcome: AlertOutcome =
    entry.outcome === 'ack' ? 'ack'
    : entry.outcome === 'dismiss' ? 'dismiss'
    : entry.outcome === 'failed' ? 'failed'
    : 'resolved';
  return {
    ts: finiteNumber(entry.ts) ?? Date.now(),
    alertId: cleanText(entry.alertId, 200) ?? '',
    category: cleanText(entry.category, 64),
    severity: cleanText(entry.severity, 32),
    outcome,
    // Free text — keeps operator-typed newlines/tabs, strips other controls.
    // 500 matches the clamp the API route already applies.
    notes: cleanMultilineText(entry.notes, 500),
    features: cleanFeatureMap(entry.features),
    // Preserve the tri-state: undefined = key omitted (pre-v0.9.59 rows),
    // null = explicitly "no LR vector" — both round-trip as before.
    lrFeatures: entry.lrFeatures === null ? null : cleanFeatureMap(entry.lrFeatures),
    alertFiredAt: finiteNumber(entry.alertFiredAt),
    source: {
      ip: cleanText(entry.source?.ip, 64),
      ua: cleanText(entry.source?.ua, 256),
    },
  };
}

/** Append one outcome. Synchronous — submissions are infrequent + must
 *  durable-by-EOF before we acknowledge to the client. */
export function appendAlertOutcome(entry: AlertOutcomeEntry): void {
  try {
    ensureDir();
    appendFileSync(PATH, JSON.stringify(sanitizeOutcomeEntry(entry)) + '\n');
  } catch (e: any) {
    // Don't crash the API on a disk-full or permission error; surface but continue.
    console.error(`alertOutcomes: append failed: ${e?.message ?? e}`);
  }
}

/** Tail the most recent N entries (newest first). */
export function tailAlertOutcomes(limit = 100): AlertOutcomeEntry[] {
  // TOCTOU hardening (CodeQL js/file-system-race): open FIRST, then fstat the
  // HANDLE — size and read come from the same inode, and a missing file just
  // throws ENOENT out of openSync (→ []), same as the old existsSync probe.
  let fd: number;
  try {
    fd = openSync(PATH, 'r');
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - TAIL_MAX_BYTES);
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_MAX_BYTES));
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    const startNL = start > 0 ? text.indexOf('\n') + 1 : 0;
    const usable = text.slice(startNL);
    const lines = usable.split('\n').filter((l) => l.trim().length > 0);
    const parsed: AlertOutcomeEntry[] = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line) as AlertOutcomeEntry); } catch { /* skip */ }
    }
    return parsed.slice(-limit).reverse();
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** Read every entry in the log — small enough for our use case
 *  (operator-paced submissions, max ~thousands/yr). */
export function readAllAlertOutcomes(): AlertOutcomeEntry[] {
  if (!existsSync(PATH)) return [];
  try {
    const text = readFileSync(PATH, 'utf-8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const out: AlertOutcomeEntry[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line) as AlertOutcomeEntry); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

/* ─── stats aggregation ──────────────────────────────────────────── */

/** Per-alert-family stats. The "family" is the alert ID with any device-
 *  specific suffix stripped, so e.g. `pack-hot-Y711...-3` rolls up under
 *  `pack-hot` and we can ask "how often are pack-hot alerts real?" */
export interface AlertFamilyStats {
  family: string;
  total: number;
  ack: number;            // TP candidates
  dismiss: number;        // FP candidates
  failed: number;         // strong TP (preceded actual failure)
  resolved: number;       // ambiguous (excluded from precision)
  /** Precision = (ack + failed) / (ack + failed + dismiss). */
  precision: number | null;
  /** Median time-to-action (ms). Useful for "operators are quick to ack X" insight. */
  medianTimeToActionMs: number | null;
  lastSeenAt: number;
}

/**
 * Roll an alert ID up to its family by splitting on `-` and stopping at
 * the first token containing an uppercase letter. Our alert-family
 * convention is all-lowercase (`pack-hot`, `cell-imbalance`); device
 * suffixes are always uppercase serials (`Y711ZAB...`). This lets a
 * thin extra `-N` (pack number) at the very end stay in the family
 * because it has no uppercase, but stripped device serials drop out.
 */
/**
 * v0.13.2 — Families whose underlying condition is CONTINUOUSLY-ACTIVE /
 * persistent rather than a transient event. v1.19.0 (F20) note: snapshots
 * now re-capture on every RISE, so for a persistent condition `alertFiredAt`
 * refreshes at each process restart's boot re-rise — on this daily-rebooting
 * host it reads roughly "time since last boot", and pre-F20 jsonl entries
 * (first-ever-fire stamps, up to 618 h stale) coexist with post-F20 entries
 * in the same log. Either way the ratio `ts - alertFiredAt` does NOT measure
 * operator response for a permanently-true condition, so the exclusion below
 * stands — it is now justified by mixed/boot-relative semantics rather than
 * by the old never-refreshed premise. The 7-day audit (P2-6)
 * saw `medianTimeToActionMs` of 9.44 days for `offline` and 13.18 days for
 * `grid-offgrid` — pure condition-age, not response latency. We exclude
 * these from the time-to-action metric (return null) rather than report a
 * meaningless number; null is the honest answer for a permanently-true
 * condition. Transient families (soc-low, ems-volt, pack-hot, …) re-arm on
 * each fresh fire, so their alertFiredAt tracks the real event start and the
 * metric stays meaningful.
 */
const PERSISTENT_FAMILIES = new Set<string>([
  'offline',
  'grid-offgrid',
]);

export function familyOf(alertId: string): string {
  const parts = alertId.split('-');
  const familyParts: string[] = [];
  for (const p of parts) {
    if (/[A-Z]/.test(p)) break;
    familyParts.push(p);
  }
  if (familyParts.length === 0) return alertId;
  // Drop a trailing all-digits token (typically a pack number) so
  // `pack-hot-3` and `pack-hot-7` roll up under `pack-hot`.
  while (familyParts.length > 1 && /^\d+$/.test(familyParts[familyParts.length - 1])) {
    familyParts.pop();
  }
  return familyParts.join('-');
}

export function computeFamilyStats(): AlertFamilyStats[] {
  const entries = readAllAlertOutcomes();
  const grouped = new Map<string, AlertOutcomeEntry[]>();
  for (const e of entries) {
    const fam = familyOf(e.alertId);
    let arr = grouped.get(fam);
    if (!arr) { arr = []; grouped.set(fam, arr); }
    arr.push(e);
  }
  const out: AlertFamilyStats[] = [];
  for (const [family, arr] of grouped) {
    let ack = 0, dismiss = 0, failed = 0, resolved = 0;
    const ttas: number[] = [];
    let lastSeenAt = 0;
    for (const e of arr) {
      if (e.outcome === 'ack') ack++;
      else if (e.outcome === 'dismiss') dismiss++;
      else if (e.outcome === 'failed') failed++;
      else if (e.outcome === 'resolved') resolved++;
      if (e.ts > lastSeenAt) lastSeenAt = e.ts;
      if (e.alertFiredAt && e.ts) ttas.push(e.ts - e.alertFiredAt);
    }
    const realCount = ack + failed;
    const decidedCount = ack + failed + dismiss;
    const precision = decidedCount > 0 ? realCount / decidedCount : null;
    ttas.sort((a, b) => a - b);
    // v0.13.2 — null out time-to-action for continuously-active families:
    // their alertFiredAt is the condition's first-ever fire, so the delta is
    // condition-age, not operator response time (audit P2-6).
    const medianTTA = PERSISTENT_FAMILIES.has(family)
      ? null
      : (ttas.length ? ttas[Math.floor(ttas.length / 2)] : null);
    out.push({
      family,
      total: arr.length,
      ack, dismiss, failed, resolved,
      precision,
      medianTimeToActionMs: medianTTA,
      lastSeenAt,
    });
  }
  // Sort: most-noisy families (lowest precision) first, then by total descending.
  out.sort((a, b) => {
    const pa = a.precision ?? 1; // unknown → assume real
    const pb = b.precision ?? 1;
    if (pa !== pb) return pa - pb;
    return b.total - a.total;
  });
  return out;
}
