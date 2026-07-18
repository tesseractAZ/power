import type { DeviceSnapshot, Shp2ChargeWindow, Shp2PairedCircuit, Shp2Projection } from '../types';
import { fmtPct, fmtW } from '../format';
// v0.85.0 — the dissolved Predictive tab's strategy-relevant sections relocate
// here: EV-charging window prediction + NWS active alerts (storm-prep). Both
// are model-driven and marked with the PredictiveBadge inside the card.
import { AdvancedInsightsCard } from '../cards/AdvancedInsightsCard';
// v1.38.0 (night-charge advisory, WS4) — the advisor's TONIGHT'S PLAN card,
// self-fetching and SHP2-availability-independent. Mounted just ABOVE the SHP2
// native "Charge schedule (time-of-use)" card so the advisory recommendation and
// the device's own schedule sit together but are never confused.
import { NightChargeCard } from '../cards/NightChargeCard';
import { SectionHeader } from '../components/sections';

/**
 * SHP2 strategy view: per-circuit load-shed priorities and the time-of-use
 * charge schedule. Both are read-only — this dashboard never writes config.
 *
 * v0.85.0 — also hosts the forward-looking strategy predictions (EV-charging
 * windows, storm-prep NWS alerts). Those do NOT depend on the SHP2 being
 * online, so they render even when the SHP2 config below is unavailable.
 */
export function StrategyPanel({ devices }: { devices: Record<string, DeviceSnapshot> }) {
  // Require online: a cloud-offline SHP2 carries STALE strategy config, and this
  // card presents it as authoritative ("…needs the Smart Home Panel online"). An
  // offline SHP2 must fall through to the not-available message.
  const shp2 = Object.values(devices).find((d) => d.online && d.projection?.kind === 'shp2');
  const p = shp2?.projection?.kind === 'shp2' ? (shp2.projection as Shp2Projection) : null;

  // EV-window + NWS storm-prep predictions — independent of SHP2 availability.
  const predictions = <AdvancedInsightsCard sections={['ev-window', 'nws']} />;

  if (!p) {
    return (
      <div className="space-y-4">
        <div className="card">SHP2 not available — strategy view needs the Smart Home Panel online.</div>
        {predictions}
      </div>
    );
  }
  const s = p.strategy;

  // Rank paired circuits by SHP2 native loadPriority. ASCENDING loadPriority =
  // most-protected (shed LAST, kept powered longest); the HIGHEST number sheds
  // FIRST. Verified empirically against live data: Pool Pump — the least-essential
  // load and currently SHP2-disabled — is loadPriority 25, a subpanel is 1. This is
  // the OPPOSITE polarity of server/src/loadShedRegistry.ts's internal HA shed-list
  // convention (priority 1 = shed-FIRST). They are DIFFERENT priority systems — do
  // NOT flip this sort to "match" loadShedRegistry; the direction here is correct.
  const ranked = [...p.pairedCircuits]
    .filter((c) => c.loadPriority != null)
    .sort((a, b) => (a.loadPriority ?? 999) - (b.loadPriority ?? 999));
  const unranked = p.pairedCircuits.filter((c) => c.loadPriority == null);

  return (
    <div className="space-y-4">
      {/* Load-shed strategy */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Load-shed strategy</span>
          <span className={`badge ${s.loadShedEnabled ? 'badge-ok' : 'badge-muted'}`}>
            {s.loadShedEnabled ? 'active' : s.loadShedConfigured ? 'configured · inactive' : 'not configured'}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile label="Mid-priority floor" value={fmtPct(s.midPriorityDischargeFloorSoc)} sub="mid loads cut at this SoC" />
          {/* Read the canonical top-level projection reserve — the SAME field the
              floor alarm, grid-backstop and HA backup_reserve_percent sensor defend
              with — NOT s.backupReserveSoc, so the tile can never show a reserve
              different from the one actually protecting the home. */}
          <Tile label="Backup reserve" value={fmtPct(p.backupReserveSoc)} sub={s.backupReserveEnabled ? 'reserve enabled' : 'reserve disabled'} />
          <Tile label="Solar reserve" value={fmtPct(s.solarBackupReserveSoc)} sub="target SoC on solar" />
          {/* Raw SHP2 mode codes — exact EcoFlow enum semantics are unconfirmed, so
              present them honestly as codes rather than fabricate labels. */}
          <Tile label="Smart backup (mode code)" value={String(s.smartBackupMode ?? '—')} sub={`raw SHP2 codes · backup ${s.backupMode ?? '—'} · overload ${s.overloadMode ?? '—'}`} />
        </div>
        {!s.loadShedEnabled && s.loadShedConfigured && (
          <div className="text-[11px] text-muted mt-3 leading-relaxed">
            Priorities below are configured but the automatic load-shed strategy is currently switched off in the SHP2.
            They define the intended shed order when enabled — the highest-numbered circuits drop first as the battery depletes.
          </div>
        )}
      </div>

      {/* Circuit priority ranking */}
      <div className="card">
        <div className="card-title">Circuit priority — shed order</div>
        <div className="space-y-2">
          {ranked.map((c, i) => (
            <PriorityRow key={c.primaryCh} circuit={c} rank={i + 1} total={ranked.length} />
          ))}
          {unranked.map((c) => (
            <PriorityRow key={c.primaryCh} circuit={c} rank={null} total={ranked.length} />
          ))}
        </div>
        <div className="text-[11px] text-muted mt-3">
          #1 = highest priority (last to be shed, kept powered longest). Higher numbers shed earlier when backup runs low.
        </div>
      </div>

      {/* Tonight's night-charge advisory (our planner — distinct from the SHP2's
          native TOU schedule below). Self-fetching; renders its own unavailable
          shape when no plan is live. */}
      <NightChargeCard />

      {/* Charge schedule */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Charge schedule (time-of-use)</span>
          {s.timeTask ? (
            <span className={`badge ${s.timeTask.isEnabled ? 'badge-ok' : 'badge-muted'}`}>
              {s.timeTask.isEnabled ? 'enabled' : 'disabled'}
            </span>
          ) : (
            <span className="badge badge-muted">no task</span>
          )}
        </div>
        {!s.timeTask ? (
          <div className="text-sm text-muted">No scheduled charge/discharge task configured on the SHP2.</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <Tile label="Task type" value={taskLabel(s.timeTask.type)} />
              <Tile label="Repeat" value={modeLabel(s.timeTask.timeMode)} />
              <Tile label="Charge target" value={fmtPct(s.timeTask.chargeCeilingSoc)} sub={`floor ${fmtPct(s.timeTask.chargeFloorSoc)}`} />
              <Tile label="Charge power" value={fmtW(s.timeTask.chargeWatts)} />
            </div>
            {/* The time-range gate (rangeEnabled) governs whether the bitmap windows
                are operative at all. When off, the windows are NOT being acted on
                regardless of isEnabled — de-emphasize them and say so. */}
            <div className={s.timeTask.rangeEnabled ? '' : 'opacity-50'}>
              <DayTimeline windows={s.timeTask.windows} />
              <div className="text-[11px] text-muted mt-2">
                {s.timeTask.windows.length === 0
                  ? 'No active window in the schedule bitmap.'
                  : `${s.timeTask.rangeEnabled ? 'Active' : 'Configured'} window${s.timeTask.windows.length > 1 ? 's' : ''}: ` +
                    s.timeTask.windows.map((w) => `${fmtClock(w.startMinute)}–${fmtClock(w.endMinute)}`).join(', ') +
                    ` · ${s.timeTask.slotMinutes}-min resolution`}
                {!s.timeTask.rangeEnabled && ' · time-range gate disabled, so these windows are not active.'}
                {s.timeTask.rangeEnabled && !s.timeTask.isEnabled && ' · task currently disabled, so this window is not being acted on.'}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Forward-looking strategy (relocated from the dissolved Predictive
          tab in v0.85.0). The config above is live SHP2 state; these are
          model-driven and marked with the PredictiveBadge. Empty-by-design when
          no EV pattern is detected and no NWS alert is active. */}
      <div className="pt-2">
        <SectionHeader
          accent="grid"
          title={<>Forecast &amp; storm-prep</>}
          takeaway="EV-charging windows and active storm alerts — quiet when none are detected."
        />
      </div>
      {predictions}
    </div>
  );
}

function PriorityRow({
  circuit,
  rank,
  total,
}: {
  circuit: Shp2PairedCircuit;
  rank: number | null;
  total: number;
}) {
  // Color gradient: rank 1 = green (essential) → last = red (first to shed)
  const frac = rank != null && total > 1 ? (rank - 1) / (total - 1) : 0;
  const tier = frac < 0.34 ? 'essential' : frac < 0.67 ? 'standard' : 'first to shed';
  const tierColor = frac < 0.34 ? 'text-ok' : frac < 0.67 ? 'text-amber-700' : 'text-warn';
  const active = (circuit.watts ?? 0) > 1;
  // The SHP2 can have a circuit disabled (loadIsEnable === false, e.g. Pool Pump
  // today). Keep it in the ranked list but clearly mark it — it is NOT an active
  // shed participant despite carrying a loadPriority. Mirrors the telnet screen.
  const disabled = circuit.loadIsEnable === false;
  return (
    <div className={`flex items-center gap-3 bg-panel2/50 border border-line rounded-lg p-2 ${disabled ? 'opacity-50' : ''}`}>
      <div className={`text-lg font-bold tabular-nums w-8 text-center ${tierColor}`}>
        {rank ?? '—'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate flex items-center gap-2">
          <span className={disabled ? 'line-through' : ''}>{circuit.name}</span>
          {disabled && (
            <span className="badge badge-muted text-[9px] uppercase tracking-wider shrink-0">disabled</span>
          )}
        </div>
        <div className="text-[10px] text-muted">
          {circuit.isSplitPhase ? `ch${circuit.primaryCh}+${circuit.secondaryCh} · 240V` : `ch${circuit.primaryCh}`}
          {' · '}{circuit.breakerAmps ?? '—'}A
          {' · raw priority '}{circuit.loadPriority ?? '—'}
          {disabled && ' · turned off in the SHP2'}
        </div>
      </div>
      <div className="text-right">
        <div className={`text-sm tabular-nums ${active ? 'text-ok' : 'text-muted'}`}>{fmtW(circuit.watts)}</div>
        <div className={`text-[10px] uppercase tracking-wider ${tierColor}`}>{tier}</div>
      </div>
    </div>
  );
}

function DayTimeline({ windows }: { windows: Shp2ChargeWindow[] }) {
  const DAY = 24 * 60;
  return (
    <div>
      <div className="relative h-9 bg-panel2 border border-line rounded-lg overflow-hidden">
        {/* hour gridlines */}
        {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
          <div key={h} className="absolute top-0 bottom-0 border-l border-line/40" style={{ left: `${(h / 24) * 100}%` }} />
        ))}
        {/* active windows */}
        {windows.map((w, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 bg-accent/30 border-x border-accent"
            style={{ left: `${(w.startMinute / DAY) * 100}%`, width: `${((w.endMinute - w.startMinute) / DAY) * 100}%` }}
          />
        ))}
        {/* "now" marker */}
        <NowMarker />
      </div>
      <div className="flex justify-between text-[9px] text-muted mt-1">
        {['12a', '4a', '8a', '12p', '4p', '8p', '12a'].map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function NowMarker() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-bad"
      style={{ left: `${(minutes / (24 * 60)) * 100}%` }}
      title="now"
    />
  );
}

function fmtClock(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const ampm = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

function taskLabel(type: string | null): string {
  if (!type) return '—';
  if (/charge/i.test(type)) return 'Scheduled charge';
  if (/discharge/i.test(type)) return 'Scheduled discharge';
  return type;
}

function modeLabel(mode: string | null): string {
  if (!mode) return '—';
  if (/every_day/i.test(mode)) return 'Every day';
  if (/week/i.test(mode)) return 'Weekly';
  if (/once/i.test(mode)) return 'Once';
  return mode.replace(/STARTEGY_|STRATEGY_/i, '').replace(/_/g, ' ').toLowerCase();
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-xl font-semibold mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  );
}
