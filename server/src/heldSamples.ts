/* ═══════════════════════════════════════════════════════════════════════════
 * heldSamples.ts — v1.188.1. What the recorder writes when a device's readings are HELD
 * rather than freshly reported, and what it does with the held rows already written.
 *
 * THE INCIDENT. After a home internet outage (2026-10-14 23:53 → 10-15 01:55) all five Cores
 * stayed "offline" in the EcoFlow cloud device list for about 20 h; the panel came back at
 * 04:16. The store keeps a device's last projection across `/device/list` polls (it must: the
 * alarms read it) and quota is fetched only for a device listed online, so each Core's
 * projection was its last reading from before the outage. The recorder's `extract()` walked
 * every device that had a projection, and its 5-minute heartbeat restated every unchanged
 * metric at the current time: about 1,300 rows per Core per hour with no metric changing in
 * six hours, PV at 0 W all day while the pool charged to ~96 % on solar. Every consumer that
 * reads `samples` (the solar fit and its bias correction, soiling, typical-day curves, the
 * forecast fit, the night-charge ledger and its learners, energy accounting, history) took
 * those rows as measurements, and every coverage gate passed them because they were present.
 * The rows also stamped the per-device gap clock, so the 6 h per-device sweep built for a
 * silent device never fired for any Core.
 *
 * WHAT THIS MODULE DOES.
 *  1. The gate (`projectionRecordable`): a projection is a READING only while its content is
 *     recent — `lastTelemetryAtMs`, stamped only when telemetry content lands (a REST quota or a
 *     translated MQTT delta) — and, for the panel, while its cloud-shadow latch is clear; for a
 *     Core, while its readings have CHANGED recently (its content clock: a cloud replaying a Core's
 *     cached body still lands content). A held device writes no rows, so every consumer sees a gap,
 *     which each of them already handles.
 *  2. The held-span log (`held_spans`): a hold of an hour or more is recorded with its start
 *     (the last fresh content) and end, so the night-charge ledger can say why it did not score.
 *  3. The exclusion of held rows already written (`held_samples`): a stretch of an hour or more
 *     in which NO metric of a device changed, restated at least three times over at least eight
 *     metrics, is moved — unchanged, in one transaction per slice — from `samples` to
 *     `held_samples`. Nothing is deleted: `restoreHeldSamples` moves a span back, and a restored
 *     span is never excluded again, nor (review 4) the rest of its hold while the device goes on
 *     restating the same readings — (review 5) until a metric changes, or until a return reading
 *     after a silence is followed by another silence (createFrozenScanner: a later replay is a
 *     hold from that reading); (review 6) also when the restore lands while a scan runs, since each
 *     move slice reads the restored spans again (moveStep). Every move is logged.
 *
 * WHAT IT DOES NOT DO. The alarms read the live store, never `samples`; nothing here touches the
 * store. The offline, stale and blind alarms and the SoC ladder are unchanged by construction.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { dpuContentFresh } from './shp2Membership.js';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/* ─────────────────────────────── the gate ─────────────────────────────── */

/**
 * How recent a projection's content must be for the recorder to write it: three missed 60 s
 * polls, the same figure as the 'Telemetry stale' alarm's STALE_MS. It bites only on rows written
 * on ANOTHER device's change event: a device's own content arrival emits 'change' and is recorded
 * at age 0, so the poll cadence and the 10 s dedupe are unaffected. It is shorter than the 5-min
 * heartbeat, so a silent device gets no restated heartbeat at all.
 */
export const RECORD_FRESH_MS = 3 * MIN_MS;

/** The freshness fields of a DeviceSnapshot the gate reads. */
export interface FreshnessFields {
  lastTelemetryAtMs?: number;
  contentStaleSinceMs?: number | null;
  /** A Core's content clock (snapshot.ts dpuContentWitness): read for a 'dpu' projection only. */
  contentChangedAtMs?: number;
  projection?: { kind: string } | null;
}

/**
 * v1.188.1 — is this device's projection a READING the recorder may write now? PURE.
 *
 * Keyed on `lastTelemetryAtMs` alone, never on `online`, `lastUpdated`, `lastQuotaAtMs` or the
 * MQTT arrival clock:
 *  - `online` would drop genuine MQTT readings from a Core the cloud lists offline, and it stays
 *    at its last value for a device absent from `/device/list`;
 *  - `lastUpdated` is also bumped by a bare `/status` flip that carries no content;
 *  - `lastQuotaAtMs` ignores MQTT content;
 *  - the MQTT arrival clock is stamped by the panel's untranslated messages, which never refresh
 *    its projection.
 * A missing clock is not a reading (fail-closed): every production writer of a projection
 * (setDeviceQuota, mergeDeviceQuota) stamps it. `Math.abs` also refuses a clock stepped either way
 * by more than the window. A REST 200 that replays a cached body still bumps `lastTelemetryAtMs`,
 * so arrival alone does not make a reading. A latched panel cloud shadow (`contentStaleSinceMs`) is
 * the panel's marker of a replayed body. A Core has no latch: its marker is its content clock
 * (`contentChangedAtMs`, v1.181.0), which moves only when its readings change. A Core's projection is
 * a reading only while that clock is fresh (dpuContentFresh, the clock the grid resolver, the
 * Energy flow card and the backup timers read). Unknown is not fresh: after a restart the store's
 * first body only seeds the witness, so a Core is written from its first change (seconds over
 * MQTT, one poll over REST).
 */
export function projectionRecordable(d: FreshnessFields, nowMs: number, freshMs: number = RECORD_FRESH_MS): boolean {
  const t = d.lastTelemetryAtMs;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return false;
  if (Math.abs(nowMs - t) > freshMs) return false;
  if (d.contentStaleSinceMs != null) return false;
  return d.projection?.kind !== 'dpu' || dpuContentFresh(d, nowMs);
}

/** v1.188.1 — the instant after which a held device's content was not fresh: the panel's shadow
 *  onset, a Core's last content change, or the last content arrival, whichever is earliest; null
 *  when it has none. A Core whose cloud replays its body keeps one start (its content clock) while
 *  the arrivals move. PURE. */
export function heldSinceMs(d: FreshnessFields): number | null {
  const c: number[] = [];
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (ok(d.contentStaleSinceMs)) c.push(d.contentStaleSinceMs);
  if (d.projection?.kind === 'dpu' && ok(d.contentChangedAtMs)) c.push(d.contentChangedAtMs);
  if (ok(d.lastTelemetryAtMs)) c.push(d.lastTelemetryAtMs);
  return c.length === 0 ? null : Math.min(...c);
}

/* ─────────────────────────────── held spans ─────────────────────────────── */

/**
 * The shortest hold that is logged, excluded or refused by the ledger. An hour is where a held
 * stretch starts to matter to the integrals: the night-charge ledger's trapezoid bridges a gap of
 * up to an hour between two real readings and drops a longer one, and twelve restated heartbeats
 * are far past anything a live device with dozens of metrics produces.
 */
export const HELD_SPAN_MIN_MS = HOUR_MS;
/** A frozen stretch must restate some metric at least this many times ("3 or more heartbeats"). */
export const HELD_MIN_RESTATEMENTS = 3;
/** …and restate at least this many distinct metrics: a Core writes ~109 and a panel dozens; a
 *  generic device writes seven, and an idle one can legitimately sit still for an hour. */
export const HELD_MIN_METRICS = 8;
/** Rows younger than this are never moved: the lifetime rollup re-reads the last 10 min (its
 *  look-back) every 5 min, and a counter must never see its pending window shrink. */
export const HELD_MOVE_MIN_AGE_MS = 15 * MIN_MS;
/** One move transaction covers at most this much of one device (the write lock stays short). */
export const HELD_MOVE_SLICE_MS = HOUR_MS;
/** One scan step reads at most this much of one device: the panel writes ~100 k rows a day, so a
 *  quarter day is a few tens of milliseconds of the event loop on the Pi. */
export const HELD_SCAN_CHUNK_MS = 6 * HOUR_MS;
/** An hourly scan re-reads this much before its watermark, so a hold still too young to qualify
 *  at the previous scan is read from its start. */
export const HELD_RESCAN_OVERLAP_MS = 3 * HOUR_MS;
/** How often the scan runs after the first full one. */
export const HELD_SCAN_EVERY_MS = HOUR_MS;
/** A gate span's end is persisted at most this often while the hold lasts. */
export const HELD_GATE_PERSIST_EVERY_MS = MIN_MS;

export type HeldReason = 'gate-stale' | 'gate-shadow' | 'frozen';

export interface HeldSpan {
  sn: string;
  /** The last fresh instant: rows with startMs < ts ≤ endMs are held. For a frozen span it is the
   *  newest row kept in `samples` before them: a reading in which some metric changed, or (v1.188.1
   *  review 2) a row left there because it did not continue a hold (createFrozenScanner). */
  startMs: number;
  endMs: number;
  /** gate-stale / gate-shadow — the recorder wrote nothing (the gate); frozen — held rows that
   *  had been written were moved to held_samples. */
  reason: HeldReason;
  /** Rows moved to held_samples (0 for a gate span). */
  rows: number;
  detectedAtMs: number;
  /** Set when the span was moved back by restoreHeldSamples; a restored span is not excluded, and
   *  (v1.188.1 review 4) its end follows the rest of its hold, which is not excluded either. */
  restoredAtMs: number | null;
}

/** Length of [a0, a1] ∩ [b0, b1]. PURE. */
export function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/* ─────────────────────────────── the frozen detector ─────────────────────────────── */

export interface FrozenStretch {
  /** The stretch's anchor, exclusive: the newest row kept in `samples` before it — the last instant
   *  at which some metric changed (a fresh reading), or (v1.188.1 review 2) a restated row left
   *  there because what it ended did not continue a hold (createFrozenScanner). */
  startMs: number;
  /** The last restated row of the stretch: inclusive. */
  endMs: number;
  /** The first restated row (after a gap, later than startMs). */
  firstHeldMs: number;
  /** The most restatements of any one metric. */
  restatements: number;
  /** Distinct metrics restated. */
  metrics: number;
  /** Restated rows. */
  heldRows: number;
  /** v1.188.1 (dry run) — the observed constancy: the intervals of the stretch between two rows
   *  no more than the bridge apart (the length `qualifies` tests). The lifetime counters integrate
   *  the held flow over exactly these intervals (integrateWh bridges up to 10 min). */
  observedMs: number;
  /** v1.188.1 (review 2) — those intervals, merged into runs [from, to] in ts order (a hole or a
   *  silence starts a new run): what a part of the stretch observed (observedWithinMs). */
  observed: ReadonlyArray<readonly [number, number]>;
  /** Each restated metric's value (identical throughout, by construction). */
  heldValues: Map<string, number>;
  /** Meets the length, restatement and metric thresholds on its own. A stretch that does not
   *  can still extend a span an earlier scan moved (its first rows are gone, so a scan sees only
   *  the tail): the caller decides (createHeldSamples). */
  qualifies: boolean;
}

export interface FrozenScanOptions {
  minSpanMs: number;
  minRestatements: number;
  minMetrics: number;
  /** v1.188.1 (review) — the longest interval between two consecutive rows that counts toward
   *  `minSpanMs`; a longer one is a gap with no rows, observed as nothing. Optional (default
   *  HELD_ROW_BRIDGE_MS) so a caller's options from before it keep their meaning. */
  bridgeMs?: number;
  /** v1.188.1 (review 2) — the longest gap with no rows that is a HOLE inside a stretch (default
   *  HELD_RETURN_GAP_MS); a longer one is a SILENCE, after which the device's rows are a return
   *  (createFrozenScanner). */
  returnGapMs?: number;
  /** v1.188.1 (dry run) — which stretches that do NOT qualify are returned, by their last fresh
   *  instant and first restated row. Omitted, every stretch is returned (flagged). The held-sample
   *  scan keeps only the tail of a span an earlier scan moved: a live device produces a stretch
   *  between every two changes, hundreds of thousands per device over the retention window, and
   *  kept until the device finished each held its own Map (+190–360 MB in the dry run). */
  keepUnqualified?: (startMs: number, firstHeldMs: number) => boolean;
  /** v1.188.1 (review 2) — where the rows an earlier scan moved from this last fresh instant end
   *  (its span's end), or undefined: those rows were there, so the next row is measured from that
   *  end, not from the fresh reading hours before it. Omitted, nothing was moved. */
  movedThroughMs?: (anchorMs: number) => number | undefined;
}

/**
 * v1.188.1 (review) — two heartbeats: the longest interval between two rows of a device that is
 * still OBSERVED constancy (integrateWh's own 10-min bridge). The recorder restates an unchanged
 * metric every 5 min while the device reports, so a longer interval means nothing was written.
 */
export const HELD_ROW_BRIDGE_MS = 10 * MIN_MS;

/**
 * v1.188.1 (review 2) — the longest gap with no rows that is a HOLE inside a hold (an add-on
 * restart, a Pi reboot, a poll or WAN outage of up to an hour) rather than a SILENCE the device
 * comes back from. The night-charge ledger's trapezoid bridges a gap of up to an hour between two
 * readings, so for the integrals an hour or less is still one series.
 */
export const HELD_RETURN_GAP_MS = HELD_SPAN_MIN_MS;

export const FROZEN_DEFAULTS: FrozenScanOptions = {
  minSpanMs: HELD_SPAN_MIN_MS,
  minRestatements: HELD_MIN_RESTATEMENTS,
  minMetrics: HELD_MIN_METRICS,
  bridgeMs: HELD_ROW_BRIDGE_MS,
  returnGapMs: HELD_RETURN_GAP_MS,
};

/** v1.188.1 (review 2) — how much of a stretch's observed constancy lies in (fromMs, toMs]. PURE. */
export function observedWithinMs(s: Pick<FrozenStretch, 'observed'>, fromMs: number, toMs: number): number {
  let ms = 0;
  for (const [a, b] of s.observed) ms += overlapMs(a, b, fromMs, toMs);
  return ms;
}

/** The running totals of one stretch, or of one return piece not yet joined to it. */
interface StretchAcc {
  counts: Map<string, number>;
  values: Map<string, number>;
  heldRows: number;
  firstHeldTs: number;
  lastHeldTs: number;
  observedMs: number;
  observed: Array<[number, number]>;
}
const newStretchAcc = (): StretchAcc => ({
  counts: new Map(), values: new Map(), heldRows: 0,
  firstHeldTs: Number.POSITIVE_INFINITY, lastHeldTs: Number.NEGATIVE_INFINITY, observedMs: 0, observed: [],
});

/**
 * v1.188.1 — the frozen-stretch detector for ONE device, fed its rows in ts order. PURE.
 *
 * A row whose value differs from the previous row of its metric (or whose metric has no previous
 * row) is new content: every row at that ts is a fresh reading and closes the stretch. A row equal
 * to its metric's previous value is a restatement. A stretch qualifies when at least `minSpanMs`
 * of OBSERVED constancy passed — rows no further apart than `bridgeMs`, from its last fresh
 * instant to its last restatement — with no metric changing, some metric was restated at least
 * `minRestatements` times and at least `minMetrics` metrics were restated. A GAP is not a hold: a
 * stretch needs restated rows, so a span with no rows at all is never reported, and (v1.188.1
 * review) a gap inside a stretch does not count toward its length. Measured from the last change
 * to the last restatement, a genuinely constant Core back from a 55-min gap with three identical
 * heartbeats qualified after 10 min of observation, its fresh rows moved and its night refused;
 * the gate (v1.188.1) makes such gaps whenever a device's content is more than 3 min old. The
 * cost is deliberate: a replayed body after a long gap is caught once it has been restated for
 * an hour, not before (the gate's own span over the gap still refuses the night-ledger row).
 * Every stretch with restated rows is returned, flagged `qualifies` when it meets the thresholds
 * (or, with `keepUnqualified`, every qualifying one and the non-qualifying ones it keeps).
 *
 * v1.188.1 (review 2) — what a gap with no rows does to a stretch depends on its length:
 *  - up to `returnGapMs` (an hour) it is a HOLE: the stretch goes on across it, and the observed
 *    time on both sides adds up. A restart's 20-min hole inside a running hold no longer leaves
 *    the hold's tail in `samples`, and two 40-min parts of one hold are one 80-min hold.
 *  - longer, it is a SILENCE, and the restated rows after it are a RETURN PIECE. It joins the
 *    stretch only once it qualifies on its own (an hour of observed constancy after the silence:
 *    a replayed body, as above), and the stretch then runs from the last change before the silence
 *    (the incident's Cores: a 2 h outage, then 20 h of restatements). A return piece that ends
 *    (a change, another silence, the scan's end) before that is a RETURN READING: it stays in
 *    `samples`, and the stretch before it ends at its last restated row. On the live database a
 *    Core held for ~23 h, silent for 9.8 days, came back with one group equal to its held values;
 *    the scan of v1.188.1 before its dry run moved that return reading with the span, which then
 *    claimed 257.9 h. After a return reading that another silence follows, the stretch starts again
 *    from it (it is the newest row kept), so a later replay is a hold from there.
 *  - a stretch that does NOT qualify (and is not kept) when a silence begins is over: its rows
 *    stay, and the next stretch starts from its last row. Joined to a part after the silence, it
 *    would be moved by a scan that reads both and left by an hourly scan that no longer reads it.
 * So whether a row is moved, where a span starts and where it ends do not depend on how often the
 * scan runs: the anchor of every stretch is the newest row kept in `samples` before it, which is
 * what an hourly scan reads as its anchor (`movedThroughMs` tells it where the rows an earlier
 * scan moved from that anchor end; review 3: the gap after such an anchor is measured from there
 * too). The one exception is a hold whose observed hour takes longer than the rescan overlap to
 * build up (restatements more than a bridge apart add nothing to it): the hourly scans leave its
 * first restated rows in samples as its anchor, and only a scan that reads it whole moves them.
 * v1.188.1 (review 4) — or ALL of it: when its restatements stay that far apart throughout, no
 * hourly re-read holds an observed hour, and only the first scan (it reads the whole history)
 * moves any of it.
 *
 * `prev` is each metric's value before the first fed row and `anchorMs` the ts of the newest such
 * row (the last fresh instant before the scan, when the scan starts mid-hold); both empty/null on
 * a scan from the start of the data.
 */
export function createFrozenScanner(prev: ReadonlyMap<string, number>, anchorMs: number | null, opts: FrozenScanOptions = FROZEN_DEFAULTS) {
  const last = new Map(prev);
  const bridgeMs = opts.bridgeMs ?? HELD_ROW_BRIDGE_MS;
  const returnGapMs = opts.returnGapMs ?? HELD_RETURN_GAP_MS;
  const keep = opts.keepUnqualified ?? (() => true);
  const movedThrough = opts.movedThroughMs ?? (() => undefined);
  let anchor: number | null = null;
  /** The ts of the previous row (fresh or restated): the start of the interval the next one ends.
   *  For an anchor with moved rows after it, the end of those rows. */
  let prevRowTs: number | null = null;
  /** The stretch from `anchor`. */
  let cur = newStretchAcc();
  /** A return piece (after a silence) that has not qualified on its own yet. */
  let ret: StretchAcc | null = null;
  const out: FrozenStretch[] = [];
  const setAnchor = (ts: number) => {
    anchor = ts;
    const movedEnd = movedThrough(ts);
    prevRowTs = movedEnd != null && movedEnd > ts ? movedEnd : ts;
  };
  /** Is the gap with no rows before a row at `ts` a SILENCE (more than returnGapMs), not a hole? */
  const silenceBefore = (ts: number) => prevRowTs != null && ts - prevRowTs > returnGapMs;
  if (anchorMs != null) setAnchor(anchorMs);
  const restatementsOf = (a: StretchAcc) => {
    let n = 0;
    for (const c of a.counts.values()) if (c > n) n = c;
    return n;
  };
  const qualifies = (a: StretchAcc) => a.observedMs >= opts.minSpanMs && restatementsOf(a) >= opts.minRestatements && a.counts.size >= opts.minMetrics;
  const close = () => {
    ret = null; // a return piece that never qualified: return readings, left in samples
    if (anchor != null && cur.heldRows > 0) {
      const q = qualifies(cur);
      if (q || keep(anchor, cur.firstHeldTs)) {
        out.push({ startMs: anchor, endMs: cur.lastHeldTs, firstHeldMs: cur.firstHeldTs, restatements: restatementsOf(cur), metrics: cur.counts.size, heldRows: cur.heldRows, observedMs: cur.observedMs, observed: cur.observed, heldValues: cur.values, qualifies: q });
      }
    }
    cur = newStretchAcc();
  };
  return {
    /** Rows in ts order (ties in any order). May be called once per chunk. */
    feed(rows: ReadonlyArray<{ metric: string; ts: number; value: number }>): void {
      let i = 0;
      while (i < rows.length) {
        const ts = rows[i].ts;
        let j = i;
        let changed = false;
        for (; j < rows.length && rows[j].ts === ts; j++) {
          const pv = last.get(rows[j].metric);
          if (pv === undefined || pv !== rows[j].value) changed = true;
        }
        if (changed) {
          close();
          setAnchor(ts);
        } else {
          if (silenceBefore(ts)) {
            // A silence. What came before it that cannot become part of a hold any more stays in
            // samples, and the stretch starts again from its last row: a return piece that did not
            // qualify on its own, or a stretch that neither qualifies nor extends a moved span.
            if (ret != null) {
              const kept = ret.lastHeldTs;
              close();
              setAnchor(kept);
            } else if (cur.heldRows > 0 && !qualifies(cur) && !(anchor != null && keep(anchor, cur.firstHeldTs))) {
              const kept = cur.lastHeldTs;
              close();
              setAnchor(kept);
            }
            // v1.188.1 (review 3) — measured again from the new anchor. A kept row that starts a span
            // an earlier scan moved has its previous row at that span's end (setAnchor), so this row
            // may follow it within a hole: it continues the span, exactly as for a scan whose anchor
            // is that row. Opened unconditionally, a scan that re-read the span from before its start
            // (the 3 h overlap, a boot after a stop, the retry after a failed slice) made the rows
            // after the moved part a return piece that had to qualify again, and a hold that ended
            // within the hour stayed in samples for good: the next scan's anchor is a row after it.
            if (silenceBefore(ts)) ret = newStretchAcc();
          }
          const acc = ret ?? cur;
          for (let k = i; k < j; k++) {
            const m = rows[k].metric;
            acc.counts.set(m, (acc.counts.get(m) ?? 0) + 1);
            acc.values.set(m, rows[k].value);
          }
          acc.heldRows += j - i;
          if (ts < acc.firstHeldTs) acc.firstHeldTs = ts;
          acc.lastHeldTs = ts;
          // Only an interval between two rows a heartbeat or two apart is observed constancy.
          if (prevRowTs != null && ts - prevRowTs <= bridgeMs) {
            acc.observedMs += ts - prevRowTs;
            const run = acc.observed[acc.observed.length - 1];
            if (run != null && run[1] === prevRowTs) run[1] = ts;
            else acc.observed.push([prevRowTs, ts]);
          }
          // A return piece that has qualified on its own is a hold: it joins the stretch.
          if (ret != null && qualifies(ret)) {
            for (const [m, n] of ret.counts) cur.counts.set(m, (cur.counts.get(m) ?? 0) + n);
            for (const [m, v] of ret.values) cur.values.set(m, v);
            cur.heldRows += ret.heldRows;
            if (ret.firstHeldTs < cur.firstHeldTs) cur.firstHeldTs = ret.firstHeldTs;
            cur.lastHeldTs = ret.lastHeldTs;
            cur.observedMs += ret.observedMs;
            cur.observed.push(...ret.observed);
            ret = null;
          }
          prevRowTs = ts;
        }
        for (let k = i; k < j; k++) last.set(rows[k].metric, rows[k].value);
        i = j;
      }
    },
    /** Close the trailing stretch (a hold still running at the scan's end) and return them all. A
     *  return piece still too short is left for a later scan (it re-reads it). */
    finish(): FrozenStretch[] {
      close();
      return out;
    },
  };
}

/** Restated flow metrics that the lifetime counters integrate, for the one-time estimate the
 *  move logs (the counters are not rewritten: Home Assistant reads a decrease as a meter reset). */
const LIFETIME_FLOW_METRIC = /^(pv_total|ac_in|panel_load|grid_home_w|ch\d+_w)$/;

/* ─────────────────────────────── the store ─────────────────────────────── */

/** Schema. `held_samples` mirrors `samples` exactly so a restore is a plain copy back. */
export const HELD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS held_samples (
    ts INTEGER NOT NULL,
    sn TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_held_samples_sn_ts ON held_samples (sn, ts);
  CREATE INDEX IF NOT EXISTS idx_held_samples_ts ON held_samples (ts);
  CREATE TABLE IF NOT EXISTS held_spans (
    sn TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    reason TEXT NOT NULL,
    rows INTEGER NOT NULL DEFAULT 0,
    detected_at_ms INTEGER NOT NULL,
    restored_at_ms INTEGER,
    PRIMARY KEY (sn, start_ts, reason)
  );
  CREATE INDEX IF NOT EXISTS idx_held_spans_end ON held_spans (end_ts);
  CREATE TABLE IF NOT EXISTS held_scan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    scanned_to_ts INTEGER NOT NULL,
    full_scan_at_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS held_generation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    gen INTEGER NOT NULL
  );
`;

/**
 * v1.188.1 (review) — the SAMPLES GENERATION: a counter that moves, in the same transaction, every
 * time rows leave `samples` (a move to held_samples) or come back (a restore). Every other change
 * to `samples` appends (or prunes past the retention), and the analytics worker's closed-day
 * memos (analytics.ts dailyEnergyWhCache, eqSeriesCache) assume exactly that: a closed day's
 * integral is computed once and kept for the life of the process. Its first warm pass runs
 * seconds after a boot, the first scan a minute later, so on the upgrade boot the incident's
 * closed day was memoised with its held flows and served until the next restart. The worker's
 * report chokepoint reads this before every report (reports.ts noteSamplesGeneration) and resets
 * the memos and the results built on them when it has moved.
 */
export const SAMPLES_GENERATION_SQL = {
  read: 'SELECT gen FROM held_generation WHERE id = 1',
  bump: 'INSERT INTO held_generation (id, gen) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET gen = gen + 1',
} as const;

/** v1.188.1 (review) — a reader of the samples generation on any connection to the database
 *  (the worker's read-only one included): 0 before the first move, and 0 — retried on the next
 *  call — while the table does not exist yet. Never throws. */
export function samplesGenerationReader(db: DatabaseSync): () => number {
  let stmt: StatementSync | null = null;
  return () => {
    try {
      stmt ??= db.prepare(SAMPLES_GENERATION_SQL.read);
      const r = stmt.get() as { gen: number | bigint } | undefined;
      return r == null ? 0 : Number(r.gen);
    } catch {
      stmt = null;
      return 0;
    }
  };
}

/**
 * The statements that read `samples`. Exported so their query PLANS can be asserted
 * (test/bootPlannerStats.test.ts): each is an index SEARCH whatever the statistics say. The two
 * move statements are pinned to the ts index — a range over one slice of time, filtered to the
 * device — because the composite index cannot bound ts without a metric.
 */
export const HELD_SAMPLES_SQL = {
  prevValue: 'SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts <= ? ORDER BY ts DESC LIMIT 1',
  /** v1.188.1 (dry run) — a series' oldest row (the first full scan starts each device there), the
   *  boot seed's MAX(ts) seek mirrored: one index SEARCH per (sn, metric). */
  minTs: 'SELECT MIN(ts) AS v FROM samples INDEXED BY idx_samples_sn_metric_ts WHERE sn = ? AND metric = ?',
  chunkRows: 'SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts > ? AND ts <= ? ORDER BY ts ASC',
  moveCopy: 'INSERT INTO held_samples (ts, sn, metric, value) SELECT ts, sn, metric, value FROM samples INDEXED BY idx_samples_ts WHERE ts > ? AND ts <= ? AND sn = ?',
  moveDelete: 'DELETE FROM samples INDEXED BY idx_samples_ts WHERE ts > ? AND ts <= ? AND sn = ?',
} as const;

/** v1.188.1 (dry run) — the held-span reads of the scan: exported so a test can count them. */
export const HELD_SPANS_SQL = {
  /** A device's frozen spans, read ONCE per device per scan (planScan). v1.188.1 (review 2) — not
   *  the restored ones: their rows are back in samples, and a scan reads them like any other. */
  frozenOf: "SELECT start_ts, end_ts FROM held_spans WHERE sn = ? AND reason = 'frozen' AND restored_at_ms IS NULL",
  /** v1.188.1 (review 4) — a device's restored spans, read once per device per scan (planScan). */
  restoredOf: "SELECT start_ts, end_ts FROM held_spans WHERE sn = ? AND reason = 'frozen' AND restored_at_ms IS NOT NULL",
  /** v1.188.1 (review 4) — a restored span's end follows the hold it restored while the device goes
   *  on restating the same readings (scanStep): its rows were never moved, and are not. */
  extendRestored: "UPDATE held_spans SET end_ts = ? WHERE sn = ? AND start_ts = ? AND reason = 'frozen' AND restored_at_ms IS NOT NULL AND end_ts < ?",
  /** v1.188.1 (review 5) — the restored span of a device that starts at a given instant, if any
   *  (restoredSpanFrom: a restore by SQL the recorder was not told about). */
  restoredFrom: "SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = 'frozen' AND restored_at_ms IS NOT NULL",
} as const;

export interface HeldScanSummary {
  /** Spans found (new or extended) by this scan. */
  spans: number;
  /** Rows moved to held_samples by this scan. */
  rowsMoved: number;
  full: boolean;
  /** v1.188.1 (dry run) — stretches the scanner kept for the move decision: those that qualify
   *  and the tails of spans an earlier scan moved. Bounded by the holds, not by the rows. */
  candidates: number;
}

export interface HeldSamplesOptions {
  log: (m: string) => void;
  /** The samples retention, in ms (RECORDER_RETENTION_DAYS). */
  retainMs: number;
  /** Devices never scanned or logged: the synthetic series and bench spares. */
  isExcludedSn: (sn: string) => boolean;
  /** Each device serial in `samples` (the recorder's seed skip-scan). */
  listSns: () => string[];
  /** Each metric a device has rows for. */
  listMetrics: (sn: string) => string[];
  /** Called after a slice of a span was moved: no row of `sn` in (spanStartMs, endMs] is left in
   *  `samples`, and spanStartMs is the stretch's anchor, the newest row of `sn` kept there before
   *  them (FrozenStretch.startMs): its last fresh reading, or (v1.188.1 review 2) a restated row
   *  left there. v1.188.1 (review 3) — not always the last fresh reading, so a caller states it as
   *  the newest row kept, not as the moment the device went quiet.
   *
   *  v1.188.1 (review 4) — `heldThroughMs` (≥ endMs) is the stretch's last restated row as the scan
   *  read it: every row of `sn` in (startMs, heldThroughMs] restates the same readings, those after
   *  endMs not moved yet (younger than HELD_MOVE_MIN_AGE_MS, or in a later slice). A device whose
   *  replayed body is still being written has its newest row there.
   *
   *  v1.188.1 (review 5) — `heldValues` is each restated metric's value in the stretch: a row the
   *  scan did not read (written after its plan, or the first write of a new process) restates the
   *  hold when it carries that value (recorder.ts restatedSince, record()). */
  onMoved?: (sn: string, startMs: number, endMs: number, heldThroughMs: number, heldValues: ReadonlyMap<string, number>) => void;
  /** v1.188.1 (review 2) — called after a span was restored: the rows of `sn` in (startMs, endMs]
   *  are back in `samples`, so whatever onMoved re-dated from them goes back too. */
  onRestored?: (sn: string, startMs: number, endMs: number) => void;
  now?: () => number;
}

interface ScanJob {
  sn: string;
  metrics: string[];
  fromMs: number;
  toMs: number;
  cursorMs: number;
  /** v1.188.1 (dry run) — the device's frozen spans as the scan began: start_ts → end_ts. */
  frozenEnds: ReadonlyMap<number, number>;
  /** v1.188.1 (review 4) — the device's restored spans as the scan began (an end is advanced in
   *  place when a stretch continues one: scanStep). */
  restored: Array<{ startMs: number; endMs: number }>;
  scanner: ReturnType<typeof createFrozenScanner>;
}

interface MoveJob {
  sn: string;
  spanStartMs: number;
  fromMs: number;
  toMs: number;
  stretch: FrozenStretch;
  /** First slice of a span no earlier scan had found: the span is logged once, here. */
  announce: boolean;
  /** v1.188.1 (review 2) — the whole range this scan moves for the stretch, (rangeFromMs,
   *  rangeToMs]: what its log lines state, and what the held-flow estimate covers. */
  rangeFromMs: number;
  rangeToMs: number;
  /** v1.188.1 (review 2) — the range extends a span an earlier scan moved (its last slice says so). */
  extension: boolean;
  /** v1.188.1 (review 6) — the device's restored spans as the scan was planned (ScanJob.restored):
   *  a span restored since then is looked for again at each slice (moveStep). */
  plannedRestored: ReadonlyArray<{ startMs: number }>;
}

/** v1.188.1 (review 4) — is `startMs` (a stretch's anchor) one of the rows of a restored span,
 *  its start included? No metric of the device changed in it, so a stretch from there continues the
 *  hold the restore gave back. PURE. */
const anchoredIn = (r: { startMs: number; endMs: number }, startMs: number): boolean => startMs >= r.startMs && startMs <= r.endMs;
/** v1.188.1 (review 4) — does the stretch `s` continue the hold the restored span `r` gave back: it
 *  overlaps the span, or its anchor is one of the span's rows? PURE. */
const continuesRestored = (r: { startMs: number; endMs: number }, s: Pick<FrozenStretch, 'startMs' | 'endMs'>): boolean => overlapMs(r.startMs, r.endMs, s.startMs, s.endMs) > 0 || anchoredIn(r, s.startMs);

export function createHeldSamples(db: DatabaseSync, o: HeldSamplesOptions) {
  const now = o.now ?? Date.now;
  db.exec(HELD_SCHEMA_SQL);
  const prevValueStmt = db.prepare(HELD_SAMPLES_SQL.prevValue);
  const minTsStmt = db.prepare(HELD_SAMPLES_SQL.minTs);
  const chunkRowsStmt = db.prepare(HELD_SAMPLES_SQL.chunkRows);
  const moveCopyStmt = db.prepare(HELD_SAMPLES_SQL.moveCopy);
  const moveDeleteStmt = db.prepare(HELD_SAMPLES_SQL.moveDelete);
  const restoreCopyStmt = db.prepare('INSERT INTO samples (ts, sn, metric, value) SELECT ts, sn, metric, value FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?');
  const restoreDeleteStmt = db.prepare('DELETE FROM held_samples WHERE sn = ? AND ts > ? AND ts <= ?');
  const spanUpsertStmt = db.prepare(
    `INSERT INTO held_spans (sn, start_ts, end_ts, reason, rows, detected_at_ms) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sn, start_ts, reason) DO UPDATE SET end_ts = MAX(end_ts, excluded.end_ts), rows = rows + excluded.rows`,
  );
  const spansInStmt = db.prepare(
    `SELECT sn, start_ts, end_ts, reason, rows, detected_at_ms, restored_at_ms FROM held_spans
      WHERE end_ts >= ? AND start_ts <= ? AND restored_at_ms IS NULL ORDER BY start_ts ASC, sn ASC`,
  );
  const restoredOfStmt = db.prepare(HELD_SPANS_SQL.restoredOf);
  const extendRestoredStmt = db.prepare(HELD_SPANS_SQL.extendRestored);
  const markRestoredStmt = db.prepare('UPDATE held_spans SET restored_at_ms = ? WHERE sn = ? AND start_ts = ? AND reason = ?');
  const restoredFromStmt = db.prepare(HELD_SPANS_SQL.restoredFrom);
  const restoredInStmt = db.prepare(
    `SELECT sn, start_ts, end_ts, reason, rows, detected_at_ms, restored_at_ms FROM held_spans
      WHERE end_ts >= ? AND start_ts <= ? AND restored_at_ms IS NOT NULL ORDER BY start_ts ASC, sn ASC`,
  );
  const frozenOfStmt = db.prepare(HELD_SPANS_SQL.frozenOf);
  const scanStateStmt = db.prepare('SELECT scanned_to_ts, full_scan_at_ms FROM held_scan WHERE id = 1');
  const scanStateUpsertStmt = db.prepare(
    `INSERT INTO held_scan (id, scanned_to_ts, full_scan_at_ms) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET scanned_to_ts = excluded.scanned_to_ts, full_scan_at_ms = COALESCE(held_scan.full_scan_at_ms, excluded.full_scan_at_ms)`,
  );
  const pruneHeldStmt = db.prepare('DELETE FROM held_samples WHERE ts < ?');
  const heldRowWithinStmt = db.prepare('SELECT 1 AS one FROM held_samples WHERE sn = ? AND ts >= ? AND ts <= ? AND metric = ? LIMIT 1');
  const pruneSpansStmt = db.prepare('DELETE FROM held_spans WHERE end_ts < ?');
  const bumpGenerationStmt = db.prepare(SAMPLES_GENERATION_SQL.bump);
  const readGeneration = samplesGenerationReader(db);

  const toSpan = (r: Record<string, unknown>): HeldSpan => ({
    sn: String(r.sn),
    startMs: Number(r.start_ts),
    endMs: Number(r.end_ts),
    reason: String(r.reason) as HeldReason,
    rows: Number(r.rows),
    detectedAtMs: Number(r.detected_at_ms),
    restoredAtMs: r.restored_at_ms == null ? null : Number(r.restored_at_ms),
  });

  /* ── the gate's span log ── */

  const gateOpen = new Map<string, { startMs: number; endMs: number; reason: HeldReason; persistedAtMs: number }>();
  const persistGate = (sn: string, g: { startMs: number; endMs: number; reason: HeldReason; persistedAtMs: number }, atMs: number) => {
    const first = g.persistedAtMs === 0;
    try {
      spanUpsertStmt.run(sn, g.startMs, g.endMs, g.reason, 0, atMs);
      g.persistedAtMs = atMs;
    } catch (e: any) {
      o.log(`recorder: held-span log failed for ${sn} (${e?.message ?? e})`);
      return;
    }
    if (first) {
      o.log(`recorder: ${sn} has delivered no fresh readings since ${new Date(g.startMs).toISOString()} (${g.reason === 'gate-shadow' ? 'the cloud is replaying its last payload' : 'its last reading is being held'}) — nothing is recorded for it until it reports again`);
    }
  };

  /**
   * v1.188.1 — the gate's evaluation of one change event: `held` maps each device the gate did NOT
   * record to its heldSinceMs. A hold of HELD_SPAN_MIN_MS or more is persisted (and its end kept
   * current at most once a minute); it closes on the device's first recordable evaluation.
   *
   * v1.188.1 (merge) — a LATER start for a device held at every evaluation since the span opened is
   * the same hold: no fresh reading came in between (one would have closed it). The case is a Core
   * with no content clock yet, after a restart: the store's first body only seeds its witness, so a
   * Core whose cloud replays its cached body is held from its last arrival, which moves with every
   * poll. Re-opened at each new start, its span never reached an hour and was never logged, so the
   * night ledger read the replay as missing rather than held; in this process (a content clock) the
   * same replay is one span from its last change. The span runs from the first instant this process
   * held it, never earlier: the downtime of a restart is not charged as a hold.
   */
  function noteGate(held: ReadonlyMap<string, { sinceMs: number | null; shadow: boolean }>, atMs: number): void {
    for (const [sn, h] of held) {
      if (h.sinceMs == null || o.isExcludedSn(sn)) continue;
      const reason: HeldReason = h.shadow ? 'gate-shadow' : 'gate-stale';
      let g = gateOpen.get(sn);
      if (g && (h.sinceMs < g.startMs || g.reason !== reason)) {
        if (g.persistedAtMs > 0) persistGate(sn, g, atMs);
        g = undefined;
      }
      if (!g) {
        g = { startMs: h.sinceMs, endMs: atMs, reason, persistedAtMs: 0 };
        gateOpen.set(sn, g);
      }
      g.endMs = Math.max(g.endMs, atMs);
      if (g.endMs - g.startMs >= HELD_SPAN_MIN_MS && atMs - g.persistedAtMs >= HELD_GATE_PERSIST_EVERY_MS) persistGate(sn, g, atMs);
    }
    for (const [sn, g] of gateOpen) {
      if (held.has(sn)) continue;
      if (g.persistedAtMs > 0) {
        persistGate(sn, g, atMs);
        o.log(`recorder: ${sn} is reporting again after ${Math.round((g.endMs - g.startMs) / MIN_MS)} min with no fresh readings — recording resumed`);
      }
      gateOpen.delete(sn);
    }
  }

  /* ── the scan of rows already written ── */

  let ready = false;
  let running = false;
  let stopped = false;
  const scanQueue: ScanJob[] = [];
  const moveQueue: MoveJob[] = [];
  let scanSpans = 0;
  let scanRows = 0;
  let scanCandidates = 0;
  let scanFull = false;
  let scanToMs = 0;
  let scanStartedAt = 0;
  /** v1.188.1 (review) — the start of the earliest span a move slice of this scan failed on
   *  (+Infinity when none): the watermark is not saved past it, so the next scan re-reads it. */
  let failedFromMs = Number.POSITIVE_INFINITY;
  /** v1.188.1 (review 4) — the restored spans whose continuation this process has logged
   *  (`sn|start`): an hourly scan re-reads a running hold every hour, and one line says it. */
  const restoredNoted = new Set<string>();

  /** v1.188.1 (dry run) — a device's frozen spans, start_ts → end_ts: one read per device per scan. */
  function readFrozenEnds(sn: string): Map<number, number> {
    const m = new Map<number, number>();
    for (const r of frozenOfStmt.all(sn) as Array<{ start_ts: number; end_ts: number }>) m.set(Number(r.start_ts), Number(r.end_ts));
    return m;
  }

  /** Plan a scan: every device in `samples`, from the watermark (less the overlap) or, the first
   *  time, from the retention horizon — or from the device's oldest row, when that is later. */
  function planScan(atMs: number): void {
    const st = scanStateStmt.get() as { scanned_to_ts: number; full_scan_at_ms: number | null } | undefined;
    const horizon = atMs - o.retainMs;
    scanFull = st?.full_scan_at_ms == null;
    const scanFromMs = scanFull ? horizon : Math.max(horizon, Number(st!.scanned_to_ts) - HELD_RESCAN_OVERLAP_MS);
    scanToMs = atMs;
    scanStartedAt = atMs;
    scanSpans = 0;
    scanRows = 0;
    scanCandidates = 0;
    failedFromMs = Number.POSITIVE_INFINITY;
    for (const sn of o.listSns()) {
      if (o.isExcludedSn(sn)) continue;
      const metrics = o.listMetrics(sn);
      if (metrics.length < HELD_MIN_METRICS) continue; // cannot qualify; never scanned
      // v1.188.1 (dry run) — the first scan starts each device at its oldest row, not at the
      // retention horizon: on the live database (1,825-day retention, data from 2025) 34,666 of
      // its 36,500 six-hour steps read nothing, about half its wall time on the Pi. Nothing lies
      // between the horizon and that row, so the scan reads exactly the same rows.
      let fromMs = scanFromMs;
      if (scanFull) {
        let oldest = Number.POSITIVE_INFINITY;
        for (const m of metrics) {
          const v = (minTsStmt.get(sn, m) as { v: number | bigint | null } | undefined)?.v;
          if (v != null && Number(v) < oldest) oldest = Number(v);
        }
        if (Number.isFinite(oldest)) fromMs = Math.max(scanFromMs, oldest - 1);
      }
      // Each metric's value before the scan, and the newest such row: the last instant before the
      // scan. On an hourly scan that starts inside a hold whose earlier rows were already moved,
      // that row IS the hold's last fresh reading, so the stretch keeps its true start.
      const prev = new Map<string, number>();
      let anchor: number | null = null;
      for (const m of metrics) {
        const r = prevValueStmt.get(sn, m, fromMs) as { ts: number; value: number } | undefined;
        if (!r) continue;
        prev.set(m, r.value);
        if (anchor == null || r.ts > anchor) anchor = Number(r.ts);
      }
      // v1.188.1 (dry run) — the frozen spans are read once here, not once per stretch: the
      // finishing step looked one up for every stretch the device had (100 k–486 k per device over
      // the retention window, 1.6–5.4 s of the alarm thread per device on the Pi). A stretch that
      // does not qualify is kept only to extend a span an earlier scan moved: a hold still running,
      // from the same last fresh reading.
      //
      // v1.188.1 (review 2) — the scanner measures the first row after such a span from where the
      // span ends (movedThroughMs), so a hole of up to an hour inside the hold (a restart) extends
      // it, and a device back after a longer silence is a return piece, moved only once it has
      // qualified on its own (createFrozenScanner). The dry run's rule — extend only when the first
      // row is within one bridge of the span's end — left the tail of a running hold in samples
      // after any hole longer than two heartbeats.
      const frozenEnds = readFrozenEnds(sn);
      // v1.188.1 (review 4) — and its restored spans: a stretch from an anchor inside one continues
      // the hold the restore gave back, whether it qualifies in this scan's window or not, and is
      // kept so the span's end follows it (scanStep).
      const restored = (restoredOfStmt.all(sn) as Array<{ start_ts: number; end_ts: number }>)
        .map((r) => ({ startMs: Number(r.start_ts), endMs: Number(r.end_ts) }));
      const scanner = createFrozenScanner(prev, anchor, {
        ...FROZEN_DEFAULTS,
        keepUnqualified: (startMs) => frozenEnds.has(startMs) || restored.some((r) => anchoredIn(r, startMs)),
        movedThroughMs: (anchorMs) => frozenEnds.get(anchorMs),
      });
      scanQueue.push({ sn, metrics, fromMs, toMs: atMs, cursorMs: fromMs, frozenEnds, restored, scanner });
    }
  }

  /** v1.188.1 (review 4) — a stretch the restored span `r` gave back: left in samples, the span's
   *  end follows its last restated row, and the continuation is logged once per process. */
  function leaveRestored(sn: string, r: { startMs: number; endMs: number }, s: FrozenStretch): void {
    if (s.endMs > r.endMs) {
      try {
        extendRestoredStmt.run(s.endMs, sn, r.startMs, s.endMs);
        r.endMs = s.endMs;
      } catch (e: any) {
        o.log(`recorder: restored span of ${sn} from ${new Date(r.startMs).toISOString()} not extended (${e?.message ?? e})`);
      }
    }
    const key = `${sn}|${r.startMs}`;
    if (!restoredNoted.has(key)) {
      restoredNoted.add(key);
      o.log(`recorder: ${sn} held stretch ${new Date(s.startMs).toISOString()} → ${new Date(s.endMs).toISOString()} is part of the span from ${new Date(r.startMs).toISOString()} that was restored earlier — left in samples (the span now runs to ${new Date(r.endMs).toISOString()})`);
    }
  }

  /** One device-chunk of reading; when the device is done, its qualifying stretches are queued
   *  for moving (slice by slice). Returns false when there is nothing left to read. */
  function scanStep(): boolean {
    const job = scanQueue[0];
    if (!job) return false;
    const to = Math.min(job.toMs, job.cursorMs + HELD_SCAN_CHUNK_MS);
    const rows: Array<{ metric: string; ts: number; value: number }> = [];
    for (const m of job.metrics) {
      for (const r of chunkRowsStmt.all(job.sn, m, job.cursorMs, to) as Array<{ ts: number; value: number }>) {
        rows.push({ metric: m, ts: Number(r.ts), value: r.value });
      }
    }
    rows.sort((a, b) => a.ts - b.ts);
    job.scanner.feed(rows);
    job.cursorMs = to;
    if (to < job.toMs) return true;
    scanQueue.shift();
    // The scanner kept only the stretches that qualify and the tails of spans an earlier scan
    // moved (planScan's keepUnqualified): every one returned here is a candidate.
    const stretches = job.scanner.finish();
    scanCandidates += stretches.length;
    if (stretches.length === 0) return true;
    const moveUntil = scanToMs - HELD_MOVE_MIN_AGE_MS;
    // v1.188.1 (review 2) — one stretch per last fresh reading per scan: a hole inside a hold no
    // longer splits it (createFrozenScanner), so nothing is chained here any more.
    for (const s of stretches) {
      // A span an earlier scan already moved is extended from where that move stopped. Its tail
      // alone may restate each metric only once or twice (the rows before it are gone): it is
      // still the same hold, from the same last fresh reading.
      const priorEnd = job.frozenEnds.get(s.startMs);
      // v1.188.1 (review 4) — a restored span gives back the HOLD, not only the rows an earlier scan
      // had moved: a stretch that overlaps it, or whose anchor is one of its rows (no metric changed
      // since its start), is left in samples, and the span's end follows the stretch's last row.
      // v1.188.1 (review 5) — a stretch anchored on a return reading after the restored end is not
      // one: after a silence, a return reading and another silence, the scanner starts the stretch
      // again from that reading (createFrozenScanner), as for any device, so a later replay of the
      // same readings is a new hold. What restore() logs says so.
      // Matched on overlap alone, a restore made while the device still restated its readings held
      // only until the 3 h re-read started after the restored end: from there each hourly scan's
      // anchor was a restated row of the same hold, and the rest of the hold was moved as a new span
      // (a second HELD SAMPLES line, the ledger refusing those hours again), while a boot scan after
      // a stop, re-reading from before it, left the same rows.
      const r = job.restored.find((x) => continuesRestored(x, s));
      if (r) {
        leaveRestored(job.sn, r, s);
        continue;
      }
      const end = Math.min(s.endMs, moveUntil);
      const from = priorEnd == null ? s.startMs : Math.max(s.startMs, priorEnd);
      if (end <= from) continue;
      scanSpans++;
      for (let a = from; a < end; a += HELD_MOVE_SLICE_MS) {
        moveQueue.push({ sn: job.sn, spanStartMs: s.startMs, fromMs: a, toMs: Math.min(end, a + HELD_MOVE_SLICE_MS), stretch: s, announce: priorEnd == null && a === from, rangeFromMs: from, rangeToMs: end, extension: priorEnd != null, plannedRestored: job.restored });
      }
    }
    return true;
  }

  /**
   * The held flow the lifetime counters had integrated over the rows a move range covers. The
   * counters integrate across the 5-min heartbeats (aggregator.integrateWh bridges up to 10 min)
   * but not across a longer gap: the held flow ran for the stretch's OBSERVED time. v1.188.1 (dry
   * run) — not endMs − firstHeldMs: a stretch with a gap inside it (rows on both sides) overstated
   * it, 400.8 kWh of pv_total on the live database where its held rows covered about 23 h (about
   * 36 kWh). v1.188.1 (review 2) — and only the observed time inside the range moved, so the ranges
   * of one span (its first scan, then each extension) add up to its held flow, each part once.
   */
  function heldFlowEstimate(job: MoveJob): string {
    const flows = [...job.stretch.heldValues].filter(([m, v]) => LIFETIME_FLOW_METRIC.test(m) && v > 0);
    if (flows.length === 0) return '';
    const ms = observedWithinMs(job.stretch, job.rangeFromMs, job.rangeToMs);
    return `; the lifetime energy counters had integrated about ${flows.map(([m, v]) => `${(v * ms / HOUR_MS / 1000).toFixed(1)} kWh of ${m}`).join(', ')} from these held readings, which are not rewritten (Home Assistant reads a decrease as a meter reset)`;
  }

  /** One slice moved: copy, delete, check the counts agree, log the span — one transaction. */
  function moveStep(): boolean {
    const job = moveQueue.shift();
    if (!job) return false;
    let moved = 0;
    try {
      // v1.188.1 (review 6) — IMMEDIATE: the write lock first, so the restored spans read below are
      // the ones the copy and delete run against (another connection cannot commit in between). A
      // lock held elsewhere fails this slice like any other step of it (below).
      db.exec('BEGIN IMMEDIATE');
      // v1.188.1 (review 6) — a restore since the scan was planned. The SQL of architecture 4.4
      // needs no restart, and a scan runs one step per timer tick: planned before the SQL, it went
      // on to move the rest of the hold (and the slices it had queued) under the span the owner had
      // just marked restored, and those rows stayed in held_samples for good, under a span that no
      // reader treats as held any more. The device's restored spans are read again here, in the
      // transaction, and a stretch that continues one is left in samples (leaveRestored).
      // (A span already restored when the scan was planned was matched by scanStep.)
      const r = (restoredOfStmt.all(job.sn) as Array<{ start_ts: number; end_ts: number }>)
        .map((x) => ({ startMs: Number(x.start_ts), endMs: Number(x.end_ts) }))
        .find((x) => !job.plannedRestored.some((p) => p.startMs === x.startMs) && continuesRestored(x, job.stretch));
      if (r) {
        db.exec('ROLLBACK');
        // Each later slice of the stretch finds the same span and is left too.
        if (job.fromMs === job.rangeFromMs) scanSpans--; // nothing of it moved: not a held stretch
        leaveRestored(job.sn, r, job.stretch);
        return true;
      }
      const copied = Number(moveCopyStmt.run(job.fromMs, job.toMs, job.sn).changes);
      const deleted = Number(moveDeleteStmt.run(job.fromMs, job.toMs, job.sn).changes);
      if (copied !== deleted) throw new Error(`copied ${copied} rows but would delete ${deleted}`);
      moved = copied;
      spanUpsertStmt.run(job.sn, job.spanStartMs, job.toMs, 'frozen', moved, now());
      // v1.188.1 (review) — rows left samples: the readers' closed-day memos are stale.
      if (moved > 0) bumpGenerationStmt.run();
      db.exec('COMMIT');
    } catch (e: any) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      // v1.188.1 (review) — the retry the log promises. The watermark is saved no later than this
      // span's start (finishScan), so the next scan re-reads the span from before it: its anchor is
      // that start again, not one of the held rows left in place, and the slices already moved are
      // extended from where they stopped (the span's prior end). v1.188.1 (review 3) — also when
      // the start is a kept restated row the re-read passes as a silence: the rows after the moved
      // part are measured from its end (createFrozenScanner), not made a return piece.
      if (job.spanStartMs < failedFromMs) failedFromMs = job.spanStartMs;
      o.log(`recorder: held-sample move FAILED for ${job.sn} (${new Date(job.fromMs).toISOString()} → ${new Date(job.toMs).toISOString()}): ${e?.message ?? e} — this slice was rolled back and the rest of the span left in samples; the next scan re-reads ${job.sn} from ${new Date(job.spanStartMs).toISOString()}`);
      // Drop the rest of this span's slices: the next scan re-reads the span.
      for (let i = moveQueue.length - 1; i >= 0; i--) if (moveQueue[i].sn === job.sn && moveQueue[i].spanStartMs === job.spanStartMs) moveQueue.splice(i, 1);
      return true;
    }
    scanRows += moved;
    if (moved > 0) o.onMoved?.(job.sn, job.spanStartMs, job.toMs, Math.max(job.toMs, job.stretch.endMs), job.stretch.heldValues);
    const lastSlice = !moveQueue.some((m) => m.sn === job.sn && m.spanStartMs === job.spanStartMs);
    if (job.announce) {
      const s = job.stretch;
      o.log(`recorder: ⚠ HELD SAMPLES — ${job.sn} restated its last reading from ${new Date(s.startMs).toISOString()} to ${new Date(job.rangeToMs).toISOString()} (${s.metrics} metrics, up to ${s.restatements} restatements each, no value changed); those rows are being moved from samples to held_samples — kept, not deleted, and restorable${heldFlowEstimate(job)}`);
    }
    if (lastSlice) {
      // v1.188.1 (review 2) — a span an earlier scan moved, extended: its range and its held flow
      // are stated here (the HELD SAMPLES line covered only what that scan moved).
      const ext = job.extension ? ` — the held span from ${new Date(job.spanStartMs).toISOString()} continued from ${new Date(job.rangeFromMs).toISOString()}${heldFlowEstimate(job)}` : '';
      o.log(`recorder: held samples of ${job.sn} up to ${new Date(job.toMs).toISOString()} moved to held_samples${ext}`);
    }
    return true;
  }

  function finishScan(): HeldScanSummary {
    try {
      // v1.188.1 (review) — not past a span a move failed on (moveStep). The later scans are
      // incremental from the watermark, so a span behind it would never be read again: its held
      // rows would stay in samples, and the ledger would see only the part moved before the fault.
      scanStateUpsertStmt.run(Math.min(scanToMs, failedFromMs), scanFull ? now() : null);
    } catch (e: any) {
      o.log(`recorder: held-sample scan watermark not saved (${e?.message ?? e})`);
    }
    if (scanFull || scanSpans > 0) {
      o.log(`recorder: held-sample scan ${scanFull ? '(first, over the retention window) ' : ''}done in ${Math.round((now() - scanStartedAt) / 1000)} s — ${scanSpans} held stretch(es), ${scanRows} row(s) moved to held_samples (none deleted)`);
    }
    ready = true;
    running = false;
    return { spans: scanSpans, rowsMoved: scanRows, full: scanFull, candidates: scanCandidates };
  }

  function failScan(e: any): void {
    scanQueue.length = 0;
    moveQueue.length = 0;
    running = false;
    ready = true; // fail-open: scoring proceeds as before rather than stalling for good
    o.log(`recorder: held-sample scan FAILED (${e?.message ?? e}) — rows written while a device was held may still be read as measurements until the next scan`);
  }

  /** Run a whole scan synchronously, in one call (tests). Production runs scanInSteps instead, on
   *  the same main thread — the alarm engine's — one step per timer tick. */
  function scanNow(atMs: number = now()): HeldScanSummary {
    if (running) throw new Error('a held-sample scan is already running');
    running = true;
    try {
      planScan(atMs);
      while (scanStep() || moveStep()) { /* until both queues drain */ }
      return finishScan();
    } catch (e) {
      failScan(e);
      throw e;
    }
  }

  /** Production: one step per timer tick, on the main thread (the recorder has no worker), so no
   *  tick holds the event loop — and with it alarm evaluation — for long. */
  function scanInSteps(stepDelayMs = 5): void {
    if (running || stopped) return;
    running = true;
    try {
      planScan(now());
    } catch (e) {
      failScan(e);
      return;
    }
    const tick = () => {
      if (stopped) { running = false; return; }
      try {
        if (scanStep() || moveStep()) {
          setTimeout(tick, stepDelayMs).unref();
          return;
        }
        finishScan();
      } catch (e) {
        failScan(e);
      }
    };
    setTimeout(tick, stepDelayMs).unref();
  }

  /** Reverse one exclusion: the span's rows go back to samples, unchanged, and the span is marked
   *  restored so no later scan moves it again (review 4: nor the rest of the same hold, scanStep).
   *  Returns the rows restored. */
  function restore(sn: string, startMs: number): number {
    const span = (db.prepare('SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = ?').get(sn, startMs, 'frozen') as { end_ts: number } | undefined);
    if (!span) return 0;
    let n = 0;
    db.exec('BEGIN');
    try {
      n = Number(restoreCopyStmt.run(sn, startMs, Number(span.end_ts)).changes);
      const d = Number(restoreDeleteStmt.run(sn, startMs, Number(span.end_ts)).changes);
      if (d !== n) throw new Error(`restored ${n} rows but would delete ${d} from held_samples`);
      markRestoredStmt.run(now(), sn, startMs, 'frozen');
      // v1.188.1 (review) — rows came back to samples: the same invalidation as a move.
      if (n > 0) bumpGenerationStmt.run();
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
    o.log(`recorder: restored ${n} held sample(s) of ${sn} (${new Date(startMs).toISOString()} → ${new Date(Number(span.end_ts)).toISOString()}) to samples; neither this span nor the rest of its hold, while the device goes on restating the same readings, will be excluded again — the hold ends when a reading changes, or when the device comes back from a silence of more than an hour with a return reading and falls silent again (a later replay is then a new hold)`);
    o.onRestored?.(sn, startMs, Number(span.end_ts));
    return n;
  }

  /** v1.188.1 (review 5) — the restored frozen span of `sn` that starts at `startMs`, or null (also
   *  when it cannot be read). The recorder asks before it files a gap record from a held start: a
   *  restore by SQL (architecture 4.4) made while the add-on runs never reaches onRestored. */
  function restoredSpanFrom(sn: string, startMs: number): { startMs: number; endMs: number } | null {
    try {
      const r = restoredFromStmt.get(sn, startMs) as { end_ts: number } | undefined;
      return r == null ? null : { startMs, endMs: Number(r.end_ts) };
    } catch (e: any) {
      o.log(`recorder: restored-span lookup failed for ${sn} (${e?.message ?? e})`);
      return null;
    }
  }

  /** Spans overlapping [sinceMs, untilMs] that are not restored, oldest first. */
  function spans(sinceMs: number, untilMs: number): HeldSpan[] {
    const out = (spansInStmt.all(sinceMs, untilMs) as Array<Record<string, unknown>>).map(toSpan);
    // An open gate span not yet persisted is not a held hour yet; a persisted one is current
    // to the minute. Extend persisted ones to the in-memory end.
    for (const s of out) {
      const g = gateOpen.get(s.sn);
      if (g && g.persistedAtMs > 0 && g.startMs === s.startMs && g.reason === s.reason) s.endMs = Math.max(s.endMs, g.endMs);
    }
    return out;
  }

  /** v1.188.1 (review 5) — restored spans overlapping [sinceMs, untilMs], oldest first: the night
   *  ledger re-captures a row refused for one (nightLedgerScoring.heldLedgerRepair). */
  function restoredSpans(sinceMs: number, untilMs: number): HeldSpan[] {
    return (restoredInStmt.all(sinceMs, untilMs) as Array<Record<string, unknown>>).map(toSpan);
  }

  /** v1.188.1 (review 3) — is a held row of (sn, metric) in [sinceMs, untilMs]? The night ledger's
   *  reset note says an actual was integrated from held readings only when one was inside the span
   *  it was captured over (nightLedgerScoring.heldCapturedClause). */
  function heldRowsWithin(sn: string, metric: string, sinceMs: number, untilMs: number): boolean {
    return heldRowWithinStmt.get(sn, sinceMs, untilMs, metric) != null;
  }

  /** The hourly retention sweep: held rows age off with the samples they were part of; the span
   *  log is kept past the night ledger's 60-day sweep. */
  function prune(atMs: number): { rows: number; spans: number } {
    const rows = Number(pruneHeldStmt.run(atMs - o.retainMs).changes);
    const sp = Number(pruneSpansStmt.run(atMs - Math.max(o.retainMs, 61 * DAY_MS)).changes);
    return { rows, spans: sp };
  }

  /** The recorder is closing: no further step touches the database. */
  function stop(): void {
    stopped = true;
    scanQueue.length = 0;
    moveQueue.length = 0;
  }

  return {
    noteGate,
    scanNow,
    scanInSteps,
    stop,
    isReady: () => ready,
    isRunning: () => running,
    restore,
    restoredSpanFrom,
    spans,
    restoredSpans,
    heldRowsWithin,
    prune,
    samplesGeneration: readGeneration,
  };
}

export type HeldSamples = ReturnType<typeof createHeldSamples>;
