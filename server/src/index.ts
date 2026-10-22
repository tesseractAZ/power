import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config, option } from './config.js';
import { cached } from './cachedReply.js';
import { clearedHistoryPage } from './clearedHistory.js';
import { limits, MPC_RESERVE_FALLBACK_PCT } from './limits.js';
import { SHP2_SOURCE_SLOTS, SHP2_CIRCUIT_COUNT } from './hwSpec.js';
import { siteResponse, pvSite, isLegacyPvSite, physicsAmbientC, siteRepairIssues, siteBootNotices, checkHaHomeLocation } from './site.js';
// v1.191.0 (lane A) — the site clock (siteTime.ts) and its main-thread side (boot log, HA comparison).
import {
  siteTimeZone, siteYmd, siteMinuteOfDay, siteDayStartMs, siteNextDayStartOf, addDaysYmd, zonedWallTimeMs,
  fmtSiteClock, fmtSiteWeekday,
} from './siteTime.js';
import { siteTimeBootLines, checkHaTimeZone, siteTimeRepairIssues } from './siteTimeHa.js';
import { productKind, warrantyChassis, configuredBenchSpareSns, deviceAliases } from './topology.js';
import { exportDatabase, describeExistingExport, exportInProgress, DEFAULT_EXPORT_DIR, publishedSnapshotStatus } from './dbExport.js';
import { createAuth, isAllowedOrigin } from './auth.js';
import { SnapshotStore, startPollLoop, alarmPathShp2Sns } from './snapshot.js';
import type { FleetSnapshot } from './snapshot.js';
import { shp2ConnectedDpuSns, isShp2Connected, aggregateFleetFlow, findShp2, onlineDpus, isHomePoolDpu, setLastKnownHomeRoster, shp2Panels, shp2ReadbackFresh, nightPlanPanelVerdict, secondaryShp2s, houseSnOf, panelForClient, backupTimerGate } from './shp2Membership.js';
import { loadMembershipHistory, membershipVerdict } from './membershipHistory.js';
import {
  loadReconnectWatchState, saveReconnectWatchState, evaluateReconnectWatch,
  renderReconnectReport, ARM_OFFLINE_MS as RECONNECT_ARM_MS, type DeviceObs as ReconnectDeviceObs,
} from './reconnectAudit.js';
import { startMqtt } from './ecoflow/mqtt.js';
import { createRecorder } from './recorder.js';
// v1.188.1 (review) — the bridge's verdicts, for the backup timers and the card (shp2Membership.ts BridgeVerdicts).
import { slotVerdicts } from './energyBridge.js';
import { kwh1, makeLifetimeKwh, makeAlertCounter, soonestProjecting, dailyFigureResetIso } from './haPayloadFmt.js';
import { startOfLocalDayMs } from './aggregator.js';
import { setClockRejectLogger, ecoflow,
} from './ecoflow/rest.js';
import {
  decideChargeNowResponse, freshResponderState, resolveChargeNowMode,
} from './chargeNowResponder.js';
import { getLastPeakDrawObservation } from './peakGridDraw.js';
import { setChannelForceCharge, setForceChargeCeiling } from './ecoflow/commands.js';
import {
  decideForceCharge, forceChargeEnabled, desiredForceChargeCeilingPct, forceChargeInFlight, forceChargeCommandsOf,
  actuationStepOrder, runActuationSteps,
  FORCE_CHARGE_CEILING_MIN_PCT, FORCE_CHARGE_OFF_DEADLINE_AFTER_OFF_MS,
  FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS, type ForceChargeAction,
  forceChargeRateKw, FORCE_CHARGE_PLAN_RATE_KW, shp2HouseLoadKw, FORCE_CHARGE_MIN_RATE_KW, planChargeCapKw,
  evDisplacedPackKwh,
  forceChargeKwPerCore, planRateFallbackKw,
  FORCE_CHARGE_ON_VERIFY_AFTER_MS, FORCE_CHARGE_ON_MAX_RETRIES, FORCE_CHARGE_ON_RETRY_CUTOFF_MS, forceChargeOnReadbackStatus,
  forceChargeNightOutcome, partialForceChargeOnFailureSlots, FORCE_CHARGE_MAX_RUN_MS,
} from './nightForceCharge.js';
import {
  extractSettingsSurface, evaluateDrift, freshDriftState, loadConfirmedSurface,
  type ActuatorContext, type SurfaceDevice,
} from './settingsDrift.js';
import { DriftHoldQueue, driftHeldPath, settleDriftTick, type DriftHoldLog } from './settingsDriftHold.js';
import { parseQuietHours as parseNotifyQuiet, inQuietWindow as inNotifyQuiet } from './alertMonitor.js';
import { fetchVendorDay, loadVendorEnergyState, saveVendorEnergyState, driftPct, missingDays, isIncompleteDay, computeEmpiricalRte, computeLocalPackRte, type VendorDayRecord } from './energyHistory.js';
import { exportVendorStatistics } from './haStatistics.js';
import { buildWarrantyBundle, renderWarrantyMarkdown, renderWarrantyCsv, loadClearedRecords } from './warrantyExport.js';
import { startAlertMonitor, rosterMuteReasonForSn } from './alertMonitor.js';
import { systemOutageFields, telemetryGapLedgerSummary } from './alerts.js';
import { isConfigured, reachesAPhone, getLastPushFailures } from './notify.js';
// v0.9.18 — ship-wide audible broadcast to HomePod/Sonos via HA media_player.
import { generateAudioAssets, BUILTIN_TONES } from './audioAssets.js';
import { startBroadcastMonitor, parseBroadcastTestLevel } from './broadcast.js';
import { getAllStates, getEntityState } from './haService.js';
// v0.9.33 — Supervisor add-on + Core config-flow helpers
import {
  listAddons,
  listConfigEntries,
  startConfigFlow,
  submitConfigFlow,
  deleteConfigEntry,
} from './haService.js';
// v0.9.25 — feedback-loop foundation
import { appendAlertOutcome, tailAlertOutcomes, computeFamilyStats, type AlertOutcome } from './alertOutcomes.js';
import { getSnapshot, dropSnapshot } from './featureSnapshot.js';
// v0.9.27 — multi-track model advance
import { updateFromOutcome } from './models/onlineLR.js';
import { computeModelHealth } from './models/modelHealth.js';
import { physicsPmax, physicsScore } from './physics/clearSky.js';
import { analyzePackLfp } from './physics/lfpOcv.js';
import { packCurrentAmps, observePackRest, lastNonRestingAtMs, retainPacks, packRestKey } from './physics/restTracker.js';
import { fitHierarchical, findOutliers, type HBPackObs } from './models/hierarchicalBayes.js';
import { recommendDispatch, mpcPoolBasis, type MpcInputs } from './dispatch/mpc.js';
import {
  // v0.10.0 — recorder-backed compute* moved to the analytics worker
  // (see analyticsClient.report). Only the PURE assemblers that take
  // already-computed inputs and no recorder stay imported here; they run
  // cheaply on the main thread over worker-fetched report data.
  computeConfidenceSnapshot,
  getActiveNwsAlerts,
  computeDispatchPlan,
  rootCausesFor,
  computePackRiskScores,
  runwayHoursForPublish,
  // v1.38.0 (night-charge WS4) — verified efficiency seams the advisor sizes
  // against (injected, never hard-coded downstream): legEff = √DISPATCH_RTE,
  // dischargeEff = the DC-bus discharge tax.
  DISPATCH_ROUND_TRIP_EFFICIENCY,
  RUNWAY_DISCHARGE_EFFICIENCY,
  hourlyRateCents,
  mpcFallbackPair,
} from './analytics.js';
import type {
  ProbabilisticForecast, MultiDayForecast, DayForecast, EvWindowPrediction, ForecastHour,
} from './analytics.js';
import { startSshServer, loadOrCreateHostKey } from './telnet/server.js';
import { authFromEnv, authConfigProblems, describeSshAuth } from './telnet/session.js';
import { createTuiDataProvider } from './telnet/dataProvider.js';
import { registerWsConsole } from './telnet/wsConsole.js';
import { startMqttDiscovery } from './mqttDiscovery.js';
import { buildCalendarIcs } from './calendar.js';
import { computeRepairIssues } from './repairIssues.js';
import { getWeather, createGhiTickLogger } from './weather.js';
import type { WeatherForecast } from './weather.js';
import { computePackRiskV2 } from './ml.js';
import { initAnalyticsClient } from './analyticsClient.js';
import {
  refreshShp2CloudPresence,
  setBackupReserveSoc,
  debugSendCommand,
  isWriteDebugEnabled,
  checkWriteDebugToken,
  cooldownRemainingMs,
  REFRESH_COOLDOWN_MS,
} from './ecoflow/commands.js';
import { appendWriteLog, tailWriteLog } from './writeLog.js';
// v0.11.0 — ISA-18.2 / IEC 62682 alarm-priority Alert Settings + preview.
import { getAlertSettings, updateAlertSettings, isPriorityEnabled } from './alertSettings.js';
import { getBroadcastRuntimeConfig, updateBroadcastRuntimeConfig } from './broadcastRuntimeConfig.js';
// v0.15.23 — Alert Console: operator-uploaded chime tones + per-level assignment.
import {
  CHIMES_DIR, MAX_UPLOAD_BYTES, listChimes, saveChime, deleteChime,
} from './chimeStore.js';
import {
  getChimeConfig, updateChimeConfig, revertAssignmentsFor, CHIME_LEVELS,
  type ChimeAssignment,
} from './chimeConfig.js';
import type { AnnouncementLevel } from './audioRenderer.js';
import { ALARM_PRIORITY_ORDER, ALARM_PRIORITY_META, type AlarmPriority, type AlarmRung } from './alertPriority.js';
// v0.12.0 — backup-pool SoC audible alarm (escalating priority). v1.187.22 — the ladders live in socLadders.ts.
import { startSocLadders } from './socLadders.js';
import { createRunwayAlarm, shouldGateRunwayAudible, runwayAlarmStatePathFor } from './runwayAlarm.js';
import type { Shp2Projection } from './ecoflow/project.js';
import { panelPoolNetWatts, noteDrainSample, panelDrainRunway, type DrainSample, type PanelRunway } from './panelRunway.js';
import { PoolEnergyBasisTracker, defaultPoolEnergyBasisPath } from './poolEnergyBasis.js';
import { liveGridBackstop, livePoolGridBackstop, gridPresenceEntityId, setPersistedGridAbsentSource, type GridBackstop } from './gridState.js';
import { getBroadcastHealth } from './broadcastHealth.js';
import { publishReadiness, withholdUnready } from './publishReadiness.js';
import { hostPowerEntityId } from './hostPower.js';
import { sampleHostTemp, liveHostTemp } from './hostThermal.js';
import { startVitals, tickAssess, liveVitals, currentAssessment, degradedMode } from './selfVitals.js';
import { startHeartbeat, heartbeatStatus } from './heartbeat.js';
import { classifyMqttStartFailure } from './mqttStartClassify.js';
import {
  hasReachabilityConfig,
  deviceReachabilityEntities,
  setDeviceReachability,
  interpretReachabilityState,
  countCloudWedges,
} from './deviceLink.js';
import { installProcessGuards } from './processGuard.js';
import { createLoadShedAdvisor } from './loadShedAdvisor.js';
import { RateFloorTracker, isElectricallyIdle, decideCollapseSurfacing, rateFloorSampleSet, DEFAULT_RATE_FLOOR_CONFIG, type RateFloorPersisted } from './messageRateFloor.js';
import { listConfirmedRecords, clearConfirmedPack } from './defectivePackLatch.js';
import { evaluateSelfHeal, selfHealQuorum, idleExclusionEdges, loadSelfHealState, saveSelfHealState, DEFAULT_SELF_HEAL_CONFIG, canRemediateNow, recordRemediationHeal, HEAL_BUDGET_WINDOW_MS } from './sessionSelfHeal.js';
import { setBlindRemediationHooks } from './blindRemediation.js';
import { assessBlind, pollState, pollHealth, healthPollErrorKind } from './telemetryBlind.js';
import { setClockOffsetLogger } from './ecoflow/rest.js';
// v0.93.0 (audit #1 phase-2) — publish rate-floor collapses so alertMonitor turns
// them into real push alerts (mirrors broadcastHealth's set/get + pure-builder split).
import { setRateFloorCollapses, setRateFloorIdleHeld, surfacedCollapseEntry, rateFloorCollapseLine, type RateFloorCollapse, type RateFloorOnsets } from './messageRateFloorAlert.js';
import { getShedCandidates, initShedRegistry } from './loadShedRegistry.js';
import * as haStateCache from './haStateCache.js';
// v1.38.0 (night-charge WS4 integration) — wire the ADVISORY TOU-arbitrage
// night-charge advisor (nightChargeAdvisor.ts / nightChargeGate.ts) into the
// live surfaces. READ-ONLY / NO-WRITE: nothing below produces state the
// floor/runway/SoC alarm spine depends on; every field emits null over a
// fabricated number. Design: docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md §2–§5.
import {
  getLatestNightChargePlan,
  setLatestNightChargePlan,
  nightChargeStateFields,
  // R4 — the overnight window's role in the cycle (the ecoflow_night_charge_role entity).
  nightChargeRoleFields,
  buildNightChargeInputs,
  computeNightChargePlan,
  resolveCheapWindow, nextFullCheapWindow, longGapAhead, pessimisticPrePeakSurplus,
  scoreNightOutcome,
  nightWindowBounds,
  medianFilter3,
  plannerSizingNeedBuyKwh,
  calibratedLoadBandFactor, calibratedBuyDebiasFactor, buyDebiasUnmeasuredLogLine,
  buildCostSurplusLoad, costSurplusLedgerColumns,
  // v1.187.22 — the expected buy: its ledger columns, and what a spoken line states (the level
  // the write drives to and the expected draw — never the worst case, which only logs name).
  expectedBuyLedgerColumns, ledgerExpectedBuyKwh, chargeLevelPct, statedBuyKwh, buyFiguresLogText,
  chargeIsWindowBound,
  // R2 — the leg a plan sizes (every live plan is the overnight cost leg).
  OVERNIGHT_WINDOW_SPEC,
  type NightChargePlan,
  type NightChargeInputDeps,
  type NightForecastHour,
  type NightDayRollup,
  type NightEvCommit,
  type NightOutcomeActuals,
  type BindingCap,
  type NightChargeObjective,
} from './nightChargeAdvisor.js';
import {
  getLatestReadiness,
  setLatestReadiness,
  nightChargeGateFields,
  computeNightChargeReadiness,
  CURRENT_ALGO_VERSION,
} from './nightChargeGate.js';
import {
  resolveNightChargeMode,
  APPLY_MAX_RETRIES,
  coerceArmRefusalRecord,
  servedArmRefusal,
  eveningNotArmedReason,
  type ArmRefusalRecord,
  decideActuation,
  emptyActuationState,
  isReserveArbitrageRaised,
  setReserveArbitrageRaised, getReserveArbitrageRaised,
  clampReserveTarget,
  RESERVE_WRITE_MIN_PCT,
  RESERVE_WRITE_MAX_PCT,
  ownerReserveFloorPct,
  isRevertSettling,
  nightChargeSpokenNotice,
  setOwnerReserveFloorPct,
  APPLY_LEAD_MS,
  REVERT_ESCALATE_AFTER,
  REVERT_MAX_RETRIES,
  type NightActuationState,
  // The on-peak guard, the foreign rule, revertDeadline and heldByChargeWrite.
  decideRevertDeadline, revertDeadlineSpoken, restoreTargetPct, revertDeadlineMs, reserveRestoreNote,
  chargeWriteHold, setChargeWriteHold, FOREIGN_RESERVE_SETTLE_MS,
  attemptProvedUnlanded, applyProvedUnlanded, revertRetryPending, revertRetryText, REVERT_DEADLINE_HOLD_MAX_MS,
  revertResendOnReport, type RevertResendOnReport, isReserveSetting, restoreSummaryDue, type RestoreSummaryKind, restoreSentWords,
  type RevertDeadlineDecision,
} from './nightChargeActuator.js';
import { nextOnPeakStartMs, onPeakEndMs, nextChargeableOpenMs, legObjective, legForceChargeEligible, planDateOwningCycle, cheapNightOf, type ChargeLegRole } from './chargeWindows.js';
// R4 — the winter mid-day cycle computed in SHADOW: sized, probed and recorded, never armed,
// written or announced (middayShadow.ts).
// R5 (v1.189.0) — the day-aware words of a charge cycle (chargeText.ts) and their route by the leg's
// window (chargeAnnounce.ts): the overnight words are unchanged; the mid-day ones are reached only
// by a super off-peak leg, which nothing arms before the mid-day switch.
import { isMiddayLeg, middaySummaryFromLeg, middayRevertDeadlineFromLeg } from './chargeAnnounce.js';
import {
  buildMiddayChargeSummary, buildMiddayRevertDeadline, middayRevertDeadlineSpoken, buildMiddayRefreshMessage, onPeakDayWords,
} from './chargeText.js';
// R5 — the live morning refresh of an armed mid-day cost leg (morningRefresh.ts): inert until the
// switch (liveRefreshDue finds no leg while nothing arms a super off-peak leg).
import {
  liveRefreshDue, refreshPastDeadline, refreshWeatherFresh, refreshAborted, liveRefreshOutcome, standingLiveRefresh, applyLiveRefresh,
  liveRefreshLedgerColumns, REFRESH_MAX_WEATHER_AGE_MS,
} from './morningRefresh.js';
import {
  runMiddayShadowEvening, shadowCycleConfig, shadowRefreshDue, standingRefresh, refreshFromSized, refreshSizing,
  liveOvernightWrote, notComparableRefresh,
  middayShadowLedgerColumns, middayShadowRefreshLedgerColumns, middayShadowLogLines, middayShadowRefreshLogLine,
  coerceMiddayShadowRecord, getMiddayShadow, setMiddayShadow, middayChargeStateFields, shadowServed, windowP50Kwh, MIDDAY_SHADOW_LOG_TAG,
  middayShadowPreview, middayShadowPreviewLogLines, middayShadowRefreshPreviewLogLine, weatherAgeSeconds,
  costLegSizing, REFRESH_DEADLINE_MS,
  type MiddayShadowRecord, type ShadowLegSizing, type ShadowSized, type ShadowArmCandidate, type ShadowArmVerdict,
} from './middayShadow.js';
import { pvSurplusFromBand, surplusSpanEndMs } from './chargeTaper.js';
import {
  buildNightChargeMessage, sendNotification, loadNotifyConfig,
  // v1.187.22 — the after-the-fact night-charge pushes, built where their text is tested.
  buildNightChargeMorningSummary, buildNightChargeApplyFailure, buildNightForceChargeOnFailure,
  buildNightChargeRevertDeadline, buildNightChargeForeignReserve, buildNightChargeMissedApply,
} from './notify.js';
// v1.189.0 — the charge cycle: the legs one evening arms (chargeCycle.ts).
import {
  coerceCycle, serializeCycle, emptyCycle, asChargeLeg, legRoleOf, armCycle, promoteCycle, cancelLeg, parseCancelLeg,
  cycleLegsStatus, cycleDriftLeg, missedApplyDue, missedApplyReason, legLedgerFields, supersededLegs, trailingResolved,
  departedAfterStep, forceChargeDriftLeg, type DepartedLeg,
  nextForceChargeOpenMs, withLiveTrailing, MISSED_APPLY_FALLBACK_REASON,
  type ChargeCycleState, type ChargeLegState,
} from './chargeCycle.js';
import { parsePersistedIslandedLoad, eveningBasisDefers } from './nightChargeAdvisor.js';
// v1.191.0 (S6) — the night-charge schedule of the tariff in effect (the APS constants on the preset).
import { nightScheduleOf, nightScheduleLogLine, nightScheduleRepairIssues, fmtMinuteOfDay, type NightSchedule } from './nightSchedule.js';
import { tariffModelFromEnv, legacyTariffFromEnv, resolveTariffFromEnv, rateOptionsHint, tariffRepairIssues, rateAt, localParts, seasonAt, cheapPeriodIdOf, APS_PERIOD } from './tariff.js';
import { tariffCurrency } from './money.js';
// v1.187.0 — the scorer's span, cost and PV-evidence decisions, pure (nightLedgerScoring.ts).
import {
  supersedingPlanDate, knownFleetMismatchReason, type TimeSpan,
  // R4 — a two-leg row's spans and cheap periods, and the shadow's measured window.
  cycleLedgerSpans, ledgerCheapPeriodIds, minOverSpans, shadowWindowActuals,
  integrateWh, coverageFrac, ledgerSpansForWindow, assembleNightLedgerColumns, windowlessLedgerColumns,
  unpricedTariffPeriods, houseConnectedSlots, deliveredLedgerFields,
  // v1.187.22 — the measured window-open SoC and the expected-buy score clause.
  measuredWindowOpenSocPct, expectedBuyScoreNote, WINDOW_OPEN_SOC_LEAD_MS,
  // v1.187.10 — the forecast span: capture waits for issue + 24 h; the one-time repair.
  ledgerRowsDueForCapture, forecastActualsSpan, forecastSpanRepair, forecastSpanTagNote,
  forecastSpanRecaptureHorizonMs, forecastSpanResetColumns,
  // v1.188.1 — held telemetry: a row on held readings is not scored; one captured on them is repaired.
  heldLedgerVerdict, heldLedgerNote, heldLedgerRepair, heldRepairColumns, heldRepairClause, heldSides, basisIncompleteNote,
} from './nightLedgerScoring.js';
import { atomicWriteFileSync } from './atomicWrite.js';
import { readFileSync } from 'node:fs';
import type { NightLedgerRow } from './recorder.js';
import { panelFastifyOptions } from './logHooks.js';
import { createBackupWindow, registerBackupWindowRoutes, resolveBackupJournalPath } from './backupWindow.js';

// REST polling cadence. MQTT now delivers per-cmdId fresh data, but we keep a
// 60s REST poll as a baseline for fields that MQTT doesn't emit and as recovery
// after broker disconnects.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

// v0.15.18 — log diet. Per-request logging was 78 % of journald volume
// (~31k lines / 50 h: 'incoming request' + 'request completed' for every
// dashboard/HACS-card poll), drowning the lines that matter. Request logging
// is off; an onResponse hook below logs server errors (≥500) at warn, client
// 4xx at debug, slow >1s at info. The pino logMethod hook drops fastify's INFO 'stream closed
// prematurely' (media players aborting WAV range-requests — 3-4 per
// successful broadcast, fastify/lib/reply.js, benign by definition).
// v1.187.10 — the options live in logHooks.ts (panelFastifyOptions): request logging is turned off
// through a LogController, not the top-level option Fastify 5.12 deprecates (FSTDEP023).
const app = Fastify(panelFastifyOptions(config.logLevel));
app.addHook('onResponse', (req, reply, done) => {
  const ms = Math.round((reply as { elapsedTime?: number }).elapsedTime ?? 0);
  if (reply.statusCode >= 500) {
    req.log.warn({ url: req.url, statusCode: reply.statusCode, ms }, 'request error');
  } else if (reply.statusCode >= 400) {
    req.log.debug({ url: req.url, statusCode: reply.statusCode, ms }, 'request rejected');
  } else if (ms > 1000) {
    req.log.info({ url: req.url, statusCode: reply.statusCode, ms }, 'slow request');
  }
  done();
});
// v0.9.7 — defense in depth: accept empty-body POSTs even when the client
// (wrongly) sets Content-Type: application/json. Without this Fastify
// rejects with FST_ERR_CTP_EMPTY_JSON_BODY — which broke the first
// build of the reboot button. The right client fix is to omit the header
// for bodiless POSTs (already done in RebootButton.tsx), but treating an
// empty JSON body as `{}` is a safer default for every future POST.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const s = (body as string).trim();
  if (s === '') return done(null, {});
  try {
    done(null, JSON.parse(s));
  } catch (e) {
    done(e as Error, undefined);
  }
});
// v0.15.23 — Alert Console chime upload. Accept the raw WAV bytes as the request
// body (no @fastify/multipart dependency — keeps the add-on offline-lean). The
// per-parser bodyLimit caps memory; chimeStore re-validates + normalizes. The
// display filename rides in the ?name= query string, NEVER in a path. A
// dedicated content type keeps this parser off the JSON path entirely.
app.addContentTypeParser(
  ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'application/octet-stream'],
  { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
  (_req, body, done) => done(null, body),
);
/* ─── v0.9.62 — defense-in-depth security hardening ──────────────────
 *
 * the operator's add-on lives on a trusted LAN behind HA Ingress, so today no
 * one is going to drive-by-attack it. But a defense-in-depth audit
 * surfaced three risks worth closing:
 *
 *   1. CORS was `origin: true` (echoes any Origin), which means any
 *      malicious page on the LAN could fire `fetch('http://.../api/...',
 *      { credentials: 'include' })` and read the panel's state — or
 *      worse, fire writes. We replace it with an explicit allow-list of
 *      same-origin + HA dashboard origins + LAN HA host patterns.
 *   2. Write endpoints were unauthenticated. We add a write-token +
 *      same-origin + HA-ingress allowlist (`requireWriteAuth`). The
 *      token is auto-generated on first start and stored mode-0600 at
 *      `/data/panel-write-token.txt`, so the operator (the operator) can read
 *      it once and embed it in cross-origin scripts.
 *   3. Admin / Supervisor-facing GETs (audit log, addon listing,
 *      media-player discovery) were unauthenticated. We layer the same
 *      `requireWriteAuth` hook on them.
 *
 * NORMAL OPERATION IS UNCHANGED:
 *   - The React dashboard at port 8787 is same-origin → passes.
 *   - HA Ingress requests carry `X-Ingress-Path` → passes.
 *   - Lovelace cards do read-only GETs to /api/snapshot etc. → not gated.
 *   - `/api/alerts/outcome` is intentionally left open (user-feedback).
 */

/**
 * v0.9.60 — Write-auth gate (extracted to ./auth.ts for unit-testability).
 *
 * `createAuth` builds the same-origin allow-list, runs the token-bootstrap
 * I/O, and returns the Fastify preHandler used by every gated route.
 * Behavior identical to the pre-extract inlined block; see auth.ts for
 * the full per-condition rationale.
 */
const auth = createAuth({
  host: config.host,
  port: config.port,
  log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
});
const WRITE_TOKEN_PATH = auth.tokenPath;
const requireWriteAuth = auth.requireWriteAuth;

/**
 * v0.16.1 — minimal in-process fixed-window rate limiter (no dependency).
 * Applied AFTER requireWriteAuth on the filesystem-touching write endpoints
 * (chime upload/delete/config). These are operator-only (ingress/same-origin)
 * and already bounded by chimeStore's 2 MB / 20-file caps, but a fixed cap also
 * bounds CPU (WAV normalization) and disk churn if a compromised same-origin
 * session floods them — and addresses CodeQL js/missing-rate-limiting. Shared
 * bucket across the chime write routes; 30 writes/minute is ample for a human.
 */
function makeRateLimiter(maxPerWindow: number, windowMs: number) {
  let windowStart = 0;
  let count = 0;
  return (
    _req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    done: (err?: Error) => void,
  ): void => {
    const now = Date.now();
    if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
    count += 1;
    if (count > maxPerWindow) {
      reply.code(429).send({ ok: false, error: 'rate limited — too many writes, slow down' });
      return; // reply sent; do NOT call done() (request is handled)
    }
    done();
  };
}
const chimeWriteRateLimit = makeRateLimiter(30, 60_000);
// v1.110.0 — CodeQL js/missing-rate-limiting sweep. Same rationale as the
// chime limiters: operator-only surfaces, but a fixed cap bounds CPU/disk if a
// compromised same-origin session floods them.
//  - export-ha replays the whole vendor ledger into HA statistics (WS writes):
//    a handful an hour is ample for a manual re-export.
//  - the defective-pack latch endpoints touch a sidecar file; reads are cheap
//    but unbounded reads are still CodeQL-visible I/O.
const exportHaRateLimit = makeRateLimiter(6, 60 * 60_000);
// (shared by GET /api/db-export status — same cheap-statSync class of read)
const latchReadRateLimit = makeRateLimiter(60, 60_000);
const latchWriteRateLimit = makeRateLimiter(10, 60 * 60_000);
// v1.107.0 — a full VACUUM INTO is real disk I/O; a handful an hour is ample
// for a human pointing a viewer at the snapshot.
const dbExportRateLimit = makeRateLimiter(6, 60 * 60_000);

await app.register(cors, {
  // Callback form: same-origin requests (no Origin header) get echoed
  // through unchanged; cross-origin requests are accepted only if the
  // Origin matches our allowlist. Anything else gets NO
  // Access-Control-Allow-Origin header, so the browser blocks the
  // response from JS.
  origin: auth.corsOriginCallback,
});
// v0.9.14 — permessage-deflate on WebSocket frames. SnapshotStore pushes
// the full snapshot on every change (~50-150 KB raw JSON for a 13-device
// fleet); with PMD enabled, that compresses to ~10-30 KB per frame. Saves
// real bandwidth over HA Ingress + on mobile, especially when MQTT chatter
// triggers frequent change events. Threshold filters out tiny frames where
// the deflate framing overhead would dominate.
await app.register(websocket, {
  options: {
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 6 },
    },
    // v0.68.0 — bound inbound ws frames. The /ws snapshot socket and the
    // /console/ws terminal only ever receive tiny client frames (keystrokes,
    // a small resize JSON; /ws receives nothing), so 64 KiB is generous while
    // capping a malicious/runaway client's per-frame memory.
    maxPayload: 64 * 1024,
  },
});
// v0.9.14 — gzip/brotli on every response over 1 kB. JSON payloads (snapshot,
// ha-state, history) typically compress 70-85%; the savings show up most over
// HA Ingress and on mobile. `global: true` covers static assets too; the
// threshold filters out small responses where the framing cost would dominate.
await app.register(compress, {
  global: true,
  encodings: ['br', 'gzip'],
  threshold: 1024,
});

// `cached` (ETag + private Cache-Control, 304 on a match; v0.9.14/v0.9.27) lives in cachedReply.ts.

// Serve the built web UI at `/`, with SPA fallback. Present in production
// (Home Assistant add-on, `npm run build` output); absent in dev, where Vite
// is the front-end server and proxies /api and /ws back to this process.
const webDist =
  process.env.WEB_DIST_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  // Asset prefixes served by fastify-static plugins below. A GET that misses a
  // real file under one of these must hard-404 — falling through to the SPA
  // catch-all would return index.html (HTML 200) for a missing tone, masking a
  // broken assignment as a silent success in the Alert Console preview.
  const ASSET_404_PREFIXES = ['/chimes/', '/audio-render/', '/audio/'];
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method !== 'GET' ||
      req.url.startsWith('/api/') ||
      req.url.startsWith('/ws') ||
      ASSET_404_PREFIXES.some((p) => req.url.startsWith(p))
    ) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });
  app.log.info(`web: serving built UI from ${webDist}`);
} else {
  app.log.info(`web: no built bundle at ${webDist} (dev mode — Vite at :5173)`);
}

// v0.9.18 — synthesise the alert klaxon WAVs at startup and serve them
// at /audio/*. HomePod / Sonos stream these URLs when we broadcast
// condition transitions through Music Assistant.
const audioDir = resolve(process.env.DATA_DIR ?? '/data', 'audio');
await generateAudioAssets(audioDir, (m) => app.log.info(m));
await app.register(fastifyStatic, {
  root: audioDir,
  prefix: '/audio/',
  decorateReply: false,
  wildcard: false,
});

// v0.9.70 — combined klaxon + TTS announcements are rendered on demand
// into a separate cache dir. Served at /audio-render/* so the WAVs the
// renderer creates are distinct from the per-level klaxon files (which
// the renderer reads as inputs).
//
// v0.9.71 — fastify-static refuses to register the route when `root`
// doesn't exist at registration time. mkdirSync up-front so the route
// is always wired even before the first render writes anything.
//
// v0.9.73 — wildcard MUST be true here (unlike /audio/* above).
// fastify-static's wildcard:false mode ENUMERATES files at registration
// time and registers an explicit route per file. New files written at
// runtime aren't visible. That's fine for /audio/ (klaxons generated at
// startup, set in stone after), but FATAL for /audio-render/ where the
// whole point is rendering files on demand. v0.9.70-v0.9.72 all 404'd
// every newly-rendered announcement — the only files that served were
// ones that happened to already exist on disk before startup. Yellow
// "worked" only because it was rendered under v0.9.70 and survived to
// v0.9.71 startup, when wildcard:false enumerated it. Red rendered
// fresh under v0.9.72 was invisible. wildcard:true does on-demand path
// resolution per request — the correct mode for a dynamic cache dir.
const audioRenderDir = resolve(process.env.DATA_DIR ?? '/data', 'audio-render');
const { mkdirSync } = await import('node:fs');
mkdirSync(audioRenderDir, { recursive: true });
await app.register(fastifyStatic, {
  root: audioRenderDir,
  prefix: '/audio-render/',
  decorateReply: false,
  wildcard: true,
});

// v0.15.23 — Alert Console: serve operator-uploaded chime tones for IN-BROWSER
// preview at /chimes/<id>.wav. Same shape as /audio-render/: decorateReply
// FALSE (only the first static register may own reply.sendFile) and wildcard
// TRUE (tones are written at runtime; wildcard:false enumerates at registration
// and 404s new files until restart — the exact /audio-render pitfall above).
// mkdirSync up-front so fastify-static registers even before the first upload.
mkdirSync(CHIMES_DIR, { recursive: true });
await app.register(fastifyStatic, {
  root: CHIMES_DIR,
  prefix: '/chimes/',
  decorateReply: false,
  wildcard: true,
});

const store = new SnapshotStore();
// v1.180.0 — the resolver's declared-grid veto survives a restart made while the cloud is
// unreachable (no /device/list, so no panel device to carry the persisted reading).
setPersistedGridAbsentSource(() => store.persistedGridAbsent());
/** v0.36.0 — snapshot the dashboard/TUI consume, augmented with the live grid backstop. */
function snapshotForClient(): FleetSnapshot {
  const s = store.get();
  const grid = liveGridBackstop(s.devices);
  const off_grid = !grid.present;
  // Attach the grid backstop onto the SHP2 device too, so device-scoped
  // consumers (Shp2Card) get it directly off `devices[shp2sn]`. IMMUTABLE:
  // shallow-copy the devices map + the one SHP2 device so we never mutate the
  // objects inside store.get() (the HA-state + /api/broadcast/status consumers
  // read raw store.get() and must stay byte-identical).
  const shp2 = findShp2(s.devices);
  // v0.40.1 — annotate each SHP2 source slot with `dpuStale` (the slot is counted
  // by the SHP2 but its underlying DPU is itself cloud-offline). OBSERVABILITY ONLY:
  // does NOT touch backup-pool capacity (SHP2-aggregate, stays authoritative) or the
  // floor alarm. Immutable, so the raw store the HA-state/broadcast paths read is
  // untouched. The TUI computes the same flag inline via isSourceDpuStale.
  // v1.188.1 — panelForClient: and `dpuFrozen` (the Core listed online on a frozen meter) on each
  // slot, and the panel's own `readbackFresh` verdict; the Energy flow card keys on all three.
  // v1.188.1 (review) — and the energy bridge's verdicts on each slot (`ownReading`, `pvMeasuredW`), from
  // the computation the two power sensors publish, so the card counts each Core as they do.
  const nowMs = Date.now();
  const agg = aggregateFleetFlow(s.devices);
  const verdicts = slotVerdicts(recorder.bridgedFleetFlow({ fleetPv: agg.fleetPv, fleetBatteryNet: agg.fleetBatteryNetDisplay }, s.devices, nowMs));
  const shp2Enriched =
    shp2 && shp2.projection?.kind === 'shp2'
      ? { ...panelForClient(shp2, s.devices, nowMs, verdicts), grid, off_grid }
      : shp2
        ? { ...shp2, grid, off_grid }
        : undefined;
  const devices: typeof s.devices = shp2Enriched ? { ...s.devices, [shp2!.sn]: shp2Enriched } : { ...s.devices };
  // v1.185.0 — every other panel's source slots get the same observability flag.
  for (const p of secondaryShp2s(s.devices)) devices[p.sn] = panelForClient(p, s.devices, nowMs, verdicts);
  // v1.185.0 — which panel is the house panel, and whether one must be pinned (the dashboard's
  // prompt reads this).
  return { ...s, devices, grid, off_grid, housePanel: store.housePanelState() };
}
/** v1.69.0 — process start, for the telemetry-blind boot grace. */
const PROCESS_BOOT_MS = Date.now();
// v1.69.0 — surface an adopted clock correction. A silent correction would hide the
// very fault it compensates for: the operator would never learn the Pi's clock is
// wrong, and would not know to fix NTP. Signing self-heals; the host still needs care.
// v1.120.0 — this registration used to sit INSIDE the setClockOffsetLogger callback body
// (one line, zero-indented, easy to miss), so the reject logger was only installed AFTER a
// first offset ADOPTION. Adoptions are rare by design, so in practice onClockSampleRejected
// stayed null for the whole process lifetime and every RTT-gate rejection was invisible —
// which is the exact ambiguity v1.86.0 shipped to remove: "gate never needed" and "gate
// silently rejecting" looked identical in production. It must be registered at module scope.
setClockRejectLogger((reason) => app.log.debug(`ecoflow: clock sample rejected (${reason}) — latency, not skew; offset unchanged`));

setClockOffsetLogger((offsetMs, previousMs) => {
  const s = (offsetMs / 1000).toFixed(1);
  app.log.warn(
    `ecoflow: adopted a ${s}s clock correction for request signing (was ${(previousMs / 1000).toFixed(1)}s). `
    + `The HOST clock is wrong by about that much — signing is now self-corrected, but fix NTP on the Pi: `
    + `after a power cut it boots with no RTC and cannot sync until DNS is up.`,
  );
});

// v1.154.0 — the last-known roster is published BEFORE createRecorder. It used to be
// published further down this file, so the recorder's boot-time restart probe resolved
// benchSpareSns() against the stale SPARE_DPU_SNS literal and dropped Core 5, a wired home
// Core, from the fleet anchor. Everything this block uses is an import.
const MEMBERSHIP_HISTORY_PATH = resolve(process.cwd(), config.dbPath, '..', 'membership-history.json');

// v1.117.0 — LAST-KNOWN SHP2 ROSTER. The connected-source roster is durable
// state, but it is re-derived from the live SHP2 projection every tick, so it
// reads EMPTY for the first tick after a boot (projection not yet hydrated) and
// for any SHP2 cloud-blind window. Membership consumers then fell through to the
// static SPARE_DPU_SNS literal, which has been stale since the 08-20 swap — and
// on 2026-08-29 that admitted the off-panel Core 3 into the pool mean, whose
// phantom 75% re-armed the SoC ladder and replayed a 30% rung to the speakers on
// both deploys. Seed from the persisted membership fingerprint (a sorted,
// comma-joined SN list) so the roster is known from the very first tick, and
// refresh it whenever the live roster is non-empty.
let lastKnownRoster: Set<string> = (() => {
  try {
    const h = loadMembershipHistory(MEMBERSHIP_HISTORY_PATH);
    const fp = h.entries.length ? h.entries[h.entries.length - 1].fp : '';
    return new Set(fp ? fp.split(',').filter(Boolean) : []);
  } catch {
    return new Set<string>();
  }
})();
// Seed the shared publisher from the persisted fingerprint so the roster is known
// from the very first tick, before any live projection has hydrated.
setLastKnownHomeRoster(lastKnownRoster);
export function noteLiveRoster(roster: ReadonlySet<string>): void {
  if (roster.size > 0) lastKnownRoster = new Set(roster);
  // v1.121.0 — publish it to the membership module so the OTHER consumers of the
  // bench-spare floor (the offline-spare mute and homeCoreCoverage's SHP2-blind
  // fallback; v1.191.0: BENCH_SPARE_SNS when set, else the stale SPARE_DPU_SNS
  // literal) share the same durable answer isHomePoolDpu already had.
  setLastKnownHomeRoster(lastKnownRoster);
  // v1.191.0 (S8, CA17) — and to the analytics worker, which has its own copy of the module.
  analytics.pushHomeRoster?.([...lastKnownRoster]);
}

// v1.154.0 — timed from OUTSIDE as well as inside. v1.152.0's per-phase line was emitted
// before a 5.8 s seed and so covered about 63% of the call. If this number and the recorder's
// own `total` disagree, part of createRecorder is outside its instrumentation again.
const recorderCallT0 = performance.now();
const recorder = createRecorder(store, (m) => app.log.info(m), (m) => app.log.debug(m));
app.log.info(`recorder: createRecorder returned after ${Math.round(performance.now() - recorderCallT0)}ms`);
// v1.187.20 — the Home Assistant backup hooks (config.yaml backup_pre / backup_post) hold the
// recorder connection's WAL checkpoints still while the Supervisor copies /data, so no checkpoint
// rewrites ecoflow.db under the copy. Loopback-only routes; see backupWindow.ts.
const backupWindow = createBackupWindow({
  wal: recorder.walControl,
  journalPath: resolveBackupJournalPath({ dataDir: dirname(resolve(process.cwd(), config.dbPath)) }),
  log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
});
registerBackupWindowRoutes(app, backupWindow);
// v0.10.0 — analytics worker. Every heavy history scan (the cache-warmer's
// reports + each /api/* analytics endpoint) runs on the worker's event loop
// against a read-only connection to the same WAL DB. The main thread keeps
// the sole write connection (ingestion + lifetime rollup) and never blocks on
// a multi-second SQLite scan again — which is what was intermittently
// starving the HTTP port and tripping the Supervisor watchdog. The worker
// self-warms its report caches, so the old main-thread cache-warmer is gone.
const analytics = initAnalyticsClient(resolve(process.cwd(), config.dbPath), (m) => app.log.info(m));
store.on('change', (snap) => analytics.pushSnapshot(snap));
// v1.191.0 (S8, CA17) — the seeded last-known roster, so the worker's spare floor honours it from boot.
analytics.pushHomeRoster?.([...lastKnownRoster]);
// v1.191.0 (S8) — name where the device topology comes from, once at boot (the feature, not the
// version string): the bench-spare floor (BENCH_SPARE_SNS, or the built-in list) and the alias layers.
{
  const spares = configuredBenchSpareSns();
  const al = deviceAliases();
  const bySource = (src: string) => Object.values(al.sourceBySn).filter((x) => x === src).length;
  app.log.info(
    `devices: bench-spare floor ${spares == null ? 'the built-in list (BENCH_SPARE_SNS unset)' : `BENCH_SPARE_SNS (${spares.size} serial${spares.size === 1 ? '' : 's'})`}; `
    + `display aliases: image ${bySource('image')}, data ${bySource('data')}, option ${bySource('option')}`
    + (al.errors.length ? ` — ignored as unreadable: ${al.errors.map((e) => e.source).join(', ')}` : ''),
  );
}
// v1.186.0 — the first poll settled: the worker gets the hydrated map before the alert monitor's
// first reports (registered before startAlertMonitor, and a report posts in a later microtask).
store.on('hydrated', () => analytics.flushSnapshot());

app.get('/api/snapshot', async () => snapshotForClient());
// v1.69.0 — /api/health used to return a hardcoded `ok: true`. On 2026-08-04 the
// add-on ran 22 minutes with an EMPTY device map and zero telemetry while this
// endpoint reported ok:true / vitalsLevel:"ok". A health endpoint that cannot say
// "unhealthy" is not a health endpoint; it is decoration, and it actively hid the
// outage from the HA watchdog and from the operator. It now reflects whether the
// add-on can actually SEE anything.
app.get('/api/health', async (_req, reply) => {
  const blind = assessBlind({
    nowMs: Date.now(),
    bootMs: PROCESS_BOOT_MS,
    projectedDeviceCount: Object.values(store.get().devices)
      .filter((d: any) => d?.projection?.kind === 'dpu' || d?.projection?.kind === 'shp2').length,
    ...pollState(),
    lastHealAtMs: null,
  });
  if (blind.blind) reply.code(503); // so the HA watchdog and any uptime probe SEE it
  return {
    ok: !blind.blind,
    blind: blind.blind,
    blindReason: blind.reason,
    blindForMs: blind.blindForMs,
    // v1.187.10 — null while no failure is current (it read 'other' on a healthy add-on).
    pollErrorKind: healthPollErrorKind(blind, pollState()),
    // v1.144.0 — `telemetryBlind`'s own docstring frames the whole feature around
    // /api/health having reported healthy while the add-on held zero telemetry,
    // and says guard 1 "makes /api/health honest". v1.140.0 computed the poll
    // verdict and published it to MQTT but never added it here — and this is the
    // surface a watchdog polls. During a panel-dark window SHORTER than the 5-min
    // staleness threshold, which is the shape of every such window in the record,
    // `blind` is still false and this endpoint returns a clean bill of health.
    pollHealth: pollHealth(),
    // v1.144.0 — and whether the cloud is replaying a body at us (v1.142.0).
    // v1.148.0 — via findShp2(), not a raw find(). v1.129.0 pinned that helper to
    // the lowest SN precisely so every singleton path is consistently wrong in the
    // same way rather than each picking a different panel. With a second SHP2 the
    // raw find could report a different panel from the one the alarm path reads.
    shp2ContentFrozenMs: (() => {
      const p2 = findShp2(store.get().devices) as { contentStaleSinceMs?: number | null } | undefined;
      return p2?.contentStaleSinceMs != null ? Date.now() - p2.contentStaleSinceMs : 0;
    })(),
    vitalsLevel: currentAssessment()?.level ?? null,
    heartbeat: heartbeatStatus(),
    generatedAt: store.get().generatedAt,
  };
});

/**
 * v0.9.74 — unauth version stamp. Quick debug surface to confirm which
 * release a panel is running without having to crack open `/api/snapshot`
 * or read the addon log. Returns the `BUILD_VERSION` env var set by
 * `images.yml` at build time (e.g. "0.9.74"), falling back to "dev" when
 * running outside the Docker image.
 */
app.get('/api/version', async () => ({
  version: process.env.BUILD_VERSION || 'dev',
  builtAt: process.env.BUILD_DATE || null,
  ref: process.env.BUILD_REF || null,
}));

/**
 * v0.9.62 — unauth surface so a (future) UI consumer can detect that
 * writes need an X-Panel-Write-Token (or HA ingress / same-origin) and
 * surface the right hint to the user instead of just hitting a blind
 * 401. Current dashboard doesn't need this (it's same-origin), but
 * external callers (a future companion app, a curl-from-laptop user)
 * will.
 */
app.get('/api/panel-info', async () => ({
  writeAuthRequired: true,
  sameOriginOk: true,
  ingressOk: true,
  tokenHeader: 'X-Panel-Write-Token',
  tokenPath: WRITE_TOKEN_PATH,
}));

// v1.191.0 — the site facts the cards read from the server (plan 2.7; site.ts). A stub in S2: the
// zone and its source, the coordinates, the currency, the PV strings and the per-DPU bench-spare flag
// are today's values, and each lane fills in its own field.
app.get('/api/site', async (req, reply) => cached(req, reply, siteResponse(store.get().devices, lastKnownRoster), 60));

app.get<{ Querystring: { sn?: string; metric?: string; since?: string; until?: string; bucket?: string } }>(
  '/api/history',
  async (req, reply) => {
    const { sn, metric, since, until, bucket } = req.query;
    if (!sn || !metric) {
      reply.code(400);
      return { error: 'sn and metric required' };
    }
    const sinceMs = since ? Number(since) : Date.now() - 60 * 60 * 1000;
    const untilMs = until ? Number(until) : Date.now();
    const bucketSec = bucket ? Number(bucket) : undefined;
    const points = await analytics.query(sn, metric, sinceMs, untilMs, bucketSec);
    // v0.9.14 — short Cache-Control + ETag so repeat fetches from the same
    // dashboard tab return 304. History rows are append-only; 15s of staleness
    // on the trailing edge is fine for chart UX.
    return cached(req, reply, { sn, metric, sinceMs, untilMs, bucketSec, points }, 15);
  },
);

app.get<{ Querystring: { since?: string; until?: string } }>('/api/summary/today', async (req, reply) => {
  const since = req.query.since ? Number(req.query.since) : startOfLocalDayMs();
  const until = req.query.until ? Number(req.query.until) : Date.now();
  // v1.176.0 — `dayEndMs`: the local midnight that ENDS the day this payload covers, so the
  // Today card can tell a payload from a finished day without assuming a day is 24 h (a
  // daylight-saving fall-back day is 25). v1.191.0 (CA25) — the SITE midnight (siteTime.ts), as the
  // default `since` is (startOfLocalDayMs), not the host's.
  const dayEndMs = siteNextDayStartOf(since);
  // v1.190.2 — `bridged`: a home Core the energy bridge metered at its panel slot counts the energy
  // the bridge booked for it (the figures Home Assistant's Energy counters add), not its own absent
  // samples; `fleet.bridged` says how much of each figure that is.
  const totals = await analytics.report('totals', { sinceMs: since, untilMs: until, bridged: true });
  return cached(req, reply, { ...(totals as object), dayEndMs }, 30);
});

/**
 * Per-circuit daily kWh history for the CircuitModal's multi-day comparison.
 * Returns the last `days` (default 7, max 30) of trapezoidal kWh + peak watt +
 * peak timestamp + coverage, plus a summary block (avg, peak day, min day).
 *
 * v0.9.8 — accepts `?pair=N` as an alternative to `?ch=N`. When `pair` is set,
 * the response integrates the combined `pair${N}_w` series (both legs of a
 * split-phase circuit), so clicking on something like the Pool Pump shows the
 * full 240 V load instead of just one leg's ~half.
 */
app.get<{ Querystring: { sn?: string; ch?: string; pair?: string; days?: string } }>(
  '/api/circuit/history',
  async (req, reply) => {
    const { sn, ch, pair, days } = req.query;
    if (!sn || (!ch && !pair)) {
      reply.code(400);
      return { error: 'sn and (ch or pair) required' };
    }
    const raw = pair ?? ch!;
    const chNum = Number(raw);
    if (!Number.isInteger(chNum) || chNum < 1) {
      reply.code(400);
      return { error: 'ch/pair must be a positive integer' };
    }
    const daysNum = Math.max(1, Math.min(30, Number(days ?? 7) || 7));
    const metric = pair ? `pair${chNum}_w` : undefined;
    return await analytics.report('circuitHistory', { sn, ch: chNum, days: daysNum, metric });
  },
);

/** v1.82.0 — the stored vendor energy ledger (see energyHistory.ts). */
/**
 * v1.103.0 — "was pool membership stable across this site day?" for the
 * pack-DC RTE. A day that spans a reconfiguration measures its charge and
 * discharge legs over different batteries, so its ratio is meaningless; a day
 * predating the membership record is `unknown`, which we also refuse rather
 * than assume clean.
 */
function membershipStableOnDay(day: string): boolean {
  try {
    const h = loadMembershipHistory(MEMBERSHIP_HISTORY_PATH);
    const [y, m, d] = day.split('-').map(Number);
    if (!y || !m || !d) return false;
    // v1.191.0 (T8) — the site day [local midnight, next local midnight) (siteTime.ts); it was the
    // fixed UTC−7 [07:00Z, 07:00Z), identical in the default zone.
    const startMs = siteDayStartMs(day);
    return membershipVerdict(h, startMs, siteDayStartMs(addDaysYmd(day, 1))) === 'stable';
  } catch {
    return false;
  }
}

app.get<{ Querystring: { day?: string } }>('/api/energy-history', async (req, reply) => {
  const state = loadVendorEnergyState();
  if (req.query.day) {
    const rec = state.days[req.query.day];
    if (!rec) { reply.code(404); return { error: `no vendor record for ${req.query.day}` }; }
    return rec;
  }
  const days = Object.keys(state.days).sort();
  // v1.85.0 — advisory empirical RTE alongside the record (never buy-sizing).
  const rte = computeEmpiricalRte(Object.values(state.days));
  // v1.89.0 — pack-DC round-trip ratio (B2; DC basis, upper bound on dispatch RTE).
  const localPackRte = computeLocalPackRte(Object.values(state.days), membershipStableOnDay);
  return { lastRunDay: state.lastRunDay, empiricalRte: rte, localPackRte, days: days.map((d) => state.days[d]) };
});

/** v1.90.0 (B3) — the warranty evidence bundle: live per-pack + per-cell data
 *  plus this serial's persisted alert history, as paste-ready markdown
 *  (?format=csv for the per-cell grid). READ-ONLY. */
app.get<{ Querystring: { sn?: string; format?: string; packSn?: string } }>('/api/warranty-export', async (req, reply) => {
  // v1.191.0 (S8, X1) — with no ?sn=, the legacy default chassis while it is on this account's device
  // map (as before), else the chassis holding the one latched defective pack, else 400 with the last
  // four characters of each Core's serial (topology.ts warrantyChassis). OWNER DECISION 2 keeps the
  // default serial here for now; the alerts that point here carry ?sn= themselves.
  const sn = req.query.sn ?? 'Y711FAB59J234000';
  const pick = warrantyChassis(req.query.sn, sn, store.get().devices, listConfirmedRecords().map((r) => r.deviceSn));
  if ('error' in pick) { reply.code(400); return { error: pick.error, candidates: pick.candidates }; }
  const chassis = pick.sn;
  const d: any = (store.get().devices as any)[chassis];
  if (!d?.projection) { reply.code(404); return { error: `no projection for ${chassis}` }; }
  // v1.102.0 — `?packSn=` follows ONE pack's history across every chassis it has
  // lived in; omitted, the bundle covers this chassis and the packs it holds now.
  const bundle = buildWarrantyBundle(d, loadClearedRecords() as any, new Date().toISOString(), req.query.packSn);
  if (req.query.format === 'csv') {
    reply.type('text/csv').header('Content-Disposition', `attachment; filename="warranty-${chassis}-cells.csv"`);
    return renderWarrantyCsv(bundle);
  }
  if (req.query.format === 'json') return bundle;
  reply.type('text/markdown').header('Content-Disposition', `attachment; filename="warranty-${chassis}.md"`);
  return renderWarrantyMarkdown(bundle);
});

/** v1.90.0 (B10) — DISCOVERY probe: do -Month/-Year variants of the documented
 *  -Week history codes exist? Read-only; returns raw outcomes for the register.
 *  ?month=YYYY-MM (default: last month). */
app.get<{ Querystring: { month?: string } }>('/api/debug/vendor-history-probe', async (req, reply) => {
  const shp2 = findShp2(store.get().devices);
  if (!shp2) { reply.code(503); return { error: 'no SHP2' }; }
  // v1.191.0 (T15) — "last month" on the site calendar (the vendor reads device-local times, CA18).
  const m = req.query.month ?? siteYmd(Date.now() - 32 * 24 * 3_600_000).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) { reply.code(400); return { error: 'month=YYYY-MM' }; }
  const [y, mo] = m.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const win = { beginTime: `${m}-01 00:00:00`, endTime: `${m}-${String(lastDay).padStart(2, '0')} 23:59:59` };
  const bases = [
    'PD303-App-LOAD-LOAD-ENERGY-FLOW-chart_general_value_no_filt',
    'PD303-App-GRID-GRID-ENERGY-FLOW-chart_grid_value',
    'PD303-App-SOLAR-SOLAR-ENERGY-FLOW-chart_general_value_no_filt',
    'PD303-App-BATTERY-BATTERY-ENERGY-FLOW-chart_battery_value_dual',
    'PD303-Dashboard-Circuits-Line',
  ];
  const out: Record<string, unknown> = {};
  for (const base of bases) {
    for (const suffix of ['Month', 'Year']) {
      const code = `${base}-${suffix}`;
      try {
        const params: Record<string, unknown> = base.includes('Circuits')
          ? { code, field1: 'energy_hour_grid_ch1', field2: 'energy_hour_oil_ch1', field3: 'energy_hour_bak_ch1', ...win }
          : { code, ...win };
        const resp = await ecoflow.getQuotaData(shp2.sn, params);
        out[code] = { ok: true, sample: JSON.stringify(resp).slice(0, 400) };
      } catch (e: any) {
        out[code] = { ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return { month: m, window: win, results: out };
});

/** v1.89.0 (B1) — manual full re-export of the vendor ledger to HA statistics.
 *  v1.110.0 — write-auth + rate limit: this WRITES to HA's statistics store and
 *  had shipped un-gated (pre-dating the every-write-gated convention); the
 *  dashboard reaches it through ingress, which passes requireWriteAuth. */
app.post('/api/energy-history/export-ha', { preHandler: [requireWriteAuth, exportHaRateLimit] }, async () => {
  const state = loadVendorEnergyState();
  const exp = await exportVendorStatistics(Object.values(state.days), (m) => app.log.warn(m));
  return { exported: exp.exported, failed: exp.failed, days: Object.keys(state.days).length };
});

/** v1.85.0 — manual bounded backfill trigger (runs in the background). */
// v1.187.16 — write-gated like every other write route (it starts vendor fetches and writes the ledger).
app.post<{ Querystring: { days?: string } }>('/api/energy-history/backfill', { preHandler: requireWriteAuth }, async (req) => {
  const cap = Math.max(1, Math.min(30, Number(req.query.days ?? 10) || 10));
  void runVendorBackfill(cap).catch((e: any) => app.log.warn(`energy-history: manual backfill failed (${e?.message ?? e})`));
  return { started: true, cap };
});

/** v1.82.0 — live vendor fetch for one day, NOT stored (verification/debug). */
app.get<{ Querystring: { day?: string } }>('/api/debug/vendor-history', async (req, reply) => {
  const day = req.query.day;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) { reply.code(400); return { error: 'day=YYYY-MM-DD required' }; }
  const shp2 = findShp2(store.get().devices);
  if (!shp2) { reply.code(503); return { error: 'no SHP2 in the roster' }; }
  return await fetchVendorDay(shp2.sn, day, (m) => app.log.warn(m), 12);
});

app.get<{ Querystring: { sn?: string } }>('/api/debug/raw', async (req, reply) => {
  const sn = req.query.sn;
  if (!sn) {
    reply.code(400);
    return { error: 'sn required' };
  }
  return {
    sn,
    raw: store.getRaw(sn) ?? null,
    mqtt: store.getMqttByCmd(sn),
    mqttFlat: store.getMqttFlat(sn) ?? null,
    source: store.lastSourceBySn.get(sn) ?? null,
    lastMqttAt: store.lastMqttAtBySn.get(sn) ?? null,
    mqttMsgCount: store.mqttMsgCountBySn.get(sn) ?? 0,
  };
});

app.get('/api/debug/mqtt-summary', async () => {
  const list = Object.keys(store.get().devices);
  return list.map((sn) => ({
    sn,
    deviceName: store.get().devices[sn]?.deviceName,
    msgCount: store.mqttMsgCountBySn.get(sn) ?? 0,
    lastMqttAt: store.lastMqttAtBySn.get(sn) ?? null,
    cmdIds: Object.keys(store.getMqttByCmd(sn)).map(Number).sort((a, b) => a - b),
  }));
});

app.get<{ Querystring: { sn?: string } }>('/api/metrics', async (req, reply) => {
  const sn = req.query.sn;
  if (!sn) {
    reply.code(400);
    return { error: 'sn required' };
  }
  return { sn, metrics: await analytics.listMetrics(sn) };
});

// v0.9.14 — these endpoints all sit downstream of cache-warmer-hot computes,
// so the function call returns instantly. Adding HTTP-level caching (ETag +
// short max-age) saves the JSON-serialization + network cost on repeat fetches
// from the same browser tab.
app.get('/api/forecast', async (req, reply) =>
  cached(req, reply, await analytics.report('forecast'), 60),
);

app.get('/api/degradation', async (req, reply) =>
  cached(req, reply, await analytics.report('degradation'), 60),
);

// v1.52.0 — the runway report is an ISLANDED projection ("if the grid vanished
// now"). The surfaces that consume it must be able to say so, and must be able
// to tell that the pool is ALREADY at/under the reserve floor: the crossing
// detector only arms while `stateKwh > reserveKwh`, so on a below-floor pool
// `hoursToReserve` is the *next* crossing after a modelled solar recharge — a
// true number that reads as false ("11.2 h until the floor" while under it).
// The report itself stays pure; the grid context is attached here, at the edge,
// from the same live backstop resolver the floor alarm uses.
app.get('/api/runway', async (req, reply) => {
  const report = await analytics.report<Record<string, unknown>>('runway');
  const grid = liveGridBackstop(store.get().devices);
  const remaining = report?.backupRemainingKwh;
  const reserve = report?.backupReserveKwh;
  const belowReserveFloor =
    typeof remaining === 'number' && typeof reserve === 'number' && reserve > 0
      ? remaining <= reserve
      : null; // null = undeterminable, never a fabricated false
  return cached(req, reply, { ...report, belowReserveFloor, grid }, 30);
});

app.get<{ Querystring: { days?: string } }>('/api/round-trip-efficiency', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('roundTripEfficiency', { days }), 60);
});

app.get('/api/clipping', async (req, reply) =>
  cached(req, reply, await analytics.report('clipping'), 60),
);

// v0.9.77 — SoC-saturation curtailment (distinct from inverter clipping).
// Surfaces "PV being rejected at the panels because batteries are full".
// The engine handles its own 1-min cache; this Fastify wrapper adds the
// standard hash-etag + 60s Cache-Control treatment used by every other
// analytics endpoint, so dashboards re-poll without re-shipping bytes.
app.get('/api/curtailment', async (req, reply) =>
  cached(req, reply, await analytics.report('curtailment'), 60),
);

// v0.7.6 — lifetime energy counters for HA Energy Dashboard.
// Each entry: { persistedWh, pendingWh, watermarkMs } — live total = persistedWh + pendingWh.
// HA expects monotonically-increasing kWh with state_class=total_increasing.
// v0.9.14 — 15 s cache: lifetime counters are recorded server-side every poll;
// 15 s of staleness avoids re-running the JSON build on every HA poll cycle.
app.get('/api/lifetime-energy', async (req, reply) => {
  const totals = recorder.getLifetimeTotals();
  const toKwh = (wh: number) => Math.round((wh / 1000) * 1000) / 1000;
  const live = (k: keyof typeof totals) =>
    toKwh(totals[k].persistedWh + totals[k].pendingWh);
  return cached(req, reply, {
    generated_at: Date.now(),
    pv_lifetime_kwh: live('fleet_pv_wh'),
    load_lifetime_kwh: live('fleet_load_wh'),
    grid_import_lifetime_kwh: live('fleet_grid_import_wh'),
    // v0.34.0 — total whole-home grid import metered at the SHP2 main. The
    // grid_import figure above counts only grid that charged the DPUs; this is the
    // authoritative total (accumulates from deploy — there is no historical back-fill).
    grid_to_home_lifetime_kwh: live('fleet_grid_home_wh'),
    battery_charge_lifetime_kwh: live('fleet_battery_charge_wh'),
    battery_discharge_lifetime_kwh: live('fleet_battery_discharge_wh'),
    // v0.56.0 — DISPLAY-ONLY annotation (does NOT touch the total_increasing counters). The coulomb
    // baseline was captured mid-life, so over a window ending below baseline SoC cumulative discharge
    // legitimately EXCEEDS charge (energy stored before the baseline counts on the way out but was
    // never counted as charge in-window). This is NOT an RTE>100% energy-conservation violation —
    // the user-facing round-trip efficiency is computed separately and clamped ≤100%. Positive =
    // discharge ahead of charge; shrinks toward zero as the pool returns to its baseline SoC.
    // See /api/debug/battery-lifetime.deficitWh.
    battery_baseline_deficit_kwh:
      Math.round((live('fleet_battery_discharge_wh') - live('fleet_battery_charge_wh')) * 1000) / 1000,
    details: totals,
  }, 15);
});

// v0.45.0 — read-only diagnostics for the lifetime battery counters. Surfaces
// the unclamped charge/discharge floors, the emitted totals (persisted+pending
// split), the informational deficit the removed discharge≤charge clamp would
// have shaved, the per-pack filter/held breakdown, and which SHP2 members are
// being carried while offline. STRICTLY READ-ONLY (zero writes / zero mutation
// of the emitted counters) — see recorder.batteryLifetimeDebug.
app.get('/api/debug/battery-lifetime', async (req, reply) => {
  return cached(req, reply, {
    generated_at: Date.now(),
    ...recorder.batteryLifetimeDebug(),
  }, 15);
});

// v0.54.1 — read-only soiling diagnostics. Surfaces computeSoiling's full
// per-day clear-sky coeff distribution (dayCoeffs/dayHours), the coverage bar,
// baseline (current max), recentCoeff, recentCovered, cleanDays, and dropPct —
// so a baseline inflated by one outlier "best day" can be told apart from a
// genuinely depressed recent window. STRICTLY READ-ONLY (mirrors the forecast's
// own soiling object; no recompute side effects, no writes).
app.get('/api/debug/soiling', async (req, reply) => {
  const fc = await analytics.report('forecast');
  return cached(req, reply, {
    generated_at: Date.now(),
    soiling: fc.soiling ?? null,
  }, 15);
});

// v0.30.0 — telemetry-gap markers: a durable, queryable record of any home-feed
// blackout the recorder detected (see recorder.detectTelemetryGap). A silent
// upstream stall now shows up as an incident here instead of only being
// discoverable by scanning /api/history for missing buckets.
app.get('/api/telemetry-gaps', async (req, reply) => {
  const gaps = recorder.telemetryGaps();
  return cached(req, reply, {
    generated_at: Date.now(),
    // v1.155.0 — rollups split by kind (alerts.ts telemetryGapLedgerSummary): folded
    // into longest_gap_min, one multi-day single-Core record read as a fleet blackout.
    ...telemetryGapLedgerSummary(gaps),
    gaps,
  }, 30);
});

// v0.7.5 — new analytics endpoints (all cached v0.9.14)
app.get<{ Querystring: { days?: string } }>('/api/self-consumption', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('selfConsumption', { days }), 60);
});

app.get('/api/thermal-events', async (req, reply) =>
  cached(req, reply, await analytics.report('thermalEvents'), 60),
);

app.get('/api/equipment-health', async (req, reply) =>
  cached(req, reply, await analytics.report('equipmentHealth'), 60),
);

app.get('/api/shade-report', async (req, reply) =>
  cached(req, reply, await analytics.report('shadeReport'), 60),
);

app.get('/api/soiling-decomposition', async (req, reply) =>
  cached(req, reply, await analytics.report('soilingDecomposition'), 60),
);

app.get('/api/string-mismatch', async (req, reply) =>
  cached(req, reply, await analytics.report('stringMismatch'), 60),
);

app.get('/api/ev-window-prediction', async (req, reply) =>
  cached(req, reply, await analytics.report('evWindowPrediction'), 60),
);

app.get('/api/charge-curve', async (req, reply) =>
  cached(req, reply, await analytics.report('chargeCurve'), 60),
);

app.get('/api/internal-resistance', async (req, reply) =>
  cached(req, reply, await analytics.report('internalResistance'), 60),
);

app.get<{ Querystring: { days?: string } }>('/api/forecast-skill', async (req, reply) => {
  // v1.30.0 — clamp raised 14→30 to match PV_BAND_CAL_WINDOW_DAYS (the window
  // the probabilistic band's calibration hindcasts), bounded by recorder retention.
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('forecastSkill', { days }), 60);
});

app.get('/api/ambient-thermal-forecast', async (req, reply) =>
  cached(req, reply, await analytics.report('ambientThermal'), 60),
);

app.get('/api/confidence', async (req, reply) => {
  // v1.20.0 (review fix) — forecastDayR2 needs the 30-DAY skill window (the
  // basis its r²≈0.94 premise was validated on); the default 7-day report
  // stays untouched for /api/forecast-skill and the probabilistic band.
  // (Also dropped the dead report('forecast') fetch — computeConfidenceSnapshot
  // never read it.)
  const [deg, thermal, skill] = await Promise.all([
    analytics.report('degradation'),
    analytics.report('ambientThermal'),
    analytics.report('forecastSkill', { days: 30 }),
  ]);
  return cached(req, reply, computeConfidenceSnapshot(deg, thermal, skill), 60);
});

app.get('/api/nws-alerts', async (req, reply) =>
  cached(req, reply, { alerts: await getActiveNwsAlerts() }, 60),
);

// v0.9.2 — weather ensemble (Open-Meteo + NWS NDFD when enabled). Returns
// the underlying forecast with per-hour ensembleSources + disagreement
// metadata so consumers can see WHY the bands are wider on hours with
// high inter-source disagreement.
// v0.13.3 — map weather hours to recorder GHI rows. Pure helper shared by the
// /api/weather/ensemble handler and the periodic persistence tick (below).
function weatherGhiRows(w: WeatherForecast): Array<{ epochMs: number; radiationWm2: number; cloudCoverPct: number; radiationMissing: boolean }> {
  return w.hours.map((h) => ({
    epochMs: h.ts,
    radiationWm2: h.radiationWm2,
    cloudCoverPct: h.cloudCoverPct,
    // v1.156.0 — a stand-in 0 for a value the provider did not send must never become a realized reading.
    radiationMissing: h.radiationMissing === true,
  }));
}

app.get('/api/weather/ensemble', async () => {
  const w = await getWeather((m) => app.log.info(m));
  if (!w) return { error: 'no weather available' };
  // v0.13.1 — persist the past+present hours' GHI + cloud cover to the
  // recorder so the irradiance series outlives the 2h in-memory weather
  // cache. With past_days=7 (weather.ts) one fetch backfills a full week,
  // which is what unblocks forecast-skill days 4-7 and feeds the soiling
  // estimator. Change-detected + idempotent, so calling this on every
  // (cached or fresh) fetch is cheap and never duplicates rows.
  if (recorder && w.hours.length > 0) {
    try {
      recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });
    } catch (e: any) {
      app.log.warn(`weather: GHI persistence failed (${e?.message ?? e}) — live forecast unaffected`);
    }
  }
  return {
    fetchedAt: w.fetchedAt,
    lat: w.lat, lon: w.lon,
    sourcesCount: w.ensembleSourcesCount ?? 1,
    avgDisagreementPct: w.ensembleAvgDisagreement ?? 0,
    hourCount: w.hours.length,
    enrichedHourCount: w.hours.filter((h) => (h.ensembleSources ?? 1) > 1).length,
    hours: w.hours.map((h) => ({
      ts: h.ts,
      cloudCoverPct: h.cloudCoverPct,
      radiationWm2: h.radiationWm2,
      ensembleSources: h.ensembleSources ?? 1,
      disagreementPct: h.ensembleDisagreementPct ?? null,
    })),
  };
});

app.get('/api/incidents', async (req, reply) =>
  cached(req, reply, { incidents: monitor.incidents() }, 15),
);

app.get('/api/alert-telemetry', async (req, reply) =>
  cached(req, reply, { telemetry: monitor.telemetry() }, 30),
);

/* ─── v0.9.10 — WRITE-side actions ─────────────────────────────────────
 *
 * Cloud-presence refresh for SHP2. Replaces the v0.9.6 reboot button —
 * empirical probing (scripts/probe-shp2-reboot-direct.ts) proved SHP2
 * reboot isn't exposed in the public IoT API. The cheapest documented
 * action that round-trips through EcoFlow's cloud is a no-op write
 * (re-send the current backupReserveSoc), which is enough to un-stick
 * the cloud-offline (online-on-LAN-but-cloud-says-offline) state the reboot was originally meant to address.
 * Every write is rate-limited + audit-logged.
 */
app.post<{ Params: { sn: string } }>('/api/device/refresh-cloud/:sn', { preHandler: requireWriteAuth }, async (req, reply) => {
  const sn = req.params.sn;
  if (!sn || !store.get().devices[sn]) {
    reply.code(404);
    return { error: 'unknown sn' };
  }
  // Pull the current backupReserveSoc from the SHP2 projection — we round-trip
  // this exact value so the write is a true no-op (no state change on the panel).
  const proj = store.get().devices[sn]?.projection;
  const currentReserveSoc =
    proj && proj.kind === 'shp2' ? proj.backupReserveSoc : null;
  if (currentReserveSoc == null) {
    reply.code(409);
    return {
      ok: false,
      code: 'no-snapshot',
      message:
        'No current backupReserveSoc available for this device. Wait for the next polling cycle and retry.',
    };
  }
  const result = await refreshShp2CloudPresence({
    sn,
    currentReserveSoc,
    source: {
      ip: req.ip,
      ua: req.headers['user-agent']?.toString(),
    },
  });
  if (result.outcome !== 'success') reply.code(result.rateLimited ? 429 : 502);
  return {
    ok: result.outcome === 'success',
    code: result.code,
    message: result.message,
    durationMs: result.durationMs,
    rateLimited: !!result.rateLimited,
    cooldownRemainingMs: cooldownRemainingMs('refresh-cloud', sn, REFRESH_COOLDOWN_MS),
  };
});

/** Read-only view of write cooldowns so the UI can disable buttons until ready. */
app.get<{ Querystring: { sn?: string } }>('/api/device/refresh-cloud-cooldown', async (req) => {
  const sn = req.query.sn;
  if (!sn) return { error: 'sn required' };
  return {
    sn,
    cooldownMs: REFRESH_COOLDOWN_MS,
    remainingMs: cooldownRemainingMs('refresh-cloud', sn, REFRESH_COOLDOWN_MS),
  };
});

/** Debug surface for empirically discovering undocumented EcoFlow commands.
 *  Off unless WRITE_DEBUG_TOKEN is set; requires the token in the
 *  `x-write-debug-token` header. Audit-logged like any other write.
 *
 *  v0.9.62 hardening (defense-in-depth even though gated by env):
 *   - requireWriteAuth — must be HA-ingress / same-origin / token-bearing
 *   - per-SN cooldown (env SEND_CMD_COOLDOWN_MS, default 30s)
 *   - cmdSet allow-list — only known prefixes accepted
 *   - params depth + key-count + JSON-size caps
 */
const SEND_CMD_COOLDOWN_MS = Number(process.env.SEND_CMD_COOLDOWN_MS ?? 30_000);
const lastSendCommandAt = new Map<string, number>();
const ALLOWED_CMD_SETS = [
  'PD303_APP_SET',            // SHP2
  'WN511_PORTABLE_',          // DPU family (prefix)
  'WN511_BLE_FUNC_',          // DPU family (prefix)
];
function cmdSetAllowed(cmdSet: unknown): boolean {
  if (typeof cmdSet !== 'string' || cmdSet.length === 0) return false;
  return ALLOWED_CMD_SETS.some((p) =>
    p.endsWith('_') ? cmdSet.startsWith(p) : cmdSet === p,
  );
}
function paramsObjectOk(
  params: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (params == null) return { ok: true };
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, reason: 'params-must-be-object' };
  }
  // Depth + key-count walk (bounded so a hostile payload can't DOS the walker).
  let totalKeys = 0;
  function walk(node: unknown, depth: number): { ok: boolean; reason?: string } {
    if (depth > 5) return { ok: false, reason: 'params-too-deep (max depth 5)' };
    if (node == null || typeof node !== 'object') return { ok: true };
    if (Array.isArray(node)) {
      for (const item of node) {
        const r = walk(item, depth + 1);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    for (const k of Object.keys(node as Record<string, unknown>)) {
      totalKeys += 1;
      if (totalKeys > 100) return { ok: false, reason: 'params-too-many-keys (max 100)' };
      const r = walk((node as Record<string, unknown>)[k], depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  const walkRes = walk(params, 0);
  if (!walkRes.ok) return { ok: false, reason: walkRes.reason! };
  let serialized = '';
  try { serialized = JSON.stringify(params); } catch {
    return { ok: false, reason: 'params-not-serializable' };
  }
  if (Buffer.byteLength(serialized, 'utf8') > 1024) {
    return { ok: false, reason: 'params-too-large (max 1KB serialized)' };
  }
  return { ok: true };
}

app.post<{ Body: { sn?: string; body?: Record<string, unknown> } }>(
  '/api/device/send-command',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    if (!isWriteDebugEnabled()) {
      reply.code(403);
      return { error: 'write-debug disabled (set WRITE_DEBUG_TOKEN env to enable)' };
    }
    const provided = req.headers['x-write-debug-token']?.toString();
    if (!checkWriteDebugToken(provided)) {
      reply.code(401);
      return { error: 'invalid or missing x-write-debug-token header' };
    }
    const body = req.body;
    if (!body || !body.sn || typeof body.body !== 'object') {
      reply.code(400);
      return { error: 'expected { sn, body: { cmdSet, cmdId, params } }' };
    }
    if (!store.get().devices[body.sn]) {
      reply.code(404);
      return { error: 'unknown sn' };
    }
    // v0.9.62 — cmdSet allow-list. Reject anything that isn't a known
    // PD303 / WN511 prefix so a stolen token (or curious operator)
    // can't blast arbitrary cmdSets at the device. Log every rejection
    // to the audit trail so we can see attempted misuse.
    const cmdSet = body.body['cmdSet'] ?? body.body['cmdCode'];
    if (!cmdSetAllowed(cmdSet)) {
      appendWriteLog({
        ts: Date.now(),
        action: 'send-command',
        sn: body.sn,
        params: body.body,
        source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
        outcome: 'failure',
        code: 'cmdSet-not-allowlisted',
        message: `cmdSet=${String(cmdSet)} rejected by allow-list`,
      });
      reply.code(400);
      return {
        error: 'cmdSet-not-allowlisted',
        allowedPrefixes: ALLOWED_CMD_SETS,
        provided: cmdSet ?? null,
      };
    }
    // v0.9.62 — params shape guard (depth/keys/size).
    const paramsCheck = paramsObjectOk(body.body['params']);
    if (!paramsCheck.ok) {
      appendWriteLog({
        ts: Date.now(),
        action: 'send-command',
        sn: body.sn,
        params: body.body,
        source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
        outcome: 'failure',
        code: 'params-rejected',
        message: paramsCheck.reason,
      });
      reply.code(400);
      return { error: 'params-rejected', reason: paramsCheck.reason };
    }
    // v0.9.62 — per-SN cooldown (mirrors refreshShp2CloudPresence).
    const now = Date.now();
    const last = lastSendCommandAt.get(body.sn) ?? 0;
    if (now - last < SEND_CMD_COOLDOWN_MS) {
      const remainingMs = last + SEND_CMD_COOLDOWN_MS - now;
      reply.code(429);
      return {
        error: 'cooldown',
        remainingMs,
        message: `wait ${Math.ceil(remainingMs / 1000)}s before retrying`,
      };
    }
    lastSendCommandAt.set(body.sn, now);
    const result = await debugSendCommand({
      sn: body.sn,
      body: body.body,
      source: {
        ip: req.ip,
        ua: req.headers['user-agent']?.toString(),
      },
    });
    if (result.outcome !== 'success') reply.code(502);
    return result;
  },
);

/** Last N audit-log entries. Useful for the UI to show "last writes".
 *  v0.9.62 — gated by requireWriteAuth: the audit log can leak
 *  source-IPs, attempted command shapes, etc. — not catastrophic, but
 *  not appropriate for unauth LAN visitors either. */
app.get<{ Querystring: { limit?: string } }>(
  '/api/writes/log',
  { preHandler: requireWriteAuth },
  async (req) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50) || 50));
    return { entries: tailWriteLog(limit) };
  },
);

// v0.8.0 — sustainability, tariff, probabilistic forecasts, multi-day,
// dispatch planner, calendar, repair issues (all cached v0.9.14)
app.get<{ Querystring: { days?: string } }>('/api/carbon', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('carbon', { days }), 60);
});

app.get<{ Querystring: { days?: string } }>('/api/tariff', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('tariff', { days }), 60);
});

app.get('/api/forecast/probabilistic', async (req, reply) =>
  cached(req, reply, await analytics.report('probabilisticForecast'), 60),
);

app.get<{ Querystring: { days?: string } }>('/api/forecast/multi-day', async (req, reply) => {
  const days = Math.max(1, Math.min(7, Number(req.query.days ?? 3) || 3));
  return cached(req, reply, await analytics.report('multiDayForecast', { days }), 60);
});

app.get('/api/dispatch-plan', async (req, reply) => {
  const fc = await analytics.report('forecast');
  return cached(req, reply, computeDispatchPlan(store.get().devices, fc), 60);
});

app.get('/api/root-cause', async (req) => {
  const id = (req.query as any).alertId as string | undefined;
  if (!id) return { causes: [] };
  return { causes: rootCausesFor(id) };
});

app.get('/api/calendar.ics', async (req, reply) => {
  const [fc, ev] = await Promise.all([
    analytics.report('forecast'),
    analytics.report('evWindowPrediction'),
  ]);
  const nws = await getActiveNwsAlerts();
  const ics = buildCalendarIcs({ devices: store.get().devices, forecast: fc, evWindow: ev, nwsAlerts: nws });
  reply
    .header('Content-Type', 'text/calendar; charset=utf-8')
    .header('Content-Disposition', 'inline; filename="ecoflow-panel.ics"')
    // HTTP-layer cache (HA's generic_ics_calendar honors this). Function-
    // level cache was removed in v0.8.1 since it was effectively unkeyed.
    .header('Cache-Control', 'public, max-age=300');
  return ics;
});

// v0.9.0 — Bayesian solar model + Pack Risk Scores (cached v0.9.14)
app.get('/api/forecast/bayesian', async (req, reply) =>
  cached(req, reply, await analytics.report('bayesianSolar'), 60),
);

app.get('/api/pack-risk', async (req, reply) => {
  const [deg, therm, ir, cc] = await Promise.all([
    analytics.report('degradation'),
    analytics.report('thermalEvents'),
    analytics.report('internalResistance'),
    analytics.report('chargeCurve'),
  ]);
  return cached(req, reply, computePackRiskScores(store.get().devices, deg, therm, ir, cc), 60);
});

// v0.9.4 — trained ML risk scoring. Surfaces three side-by-side signals
// per pack: heuristic (v0.9.0), trained logistic regression, unsupervised
// novelty. Composite = mean of the three. modelVersion is honest about
// whether real labels exist (lr-labeled-v1) vs heuristic-distilled
// (lr-heuristic-baseline-v1). When real failures accumulate, drop a CSV
// into data/labels.csv and run `npm run train-pack-risk`.
app.get('/api/pack-risk/v2', async (req, reply) => {
  const [deg, therm, ir, cc] = await Promise.all([
    analytics.report('degradation'),
    analytics.report('thermalEvents'),
    analytics.report('internalResistance'),
    analytics.report('chargeCurve'),
  ]);
  const heur = computePackRiskScores(store.get().devices, deg, therm, ir, cc);
  return cached(req, reply, computePackRiskV2(store.get().devices, heur.packs, deg, therm, ir, cc), 60);
});

app.get('/api/repair-issues', async (req, reply) => {
  const [forecastSkill, degradation, soiling, equipmentHealth] = await Promise.all([
    analytics.report('forecastSkill'),
    analytics.report('degradation'),
    analytics.report('soilingDecomposition'),
    analytics.report('equipmentHealth'),
  ]);
  const report = computeRepairIssues({
    devices: store.get().devices,
    alerts: store.get().alerts ?? [],
    degradation,
    soiling,
    equipmentHealth,
    forecastSkill,
  });
  // v1.191.0 (lane A) — the site clock's issues: a configured zone that did not resolve, and a zone
  // that differs from Home Assistant's (siteTimeHa.ts).
  report.issues.push(...siteTimeRepairIssues());
  // v1.191.0 (S5, P5) — an unusable tariff spec and an unknown currency, raised by tariff.ts.
  report.issues.push(...tariffRepairIssues(report.generatedAt));
  // v1.191.0 (S6) — a configured notify time the cheap window has already opened by (never on the APS preset).
  report.issues.push(...nightScheduleRepairIssues(nightScheduleNow(), report.generatedAt));
  // v1.191.0 — the site's own items (site.ts: the location check, the reference-home defaults, an
  // unreadable PV_STRINGS), raised on this thread at boot and by the background location read.
  return cached(req, reply, { ...report, issues: [...report.issues, ...siteRepairIssues()] }, 60);
});

/**
 * Flat key-value snapshot for Home Assistant REST sensors. One HTTP call
 * returns every metric we expose as an HA entity (the fields:
 * docs/reference/02-2-home-assistant-wiring.md “/api/ha-state (selected fields)”).
 * Cached forecast + degradation are reused, so HA can poll this every 30s
 * without hammering the recorder.
 */
app.get('/api/ha-state', async (req, reply) => {
  const snap = store.get();
  const devices = Object.values(snap.devices);
  const shp2 = findShp2(snap.devices);

  // Cached projections (internally cached ~30min — cheap to call per-request).
  const [fc, deg, runway, rte, clipping, curtailment, selfCons, carbon, tariff] = await Promise.all([
    analytics.report('forecast'),
    analytics.report('degradation'),
    analytics.report('runway'),
    analytics.report('roundTripEfficiency'),
    analytics.report('clipping'),
    analytics.report('curtailment'),
    analytics.report('selfConsumption'),
    analytics.report('carbon'),
    analytics.report('tariff'),
  ]);
  // v0.9.74 — only SHP2-bound DPUs count toward fleet totals. Bench cores
  // (not SHP2 sources) inflate every "fleet PV / battery net /
  // total in / total out" reading because their energy can't actually
  // reach the home power bus. Before v0.9.74 the code summed all 5 cores and
  // overstated the home's available capacity by ~40%.
  // v0.52.0 — the per-pack fleet flow loop is shared with mqttDiscovery's
  // buildState via aggregateFleetFlow (raw, un-rounded sums; rounded at emission).
  // v1.178.1 — AFTER the reports' await, from the same live device map publishReadiness
  // judges below (see buildState): sums taken before it were a boot-time sum over nothing.
  // v1.186.2 — the published battery net is the DISPLAY sum (stream-preferred, see snapshot.ts).
  const { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNetDisplay: fleetBatteryNet, panelLoad } = aggregateFleetFlow(snap.devices);
  // v1.188.1 — Fleet PV and Battery Net add every DARK home slot, metered at the panel
  // (energyBridge.ts); null while one cannot be bridged (publishReadiness `flowBridged`).
  // v1.188.1 (review) — and AC Import / Fleet Total In / Out on the same notion: a frozen Core's held
  // figures are taken out, a dark Core counts at its slot (energyBridge.ts BridgedFleetFlow.acIn).
  const bridged = recorder.bridgedFleetFlow({ fleetPv, fleetBatteryNet, acIn, fleetIn, fleetOut }, snap.devices, Date.now());

  // v1.125.1 — cache the REPRESENTATIVE islanded load for the outage cushion.
  //
  // v1.125.0 read the instantaneous panel load, which is wrong twice over: it
  // swings ~3x across the day (measured 1445 W at 00:50 MST, 3971-4038 W at
  // 18:00), so the cushion — and therefore the nightly buy — would depend on
  // WHEN the plan happened to run; and a single quiet-moment sample understates
  // the load an outage would actually see. selfCons.loadKwh is already the SHP2
  // panel_load energy over 7 days (analytics.ts: `shp2Wh.get('panel_load')`), so
  // its mean is both representative and free — it is fetched here anyway.
  if (Number.isFinite(selfCons?.loadKwh) && (selfCons?.loadKwh ?? 0) > 0) {
    noteIslandedLoadKw((selfCons.loadKwh as number) / (7 * 24));
  }
  const lifetime = recorder.getLifetimeTotals();
  const lifetimeKwh = makeLifetimeKwh(lifetime);
  // v0.8.0 additions — carbon + tariff fetched in the Promise.all above.

  // Soonest projected EOL = the pack with the fewest years left.
  const { projecting, soonest } = soonestProjecting((deg as import('./analytics.js').FleetDegradation).packs);
  type Pack = (typeof projecting)[number];
  const peerOutliers = projecting.filter((p) => p.peerOutlier);
  const eolLabel = (p: Pack | null) =>
    p == null
      ? null
      : p.coreNum != null
        ? `Core ${p.coreNum} · Pack ${p.packNum}`
        : `${p.device} · Pack ${p.packNum}`;

  // Alert counts split by source × severity.
  const alerts = snap.alerts ?? [];
  const cnt = makeAlertCounter(alerts);
  // v1.188.1 — which backup timer applies: the Cores' battery net while every home Core reports,
  // else a bound through the panel's slots (shp2Membership.ts backupTimerGate). v1.188.1 (review) — on
  // the bridge's verdicts, so the timers count each Core as Battery Net does (its own reading, or its
  // slot less the PV the bridge reads as measured there).
  const timers = backupTimerGate(snap.devices, Date.now(), slotVerdicts(bridged));

  const payload = {
    generated_at: snap.generatedAt,

    // Power flow (watts, integers)
    fleet_pv_watts: bridged.fleetPv == null ? null : Math.round(bridged.fleetPv),
    fleet_total_in_watts: bridged.fleetIn == null ? null : Math.round(bridged.fleetIn),
    fleet_total_out_watts: bridged.fleetOut == null ? null : Math.round(bridged.fleetOut),
    // v0.10.4 per-pack; positive = discharging. v1.188.1 — plus the bridged dark slots.
    fleet_battery_net_watts: bridged.fleetBatteryNet == null ? null : Math.round(bridged.fleetBatteryNet),
    panel_load_watts: Math.round(panelLoad),
    ac_import_watts: bridged.acIn == null ? null : Math.round(bridged.acIn),
    // v0.40.0 — resolve via the grid-presence resolver, not `acIn < 5` (DPU ac_in is ~0 on
    // a PV/battery-covered home → falsely pinned off-grid 24/7). Matches /api/snapshot's
    // off_grid (snapshotForClient) and the alarm engine's grid-presence view.
    off_grid: !liveGridBackstop(snap.devices).present,

    // Battery — SHP2 backup pool
    backup_pool_percent: shp2?.projection.backupBatPercent ?? null,
    backup_reserve_percent: shp2?.projection.backupReserveSoc ?? null,
    backup_full_capacity_kwh: kwh1(shp2?.projection.backupFullCapWh),
    backup_remaining_kwh: kwh1(shp2?.projection.backupRemainWh),
    // v0.15.12 — the SHP2 reports both timers regardless of flow direction;
    // publishing both showed "1.7 h to full" while the fleet was discharging.
    // Gate each on the (now correctly-signed) per-pack battery net: >+50 W =
    // discharging → charge timer inapplicable; <−50 W = charging → discharge
    // timer inapplicable; the ±50 W deadband publishes both (idle/ambiguous).
    // v1.188.1 — on backupTimerGate: with a home Core dark the Cores' net is not the pool's
    // (10-16 20:04: every Core offline, 0 W summed, "38 min" to full during a 3.4 kW drain).
    backup_charge_minutes: timers.charge ? (shp2?.projection.backupChargeTimeMin ?? null) : null,
    backup_discharge_minutes: timers.discharge ? (shp2?.projection.backupDischargeTimeMin ?? null) : null,

    // Forecast (cached ~30min)
    // v0.78.0 — publish the RESTORED display basis (all SHP2-connected Cores, wedged
    // included) so the tile shows true full-fleet PV rather than deflating to the
    // reporting Cores while a home Core is cloud-wedged. The alarm-facing basis stays
    // reporting-only (see getDayForecast + the computeRunway invariant). `?? …` keeps
    // pre-v0.78 cached forecast shapes working (Display == reporting there).
    forecast_pv_next_24h_kwh: Math.round((fc.forecastPvWhNext24Display ?? fc.forecastPvWhNext24) / 100) / 10,
    typical_pv_per_day_kwh: Math.round((fc.typicalPvWhPerDayDisplay ?? fc.typicalPvWhPerDay) / 100) / 10,
    projected_low_soc_percent: fc.minProjectedSoc,
    projected_low_soc_at: fc.minProjectedSocTs,
    forecast_history_days: fc.historyDays,
    forecast_has_weather: fc.hasWeather,
    // v0.77.0 — diagnostic: the forecast was built on an incomplete basis (cold
    // history / no SoC basis while the SHP2 or home Cores are cloud-offline). Lets
    // the operator read runway/projected-SoC with appropriate skepticism.
    forecast_structurally_incomplete: fc.structurallyIncomplete ?? false,
    soiling_drop_percent: fc.soiling?.dropPct ?? null,

    // Degradation (cached ~30min)
    degradation_packs_total: deg.packs.length,
    degradation_packs_projecting: projecting.length,
    degradation_soonest_eol_years: soonest?.yearsToEol ?? null,
    degradation_soonest_eol_date: soonest?.eolDate ?? null,
    degradation_soonest_eol_pack: eolLabel(soonest),
    degradation_peer_outliers: peerOutliers.length,

    // Alerts (split by engine source and severity)
    alert_critical_count: cnt('threshold', 'critical'),
    alert_warning_count: cnt('threshold', 'warning'),
    alert_info_count: cnt('threshold', 'info'),
    learned_critical_count: cnt('learned', 'critical'),
    learned_warning_count: cnt('learned', 'warning'),
    learned_info_count: cnt('learned', 'info'),

    // Runway — live off-grid projection (v0.5.0). v0.15.11 — null hours on a
    // net-charging horizon publish a sentinel (not bare null → HA 'unknown') so
    // a healthy ">24 h" reading is distinguishable from a real telemetry outage.
    runway_to_reserve_hours: runwayHoursForPublish(runway.hoursToReserve, runway.unavailable),
    runway_to_empty_hours: runwayHoursForPublish(runway.hoursToEmpty, runway.unavailable),
    // v0.59.0 — the runway / projected-low-SoC numbers assume the ISLANDED case (no
    // grid). True when the grid is actively carrying the load, so a 0% / low-hour
    // reading is informational, not an actionable depletion threat — let HA
    // automations gate `runway < threshold` rules on this. The numeric sensors stay
    // continuous (islanding can begin any second); this flag is the gate.
    runway_projection_islanded_only: liveGridBackstop(snap.devices).backstopping,
    // v0.69.0 — the same islanded-only caveat applies to projected_low_soc_percent
    // above: a 0% / low projection during a grid-tied cycle is informational, not an
    // imminent-depletion threat. Discoverable companion to the runway flag so an HA
    // automation gating on `projected_low_soc < N` can suppress grid-tied false alarms.
    projected_low_soc_islanded_only: liveGridBackstop(snap.devices).backstopping,
    runway_recent_load_watts: runway.recentLoadWatts,
    runway_forecast_pv_used_kwh: runway.forecastPvUsedKwh,

    // Round-trip efficiency — 7-day rolling (v0.5.0)
    round_trip_efficiency_percent: rte.efficiencyPct,
    round_trip_charged_kwh_7d: rte.totalChargedKwh,
    round_trip_discharged_kwh_7d: rte.totalDischargedKwh,

    // Inverter clipping — kWh lost today because the arrays produced more
    // DC than the hardware could pass through (v0.6.0).
    pv_clipped_kwh_today: clipping.todayKwh,
    // v1.187.10 — the day this re-estimated figure covers (its last_reset; see mqttDiscovery.ts).
    pv_clipped_kwh_today_since: dailyFigureResetIso(clipping?.generatedAt),
    pv_array_peak_watts: clipping.arrayPeakW,
    pv_hours_at_peak_today: clipping.hoursAtPeak,

    // v0.9.77 — SoC-saturation curtailment. Distinct from inverter clipping:
    // here the panels could produce more but batteries are full and home
    // load is below PV. The MPPTs throttle to match (load + standby) and
    // the rest is rejected at the array. Surface state + Wh + cumulative.
    pv_curtailment_active: curtailment.active,
    pv_curtailment_surplus_watts: curtailment.currentSurplusW,
    pv_curtailment_kwh_today: curtailment.todayKwh,
    pv_curtailment_kwh_today_since: dailyFigureResetIso(curtailment?.generatedAt),
    pv_curtailment_kwh_7d: curtailment.recent7dKwh,
    pv_curtailment_inactive_reason: curtailment.inactiveReason,
    // The configured charge ceiling (chgMaxSoc) — the SoC the pool fills
    // to before curtailment can begin. Storm Guard raises it to 100.
    pv_curtailment_charge_ceiling_pct: curtailment.current.chargeCeilingPct,

    // Self-consumption — 7-day rolling (v0.7.5)
    pv_kwh_7d: selfCons.pvKwh,
    load_kwh_7d: selfCons.loadKwh,
    battery_charge_kwh_7d: selfCons.batteryChargeKwh,
    battery_discharge_kwh_7d: selfCons.batteryDischargeKwh,
    // v1.1.0 — WHOLE-HOME grid over the window, not the DPU-charging subset.
    // `selfCons.gridImportKwh` is documented as "DPU ac_in — grid that CHARGED the DPUs (a
    // subset of total home grid)". On this SHP2 home the grid flows through the panel main
    // and never touches DPU ac_in, so it reads 0 — while `tariff_grid_import_cost_7d_dollars`
    // costed the whole-home grid and read $61.33. The emitted pair was a flat contradiction:
    // a $61 grid bill on zero grid kWh. ($61.33 ÷ $0.17/kWh ≈ 361 kWh ≈ load_kwh_7d 781 ×
    // (1 − 53.6% solar) — the tariff was right.) `gridForKpiKwh` is the same coverage-gated
    // whole-home superset the tariff, solar_fraction and carbon KPIs already use, so all four
    // now agree. It is null when grid_home_w can't be trusted, publishing "unknown" rather
    // than a wrong number — the same posture as solar_fraction_of_load_percent.
    // NOTE: `grid_import_lifetime_kwh` (the HA Energy Dashboard counter) still reads the
    // ac_in-based `fleet_grid_import_wh` and is deliberately NOT changed here.
    grid_import_kwh_7d: selfCons.gridForKpiKwh,
    solar_fraction_of_load_percent: selfCons.solarFractionOfLoadPct,
    direct_use_ratio_percent: selfCons.directUseRatioPct,
    // v0.69.0 — home-core coverage for the self-consumption KPIs. reporting < connected
    // means a SHP2-wired home core's own PV/charge telemetry is missing from the 7-day
    // integral (cloud-offline / projection-less), so solar_fraction undercounts.
    self_consumption_home_dpus_connected: selfCons.homeDpusConnected,
    self_consumption_home_dpus_reporting: selfCons.homeDpusReporting,
    self_consumption_coverage_partial: selfCons.homeDpusCoveragePartial,

    // Lifetime monotonic energy counters for HA Energy Dashboard (v0.7.6).
    // state_class: total_increasing — survive samples-table pruning via the
    // persistent `lifetime_totals` table; battery counters come from the BMS.
    pv_lifetime_kwh: lifetimeKwh('fleet_pv_wh'),
    load_lifetime_kwh: lifetimeKwh('fleet_load_wh'),
    grid_import_lifetime_kwh: lifetimeKwh('fleet_grid_import_wh'),
    // v1.3.0 (audit rank 12) — the SHP2-gridWatt whole-home counter (v0.34.0). It was
    // published by /api/lifetime-energy but absent from /api/ha-state, so the REST sensor
    // the manual of the time told operators to create against ha-state read `unknown` forever. Distinct
    // from grid_import_lifetime_kwh (DPU ac_in basis) — see project_energy_grid_reconcile.
    grid_to_home_lifetime_kwh: lifetimeKwh('fleet_grid_home_wh'),
    battery_charge_lifetime_kwh: lifetimeKwh('fleet_battery_charge_wh'),
    battery_discharge_lifetime_kwh: lifetimeKwh('fleet_battery_discharge_wh'),

    // Per-circuit lifetime kWh (v0.8.0) — one row per SHP2 circuit, each
    // appears as an HA Energy Dashboard "Individual device". Dynamic field
    // names: circuit_<ch>_lifetime_kwh.
    ...Object.fromEntries(
      Object.keys(lifetime)
        .filter((k) => k.startsWith('circuit_'))
        .map((k) => {
          const ch = k.match(/^circuit_(\d+)_wh$/)?.[1];
          return [`circuit_${ch}_lifetime_kwh`, lifetimeKwh(k)];
        }),
    ),

    // Sustainability — carbon offset / equivalent miles avoided (v0.8.0)
    carbon_kg_avoided_7d: carbon.totalKgAvoided,
    carbon_lifetime_kg_avoided: carbon.lifetimeKgAvoided,
    carbon_lifetime_miles_not_driven: carbon.lifetimeMilesNotDriven,
    carbon_grid_intensity_kg_per_kwh: carbon.gridCo2IntensityKgPerKwh,

    // TOU tariff cost tracking (v0.8.0)
    tariff_grid_import_cost_7d_dollars: tariff.gridImportCostDollars,
    tariff_solar_load_value_7d_dollars: tariff.solarLoadValueDollars,
    tariff_net_savings_7d_dollars: tariff.netSavingsDollars,
    tariff_today_grid_cost_dollars: tariff.todayGridImportCostDollars,
    tariff_today_solar_value_dollars: tariff.todaySolarLoadValueDollars,
    tariff_on_peak_cents: tariff.onPeakCents,
    tariff_off_peak_cents: tariff.offPeakCents,

    // Connectivity
    fleet_devices_total: devices.length,
    fleet_devices_online: devices.filter((d) => d.online).length,
    // Cloud-wedge diagnostic: devices the EcoFlow cloud reports OFFLINE but that
    // are still reachable on the LAN (per the configured HA ping binary_sensors)
    // — i.e. a cloud-session/MQTT wedge, not a real outage. 0 when the feature is
    // unconfigured (every offline device classifies 'unknown', not 'cloud_wedge').
    ecoflow_cloud_wedge_count: countCloudWedges(devices),
    // v0.83.0 — system data-gap / unplanned-outage TRACKING (24 h). Counts the
    // recorder's recorded telemetry blackouts (host power loss / add-on stop /
    // MQTT stall > 15 min) so the operator can watch the trend and confirm a
    // power/UPS fix reduced them. The transient push alerts live in snapshot.alerts;
    // these are the durable at-a-glance tiles. All 0/null on a healthy day.
    // v1.14.0 — single-sourced with the MQTT state publisher (alerts.ts
    // systemOutageFields) and unit-tested at the payload level.
    ...systemOutageFields(recorder.telemetryGaps(), Date.now()),

    // v1.38.0 — night-charge ADVISORY (state fields) + write-readiness gate
    // fields (design §4.1). Mirrors mqttDiscovery.buildState EXACTLY (the
    // deliberate MQTT/REST parity fix, matching the pv_curtailment precedent).
    // Both are fail-safe: nightChargeStateFields returns charge_tonight strictly
    // false + numeric fields null unless the plan is fresh (basisComplete &&
    // <12 h old); nightChargeGateFields returns write_ready strictly false on a
    // null readiness. READ-ONLY — no field here is consumed by the alarm spine.
    ...nightChargeStateFields(getLatestNightChargePlan()),
    // v1.189.0 (R4) — the overnight window's role, and the winter mid-day charge (shadow until the
    // switch: midday_charge_recommended strictly false). In parity with mqttDiscovery.buildState.
    ...nightChargeRoleFields(getLatestNightChargePlan()),
    ...middayChargeStateFields(getMiddayShadow()),
    host_soc_temp_c: liveHostTemp()?.tempC ?? null,
    host_evloop_lag_ms: liveVitals()?.evLoopLagMs ?? null,
    host_mem_available_mb: liveVitals()?.memAvailableMb ?? null,
    host_data_disk_free_mb: liveVitals()?.dataDiskFreeMb ?? null,
    host_load_1m: liveVitals()?.load1 ?? null,
    ...nightChargeGateFields(getLatestReadiness()),
  };
  // v0.9.14 — 25 s cache: the underlying computes refresh every 4 min via the
  // cache warmer, but HA polls this every 30 s. ETag + 25 s max-age means most
  // HA polls return 304 with no body — saves ~3 KB JSON per HA entity-poll cycle.
  // v1.178.0 — the same readiness rule as the MQTT publisher (publishReadiness.ts): a field
  // whose data does not exist yet is null, not a model-less 0.
  withholdUnready(payload as Record<string, unknown>, publishReadiness({
    devices: snap.devices,
    alerts: snap.alerts,
    alertsComplete: snap.alertsComplete, // v1.186.0
    speakerLastProbeAt: getBroadcastHealth().lastProbeAt,
    forecast: fc,
    runway, // v1.187.10
    clipping,
    curtailment,
    carbon,
    tariff,
    degradation: deg, // v1.187.18
    flowBridge: bridged, // v1.188.1
  }));
  return cached(req, reply, payload, 25);
});

app.get('/api/notify/status', async () => {
  const cfg = monitor.getConfig();
  return {
    channel: cfg.channel,
    configured: isConfigured(cfg),
    minSeverity: cfg.minSeverity,
    notifyResolved: cfg.notifyResolved,
    // v1.124.0 — the question that actually matters. `configured` has always meant
    // "can we dispatch", which for the 'ha' channel was true with nothing but a
    // supervisor token while delivering only a drawer card — which is exactly how
    // "alerts are configured" and "alerts reach nobody" became indistinguishable.
    reachesAPhone: reachesAPhone(cfg),
    pushTargets: cfg.pushTargets.map((t) => `notify.${t}`),
    criticalBypassDnd: cfg.criticalBypassDnd,
    lastPushFailures: getLastPushFailures(),
    ...monitor.stats(),
  };
});

app.post('/api/notify/test', { preHandler: requireWriteAuth }, async (_req, reply) => {
  try {
    await monitor.sendTest();
    return { ok: true };
  } catch (e: any) {
    reply.code(400);
    return { ok: false, error: String(e?.message ?? e) };
  }
});

// The Cleared view's history: a window of the ledger (`?days=N`, default 7; `?since=<ms>`;
// `?all=1`), newest first, each row reduced to what the table renders (clearedHistory.ts). The
// ledger and `monitor.history()` are unchanged for the warranty export.
app.get<{ Querystring: { days?: string; since?: string; all?: string } }>('/api/alerts/history', async (req, reply) =>
  cached(req, reply, clearedHistoryPage(monitor.history(), req.query ?? {}, Date.now()), 30),
);

/* v0.9.25 — feedback-loop endpoints.
 *
 *   POST /api/alerts/outcome   submit operator verdict on an alert
 *   GET  /api/alerts/outcomes  recent submissions (debug + audit)
 *   GET  /api/alerts/outcomes/stats   per-family precision + counts
 *
 * v1.187.16 — write-gated (requireWriteAuth) like every other write route: the dashboard's
 * outcome buttons reach it same-origin through HA Ingress; a bare LAN POST no longer writes the
 * learning ledger. The submitting operator's IP + UA are recorded for audit. */
app.post<{ Body: { alertId?: string; outcome?: string; notes?: string } }>(
  '/api/alerts/outcome',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    const { alertId, outcome, notes } = req.body ?? {};
    if (!alertId || typeof alertId !== 'string') {
      reply.code(400);
      return { ok: false, error: 'alertId required' };
    }
    if (!outcome || !['ack', 'dismiss', 'failed', 'resolved'].includes(outcome)) {
      reply.code(400);
      return { ok: false, error: 'outcome must be one of: ack, dismiss, failed, resolved' };
    }
    // Find the live alert (for category/severity context) — might not exist
    // if the alert has since cleared, which is fine; we still record.
    const liveAlert = (store.get().alerts ?? []).find((a) => a.id === alertId);
    const snap = getSnapshot(alertId);
    const entry = {
      ts: Date.now(),
      alertId,
      category: liveAlert?.category ?? snap?.category,
      severity: liveAlert?.severity ?? snap?.severity,
      outcome: outcome as AlertOutcome,
      notes: notes && typeof notes === 'string' ? notes.slice(0, 500) : undefined,
      features: snap?.features,
      // v0.9.59 — also thread through the captured LR feature vector
      // (populated for pack-level alerts; null/undefined for system /
      // SHP2 / EVSE alerts where the pack-risk LR doesn't apply).
      lrFeatures: snap?.lrFeatures,
      alertFiredAt: snap?.ts,
      source: {
        ip: req.ip,
        ua: req.headers['user-agent']?.toString(),
      },
    };
    appendAlertOutcome(entry);
    // v0.9.27 — online LR weight update. Fires only when we have features
    // captured AND the outcome is labelable (not 'resolved'). The shadow
    // model file at /data/models/pack-risk-lr-v1-online.json accumulates
    // updates; the baseline file is never overwritten.
    let onlineLrResult: ReturnType<typeof updateFromOutcome> | null = null;
    try {
      onlineLrResult = updateFromOutcome(entry, (m) => app.log.info(m));
    } catch (e: any) {
      app.log.warn(`onlineLR: update failed: ${e?.message ?? e}`);
    }
    // Outcome captured — drop the feature snapshot to free memory.
    // (The persisted JSONL keeps it for any future bulk re-training.)
    dropSnapshot(alertId);
    return { ok: true, onlineLrUpdated: onlineLrResult?.updated ?? false };
  },
);

/* v0.9.27 — Model Health (track A completion). Aggregate report across
 *  all models. Used by the Science-station Model Health panel. */
app.get('/api/models/health', async (req, reply) =>
  cached(req, reply, computeModelHealth(), 60),
);

/* v0.9.27 — Physics: clear-sky PV theoretical maximum + realized score.
 *  Tells the operator how much of "physics says we should be making"
 *  we're actually producing — normalizes away time-of-day + season. */
app.get('/api/physics/pv-pmax', async (req, reply) => {
  const ts = Date.now();
  // v1.191.0 — the install's array (site.ts pvSite(): the reference array while no PV_* option is
  // set). Ambient: 30 °C on that legacy site, as before; a configured site takes the weather cache's
  // temperature_2m for the hour (physicsAmbientC), so the weather is read only then.
  const site = pvSite();
  const ambient = physicsAmbientC(ts, site, isLegacyPvSite(site) ? null : await getWeather((m) => app.log.debug(m)));
  const dpus = onlineDpus(store.get().devices);
  const realizedW = dpus.reduce((s, d) => s + ((d.projection as any).pvTotalWatts ?? 0), 0);
  const result = physicsPmax(ts, ambient, site);
  return cached(req, reply, {
    ...result,
    realizedW,
    score: physicsScore(realizedW, result.pMaxW),
  }, 30);
});

/* v0.9.27 — Physics: per-pack LFP OCV analysis. Surfaces "physics SoC
 *  says X but BMS says Y" for each pack, flagging miscalibration. */
app.get('/api/physics/lfp-soc', async (req, reply) => {
  const dpus = onlineDpus(store.get().devices);
  const results: Array<{ device: string; packNum: number; analysis: ReturnType<typeof analyzePackLfp> }> = [];
  for (const d of dpus) {
    const p = d.projection as any;
    for (const pk of (p.packs ?? [])) {
      // v1.2.0 — the old code read `pk.totalVoltage`, a field the pack projection has
      // never had, so packCurrentA was null on every pack. Derive it from the real
      // fields, and take `lastNonRestingAtMs` from the rest tracker fed by the poll
      // loop (it was hardcoded null, pinning isResting false forever).
      const packVoltageMv = pk.packVoltageMv ?? pk.adBatVoltageMv ?? null;
      const analysis = analyzePackLfp({
        packVoltageMv,
        reportedSoCPct: pk.soc ?? null,
        cellVoltagesMv: pk.cellVoltagesMv ?? [],
        packCurrentA: packCurrentAmps(pk.outputWatts, pk.inputWatts, packVoltageMv),
        lastNonRestingAtMs: lastNonRestingAtMs(packRestKey(d.sn, pk)),
      });
      results.push({ device: d.deviceName, packNum: pk.num, analysis });
    }
  }
  return cached(req, reply, { packs: results, generatedAt: Date.now() }, 30);
});

/* v0.9.27 — Hierarchical Bayesian fit on pack SoH. Returns per-pack
 *  posteriors (shrunken toward DPU + fleet means) and flags outliers. */
app.get('/api/models/hierarchical-pack-soh', async (req, reply) => {
  const dpus = onlineDpus(store.get().devices);
  const obs: HBPackObs[] = [];
  for (const d of dpus) {
    const p = d.projection as any;
    for (const pk of (p.packs ?? [])) {
      const sohValue = pk.actSoh ?? pk.soh;
      if (sohValue == null) continue;
      // Estimate per-observation σ from the cycle count. Newer packs (low
      // cycles) have noisier SoH estimates; older packs have settled.
      const sigma = Math.max(0.3, 3.0 - Math.min(2.5, (pk.cycles ?? 0) / 500));
      obs.push({
        packKey: `${d.sn}:${pk.num}`,
        dpuKey: d.sn,
        value: sohValue,
        obsSigma: sigma,
      });
    }
  }
  const fit = fitHierarchical(obs);
  const outliers = findOutliers(fit, 2.0);
  return cached(req, reply, {
    generatedAt: Date.now(),
    metric: 'pack_soh_pct',
    packs: fit.packs,
    dpuMeans: Object.fromEntries(fit.dpuMeans),
    fleetMean: fit.fleetMean,
    sigmaWithinDpu: fit.sigmaWithinDpu,
    sigmaWithinFleet: fit.sigmaWithinFleet,
    outlierPackKeys: outliers.map((o) => o.packKey),
  }, 300);
});

/* v0.9.27 — MPC dispatch recommendation. Recommend-only (doesn't
 *  apply any setpoints) but surfaces "if you set reserve to X at hour Y
 *  for the next 24h, here's the projected $ savings." */
app.get('/api/dispatch/recommend', async (req, reply) => {
  const shp2 = findShp2(store.get().devices);
  if (!shp2 || shp2.projection?.kind !== 'shp2') {
    reply.code(503);
    return { error: 'SHP2 not online' };
  }
  const sp: any = shp2.projection;
  const pool = mpcPoolBasis(sp);
  if (!pool) {
    reply.code(503);
    return { error: 'backup pool unknown' };
  }
  // Pull current forecast + load history for the next 24 h.
  let fc: any = null;
  try { fc = await analytics.report('forecast'); } catch { /* */ }
  // v0.9.59 — feed the MPC the actual per-hour PV+load curve from the
  // day-ahead forecast instead of flat-filling with the 24 h mean. Without
  // the diurnal signal the planner can't distinguish midday charging from
  // evening discharge, so TOU arbitrage was impossible. Pull the P10
  // (pessimistic) PV band from the probabilistic forecast so the planner
  // can use a risk-averse PV envelope when sizing pre-peak imports.
  // Fall back to flat-fill only if no forecast hours are available.
  const recentLoadW = (sp.circuits ?? []).reduce(
    (s: number, c: any) => s + (c.watts ?? 0), 0,
  );
  const fallbackLoadKwh = recentLoadW / 1000;
  const fallbackPvKwh = (fc?.forecastPvWhNext24 ?? 0) / 24000;
  const fcHours: any[] = Array.isArray(fc?.hours) ? fc.hours : [];
  // Pull the probabilistic band so we have a real P10 PV envelope.
  let probHours: any[] = [];
  try {
    if (fc) {
      const prob = await analytics.report('probabilisticForecast');
      probHours = Array.isArray(prob?.hours) ? prob.hours : [];
    }
  } catch { /* probabilistic is optional — fall through */ }
  const pvP50: number[] = new Array(24).fill(fallbackPvKwh);
  const pvP10: number[] = new Array(24).fill(fallbackPvKwh * 0.6);
  const loadForecast: number[] = new Array(24).fill(fallbackLoadKwh);
  for (let i = 0; i < 24; i++) {
    const fh = fcHours[i];
    if (fh) {
      pvP50[i] = (fh.forecastPvW ?? 0) / 1000;
      loadForecast[i] = (fh.forecastLoadW ?? 0) / 1000;
    }
    const pb = probHours[i];
    if (pb) {
      pvP10[i] = (pb.p10W ?? pvP50[i] * 1000 * 0.7) / 1000;
    } else if (fh) {
      // No probabilistic band for this hour — synthesize a conservative
      // 70% P50 floor so the risk-averse branch still has something to bite.
      pvP10[i] = pvP50[i] * 0.7;
    }
  }
  // Tariff: the two-tier pair this vector falls back to while no confirmed rate prices an hour.
  // Both default to TARIFF_FLAT_CENTS_PER_KWH (17 ¢ when absent); TARIFF_ON_PEAK_CENTS_PER_KWH /
  // TARIFF_OFF_PEAK_CENTS_PER_KWH split them. (Until v1.191.0 this comment called the reference
  // plan flat: it is APS R-EV, priced hour by hour through hourlyRateCents below once confirmed.)
  // v1.191.0 — read through tariff.ts legacyTariffFromEnv, the one reader analytics.ts and
  // dispatch/mpc.ts use too; the rules are this block's own (bare Number, the flat rate when absent).
  // v1.191.0 (review 3) — the pair is analytics.ts mpcFallbackPair: with TARIFF_PLAN set, the cost
  // figures' own pair (an unconfirmed two_tier plan's two rates, not the 17 ¢ flat default); while it is
  // unset, the …_CENTS_PER_KWH pair above, as before (golden G2).
  const legacyTariff = legacyTariffFromEnv();
  const flatCents = legacyTariff.flatCents;
  const { onPeak, offPeak } = mpcFallbackPair(Date.now());
  // v1.136.0 — THIRD copy of the on-peak window, now retired. This hardcoded
  // `h >= 15 && h < 20` was a two-tier ladder with no DOW gate at all, so it
  // priced weekend afternoons as on-peak and every overnight hour as off-peak,
  // on a plan whose on-peak is Mon-Fri 16:00-19:00 only. It also read the HOST
  // clock. `hourlyRateCents` resolves the full table in the tariff's zone and falls
  // back to this same two-tier pair when rates are unconfirmed.
  //
  // v1.191.0 (T9) — the vector is built on the site clock (each entry is that local hour of
  // today, siteTime.ts) and the MPC indexes it on the same clock (dispatch/mpc.ts siteHour). It
  // was built on a fixed UTC−7 midnight and indexed by the host's getHours(): one vector, two
  // clocks, which agreed only while the host's zone was the reference install's.
  const todayYmd = siteYmd(Date.now());
  const tariffByHour: number[] = Array.from({ length: 24 }, (_, h) =>
    hourlyRateCents(zonedWallTimeMs(todayYmd, h, 0, siteTimeZone()), { onPeak, offPeak }));
  // v0.15.2 — off-grid honesty fix. The hardcoded gridAvailable:true let the
  // optimizer "assume away" reserve dips via grid imports that physically don't
  // exist on this islanded site, producing dangerously optimistic plans. Default
  // false; a grid-tied user opts back in with GRID_AVAILABLE=true.
  const gridAvailable = process.env.GRID_AVAILABLE === 'true';
  // v0.15.2 — feed LIVE round-trip efficiency into the per-cycle cost: as the
  // pack ages and RTE drops, each round-trip wastes more real energy, so the DP
  // should increasingly prefer shedding/deferring over deep-cycling. Cost = base
  // wear + marginal energy loss valued at the flat tariff. Falls back to the
  // legacy 0.02 constant until RTE has enough coverage to report.
  let cyclingCostUsdPerKwh = 0.02;
  try {
    const rte: any = await analytics.report('roundTripEfficiency');
    const effFrac = rte?.efficiencyPct != null ? rte.efficiencyPct / 100 : null;
    if (effFrac != null && effFrac > 0 && effFrac <= 1) {
      const baseWear = limits.cyclingBaseWearUsdPerKwh; // CYCLING_BASE_WEAR_USD_PER_KWH (limits.ts; 0.015 while unset)
      cyclingCostUsdPerKwh =
        Math.round((baseWear + (1 - effFrac) * (flatCents / 100)) * 10_000) / 10_000;
    }
  } catch { /* RTE is optional — keep the legacy default */ }
  const inputs: MpcInputs = {
    currentSocPct: pool.currentSocPct,
    reserveFloorPct: sp.backupReserveSoc ?? MPC_RESERVE_FALLBACK_PCT,
    capacityKwh: pool.capacityKwh,
    pvForecastP50: pvP50,
    pvForecastP10: pvP10,
    loadForecast,
    tariffOnPeakCentsByHour: tariffByHour,
    gridAvailable,
    cyclingCostUsdPerKwh,
    reserveDipPenaltyUsdPerKwh: 1.0,
  };
  const result = recommendDispatch(inputs);
  return cached(req, reply, { inputs, ...result }, 300);
});

/* v0.9.27 — Forecast backtest. Replay the last 7 days of typical-day
 *  PV forecasting against recorder actuals; surface RMSE/MAE/bias/R². */
app.get('/api/backtest/forecast', async (req, reply) => {
  // v0.21.0 — score actuals over the SAME scope as the predictor: SHP2-connected
  // home DPUs only (the typical-PV curve is built from home DPUs — v0.9.76).
  // Summing actuals over spare bench cores too biased the reported R²/bias/MAE
  // on a fleet with spare panels.
  const connected = shp2ConnectedDpuSns(store.get().devices);
  const dpus = Object.values(store.get().devices)
    .filter((d) => d.projection?.kind === 'dpu' && isShp2Connected(d.sn, connected))
    .map((d) => d.sn);
  // Use the typical-PV (recent average) as the v1 forecaster.
  // Higher-fidelity backtests can swap in the Bayesian or full forecast.
  let typicalWhPerHour = 0;
  // v0.13.3 — P3-4: prefer the 24-slot diurnal curve over the flat
  // typicalPvWhPerDay/24 scalar. The flat predictor returns the same Wh at 2am
  // and noon, so it has ~no correlation with real diurnal PV (measured
  // r2≈-0.0006). v0.13.1 exposed typicalPvCurveWhPerHour on the forecast report
  // (night≈0, noon≈peak); pass it through so the backtest builds a diurnal
  // baseline via diurnalBaselinePredictor(curve)[hourOfDay] and scores a real R².
  // typicalWhPerHour stays as a back-comp fallback for builders without the curve.
  let typicalPvCurveWhPerHour: number[] | undefined;
  try {
    const fc: any = await analytics.report('forecast');
    typicalWhPerHour = (fc?.typicalPvWhPerDay ?? 0) / 24;
    typicalPvCurveWhPerHour = fc?.typicalPvCurveWhPerHour;
  } catch { /* */ }
  const score = await analytics.report('backtest', {
    dpuSns: dpus, hoursBack: 168, typicalWhPerHour, typicalPvCurveWhPerHour,
  });
  return cached(req, reply, { model: 'typical-day-baseline', ...score }, 600);
});

app.get<{ Querystring: { limit?: string } }>(
  '/api/alerts/outcomes',
  async (req, reply) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50) || 50));
    return cached(req, reply, { entries: tailAlertOutcomes(limit) }, 15);
  },
);

app.get('/api/alerts/outcomes/stats', async (req, reply) =>
  cached(req, reply, { families: computeFamilyStats() }, 60),
);

// v0.20.0 — serialize the snapshot frame once per emit and share it across all
// WS clients. The store hands the SAME `snap` reference to every listener within
// one synchronous emit, and `store.frameSeq` is bumped once per emit, so caching
// on frameSeq yields byte-identical frames per emit with one JSON.stringify
// instead of one-per-client. (store.get() === the emitted `snap`.)
let wsFrameSeq = -1;
let wsDataStr = '';
/**
 * v1.176.0 — every frame carries `serverNowMs`, stamped at SEND time, so the dashboard can
 * measure data age on the server's clock. The header age and LIVE pill compare
 * server-stamped telemetry clocks against "now"; using the browser's clock for "now" made
 * them wrong by the skew between the two — a viewing tablet a few minutes fast read STALE
 * forever, and this RTC-less host boots on a baked-in date until NTP corrects it. The
 * snapshot body stays cached per emit (one JSON.stringify per emit, shared by every
 * client); only the stamp is per send, because the connect-time send can hand a new client
 * a body cached minutes ago.
 */
function snapshotFrame(): string {
  if (store.frameSeq !== wsFrameSeq) {
    wsDataStr = JSON.stringify(snapshotForClient());
    wsFrameSeq = store.frameSeq;
  }
  return `{"type":"snapshot","serverNowMs":${Date.now()},"data":${wsDataStr}}`;
}
app.get('/ws', {
  websocket: true,
  // v0.68.0 — reject cross-origin upgrades on the snapshot socket too, matching
  // the /console/ws policy and the CORS origin callback. Read-only telemetry,
  // but a cross-origin page shouldn't be able to stream the fleet snapshot.
  // Missing Origin (same-origin fetch / HA dashboards / curl) and LAN/same
  // origins still pass, so the React dashboard and Lovelace cards are unaffected.
  preValidation: (req, reply, done) => {
    const origin = req.headers.origin?.toString();
    if (origin && !isAllowedOrigin(origin, auth.sameOrigins)) {
      reply.code(403).send({ error: 'forbidden-origin' });
      return; // reply short-circuits the route → upgrade never happens
    }
    done();
  },
}, (socket) => {
  socket.send(snapshotFrame());
  const onChange = () => {
    if (socket.readyState === socket.OPEN) {
      socket.send(snapshotFrame());
    }
  };
  store.on('change', onChange);
  socket.on('close', () => store.off('change', onChange));
});

// v1.139.0 — the EcoFlow-enablement doorbell (v1.88.0) is DELETED, along with
// the long-failure-recovered callback it was wired to. It watched for the 1006-blocked
// accessories to start answering `/quota/all`, on the theory that 1006 was a
// grantable account permission an API-access request could lift. It is not: 1006
// is a PRODUCT-CLASS limit (settled 2026-09-08) — EcoFlow is not
// expected to extend API coverage to these device classes.
//
// So the condition it watched for cannot occur, and every firing it ever
// produced was necessarily false. v1.138.0 fixed the mechanism; this removes the
// feature, because a detector that can only fire falsely is worse than none on a
// life-safety system — it teaches the operator to discount the push.
//
// See the tombstone above `pollHealthVerdict` in snapshot.ts for what survives
// and why (the attempt set and the S1 telemetry-blind fix are unrelated to this).
const stopPoll = startPollLoop(store, POLL_INTERVAL_MS, (m) => app.log.info(m), (m) => app.log.warn(m), (m) => app.log.debug(m));

/* v1.2.0 — feed the per-pack rest tracker. `analyzePackLfp` needs to know when a pack
 * last moved current before it will trust pack voltage as a rested OCV; nothing was
 * recording that, so `/api/physics/lfp-soc` reported isResting=false on all 15 packs and
 * never produced a physics SoC. Sampled on the poll cadence — OCV settling is a 10-minute
 * scale phenomenon, so a 60 s sample is ample. Keyed on the pack hardware serial. */
// v1.42.0 — host SoC temperature sampler (60 s). Read-only sysfs read; the
// holder feeds the alert builder, /api/ha-state, and the MQTT sensor. On hosts
// with no readable thermal zone every surface stays null (no alert).
const hostTempTick = setInterval(() => { sampleHostTemp(); tickAssess(); }, 60 * 1000);
hostTempTick.unref();
sampleHostTemp();
// v1.43.0 — co-tenant degradation defense: in-band vitals (event-loop lag,
// /proc pressure, data-disk free) + the out-of-band dead-man heartbeat.
startVitals(resolve(process.cwd(), config.dbPath, '..'));
tickAssess();
startHeartbeat((m) => app.log.info(m));
// v1.144.0 — name the published DB snapshot once at boot. A 1.72 GB export sat
// in /share for four days riding along in every nightly HA backup, and nothing
// outside the web UI ever mentioned it. Not swept on a timer: that file is the
// only recorder history reaching past the ~52 h log ring and it has already been
// used for a real investigation — surface it and leave the deletion decision open.
(() => {
  const snap = publishedSnapshotStatus();
  if (!snap || !snap.exists) return;
  const gb = (snap.bytes / 1e9).toFixed(2);
  const days = snap.ageMs / 86_400_000;
  app.log.info(
    `db-export: published snapshot is ${gb} GB, ${days < 1 ? '<1' : Math.round(days)}d old`
    + `${days >= 2 ? ' — it is included in every HA backup; refresh or remove it if that is not wanted' : ''}`,
  );
})();

const restTrackerTick = setInterval(() => {
  // v1.43.0 alarm-first QoS: under critical host pressure, discretionary
  // analytics yield their slice to the poll→alert→broadcast path.
  if (degradedMode()) { app.log.debug('vitals: skipping rest-tracker tick (host pressure critical)'); return; }
  const now = Date.now();
  const keys: string[] = [];
  for (const d of onlineDpus(store.get().devices)) {
    for (const pk of ((d.projection as any)?.packs ?? [])) {
      const key = packRestKey(d.sn, pk);
      keys.push(key);
      observePackRest(key, packCurrentAmps(pk.outputWatts, pk.inputWatts, pk.packVoltageMv ?? pk.adBatVoltageMv), now);
    }
  }
  retainPacks(keys);
}, POLL_INTERVAL_MS);
restTrackerTick.unref?.();

// v0.13.3 — periodic GHI persistence. v0.13.1 only persisted the weather
// irradiance series from the /api/weather/ensemble HTTP handler, so GHI rows
// (which back forecast-skill days 4-7 and the soiling estimator) only landed
// when a dashboard was open. This tick calls getWeather() + recordWeatherGhi()
// on a ~45-min cadence so GHI persists reliably headless too. getWeather has a
// 2h in-memory cache, so most ticks are a cheap cache hit; recordWeatherGhi is
// change-detected + idempotent, so re-persisting the same rows never dupes.
const GHI_PERSIST_INTERVAL_MS = 45 * 60_000;
// v1.187.10 — the tick's own line says only "ran, nothing new" (6-hourly) and "no forecast"
// (createGhiTickLogger); the recorder logs every real write.
const logGhiTick = createGhiTickLogger((m) => app.log.debug(m));
const ghiPersistTick = setInterval(() => {
  if (degradedMode()) { app.log.debug('vitals: skipping GHI-persist tick (host pressure critical)'); return; }
  void (async () => {
    try {
      const w = await getWeather((m) => app.log.debug(m));
      if (recorder && w && w.hours.length > 0) {
        const r = recorder.recordWeatherGhi(weatherGhiRows(w), { fetchedAtMs: w.fetchedAt });
        logGhiTick({
          kind: 'ran', hours: w.hours.length,
          written: r?.written ?? 0, realized: (r?.realizedInserted ?? 0) + (r?.realizedRevised ?? 0),
        }, Date.now());
      } else if (recorder) {
        logGhiTick({ kind: 'no-weather' }, Date.now());
      }
      // v1.31.0 — archive the ISSUED next-24h PV forecast alongside the GHI
      // rows (same cadence; hour-snapped + change-detected in the recorder, so
      // this is ≤ a handful of rows/day). The band calibrator will score
      // against this archive — true out-of-sample day-ahead error — once
      // enough days accumulate; until then it only writes. Best-effort: an
      // analytics hiccup must not disturb the GHI persistence above.
      if (recorder) {
        try {
          const fc = await analytics.report('forecast');
          if (fc && Number.isFinite(fc.forecastPvWhNext24)) {
            recorder.recordForecastArchive(fc.forecastPvWhNext24, Date.now());
          }
        } catch (e: any) {
          app.log.debug(`forecast-archive: skipped (${e?.message ?? e})`);
        }
      }
    } catch (e: any) {
      app.log.debug(`weather: periodic GHI persistence skipped (${e?.message ?? e})`);
    }
  })();
}, GHI_PERSIST_INTERVAL_MS);
ghiPersistTick.unref();

// MQTT is best-effort; if it fails, REST polling still works.
// v0.10.4 — start with indefinite retry-with-backoff. A transient DNS
// brownout at boot (the 06-01 EAI_AGAIN event) previously left the add-on
// PERMANENTLY REST-only — this was a one-shot start with no retry, so a
// ~1-minute network blip downgraded telemetry resolution ~63% for days,
// undetected. Now a boot-time blip self-heals: keep retrying (10s → 30s →
// 60s → 120s → 5min cap) until MQTT connects. (mqtt.ts also retries the
// cert fetch, so this only fires on a longer outage.)
let stopMqtt: (() => void) | null = null;
const MQTT_RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
// v0.75.0 — number of initial retry attempts during which a DNS/signature failure
// is a benign boot-window transient (logged at warn, not error). Covers the
// 10+30+60+120+300s backoff ≈ first ~9 min; a failure still recurring after that
// is genuinely persistent and escalates back to error so it stands out.
const MQTT_BOOT_GRACE_ATTEMPTS = Number(process.env.MQTT_BOOT_GRACE_ATTEMPTS ?? 5);
const startMqttWithRetry = async (attempt = 0): Promise<void> => {
  if (stopMqtt) return; // already connected (or a prior attempt won the race)
  try {
    const mqttHandle = await startMqtt(store, (m) => app.log.info(m), (m) => app.log.warn(m));
    stopMqtt = mqttHandle.stop;
    if (attempt > 0) app.log.info(`mqtt: connected after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
  } catch (e: any) {
    const delay = MQTT_RETRY_MS[Math.min(attempt, MQTT_RETRY_MS.length - 1)];
    const msg = e?.message ?? String(e);
    // v0.75.0 — the first few boot-window failures are almost always a DNS race:
    // the Pi's resolver isn't up yet, so api-a.ecoflow.com fails to resolve
    // (EAI_AGAIN / ENOTFOUND) and the EcoFlow signature handshake then reports
    // 8521 "signature is wrong". These self-heal within ~10 min on the backoff and
    // REST polling (the alarm data path) never stops — so log them at WARN, not
    // ERROR, so a genuinely PERSISTENT auth/signature failure (still failing past
    // the boot window) stands out instead of being buried under benign boot
    // artifacts. After MQTT_BOOT_GRACE_ATTEMPTS the failure escalates back to error.
    // v0.76.0 — level selection extracted to the pure, tested classifyMqttStartFailure().
    const transientBoot = classifyMqttStartFailure(attempt, msg, MQTT_BOOT_GRACE_ATTEMPTS) === 'warn';
    const line = `mqtt: start failed (REST polling continues): ${msg} — retry in ${delay / 1000}s${transientBoot ? ' (boot-window transient)' : ''}`;
    if (transientBoot) app.log.warn(line);
    else app.log.error(line);
    setTimeout(() => { void startMqttWithRetry(attempt + 1); }, delay).unref();
  }
};
await startMqttWithRetry();

// Alert monitor: computes fleet alerts, attaches to the snapshot, pushes notifications.
// v1.66.0 — the `warn` sink. Without it every notify-DELIVERY failure logged at info,
// so "count the level >= 40 lines" — the triage this project actually runs — reported a
// clean bill of health while the alarm's only non-audible escape path was failing.
const monitor = startAlertMonitor(store, recorder, (m) => app.log.info(m), (m) => app.log.warn(m));
app.log.info(
  `notify: channel=${monitor.getConfig().channel} configured=${isConfigured(monitor.getConfig())}`,
);

// Control-room TUI — a menu-driven terminal view of the whole fleet, exposed
// two ways over ONE shared set of refresh timers:
//   • the SSH server on :2323 (SSH_ENABLED, or the deprecated TELNET_ENABLED
//     alias; config.ssh), password login with the console credentials; and
//   • a browser web terminal at /console on the web port :8787 (xterm.js over
//     a WebSocket), reachable on the LAN + pointable from a HA panel_iframe.
// v0.67.0 — the per-session render/input logic is transport-agnostic
// (TuiSession), reused by both. The browser console shares the session driver
// and keeps its in-session login card; the SSH session opens already
// authenticated.
let stopSsh: (() => void) | null = null;
const stopTuiData = (() => {
  try {
    const tuiData = createTuiDataProvider({ store, recorder, log: (m) => app.log.info(m) });
    // Browser web terminal — always available on the web port (independent of
    // the SSH toggle). Registered before app.listen().
    registerWsConsole({
      app,
      data: tuiData.provider,
      log: (m) => app.log.info(m),
      // Reject cross-origin ws upgrades using the SAME same-origin/LAN policy as
      // CORS (auth.ts isAllowedOrigin). Missing Origin (same-origin browser
      // fetch, HA panel_iframe, curl) is allowed by the caller in wsConsole.ts.
      isOriginAllowed: (origin) => (origin ? isAllowedOrigin(origin, auth.sameOrigins) : true),
    });
    app.log.info('console: web terminal available at /console');
    // v1.47.2 — the untypeable-credential warning is about the /console login
    // card, which is registered unconditionally (an SSH client can send any
    // password; the card cannot type one outside printable ASCII or over 64
    // characters), so it is emitted whatever the SSH toggle says.
    for (const p of authConfigProblems(authFromEnv())) app.log.warn(`console: ${p}`);
    // One boot notice per deprecated alias (TELNET_ENABLED / TELNET_PORT) that decided a value.
    for (const n of config.ssh.deprecationNotes) app.log.warn(`ssh: ${n}`);
    if (config.ssh.enabled) {
      const hostKey = loadOrCreateHostKey(config.ssh.hostKeyPath, (m) => app.log.info(m), (m) => app.log.warn(m));
      stopSsh = startSshServer({
        store,
        recorder,
        host: config.ssh.host,
        port: config.ssh.port,
        hostKey: hostKey.key,
        log: (m) => app.log.info(m),
        warn: (m) => app.log.warn(m),
        data: tuiData, // share the refresh timers
      }).stop;
      // The fingerprint is on this line at EVERY start, to compare with what `ssh` shows on first connect.
      app.log.info(`ssh: control-room TUI on ${config.ssh.host}:${config.ssh.port} ${describeSshAuth(authFromEnv())} — host key ${hostKey.fingerprint}`);
    } else {
      app.log.info('ssh: control-room TUI off (SSH_ENABLED and TELNET_ENABLED are both off) — /console only');
    }
    return tuiData.stop;
  } catch (e: any) {
    app.log.error(`console/ssh: failed to start: ${e?.message ?? e}`);
    return () => {};
  }
})();

// HA MQTT Discovery — opt-in. When wired to the user's HA MQTT broker, every
// sensor we expose auto-registers under the "EcoFlow Panel" device with no
// YAML edit required. Falls back silently when the feature is disabled.
let stopMqttDiscovery: (() => void) | null = null;
try {
  const discoveryHandle = await startMqttDiscovery(store, recorder, (m) => app.log.info(m));
  stopMqttDiscovery = discoveryHandle.stop;
} catch (e: any) {
  app.log.error(`mqtt-discovery: failed to start: ${e?.message ?? e}`);
}

// v0.9.5 — cache pre-warmer. Runs the heavy /api/ha-state computations
// every 4 min so request-path callers always hit warm caches (was: every
// 5 min the next /api/ha-state caller paid ~1.8s rebuilding everything).
// v0.10.0 — the analytics worker self-warms its report caches in a worker
// thread; the old main-thread cache-warmer (the dominant source of the
// multi-second event-loop blocks that tripped the Supervisor watchdog) is gone.

// v0.9.18 / v0.9.70 — Ship-wide audible broadcast. Listens for alert-
// condition transitions (green/yellow/red) and pushes a combined
// klaxon + TTS WAV (rendered on demand by audioRenderer.ts via
// Wyoming-direct to Piper) to every configured speaker through Music
// Assistant's play_announcement service.
// Off unless BROADCAST_ENABLED=true and at least one target is set.
const broadcast = startBroadcastMonitor(store, (m) => app.log.info(m), {
  klaxonDir: audioDir,
  cacheDir: audioRenderDir,
  cacheUrlPath: '/audio-render',
  // v1.187.3 — a green inside the post-restart warm-up is announced as a recovery only once it has
  // stood its dwell on a SETTLED alert set (broadcast.isRestartRecovery), measured from the alert
  // monitor's stamp (alertMonitor.alertSetTrusted): the store hydrated, every feed's delivery in the
  // published set, the boot onset debounces run, no onset clock withholding a fault.
  alertSetSettledSince: () => monitor.alertSetSettledSince(),
});

// v0.12.0 — backup-pool SoC audible alarm (50/40/30/20/15/10/8/4/2%, escalating priority): the house
// ladder and its grid-drop re-escalation (v0.23.0), and one ladder per secondary panel (v1.185.0).
// v1.187.22 — in socLadders.ts, fed by the store tick only once the store is hydrated (bounded by
// BOOT_HYDRATION_MAX_MS): a partial boot map spoke a false 50 % rung on 2026-10-12.
const socAlarmEnabled = process.env.BATTERY_SOC_ALARM_ENABLED !== 'false';
const socLadders = startSocLadders(store, {
  enabled: socAlarmEnabled,
  announce: (priority, message, messageEs) => broadcast.announce(priority, message, messageEs),
  isPriorityEnabled,
  // Keep the grid-presence entity fresh (TTL-gated) so the tick's grid verdicts are live.
  refreshGrid: async () => {
    if (gridPresenceEntityId() || hostPowerEntityId()) await haStateCache.refreshIfStale();
  },
  poolGrid: livePoolGridBackstop,
  noteLiveRoster,
  lastKnownRoster: () => lastKnownRoster,
  log: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
});

// v0.14.0 — projection-depletion audible alarm. Rides the off-grid runway
// projection (forecast PV − forecast load over 24h): announces, with escalating
// priority, when the pool is projected to reach its reserve floor (or empty)
// before solar recovers — so load can be shed while the pool is still healthy,
// rather than only once the SoC ladder has already fallen to 50/40/30%. Polled
// (not store-driven) because the runway is an analytics-worker report; a 2-min
// cadence is far finer than the hourly re-announce throttle and the report is
// cached. Honours the same per-priority Alert-Settings toggles as the SoC alarm.
const runwayAlarmEnabled = process.env.BATTERY_RUNWAY_ALARM_ENABLED !== 'false';
// v0.93.0 (audit #8) — the grid-backstop snapshot for the CURRENT runway tick,
// assigned right before runwayAlarm.update below (same tick's grid state the
// classifier sees). Read by onTrigger to gate ONLY the AUDIBLE runway alarm while
// the grid is backstopping — a belt-and-braces mute of the by-design ~10% floor
// audible that flapped a chime on a grid-tied home (one audible fired). Mirrors
// socGridForTick. Push + on-screen (the analytics forecast-runtime-* alert via
// computeAlerts) are UNTOUCHED — only broadcast.announce is gated. Off-grid
// (backstopping=false, the safe default) → gate is a no-op → a real islanded
// depletion still annunciates unchanged.
let runwayGridForTick = liveGridBackstop({});
// v1.185.0 — a SECONDARY panel's drain samples, latest runway (for /api/house-panel) and alarm.
const panelDrainSamples = new Map<string, DrainSample[]>();
/** v1.187.19 — the MAIN thread's capacity-basis tracker, for the secondary panels' drain runways
 *  only (the house runway's lives in the analytics worker). Its own file: the two threads never
 *  share one. */
const panelPoolBasisTracker = new PoolEnergyBasisTracker({ path: defaultPoolEnergyBasisPath('pool-energy-basis-panels') });
const lastPanelRunways = new Map<string, PanelRunway>();
const panelRunwayAlarms = new Map<string, ReturnType<typeof createRunwayAlarm>>();
const panelRunwayGrid = new Map<string, GridBackstop>();
function panelRunwayAlarm(sn: string, name: string): ReturnType<typeof createRunwayAlarm> {
  const have = panelRunwayAlarms.get(sn);
  if (have) return have;
  const alarm = createRunwayAlarm({
    statePath: runwayAlarmStatePathFor(sn),
    wording: { poolName: name, basis: 'drain' },
    onTrigger: (priority, message, messageEs) => {
      if (!isPriorityEnabled(priority)) return;
      if (shouldGateRunwayAudible(panelRunwayGrid.get(sn))) {
        app.log.info(`runway-alarm [${name}]: audible suppressed — grid available as backup (push/on-screen unaffected)`);
        return;
      }
      void broadcast.announce(priority, message, messageEs).then(
        (a) => { if (!a.ok) app.log.info(`runway-alarm [${name}]: audible suppressed (${a.error ?? 'unknown'})`); },
        () => { /* see the soc-alarm note in socLadders.ts */ },
      );
    },
    log: (m) => app.log.info(`${m} [${name}]`),
  });
  panelRunwayAlarms.set(sn, alarm);
  return alarm;
}
const runwayAlarm = createRunwayAlarm({
  onTrigger: (priority, message, messageEs) => {
    if (!isPriorityEnabled(priority)) return;
    // v0.93.0 (audit #8) — AUDIBLE-only grid gate. When the grid is backstopping,
    // the pool reaching/holding the reserve floor merely transfers to mains, so the
    // audible chime is suppressed here even if a transient backstopping=false let the
    // classifier reach critical. Never suppresses push/on-screen; never fires when
    // off-grid (backstopping=false), so a genuine islanded emergency is unchanged.
    if (shouldGateRunwayAudible(runwayGridForTick)) {
      app.log.info('runway-alarm: audible suppressed — grid available as backup (push/on-screen unaffected)');
      return;
    }
    void broadcast.announce(priority, message, messageEs).then( // v0.62.0 — Spanish second pass
      (a) => { if (!a.ok) app.log.info(`runway-alarm: audible suppressed (${a.error ?? 'unknown'}) — push/on-screen unaffected`); },
      () => { /* see the soc-alarm note in socLadders.ts */ },
    );
  },
  log: (m) => app.log.info(m),
});
if (runwayAlarmEnabled) {
  const runwayAlarmTick = setInterval(() => {
    void (async () => {
      try {
        // v0.23.0 — keep the grid-presence entity fresh (TTL-gated + coalesced)
        // so the floor classifier sees live grid state, then resolve the
        // backstop from the current snapshot and pass it into the alarm.
        if (gridPresenceEntityId() || hostPowerEntityId()) {
          try {
            await haStateCache.refreshIfStale();
          } catch {
            /* best effort — a cold/stale cache resolves to NOT present (safe) */
          }
        }
        // v1.185.0 (review) — every OTHER panel's runway FIRST, on the main thread and in its own try:
        // it needs nothing from the analytics worker, whose timeouts must not silence it.
        try {
          const devs = store.get().devices;
          const nowMs = Date.now();
          for (const p of secondaryShp2s(devs)) {
            const samples = noteDrainSample(panelDrainSamples.get(p.sn) ?? [], panelPoolNetWatts(devs, p).netW, nowMs);
            panelDrainSamples.set(p.sn, samples);
            const pr = panelDrainRunway(p, samples, nowMs, panelPoolBasisTracker.evaluate(devs, p, nowMs));
            lastPanelRunways.set(p.sn, pr);
            const g = livePoolGridBackstop(devs, p.sn);
            panelRunwayGrid.set(p.sn, g);
            // An unavailable figure (measuring, a Core dark, a stale panel) HOLDS the alarm's state: a
            // blip must not re-arm it into a re-announcement ten minutes later.
            if (pr.unavailable == null) panelRunwayAlarm(p.sn, p.deviceName).update(pr, g);
          }
        } catch (e: any) {
          app.log.warn(`runway-alarm: secondary panels skipped (${e?.message ?? e})`);
        }
        const r = await analytics.report('runway');
        // v0.93.0 (audit #8) — assign the tick's grid backstop synchronously BEFORE
        // update() so onTrigger's audible gate reads exactly the grid state this
        // classification used (no stale-cache divergence). Mirrors socGridForTick.
        // v1.185.0 (review) — the house pool's own verdict on a multi-panel plant (one panel: identical).
        runwayGridForTick = livePoolGridBackstop(store.get().devices, houseSnOf(store.get().devices));
        runwayAlarm.update(r, runwayGridForTick);
      } catch (e: any) {
        app.log.debug(`runway-alarm: poll skipped (${e?.message ?? e})`);
      }
    })();
  }, 2 * 60 * 1000);
  runwayAlarmTick.unref();
}

// Cloud-wedge vs real-outage reachability poll. EcoFlow's cloud gives NO device
// IP, so LAN reachability is read from operator-configured HA ping binary_sensors
// (ECOFLOW_DEVICE_REACHABILITY: SN → entity_id). Each tick we read those entity
// states into the deviceLink cache, which the alarm engine then consults to
// classify an offline device as a cloud-session wedge (reachable on the LAN) vs a
// real power/network outage (unreachable). Mirrors the grid-presence fetch: same
// async, non-blocking pattern, each HA read failure tolerated → 'unknown'. Fully
// dormant when ECOFLOW_DEVICE_REACHABILITY is unset/empty (the interval still
// runs but does nothing). Reads are independent of the SHP2 telemetry cadence so
// the classification stays fresh even under a total MQTT stall.
// v0.73.0 (finding #4) — in-flight guard so overlapping 30 s ticks coalesce. If a
// Supervisor read hangs (the 5 s/10 s caps below bound a single read, but a whole
// fan-out can still straddle a tick boundary), the next tick reuses the in-flight
// promise rather than launching a second concurrent fan-out. Mirrors haStateCache's
// `if (inflight) return inflight`.
let reachabilityInflight: Promise<void> | null = null;
async function refreshDeviceReachability(): Promise<void> {
  if (reachabilityInflight) return reachabilityInflight;
  reachabilityInflight = (async () => {
    const entities = deviceReachabilityEntities();
    await Promise.all(
      Object.entries(entities).map(async ([sn, entityId]) => {
        try {
          // v0.73.0 (finding #4) — explicit short caps so a hung Supervisor read
          // can't pile up across the 30 s poll. undici's default is ~5 min.
          const e = await getEntityState(entityId, { headersTimeoutMs: 4000, bodyTimeoutMs: 8000 });
          // A null read (HA unreachable / unknown entity) maps to 'unknown' — the
          // safe default that yields no enrichment rather than a fabricated up/down.
          setDeviceReachability(sn, interpretReachabilityState(e?.state ?? null));
        } catch {
          setDeviceReachability(sn, 'unknown');
        }
      }),
    );
  })().finally(() => { reachabilityInflight = null; });
  return reachabilityInflight;
}
{
  // Prime once at boot so the first offline alert can classify, then refresh on a
  // cadence finer than the alert-eval loop. unref() so it never holds the process.
  // v0.73.0 (finding #8) — match the interval tick's .catch so a boot-prime rejection
  // can't surface as an unhandled rejection.
  if (hasReachabilityConfig()) {
    void refreshDeviceReachability().catch((e: any) =>
      app.log.debug(`device-reachability: boot prime skipped (${e?.message ?? e})`),
    );
  }
  const reachabilityTick = setInterval(() => {
    if (!hasReachabilityConfig()) return; // dormant — no HA reads when unconfigured
    void refreshDeviceReachability().catch((e: any) =>
      app.log.debug(`device-reachability: refresh skipped (${e?.message ?? e})`),
    );
  }, 30 * 1000);
  reachabilityTick.unref();
}

// v0.23.0 — one-time boot advisory: an ISLANDED site (no grid backstop) with
// quiet hours configured and CRITICAL_BREAKS_QUIET_HOURS off means a genuine
// overnight off-grid emergency (backup floor, projected-empty) will NOT chime or
// push until the morning digest. The default is deliberately quiet, but make the
// trade-off explicit so an off-grid operator can opt back in if they want it.
{
  const offGrid = process.env.GRID_AVAILABLE !== 'true' && gridPresenceEntityId() === '';
  const critBreaks =
    process.env.CRITICAL_BREAKS_QUIET_HOURS === 'true' || process.env.CRITICAL_BREAKS_QUIET_HOURS === '1';
  const quietConfigured =
    (process.env.NOTIFY_QUIET_HOURS ?? '').trim() !== '' || (process.env.BROADCAST_QUIET_HOURS ?? '').trim() !== '';
  if (offGrid && quietConfigured && !critBreaks) {
    app.log.warn(
      'config: off-grid site + quiet hours + CRITICAL_BREAKS_QUIET_HOURS=false — genuine overnight ' +
        'battery/floor emergencies will be HELD until the morning digest (no chime/push). ' +
        'Set CRITICAL_BREAKS_QUIET_HOURS=true to be woken for critical alerts.',
    );
  }
}

// v0.15.2 — Intelligent load-shedding ADVISOR (Phase 1: read + advise, NO
// actuation). Reads the runway projection + live HA device state (haStateCache)
// + SHP2 circuit watts, decomposes the load, and recommends which loads to shed
// to extend runway (with an upper-bound counterfactual). The recommendation is
// surfaced at GET /api/load-shedding/status and as MQTT entities, so the
// operator's own HA automations can act on it. The add-on never toggles a load.
const loadShedAdvisoryEnabled = process.env.LOAD_SHEDDING_ADVISORY_ENABLED !== 'false';
initShedRegistry((m) => app.log.info(m));
const loadShedAdvisor = createLoadShedAdvisor({
  getCandidates: getShedCandidates,
  haEntity: (id) => haStateCache.getCachedEntity(id),
  shp2CircuitWatts: (ch) => {
    const shp2 = findShp2(store.get().devices);
    const circuits: any[] =
      shp2 && shp2.projection?.kind === 'shp2' ? ((shp2.projection as any).circuits ?? []) : [];
    const c = circuits.find((x) => x?.ch === ch);
    return c && typeof c.watts === 'number' ? c.watts : null;
  },
  thresholdHours: () => Number(process.env.LOAD_SHEDDING_RUNWAY_THRESHOLD_H ?? 4.0),
  restoreMarginHours: () => Number(process.env.LOAD_SHEDDING_RESTORE_MARGIN_H ?? 2.0),
});
if (loadShedAdvisoryEnabled) {
  const loadShedTick = setInterval(() => {
    void (async () => {
      try {
        // No allowlisted loads (the default) → nothing to advise on; skip the
        // HA state poll entirely so opted-out installs pay zero overhead.
        if (getShedCandidates().length === 0) return;
        await haStateCache.refreshIfStale();
        const r = await analytics.report('runway');
        // v0.92.0 — pass the live grid backstop so the advisor is grid-AWARE
        // (mirrors runwayAlarm.update above): while the grid carries the load at
        // the floor, classifyRunway returns null → no shed recommended, matching
        // the audible alarm the operator hears.
        loadShedAdvisor.update(r, liveGridBackstop(store.get().devices));
      } catch (e: any) {
        app.log.debug(`load-shed: advisory tick skipped (${e?.message ?? e})`);
      }
    })();
  }, 2 * 60 * 1000);
  loadShedTick.unref();
}

// v0.92.0 — message-RATE floor monitor (finding #1). A device (notably the
// single-point-critical SHP2) can crawl at a tiny message rate for hours while its
// ~5-min heartbeat keeps `lastUpdated` under BOTH the 180 s staleness threshold and
// the 15-min recorder gap threshold — so neither existing detector fires. This
// samples the per-SN cumulative count every 60 s and, when a normally-chatty device's
// rate collapses below its learned baseline for a sustained window, logs a WARN naming
// it (v0.93.0 will promote this to a push/audible alert once wired into the alert
// pipeline). Purely observational for now — cannot suppress or alter any existing alarm.
const rateFloor = new RateFloorTracker();
// v1.76.0 — cloud-session self-heal state (see sessionSelfHeal.ts).
// v1.93.0 — hydrate the rolling-24h heal budget from /data: it used to be
// process-local, so the cap was really "6 per process lifetime" and a restart
// silently granted a fresh six.
const selfHealState = loadSelfHealState();
if (selfHealState.healTimesMs.length > 0) {
  app.log.info(`self-heal: restored ${selfHealState.healTimesMs.length} heal(s) still inside the rolling 24h budget`);
}
let selfHealCapLogged = false; // v1.90.0 — one stand-down line per capped episode

/**
 * v1.166.0 — ONE implementation of the EcoFlow MQTT session rebuild, shared by the
 * rate-floor healer below and the telemetry-blind remediation (blindRemediation.ts).
 * The caller books the heal against the shared budget and persists it FIRST.
 */
function rebuildMqttSession(): void {
  try { stopMqtt?.(); } catch (e: any) {
    app.log.warn(`self-heal: old MQTT stop threw (continuing): ${e?.message ?? e}`);
  }
  stopMqtt = null;
  void startMqttWithRetry();
}

// v1.166.0 — REMEDIATE FIRST, ALARM ONLY IF IT FAILS (policy set 2026-09-17).
// The alert engine calls these in the same tick it builds the telemetry-blind alert.
// The budget is the SHARED rolling-24h one; the gap is the blind path's own 15 min.
setBlindRemediationHooks({
  canHeal: () => canRemediateNow(selfHealState, Date.now()),
  heal: (reason) => {
    const now = Date.now();
    selfHealState.healTimesMs = selfHealState.healTimesMs.filter((t) => now - t < HEAL_BUDGET_WINDOW_MS);
    recordRemediationHeal(selfHealState, now);
    saveSelfHealState(selfHealState); // persist the budget BEFORE the rebuild
    app.log.warn(`self-heal: ${reason} — rebuilding the EcoFlow MQTT session now (heal ${selfHealState.healTimesMs.length}/${DEFAULT_SELF_HEAL_CONFIG.maxPerDay} in the rolling 24h)`);
    rebuildMqttSession();
  },
});
// v1.157.0 — devices currently excluded from the heal quorum as idle, so the exclusion
// logs once per edge rather than every tick.
const healIdleExcluded = new Set<string>();

// v1.81.0 — event-loop lag observability (08-05 queue #8). The 08-05 review
// found 3.5-9.7s stalls freezing all in-flight API requests — and alarm
// evaluation shares this loop. Recent audits show none, likely thanks to the
// v0.10.0 analytics worker; this monitor makes that claim measurable instead
// of inferred from absence. 500ms cadence, warn at >1.5s observed lag,
// throttled to one line per minute with the window maximum.
{
  const LAG_TICK_MS = 500;
  const LAG_WARN_MS = 1_500;
  let lagExpected = Date.now() + LAG_TICK_MS;
  let lagWindowMax = 0;
  let lagLastWarnMs = 0;
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - lagExpected;
    lagExpected = now + LAG_TICK_MS;
    if (lag > lagWindowMax) lagWindowMax = lag;
    if (lagWindowMax > LAG_WARN_MS && now - lagLastWarnMs > 60_000) {
      app.log.warn(`event-loop: stalled ~${Math.round(lagWindowMax)}ms (max over the last minute) — in-flight API requests and alarm evaluation were frozen for that long`);
      lagLastWarnMs = now;
      lagWindowMax = 0;
    } else if (now - lagLastWarnMs > 60_000) {
      lagWindowMax = 0; // roll the window even when quiet
    }
  }, LAG_TICK_MS);
  lagTimer.unref();
} // v1.78.0 — one stand-down line per capped day

// v1.66.0 — persist the LEARNED hour-of-day baselines. The detector's comparison
// baseline is now per-hour-of-day (see messageRateFloor.ts), and a bucket needs
// ~30 healthy samples of that hour before it outranks the global fallback. This
// add-on restarted 18 times in one 50 h window, so in-memory buckets would never
// mature and the fix would be inert in production. Only what was LEARNED is
// persisted — never in-flight collapse timers, so a restart cannot resurrect a
// stale collapse. Fail-open on every path: a missing/corrupt file just means the
// tracker cold-starts on the global baseline, i.e. exactly v0.92.0 behaviour.
const RATE_FLOOR_STATE_PATH =
  process.env.MSG_RATE_FLOOR_STATE_PATH ??
  resolve(process.cwd(), config.dbPath, '..', 'msg-rate-floor.json');
try {
  if (existsSync(RATE_FLOOR_STATE_PATH)) {
    rateFloor.hydrate(JSON.parse(readFileSync(RATE_FLOOR_STATE_PATH, 'utf8')) as RateFloorPersisted);
    app.log.info(`msg-rate-floor: restored learned baselines from ${RATE_FLOOR_STATE_PATH}`);
  } else {
    app.log.info('msg-rate-floor: no prior baselines — learning from scratch (global fallback until hour buckets mature)');
  }
} catch (e: any) {
  app.log.warn(`msg-rate-floor: could not restore baselines (${e?.message ?? e}) — learning from scratch`);
}
let rateFloorSaveFailLogged = false;
let rateFloorTicks = 0;
// v1.111.0 — devices whose CURRENT collapse episode has surfaced (see
// decideCollapseSurfacing): idleness gates entry, never eviction.
const surfacedCollapses = new Set<string>();
// v1.187.10 — each surfaced episode's onset rate and baseline (surfacedCollapseEntry).
const collapseOnsets: RateFloorOnsets = new Map();
// v1.108.0 — night-charge load-band calibration: last logged value (log on change only).
let lastLoggedLoadBandKey: string | null = null;
let lastLoggedBuyDebiasKey: string | null = null;
// v1.187.1 — the cost ceiling's load de-bias: last logged value (log on change only).
let lastLoggedCostLoadKey: string | null = null;
/**
 * v1.125.0 — the ISLANDED load, kW: the SHP2's own circuit sum.
 *
 * When the grid drops the SHP2 carries its backup circuits and the rest of the
 * house is dead, so this — not the whole-house figure — is the load an outage
 * cushion has to survive. Measured live 2026-09-05: panel_load 1445 W against a
 * whole-house 4863 W.
 *
 * Returns null when the SHP2 is not reporting, which fails the cushion CLOSED to
 * its legacy form rather than silently sizing against a missing measurement.
 */
/**
 * v1.129.0 — PERSISTED, AND REFRESHED ON A TIMER RATHER THAN BY A WEB REQUEST.
 *
 * v1.125.1 populated this cache as a SIDE EFFECT of the /api/ha-state handler.
 * Two consequences, both observed live on 2026-09-05:
 *
 *  - Every restart emptied it, so `outageCushionKwh` fell back to the legacy flat
 *    band until someone happened to request that endpoint. After the v1.128.1
 *    deploy the plan still read `cushionBasis: legacy-pct` more than an hour
 *    later. Deploys are frequent, so this was not a rare edge.
 *  - Safety-relevant sizing depended on an unrelated HTTP route being hit. That
 *    is the same shape as the defects this codebase keeps finding: a mechanism
 *    whose liveness rests on something nobody guaranteed.
 *
 * The value is durable state — a 7-day mean does not change materially across a
 * restart — so it is persisted and seeded at boot, and refreshed on the
 * night-charge recompute tick that already runs every 30 minutes. The ha-state
 * handler still updates it opportunistically; it is simply no longer the only
 * path. Staleness still fails the cushion CLOSED to its legacy form.
 */
const ISLANDED_LOAD_PATH = resolve(process.cwd(), config.dbPath, '..', 'islanded-load.json');
/** Stale after this long the cushion falls back to its legacy form rather than
 *  sizing against a figure nobody has refreshed. */
const ISLANDED_LOAD_MAX_AGE_MS = 6 * 3_600_000;

let islandedLoadKwCache: { kw: number; atMs: number } | null = (() => {
  try {
    return parsePersistedIslandedLoad(JSON.parse(readFileSync(ISLANDED_LOAD_PATH, 'utf8')));
  } catch { /* absent or corrupt — fall back to legacy until a refresh lands */ }
  return null;
})();

/** Record a fresh islanded-load measurement and make it survive a restart. */
function noteIslandedLoadKw(kw: number): void {
  if (!Number.isFinite(kw) || kw <= 0) return;
  islandedLoadKwCache = { kw, atMs: Date.now() };
  try { atomicWriteFileSync(ISLANDED_LOAD_PATH, JSON.stringify(islandedLoadKwCache)); }
  catch { /* a lost write costs one restart's freshness, never correctness */ }
}

function islandedLoadKwNow(): number | null {
  if (!islandedLoadKwCache) return null;
  if (Date.now() - islandedLoadKwCache.atMs > ISLANDED_LOAD_MAX_AGE_MS) return null;
  return islandedLoadKwCache.kw;
}

// v1.115.0 — the SHP2's currently-reported reserve, for ownerReserveFloorPct's
// fallback. Null before the first poll populates the snapshot.
// v1.115.0 — the owner's most recent /api/reserve-floor write. The device
// echoes it back through the settings surface a poll or two later; within this
// grace window that echo is OURS, not drift. Deliberately in-memory: a restart
// losing it costs one spurious drift warn, never a missed real change.
export const OWNER_FLOOR_WRITE_GRACE_MS = 15 * 60_000;
let ownerFloorWrite: { pct: number; atMs: number } | null = null;

function liveReserveSocPct(): number | null {
  const shp2 = findShp2(store.get().devices); // v1.185.0 — the house panel
  return (shp2?.projection as any)?.backupReserveSoc ?? null;
}

const rateFloorTick = setInterval(() => {
  try {
    const now = Date.now();
    const devices = store.get().devices;
    // v0.93.0 (audit #1 phase-2) — accumulate the CURRENTLY-collapsing devices this
    // tick and publish them so alertMonitor surfaces a real push alert per device
    // (via rateFloorAlerts). `collapsing` is true while a fired collapse is ongoing,
    // so the set is stable across ticks (dedup) and empties on recovery. The WARN
    // log is preserved below exactly as before.
    const collapses: RateFloorCollapse[] = [];
    // v1.157.0 — surfaced devices that are electrically idle THIS tick. Feeds the
    // self-heal quorum only (selfHealQuorum); `collapses`, the alert set, is never filtered.
    const idleSurfacedSns = new Set<string>();
    // v1.131.0 — ITERATE THE ROSTER, NOT THE OBSERVATION MAP.
    //
    // `mqttMsgCountBySn` gains an entry only inside the MQTT ingest path, so a
    // device that has produced ZERO messages since process start is absent from
    // it and was never sampled at all. The detector was armed for a 0.2 msg/min
    // collapse and disarmed for a 0.0 msg/min one — and a restart is exactly what
    // converts the first into the second. Its own header calls the SHP2 "the
    // single-point-critical alarm DATA SOURCE, so a silent rate-collapse is a real
    // blind spot"; a totally silent SHP2 was the one case it could not see.
    //
    // Sampling the known devices with `?? 0` lets the existing dwell and
    // eligibility logic treat silence as the rate-0 collapse it is.
    for (const { sn, count } of rateFloorSampleSet(Object.keys(devices), store.mqttMsgCountBySn)) {
      const r = rateFloor.sample(sn, count, now);
      const name = devices[sn]?.deviceName ?? sn;
      // v1.95.0 — this detector exists to catch a device that is "barely
      // reporting while still appearing FRESH". A device that is actually
      // offline is the offline/stale alert's business, and reporting it here
      // told the operator to "check the EcoFlow cloud session / power" for
      // hardware he had just unplugged himself. Keep SAMPLING (so baselines
      // stay honest) but never surface a collapse for an offline device.
      // v1.108.0 gated surfacing on idleness statelessly, which let a brief
      // idle spell mid-collapse EVICT the standing alert (silent resolve →
      // duplicate push on re-fire, warn trail lost — the 08-25/26 audit
      // minors). v1.111.0 — decideCollapseSurfacing (pure, tested): offline
      // evicts (the offline alert owns that), recovery evicts, idleness gates
      // ENTRY only; the collapse warn logs exactly once per surfaced episode,
      // even when the tracker edge was consumed during an idle spell.
      const projW: any = devices[sn]?.projection;
      const online = devices[sn]?.online === true;
      const idle = isElectricallyIdle(projW?.totalInWatts, projW?.totalOutWatts);
      // v1.112.1 — "starved right now": current rate under the collapse floor.
      // Nulls fail toward starved (never let missing data mute a real episode).
      const starvedNow = r.rate == null || r.baseline <= 0
        || r.rate < DEFAULT_RATE_FLOOR_CONFIG.floorFraction * r.baseline;
      const wasSurfaced = surfacedCollapses.has(sn);
      const dec = decideCollapseSurfacing(r.collapsing, online, idle, wasSurfaced, starvedNow);
      if (!online) { surfacedCollapses.delete(sn); collapseOnsets.delete(sn); continue; }
      if (dec.surfaced) {
        surfacedCollapses.add(sn);
        // v1.187.10 — the onset frozen, the live rate beside it, and whether it is back above the floor.
        collapses.push(surfacedCollapseEntry(collapseOnsets, sn, name, r.rate, r.baseline, starvedNow));
        if (idle) idleSurfacedSns.add(sn);
      } else if (!r.collapsing) {
        surfacedCollapses.delete(sn);
        collapseOnsets.delete(sn);
      }
      if (dec.logCollapse) {
        // v1.187.10 — a roster-muted device (bench spare, off-panel Core) logs at INFO with the mute.
        const line = rateFloorCollapseLine({ name, sn, rate: r.rate, baseline: r.baseline, usedHourBucket: r.usedHourBucket, eligibilityPeak: r.eligibilityPeak }, rosterMuteReasonForSn(sn));
        if (line.level === 'warn') app.log.warn(line.text); else app.log.info(line.text);
      } else if (r.recovered && wasSurfaced) {
        // v1.116.0 — a recovery is only newsworthy for an episode the operator
        // was actually told about. The 08-28/29 night logged SIX "message rate
        // recovered" lines with ZERO matching "collapsed" lines (the entry gate
        // correctly suppressed idle/rebounding collapses, but the exit line was
        // ungated), so the journal read as recoveries from nowhere — and the
        // asymmetry is exactly what makes a suppressed episode hard to audit.
        app.log.info(`msg-rate-floor: ${name} message rate recovered (${r.rate?.toFixed(1) ?? '?'} msg/min)`);
      }
      // The transition that disarmed three Cores without a trace. v0.92.0 logged
      // nothing here at all, so "no alert" and "no longer watching" read the same.
      //
      // As of the eligibility high-water mark this can no longer be triggered by a
      // COLLAPSE — only by a device that has been genuinely quiet long enough for
      // the mark to decay under the floor (days). If this line appears during an
      // outage, the mark is not doing its job and that is a bug, not a status.
      if (r.eligibilityLost) {
        app.log.warn(
          `msg-rate-floor: ${name} is NO LONGER MONITORED — its learned baseline fell below the ` +
          `eligibility floor (now ~${r.baseline.toFixed(1)} msg/min). A rate collapse on this device ` +
          `will NOT raise an alert until its baseline recovers. ${sn}`,
        );
      }
    }
    setRateFloorCollapses(collapses);

    // v1.76.0 — SESSION SELF-HEAL. When the fleet has been starved (≥2 surfaced
    // rate-collapses that selfHealQuorum counts — v1.157.0) for the dwell, rebuild our MQTT session: stop, null
    // the handle, and let startMqttWithRetry re-fetch the certificate and connect
    // fresh. Read-path only — REST polling (the alarm data path) is untouched, and
    // a failed rebuild falls back to the existing retry backoff. Cooldown + daily
    // cap make thrash impossible (the 08-08 flap storm is the sizing case).
    // If a prior rebuild's retry chain is still running (stopMqtt === null), a
    // duplicate chain is benign: whichever connects first wins, the loser sees
    // stopMqtt set and returns.
    // v1.121.0 — the SHP2 alone satisfies the quorum (see evaluateSelfHeal): it is
    // the alarm chain's single-point-critical input, so a wedge confined to it must
    // be able to start the heal clock. Dwell/cooldown/budget are unchanged.
    // v1.144.0 — resolve the alarm-path panel by IDENTITY, not by projection.
    // `findShp2` requires `projection.kind === 'shp2'`, which only exists after a
    // SUCCESSFUL quota fetch — so on a restart while the panel is cloud-dark it
    // returns undefined and this exception is disarmed. That matters more here
    // than almost anywhere: replaying the quorum gate against the observed
    // 52.5 h window without this exception yields ZERO of the six heals that
    // actually fired. It is the only route by which self-heal reaches the SHP2 at
    // all, and "restart while the panel is dark" is exactly when a human would
    // restart the add-on. Same identity-not-projection rule v1.140.0 established
    // for pollHealthVerdict, and it also stops `findShp2` pinning the
    // lowest-serial panel when a second one is present.
    const alarmPathSns = new Set(alarmPathShp2Sns(devices));
    const alarmCriticalStarved = alarmPathSns.size > 0 && collapses.some((c) => alarmPathSns.has(c.sn));
    // v1.157.0 — the heal QUORUM is not the alert set (see selfHealQuorum). A held collapse
    // on a device that has gone electrically idle keeps its alert but loses its heal vote;
    // the alarm-path panel always counts. On 2026-09-13 three idle Cores held at reserve
    // spent four heals on a healthy session, so the panel's genuine wedges the next
    // evening each ran on the last slot.
    const healQuorum = selfHealQuorum(collapses, idleSurfacedSns, alarmPathSns);
    // v1.158.0 — the same set gates the PUSH dwell (the card is unchanged): a collapse held
    // on an idle, non-alarm-path device pushed at 21:51 on 2026-09-13 against a session that
    // had been healthy since 21:41. The alarm-path panel is never in idleExcluded, by identity.
    setRateFloorIdleHeld(healQuorum.idleExcluded.map((m) => m.sn));
    for (const m of idleExclusionEdges(healIdleExcluded, healQuorum.idleExcluded)) {
      app.log.info(`self-heal: ${m.deviceName} no longer counts toward the heal quorum — it is electrically idle, so its held rate collapse no longer votes for a session rebuild; the alert stays until the rate recovers`);
    }
    // v1.191.0 (Z5) — the quorum is bounded by the devices on the account (a one-device account can
    // heal); on a plant with more devices than SELF_HEAL_MIN_DEVICES it is that setting, as before.
    const healVerdict = evaluateSelfHeal(
      now, healQuorum.count, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved, accountDevices: Object.keys(devices).length },
    );
    // v1.78.0 — the daily-cap stand-down was computed and DISCARDED: on 08-14
    // the cap emptied at 04:44 with recovery 27 min later, and nothing in the
    // log said the healer had stood down. Log it once per capped day.
    if (!healVerdict.heal && healVerdict.reason.startsWith('daily cap')) {
      // v1.90.0 — rolling 24h budget: log the stand-down once per capped
      // EPISODE; re-arm when the budget frees or a heal fires.
      if (!selfHealCapLogged) {
        selfHealCapLogged = true;
        app.log.warn(`self-heal: standing down — ${healVerdict.reason} (starvation persisting; capacity frees as heals age past 24h)`);
      }
    } else {
      selfHealCapLogged = false;
    }
    if (healVerdict.heal) {
      saveSelfHealState(selfHealState); // persist the budget BEFORE the rebuild
      app.log.warn(`self-heal: ${healVerdict.reason} [counted: ${healQuorum.counted.map((m) => m.deviceName).join(', ')}]`);
      rebuildMqttSession();
    }

    // Persist learned baselines every ~10 min. Cheap (a few hundred bytes) and
    // strictly best-effort — a write failure is latched to one log line so a
    // read-only /data (the failing-SD-card case) cannot flood the log.
    if (++rateFloorTicks % 10 === 0) {
      try {
        writeFileSync(RATE_FLOOR_STATE_PATH, JSON.stringify(rateFloor.toJSON()));
      } catch (e: any) {
        if (!rateFloorSaveFailLogged) {
          rateFloorSaveFailLogged = true;
          app.log.warn(`msg-rate-floor: cannot persist learned baselines (${e?.message ?? e}) — hour buckets will reset on restart`);
        }
      }
    }
  } catch (e: any) {
    app.log.debug(`msg-rate-floor: tick skipped (${e?.message ?? e})`);
  }
}, 60 * 1000);
rateFloorTick.unref();

// Read-only advisory status. No auth: it exposes no secrets and actuates nothing.
app.get('/api/load-shedding/status', async () => ({
  enabled: loadShedAdvisoryEnabled,
  mode: 'advisory',
  candidatesConfigured: getShedCandidates().length,
  haStateCacheAgeMs: haStateCache.getCacheAgeMs(),
  advisory: loadShedAdvisor.getStatus(),
}));

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.38.0 — Night-charge TOU-arbitrage ADVISOR wiring (design §2–§5).
 *
 * ADVISORY / NO-WRITE. This orchestrates the pure subsystem modules
 * (nightChargeAdvisor.ts + nightChargeGate.ts + recorder ledger) — it NEVER
 * issues a device write and NEVER touches the floor/runway/SoC alarm spine. It
 * (1) recomputes a fresh plan on a 30-min tick so HA/status always have a
 * ≤12 h-fresh plan; (2) runs ONE ~21:30 site-time evening job (day-keyed
 * latch, persisted across add-on restarts) that records the plan row, scores yesterday's
 * outcome, recomputes readiness, and sends ONE notification; (3) serves
 * GET /api/night-charge/status. Every numeric emits null over a fabricated
 * number, and any incomplete/incoherent/thin basis yields a null plan. Mirrors
 * the load-shed advisor block above.
 * ═════════════════════════════════════════════════════════════════════════ */
const nightChargeEnabled = process.env.NIGHT_CHARGE_ADVISOR_ENABLED !== 'false';
// v1.39.0: max 22, not 23 — the evening job's catch-up window is [fire, 23:00),
// so hour=23 made the fire window the EMPTY SET: the advisory could never send
// and every night logged a "missed window" that looked transient. The schema is
// int(0,23), so this clamp is the only one (v1.191.0, W6: it was said to be the
// schema's too). (S6) — another plan's schedule clamps further, to the hour before
// its cheap window opens (nightSchedule.ts notifyHourMax).
const NIGHT_CHARGE_NOTIFY_HOUR = clampInt(Number(process.env.NIGHT_CHARGE_NOTIFY_HOUR ?? 21), 0, 22, 21);
const NIGHT_CHARGE_NOTIFY_MINUTE = clampInt(Number(process.env.NIGHT_CHARGE_NOTIFY_MINUTE ?? 30), 0, 59, 30);
/** v1.191.0 (S6, plan 3.4 W2–W6) — the night-charge schedule of the tariff in effect, for the configured
 *  notify time (nightSchedule.ts): the APS R-EV preset's constants on the reference install, whatever
 *  the notify time; the plan's own cheap window otherwise. The evening job, the shadow tick, the
 *  status route, the scorer's fallback night and the force-charge backstop read it at call time. */
function nightScheduleNow(model = tariffModelFromEnv()): NightSchedule {
  return nightScheduleOf(model, { hour: NIGHT_CHARGE_NOTIFY_HOUR, minute: NIGHT_CHARGE_NOTIFY_MINUTE });
}
/** v1.191.0 (S6, W5) — the force-charge run backstop of the tariff in effect (7 h on the APS preset).
 *  It never throws: a tariff read that fails gives the fixed 7 h, so no OFF decision waits on it. */
function forceChargeMaxRunNow(): number {
  try { return nightScheduleNow().forceChargeMaxRunMs; } catch { return FORCE_CHARGE_MAX_RUN_MS; }
}
/** The readiness options with the schedule's completion offset (45 h on the APS preset). */
function nightReadinessOpts(): { algoVersion: number; completeAfterMs: number } {
  return { algoVersion: CURRENT_ALGO_VERSION, completeAfterMs: nightScheduleNow().fallbackNight.completeMin * 60_000 };
}
const NIGHT_CHARGE_LATCH_PATH =
  process.env.NIGHT_CHARGE_LATCH_PATH ?? resolve(process.cwd(), config.dbPath, '..', '.night-charge-latch.json');
// v1.40.0: the freshest pre-window plan, persisted so a restart during the
// evening job's 21:30–23:00 record window no longer loses the night's plan row.
const NIGHT_CHARGE_PLANSNAP_PATH =
  process.env.NIGHT_CHARGE_PLANSNAP_PATH ?? resolve(process.cwd(), config.dbPath, '..', '.night-charge-plan.json');
// v1.50.0 — owner-selected write posture. Unknown/absent values fail closed to
// 'advisory' (resolveNightChargeMode); 'supervised'/'auto' arm the bounded
// nightly reserve write below.
const NIGHT_CHARGE_MODE = resolveNightChargeMode(process.env.NIGHT_CHARGE_MODE);
// v1.165.0 — force-charge gate inputs (nightForceCharge.ts). The same options the
// planner reads; the kill switch is ARB_COST_MAX_SOC_PCT <= RESERVE_WRITE_MAX_PCT.
// v1.191.0 (S3b) — through their config.ts rows (the same rules: 'cost' in any case, a bare Number()).
const FORCE_CHARGE_OBJECTIVE = option<'cost' | 'resilience'>('ARB_OBJECTIVE');
const FORCE_CHARGE_COST_MAX_SOC_PCT = option<number>('ARB_COST_MAX_SOC_PCT');
// R2 — per leg: a backup leg never force-charges (chargeWindows.ts legForceChargeEligible). Every
// caller today arms the overnight cost leg, the default.
const forceChargeOn = (role: ChargeLegRole = 'cost'): boolean => legForceChargeEligible(role, forceChargeEnabled({
  mode: NIGHT_CHARGE_MODE,
  objective: FORCE_CHARGE_OBJECTIVE,
  costMaxSocPct: FORCE_CHARGE_COST_MAX_SOC_PCT,
  reserveWriteMaxPct: RESERVE_WRITE_MAX_PCT,
}));
// Restart-persistent per-night actuation record — a raised reserve MUST be
// findable (and revertable) across an add-on restart mid-window.
const NIGHT_CHARGE_ACTUATION_PATH =
  process.env.NIGHT_CHARGE_ACTUATION_PATH ?? resolve(process.cwd(), config.dbPath, '..', '.night-charge-actuation.json');
const HOUR_MS = 3_600_000;

function clampInt(v: number, lo: number, hi: number, dflt: number): number {
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** Restart-persistent day-keyed latch. The add-on restarts whenever it is
 *  updated (and on host maintenance), so the latch must survive restarts for
 *  the evening job to fire at most ONCE per site calendar day. (v1.40.0:
 *  the host itself is verified stable — the earlier "daily power-cycle"
 *  premise no longer holds; restart-resilience is still required.) */
interface NightChargeLatch {
  lastNotifyDay: string | null;
  /** v1.187.22 — the evening's refused arm (armRefusalReason) and the window it was refused for:
   *  the status route serves it (servedArmRefusal) so the card leads with it. null = none. */
  armRefused?: ArmRefusalRecord | null;
}
function readNightChargeLatchFile(): NightChargeLatch {
  try {
    const raw = JSON.parse(readFileSync(NIGHT_CHARGE_LATCH_PATH, 'utf8'));
    const d = raw?.lastNotifyDay;
    return { lastNotifyDay: typeof d === 'string' ? d : null, armRefused: coerceArmRefusalRecord(raw?.armRefused) };
  } catch {
    return { lastNotifyDay: null, armRefused: null };
  }
}
// In-memory mirror of the persisted latch, seeded once from disk at module load.
// The read path (evening job tick + the status route) reads THIS, never the file,
// so no request/timer performs an unbounded filesystem read (CWE-770 / CodeQL
// js/missing-rate-limiting); the file is the cross-restart source of truth,
// updated in lock-step on every write.
let nightChargeLatchMem: NightChargeLatch = readNightChargeLatchFile();
function readNightChargeLatch(): NightChargeLatch {
  return nightChargeLatchMem;
}
function writeNightChargeLatch(l: NightChargeLatch): void {
  nightChargeLatchMem = { lastNotifyDay: l.lastNotifyDay, armRefused: l.armRefused ?? null };
  try {
    atomicWriteFileSync(NIGHT_CHARGE_LATCH_PATH, JSON.stringify(l));
  } catch (e: any) {
    app.log.debug(`night-charge: latch persist failed (${e?.message ?? e})`);
  }
}

// v1.50.0 — in-memory mirror of the persisted actuation state, seeded once at
// module load (same pattern as the notify latch: reads hit memory, writes go to
// memory + disk in lock-step).
// v1.189.0 — the file holds the charge CYCLE (chargeCycle.ts): the active leg at the top level, in
// the shape every earlier release reads (a rollback still finds and reverts it), plus the legs
// pending behind it and a trailing leg. The per-night record below stays the ACTIVE leg, so every
// reader of it is unchanged; with one leg nothing is pending or trailing.
const nightCycleAtBoot: ChargeCycleState = (() => {
  try {
    return coerceCycle(JSON.parse(readFileSync(NIGHT_CHARGE_ACTUATION_PATH, 'utf8')));
  } catch {
    return emptyCycle();
  }
})();
let nightActuationMem: ChargeLegState = nightCycleAtBoot.active;
/** v1.189.0 — the legs armed behind the active one, in order. They have written nothing. */
let nightCyclePending: ChargeLegState[] = nightCycleAtBoot.pendingLegs;
/** v1.189.0 — a prior leg still verifying its force-charge OFF while a reserve-only backup leg
 *  runs (chargeCycle.armCycle); driven by runTrailingLegTick. */
let nightCycleTrailing: ChargeLegState | null = nightCycleAtBoot.trailing;
/** v1.189.0 — the legs that left the cycle within the drift tail (chargeCycle.DepartedLeg): the
 *  settings-drift attribution still sees their restore and force-charge OFF. In memory only. */
let nightCycleDeparted: DepartedLeg[] = [];
/** v1.189.0 — the cycle as one value (the record is the three bindings above). */
function nightCycleView(): ChargeCycleState {
  return { active: nightActuationMem, pendingLegs: nightCyclePending, trailing: nightCycleTrailing };
}
// v1.113.0 — seed the posture from persisted state so a restart mid-window
// does not momentarily present an arbitrage-raised reserve as a genuine floor.
setReserveArbitrageRaised(effectiveArbitragePosture(nightActuationMem, liveReserveSocPct(), Date.now()));
setOwnerReserveFloorPct(ownerReserveFloorPct(nightActuationMem, liveReserveSocPct(), Date.now()));
analytics.pushOwnerFloor(ownerReserveFloorPct(nightActuationMem, liveReserveSocPct(), Date.now()));
// heldByChargeWrite — the on-peak money detectors' view of a write whose restore did not take.
setChargeWriteHold(chargeWriteHold(nightActuationMem));

// v1.119.2 — republish the OWNER floor on every snapshot, not only on an
// actuation-state write: the floor has three possible authors — the owner, our
// own actuator, and EcoFlow Storm Guard (which moved it 20 -> 40 on 2026-08-30
// with no actuation event at all). pushOwnerFloor is idempotent, so this is a
// no-op except when the value actually moves.
//
// ★ REGISTERED HERE, NOT beside the pushSnapshot handler near the top of this
// file. v1.119.0 put it there and the handler closed over `nightActuationMem`,
// a `let` declared ~2300 lines further down — so the first store 'change' that
// arrived during module evaluation threw
// `ReferenceError: Cannot access 'nightActuationMem' before initialization`
// and FAILED THE WHOLE POLL. Observed once per boot (2026-09-01 19:47:18).
// A handler that reads module state must be registered after that state exists.
// v1.120.0 — the arbitrage POSTURE must survive the revert readback lag. The
// revert stamps revertedAtMs on the cloud ACK, but the SHP2 keeps reporting the
// raised reserve for another ~20-60 s; with the posture already false the alert
// engine reads pool 49% against a still-raised reserve of 50 and pushes a false
// "[Medium] Backup at reserve" that resolves itself ~40 s later (live 2026-09-03
// 05:06:16, and in the ledger for 08-31 and 09-01). isRevertSettling holds the
// posture true for exactly as long as the device still echoes OUR target.
function effectiveArbitragePosture(
  s: NightActuationState, liveReservePct: number | null, nowMs: number,
): boolean {
  return isReserveArbitrageRaised(s) || isRevertSettling(s, liveReservePct, nowMs);
}

store.on('change', (snap: FleetSnapshot) => {
  const sp = findShp2(snap.devices);
  const live = sp?.projection?.kind === 'shp2' ? (sp.projection.backupReserveSoc ?? null) : null;
  // v1.187.10 — the floor, like the posture below, holds through the revert readback lag
  // (isRevertSettling): this per-snapshot push is what ends the hold on the readback.
  analytics.pushOwnerFloor(ownerReserveFloorPct(nightActuationMem, live, Date.now()));
  // Re-evaluate the posture per snapshot: the settling window ENDS on a device
  // readback, which is a snapshot event, not an actuation-state write.
  setReserveArbitrageRaised(effectiveArbitragePosture(nightActuationMem, live, Date.now()));
});
function persistNightActuation(s: NightActuationState): void {
  // v1.189.0 — the active leg keeps its name (a record built fresh is the overnight cost leg).
  nightActuationMem = asChargeLeg(s);
  // v1.113.0 — keep the alert engine's reserve-posture flag in lockstep with
  // every actuation-state write (apply, revert, cancel, abort).
  setReserveArbitrageRaised(effectiveArbitragePosture(s, liveReserveSocPct(), Date.now()));
  // v1.115.0 — and the owner floor the runway alarm measures against.
  // v1.119.0 — ALSO push it across the worker boundary: the runway report runs
  // in the analytics worker, where a main-thread module publisher is invisible.
  const ownerFloor = ownerReserveFloorPct(s, liveReserveSocPct(), Date.now());
  setOwnerReserveFloorPct(ownerFloor);
  analytics.pushOwnerFloor(ownerFloor);
  // heldByChargeWrite — and the write the on-peak money detectors measure past (alertMonitor):
  // the prior floor while a restore that did not take leaves our target standing.
  setChargeWriteHold(chargeWriteHold(s));
  try {
    // v1.189.0 — the whole cycle (chargeCycle.serializeCycle): the active leg at the top level.
    atomicWriteFileSync(NIGHT_CHARGE_ACTUATION_PATH, JSON.stringify(serializeCycle(nightCycleView())));
  } catch (e: any) {
    app.log.debug(`night-charge: actuation persist failed (${e?.message ?? e})`);
  }
}

/** v1.189.0 — persist a whole cycle: its pending and trailing legs, then the active leg (which
 *  publishes the posture, the owner floor and the write hold, and writes the file). */
function persistCycle(c: ChargeCycleState): void {
  nightCyclePending = c.pendingLegs;
  nightCycleTrailing = c.trailing;
  persistNightActuation(c.active);
}

/** v1.189.0 — persist the trailing leg, only while it is still the one on record: the evening job
 *  re-arming the cycle during a trailing step's await must not have its record overwritten. */
function persistTrailing(t: NightActuationState): void {
  const cur = nightCycleTrailing;
  if (cur == null || cur.day !== t.day || cur.windowStartMs !== t.windowStartMs) {
    app.log.warn(`night-charge: trailing-leg write for ${t.day ?? '—'} dropped — the cycle no longer holds that leg.`);
    return;
  }
  persistCycle({ ...nightCycleView(), trailing: asChargeLeg(t, cur) });
}

/**
 * v1.189.0 — where a force-charge step's record lives: the active leg, or the trailing one. The
 * escalation (escalateForceChargeStuck) writes through it, so a trailing leg's page is recorded on
 * the trailing leg.
 */
interface LegSlot {
  get(): NightActuationState;
  put(s: NightActuationState): void;
}
const ACTIVE_LEG: LegSlot = { get: () => nightActuationMem, put: (s) => persistNightActuation(s) };
const TRAILING_LEG: LegSlot = {
  get: () => nightCycleTrailing ?? emptyActuationState(),
  put: (s) => persistTrailing(s),
};

/** v1.189.0 — a leg's ledger stamp, to its leg's columns (chargeCycle.legLedgerFields: a backup
 *  leg's go to backup_*; one with no backup column is not written). Never throws. */
function stampLegOutcome(leg: NightActuationState & { leg?: ChargeLegRole }, fields: Partial<NightLedgerRow>): void {
  if (leg.day == null) return;
  const cols = legLedgerFields(legRoleOf(leg), fields as Record<string, unknown>) as Partial<NightLedgerRow>;
  if (Object.keys(cols).length === 0) return;
  try { recorder.recordNightOutcome(leg.day, cols); }
  catch (e: any) { app.log.warn(`night-charge: ledger stamp failed for ${leg.day} (${e?.message ?? e})`); }
}

/** v1.189.0 — the house panel's backup reserve from a FRESH readback (the reserve step's R3 rule:
 *  a frozen projection never decides), or null. */
function freshReserveReadingPct(nowMs: number): number | null {
  const shp2 = findShp2(store.get().devices);
  const sp: any = shp2 && shp2.projection?.kind === 'shp2' && shp2ReadbackFresh(shp2, nowMs) ? shp2.projection : null;
  return typeof sp?.backupReserveSoc === 'number' ? sp.backupReserveSoc : null;
}

// v1.191.0 (lane A, T2) — the clock text ("10:55 PM") and weekday of an instant are siteTime.ts
// fmtSiteClock / fmtSiteWeekday (the site zone; en-US parts and a fixed Spanish map, never an `es`
// locale). They were fmtPhoenixClock / fmtPhoenixWeekday here, pinned to the reference zone.

/**
 * DAY-QUALIFIED deadline text for the supervised announcement (v1.51.2).
 *
 * ★ The cancel deadline is the owner's control point, so it must never be
 * ambiguous about WHICH night it names. Weekend tariff semantics routinely
 * resolve a Saturday-evening plan's charge window to Monday 00:00 — the write
 * moment is then ~28 h out, and a bare "11:55 PM" reads as tonight. This is the
 * same failure v1.39.0 fixed for the published window entities via
 * `fmtSiteDayHm`; the announcement needs the identical discipline.
 *
 * Beyond 24 h the weekday is spelled out ("on Sunday at 11:55 PM"); inside 24 h
 * the bare clock time is unambiguous and reads naturally in speech.
 */
function fmtDeadlineSpoken(ms: number, nowMs: number): string {
  const hm = fmtSiteClock(ms);
  if (ms - nowMs < 24 * HOUR_MS) return `at ${hm}`;
  const wd = fmtSiteWeekday(ms);
  return wd ? `on ${wd} at ${hm}` : `at ${hm}`;
}

/** v1.67.0 — Spanish counterpart of fmtDeadlineSpoken for the bilingual second
 *  pass. Same shape and the same clock string; only the framing is translated
 *  (the weekday through siteTime.ts's fixed Spanish map). */
function fmtDeadlineSpokenEs(ms: number, nowMs: number): string {
  const hm = fmtSiteClock(ms);
  if (ms - nowMs < 24 * HOUR_MS) return `a las ${hm}`;
  const es = fmtSiteWeekday(ms, 'es');
  return es ? `el ${es} a las ${hm}` : `a las ${hm}`;
}

// In-memory cache of the last 7 ledger rows for the read-only status route, so
// that handler never performs a per-request SQLite (filesystem) read — CWE-770 /
// CodeQL js/missing-rate-limiting. Refreshed by the background recompute tick /
// evening job (timers, not rate-limited request handlers), matching how the
// other read endpoints serve worker/holder data rather than hitting the DB inline.
let nightRecentOutcomesMem: unknown[] = [];
function refreshNightRecentOutcomes(): void {
  try { nightRecentOutcomesMem = recorder.readNightLedger(7); }
  catch { /* keep the last cached value; the route must never touch the DB */ }
}

// v1.191.0 (T3) — the minute of the day the ~21:30 gates read is siteTime.ts siteMinuteOfDay (the
// site zone, never the host clock); it was phoenixMinuteOfDay here.

// v1.70.0 — apsREvRatesFromEnv moved to tariff.ts so alertMonitor's on-peak
// grid-draw detector reads the SAME tariff this file does. See tariff.ts.

// v1.191.0 (W1) — the cheap period the advisor sizes the buy against is the tariff's own, read at
// each evaluation: tariff.ts cheapPeriodIdOf (the APS preset's OVERNIGHT tier; the period a custom
// plan flags `cheap`; NIGHT_CHARGE_CHEAP_PERIOD's; null when the plan has none, so no window). It
// was the constant APS_PERIOD.OVERNIGHT here, which no other plan's period table names.
/** N_MIN scored calibration days before the band is trusted (design §2.3). */
const NIGHT_MIN_CAL_DAYS = 14;

/** Extras carried alongside the plan so the evening job can map plan+inputs →
 *  the snake_case NightLedgerRow columns the pure plan doesn't itself carry. */
interface NightPlanExtras {
  socNowPct: number;
  fullKwh: number;
  cushionPct: number;
  cushionKwh: number;
  horizonHours: number;
  pvP10Kwh: number; pvP50Kwh: number; pvP90Kwh: number;
  loadP10Kwh: number; loadP50Kwh: number; loadP90Kwh: number;
  evP90SessionKwh: number | null; evSessionCount: number | null;
  bandSigmaCal: number | null;
  calScoredDays: number;
  forecastBasis: string;
  weatherCovered: number;
  tariffSnapshot: string;
  /** v1.174.0 — how old the panel reading the plan was sized on, seconds (null = unknown). */
  panelSampleAgeS: number | null;
  /** v1.187.0 — the Cores the PV band's solar model was fitted on (sorted, comma-joined);
   *  null = unknown. Optional: a plan snapshot persisted before v1.187.0 has none. */
  pvModelSns?: string | null;
  /** R4 — a shadow leg only: the P50 PV and the median house load over its window, kWh (null unless
   *  the band covers every hour of it). Absent on every live plan. */
  windowPvP50Kwh?: number | null;
  windowLoadP50Kwh?: number | null;
  /** R5 — a pinned leg only (the shadow, the morning refresh): when the weather its band was built
   *  on was fetched; null when unknown. Absent on every evening and tick plan. */
  weatherFetchedAtMs?: number | null;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

/**
 * Assemble a NightChargeInputDeps from the LIVE analytics reports + SHP2
 * projection, size the plan, and latch it in the holder. Returns the plan plus
 * the ledger extras (or null when inputs cannot be constructed — SHP2 offline /
 * missing battery fields, I5). Direct orchestration (NOT createNightChargeAdvisor.
 * update() — buildInputs there is synchronous, but we need awaited analytics).
 */
async function recomputeNightChargePlan(
  opts: { allowStalePanel?: boolean; role?: ChargeLegRole; shadowLeg?: ShadowLegSizing; maxWeatherAgeMs?: number } = {},
): Promise<{ plan: NightChargePlan; extras: NightPlanExtras } | 'panelStale' | null> {
  const nowMs = Date.now();
  // R4 — a mid-day cycle's leg sized in SHADOW (middayShadow.ts): its window, horizon end and PV
  // surplus span are pinned by the caller, and the plan is RETURNED ONLY — it is never set as the
  // latest plan (the night-charge entities, the card and the status keep the live overnight plan),
  // never persisted as the plan snapshot, and never logged as a calibration change.
  const shadowLeg = opts.shadowLeg ?? null;
  // R2 — the leg's role sets its objective and force-charge (legObjective, forceChargeOn). Every
  // live caller plans the overnight cost leg.
  const legRole: ChargeLegRole = shadowLeg?.spec.role ?? opts.role ?? 'cost';
  const shp2 = findShp2(store.get().devices);
  if (!shp2 || shp2.projection?.kind !== 'shp2') return null; // I5 — advisory null
  // v1.174.0 — the R3 freshness gate the actuator and force-charge ticks already apply.
  // A stale panel is NOT an incomplete basis: 'panelStale' tells the caller to retry
  // (the 30-min tick keeps the previous plan; the evening job defers without latching).
  // Only the evening job's last resort passes allowStalePanel — see nightPlanPanelVerdict.
  const panel = nightPlanPanelVerdict(shp2, nowMs, opts.allowStalePanel === true);
  if (!panel.use) return 'panelStale';
  const sp: any = shp2.projection;

  const fullWh: number | null = sp.backupFullCapWh ?? null;
  const socNowPct: number | null = sp.backupBatPercent ?? null;
  const remainWh: number | null = sp.backupRemainWh ?? null;
  // v1.116.0 — the OWNER's floor, not the device's current instruction. The
  // plan is recomputed every ~30 min, INCLUDING while our own night-charge
  // write holds the reserve at 50 — so a mid-window recompute sized against
  // floor+cushion = 50+15 = 65%, treating our instruction as the owner's
  // requirement. Third sibling of the same defect: v1.113.0 fixed the
  // below-reserve alert, v1.115.0 the runway alarm, this is the planner.
  const reserveFloorPct: number | null =
    ownerReserveFloorPct(nightActuationMem, sp.backupReserveSoc ?? null, nowMs);
  if (fullWh == null || fullWh <= 0 || socNowPct == null || reserveFloorPct == null) return null; // I5
  const fullKwh = fullWh / 1000;

  // I11 — SoC coherence (% vs remainWh/fullWh). false ⇒ the sizer returns null.
  const socCoherent = remainWh != null && Math.abs((remainWh / fullWh) * 100 - socNowPct) <= 8;

  // Verified efficiency seams (injected, never hard-coded downstream).
  const legEff = Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY); // ≈ 0.927
  const dischargeEff = RUNWAY_DISCHARGE_EFFICIENCY;         // ≈ 0.94

  // Operator knobs. v1.191.0 (S3b) — each through its config.ts row, with the rule it had here.
  const cushionPct = option<number>('ARB_OUTAGE_CUSHION_PCT');
  // v1.125.0 — the outage the cushion is sized to survive, and the multiplier on
  // the observed islanded load. See outageCushionKwh for why the cushion is no
  // longer a flat share of pool measured against a whole-house forward sim.
  const outageCushionHours = option<number>('ARB_OUTAGE_CUSHION_HOURS');
  // v1.127.0 — buy objective. 'cost' maximises arbitrage against the configured
  // tariff; 'resilience' (legacy) sizes only to hold floor+cushion. Cost mode is
  // bounded below by the resilience answer, so it can never buy less.
  const objectiveMode = legObjective(legRole, option<'cost' | 'resilience'>('ARB_OBJECTIVE'));
  const costMaxSocPct = option<number>('ARB_COST_MAX_SOC_PCT');
  const islandedLoadSafety = option<number>('ARB_ISLANDED_LOAD_SAFETY');
  // v1.173.0 — 0 (default) = AUTO: connected Cores × the proven per-Core rate (planChargeCapKw).
  const planConnectedSlots = Array.isArray(sp.sources)
    ? sp.sources.filter((c: any) => c?.hwConnect === true && Number.isInteger(Number(c?.slot))).length
    : null;
  const chargeCapKw = planChargeCapKw(option<number>('ARB_CHARGE_CAP_KW'), planConnectedSlots, legEff);
  // v1.60.0 — the SHARED grid-input envelope the charger and the house both draw
  // from. Default 17 kW is the COEXISTENCE figure measured on 2026-08-02→03: at
  // 03:00 `panel_load` held 14.0 kW (EVSE ~11.5 kW + ~2.5 kW baseline) while the
  // packs still took ~2.8 kW (battery_net −2,757 W ⇒ ~3.0 kW at the meter after
  // the charge leg) — 14.0 + 3.0 ≈ 17. The raw grid-input reading that night was
  // ~19 kW; the lower coexistence figure is used deliberately, because
  // UNDER-stating the envelope under-states the buy we can deliver, which is the
  // safe (honest-shortfall) direction. Set ≤0 to disable contention modelling.
  const gridInputCapKw = gridInputCapKwFromEnv();
  // v1.106.0 — the load band is calibrated from realized error, floored at the
  // historical hand-set 1.15 so it can only widen. Only loadP90W feeds sizing,
  // and a wider P90 buys more — the safe direction for an asymmetric under-buy
  // miss. `basis` is surfaced on the plan so the number is auditable.
  const loadBandFloor = option<number>('ARB_LOAD_P90_FACTOR');
  const loadBandCal = calibratedLoadBandFactor(
    (() => {
      try { return recorder.readNightLedger(120).map((r: any) => r.load_err_frac as number | null); }
      catch { return []; }
    })(),
    { floor: loadBandFloor, cap: Number(process.env.ARB_LOAD_P90_CAP ?? 2.0) },
  );
  const loadP90Factor = loadBandCal.factor;
  // v1.112.0 — buy de-bias from realized nights (announcement-only; see
  // calibratedBuyDebiasFactor). Log on change, like the load band.
  // R4 — the de-bias stratum of the leg's window kind (calibratedBuyDebiasFactor): the overnight
  // rows for every live plan, as before.
  const buyDebiasCal = calibratedBuyDebiasFactor(
    (() => { try { return recorder.readNightLedger(120); } catch { return []; } })(),
    { windowKind: shadowLeg?.spec.kind ?? 'overnight' },
  );
  if (!shadowLeg && buyDebiasCal.basis === 'measured' && buyDebiasCal.factor > 1.005) {
    const key = `${buyDebiasCal.factor.toFixed(3)}:${buyDebiasCal.samples}`;
    if (key !== lastLoggedBuyDebiasKey) {
      lastLoggedBuyDebiasKey = key;
      app.log.info(
        `night-charge: announced buy calibrated ×${buyDebiasCal.factor.toFixed(2)} from ${buyDebiasCal.samples} realized night(s) `
        + `(raw plan figure is unchanged in the ledger; median delivered/planned, floor 1.0 — only ever raises the announcement)`,
      );
    }
  }
  // v1.144.0 — the SILENT case. The "calibrated ×N" line above only ever fires
  // on a measured result, so a learner selecting ZERO eligible rows says nothing
  // at all and its 1.000 reads as "measured, no bias". It is not: the eligibility
  // filter requires `!(cushion_shortfall === 1)` and that flag is 1 on every
  // ledger row, so the sample set is empty and the floor is returned. Say so
  // once, on change, with the reason — delivered/planned has run 1.44-1.55x on
  // every actuated-and-scored night while this reported no bias.
  // v1.187.3 — and says how many rows were set aside for their delivered_kwh basis (the
  // pre-v1.187.3 import − house-load estimate is never a sample), so a reset to 'default'
  // after the upgrade reads as what it is. The key and text are buyDebiasUnmeasuredLogLine's.
  const buyDebiasUnmeasured = shadowLeg ? null : buyDebiasUnmeasuredLogLine(buyDebiasCal);
  if (buyDebiasUnmeasured && buyDebiasUnmeasured.key !== lastLoggedBuyDebiasKey) {
    lastLoggedBuyDebiasKey = buyDebiasUnmeasured.key;
    app.log.info(buyDebiasUnmeasured.text);
  }
  if (!shadowLeg && loadBandCal.basis === 'measured' && loadBandCal.factor > loadBandFloor) {
    // v1.108.0 — this evaluation runs every 30 min; the calibration only moves
    // when the night ledger grows. Log on CHANGE, not on every look (the 08-24
    // audit counted 48 identical lines/day).
    const bandKey = `${loadBandCal.factor.toFixed(3)}:${loadBandCal.samples}`;
    if (bandKey !== lastLoggedLoadBandKey) {
      lastLoggedLoadBandKey = bandKey;
      app.log.info(
        `night-charge: load band calibrated to ±${((loadBandCal.factor - 1) * 100).toFixed(0)}% `
        + `from ${loadBandCal.samples} realized night(s) (was the hand-set ±${((loadBandFloor - 1) * 100).toFixed(0)}%; `
        + `only widens, and only loadP90 feeds sizing)`,
      );
    }
  }
  // v1.191.0 — the one EV_MAX_LOAD_W reader (limits.ts; it was parsed here a second time, unclamped).
  const evMaxLoadW = limits.evMaxLoadW;
  const minBuyKwh = option<number>('ARB_MIN_BUY_KWH');

  // Tariff period resolver (the plan in effect on the site clock: R-EV while TARIFF_PLAN is unset).
  // Cents may be unconfirmed — periodId is structural and needs no confirmed rate.
  const tariffModel = tariffModelFromEnv();
  const periodIdAt = (ts: number): string => rateAt(tariffModel, ts).periodId;
  // v1.191.0 (W1) — the plan's cheap period ('overnight' on the APS preset); null: no window.
  const cheapPeriodId = cheapPeriodIdOf(tariffModel);
  // v1.191.0 (review) — one night of it at a time: a weekend-long off-peak run is a window a night
  // (chargeWindows.ts cheapNightOf; null on the APS preset, whose windows are unchanged).
  const cheapNight = cheapNightOf(tariffModel);
  // v1.191.0 (S6) — its schedule: the full-window minimum below, the snapshot's notify time.
  const nightSched = nightScheduleNow(tariffModel);

  // Live analytics reports (each best-effort — a missing report degrades the
  // basis to null, never a fabricated number).
  // R5 — the morning refresh asks for a forecast on weather at most `maxWeatherAgeMs` old (the
  // worker re-fetches older weather; the band says when its weather was fetched). Every other
  // caller passes none: the two reports are requested exactly as before.
  const wxAge = opts.maxWeatherAgeMs;
  const [prob, multiDay, dayAhead, evReport] = await Promise.all([
    (wxAge != null
      ? analytics.report<ProbabilisticForecast>('probabilisticForecast', { maxWeatherAgeMs: wxAge })
      : analytics.report<ProbabilisticForecast>('probabilisticForecast')).catch(() => null),
    analytics.report<MultiDayForecast>('multiDayForecast', { days: 4 }).catch(() => null),
    (wxAge != null
      ? analytics.report<DayForecast>('forecast', { maxWeatherAgeMs: wxAge })
      : analytics.report<DayForecast>('forecast')).catch(() => null),
    analytics.report<EvWindowPrediction>('evWindowPrediction').catch(() => null),
  ]);

  // Day-ahead hours by hour-epoch — the load side (probabilistic band is PV-only).
  const dayAheadByEpoch = new Map<number, ForecastHour>();
  for (const fh of dayAhead?.hours ?? []) dayAheadByEpoch.set(Math.floor(fh.ts / HOUR_MS), fh);

  // bandHours (within-24 h authoritative band): PV P10 from the probabilistic
  // forecast; load P90 = day-ahead forecastLoadW × ARB_LOAD_P90_FACTOR. The
  // day-ahead forecast folds an EXPECTED-VALUE EV block (predictedEvLoadW) into
  // forecastLoadW, so embeddedEvW is that component ALSO scaled by the P90 factor
  // (it sits inside the scaled loadP90W) — the advisor subtracts it before
  // placing the committed p90SessionKwh block, so EV is never double-counted (§2.3).
  const bandHours: NightForecastHour[] = [];
  for (const pb of prob?.hours ?? []) {
    const fh = dayAheadByEpoch.get(Math.floor(pb.ts / HOUR_MS));
    if (!fh) continue; // no load side for this hour → skip (band must carry both)
    bandHours.push({
      ts: pb.ts,
      pvP10W: pb.p10W,
      loadP90W: fh.forecastLoadW * loadP90Factor,
      embeddedEvW: (fh.predictedEvLoadW ?? 0) * loadP90Factor,
      // v1.187.22 — the MEDIAN load and PV, for the expected-buy disclosure only: forecastLoadW
      // WITHOUT the P90 factor, its expected-value EV left in (never the committed P90 block).
      loadP50W: fh.forecastLoadW,
      pvP50W: pb.p50W,
    });
  }

  // dayRollups (beyond the 24 h band): multi-day hourly {ts,pvW,loadW}. The
  // merge in buildNightChargeInputs is keyed by ts and the band always wins, so
  // day-0 overlap hours are superseded; daysAhead widens the daily P10/P90.
  const dayRollups: NightDayRollup[] = (multiDay?.days ?? []).map((d, idx) => ({
    daysAhead: idx,
    hours: d.hours.map((h) => ({ ts: h.ts, pvW: h.pvW, loadW: h.loadW })),
  }));

  const realizedDailyErrHalfFrac = prob?.realizedDailyErrHalfFrac ?? 0;
  const calScoredDays = prob?.calScoredDays ?? 0;
  const bandCoverageFrac = (prob?.bandRealizedCoveragePct ?? 0) / 100;

  // Cheap window (needed here for nextRecharge + morning-surplus bounds; the
  // sizer resolves it again from the same resolver — identical result).
  // R4 — a shadow leg's window is the one the chooser pinned.
  const window = shadowLeg ? (shadowLeg.spec.window ?? null)
    : cheapPeriodId == null ? null : resolveCheapWindow(periodIdAt, nowMs, cheapPeriodId, 30, cheapNight);
  const windowEndMs = window?.endMs ?? nowMs;

  // nextRecharge = the START of the NEXT cheap charge window after tonight's —
  // the next time we can cheaply top up (design §2.4). Tariff-based and
  // deterministic: a single transient sunny hour, OR a CENTRAL-forecast pv≥load
  // crossing that the P10-PV/P90-load sim would still be draining through, can no
  // longer truncate the multi-day carry. On a weekday this lands ~tomorrow night.
  // ★ WEEKEND SEMANTICS (v1.39.0 honesty pass): tariff.ts gates OVERNIGHT on
  // each hour's own calendar weekday, so the model's Friday window is Fri
  // 23:00–24:00 ONLY (Sat 00:00–05:00 = weekend off-peak) and the next window
  // opens Mon 00:00 — a ~48 h carry, sized against a 1-hour charge window
  // (charge-power capped, cushionShortfall honestly flagged). Whether the REAL
  // APS R-EV extends Friday's overnight into Saturday 00:00–05:00 is an OPEN
  // tariff question only the owner's bill can settle; if it does, the fix
  // belongs in tariff.ts's weekday gating, not here. Scan 4 days to bridge
  // the weekend gap either way.
  // R2 — nextChargeableOpenMs over the overnight cycle: the same 96 h overnight scan.
  // R4 — a shadow leg's horizon end is its own (option A for the backup, 23:00 for the mid-day leg).
  const nextRechargeMs: number | null = shadowLeg ? shadowLeg.nextRechargeMs : nextChargeableOpenMs(tariffModel, windowEndMs + HOUR_MS);

  // morningPvSurplusP90Kwh — the over-buy ceiling headroom. Sum over the next
  // solar day (window-end → +14 h) of max(0, P90 PV − forecast load). P90 PV =
  // the probabilistic p90W (best case) — the deliberate asymmetry so we never
  // over-buy into morning-PV clipping. null when the band doesn't cover it.
  // v1.168.0 — the MEDIAN surplus, over the same hours: what the cost ceiling leaves
  // room for. Null unless every covered hour carries a finite p50W.
  // R2 — the sums are chargeTaper.ts pvSurplusFromBand, the span its surplusSpanEndMs (an
  // overnight window: close + 14 h).
  const morningEndMs = shadowLeg ? shadowLeg.surplusEndMs : surplusSpanEndMs('overnight', windowEndMs, null);
  const { p90Kwh: morningPvSurplusP90Kwh, p50Kwh: morningPvSurplusP50Kwh } = window
    ? pvSurplusFromBand({
      hours: prob?.hours ?? [],
      loadAt: (ts) => dayAheadByEpoch.get(Math.floor(ts / HOUR_MS))?.forecastLoadW,
      fromMs: windowEndMs,
      toMs: morningEndMs,
    })
    : { p90Kwh: null, p50Kwh: null };
  // v1.187.1 — the cost ceiling's surplus on a DE-BIASED load (buildCostSurplusLoad): the
  // forecast load ran above the measured load on every readable ledger night of 2026-09-23..29
  // (load_err_frac −0.29 to −0.43), so the surplus above left too little room and the pool
  // filled by 13:00 on 09-30 with ~9-12 kWh of PV curtailed. Cost mode only, the same hours as
  // above, and only where it widens the headroom (the planner's debiasedCostSurplusKwh); the
  // raw P90 above stays the over-buy flag.
  const costLoadBuilt = await buildCostSurplusLoad({
    objectiveMode,
    nowMs,
    probHours: window ? (prob?.hours ?? []) : [],
    loadAt: (ts) => dayAheadByEpoch.get(Math.floor(ts / HOUR_MS)),
    fromMs: windowEndMs,
    toMs: morningEndMs,
    readLedger: (days) => recorder.readNightLedger(days),
    fetchHourlyLoad: (fromMs, toMs, bucketS) => analytics.query(shp2.sn, 'panel_load', fromMs, toMs, bucketS),
    hourOf: (ts) => localParts(ts, tariffModel.timezone).hour,
  });
  const costSurplusLoad: NightChargeInputDeps['costSurplusLoad'] = costLoadBuilt?.load ?? null;
  if (costLoadBuilt && !shadowLeg) {
    const { load: cl, medianRatio, floored } = costLoadBuilt;
    const key = `${cl.factor.toFixed(3)}:${cl.samples}:${floored ? 'floor' : 'nofloor'}`;
    if (key !== lastLoggedCostLoadKey) {
      lastLoggedCostLoadKey = key;
      app.log.info(
        `night-charge: cost-ceiling surplus counts the house load at ×${cl.factor.toFixed(2)} of its forecast `
        + `(median realized/forecast ${medianRatio?.toFixed(2) ?? '—'} over ${cl.samples} ledger night(s)`
        + `${floored ? '' : '; no measured hourly floor, so every hour keeps its forecast'}) — cost ceiling only, `
        + `never past the resilience target nor on a cushion-shortfall night; P50 surplus ${morningPvSurplusP50Kwh ?? '—'} → ${cl.p50Kwh ?? '—'} kWh`,
      );
    }
  }
  // v1.168.0 — the Thursday rule, from the tariff calendar: tonight is a full window and
  // the next full one is more than a day after it (short windows stepped over).
  // R4 — the Thursday rule is the overnight cycle's: a shadow leg is followed by a chargeable window
  // the same evening (the mid-day leg) or sized for resilience only (the backup).
  const nightLongGapAhead = shadowLeg ? false : longGapAhead(
    window,
    window && cheapPeriodId != null ? nextFullCheapWindow(periodIdAt, window.endMs, cheapPeriodId, 120, nightSched.fullWindowMinMs, cheapNight) : null,
    nightSched.fullWindowMinMs,
  );
  // v1.186.0 — the PESSIMISTIC (P10) surplus from window close to the evening on-peak
  // start: the headroom a long-gap night keeps (null ⇒ set aside, the full buy stands).
  const prePeakP10Hours: Array<{ ts: number; p10W: number; loadW: number }> = [];
  for (const pb of prob?.hours ?? []) {
    const fh = dayAheadByEpoch.get(Math.floor(pb.ts / HOUR_MS));
    if (fh) prePeakP10Hours.push({ ts: pb.ts, p10W: pb.p10W, loadW: fh.forecastLoadW });
  }
  const prePeakPvSurplusP10Kwh = window && !shadowLeg
    ? pessimisticPrePeakSurplus({
      hours: prePeakP10Hours,
      windowEndMs: window.endMs,
      isOnPeakAt: (ts) => rateAt(tariffModel, ts).isOnPeak,
    }).kwh
    : null;

  // Committed-EV worst case: next predicted session start (>= now-hour), the p90
  // session energy, and the observed session count (tail-sufficiency).
  let ev: NightEvCommit | null = null;
  if (evReport) {
    const nowHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const candidates = (evReport.upcomingNext24h ?? [])
      .filter((e) => e.ts + (e.durationHours ?? 0) * HOUR_MS > nowMs) // ongoing or future
      .sort((a, b) => a.ts - b.ts);
    ev = {
      p90SessionKwh: evReport.p90SessionKwh ?? null,
      chargeStartMs: candidates.length ? Math.max(candidates[0].ts, nowHour) : null,
      sessionCount: evReport.sessionsObserved ?? 0,
    };
  }

  // Confidence tier — derived from the real-weather horizon vs the plan horizon.
  // forecast = the whole post-window horizon is weather-backed; climatology =
  // no real forecast / the window itself is past the weather horizon; mixed =
  // part of the horizon runs past it (weekend carry beyond the ~4-day forecast).
  let weatherHorizonEndMs: number | null = null;
  try {
    const wx = await getWeather();
    if (wx && wx.hours.length) weatherHorizonEndMs = Math.max(...wx.hours.map((h) => h.ts)) + HOUR_MS;
  } catch { /* weather optional — null ⇒ climatology below */ }
  const horizonEndMs = nextRechargeMs ?? (window ? window.endMs + 24 * HOUR_MS : nowMs + 24 * HOUR_MS);
  let confidenceTier: 'forecast' | 'mixed' | 'climatology';
  if (!(dayAhead?.hasWeather === true) || weatherHorizonEndMs == null) {
    confidenceTier = 'climatology';
  } else if (horizonEndMs <= weatherHorizonEndMs) {
    confidenceTier = 'forecast';
  } else if ((window?.startMs ?? nowMs) >= weatherHorizonEndMs) {
    confidenceTier = 'climatology';
  } else {
    confidenceTier = 'mixed';
  }

  const forecastPresent = bandHours.length > 0;

  const deps: NightChargeInputDeps = {
    nowMs,
    fullKwh, socNowPct, reserveFloorPct, cushionPct, socCoherent,
    // v1.125.0 — ISLANDED load: the SHP2's own circuits, which are what actually
    // run when the grid drops. Null when the SHP2 is not reporting, which fails
    // closed to the legacy flat band rather than granting a weaker guarantee.
    islandedLoadKw: islandedLoadKwNow(),
    outageCushionHours, islandedLoadSafety, objectiveMode, costMaxSocPct,
    legEff, dischargeEff, chargeCapKw, gridInputCapKw,
    periodIdAt, cheapPeriodId, cheapNight, windowScanHours: 30,
    bandHours, dayRollups, realizedDailyErrHalfFrac, nextRechargeMs,
    ev, evMaxLoadW,
    confidenceTier, forecastPresent, calScoredDays, minCalScoredDays: NIGHT_MIN_CAL_DAYS, bandCoverageFrac,
    morningPvSurplusP90Kwh, minBuyKwh,
    morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead, prePeakPvSurplusP10Kwh,
    costSurplusLoad,
    buyDebiasFactor: buyDebiasCal.factor,
    buyDebiasBasis: buyDebiasCal.basis,
    buyDebiasSamples: buyDebiasCal.samples,
    // v1.187.22 — the gate the force-charge itself runs on, so the expected buy reads the level
    // the armed write drives to (armedWriteLevelPct). R2 — the leg's own (forceChargeOn(role)).
    forceChargeEligible: forceChargeOn(legRole),
    // R2 — the leg: the overnight window (resolved above) for every live plan, its role the caller's.
    // R4 — a shadow leg's own spec (its pinned window, taper line and backup hold).
    windowSpec: shadowLeg ? shadowLeg.spec : legRole === 'cost' ? OVERNIGHT_WINDOW_SPEC : { kind: 'overnight', role: legRole },
  };

  const inputs = buildNightChargeInputs(deps);
  const plan = computeNightChargePlan(inputs);
  // v1.174.0 — the evening job's last resort: sized on a stale reading, and it says so.
  if (!panel.fresh) {
    plan.rationale += ` NOTE: sized on a panel reading ${panel.ageMs != null ? `~${Math.round(panel.ageMs / 60_000)} min old` : 'of unknown age'} (${panel.why}) — it did not recover before the deferral deadline. The reserve write and force-charge still wait for a live readback.`;
  }
  // R4 — never a shadow leg: the holder is the live overnight plan the entities, card and status serve.
  if (!shadowLeg) setLatestNightChargePlan(plan);

  // Ledger diagnostics computed over the authoritative 24 h band (where the
  // P10/P50/P90 percentiles are actually defined).
  let pvP10 = 0, pvP50 = 0, pvP90 = 0, loadP50 = 0;
  for (const pb of prob?.hours ?? []) {
    const fh = dayAheadByEpoch.get(Math.floor(pb.ts / HOUR_MS));
    if (!fh) continue;
    pvP10 += pb.p10W / 1000;
    pvP50 += pb.p50W / 1000;
    pvP90 += pb.p90W / 1000;
    loadP50 += fh.forecastLoadW / 1000;
  }
  const season = seasonAt(tariffModel, nowMs); // v1.187.10 — the one season source
  const tariffSnapshot = JSON.stringify({
    planId: tariffModel.planId,
    season,
    periodIdNow: periodIdAt(nowMs),
    ratesConfirmed: tariffModel.ratesConfirmed,
    centsByTier: {
      onPeak: tariffModel.periods.find((p) => p.id === APS_PERIOD.ON_PEAK)?.centsBySeason[season] ?? null,
      overnight: tariffModel.periods.find((p) => p.id === APS_PERIOD.OVERNIGHT)?.centsBySeason[season] ?? null,
      superOffPeak: tariffModel.periods.find((p) => p.id === APS_PERIOD.SUPER_OFF_PEAK)?.centsBySeason[season] ?? null,
      offPeak: tariffModel.offPeak.centsBySeason[season] ?? null,
    },
    demandUsdPerKw: null,
  });

  const extras: NightPlanExtras = {
    socNowPct,
    fullKwh,
    cushionPct,
    // v1.125.0 — record the cushion the plan ACTUALLY applied, not the legacy
    // flat band. The ledger is the evidence base the readiness gate reduces over,
    // so a row that says 15%-of-pool when an islanded-outage cushion was used
    // would misattribute every downstream conclusion.
    cushionKwh: plan.cushionKwh ?? round2((fullKwh * cushionPct) / 100),
    horizonHours: inputs.horizon.length,
    pvP10Kwh: round2(pvP10), pvP50Kwh: round2(pvP50), pvP90Kwh: round2(pvP90),
    loadP10Kwh: round2(loadP50 / loadP90Factor), loadP50Kwh: round2(loadP50), loadP90Kwh: round2(loadP50 * loadP90Factor),
    // v1.123.0 — NULL, not 0. `?? 0` collapsed "no EVSE prediction available"
    // (no history, an EVSE cloud gap, an analytics failure) into a confident
    // "the car will not charge". The ledger shows the artifact directly: the
    // 2026-08-27 row records 0 sessions / 0 kWh and the very next row records 6
    // sessions / 45.1 kWh — a 30-day rolling mining window cannot legitimately
    // gain six historical sessions overnight, so the zeros recorded an
    // unavailable report, not an EV-free history. The advisor's own contract
    // already forbids this read ("a missing evP90W must never be read as zero");
    // the plan-time surface honours it, the recorded row did not. This ledger is
    // the permanent evidence base the readiness gate reduces over, and it is the
    // one column that cannot be reconstructed after the fact.
    evP90SessionKwh: ev?.p90SessionKwh ?? null,
    evSessionCount: ev?.sessionCount ?? null,
    // v1.149.0 — was `?? 1`. A missing probabilistic forecast is not a
    // calibration factor of 1; writing one filed "no forecast" as "calibration
    // neutral" in a durable ledger column, indistinguishable after the fact from
    // a genuine saturated reading. Null over fabrication, as everywhere else.
    bandSigmaCal: prob?.bandSigmaCal ?? null,
    calScoredDays,
    forecastBasis: confidenceTier,
    weatherCovered: dayAhead?.hasWeather ? 1 : 0,
    tariffSnapshot,
    panelSampleAgeS: panel.ageMs != null ? Math.round(panel.ageMs / 1000) : null,
    // v1.187.0 — the fleet the PV band describes, so the scorer can tell a band graded
    // against other Cores' actuals (the 2026-09-27 partial-map restart) from a forecast miss.
    pvModelSns: Array.isArray(prob?.solarModelSns) && prob!.solarModelSns.length > 0
      ? [...prob!.solarModelSns].sort().join(',') : null,
    // R4 — a shadow leg's planned window PV and load (the forecast skill its ledger columns grade).
    ...(shadowLeg && window ? windowP50Kwh(bandHours, window) : {}),
    // R5 — and when the weather its band was built on was fetched (the refresh's freshness test).
    ...(shadowLeg ? { weatherFetchedAtMs: prob?.weatherFetchedAtMs ?? dayAhead?.weatherFetchedAtMs ?? null } : {}),
  };

  // v1.40.0: persist the freshest PRE-WINDOW plan to disk. The evening job's
  // record moment is otherwise a single ~90-minute liveness window
  // (21:30–23:00): a restart/update landing inside it lost the night's plan
  // row entirely (an unlearnable night the gate could only count as missing).
  // The 30-min tick recomputes plans all day, so a late boot inside/after the
  // charge window can still record the last honest pre-window plan of the day
  // (issued_at stays the plan's own generatedAt — never backdated).
  // R4 — keyed by the plan date that owns the cycle (planDateOwningCycle): an overnight window's
  // plan is always this evening's, so every live snapshot keeps its key; never a shadow leg.
  if (!shadowLeg && plan.window && nowMs < plan.window.startMs) {
    try {
      atomicWriteFileSync(NIGHT_CHARGE_PLANSNAP_PATH, JSON.stringify({
        day: planDateOwningCycle({
          nowMs, firstLegStartMs: plan.window.startMs, timezone: siteTimeZone(),
          notifyMinuteOfDay: nightSched.notify.fireMin,
        }),
        plan, extras,
      }));
    } catch (e: any) {
      app.log.debug(`night-charge: plan snapshot persist failed (${e?.message ?? e})`);
    }
  }
  return { plan, extras };
}

/** v1.187.22 — the armed night's EXPECTED buy, read back from its plan row (ledgerExpectedBuyKwh),
 *  for the morning summary and the apply-failure push. null when the row has none or the ledger
 *  cannot be read: the push then states no kWh (the armed record's buyKwh is the worst case). */
function armedExpectedBuyKwh(day: string | null): number | null {
  try {
    return ledgerExpectedBuyKwh(recorder.readNightLedger(14), day);
  } catch (e: any) {
    app.log.debug(`night-charge: expected-buy lookup failed (${e?.message ?? e})`);
    return null;
  }
}

/** Map a fresh plan + extras → the frozen NightLedgerRow PLAN columns and upsert.
 *  For an incomplete-basis plan the trajectory fields are OMITTED (→ NULL) so the
 *  scorer can detect "no basis" via a null min_proj_soc_pct and mark scored=0. */
function recordNightPlanRow(planDate: string, plan: NightChargePlan, extras: NightPlanExtras): void {
  const row: Partial<NightLedgerRow> & { plan_date: string } = {
    plan_date: planDate,
    issued_at_ms: plan.generatedAt,
    algo_version: String(CURRENT_ALGO_VERSION),
    posture: NIGHT_CHARGE_MODE,
    objective: plan.objective,
    rationale: plan.rationale,
    confidence_tier: plan.confidenceTier,
    horizon_hours: extras.horizonHours,
    soc_now_pct: round1(extras.socNowPct),
    target_soc_pct: plan.targetSocPct ?? 0,
    buy_kwh: plan.buyKwh ?? 0,  // ★ RAW, never buyKwhDebiased — the learner reads this column; feeding it the debiased figure would collapse the calibration onto its own output (ratio→1).
    required_extra_kwh: plan.requiredExtraKwh ?? 0,
    reserve_floor_pct: plan.reserveFloorPct,
    cushion_pct: plan.cushionPct,
    cushion_kwh: extras.cushionKwh,
    binding_cap: plan.bindingCap,
    // v1.132.0 — the discriminating field for cost mode. `objective` only says
    // which mode was CONFIGURED plus buy/no-buy; costModeTargetKwh floors at the
    // resilience answer and raises only under a strict inequality, so a
    // 'cost_arbitrage' row can carry zero cost-mode contribution. Persisting the
    // ceiling basis is what makes that answerable from the ledger.
    cost_ceiling_basis: plan.costCeilingBasis ?? null,
    // v1.174.0 — WHICH surplus set the ceiling and whether the long-gap rule did, plus the
    // ceiling itself: cost_ceiling_basis alone cannot say why a ceiling was 90 vs 83.
    cost_surplus_basis: plan.costCeilingSurplusBasis ?? null,
    cost_long_gap: plan.longGapAhead == null ? null : (plan.longGapAhead ? 1 : 0),
    cost_ceiling_soc_pct: plan.costCeilingSocPct ?? null,
    // v1.187.1 (review) — the surplus the ceiling used, the one the forecast load alone gave,
    // and the load factor and ledger nights between them: cost_ceiling_soc_pct alone cannot
    // say whether a 72% ceiling was de-biased, nor what the raw one would have been. Written
    // unconditionally (null in resilience mode), so a re-issued plan never leaves an earlier
    // plan's figures beside its own.
    ...costSurplusLedgerColumns(plan),
    // v1.174.0 — `?? null`: a plan snapshot persisted before the upgrade has no such field.
    panel_sample_age_s: extras.panelSampleAgeS ?? null,
    // v1.187.0 — written unconditionally (null when unknown) so a re-issued plan can never
    // leave an earlier plan's Core set beside its own band.
    pv_model_sns: extras.pvModelSns ?? null,
    pv_p10_kwh: extras.pvP10Kwh,
    pv_p50_kwh: extras.pvP50Kwh,
    pv_p90_kwh: extras.pvP90Kwh,
    load_p10_kwh: extras.loadP10Kwh,
    load_p50_kwh: extras.loadP50Kwh,
    load_p90_kwh: extras.loadP90Kwh,
    ev_p90_session_kwh: extras.evP90SessionKwh == null ? null : round2(extras.evP90SessionKwh),
    ev_session_count: extras.evSessionCount,
    pool_full_kwh: round2(extras.fullKwh),
    band_sigma_cal: extras.bandSigmaCal,
    cal_scored_days: extras.calScoredDays,
    forecast_basis: extras.forecastBasis,
    weather_covered: extras.weatherCovered,
    tariff_snapshot: extras.tariffSnapshot,
    // v1.50.0 — the plan-time cushionShortfall disclosure (§5.1 strike
    // exemption: a disclosed shortfall is physics, not engine fault).
    cushion_shortfall: plan.cushionShortfall ? 1 : 0,
    // v1.186.0 — the trough the cushion test judged and its line: what the scorer
    // grades plan_traj_floor_breached on. Written UNCONDITIONALLY (null on a null plan)
    // so a later plan of record can never leave an earlier plan's trough beside its own
    // cushion_shortfall.
    cushion_trough_soc_pct: plan.cushionTroughSocPct ?? null,
    cushion_line_soc_pct: plan.cushionLineSocPct ?? null,
    // v1.187.22 — the expected buy and start beside buy_kwh (the worst case), so the scorer can
    // grade them. Written unconditionally (null with none) for the same reason as above.
    ...expectedBuyLedgerColumns(plan),
    // v1.189.0 — the cost leg's window (the charge cycle's ledger columns): every plan of record is
    // the overnight leg until the mid-day switch.
    window_kind: 'overnight',
  };
  // Only a plan with a real trajectory records min_proj_soc — a null-basis /
  // insufficient plan leaves it NULL so the scorer recognises "no basis".
  if (plan.minProjSocPct != null) {
    row.min_proj_soc_pct = plan.minProjSocPct;
    if (plan.minProjSocTsMs != null) row.min_proj_soc_ts_ms = plan.minProjSocTsMs;
  }
  // v1.39.0: the §3.1 frozen plan column soc_at_window_start_pct was declared in
  // the schema but never written (NULL on every row) — it now records the plan's
  // own projected pack SoC entering the charge window (the pre-window carry).
  if (plan.projSocAtWindowStartPct != null) row.soc_at_window_start_pct = plan.projSocAtWindowStartPct;
  // v1.39.0 (2nd adversarial pass): freeze the plan's ACTUAL resolved charge
  // window. Weekend plans resolve windows disjoint from the canonical
  // 23:00–05:00 night (a Saturday plan's window is Monday 00:00–05:00), so the
  // scorer/completion gate MUST pair actuals to the real window — without these
  // columns a Saturday night would be captured before its window even opened.
  if (plan.window) {
    row.window_start_ms = plan.window.startMs;
    row.window_end_ms = plan.window.endMs;
  }
  recorder.recordNightPlan(row);
}

// v1.187.0 (review) — integrateWh / coverageFrac (the trapezoid and the 5-min-bucket
// coverage the ledger columns share) moved, unchanged, to nightLedgerScoring.ts.

/** v1.150.0 — minimum PER-CORE PV coverage required before a fleet PV sum may be
 *  written to the DURABLE night-charge ledger. Mirrors the long-standing
 *  `GRID_HOME_MIN_COVERAGE = 0.9` precedent (analytics.ts) rather than inventing
 *  a second convention: both answer "did we actually measure enough of this
 *  window to publish a total?", and 0.9 is the value this codebase already
 *  decided that question with. Applied to the WORST core, never the mean. */
export const PV_LEDGER_MIN_CORE_COVERAGE = 0.9;

/**
 * Score YESTERDAY's plan now that its charge window + 4–7pm have both closed
 * (design §3.1). Measures the actuals we CAN defensibly source from history and
 * records them; the plan-trajectory floor verdict is scored on the plan's own
 * simulated trajectory (§3.3), never on baseline telemetry.
 *
 * ★ FAIL-SAFE (design §"outcome actuals"): in advisory phase the home runs
 *   WITHOUT the pre-buy, and on a grid-tied home its own overnight import can
 *   prop the SoC — so the realized-need buy is only a defensible hindsight
 *   counterfactual on a CLEAN night (near-zero window import). On a propped or
 *   low-coverage night we set scored=0 with an explicit score_notes rather than
 *   fabricate a safety-critical under-buy number. coverage < 0.9 ⇒ scored=0.
 */
/** The scoring spans for one ledger row. v1.39.0 2nd-pass: derived from the
 *  row's OWN stored window when present — weekend plans resolve windows
 *  disjoint from the canonical 23:00–05:00 night (Saturday → Monday
 *  00:00–05:00), and pairing actuals to the wrong night was the very defect
 *  class this release repairs.
 *  v1.187.0 — the on-peak span is no longer plan-date-anchored. "The 4–7 pm of
 *  the plan day" closed ~2.5 h before the ~21:30 plan existed and counted Saturday
 *  and Sunday afternoons (off-peak) as on-peak: the column graded each plan on the
 *  PREVIOUS night's outcome. It is now the on-peak period the plan GOVERNS — the
 *  first on-peak run after its own window closes, before the next window opens —
 *  resolved from the tariff model (governedOnPeakSpan); null when there is none. */
interface NightScoringSpans {
  windowStart: number;
  windowEnd: number;
  /** v1.187.0 — the governed on-peak period, or null (Friday, a holiday). */
  onpeak: TimeSpan | null;
  scoreSpanEnd: number;
  completeMs: number;
  /** false ⇒ pre-v1.39.0 row with no stored window — actuals CANNOT be paired
   *  to the plan's real window; capture as scored=0, never fabricate. */
  windowKnown: boolean;
  /** R4 — a two-leg (mid-day) row only: the backup and post spans the realized trough is taken
   *  over (nightLedgerScoring.cycleLedgerSpans). Absent on every other row, whose trough is
   *  [window close, scoreSpanEnd) as before. */
  troughSpans?: TimeSpan[];
}
function nightSpansForRow(y: NightLedgerRow): NightScoringSpans | null {
  // v1.191.0 (S6, W4) — the schedule's night (D 23:00 → D+1 05:00, complete D+1 21:00 on the APS preset).
  const b = nightWindowBounds(String(y.plan_date), nightScheduleNow().fallbackNight);
  if (!b) return null; // malformed plan_date
  const ws = typeof y.window_start_ms === 'number' ? y.window_start_ms : null;
  const we = typeof y.window_end_ms === 'number' ? y.window_end_ms : null;
  if (ws != null && we != null && we > ws) {
    // The plan-trajectory score span runs 16 h past the REAL window close (mirrors the
    // canonical 05:00→21:00 trough span). v1.187.0 — and the night completes only once its
    // governed on-peak has closed too (ledgerSpansForWindow). Structural only: period ids
    // and on-peak flags need no confirmed rate.
    const tariff = tariffModelFromEnv();
    // v1.191.0 (W1) — the plan's cheap period, not the APS id: the next window opening is a run of it.
    const cheapId = cheapPeriodIdOf(tariff);
    // R4 — a two-leg (mid-day) row scores its backup, window and post spans and counts both cheap
    // periods for the on-peak attribution (cycleLedgerSpans, ledgerCheapPeriodIds). No row is
    // two-leg before the mid-day switch: every row takes the branch below, as before.
    const cheapIds = ledgerCheapPeriodIds(y.window_kind, cheapId);
    const cycle = cycleLedgerSpans(
      y,
      (t) => rateAt(tariff, t).isOnPeak,
      (t) => cheapIds.includes(rateAt(tariff, t).periodId),
    );
    if (cycle != null) {
      return {
        windowStart: ws, windowEnd: we, onpeak: cycle.onpeak,
        scoreSpanEnd: cycle.scoreSpanEndMs, completeMs: cycle.completeMs, windowKnown: true, troughSpans: cycle.troughSpans,
      };
    }
    const spans = ledgerSpansForWindow(
      we,
      (t) => rateAt(tariff, t).isOnPeak,
      (t) => cheapId != null && rateAt(tariff, t).periodId === cheapId,
    );
    return {
      windowStart: ws, windowEnd: we, onpeak: spans.onpeak,
      scoreSpanEnd: spans.scoreSpanEndMs, completeMs: spans.completeMs, windowKnown: true,
    };
  }
  return {
    windowStart: b.windowStartMs, windowEnd: b.windowEndMs, onpeak: null,
    scoreSpanEnd: b.scoreSpanEndMs, completeMs: b.completeMs, windowKnown: false,
  };
}

/** The backfill sweep's reach, in plan days (v1.39.0). v1.187.10 — named: the one-time
 *  forecast-span repair keeps its re-captures inside it. */
const LEDGER_BACKFILL_SWEEP_DAYS = 60;

function scoreCompletedNights(nowMs: number): void {
  const shp2 = findShp2(store.get().devices);
  if (!shp2 || shp2.projection?.kind !== 'shp2') return; // can't source actuals
  const shp2Sn = shp2.sn;
  // v1.188.1 — not before the first scan for held rows has finished: until then a row could be
  // captured on readings the recorder had restated, not measured (heldSamples.ts). The 30-min
  // tick and the evening job retry.
  if (!(recorder.heldSamplesReady?.() ?? true)) {
    app.log.debug('night-charge: outcome capture waits for the first held-sample scan');
    return;
  }
  // v1.39.0: BACKFILL, not exactly-yesterday. The old scorer targeted only
  // localParts(now−24h) — a night left uncaptured across SHP2-wedge / downtime
  // days was orphaned FOREVER once the date advanced (an uncounted MNAR
  // exclusion). 60-day sweep (matching the premature-capture repair window):
  // a night whose raw telemetry (~30 d retention) has aged out captures
  // HONESTLY as scored=0 with null actuals via the guards in scoreNightRow —
  // it does not stay uncaptured forever.
  let rows = recorder.readNightLedger(LEDGER_BACKFILL_SWEEP_DAYS);
  // v1.188.1 — a row captured on held readings is reset first, so the loop below re-captures it.
  if (repairHeldNightOutcomes(rows, shp2Sn, nowMs)) rows = recorder.readNightLedger(LEDGER_BACKFILL_SWEEP_DAYS);
  // ★ THE v1.39.0 COMPLETION GATE (review HIGH ×2): a night may be captured
  // only once its FULL scored span has elapsed — 16 h past its REAL window
  // close. The pre-fix midnight tick captured yesterday's row while its
  // charge window was still OPEN — window coverage ~25% ⇒ scored=0, inverted
  // SoC query ⇒ actuals null — and the idempotence latch then froze those
  // truncated actuals into the never-pruned ledger forever, so the
  // write-readiness gate could never accumulate a single scored night.
  // v1.187.10 — AND only once issue + 24 h has elapsed (ledgerCaptureDueMs): the PV/load
  // actuals cover [issue, +24 h], the span of the P50 they are graded against. A Friday
  // 1 h window completes Saturday 16:00, ~5.4 h before that, and its truncated actuals
  // were frozen in. Already-captured, malformed and in-flight rows are skipped there.
  for (const { row: y, spans: s } of ledgerRowsDueForCapture(rows, nowMs, nightSpansForRow)) {
    try {
      // v1.187.0 — a later plan for the SAME window (Sunday's for Saturday's shared
      // Monday window) is the plan of record: it carries the on-peak and the cost.
      scoreNightRow(y, s, shp2Sn, nowMs, supersedingPlanDate(y, rows));
    } catch (e: any) {
      app.log.debug(`night-charge: scoring ${y.plan_date} skipped (${e?.message ?? e})`);
    }
  }
}

/** Score ONE completed night row. Extracted from the old yesterday-only scorer
 *  so the completion-gated backfill loop above can target ANY uncaptured
 *  plan_date; the night's clock spans come from nightSpansForRow (the same
 *  single source of truth the completion gate uses), never from `now`. */
function scoreNightRow(
  y: NightLedgerRow,
  s: NightScoringSpans,
  shp2Sn: string,
  nowMs: number,
  /** v1.187.0 — the later plan_date that owns this row's window, or null. */
  supersededBy: string | null = null,
): void {
  const yDate = String(y.plan_date);
  // Pre-v1.39.0 rows never recorded their resolved window — the actuals cannot
  // be paired to the plan's REAL charge window (which for weekend plans is a
  // different night entirely). Capture honestly as unscored; never fabricate a
  // cross-span comparison the gate would then learn from.
  if (!s.windowKnown) {
    // v1.132.0 — two different things reach here and they used to print the same
    // note. A row with NO window because the tariff offered none that night
    // (Saturday, on this plan) is a correct, complete row; only a row predating
    // v1.39.0's window columns is a data-vintage problem. Calling a normal
    // windowless Saturday a "pre-v1.39.0 row" sent anyone reading the ledger
    // looking for a migration bug that isn't there.
    const noWindowByDesign = typeof y.window_start_ms !== 'number'
      && typeof y.window_end_ms !== 'number'
      && String(y.algo_version) === String(CURRENT_ALGO_VERSION);
    // v1.187.0 (review) — a plan with no window by design governs no on-peak: basis 'none',
    // so a NULL basis keeps meaning "not measured on the governed basis".
    const wl = windowlessLedgerColumns(noWindowByDesign);
    recorder.recordNightOutcome(yDate, {
      outcome_captured_at_ms: nowMs,
      scored: 0,
      onpeak_basis: wl.onpeakBasis,
      score_notes: (noWindowByDesign
        ? 'not scored — no cheap charge window was resolved for this night, so there is no window to pair actuals to. Expected on a tariff day that offers none; not a defect.'
        : "not scored — the plan's resolved charge window was not recorded (pre-v1.39.0 row); actuals cannot be paired to the real window.")
        + ` ${wl.notes}`,
    });
    return;
  }
  const windowStart = s.windowStart;               // the plan's REAL window open
  const windowEnd = s.windowEnd;                   // the plan's REAL window close
  const scoreFrom = windowEnd;                     // plan trajectory scores post-close
  const spanEnd = Math.min(nowMs, s.scoreSpanEnd); // window close + 16 h (gate ⇒ fully elapsed)
  // PV/load TOTALS are compared against the plan's forecast P50, which covered
  // the ~24 h from issue (~21:30). Integrate actuals over the SAME [issue, +24 h]
  // horizon so pv_err_frac / load_err_frac are like-for-like, not the charge-window span.
  // v1.187.10 — the sweep captures only once that span has elapsed (ledgerCaptureDueMs).
  const fcSpan = forecastActualsSpan(y.issued_at_ms, nowMs);
  const fcSpanStart = fcSpan.startMs;
  const fcSpanEnd = fcSpan.endMs;

  const gridWin = recorder.query(shp2Sn, 'grid_home_w', windowStart, windowEnd);
  // R4 — a two-leg row's trough covers its backup and post spans (cycleLedgerSpans); every other row
  // keeps [window close, close + 16 h).
  const socPts = s.troughSpans == null ? recorder.query(shp2Sn, 'backup_pct', scoreFrom, spanEnd) : [];
  const loadPts = recorder.query(shp2Sn, 'panel_load', fcSpanStart, fcSpanEnd);
  // v1.187.22 — the pool SoC as the window opened: what the plan's expected start and its
  // islanded sizing start (soc_at_window_start_pct) are graded against.
  const windowOpenSocPct = measuredWindowOpenSocPct(
    recorder.query(shp2Sn, 'backup_pct', windowStart - WINDOW_OPEN_SOC_LEAD_MS, windowStart), windowStart);

  // v1.39.0 2nd-pass: null-over-fabrication — zero samples must record NULL,
  // not a "measured" 0 kWh import (matching the on-peak guard below).
  const windowImportKwh = gridWin.length ? round2(integrateWh(gridWin, true) / 1000) : null;
  const winCoverage = round2(coverageFrac(gridWin, windowStart, windowEnd));

  // v1.187.0 — the ON-PEAK outcome (the on-peak period this plan GOVERNS, not the plan
  // day's own 16:00-19:00, which closed before the plan existed), the REALIZED COST and
  // the delivered-energy span are assembled below by assembleNightLedgerColumns
  // (nightLedgerScoring.ts), once the home Cores and the actuation stamp are known.

  // Actual PV = summed pv_total over the SHP2-connected home DPUs (the same
  // basis the forecast PV is built from); actual load = SHP2 panel_load. Both
  // over the forecast horizon [issue, +24 h].
  //
  // v1.150.0 — PER-CORE COVERAGE GATE. This sum previously had none at all, and
  // it is the more dangerous of the two ungated PV sums in this codebase: its
  // output is written PERMANENTLY into the never-pruned night-charge ledger as
  // `actual_pv_kwh`, feeding `pv_err_frac` / `pv_in_band` (readiness band
  // coverage) and, through `buy_err_kwh`, the HARD under-buy safety criterion.
  // A transient skill-report error ages out of a 30-day window; a bad ledger row
  // is durable safety evidence and does not.
  //
  // The failure it admits is not hypothetical. Core 2 recorded ZERO samples of
  // every metric for nine days (2026-08-11..08-19) while Cores 1 and 3 kept
  // writing. Summing `pv_total` over the roster during such a window silently
  // yields a fraction of true production — measured at 32% of the vendor's own
  // daily figure — with nothing in the number saying so.
  //
  // Null over a deflated total, the same rule the rest of this file follows.
  const homeSns = shp2ConnectedDpuSns(store.get().devices);
  // v1.188.1 — HELD TELEMETRY (nightLedgerScoring.heldLedgerVerdict): a home Core or the house
  // panel with an hour or more of the span held — offline in the cloud with its last reading
  // restated, or not recorded at all — leaves its actual empty, and the row is not scored.
  const heldVerdict = heldLedgerVerdict({
    spans: recorder.heldSpans?.(fcSpanStart, fcSpanEnd) ?? [],
    coreSns: [...homeSns], panelSn: shp2Sn, span: { startMs: fcSpanStart, endMs: fcSpanEnd },
  });
  // v1.188.1 (review 5) — each actual is withheld on its own side only (nightLedgerScoring.heldSides).
  const heldSide = heldSides(heldVerdict);
  const deviceNameOf = (sn: string) => store.get().devices[sn]?.deviceName ?? sn;
  let actualPvKwh: number | null = null;
  let actualPvCoverage: number | null = null;
  if (homeSns.size) {
    let pvWh = 0;
    let worstCov = 1;
    for (const sn of homeSns) {
      const pts = recorder.query(sn, 'pv_total', fcSpanStart, fcSpanEnd);
      pvWh += integrateWh(pts, true);
      // Per-core, not fleet-averaged: one dark core in three averages to a
      // healthy-looking 0.67 while the total is a third short. The MINIMUM is
      // the only summary that cannot hide a single dark member.
      worstCov = Math.min(worstCov, coverageFrac(pts, fcSpanStart, fcSpanEnd));
    }
    actualPvCoverage = round2(worstCov);
    const pvHeld = heldSide.pv;
    actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE && !pvHeld ? round2(pvWh / 1000) : null;
    if (pvHeld && heldVerdict != null) {
      app.log.warn(`night-charge ledger: actual_pv_kwh WITHHELD for ${yDate} — ${heldVerdict.pv.map((p) => `${deviceNameOf(p.sn)} ${(p.heldMs / 3_600_000).toFixed(1)} h`).join(', ')} of the span had no fresh readings (held telemetry)`);
    } else if (actualPvKwh == null) {
      app.log.warn(`night-charge ledger: actual_pv_kwh WITHHELD — worst per-core PV coverage ${worstCov.toFixed(2)} < ${PV_LEDGER_MIN_CORE_COVERAGE} over the scored span; a fleet sum across a dark core under-counts and this column is durable`);
    }
  }
  const actualLoadKwh = loadPts.length && !heldSide.load ? round2(integrateWh(loadPts, false) / 1000) : null;

  // Actual min SoC over the scored trajectory span (raw telemetry; used only for
  // soc_min_err, NOT the floor verdict — §3.3).
  // v1.39.0 2nd-pass: median-of-3 filter before the min-scan. The documented
  // SHP2 cloud-reconnect artifact emits a single transient backupBatPercent=0
  // sample (the same artifact behind the historical 50→2% SoC-alarm false
  // cascade); an unfiltered min-scan latches it, fabricating realizedNeed =
  // the full floor+cushion and a false HARD under-buy in the gate's evidence.
  // A 3-sample median kills isolated spikes while passing real sustained lows.
  let actualMinSocPct: number | null = null;
  let actualMinSocTsMs: number | null = null;
  for (const p of medianFilter3(socPts)) {
    if (actualMinSocPct == null || p.value < actualMinSocPct) { actualMinSocPct = p.value; actualMinSocTsMs = p.ts; }
  }
  if (s.troughSpans != null) {
    const low = minOverSpans(s.troughSpans, (a, b) => recorder.query(shp2Sn, 'backup_pct', a, Math.min(nowMs, b)), medianFilter3);
    actualMinSocPct = low?.value ?? null;
    actualMinSocTsMs = low?.ts ?? null;
  }
  if (actualMinSocPct != null) actualMinSocPct = round1(actualMinSocPct);

  const hadBasis = y.min_proj_soc_pct != null; // null ⇒ plan had no trajectory
  // null import (no samples) is NOT clean — it is unknown; covOk=false already
  // forces scored=0 on such nights, this just keeps the flag honest too.
  const cleanBaseline = windowImportKwh != null && windowImportKwh <= limits.cleanBaselineMaxImportKwh; // ARB_MIN_BUY_KWH, second use
  const covOk = winCoverage >= 0.9;

  // v1.50.0 — actuated night: `actuated` was stamped by the actuator at write time, never
  // inferred here. Since v1.105.0 an actuated night is scored on the SAME planner-sizing
  // basis as an advisory one (below), and the clean-baseline requirement does not apply to
  // it. Its delivered energy (`delivered_kwh`; v1.187.3: measured into the Cores,
  // deliveredIntoCores) is recorded for the buy de-bias learner only and is NOT part of
  // buy_err_kwh.
  const wasActuated = y.actuated === 1 || (y.actuated as unknown) === true;
  // v1.187.0 — the on-peak, realized-cost, delivered-energy and PV-evidence columns, pure
  // (nightLedgerScoring.assembleNightLedgerColumns) behind a query seam on the house panel:
  //  - on-peak over the governed span (2026-09-28's 4.27 kWh on-peak buy belongs to the
  //    cancelled weekend arm behind it, not the clean 09-28 night); none on a superseded
  //    row (the later plan carries it) and null — never 0 — when none is governed;
  //  - realized cost: metered import × the tariff's own rate per interval (rateAt — the
  //    table the Grid Cost sensor and the planner use) over [window open, close + 16 h),
  //    null with the reason in score_notes;
  //  - delivered energy (v1.115.0: integrate the span the write was actually HELD, since
  //    it feeds the v1.112.0 buy de-bias calibrator) to the restore's own stamp + the
  //    device settle (deliveredHoldSpan); v1.187.3 — measured INTO the Cores on the house
  //    panel's source channels the hold recorded, plus any slot connected now
  //    (deliveredIntoCores), not import − house load, which under-counted every night the
  //    SHP2 ran the house from the pack;
  //  - the PV set-aside: a band built for other Cores than the actuals'.
  const tariffNow = tariffModelFromEnv();
  const cols = assembleNightLedgerColumns({
    row: y,
    actuated: wasActuated,
    windowStartMs: windowStart,
    windowEndMs: windowEnd,
    scoreSpanEndMs: s.scoreSpanEnd,
    onpeak: s.onpeak,
    supersededBy,
    query: (metric, a, b) => recorder.query(shp2Sn, metric, a, b),
    rateAt: (t) => rateAt(tariffNow, t),
    homeSns: [...homeSns],
    houseConnectedSlots: houseConnectedSlots(store.get().devices, shp2Sn),
  });
  const deliveredKwh = cols.deliveredKwh;
  const onpeak = cols.onpeak;

  // v1.105.0 (algo v3) — realized need on the PLANNER-SIZING basis.
  //
  // `buy_err_kwh` now answers exactly ONE question: did the planner size the buy
  // correctly? A planner sizes from its forecast, so its sizing error IS its
  // forecast error in kWh. The previous definition mixed in the actuator's own
  // delivered energy (over-delivery is BY DESIGN and was scored as under-buy)
  // and anchored on a 16h-post-window trough that is really the reverted reserve
  // setpoint — together a systematic −62 kWh across four nights that produced a
  // 56% "under-buy rate" no forecast improvement could ever move.
  //
  // The same basis is used for actuated and advisory nights, deliberately: one
  // column must mean one thing. Delivery quality is a SEPARATE question and is
  // not what this metric is for.
  let realizedNeedBuyKwh: number | null = null;
  let scored = 0;
  let scoreNotes: string;
  const legEff = Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY);
  const fcPv = y.pv_p50_kwh ?? null;
  const fcLoad = y.load_p50_kwh ?? null;
  if (!hadBasis) {
    // v1.188.1 (review) — with the held verdict when there is one: the marker keeps the held
    // repair from resetting this row on every sweep (basisIncompleteNote).
    scoreNotes = basisIncompleteNote(heldVerdict, deviceNameOf);
  } else if (heldVerdict != null) {
    scoreNotes = heldLedgerNote(heldVerdict, deviceNameOf);
  } else if (!covOk) {
    scoreNotes = `not scored — overnight grid_home_w coverage ${(winCoverage * 100).toFixed(0)}% < 90% (MNAR-excluded).`;
  } else if (actualMinSocPct == null) {
    scoreNotes = 'not scored — no backup_pct telemetry over the scored span.';
  } else if (actualPvKwh == null || actualLoadKwh == null || fcPv == null || fcLoad == null) {
    scoreNotes = 'not scored — planner-sizing basis needs both the P50 forecast and the realized PV/load totals (§3.1).';
  } else {
    realizedNeedBuyKwh = plannerSizingNeedBuyKwh({
      planBuyKwh: y.buy_kwh ?? 0,
      forecastPvKwh: fcPv, actualPvKwh,
      forecastLoadKwh: fcLoad, actualLoadKwh,
      legEff,
    });
    scored = 1;
    const missKwh = round2((fcPv - actualPvKwh) + (actualLoadKwh - fcLoad));
    scoreNotes =
      `scored — planner-sizing basis (algo v3): net forecast miss ${missKwh} kWh `
      + `(PV ${fcPv}→${actualPvKwh}, load ${fcLoad}→${actualLoadKwh})`
      + `${wasActuated ? `; delivered ~${deliveredKwh ?? '?'} kWh, deliberately NOT part of this metric` : '; advisory night'}.`;
  }

  // v1.187.22 — the plan's expected buy against what was delivered, and its expected window-open
  // SoC against the measured one (expectedBuyScoreNote; '' on a row without them). Notes only.
  scoreNotes += expectedBuyScoreNote({
    expectedBuyKwh: y.expected_buy_kwh ?? null,
    expectedStartSocPct: y.expected_start_soc_pct ?? null,
    sizingStartSocPct: y.soc_at_window_start_pct ?? null,
    windowOpenSocPct,
    actuated: wasActuated,
    deliveredKwh,
  });

  // Reconstruct just the plan fields the scorer reads.
  const yPlan: NightChargePlan = {
    generatedAt: y.issued_at_ms,
    basisComplete: hadBasis,
    objective: y.objective as NightChargeObjective,
    chargeTonight: (y.buy_kwh ?? 0) > 0,
    buyKwh: y.buy_kwh ?? null,
    // Scorer reconstruction: the ledger holds only the RAW buy (by design —
    // the de-bias must never feed on its own output), so factor 1 here.
    buyKwhDebiased: y.buy_kwh ?? null,
    buyDebiasFactor: 1,
    // The scorer does not read the basis; a reconstructed plan reports it
    // honestly as unmeasured rather than implying a null result.
    buyDebiasBasis: 'default' as const,
    buyDebiasSamples: 0,
    targetSocPct: y.target_soc_pct ?? null,
    // The ledger freezes the PREDICTION (target_soc_pct) because that is what
    // the scorer grades — soc_min_err/buy_err only detect an under-buy when
    // they are compared against what the plan said the pack would reach. The
    // write setpoint is recorded on the ACTUATION record instead (its
    // targetPct), so a re-scored night can never mistake the ask for the
    // forecast; null here is "not a scored column", never "no setpoint".
    setpointSocPct: null,
    requiredExtraKwh: y.required_extra_kwh ?? null,
    bindingCap: (y.binding_cap as BindingCap) ?? null,
    cushionShortfall: y.cushion_shortfall === 1,
    // The ledger does not freeze the contention disclosure (it is a plan-time
    // narrative, not a score column) and the scorer never reads it — null here
    // is "not reconstructed", never "no contention".
    evContention: null,
    minProjSocPct: y.min_proj_soc_pct ?? null,
    minProjSocTsMs: y.min_proj_soc_ts_ms ?? null,
    baselineMinSocPct: null,
    // v1.186.0 — the plan-trajectory verdict is graded on these; a row planned before
    // v1.186.0 has neither, and its verdict is then null (unknown), not "held".
    cushionTroughSocPct: y.cushion_trough_soc_pct ?? null,
    cushionLineSocPct: y.cushion_line_soc_pct ?? null,
    projSocAtWindowStartPct: y.soc_at_window_start_pct ?? null,
    preWindowMinSocPct: null,
    confidenceTier: y.confidence_tier as NightChargePlan['confidenceTier'],
    window: null,
    reserveFloorPct: y.reserve_floor_pct,
    cushionPct: y.cushion_pct,
    rationale: y.rationale ?? '',
  };
  const actuals: NightOutcomeActuals = {
    actualPvKwh, actualLoadKwh, actualMinSocPct, actualMinSocTsMs,
    realizedNeedBuyKwh,
    forecastPvKwh: y.pv_p50_kwh ?? null,
    forecastLoadKwh: y.load_p50_kwh ?? null,
  };
  const score = scoreNightOutcome(yPlan, actuals);

  const inBand = (a: number | null, lo: number | null, hi: number | null): number | null =>
    a == null || lo == null || hi == null ? null : (a >= lo && a <= hi ? 1 : 0);
  const cushionBreached =
    actualMinSocPct == null ? null : (actualMinSocPct < y.reserve_floor_pct + y.cushion_pct ? 1 : 0);

  recorder.recordNightOutcome(yDate, {
    outcome_captured_at_ms: nowMs,
    actual_pv_kwh: actualPvKwh,
    actual_load_kwh: actualLoadKwh,
    actual_window_import_kwh: windowImportKwh,
    actual_onpeak_import_kwh: onpeak.importKwh,
    onpeak_import_occurred: onpeak.occurred,
    onpeak_start_ms: onpeak.span?.startMs ?? null,
    onpeak_end_ms: onpeak.span?.endMs ?? null,
    onpeak_basis: onpeak.basis,
    realized_cost_cents: cols.cost.cents,
    // The verdict is still written; the gate reads this reason and counts it.
    pv_verdict_set_aside: cols.pvSetAside,
    actual_min_soc_pct: actualMinSocPct,
    actual_min_soc_ts_ms: actualMinSocTsMs,
    plan_traj_floor_breached: score.planTrajFloorBreached == null ? null : (score.planTrajFloorBreached ? 1 : 0),
    cushion_breached: cushionBreached,
    // v1.187.3 — delivered_kwh with delivered_basis, set together (deliveredLedgerFields);
    // the learner reads only the current basis.
    ...deliveredLedgerFields(cols),
    grid_home_coverage_frac: winCoverage,
    scored,
    window_open_soc_pct: windowOpenSocPct,
    // v1.187.0 — the on-peak and cost clauses always say what was measured (or why
    // nothing was), and the PV set-aside when there is one.
    score_notes: `${scoreNotes} ${cols.notes}`,
    pv_err_frac: score.pvErrFrac,
    pv_in_band: inBand(actualPvKwh, y.pv_p10_kwh, y.pv_p90_kwh),
    load_err_frac: score.loadErrFrac,
    load_in_band: inBand(actualLoadKwh, y.load_p10_kwh, y.load_p90_kwh),
    buy_err_kwh: score.buyErrKwh,
    soc_min_err_pct: score.socMinErrPct,
  });
  // R4 — the mid-day shadow's window, measured: the PV and load the shadow was planned on, graded
  // (shadowWindowActuals). Only a row the shadow ran a mid-day leg for; written apart from the
  // outcome above, which it leaves as it was.
  // v1.189.0 on v1.188.1 — on the held verdict over the window itself, the rule the actuals above
  // are withheld by (the held repair resets these two with the outcome, forecastSpanResetColumns).
  const shadowActuals = shadowWindowActuals({
    row: y, nowMs, homeSns: [...homeSns],
    queryPv: (sn, a, b) => recorder.query(sn, 'pv_total', a, b),
    queryLoad: (a, b) => recorder.query(shp2Sn, 'panel_load', a, b),
    held: { spans: (a, b) => recorder.heldSpans?.(a, b) ?? [], panelSn: shp2Sn },
    // v1.189.0 (review) — the shadow's window P50 is from the row's own band: set aside with it.
    pvSetAside: cols.pvSetAside,
  });
  if (shadowActuals != null) {
    recorder.recordNightOutcome(yDate, { shadow_window_pv_kwh: shadowActuals.pvKwh, shadow_window_load_kwh: shadowActuals.loadKwh });
  }
}

/**
 * The single ~21:30 site-time evening job (design §3.2). Day-keyed +
 * restart-persistent latch so it fires at most once per site calendar day
 * across add-on restarts (updates, host maintenance). In order: recompute fresh plan → record plan row
 * → score yesterday → recompute readiness → send ONE notification. Latches only
 * AFTER a successful send. Guarded end-to-end; a plan pushed after charging
 * should begin is worse than none, so past 23:00 it log-and-latches.
 */
/** v1.174.0 — the stale-panel deferral logs once per night, not once a minute. */
let nightPlanStaleDeferLoggedDay: string | null = null;
let nightPlanBasisDeferLoggedDay: string | null = null; // v1.186.5
let nightEveningJobInFlight = false; // v1.39.0: re-entrancy guard — a run slower
// than the 60 s tick (analytics reports + a weather fetch, latch written only
// after the awaited send) let overlapping runs each pass the latch check and
// each send the evening notification.
async function runNightChargeEveningJob(): Promise<void> {
  if (nightEveningJobInFlight) return;
  nightEveningJobInFlight = true;
  try {
    await runNightChargeEveningJobInner();
  } finally {
    nightEveningJobInFlight = false;
  }
}

/**
 * v1.171.1 — CANCEL a prior night's ARM that tonight's plan did not supersede.
 *
 * The supersede/stamp block below lives inside `if (armedCandidate)`, so it only runs when
 * TONIGHT produces an armable plan. Saturday has no window of its own and arms for the
 * Monday 00:00–05:00 window; if Sunday's job then decides to HOLD (or has an incomplete
 * basis), nothing touched the record and Saturday's arm still applied at Sunday 23:55 —
 * a reserve write, and a force-charge riding it, against the engine's own fresh decision
 * not to charge. Only a never-applied arm whose window has not yet opened is cleared: an
 * applied or attempted write is unresolved and belongs to the revert path, an unverified
 * force-charge belongs to its OFF path, and an unrestored panel ceiling still needs its
 * restore. Returns true when it cleared one.
 */
function cancelStalePriorArm(today: string, nowMs: number, reason: string): boolean {
  const s = nightActuationMem;
  if (s.day == null || s.day === today) return false;
  if (s.targetPct == null || s.windowStartMs == null || nowMs >= s.windowStartMs) return false;
  if (s.appliedAtMs != null || s.applyAttemptedAtMs != null) return false;
  if (s.forceChargeOnAtMs != null && s.forceChargeOffVerifiedAtMs == null) return false;
  if (s.forceChargeCeilingPriorPct != null && s.forceChargeCeilingRestoredAtMs == null) return false;
  const stale = s.day;
  app.log.warn(`night-charge: CANCELLING the prior ARM for ${stale} (target ${s.targetPct}%, worst-case sizing ~${s.buyKwh ?? '—'} kWh${s.forceChargeCeilingPct != null ? `, force-charge to ${s.forceChargeCeilingPct}%` : ''}) — ${reason}. Without this it would have written at ${new Date(s.windowStartMs - APPLY_LEAD_MS).toISOString()} against tonight's decision.`);
  try {
    // To the leg's own column (chargeCycle.legLedgerFields: a backup leg's goes to backup_*), as
    // every other leg stamp is; the overnight cost leg's is the column it always was.
    recorder.recordNightOutcome(stale, legLedgerFields(legRoleOf(s), {
      arm_disposition: `cancelled by the ${today} plan — ${reason}`,
    }) as Partial<NightLedgerRow>);
  } catch (e: any) {
    app.log.warn(`night-charge: cancel stamp failed for ${stale} (${e?.message ?? e})`);
  }
  // v1.189.0 — and the legs pending behind it (armed with it, never written): with nothing active
  // they would be promoted and write against tonight's decision.
  for (const p of nightCyclePending) {
    stampLegOutcome(p, { arm_disposition: `cancelled by the ${today} plan — ${reason}` });
  }
  nightCyclePending = [];
  persistNightActuation(emptyActuationState());
  return true;
}

async function runNightChargeEveningJobInner(): Promise<void> {
  const nowMs = Date.now();
  const today = siteYmd(nowMs);
  const latch = readNightChargeLatch();
  if (latch.lastNotifyDay === today) return; // already fired today (survives restart)

  const nowMin = siteMinuteOfDay(nowMs);
  // v1.191.0 (S6) — the schedule of the tariff in effect: on the APS preset fire = the configured
  // time, cutoff 23:00 and deferral 22:30, as before; another plan's from its cheap window.
  const sched = nightScheduleNow();
  const fireMin = sched.notify.fireMin;
  const cutoffMin = sched.eveningCutoffMin; // catch-up window [fire, cutoff): 23:00 on the APS preset
  const deferUntilMin = sched.staleDeferUntilMin;
  if (nowMin < fireMin) return; // too early
  if (nowMin >= cutoffMin) {
    app.log.warn(`night-charge: evening job missed today's ${sched.notify.hour}:${String(sched.notify.minute).padStart(2, '0')}–${fmtMinuteOfDay(cutoffMin)} window; skipping the notify + latching (a late plan is worse than none).`);
    // v1.171.1 — no decision was reached tonight, so a prior arm is NOT cancelled (its
    // plan is the only one there is). Name it, because it will write on its own.
    if (nightActuationMem.day != null && nightActuationMem.day !== today
        && nightActuationMem.appliedAtMs == null && nightActuationMem.applyAttemptedAtMs == null
        && nightActuationMem.targetPct != null && nightActuationMem.windowStartMs != null
        && nowMs < nightActuationMem.windowStartMs) {
      app.log.warn(`night-charge: the ARM for ${nightActuationMem.day} (target ${nightActuationMem.targetPct}%) is still pending and WILL write at ${new Date(nightActuationMem.windowStartMs - APPLY_LEAD_MS).toISOString()} — tonight's job never reached a decision to supersede or cancel it. Cancel from the panel if that is not wanted.`);
    }
    // v1.40.0: the NOTIFY is skipped, but the LEDGER ROW need not be lost — if
    // a pre-window plan snapshot from today exists and no row was recorded,
    // record it now with its honest original issued_at (plan.generatedAt).
    // This converts "restart during the 21:30–23:00 window" from an
    // unlearnable missing night into a recorded one.
    try {
      const hasRow = recorder.readNightLedger(2).some((r) => r.plan_date === today);
      if (!hasRow) {
        const snap = JSON.parse(readFileSync(NIGHT_CHARGE_PLANSNAP_PATH, 'utf8'));
        if (snap?.day === today && snap.plan && snap.extras) {
          recordNightPlanRow(today, snap.plan as NightChargePlan, snap.extras as NightPlanExtras);
          app.log.info(`night-charge: recorded today's plan row from the persisted pre-window snapshot (issued ${new Date(snap.plan.generatedAt).toISOString()}) after missing the live record window.`);
        }
      }
    } catch (e: any) {
      app.log.debug(`night-charge: snapshot recovery skipped (${e?.message ?? e})`);
    }
    // Still SCORE yesterday + refresh readiness even when tonight's NOTIFY window
    // was missed — otherwise a missed evening job permanently drops the prior
    // night's outcome from the ledger/gate, an uncounted MNAR exclusion that
    // biases the write-readiness reduction (the tick below also does this, but
    // do it here so a same-day miss is captured immediately).
    try { scoreCompletedNights(nowMs); } catch (e: any) { app.log.debug(`night-charge: cutoff scoring skipped (${e?.message ?? e})`); }
    try { setLatestReadiness(computeNightChargeReadiness(recorder.readNightLedger(400), nowMs, nightReadinessOpts())); } catch (e: any) { app.log.debug(`night-charge: cutoff readiness recompute failed (${e?.message ?? e})`); }
    refreshNightRecentOutcomes(); // scoring may have updated rows the status route serves
    // v1.187.22 — no decision was reached tonight, so a refusal recorded on an earlier evening still
    // stands (Saturday's, for the window Sat and Sun share): keep it. servedArmRefusal serves it only
    // beside a charge plan for that window, and only until the window closes.
    writeNightChargeLatch({ lastNotifyDay: today, armRefused: latch.armRefused ?? null });
    return;
  }

  try {
    // (a) recompute fresh; (b) record the plan row (when a plan was produced).
    // v1.174.0 — a STALE panel DEFERS: no latch, no notification, no cancel of a prior
    // arm — the 60 s tick retries. From the schedule's deferral end (22:30 on the APS preset) the plan is
    // sized on the last reading instead (disclosed on the plan), so staleness alone
    // never costs the night. Only a genuinely missing basis (null) reaches
    // 'insufficient_basis' below.
    const result = await recomputeNightChargePlan({ allowStalePanel: nowMin >= deferUntilMin });
    if (result === 'panelStale') {
      if (nightPlanStaleDeferLoggedDay !== today) {
        nightPlanStaleDeferLoggedDay = today;
        app.log.info(`night-charge: evening plan DEFERRED for ${today} — the panel reading is stale; retrying every minute until ${Math.floor(deferUntilMin / 60)}:${String(deferUntilMin % 60).padStart(2, '0')}, then planning on the last reading (disclosed).`);
      }
      return;
    }
    const fresh = result;
    // v1.186.5 — an incomplete basis DEFERS (no row, notify, latch or cancel) until
    // the schedule's deferral end, like a stale panel; see eveningBasisDefers.
    if (eveningBasisDefers(fresh?.plan ?? null, nowMin, deferUntilMin)) {
      if (nightPlanBasisDeferLoggedDay !== today) {
        nightPlanBasisDeferLoggedDay = today;
        app.log.info(`night-charge: evening plan DEFERRED for ${today} — ${fresh ? `the basis is incomplete (${fresh.plan.rationale})` : 'inputs unavailable'}; retrying every minute until ${Math.floor(deferUntilMin / 60)}:${String(deferUntilMin % 60).padStart(2, '0')}, then deciding on what is known.`);
      }
      return;
    }
    if (fresh) {
      recordNightPlanRow(today, fresh.plan, fresh.extras);
      // v1.39.0: refresh the status route's in-memory mirror immediately — the
      // just-recorded row was otherwise invisible for up to 30 min (next tick).
      refreshNightRecentOutcomes();
      // v1.40.0: the subsystem previously logged nothing at info level — an
      // incident left zero breadcrumbs. One line per nightly lifecycle event.
      // v1.115.0 — print the window's END and DURATION, not just its start. A
      // 1 h Friday window (the Mon-Fri overnight period ends at Sat 00:00) was
      // indistinguishable in the journal from the usual 6 h one, and the short
      // window is exactly what explains an unusually small buy.
      const w = fresh.plan.window;
      const winStr = w
        ? `${new Date(w.startMs).toISOString()}→${new Date(w.endMs).toISOString()} (${round1((w.endMs - w.startMs) / 3_600_000)}h)`
        : 'none';
      app.log.info(`night-charge: plan row recorded for ${today} — chargeTonight=${fresh.plan.chargeTonight} buyKwh=${fresh.plan.buyKwh ?? 'null'} expectedBuyKwh=${fresh.plan.expectedBuyKwh ?? 'null'} window=${winStr}`);
    } else {
      app.log.info(`night-charge: no plan row for ${today} — inputs unavailable (SHP2 offline / missing battery fields); the night will count as an exclusion.`);
    }

    // (c) score yesterday (independent of today's SHP2 state).
    try { scoreCompletedNights(nowMs); }
    catch (e: any) { app.log.debug(`night-charge: yesterday scoring skipped (${e?.message ?? e})`); }

    // (d) recompute readiness over the full ledger (400 d ≫ the in-season window).
    try {
      const readiness = computeNightChargeReadiness(recorder.readNightLedger(400), nowMs, nightReadinessOpts());
      setLatestReadiness(readiness);
    } catch (e: any) { app.log.debug(`night-charge: readiness recompute skipped (${e?.message ?? e})`); }

    // (e) send ONE notification, honoring NIGHT_CHARGE_NOTIFY_ON_HOLD.
    const plan = fresh?.plan ?? null;
    const shape: 'charge' | 'hold' | 'insufficient_basis' =
      plan == null || !plan.basisComplete ? 'insufficient_basis' : (plan.chargeTonight ? 'charge' : 'hold');
    const notifyOnHold = process.env.NIGHT_CHARGE_NOTIFY_ON_HOLD !== 'false';
    if (shape === 'hold' && !notifyOnHold) {
      // v1.171.1 — the decision still counts: a prior arm must not outlive it.
      cancelStalePriorArm(today, nowMs, 'tonight the engine decided to HOLD (no buy needed)');
      // Suppressed by owner config; still latch so we don't retry all night.
      writeNightChargeLatch({ lastNotifyDay: today });
      app.log.info('night-charge: hold plan — notification suppressed (NIGHT_CHARGE_NOTIFY_ON_HOLD=false); latched.');
      return;
    }
    // v1.171.1 — tonight reached a decision NOT to charge: cancel a prior night's arm it
    // would otherwise leave standing (see cancelStalePriorArm).
    if (shape !== 'charge') {
      cancelStalePriorArm(today, nowMs, shape === 'hold'
        ? 'tonight the engine decided to HOLD (no buy needed)'
        : 'tonight the engine had no usable plan (incomplete basis)');
    }
    // v1.50.0 — supervised arming: when the owner enabled a write mode and
    // tonight's plan is a charge, the bounded write arms FROM THE ANNOUNCED
    // PLAN (the cancel window runs against exactly these numbers; a fresher
    // recompute never silently substitutes a different buy). The candidate is
    // computed here but PERSISTED only after at least one announcement
    // channel confirms delivery — a write the owner never heard about must
    // never fire. Arming is refused while a prior night is unresolved.
    let supervisedCtx: {
      cancelDeadlineText: string; cancelDeadlineTextEs: string; targetPct: number;
      forceChargeTargetPct?: number | null;
    } | null = null;
    let armedCandidate: NightActuationState | null = null;
    // v1.189.0 — the cycle armCycle built (chargeCycle.ts), persisted only once delivered, and the
    // prior cycle's pending legs it replaces (stamped then).
    let armedCycle: ChargeCycleState | null = null;
    let supersededPending: Array<{ leg: ChargeLegState; sharedWindow: boolean }> = [];
    // v1.187.22 — why a write mode refused to arm a charge plan; the push then says no write is
    // armed instead of recommending the plan's level and draw (buildNightChargeMessage).
    let armRefused: string | null = null;
    if (NIGHT_CHARGE_MODE !== 'advisory' && shape === 'charge' && plan) {
      // v1.187.22 — the force-charge gate is stamped on the record (forceChargeRides): the gate this
      // plan's expected figure was made with, read back by the morning push.
      // The on-peak guard: the start of the on-peak period after the window open, stamped on the
      // arm (nextOnPeakStartMs) — raises stop, and the restore falls due, an hour before it.
      const armOnPeakStartMs = plan.window != null ? nextOnPeakStartMs(tariffModelFromEnv(), plan.window.startMs) : null;
      // v1.189.0 — armed as a charge cycle (chargeCycle.armCycle). With one leg — tonight's
      // overnight cost leg, every cycle until the mid-day switch — it arms what armFromPlan arms
      // against the active leg, and refuses with armRefusalReason's words, unchanged.
      const arm = armCycle(nightCycleView(), today, [{
        role: 'cost', kind: 'overnight', plan, forceChargeEnabled: forceChargeOn(), nextOnPeakStartMs: armOnPeakStartMs,
        announcedLevelPct: chargeLevelPct(plan), announcedExpectedKwh: statedBuyKwh(plan),
      }], nowMs, plan.reserveFloorPct);
      armedCycle = arm.cycle;
      armedCandidate = arm.cycle?.active ?? null;
      if (!armedCandidate) armRefused = arm.refused[0]?.reason ?? null;
      if (armedCandidate) {
        // v1.79.0 — an earlier evening's never-applied ARM being replaced is a
        // normal weekend pattern, but 3 ARMED vs 2 APPLIED was untraceable
        // without a disposition line.
        // v1.132.0 — this comment said "Fri and Sat both target the Monday
        // window". Wrong for this tariff: FRIDAY has its own window (23:00 →
        // 00:00, one hour, since the weekday rule is evaluated per-instant).
        // The pair that genuinely shares a window is SAT + SUN, both resolving
        // to Mon 00:00 → 05:00, because Saturday has no window of its own.
        if (nightActuationMem.day != null && nightActuationMem.day !== today &&
            nightActuationMem.appliedAtMs == null && nightActuationMem.applyAttemptedAtMs == null &&
            nightActuationMem.targetPct != null) {
          app.log.info(`night-charge: prior ARM for ${nightActuationMem.day} (target ${nightActuationMem.targetPct}%, worst-case sizing ~${nightActuationMem.buyKwh ?? '—'} kWh) superseded by tonight's plan — one write fires at the shared window.`);
          // v1.132.0 — and STAMP it. A log line is not the ledger: the superseded
          // night keeps actuated=null forever, indistinguishable from four other
          // dispositions (held below minimum buy, no window, advisory mode, apply
          // guards refused). 2026-08-29 sat that way with buy_kwh=36, reading like
          // a failed 36 kWh buy when it was a normal shared-window supersede.
          try {
            // To the leg's own column (chargeCycle.legLedgerFields), as every other leg stamp is.
            recorder.recordNightOutcome(nightActuationMem.day, legLedgerFields(legRoleOf(nightActuationMem), {
              arm_disposition: `superseded by the ${today} plan — Sat/Sun share one Monday window, so only the later arm writes`,
            }) as Partial<NightLedgerRow>);
          } catch (e: any) {
            app.log.warn(`night-charge: supersede stamp failed for ${nightActuationMem.day} (${e?.message ?? e})`);
          }
        }
        // v1.189.0 — and a prior cycle's pending leg that never wrote (chargeCycle.supersededLegs;
        // the active leg is stamped above, as it always was). Stamped once the cycle that replaces
        // it is persisted (below): an undelivered arm replaces nothing.
        supersededPending = supersededLegs(nightCycleView(), arm.legs, today, nowMs).filter(({ leg }) => leg !== nightActuationMem);
        supervisedCtx = {
          // Day-qualified: a weekend plan's window can be ~28 h out, and a bare
          // clock time would read as tonight (see fmtDeadlineSpoken).
          cancelDeadlineText: fmtDeadlineSpoken(armedCandidate.windowStartMs! - APPLY_LEAD_MS, nowMs),
          cancelDeadlineTextEs: fmtDeadlineSpokenEs(armedCandidate.windowStartMs! - APPLY_LEAD_MS, nowMs),
          targetPct: armedCandidate.targetPct!,
          // v1.165.0 — say so when force-charge will ride this window. v1.187.22 — from the stamp
          // the morning push reads back (forceChargeRides): one decision, made once.
          forceChargeTargetPct: armedCandidate.forceChargeRides === true ? armedCandidate.forceChargeCeilingPct : null,
        };
      } else if (
        nightActuationMem.forceChargeOnAtMs != null && nightActuationMem.forceChargeOffVerifiedAtMs == null
      ) {
        // v1.165.0 — armFromPlan refuses to bury an unverified force-charge. Say
        // so: a silent refusal reads as "the evening job did nothing".
        app.log.warn(`night-charge: supervised arming refused — the ${nightActuationMem.day} force-charge was switched ON and its OFF has not verified (slots ${(nightActuationMem.forceChargeSlots ?? []).join(',') || 'unknown'}). Arming resumes once the panel reads force-charge OFF.`);
      } else if (
        (nightActuationMem.appliedAtMs != null || nightActuationMem.applyAttemptedAtMs != null) &&
        nightActuationMem.revertedAtMs == null
      ) {
        app.log.warn("night-charge: supervised arming refused — a prior night's reserve write is unresolved (applied or unconfirmed-attempt, not yet reverted).");
      } else if (armRefused) {
        app.log.warn(`night-charge: supervised arming refused — ${armRefused}.`);
      }
    }
    const cfg = loadNotifyConfig();
    const msg = buildNightChargeMessage(plan, shape, supervisedCtx, armRefused, NIGHT_CHARGE_MODE);
    await sendNotification(cfg, msg); // direct — bypasses quiet-hours/min-severity (I10)
    // NOTIFY_CHANNEL 'none' makes sendNotification a silent no-op — that is
    // NOT a delivered announcement for arming purposes.
    const haNotifyDelivered = cfg.channel !== 'none';
    // The audible channel (reaches the owner without any phone-push
    // dependency): announce the armed write once, at the same evening moment.
    let audibleDelivered = false;
    if (supervisedCtx && plan) {
      // v1.187.22 — what the write will do: the level it drives the pool to and the expected draw
      // (none spoken with no expected figure). The worst case the plan is sized on is not spoken.
      // Disclose a plan that cannot hold the cushion — the HA notification says
      // so, and the audible channel (the one that reaches the owner without a
      // phone) must not be quieter about residual risk than the text channel.
      // v1.122.0 — the SPOKEN variant is deliberately shorter than the push, and
      // its length is bounded by a test. See nightChargeSpokenNotice.
      const spokenPair = nightChargeSpokenNotice({
        levelPct: chargeLevelPct(plan) ?? supervisedCtx.targetPct,
        // v1.187.22 — what a night expected to charge nothing holds: the armed reserve.
        reservePct: supervisedCtx.targetPct,
        expectedKwh: statedBuyKwh(plan),
        toward: chargeIsWindowBound(plan),
        deadlineText: supervisedCtx.cancelDeadlineText,
        deadlineTextEs: supervisedCtx.cancelDeadlineTextEs,
        cushionShortfall: plan.cushionShortfall === true,
      });
      const spoken = spokenPair.en;
      const spokenEs = spokenPair.es;
      try {
        // v1.122.0 — consent checkpoint: never dropped by the same-level storm gate.
        const a = await broadcast.announce('medium', spoken, spokenEs, { consentNotice: true });
        audibleDelivered = a.ok === true;
        // v1.78.0 — a config-mandated quiet-hours suppression is healthy, not a
        // failure; logging it at WARN made 3/3 nightly arms read as broken and
        // hid the signature a REAL audible breakage would share.
        if (!a.ok && String(a.error ?? '').startsWith('suppressed')) {
          app.log.info(`night-charge: supervised announce suppressed (${a.error}) — arm delivered via HA notify`);
        } else if (!a.ok) {
          app.log.warn(`night-charge: supervised announce failed (${a.error ?? 'unknown'})`);
        }
      } catch (e: any) {
        app.log.warn(`night-charge: supervised announce failed (${e?.message ?? e})`);
      }
    }
    if (armedCandidate) {
      if (haNotifyDelivered || audibleDelivered) {
        // v1.189.0 — the whole cycle, only now it is delivered (the trailing leg, if any, with it, as
        // the ticks during the announcement left it: chargeCycle.withLiveTrailing).
        persistCycle(withLiveTrailing(armedCycle!, nightActuationMem));
        for (const { leg, sharedWindow } of supersededPending) {
          app.log.info(`night-charge: prior ${leg.leg} leg for ${leg.day} (target ${leg.targetPct}%) superseded by tonight's plan${sharedWindow ? ' — the same window' : ''}.`);
          stampLegOutcome(leg, { arm_disposition: `superseded by the ${today} plan` });
        }
        app.log.info(
          `night-charge: supervised write ARMED for ${today} — reserve → ${armedCandidate.targetPct}% at ${new Date(armedCandidate.windowStartMs! - APPLY_LEAD_MS).toISOString()} (${buyFiguresLogText(plan?.expectedBuyKwh, plan?.buyKwhDebiased ?? plan?.buyKwh)}); announced via ${[haNotifyDelivered ? 'HA notify' : null, audibleDelivered ? 'audible' : null].filter(Boolean).join(' + ')}; cancellable until the write moment. ${forceChargeArmNote(armedCandidate)}`,
        );
      } else {
        app.log.error(
          `night-charge: supervised write NOT armed for ${today} — no announcement channel delivered (NOTIFY_CHANNEL='${cfg.channel}', audible failed). A write the owner never heard about must not fire; tonight stays advisory.`,
        );
      }
    }
    // v1.187.22 — and the refused arm, keyed by its window, for the card (servedArmRefusal): a
    // refusal, or a write no announcement channel delivered (nothing is armed — unless the record
    // left in place is an arm for the same window that will still write).
    const notArmed = eveningNotArmedReason({
      refused: armRefused, candidate: armedCandidate, delivered: haNotifyDelivered || audibleDelivered, prior: nightActuationMem,
    });
    writeNightChargeLatch({
      lastNotifyDay: today,
      armRefused: notArmed && plan?.window
        ? { reason: notArmed, windowStartMs: plan.window.startMs, windowEndMs: plan.window.endMs } : null,
    }); // latch AFTER a successful send
    app.log.info(`night-charge: evening advisory sent (${shape}) and latched for ${today}.`);
  } catch (e: any) {
    // Do NOT latch on failure — retry next minute-tick within the window.
    app.log.warn(`night-charge: evening job failed, will retry within the window (${e?.message ?? e})`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * R4 (v1.189.0) — THE WINTER MID-DAY CYCLE IN SHADOW (middayShadow.ts, plan §8 R4).
 *
 * Once tonight's evening job has run and latched, the mid-day cycle the switch would arm is
 * computed beside it: the backup leg (option A) and the 10:00–15:00 cost leg, sized by the same
 * planner (recomputeNightChargePlan with a shadow leg: the plan is returned only — no holder, no
 * snapshot), and probed against the cycle in place (chargeCycle.armCycle on it; the result is
 * dropped). At 09:30–09:55 the cost leg's morning refresh is computed the same way. The record goes
 * to its own file, the log ("night-charge[midday-shadow]:"), the evening's ledger row (shadow_*
 * columns), the ecoflow_midday_charge_* entities and the card's read-only section.
 *
 * ★ NOTHING HERE WRITES THE DEVICE, ARMS, PUSHES OR SPEAKS. No function in this block calls a
 * panel writer, persists the charge cycle, sends a notification or announces; the live overnight
 * cycle — its arm, its push and speech, its 23:00 and 05:00 writes — is the evening job's alone,
 * unchanged, and the actuator ticks at 10:00 and 15:00 find no mid-day leg in the cycle.
 * ═════════════════════════════════════════════════════════════════════════ */
const NIGHT_CHARGE_MIDDAY_SHADOW_PATH = resolve(process.cwd(), config.dbPath, '..', '.night-charge-midday-shadow.json');
setMiddayShadow((() => {
  try {
    return coerceMiddayShadowRecord(JSON.parse(readFileSync(NIGHT_CHARGE_MIDDAY_SHADOW_PATH, 'utf8')));
  } catch {
    return null;
  }
})());

/** The shadow record to memory (the surfaces read it there) and to its own file. */
function persistMiddayShadow(r: MiddayShadowRecord): void {
  setMiddayShadow(r);
  try {
    atomicWriteFileSync(NIGHT_CHARGE_MIDDAY_SHADOW_PATH, JSON.stringify(r));
  } catch (e: any) {
    app.log.debug(`${MIDDAY_SHADOW_LOG_TAG} persist failed (${e?.message ?? e})`);
  }
}

/** The house Cores' configured charge ceilings (chgMaxSoc): the mid-day leg's taper line. */
function homeChgMaxSocPcts(): Array<number | null> {
  const devices = store.get().devices;
  const home = shp2ConnectedDpuSns(devices);
  return Object.values(devices)
    .filter((d) => home.has(d.sn))
    .map((d) => {
      const v = (d.projection as { chgMaxSoc?: unknown } | null | undefined)?.chgMaxSoc;
      return Number.isFinite(v) ? Number(v) : null;
    });
}

/** One shadow leg, sized: the plan only (recomputeNightChargePlan sets no holder and writes no
 *  snapshot for a shadow leg) and its window's planned PV and load. */
async function sizeShadowLeg(sizing: ShadowLegSizing, allowStalePanel: boolean): Promise<ShadowSized | null | 'panelStale'> {
  const r = await recomputeNightChargePlan({ allowStalePanel, shadowLeg: sizing });
  if (r === 'panelStale' || r == null) return r;
  return {
    plan: r.plan, windowPvP50Kwh: r.extras.windowPvP50Kwh ?? null, windowLoadP50Kwh: r.extras.windowLoadP50Kwh ?? null,
    weatherFetchedAtMs: r.extras.weatherFetchedAtMs ?? null,
  };
}

/** Would these legs arm against the cycle in place? armCycle is pure: its cycle is DROPPED here —
 *  only the verdict (which roles armed, which were refused and why) leaves this function. */
function shadowArmProbe(day: string, nowMs: number): (cands: ShadowArmCandidate[]) => ShadowArmVerdict {
  return (cands) => {
    const model = tariffModelFromEnv();
    const verdict = armCycle(nightCycleView(), day, cands.map((c) => ({
      role: c.role, kind: c.kind, plan: c.plan, forceChargeEnabled: forceChargeOn(c.role),
      nextOnPeakStartMs: c.plan.window != null ? nextOnPeakStartMs(model, c.plan.window.startMs) : null,
    })), nowMs, cands[0]?.plan.reserveFloorPct ?? null);
    return { armed: verdict.legs.map((l) => l.leg), refused: verdict.refused };
  };
}

/** The shadow's columns onto the evening's ledger row — only a row the live evening job recorded
 *  (a shadow never creates a row: a row of shadow columns alone would read as a night with no plan). */
function stampShadowLedger(day: string, cols: Partial<NightLedgerRow>): void {
  try {
    if (!recorder.readNightLedger(3).some((r) => r.plan_date === day)) {
      app.log.info(`${MIDDAY_SHADOW_LOG_TAG} ${day} — no ledger row for the evening (no live plan was recorded); the shadow stays in the log and on the card.`);
      return;
    }
    recorder.recordNightOutcome(day, cols);
  } catch (e: any) {
    app.log.warn(`${MIDDAY_SHADOW_LOG_TAG} ${day} — ledger stamp failed (${e?.message ?? e})`);
  }
}

let middayShadowInFlight = false;
let middayShadowDeferLoggedDay: string | null = null;
/** The shadow's minute tick: single-flight; a failure is logged and retried — it can cost the shadow
 *  its evening, never the live cycle anything. */
async function runMiddayShadowTick(): Promise<void> {
  if (middayShadowInFlight) return;
  middayShadowInFlight = true;
  try {
    await runMiddayShadowTickInner(Date.now());
  } catch (e: any) {
    app.log.warn(`${MIDDAY_SHADOW_LOG_TAG} tick failed (${e?.message ?? e}); shadow only — nothing was written`);
  } finally {
    middayShadowInFlight = false;
  }
}

async function runMiddayShadowTickInner(nowMs: number): Promise<void> {
  const today = siteYmd(nowMs);
  const model = tariffModelFromEnv();
  const cfg = shadowCycleConfig(FORCE_CHARGE_OBJECTIVE, FORCE_CHARGE_COST_MAX_SOC_PCT);
  const cur = getMiddayShadow();
  const nowMin = siteMinuteOfDay(nowMs);
  // v1.191.0 (S6) — the live evening job's schedule (the APS constants on the preset).
  const sched = nightScheduleNow(model);
  const fireMin = sched.notify.fireMin;

  // (1) The evening: after the live evening job latched today, inside its [fire, cutoff) window.
  if (readNightChargeLatch().lastNotifyDay === today && cur?.day !== today && nowMin >= fireMin && nowMin < sched.eveningCutoffMin) {
    const rec = await runMiddayShadowEvening({
      nowMs, day: today, model, cfg, mode: NIGHT_CHARGE_MODE, chgMaxSocPcts: homeChgMaxSocPcts(),
      sizeLeg: (sz) => sizeShadowLeg(sz, nowMin >= sched.staleDeferUntilMin),
      armProbe: shadowArmProbe(today, nowMs),
    });
    if (rec === 'panelStale') {
      if (middayShadowDeferLoggedDay !== today) {
        middayShadowDeferLoggedDay = today;
        app.log.info(`${MIDDAY_SHADOW_LOG_TAG} ${today} — the panel reading is stale; retrying each minute.`);
      }
      return;
    }
    persistMiddayShadow(rec);
    for (const line of middayShadowLogLines(rec)) app.log.info(line);
    // R5 — what the evening would have pushed and spoken for the mid-day cycle (chargeText.ts):
    // logged, never sent.
    for (const line of middayShadowPreviewLogLines(rec, model)) app.log.info(line);
    stampShadowLedger(today, middayShadowLedgerColumns(rec));
    return;
  }

  // (2) The cost leg's morning refresh — a computation only: it lowers or cancels nothing, because
  // nothing is armed; it records what the live refresh would have done. Not when the live overnight
  // leg of the same evening wrote to the panel (liveOvernightWrote): the 09:30 pool it would size on
  // is not the one a mid-day cycle would have had, and the refresh is recorded as not comparable.
  const due = shadowRefreshDue(cur, nowMs);
  if (cur == null || due == null) return;
  let refresh = liveOvernightWrote(cur, nightActuationMem) ? notComparableRefresh(nowMs)
    : due === 'stand' ? standingRefresh(cur, nowMs) : null;
  if (refresh == null) {
    const sizing = refreshSizing(model, cur, cfg, homeChgMaxSocPcts());
    if (sizing == null) return;
    // A fresh panel is required (plan §3.4 step 1); until the deadline a stale one retries.
    const sized = await sizeShadowLeg(sizing, false);
    if (sized === 'panelStale' || sized == null) return;
    refresh = refreshFromSized(cur, sized, nowMs);
  }
  // Re-read after the await: a record replaced meanwhile (or refreshed) is not this refresh's.
  const live = getMiddayShadow();
  if (live == null || live.day !== cur.day || live.computedAtMs !== cur.computedAtMs || live.refresh != null) return;
  const next: MiddayShadowRecord = { ...live, refresh };
  persistMiddayShadow(next); // stamped before anything is said about it (plan §3.4 step 4)
  app.log.info(middayShadowRefreshLogLine(next, refresh));
  // R5 — and the push a live refresh would send (never sent, never spoken).
  const refreshPreview = middayShadowRefreshPreviewLogLine(next, refresh);
  if (refreshPreview != null) app.log.info(refreshPreview);
  stampShadowLedger(next.day, middayShadowRefreshLedgerColumns(refresh));
}

/**
 * v1.188.1 — the rows captured on HELD readings (nightLedgerScoring.heldLedgerRepair): reset for
 * the sweep to re-capture while their telemetry is retained, else tagged. Run by the sweep itself
 * (scoreCompletedNights), with the same Cores and panel the capture then uses, so a re-captured
 * row always carries the verdict and is not reset again. Rows are corrected in place, never
 * deleted. Returns true when it reset one.
 */
function repairHeldNightOutcomes(rows: NightLedgerRow[], shp2Sn: string, nowMs: number): boolean {
  let reset = false;
  try {
    // v1.188.1 (review 5) — also with no span left: a row stated as held whose span was restored
    // owes a re-capture (heldLedgerRepair), and with every span restored this returned first.
    const spans = recorder.heldSpans?.(nowMs - (LEDGER_BACKFILL_SWEEP_DAYS + 2) * 86_400_000, nowMs);
    if (spans == null) return false;
    const horizonMs = forecastSpanRecaptureHorizonMs(
      config.retentionDays, LEDGER_BACKFILL_SWEEP_DAYS,
    );
    const coreSns = [...shp2ConnectedDpuSns(store.get().devices)];
    const nameOf = (sn: string) => store.get().devices[sn]?.deviceName ?? sn;
    const restored = recorder.restoredHeldSpans?.(nowMs - (LEDGER_BACKFILL_SWEEP_DAYS + 2) * 86_400_000, nowMs) ?? [];
    for (const y of rows) {
      const r = heldLedgerRepair(y, { spans, coreSns, panelSn: shp2Sn, nowMs, horizonMs, restored });
      if (!r) continue;
      // v1.188.1 (review 3) — whether a held row lies inside the span as captured, per side: the
      // verdict also counts the silent hours of a frozen span (no rows at all), and an actual
      // integrated across those alone had integrated no held reading.
      const heldIn = (side: Array<{ sn: string }>, metric: string) =>
        side.some((p) => recorder.heldRowsWithin?.(p.sn, metric, r.span.startMs, r.span.endMs) ?? true);
      const heldRows = r.action === 'recapture' && r.verdict != null ? { pv: heldIn(r.verdict.pv, 'pv_total'), load: heldIn(r.verdict.load, 'panel_load') } : {};
      // v1.188.1 (review 5) — one write for both actions (nightLedgerScoring.heldRepairColumns).
      recorder.recordNightOutcome(String(y.plan_date), heldRepairColumns(y, r, nameOf, heldRows));
      if (r.action === 'tag') {
        app.log.info(`night-charge: tagged ${y.plan_date} — its PV/load span had an hour or more with no fresh readings (held or missing) and it is past the re-capture horizon; kept as captured.`);
        continue;
      }
      reset = true;
      app.log.info(`night-charge: reset ${y.plan_date} for re-capture — ${heldRepairClause(r, y, heldRows)} (pv ${y.actual_pv_kwh ?? 'null'} kWh, load ${y.actual_load_kwh ?? 'null'} kWh, buy_err ${y.buy_err_kwh ?? 'null'} kWh as captured).`);
    }
  } catch (e: any) {
    app.log.debug(`night-charge: held-telemetry repair skipped (${e?.message ?? e})`);
  }
  return reset;
}

/**
 * v1.39.0 one-time-per-boot, idempotent repair: pre-v1.39.0 the scorer could
 * capture a night's outcome just after midnight — mid-charge-window — and the
 * idempotence latch then froze the truncated actuals (scored=0, null SoC,
 * ~25% coverage) into the never-pruned ledger forever. Reset any row whose
 * capture PRECEDES its own night-completion boundary so the (now
 * completion-gated) scorer re-captures it with full-span actuals. Rows are
 * corrected in place — never deleted. Idempotent: a reset row has a null
 * capture (skipped next boot) and a correctly re-scored row has
 * capture ≥ completeMs (also skipped).
 */
function repairPrematureNightOutcomes(): void {
  try {
    const rows = recorder.readNightLedger(60);
    for (const y of rows) {
      const cap = y.outcome_captured_at_ms;
      if (cap == null) continue;
      // Same span derivation as the scorer (stored real window when present) —
      // a capture is premature iff it precedes ITS OWN night's completion.
      const s = nightSpansForRow(y);
      if (!s || cap >= s.completeMs) continue; // captured after completion — sound
      recorder.recordNightOutcome(String(y.plan_date), {
        outcome_captured_at_ms: null,
        actual_pv_kwh: null,
        actual_load_kwh: null,
        actual_window_import_kwh: null,
        actual_onpeak_import_kwh: null,
        onpeak_import_occurred: null,
        // v1.187.0 — the on-peak span, its basis and the realized cost are outcome
        // columns too: a re-capture must not inherit them from the premature one.
        onpeak_start_ms: null,
        onpeak_end_ms: null,
        onpeak_basis: null,
        realized_cost_cents: null,
        actual_min_soc_pct: null,
        actual_min_soc_ts_ms: null,
        plan_traj_floor_breached: null,
        cushion_breached: null,
        grid_home_coverage_frac: null,
        scored: 0,
        score_notes:
          'reset — outcome had been captured before the night completed (pre-v1.39.0 mid-window scoring defect); re-captured by the backfill sweep — scored where telemetry still exists, else honestly unscored.',
        pv_err_frac: null,
        pv_in_band: null,
        pv_verdict_set_aside: null, // v1.187.0 — re-derived with the verdict it qualifies
        load_err_frac: null,
        load_in_band: null,
        buy_err_kwh: null,
        soc_min_err_pct: null,
      });
      app.log.info(`night-charge: reset prematurely-captured outcome for ${y.plan_date} (was captured mid-night).`);
    }
  } catch (e: any) {
    app.log.debug(`night-charge: premature-outcome repair skipped (${e?.message ?? e})`);
  }
}

/**
 * v1.187.10 — once per boot, idempotent: the rows captured before issue + 24 h.
 *
 * Until v1.187.10 the sweep captured a row at its night's completion (window close + 16 h)
 * and integrated the PV/load actuals only up to that instant, while the P50 they are graded
 * against spans 24 h from issue. A Friday 1 h window completes Saturday 16:00, ~5.4 h short
 * (2026-10-02: load 39.62 kWh on 18.6 h against an 81.8 kWh forecast, buy_err +51.09 kWh).
 * forecastSpanRepair (nightLedgerScoring.ts) picks the rows at least an hour short:
 *  - within the re-capture horizon (the raw-sample retention and the 60-day sweep, less a
 *    2-day margin) the outcome is reset exactly as repairPrematureNightOutcomes resets it,
 *    and the sweep re-captures it over the full span — re-scored on the current scorer;
 *  - past it, the telemetry is gone or the sweep would never return to the row, so only
 *    `score_notes` gains a clause saying the errors under-count — a TAG, not a rewrite;
 *  - (review) a row inside the horizon that today's devices cannot re-score faithfully — no
 *    `pv_model_sns` (no roster check) or a pre-v1.187.3 delivered figure — is tagged too
 *    (forecastSpanRecapturable).
 * Rows are corrected in place — never deleted.
 */
function repairShortForecastSpanOutcomes(): void {
  try {
    const nowMs = Date.now();
    const horizonMs = forecastSpanRecaptureHorizonMs(
      config.retentionDays, LEDGER_BACKFILL_SWEEP_DAYS,
    );
    const tagged: string[] = [];
    for (const y of recorder.readNightLedger(400)) {
      const r = forecastSpanRepair(y, nowMs, horizonMs);
      if (!r) continue;
      const shortH = (r.shortMs / HOUR_MS).toFixed(1);
      if (r.action === 'tag') {
        recorder.recordNightOutcome(String(y.plan_date), {
          score_notes: `${y.score_notes ?? ''} ${forecastSpanTagNote(r.shortMs)}`.trim(),
        });
        tagged.push(`${y.plan_date} (${shortH} h short)`);
        continue;
      }
      recorder.recordNightOutcome(String(y.plan_date), forecastSpanResetColumns(r.shortMs));
      app.log.info(`night-charge: reset ${y.plan_date} for re-capture — its PV/load actuals stopped ${shortH} h short of issue + 24 h (load ${y.actual_load_kwh ?? 'null'} kWh, buy_err ${y.buy_err_kwh ?? 'null'} kWh as captured).`);
    }
    if (tagged.length > 0) {
      app.log.info(`night-charge: tagged ${tagged.length} ledger row(s) whose PV/load actuals stopped short of issue + 24 h and are past the re-capture horizon — kept as captured: ${tagged.join(', ')}.`);
    }
  } catch (e: any) {
    app.log.debug(`night-charge: forecast-span repair skipped (${e?.message ?? e})`);
  }
}

/**
 * v1.187.0 — once per boot, idempotent: tag the rows in KNOWN_FLEET_MISMATCH_PV_ROWS
 * (nightLedgerScoring.ts) whose PV band predates `pv_model_sns` but is established to
 * have been built for other Cores than the actuals. A TAG, not a rewrite: only
 * `pv_verdict_set_aside` is written, the captured `pv_in_band` / `pv_err_frac` stay, and
 * each tag is logged. Matched on plan_date AND issued_at_ms, so no other ledger matches.
 */
function tagKnownFleetMismatchPvRows(): void {
  try {
    for (const y of recorder.readNightLedger(400)) {
      if (y.outcome_captured_at_ms == null || y.pv_verdict_set_aside != null) continue;
      const reason = knownFleetMismatchReason(y);
      if (reason == null) continue;
      recorder.recordNightOutcome(String(y.plan_date), { pv_verdict_set_aside: reason });
      app.log.info(`night-charge: ledger ${y.plan_date} — ${reason} (pv_in_band was ${y.pv_in_band ?? 'null'}, pv_err_frac ${y.pv_err_frac ?? 'null'}).`);
    }
  } catch (e: any) {
    app.log.debug(`night-charge: known fleet-mismatch tagging skipped (${e?.message ?? e})`);
  }
}

/**
 * v1.129.0 — supervised-write interlock for a multi-panel plant.
 *
 * Every hardware write below resolves its target panel by re-running the
 * singleton lookup on the CURRENT snapshot; none of them pins the SN they wrote
 * to. With two panels that is a wrong-panel write waiting to happen: apply to
 * panel A, restart, and the retry or revert lands on panel B — leaving panel A
 * pinned at a raised reserve with a third of the house pool withheld during an
 * outage, and nothing that will ever bring it down.
 *
 * So while the census sees more than one panel, APPLY-direction writes are
 * refused. The REVERT direction is deliberately NOT interlocked: blocking an
 * apply is fail-safe, blocking a revert is not — it would strand exactly the
 * pinned-reserve state this is meant to avoid. Retired by Phase 4, which pins
 * the SN into the actuation state.
 */
function multiPanelWriteBlock(): string | null {
  const devices = store.get().devices;
  const panels = shp2Panels(devices);
  // v1.185.0 (review) — a MISSING pin blocks at any panel count (a lone replacement panel included).
  const missing = Object.values(devices).find((d) => d.housePanelMissing != null)?.housePanelMissing;
  if (missing) return `the pinned house panel (${missing}) is not on the account — supervised writes are blocked; nothing is retargeted (pin a panel: POST /api/house-panel)`;
  if (panels.sns.length <= 1) return null;
  // v1.185.0 — PHASE 4: the target is pinned. Every supervised write resolves its panel through
  // findShp2, which returns only the pinned house panel (the pin is persisted, so a retry or
  // revert after a restart lands on the same panel, and POST /api/house-panel refuses to move it
  // while a write is outstanding). What stays blocked is two panels with none pinned.
  if (Object.values(devices).some((d) => d.housePanel === true)) return null;
  return `two smart panels present (${panels.sns.join(', ')}) and none pinned as the house panel — supervised writes are blocked; revert remains enabled (pin one: POST /api/house-panel)`;
}

/**
 * v1.50.0 — the supervised-write actuator tick (60 s). decideActuation is pure
 * and fail-closed; this driver executes its action through the audited write
 * helper (setBackupReserveSoc) and persists every observed transition. The
 * REVERT side runs regardless of mode — a raised reserve must come back down
 * even if the owner flips the option to advisory mid-night.
 */
let nightActuationInFlight = false;
/**
 * v1.84.0 — Charge Now responder tick (see chargeNowResponder.ts). Consumes
 * the peak-grid-draw observation published by the alert monitor; never
 * re-derives the economics. Supervised writes go through the audited
 * setChannelForceCharge with device readback (a cloud ACK is not an
 * actuation — v1.79.0's lesson applies here from day one).
 */
const chargeNowState = freshResponderState();
const CHARGE_NOW_MODE = resolveChargeNowMode(process.env.CHARGE_NOW_RESPONSE);

async function runChargeNowTick(): Promise<void> {
  try {
    const obs = getLastPeakDrawObservation();
    const nowMs = Date.now();
    if (!obs || nowMs - obs.atMs > 3 * 60_000) return; // stale basis = no action
    const snap = store.get();
    const stormPrepActive = (snap.alerts ?? []).some((a: any) => typeof a?.id === 'string' && a.id.startsWith('storm-'));
    const action = decideChargeNowResponse(chargeNowState, {
      mode: CHARGE_NOW_MODE,
      verdictActive: obs.verdict.active,
      slots: obs.forceChargeSlots,
      stormPrepActive,
      nowMs,
      siteDay: siteYmd(nowMs),
    });
    if (action.kind === 'none') return;
    const shp2 = findShp2(snap.devices);
    const names = 'on' in action ? action.on.map((s) => `${s.label} (AC${s.slot})`).join(', ') : '';

    if (action.kind === 'stormHold') {
      app.log.info('charge-now: response HELD — a storm pre-charge advisory is active; an operator pre-charging ahead of weather outranks the bill.');
      return;
    }
    if (action.kind === 'advise') {
      app.log.warn(`charge-now: ADVISORY — force charge is ON during on-peak for ${names}; CHARGE_NOW_RESPONSE=advisory so no write is made.`);
      await sendNotification(loadNotifyConfig(), {
        severity: 'warning', dedupId: 'charge_now_response',
        title: 'Charge Now is buying on-peak',
        body:
          `Force charge (the app's "Charge Now") is ON for ${names} while the plant buys grid power on-peak `
          + 'with the pool comfortably above reserve. Turn it off in the EcoFlow app on that unit — or set '
          + 'the add-on option "Charge Now Response" to supervised to have this handled automatically.',
      });
      return;
    }
    if (action.kind === 'turnOff' || action.kind === 'retryWrite') {
      if (!shp2) return;
      const slots = action.kind === 'turnOff' ? action.on.map((s) => s.slot) : action.slots;
      app.log.warn(`charge-now: ${action.kind === 'turnOff' ? 'SUPERVISED OFF' : 'readback retry'} — writing FORCE_CHARGE_OFF for slot(s) ${slots.join(', ')}.`);
      if (action.kind === 'turnOff') {
        void broadcast.announce(
          'medium',
          `Advisory. Charge Now was buying grid power on peak for ${action.on.map((s) => s.label).join(' and ')}. The panel is turning it off now.`,
          `Aviso. La carga inmediata estaba comprando energía de la red en horario punta para ${action.on.map((s) => s.label).join(' y ')}. El panel la está desactivando ahora.`,
        ).then(
          (a) => { if (!a.ok) app.log.info(`charge-now: announce suppressed (${a.error ?? 'unknown'})`); },
          () => { /* fire-and-forget; result handled by announce's own logging */ },
        );
        await sendNotification(loadNotifyConfig(), {
          severity: 'warning', dedupId: 'charge_now_response',
          title: 'Charge Now: turning force charge OFF',
          body:
            `Force charge was ON for ${names} while buying on-peak with the pool above reserve. `
            + 'The panel is writing FORCE_CHARGE_OFF through the audited path and will verify against the device.',
        });
      }
      for (const slot of slots) {
        const cnBlocked = multiPanelWriteBlock();
        if (cnBlocked) { app.log.warn(`charge-now: clear refused — ${cnBlocked}`); continue; }
        const r = await setChannelForceCharge({ sn: shp2.sn, slot, on: false, source: { ua: 'charge-now-responder' } });
        if (r.outcome !== 'success') app.log.warn(`charge-now: slot ${slot} write ${r.outcome} (${r.code ?? ''} ${r.message ?? ''})`);
      }
      return;
    }
    if (action.kind === 'verified') {
      app.log.info(`charge-now: VERIFIED by device readback — force charge OFF on slot(s) ${action.slots.join(', ')}; the on-peak buy ends with this poll cycle.`);
      return;
    }
    if (action.kind === 'verifyFailed') {
      app.log.error(`charge-now: write NEVER TOOK EFFECT — slot(s) ${action.slots.join(', ')} still read FORCE_CHARGE_ON after retries. Turn it off in the EcoFlow app.`);
      await sendNotification(loadNotifyConfig(), {
        severity: 'warning', dedupId: 'charge_now_response_failure',
        title: 'Charge Now: force-charge OFF did not take effect',
        body:
          `The panel wrote FORCE_CHARGE_OFF but the device still reads ON for slot(s) ${action.slots.join(', ')} after a retry. `
          + 'Turn Charge Now off in the EcoFlow app on that unit — and note this alongside the reserve-write issue for EcoFlow support.',
      });
      return;
    }
  } catch (e: any) {
    app.log.warn(`charge-now: tick failed (${e?.message ?? e})`);
  }
}

/**
 * v1.83.0 — settings-drift watchdog tick (see settingsDrift.ts). Read-only:
 * extract the fleet's settings surface from the raw quota, confirm changes on
 * two consecutive observations, classify the actuator's own reserve writes,
 * and push one batched [Medium] notification for external changes — held
 * through the notify quiet window like resolves are.
 * v1.187.20 — the held push is ON DISK (settings-drift-held.json, beside the
 * baseline), rehydrated here at module load, before the first tick: a restart
 * inside the quiet window lost it on 2026-10-10 (settingsDriftHold.ts). What
 * follows the evaluation (adopt, or classify → commit → flush on every tick)
 * is settleDriftTick there, so the tests drive the code that ships.
 */
const settingsDriftState = freshDriftState();
settingsDriftState.confirmed = loadConfirmedSurface(); // null on first boot = silent adoption
const DRIFT_QUIET = parseNotifyQuiet(process.env.NOTIFY_QUIET_HOURS ?? '22-06');
const driftHoldLog: DriftHoldLog = { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) };
const driftHold = new DriftHoldQueue({
  path: driftHeldPath(),
  isQuiet: (now) => DRIFT_QUIET != null && inNotifyQuiet(now, DRIFT_QUIET),
  send: (msg) => sendNotification(loadNotifyConfig(), msg),
  log: driftHoldLog,
});

function settingsSurfaceDevices(): SurfaceDevice[] {
  const snap = store.get();
  const out: SurfaceDevice[] = [];
  for (const d of Object.values(snap.devices) as any[]) {
    const kind = d?.projection?.kind;
    if (kind !== 'shp2' && kind !== 'dpu') continue;
    out.push({ sn: d.sn, label: d.deviceName ?? d.sn, kind, raw: store.getRaw(d.sn) });
  }
  return out;
}

/**
 * The classifier's context for a confirmed drift change: which of this add-on's own writes
 * are in flight. Read from this module's actuator memory; settleDriftTick calls it only when
 * a change is confirmed.
 */
function driftActuatorContext(nowMs: number): ActuatorContext {
  // v1.189.0 — per leg (chargeCycle.legDriftActive): the leg whose write a reserve change now could
  // be — of the trailing, active and pending legs. The overnight leg keeps the rule this has always
  // applied, so with one leg the attribution is today's; a mid-day leg's armed 21:30 → 10:00 span
  // is not attributed (only its apply window and its write to 15 min after the last restore).
  // A leg that left the cycle (promoted from, or a trailing leg done) stays in it for the drift
  // tail: its restore or OFF is confirmed a drift tick or two after it left (nightCycleDeparted).
  const own = cycleDriftLeg(nightCycleView(), nowMs, nightCycleDeparted);
  const nightActive = own != null;
  const reserveLeg = own ?? nightActuationMem;
  // v1.115.0 — an owner-floor write through /api/reserve-floor was being
  // reported back as an EXTERNAL change at warn level ~3 min later (the
  // add-on flagging its own write as third-party tampering). Own-write
  // attribution covered the night-charge path only. The grace window is
  // supplied here so classifyChange stays clock-free.
  const ownerFloorPct =
    ownerFloorWrite != null && nowMs - ownerFloorWrite.atMs <= OWNER_FLOOR_WRITE_GRACE_MS
      ? ownerFloorWrite.pct
      : null;
  // v1.165.0 — our own force-charge ON/OFF (and the ceiling sync) are not
  // "external" (forceChargeDriftActive). v1.189.0 — the active leg's, or the trailing leg's while
  // its OFF is in flight or recent (its re-sends are ours too), or a leg that left the cycle within
  // the drift tail (chargeCycle.forceChargeDriftLeg; with one leg, the active leg).
  const act = forceChargeDriftLeg(nightCycleView(), nightCycleDeparted, nowMs, (l) => forceChargeDriftActive(l, nowMs));
  const forceChargeActive = forceChargeDriftActive(act, nowMs);
  // v1.187.10 — and only what it COMMANDED is its own write (forceChargeCommandsOf):
  // inside that window the panel's own ceiling stop turns slots OFF before ours.
  return {
    targetPct: reserveLeg.targetPct, priorReservePct: reserveLeg.priorReservePct, nightActive, ownerFloorPct, forceChargeActive,
    forceChargeCommands: forceChargeCommandsOf(act),
  };
}

/** v1.165.0 — a record's force-charge writes are in flight, or were made within the last 15
 *  minutes: the same tail as the reserve, since the slots read back OFF a poll or two after the
 *  write. (v1.189.0: a function, so the trailing leg is judged by the same rule.) */
function forceChargeDriftActive(act: NightActuationState, nowMs: number): boolean {
  return forceChargeInFlight(act) ||
    (act.forceChargeOffVerifiedAtMs != null && nowMs - act.forceChargeOffVerifiedAtMs < 15 * 60_000) ||
    (act.forceChargeCeilingAttemptedAtMs != null && nowMs - act.forceChargeCeilingAttemptedAtMs < 15 * 60_000) ||
    // v1.173.0 — and the RESTORE: on a night whose force-charge never started, the 05:00
    // restore of the panel's own ceiling was pushed as an external "Setting changed".
    (act.forceChargeCeilingRestoreLastAttemptMs != null && nowMs - act.forceChargeCeilingRestoreLastAttemptMs < 15 * 60_000);
}

function runSettingsDriftTick(): void {
  try {
    const surface = extractSettingsSurface(settingsSurfaceDevices());
    const evaln = evaluateDrift(settingsDriftState, surface);
    // v1.187.20 — adopt, or classify → commit → flush (the flush on EVERY tick): settleDriftTick
    // in settingsDriftHold.ts. The classify and commit run before it returns; the push resolves later.
    void settleDriftTick({
      queue: driftHold, state: settingsDriftState, evaluation: evaln, now: new Date(), log: driftHoldLog,
      context: driftActuatorContext,
    }).catch((e: any) => app.log.warn(`settings-drift: tick failed (${e?.message ?? e})`));
  } catch (e: any) {
    app.log.warn(`settings-drift: tick failed (${e?.message ?? e})`);
  }
}

/**
 * v1.90.0 (B5) — long-offline reconnect auto-audit tick (see reconnectAudit.ts).
 * Core 2 returns ~Sept 1; the transition audit must not depend on a human
 * noticing the flip. Arms after 24h continuous offline (tenure persisted in a
 * sidecar so a deploy during the wait cannot reset the clock), then on
 * reconnect collects a 30-min checkpoint window and delivers ONE [Medium]
 * report push. Spares are excluded — expected-offline is the zombie gate's
 * domain, and a spare flip must never page.
 */
const reconnectWatchState = loadReconnectWatchState();
let reconnectPvCache: { value: number | null; atMs: number } = { value: null, atMs: 0 };
let reconnectTickInFlight = false;

async function reconnectPvCoverage(nowMs: number): Promise<number | null> {
  if (nowMs - reconnectPvCache.atMs < 5 * 60_000) return reconnectPvCache.value;
  try {
    const t: any = await analytics.report('totals', { sinceMs: nowMs - 24 * 3_600_000, untilMs: nowMs });
    reconnectPvCache = { value: t?.fleet?.pvCoverage ?? null, atMs: nowMs };
  } catch {
    reconnectPvCache = { value: null, atMs: nowMs };
  }
  return reconnectPvCache.value;
}

function reconnectObsDevices(): ReconnectDeviceObs[] {
  const out: ReconnectDeviceObs[] = [];
  // v1.92.0 — pool membership from the SHP2 roster, not the static literal. The
  // 2026-08-20 reconfiguration inverted that literal (Core 5 took a panel slot,
  // Core 3 went to the bench), so the bare allowlist check exempted a live home
  // Core from auditing while watching a bench unit — and powering that bench
  // unit down for service would have fired a pointless 30-min audit and push.
  const devices = store.get().devices;
  const roster = shp2ConnectedDpuSns(devices as any);
  for (const d of Object.values(devices) as any[]) {
    if (!isHomePoolDpu(d.sn, roster)) continue;
    // Kind falls back to the product name: a device cloud-dark since boot has
    // no projection, and that is exactly the device this watch exists for.
    const pk = d?.projection?.kind;
    const kind: ReconnectDeviceObs['kind'] =
      pk === 'dpu' || pk === 'shp2' ? pk
      : productKind(d.productName); // v1.191.0 (S8) — the same two tests, in the same order
    out.push({
      sn: d.sn, name: d.deviceName ?? d.sn, kind,
      online: d.online === true,
      lastUpdatedMs: d.lastUpdated ?? 0,
      packs: Array.isArray(d?.projection?.packs)
        ? d.projection.packs.map((p: any, i: number) => ({
            num: typeof p.num === 'number' ? p.num : i + 1,
            socPct: typeof p.soc === 'number' ? p.soc : null,
            spreadMv: typeof p.maxVolDiffMv === 'number' ? p.maxVolDiffMv : null,
          }))
        : undefined,
    });
  }
  return out;
}

async function runReconnectWatchTick(): Promise<void> {
  if (reconnectTickInFlight) return;
  reconnectTickInFlight = true;
  try {
    const nowMs = Date.now();
    const devices = reconnectObsDevices();
    // pvCoverage is only consulted at the flip and in the report; fetch it only
    // while an armed tenure or a live audit could consume it (multi-day
    // outages — rare), at most once per 5 min.
    const anyArmed = Object.values(reconnectWatchState.offlineSinceMs)
      .some((t) => nowMs - t >= RECONNECT_ARM_MS);
    const pv = anyArmed || reconnectWatchState.audit != null ? await reconnectPvCoverage(nowMs) : null;
    const liveIds = new Set(monitor.activeAlertIds());
    const offlineActiveBySn = new Set(devices.filter((d) => liveIds.has(`offline-${d.sn}`)).map((d) => d.sn));
    const ev = evaluateReconnectWatch(reconnectWatchState, devices, offlineActiveBySn, pv, nowMs);
    saveReconnectWatchState(reconnectWatchState);
    if (ev.kind === 'armed') {
      app.log.info(`reconnect-watch: ${ev.name} (${ev.sn}) offline ${(ev.offlineForMs / 3_600_000).toFixed(1)}h — audit ARMED for its return`);
    } else if (ev.kind === 'auditStarted') {
      app.log.warn(`reconnect-watch: ${ev.name} (${ev.sn}) is BACK after ${(ev.offlineForMs / 86_400_000).toFixed(1)} days — 30-min transition audit running`);
    } else if (ev.kind === 'report') {
      const msg = renderReconnectReport(ev.report);
      app.log.warn(`reconnect-watch: ${msg.title} — ${msg.body}`);
      await sendNotification(loadNotifyConfig(), {
        severity: 'warning', dedupId: `reconnect_audit_${ev.report.sn}`, title: msg.title, body: msg.body,
      }).catch((e: any) => app.log.warn(`reconnect-watch: report push failed (${e?.message ?? e}) — report is in the log above`));
    }
  } catch (e: any) {
    app.log.warn(`reconnect-watch: tick failed (${e?.message ?? e})`);
  } finally {
    reconnectTickInFlight = false;
  }
}

/**
 * v1.82.0 — vendor energy-history daily job. Fires once per site day in the
 * [06:35, 09:00) window (after the digest, before solar ramps the poll budget's
 * importance), fetching YESTERDAY's vendor ledger and reconciling the two
 * like-basis pairs (home ↔ panelLoadWh, solar ↔ pvWh). Day-keyed latch in the
 * sidecar survives restarts. ~19 sequential vendor requests, 400ms spacing.
 */
let vendorEnergyJobInFlight = false;
async function runVendorEnergyJob(): Promise<void> {
  if (vendorEnergyJobInFlight) return;
  vendorEnergyJobInFlight = true;
  try {
    const nowMs = Date.now();
    const today = siteYmd(nowMs);
    const state = loadVendorEnergyState();
    if (state.lastRunDay === today) return;
    const nowMin = siteMinuteOfDay(nowMs);
    if (nowMin < 6 * 60 + 35 || nowMin >= 9 * 60) return;
    const shp2 = findShp2(store.get().devices);
    if (!shp2) return;
    const yesterdayYmd = addDaysYmd(today, -1); // T14/CA26 — the site calendar's previous day
    app.log.info(`energy-history: fetching the vendor ledger for ${yesterdayYmd}`);
    const vendor = await fetchVendorDay(shp2.sn, yesterdayYmd, (m) => app.log.warn(m));
    // Like-basis local totals for the same site day (v1.191.0, T14: the day the vendor is asked for,
    // on the same clock; it was the host's previous midnight + 24 h).
    let local: VendorDayRecord['local'] = null;
    try {
      const dayStart = siteDayStartMs(yesterdayYmd);
      const t: any = await analytics.report('totals', { sinceMs: dayStart, untilMs: siteDayStartMs(today) });
      local = {
        panelLoadWh: t?.fleet?.panelLoadWh ?? null, pvWh: t?.fleet?.pvWh ?? null, pvCoverage: t?.fleet?.pvCoverage ?? null,
        // v1.89.0 — gross pack-DC flows for the local round-trip ratio (B2).
        batteryChargeWh: t?.fleet?.batteryChargeWh ?? null, batteryDischargeWh: t?.fleet?.batteryDischargeWh ?? null,
      };
    } catch (e: any) {
      app.log.warn(`energy-history: local totals unavailable for ${yesterdayYmd} (${e?.message ?? e})`);
    }
    const partialPv = local?.pvCoverage != null && local.pvCoverage < 0.95;
    const rec: VendorDayRecord = {
      ...vendor, local,
      driftHomePct: driftPct(vendor.homeWh, local?.panelLoadWh ?? null),
      driftSolarPct: driftPct(vendor.solarWh, local?.pvWh ?? null),
      // v1.87.0 — with a partial local basis, the drift IS the dark capacity's
      // production; record it as such instead of leaving an unexplained gap.
      impliedDarkPvWh: partialPv && vendor.solarWh != null && local?.pvWh != null
        ? Math.max(0, vendor.solarWh - local.pvWh) : null,
    };
    state.days[yesterdayYmd] = rec;
    state.lastRunDay = today;
    saveVendorEnergyState(state);
    const kwh = (wh: number | null) => (wh == null ? '—' : (wh / 1000).toFixed(1));
    app.log.info(
      `energy-history: ${yesterdayYmd} vendor home ${kwh(rec.homeWh)} kWh (local ${kwh(local?.panelLoadWh ?? null)}, drift ${rec.driftHomePct ?? '—'}%), `
      + `solar ${kwh(rec.solarWh)} (local ${kwh(local?.pvWh ?? null)}, drift ${rec.driftSolarPct ?? '—'}%${rec.impliedDarkPvWh != null ? `, PARTIAL basis pvCoverage ${(local?.pvCoverage ?? 0).toFixed(2)} — dark-core production ≈ ${kwh(rec.impliedDarkPvWh)} kWh` : ''}), `
      + `grid ${kwh(rec.gridWh)}, battery in ${kwh(rec.batteryInWh)} / out ${kwh(rec.batteryOutWh)}, `
      + `generator ${kwh(rec.generatorWh)}, ${rec.circuits.length}/${SHP2_CIRCUIT_COUNT} circuits.`,
    );
    // v1.85.0 — bounded backfill: up to 10 older missing days per morning,
    // converging on the 60-day horizon in about a week without ever competing
    // with the live poll budget outside this window.
    await runVendorBackfill(10);
    // v1.85.0 — empirical RTE (advisory): report what the vendor's own
    // battery in/out imply, never wire it into buy sizing yet.
    const all = loadVendorEnergyState();
    // v1.89.0 (B2) — the pack-DC round-trip ratio, an upper bound on dispatch
    // RTE (conversion losses excluded). Advisory; DISPATCH_RTE stays 0.86.
    const packRte = computeLocalPackRte(Object.values(all.days), membershipStableOnDay);
    if (packRte.packDcRte != null) {
      app.log.info(`energy-history: pack-DC round-trip ratio ${packRte.packDcRte} over ${packRte.sampleDays} day(s) (charge ${(packRte.chargeWh / 1000).toFixed(1)} kWh, discharge ${(packRte.dischargeWh / 1000).toFixed(1)} kWh) — DC basis: an UPPER BOUND on the 0.86 AC dispatch RTE, not a replacement.`);
    }
    // v1.89.0 (B1) — give the ledger back to HA as gap-free external
    // statistics (idempotent full re-import; failures retry tomorrow).
    try {
      const exp = await exportVendorStatistics(Object.values(all.days), (m) => app.log.warn(m));
      if (exp.exported.length) app.log.info(`ha-stats: exported ${exp.exported.length} vendor series to Home Assistant statistics (${Object.keys(all.days).length} days each; pick the "EcoFlow ledger" series in the Energy dashboard for gap-free history).`);
    } catch (e: any) {
      app.log.warn(`ha-stats: export failed (${e?.message ?? e}) — retries tomorrow`);
    }
    const rte = computeEmpiricalRte(Object.values(all.days));
    if (rte.rte != null && rte.interpretation === 'rte') {
      app.log.info(`energy-history: empirical RTE ${rte.rte} over ${rte.sampleDays} qualifying day(s) (in ${(rte.totalInWh / 1000).toFixed(1)} kWh, out ${(rte.totalOutWh / 1000).toFixed(1)} kWh) — DISPATCH_RTE stays 0.86 until this baseline is trusted.`);
    } else if (rte.rte != null) {
      app.log.info(`energy-history: vendor battery-in reads GRID-ONLY (out/in ${rte.rte} over ${rte.sampleDays} day(s) — impossible as an efficiency); treating it as bought-energy-into-the-pool, not an RTE input.`);
    }
  } catch (e: any) {
    app.log.warn(`energy-history: daily job failed (${e?.message ?? e}) — retries on the next tick within the window`);
  } finally {
    vendorEnergyJobInFlight = false;
  }
}

let vendorBackfillInFlight = false;
async function runVendorBackfill(cap: number): Promise<{ fetched: string[] }> {
  if (vendorBackfillInFlight) return { fetched: [] };
  vendorBackfillInFlight = true;
  try {
    const shp2 = findShp2(store.get().devices);
    if (!shp2) return { fetched: [] };
    const state = loadVendorEnergyState();
    const today = siteYmd(Date.now());
    const incomplete = new Set(Object.entries(state.days).filter(([, r]) => isIncompleteDay(r)).map(([d]) => d));
    const targets = missingDays(new Set(Object.keys(state.days)), today, 60, cap, incomplete);
    const fetched: string[] = [];
    for (const day of targets) {
      const vendor = await fetchVendorDay(shp2.sn, day, (m) => app.log.warn(m));
      state.days[day] = { ...vendor, local: null, driftHomePct: null, driftSolarPct: null };
      fetched.push(day);
      saveVendorEnergyState(state); // save per day — a crash keeps progress
    }
    if (fetched.length) app.log.info(`energy-history: backfilled ${fetched.length} day(s): ${fetched.join(', ')}`);
    return { fetched };
  } finally {
    vendorBackfillInFlight = false;
  }
}

async function runNightActuationTick(): Promise<void> {
  if (nightActuationInFlight) return;
  nightActuationInFlight = true;
  try {
    // v1.189.0 — the charge cycle's own steps (chargeCycle.ts), each in its own try; with one leg
    // neither has anything to do. A trailing leg's force-charge OFF goes first — an OFF, as in the
    // close-off-first order below — then the cycle step: a trailing leg that resolved leaves, and a
    // resolved active leg hands over to the next pending one.
    try { await runTrailingLegTick(); }
    catch (e: any) { app.log.warn(`night-charge: trailing-leg tick failed (${e?.message ?? e})`); }
    try { runCycleStep(); }
    catch (e: any) { app.log.warn(`night-charge: cycle step failed (${e?.message ?? e})`); }
    // v1.165.0 — the force-charge step runs AFTER the reserve step (whose tick returns
    // early on 'none' for most of the window) and re-reads state fresh, so the START rides
    // the reserve the step just verified. Each step in its own try (runActuationSteps): a
    // failure of one must never break the other.
    // v1.187.0 (review) — except when a force-charge OFF is already due (window closed,
    // cancelled, reverted): then the OFF goes first (actuationStepOrder). With the restore
    // now due at the close itself, the OFF otherwise waited behind the revert PUT on the
    // same tick while the Cores kept grid-charging at the off-peak rate.
    await runActuationSteps(actuationStepOrder(nightActuationMem, Date.now()), {
      reserve: () => runNightActuationTickInner(),
      forceCharge: () => runForceChargeTick(),
    }, (step, e: any) => {
      app.log.warn(`night-charge: ${step === 'reserve' ? 'actuation' : 'force-charge'} tick failed (${e?.message ?? e})`);
    });
    // v1.189.0 — a leg whose apply window passed with no write (chargeCycle.missedApplyDue).
    try { await runMissedApplyStep(); }
    catch (e: any) { app.log.warn(`night-charge: missed-apply step failed (${e?.message ?? e})`); }
  } finally {
    nightActuationInFlight = false;
  }
}

/** v1.166.0 — reasons already logged for the current night (one line per reason). */
let forceChargeWhyLogged: { day: string | null; reasons: Set<string> } = { day: null, reasons: new Set() };

/** The shared grid-input envelope (ARB_GRID_INPUT_CAP_KW; see the planner's note on why
 *  17 kW): ≤0 or unparseable ⇒ null (contention not modelled). One reader for the planner
 *  and — v1.169.0 — the force-charge start, so the two can never disagree. */
function gridInputCapKwFromEnv(): number | null {
  // v1.191.0 (S3b) — the config.ts row keeps the rule: Number(raw ?? 17), ≤0 or unparseable ⇒ null.
  return option<number | null>('ARB_GRID_INPUT_CAP_KW');
}

/** v1.166.0 — tonight's force-charge decision, stated on the 21:30 ARMED line. */
function forceChargeArmNote(armed: NightActuationState): string {
  if (!forceChargeOn()) return 'Force-charge: off (disabled by options).';
  const c = armed.forceChargeCeilingPct;
  if (c == null) return 'Force-charge: none tonight (no economic ceiling announced) — reserve-only.';
  if (c <= RESERVE_WRITE_MAX_PCT) {
    return `Force-charge: none tonight — the ${c}% target is at or below the ${RESERVE_WRITE_MAX_PCT}% reserve, which reaches it alone.`;
  }
  return `Force-charge: ELIGIBLE — just in time to reach ~${c}% by the window close (from the open, if the pack needs the whole window); OFF when it gets there (software stop; panel ceiling ${desiredForceChargeCeilingPct(c)}% as backstop).`;
}

/**
 * v1.165.0 — the night force-charge step (see nightForceCharge.ts for the rails).
 * `forceDisabled` is the master-switch safety tick: it can only ever switch OFF.
 */
async function runForceChargeTick(opts: { forceDisabled?: boolean } = {}): Promise<void> {
  const state = nightActuationMem;
  if (state.day == null) return;
  const nowMs = Date.now();
  const shp2 = findShp2(store.get().devices);
  if (!shp2) {
    // v1.168.0 — no panel to write to, but the wall-clock deadline needs none: a
    // force-charge of ours that cannot be switched off or confirmed must still alarm.
    // Every input is "unknown", so only the deadline escalation can come back.
    const blind = decideForceCharge(state, nowMs, {
      enabled: false, gridPresent: null, gridStaLost: false, slotsOn: null, connectedSlots: [],
      vitalsRed: false, socCoherent: false, ceilingReadbackPct: null, poolSocPct: null, fullKwh: null,
      maxRunMs: forceChargeMaxRunNow(), // v1.191.0 (S6, W5) — 7 h on the APS preset
    });
    if (blind.kind === 'offFailed') await escalateForceChargeStuck(state, blind);
    return;
  }
  // Same R3 rule as the reserve readback: a frozen projection never decides. The
  // OFF triggers are time/cancel/grid based, so a stale readback still switches OFF
  // at window end — only the START and the VERIFY wait for a live reading.
  const sp: any = shp2.projection?.kind === 'shp2' && shp2ReadbackFresh(shp2, nowMs) ? shp2.projection : null;
  const sources: any[] | null = Array.isArray(sp?.sources) ? sp.sources : null;
  const slotsOn = sources == null ? null
    : sources.filter((c) => c?.forceCharge === 'FORCE_CHARGE_ON').map((c) => Number(c.slot)).filter(Number.isInteger);
  const connectedSlots = (sources ?? [])
    .filter((c) => c?.hwConnect === true).map((c) => Number(c.slot)).filter(Number.isInteger);
  // v1.186.0 — each slot's Core SoC from the SAME fresh readback, for the ON verify's
  // at-the-ceiling exemption. A stale readback gives none (sources is null).
  const slotSocPct: Record<number, number | null> | null = sources == null ? null
    : Object.fromEntries(sources
      .filter((c) => Number.isInteger(Number(c?.slot)))
      .map((c) => [Number(c.slot), typeof c?.batteryPercentage === 'number' && Number.isFinite(c.batteryPercentage) ? c.batteryPercentage : null]));
  const fullWh: number | null = sp?.backupFullCapWh ?? null;
  const socNowPct: number | null = sp?.backupBatPercent ?? null;
  const remainWh: number | null = sp?.backupRemainWh ?? null;
  const socCoherent =
    fullWh != null && fullWh > 0 && socNowPct != null && remainWh != null &&
    Math.abs((remainWh / fullWh) * 100 - socNowPct) <= 8;
  const gridNow = liveGridBackstop(store.get().devices);
  // v1.169.0 — the charge rate the start is timed with: the grid-import cap less the live
  // house load, through the charge leg. The house shares the cap, so this moves with usage.
  const gridCapKw = gridInputCapKwFromEnv();
  const houseLoadKw = shp2HouseLoadKw(sp);
  const chargeRateKw = forceChargeRateKw({
    gridCapKw, houseLoadKw, legEff: Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY),
    // v1.170.0 — fewer Cores connected ⇒ bounded by what each is proven to take.
    slotCount: connectedSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS).length,
  });
  // …and the EV the live reading cannot see yet: the planner's predicted (P90) EV energy in
  // the rest of TONIGHT's window, which the pack will not get (review F1, 2026-09-18). Only
  // a plan for this same window counts; an EV already charging is counted twice (live load
  // and forecast), which errs toward starting early — the safe direction.
  const fcPlan = getLatestNightChargePlan();
  // v1.173.0 — through evDisplacedPackKwh: with a Core out, the EV first eats the slack the
  // per-Core bound leaves under the cap, so only the rest displaces pack charge.
  const fcLeg = Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY);
  const evDisplacedKwh =
    fcPlan?.window != null && fcPlan.window.endMs === state.windowEndMs
      && typeof fcPlan.evContention?.windowEvKwh === 'number' && Number.isFinite(fcPlan.evContention.windowEvKwh)
      ? evDisplacedPackKwh({
        evKwh: fcPlan.evContention.windowEvKwh,
        peakEvKw: typeof fcPlan.evContention.peakEvKw === 'number' ? fcPlan.evContention.peakEvKw : null,
        rateKw: chargeRateKw,
        unboundedRateKw: gridCapKw != null && houseLoadKw != null
          ? Math.max(FORCE_CHARGE_MIN_RATE_KW, (gridCapKw - Math.max(0, houseLoadKw)) * fcLeg) : null,
        legEff: fcLeg,
      })
      : null;
  const action = decideForceCharge(state, nowMs, {
    // v1.189.0 — per leg: a backup leg never force-charges (chargeWindows.legForceChargeEligible).
    enabled: !opts.forceDisabled && forceChargeOn(legRoleOf(state)),
    // v1.179.0 — tri-state: null when presence is false only because nothing can be heard.
    gridPresent: gridNow.present ? true : gridNow.presenceUnknown ? null : false,
    // Connected is gridSta === 1 ONLY (docs/reference/02-1-cloud-protocol-and-snapshot.md
    // “Backup pool + grid presence”): 2 is islanded, 0 absent.
    gridStaLost: sp != null && typeof sp.gridSta === 'number' && sp.gridSta !== 1,
    slotsOn,
    connectedSlots,
    slotSocPct, // v1.186.0 — the ON verify's at-the-ceiling exemption
    vitalsRed: currentAssessment()?.level === 'crit',
    socCoherent,
    ceilingReadbackPct: typeof sp?.forceChargeCeilingSoc === 'number' ? sp.forceChargeCeilingSoc : null,
    // v1.167.0 — times the just-in-time start and ends the charge at the target. Only a
    // fresh, coherent reading: an unknown SoC never starts one and never stops one early.
    poolSocPct: socCoherent ? socNowPct : null,
    fullKwh: fullWh != null && fullWh > 0 ? fullWh / 1000 : null,
    // Blind OFF re-sends stop at the next charge window's open at the latest (blindResendStopMs):
    // v1.189.0 — the next cost leg pending in the cycle, else the latest plan's window, when it
    // opens after this night's closes (chargeCycle.nextForceChargeOpenMs).
    nextLegOpenMs: nextForceChargeOpenMs(state, nightCyclePending, fcPlan?.window?.startMs),
    chargeRateKw,
    evDisplacedKwh,
    // v1.191.0 (S6, W5) — the run backstop of the tariff in effect: 7 h on the APS preset.
    maxRunMs: forceChargeMaxRunNow(),
  });
  if (action.kind === 'none') {
    // v1.166.0 — "chose not to" must never read like "broke". While a night is live
    // (reserve applied, not reverted, force-charge not started), say WHY the start
    // is declined — each distinct reason once per night.
    const live = state.appliedAtMs != null && state.revertedAtMs == null && !state.cancelled
      && state.forceChargeOnAtMs == null;
    if (live && action.why) {
      if (forceChargeWhyLogged.day !== state.day) forceChargeWhyLogged = { day: state.day, reasons: new Set() };
      if (!forceChargeWhyLogged.reasons.has(action.why)) {
        forceChargeWhyLogged.reasons.add(action.why);
        app.log.info(`night-charge: force-charge NOT starting for ${state.day} — ${action.why}.`);
      }
    }
    return;
  }

  if (action.kind === 'syncCeiling') {
    const blocked = multiPanelWriteBlock();
    if (blocked) { app.log.warn(`night-charge: force-charge ceiling sync refused — ${blocked}`); return; }
    const retry = state.forceChargeCeilingAttemptedAtMs != null;
    persistNightActuation({
      ...nightActuationMem,
      forceChargeCeilingAttemptedAtMs: nowMs,
      forceChargeCeilingSyncRetries: retry ? nightActuationMem.forceChargeCeilingSyncRetries + 1 : 0,
      forceChargeCeilingPriorPct: nightActuationMem.forceChargeCeilingPriorPct ?? action.prior,
    });
    const rc = await setForceChargeCeiling({ sn: shp2.sn, pct: action.pct, source: { ua: 'night-force-charge' } });
    app.log.info(`night-charge: force-charge ceiling → ${action.pct}% (panel's own was ${action.prior ?? '?'}%, restored after the night)${retry ? ' — retry' : ''}: ${rc.outcome === 'success' ? 'ACK' : `${rc.code}: ${rc.message}`}. Force-charge waits for it to read back.`);
    return;
  }

  if (action.kind === 'restoreCeiling') {
    persistNightActuation({
      ...nightActuationMem,
      forceChargeCeilingRestoreAttempts: nightActuationMem.forceChargeCeilingRestoreAttempts + 1,
      forceChargeCeilingRestoreLastAttemptMs: nowMs,
    });
    const rc = await setForceChargeCeiling({ sn: shp2.sn, pct: action.pct, source: { ua: 'night-force-charge' } });
    const how = rc.outcome === 'success' ? 'ACK' : `${rc.code}: ${rc.message}`;
    if (action.lastAttempt) {
      app.log.warn(`night-charge: restoring the panel's force-charge ceiling to ${action.pct}% — LAST attempt (${how}). If it does not read back, a manual Charge Now will stop short; set the Charge Now limit back to ${action.pct}% in the EcoFlow app.`);
    } else {
      app.log.info(`night-charge: restoring the panel's force-charge ceiling to ${action.pct}% (${how}).`);
    }
    return;
  }

  if (action.kind === 'ceilingRestored') {
    persistNightActuation({ ...nightActuationMem, forceChargeCeilingRestoredAtMs: nowMs });
    app.log.info(`night-charge: the panel's own force-charge ceiling is back at ${state.forceChargeCeilingPriorPct}% (readback).`);
    return;
  }

  if (action.kind === 'on') {
    const blocked = multiPanelWriteBlock();
    if (blocked) { app.log.warn(`night-charge: force-charge ON refused — ${blocked}`); return; }
    // WRITE-AHEAD: persist the intent BEFORE the writes. A lost confirmation can
    // then never orphan a force-charge — the OFF covers every slot attempted.
    persistNightActuation({ ...nightActuationMem, forceChargeOnAtMs: nowMs, forceChargeSlots: action.slots });
    const results: string[] = [];
    let rejected = 0;
    for (const slot of action.slots) {
      const r = await setChannelForceCharge({ sn: shp2.sn, slot, on: true, source: { ua: 'night-force-charge' } });
      if (r.outcome !== 'success') rejected++;
      results.push(`ch${slot} ${r.outcome === 'success' ? 'ok' : `${r.code}`}`);
    }
    // v1.186.0 — the ON-verify grace runs from when the writes FINISHED, not from the stamp
    // above: each slot's cooldown starts when its own write goes out, so slow PUTs measured
    // from the stamp let the one re-issue land inside a later slot's cooldown, rate-limited.
    persistNightActuation({ ...nightActuationMem, forceChargeOnLastAttemptMs: Date.now() });
    stampLegOutcome(state, { force_charge_on_at_ms: nowMs }); // v1.189.0 — the ledger's force-charge stamps
    const slotsNow = connectedSlots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS).length;
    const unboundedKw = gridCapKw != null ? (gridCapKw - Math.max(0, houseLoadKw ?? 0)) * Math.sqrt(DISPATCH_ROUND_TRIP_EFFICIENCY) : null;
    const rateNote = (chargeRateKw != null
      ? (unboundedKw != null && chargeRateKw < unboundedKw - 1e-9 && chargeRateKw > FORCE_CHARGE_MIN_RATE_KW
        ? `timed at ~${chargeRateKw.toFixed(1)} kW (bounded by ${slotsNow} connected Core(s) × ${forceChargeKwPerCore()} kW)`
        : `timed at ~${chargeRateKw.toFixed(1)} kW (grid cap ${gridCapKw} kW less the house's ${Math.max(0, houseLoadKw ?? 0).toFixed(1)} kW, through the charge leg, floored at 1 kW)`)
      : (planRateFallbackKw(slotsNow) === FORCE_CHARGE_PLAN_RATE_KW
        ? `timed at the fixed ${FORCE_CHARGE_PLAN_RATE_KW} kW fallback (${gridCapKw == null ? 'no grid-input cap configured' : 'no live house load'})`
        // v1.191.0 (H2) — FORCE_CHARGE_KW_PER_CORE set and the slots known: the fallback is slots × that rate.
        : `timed at the ${planRateFallbackKw(slotsNow)} kW fallback (${slotsNow} connected Core(s) × ${forceChargeKwPerCore()} kW; ${gridCapKw == null ? 'no grid-input cap configured' : 'no live house load'})`))
      + (evDisplacedKwh != null && evDisplacedKwh > 0 ? `, plus ~${evDisplacedKwh.toFixed(1)} kWh the predicted EV will take` : '');
    // v1.186.0 — a rejected ON is no longer an info-level footnote: it is verified by
    // readback like an accepted one, re-issued once, then warned about.
    const onLine = `night-charge: FORCE-CHARGE ON for ${state.day} — ${results.join(', ')}; just in time to reach ${state.forceChargeCeilingPct}% by the window close (${new Date(state.windowEndMs!).toISOString()}), ${rateNote} — stops at the target, with the panel's ${desiredForceChargeCeilingPct(state.forceChargeCeilingPct!)}% ceiling as the backstop. Also OFF on window end, cancel, revert, grid loss or disable. Verifying ON by readback${rejected > 0 ? ` (${rejected} write(s) REJECTED — re-issued once if the slot does not read ON within ${Math.round(FORCE_CHARGE_ON_VERIFY_AFTER_MS / 60_000)} min)` : ''}.`;
    if (rejected > 0) app.log.warn(onLine); else app.log.info(onLine);
    return;
  }

  if (action.kind === 'onVerified') {
    persistNightActuation({ ...nightActuationMem, forceChargeOnVerifiedAtMs: nowMs });
    const on = (state.forceChargeSlots ?? []).filter((n) => !action.atCeiling.includes(n));
    app.log.info(`night-charge: force-charge ON VERIFIED by device readback for ${state.day} — slot(s) ${on.join(',') || 'none'} read FORCE_CHARGE_ON${action.atCeiling.length > 0 ? `; slot(s) ${action.atCeiling.join(',')} already at the panel's ceiling (switched off by the panel itself)` : ''}${state.forceChargeOnFailedAtMs != null ? ' (after the warning — it applied late)' : ''}.`);
    return;
  }

  if (action.kind === 'onRetry') {
    const blocked = multiPanelWriteBlock();
    if (blocked) { app.log.warn(`night-charge: force-charge ON re-issue refused — ${blocked}`); return; }
    // Write-ahead, as for the ON: the re-issue is spent BEFORE the writes, whatever the
    // cloud answers, so a cloud that keeps refusing ends in the warning, not a loop.
    persistNightActuation({
      ...nightActuationMem,
      forceChargeOnRetries: nightActuationMem.forceChargeOnRetries + 1,
      forceChargeOnLastAttemptMs: nowMs,
    });
    const results: string[] = [];
    let limited = 0;
    for (const slot of action.slots) {
      const r = await setChannelForceCharge({ sn: shp2.sn, slot, on: true, source: { ua: 'night-force-charge-retry' } });
      if (r.rateLimited === true) limited++;
      results.push(`ch${slot} ${r.outcome === 'success' ? 'ok' : `${r.code}`}`);
    }
    // v1.186.0 — the next grace runs from when these writes FINISHED; a re-issue whose every
    // write came back rate-limited never reached the panel, so it is handed back (the window-
    // end cutoff in verifyForceChargeOn still bounds it: past that the warning goes instead).
    const unspent = limited === action.slots.length;
    persistNightActuation({
      ...nightActuationMem,
      forceChargeOnLastAttemptMs: Date.now(),
      ...(unspent ? { forceChargeOnRetries: Math.max(0, nightActuationMem.forceChargeOnRetries - 1) } : {}),
    });
    if (unspent) results.push('all rate-limited — re-issue not counted');
    app.log.warn(`night-charge: force-charge ON NOT APPLIED — slot(s) ${action.slots.join(',')} still read FORCE_CHARGE_OFF ${Math.round((nowMs - (state.forceChargeOnLastAttemptMs ?? state.forceChargeOnAtMs ?? nowMs)) / 60_000)}m after the ON; re-issuing ON (retry ${state.forceChargeOnRetries + 1}/${FORCE_CHARGE_ON_MAX_RETRIES}): ${results.join(', ')}.`);
    return;
  }

  if (action.kind === 'onFailed') {
    // v1.186.0 — the buy above the reserve is forfeited on these slots. A cost, not a
    // safety, matter: the reserve write is verified on its own, and the OFF side (window
    // end, deadline) runs exactly as before. Once per night — the marker survives a restart.
    // v1.187.22 — and which slots: a failure on only some of ours is reported as such, here and in
    // the morning push (partialForceChargeOnFailureSlots).
    persistNightActuation({ ...nightActuationMem, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: [...action.slots] });
    const all = partialForceChargeOnFailureSlots({ forceChargeSlots: state.forceChargeSlots, forceChargeOnFailedSlots: action.slots }) == null;
    app.log.warn(`night-charge: force-charge ON NEVER TOOK EFFECT for ${state.day} — slot(s) ${action.slots.join(',')} still read FORCE_CHARGE_OFF after ${state.forceChargeOnRetries} re-issue(s)${action.noRetry ? ` (none sent: under ${Math.round(FORCE_CHARGE_ON_RETRY_CUTOFF_MS / 60_000)} min of the window left, so the window-end OFF is never held behind one)` : ''}, and their Cores do not read at the panel's ceiling. Tonight's buy above the ${RESERVE_WRITE_MAX_PCT}% reserve is forfeited${all ? '' : ' on those slot(s)'}; the reserve charge is unaffected, and the OFF at the window close still runs.`);
    try {
      // v1.187.22 — toward where it stops (~80%), as every other surface names it, not the ceiling.
      await sendNotification(loadNotifyConfig(), buildNightForceChargeOnFailure({
        day: state.day, slots: action.slots, ourSlots: state.forceChargeSlots, retries: state.forceChargeOnRetries,
        noRetry: action.noRetry === true, ceilingPct: state.forceChargeCeilingPct,
      }));
    } catch (e: any) {
      app.log.warn(`night-charge: force-charge ON-failure notify failed (${e?.message ?? e})`);
    }
    return;
  }

  if (action.kind === 'off' || action.kind === 'offRetry') {
    const isRetry = action.kind === 'offRetry';
    persistNightActuation({
      ...nightActuationMem,
      forceChargeOffAtMs: nightActuationMem.forceChargeOffAtMs ?? nowMs,
      forceChargeOffLastAttemptMs: nowMs,
      forceChargeOffReason: isRetry ? nightActuationMem.forceChargeOffReason : action.reason,
    });
    const results: string[] = [];
    let acked = 0;
    for (const slot of action.slots) {
      const r = await setChannelForceCharge({ sn: shp2.sn, slot, on: false, source: { ua: 'night-force-charge' } });
      if (r.outcome === 'success') acked++;
      results.push(`ch${slot} ${r.outcome === 'success' ? 'ok' : `${r.code}`}`);
    }
    // Only a write the cloud ACCEPTED is evidence the panel is ignoring us. A rejected
    // or rate-limited OFF never reached it, so it must not spend the readback budget.
    if (isRetry && acked > 0) {
      persistNightActuation({ ...nightActuationMem, forceChargeOffRetries: nightActuationMem.forceChargeOffRetries + 1 });
    }
    if (!isRetry && state.forceChargeOffAtMs == null) {
      stampLegOutcome(state, { force_charge_off_at_ms: nowMs, force_charge_off_reason: action.reason }); // v1.189.0
    }
    if (isRetry && action.kind === 'offRetry' && action.unconfirmed) {
      app.log.warn(`night-charge: force-charge NOT CONFIRMED OFF (no live panel readback) — re-sending OFF to slots ${action.slots.join(',')} every 15 min until a readback shows it off: ${results.join(', ')}`);
    } else if (isRetry) {
      app.log.warn(`night-charge: force-charge still reads ON (slots ${action.slots.join(',')}) — re-issuing OFF${nightActuationMem.forceChargeOffEscalated ? ' (escalated; re-issued every 15 min until it reads OFF)' : ` (retry ${nightActuationMem.forceChargeOffRetries})`}: ${results.join(', ')}`);
    } else {
      // v1.186.0 — an OFF over an ON no readback ever proved says so: a clean-looking
      // "OFF VERIFIED" next is not evidence the night bought anything above the reserve.
      const onNote = state.forceChargeOnVerifiedAtMs != null ? ''
        : state.forceChargeOnFailedAtMs != null ? ' (the ON never took effect — see the earlier warning)'
          : ' (the ON was never verified by readback)';
      app.log.info(`night-charge: FORCE-CHARGE OFF for ${state.day} (${action.reason === 'target' ? `reached the ${state.forceChargeCeilingPct}% target` : action.reason}) — ${results.join(', ')}; verifying by readback${onNote}.`);
    }
    return;
  }

  if (action.kind === 'offVerified') {
    persistNightActuation({ ...nightActuationMem, forceChargeOffVerifiedAtMs: nowMs });
    stampLegOutcome(state, { force_charge_off_verified_at_ms: nowMs }); // v1.189.0
    app.log.info(`night-charge: force-charge OFF VERIFIED by device readback for ${state.day}${state.forceChargeOffEscalated ? ' (after the escalation — resolved)' : ''}.`);
    return;
  }

  // action.kind === 'offFailed' — OFF re-issued and the panel still reads ON, or (v1.168.0)
  // the wall-clock deadline passed with nothing verified OFF.
  await escalateForceChargeStuck(state, action);
}

/**
 * The force-charge-stuck escalation. It costs money every on-peak hour it persists, so
 * it escalates like a stuck reserve does — audibly — and the OFF keeps being re-issued
 * every 15 min until it reads OFF. v1.168.0: also raised by the wall-clock deadline,
 * where there may be NO live readback — then the words say the OFF could not be
 * CONFIRMED, never that the panel "still reads ON".
 */
async function escalateForceChargeStuck(
  state: NightActuationState,
  action: Extract<ForceChargeAction, { kind: 'offFailed' }>,
  // v1.189.0 — the record it pages for: the active leg, or the trailing leg (runTrailingLegTick).
  leg: LegSlot = ACTIVE_LEG,
): Promise<void> {
  const repage = action.repage === true;
  if (repage) {
    // v1.173.0 — a deadline page that quiet hours silenced: speak it again (no second push).
    // Booked as muted until the announce says it was heard.
    leg.put({
      ...leg.get(),
      forceChargeOffDeadlineRepages: leg.get().forceChargeOffDeadlineRepages + 1,
      forceChargeOffDeadlineMutedAtMs: Date.now(),
    });
  } else {
    leg.put({
      ...leg.get(),
      forceChargeOffEscalated: true,
      // The deadline pages once, on its own record (see nightForceCharge.ts section 0).
      forceChargeOffDeadlinePagedAtMs: action.deadline ? Date.now() : leg.get().forceChargeOffDeadlinePagedAtMs,
    });
  }
  const unconfirmed = action.unconfirmed === true;
  const why = action.deadline
    ? (unconfirmed
      ? `not confirmed OFF by the deadline (window end + ${Math.round(FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS / 60_000)} min, or first OFF + ${Math.round(FORCE_CHARGE_OFF_DEADLINE_AFTER_OFF_MS / 60_000)} min) and there is NO live panel readback to show it off`
      : `still read FORCE_CHARGE_ON at the deadline (window end + ${Math.round(FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS / 60_000)} min, or first OFF + ${Math.round(FORCE_CHARGE_OFF_DEADLINE_AFTER_OFF_MS / 60_000)} min)`)
    : `still read FORCE_CHARGE_ON after ${state.forceChargeOffRetries} re-issues`;
  app.log.error(`night-charge: ${repage ? 'RE-SPEAKING (quiet hours silenced it) — ' : ''}force-charge ${unconfirmed ? 'NOT CONFIRMED OFF' : 'NEVER SWITCHED OFF'} — slots ${action.slots.join(',')} ${why}. While it is on the panel keeps buying grid power, including on-peak. Re-issuing OFF every 15 min until it reads off (blind, with no readback, for up to 12 h).`);
  try {
    const heard = await broadcast.announce(
      'critical',
      unconfirmed
        ? 'Critical. The night charge system could not confirm that the panel\'s charge now setting is off. '
          + 'If it is still on, the house will keep buying grid power, including at the peak rate. '
          + 'Check Charge Now in the EcoFlow app.'
        : 'Critical. The night charge system could not switch off the panel\'s charge now setting. '
          + 'The house will keep buying grid power, including at the peak rate, until it is switched off. '
          + 'Turn off Charge Now in the EcoFlow app.',
      unconfirmed
        ? 'Alarma crítica. Alarma crítica. El sistema de carga nocturna no pudo confirmar que la carga forzada del panel esté desactivada. '
          + 'Si sigue activa, la casa seguirá comprando energía de la red, incluso en horario punta. '
          + 'Revise Cargar ahora en la aplicación EcoFlow.'
        : 'Alarma crítica. Alarma crítica. El sistema de carga nocturna no pudo desactivar la carga forzada del panel. '
          + 'La casa seguirá comprando energía de la red, incluso en horario punta, hasta que se desactive. '
          + 'Desactive Cargar ahora en la aplicación EcoFlow.',
    );
    // A quiet-hours suppression is not a failure, but it must be VISIBLE: the push still
    // goes, and the wall-clock deadline keeps its own page for the morning.
    if (heard && heard.ok === false) {
      app.log.warn(`night-charge: force-charge escalation was NOT spoken (${heard.error ?? 'refused'}) — push only${action.deadline ? '; the deadline page will be re-spoken every 30 min until it is heard' : '; the wall-clock deadline will page again'}.`);
    }
    // v1.173.0 — a deadline page records whether it was HEARD, so a quiet-hours mute is
    // re-spoken once quiet hours end (Friday's deadline lands at Sat 01:00).
    if (action.deadline) {
      leg.put({
        ...leg.get(),
        forceChargeOffDeadlineMutedAtMs: heard && heard.ok === false ? Date.now() : null,
      });
    }
  } catch (e: any) {
    app.log.warn(`night-charge: force-charge escalation announce failed (${e?.message ?? e})`);
  }
  if (repage) return; // the push already went with the first page
  try {
    await sendNotification(loadNotifyConfig(), {
      severity: 'critical',
      dedupId: 'night_charge_force_charge_stuck',
      title: unconfirmed ? 'Night-charge: force-charge not confirmed OFF' : 'Night-charge: force-charge stuck ON',
      body:
        `The night-charge for ${state.day} switched force-charge ("Charge Now") ON and `
        + (unconfirmed
          ? `has not been able to confirm it off: slot(s) ${action.slots.join(', ')} were ours, and the panel's readback is unavailable. `
          : action.deadline
            ? `the panel has not switched off: slot(s) ${action.slots.join(', ')} still read ON past the deadline. `
            : `the panel has not switched off: slot(s) ${action.slots.join(', ')} still read ON after ${state.forceChargeOffRetries} accepted OFF commands. `)
        + 'While it stays on the panel buys grid power instead of using the battery — including at the on-peak rate. '
        + 'Check Charge Now in the EcoFlow app and turn it off. The add-on keeps sending OFF every 15 minutes until it reads off (with no readback, for up to 12 hours).',
    });
  } catch (e: any) {
    app.log.warn(`night-charge: force-charge escalation notify failed (${e?.message ?? e})`);
  }
}

/**
 * revertDeadline — page an unconfirmed restore (decideRevertDeadline): an audible critical and a
 * critical push. The stage is stamped BEFORE anything is said, so a restart never pages it twice;
 * the on-peak page stands for the deadline page as well when both fall due on one tick (a process
 * that was down through both). The announce and the push are not awaited: a page must never hold
 * the tick, and with it the restore re-issue the same tick may need. Broadcast quiet hours apply
 * to the spoken page as to every critical announce; the push always goes.
 */
function pageRevertDeadline(
  state: NightActuationState,
  d: Extract<RevertDeadlineDecision, { kind: 'page' }>,
  nowMs: number,
  /** A restore of ours will still be sent (revertRetryPending): what the push and the log say of it. */
  retrying: boolean,
  /** None is being sent and one will be once the panel reports again (revertResendOnReport). */
  resendOnReport: RevertResendOnReport | null,
): void {
  persistNightActuation({
    ...state,
    revertDeadlinePagedAtMs: state.revertDeadlinePagedAtMs ?? nowMs,
    revertDeadlineOnPeakPagedAtMs: d.stage === 'onPeak' ? nowMs : state.revertDeadlineOnPeakPagedAtMs,
  });
  // v1.189.0 — the ledger keeps the first page (a backup leg's has no column: stampLegOutcome).
  if (state.revertDeadlinePagedAtMs == null) stampLegOutcome(state, { revert_deadline_paged_at_ms: nowMs });
  const restorePct = restoreTargetPct(state);
  // What the reserve still reads, for the words: the target, or the raise's other value on a partly
  // granted night not yet adopted (decideRevertDeadline's readsPct). decideRevertDeadline pages only
  // a record with a target.
  const targetPct = d.readsPct ?? state.targetPct!;
  const onPeakClock = state.nextOnPeakStartMs != null ? fmtSiteClock(state.nextOnPeakStartMs) : null;
  // The deadline page names the on-peak start's day when it is not today's: a Friday window's page
  // at 12:30 AM Saturday is about Monday's on-peak (chargeText.onPeakDayWords).
  const onPeakDay = d.stage === 'deadline' && state.nextOnPeakStartMs != null ? onPeakDayWords(state.nextOnPeakStartMs, nowMs) : null;
  const deadlineMs = revertDeadlineMs(state);
  app.log.error(
    `night-charge: revertDeadline — the restore of the backup reserve to ${restorePct ?? '?'}% for ${state.day} `
    + (d.unknown ? 'could not be confirmed (no valid live panel reading)' : `has not taken effect (the panel still reads ${targetPct}%)`)
    + (d.stage === 'onPeak'
      ? `, and on-peak pricing has started (${new Date(state.nextOnPeakStartMs!).toISOString()})`
      : ` by its deadline (${deadlineMs != null ? new Date(deadlineMs).toISOString() : '?'})`)
    + `. Paging: critical, spoken and pushed. ${revertRetryText(retrying, resendOnReport)}`,
  );
  // R5 — a winter mid-day leg is paged in the mid-day words (chargeText.ts: the window, the on-peak
  // start, and Charge Now when its OFF has not read back); nothing arms one before the mid-day
  // switch. The overnight leg's page is unchanged.
  // (The record is the active leg, spread from nightActuationMem: it carries its window kind.)
  const midday = isMiddayLeg(state as Partial<ChargeLegState>)
    ? middayRevertDeadlineFromLeg(state, { stage: d.stage, unknown: d.unknown, targetPct, restorePct, nowMs, retrying, resendOnReport }) : null;
  const spoken = midday != null ? middayRevertDeadlineSpoken(midday) : revertDeadlineSpoken({ stage: d.stage, unknown: d.unknown, targetPct, restorePct, onPeakClock, onPeakDay });
  void (async () => {
    try {
      const heard = await broadcast.announce('critical', spoken.en, spoken.es);
      if (heard && heard.ok === false) {
        app.log.warn(`night-charge: revertDeadline page was NOT spoken (${heard.error ?? 'refused'}) — push only${d.stage === 'deadline' && state.nextOnPeakStartMs != null ? '; it pages again at the on-peak start if the restore has still not read back' : ''}.`);
      }
    } catch (e: any) {
      app.log.warn(`night-charge: revertDeadline announce failed (${e?.message ?? e})`);
    }
    try {
      await sendNotification(loadNotifyConfig(), midday != null ? buildMiddayRevertDeadline(midday) : buildNightChargeRevertDeadline({
        day: state.day, stage: d.stage, unknown: d.unknown, targetPct, restorePct, onPeakClock, onPeakDay, retrying, resendOnReport,
      }));
    } catch (e: any) {
      app.log.error(`night-charge: revertDeadline push FAILED — ${e?.message ?? e}.`);
    }
  })();
}

/**
 * v1.189.0 (review) — the summary of a restore (nightChargeActuator.restoreSummaryDue): the morning
 * summary, or a winter mid-day leg's own. It went on the restore's cloud ACK saying "reserve restored
 * to 16%", and a restore that then did not read back was paged critical half an hour later, both
 * cards standing. It now goes once: when the restore reads back ('readBack': restored, the words
 * before), or when its readback grace runs with none ('acknowledged': the restore was sent and
 * acknowledged, and the panel has not read it back). Stamped before it is sent, so a restart never
 * sends it twice. NOT awaited (v1.187.0 review): an info push (5 s headers + 10 s body per target)
 * must never hold the tick, and with it any force-charge step still to run.
 * v1.187.22 — the armed day's EXPECTED figure, or none: state.buyKwh is the worst case. What the
 * force-charge did comes from this record (forceChargeNightOutcome: ran, switched ON but unconfirmed
 * or failed, never started); a cancel or a grid-loss abort ended the night early and is said so,
 * with no figure.
 */
function sendRestoreSummary(state: ChargeLegState, restore: RestoreSummaryKind, nowMs: number): void {
  persistNightActuation({ ...state, restoreSummaryAtMs: nowMs });
  const restorePct = state.priorReservePct;
  if (restorePct == null || state.revertedAtMs == null) return;
  const endedBy = state.revertGridLossAbort ? 'gridLoss' as const : state.cancelled ? 'cancelled' as const : 'window' as const;
  // R5 — a winter mid-day leg gets the mid-day summary (chargeText.ts, the window named from its
  // record); nothing arms one before the mid-day switch. The overnight leg's summary is the other branch.
  if (isMiddayLeg(state)) {
    const onPeakAt = state.nextOnPeakStartMs ?? null;
    void sendNotification(loadNotifyConfig(), buildMiddayChargeSummary(middaySummaryFromLeg(state, {
      restorePct, restoredAtMs: state.revertedAtMs, expectedKwh: armedExpectedBuyKwh(state.day),
      forceCharge: forceChargeNightOutcome(state, forceChargeOn(state.leg)),
      onPeak: onPeakAt != null ? { startMs: onPeakAt, endMs: onPeakEndMs(tariffModelFromEnv(), onPeakAt) } : null,
      ended: endedBy, restore,
    }))).catch((e: any) => {
      app.log.debug(`night-charge: mid-day summary notify failed (${e?.message ?? e})`);
    });
  } else {
    void sendNotification(loadNotifyConfig(), buildNightChargeMorningSummary({
      day: state.day, targetPct: state.targetPct, restorePct,
      expectedKwh: armedExpectedBuyKwh(state.day),
      forceCharge: forceChargeNightOutcome(state, forceChargeOn()),
      ended: endedBy, restore,
    })).catch((e: any) => {
      app.log.debug(`night-charge: morning summary notify failed (${e?.message ?? e})`);
    });
  }
  app.log.info(`night-charge: summary for ${state.day} sent — the restore to ${restorePct}% ${restore === 'readBack' ? 'read back' : `has not read back ${Math.round((nowMs - state.revertedAtMs) / 60_000)} min after it was acknowledged`}.`);
}

/** v1.189.0 (review) — this process has read a reserve setting from a fresh panel readback since it
 *  started (runNightActuationTickInner): what the revertDeadline's deadline stage waits on after a
 *  restart across it (restoreAwaitingFirstChance). */
let nightReserveReadSinceBoot = false;

async function runNightActuationTickInner(): Promise<void> {
  let state = nightActuationMem;
  if (state.day == null) return;
  const nowMs = Date.now();
  const shp2 = findShp2(store.get().devices);
  // v1.140.0 — R3: a CONTROL READBACK must be a live reading, never a frozen
  // projection. setDeviceList preserves `projection` verbatim across an offline
  // transition, so a cloud-dark panel keeps serving its last sample; comparing
  // that to the target by strict equality manufactures verdicts — applyFailed
  // ("the write NEVER TOOK EFFECT") or revertFailed, which speaks a bilingual
  // CRITICAL broadcast. Nulling the whole group together makes every
  // decideActuation branch return 'none', which is the pause the actuator's own
  // comment already promises for an unknown reading.
  const sp: any =
    shp2 && shp2.projection?.kind === 'shp2' && shp2ReadbackFresh(shp2, nowMs)
      ? shp2.projection
      : null;
  const fullWh: number | null = sp?.backupFullCapWh ?? null;
  const socNowPct: number | null = sp?.backupBatPercent ?? null;
  const remainWh: number | null = sp?.backupRemainWh ?? null;
  // Same I11 coherence verdict the planner uses — a transient reconnect zero
  // must never gate a write THROUGH nor a revert OUT.
  const socCoherent =
    fullWh != null && fullWh > 0 && socNowPct != null && remainWh != null &&
    Math.abs((remainWh / fullWh) * 100 - socNowPct) <= 8;
  const currentReservePct: number | null =
    typeof sp?.backupReserveSoc === 'number' ? sp.backupReserveSoc : null;
  // v1.189.0 (review) — the first reserve setting this process reads: until it, an accepted
  // restore's deadline stage waits (bounded) instead of paging an unknown reading
  // (decideRevertDeadline's readSinceBoot).
  if (isReserveSetting(currentReservePct)) nightReserveReadSinceBoot = true;

  // An attempted write the cloud never confirmed, still reading its attempt-time baseline once its
  // apply ladder is over, never landed (attemptProvedUnlanded): stamped, so no later missing
  // reading can make it outstanding again.
  if (attemptProvedUnlanded(state, currentReservePct, nowMs)) {
    persistNightActuation({ ...state, attemptUnlandedAtMs: nowMs });
    app.log.info(`night-charge: the ${state.day} write attempt never landed — after its apply window the panel still reads the ${state.attemptBaselinePct}% it read before the attempt; nothing of ours holds the reserve.`);
    state = nightActuationMem;
    if (state.day == null) return;
  }
  // The same proof for a write the cloud ACK'd: its apply ladder ended in applyFailed and the panel
  // still reads the baseline (applyProvedUnlanded). Its restore is a no-op; nothing of ours holds
  // the reserve unless a later reading verifies the write.
  if (applyProvedUnlanded(state, currentReservePct, nowMs)) {
    persistNightActuation({ ...state, applyUnlandedAtMs: nowMs });
    app.log.info(`night-charge: the ${state.day} write never took effect — after its re-issues the panel still reads the ${state.attemptBaselinePct}% it read before the write; its restore is a no-op and nothing of ours holds the reserve.`);
    state = nightActuationMem;
    if (state.day == null) return;
  }

  // revertDeadline — ahead of the decision, and of the `!shp2` return below: a panel missing
  // from the device list, or not reporting, is exactly the unconfirmed restore it pages about.
  // Each stage is decided once, at its moment: a page, or a pass on a reading that is not ours.
  // The deadline stage waits, a bounded while, for a restore that has not had its chance (a
  // process down across the deadline: the restore is sent by decideActuation below on this tick).
  const revertPage = decideRevertDeadline(state, nowMs, currentReservePct, shp2 != null, nightReserveReadSinceBoot);
  if (revertPage.kind === 'hold') {
    if (state.revertDeadlineHeldAtMs == null) {
      persistNightActuation({ ...state, revertDeadlineHeldAtMs: nowMs });
      app.log.info(`night-charge: revertDeadline — the deadline for ${state.day} came with its restore ${restoreSentWords(state.revertedAtMs, PROCESS_BOOT_MS)}; the page waits up to ${REVERT_DEADLINE_HOLD_MAX_MS / 60_000} min for it to be sent and read back.`);
      state = nightActuationMem;
      if (state.day == null) return;
    }
  } else if (revertPage.kind === 'page') {
    pageRevertDeadline(state, revertPage, nowMs, revertRetryPending(state, currentReservePct, shp2 != null),
      revertResendOnReport(state, currentReservePct, shp2 != null));
    state = nightActuationMem; // the stamp is on the record every write below spreads
    if (state.day == null) return;
  } else if (revertPage.kind === 'pass') {
    persistNightActuation(revertPage.stage === 'onPeak'
      ? { ...state, revertDeadlineOnPeakPassedAtMs: nowMs }
      : { ...state, revertDeadlinePassedAtMs: nowMs });
    app.log.info(`night-charge: revertDeadline — ${revertPage.stage === 'onPeak' ? 'the on-peak start' : 'the deadline'} for ${state.day} passed without a page: the panel reads ${revertPage.pct}%, not the ${state.targetPct}% set${revertPage.pct === restoreTargetPct(state) ? ' (the restore has read back)' : ''}.`);
    state = nightActuationMem;
    if (state.day == null) return;
  }

  // v1.189.0 (review) — the summary of the restore, once it is owed (restoreSummaryDue): its readback
  // grace ran with no readback (a restore that read back sends it on its revertVerified tick).
  // v1.189.1 — after a restart it waits for this process's first reading of the reserve, up to
  // REVERT_DEADLINE_HOLD_MAX_MS from the first tick that waits (stamped once), so a readback on that
  // reading is summarised as restored instead of a "sent" card followed by a "restored" one.
  const summaryOwed = restoreSummaryDue(state, nowMs, currentReservePct, nightReserveReadSinceBoot);
  if (summaryOwed === 'hold') {
    if (state.restoreSummaryHeldAtMs == null) {
      persistNightActuation({ ...state, restoreSummaryHeldAtMs: nowMs });
      const sentAtMs = state.revertedAtMs ?? nowMs;
      app.log.info(`night-charge: the summary of the ${state.day} restore waits up to ${REVERT_DEADLINE_HOLD_MAX_MS / 60_000} min for the panel's first reading since the add-on started: the restore was sent ${Math.round((nowMs - sentAtMs) / 60_000)} min ago${sentAtMs < PROCESS_BOOT_MS ? ', before the add-on last started' : ''}, and has not read back.`);
      state = nightActuationMem;
      if (state.day == null) return;
    }
  } else if (summaryOwed != null) {
    sendRestoreSummary(state, summaryOwed, nowMs);
    state = nightActuationMem;
    if (state.day == null) return;
  }

  const gridNow = liveGridBackstop(store.get().devices);
  const action = decideActuation(state, nowMs, {
    mode: NIGHT_CHARGE_MODE,
    writeReady: getLatestReadiness()?.writeReady === true,
    currentReservePct,
    socCoherent,
    vitalsRed: currentAssessment()?.level === 'crit',
    // v1.179.0 — tri-state: null when presence is false only because nothing can be heard
    // (decideActuation never aborts on null).
    gridPresent: gridNow.present ? true : gridNow.presenceUnknown ? null : false,
  });
  if (action.kind === 'none' || !shp2) return;

  if (action.kind === 'adopt') {
    // A write whose confirmation was lost is proven applied by the live
    // reading — stamp it so the normal revert path takes over. Without this a
    // raised reserve would sit orphaned behind the "nothing to raise" guard.
    persistNightActuation({ ...state, appliedAtMs: state.applyAttemptedAtMs ?? nowMs, priorReservePct: action.priorPct, lastError: null });
    stampLegOutcome(state, { actuated: 1, actuation_applied_at_ms: state.applyAttemptedAtMs ?? nowMs });
    app.log.warn(
      `night-charge: ADOPTED an unconfirmed write — the device reads ${state.targetPct}% (attempt baseline ${action.priorPct}%); the apply succeeded but its confirmation was lost. Normal auto-revert takes over.`,
    );
    return;
  }

  if (action.kind === 'apply') {
    const blocked = multiPanelWriteBlock();
    if (blocked) { app.log.warn(`night-charge: APPLY refused — ${blocked}`); return; }
    // Write-ahead intent: persist the attempt (with the pre-write baseline)
    // BEFORE issuing the write, so a lost confirmation is reconcilable.
    persistNightActuation({ ...state, applyAttemptedAtMs: nowMs, attemptBaselinePct: currentReservePct });
    const r = await setBackupReserveSoc({
      sn: shp2.sn, targetPct: action.targetPct, source: { ua: 'night-charge-supervised' },
    });
    if (r.outcome === 'success') {
      persistNightActuation({ ...nightActuationMem, appliedAtMs: nowMs, priorReservePct: currentReservePct, lastError: null });
      stampLegOutcome(state, { actuated: 1, actuation_applied_at_ms: nowMs });
      app.log.info(
        `night-charge: SUPERVISED WRITE APPLIED — backupReserveSoc ${currentReservePct}% → ${action.targetPct}% for ${state.day}; auto-reverts after window close.`,
      );
    } else if (!r.rateLimited) {
      persistNightActuation({ ...nightActuationMem, lastError: r.message ?? r.code ?? 'write failed' });
      app.log.warn(`night-charge: supervised write failed (${r.code}: ${r.message}); retrying within the apply window (the attempt is recorded — a lost confirmation reconciles from the live reserve reading).`);
    }
    return;
  }

  if (action.kind === 'foreignSeen') {
    // The foreign rule (nightChargeActuator.foreignStep): the first of the two readings.
    persistNightActuation({ ...state, foreignReservePct: action.pct, foreignSeenAtMs: nowMs });
    app.log.info(`night-charge: foreign reserve reading — the panel reads ${action.pct}%, neither the ${state.targetPct}% set for ${state.day} nor the ${state.priorReservePct ?? '?'}% it restores; taken as set outside the add-on if it still reads ${action.pct}% in ${Math.round(FOREIGN_RESERVE_SETTLE_MS / 60_000)} min.`);
    return;
  }

  if (action.kind === 'foreignCleared') {
    persistNightActuation({ ...state, foreignReservePct: null, foreignSeenAtMs: null });
    app.log.info(`night-charge: foreign reserve reading cleared — the panel reads ${currentReservePct ?? '?'}% again for ${state.day}.`);
    return;
  }

  if (action.kind === 'foreignSettled') {
    // Someone else's reserve: nothing more is written to it for this night (decideActuation
    // returns 'none' from here), the night is resolved for the next arm, and the force-charge
    // riding the write switches OFF (nightForceCharge offReason 'foreign').
    persistNightActuation({ ...state, foreignSettledAtMs: nowMs, foreignReservePct: action.pct, lastError: null });
    app.log.warn(`night-charge: foreign reserve SETTLED — the panel has read ${action.pct}% since ${state.foreignSeenAtMs != null ? new Date(state.foreignSeenAtMs).toISOString() : '?'}: neither the ${state.targetPct}% set for ${state.day} nor the ${state.priorReservePct ?? '?'}% it restores. Taken as set outside the add-on; nothing more is written to the reserve for this night${state.revertedAtMs != null ? ' (the restore was sent and did not read back)' : ' (no restore is sent)'}.`);
    void sendNotification(loadNotifyConfig(), buildNightChargeForeignReserve({
      day: state.day, pct: action.pct, targetPct: state.targetPct, restorePct: state.priorReservePct,
    })).catch((e: any) => {
      app.log.debug(`night-charge: foreign-reserve notify failed (${e?.message ?? e})`);
    });
    return;
  }

  if (action.kind === 'applyVerified') {
    // v1.79.0 — the DEVICE now reads the target: the actuation is real, not
    // merely cloud-ACK'd. One line, stamped once.
    persistNightActuation({ ...state, applyVerifiedAtMs: nowMs, lastError: null });
    app.log.info(`night-charge: write VERIFIED by device readback — backupReserveSoc reads ${state.targetPct}% for ${state.day}.`);
    return;
  }

  if (action.kind === 'applyCeiling') {
    // v1.161.0 — the panel raised the reserve but settled below what we asked.
    // Adopt the achieved value AS the target: every downstream equality (the
    // arbitrage posture, isRevertSettling, the revert readback) then compares
    // against what the device actually holds, and the night closes normally.
    // `requestedPct` keeps the intent for the ledger and for the operator.
    const requested = state.targetPct;
    persistNightActuation({
      ...state,
      targetPct: action.achievedPct,
      requestedPct: state.requestedPct ?? requested,
      applyVerifiedAtMs: nowMs,
      lastError: null,
    });
    app.log.warn(
      `night-charge: device CEILING — asked backupReserveSoc ${requested}%, the panel settled at ${action.achievedPct}% (baseline was ${state.attemptBaselinePct ?? '?'}%). Treating it as applied: the reserve IS raised and tonight's buy is real, just smaller than planned. Reverts to ${state.priorReservePct ?? '?'}% after the window. If this repeats at the same value, that value is the SHP2's own limit and RESERVE_WRITE_MAX_PCT should be set to it.`,
    );
    return;
  }

  if (action.kind === 'ceilingMoved') {
    // A write the panel granted in part now reads another value within what the night asked for
    // (nightChargeActuator.ceilingMovedPct): the panel moved on our own write, not someone else's
    // setting. Adopted as the target, as applyCeiling adopts the first answer, so the restore's
    // readback, the revertDeadline pages and the money detectors' hold compare against it.
    persistNightActuation({ ...state, targetPct: action.pct, foreignReservePct: null, foreignSeenAtMs: null, lastError: null });
    app.log.warn(`night-charge: the panel now reads backupReserveSoc ${action.pct}% for ${state.day} — within the ${state.requestedPct ?? '?'}% the night asked for (it had settled at ${state.targetPct}%). Taken as the night's own write, now its target; `
      + (state.revertedAtMs == null
        ? `reverts to ${state.priorReservePct ?? '?'}% after the window.`
        : `its restore to ${state.priorReservePct ?? '?'}% has not read back, and is judged against ${action.pct}%.`));
    return;
  }

  if (action.kind === 'retryApply') {
    const blockedRetry = multiPanelWriteBlock();
    if (blockedRetry) { app.log.warn(`night-charge: APPLY RETRY refused — ${blockedRetry}`); return; }
    // v1.79.0 — cloud ACK'd but the device never took it (the 08-16 phantom).
    persistNightActuation({ ...state, applyRetries: state.applyRetries + 1, applyLastAttemptMs: nowMs });
    app.log.warn(`night-charge: apply readback FAILED — device still reads ${currentReservePct ?? 'unknown'}% ${Math.round((nowMs - (state.applyLastAttemptMs ?? state.appliedAtMs ?? nowMs)) / 60_000)}m after the ACK'd write; re-issuing (retry ${state.applyRetries + 1}/${APPLY_MAX_RETRIES}).`);
    const rr = await setBackupReserveSoc({
      sn: shp2.sn, targetPct: action.targetPct, source: { ua: 'night-charge-supervised-retry' },
    });
    if (rr.outcome !== 'success' && !rr.rateLimited) {
      persistNightActuation({ ...nightActuationMem, lastError: rr.message ?? rr.code ?? 'retry write failed' });
    }
    return;
  }

  if (action.kind === 'applyFailed') {
    // v1.79.0 — retries exhausted; the ledger must not keep a phantom
    // actuation and the operator must hear about the forfeited buy. The night
    // still closes through the normal revert (a no-op restore).
    persistNightActuation({ ...state, applyEscalated: true });
    stampLegOutcome(state, { actuated: 0 });
    // v1.187.22 — the push states the armed day's EXPECTED figure, or none (never the worst case,
    // state.buyKwh); the log keeps both, labelled.
    const expectedKwh = armedExpectedBuyKwh(state.day);
    app.log.error(`night-charge: write NEVER TOOK EFFECT — the cloud ACK'd backupReserveSoc ${state.targetPct}% but the device still reads ${currentReservePct ?? 'unknown'}% after ${state.applyRetries} retries. Tonight's charge (${buyFiguresLogText(expectedKwh, state.buyKwh)}) is forfeited; ledger corrected to actuated:0.`);
    try {
      await sendNotification(loadNotifyConfig(), buildNightChargeApplyFailure({
        day: state.day, currentReservePct, targetPct: state.targetPct, applyRetries: state.applyRetries, expectedKwh,
      }));
    } catch (e: any) {
      app.log.warn(`night-charge: apply-failure notify failed (${e?.message ?? e})`);
    }
    return;
  }

  if (action.kind === 'revertVerified') {
    // v1.131.0 — the DEVICE now reads the restored floor: the night is really
    // closed, not merely cloud-ACK'd. One line, stamped once.
    persistNightActuation({ ...state, revertVerifiedAtMs: nowMs, lastError: null });
    app.log.info(`night-charge: revert VERIFIED by device readback — backupReserveSoc reads ${state.priorReservePct}% for ${state.day}.`);
    // v1.189.0 (review) — the summary says "restored" now that the panel reported it (on this tick:
    // a resolved leg may hand over to the next before the next tick's step).
    const owed = restoreSummaryDue(nightActuationMem, nowMs);
    if (owed != null) sendRestoreSummary(nightActuationMem, owed, nowMs);
    return;
  }

  if (action.kind === 'retryRevert') {
    const blockedRevertRetry = multiPanelWriteBlock();
    if (blockedRevertRetry) { app.log.warn(`night-charge: REVERT RETRY refused — ${blockedRevertRetry}`); return; }
    persistNightActuation({ ...state, revertRetries: state.revertRetries + 1, revertLastAttemptMs: nowMs });
    app.log.warn(`night-charge: revert readback FAILED — device still reads the raised ${state.targetPct}% ${Math.round((nowMs - (state.revertLastAttemptMs ?? state.revertedAtMs ?? nowMs)) / 60_000)}m after the ACK'd restore; re-issuing ${action.restorePct}% (retry ${state.revertRetries + 1}/${REVERT_MAX_RETRIES}).`);
    const rv = await setBackupReserveSoc({
      sn: shp2.sn, targetPct: action.restorePct, source: { ua: 'night-charge-supervised-revert-retry' },
    });
    if (rv.outcome !== 'success' && !rv.rateLimited) {
      persistNightActuation({ ...nightActuationMem, lastError: rv.message ?? rv.code ?? 'revert retry write failed' });
    }
    return;
  }

  if (action.kind === 'revertFailed') {
    // v1.131.0 — the restore was accepted by the cloud, re-issued, and the
    // panel still holds the raised floor. This does NOT self-heal and it costs
    // money every on-peak hour it persists, so it escalates the same way a
    // cloud-rejected revert does at REVERT_ESCALATE_AFTER.
    persistNightActuation({ ...state, revertReadbackEscalated: true });
    app.log.error(`night-charge: revert NEVER TOOK EFFECT — the cloud ACK'd backupReserveSoc ${action.restorePct}% but the panel still reads the raised ${state.targetPct}% after ${state.revertRetries} re-issues. The panel will hold ${state.targetPct}% as its floor and buy grid instead of discharging until the reserve is corrected.`);
    try {
      await broadcast.announce(
        'critical',
        `Critical. The night charge system restored the backup reserve but the panel did not accept it. The reserve is stuck at ${state.targetPct} percent instead of ${action.restorePct} percent. The house will buy grid power instead of using the battery. Check the Power panel.`,
        // Spanish second pass — without it this CRITICAL plays English twice
        // instead of bilingual (see the announce() contract).
        `Alarma crítica. Alarma crítica. El sistema de carga nocturna restableció la reserva de respaldo pero el panel no la aceptó. ` +
        `La reserva está fija en ${state.targetPct} por ciento en lugar de ${action.restorePct} por ciento. ` +
        `La casa comprará energía de la red en lugar de usar la batería. Revise el panel Power.`,
      );
    } catch (e: any) {
      app.log.warn(`night-charge: revert-readback escalation announce failed (${e?.message ?? e})`);
    }
    try {
      await sendNotification(loadNotifyConfig(), {
        severity: 'critical',
        dedupId: 'night_charge_revert_readback_failure',
        title: 'Night-charge: reserve stuck raised',
        body:
          `The morning restore for ${state.day} was accepted by the EcoFlow cloud but the Smart Home Panel 2 `
          + `still reads ${state.targetPct}% instead of ${action.restorePct}%, after ${state.revertRetries} re-issues. `
          + `While the reserve stays raised the panel treats ${state.targetPct}% as its floor and buys grid power `
          + 'rather than discharging the pack. Set the backup reserve back manually in the EcoFlow app, '
          + 'or check the SHP2 cloud link.',
      });
    } catch (e: any) {
      app.log.warn(`night-charge: revert-readback escalation notify failed (${e?.message ?? e})`);
    }
    return;
  }

  // action.kind === 'revert'
  if (action.gridLossAbort) {
    app.log.warn(`night-charge: GRID LOST mid-window — aborting the buy and restoring the ${action.restorePct}% floor now (a raised reserve in an outage is a false AT-RESERVE-FLOOR posture).`);
  }
  const r = await setBackupReserveSoc({
    sn: shp2.sn, targetPct: action.restorePct, source: { ua: 'night-charge-supervised-revert' },
  });
  if (r.outcome === 'success') {
    // v1.189.0 (review) — a grid-loss abort is kept with the restore: the summary goes after the
    // ACK (restoreSummaryDue) and says what ended the night.
    persistNightActuation({ ...state, revertedAtMs: nowMs, lastError: null, revertGridLossAbort: action.gridLossAbort === true });
    // v1.187.0 (review) — where the hold ended, for the delivered-energy span
    // (nightLedgerScoring.deliveredHoldSpan): the restore lands on the first tick after
    // the close, and the pack charges until it does.
    // v1.189.0 — to the leg's own columns (a backup leg's go to backup_*: stampLegOutcome).
    stampLegOutcome(state, { actuation_reverted_at_ms: nowMs });
    app.log.info(
      `night-charge: reserve REVERTED to ${action.restorePct}% for ${state.day}${state.cancelled ? ' (owner cancel)' : ''}.`,
    );
    // v1.189.0 (review) — the summary waits for the restore's readback (sendRestoreSummary): it went
    // here, on the cloud ACK, saying "reserve restored".
    return;
  }
  if (!r.rateLimited) {
    const attempts = state.revertAttempts + 1;
    let escalated = state.revertEscalated;
    if (attempts >= REVERT_ESCALATE_AFTER && !escalated) {
      escalated = true;
      app.log.error(
        `night-charge: reserve revert FAILED ${attempts}× — escalating; reserve is stuck at ${state.targetPct}% (floor alarms remain independently active). Retries continue.`,
      );
      try {
        await broadcast.announce(
          'critical',
          `Critical. The night charge system could not restore the backup reserve after charging. The reserve is stuck at ${state.targetPct} percent. Retries continue. Check the Power panel.`,
          // v1.67.0 — Spanish second pass. Without it this CRITICAL plays English
          // twice instead of bilingual (see the announce() contract).
          `Alarma crítica. Alarma crítica. El sistema de carga nocturna no pudo restablecer la reserva de respaldo después de cargar. ` +
          `La reserva está fija en ${state.targetPct} por ciento. Los reintentos continúan. Revise el panel Power.`,
        );
      } catch { /* annunciation best-effort; retries continue regardless */ }
      try {
        await sendNotification(loadNotifyConfig(), {
          severity: 'critical',
          dedupId: 'night_charge_revert_failure',
          title: 'Night-charge: reserve revert FAILING',
          body:
            `The post-window restore of backupReserveSoc to ${action.restorePct}% has failed ${attempts} time(s) `
            + `(${r.code}: ${r.message}). The write retries every few minutes. The floor/runway/SoC alarm spine is unaffected.`,
        });
      } catch (e: any) {
        // v1.131.0 — this was a bare `catch {}`. It is the ONLY critical-severity
        // push outside the alert engine, and it fires when a supervised write has
        // left backupReserveSoc STUCK at an elevated value — a state the code
        // itself escalates with a spoken "Critical" broadcast. Since v1.124.0
        // sendNotification THROWS whenever every push target fails, so the one
        // path that most needs to know it failed was the one discarding the news.
        app.log.error(`night-charge: reserve-revert escalation push FAILED — ${e?.message ?? e}. The spoken broadcast is now the only channel carrying this.`);
      }
    } else {
      app.log.warn(`night-charge: reserve revert attempt ${attempts} failed (${r.code}: ${r.message}); will retry.`);
    }
    persistNightActuation({ ...state, revertAttempts: attempts, revertEscalated: escalated, lastError: r.message ?? r.code ?? 'revert failed' });
  }
}

/* ═══ v1.189.0 — the charge cycle's own steps (chargeCycle.ts) ═══════════════════════════════════
 * With one leg — every cycle the add-on arms until the mid-day switch — none of these has anything
 * to do: nothing is pending, nothing trails, and the overnight cost leg never sends a missed-apply
 * push. They write nothing to the device but a trailing leg's force-charge OFF. */

/**
 * The cycle step (chargeCycle.promoteCycle): a trailing leg that has resolved leaves the cycle, and
 * a resolved active leg hands over to the first pending one (legResolved, with the live reserve
 * from a FRESH readback for armOpenItem's never-landed proof). Nothing is written to the device.
 */
function runCycleStep(): void {
  if (nightCyclePending.length === 0 && nightCycleTrailing == null) return;
  const nowMs = Date.now();
  const step = promoteCycle(nightCycleView(), nowMs, freshReserveReadingPct(nowMs));
  if (step == null) return;
  persistCycle(step.cycle);
  nightCycleDeparted = departedAfterStep(nightCycleDeparted, step, nowMs);
  if (step.trailingDone) {
    app.log.info(`night-charge: the trailing ${step.trailingDone.day} leg is done — its force-charge OFF read back${step.trailingDone.forceChargeCeilingPriorPct != null && step.trailingDone.forceChargeCeilingRestoredAtMs == null ? '; the panel\'s ceiling restore goes on with the active leg' : ''}.`);
  }
  if (step.promoted) {
    const { from, to } = step.promoted;
    app.log.info(`night-charge: the ${from.leg} leg for ${from.day} is resolved; the ${to.leg} leg (${to.windowStartMs != null ? new Date(to.windowStartMs).toISOString() : '?'} → ${to.windowEndMs != null ? new Date(to.windowEndMs).toISOString() : '?'}, reserve → ${to.targetPct}%${to.cancelled ? ', cancelled' : ''}) is now active.`);
  }
}

/**
 * The trailing leg (chargeCycle.armCycle): a prior leg whose only open item was a force-charge OFF
 * not yet verified when a reserve-only backup leg armed. It is driven by the same decision as the
 * active leg (decideForceCharge) with force-charge DISABLED, so the only answers are the OFF, its
 * re-sends and readback, the wall-clock deadline and the panel's ceiling restore — a trailing leg
 * never switches anything on. Its records go to the trailing slot. Blind re-sends stop at the open
 * of the next leg that may force-charge (the pending cost leg), which waits for this one anyway.
 */
async function runTrailingLegTick(): Promise<void> {
  const t = nightCycleTrailing;
  if (t == null) return;
  const nowMs = Date.now();
  const cur = (): NightActuationState => nightCycleTrailing ?? t;
  const shp2 = findShp2(store.get().devices);
  if (!shp2) {
    const blind = decideForceCharge(t, nowMs, {
      enabled: false, gridPresent: null, gridStaLost: false, slotsOn: null, connectedSlots: [],
      vitalsRed: false, socCoherent: false, ceilingReadbackPct: null, poolSocPct: null, fullKwh: null,
      maxRunMs: forceChargeMaxRunNow(), // v1.191.0 (S6, W5)
    });
    if (blind.kind === 'offFailed') await escalateForceChargeStuck(t, blind, TRAILING_LEG);
    return;
  }
  const sp: any = shp2.projection?.kind === 'shp2' && shp2ReadbackFresh(shp2, nowMs) ? shp2.projection : null;
  const sources: any[] | null = Array.isArray(sp?.sources) ? sp.sources : null;
  const slotsOn = sources == null ? null
    : sources.filter((c) => c?.forceCharge === 'FORCE_CHARGE_ON').map((c) => Number(c.slot)).filter(Number.isInteger);
  // No grid reading is passed: with force-charge disabled and the leg's window over, the grid can
  // only ever matter to a start, which a trailing leg never makes (its OFF falls due on the clock).
  const action = decideForceCharge(t, nowMs, {
    enabled: false,
    gridPresent: null,
    gridStaLost: false,
    slotsOn,
    connectedSlots: [],
    vitalsRed: currentAssessment()?.level === 'crit',
    socCoherent: false,
    ceilingReadbackPct: typeof sp?.forceChargeCeilingSoc === 'number' ? sp.forceChargeCeilingSoc : null,
    poolSocPct: null,
    fullKwh: null,
    // Blind re-sends stop at the next cost leg's open (a backup leg never force-charges, so an OFF
    // inside its window cuts nothing of ours), else the latest plan's (nextForceChargeOpenMs).
    nextLegOpenMs: nextForceChargeOpenMs(t, [nightActuationMem, ...nightCyclePending], getLatestNightChargePlan()?.window?.startMs),
    maxRunMs: forceChargeMaxRunNow(), // v1.191.0 (S6, W5)
  });
  if (action.kind === 'off' || action.kind === 'offRetry') {
    const isRetry = action.kind === 'offRetry';
    persistTrailing({
      ...cur(),
      forceChargeOffAtMs: cur().forceChargeOffAtMs ?? nowMs,
      forceChargeOffLastAttemptMs: nowMs,
      forceChargeOffReason: isRetry ? cur().forceChargeOffReason : action.reason,
    });
    const results: string[] = [];
    let acked = 0;
    for (const slot of action.slots) {
      const r = await setChannelForceCharge({ sn: shp2.sn, slot, on: false, source: { ua: 'night-force-charge' } });
      if (r.outcome === 'success') acked++;
      results.push(`ch${slot} ${r.outcome === 'success' ? 'ok' : `${r.code}`}`);
    }
    // As for the active leg: only an OFF the cloud accepted spends the readback budget.
    if (isRetry && acked > 0) persistTrailing({ ...cur(), forceChargeOffRetries: cur().forceChargeOffRetries + 1 });
    if (!isRetry && t.forceChargeOffAtMs == null) {
      stampLegOutcome(t, { force_charge_off_at_ms: nowMs, force_charge_off_reason: action.reason });
    }
    app.log.warn(`night-charge: trailing ${t.day} leg — force-charge OFF ${isRetry ? 're-sent' : 'sent'} to slots ${action.slots.join(',')}${isRetry && action.kind === 'offRetry' && action.unconfirmed ? ' (no live readback)' : ''}: ${results.join(', ')}.`);
    return;
  }
  if (action.kind === 'offVerified') {
    persistTrailing({ ...cur(), forceChargeOffVerifiedAtMs: nowMs });
    stampLegOutcome(t, { force_charge_off_verified_at_ms: nowMs });
    app.log.info(`night-charge: trailing ${t.day} leg — force-charge OFF VERIFIED by device readback.`);
    return;
  }
  if (action.kind === 'offFailed') {
    await escalateForceChargeStuck(t, action, TRAILING_LEG);
    return;
  }
  if (action.kind === 'restoreCeiling') {
    persistTrailing({
      ...cur(),
      forceChargeCeilingRestoreAttempts: cur().forceChargeCeilingRestoreAttempts + 1,
      forceChargeCeilingRestoreLastAttemptMs: nowMs,
    });
    const rc = await setForceChargeCeiling({ sn: shp2.sn, pct: action.pct, source: { ua: 'night-force-charge' } });
    app.log.info(`night-charge: trailing ${t.day} leg — restoring the panel's force-charge ceiling to ${action.pct}% (${rc.outcome === 'success' ? 'ACK' : `${rc.code}: ${rc.message}`})${action.lastAttempt ? ' — LAST attempt' : ''}.`);
    return;
  }
  if (action.kind === 'ceilingRestored') {
    persistTrailing({ ...cur(), forceChargeCeilingRestoredAtMs: nowMs });
    app.log.info(`night-charge: trailing ${t.day} leg — the panel's own force-charge ceiling is back at ${t.forceChargeCeilingPriorPct}% (readback).`);
    return;
  }
  // With force-charge disabled and the leg's window over, nothing else can come back; an answer
  // that does is logged, never executed.
  if (action.kind !== 'none') app.log.warn(`night-charge: trailing ${t.day} leg — '${action.kind}' not executed (a trailing leg only switches OFF).`);
}

/**
 * The missed apply (plan §4.8; chargeCycle.missedApplyDue): a leg the overnight-only cycle never
 * had — a mid-day leg, or the outage backup before one — whose apply window passed with no write
 * sends ONE info push naming why (missedApplyReason, read from this tick's inputs) and the reserve
 * in force. The leg is stamped before the push goes, and the push is not awaited. The overnight
 * cost leg never sends it: there only a write that never took effect pushes (applyFailed).
 */
async function runMissedApplyStep(): Promise<void> {
  const nowMs = Date.now();
  const at = [nightActuationMem, ...nightCyclePending].findIndex((l) => missedApplyDue(l, nowMs));
  if (at < 0) return;
  const pending = at > 0;
  const leg = pending ? nightCyclePending[at - 1] : nightActuationMem;
  // The leg is stamped whatever the reason reads: the cycle step promotes a missed active leg only
  // once its push is stamped (chargeCycle.promoteCycle), so a throw here must not block the stamp.
  let reason = MISSED_APPLY_FALLBACK_REASON;
  let currentReservePct: number | null = null;
  try {
    const shp2 = findShp2(store.get().devices);
    const sp: any = shp2 && shp2.projection?.kind === 'shp2' && shp2ReadbackFresh(shp2, nowMs) ? shp2.projection : null;
    const fullWh: number | null = sp?.backupFullCapWh ?? null;
    const socNowPct: number | null = sp?.backupBatPercent ?? null;
    const remainWh: number | null = sp?.backupRemainWh ?? null;
    const socCoherent = fullWh != null && fullWh > 0 && socNowPct != null && remainWh != null
      && Math.abs((remainWh / fullWh) * 100 - socNowPct) <= 8;
    currentReservePct = typeof sp?.backupReserveSoc === 'number' ? sp.backupReserveSoc : null;
    reason = missedApplyReason(leg, {
      blockedBy: pending ? (nightCycleTrailing != null && !trailingResolved(nightCycleTrailing) ? nightCycleTrailing : nightActuationMem) : null,
      mode: NIGHT_CHARGE_MODE,
      vitalsRed: currentAssessment()?.level === 'crit',
      socCoherent,
      currentReservePct,
      panelBlock: multiPanelWriteBlock(),
    });
  } catch (e: any) {
    app.log.warn(`night-charge: missed-apply reason unavailable (${e?.message ?? e}) — the push names none.`);
  }
  const stamped: ChargeLegState = { ...leg, missedApplyPushedAtMs: nowMs };
  if (pending) persistCycle({ ...nightCycleView(), pendingLegs: nightCyclePending.map((p, i) => (i === at - 1 ? stamped : p)) });
  else persistNightActuation(stamped);
  stampLegOutcome(leg, { arm_disposition: `missed — ${reason}` });
  app.log.warn(`night-charge: the ${leg.leg} leg for ${leg.day} (${leg.windowStartMs != null ? new Date(leg.windowStartMs).toISOString() : '?'}) did not start — ${reason}. Nothing was written; the reserve reads ${currentReservePct ?? 'unknown'}%.`);
  void sendNotification(loadNotifyConfig(), buildNightChargeMissedApply({
    day: leg.day, role: leg.leg, windowStartMs: leg.windowStartMs ?? nowMs, windowEndMs: leg.windowEndMs ?? nowMs,
    reason, reservePct: currentReservePct, nowMs,
  })).catch((e: any) => {
    app.log.debug(`night-charge: missed-apply notify failed (${e?.message ?? e})`);
  });
}

/**
 * R5 (v1.189.0) — THE LIVE MORNING REFRESH of an armed winter mid-day cost leg (morningRefresh.ts,
 * plan §3.4). INERT UNTIL THE MID-DAY SWITCH: liveRefreshDue finds a leg only when the ACTIVE leg is
 * a super off-peak cost leg, and the evening job arms the overnight leg alone — every tick returns
 * at its first test. When the switch arms one:
 *  1. from 30 to 5 min before the open, the leg is re-planned on its own window (the planner's pinned
 *     leg: the plan is returned only), a fresh panel, and a forecast on weather at most
 *     REFRESH_MAX_WEATHER_AGE_MS old — the worker is asked for it (the reports' maxWeatherAgeMs, never
 *     the main thread's cached answer); older weather (a failed fetch) defers to the next minute;
 *  2. the leg is re-read after the await (refreshAborted), and an answer that arrives at or after
 *     open − 5 min is dropped unwritten (refreshPastDeadline: the next tick stamps the arm standing);
 *  3. refreshLeg against what the evening announced: lower or cancel, never raise;
 *  4. refreshedAtMs — with a lowered reserve and force-charge ceiling, or the cancel — is persisted
 *     BEFORE anything is pushed;
 *  5. it pushes, and never speaks, on a cancel, a changed written value, a cap or a ±25% move.
 * At 5 min before the open with no refresh made, the evening's arm stands (stamped once).
 * Every judgement after the await (the deadline, the weather's age, the stamps) reads the clock
 * after it: the planner's await can outlast the minute it started in.
 */
let morningRefreshInFlight = false;
let morningRefreshDeferLoggedFor: string | null = null;
async function runMorningRefreshTick(): Promise<void> {
  if (morningRefreshInFlight) return;
  morningRefreshInFlight = true;
  try {
    await runMorningRefreshTickInner(Date.now());
  } catch (e: any) {
    app.log.warn(`night-charge: morning refresh failed (${e?.message ?? e}); the evening arm stands until the next minute`);
  } finally {
    morningRefreshInFlight = false;
  }
}

async function runMorningRefreshTickInner(nowMs: number): Promise<void> {
  const due = liveRefreshDue(nightCycleView(), nowMs);
  if (due == null) return; // every tick until the mid-day switch arms a super off-peak cost leg
  const leg = nightActuationMem;
  const key = `${leg.day}@${leg.windowStartMs}`;
  if (due === 'stand') {
    const o = standingLiveRefresh(leg, `no refresh completed by ${REFRESH_DEADLINE_MS / 60_000} minutes before the window; the evening arm stands`);
    persistNightActuation(applyLiveRefresh(leg, o, nowMs));
    stampLegOutcome(leg, liveRefreshLedgerColumns(o, nowMs, null));
    app.log.info(`night-charge: morning refresh for ${leg.day} — stood: ${o.reason}.`);
    return;
  }
  const model = tariffModelFromEnv();
  const sizing = costLegSizing(model, { role: 'cost', kind: 'super_off_peak', startMs: leg.windowStartMs!, endMs: leg.windowEndMs! },
    shadowCycleConfig(FORCE_CHARGE_OBJECTIVE, FORCE_CHARGE_COST_MAX_SOC_PCT), { chgMaxSocPcts: homeChgMaxSocPcts(), backupHold: null });
  const r = await recomputeNightChargePlan({ shadowLeg: sizing, maxWeatherAgeMs: REFRESH_MAX_WEATHER_AGE_MS });
  const at = Date.now();
  if (refreshPastDeadline(leg, at)) {
    app.log.info(`night-charge: morning refresh for ${leg.day} dropped — its answer came ${REFRESH_DEADLINE_MS / 60_000} minutes or less before the window; the evening arm stands.`);
    return;
  }
  if (r === 'panelStale' || r == null) {
    if (morningRefreshDeferLoggedFor !== key) {
      morningRefreshDeferLoggedFor = key;
      app.log.info(`night-charge: morning refresh for ${leg.day} deferred — ${r === 'panelStale' ? 'the panel reading is stale' : 'the planner had no inputs'}; retrying each minute until ${REFRESH_DEADLINE_MS / 60_000} minutes before the window.`);
    }
    return;
  }
  const wxAt = r.extras.weatherFetchedAtMs ?? null;
  if (!refreshWeatherFresh(wxAt, at)) {
    if (morningRefreshDeferLoggedFor !== key) {
      morningRefreshDeferLoggedFor = key;
      const age = weatherAgeSeconds(wxAt, at);
      app.log.info(`night-charge: morning refresh for ${leg.day} deferred — the forecast's weather is ${age != null ? `${Math.round(age / 60)} min` : 'of unknown age'} old (at most ${REFRESH_MAX_WEATHER_AGE_MS / 60_000} min); retrying each minute.`);
    }
    return;
  }
  // Re-read after the await: a leg re-armed, cancelled, attempted or refreshed meanwhile is not this refresh's.
  const live = nightActuationMem;
  const aborted = refreshAborted(leg, live);
  if (aborted != null) {
    app.log.info(`night-charge: morning refresh for ${leg.day} dropped — ${aborted}.`);
    return;
  }
  const o = liveRefreshOutcome(live, r.plan);
  persistNightActuation(applyLiveRefresh(live, o, at)); // stamped before anything is pushed (plan §3.4 step 4)
  stampLegOutcome(live, liveRefreshLedgerColumns(o, at, weatherAgeSeconds(wxAt, at)));
  app.log.info(`night-charge: morning refresh for ${live.day} — ${o.disposition}: ${o.reason}; reserve ${o.reservePct ?? '—'}%, level ~${o.levelPct ?? '—'}%, expected ${o.expectedBuyKwh ?? '—'} kWh.`);
  const msg = buildMiddayRefreshMessage({
    nowMs: at, windowStartMs: live.windowStartMs!, windowEndMs: live.windowEndMs!, announcedAtMs: live.announcedAtMs,
    disposition: o.disposition,
    announced: { levelPct: live.announcedLevelPct, expectedKwh: live.announcedExpectedKwh },
    refreshed: { levelPct: o.levelPct, reservePct: o.reservePct, expectedKwh: o.expectedBuyKwh },
    neededLevelPct: o.neededLevelPct,
    neededReservePct: o.neededReservePct,
    windowPvKwh: { announced: null, refreshed: r.extras.windowPvP50Kwh ?? null },
    reservePct: freshReserveReadingPct(at),
    applyAtMs: live.windowStartMs! - APPLY_LEAD_MS,
    wouldPush: o.wouldPush,
  });
  // A push, never speech (plan §3.4 step 5); not awaited.
  if (msg != null) {
    void sendNotification(loadNotifyConfig(), msg).catch((e: any) => {
      app.log.debug(`night-charge: morning refresh notify failed (${e?.message ?? e})`);
    });
  }
}

if (nightChargeEnabled) {
  // Periodic recompute (30 min, unref'd) so /api/ha-state + status always have a
  // ≤12 h-fresh plan even on days the evening job hasn't fired yet. Best-effort.
  const nightRecomputeTick = setInterval(() => {
    void (async () => {
      try { await recomputeNightChargePlan(); }
      catch (e: any) { app.log.debug(`night-charge: recompute tick skipped (${e?.message ?? e})`); }
      // Score yesterday + refresh readiness on the tick too (idempotent — the
      // scorer returns once outcome_captured_at_ms is set) so the ledger and the
      // write-readiness reduction stay current EVEN on a day the evening notify
      // job never fired — decoupling outcome capture from the notify window so a
      // missed window can't silently drop a night (an MNAR bias in the gate).
      try { scoreCompletedNights(Date.now()); }
      catch (e: any) { app.log.debug(`night-charge: tick scoring skipped (${e?.message ?? e})`); }
      // v1.129.0 — refresh the ISLANDED LOAD here, on the same timer that
      // recomputes the plan that consumes it. Until now this was only ever
      // populated as a side effect of the /api/ha-state handler, so after a
      // restart the outage cushion silently fell back to its legacy flat band
      // until something happened to request that endpoint — observed still
      // legacy more than an hour after the v1.128.1 deploy. Safety-relevant
      // sizing must not depend on an unrelated route being hit.
      try {
        const sc: any = await analytics.report('selfConsumption');
        if (Number.isFinite(sc?.loadKwh) && (sc?.loadKwh ?? 0) > 0) {
          noteIslandedLoadKw((sc.loadKwh as number) / (7 * 24));
        }
      } catch (e: any) { app.log.debug(`night-charge: islanded-load refresh skipped (${e?.message ?? e})`); }
      try {
        setLatestReadiness(computeNightChargeReadiness(recorder.readNightLedger(400), Date.now(), nightReadinessOpts()));
      } catch (e: any) { app.log.debug(`night-charge: tick readiness recompute failed (${e?.message ?? e})`); }
      refreshNightRecentOutcomes(); // keep the status route's cache warm (DB read on a timer, not the handler)
    })();
  }, 30 * 60 * 1000);
  nightRecomputeTick.unref();

  // v1.129.0 — and once at boot, so the FIRST plan after a deploy is sized on the
  // real islanded load rather than the legacy band.
  //
  // v1.129.1 — RETRIED, AND NEVER SILENT. The v1.129.0 cut ran once with an empty
  // `catch {}`; on the 2026-09-04 20:23 boot it produced no log line and the plan
  // stayed on the legacy band, and the swallowed error made it impossible to tell
  // whether the call had failed or never run. The analytics worker is cold at
  // boot, so one immediate attempt is the wrong shape — and a diagnostic path that
  // hides its own failure is the exact pattern this release series has been
  // removing everywhere else.
  void (async () => {
    const delays = [0, 15_000, 60_000, 180_000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
      try {
        const sc: any = await analytics.report('selfConsumption');
        const kw = Number.isFinite(sc?.loadKwh) && (sc?.loadKwh ?? 0) > 0
          ? (sc.loadKwh as number) / (7 * 24)
          : null;
        if (kw != null) {
          noteIslandedLoadKw(kw);
          app.log.info(`night-charge: islanded load ${kw.toFixed(2)} kW (7-day mean panel load) — outage cushion sized on it`);
          return;
        }
        app.log.debug(`night-charge: islanded-load seed attempt ${i + 1} returned no usable loadKwh`);
      } catch (e: any) {
        app.log.debug(`night-charge: islanded-load seed attempt ${i + 1} failed (${e?.message ?? e})`);
      }
    }
    // Not fatal: the 30-minute recompute tick refreshes it, and until then the
    // cushion falls back to its legacy band — fail-closed, just less precise.
    app.log.info('night-charge: islanded-load seed did not settle at boot; the 30-minute recompute will carry it');
  })();
  // A gentle first warm-up a minute after boot (analytics worker warm) so the
  // holder + status cache aren't empty before the first scheduled tick.
  // v1.39.0: the warm path now also (a) repairs prematurely-captured outcome
  // rows, (b) runs the completion-gated backfill scorer, and (c) recomputes
  // readiness — previously readiness stayed null for up to 30 min after every
  // add-on restart (update/maintenance), flapping the HA gate fields to null.
  const nightWarm = setTimeout(() => {
    repairPrematureNightOutcomes();
    repairShortForecastSpanOutcomes(); // v1.187.10 — before the sweep below re-captures them
    tagKnownFleetMismatchPvRows(); // v1.187.0 — before readiness reads the ledger below
    // v1.187.0 (review) — once per boot: a confirmed table that cannot price every period
    // leaves realized_cost_cents NULL on every night crossing it (each row's note says so).
    try {
      const tariffNowModel = tariffModelFromEnv();
      const unpriced = unpricedTariffPeriods(tariffNowModel);
      if (unpriced.length > 0) {
        app.log.warn(`night-charge: the confirmed tariff has no rate for ${unpriced.join(', ')} — realized_cost_cents stays NULL for any night whose scored span crosses one (score_notes names it). Set the matching ${rateOptionsHint(tariffNowModel.planId)} option to price it.`);
      }
    } catch (e: any) { app.log.debug(`night-charge: tariff coverage check skipped (${e?.message ?? e})`); }
    void recomputeNightChargePlan().catch((e: any) => app.log.debug(`night-charge: warm recompute skipped (${e?.message ?? e})`));
    try { scoreCompletedNights(Date.now()); } catch (e: any) { app.log.debug(`night-charge: warm scoring skipped (${e?.message ?? e})`); }
    try {
      setLatestReadiness(computeNightChargeReadiness(recorder.readNightLedger(400), Date.now(), nightReadinessOpts()));
    } catch (e: any) { app.log.debug(`night-charge: warm readiness recompute failed (${e?.message ?? e})`); }
    refreshNightRecentOutcomes();
  }, 60 * 1000);
  nightWarm.unref();
  // Evening job — minute-granular gate + day-keyed restart-persistent latch.
  const nightEveningTick = setInterval(() => { void runNightChargeEveningJob(); }, 60 * 1000);
  nightEveningTick.unref();
  // v1.50.0 — supervised-write actuator (v1.187.0: apply at window open, revert at
  // window close — APPLY_LEAD_MS / REVERT_LAG_MS are 0; both fail-closed, both audited).
  const nightActuationTick = setInterval(() => { void runNightActuationTick(); }, 60 * 1000);
  nightActuationTick.unref();
  // R4 — the winter mid-day cycle in shadow: computed and recorded, never written (middayShadow.ts).
  const nightMiddayShadowTick = setInterval(() => { void runMiddayShadowTick(); }, 60 * 1000);
  nightMiddayShadowTick.unref();
  // R5 — the live morning refresh of an armed mid-day cost leg: inert until the mid-day switch
  // (morningRefresh.liveRefreshDue finds no leg while nothing arms one).
  const nightMorningRefreshTick = setInterval(() => { void runMorningRefreshTick(); }, 60 * 1000);
  nightMorningRefreshTick.unref();
}

// v1.165.0 — the force-charge OFF side must OUTLIVE the master switch. The actuation
// tick above only exists while NIGHT_CHARGE_ADVISOR_ENABLED is on, and changing any
// option restarts the add-on — so an owner who flips that switch mid-night (the most
// obvious "turn this off") would otherwise leave force-charge ON with nothing left to
// switch it off. This tick does nothing unless a force-charge of ours is in flight,
// and then it can only ever switch it OFF (forceDisabled).
const forceChargeSafetyTick = setInterval(() => {
  if (nightChargeEnabled) return; // the normal tick owns it
  // v1.189.0 — and a trailing leg's OFF (chargeCycle.ts), which only ever switches off.
  if (nightCycleTrailing != null && forceChargeInFlight(nightCycleTrailing) && !nightActuationInFlight) {
    nightActuationInFlight = true;
    runTrailingLegTick()
      .catch((e: any) => app.log.warn(`night-charge: trailing-leg safety tick failed (${e?.message ?? e})`))
      .finally(() => { nightActuationInFlight = false; });
    return;
  }
  if (!forceChargeInFlight(nightActuationMem) || nightActuationInFlight) return;
  nightActuationInFlight = true;
  runForceChargeTick({ forceDisabled: true })
    .catch((e: any) => app.log.warn(`night-charge: force-charge safety tick failed (${e?.message ?? e})`))
    .finally(() => { nightActuationInFlight = false; });
}, 60 * 1000);
forceChargeSafetyTick.unref();

// v1.91.0 — these four engines are independent of night charge and must run
// even when NIGHT_CHARGE_ENABLED is off. They had accreted inside the block
// above, so disabling night charge would have silently killed all four.
const vendorEnergyTick = setInterval(() => { void runVendorEnergyJob(); }, 60 * 1000); // v1.82 vendor energy ledger
vendorEnergyTick.unref();
const settingsDriftTick = setInterval(() => { runSettingsDriftTick(); }, 60 * 1000); // v1.83 settings-drift watch
settingsDriftTick.unref();
const chargeNowTick = setInterval(() => { void runChargeNowTick(); }, 60 * 1000); // v1.84 charge-now responder
chargeNowTick.unref();
const reconnectWatchTick = setInterval(() => { void runReconnectWatchTick(); }, 60 * 1000); // v1.90 reconnect auto-audit
reconnectWatchTick.unref();

// Read-only advisory status (design §4.4). No auth: exposes no secrets, actuates
// nothing. Mirrors /api/load-shedding/status. reserveFloorPercent is the SAME
// projection.backupReserveSoc the floor alarm defends — never a divergent copy.
app.get('/api/night-charge/status', async () => {
  const plan = getLatestNightChargePlan();
  const shp2 = findShp2(store.get().devices);
  const sp: any = shp2 && shp2.projection?.kind === 'shp2' ? shp2.projection : null;
  const latch = readNightChargeLatch();
  const nightSchedNotify = nightScheduleNow().notify;
  return {
    enabled: nightChargeEnabled,
    mode: NIGHT_CHARGE_MODE,
    // v1.191.0 (T16) — the zone every time in this payload was computed in; the card writes its
    // clock times in it (never the browser's zone).
    siteTimeZone: siteTimeZone(),
    // v1.182.0 — the panel's reserve maximum, so the card shows what will actually be written.
    reserveWriteMaxPct: RESERVE_WRITE_MAX_PCT,
    window: plan?.window ?? null,
    reserveFloorPercent: sp?.backupReserveSoc ?? null,
    confidence: plan?.confidenceTier ?? null,
    // v1.191.0 (S6) — the time the evening job fires (the configured one on the APS preset).
    notify: { hour: nightSchedNotify.hour, minute: nightSchedNotify.minute, lastNotifyDay: latch.lastNotifyDay },
    plan,
    // v1.187.22 — why a write mode refused to arm this plan's window, until it closes; the card
    // leads with it instead of the plan's expected charge (servedArmRefusal). null = not refused.
    armRefusal: servedArmRefusal(latch.armRefused, plan, NIGHT_CHARGE_MODE, Date.now()),
    readiness: getLatestReadiness(),
    // v1.50.0 — tonight's supervised-write record (armed/applied/cancelled/
    // reverted), served from the in-memory mirror.
    actuation: {
      ...nightActuationMem,
      cancelDeadlineMs:
        nightActuationMem.windowStartMs != null ? nightActuationMem.windowStartMs - APPLY_LEAD_MS : null,
      // v1.186.0 — beside forceChargeOnAtMs (and forceChargeOnVerifiedAtMs /
      // forceChargeOnFailedAtMs, spread above): did the ON actually take?
      forceChargeOnVerify: forceChargeOnReadbackStatus(nightActuationMem),
    },
    // v1.189.0 — the charge cycle's legs, in order: a trailing leg, the active one (the record
    // above), the pending ones (chargeCycle.cycleLegsStatus). One entry with one leg.
    legs: cycleLegsStatus(nightCycleView(), Date.now()),
    // v1.189.0 (R4) — the winter mid-day cycle computed in shadow (middayShadow.ts), while it is the
    // current one (shadowServed); null otherwise. Read-only: the card shows it with no control.
    middayShadow: shadowServed(getMiddayShadow(), Date.now()) ? getMiddayShadow() : null,
    // R5 — what the 21:30 notice would have pushed and spoken for it (chargeText.ts): never sent; the
    // card shows its title read-only.
    middayShadowPreview: shadowServed(getMiddayShadow(), Date.now()) ? middayShadowPreview(getMiddayShadow(), tariffModelFromEnv()) : null,
    // In-memory cache refreshed by the recompute tick / evening job — the route
    // must NOT read the ledger (DB/filesystem) inline (CWE-770).
    recentOutcomes: nightRecentOutcomesMem,
  };
});

// v1.50.0 — owner cancel for tonight's supervised write. Before the apply
// moment this disarms; after a successful apply it triggers an immediate
// revert on the next actuator tick (≤60 s). Same write auth as every other
// actuating endpoint.
// v1.189.0 — by leg (chargeCycle.cancelLeg): an optional body { leg: 'cost' | 'backup' }. With no leg
// named it cancels the cost leg wherever it is (active or pending), else the active leg — with one
// leg, the active leg, as always. The pending legs are looked at before any 409; a 409 answers for
// the leg named. `actuation` is the leg cancelled.
app.post('/api/night-charge/cancel', { preHandler: requireWriteAuth }, async (req, reply) => {
  const want = parseCancelLeg(req.body);
  if (want === undefined) {
    reply.code(400);
    return { ok: false, error: 'leg must be "cost" or "backup"' };
  }
  const r = cancelLeg(nightCycleView(), want);
  if (!r.ok) {
    reply.code(409);
    return { ok: false, error: r.error };
  }
  persistCycle(r.cycle);
  const s = r.leg;
  const which = s.leg === 'cost' && s.windowKind === 'overnight' ? '' : ` ${s.leg === 'backup' ? 'outage-backup' : 'daytime'} leg${r.where === 'pending' ? ' (pending)' : ''}`;
  app.log.info(
    `night-charge: owner CANCELLED tonight's supervised write${which} (${s.day})${s.appliedAtMs != null ? ' — the applied write reverts within a minute' : ''}.`,
  );
  return { ok: true, actuation: s, leg: s.leg, legs: cycleLegsStatus(nightCycleView(), Date.now()) };
});

// v1.184.0 — the operator's "the grid is back" for a declared-grid veto held on a panel reading
// the panel is not refreshing (docs/reference/05-runway-and-soc-alarms.md “4.2 Signals combined
// (resolveGridBackstop)”). Refused while the panel is
// freshly reporting no grid: that is the measurement, and its next poll would veto again.
// v1.185.0 — the house panel: which one night charge writes to, every panel's pool, and (POST) the
// operator's pin when two panels stand with none pinned. Moving an EXISTING pin is refused while a
// supervised write could still be outstanding on the old panel — its retry or revert would land on
// the new one and strand the old panel's reserve raised or a slot force-charging.
app.get('/api/house-panel', async () => {
  const devs = store.get().devices;
  return {
    ...store.housePanelState(),
    writeBlock: multiPanelWriteBlock(),
    pools: Object.values(devs)
      .filter((d) => d.projection?.kind === 'shp2')
      .map((d) => {
        const p = d.projection as Shp2Projection;
        const rw = lastPanelRunways.get(d.sn);
        return {
          sn: d.sn, name: d.deviceName, house: d.housePanel === true, online: d.online,
          backupPct: p.backupBatPercent ?? null, reservePct: p.backupReserveSoc ?? null,
          ...(rw ? { runway: { drainW: rw.drainW, hoursToReserve: rw.hoursToReserve, hoursToEmpty: rw.hoursToEmpty, unavailable: rw.unavailable } } : {}),
        };
      }),
  };
});
app.post<{ Body: { sn?: unknown } }>('/api/house-panel', { preHandler: requireWriteAuth }, async (req, reply) => {
  const sn = typeof req.body?.sn === 'string' ? req.body.sn.trim() : '';
  const st = store.housePanelState();
  if (!st.panels.some((p) => p.sn === sn)) {
    reply.code(400);
    return { ok: false, error: 'sn must be a smart panel on this account', panels: st.panels };
  }
  if (st.sn != null && st.sn !== sn) {
    const house = findShp2(store.get().devices);
    const forcing = (house?.projection.sources ?? []).some((c) => c?.forceCharge === 'FORCE_CHARGE_ON');
    const m = nightActuationMem;
    const busy = getReserveArbitrageRaised() ? 'the night-charge plan is holding the house panel\'s reserve raised'
      : m.applyAttemptedAtMs != null && m.appliedAtMs == null && m.revertedAtMs == null ? 'a night-charge reserve write is unconfirmed'
      : m.forceChargeCeilingPriorPct != null && m.forceChargeCeilingRestoredAtMs == null ? 'the house panel\'s force-charge ceiling is still to be restored'
      // v1.189.0 — and a trailing leg (chargeCycle.ts) still switching its force-charge off.
      : nightCycleTrailing != null && !trailingResolved(nightCycleTrailing) ? 'a previous night-charge leg is still confirming its force-charge off'
      : nightActuationInFlight ? 'a night-charge write is in flight'
        : chargeNowState.pendingVerify ? 'a Charge Now write is awaiting readback'
          : forcing ? 'a house-panel slot is force-charging'
            : null;
    if (busy) {
      reply.code(409);
      return { ok: false, error: `not moved: ${busy} — pin again once it has reverted` };
    }
  }
  store.pinHousePanel(sn);
  return { ok: true, ...store.housePanelState() };
});

app.post('/api/grid-veto/clear', { preHandler: requireWriteAuth }, async (_req, reply) => {
  const g = liveGridBackstop(store.get().devices);
  if (!g.vetoClearable) {
    reply.code(409);
    return { ok: false, error: g.declared ? 'no grid veto is in force' : 'the panel is reporting no grid now — nothing stale to clear' };
  }
  const panels = store.clearGridVeto();
  app.log.info(`grid-veto: operator CLEARED the saved "no grid" reading (${panels} panel(s)); was: ${g.reason}. The panel's next reading counts again.`);
  return { ok: true, grid: liveGridBackstop(store.get().devices) };
});

// Diagnostics: the analytics worker is the cache warmer now (self-warming
// inside a worker thread). Endpoint kept for backward-compat.
app.get('/api/cache-warmer/status', async () => ({
  mode: 'worker-self-warm',
}));

/* v0.9.18 — broadcast diagnostic + manual test endpoints.
 *
 * GET  /api/broadcast/status — current config snapshot + last broadcast
 * POST /api/broadcast/test   — fire a test broadcast (bypasses all gates)
 *   body: { level?: "red" | "yellow" | "green" }   (default "red")
 */
app.get('/api/broadcast/status', async () => {
  const s = broadcast.status();
  const cfg = broadcast.config();
  return {
    ...s,
    // v0.23.0 — live grid-backstop state, so the operator can see whether the
    // floor alarms are currently in their downgraded (grid present) posture.
    grid: liveGridBackstop(store.get().devices),
    config: {
      enabled: cfg.enabled,
      targets: cfg.targets,
      audioBase: cfg.audioBase,
      volume: cfg.volume,
      // v0.15.8 — surface the RESOLVED announcement knobs so the operator can
      // verify what actually takes effect (e.g. that announceVolume resolved to
      // 100 with BROADCAST_VOLUME:1 + a blank BROADCAST_ANNOUNCE_VOLUME). null
      // announceVolume = "off"/standing (announce_volume omitted from the call).
      announceVolume: cfg.announceVolume,
      repeat: cfg.repeat,
      repeatGapMs: cfg.repeatGapMs,
      chimeGapMs: cfg.chimeGapMs,
      leadSilenceMs: cfg.leadSilenceMs,
      usePreAnnounce: cfg.usePreAnnounce,
      announceRetries: cfg.announceRetries,
      // v0.61.0 — "End of message" terminator on the final play (resolved state).
      endOfMessage: cfg.endOfMessage,
      endOfMessagePhrase: cfg.endOfMessagePhrase,
      endOfMessageGapMs: cfg.endOfMessageGapMs,
      // v0.62.0 — bilingual second pass (English + Spanish). `bilingualActive` is
      // the EFFECTIVE state: on only when a Spanish voice is also configured.
      bilingual: cfg.bilingual,
      bilingualActive: cfg.bilingual && cfg.secondLangVoice.length > 0,
      secondLangVoice: cfg.secondLangVoice,
      endOfMessagePhraseEs: cfg.endOfMessagePhraseEs,
      minSeverity: cfg.minSeverity,
      quietHours: cfg.quietHours,
      // v0.23.0 — whether critical alerts break through quiet hours (opt-in).
      criticalBreakThrough: cfg.criticalBreakThrough,
      // v0.9.70 — Wyoming is the canonical TTS path now. No engine
      // selector / fallback chain / language toggle / Sonos restore —
      // all that lived in v0.9.18-v0.9.69's broadcast complexity that
      // got removed when MA + Wyoming-direct replaced the tts_get_url
      // + media_player + per-protocol stagger machinery.
      wyomingHost: cfg.wyomingHost,
      wyomingPort: cfg.wyomingPort,
      wyomingVoice: cfg.wyomingVoice,
    },
  };
});

// v0.18.0 — live broadcast enable + volume, mutable from the UI without a
// restart. The env (BROADCAST_ENABLED / BROADCAST_VOLUME) is the boot baseline;
// a /data override (set here) wins at runtime and persists. The response
// surfaces effective / override / envBaseline so the UI can show default-vs-
// overridden and disclose when an env-pinned BROADCAST_ANNOUNCE_VOLUME makes the
// volume slider audibly inert.
const broadcastConfigRateLimit = makeRateLimiter(30, 60_000);
function broadcastConfigResponse() {
  const cfg = broadcast.config();              // effective (override already merged in loadBroadcastConfig)
  const ov = getBroadcastRuntimeConfig();      // the /data override (null fields = deferring to env)
  const envEnabled = process.env.BROADCAST_ENABLED === 'true' || process.env.BROADCAST_ENABLED === '1';
  const envVolRaw = Number(process.env.BROADCAST_VOLUME ?? 0.5);
  const envVolume = Number.isFinite(envVolRaw) ? Math.max(0, Math.min(1, envVolRaw)) : 0.5;
  const announceVolumePinned = (process.env.BROADCAST_ANNOUNCE_VOLUME ?? '').trim().length > 0;
  return {
    enabled: cfg.enabled,
    volume: cfg.volume,
    announceVolume: cfg.announceVolume,
    // When true, BROADCAST_ANNOUNCE_VOLUME pins the announce volume and the
    // master slider is informational only (no audible effect).
    announceVolumePinned,
    source: ov.source,
    updatedAt: ov.updatedAt,
    override: { enabled: ov.enabled }, // null = deferring to env
    envBaseline: { enabled: envEnabled },
  };
}

// GET — current effective broadcast enable/volume + override + env baseline. NO
// auth: read-only and non-sensitive (matches /api/broadcast/status). Served
// entirely from in-memory state (broadcast.config() is the monitor's closure
// config; getBroadcastRuntimeConfig() caches after its first disk read), so the
// read bucket below is belt-and-braces (CodeQL js/missing-rate-limiting) — and
// DELIBERATELY separate from the PUT's bucket so a flood of reads can never
// 429 an operator write. The UI fetches this once per console mount.
const broadcastConfigReadRateLimit = makeRateLimiter(120, 60_000);
app.get(
  '/api/broadcast/config',
  { preHandler: broadcastConfigReadRateLimit },
  async () => broadcastConfigResponse(),
);

// PUT — set or clear the runtime enable/volume override. Write-gated + rate
// limited (touches /data). A field present sets it (boolean/number overrides
// env; explicit null clears back to the env baseline); an absent field is
// unchanged.
app.put<{ Body: { enabled?: boolean | null } }>(
  '/api/broadcast/config',
  { preHandler: [requireWriteAuth, broadcastConfigRateLimit] },
  async (req) => {
    // Guard the body SHAPE before the `in` operator — the raw JSON parser passes
    // primitives through, and `'enabled' in 42` throws. A non-object body is a
    // no-op patch (the response still echoes the current effective config).
    const body: { enabled?: boolean | null } =
      req.body && typeof req.body === 'object' ? req.body : {};
    const patch: { enabled?: boolean | null } = {};
    if ('enabled' in body) patch.enabled = body.enabled;
    const next = updateBroadcastRuntimeConfig(patch, 'web');
    appendWriteLog({
      ts: Date.now(),
      action: 'broadcast-config',
      sn: '', // global, not device-specific
      params: { enabled: next.enabled },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return broadcastConfigResponse();
  },
);

app.post<{ Body: { level?: 'red' | 'yellow' | 'green' } }>(
  '/api/broadcast/test',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    // v1.185.1 — the CONDITION levels (red/yellow/green), not the chime rungs (see broadcast.ts).
    const level = parseBroadcastTestLevel(req.body?.level);
    if (level == null) {
      reply.code(400);
      return { ok: false, error: 'level must be red, yellow, or green' };
    }
    const r = await broadcast.test(level);
    // v0.9.23 — 429 when blocked by cooldown, 502 on real failures, 200 ok.
    if (!r.ok) {
      const isCooldown = r.cooldownRemainingMs != null && r.cooldownRemainingMs > 0 && r.messages.some((m) => m.startsWith('cooldown:'));
      reply.code(isCooldown ? 429 : 502);
    }
    return r;
  },
);

/* ──────────────────────────────────────────────────────────────────────
 * v0.11.0 — Alert Settings (ISA-18.2 / IEC 62682 alarm-priority annunciation
 * toggles) and per-priority announcement preview.
 *
 * The internal Alert.severity union is unchanged; priority is DERIVED. These
 * routes expose the user-mutable annunciation layer (alertSettings.ts) and a
 * preview that renders/plays exactly what each priority sounds like.
 * ────────────────────────────────────────────────────────────────────── */

/** Serialize the current settings into the cross-group contract shape. */
function alertSettingsResponse() {
  const settings = getAlertSettings();
  return {
    priorities: ALARM_PRIORITY_ORDER.map((id) => {
      const m = ALARM_PRIORITY_META[id];
      return {
        id: m.id,
        label: m.label,
        isa: m.isa,
        rank: m.rank,
        tag: m.tag,
        colorToken: m.colorToken,
        description: m.description,
        response: m.response,
        enabled: settings.priorityEnabled[id] !== false,
      };
    }),
    updatedAt: settings.updatedAt,
  };
}

// GET — current annunciation settings. NO auth: read-only and non-sensitive
// (matches /api/broadcast/status, which is also unauthenticated). Served from
// memory (getAlertSettings() caches after its first disk read); the dedicated
// read bucket bounds request-handling work regardless (CodeQL
// js/missing-rate-limiting) without sharing the write path's budget.
const alertSettingsReadRateLimit = makeRateLimiter(120, 60_000);
app.get(
  '/api/alert-settings',
  { preHandler: alertSettingsReadRateLimit },
  async () => alertSettingsResponse(),
);

// PUT — update per-priority enable flags. Write-gated.
app.put<{ Body: { priorityEnabled?: Partial<Record<AlarmPriority, boolean>> } }>(
  '/api/alert-settings',
  { preHandler: requireWriteAuth },
  async (req) => {
    const body = req.body ?? {};
    const next = updateAlertSettings({ priorityEnabled: body.priorityEnabled }, 'web');
    appendWriteLog({
      ts: Date.now(),
      action: 'alert-settings',
      sn: '', // not device-specific — settings are global annunciation toggles
      params: { priorityEnabled: next.priorityEnabled },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return alertSettingsResponse();
  },
);

// POST — preview a priority's announcement in the browser or on the speakers.
// v1.186.4 — every RUNG, the all-clear included (it has a tone, so it gets a preview).
const PREVIEW_RUNGS: AlarmRung[] = ['critical', 'high', 'medium', 'low', 'clear'];
app.post<{ Body: { priority?: AlarmRung; target?: 'browser' | 'speakers' } }>(
  '/api/alert-preview',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    const priority = req.body?.priority;
    const target = req.body?.target;
    if (!priority || !PREVIEW_RUNGS.includes(priority)) {
      reply.code(400);
      return { ok: false, error: 'priority must be one of critical, high, medium, low, clear' };
    }
    if (target !== 'browser' && target !== 'speakers') {
      reply.code(400);
      return { ok: false, error: "target must be 'browser' or 'speakers'" };
    }
    const r = await broadcast.preview(priority, target);
    // Mirror /api/broadcast/test: 429 on cooldown, 502 on real failure, 200 ok.
    if (!r.ok) {
      const isCooldown = r.cooldownRemainingMs != null && r.cooldownRemainingMs > 0;
      reply.code(isCooldown ? 429 : 502);
    }
    return r;
  },
);

/* ─── v0.15.23 Alert Console — chime tone library + per-level assignment ───
 * Upload your own alarm tones (POST /api/chimes, raw WAV body) and assign one
 * per level (PUT /api/chime-config). The tone PREPENDS the spoken message in
 * place of the synthesized klaxon. All gated by requireWriteAuth (ingress /
 * same-origin), audit-logged, and normalized + validated by chimeStore. A bad
 * or deleted tone degrades to the built-in klaxon (chimeConfig.resolveChime),
 * never a silent alarm. Browser preview plays /chimes/<id>.wav directly. */
// v1.58.0 — ANNOTATED, not asserted. `as Record<…>` lets a missing key through
// and renders an undefined label; this form is TS2739 the moment the level union
// gains a member without a label here.
const LEVEL_LABELS: Record<AnnouncementLevel, string> = {
  critical: 'Critical (P1)',
  high: 'High (P2)',
  medium: 'Medium (P3)',
  low: 'Low (P4)',
  clear: 'All-clear / Recovery',
};

function chimeConsoleResponse() {
  const cfg = getChimeConfig();
  return {
    levels: CHIME_LEVELS,
    // UI labels for the 3 audio levels (the 4 ISA priorities collapse to these).
    levelLabels: LEVEL_LABELS,
    assignments: cfg.assignments,
    chimes: listChimes(),
    // v0.17.0 — the named built-in tone library, selectable per level alongside
    // the level default and uploads. Preview each at /audio/<id>.wav.
    builtinTones: BUILTIN_TONES,
    updatedAt: cfg.updatedAt,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}

// List uploaded tones + current per-level assignments (read-only).
// Rate-limited like the other read endpoints (broadcast/config, alert-settings):
// these two were the only ones that missed the pattern, which CodeQL's
// js/missing-rate-limiting flagged the first time the scan ran here.
const chimeConsoleReadRateLimit = makeRateLimiter(120, 60_000);
app.get(
  '/api/chimes',
  { preHandler: chimeConsoleReadRateLimit },
  async () => ({ ok: true, ...chimeConsoleResponse() }),
);
app.get(
  '/api/chime-config',
  { preHandler: chimeConsoleReadRateLimit },
  async () => ({ ok: true, ...chimeConsoleResponse() }),
);

// Upload a tone — raw WAV bytes in the body, display name in ?name=. chimeStore
// validates the RIFF/WAVE header, normalizes to 22050/16/mono, and stores it
// under a content-addressed id (no client filename ever touches a path).
app.post<{ Querystring: { name?: string } }>(
  '/api/chimes',
  { preHandler: [requireWriteAuth, chimeWriteRateLimit] },
  async (req, reply) => {
    const buf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      reply.code(400);
      return { ok: false, error: 'expected a WAV file body (set Content-Type: audio/wav)' };
    }
    const name = typeof req.query.name === 'string' ? req.query.name : 'tone.wav';
    const res = saveChime(buf, name);
    if (!res.ok) {
      reply.code(400);
      return { ok: false, error: res.error };
    }
    appendWriteLog({
      ts: Date.now(),
      action: 'chime-upload',
      sn: '',
      params: { id: res.meta!.id, name: res.meta!.originalName, bytes: res.meta!.sizeBytes, durationMs: res.meta!.durationMs },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return { ok: true, chime: res.meta, ...chimeConsoleResponse() };
  },
);

// Delete a tone — reverts any level currently assigned to it back to built-in
// (an assignment can never dangle at a missing file).
app.delete<{ Params: { id: string } }>(
  '/api/chimes/:id',
  { preHandler: [requireWriteAuth, chimeWriteRateLimit] },
  async (req, reply) => {
    const id = req.params.id;
    const revertedAssignments = revertAssignmentsFor(id);
    const removed = deleteChime(id);
    if (!removed) {
      reply.code(404);
      return { ok: false, error: 'tone not found' };
    }
    appendWriteLog({
      ts: Date.now(),
      action: 'chime-delete',
      sn: '',
      params: { id, revertedAssignments },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return { ok: true, ...chimeConsoleResponse() };
  },
);

// Assign tones per level. Rejects ids that don't exist (keeps prior value).
app.put<{ Body: { assignments?: Partial<Record<AnnouncementLevel, ChimeAssignment>> } }>(
  '/api/chime-config',
  { preHandler: [requireWriteAuth, chimeWriteRateLimit] },
  async (req, reply) => {
    const patch = req.body?.assignments ?? {};
    const { rejected } = updateChimeConfig(patch, 'web');
    appendWriteLog({
      ts: Date.now(),
      action: 'chime-config',
      sn: '',
      params: { assignments: getChimeConfig().assignments, rejected },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: rejected.length ? 'failure' : 'success',
      message: rejected.length ? rejected.join('; ') : undefined,
    });
    if (rejected.length) reply.code(422);
    return { ok: rejected.length === 0, rejected, ...chimeConsoleResponse() };
  },
);

// v0.9.70 — removed endpoints that pre-dated the Wyoming-direct rewrite:
//   - /api/broadcast/tts-services (engine picker + sample messages)
//     was the v0.9.29 multi-engine picker UI. v0.9.70 only uses Wyoming.
//   - /api/broadcast/tts-debug (raw service catalog dump) was the
//     v0.9.32 "why doesn't Piper appear" diagnostic. Wyoming-direct
//     bypasses HA's TTS service catalog entirely.
//   - /api/broadcast/test-tts (engine + target isolation) was the
//     v0.9.35 surgical test for which engine 500s. The full-pipeline
//     /api/broadcast/test covers this now since there's only one path.
// The /api/broadcast/setup-piper + /api/broadcast/reset-piper endpoints
// stay — they're still useful for first-time Wyoming integration setup
// even though the broadcast path no longer routes through HA's TTS layer.

/**
 * v0.9.33 — List installed Supervisor add-ons. Requires `hassio_api: true`
 * + role `manager` (added in v0.9.33). Used to verify the Piper add-on
 * is actually running before we attempt to bridge it via Wyoming Protocol.
 */
/**
 * v1.107.0 — DB snapshot for external viewers (sqlite-web et al).
 *
 * `/data/ecoflow.db` is private to this add-on, so no viewer can open it. POST
 * here to publish a transactionally consistent copy to a `/share` path any
 * add-on can read; GET reports where that copy is and how fresh it is without
 * producing a new one.
 *
 * Gated + rate-limited because it is a filesystem-touching write that costs
 * real disk I/O — same treatment as the chime write routes.
 */
/**
 * v1.108.0 — the defective-pack latch registry (see defectivePackLatch.ts).
 * GET lists latched confirmations; POST clear removes one (operator false-
 * positive path). The latch otherwise retires on its own 48 h after the pack
 * leaves the fleet.
 */
/**
 * v1.114.0 — OWNER RESERVE FLOOR. The panel could raise `backupReserveSoc` for
 * night-charge arbitrage but there was no way to set the owner floor itself through
 * it, so a buffer change meant the vendor app and a settings-drift line after
 * the fact. Same audited helper the nightly actuator uses (clamped, readback is
 * observed on the next poll, written to the write log).
 *
 * ★ REFUSED WHILE A NIGHT-CHARGE WRITE IS IN FLIGHT. The actuator captured
 * `priorReservePct` at apply time and restores exactly that at window close;
 * changing the floor underneath it would make the revert restore the OLD floor
 * hours later, silently undoing the owner's change. Wait for the revert (~05:00; v1.187.0)
 * or cancel the night via /api/night-charge/cancel.
 */
app.post<{ Querystring: { pct?: string } }>(
  '/api/reserve-floor',
  { preHandler: [requireWriteAuth, latchWriteRateLimit] },
  async (req, reply) => {
    const raw = Number(req.query.pct);
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      reply.code(400); return { ok: false, error: 'pct must be an integer' };
    }
    const targetPct = clampReserveTarget(raw);
    if (targetPct !== raw) {
      reply.code(400);
      return {
        ok: false,
        error: `pct ${raw} outside the supported [${RESERVE_WRITE_MIN_PCT},${RESERVE_WRITE_MAX_PCT}] reserve envelope`,
      };
    }
    if (isReserveArbitrageRaised(nightActuationMem)) {
      // The active night's restore time, named: the window close, or an hour before on-peak if that
      // is sooner (revertDueMs) — immediately on a cancel.
      const restore = reserveRestoreNote(nightActuationMem, Date.now(), fmtDeadlineSpoken);
      reply.code(409);
      return {
        ok: false,
        error: `a night-charge write is currently holding the reserve up; ${restore.text}`,
        priorReservePct: nightActuationMem.priorReservePct,
        restoreAtMs: restore.atMs,
        hint: 'retry after the scheduled revert, or POST /api/night-charge/cancel first',
      };
    }
    const floorBlocked = multiPanelWriteBlock();
    if (floorBlocked) { reply.code(409); return { ok: false, error: floorBlocked }; }
    const shp2 = findShp2(store.get().devices);
    if (!shp2) { reply.code(503); return { ok: false, error: 'SHP2 not present in the snapshot' }; }
    const before = (shp2.projection as any)?.backupReserveSoc ?? null;
    const r = await setBackupReserveSoc({ sn: shp2.sn, targetPct, source: { ua: 'owner-reserve-floor' } });
    if (r.outcome !== 'success') {
      reply.code(502);
      return { ok: false, error: r.message ?? r.code ?? 'write failed', rateLimited: r.rateLimited === true };
    }
    ownerFloorWrite = { pct: targetPct, atMs: Date.now() };
    setOwnerReserveFloorPct(ownerReserveFloorPct(nightActuationMem, targetPct, Date.now()));
    analytics.pushOwnerFloor(ownerReserveFloorPct(nightActuationMem, targetPct, Date.now()));
    app.log.warn(
      `reserve-floor: OWNER set backupReserveSoc ${before ?? '?'}% → ${targetPct}% (this is the floor the reserve alarm defends `
      + `and the night-charge planner sizes against; the nightly write will now restore ${targetPct}% at window close).`,
    );
    return { ok: true, previousPct: before, targetPct, note: 'device readback appears in the next poll (~60s)' };
  },
);

app.get('/api/defective-packs', { preHandler: latchReadRateLimit }, async () => ({ ok: true, packs: listConfirmedRecords() }));
app.post<{ Querystring: { packSn?: string } }>(
  '/api/defective-packs/clear',
  { preHandler: [requireWriteAuth, latchWriteRateLimit] },
  async (req, reply) => {
    const packSn = req.query.packSn;
    if (!packSn) { reply.code(400); return { ok: false, error: 'packSn required' }; }
    const cleared = clearConfirmedPack(packSn);
    app.log.info(`defective-pack latch: operator ${cleared ? 'cleared' : 'tried to clear unknown'} ${packSn}`);
    return { ok: true, cleared };
  },
);

app.get('/api/db-export', { preHandler: latchReadRateLimit }, async () => {
  const existing = describeExistingExport();
  return {
    ok: true,
    ...existing,
    dir: DEFAULT_EXPORT_DIR,
    inProgress: exportInProgress(),
    sourcePath: resolve(process.cwd(), config.dbPath),
  };
});

app.post<{ Querystring: { name?: string } }>(
  '/api/db-export',
  { preHandler: [requireWriteAuth, dbExportRateLimit] },
  async (req, reply) => {
    try {
      const result = await exportDatabase({
        sourcePath: resolve(process.cwd(), config.dbPath),
        name: req.query.name,
        log: (m) => app.log.info(m),
      });
      return { ok: true, ...result, generatedAt: new Date().toISOString() };
    } catch (e: any) {
      app.log.warn(`db-export failed: ${e?.message ?? e}`);
      reply.code(500);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
);

app.get('/api/admin/addons', { preHandler: requireWriteAuth }, async (_req, reply) => {
  const addons = await listAddons();
  if (!addons) {
    reply.code(503);
    return {
      ok: false,
      error: 'Supervisor add-on API unavailable. Add-on may lack hassio_api permission (was added in v0.9.33). After updating, the user must reapprove the add-on permissions in Home Assistant → Settings → Add-ons → Power.',
    };
  }
  return { ok: true, count: addons.length, addons };
});

/**
 * v0.9.33 — Auto-setup the Wyoming Protocol integration for Piper.
 *
 * v0.9.31-32 testing established that installing the Piper add-on isn't
 * enough — HA also needs the Wyoming Protocol integration to bridge to
 * it, which exposes the `tts.piper` entity. Without this, the panel sees
 * only `tts.cloud_say` and the spoken alert depends entirely on Nabu
 * Casa uptime (which 500'd twice during testing).
 *
 * This endpoint:
 *   1. Checks if a Wyoming config-entry already exists for this host+port.
 *   2. If yes → returns "already configured".
 *   3. If no → kicks off the Core config flow, submits host+port form data,
 *      and reports the result.
 *
 * Defaults to host=`core-piper`, port=10200 — the add-on's standard
 * Wyoming exposure. Override via query params for non-standard setups.
 */
/**
 * v0.9.43 — Wipe + re-add the Wyoming Protocol integration.
 *
 * v0.9.41 diagnosed the operator's tts.piper entity as empty (no voice metadata
 * pulled from Piper) — the Wyoming integration was likely added BEFORE
 * he configured a voice in the Piper add-on, and it cached the empty
 * state. tts.speak then 500s because HA has no voice to render with.
 *
 * This endpoint:
 *   1. Lists all wyoming config-entries
 *   2. Deletes any whose data.host matches the Piper add-on hostname
 *   3. Re-runs the v0.9.33 setup-piper flow to re-add cleanly
 *
 * After this, the Wyoming integration will re-pull Piper's voice list
 * on connect — assuming the operator has saved a voice in Piper add-on config.
 */
app.post<{ Querystring: { host?: string; port?: string } }>(
  '/api/broadcast/reset-piper',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    const host = req.query.host ?? 'core-piper';
    const port = Number(req.query.port ?? 10200);
    const existing = await listConfigEntries('wyoming');
    if (!existing) {
      reply.code(503);
      return { ok: false, error: 'Could not list Wyoming config entries (hassio_api access?)' };
    }
    const matching = existing.filter((e) => {
      const data = e.data as Record<string, unknown> | undefined;
      return data && data.host === host && (port === 0 || Number(data.port) === port);
    });
    const deleted: Array<{ entry_id: string; ok: boolean; error?: string }> = [];
    for (const entry of matching) {
      const entryId = String((entry as Record<string, unknown>).entry_id ?? '');
      if (!entryId) continue;
      const d = await deleteConfigEntry(entryId);
      deleted.push({ entry_id: entryId, ok: d.ok, error: d.error });
    }
    // Now re-add via the v0.9.33 setup flow.
    const startRes = await startConfigFlow('wyoming');
    if (!startRes.ok) {
      reply.code(502);
      return { ok: false, deleted, error: `re-add flow failed: ${startRes.error ?? startRes.status}`, body: startRes.body };
    }
    const flow = startRes.body as { flow_id?: string; type?: string };
    if (!flow.flow_id || flow.type === 'create_entry') {
      return { ok: true, deleted, recreated: flow };
    }
    const submitRes = await submitConfigFlow(flow.flow_id, { host, port });
    if (!submitRes.ok) {
      reply.code(502);
      return { ok: false, deleted, error: `submit failed: ${submitRes.error ?? submitRes.status}`, body: submitRes.body };
    }
    return {
      ok: true,
      deleted,
      recreated: submitRes.body,
      message: `Removed ${deleted.length} stale Wyoming entry/entries and re-added for ${host}:${port}. Wait a few sec, then check /api/broadcast/tts-debug — tts.piper should now have voice attrs.`,
    };
  },
);

app.post<{ Querystring: { host?: string; port?: string } }>(
  '/api/broadcast/setup-piper',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    const host = req.query.host ?? 'core-piper';
    const port = Number(req.query.port ?? 10200);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      reply.code(400);
      return { ok: false, error: `invalid port: ${req.query.port}` };
    }

    // 1. Check for an existing Wyoming entry that already matches.
    const existing = await listConfigEntries('wyoming');
    if (existing) {
      const match = existing.find((e) => {
        const data = e.data as Record<string, unknown> | undefined;
        return data && data.host === host && Number(data.port) === port;
      });
      if (match) {
        return {
          ok: true,
          alreadyConfigured: true,
          entry: match,
          message: `Wyoming integration for ${host}:${port} already exists. Restart the add-on to refresh TTS detection.`,
        };
      }
    }

    // 2. Start the config flow for `wyoming`.
    const startRes = await startConfigFlow('wyoming');
    if (!startRes.ok) {
      reply.code(startRes.status >= 400 ? startRes.status : 502);
      return {
        ok: false,
        error: `Could not start Wyoming config flow: HTTP ${startRes.status} ${startRes.error ?? ''}. If status is 403, the add-on may lack hassio_api permission — reapprove the add-on permissions in Home Assistant → Settings → Add-ons → Power.`,
        body: startRes.body,
      };
    }
    const flow = startRes.body as { flow_id?: string; type?: string; errors?: unknown };
    if (!flow.flow_id) {
      reply.code(502);
      return { ok: false, error: 'config flow response missing flow_id', body: flow };
    }
    if (flow.type === 'create_entry') {
      // Single-step flow auto-completed.
      return { ok: true, autoCompleted: true, entry: flow };
    }

    // 3. Submit step 1 (host + port).
    const submitRes = await submitConfigFlow(flow.flow_id, { host, port });
    if (!submitRes.ok) {
      reply.code(submitRes.status >= 400 ? submitRes.status : 502);
      return {
        ok: false,
        error: `Wyoming flow submission failed: HTTP ${submitRes.status} ${submitRes.error ?? ''}`,
        body: submitRes.body,
      };
    }
    const final = submitRes.body as { type?: string; title?: string; errors?: unknown };
    if (final.type === 'create_entry') {
      return {
        ok: true,
        created: true,
        title: final.title,
        message: 'Wyoming integration added. The tts.piper entity should appear within a few seconds. Re-test the broadcast to see Piper in the engine list.',
      };
    }
    // Flow returned another step (unusual for Wyoming) — return the form
    // so the caller can complete it.
    return {
      ok: false,
      requiresMoreSteps: true,
      flow_id: flow.flow_id,
      step: final,
      message: 'Wyoming config flow returned another step. Check Home Assistant logs.',
    };
  },
);

/**
 * v0.9.19 — discover every media_player entity HA knows about so the
 * user can pick targets from a real list instead of guessing entity IDs.
 * We use the manufacturer + model hints HA exposes to label HomePods vs
 * Sonos vs Apple TV vs generic Cast vs Echo, so the user sees what each
 * speaker actually is.
 *
 * Returns:
 *   {
 *     supervised: boolean,
 *     count: number,
 *     speakers: [
 *       { entity_id, friendly_name, family: 'sonos'|'homepod'|'cast'|'echo'|'androidtv'|'apple_tv'|'unknown',
 *         state, volume_level, source, currently_configured: boolean }
 *     ]
 *   }
 */
app.get('/api/broadcast/discover', { preHandler: requireWriteAuth }, async (_req, reply) => {
  const cfg = broadcast.config();
  const status = broadcast.status();
  const all = await getAllStates();
  if (!all) {
    reply.code(503);
    return { supervised: false, count: 0, speakers: [], error: 'SUPERVISOR_TOKEN missing or HA unreachable' };
  }
  const configured = new Set(cfg.targets);
  const speakers = all
    .filter((s) => s.entity_id.startsWith('media_player.'))
    .map((s) => {
      const a = s.attributes ?? {};
      const friendly = String(a.friendly_name ?? s.entity_id.replace(/^media_player\./, ''));
      const family = familyOf(s.entity_id, a);
      return {
        entity_id: s.entity_id,
        friendly_name: friendly,
        family,
        state: s.state,
        volume_level: typeof a.volume_level === 'number' ? a.volume_level : null,
        source: typeof a.source === 'string' ? a.source : null,
        currently_configured: configured.has(s.entity_id),
      };
    })
    .sort((a, b) => {
      // Configured first, then group by family, then alphabetical.
      if (a.currently_configured !== b.currently_configured) {
        return a.currently_configured ? -1 : 1;
      }
      if (a.family !== b.family) return a.family.localeCompare(b.family);
      return a.friendly_name.localeCompare(b.friendly_name);
    });
  return {
    supervised: true,
    count: speakers.length,
    speakers,
    // v0.9.70 — speakerGroups + ttsEngine dropped (no more protocol
    // bucketing, no more multi-engine picker — Wyoming is the path).
    musicAssistantAvailable: status.musicAssistantAvailable,
    wyomingReachable: status.wyomingReachable,
  };
});

/** Infer the speaker family from the entity_id + attributes — drives the
 * type column + decides which broadcast helpers (sonos.snapshot etc.) apply. */
function familyOf(entityId: string, attrs: Record<string, unknown>): string {
  const id = entityId.toLowerCase();
  const platform = String(attrs.platform ?? '').toLowerCase();
  const sourceList = Array.isArray(attrs.source_list) ? attrs.source_list.join(' ').toLowerCase() : '';
  const dt = String((attrs as any).device_class ?? '').toLowerCase();
  if (id.includes('sonos') || platform === 'sonos' || sourceList.includes('sonos')) return 'sonos';
  if (id.includes('homepod') || platform === 'homepod' || /homepod/i.test(String((attrs as any).model ?? ''))) return 'homepod';
  if (platform === 'apple_tv' || id.includes('apple_tv')) return 'apple_tv';
  if (platform === 'cast' || id.includes('chromecast') || id.includes('cast') || dt === 'speaker') return 'cast';
  if (platform === 'alexa_media' || id.includes('echo') || id.includes('alexa')) return 'echo';
  if (platform === 'androidtv' || id.includes('android_tv') || id.includes('androidtv')) return 'androidtv';
  return 'unknown';
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`EcoFlow panel API listening on http://${config.host}:${config.port}`);
// v1.130.0 — SAY WHICH BUILD THIS IS. The banner predates the release cadence and
// never carried a version, so after 13 releases and 15 restarts on 2026-09-04 no
// line in the add-on's own log could say which build produced any given behaviour.
// The 09-04 audit had to date the v1.124.x cutover indirectly, by inferring it from
// an HA Core schema-validation error. A log that cannot identify its own build
// cannot answer "did that fix take?" — the central question after any deploy.
app.log.info(
  `ecoflow-panel v${process.env.BUILD_VERSION || 'dev'}`
  + `${process.env.BUILD_REF ? ` (ref ${String(process.env.BUILD_REF).slice(0, 7)})` : ''}`
  + `${process.env.BUILD_DATE ? ` built ${process.env.BUILD_DATE}` : ''}`
  + ` — node ${process.version}, pid ${process.pid}`,
);
// v1.191.0 (lane A, plan 2.4) — the site zone, resolved once when siteTime.ts loaded (SITE_TIMEZONE →
// the container's TZ → the default), named with its source, then any configured value that did not
// resolve. Main thread only (CA17). Home Assistant's own zone is compared in the background; a
// difference warns and raises a repair issue, and the zone is never switched after boot.
{
  const st = siteTimeBootLines();
  app.log.info(st.info);
  for (const w of st.warnings) app.log.warn(`site time: ${w}`);
  void checkHaTimeZone((m) => app.log.warn(`site time: ${m}`));
}
// v1.191.0 (S5) — the tariff in effect, named once at boot (main thread only, CA17). An unusable spec
// is an error line: every price is null and the night charge holds; the R-EV table is NOT used instead.
{
  const t = resolveTariffFromEnv();
  if (t.error != null) {
    app.log.error(`tariff: ${t.error} — every price reads unknown and no night-charge window is planned; the built-in APS R-EV table is not used in its place (repair issue tariff-spec-invalid)`);
  } else {
    app.log.info(`tariff: plan ${t.model.planId}${t.planSet ? '' : ' (TARIFF_PLAN unset: the built-in APS R-EV preset)'}, rates ${t.model.ratesConfirmed ? 'confirmed' : 'unconfirmed'} (${t.confirmationKey}), currency ${tariffCurrency().code}`);
  }
  const currency = tariffCurrency();
  if (currency.error != null) app.log.warn(`tariff: ${currency.error}`);
  // v1.191.0 (S6) — the night-charge schedule another plan derives from its cheap window (silent on the
  // APS preset, whose schedule is unchanged); a warning when the notify hour had to be clamped.
  const sched = nightScheduleNow(t.model);
  const schedLine = nightScheduleLogLine(sched);
  if (schedLine != null) {
    if (sched.notify.clampedFrom != null && sched.source === 'derived') app.log.warn(`${schedLine} (repair issue night-charge-notify-after-window)`);
    else app.log.info(schedLine);
  }
  // CA20's tariff half (the site zone is not the reference zone while TARIFF_PLAN is unset) is part of
  // the one reference-home-defaults notice and repair issue, which siteBootNotices raises below.
}

// v1.191.0 — the site notices (site.ts). The ones that need nothing from Home Assistant run now
// (CA20's reference-home defaults, PV_STRINGS); Home Assistant's home location is read in the
// background a little after boot, never awaited, and only ever raises a notice and a repair item
// or saves the location for the next start (OWNER DECISION 5; the coordinates never change in-run).
const siteLog = { info: (m: string) => app.log.info(m), warn: (m: string) => app.log.warn(m) };
siteBootNotices(siteLog, { rosterSize: lastKnownRoster.size });
const siteLocationCheck = setTimeout(() => {
  checkHaHomeLocation({ log: siteLog }).catch((e: unknown) => app.log.debug(`site: Home Assistant location read failed: ${(e as Error)?.message ?? e}`));
}, 30_000);
siteLocationCheck.unref?.();

// v1.152.0 — the v1.151.0 boot pre-warm was REMOVED, not repaired.
//
// It fired `analytics.report('equipmentHealth')` immediately after `listen`, and
// a log audit measured it completing in 578 ms and 694 ms on two boots — against
// its own comment claiming a 9,007 ms cold scan. It was inert: the request is
// posted before the store's first 'change' event, so the worker still held its
// initial `devices: {}` (analyticsWorker.ts), `allDpus({})` returned [], both
// loops were skipped, and `if (dpus.length > 0)` declined to cache. It warmed
// nothing, cached nothing, and logged "equipment-health pre-warmed" anyway.
//
// That is a false-success line in the audit log — the exact defect class this
// codebase keeps finding, shipped by the release that was fixing one.
//
// It is deleted rather than gated because the machinery ALREADY EXISTED and was
// not checked for: `equipmentHealth` is in WARM_REPORTS (reports.ts) and the
// worker's own `firstWarm` (analyticsWorker.ts) polls every 500 ms and warms as
// soon as `hasDevices()` is true — correctly gated on a non-empty snapshot,
// which is precisely what the pre-warm got wrong. Re-adding a second warmer
// here would duplicate it and reintroduce the race.

// v0.60.0 — survive a transient DNS/network bounce (the daily CoreDNS/AppArmor
// maintenance window crashed the add-on with exit 255) but re-raise a genuinely
// fatal uncaught error. Covers the POST-BOOT steady-state runtime (where a transient
// DNS error can leak out of the MQTT client's reconnect path as an unhandled
// rejection); boot-time DNS transients are already handled by the cert-fetch retry
// (getMqttCertificationWithRetry), and a genuine boot-time crash is correctly fatal.
installProcessGuards({
  error: (m) => app.log.error(m),
  fatal: (m) => app.log.fatal(m),
});

const shutdown = async () => {
  app.log.info('shutting down');
  stopPoll();
  clearInterval(ghiPersistTick);
  clearTimeout(siteLocationCheck);
  clearInterval(restTrackerTick);
  stopMqtt?.();
  monitor.stop();
  socLadders.stop();
  stopSsh?.();
  stopTuiData(); // shared TUI refresh timers (SSH + /console)
  stopMqttDiscovery?.();
  analytics.stop();
  broadcast.stop();
  backupWindow.stop();
  recorder.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
