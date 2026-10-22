import { memo, useEffect, useState } from 'react';
import {
  actuationBannerState, actuationBannerVisible, actuationKey, cancelOutcome, cancelRequestInit, chargeFigureParts, floorCushionLinePct, fmtLinePct,
  holdSummary, noChargeExpected, noPlanText, refusedArmLead, reserveWriteLabel, sizingLine, withConfirmedCancel, writeStands,
  writtenReservePct, middayShadowView, type MiddayShadowStatus, type MiddayShadowPreviewStatus,
} from './nightChargeText';
import { apiUrl } from '../api';
import { fmtHHMMIn } from '../siteTime';

/**
 * Tonight's night-charge advisory — should the home buy grid energy in the
 * cheap overnight window to hold the outage cushion above the reserve floor and
 * skip the 4–7pm peak? (design docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md §4.3.)
 *
 * ★ ADVISORY / READ-ONLY. This card renders a recommendation; it never writes
 *   the device and is strictly subordinate to the floor/runway/SoC alarm spine.
 *   It fails SAFE: a null/incomplete/stale plan renders the grey "unavailable"
 *   shape (cloned from RunwayCard), NEVER a fabricated number, and
 *   `charge_tonight` is only ever surfaced as a recommendation to gate an HA
 *   automation on — never an instruction to charge NOW.
 *
 * Zero-prop, self-fetching on a 60 s poll (memo makes it immune to the App's
 * ~1 Hz snapshot re-renders), exactly like RunwayCard.
 */

// ── Local shapes (mirrors of the server types; the /api/night-charge/status
// contract, §4.4). Kept local so this card owns no cross-file type coupling. ──
interface NightChargePlan {
  generatedAt: number;
  basisComplete: boolean;
  objective: string;
  chargeTonight: boolean;
  /** The worst case the plan is SIZED on (islanded, P10 PV / P90 load). */
  buyKwh: number | null;
  /** The worst case × the realized-buy calibration, and that factor (1 = uncalibrated). */
  buyKwhDebiased?: number | null;
  buyDebiasFactor?: number;
  /** v1.187.22 — what the armed write is expected to draw; absent on older plans. */
  expectedBuyKwh?: number | null;
  /** v1.187.22 — the level that write drives the pool to; absent on older plans. */
  expectedWriteLevelPct?: number | null;
  /** v1.187.22 — the window closes before that level is reached ("toward"). */
  expectedDeliverableBound?: boolean;
  /** v1.187.22 — force-charge rides the night: its expected start; null = none expected (the night
   *  stops at the reserve). Absent otherwise and on older plans. */
  expectedForceChargeStartMs?: number | null;
  /** The arrival projected on the islanded worst case the plan is sized on (v1.187.22: shown
   *  as "Worst-case arrival", never as the expected outcome). */
  targetSocPct: number | null;
  /** v1.60.0 — the WRITE SETPOINT (the resilience requirement). Higher than
   *  `targetSocPct` exactly when a cap prevents delivering the requirement; the
   *  card shows both in that case so the ask is never read as a forecast. */
  setpointSocPct: number | null;
  requiredExtraKwh: number | null;
  bindingCap: 'requirement' | 'chargePower' | 'evContention' | 'poolHeadroom' | 'overBuy' | null;
  cushionShortfall: boolean;
  /** v1.60.0 — EV-contention disclosure. `basis: 'unavailable'` means no EVSE
   *  prediction covered the window, so contention was NOT modelled — it is not
   *  a prediction of zero, and the card must not render it as reassurance. */
  evContention: {
    basis: 'predicted' | 'unavailable';
    windowEvKwh: number | null;
    peakEvKw: number | null;
    minChargeRateKw: number | null;
    derateKwh: number | null;
  } | null;
  minProjSocPct: number | null;
  minProjSocTsMs: number | null;
  baselineMinSocPct: number | null;
  /** v1.186.0 — the trough the cushion test judged and its line, and the cushion basis. */
  cushionTroughSocPct?: number | null;
  cushionLineSocPct?: number | null;
  cushionBasis?: string | null;
  confidenceTier: 'forecast' | 'mixed' | 'climatology';
  window: { startMs: number; endMs: number } | null;
  reserveFloorPct: number;
  cushionPct: number;
  rationale: string;
}

interface NightChargeReadiness {
  state: 'LEARNING' | 'READY_TO_CONSIDER_WRITES' | 'BLOCKED';
  writeReady: boolean;
  blocking: string[];
  scoredDays: number;
  effectiveN: number;
}

interface NightActuation {
  day: string | null;
  targetPct: number | null;
  buyKwh: number | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
  cancelled: boolean;
  appliedAtMs: number | null;
  priorReservePct: number | null;
  revertedAtMs: number | null;
  revertAttempts: number;
  lastError: string | null;
  cancelDeadlineMs: number | null;
  revertVerifiedAtMs?: number | null;
  revertRetries?: number;
  revertReadbackEscalated?: boolean;
  /** v1.189.0 — the charge cycle's leg this record is (absent from an older server: the cost leg). */
  leg?: 'cost' | 'backup';
  /** v1.189.0 — the reserve settled as someone else's (the foreign rule): nothing left to cancel. */
  foreignSettledAtMs?: number | null;
  foreignReservePct?: number | null;
}

interface NightChargeStatus {
  /** v1.182.0 — the panel's reserve maximum (RESERVE_WRITE_MAX_PCT). */
  reserveWriteMaxPct?: number;
  enabled: boolean;
  mode: 'advisory' | 'supervised' | 'auto';
  window: { startMs: number; endMs: number } | null;
  reserveFloorPercent: number | null;
  confidence: string | null;
  notify: { hour: number; minute: number; lastNotifyDay: string | null } | null;
  plan: NightChargePlan | null;
  /** v1.187.22 — why a supervised/auto mode refused to arm this plan's window (servedArmRefusal);
   *  null/absent = not refused (or an older server). */
  armRefusal?: string | null;
  readiness: NightChargeReadiness | null;
  actuation?: NightActuation | null;
  /** v1.189.0 (R4) — the winter mid-day cycle computed in shadow; null/absent with none current. */
  middayShadow?: MiddayShadowStatus | null;
  /** v1.189.0 (R5) — what its evening notice would have said (never sent); null/absent with none. */
  middayShadowPreview?: MiddayShadowPreviewStatus | null;
  recentOutcomes?: unknown;
  /** v1.191.0 (T16) — the site zone the server computed the plan in (siteTime.ts); the card's clock
   *  times are written in it, never the browser's zone. Absent from an older server: no time shown. */
  siteTimeZone?: string;
}

/** 12 h staleness horizon — matches the server's nightChargeStateFields guard so
 *  the web card and the HA entities never disagree about "is tonight's plan
 *  still live". */
const STALE_MS = 12 * 60 * 60 * 1000;

/** v1.189.0 — a status request that has not answered by now is a failure: the card leaves
 *  "Loading…" for the unavailable shape, which still carries a Cancel (StatusBlindCancel). A hung
 *  request would otherwise hold the card on "Loading…", with no Cancel, indefinitely. */
const STATUS_TIMEOUT_MS = 15_000;

/** HH:MM for the charge window in the site zone the payload names (never the browser's clock).
 *  v1.191.0 (T16) — it was pinned to the reference install's zone. */
type ClockFmt = (ms: number | null | undefined) => string | null;
const siteHHMM = (zone: string | null | undefined): ClockFmt => (ms) => fmtHHMMIn(ms, zone);

const READINESS_LABEL: Record<NightChargeReadiness['state'], string> = {
  LEARNING: 'learning',
  READY_TO_CONSIDER_WRITES: 'ready to consider writes',
  BLOCKED: 'blocked',
};

/** Human labels for the plan's binding cap. `Record<…>` over the union so a new
 *  server-side cap cannot be added without a label landing here; the render
 *  still falls back to the raw key, so an OLDER card served a NEWER server
 *  shows `cap: evContention` rather than a blank or `undefined`. */
const BINDING_CAP_LABEL: Record<NonNullable<NightChargePlan['bindingCap']>, string> = {
  requirement: 'resilience requirement',
  chargePower: 'charge power',
  evContention: 'EV sharing the grid input',
  poolHeadroom: 'pool headroom',
  overBuy: 'morning-PV clip accepted',
};

export const NightChargeCard = memo(function NightChargeCard() {
  const [status, setStatus] = useState<NightChargeStatus | null>(null);
  const [err, setErr] = useState(false);
  // v1.189.0 — the write a Cancel was confirmed for (actuationKey), until the status poll carries it.
  const [cancelledKey, setCancelledKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const ctl = new AbortController();
      const timer = window.setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
      try {
        const r = await fetch(apiUrl('api/night-charge/status'), { signal: ctl.signal });
        if (!live) return;
        if (r.ok) {
          setStatus(await r.json());
          setErr(false);
        } else {
          setErr(true);
        }
      } catch {
        if (live) setErr(true);
      } finally {
        window.clearTimeout(timer);
      }
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  // ★ v1.189.0 — every shape below carries the owner's Cancel: the banner wherever the status is
  // known (it renders nothing unless a write is armed or applied, or has just settled), and a
  // status-blind Cancel where it is not. A recompute that holds, an incomplete basis or a stale
  // plan does not disarm the write the evening job armed (writeStands), so none of them may hide
  // its Cancel.
  if (!status) {
    return (
      <div className="card text-sm">
        <div className="text-muted">
          {err ? 'Night-charge advisory unavailable — see add-on log.' : 'Loading night-charge advisory…'}
        </div>
        {err && <StatusBlindCancel />}
      </div>
    );
  }

  // v1.189.0 — a confirmed cancel shows at once, for the write it was made on only (a poll that
  // left before it cannot undo it, and the next night's write keeps its Cancel); the 60 s poll
  // converges the rest.
  const hhmm = siteHHMM(status.siteTimeZone);
  const actuation = withConfirmedCancel(status.actuation ?? null, cancelledKey);
  const onCancelled = () => setCancelledKey(actuationKey(actuation));
  const banner = (spacing: 'mt-3' | 'mb-3') => (
    <ActuationBanner mode={status.mode} actuation={actuation} onCancelled={onCancelled} spacing={spacing} hhmm={hhmm} />
  );
  const stands = writeStands(actuation, status.mode, Date.now());

  const plan = status.plan;
  // Fail-safe: null / incomplete / stale plan → the grey "unavailable" shape,
  // never a fabricated number.
  const fresh =
    plan != null &&
    plan.basisComplete &&
    Number.isFinite(plan.generatedAt) &&
    Date.now() - plan.generatedAt < STALE_MS;

  if (!plan || !fresh) {
    return (
      <div className="card text-sm">
        <div className="card-title">Night-charge plan</div>
        <div className={stands ? 'text-warn' : 'text-muted'}>{noPlanText(plan != null && !plan.basisComplete, stands)}</div>
        {banner('mt-3')}
        <MiddayShadowSection shadow={status.middayShadow} preview={status.middayShadowPreview} hhmm={hhmm} />
      </div>
    );
  }

  const readiness = status.readiness;
  // v1.187.22 — the line the plan is sized on (floorCushionLinePct), the push's and the hold's.
  const floorCushionLine = fmtLinePct(floorCushionLinePct(plan));
  const readinessNote = readiness ? (
    <span className="text-xs text-muted normal-case tracking-normal">
      readiness: {READINESS_LABEL[readiness.state] ?? readiness.state}
    </span>
  ) : null;

  // HOLD — the plan charges nothing tonight (v1.189.0: a write the evening job armed from the
  // announced plan still stands — writeStands — and is said so). v1.187.22 — which hold, on the figure it was decided on
  // (holdSummary, the evening push's hold shape): the islanded trough labelled as such, and a
  // window that cannot cover the cushion said so rather than "No overnight charge needed."
  if (!plan.chargeTonight) {
    const hold = holdSummary(plan, { writeStands: stands });
    return (
      <div className="card text-sm">
        <div className="card-title flex items-center justify-between">
          <span>Night-charge plan</span>
          {readinessNote}
        </div>
        <div className={`${hold.tone === 'warn' ? 'text-warn' : hold.tone === 'ok' ? 'text-ok' : 'text-muted'} font-medium`}>{hold.headline}</div>
        <div className="text-muted mt-1 leading-relaxed">{hold.detail}</div>
        {banner('mt-3')}
        <AdvisoryNote mode={status.mode} />
        <MiddayShadowSection shadow={status.middayShadow} preview={status.middayShadowPreview} hhmm={hhmm} />
      </div>
    );
  }

  // CHARGE — surface buy, target SoC, baseline→plan trough, window, confidence.
  const ws = hhmm(plan.window?.startMs);
  const we = hhmm(plan.window?.endMs);
  // v1.187.22 — the headline is the charge the write arms (the expected draw and the level it
  // drives to); the worst case appears once, in the labelled sizing line beneath.
  const fig = chargeFigureParts(plan, status.reserveWriteMaxPct ?? null);
  const sizing = sizingLine(plan);
  // v1.187.22 — a night expected to charge nothing: the reserve is held as a floor.
  const noChargeNight = noChargeExpected(plan);
  // v1.187.22 — a write mode refused to arm tonight: lead with that, never the plan's expected charge
  // — in the words for the night the plan is (a charge, or the reserve held).
  const refused = status.mode !== 'advisory' && status.armRefusal
    ? refusedArmLead(status.armRefusal, { mode: status.mode, held: noChargeNight, reservePct: writtenReservePct(plan, status.reserveWriteMaxPct ?? null) })
    : null;

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Night-charge plan</span>
        {readinessNote}
      </div>

      {refused ? (
        <div className="mb-3 text-sm">
          <div className="text-warn font-medium">{refused.headline}</div>
          <div className="text-muted mt-1 leading-relaxed">{refused.detail}</div>
        </div>
      ) : (
        <div className="flex items-baseline gap-4 mb-3 flex-wrap">
          <div className="text-4xl font-bold tabular-nums text-ink">
            {fig.main}
            <span className={`text-2xl font-semibold${fig.unit === '%' ? '' : ' ml-1'}`}>{fig.unit}</span>
          </div>
          <div className="text-sm text-muted">
            {fig.label}
            {ws && we && (
              <>
                {' '}
                in the <span className="text-ink font-medium">{ws}–{we}</span> window
              </>
            )}
          </div>
        </div>
      )}

      {sizing && <div className="text-xs text-muted mb-3 -mt-2">{sizing}</div>}

      {plan.cushionShortfall && (
        <div className="text-xs text-warn mb-3 -mt-1">
          charge/pool caps prevent fully meeting the cushion — residual risk remains
        </div>
      )}

      {/* v1.60.0 — EV contention. Either the predicted session is quantified, or
          we say plainly that it is UNMODELLED; the absent-prediction line is a
          warning, never a "no EV expected tonight". v1.187.22 — neither on a night
          expected to charge nothing: there is no pack charge for the car to share with. */}
      {!noChargeNight && plan.bindingCap === 'evContention' && plan.evContention?.windowEvKwh != null && (
        <div className="text-xs text-warn mb-3 -mt-1">
          EV charging predicted in the window (~{plan.evContention.windowEvKwh.toFixed(1)} kWh
          {plan.evContention.peakEvKw != null && <>, peak ~{plan.evContention.peakEvKw.toFixed(1)} kW</>}) — it
          shares the grid input
          {plan.evContention.minChargeRateKw != null && <>, leaving ~{plan.evContention.minChargeRateKw.toFixed(1)} kW for the packs</>}
          {plan.evContention.derateKwh != null && plan.evContention.derateKwh > 0 && (
            <> and cutting ~{plan.evContention.derateKwh.toFixed(1)} kWh off the deliverable buy</>
          )}
          .
        </div>
      )}
      {!noChargeNight && plan.evContention?.basis === 'unavailable' && plan.cushionShortfall && (
        <div className="text-xs text-muted mb-3 -mt-1">
          no EVSE prediction covers this window — EV contention is not modelled; if the car charges
          overnight the packs will receive less than planned
        </div>
      )}

      {banner('mb-3')}


      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {/* v1.187.22 — the whole-house island troughs, labelled as such: with the grid present
            the SHP2 holds the reserve, so neither is where the pool is expected to go. */}
        <Stat label="Island low, no charge" value={fmtSoc(plan.baselineMinSocPct)} sub="if the grid were lost · P10 PV / P90 load" />
        <Stat label="Island low, with charge" value={fmtSoc(plan.minProjSocPct)} sub={`if the grid were lost · floor+cushion ${floorCushionLine}`} />
        <Stat
          // v1.187.22 — the arrival on the islanded worst case the plan is sized on, labelled as
          // that basis: under "Expected SoC" it sat beside the headline's expected charge as a
          // second, contradicting outcome (80% next to "expected charge to ~50%").
          label="Worst-case arrival"
          value={fmtSoc(plan.targetSocPct)}
          // v1.60.0 — the reserve we ask the device for is shown alongside it only when the two
          // diverge (a cap prevented delivering the requirement), never as a silent swap.
          sub={
            [
              'sizing basis',
              // v1.182.0 — what will actually be WRITTEN (clamped to the panel's maximum).
              reserveWriteLabel(plan.setpointSocPct, plan.targetSocPct, status.reserveWriteMaxPct ?? null),
              plan.bindingCap ? `cap: ${BINDING_CAP_LABEL[plan.bindingCap] ?? plan.bindingCap}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        />
        <Stat label="Confidence" value={plan.confidenceTier} sub={ws && we ? `${ws}–${we}` : undefined} />
      </div>

      <AdvisoryNote mode={status.mode} />
      <MiddayShadowSection shadow={status.middayShadow} preview={status.middayShadowPreview} hhmm={hhmm} />
    </div>
  );
});

/**
 * v1.50.0 — tonight's supervised-write state + the owner cancel control.
 * Renders nothing in advisory mode or when nothing is armed for tonight. The
 * cancel POST is optimistic-after-confirm: on 2xx the card marks that write
 * cancelled at once (onCancelled; the 60 s status poll converges the full card).
 * v1.189.0 — rendered in every card shape; its words and its Cancel come from
 * actuationBannerState.
 */
function ActuationBanner({ mode, actuation, onCancelled, spacing, hhmm }: {
  mode: NightChargeStatus['mode'];
  /** The site-zone clock formatter (siteHHMM). */
  hhmm: ClockFmt;
  actuation: NightActuation | null;
  onCancelled: () => void;
  /** Its margin in the shape it sits in: above the stats (mb-3), or under the shape's text (mt-3). */
  spacing: 'mt-3' | 'mb-3';
}) {
  const [busy, setBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  if (mode === 'advisory' || !actuation || !actuationBannerVisible(actuation, Date.now())) return null;

  const state = actuationBannerState(actuation, hhmm(actuation.cancelDeadlineMs));
  const doCancel = async () => {
    setBusy(true);
    setCancelErr(null);
    const out = await postCancel(actuation.leg ?? null);
    if (out.ok) onCancelled();
    else setCancelErr(out.text);
    setBusy(false);
  };

  return (
    <div className={`flex items-center justify-between gap-3 bg-panel2 border border-line rounded-md p-2 ${spacing} text-xs`}>
      <span className={state.settled ? 'text-muted' : 'text-warn'}>{state.text}</span>
      <span className="flex items-center gap-2">
        {cancelErr && <span className="text-crit">{cancelErr}</span>}
        {state.cancel && <CancelButton label={state.cancel} busy={busy} onClick={doCancel} />}
      </span>
    </div>
  );
}

/**
 * v1.189.0 — the Cancel for a card that could not read its status (an error, or a request that
 * timed out): what is armed is unknown, so it says so and offers the same POST. The server
 * answers 409 when nothing is armed or the write already reverted (cancelOutcome).
 */
function StatusBlindCancel() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ done: boolean; text: string } | null>(null);
  const doCancel = async () => {
    setBusy(true);
    setOut(await postCancel());
    setBusy(false);
  };
  return (
    <div className="flex items-center justify-between gap-3 bg-panel2 border border-line rounded-md p-2 mt-3 text-xs">
      <span className="text-muted">{out?.text ?? 'What is armed tonight is unknown; a supervised write can still be cancelled.'}</span>
      {!out?.done && <CancelButton label="Cancel tonight" busy={busy} onClick={doCancel} />}
    </div>
  );
}

function CancelButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      className="px-2 py-1 rounded-sm border border-line bg-panel hover:bg-panel2 text-ink disabled:opacity-50"
      disabled={busy}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** v1.50.0 — the owner's cancel (write-auth); v1.189.0 — its answer in the card's words (cancelOutcome),
 *  for the leg named (cancelRequestInit): the banner's own leg; none from the status-blind Cancel,
 *  which the server reads as the cost leg — tonight's, with one leg. */
async function postCancel(leg: 'cost' | 'backup' | null = null): Promise<{ ok: boolean; done: boolean; text: string }> {
  try {
    const r = await fetch(apiUrl('api/night-charge/cancel'), cancelRequestInit(leg));
    let body: unknown = null;
    try { body = await r.json(); } catch { /* not JSON: judged on the status alone */ }
    return cancelOutcome(r.status, body);
  } catch {
    return { ok: false, done: false, text: 'cancel failed — network error' };
  }
}

/**
 * v1.189.0 (R4) — the winter mid-day cycle computed in shadow (middayShadowView): read-only. It has
 * no Cancel and no other control — nothing of it is armed — and renders nothing with no mid-day leg.
 */
function MiddayShadowSection({ shadow, preview, hhmm }: {
  shadow: MiddayShadowStatus | null | undefined;
  preview?: MiddayShadowPreviewStatus | null;
  hhmm: ClockFmt;
}) {
  const view = middayShadowView(shadow, hhmm, preview);
  if (view == null) return null;
  return (
    <div className="mt-3 border-t border-line pt-2 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-muted">{view.title}</div>
      {view.lines.map((line) => (
        <div key={line} className="text-muted mt-0.5 leading-relaxed">{line}</div>
      ))}
      <div className="text-[11px] text-muted mt-1 leading-relaxed">{view.note}</div>
    </div>
  );
}

function AdvisoryNote({ mode }: { mode: NightChargeStatus['mode'] }) {
  if (mode !== 'advisory') {
    return (
      <div className="text-[11px] text-muted mt-3 leading-relaxed">
        {mode === 'auto' ? 'Auto' : 'Supervised'} write mode — on charge nights the add-on performs one
        bounded reserve write (announced each evening, cancellable above) and auto-restores the prior
        reserve after the window. The reserve-floor alarms are independent of this path.
      </div>
    );
  }
  return (
    <div className="text-[11px] text-muted mt-3 leading-relaxed">
      Advisory only — this add-on never charges the battery itself. Wire your own HA automation to the{' '}
      <code className="text-ink">charge_tonight</code> sensor, gated on{' '}
      <code className="text-ink">night_charge_write_ready</code> and the published window.
    </div>
  );
}

function fmtSoc(p: number | null | undefined): string {
  return p == null ? '—' : `${p.toFixed(0)}%`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-panel2 border border-line rounded-md p-2">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-base font-semibold tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
