import { memo, useEffect, useState } from 'react';
import { apiUrl } from '../api';

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
  buyKwh: number | null;
  /** The contention-derated PREDICTION of where the pack lands. */
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
}

interface NightChargeStatus {
  enabled: boolean;
  mode: 'advisory' | 'supervised' | 'auto';
  window: { startMs: number; endMs: number } | null;
  reserveFloorPercent: number | null;
  confidence: string | null;
  notify: { hour: number; minute: number; lastNotifyDay: string | null } | null;
  plan: NightChargePlan | null;
  readiness: NightChargeReadiness | null;
  actuation?: NightActuation | null;
  recentOutcomes?: unknown;
}

/** 12 h staleness horizon — matches the server's nightChargeStateFields guard so
 *  the web card and the HA entities never disagree about "is tonight's plan
 *  still live". */
const STALE_MS = 12 * 60 * 60 * 1000;

/** HH:MM in America/Phoenix (never the host clock) for the charge window. */
const phoenixHHMM = (ms: number | null | undefined): string | null => {
  if (ms == null || !Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Phoenix',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return null;
  }
};

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

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(apiUrl('api/night-charge/status'));
        if (!live) return;
        if (r.ok) {
          setStatus(await r.json());
          setErr(false);
        } else {
          setErr(true);
        }
      } catch {
        if (live) setErr(true);
      }
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  if (!status) {
    return (
      <div className="card text-sm text-muted">
        {err ? 'Night-charge advisory unavailable — see add-on log.' : 'Loading night-charge advisory…'}
      </div>
    );
  }

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
        <div className="card-title">Tonight's night-charge plan</div>
        <div className="text-muted">
          {plan && !plan.basisComplete
            ? 'No plan tonight — forecast/telemetry basis incomplete; nothing will be charged.'
            : 'No night-charge plan available — advisor idle or plan stale.'}
        </div>
      </div>
    );
  }

  const readiness = status.readiness;
  const floorCushionPct = plan.reserveFloorPct + plan.cushionPct;
  const readinessNote = readiness ? (
    <span className="text-xs text-muted normal-case tracking-normal">
      readiness: {READINESS_LABEL[readiness.state] ?? readiness.state}
    </span>
  ) : null;

  // HOLD — basis complete, projected trough already holds floor+cushion.
  if (!plan.chargeTonight) {
    return (
      <div className="card text-sm">
        <div className="card-title flex items-center justify-between">
          <span>Tonight's night-charge plan</span>
          {readinessNote}
        </div>
        <div className="text-ok font-medium">No overnight charge needed.</div>
        <div className="text-muted mt-1 leading-relaxed">
          Projected overnight trough{' '}
          <span className="text-ink font-medium">{fmtSoc(plan.baselineMinSocPct)}</span> stays at/above the{' '}
          {floorCushionPct.toFixed(0)}% floor+cushion — no cheap-window buy required tonight.
        </div>
        <AdvisoryNote mode={status.mode} />
      </div>
    );
  }

  // CHARGE — surface buy, target SoC, baseline→plan trough, window, confidence.
  const ws = phoenixHHMM(plan.window?.startMs);
  const we = phoenixHHMM(plan.window?.endMs);

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Tonight's night-charge plan</span>
        {readinessNote}
      </div>

      <div className="flex items-baseline gap-4 mb-3 flex-wrap">
        <div className="text-4xl font-bold tabular-nums text-ink">
          {plan.buyKwh != null ? plan.buyKwh.toFixed(1) : '—'}
          <span className="text-2xl font-semibold ml-1">kWh</span>
        </div>
        <div className="text-sm text-muted">
          buy overnight → expect <span className="text-ink font-medium">{fmtSoc(plan.targetSocPct)}</span>
          {ws && we && (
            <>
              {' '}
              in the <span className="text-ink font-medium">{ws}–{we}</span> window
            </>
          )}
        </div>
      </div>

      {plan.cushionShortfall && (
        <div className="text-xs text-warn mb-3 -mt-1">
          charge/pool caps prevent fully meeting the cushion — residual risk remains
        </div>
      )}

      {/* v1.60.0 — EV contention. Either the predicted session is quantified, or
          we say plainly that it is UNMODELLED; the absent-prediction line is a
          warning, never a "no EV expected tonight". */}
      {plan.bindingCap === 'evContention' && plan.evContention?.windowEvKwh != null && (
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
      {plan.evContention?.basis === 'unavailable' && plan.cushionShortfall && (
        <div className="text-xs text-muted mb-3 -mt-1">
          no EVSE prediction covers this window — EV contention is not modelled; if the car charges
          overnight the packs will receive less than planned
        </div>
      )}

      <ActuationBanner mode={status.mode} actuation={status.actuation ?? null} />


      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Trough without buy" value={fmtSoc(plan.baselineMinSocPct)} sub="P10 PV / P90 load" />
        <Stat label="Trough with buy" value={fmtSoc(plan.minProjSocPct)} sub={`floor+cushion ${floorCushionPct.toFixed(0)}%`} />
        <Stat
          label="Expected SoC"
          value={fmtSoc(plan.targetSocPct)}
          // v1.60.0 — the headline number is the PREDICTION; the reserve we ask
          // the device for is shown alongside it only when the two diverge (a
          // cap prevented delivering the requirement), never as a silent swap.
          sub={
            [
              plan.setpointSocPct != null && plan.targetSocPct != null && plan.setpointSocPct > plan.targetSocPct + 0.5
                ? `reserve set to ${plan.setpointSocPct.toFixed(0)}%`
                : null,
              plan.bindingCap ? `cap: ${BINDING_CAP_LABEL[plan.bindingCap] ?? plan.bindingCap}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        />
        <Stat label="Confidence" value={plan.confidenceTier} sub={ws && we ? `${ws}–${we}` : undefined} />
      </div>

      <AdvisoryNote mode={status.mode} />
    </div>
  );
});

/**
 * v1.50.0 — tonight's supervised-write state + the owner cancel control.
 * Renders nothing in advisory mode or when nothing is armed for tonight. The
 * cancel POST is optimistic-after-confirm: on 2xx the banner flips locally to
 * "cancelled" immediately (the 60 s status poll converges the full card).
 */
function ActuationBanner({ mode, actuation }: { mode: NightChargeStatus['mode']; actuation: NightActuation | null }) {
  const [busy, setBusy] = useState(false);
  const [localCancelled, setLocalCancelled] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  if (mode === 'advisory' || !actuation || actuation.day == null) return null;

  const cancelled = actuation.cancelled || localCancelled;
  const deadline = phoenixHHMM(actuation.cancelDeadlineMs);
  const doCancel = async () => {
    setBusy(true);
    setCancelErr(null);
    try {
      const r = await fetch(apiUrl('api/night-charge/cancel'), { method: 'POST' });
      if (r.ok) setLocalCancelled(true);
      else setCancelErr(`cancel failed (HTTP ${r.status})`);
    } catch {
      setCancelErr('cancel failed — network error');
    } finally {
      setBusy(false);
    }
  };

  let text: string;
  let showCancel = false;
  if (actuation.revertedAtMs != null) {
    text = `Completed — reserve restored to ${actuation.priorReservePct ?? '—'}%.`;
  } else if (cancelled) {
    text = actuation.appliedAtMs != null
      ? 'Cancelled — the applied write reverts within a minute.'
      : 'Cancelled — no write tonight.';
  } else if (actuation.appliedAtMs != null) {
    text = `Reserve raised to ${actuation.targetPct}% (was ${actuation.priorReservePct ?? '—'}%); auto-restores after the window closes.`;
    showCancel = true;
  } else {
    text = `Supervised write armed — reserve → ${actuation.targetPct}%${deadline ? ` at ${deadline}` : ''}.`;
    showCancel = true;
  }

  return (
    <div className="flex items-center justify-between gap-3 bg-panel2 border border-line rounded-md p-2 mb-3 text-xs">
      <span className={actuation.revertedAtMs != null || cancelled ? 'text-muted' : 'text-warn'}>{text}</span>
      <span className="flex items-center gap-2">
        {cancelErr && <span className="text-crit">{cancelErr}</span>}
        {showCancel && (
          <button
            className="px-2 py-1 rounded border border-line bg-panel hover:bg-panel2 text-ink disabled:opacity-50"
            disabled={busy}
            onClick={doCancel}
          >
            {actuation.appliedAtMs != null ? 'Cancel & revert' : 'Cancel tonight'}
          </button>
        )}
      </span>
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
