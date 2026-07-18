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
  targetSocPct: number | null;
  requiredExtraKwh: number | null;
  bindingCap: 'requirement' | 'chargePower' | 'poolHeadroom' | 'overBuy' | null;
  cushionShortfall: boolean;
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

interface NightChargeStatus {
  enabled: boolean;
  mode: 'advisory';
  window: { startMs: number; endMs: number } | null;
  reserveFloorPercent: number | null;
  confidence: string | null;
  notify: { hour: number; minute: number; lastNotifyDay: string | null } | null;
  plan: NightChargePlan | null;
  readiness: NightChargeReadiness | null;
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
        <AdvisoryNote />
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
          buy overnight → target <span className="text-ink font-medium">{fmtSoc(plan.targetSocPct)}</span>
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Trough without buy" value={fmtSoc(plan.baselineMinSocPct)} sub="P10 PV / P90 load" />
        <Stat label="Trough with buy" value={fmtSoc(plan.minProjSocPct)} sub={`floor+cushion ${floorCushionPct.toFixed(0)}%`} />
        <Stat label="Target SoC" value={fmtSoc(plan.targetSocPct)} sub={plan.bindingCap ? `cap: ${plan.bindingCap}` : undefined} />
        <Stat label="Confidence" value={plan.confidenceTier} sub={ws && we ? `${ws}–${we}` : undefined} />
      </div>

      <AdvisoryNote />
    </div>
  );
});

function AdvisoryNote() {
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
