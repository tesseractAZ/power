## 10. Audible Broadcast, Chimes & Text-to-Speech

This cluster documents how the ecoflow-panel add-on turns an in-memory alert
condition into **audible sound in the house** — a synthesized alarm chime
followed by a spoken, TTS-rendered description of the alert, pushed to every
configured speaker. It is the "last mile" of a life-safety alarm: the on-screen
tiles and HA push notifications tell you *what* is wrong; this pipeline makes
sure someone who is not looking at a screen *hears* it.

The design philosophy that recurs throughout every module below is: **collapse
the delivery method, never the measurement, and never let a cosmetic sub-step
silence an alarm.** A missing custom tone falls back to a built-in klaxon; a
failed Spanish pass still plays English; a failed "End of message" terminator
still plays the message; a dead speaker channel raises a *push* alert about
itself rather than trying to chime over the broken channel.

Source files covered:

| File | Role |
|------|------|
| `server/src/broadcast.ts` | The monitor: condition derivation, gates, per-target volume pin, MA + SIP dispatch, retries, health probe |
| `server/src/audioRenderer.ts` | Assembles chime + TTS PCM into one cached WAV; the cache key |
| `server/src/audioAssets.ts` | Synthesizes the built-in klaxons + named tone library at boot |
| `server/src/chimeStore.ts` | Operator WAV uploads: normalize-on-ingest + content-addressed storage |
| `server/src/chimeConfig.ts` | Per-rung tone assignment (`resolveChime`) + the 3-level→5-rung migration |
| `server/src/ttsService.ts` | Alert → spoken sentence; the TTS text normalizer (`verbalizeForTts`) |
| `server/src/wyomingTts.ts` | Wyoming-protocol Piper TCP client + `pcmToWav` |
| `server/src/broadcastRuntimeConfig.ts` | Live enable/volume override layer on top of env |
| `server/src/haService.ts` | `callHaService` and friends — every HA call, never throws |
| `server/src/broadcastHealth.ts` | Audible-delivery health signal + self-alert builder |

---

### 1. Pipeline overview

At the top level, the flow is:

```
alert condition transition (or a dedicated announce()/test()/preview() call)
        │
        ▼
 gates: enabled? minSeverity? quiet hours? storm gate? restart/boot grace?
        │
        ▼
 resolveChime(rung)       →  which WAV prepends this rung
        │
        ▼
 renderAnnouncement(...)  →  build (or cache-hit) the combined WAV:
        │                     [lead silence][chime][gap][TTS][terminator], ×repeat
        │                     TTS rendered via Wyoming/Piper over TCP
        ▼
 url = audioBase + /audio-render/<sha1>.wav
        │
        ├─► SIP side-channel  (fire-and-forget, BEFORE MA pre-flight)
        │      media_player.play_media(announce=true) → an announce-capable SIP phone
        │
        ▼
 MA pre-flight: ≥1 target registered & not 'unavailable'? else defer+retry
        │
        ▼
 per-target volume_set (pin standing volume)  →  music_assistant.play_announcement
        │
        ▼
 verify: call ok AND wall-clock ≥ 2 s (a sub-2 s "ok" = HA dropped it)
        │
        ▼
 record lastPlayed*, persist broadcast-last.json
```

Two distinct output channels carry the **same rendered WAV**:

1. **Music Assistant** (`music_assistant.play_announcement`) → the primary
   speakers, `BROADCAST_TARGETS` (on the reference plant, two ecobee thermostats
   exposed as MA AirPlay players). This is the verified, retried, health-tracked path.
2. **SIP / announce-only** (`media_player.play_media` with `announce: true`) →
   `BROADCAST_SIP_TARGETS`, an optional announce-capable SIP phone exposed as a
   media player (on the reference plant, a cordless handset on a home PBX). MA cannot
   drive a SIP phone, so this is a parallel, fire-and-forget side-channel.

---

### 2. Condition derivation & annunciation gates (`broadcast.ts`)

#### 2.1 `conditionFromAlerts(alerts)` → level

The audible **condition level** is a 3-value collapse of the alert list:

```
crit  = count of counted alerts with severity === 'critical'
warn  = count of counted alerts with severity === 'warning'
level = crit > 0 ? 'red' : warn > 0 ? 'yellow' : 'green'
```

Before counting, alerts are filtered out ("not counted") when:

- `a.annunciate === false` (e.g. an expected-offline bench spare — visible but silent);
- `a.id` starts with `backup-soc` (owned by the dedicated `announce()` SoC path);
- `a.id` starts with `shp2-below-reserve` (owned by the grid-aware runway alarm; its severity flips critical↔info with grid backstop);
- `a.id` starts with `forecast-runtime` (owned by the runway-alarm `announce()` path);
- `a.id` starts with `system-outage` (a retrospective event, fires its own one-shot push);
- `a.id` starts with `system-audible` (the audible-unreachable self-alert — must never chime over the channel it reports broken);
- `a.id` starts with `soiling-pv` (v1.187.1 — the panel-soiling estimate is maintenance, never danger: push and card only). A second guard: the alert carries `audible: false`, which `speakableAlerts` drops before this count and before the spoken message is built.
- `a.id` starts with `peak-idle-pool` (v1.187.0 — the on-peak idle-pool notice reports spend, never danger: push and card only, §7.10.1). A second guard: the notice also carries `audible: false`, which the tick's `speakableAlerts` drops before this count and before the spoken message is built — the id exclusion alone left it eligible to be the alert a yellow names aloud.
- `a.audible === false` (v1.187.0 — card and push only; e.g. `vdiff-warn-*` since v1.187.12, a `peer-voldiff-*` warning since v1.187.21, `ems-volt-*`, the soiling and idle-pool notices);
- `a.id` starts with `msg-rate-floor-` or `stale-` (v1.173.0 — stale-data warnings sound only after the remediation has failed: push and card only; the `telemetry-blind` critical is the audible, remediate-first path).

These exclusions keep the standing chime/all-clear from double-announcing a
crossing that a dedicated `announce()` path already owns.

Additionally, on every tick the alert list passes through `speakableAlerts`
*before* `conditionFromAlerts` and `messageFor` run. It drops alerts whose **ISA priority is
silenced** on the Alert Settings page (`isPriorityEnabled(priorityOf(a))`), alerts carrying
`audible: false`, and a cell-imbalance warning (`vdiff-warn-*`, `peer-voldiff-*`) that has not
yet stood `IMBALANCE_SPEAK_HOLD_MS` (10 min, from the restart-persistent onset;
`heldForImbalanceConfirm`). None of them can raise the level or be the alert named aloud. The alerts stay visible in the UI — only the audible annunciation is gated. Both cell-imbalance warning families now carry `audible: false` (`vdiff-warn-*` since v1.187.12, `peer-voldiff-*` since v1.187.21), so the `audible` filter drops them first; the speak hold is the second guard.

#### 2.2 The tick loop and its guards (`tick()`, every 10 s)

The monitor polls `store.get().alerts` on a **10 s `setInterval`** and fires on
**condition transitions**, not per-tick. Ordered guard logic:

| Guard | Behavior |
|-------|----------|
| `firstTick` | A **green** first observation only records `prevLevel`/`prevCrit` and returns (an unpopulated store reads green; it never wipes the red-replay evidence). Since v1.186.0 a **non-green** first observation is not joined silently: it is treated as a transition from green on that tick and passes through the boot gates below (restart continuation, the boot yellow hold, `holdBootRed`, the red replay gate). |
| `transitioned` | `level !== prevLevel`, `newWarn`, or `unheardReturn` (v1.187.4: a return to the level a de-escalation hold is holding is a transition when that level was never audible in its episode, `committedAudible`; only a heard level's return is a flicker the dwell absorbs). |
| `newCrit` | `level === 'red'` and either `crit > prevCrit` or a counted critical whose **fingerprint** (`alertFingerprint`: `id` + `title` + `fault`) was not in the set recorded when the standing level was committed (`prevCritFps`, `hasNewIdentity`) — a *new* critical while already red re-fires, including a different critical that replaces a cleared one at the same count. While the committed level stays red the recorded set **accumulates** (`adoptLevel` unions it), so each distinct critical is announced once per red episode: a critical whose fault code alternates between two values is announced once per value, not on every flip. A commit of a lower level starts the set afresh. |
| `newWarn` | `level === 'yellow'` while a de-escalation is held (below a held red, or returning inside a held yellow→green), with a counted warning whose fingerprint was not in the set recorded at the last commit (`prevWarnFps`; `conditionFromAlerts` returns `warningFingerprints`). A new warning is never held. Below a sounded critical that is only held (`soundedCriticalHeld`, next row) it is spoken at once, but the committed level **stays red** (`keepRed`: `adoptLevel('red', prevCrit, …)`, also on the restart-continuation path): committing yellow there ended the red episode (`prevCritFps` started afresh), so the held critical's next loud reading was a new red and could sound the klaxon again. |
| **De-escalation dwell** (`deescalationDue`, `CONDITION_CLEAR_DWELL_MS` = 3 min, v1.187.0) | A move to a **lower** level commits only once the condition has stood at or below it for the dwell — the same 3 min as the push path's cell-imbalance resolve dwell (`VDIFF_RESOLVE_DWELL_MS`). Green commits after **green** has stood 3 min (from yellow or red); yellow commits from red after the level has been **below red** for 3 min. Until then `prevLevel` is not advanced and nothing is spoken, so a flicker back up is no transition at all (a peer outlier whose z-score crosses the warning line as sibling readings land no longer speaks a false "All clear"). The clocks (`belowRedSinceMs`, `greenSinceMs`) run on every tick. Rises, `newCrit` and `newWarn` never wait. One log line per held episode, one when it is abandoned. While a hold stands, the condition record's heard flag (`conditionSpoken`) is demoted to unheard, so a restart inside the dwell never boots on a heard baseline of a level the house has left (it would swallow a standing yellow as a restart continuation of a cleared red); the flag is restored when the level returns to the committed one with nothing new (`endDeescalationHold`). Green **observed** under a held level destroys the red-replay evidence at once (below). **A critical that sounded and is then held by a bounded cell-spread mute is held, not cleared** (`soundedCriticalHeld`, v1.187.0 log review): while a critical whose fingerprint was counted at a committed red (`soundedCritFps`, a map of fingerprint → the last tick it was present, recorded by `adoptLevel` at a red commit **and on every tick the committed level is red** — a critical that clears and comes back loud inside a hold is a flicker the hold absorbs and commits nothing) is present with `mutedBy` set, the tick treats the observation as red for both clocks, so no move below red — nor yellow → green — commits. **A sounded `vdiff-crit-` that is ABSENT holds too**, until it has been gone `SOUNDED_VDIFF_ABSENT_HOLD_MS` (7 min: two ~180 s BMS reading periods plus a 20 s monitor tick, rounded up): a spread that follows the charge current is loud on alternate readings and absent 180-200 s between them — as long as the dwell — and green had committed between two klaxons (8 cycles: 8 klaxons, 7 all-clears); one missed reading makes the gap 360 s. A genuine clear of a sounded cell-spread critical therefore gets its all-clear about 7 + 3 minutes after the clear. Any other critical is released the tick it clears, as before. A `vdiff-crit` that sounded and was then muted again by balancing (a pack below 95%, where the balancing mute holds up to 20 min) made the level green, and `allClearSpeechBlocked`, which reads `annunciate`, let the all-clear be spoken with the card open, between two klaxons for the same pack. The hold ends when that critical has cleared and stayed gone the absent hold (the lower level then stands its own full dwell and the all-clear is spoken) or annunciates again (a flicker absorbed, nothing re-spoken). A new critical inside it is still announced at once; a new warning is spoken at once with the red kept committed (`newWarn`). A muted critical that never sounded, or one muted by policy (bench spare, off-panel Core), holds nothing, as before. **v1.187.1** — a policy stamp that takes precedence over a bounded mute clears `mutedBy` (the bench-spare stamp in `computeAlerts`, `applyRosterMute` in the monitor): both used to overwrite `annunciate` and `muteReason` and leave `mutedBy` set, so a sounded `vdiff-crit` muted by policy that also carried a knee mute held the red and delayed the all-clear for as long as the knee mute lasted. `muteReason` stays diagnostic only; `mutedBy` names the mute in force. **v1.187.3 (log review) — the sounded record survives a restart** (`restoreSoundedCriticals`): `soundedCritFps` lived only in memory, so after a restart a sounded `vdiff-crit` muted again by its knee mute (the knee session survives an outage under `VDIFF_KNEE_GAP_CARRY_MS`), or absent between two readings, held nothing. A warning standing at the first tick was adopted as a continuation of the heard red, it cleared, and the green was announced as a recovery (`isRestartRecovery`, next row): "All clear" with the critical's card open, then the klaxon when the mute lapsed. The record's cell-spread entries (`soundedCritPersists`: `vdiff-crit-`, the only criticals that can hold after a restart — `mutedBy`, which holds a present critical, is stamped only on a `vdiff-crit`, and the absent hold applies only to `vdiff-crit-`) are written to `broadcast-last.json` (`soundedCrit`: fingerprint → last-present ms) whenever their set changes, and at most every `SOUNDED_CRIT_PERSIST_EVERY_MS` (1 min) while there are any. Any other sounded critical stays in memory only: persisted, a standing critical whose fault code alternates rewrote the file on every flip (the absent code pruned, the present one recorded), and every minute while it stood. The record is restored before the first tick: each cell-spread entry with a well-formed fingerprint and a finite last-present time at most `SOUNDED_CRIT_RESTORE_MAX_AGE_MS` old (= `VDIFF_KNEE_GAP_CARRY_MS`, 60 min: after a longer outage the knee mute starts a new session, and its critical is a new episode), stamped at the boot. Nothing is observed during the outage, so it is not counted as absence: an absent cell-spread critical is held `SOUNDED_VDIFF_ABSENT_HOLD_MS` from the boot. The boot stamp is for the hold only: the file keeps the entry's own last-present time, never later than the boot (a clock stepped back), until the critical is present again, muted or loud (`soundedCritRestoredAt`). The 60-min bound therefore counts from when the critical was last present, however many restarts follow; written back at the first tick, the boot stamp renewed an absent critical at every restart, and restarts under 7 min apart kept it restorable for ever. It is restored whatever the condition record says, because only a red writes an entry and the record prunes itself, while the hold demotes the record's heard flag exactly when a sounded critical is muted. A status file written before v1.187.3 has no record; under a **committed** red on record (`conditionLevel` red, heard or not) the cell-spread criticals of the red announcement on record (`redReplayGate.state().activeFingerprints`, read at boot before the first green observed under a hold can clear it) are seeded instead. Keyed on a heard red, the fallback seeded nothing when the upgrade restart landed inside such a hold, the heard flag demoted while the critical was muted; below a committed yellow (the red's criticals released) nothing is seeded. One boot line names what was restored. |
| **Restart continuation** (`isRestartContinuation`) | Within `BROADCAST_BOOT_WARMUP_MS` (default **10 min**), a yellow/green transition at or below the persisted pre-restart baseline is adopted silently (analytics warm-up re-presents an already-broadcast advisory as a fresh rise). **RED is never suppressed here** — this function sees only levels, and a level-only red≤red match would swallow a new critical behind a stale one. **v1.187.3 — a green that has stood its dwell on a settled alert set is a recovery, not a continuation** (`isRestartRecovery`): the first tick joins a green silently, so a green transition always follows a yellow or red committed since boot, and its clearing is news. When a heard baseline exists and the green has stood `CONDITION_CLEAR_DWELL_MS` **on a settled alert set** — measured from the later of `greenSinceMs` and the alert monitor's settled stamp (`BroadcastMonitorOpts.alertSetSettledSince`, wired in index.ts to `AlertMonitor.alertSetSettledSince`; absent, throwing or not a finite number ⇒ never settled) — the green goes on as an ordinary transition (the all-clear speech gate, quiet hours and the storm gates still apply) and the continuation baseline ends (`continuationBaseline`), so it is announced once and a later warning inside the warm-up is spoken as new. On 2026-10-01 a heard yellow standing at a deploy was adopted as a continuation, cleared, and its green was adopted in silence 3 minutes later, leaving the cleared warning as the last words. **The settled stamp** (`alertSetTrusted`, stamped by the alert monitor at the publish of the first set of a run of trusted ones and cleared before the first publish of any pass whose set is not one): the store hydrated; every worker/NWS feed's value in the published set is a delivery computed on a hydrated store, judged on the value each read returned (`AlertFeedRead.warm`), not on `warm()`, which turns true when a fetch lands, before its alerts reach the set; the live alarms computed at least `BOOT_RESET_ONSET_DEBOUNCE_MS` (3 min) after `firstPollSettledAt`; and no in-memory onset clock withholding a fault the device reports now (`debouncedOnsetsPending`: an inverter error or an SHP2 source error inside its 3-minute window, both critical; an MPPT string error inside its window; a backup pool unknown for under 15 min, which withholds `reserve-alarm-blind`). These clocks restart at zero in every process, so a fault that stood before the restart is absent after it for one window (3 min for the device error codes, as long as the green's dwell): measured from the green alone, a green that began on that set could be spoken seconds before the critical re-published ("All clear", then the klaxon). Until the green has stood its dwell on a settled set it is **held** like any de-escalation (logged once: `green has stood 180 s but is held, not adopted`); if the restart question closes first (`restartQuestionOpen`, v1.187.4: open until `LONGEST_RESTARTED_ONSET_MS` + `RESTARTED_ONSET_HOLD_MARGIN_MS` = 16 min after the boot, and at least the warm-up; on a set settled by then, one more `CONDITION_CLEAR_DWELL_MS`), it is announced as a transition when a condition above green has been audible since the boot (`conditionAudibleSinceBootLevel`) or the set is settled at that moment, and otherwise adopted silently as a continuation. The decision waits while a broadcast is in flight or queued, a SIP outcome is pending, or a condition retry could still raise the level (`conditionRetryCouldRaise`). A yellow at or below the baseline is still adopted as a continuation, except when a higher level has been audible since the boot and has since cleared (`higherAudible`, v1.187.4; not while that level is only held, `keepRed`). A green first tick is still joined silently. `bootBaselineLevel` (status) stays the value read at boot. **v1.187.3 (log review)** — a cell-spread critical that sounded before the restart and is muted by its knee mute after it, or absent between two readings, holds the green as it does in one process (the sounded record is restored at boot, `soundedCriticalHeld` in the row above): the green clock does not start, so no recovery is announced while the critical's card is open; a genuine clear gets its all-clear after the absent hold and the dwell. A failed first NWS fetch keeps the storm-prep feed cold (`stormPrepAlerts`), so the set is not settled while its storm alerts are unknown. **(seam fix)** A green held inside the warm-up by such a sounded critical has its recovery decided even when its dwell ends after the warm-up (`deescalationHold.soundedHeldInWarmup`, set on each hold tick such a critical holds inside the warm-up): the restored absent hold (7 min from the boot) plus the dwell (3 min) ended exactly as the 10-min warm-up did, so the green always took the late-green path, an ordinary transition, and was spoken with the set never settled, where the same restart without the record adopted it silently. From its first due tick (`recoveryHoldSinceMs`) it is a recovery as soon as it has stood its dwell on a settled set, for at most one more `CONDITION_CLEAR_DWELL_MS`, the patience the warm-up path gives; then it is adopted silently as a continuation. Decided on the due tick alone, a settled stamp reset by one transient onset 30 s before it silenced the all-clear. This holds whenever the dwell ends, so a green after a long knee mute that began inside the warm-up is also adopted silently if the set has still not settled (a feed that has never delivered). **(v1.187.5)** Since v1.187.4 the restart question itself (open to boot + 16 min, 19 on a set settled by then) decides the absent-hold case above (the green due near boot + 10). The mark decides a green whose dwell ends after the question has closed: a restored critical held past boot + 6 min (9 on a set settled by then) and then gone, such as its knee mute back after the restart (bounded 20 min from the crossing before the restart). Decided on the due tick alone, such a green would now be announced 30 s after a stamp reset, before it had stood its dwell on the settled set, and adopted in silence when the set settled 30 s after the due tick (a set settled at the decision is announced since v1.187.4). A hold that ends (the level back up, or a commit) forgets the mark. **(seam review)** Only a critical of before the restart marks the hold: one restored or seeded at the boot and not released since (`bootSoundedFps`, read on a copy of the record). A critical that first sounded after the boot, or a restored one released and back, is the house's own news, so its green is an ordinary transition, as is a green that any sounded critical first holds after the warm-up. Marked by a cell-spread red heard after the restart, the green was decided on one tick and, on an unsettled set, adopted in silence, so the cleared critical stayed the last words. **(seam review)** A green still held for its recovery when the restart question closes is announced as an ordinary transition, not adopted silently, when a condition above green has been made audible since the boot on any channel (`conditionAudibleSinceBootLevel`, in memory only — since v1.187.4 a tone-only play after a failed spoken render, a delivery-unknown Music Assistant timeout and a confirmed SIP delivery all count; `lastConditionPlayedLevel` remains the storm gates' evidence). The last words in the house are then that condition, not the pre-restart level. |
| **Boot phantom-red hold** (`holdBootRed`) | Within the warm-up window, the *first* fresh red is held for **one tick** to confirm it is standing and not a telemetry-populate phantom (`prevLevel` is NOT advanced, so a persisting red re-fires ≤10 s late; a one-tick phantom clears and is never spoken). A fresh yellow in the window is held until it has stood `BOOT_YELLOW_CONFIRM_MS` (`holdBootYellow`, v1.173.1). **v1.187.1** — each hold line names what it holds (`describeFingerprint` of the counted warnings or criticals), and a hold that ends below its level writes one line naming what it held: `boot yellow dropped after N s — cleared inside the hold, not spoken (…)` when a held yellow falls to green (every warning seen during the hold), `boot red dropped — the level fell to <level> inside its one-tick confirmation; not spoken (…)`. A rise from a held yellow to red is not a drop (red logs its own hold and transition), and a hold that is adopted (`adoptLevel`: spoken, or silenced by a gate with its own line) ends without one. **v1.187.10** — the drop line splits the held warnings against the alerts of the dropping tick (`bootYellowDropLine`): one no longer present is "cleared inside the hold"; one still present is "still active but no longer counted toward the condition", named with why (its `muteReason`, `annunciate:false`, `audible:false`, or a new severity). An off-panel Core's standing imbalance, muted only once its roster streak rebuilds a few ticks after each restart, had been logged as cleared. |
| **Red replay gate** (`redReplayGate`, v1.64.0) | Runs *after* the phantom hold, so only a confirmed red reaches it. Suppresses a red re-announce **only when all of these hold**: inside the warm-up window; the last verified broadcast of any level was itself a red (so this is **not an escalation** — same `LEVEL_RANK` ladder as the storm gate); the critical that would be **spoken now** has the same **fingerprint** (`id` + `title` + `fault` code, ★ never the bare id — `dpu-err-<sn>` spans every `sysErrCode`) as the one that **was spoken** then; no unrecognised critical is active alongside it; and the announcement is not older than `BROADCAST_RED_REPLAY_MIN_GAP_MS` — **default `Infinity` since v1.78.0** ("announced since this fault began"): an unchanged, verifiably announced fault never replays at boot; setting the env var restores the v1.64.0 timed reminder. A changed fault, a new fault or an escalation announces immediately at any age. Reaching **green** destroys the evidence (all-clear ⇒ the next red is a new event) — a green committed by `adoptLevel`, and since v1.187.0 a green first **observed** under a held de-escalation, before the dwell commits it: the evidence is read only at boot, and a restart inside the dwell (the boot green is joined silently and never wipes) otherwise muted the same critical re-raising in the warm-up. Missing/corrupt/future-dated/legacy-shape state ⇒ announce. Level adopted on suppression (no retry). |
| **In-flight** (`tickInFlight`) | An MA announcement blocks 20–105 s (>> the 10 s tick). If a different level arrives mid-flight, the tick returns WITHOUT advancing `prevLevel`, so the missed transition re-presents next tick (prevents a lost yellow→green). |
| `cfg.enabled` | Disabled → adopt level, no broadcast. |
| **All-clear-vs-critical** | A `green` is adopted silently (no spoken all-clear) if any critical alert with `annunciate !== false` is still active, or the `telemetry-blind` critical is held silent by its remediate-first gate (`allClearSpeechBlocked`, v1.166.0: held is not cleared) — avoids a spoken "all clear" contradicting a runway-alarm critical on the same speakers. |
| `minSeverity` | `yellow` is skipped when `cfg.minSeverity === 'critical'` (the default). |
| **Quiet hours** | `yellow`/`green` always respect quiet hours. `red` breaks through ONLY when `criticalBreakThrough` is opted in; default OFF ⇒ red is also suppressed overnight (alert stays on-screen; push queues the morning digest). |

Only after all guards pass does `tick()` set `tickInFlight`, build the message
(`messageFor` / `messageEsFor`), and call `runBroadcast`.

#### 2.3 Storm gates (`runBroadcastInner`)

Two suppression gates prevent an alarm storm from wedging Music Assistant (the
Jun 12 event fired 5 broadcasts in 50 min from 3 sources and drove MA into HTTP
500s). Both are **bypassed by a genuine escalation** (a level higher than the
last thing that *actually played*) and by test/preview:

- **`SAME_MESSAGE_GAP_MS = 10 min`** — an identical spoken message within the window is suppressed (tier-boundary flapping repeats the exact text).
- **`SAME_LEVEL_GAP_MS = 2 min`** — any same-or-lower level within the window is suppressed (at most one non-escalating voice alarm per gap).

The identical-message gate keys off `lastPlayedAt`/`lastPlayedLevel`/`lastPlayedMessage`.
Since v1.186.0 the same-level gap keys off `lastConditionPlayedAt`/`lastConditionPlayedLevel`,
armed only by a **condition** delivery: a dedicated SoC/runway/notice announcement arms the
identical-message gate only, and a test arms neither. Both are set **only on verified,
error-free playback**, so a failed or unverified dispatch never blocks its own retry. A dedicated
`consentNotice` (the supervised night-charge arm/cancel, v1.122.0) bypasses both gates. `stormSuppressedCount` is surfaced in `/api/broadcast/status`.

**Repeat-warning gate** (`sameWarningRepeat`, `SAME_WARNING_REPEAT_GAP_MS` = 30 min,
v1.187.0). A warning's spoken detail carries its live reading, so the identical-message
gate never matches a repeat of the same alert. Before a condition yellow is spoken, its
identity — the fingerprint of the alert `pickPrimaryAlert` names aloud (from the counted alerts,
`conditionNamePool`, v1.187.11), the rung, and the counted `warningFingerprints` — is compared with
the last condition yellow that reached the speakers (`lastVoicedWarning`, recorded only when the
yellow's dispatch returned `ok`; v1.187.11: a deferred condition retry's yellow and the v1.45.0
spoken retry's too).
The yellow is suppressed only when the named alert and rung match, every warning counted
now was counted then, and it is inside the window. The memory is dropped the moment any
condition green or red passes the storm gates on its way to the speakers, so a warning
returning after a **spoken** all-clear is always spoken again.

**Storm-gated condition re-present** (`deferredCondition`, v1.187.0). A condition transition
refused by the same-level gap is re-presented **once**, at `lastConditionPlayedAt +
SAME_LEVEL_GAP_MS`, when it is either a **de-escalation** (a green, or a yellow after a red —
a level below `lastConditionPlayedLevel`) or a **same-level transition that carried something
new** (`fresh`: the counted identities at that level not counted at the previous commit — a
new warning inside a held yellow→green, a different critical while red). It passes the tick's
own gates: the condition must still be that level, at least one of a same-level deferral's
`fresh` identities must still be counted, broadcasts enabled, the all-clear speech gate clear (green),
minimum severity met (yellow), and outside quiet hours (a red breaks through only when
`criticalBreakThrough` is set, as the tick's own red). A **higher** level drops it (that
transition announces itself); a **lower** level does not: the deferral waits while the lower
level stands its dwell, is superseded when that level commits, and is re-presented if the
condition returns to the deferred level first (a flicker the dwell absorbs would otherwise
leave a warning nobody heard unspoken). Any newer commit (`adoptLevel`) supersedes it; the
re-present never arms another, and it passes the identical-message and repeat-warning gates
like any condition broadcast. Before v1.187.0 the refusal was final (the tick had already
committed the level), so the last words spoken could be a critical that had cleared.

**Suppressions are not broadcasts** (`isStormSuppression`, v1.187.0). A storm-gate refusal
renders and dispatches nothing. It is recorded in `lastSuppressedAt` / `lastSuppressedLevel`
/ `lastSuppressedKind` / `lastSuppressedReason` (persisted in `broadcast-last.json`) and no
longer overwrites `lastBroadcastAt` / `lastLevel` / `lastOutcome` / `lastErrors`, which keep
describing the last broadcast that was attempted.

#### 2.4 Single-flight serialization

Every broadcast that goes through `runBroadcast` (tick, `announce()`, `test()`, deferred and
spoken retries), and the boot terminator pre-warm, is serialized through one promise chain
(`broadcastChain`). The `preview()` speakers target is not: it calls `playAnnounce` and
`playSipAnnounce` directly, so a speaker preview can overlap a real announcement. A second request
waits for the first playback to finish rather than overlapping `play_announcement`
calls (which wedged MA into 500s).

#### 2.5 Deferred retry

`scheduleBroadcastRetry` provides a single-slot deferred retry with delays
`RETRY_DELAYS_MS = [30 s, 90 s, 180 s]` for broadcasts that could not be
*verified* (all targets unavailable, MA call failure, or a suspiciously fast
completion). A retry:

- re-checks `cfg.enabled` (an operator who disabled broadcasts must not hear an armed retry);
- skips the SIP cordless while the last SIP dispatch delivered (`lastSipDispatchOk`, v1.32.0) — it already took the audio, so it isn't replayed at +30/+90/+180 s — and, for a condition retry, only while the retry names the alert that dispatch named (v1.187.11);
- resets `retryAttempt` to 0 on a verified, error-free delivery of a real broadcast (v1.186.0: a test never resets the budget);
- replays the words it was armed with — a dedicated retry always; a condition retry while the alert they name is the one the condition names when it runs (v1.187.11 — see below).

**v1.159.0 — the budget now COUNTS.** The timer callback used to clear `retryLevel` before
re-running the broadcast, and `scheduleBroadcastRetry` only sees a pending slot while that
is set — so every failure started a fresh budget and the ladder logged `1/3` forever. On
2026-09-15, with `music_assistant.play_announcement` returning HTTP 500 for ten minutes, the
log shows `deferred retry 1/3` at 20:47:12, 20:50:16 and 20:53:20 for ONE condition. The slot
now survives the fire (so the ladder is 1 → 2 → 3 → give up) and is released by
`releaseRetrySlotIfIdle()` whenever a broadcast ends with no retry armed, so a stale level
cannot make later milder deferrals "keep-pending" against a retry that no longer exists.
This matters beyond the noise: the single-flight note below records that overlapping
`play_announcement` calls are what wedge MA into those 500s, so an uncountable retry can
sustain the failure it is retrying. Harness: `scripts/mutate-broadcast-retry.mjs`.

**v1.160.0 — the slot is released on every exit.** v1.159.0 released it only at the
completion tail, but the broadcast routine returns early in six places before it can arm
anything: not supervised, no MA targets, the two storm gates, and the two render failures.
A fired retry that met one of those — most plausibly the **same-level storm gate**, since a
retry replays the same rung ~30 s later, which is exactly what `SAME_LEVEL_GAP_MS` absorbs —
left the slot held with **no timer armed**. That phantom slot is worse than the defect it
came from: every later milder deferral logs "keeping the pending `<level>` retry" against a
retry that does not exist, and the next same-level failure can reach "giving up after 3"
having made zero attempts. `runBroadcastInner` is now a wrapper that calls the gated routine
inside `try { … } finally { releaseRetrySlotIfIdle(); }`, so every exit — including a throw —
releases an idle slot. The call is idempotent (a no-op while a timer is armed) and
`scheduleBroadcastRetry` runs *inside* the routine, so a retry this broadcast armed is always
already armed when the release runs. Releasing on the way **in** would be the v1.159.0 defect
restored, and is pinned against.

**v1.187.4 — a condition retry is replayed only within its condition episode.** A condition
retry (`kind === 'condition'`) is the tick's commit spoken late; it carries the condition episode
it was requested in (`conditionEpisode`, advanced by every commit that changes the level) and runs
only while that episode is current (`conditionRetryStale`), checked when it reaches the head of the
single-flight chain; otherwise it is dropped with a log line (the slot released by the `finally`).
A stale pending condition retry does not count as pending for `retrySlotDecision`, so a newer
deferral — a green after a red — supersedes it. A warning spoken while the committed level stays
red (`keepRed`) is in the red's episode and is retried. Dedicated retries (SoC ladder, runway,
notices) are unchanged.

**v1.187.5 — inside an episode the newest announcement wins.** Every broadcast takes a
generation when it runs (`attemptGeneration`); a deferred retry keeps its announcement's (`retryOf`). **v1.187.10** — every
outcome line ends with the kind and that generation (`outcomeTag`: `… → ok in 58918ms (…) [dedicated #7]`,
`[condition #N]`, `[test #N]`), appended so a `broadcast: <level> → ok in` prefix still matches; the
night-charge notice (a dedicated yellow) had logged exactly as a condition yellow, and a retry could be
matched to its announcement only by timing.
Per level, `conditionNewestGeneration` records the newest condition announcement that armed the slot
or reached the speakers, and a condition retry superseded by a newer one at its level or above is
dropped when it runs (`conditionRetrySuperseded`, after the episode check). Only a higher generation
outranks the pending retry (a retry's re-arm keeps its budget), and only a delivery at least as new
as the pending retry cancels it. A lower announcement never supersedes a higher retry; dedicated
retries neither supersede nor are superseded. Those checks compare announcements, not alerts: in v1.187.5 a retry that passed them replayed its armed words, so a red naming A that cleared while C kept the red could still speak A at its retry, and a retry already queued ahead of C's announcement when A cleared could speak A while C waited out the same-level gap (known limit until v1.187.11, below). A retry that
runs inside the same-level gap is refused like any broadcast and is not re-armed (v1.187.11: it is re-presented once).

**v1.187.11 — a condition retry says what the identity of its alert decides when it runs.** Every
condition announcement carries the fingerprint of the alert its words name (`conditionNamedFingerprint`:
`pickPrimaryAlert` over the array the words are built from); a retry keeps it, and so does its re-arm.
Every naming site names from the alerts the condition COUNTS (`conditionNamePool`, the `counted` array
`conditionFromAlerts` returns): the tick's words (`messageFor`), its red replay fingerprint, the
repeat-warning gate's identity and a retry's words. `pickPrimaryAlert` excluded only non-annunciating
and `audible:false` alerts, so an id the count drops (a backup-SoC band, the runway projection, a
device telemetry gap, a stale-telemetry or message-rate warning, the soiling and idle-pool notices)
could be named in place of the alert that raised the level when it ranked first, and those titles
carry the live reading, so the named identity moved with it.
At the head of the chain, after the episode and newest checks, `conditionRetryWords` reads the tick's
chain as it stands (`speakableAlerts` over the store) and decides: the condition at the retry's level
naming the SAME alert → the armed words, rendered already (a reading that moved, 101 → 104 mV, is not a
different alarm), with the cordless skipped as armed; a DIFFERENT alert → the words and the rung
(tone) as the tick would build them now, from one array, with the cordless dispatched again; the
condition not at the retry's level → the armed words (below: a de-escalation standing its dwell or a
sounded critical held by its mute, fail-loud; above: that transition is in hand), unless the armed
alert is still raised but `speakableAlerts` now drops it (a silenced priority, `audible:false`, a
cell-imbalance warning inside its speak hold) or it is a policy mute (`annunciate:false` with no
bounded mute behind it; a critical held by one, `mutedBy`, replays) → dropped; a green retry → dropped
while `allClearSpeechBlocked`, whatever the level observed. New words then pass the identity gates the tick applies to the alert it
names (`sameWarningRepeat`, the red replay gate), and a retry yields — is dropped — when a new
announcement naming that alert is waiting behind it in the chain (`queuedConditionNames`, counted
in at the request and out at the run): spoken by both, the alert was told twice, since its reading
could move in between (the identical-message gate does not see it) and the same-level gap then
refused and re-presented it. A failure to read the condition replays the armed words and logs it
(`conditionRetryAtRun`). A yellow retry that reached the speakers is what the repeat-warning gate
remembers (`lastVoicedWarning`, with the warnings counted as it played), as the tick's own yellow is.
A failed spoken render of a condition retry now earns the one spoken retry (`noteSpokenRenderFailure`)
unless one already pending would speak and this one would not, or is not for a more serious level (a
dedicated one replays its own words whatever the level; a condition one speaks only if the condition
is then at its level, judged by the level observed when the retry ran) — and that spoken retry's tone is the tick's current rung, as its words are; it is never an
"All clear" while `allClearSpeechBlocked`, and its yellow is recorded by the repeat-warning gate; a refusal by the same-level gap earns one re-present when the
gap expires (`refusedRetryRepresent` into `deferredCondition`; only that refusal, never over a
re-present already waiting). A re-present below the committed level (a warning under a kept red)
waits while the observed level is the committed one, and does not end the red's held de-escalation.
Dedicated retries are unchanged. Residual: a cordless dispatch that timed out is re-fired only by a retry that runs; a condition retry dropped when it runs (a speech gate, the repeat-warning check, the restart replay check, or giving way to a waiting announcement) neither re-fires the cordless nor gives the restart decision its evidence. Harness: `scripts/mutate-v1187-5.mjs` (W-i to W-xlix).

#### 2.6 Engineering history (moved)

The per-release notes that stood here are frozen, unedited, in [engineering-release-log-1.md](../history/engineering-release-log-1.md)
and [engineering-release-log-2.md](../history/engineering-release-log-2.md); what each release changed is in the [CHANGELOG](../../ecoflow_panel/CHANGELOG.md).

---

### 3. The audible dispatch: MA + SIP (`broadcast.ts`)

#### 3.1 Per-target volume pin (v1.24.0)

Before the MA announcement, `playAnnounce(url)` pins each target's **standing
volume** to `announceVolumeLevel(cfg.announceVolume)` (0..1), derived from the
same `announceVolume` (0..100) that is sent as `announce_volume`. This exists
because RAOP/AirPlay speakers (ecobees especially) handle MA's
set→play→restore `announce_volume` unreliably and fall back to a standing
volume that can silently drift low (~0.2 after re-provisioning).

**v1.24.0 audit fix — per-target, not batched:** the volume_set is issued
**one call per target in parallel** (`Promise.all(cfg.targets.map(...))`), not
as one batched `entity_id` list. HA resolves a batched list before executing,
so a single VOLUME_SET-incapable target (on the reference plant the cordless lacks the feature bit;
the two ecobees have it) would make the whole call raise `ServiceNotSupported`
and pin *nobody*. Per-target isolates the incapable one so capable speakers are
always pinned. It is best-effort — a failure is logged and never blocks the
announcement; after any success there is a 300 ms pause to let RAOP apply
before the stream. Skipped entirely when `announceVolume` is `null`
(`'standing'`/`'off'` escape hatch).

The MA call itself:

```js
music_assistant.play_announcement({
  entity_id: cfg.targets,          // all MA targets in one call
  url,                             // http://<audioBase>/audio-render/<sha1>.wav
  use_pre_announce: cfg.usePreAnnounce,
  announce_volume: cfg.announceVolume,   // omitted entirely when null
})
```

Retried up to `cfg.announceRetries` times (1.5 s apart) on a definite call failure (an HTTP error or a refused connection). A timeout is delivery UNKNOWN (v1.118.1, §12i): it is retried neither in-call nor by the deferred ladder, and the play reports `ok` but not `verified`. The call's timeout is sized to the clip (`announceTimeoutMs`: play time at 44 100 B/s + 45 s, floor 75 s, ceiling 10 min; body timeout = that + 45 s).

#### 3.2 SIP side-channel (v1.25.0)

`playSipAnnounce(url)` delivers the **same rendered WAV** to `cfg.sipTargets`
via `media_player.play_media` with `announce: true`, `media_content_type:
'music'`. Key properties:

- Dispatched **BEFORE the MA pre-flight** and **fire-and-forget** — so the cordless is a genuine *alternate* channel that still speaks even when the MA pre-flight defers because the ecobees are mid-restart / unavailable.
- **No volume pre-pin** — the cordless has no volume feature (a `volume_set` on it 500s).
- Fire-and-forget so the ~3–5 s play_media → switchboard render+originate round-trip never delays the (already 17–34 s) MA announcement.
- Skipped on deferred MA retries (`skipSip`) so the identical alarm isn't replayed on the cordless — only when the first dispatch is **confirmed**: it resolved with a target reached, or (v1.48.3) it timed out and a target read `playing` / `on` 8 s later (`SIP_TIMEOUT_PROBE_DELAY_MS`; `BroadcastMonitorOpts.sipTimeoutProbeDelayMs` is a test seam, its default pinned through the real monitor and by `mutate-v1187-4.mjs` S-i..S-iii). **v1.187.10 — the limit of that probe:** it can confirm only a target that reports playback. The Switchboard announce entity writes no state during an announce call (HA history reads `idle` through every announcement), so on it a timed-out dispatch is delivery **unknown**: the line says so and names what each target read (`sipProbeUnknownLine`); it is not counted as heard (`noteConditionAudible`) or as delivered, and a deferred retry re-fires the cordless (Switchboard drops an identical clip still in flight or just heard). The restart decisions (§10.2) wait while a condition retry armed on its timer could still make a level above the one decided audible (`conditionRetryCouldRaise`), as they wait for a broadcast in flight. Residual: when every re-fire also times out, the red is never counted as audible and its green can be adopted silently when the restart question closes; evidence of a placed call has to come from Switchboard itself.
- A target listed in **both** `BROADCAST_TARGETS` and `BROADCAST_SIP_TARGETS` is dropped from the SIP list at load — MA wins.
- **At least one MA target is required.** A SIP-only configuration is treated as "no targets" (`cfg.targets.length === 0` → `no targets configured`), because the whole outcome/retry/health machinery keys on `cfg.targets` and SIP dispatch is unverifiable.

#### 3.3 MA pre-flight & verification

After the SIP dispatch, before the MA call:

- **Pre-flight:** `getEntityState` each MA target; require `≥1` registered and not `'unavailable'`. During HA/MA restart windows entities briefly deregister and HA *accepts* `play_announcement` then silently drops it (3 confirmed swallowed broadcasts, each "ok" in 20–34 ms). If `usable === 0`, defer + retry, mark `lastOutcome = 'failure'`, and force a health probe (it counts toward the debounce run but does not restart or shorten its span, §13).
- **Post-call verification:** a real MA announcement blocks until playback completes (17–34 s). If the call returns `ok` in **< 2000 ms**, it is treated as unverified (`unverified: completed in <n>ms — too fast for real playback`) and a retry is scheduled — a success no one heard is not reported as success.

Outcome (`'success'` / `'partial'` / `'failure'`), errors, level, spoken message,
and last render diagnostics are persisted to `broadcast-last.json` (next to the
SQLite DB) so "what played last and did it work" survives the very restarts that
most need auditing.

A second sidecar, `broadcast-red-replay.json`, records `{lastRedAnnouncedAtMs,
voicedFingerprint, activeFingerprints, lastPlayedLevel}` on every
**verified-successful RED** condition broadcast — the evidence the v1.64.0 red
replay gate (§2.2) needs to tell *the same standing fault* from *a new emergency*
after a restart. It is written only on `ok === true`, on the same reasoning as the
storm gates: a dispatch nobody heard must not buy silence. No other red path writes
it (deferred retry, spoken retry, and the dedicated SoC/runway announcers all leave
it alone) — not recording costs at most one extra klaxon, which is the safe
direction.

★ `voicedFingerprint` is the fingerprint of the **one** alert that was actually
said aloud — `ttsService.pickPrimaryAlert`'s choice, since `buildAlertMessage`
voices exactly one. `activeFingerprints` is context only: it can force an extra
announcement when something unrecognised appears, never justify one fewer, because
a counted critical is not necessarily a *spoken* one. A verified **yellow** demotes
`lastPlayedLevel` (making the next red an escalation); a **green** condition
tombstones the whole file.

---

### 4. Announcement rendering (`audioRenderer.ts`)

#### 4.1 Layout

`renderAnnouncement(opts)` assembles one WAV, per repeated/language block:

```
[lead-in silence][chime][chime gap][TTS pass] ... [terminator]
```

Multiple blocks are joined with `repeatGapMs` of silence. The full ordering is
built by the pure, unit-tested `assembleAnnouncementParts(silence, blocks, gap,
tails, endGap)`. Silence buffers are frame-aligned zero-filled PCM
(`makeSilencePcm`).

Timing knobs (all resolved once and folded into the cache key):

| Knob | Default | Meaning |
|------|---------|---------|
| `leadSilenceMs` | 1000 ms (add-on option default; 1500 ms only when `BROADCAST_LEAD_SILENCE_MS` is unset) | Digital silence before the first chime so AirPlay/multi-room speakers sync up (prevents clipped chime starts + slow devices missing short clips). 0 disables. |
| `chimeGapMs` | 1000 ms | Silence after the chime group, before the spoken message (chime decays first). |
| `announceRepeat` (`cfg.repeat`) | 2 | Whole (chime+message) block repeats so a missed first pass gets a second. Clamped 1..3. **Ignored when bilingual** (the two languages ARE the redundancy). |
| `repeatGapMs` | 1500 ms | Silence between repeated blocks. |
| `endOfMessageGapMs` | 700 ms | Silence before the "End of message" terminator on the final block. |

#### 4.2 TTS passes & the bilingual second language

Spanish is the only second language: the verbalizers, the Spanish message builder and the
title map exist for `es` alone, and the English verbalizer reads en_US. Another language would
need its own builder and verbalizer; it is not configurable.

By default there is **one pass** (`message`), repeated `announceRepeat` times.
When `opts.messages` is supplied (bilingual active), each entry
(`{ text, voice, lang }`) is its own pass, played once in order — e.g. English
then Spanish. Each unique `(lang, voice, text)` is rendered once via Wyoming and
de-duped. Each pass's text is normalized with its language's verbalizer
(`verbalizeForTts` for `en`, `verbalizeForTtsEs` for `es`) at render time.

A pass whose TTS fails, or whose WAV format doesn't match the klaxon
(rate/width/channels), is **dropped** — non-fatal; the other passes still play.
`≥1` pass must survive or the render is a hard error.

#### 4.3 "End of message" terminator (per-language)

When enabled, a terminator utterance ("End of message" / "Fin del mensaje")
rides the **last block of each language**. A bilingual alarm gets the English
phrase after the English pass and the Spanish phrase after the Spanish pass; a
monolingual alarm gets one terminator on the final block. A terminator that
fails to render or mismatches format is **omitted** (message still plays) and
marks the render incomplete.

Terminator audio is **cached permanently** at `/data/audio-render/term-<hash>.wav`
(keyed on render version + language + voice + phrase; the WAV header is
validated against the chime format at read time, and the age-based cache prune
exempts `term-*` files). The disk cache applies only when the voice is
explicitly pinned — with the voice unset the audio depends on the TTS server's
own default voice, so only the in-memory memo (cleared on restart) is used.
The phrases never change, so only the first announcement per key pays a render.
At boot the monitor **pre-warms** this cache (~20 s after start, Spanish first
so Piper is left holding the primary English voice), serialized through the
broadcast single-flight: each entry is its own queue slot, a pending real
broadcast makes remaining entries yield instantly, and a failed entry halts the
pre-warm rather than sending more requests to a struggling server. After any
voice change or cache wipe the cost is paid once at boot, never during an
alarm. Because Piper holds one voice model resident and a model switch costs
~4 s regardless of quality tier, a fresh bilingual alarm with warmed
terminators performs at most **one** voice switch — passes render
resident-voice-first (tracking updates only on real renders, never on cache
hits), and message passes always take budget priority over terminators.

#### 4.4 Format & concat

Everything is a **byte-splice of raw PCM** — there is no per-render resampling.
The renderer requires the chime WAV and every TTS WAV to be **identical format**
(22050 Hz / 16-bit / mono). Piper's default voice matches exactly. A mismatched
Piper voice (e.g. a 16 kHz voice) causes that pass to drop with a diagnostic like
`format mismatch — klaxon=22050/16/1 tts=16000/16/1`. `parseWavHeader` tolerates
extra chunks (Piper sometimes emits a LIST chunk) by scanning for `data`.

#### 4.5 Klaxon-only path

If **no** pass has spoken text (`anySpoken === false`), the render is chime-only
(lead silence + `announceRepeat` blocks of one chime each) — still cached, no
Wyoming call. With `leadMs === 0 && announceRepeat === 1` this is byte-identical
to the source klaxon WAV.

#### 4.6 Cache & the cache key

Renders are cached at `/data/audio-render/<hash>.wav`. On a cache hit a single
async `stat` short-circuits (returns `fromCache: true`). Writes are atomic:
unpredictable temp name (`<path>.<pid>.<rand>.tmp`) + exclusive create (`flag:
'wx'`) + `rename`, so the HTTP route can never serve a partially-written WAV.

**`renderCacheKey(...)`** is `sha1(...).slice(0,16)` over a `|`-joined string:

```
v<RENDER_VERSION>|<level>|r<announceRepeat>|s<leadMs>|g<repeatGapMs>|c<chimeGapMs>
  <tagPart><eomPart><msgPart><voicePart>|<message ?? '<null>'>
```

- `RENDER_VERSION = 6` — bumping it invalidates every cached render without touching disk.
- **Zero-churn design:** components are *omitted* for their neutral/default value so a default operator's key is byte-identical to the pre-feature string. Built-in chime tag omits `tagPart`; disabled terminator omits `eomPart`; monolingual omits `msgPart`; unpinned voice omits `voicePart`.
- `tagPart` for a named/custom tone also folds in `AUDIO_ASSETS_VERSION`, so regenerating a tone asset invalidates dependent combined renders.
- A null `message` hashes distinctly from empty string (klaxon-only vs empty-spoken don't share a slot).
- `wyomingVoice` (`BROADCAST_WYOMING_VOICE`) is folded in so a voice change re-renders (the monolingual path historically had no voice token → cache-hit the wrong voice's WAV; fixed v0.64.0).

**Incomplete renders** (a dropped pass or dropped terminator) are written to a
distinct `<hash>.partial.wav` name — served for this announcement but never
cache-hit — so once a Spanish voice is provisioned the next render is complete
and caches properly. Both are pruned by age.

`pruneRenderCache(dir, maxAgeMs, log)` runs hourly with
`CACHE_MAX_AGE_MS = 7 days`, and also sweeps crash-orphaned `*.tmp` files older
than 1 h.

#### 4.7 Render health — the dead-voice self-alert (v1.44.0)

The cache creates a blind spot: a wedged TTS engine (a Home Assistant Core
update can kill the Piper add-on's Wyoming socket while the add-on still reports
`started`) renders nothing, yet previously-cached WAVs keep playing, so the
alarm's voice can be dead for days while every repeated announcement still
sounds normal. The failure only surfaces when a *changed* message forces a fresh
render — which is precisely when speech matters.

`audioRenderer.ts` therefore tracks **fresh-render health** in a module holder
(`ttsRenderHealth()`): each render request whose spoken passes *all* fail
increments a consecutive-failure counter (recording the last error and
timestamp); a successful fresh render resets it. Cache hits never touch the
counter in either direction — they prove the disk file exists, not that the
engine is alive.

`alerts.ts` raises **`tts-render-degraded`** (warning, Connectivity/System)
when the counter reaches **≥ 2** — one blown render is tolerated as transient;
two consecutive failures with no intervening success indicates a wedged engine.
The alert names the failure count and last error, states that critical chimes
still deliver (the klaxon path needs no TTS) while speech is dropped, and
carries the remedy: restart the Piper add-on, after which the next changed
message re-renders and the alert self-resolves.

**Failure-path delivery (v1.45.0).** A spoken-render failure never silences a
condition broadcast: the announcement falls back to a **chime-only render**
(cached, no Wyoming dependency) so the klaxon still sounds, the outcome reports
`partial` with the render error retained, and the tick layer schedules **one
spoken retry 90 s later** — past a transient host stall (the observed failure
class: nightly backup I/O saturating the host at 04:58–05:02, colliding with
quiet-hours end). The retry re-checks the condition level, enablement, and
quiet hours, bypasses the storm gate (the identical message is intentional),
and is never repeated — a second consecutive failure is this alert's job. The
chime-only fallback does not touch the failure counter; only a fresh spoken
render success resets it.

---

### 5. The tone library (`audioAssets.ts`)

All alarm audio is **synthesized in-process at server startup** (speakers can't
synthesize on the fly, they need URLs). Format is fixed **PCM 22050 Hz / 16-bit
mono** (`SAMPLE_RATE`/`BITS_PER_SAMPLE`/`NUM_CHANNELS`). The synth primitive
`addTone` supports `square`, `sine`, and additive-harmonic `bell` waveforms with
attack/release envelopes; `addTone` floors the onset attack at ~4 ms to kill a
sample-0 DC click.

#### 5.1 The rung klaxons

Asset ids are written to `/data/audio/<id>.wav` and mapped to rungs by:

```
KLAXON_FOR_LEVEL = {
  critical: 'red-alert.wav',              high: 'powerplant-red-alert.wav',
  medium:   'yellow-alert.wav',           low:  'powerplant-yellow-alert.wav',
  clear:    'all-clear.wav',
}
```

**v1.59.0** widened this from three entries to five, giving P1/P2 and P3/P4
distinct klaxons. No `AUDIO_ASSETS_VERSION` bump was needed: all five WAVs were
already synthesized on disk (the two `powerplant-*` ids were promoted to
first-class named tones in v1.55.0), so this is a remap of existing assets, not
new synthesis. `boatswain` remains an asset id but is not a rung klaxon.

v1.56.0 — the `BROADCAST_CHIME_PACK` option is **removed**. The klaxons are one
fixed set (the melodic struck-bell waveforms). Both historical sets survive
individually as named tones, so an operator selects any of them per rung in the
Alert Console rather than choosing a set globally:

| Pack | red | yellow | green |
|------|-----|--------|-------|
| **`powerplant`** (named tones `powerplant-*`; the `builtin` tone of the high and low rungs) | Fast hi/lo square warble ~4 alt/s, 880/587 Hz, ~2.6 s ("drop everything") | Slow ~1.5 Hz single-tone sine, 620 Hz, 3 beeps, ~1.9 s | Soft descending bell double-chime 660→554 Hz, ~1.0 s |
| **`airport`** (named tones `airport-*`; also the synthesized `red-alert`/`yellow-alert`/`all-clear` level klaxons, the `builtin` tone of critical, medium and clear) | Descending struck-bell Am arpeggio C5→A4→F4, ×2, ~3.0 s | Two-note "bing-bong" E5→C5 bell, ~1.4 s | Rising C-major arpeggio C5→E5→G5 bell, ~1.3 s |

The `powerplant` pack follows ISA-18.2 / EEMUA-191 convention (priority conveyed
by *cadence*: fast warble = emergency, slow pulse = caution, soft chime =
advisory). `boatswain` (a two-tone sine sweep) is pack-independent.

#### 5.2 Named built-in tone library (v0.17.0)

A fixed, **selectable** library of 22 short tones (separate from the 4 klaxons),
synthesized once to `/data/audio/<id>.wav`, pack-independent. Catalog
(`BUILTIN_TONES`, ordered as shown in the UI dropdown):

`airport-red-alert`, `airport-yellow-alert`, `airport-all-clear`, `powerplant-red-alert`,
`powerplant-yellow-alert`, `powerplant-all-clear` (v1.55.0 — the six pack klaxons, listed first),
`ping-single` (Single Ping), `ping-double` (Double Ping), `triad-bell` (Triad
Bell), `triad-up` (Rising Triad), `marimba-run` (Marimba Run), `cascade` (Chime
Cascade), `doorbell` (Two-Tone Doorbell), `chirp-rise` (Rising Chirp),
`sweep-down` (Descending Sweep), `sonar-ping` (Sonar Ping), `pulse-slow` (Slow
Pulse (caution)), `warble-fast` (Fast Warble (emergency)), `buzz-alarm` (Alarm
Buzz), `klaxon-honk` (Klaxon Honk), `knock-soft` (Soft Knock), `gong` (Gong).

**Immutability contract:** a tone id is a permanent identity for one sound (its
render-cache tag is `b:<id>`, with no version component). To *change* a sound,
ship a new id — never edit an existing builder's waveform in place (it would
serve stale cached renders). Module load asserts every `BUILTIN_TONES` entry has
a matching `NAMED_TONE_BUILDERS` fn (a refused deploy is better than a catalog
tone that writes no WAV). A named-tone id must match
`BUILTIN_TONE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/`.

#### 5.3 Version-gated regeneration

`AUDIO_ASSETS_VERSION = 6`. A marker file `/data/audio/.assets-version` stores
`v<version>` (`v6`). Since v1.56.0 removed the chime-pack option, the marker is version-only and
matches no earlier `<n>` or `<n>:<pack>` marker, so every install regenerated once. If it doesn't
match, all WAVs are force-regenerated at boot (atomic tmp→rename), so bumping the version
regenerates without manual `/data/audio` cleanup.
`regenerateAudioAssets` (tests / explicit reset) deletes all assets + the marker
first.

---

### 6. Operator-uploaded tones (`chimeStore.ts`)

The operator can upload their own short WAV to prepend the spoken message.
Library lives at `CHIMES_DIR` (`<$CHIMES_DIR, else $DATA_DIR, else /data>/chimes`, default
`/data/chimes`): `<id>.wav` (normalized) + `manifest.json`.

**Two hard safety rules:**

1. **Normalize on ingest.** The renderer requires exactly 22050/16/mono. Rather
   than reject the ~99% of real files that are 44.1 kHz stereo, `normalizeToTarget`
   decodes (PCM int 8/16/24/32 or IEEE float 32), downmixes to mono, linear-
   resamples to 22050 Hz, and requantizes to 16-bit — ONCE, at upload. The
   per-render path stays a byte-splice.
2. **Server-generated ids only.** The id is `sha1(normalized PCM).slice(0,16)`
   (16 hex) — content-addressed, so a re-upload de-dupes. A client filename
   never touches a path/URL; it lives in the manifest only as a display label
   (`sanitizeName`). Every id passes through `chimeFilePath` which enforces
   `/^[a-f0-9]{16}$/` + a directory-containment check.

**Caps:** `MAX_UPLOAD_BYTES = 2 MB` raw, `MAX_CHIME_COUNT = 20` tones,
`MAX_DURATION_MS = 15 s`. The manifest is read into a null-prototype object with
per-key hex validation (prototype-pollution defense). `listChimes` self-heals
after manual file deletes (only surfaces entries whose file exists).

---

### 7. Per-rung chime assignment (`chimeConfig.ts`)

Persisted at `$CHIME_CONFIG_PATH` (default `chime-config.json` next to the DB).
Stores one assignment per **rung** — `CHIME_LEVELS` = `critical` / `high` /
`medium` / `low` / `clear`, pinned exhaustive against `AnnouncementLevel` by a
compile-time `Exclude<>` check:

```
{ kind: 'builtin' }        // the rung's synthesized klaxon
{ kind: 'named', id }      // a named built-in tone (the shipped default)
{ kind: 'custom', id }     // an uploaded tone
```

Granularity is per-rung as of **v1.59.0**; it was per-level (`red`/`yellow`/
`green`) before that, which made P1 indistinguishable from P2 by ear. Shipped
defaults are one DISTINCT named tone per rung (`warble-fast`, `klaxon-honk`,
`pulse-slow`, `doorbell`, `triad-up`) rather than all-`builtin` — on the
chime-only fallback the tone is the *entire* message, so identical defaults
would erase the severity distinction exactly when the spoken text is missing.

**Migration (v1.59.0).** `sanitize()` fans a legacy 3-key file out across the
five rungs — `red` → critical + high, `yellow` → medium + low, `green` → clear —
the inverse of the old `klaxonLevelForPriority` collapse, so whatever played for
a given alarm still plays for it. Resolution order per rung is: the rung's own
key, else its legacy level, else the shipped default. It runs on the **read**
path with no one-shot rewrite and is idempotent, which matters because /data
loss and partial restores are demonstrated events on this host. A wrong
migration fails silently — the file still parses, the console still renders, and
the operator's hand-picked tones are quietly replaced by defaults with nothing
logged. Pinned by `test/chimeConfigMigration.test.ts` (mutation-verified: the
fan-out, its direction, and own-key precedence each have a killing test).

**`resolveChime(rung, klaxonDir)`** is the single resolution seam (used at
every render call site). It returns `{ path, tag, fellBack }`:

| Assignment | path | tag |
|------------|------|-----|
| `builtin` (or unset) | `klaxonDir/KLAXON_FOR_LEVEL[level]` | `'builtin'` (omitted from cache key) |
| `named` (file present) | `builtinTonePath(id, klaxonDir)` | `b:<id>` |
| `custom` (file present) | `chimePath(id)` | `<16-hex id>` |
| named/custom **file missing** | **falls back** to the builtin klaxon path | `'builtin'`, `fellBack: true` |

The tag **always matches the returned path**, so the render cache can never
serve a stale tone for a swapped id. A dangling/deleted assignment degrades to
"wrong tone, message still plays" — never a silent alarm. `updateChimeConfig`
rejects assignments to ids that don't exist (keeps the prior value);
`revertAssignmentsFor(id)` reverts every level using a custom id back to builtin
when that tone is deleted.

---

### 8. Text-to-speech: message building & normalization (`ttsService.ts`)

#### 8.1 `buildAlertMessage(level, alerts)` → spoken English sentence

- `green` → `"All clear. All stations report normal."`
- `red`/`yellow` → picks a **primary alert** (`pickPrimaryAlert`: only alerts of the level's severity — critical for red, warning for yellow — then those with a location (`coreNum`), then category rank Battery > SHP2 > Solar > Grid > Thermal > Connectivity; never a non-annunciating or `audible: false` alert. The tick passes only the alerts the condition counts, `conditionNamePool`, v1.187.11) and builds:

  ```
  <ISA priority prefix> <Category clause> <Location>. <Title>. <detail>[ Acknowledge at console.][ Repeat. <prefix> <Title>.]
  ```

  Critical uses a doubled prefix ("Critical alarm. Critical alarm.") and appends
  an acknowledge + a brief repeat. Category is spoken-friendly ("Battery" →
  "Battery system", "SHP2" → "Smart panel"); location is number-worded ("Core 3
  Pack 2" → "Core three pack two"). Detail is shortened to ~200 chars
  (`shortenDetail`): at the last sentence end past char 100 — a `.`, `!` or `?`
  (and any closing quote or bracket) followed by whitespace or the end of the
  detail — else at the last whitespace, with an ellipsis. v1.187.22: the cut was
  the last `.` of the first 200 chars, and a decimal point is one, so a spoken
  figure was cut short ("about $2." for $2.19 on every spoken `peak-grid-draw`
  with confirmed rates; "load1 6." for 6.37 on host pressure). A no-primary
  fallback derives the prefix from the level's severity.

#### 8.2 `verbalizeForTts(s)` — the normalizer

Makes Piper read symbols/units naturally. It is the **v0.57.0 chokepoint**:
`buildAlertMessage` normalizes the title/detail, and the renderer normalizes the
whole assembled message a second time (so hand-built SoC/runway/test/preview
strings get the same treatment). It is therefore **idempotent at the function
level** (`verbalizeForTts(verbalizeForTts(x)) === verbalizeForTts(x)`).

Rules (order matters — longest token first):

- plural `(s)` → plain plural (`month(s)` → `months`; **v1.187.10** any word: `message(s)` had been read "message s");
- rate slashes → "per unit" (`%/h` → `percent per hour`);
- **v1.187.10** — an API path is read as its words, without slashes (`EcoFlow's /device/list` → `EcoFlow's device list`; only a slash that starts a word, after the rate slashes);
- relational/math symbols (`≥`→"at or above", `≤`→"at or below", `≈`/`~`→"about", `<`→"below", `>`→"above", `→`→"to", `²`→"squared"), plus ASCII `>=`/`<=`;
- **v1.187.23** — a range is read "to" (`readRanges`, first in the chain): an em/en dash with no space on either side between two numbers (the left one may carry a unit, am/pm or `%`; the right one may start with `$` or a weekday name) or between two weekday names (`On-Peak (4–7pm Mon–Fri)` → `On-Peak 4 to 7pm Mon to Fri`, read "On-Peak 4, 7pm Mon, Fri" on every spoken `peak-grid-draw` before; `23:00–Tue 05:00` → `23:00 to Tue 05:00`); a hyphen-minus between two weekday names, or between two numbers only when the right one carries am/pm, `%` or a unit (`4-7pm`, `36-38%`, `5-10 min`) and the left one does not follow a word character, `.`, `:` or a hyphen — so a negative number (`-3%`), a date (`2026-10-12`), a serial or alert id (`XXX0015-2`) or a version is never read as a range. The hyphen rule's unit list holds every unit spelling a unit rule matches (`min` and `mins` alike) and every word the unit rules expand it to, which keeps the function idempotent (`ttsRangeRead.test.ts` walks every spelling, spaced and glued);
- em/en dash, middot → a spoken pause; parens dropped. A **spaced** dash is always a pause, between numbers too (`Core 3 — 45%` → `Core 3, 45 percent`): prose dashes are written spaced;
- energy/power/electrical units, **number-anchored** (`(\d…)\s*UNIT\b`): `kWh`→"kilowatt hours", `Wh`, `kWp`, `kW`, `W`→"watts", `mAh`, `Ah`, `mA`, `A`→"amps", `mV`, `kV`, `V`→"volts";
- time units: `h`/`hr`/`hrs`/`hours`→"hours", `min`→"minutes", `mo`→"months", combo `3h 7m`→"3 hours 7 minutes"; **v1.187.10** a glued seconds age `31s`→"31 seconds" (the alert ages, `fmtAge`);
- `°F`/`°C`→degrees, `%`→"percent";
- domain abbreviations: `SoC`→"state of charge", `SoH`→"state of health", `IR`→"internal resistance", `EVSE`→"charger" (before `EV`), `RTE`, `TOU`, `PV`→"solar", `MPPT`→"M P P T", `BMS`/`EMS`, `HV`/`LV`, `EV`→"E V", `SHP2`→"smart panel", `DPU`→"D P U";
- singularize the realistic `1 <time>s` cases (`in 1 hours` → `1 hour`; `second` too since v1.187.10);
- collapse whitespace runs, tidy space-before-punctuation.

Unit rules are number-anchored so device SNs (`XXX0015`), error codes, and prose
("a breaker") are never corrupted. en_US only.

#### 8.3 Spanish second pass

`buildAlertMessageEs` mirrors the English builder with fully Spanish framing
(`priorityAnnouncementPrefixEs`, `categoryEs`, `locationEs`, `numberWordEs`). The
**title** is translated for broadcast-eligible families via `ES_TITLE_BY_ID_PREFIX`
(an id-prefix map, longer prefixes first), else the English title is read; the
free-form **detail tail** falls back to the English original (verbalized) — by
design, no translation API on the alarm path. `verbalizeForTtsEs` is the light
Spanish normalizer (templates are authored spoken-ready, so it only converts
stray symbols). **v1.187.23** — it reads ranges by the same rules with "a"
(`4–7pm lun–vie` → `4 a 7pm lun a vie`, `20-30%` → `20 a 30 por ciento`; Spanish
weekday names as well as English), and keeps a spaced dash as a pause. Green → `"Todo despejado. Todas las estaciones reportan
normalidad."`

---

### 9. Wyoming / Piper TTS client (`wyomingTts.ts`)

`renderWyomingTts({host, port, text, voice, timeoutMs})` speaks the **Wyoming
protocol directly to the Piper add-on over TCP** — no HA Core, no
`tts_get_url`, no Supervisor proxy in the path (that path went through six
failed iterations v0.9.18–v0.9.69; HA 2026.6.0b0's proxy started 500ing on
`tts_get_url`, so HA was removed from the TTS critical path entirely).

Protocol: JSON events over TCP with optional binary payloads. The client sends a
`synthesize` event (`{ text, voice?: { name } }` — voice omitted → Piper's
configured default), then assembles `audio-start` (format metadata) +
`audio-chunk` (binary PCM, repeated) + `audio-stop` into a WAV via `pcmToWav`.
Default `timeoutMs = 15000`. It is resilient to connect-refused, mid-stream RST,
malformed events, a hung server, empty payloads, and surfaces a Wyoming `error`
event (e.g. unknown voice name) verbatim. It does **not** retry — the renderer
owns retry/fallback policy (a failed pass simply drops).

`pcmToWav(pcm, rate, width, channels)` writes a 44-byte RIFF/WAVE header (single
allocation) byte-identical to `audioAssets.buildWavBuffer`, so the two renderers
produce concat-compatible WAVs.

---

### 10. `callHaService` — total, never throws (`haService.ts`)

Every HA interaction goes through `haService.ts`, which reads `SUPERVISOR_TOKEN`
and POSTs to `http://supervisor/core/api`. Outside Supervisor
(`isSupervised() === false`) every call is a no-op returning `{ ok: false,
error }` so the rest of the pipeline still runs in dev.

**`callHaService(domain, service, data)`** never throws — a network error is
caught and returned as `{ ok: false, error }`. It surfaces HA's actual error
message (`{"message": "..."}` body) rather than just a status code. Timeouts are
tuned per service:

| Call | headersTimeout | bodyTimeout | Why |
|------|----------------|-------------|-----|
| `music_assistant.play_announcement` | caller's budget, else **75 s** | caller's budget + 45 s, else **120 s** | MA blocks until playback finishes. Since v1.119.0 the broadcast monitor passes a budget sized to the clip (`announceTimeoutMs`: play time + 45 s, floor 75 s, ceiling 10 min); 75 s / 120 s remain the defaults for a caller that passes none. A timeout is delivery unknown, not a failure (§12i). |
| everything else | 5 s | 10 s | Keep hangs visible. |

Helpers used by the broadcast monitor: `getEntityState` (pre-flight + health
probe; returns null when HA doesn't know the entity), `getAllStates`
(discover + config-drift resolver), `probeService` (three-state
`present`/`absent`/`unknown` MA detection — `unknown` is not treated as a
confirmed negative, avoiding the boot-race "broadcasts will fail" false alarm),
`getServiceCatalog`, `startConfigFlow`/`submitConfigFlow`/`deleteConfigEntry`
(the `/api/broadcast/setup-piper` + `/reset-piper` Wyoming integration
management), and the legacy `ttsGetUrl` (with its en_US↔en-US language-toggle
retry chain — retained but off the current critical path).

---

### 11. Runtime config: env baseline + live override

#### 11.1 The two-layer model (`broadcastRuntimeConfig.ts`)

The add-on's env vars (from the HA options UI) set the **baseline**. A small,
user-mutable **override** layer persisted at
`broadcast-runtime-config.json` (next to the DB) sits on top. Each field is an
override: `null` = defer to env, a concrete value wins. `loadBroadcastConfig()`
re-merges the override every tick (~10 s) and per broadcast, so a UI change takes
effect within one tick with **no restart**. Only `enabled` is
overridable this way. Since v1.57.0 `volume` has one source, the `BROADCAST_VOLUME` add-on
option (applied on restart), and the Alert Console carries no volume slider. Writes are atomic (tmp+rename) with change listeners; the
monitor subscribes (`onBroadcastRuntimeConfigChange`) to keep its closure `cfg`
coherent for immediate read-back on `/api/broadcast/config` + `/status`.

**Important coupling:** `volume` is the abstract 0..1 master level from
`BROADCAST_VOLUME`. What actually reaches the speakers is `announceVolume` (0..100), which
`loadBroadcastConfig` derives from it. When `BROADCAST_ANNOUNCE_VOLUME` is pinned in env (a
number or `'off'`/`'standing'`), that advanced override wins and `BROADCAST_VOLUME` is
informational only (`announceVolumePinned` in `GET /api/broadcast/config` discloses this).

#### 11.2 `resolveAnnounceVolume` / `announceVolumeLevel`

- `BROADCAST_ANNOUNCE_VOLUME` = `'off'`/`'none'`/`'standing'` → `null` (omit `announce_volume`, play at standing level — more reliable on ecobees, and the pre-pin is skipped).
- a `0..100` number → that value.
- empty → `round(effectiveVolume × 100)`.

`announceVolumeLevel(announceVolume)` divides by 100 back to 0..1 for the
standing-volume pin — both knobs carry one value, not competing sources.

---

### 12. Full config knob reference

Loaded by `loadBroadcastConfig()` (env, with the runtime override for
enabled/volume). Booleans accept `true`/`1`.

| Env var | Default | Effect |
|---------|---------|--------|
| `BROADCAST_ENABLED` | `false` | Opt-in master enable (overridable live). |
| `BROADCAST_TARGETS` | — | Comma-separated `media_player.*` entity ids (MA speakers). Non-`media_player.` entries dropped. |
| `BROADCAST_SIP_TARGETS` | — | Comma-separated `media_player.*` SIP/announce-only targets. Entries also in `BROADCAST_TARGETS` dropped. |
| `BROADCAST_AUDIO_BASE` | `http://homeassistant.local:8787` | URL prefix speakers fetch the rendered WAV from (trailing slash stripped). |
| `BROADCAST_VOLUME` | `0.5` | 0..1 master level, the only volume source (v1.57.0; applied on restart). Clamped. |
| `BROADCAST_ANNOUNCE_VOLUME` | (empty → volume×100) | Pins announce volume: a `0..100` number, or `off`/`none`/`standing` to omit it. |
| `BROADCAST_MIN_SEVERITY` | `critical` | `critical` or `warning` — the lowest level that broadcasts (`yellow` skipped when `critical`). |
| `BROADCAST_QUIET_HOURS` | `22-06` | Whole local hours `HH-HH`, wrapping past midnight; empty = no quiet window. Suppresses non-critical (and critical unless break-through) in-window. |
| `CRITICAL_BREAKS_QUIET_HOURS` | `false` | When true, red/high/critical break through quiet hours; default OFF ⇒ everything held overnight. |
| `BROADCAST_WYOMING_HOST` | `core-piper` | Wyoming/Piper TCP host. |
| `BROADCAST_WYOMING_PORT` | `10200` | Wyoming/Piper TCP port. |
| `BROADCAST_WYOMING_VOICE` | (Piper default) | Piper voice override (e.g. `en_US-amy-medium`). Folded into the cache key. |
| `BROADCAST_WYOMING_VOICE_ES` | (empty) | Second-language (Spanish) Piper voice. Empty → bilingual inactive. |
| `BROADCAST_BILINGUAL` | `false` (the shipped default; absent in a bare environment reads as on) | Enable the Spanish second pass (no-op until `_VOICE_ES` set). |
| `BROADCAST_LEAD_SILENCE_MS` | `1000` | Lead-in silence, clamped 0..5000 (1500 when the variable is unset). |
| `BROADCAST_REPEAT` | `2` | Whole-block repeats, clamped 1..3. |
| `BROADCAST_REPEAT_GAP_MS` | `1500` | Silence between repeats, clamped 0..5000. |
| `BROADCAST_CHIME_GAP_MS` | `1000` | Post-chime gap, clamped 0..5000. |
| `BROADCAST_USE_PRE_ANNOUNCE` | `false` | MA pre-announce wake tone. |
| `BROADCAST_ANNOUNCE_RETRIES` | `1` | In-call MA retries, clamped 0..3. |
| `BROADCAST_END_OF_MESSAGE` | `true` | Append the terminator to the final play. |
| `BROADCAST_END_OF_MESSAGE_PHRASE` | `End of message` | English terminator (blank disables). |
| `BROADCAST_END_OF_MESSAGE_PHRASE_ES` | `Fin del mensaje` | Spanish terminator. |
| `BROADCAST_END_OF_MESSAGE_GAP_MS` | `700` | Pre-terminator gap, clamped 0..5000. |
| `BROADCAST_BOOT_WARMUP_MS` | `600000` (10 min) | Restart-continuation + boot phantom-red + red-replay window. |
| `BROADCAST_RED_REPLAY_MIN_GAP_MS` | unset (`Infinity`, v1.78.0) | Unset: an unchanged, verifiably announced standing red never replays at boot. A positive value restores the v1.64.0 timed reminder (that many ms of silence per announcement). A changed or new fault, or an escalation, ignores it. |
| `BROADCAST_RED_REPLAY_STATE_PATH` | `<db>/../broadcast-red-replay.json` | Persisted `{lastRedAnnouncedAtMs, voicedFingerprint, activeFingerprints, lastPlayedLevel}` — the only channel the gate has across a restart. |
| `BROADCAST_HEALTH_PROBE_MS` | `60000` | Audible-health probe period P. The periodic probe runs once P − min(1 s, P/10) has passed since the last probe of any kind (a tolerance for the interval's own jitter); a probe is also armed at a pending run's span end (§13, v1.187.22). |
| `BROADCAST_UNREACHABLE_CONFIRM` | `3` | C: the unreachable and degraded runs are confirmed after C failing probes **and** (C − 1) × `BROADCAST_HEALTH_PROBE_MS` since the run's first failing probe (v1.187.22; a count alone before). Forced probes count but do not restart or shorten the span. `1` confirms on the first failing probe. |
| `DATA_DIR` / `CHIMES_DIR` / `CHIME_CONFIG_PATH` / `BROADCAST_RUNTIME_CONFIG_PATH` | `/data`-relative | Storage locations. |

Alert-settings knob consumed by rendering: the per-priority annunciation enable
flags. The chime itself plays exactly once per block and is not operator-tunable.

---

### 13. Audible-delivery health & self-alert (`broadcastHealth.ts`)

The audible channel can be **enabled yet reach zero speakers** — the exact
silent failure that once hid a dead alarm channel (Music Assistant fell into
`setup_error`, every MA media_player went `unavailable`, and nothing said so).
This module makes that self-announcing.

The monitor runs `computeAudibleHealth()` on its own throttle
(`AUDIBLE_HEALTH_PROBE_MS` from `BROADCAST_HEALTH_PROBE_MS`, P below, default 60 s) — **not**
only when a broadcast fires — so a dead channel is caught even while the fleet is
green. Three kinds of probe are *forced* past the throttle: the boot kick (~15 s after start),
the probe a broadcast forces when its pre-flight finds no usable speaker, and the deadline probe
at the end of a run's span (below). Each probe reads target
availability (`getEntityState` each target; usable = present and not `'unavailable'`) and
publishes a `BroadcastHealth` snapshot via `setBroadcastHealth`. A re-entrancy guard
(`audibleProbeInFlight`) coalesces overlapping probes, so one real window is counted once.

**Debounce — a run that spans time (v1.187.22).** The unreachable state (zero usable speakers)
and the degraded state (fewer usable than configured) are each debounced by a *run* of failing
probes (`audibleRunStep`: the run's count and the time of its first failing probe). A run is
confirmed only once it holds C failing probes (`AUDIBLE_UNREACHABLE_CONFIRM` from
`BROADCAST_UNREACHABLE_CONFIRM`, default 3) **and** (C − 1) × P has passed since its first
failing probe — two minutes at the defaults; C = 1 confirms on the first failing probe. Forced
probes count toward C but neither restart nor shorten the span, so a Music Assistant restart
that puts a failed broadcast, the boot kick and a failed retry within ~30 s is not confirmed as
a dead channel (a count alone confirmed it, and pushed "unreachable" and its "Resolved" within
two minutes). Until a run is confirmed, `reachable` holds its prior published value (`null` at
boot, which never alarms; `true` after a usable read); a probe that reads any usable speaker
publishes `true` at once and ends the unreachable run. A wall clock stepped back past the run's
first failing probe re-anchors the span at the current probe.

**Probe timing.** A forced probe restarts the periodic throttle, so the tick that would have
reached a run's span can be skipped, and a run opened by a forced probe reaches its span between
ticks. After every probe that ran, a **deadline probe** is therefore armed at the earlier span
end of the open, unconfirmed runs (`audibleProbeDeadline`, judged from the probe's start, so a
deadline probe dropped by the re-entrancy guard is re-armed by the probe it ran into):
confirmation lands at the span, not up to two periods past it. A run already past its span with
a short count is left to the periodic probe, so rapid probes cannot make up the count. The
periodic throttle (`audibleProbeDue`) runs a tick once P − min(1 s, P/10) has passed since the
last probe of any kind: a tolerance for the interval's own jitter (a tick read P − 1 ms after
the last one was skipped, the run lost a probe, and confirmation waited a further period). The
periodic probe therefore never runs within P − min(1 s, P/10) after another probe, and a clock
stepped back past the last probe is due at once.

**Holds.** A confirmed unreachable channel reads `false` until a probe reads a usable speaker. A
confirmed degraded channel holds through every failing probe until a probe reads every
configured speaker usable (`audibleDegradedStep`), so a re-anchored run cannot read as
"restored" and push the degraded alert a second time.

**Immediate paths (unchanged).** No speakers configured (`BROADCAST_TARGETS` empty) reads
unreachable on the first probe, and the config-drift resolver's rename signature (below) marks
the channel unreachable at once: neither is a transient, so neither is debounced.

**Read at dispatch.** The alert monitor reads the two audible-channel alerts afresh every time it
assembles an alert set, including the set it dispatches after its wait on the analytics worker (up
to `ALERT_FEED_BUDGET_MS`). A probe that clears the channel during that wait therefore keeps the
stale alert out of the push. Rising edges are then dispatched one at a time, so a probe that clears
the channel between assembly and that alert's own dispatch can still let one stale push through; the
next tick resolves it.

Two not-usable signatures are distinguished for triage: all-`null`
(entities NOT FOUND → MA likely down/removed its players, or HA API unreachable)
vs all-`unavailable` (integration loaded, speakers offline). A one-shot
**config-drift resolver** (`resolveTargetDriftOnce`, ~16 s after boot) resolves
every configured target against the full HA registry and, when *other*
`media_player` entities exist but the specific target does not (the unambiguous
rename signature), logs a loud named WARN and un-debounced marks the channel
unreachable — a rename never self-heals.

**`broadcastHealthAlert(h, nowMs)`** is a pure builder: an enabled + supervised
channel that is CONFIRMED unreachable becomes a **WARNING / MEDIUM** push alert
`system-audible-unreachable` (`AUDIBLE_UNREACHABLE_ALERT_ID`). It returns null in
every other state (disabled / unsupervised / `reachable !== false`), so an
unwarmed monitor never false-alarms. It is deliberately NOT `annunciate: false`
(that would suppress the push too); instead `conditionFromAlerts` excludes its id
so it can never circularly try to chime over the channel it reports broken.
Severity is medium so it never wakes the household through quiet hours — an
unreachable speaker is not itself an emergency (the real emergencies push on
their own alerts). It also mirrors to HA diagnostic sensors via `mqttDiscovery`.

**`broadcastDegradedAlert(h, nowMs)`** (v1.186.0): while fewer Music Assistant targets are usable
than configured, confirmed by the same time-spanned debounce (`audibleDegradedStep`, held once
confirmed — see above), a **WARNING / MEDIUM** push alert `system-audible-degraded`
(`AUDIBLE_DEGRADED_ALERT_ID`) names the speakers that will not play. It yields to
`system-audible-unreachable` once that is confirmed, resolves when every target is usable again,
and shares the `system-audible` prefix that keeps it out of the audible condition. Each broadcast
also logs `only N of M Music Assistant target(s) usable`.
The status sensor (`audible_status`, "Audible Alarm Channel") has four values, from
`audibleStatus(h)`: `unknown` before the first probe (`lastProbeAt` null), then `disabled`
when broadcast is off, `reachable` / `UNREACHABLE` by the debounced `reachable`, and
`unknown` while that is null. **v1.187.10:** the pre-probe default carries
`enabled: false` only because nothing has been read yet, and the publisher tested `enabled`
first, so every restart published `disabled` for one 30 s cycle on a channel configured on
(the first state publish lands ~5 s after broker connect, the first probe ~15 s after
broadcast init, and the probe does not trigger a republish). The probe runs when broadcast
is disabled too, so a disabled channel reads `disabled` from the first probe on.

---

### 14. HTTP API surface (`index.ts`)

Static routes (all `decorateReply: false`; render/chime dirs use `wildcard:
true` for on-demand files):

| Route | Serves |
|-------|--------|
| `/audio/<id>.wav` | Built-in klaxons + named tones (generated at boot; `wildcard: false`). |
| `/audio-render/<sha1>.wav` | On-demand combined announcement renders. |
| `/chimes/<id>.wav` | Operator-uploaded tones (in-browser preview). |

JSON endpoints:

| Method + path | Auth | Purpose |
|---------------|------|---------|
| `GET /api/broadcast/status` | none (read-only) | Full status snapshot: `enabled`, `targetCount` (**v1.131.0**: Music-Assistant **plus** SIP targets, itemised as `maTargets`/`sipTargets`; `targets` is retained for back-compat and still lists the MA set only), `lastBroadcastAt/Level/Outcome/Errors` (the last broadcast attempted; since **v1.187.0** a storm-gate refusal is reported apart in `lastSuppressedAt/Level/Kind/Reason` and never becomes the last broadcast), `musicAssistantAvailable` (honest: present AND not confirmed-unreachable), `wyomingReachable`, `stormSuppressedCount`, `audibleReachable`/`audibleUsableTargets`/`audibleReason`, the degraded channel `audibleConfiguredTargets`/`audibleDegraded`/`audibleUnusableTargets` (v1.186.0), `lastBroadcastKind`, the restart-baseline record `conditionLevel`/`conditionSpoken`/`conditionAt`/`bootBaselineLevel`, `lastRender` (filename/bytes/ttsRenderMs/fromCache/error), live `grid` backstop, and a resolved `config` block (all knobs + `announceVolume`). `sipTargets` arrived in v1.25.0 and was threaded through dispatch and the log lines ("2 MA + 1 SIP") but not through `status()`, so the route named two of three speakers — and the one it omitted is specifically the redundant channel designed to work when Music Assistant is down, which is exactly when an operator reads this. |
| `GET /api/broadcast/config` | none (120/min bucket) | Effective enable/volume + `announceVolume` + `announceVolumePinned` + `override` + `envBaseline`. |
| `PUT /api/broadcast/config` | write (30/min) | Set/clear the runtime `enabled` override (`{ enabled }`: `true`, `false`, or `null` to clear to env). Volume is not settable here (v1.57.0). Audit-logged. |
| `POST /api/broadcast/test` | write | Fire a test broadcast at `{ level }` — `red`, `yellow` or `green` (default `red`; any other value is refused with 400, v1.185.1). Bypasses all gates except the 10 s test cooldown (`TEST_COOLDOWN_MS`). 429 on cooldown, 502 on failure. |
| `GET /api/broadcast/discover` | write | Enumerate every `media_player` HA knows (friendly name, inferred family, state, volume, `currently_configured`) so the operator picks targets from a real list. 503 if unsupervised/unreachable. |
| `POST /api/broadcast/setup-piper` / `reset-piper` | write | Add/reset the Wyoming Protocol integration via config-flow helpers. |
| `GET /api/chimes`, `GET /api/chime-config` | none | Console payload: the five rungs, their labels, per-rung `assignments`, uploaded `chimes`, `builtinTones`, `maxUploadBytes`. |
| `POST /api/chimes?name=` | write (rate-limited) | Upload a raw WAV body; `saveChime` validates + normalizes + stores. 400 on bad WAV / full library. |
| `DELETE /api/chimes/:id` | write | Delete a tone; reverts any level assigned to it back to builtin. 404 if absent. |
| `PUT /api/chime-config` | write | Assign tones per level (`{ assignments }`). 422 with `rejected[]` for unknown ids (prior value kept). |
| `GET/PUT /api/alert-settings` | read/write | Per-priority enable flags. |
| `POST /api/alert-preview` | write | Preview a `{ priority, target }` announcement; `priority` is any rung, `clear` included (v1.186.4). `browser` renders only (returns `audioPath` for the web app to play); `speakers` also plays it to every configured speaker, the MA targets and the SIP targets together (v1.186.4), and returns `delivered` (speakers that accepted it) and an optional `note` (`previewSpeakerOutcome`: a timed-out SIP dispatch is unconfirmed, not failed; Switchboard skips an identical announcement repeated inside its dedupe window). Short 2 s cooldown (`PREVIEW_COOLDOWN_MS`). |

#### The three operator-initiated render paths

- **`test(level)`** — 10 s cooldown; bypasses storm gate + all annunciation gates; speaks an ISA-prefixed "Test broadcast. This is only a test." (bilingual when a Spanish voice is set).
- **`preview(priority, target)`** — 2 s cooldown; renders via the identical `renderAnnouncement` call so it sounds exactly like a real alarm; `browser` never touches MA (works even when broadcasts are disabled / no targets).
- **`announce(priority, message, messageEs, opts?)`** — the dedicated path (kind `dedicated`) for the SoC ladder, the runway alarm, and the night-charge and Charge Now notices. Returns at once when broadcasts are disabled; maps priority → level via `klaxonLevelForPriority`, reuses `runBroadcast`, applies the quiet-hours gate (high/critical break through only with `CRITICAL_BREAKS_QUIET_HOURS`) but **no cooldown** (the callers edge-limit). `opts.consentNotice` (the supervised night-charge arm/cancel, v1.122.0) bypasses the storm gates. A failed spoken render earns the one spoken retry with its own words. Never throws.

---

### 15. Honest-null & edge-case behavior (summary)

- **Missing/corrupt custom or named tone** → `resolveChime` / renderer fall back to the built-in klaxon (`fellBack: true`); never a silent alarm.
- **Failed TTS pass** (Wyoming down, unknown voice, format mismatch) → that pass drops; other passes still play; `≥1` must survive or it's a hard error.
- **Failed terminator** → omitted; message still plays; render marked incomplete → written to `.partial.wav` (served but not cached).
- **All MA targets unavailable** → deferred + retried at 30/90/180 s; SIP side-channel already delivered independently.
- **Sub-2 s MA "ok"** → treated as unverified (HA accepted but dropped it) → retried.
- **`musicAssistantAvailable`** reported true only when the service is present AND audible isn't confirmed-unreachable (MA in `setup_error` keeps its services registered while playing to no one).
- **`audibleReachable = null`** (pre-probe / transient restart) never raises the self-alert — only a debounced `false` does.
- **VOLUME_SET-incapable target** (cordless) → per-target pin isolates it so capable ecobees are still pinned.
- **Renderer cache** keyed on version + every timing/tone/voice/message input; incomplete renders never occupy the complete key; hourly prune at 7-day age plus a 1-hour orphan-`.tmp` sweep.
- **Restart** → boot warm-up (10 min) suppresses re-spoken yellow/green advisories; the first fresh red is held one tick to filter a telemetry-populate phantom. A red is **never** suppressed on level alone, and **never on the bare alert id** either (`dpu-err-<sn>` is emitted for every `sysErrCode`, so one id spans many faults) — only a red whose **spoken** critical carries the same `id`+`title`+`fault` fingerprint already verifiably announced since that fault began (no time bound by default, v1.78.0; `BROADCAST_RED_REPLAY_MIN_GAP_MS` restores a timed one), with nothing new alongside it and no escalation, is skipped for that boot (`redReplayGate`). A standing fault re-klaxoning on every deploy trains the household to ignore the loudest tone the system has; a changed fault, a new fault, an escalation, or an intervening all-clear always fires.


---

