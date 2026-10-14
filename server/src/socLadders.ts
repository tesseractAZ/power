/**
 * v1.187.22 — the backup-pool SoC audible ladders and the store tick that feeds them, moved out of
 * index.ts so the wiring is exercised by a test (test/socLadderBootHydration.test.ts) rather than
 * pinned by source: the HOUSE ladder (v0.12.0, 50/40/30/20/15/10/8/4/2 %, escalating priority) with
 * its grid-downgrade record (v0.23.0), one ladder per SECONDARY panel (v1.185.0), and the grid-drop
 * re-escalation pass — every one of them behind the boot gate (batterySocAlarm.ts socLadderBootGate).
 *
 * THE BOOT GATE. Until the store is hydrated (SnapshotStore.firstPollSettledAt) a tick reads a
 * PARTIAL device map: the device list has landed, but only the devices whose quota already answered
 * carry a projection. On 2026-10-12 the first tick after a host reboot (22:04:09) had no panel pool %
 * and one of the three roster Cores (49 %); the fallback mean read 49 % against a real 52 %, the
 * armed 50 % rung fired, and the house heard it at 22:06:33 and again for the real crossing at
 * 22:26:45. The ladders are a DEDICATED audible path (broadcast.announce, outside the broadcast's
 * boot-confirmation holds), so they wait here for the hydrated map, bounded by BOOT_HYDRATION_MAX_MS
 * from start (the alert monitor's bound): past it, what exists is fed exactly as before, so a cloud
 * outage at boot never holds a real alarm for good. The 'hydrated' event and the bound each run a
 * tick, so the first hydrated value is evaluated at once rather than on the next change; a second
 * feed of the same value is a no-op (a crossing disarms its rung; the re-escalation record deletes
 * what it announces). The live roster is still noted on a withheld tick — it is not a ladder feed.
 */

import type { AlarmPriority } from './alertPriority.js';
import { BOOT_HYDRATION_MAX_MS } from './alertMonitor.js';
import {
  createBatterySocAlarm, socAlarmMessage, socAlarmMessageEs, socAlarmAdvisory, socAlarmAdvisoryEs,
  socAlarmStatePathFor, socLadderBootGate,
} from './batterySocAlarm.js';
import { socGridCrossDecision, reEscalateGridDrop } from './socGridDispatch.js';
import {
  findShp2, shp2ConnectedDpuSns, housePoolFallbackSoc, housePoolFallbackCoverage, houseSnOf,
  secondaryPanels, panelMeanSoc,
} from './shp2Membership.js';
import type { DeviceSnapshot, FleetSnapshot } from './snapshot.js';

/** A pool's grid verdict as the ladders read it (gridState GridBackstop). v1.186.3 — importLive: wording only. */
export type PoolGrid = { backstopping: boolean; importLive?: boolean };

/** The slice of SnapshotStore the ladders use. */
export interface SocLadderStore {
  on(event: 'change' | 'hydrated', listener: (snap: FleetSnapshot) => void): unknown;
  off(event: 'change' | 'hydrated', listener: (snap: FleetSnapshot) => void): unknown;
  get(): FleetSnapshot;
  readonly firstPollSettledAt: number;
}

export interface SocLaddersDeps {
  /** BATTERY_SOC_ALARM_ENABLED — false: a tick does nothing. */
  enabled: boolean;
  /** broadcast.announce. */
  announce: (priority: AlarmPriority, message: string, messageEs: string | null) => Promise<{ ok: boolean; error?: string }>;
  /** The Alert Settings annunciation toggles. */
  isPriorityEnabled: (priority: AlarmPriority) => boolean;
  /** Keeps the grid-presence entity fresh (TTL-gated) before the tick's grid verdicts; may reject. */
  refreshGrid: () => Promise<void>;
  /** One pool's grid verdict (gridState livePoolGridBackstop). */
  poolGrid: (devices: Record<string, DeviceSnapshot>, panelSn: string | undefined) => PoolGrid;
  /** index.ts's durable roster: noted from every tick, read by the SHP2-blind fallback. */
  noteLiveRoster: (roster: ReadonlySet<string>) => void;
  lastKnownRoster: () => ReadonlySet<string>;
  log: (m: string) => void;
  warn: (m: string) => void;
  /** Test seams: the boot bound (default BOOT_HYDRATION_MAX_MS), the clock, the ladders' state files. */
  bootHydrationMaxMs?: number;
  now?: () => number;
  houseStatePath?: string;
  panelStatePathFor?: (sn: string) => string;
}

export interface SocLadders {
  /** The house ladder's grid-downgraded bands (pct → the TRUE priority) — exposed for tests/diagnostics. */
  readonly houseDowngraded: Map<number, AlarmPriority>;
  stop(): void;
}

export function startSocLadders(store: SocLadderStore, deps: SocLaddersDeps): SocLadders {
  const { announce, isPriorityEnabled, log } = deps;
  const now = deps.now ?? Date.now;
  const startMs = now();
  const maxMs = deps.bootHydrationMaxMs ?? BOOT_HYDRATION_MAX_MS;

  // v0.23.0 — the grid-backstop verdict for the CURRENT tick, recomputed once per
  // store change (with a fresh HA cache when a grid entity is configured) and read
  // by onCross — so the audible downgrade decision uses the same grid state as the
  // on-screen alerts.ts path (no stale-cache divergence). Assigned before every update.
  let socGridForTick: PoolGrid = { backstopping: false };
  // v0.23.0 — thresholds whose audible was grid-downgraded to a low advisory:
  // pct → the TRUE (high/critical) priority. The SoC ladder is one-shot per
  // downward crossing, so if the grid stops backstopping while the pool is still
  // in a downgraded band, the dedicated audible would otherwise NEVER re-fire
  // (fail-silent). We re-escalate it from the tick below.
  const socDowngraded = new Map<number, AlarmPriority>();
  const batterySocAlarm = createBatterySocAlarm({
    statePath: deps.houseStatePath,
    onCross: (t, isPrimary) => {
      // Grid-aware: when the grid is backstopping the home, a low pool is a
      // non-event (the SHP2 transfers to mains at the floor), so the emergency
      // tiers (high/critical — the ≤10% bands) collapse to a low advisory. Off-grid
      // (the safe default) keeps the original priority.
      // v0.76.0 — grid-aware downgrade decision extracted to the pure, tested
      // socGridCrossDecision() (was inline downgradePriorityForGrid + comparison).
      const { priority, onGrid } = socGridCrossDecision(t, socGridForTick.backstopping);
      // Record/clear the grid-downgrade re-escalation state for EVERY crossed band —
      // primary or not — so a later grid drop re-escalates every band the pool is
      // still in. v0.75.0 collapses only the ANNOUNCE (below), never this bookkeeping;
      // recording only the worst band would let a grid drop fail-silent on the higher
      // emergency bands after a partial recovery above the worst one.
      if (onGrid) socDowngraded.set(t.pct, t.priority);
      else socDowngraded.delete(t.pct);
      // v0.75.0 — only the most-severe band of a same-tick multi-band crossing
      // announces, so a reconnect-at-low-SoC (or fast discharge) produces ONE audible
      // alarm rather than laddering 50/40/30/20. The on-screen alert (activeSocBand)
      // shows the current band independently, and the per-band socDowngraded record
      // above is unaffected, so nothing is suppressed — only the audio is de-duped.
      if (!isPrimary) return;
      if (!isPriorityEnabled(priority)) return;          // honour the Alert Settings annunciation toggles
      const message = onGrid
        ? socAlarmAdvisory(t.pct, undefined, socGridForTick.importLive) // v1.186.3 — wording by measured import
        : socAlarmMessage(t);
      const messageEs = onGrid ? socAlarmAdvisoryEs(t.pct, undefined, socGridForTick.importLive) : socAlarmMessageEs(t); // v0.62.0 — Spanish second pass
      // v1.78.0 — surface the disposition: the 08-12 21:11 SoC-ladder suppression
      // (deepest rung of the day) left NO log line and cost two audits a false
      // timezone theory. Suppressions are config-correct; they must still be seen.
      void announce(priority, message, messageEs).then(
        (a) => { if (!a.ok) log(`soc-alarm: audible suppressed (${a.error ?? 'unknown'}) — push/on-screen unaffected`); },
        () => { /* announce() reports via its own path; never let a rejection escape a fire-and-forget */ },
      );
    },
    log,
  });

  // Re-escalate a previously grid-downgraded crossing if the grid is no longer
  // backstopping while the pool is still at/below that threshold — closes the
  // one-shot fail-silent window on a grid drop.
  //
  // NOTE (do not "fix" as fail-silent): the store 'change' tick is NOT driven only
  // by SHP2 MQTT telemetry. SnapshotStore.setDeviceList() emits 'change'
  // UNCONDITIONALLY on every REST poll tick (refreshAll → setDeviceList, driven by
  // startPollLoop every POLL_INTERVAL_MS, default 60s), and that same poll refreshes
  // acInWatts / backupBatPercent / chargeWattPower via getQuotaAll; the grid-presence
  // HA entity is refreshed independently in the tick (deps.refreshGrid). So this
  // re-escalation self-heals on the ~60s REST cadence even under a TOTAL MQTT stall —
  // the poll loop is the de facto timer that closes the grid-drop window; it does not
  // depend on fresh SHP2 MQTT telemetry.
  // v0.76.0 — the grid-drop re-escalation pass is the pure, tested reEscalateGridDrop()
  // (mutates socDowngraded + returns the bands to announce).
  const reEscalateHouse = (soc: number | null, backstopping: boolean): void => {
    for (const { pct, priority } of reEscalateGridDrop(socDowngraded, soc, backstopping, isPriorityEnabled)) {
      void announce(priority, socAlarmMessage({ pct, priority }), socAlarmMessageEs({ pct, priority })).then(
        (a) => { if (!a.ok) log(`soc-alarm: grid-drop re-escalation audible suppressed (${a.error ?? 'unknown'})`); },
        () => { /* see soc-alarm note above */ },
      );
    }
  };

  // v1.185.0 — one SoC ladder per SECONDARY panel, created on first sight: its own persisted arming
  // state (battery-soc-alarm-<serial>.json), its own grid-downgrade record, and words that name
  // its pool. The rules are the house ladder's above, read against the same tick's grid.
  const panelStatePathFor = deps.panelStatePathFor ?? socAlarmStatePathFor;
  const panelLadders = new Map<string, { update: (soc: number | null, name: string, grid: PoolGrid) => void }>();
  function panelSocLadder(sn: string): { update: (soc: number | null, name: string, grid: PoolGrid) => void } {
    const have = panelLadders.get(sn);
    if (have) return have;
    const downgraded = new Map<number, AlarmPriority>();
    let name = sn;
    // v1.185.0 (review) — THIS pool's grid verdict (livePoolGridBackstop), set before each update.
    let poolGrid: PoolGrid = { backstopping: false };
    const say = (priority: AlarmPriority, en: string, es: string, what: string) => {
      void announce(priority, en, es).then(
        (a) => { if (!a.ok) log(`soc-alarm [${name}]: ${what} audible suppressed (${a.error ?? 'unknown'}) — push/on-screen unaffected`); },
        () => { /* see soc-alarm note above */ },
      );
    };
    const alarm = createBatterySocAlarm({
      statePath: panelStatePathFor(sn),
      onCross: (t, isPrimary) => {
        const { priority, onGrid } = socGridCrossDecision(t, poolGrid.backstopping);
        if (onGrid) downgraded.set(t.pct, t.priority);
        else downgraded.delete(t.pct);
        if (!isPrimary || !isPriorityEnabled(priority)) return;
        say(
          priority,
          onGrid ? socAlarmAdvisory(t.pct, name, poolGrid.importLive) : socAlarmMessage(t, name), // v1.186.3
          onGrid ? socAlarmAdvisoryEs(t.pct, name, poolGrid.importLive) : socAlarmMessageEs(t, name),
          'crossing',
        );
      },
      log: (m) => log(`${m} [${name}]`),
    });
    const ladder = {
      update: (soc: number | null, n: string, grid: PoolGrid) => {
        name = n;
        poolGrid = grid;
        alarm.update(soc);
        for (const { pct, priority } of reEscalateGridDrop(downgraded, soc, poolGrid.backstopping, isPriorityEnabled)) {
          say(priority, socAlarmMessage({ pct, priority }, name), socAlarmMessageEs({ pct, priority }, name), 'grid-drop re-escalation');
        }
      },
    };
    panelLadders.set(sn, ladder);
    return ladder;
  }

  // v1.187.22 — the boot gate's latch: open once, never closed again. One line when it first
  // withholds a tick, one when it opens.
  let gateOpen = false;
  let boundReached = maxMs <= 0;
  let withheldTicks = 0;
  let boundTimer: ReturnType<typeof setTimeout> | null = null;
  const bootGateOpen = (devices: Record<string, DeviceSnapshot>, shp2Soc: number | null, soc: number | null): boolean => {
    if (gateOpen) return true;
    const elapsedMs = now() - startMs;
    const gate = socLadderBootGate({
      firstPollSettledAt: store.firstPollSettledAt,
      elapsedMs: boundReached ? Math.max(elapsedMs, maxMs) : elapsedMs,
      maxMs,
    });
    if (gate === 'withhold') {
      if (withheldTicks === 0) {
        const cov = housePoolFallbackCoverage(devices, deps.lastKnownRoster());
        const house = shp2Soc != null
          ? `the house pool reads ${shp2Soc.toFixed(1)}%`
          : `the house pool's own figure is not hydrated; the fallback would read ${soc == null ? 'nothing' : `${soc.toFixed(1)}%`} from ${cov.reporting} of ${cov.roster} roster Cores`;
        const others = secondaryPanels(devices).length;
        log(`soc-ladder: withholding the SoC ladders until the first poll settles (at most ${Math.round(maxMs / 1000)} s) — ${house}${others > 0 ? `; ${others} other panel ladder(s) held too` : ''}`);
      }
      withheldTicks++;
      return false;
    }
    gateOpen = true;
    if (boundTimer) clearTimeout(boundTimer);
    if (gate === 'hydrated') {
      log(`soc-ladder: the first poll settled ${Math.max(0, store.firstPollSettledAt - startMs)} ms after start — the SoC ladders read the hydrated map from here (${withheldTicks} tick(s) withheld)`);
    } else {
      deps.warn(`soc-ladder: WARNING — no complete poll within ${Math.round(maxMs / 1000)} s of start; the SoC ladders read the data that exists (${withheldTicks} tick(s) withheld)`);
    }
    return true;
  };

  const tick = (snap: FleetSnapshot): void => {
    if (!deps.enabled) return;
    const shp2 = findShp2(snap.devices);
    const shp2Soc = shp2 && shp2.projection?.kind === 'shp2' ? shp2.projection.backupBatPercent : null;
    // v1.8.0 (review F3) — reserve-chain SHP2-blind failover. The SoC ladder reads
    // ONLY the SHP2 backup-pool %, which nulls when the SHP2 goes cloud-offline; the
    // 30-day review found two blackouts (42.2h, 25.8h) in which the pool crossed
    // 50/40/30/20% while the ladder sat dark for 17.8-20.8h. When that field is null,
    // fall back to the mean SoC of the home Cores still reporting (the pool IS those
    // batteries) so the audible ladder keeps firing. homeFleetMeanSoc returns null
    // only when NO Core is reporting — then the reserve-blind warning (computeAlerts)
    // + the offline alerts are the signal, and update(null) is a safe no-op. The
    // engine's own coherence guard still rejects an implausible drop from a fresh
    // baseline, so a bad fallback read can't ladder falsely.
    // v1.117.0 — keep the durable roster fresh, and hand it to the fallback so an
    // unhydrated tick can never admit a bench spare into the pool mean.
    deps.noteLiveRoster(shp2ConnectedDpuSns(snap.devices));
    const soc = shp2Soc != null ? shp2Soc : housePoolFallbackSoc(snap.devices, deps.lastKnownRoster());
    // v1.187.22 — nothing below (house ladder, secondary ladders, re-escalation) reads a partial boot map.
    if (!bootGateOpen(snap.devices, shp2Soc, soc)) return;
    void (async () => {
      // Keep the grid-presence entity fresh (TTL-gated) so onCross + the
      // re-escalation below see live grid state. Assign + update run synchronously
      // after the await, so onCross reads exactly the grid computed for this tick.
      try {
        await deps.refreshGrid();
      } catch {
        /* cold/stale cache ⇒ resolves to off-grid (safe) */
      }
      // v1.185.0 (review) — the HOUSE pool's own verdict on a multi-panel plant; one panel: identical
      // (livePoolGridBackstop returns liveGridBackstop there).
      socGridForTick = deps.poolGrid(snap.devices, houseSnOf(snap.devices));
      batterySocAlarm.update(soc); // fires onCross synchronously, reading socGridForTick
      // v1.185.0 — every OTHER panel's pool on its own ladder, against its own panel's grid — including
      // a panel with no projection (dark since a restart): its own Cores, from its persisted roster.
      for (const p of secondaryPanels(snap.devices)) {
        const own = p.projection?.kind === 'shp2' ? p.projection.backupBatPercent : null;
        panelSocLadder(p.sn).update(own ?? panelMeanSoc(snap.devices, p), p.deviceName, deps.poolGrid(snap.devices, p.sn));
      }
      reEscalateHouse(soc, socGridForTick.backstopping);
    })();
  };

  const onHydrated = (snap: FleetSnapshot): void => tick(snap);
  store.on('change', tick);
  store.on('hydrated', onHydrated);
  // v1.187.22 — at the bound, the ticks withheld so far are fed what exists without waiting for the
  // next change (a timer, as the alert monitor's).
  if (deps.enabled && !boundReached) {
    boundTimer = setTimeout(() => {
      boundTimer = null;
      boundReached = true;
      if (!gateOpen) tick(store.get());
    }, maxMs);
    boundTimer.unref?.();
  }

  return {
    houseDowngraded: socDowngraded,
    stop: () => {
      if (boundTimer) clearTimeout(boundTimer);
      boundTimer = null;
      store.off('change', tick);
      store.off('hydrated', onHydrated);
    },
  };
}
