### 4. The alert monitor — `startAlertMonitor()` (`alertMonitor.ts`)

**WHAT.** Runs `evaluate()` every `EVAL_INTERVAL_MS` (`ALERT_EVAL_MS`, default 20 s), re-entrancy-guarded (`evaluating` latch — an overlapping tick during a hung send is skipped). **Boot gate (v1.186.0):** no pass runs (no publish, no first-run seeding, no onset prune) until the store is hydrated by its first complete poll or `BOOT_HYDRATION_MAX_MS` (`ALERT_BOOT_HYDRATION_MAX_MS`, default 30 s) passes. Past that bound the monitor evaluates on the data that exists and logs a WARNING; offline and telemetry-blind alarms still fire. Each tick: assembles the full alert list from all sources above, `store.setAlerts()`, `buildIncidents()`, then processes rising edges, the morning digest, and falling edges.

**Worker-served inputs.** forecast, storm-prep, curtailmentAlerts, baselineAlerts and forecastAlerts are last-good feeds (`createLastGoodFeed`): each tick waits at most `ALERT_FEED_BUDGET_MS` (2.5 s) and otherwise carries the last good value, never an empty list. The worker's recompute of the four analytics feeds routinely outlasts the budget, so a one-pass budget carry is the normal path and is **not logged** (v1.187.0). A carry is logged when the read FAILED (at once), when a budget carry reaches `ALERT_FEED_CARRY_LOG_PASSES` (2) consecutive passes, and — as a WARNING through the monitor's warn sink, once per episode — at `ALERT_FEED_STUCK_WARN_PASSES` (15, ~5 min; the four worker feeds — storm-prep keeps the info sink, its line still reads "WARNING —"); "fresh again" is logged only for an episode whose carry was. `/api/notify/status` `alertFeeds[]` reports each feed's `warm`, `ageMs`, `carrying`, `lastError` and `carryEpisodes` (every carry since boot, logged or not).

#### 4.1 Rising edges, debounce, dispatch decision

For each alert not yet tracked, the monitor queues a feature snapshot (§6; taken detached after the tick's dispatches since v1.186.0, `captureFeaturesDetached`) and counts the rise with `recordRise()` only when the alert annunciates (`autoTuneCounts`) and is not a re-track of a condition that predates the restart (`bootRetrackDecision`). It then seeds a `TrackedAlert` with `notified = bootSeedNotified(...)` (a boot-standing alert is seeded as already notified, except an outage event and a critical with no notify-state record). For an already-tracked alert it updates `peakSeverity` (the most-severe severity ever reached), refreshes the notify-state record if older than `NOTIFY_STATE_REFRESH_MS` (12 h), and — if annunciating — computes the dispatch decision.

**Debounce.** `DEBOUNCE_MS` (`ALERT_DEBOUNCE_MS`, default 60 s). Critical alerts bypass this debounce (0 ms) so a brief critical isn't swallowed. The push hold-downs of `pushDebounceMsFor` (§4.5) still apply on top, so a fresh `vdiff-crit-` push waits `SETTLE_PUSH_DEBOUNCE_MS` (5 min); only an escalation to critical skips every hold (`escDebounceMs = 0`). The per-circuit load-anomaly family (`baseline-(ch|pair)N_w-…`, `isSustainGatedLoadAnomaly`) uses a much longer fire debounce `BASELINE_LOAD_SUSTAIN_MS` (`BASELINE_LOAD_SUSTAIN_MS`, default 8 min) so a normal compressor cycle clears inside the window and never pushes.

**Escalation.** `isAlertEscalation(prev, severity)` — an alert that has escalated above the severity it was last acted on (dispatched OR queued) re-notifies even after a prior push; a critical escalation bypasses debounce.

**The pure decision** `decideAlertDispatch({qualifies, alreadyNotified, alreadyQueued, escalated, debounceElapsed, inQuiet, breaksThrough})`:

```
eligible = (!alreadyNotified && !alreadyQueued) || escalated
if !eligible || !debounceElapsed || !qualifies → 'none'
return inQuiet && !breaksThrough ? 'queue' : 'dispatch'
```

`qualifies(sev, cfg.minSeverity)` gates on the configured minimum severity.

#### 4.2 Quiet hours (F1) and the morning digest

- `QUIET_WINDOW = parseQuietHours(NOTIFY_QUIET_HOURS)` (default `"22-06"`; `inQuietWindow` handles the midnight wrap). During quiet hours warning/info are queued for the morning digest.
- `CRITICAL_BREAKS_QUIET` (`CRITICAL_BREAKS_QUIET_HOURS`, default **false**) — when false, critical alerts are ALSO held for the digest (nights stay truly quiet); set `true`/`1` to be woken for criticals. At the default, every tier including critical is held until `DIGEST_HOUR`, and the digest says so and names the option.
- `DIGEST_HOUR` (`NOTIFY_DIGEST_HOUR`, default 7). `dispatchDigest()` fires once when the local hour rolls to `DIGEST_HOUR`, sorted most-severe first, one line per subject with ISA-priority labels. It only digests entries still legitimately held (`tracked.get(id)?.queued === true`), and on success marks them notified + `pushSent` + persisted (deferred from queue-time, so a pre-digest restart re-queues rather than drops). A failed digest send does NOT latch `lastDigestHour`, so it retries each tick within the hour. No channel configured ⇒ it logs loudly and drops the queue.

Queue mechanics: `action === 'queue'` sets the `queued` flag and `notifiedSeverity` (NOT `notified`, and no notify-state record), so a restart re-evaluates the alert. The held queue itself and the overnight-resolved records persist to `digest-queue.json` beside the DB (`DIGEST_STATE_PATH`, v1.86.0, written on every change) and are rehydrated at boot, so a hold that spans a restart still reaches the digest (`queuedRehydrated`, v1.130.0); an escalation-while-queued replaces the held entry in place (one line, escalated severity).

#### 4.3 Incident clustering — `buildIncidents(alerts)`

Groups the current alert list into `Incident`s so a cascade fires one notification, not five:

- **Pack-scoped** (`inc-core{N}.pack{M}`) — 2+ alerts on the same (Core, Pack); title "N concurrent alerts on Core X · Pack Y".
- **Core-scoped** (`inc-core{N}`) — 2+ alerts on the same Core with no pack; a same-category Thermal cluster is titled "Thermal cascade on Core X".
- **System-scoped** (`inc-system-<id>`) — orphans with no Core/pack pass through as 1-alert incidents.

Sorted by severity then alert-count desc. Served at **`/api/incidents`** (`{ incidents }`, cached 15 s).

#### 4.4 Cooldown / churn auto-silence

Family rollups (`AlertActionStats`, keyed by `familyOf`) track `riseCount`, `shortClearsCount`, `neverClearedCount` (longActive), `medianDurationMs` (EWMA), etc. Clear-duration classification (`classifyClearDuration`): `shortClear` = duration ≤ `SHORT_CLEAR_MS` (10 min), `longActive` = duration ≥ `CHRONIC_NOISE_LONG_MS` (4 h). **Every** cleared rise is counted (a sub-debounce <60 s flap is the most transient clear and MUST count as a shortClear — F for auto-demote reachability). Durations are clamped `max(0, ...)` against the Pi's backward clock jumps.

`applySilencingRules(t)` re-derives three flags from current counters on every evaluation (never one-way latches):

| Rule | Trigger | Effect |
|------|---------|--------|
| 1 (info silence) | `severity==='info'` & `riseCount≥5` & shortFrac ≥ 0.7 | `downgradedSilenced` → skip dispatch |
| 2 (warn→info) | `severity==='warning'` & `riseCount≥10` & shortFrac ≥ 0.8 | `warningDemotedToInfo` → notify at info priority |
| 3 (chronic noise) | not critical & `riseCount≥10` & neverClearFrac ≥ 0.5 | `chronicNoiseSilenced` → skip dispatch |
| 4 (high-volume) | not critical & `riseCount≥150` & neverClearFrac ≤ 0.2 | warning→demote, info→silence |

**The rules gate rises only (v1.187.0).** `autoTuneDispatchVerdict(t, alert, 'resolved')` always passes: whether a resolve is owed is decided by `shouldSendResolve`, and the resolve carries the HA drawer dismissal and the same-tag phone replacement, so a family that latches after a push can no longer strand that push's card (a latch flipping mid-tick used to drop whichever same-family resolve came last). Neither resolve path reads the rollups or the alert's `annunciate` flag (§4.5), nor (**v1.187.3**) the tier a Rule 2 demotion showed: a "[Low]" push owes its resolve like any other. One difference remains by design: a falling-edge resolve goes through dispatch, which honours an ISA priority the operator has turned off in Alert Settings since the push (the resolve is suppressed and logged, and that card stands); the boot orphan sweep sends from a notify-state record, which carries no priority to consult.

**Rebased families (v1.187.0).** `TELEMETRY_FAMILY_BASIS` (alertTelemetry.ts) lists families whose emitter changed what it lets annunciate — `baseline-mppt_hv_temp` and `baseline-mppt_lv_temp` (basis `mppt-load-comparable`: cooler-than-typical and load-explained MPPT readings stopped annunciating), and **v1.187.3** `peer-voldiff` (basis `peer-voldiff-high-side`: since v1.187.1 a lower cell spread than the siblings' is info and `annunciate:false`; its earlier short episodes were part of the 80.0% that held Rule 2 at its cutoff on 2026-10-01, and without three of them the family read 78.1%). `appendTelemetryEvent` stamps their basis on every new line, and `replayTelemetryEvents` does not replay a line of such a family without it (`rebasedSkipped` / `rebasedFamilies`, logged at boot by `rebasedReplayLine` with what each basis left out — `TELEMETRY_BASIS_DROPPED` — and the verdicts lifted). Like the v1.186.0 scope reset, this can only lift a silence or demotion; a family that is genuinely noisy re-latches from current-rule events (Rule 2 after 10 rises).

**Critical is never silenced or demoted.** `ENERGY_STATE_FAMILIES` are exempt from all four rules (a fast clear is a genuine recovery, not jitter): `backup-soc`, `shp2-below-reserve`, `shp2-near-reserve`, `soc-low`, `forecast-runtime`, `offline`, `stale`, `msg-rate-floor` (v1.120.0), `forecast-soc-dip`, `reserve-alarm-blind`. Bench-spare churn rolls up under separate `offline-spare` / `stale-spare` families so it can still be auto-tuned without poisoning home-device stats.

**v1.95.0 — off-panel annunciation demotion.** Annunciation used to be gated solely by the static `SPARE_DPU_SNS` literal, which describes the bench only at the moment it was written; the 2026-08-20 reconfiguration inverted it, so a benched Core chimed at full volume (19 of 19 pushes and 48 of 67 s of audio in one window) while a live home Core sat inside the literal. A DPU absent from a **non-empty** SHP2 roster is now demoted to `annunciate:false`, with three guards, each mutation-proven load-bearing (`scripts/mutate-off-panel-annunciation.mjs`, 6/6): **hysteresis** — `OFF_PANEL_DEMOTE_TICKS` (3) consecutive absences to demote but **one** sighting to re-arm, so a flickering `isConnect` can never silence a live home Core; **empty roster demotes nobody**, because an unreadable panel is not evidence; and a **thermal-critical carve-out** — a `critical` alert in category `Thermal` is never demoted, since a bench pack that is overheating must page regardless of where it is wired. Pure cores `advanceOffPanelStreaks` / `shouldDemoteAnnunciation` are exported for tests.

**v1.102.0 — pack identity follows the hardware.** Alert ids are keyed `(chassis, slot)`, so a physical pack swap silently re-points a live id at different hardware — on 2026-08-20 `vdiff-crit-<sn>-1` carried through with no resolve and no re-raise, its detail changing from "Deviant cell #31" to "cell #32" mid-episode, merging two batteries into one cleared-alert record. Every pack-scoped alert now carries `sourcePackSn` (the BMS reports it on every read). When that serial changes under a live id, `alertMonitor` retires the episode through the SAME helper a natural clear uses — honest duration, cleared-log record — and the rising-edge pass opens a fresh one. `/api/warranty-export` matches on the pack serials a device currently holds, and `?packSn=` narrows the bundle to one pack wherever it has lived; records predating the field still fall back to the chassis match. **Ids are deliberately unchanged**: re-keying them would force a one-time fleet-wide resolve/re-raise and break the persisted notified-state dedup, a large blast radius for a narrow correctness problem.

**v1.101.0 — the quiet half.** Demoting off-panel hardware removed the noise but left the inversion: the defective warranty pack, sitting on a bench chassis, was the one battery nobody was paged about. `pack-defective-<sn>-<pack>` is a STANDING alert (one per device+pack, deduped to a single push, resolving on replacement) raised on a two-leg signature — a BMS protection latch (`packLatchSignature`: SoC ≥ 20 pts below the sibling median, < 25 W exchanged, siblings ≥ 100 W) AND a deviant cell at least `DEFECTIVE_PACK_MIN_DEVIANT_MV` (50 mV) from the pack median. The second leg is a threshold, not a null check, because `packCellForensics` names its most-deviant cell even on a matched pack. Both demotion paths (the bench-spare stamp in `alerts.ts`, the off-panel demotion in `alertMonitor.ts`) consult one shared predicate `isNeverMutedAlert` — critical Thermal, or a confirmed-defective pack — so they cannot drift apart. Harness `scripts/mutate-never-muted.mjs` (8/8). In `dispatch()`, a critical alert is never suppressed even if its family latch was set from info/warning noise.

**v1.108.0 — the LATCH.** The first day the TOU window let the bench bank charge (2026-08-24), the alert fired and resolved three times: leg 3 of the live signature (siblings ≥ 100 W) tracks the charger's burst duty cycle, so the alert cleared every time a burst ended — a [High] push plus a Resolved push per burst, a cry-wolf cadence on the one alert exempt from every mute path. "Confirmed defective" is a diagnosis, not a live condition. `defectivePackLatch.ts` records the first full-signature observation per PHYSICAL pack serial (`/data/defective-pack-latch.json`; the 08-20 swap proved faults travel with the pack, so the key is packSn, never the slot), and from then on the standing alert is emitted whenever that pack is present — legs or no legs — with a detail that names the confirmation date and the captured evidence. It clears when the pack leaves the fleet (emission stops at once; the record itself retires 48 h later so a replacement with the same SN does not inherit the verdict — **v1.187.1:** the retirement is logged through the alert monitor's warn sink, a timestamped structured line at level 40, naming the pack serial, Core, slot, chassis serial and confirmation date, whether it was the 48 h absence or the 90-day backstop, and the full evidence snapshot; unwired it falls back to `console.warn`. The confirmation time is rendered by `isoOrRaw` — the number itself when it is outside the `Date` range, since the file is validated only as a number — and a sink that throws falls back to `console.warn` of the record, so a log line can never block the retirement or the alert tick; the quiescent emission's confirmation date uses the same formatter) or via the operator's `POST /api/defective-packs/clear?packSn=…` (write-auth). `GET /api/defective-packs` lists the latched records. Without a reported packSn the legs-only v1.101.0 behavior stands — nothing may latch on a slot alone. Confirmations survive restarts; presence tracking is in-memory (a restart merely restarts the 48 h absence clock). Harness mutants vii/viii pin the two silent failure modes: quiescent-emission dropped (the flap returns) and confirmation-never-recorded (latch inert).

#### 4.5 Falling edges + resolve-side dwells

An alert absent this tick is a candidate for "Resolved:". Several family-specific dwells hold the falling edge to stop good-news spam from boundary flapping:

| Family predicate | Dwell | Env |
|------------------|-------|-----|
| `learned` alert within post-boot window | `LEARNED_RESOLVE_GRACE_MS` (10 min) | — (warm-up guard) |
| `isSustainGatedLoadAnomaly` | `BASELINE_LOAD_RESOLVE_DWELL_MS` (8 min) | `BASELINE_LOAD_RESOLVE_DWELL_MS` |
| `isSocResolveDwellFamily` (`soc-low-`) | `SOC_RESOLVE_DWELL_MS` (3 min) | `SOC_RESOLVE_DWELL_MS` |
| `isCellImbalanceResolveDwellFamily` (`vdiff-(warn\|crit)-`, `peer-voldiff-`) | `VDIFF_RESOLVE_DWELL_MS` (3 min) | `VDIFF_RESOLVE_DWELL_MS` |
| `isForecastDipResolveDwellFamily` (`forecast-soc-dip`) | `FORECAST_DIP_RESOLVE_DWELL_MS` (90 min) | `FORECAST_DIP_RESOLVE_DWELL_MS` |

The PUSH side has its own hold-downs in `pushDebounceMsFor`: the settle families
`vdiff-crit-`, **`vdiff-warn-` (v1.158.0)**, `peer-voldiff-`, `peer-soc-`, `soc-low-` and
`dpu-imbalance-` wait `SETTLE_PUSH_DEBOUNCE_MS` (5 min), and `msg-rate-floor-` waits
`MSG_RATE_PUSH_DEBOUNCE_MS` (20 min). v1.158.0 closed a push/resolve asymmetry: the warning
tier of the cell-imbalance family dwelled on the way OUT but not on the way IN, so three of
twenty pushes in the 09-13..15 window were ~3-minute settling excursions. Real home-pool
episodes there ran 12-37 min, so the hold costs under 5 minutes of notice.

Dwells are resolve-ONLY — they can never delay a fire, an escalation, or the audible alarm. If the alert reappears mid-dwell the rising-edge path clears `clearedSince`.

Once the dwell passes: the notify-state record is deleted FIRST (so a failed resolve can't strand a record that eats a future re-fire), then `shouldSendResolve(t, notifyResolved, minSeverity)` gates the "Resolved:" push on `pushSent === true` (a REAL delivered fire, NOT boot-seeded `notified`), `notifyResolved`, and qualifying on the severity the fire was notified at — its source severity (`notifiedSeverity`). **v1.187.3** — never the tier auto-tune demoted it to: v1.88.0 recorded the delivered tier (`notifiedEffectiveSeverity`, now removed) and a fire pushed as "[Low] … via auto-tune" owed no resolve, so its HA drawer card and same-tag phone notification stood after the condition cleared (2026-10-01: a "[Low]" peer cell-spread card pushed at 13:16 that cleared at 13:26 was still in the drawer at 19:11). The boot orphan sweep always resolved such a fire from its record's source severity; both paths now agree. An owed resolve is not subject to the auto-tune rules (v1.187.0; §4.4), nor to the alert's current `annunciate` flag (v1.187.0): the v0.16.4 `annunciate !== false` term guarded a boot-seeded spare that `pushSent` already excludes, and otherwise stranded the card of an alert muted after its push (an MPPT warning re-tracked as a cooler reading across the v1.187.0 deploy, a hot MPPT warning that turns load-explained, a vdiff critical pushed and then muted by balancing, an on-panel push followed by an off-panel demotion). Outage events never resolve. Clears with `duration ≥ DEBOUNCE_MS` are recorded to `clearedLog` (at peak severity). `recordClear()` updates telemetry regardless of duration.

#### 4.6 Notify-state persistence & boot reconcile

`persistedNotified: Map<id, NotifyRecord{ts, sent, sev?, title?, sourceSn?}>` survives restarts at `NOTIFY_STATE_PATH` (default sibling of the DB). Loaded with a `NOTIFY_STATE_MAX_AGE_MS` (24 h) TTL; still-active records are refreshed every 12 h so a >25 h cloud wedge keeps its owed "Resolved:" across the daily reboot. `orphanedNotifiedIds()` runs after the `LEARNED_RESOLVE_GRACE_MS` warm-up: persisted ids neither firing nor tracked are retired — resolved (if owed, dismissing the exact HA card via the id-as-dedupId) or merely dropped. The sweep waits out notify quiet hours (v1.129.0). An orphan whose source cannot be judged is HELD and re-checked each tick (v1.140.0, v1.186.0): its device absent or stale (`fallingEdgeFrozenByEvidence`, read through the record's `sourceSn`), a worker feed that owns it not yet delivered, or no complete poll yet. A held orphan still unobservable at `bootMs + LEARNED_RESOLVE_GRACE_MS + ORPHAN_HOLD_MAX_MS` (`ALERT_ORPHAN_HOLD_MAX_MS`, default 6 h) is dropped with a WARNING and no "Resolved:". One `notify: boot reconcile` line reports how many records were resolved, dropped and held. Dispatch is **at-least-once** (F): send first, mark `notified`/persist only when not `failed`; a failed send retries next tick.

Cleared history persists to `CLEARED_LOG_PATH` (default sibling of DB), cap `CLEARED_LOG_MAX` (`CLEARED_LOG_MAX`, default 1500, min 50). Eviction (`pruneOldestNonSignificant`) is severity-tiered; a critical is evicted only when the whole log is criticals. **v1.187.1** — each new row records `pushed` (the episode's push went out) and `rosterMuted` (`clearedRetention`: the alert never annunciated on any tick of the episode, its push never went out, and its id carries a serial the roster mutes — a bench spare or an off-panel Core — when it cleared). A tick on which the alert's Core has no settled roster mute does not count as annunciating (`rosterMuteUnsettledSns`: the panel roster not yet read in this process, or the Core part-way through its `OFF_PANEL_DEMOTE_TICKS` off-panel streak), since the streak restarts at 0 in every process and an off-panel Core's standing alerts annunciated on the first ticks after each restart; the mute, the push and the speech are unchanged, and a push still records `pushed`. Order: oldest info (**v1.187.3** — except a `CLEARED_INFO_KEPT_AS_WARNING_PREFIXES` row, `ems-volt-*`, a warning until v1.187.3, which is evicted as a warning: at the cap the info tier is nearly empty, and its rows are the band episodes' record and warranty evidence) → oldest roster-muted warning older than `CLEARED_ROSTER_MUTED_KEEP_MS` (30 days; the last month of bench-spare record stays whole) → oldest noise-flagged warning (auto-tune family flags) recorded as not pushed → oldest noise-flagged warning not recorded as pushed (**v1.187.10**) → oldest warning that is not `isNeverMutedAlert` and not warranty evidence (**v1.187.10 review** — a pushed noise row no longer leaves in the noise tiers, so it reaches this tier, and it must not outlive the evidence it used to leave before) → oldest warning that is not `isNeverMutedAlert` → oldest warning that is not `pack-defective-*` (the other never-muted ids, such as `shp2-multi-panel`, leave before it) → oldest warning → oldest overall. Warranty evidence (`warrantyEvidence`: every `pack-defective-*` row, the rows of its Core whose episode overlaps a pack-defective episode, and every row carrying that pack's `sourcePackSn`) never leaves in the roster or noise tiers, and `pack-defective-*` rows leave after every other warning. A row muted by a condition (balancing, top of charge) is not roster-muted and stays in the plain oldest-warning tier, so the record of whether a mute hid a real fault is kept like annunciated history; rows written before v1.187.1 carry neither field and stay there too. **v1.187.1 (log review)** — `loadClearedLog` keeps a row only when its alert's `id` and `severity` are strings, and the never-muted tier and `warrantyEvidence` read a non-string id as no id (such a row leaves with the ordinary warnings and is no one's evidence): a hand-edited or corrupt row without them threw in the eviction on every clear at the cap, so the tick aborted before its pushes, or re-sent the same "Resolved" push every tick. The monitor never writes such a row. **v1.187.10 (log review)** — at the live cap the ledger held 1417 warnings, 83 criticals and 0 info rows over 85 days: with no info row left, the oldest info row was the one just added, so every info clear left on arrival; and the window's only push (a noise-flagged `peer-voldiff` row) left on its own arrival through the noise tier while 85-day-old rows whose push is unknown stayed. The newest info rows now keep a reserve of one row in `CLEARED_INFO_RESERVE_DIVISOR` (15: 100 of 1500) — an info row leaves first only beyond it, and the reserved ones leave after every warning, still before any critical — and a row recorded as pushed never leaves in the noise tiers (it ages out with the ordinary warnings). The rehydrate line at the cap says what the ledger holds and what each new clear evicts (`clearedLedgerCapNote`: warning / critical / info counts, the oldest warning's age, the eviction order) instead of "older records are being dropped". Served at **`/api/alerts/history`** (cached 30 s per query) as a window of the ledger — `?days=N` (1..365, default 7), `?since=<ms>` or `?all=1` — newest first, each row reduced to the fields the Cleared table renders (`clearedHistory.ts`: `ClearedHistoryRow`, with `total`, `shown`, `windowDays` and `since`; the whole ledger was 1,500 rows and 1.2 MB a request, the 7-day window is about 7 % of that). The ledger, its cap and `history()` are unchanged, and the warranty export reads the file.

The `AlertMonitor` handle exposes `incidents()`, `telemetry()`, `history()`, `stats()`, `getConfig()`, `sendTest()`, `stop()`, `activeAlertIds()` and (**v1.187.3**) `alertSetSettledSince()`: since when every pass has published a set a green can be trusted from (`alertSetTrusted`; read by the broadcast's post-restart recovery, §10.2), or null.

---

### 5. Notification delivery, dedupe, digest — `notify.ts`

**Channels** (`NOTIFY_CHANNEL`, default `none`): `ha` or `none`. Home Assistant owns the
delivery; the add-on does not run a second push stack. A stored value from before
v1.124.0 (`ntfy` / `pushover` / `webhook`) fails **safe to `none`** rather than pretending
to deliver.

The `ha` channel does two things:

1. **`persistent_notification`** — the durable drawer card, one per active condition,
   dismissed when the condition clears.
2. **`notify.mobile_app_*`** — the actual phone push, to every service listed in
   `NOTIFY_HA_PUSH_TARGETS`. **With no targets there is no push at all** — only the
   drawer card, which the companion app shows when you open it: no lock-screen alert and
   no sound. `isConfigured()` answers "can we dispatch"; `reachesAPhone()` answers "does
   anything actually arrive", and they are deliberately separate questions.

**Config** (`loadNotifyConfig`):

| Env | Field | Default |
|-----|-------|---------|
| `NOTIFY_CHANNEL` | channel (`ha` \| `none`) | `none` |
| `NOTIFY_MIN_SEVERITY` | minSeverity (`warning`=warn+crit, `critical`=crit only) | `warning` |
| `NOTIFY_RESOLVED` | notifyResolved (`!= '0'`) | true |
| `NOTIFY_HA_PUSH_TARGETS` | pushTargets (comma-separated, `notify.` prefix optional) | `''` |
| `NOTIFY_CRITICAL_BYPASS_DND` | criticalBypassDnd (`!= '0'`) | true |

**Critical alerts break Do Not Disturb.** `buildMobilePushPayload` emits one payload that
serves both platforms, since each ignores the other's keys:

| Platform | Keys |
|---|---|
| iOS | `data.push.sound = { name: 'default', critical: 1, volume: 1.0 }` |
| Android | `data.ttl: 0`, `data.priority: 'high'`, `data.channel: 'alarm_stream'` |

Only `critical` gets it, and only while `NOTIFY_CRITICAL_BYPASS_DND` is on; with the
bypass off a critical still goes out promptly (`ttl 0`, `priority high`) but respects the
phone's settings. Warnings and advisories are always ordinary pushes — a warning that
behaves like an emergency teaches the owner to silence the channel that carries the
emergencies.

**Dedupe.** `NotifyMessage.dedupId` (= `notifyDedupId(alert)` = the alert id) drives per-subject card identity for the HA channel. `haNotificationId(dedupId, severity)` slugs the dedupId to `[a-z0-9_]` (≤96 chars, prefixed `ecoflow_panel_`); without a dedupId it falls back to the legacy per-severity id. `haNotifyCall(msg)`: a "Resolved:" with a dedupId issues `persistent_notification.dismiss` (drawer shows ACTIVE conditions only); a fire issues `create`. The title carries the ISA bracket and a device locator (`notifyLocator`), e.g. `EcoFlow · [Medium] Pack nearly empty — Core 3 pack 1`. The morning digest, the manual test push, and the `digest`/`test` cards each get distinct dedupIds so they never overwrite each other.

**Dispatch outcomes** (`dispatch()` in the monitor): `'sent'` (delivered), `'suppressed'` (policy gate — no channel / auto-tune silence / disabled priority), `'failed'` (send errored → retry next tick). Auto-tune warning→info demotion changes the `effectiveSeverity` (and the `[Low]` bracket) but keeps the underlying `NotifyMessage.severity` for the channel priority maps.

---

### 6. Outcome-capture feedback loop & feature snapshots

#### Feature snapshots — `featureSnapshot.ts`

On every RISE the monitor calls `captureSnapshot()` (in-memory LRU of `MAX_IN_MEMORY` = 500, persisted JSONL at `FEATURE_SNAPSHOTS_PATH`). Captures the feature vector AS IT WAS at fire time, since the operator may not ack for hours. `extractFeatures(alert, snap)` returns category-specific generic features (Thermal: pack temps + MPPT; Battery: SoC/power/voltage + pack SoH/cycles/vdiff; SHP2: pool SoC/reserve/panel load; Solar: PV totals/volts/amps; Grid/Connectivity: online + snapshot age). `captureLrFeatures(alert, snap, recorder)` additionally captures the REAL normalized ML feature vector (same `ml.ts` `extractFeatures` path `computePackRiskV2` uses) — only for pack-level alerts (`packNum != null`); null otherwise. A `SAME_RISE_GUARD_MS` (60 s, `Math.abs` for clock jumps) absorbs same-rise double-invocation; the file compacts at boot past `COMPACT_BYTES` (512 KB).

#### Outcome capture — `alertOutcomes.ts` + `POST /api/alerts/outcome`

The operator's response is the ground-truth label. `AlertOutcome ∈ {ack, dismiss, failed, resolved}`:

- `ack` → true positive; `dismiss` → false positive; `failed` → strong TP (preceded actual failure); `resolved` → ambiguous (excluded from precision).

`POST /api/alerts/outcome` (`{alertId, outcome, notes?}`; `requireWriteAuth` since v1.187.16) looks up the live alert (for category/severity) and the captured snapshot, appends an `AlertOutcomeEntry` (sanitized: verdict allow-listed, numbers coerced finite, strings control-stripped/length-bounded; IP+UA recorded for audit) to `ALERT_OUTCOMES_PATH` (append-only JSONL, kept forever), fires an online-LR weight update (`updateFromOutcome` — only when labelable and features exist; writes a shadow model, never overwrites the baseline), then drops the in-memory snapshot. Returns `{ ok, onlineLrUpdated }`.

`GET /api/alerts/outcomes?limit=` → `{ entries }` (tail, newest-first). `GET /api/alerts/outcomes/stats` → `{ families }`: `computeFamilyStats()` groups by `familyOf`, precision = `(ack+failed)/(ack+failed+dismiss)` — `null` unless the family has at least one dismissal and `FAMILY_MIN_DECIDED_OUTCOMES` (3) decided outcomes (`familyPrecision`, v1.123.0), plus median time-to-action — **null** for `PERSISTENT_FAMILIES` (`offline`, `grid-offgrid`) where `ts−alertFiredAt` is condition-age, not response latency.

#### Machine telemetry — `alertTelemetry.ts`

Separate from outcomes (machine-generated, valuable ~weeks). `appendTelemetryEvent()` writes `{familyKey, alertId, event: 'rise'|'shortClear'|'longActive', ts, durationMs?}` JSONL to `ALERT_TELEMETRY_PATH`. On boot `replayPersistedTelemetry()` re-hydrates rollups from the last `REPLAY_WINDOW_MS` (30 d) / `REPLAY_MAX_BYTES` (4 MB) so auto-silencing survives restarts; the file rotates past `ROTATE_AT_BYTES` (8 MB). `parseTelemetryLine()` strips a leading NUL run (F31 — recovers records torn by the daily power-cut mid-append). A `FamilyMeta` sidecar (`ALERT_FAMILY_META_PATH`) persists real title/severity/category **and (v1.131.0) the exemplar `alertId`** so a replayed family boots with true metadata instead of the `familyKey`/`info`/`Battery` placeholder. Served at **`/api/alert-telemetry`** (`{ telemetry }`, cached 30 s).

**v1.131.0 — the exemplar described two different alerts.** A rollup's
`alertId`/`title`/`severity`/`category` are one tuple: on the live path they are
always written together from a single `Alert`, so they are coherent by
construction. The sidecar persisted only three of the four, so a replay restored
the title/severity/category of the family's most recent member while taking
`alertId` from whichever event happened to come first in the JSONL window —
routinely a different device. `/api/alert-telemetry` therefore published, for
instance, Core 3's title next to Core 1's id, and anything keying off `alertId` to
reach the alert landed on the wrong subject. `familyMetaFor(alert)` now assembles
the tuple in one place so a field can only go missing by editing the invariant,
and `replaySeedExemplar(meta, eventAlertId, familyKey)` returns `pinned: true`
when the id comes from the sidecar — later events must not move it, because it is
the id that belongs to the sidecar's title. Sidecars written before v1.131.0 have
no `alertId`; those seed `pinned: false` (title falls back to the subject-neutral
`familyKey`, id tracks the family's LAST replayed event, matching the documented
"most recent member" contract) and self-heal on the family's first live sighting.
Mutation-proven load-bearing (`scripts/mutate-detector-honesty.mjs`, mutants
vi–viii).

---

### 7. Repair issues — `repairIssues.ts`

**WHAT.** A curated ACTIONABLE subset of alerts — only conditions the operator can physically fix — surfaced as REST + an MQTT-discoverable `binary_sensor` per repair. `computeRepairIssues(ctx)` builds them with a persistent first-seen map (`REPAIR_FIRST_SEEN_PATH`) so "active for N hours" survives restarts.

Issues emitted:

- `cloud-offline-<SN>` (Connectivity) — offline device (skips bench spares via `isBenchSpareSn`, which the last-known home roster overrides); severity mirrors the alert engine via `isCoreOrShp2()` (Core/SHP2 = warning, peripheral = info). 5-step reconnect/power-cycle guide.
- `wash-panels` (Cleaning) — per-DPU soiling ≥ `SOILING_CARD_DROP_PCT` (12%, aligned to the soiling alert) with `cleanDays ≥ 6` and, since v1.187.1, the row's `recentCovered` (as the alert requires it: a thin or stale recent window gives no card); warning if worst ≥ 22%.
- `peer-outlier-<SN>-<pk>` (Battery, warning) — a `degradation.peerOutlier` pack fading fastest.
- `mppt-drift-<SN>-<string>` (Hardware, info) — MPPT reading drift `< -3` pp. **v1.187.10** — titled "MPPT reading drift" and worded as a W ÷ V·A reading-consistency ratio; the steps are a meter check of the string's V and A at the MPPT input (it sent the operator to MC4 connectors, panel clamp checks and a warranty inquiry, none of which the ratio can indicate).
- `forecast-bias` (Configuration, info) — `|biasFactor − 1| > 0.25`.
- `storm-*` — active NWS storm alerts converted to a storm-prep checklist.

Stale ids are pruned each cycle. Served at **`/api/repair-issues`** (cached), assembled from the `forecastSkill`, `degradation`, `soilingDecomposition`, `equipmentHealth` analytics reports plus live devices + `snapshot.alerts`.

---

### 8. SHP2-membership zombie gate — `shp2Membership.ts`

**WHAT.** The safety machinery that decides which DPUs count as home fleet and which are expected-offline bench spares, so a spare's offline state is muted while a real home Core's is NEVER muted.

- `shp2ConnectedDpuSns(devices)` — set of DPU SNs the SHP2 reports as connected sources (`s.isConnected && s.sn`). Empty when no SHP2 observed → `isShp2Connected` returns true for every SN (DPU-only fallback; don't zero the dashboard).
- **`SPARE_DPU_SNS`** — the explicit SN literal that is the SAFETY FLOOR for bench spares: a DPU it does not name is never treated as a spare, so a faulted/unplugged home Core — which drops out of the SHP2's connected sources — still annunciates its genuine offline alarm. The literal can drift from the wiring (a swap can move a listed serial into the home pool), so since v1.121.0 `isBenchSpareSn(sn, lastKnownRoster?)` removes spare status from any listed serial that the durable last-known home roster (`setLastKnownHomeRoster`) names as a home-pool source. The roster can only remove spare status, never add it. This is the "zombie gate": membership is by explicit SN, not by dynamic `isConnected` (which would mute a faulted core).
- `isExpectedOfflineSpare(sn, connected, lastKnownRoster?)` — `!connected.has(sn) && isBenchSpareSn(sn, lastKnownRoster)` (v1.121.0; previously `SPARE_DPU_SNS.has(sn) && !connected.has(sn)`, which used the literal alone whenever the SHP2 went cloud-dark and `connected` emptied). The positive connected-source check RE-ARMS a spare the instant it is wired into an SHP2. Overloaded to accept a pre-computed Set (hot loop) or the raw devices Record.
- The monitor applies a central roster gate each tick (`applyRosterMute`): any alert whose id carries the serial of a bench spare, or of a Core absent from a non-empty panel roster for `OFF_PANEL_DEMOTE_TICKS` ticks, is stamped `annunciate: false` with its `muteReason`, except the `isNeverMutedAlert` ids (idempotent with the per-emitter spare stamp in `alerts.ts`).
- Supporting helpers: `isSourceDpuStale` (observability-only `dpuStale` flag), `homeCoreCoverage` (`{connected, reporting, complete}` — can we see the whole pool?), `homeFleetMeanSoc` (mean SoC of reporting home Cores — the reserve-alarm-blind fallback ladder), `aggregateFleetFlow` (SHP2-membership-filtered fleet power totals).

---

### 9. Root-cause & counterfactual (`analytics.ts`)

**Root-cause graph.** A static, hand-curated causal DAG (`CAUSE_GRAPH`) over the EcoFlow LFP architecture (cell imbalance / high temp / high R → fade rate → capacity loss → EOL; MPPT temp → efficiency drop → PV underperformance; cloud → PV shortfall → low forecast; grid disconnect → battery draw → reserve depletion). `rootCausesFor(alertId)` walks one hop backwards (matching by 2-token id family or `to`-prefix) and returns upstream `{id, description}` causes.

**Counterfactual driver analysis** lives inside `forecastDayAlerts` (§3.4): it decomposes a PV shortfall into cloud-cover vs everything-else and writes the `why` narrative into `forecast-soc-dip` / `forecast-low-solar`, so the operator learns *why*, not just *that*, the forecast is low.

Served at **`/api/root-cause?alertId=<id>`** → `{ causes }`.

---

### 10. Confidence — `computeConfidenceSnapshot()` (`analytics.ts`)

**WHAT.** A model-health headline used by the UI to say how much to trust the learned outputs. `GET /api/confidence` assembles it from the `degradation`, `ambientThermal`, and a **30-day** `forecastSkill` report (the window its r²≈0.94 premise was validated on), cached 60 s.

`ConfidenceSnapshot`: `degradationMedianR2`, `forecastDayR2` (Pearson r² of predicted vs actual daily PV kWh across ≥5 scored weather-covered days — replaced the degenerate within-slot median r²), `thermalMedianR2`, `forecastSkillBiasFactor`, `forecastSkillMaePct`.

---

### 11. Alert-annunciation settings — `alertSettings.ts`

A small user-mutable layer on top of the env baseline, persisted atomically to `ALERT_SETTINGS_PATH` (default sibling of DB). `AlertSettings`: `priorityEnabled: Record<AlarmPriority, boolean>` (default all true).

`sanitize()` starts from `defaults()` and copies across only RECOGNISED keys, so a persisted file written by an older build (carrying a knob a later build retired) loads cleanly and the stale field disappears on the next write — removing a settings field needs no migration.

**SEMANTICS.** Disabling a priority silences its *annunciation* (push + audible + chime) — it does NOT hide the alarm (the alert stays in the lists, rendered muted). In the monitor's `dispatch()`, `isPriorityEnabled(priorityOf(alert))` false → the push is `'suppressed'`.

Served at **`GET /api/alert-settings`** (`alertSettingsResponse()`, cached in-process, read-rate-limited 120/60 s) and **`PUT /api/alert-settings`** (`{priorityEnabled?}`, write-auth-gated, audit-logged, notifies listeners e.g. to re-publish HA switch states).

---

### 12. API endpoint summary

| Endpoint | Method | Payload / shape |
|----------|--------|-----------------|
| `/api/snapshot` | GET | `snapshot.alerts` (the `computeAlerts` + learned output) among the full frame; also pushed over WS |
| `/api/incidents` | GET | `{ incidents: Incident[] }` (cached 15 s) |
| `/api/alerts/history` | GET | `?days=N` (1..365, default 7) / `?since=<ms>` / `?all=1` → `{ cleared: ClearedHistoryRow[], total, shown, windowDays, since }`, newest first (cached 30 s per query) |
| `/api/alert-telemetry` | GET | `{ telemetry: AlertActionStats[] }` (cached 30 s) |
| `/api/alerts/outcome` | POST | `{alertId, outcome, notes?}` → `{ok, onlineLrUpdated}` (write-auth since v1.187.16) |
| `/api/alerts/outcomes` | GET | `{ entries }` (tail, `?limit=`) |
| `/api/alerts/outcomes/stats` | GET | `{ families: AlertFamilyStats[] }` |
| `/api/root-cause` | GET | `?alertId=` → `{ causes: [{id, description}] }` |
| `/api/repair-issues` | GET | `RepairIssuesReport { generatedAt, issues: RepairIssue[] }` |
| `/api/confidence` | GET | `ConfidenceSnapshot` (cached 60 s) |
| `/api/alert-settings` | GET/PUT | `AlertSettings` (PUT write-gated) |
| `/api/notify/status` | GET | notify config (`channel`, `configured`, `reachesAPhone`, `pushTargets`, `criticalBypassDnd`, `lastPushFailures`) plus `monitor.stats()`, including `alertFeeds[]` |
| `/api/notify/test` | POST | sends a test push (write-gated) |
| `/api/telemetry-gaps` | GET | gap ledger plus `telemetryGapLedgerSummary()` (cached 30 s) |
| `/api/defective-packs` | GET | latched defective-pack records; `POST /api/defective-packs/clear?packSn=` clears one (write-gated) |
| `/api/models/health` | GET | `ModelHealthReport` (cached 60 s, §9) |

---

### 13. Honest-null behaviour, edge cases & guards

- **Debounce onsets are optional.** When `connectivity` (or a specific onset map) is absent — older callers/tests — the `dpu-err` / `shp2-src-err` debounce is skipped and the CRITICAL fires immediately (pre-v1.11 behaviour). No path silently loses a real fault.
- **Reserve default.** Every reserve consumer defaults `backupReserveSoc ?? 15`, kept consistent between the near/below pair and the SoC-band dedup.
- **`mpptProducing` fallback.** `amps == null` (device doesn't report current) falls back to the watt test alone rather than suppressing an MPPT error.
- **Bench-spare mute is bidirectional & self-re-arming.** A spare wired into an SHP2 immediately loses `annunciate:false` (it becomes a connected source); a Core the last-known home roster names is never treated as a spare (`isBenchSpareSn`, v1.121.0), and a DPU the literal does not name never is.
- **Auto-silence never touches criticals** and never touches `ENERGY_STATE_FAMILIES`; flags are re-derived (not latched) each evaluation, so a family that stops flapping sheds its latch as the 30-day replay window decays.
- **Delivery integrity.** At-least-once dispatch; a failed send retries; a "Resolved:" gates on a REAL delivered fire (`pushSent`), not boot-seeding; the notify-state record is deleted before a resolve attempt so a failed resolve can't eat a future re-fire.
- **Clock skew.** The Pi is RTC-less and jumps at NTP resync; `recordClear` clamps durations `max(0, …)`, `SAME_RISE_GUARD_MS` uses `Math.abs`, and torn-append NUL runs are stripped from telemetry lines.
- **Outage events don't "recover"** — they age off the list silently (no resolve push) and re-notify only when their duration tier changes.
- **Warm-up grace.** Learned alerts absent in the first `LEARNED_RESOLVE_GRACE_MS` (10 min) after boot are treated as warm-up, not recovery, so a restart can't emit a premature "Resolved:".
- **Confidence honesty.** `forecastDayR2` returns null with <5 scored days; the within-slot solar r² is diagnostic-only (degenerate in a low-variance climate) and nothing gates on it.


---

### 14. Resolve integrity — positive evidence only (v1.75.0, extended v1.77.0/v1.78.0)

**v1.77.0** — a device flagged `online: false` is not positive evidence regardless of
data freshness (`deviceEvidencePositive` = fresh **and** not currently offline);
`online: undefined` stays neutral.

**v1.78.0** — three extensions:

- **`Alert.sourceSn`** — an alert constructor that knows its source device declares
  it; `fallingEdgeFrozenByEvidence` reads the declaration first and falls back to
  searching the id for a serial. The fallback silently skipped every SN-less id
  (`shp2-src-err-<slot>`, `backup-soc-<pct>`), which is how a 7-second SHP2
  `/status` blip pushed a false "Resolved: Energy source error" on 2026-08-12.
  All five SHP2-derived constructors declare `sourceSn`. Evidence-exempt families
  (`offline-*`, `msg-rate-floor-*`, `zombie-*`) stay exempt even when declared.
- **Ownership handoff** (`resolveHandoffOwner`) — `backup-soc-<pct>` vanishing while
  `shp2-below-reserve`/`shp2-near-reserve` is active in the same tick is the v0.44.0
  dedup transferring the story on a *worsening* transition, not a recovery: the
  tracked entry retires with **no resolve push** and one log line. A genuine band
  recovery (successor absent) resolves unchanged. **v1.185.0** — a secondary panel's band
  (`backup-soc-<pct>-<serial>`) hands off only to that panel's own pair. **v1.186.0** —
  `system-audible-degraded` vanishing while `system-audible-unreachable` is active is likewise
  a worsening handoff: no "Resolved: Audible alarm channel degraded".
  **v1.158.0 — `forecast-runtime-<SN>` joins the same rule.** Its producer stops AT the
  floor by construction (analytics gates the projection on `cur > reserve`, while
  `shp2-below-reserve` raises on `<= reserve`: complements on the same field), so its
  vanish is always a handoff. On 2026-09-13 the pool reached the floor at 21:42 and stayed
  there until 07:55, yet the phone read *"Resolved: Projected runtime ≈0h 12m to reserve"*
  at 21:47 — a false all-clear during an active drawdown, the same class the band family's
  handoff was built for.
- **Resolves respect quiet hours** — a resolve owed inside `NOTIFY_QUIET_HOURS`
  holds (the tracked entry retries each tick) and delivers when the window opens.
  Fires were already gated; resolves were not, and landed at 00:02/00:53.

On 2026-08-08 a cloud presence-flap made device projections unevaluable and the
falling-edge loop read "alert no longer computed" as "condition recovered",
emitting false **"Resolved:"** pushes for a standing battery-protection CRITICAL.
Three rules now hold:

- **Falling-edge evidence gate.** `fallingEdgeFrozenByEvidence` maps an alert id
  to its source SN (exact match against the live device roster; ids carry their
  subject SN by construction, and keys under 8 chars never bind). If the source
  device is absent or its `lastUpdated` is older than `ALERT_EVIDENCE_STALE_MS`
  (default 5 min, the telemetry-blind bound), the falling edge FREEZES and any
  accrued resolve-dwell resets — unevaluable is not recovered. Exempt families
  (`offline-*`, `msg-rate-floor-*`, `zombie-*`, and since v1.155.0 the per-device gap ids `system-outage-device-*`): their subject IS absence, so
  their clear is computed from the very signal that gates here. System alerts
  with no source SN never freeze — `telemetry-blind` resolving while devices are
  absent is exactly its recovery.
- **No boot-time "Resolved:" for starvation orphans.** The orphan sweep drops
  `msg-rate-floor-*` records silently at boot instead of resolve-pushing them:
  message rates are unknowable in the boot window, so there is no positive
  evidence to resolve on. A persisting collapse re-fires within its dwell.
- **The digest reports what self-resolved overnight.** Digest-held alerts that
  clear before the digest hour are captured (`raisedAt`/`clearedAt`) and
  rendered as an informational "fired overnight and self-resolved" section with
  durations, stamping **no** notified-record — the v0.97.0 re-fire-suppression
  fix is preserved. (Known cosmetic gap: the post-send log line counts only
  still-pending items; the sent notification itself carries both sections.)

Committed harness: `scripts/mutate-resolve-evidence.mjs` — 7/7, including
gate-becomes-no-op, exempt-list-emptied, and the boot resolve-push returning.

