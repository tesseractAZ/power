/**
 * redReplayGate.ts — v1.64.0. Identity-aware suppression of the post-restart
 * RED re-announce.
 *
 * WHY THIS EXISTS (measured, not hypothetical)
 * --------------------------------------------
 * `critical_alerts` has sat at >= 1 for 98.8 % of live coverage because Core 3
 * Pack 1 carries a standing "Battery protection fault". A RED is never a
 * restart-continuation (broadcast.isRestartContinuation returns false for red,
 * deliberately), so EVERY add-on restart re-speaks that same standing fault
 * aloud. On 2026-08-03 five deploys produced five klaxons in four hours (5 of 5
 * restarts, 61-237 s after each); on 2026-08-02, 10 of 11 restarts did the same.
 * The annunciation was correct in isolation and useless in aggregate: the
 * household learned to ignore the loudest tone the system has.
 *
 * WHAT IS AND IS NOT SUPPRESSED
 * -----------------------------
 * A red still replays at reboot. It is suppressed ONLY when ALL of these hold:
 *
 *   1. we are inside the post-boot warm-up window (msSinceBoot < windowMs) —
 *      outside it this gate is inert and today's behaviour applies verbatim;
 *   2. the last VERIFIED-successful broadcast of any level was itself a RED, so
 *      this red is NOT an escalation (same rank ladder as the storm gate);
 *   3. the critical that WOULD BE SPOKEN now has the same FINGERPRINT as the one
 *      that WAS spoken at the last successful red announcement;
 *   4. every active counted critical's fingerprint was already in the set present
 *      at that announcement — nothing new has appeared alongside it; and
 *   5. that announcement was less than RED_REPLAY_MIN_GAP_MS (30 min, the
 *      operator's explicit choice) ago.
 *
 * Anything else => announce. A new/changed fault => announce immediately,
 * whatever the timer says. >= 30 min since the last red => announce. A green in
 * between wipes the state entirely => announce.
 *
 * ★★★ WHY A FINGERPRINT, NOT THE BARE ALERT ID
 * --------------------------------------------
 * An alert `id` names the SOURCE, not the FAULT. `dpu-err-<sn>` is emitted for
 * EVERY value of `sysErrCode` — alerts.ts holds the id constant on purpose so a
 * standing fault does not re-raise on upgrade, and flips only the TITLE between
 * "Battery protection fault" (5xx band) and "Inverter error code".
 * `shp2-src-err-<slot>` is worse: its title never varies at all. So the standing
 * Core-3 fault clearing and a DIFFERENT, real fault appearing on the same device
 * are the SAME id — and DPU_ERR_DEBOUNCE_MS (3 min, re-baselined on a code
 * change) means drop -> 3 min -> re-raise-with-a-new-code fits comfortably inside
 * the 10-minute boot window. A gate keyed on the bare id would mute that.
 *
 * The fingerprint is `id + title + fault` (see alertFingerprint). `fault` is the
 * discrete device-reported error code, threaded out explicitly by alerts.ts.
 * Deliberately NOT folded in: `detail` and `facts`, because several critical
 * details carry LIVE measurements (`vdiff-crit` prints `cell spread <n> mV`,
 * which moves every tick; `soh-crit` prints a percentage). Hashing those would
 * make every fingerprint unique and turn this whole gate into a silent no-op —
 * the failure mode that looks like it works and never suppresses anything.
 *
 * ★★★ WHY THE SPOKEN ONE, NOT ALL OF THEM
 * ---------------------------------------
 * ttsService.buildAlertMessage voices exactly ONE alert: pickPrimaryAlert's
 * choice. With two criticals active the second is never named aloud. Recording
 * "every critical that was active" would therefore file a never-spoken critical
 * as already-announced, and a post-restart red consisting solely of that critical
 * would be muted. The gate records and compares the SPOKEN fingerprint.
 *
 * ★★★ FAIL OPEN, ALWAYS
 * ---------------------
 * Missing, unreadable, corrupt, type-invalid, or future-dated state => announce
 * (today's behaviour). The gate can only ever REMOVE an announcement when it has
 * positive, well-formed evidence that this exact fault was spoken aloud minutes
 * ago. Every unknown resolves toward noise, never toward silence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { config } from './config.js';
import type { Alert } from './alerts.js';
import { pickPrimaryAlert } from './ttsService.js';

/** The broadcast condition ladder. Same three values as broadcast.ConditionLevel. */
export type BroadcastLevel = 'green' | 'yellow' | 'red';

/**
 * ★ THE rank ladder — ONE definition, shared. broadcast.ts imports this for its
 * storm gate ("escalations always play") instead of keeping a private copy, so
 * the replay gate's escalation carve-out and the storm gate's can never drift
 * apart into two different opinions about what an escalation is.
 */
export const LEVEL_RANK: Record<BroadcastLevel, number> = { green: 0, yellow: 1, red: 2 };

/** True when moving to `to` is a rise in severity. Unknown history => escalation. */
export function isLevelEscalation(from: BroadcastLevel | null, to: BroadcastLevel): boolean {
  return from == null || LEVEL_RANK[to] > LEVEL_RANK[from];
}

/** Field separator — ASCII UNIT SEPARATOR (U+001F), which no alert id, title or
 *  error code can contain, so two different field splits can never collide into
 *  the same fingerprint string. */
const FP_SEP = '\u001f';

/**
 * The identity of a FAULT, not of a source.
 *
 * `id`    — the source (device/slot/pack). Necessary, never sufficient.
 * `title` — flips when the meaning changes ("Battery protection fault" vs
 *           "Inverter error code" on the same dpu-err id). A fixed vocabulary
 *           string; it never carries a measurement.
 * `fault` — the discrete device-reported error code, threaded out by alerts.ts
 *           precisely because a code change is a different fault under the same
 *           id. Absent for alerts whose id already names exactly one fault.
 *
 * All three are stable for an unchanged fault and change when the fault changes.
 * Nothing that drifts tick-to-tick is folded in — see the file header.
 */
export function alertFingerprint(a: { id: string; title: string; fault?: string }): string {
  return `${a.id}${FP_SEP}${a.title}${FP_SEP}${a.fault ?? ''}`;
}

/** Human-readable rendering of a fingerprint, for the log line only. */
export function describeFingerprint(fp: string): string {
  return fp.split(FP_SEP).filter((s) => s.length > 0).join(' / ');
}

/**
 * ★ Shape check — a fingerprint is exactly three separator-delimited fields.
 *
 * DEFENCE IN DEPTH, and it fails in the safe direction. If a caller ever hands
 * this gate bare alert IDS instead of fingerprints — the precise defect this
 * module exists to prevent, and a one-word edit away at the call site — the ids
 * fail this check, the gate can never prove sameness, and it degrades to
 * "always announce". A miswired gate becomes a NO-OP, never a mute.
 */
export function isFingerprint(s: string): boolean {
  return s.split(FP_SEP).length === 3;
}

/**
 * The fingerprint of the ONE critical an observation would actually SAY ALOUD.
 *
 * ★ This is the single seam between "what the broadcast will speak" and "what
 * the gate compares": it calls the very function the message synthesiser calls
 * (ttsService.pickPrimaryAlert) on the very array the synthesiser will be given,
 * so the two cannot answer differently. null = nothing would be named (not red,
 * or every critical is non-annunciating), which the gate treats as "cannot prove
 * sameness" ⇒ announce.
 */
export function voicedRedFingerprint(level: BroadcastLevel, alerts: Alert[]): string | null {
  if (level !== 'red') return null;
  const primary = pickPrimaryAlert(alerts, 'red');
  return primary == null ? null : alertFingerprint(primary);
}

/**
 * Committing this condition level must DESTROY the red-replay evidence.
 *
 * Green is an all-clear: whatever red comes next is a new event, not a replay of
 * the one announced before it — including a critical that clears and re-raises
 * inside the 30-minute gap. Pure + exported so the rule is pinned by a test
 * instead of living only in a one-line `if` inside the monitor.
 */
export function clearsRedReplayEvidence(level: BroadcastLevel): boolean {
  return level === 'green';
}

/** What survives the restart. Written only when a broadcast actually played. */
export interface RedAnnounceState {
  /** Wall-clock ms of the last VERIFIED-successful red announcement. */
  lastRedAnnouncedAtMs: number;
  /** Fingerprint of the ONE critical that was actually SPOKEN in it. */
  voicedFingerprint: string;
  /** Fingerprints of every counted critical active at that announcement. */
  activeFingerprints: string[];
  /**
   * Level of the last VERIFIED-successful broadcast of ANY level. A yellow
   * played after that red demotes this, and a later red is then an ESCALATION —
   * which is never suppressed.
   */
  lastPlayedLevel: BroadcastLevel;
}

function isLevel(v: unknown): v is BroadcastLevel {
  return v === 'green' || v === 'yellow' || v === 'red';
}

/**
 * Validate a parsed state object. Anything malformed returns null, and null
 * means ANNOUNCE — see the fail-open note in the file header. Exported for tests.
 */
export function parseRedAnnounceState(raw: unknown): RedAnnounceState | null {
  if (raw == null || typeof raw !== 'object') return null;
  const s = raw as Partial<RedAnnounceState>;
  if (typeof s.lastRedAnnouncedAtMs !== 'number') return null;
  if (!Number.isFinite(s.lastRedAnnouncedAtMs) || s.lastRedAnnouncedAtMs <= 0) return null;
  // ★ The voiced record must be a well-formed FINGERPRINT, not merely a string.
  // This is also the migration path: state written by any earlier shape (e.g. the
  // bare-id `criticalIds` draft) fails to parse and therefore ANNOUNCES.
  if (typeof s.voicedFingerprint !== 'string' || !isFingerprint(s.voicedFingerprint)) return null;
  if (!Array.isArray(s.activeFingerprints)) return null;
  if (!s.activeFingerprints.every((f) => typeof f === 'string' && isFingerprint(f))) return null;
  if (!isLevel(s.lastPlayedLevel)) return null;
  return {
    lastRedAnnouncedAtMs: s.lastRedAnnouncedAtMs,
    voicedFingerprint: s.voicedFingerprint,
    activeFingerprints: [...s.activeFingerprints],
    lastPlayedLevel: s.lastPlayedLevel,
  };
}

/**
 * The operator's explicit choice: a standing red re-announces at reboot, but not
 * if it was already announced less than this ago. Env-tunable like the warm-up
 * window it pairs with (BROADCAST_BOOT_WARMUP_MS).
 */
export const RED_REPLAY_MIN_GAP_MS =
  Number(process.env.BROADCAST_RED_REPLAY_MIN_GAP_MS) || 30 * 60 * 1000;

export interface RedReplayInputs {
  /** The condition level this tick would broadcast. */
  observed: BroadcastLevel;
  /**
   * Fingerprint of the critical that WOULD BE SPOKEN now — i.e. of
   * ttsService.pickPrimaryAlert's choice over the same alert array the broadcast
   * will use. null = nothing would be named => we cannot prove sameness.
   */
  voicedFingerprint: string | null;
  /** Fingerprints of the CRITICAL alerts counted into that level. */
  activeFingerprints: readonly string[];
  /** Persisted pre-restart evidence; null = none/corrupt => announce. */
  persisted: RedAnnounceState | null;
  msSinceBoot: number;
  nowMs: number;
  windowMs: number;
  minGapMs: number;
}

/**
 * The whole decision, pure and exported for tests. Returns true = SUPPRESS this
 * red re-announce. Every early return is an "announce" (fail-open) branch.
 */
export function isRedReplaySuppressed(i: RedReplayInputs): boolean {
  // Only red is ours. Yellow/green continuation stays entirely with
  // broadcast.isRestartContinuation — this gate must not touch it.
  if (i.observed !== 'red') return false;
  // (1) Outside the warm-up window the gate is inert: a red that transitions
  // hours into a run is a live event, not a restart replay.
  if (i.msSinceBoot >= i.windowMs) return false;
  // No evidence => announce. Missing/corrupt state can NEVER suppress. A green
  // in between deletes the state outright, so an all-clear lands here too.
  if (i.persisted == null) return false;
  // A red with no identifiable critical fingerprints is incoherent (red implies
  // crit > 0). We cannot prove it is the same fault, so we announce.
  if (i.activeFingerprints.length === 0) return false;
  // Nothing would be named aloud => we cannot prove this is what was already
  // heard. Announce.
  if (i.voicedFingerprint == null) return false;
  // Not actually fingerprints (a caller passed bare ids) => same conclusion. See
  // isFingerprint: a miswired gate degrades to a no-op, never to a mute.
  if (!isFingerprint(i.voicedFingerprint)) return false;
  if (!i.activeFingerprints.every(isFingerprint)) return false;
  // (2) ESCALATION CARVE-OUT — mirrors the storm gate ("escalations always
  // play") through the one shared rank ladder. If the last thing actually played
  // was below red, this red is a RISE, and a rise is never a replay.
  if (isLevelEscalation(i.persisted.lastPlayedLevel, 'red')) return false;
  // (3) IDENTITY OF THE SPOKEN ALERT: the critical that would be voiced now must
  // be the very one that was voiced then. A different error code, a different
  // title, a different source => a different fault => announce NOW, whatever the
  // timer says.
  if (i.voicedFingerprint !== i.persisted.voicedFingerprint) return false;
  // (4) NOTHING NEW ALONGSIDE IT. The spoken alert matching is not enough on its
  // own: a second critical could have appeared that does not outrank it and so
  // would never be named. It is not evidence of "already heard" — it is evidence
  // that something changed. Announce. (This condition can only ever ADD
  // announcements; it is never sufficient by itself to suppress one.)
  const known = new Set(i.persisted.activeFingerprints);
  if (!i.activeFingerprints.every((f) => known.has(f))) return false;
  // (5) TIMER: only the last RED_REPLAY_MIN_GAP_MS of quiet earns silence.
  const elapsed = i.nowMs - i.persisted.lastRedAnnouncedAtMs;
  // Negative elapsed = persisted timestamp is in the future (clock stepped
  // backwards before NTP settled — routine on a Pi with no RTC). We cannot
  // measure the gap, so we announce.
  if (elapsed < 0) return false;
  return elapsed < i.minGapMs;
}

/**
 * Whether a finished broadcast may be recorded as "this red was announced".
 *
 * ★ `dispatchOk` is load-bearing. It mirrors the bootBaselineLevel rule in
 * broadcast.ts: only a VERIFIED-successful dispatch proves the operator heard it.
 * Recording a partial/failed dispatch would let a broadcast nobody heard buy 30
 * minutes of silence for the fault it failed to announce. Pure + exported so that
 * requirement is pinned by a test rather than by a reviewer's attention.
 */
export function isRecordableRedAnnounce(level: BroadcastLevel, dispatchOk: boolean): boolean {
  return level === 'red' && dispatchOk;
}

export interface RedReplayGate {
  /** True = suppress this red re-announce (every condition holds). */
  shouldSuppress(p: {
    observed: BroadcastLevel;
    voicedFingerprint: string | null;
    activeFingerprints: readonly string[];
    msSinceBoot: number;
    nowMs: number;
  }): boolean;
  /** Record a VERIFIED-successful red announcement so the next boot can see it. */
  noteRedAnnounced(p: {
    voicedFingerprint: string;
    activeFingerprints: readonly string[];
    nowMs: number;
  }): void;
  /**
   * Record a VERIFIED-successful broadcast at a level BELOW red. It demotes
   * lastPlayedLevel, so the next red reads as an escalation and always plays.
   */
  notePlayedBelowRed(level: BroadcastLevel): void;
  /**
   * The condition reached GREEN. An all-clear means the next red is a NEW event,
   * so the evidence is destroyed — in memory AND on disk.
   */
  noteConditionGreen(): void;
  /** Current in-memory view of the persisted state (tests/diagnostics). */
  state(): RedAnnounceState | null;
}

export interface RedReplayGateOptions {
  /** Override the persistence path (tests). */
  statePath?: string;
  /** Override the boot warm-up window (tests). */
  windowMs: number;
  /** Override the minimum re-announce gap (tests). */
  minGapMs?: number;
}

function loadState(path: string): RedAnnounceState | null {
  try {
    if (!existsSync(path)) return null;
    return parseRedAnnounceState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null; // corrupt/unreadable → announce
  }
}

function saveState(path: string, s: RedAnnounceState | null): void {
  try {
    // ★ null is written as a TOMBSTONE, not by unlinking: `{}` fails
    // parseRedAnnounceState and therefore means ANNOUNCE, and it goes through the
    // same atomic temp+rename as a real write, so a power cut during the clear
    // cannot leave the OLD state readable. One mechanism, both directions.
    atomicWriteFileSync(path, s == null ? '{}' : JSON.stringify(s));
  } catch {
    /* best effort — losing this only costs one extra klaxon after a restart,
       which is the SAFE direction. Never throw into the alarm loop. */
  }
}

/** Where the gate persists across restarts (mirrors runwayAlarm/lightingPosture). */
export const RED_REPLAY_STATE_PATH =
  process.env.BROADCAST_RED_REPLAY_STATE_PATH ??
  resolve(process.cwd(), config.dbPath, '..', 'broadcast-red-replay.json');

/**
 * Build a gate. State is READ ONCE at construction — that read is the restart
 * boundary: a fresh instance in a fresh process sees what the previous process
 * wrote. Writes go through atomicWriteFileSync (temp + rename in the same
 * directory), so a power cut mid-write can never leave a half-parsed file that
 * would silence an alarm.
 */
export function createRedReplayGate(opts: RedReplayGateOptions): RedReplayGate {
  const path = opts.statePath ?? RED_REPLAY_STATE_PATH;
  const minGapMs = opts.minGapMs ?? RED_REPLAY_MIN_GAP_MS;
  let persisted: RedAnnounceState | null = loadState(path);

  return {
    shouldSuppress(p) {
      return isRedReplaySuppressed({
        observed: p.observed,
        voicedFingerprint: p.voicedFingerprint,
        activeFingerprints: p.activeFingerprints,
        persisted,
        msSinceBoot: p.msSinceBoot,
        nowMs: p.nowMs,
        windowMs: opts.windowMs,
        minGapMs,
      });
    },
    noteRedAnnounced(p) {
      persisted = {
        lastRedAnnouncedAtMs: p.nowMs,
        voicedFingerprint: p.voicedFingerprint,
        activeFingerprints: [...p.activeFingerprints],
        lastPlayedLevel: 'red',
      };
      saveState(path, persisted);
    },
    notePlayedBelowRed(level) {
      if (level === 'red') return; // not this function's business
      if (persisted == null) return; // nothing to demote; already announcing
      persisted = { ...persisted, lastPlayedLevel: level };
      saveState(path, persisted);
    },
    noteConditionGreen() {
      persisted = null;
      saveState(path, null);
    },
    state() {
      return persisted == null
        ? null
        : { ...persisted, activeFingerprints: [...persisted.activeFingerprints] };
    },
  };
}
