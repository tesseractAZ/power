import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { Alert, ClearedHistoryPage, ClearedHistoryRow } from '../types';
import {
  CLEARED_DEFAULT_RANGE,
  CLEARED_PAGE_ROWS,
  CLEARED_RANGES,
  clearedCaption,
  clearedEmptyText,
  clearedHistoryQuery,
  clearedRangeLabel,
  deviceLabel,
  isSevere,
  newestFirst,
  showMoreLabel,
  visibleRows,
  type ClearedRange,
} from './clearedHistoryModel';
import { fmtRel, fmtMins } from '../format';
import { SubjectBoxes } from '../cards/AlertParts';
// v0.11.0 — group + colour the alert list by ISA priority (Critical/High/Medium/Low).
import {
  priorityOf,
  priorityMeta,
  priorityCounts,
  PRIORITY_META,
  ALARM_PRIORITY_ORDER,
  type PriorityMeta,
} from '../alertPriority';
import { AlertOutcomeButtons } from '../components/AlertOutcomeButtons';
import { SubNav } from '../components/SubNav';
import { PredictiveBadge } from '../components/PredictiveBadge';
import { HowItWorks } from '../components/sections';
import { apiUrl } from '../api';

// v0.85.0 — the former standalone "Alert Console" tab now lives under this
// page's "Settings" sub-view. Lazy so its (larger) audio-admin bundle only
// loads when the operator actually opens Settings.
const AlertConsolePanel = lazy(() =>
  import('./AlertConsolePanel').then((m) => ({ default: m.AlertConsolePanel })),
);

type SubView = 'active' | 'learned' | 'cleared' | 'settings';

/**
 * Alerts page (v0.85.0) — four sub-views behind a pill sub-nav:
 *   • Active   — the alarm-critical live alert board (UNCHANGED logic; thresholdAlerts).
 *   • Learned  — the model-driven anomaly/forecast detections, with the full
 *                statistical `facts` breakdown (recovered from the dissolved
 *                Predictive tab). These are predictions, hence the PredictiveBadge.
 *   • Cleared  — a dedicated, persistent history of fired→cleared alerts.
 *   • Settings — the Alert Console (broadcast / annunciation / tones), hosted inline.
 *
 * The Active view receives only `alerts` (threshold rules); the learned engine's
 * signals arrive separately as `learnedAlerts` and drive the Learned sub-view.
 */
export function AlertsPanel({
  alerts,
  learnedAlerts = [],
}: {
  alerts: Alert[];
  learnedAlerts?: Alert[];
}) {
  const [view, setView] = useState<SubView>('active');
  const counts = priorityCounts(alerts);
  // Active alerts above the advisory tier drive the sub-nav badge.
  const activeActionable = counts.critical + counts.high + counts.medium;

  return (
    <div className="space-y-4">
      <SubNav<SubView>
        aria-label="Alerts views"
        value={view}
        onChange={setView}
        tabs={[
          {
            id: 'active',
            label: 'Active',
            badge: {
              count: activeActionable,
              tone: counts.critical > 0 ? 'bad' : counts.high > 0 ? 'high' : 'warn',
            },
          },
          {
            id: 'learned',
            label: 'Learned',
            badge: { count: learnedAlerts.length, tone: 'accent' },
          },
          { id: 'cleared', label: 'Cleared' },
          { id: 'settings', label: 'Alert Settings' },
        ]}
      />

      {view === 'active' && <ActiveAlerts alerts={alerts} counts={counts} />}
      {view === 'learned' && <LearnedAlertsView alerts={learnedAlerts} />}
      {view === 'cleared' && <ClearedAlertsView />}
      {view === 'settings' && (
        <Suspense fallback={<div className="card text-sm text-muted">Loading alert settings…</div>}>
          <AlertConsolePanel />
        </Suspense>
      )}
    </div>
  );
}

/* ─── Active — the live alarm board (alarm-critical; logic unchanged) ───────── */

function ActiveAlerts({
  alerts,
  counts,
}: {
  alerts: Alert[];
  counts: Record<'critical' | 'high' | 'medium' | 'low', number>;
}) {
  // "Actionable" = anything above the advisory (Low / P4) tier.
  const actionable = alerts.filter((a) => priorityOf(a) !== 'low');

  return (
    <div className="space-y-4">
      {/* Summary — four ISA priority tiles */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Threshold alerts</span>
          <span className="text-xs text-muted normal-case tracking-normal">{alerts.length} item(s) flagged</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {ALARM_PRIORITY_ORDER.map((p) => {
            const meta = PRIORITY_META[p];
            return (
              <CountTile
                key={p}
                label={meta.label}
                isa={meta.isa}
                value={counts[p]}
                accent={counts[p] > 0 ? meta.text : 'text-muted'}
              />
            );
          })}
        </div>
        {actionable.length === 0 && (
          <div className="mt-3 flex items-center gap-2 text-sm text-ok">
            <span className="h-2 w-2 rounded-full bg-ok inline-block" />
            No Critical or High threshold alarms — see the Learned tab for model-driven detections.
          </div>
        )}
      </div>

      {/* Grouped by ISA priority (Critical → High → Medium → Low) */}
      {ALARM_PRIORITY_ORDER.map((p) => {
        const group = alerts.filter((a) => priorityOf(a) === p);
        if (group.length === 0) return null;
        const meta = PRIORITY_META[p];
        return (
          <div key={p} className="card">
            <div className="card-title flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${meta.dot} inline-block`} />
              <span>{meta.label}</span>
              <span className={`badge ${meta.badge} text-[10px]`}>{meta.isa}</span>
              <span className="text-muted normal-case tracking-normal">({group.length})</span>
            </div>
            <div className="space-y-2">
              {group.map((a) => (
                <AlertRow key={a.id} alert={a} meta={meta} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Learned — model-driven anomaly/forecast detections ────────────────────── */
/* Recovered from the dissolved Predictive tab (v0.85.0). These are learned
 * signals: peer-comparison anomalies + trend forecasts, each carrying the
 * statistical `facts` (z-scores, peer ratios, baselines) that explain WHY a
 * subject was flagged — the diagnostic surface an operator opens to see the
 * reasoning behind a flag. Marked predictive; the fixed-threshold rules stay in
 * the Active view. */

function LearnedAlertsView({ alerts }: { alerts: Alert[] }) {
  // Sort by ISA priority — most-severe first.
  const byPriority = (xs: Alert[]) =>
    [...xs].sort((a, b) => priorityMeta(priorityOf(a)).rank - priorityMeta(priorityOf(b)).rank);
  const anomalies = byPriority(alerts.filter((a) => !a.id.startsWith('forecast-')));
  const forecasts = byPriority(alerts.filter((a) => a.id.startsWith('forecast-')));
  const counts = priorityCounts(alerts);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="card-title flex items-center gap-2 flex-wrap">
          <span>Learned signals</span>
          <PredictiveBadge
            kind="model"
            accuracy={null}
            title="Model-driven detections — peer comparison, self-baseline anomalies, and trend forecasts. Not fixed-threshold rules."
          />
          <span className="text-xs text-muted normal-case tracking-normal ml-auto">
            {alerts.length} learned signal(s)
          </span>
        </div>
        <HowItWorks>
          Model-driven detections, not fixed-threshold rules. The learned engine compares every
          battery pack against the other packs in its Core, every sensor against its own hour-of-day history,
          and projects current trends forward — surfacing problems an absolute limit would miss.
          Each signal shows the statistics behind the flag.
        </HowItWorks>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          <CountTile label="Anomalies" value={anomalies.length} accent={anomalies.length ? 'text-accent' : 'text-muted'} />
          <CountTile label="Forecasts" value={forecasts.length} accent={forecasts.length ? 'text-accent' : 'text-muted'} />
          <CountTile
            label="Actionable"
            value={counts.critical + counts.high + counts.medium}
            accent={counts.critical + counts.high + counts.medium ? 'text-warn' : 'text-muted'}
          />
          <CountTile label="Low" value={counts.low} accent="text-muted" />
        </div>
        {alerts.length === 0 && (
          <div className="mt-3 text-sm text-muted leading-relaxed">
            No learned signals right now — the anomaly/forecast engines have nothing to flag.
          </div>
        )}
      </div>

      {alerts.length > 0 && (
        <>
          <LearnedSection
            title="Anomalies"
            subtitle="Unusual right now — peer comparison & self-baseline"
            items={anomalies}
            // v1.145.0 — the anomaly list is computed from ONLINE DPUs only, so
            // "every pack" overclaimed whenever one was dark: silence about a pack
            // nobody looked at read as a clean bill of health for it.
            empty="No anomalies among the packs currently reporting."
          />
          <LearnedSection
            title="Forecasts"
            subtitle="Where it's heading — runtime, degradation & day-ahead projection"
            items={forecasts}
            empty="No forecasts flagged — no concerning trends projected."
          />
        </>
      )}
    </div>
  );
}

function LearnedSection({
  title,
  subtitle,
  items,
  empty,
}: {
  title: string;
  subtitle: string;
  items: Alert[];
  empty: string;
}) {
  return (
    <div className="card">
      <div className="card-title flex items-baseline gap-2">
        <span>{title}</span>
        <span className="text-muted normal-case tracking-normal">({items.length})</span>
        <span className="text-[11px] text-muted normal-case tracking-normal ml-auto hidden sm:inline">{subtitle}</span>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-ok">
          <span className="h-2 w-2 rounded-full bg-ok inline-block" />
          {empty}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <InsightCard key={a.id} alert={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function InsightCard({ alert }: { alert: Alert }) {
  const meta = priorityMeta(priorityOf(alert));
  return (
    <div className={`flex items-stretch gap-3 bg-panel2/50 border ${meta.ring} rounded-lg p-3`}>
      <SubjectBoxes alert={alert} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold">{alert.title}</span>
          <span className={`badge ${meta.badge} text-[10px]`}>{meta.label}</span>
          <span className="badge badge-muted text-[10px]">{alert.category}</span>
          {alert.coreNum == null && <span className="text-[10px] text-muted">{alert.device}</span>}
        </div>
        <div className="text-xs text-muted mt-1 leading-relaxed">{alert.detail}</div>
        {alert.facts && alert.facts.length > 0 && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {alert.facts.map((f) => (
              <div key={f.label} className="bg-panel border border-line rounded-md px-2 py-1.5">
                <div className="text-[9px] uppercase tracking-wider text-muted leading-none">{f.label}</div>
                <div className="text-sm font-mono font-semibold tabular-nums text-ink mt-1 leading-none">{f.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Cleared — persistent history of fired→cleared alerts ──────────────────── */

type ClearedFilter = 'all' | 'severe';

/**
 * The Cleared view asks the server for a window of the ledger (7 days unless the operator picks
 * 30 or 90 days, or All), newest first, each row reduced to what the table renders; the 30 s
 * refresh re-fetches the current window only, and CLEARED_PAGE_ROWS rows are rendered before a
 * "Show more". The view used to fetch the whole ledger (1,500 rows, 1.2 MB) and render every row.
 * The pure parts live in clearedHistoryModel.ts (tested in server/test/clearedHistoryWeb.test.ts).
 */
function ClearedAlertsView() {
  const [range, setRange] = useState<ClearedRange>(CLEARED_DEFAULT_RANGE);
  const [filter, setFilter] = useState<ClearedFilter>('all');
  const [limit, setLimit] = useState(CLEARED_PAGE_ROWS);
  // The page and the range it answers: a page for another range is not shown under this one.
  const [loaded, setLoaded] = useState<{ range: ClearedRange; page: ClearedHistoryPage } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(apiUrl(clearedHistoryQuery(range)));
        if (!live) return;
        if (!r.ok) {
          setFailed(true);
          return;
        }
        const j = (await r.json()) as ClearedHistoryPage;
        if (live) {
          setLoaded({ range, page: { ...j, cleared: j.cleared ?? [] } });
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [range]);

  const page = loaded?.range === range ? loaded.page : null;
  const sorted = useMemo(() => newestFirst(page?.cleared ?? []), [page]);
  const filtered = useMemo(() => (filter === 'severe' ? sorted.filter(isSevere) : sorted), [sorted, filter]);
  const { rows: visible, hidden } = visibleRows(filtered, limit);

  const pickRange = (r: ClearedRange) => {
    setRange(r);
    setLimit(CLEARED_PAGE_ROWS);
  };

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between gap-2 flex-wrap">
        <span>Recently cleared</span>
        {page && (
          <span className="text-xs text-muted normal-case tracking-normal">
            {clearedCaption({ shown: filtered.length, total: page.total, range, filtered: filter === 'severe' })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <SubNav<ClearedRange>
          aria-label="Cleared-alert window"
          value={range}
          onChange={pickRange}
          tabs={CLEARED_RANGES.map((r) => ({ id: r, label: clearedRangeLabel(r) }))}
        />
        <SubNav<ClearedFilter>
          aria-label="Cleared-alert filter"
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: 'all', label: 'All' },
            { id: 'severe', label: 'Critical + High' },
          ]}
        />
      </div>

      <HowItWorks>
        History persists across restarts — readable even when speakers are down. Each alert is logged
        here when it clears, threshold and learned alike, with how long it lasted. The list shows the
        last 7 days unless another window is picked; All is everything the add-on has kept.
      </HowItWorks>

      {page == null ? (
        <div className="text-sm text-muted leading-relaxed">
          {failed ? 'The cleared history could not be loaded.' : 'Loading…'}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-muted leading-relaxed">
          {clearedEmptyText({ total: page.total, shown: page.shown, range })}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-left text-[11px] uppercase tracking-wider">
                  <th className="font-medium py-1 pr-3">Severity</th>
                  <th className="font-medium py-1 pr-3">Alert</th>
                  <th className="font-medium py-1 pr-3 hidden sm:table-cell">Category</th>
                  <th className="font-medium py-1 pr-3 hidden md:table-cell">Device</th>
                  <th className="font-medium py-1 pr-3">Window</th>
                  <th className="font-medium py-1">Lasted</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row, i) => (
                  <ClearedRow key={`${row.id}-${row.clearedAt}-${i}`} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          {hidden > 0 && (
            <div className="mt-3 flex items-center justify-between gap-2 flex-wrap text-xs text-muted">
              <span>{hidden.toLocaleString('en-US')} more not shown</span>
              <button
                type="button"
                onClick={() => setLimit((l) => l + CLEARED_PAGE_ROWS)}
                className="px-3 py-1 rounded-sm border border-line bg-panel hover:bg-panel2 text-ink"
              >
                {showMoreLabel(hidden)}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ClearedRow({ row }: { row: ClearedHistoryRow }) {
  const meta = PRIORITY_META[priorityOf(row)];
  return (
    <tr className="border-t border-line/50 align-top">
      <td className="py-2 pr-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${meta.dot} inline-block shrink-0`} />
          <span className={`text-[11px] font-semibold ${meta.text}`}>{meta.label}</span>
        </span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="font-medium text-ink">{row.title}</span>
          {row.source === 'learned' && (
            <span className="badge text-[9px] bg-accent/15 text-accent border-accent/30">learned</span>
          )}
        </div>
        {row.detail && <div className="text-[11px] text-muted mt-0.5 leading-snug">{row.detail}</div>}
      </td>
      <td className="py-2 pr-3 hidden sm:table-cell">
        <span className="badge badge-muted text-[10px]">{row.category}</span>
      </td>
      <td className="py-2 pr-3 hidden md:table-cell text-[11px] text-muted">{deviceLabel(row)}</td>
      <td className="py-2 pr-3 text-[11px] text-muted whitespace-nowrap">
        raised {fmtRel(row.raisedAt)}
        <br />
        cleared {fmtRel(row.clearedAt)}
      </td>
      <td className="py-2 text-[11px] font-mono tabular-nums text-ink whitespace-nowrap">
        {fmtMins(row.durationMs / 60000)}
      </td>
    </tr>
  );
}

/* ─── Shared row / tile primitives (Active view) ────────────────────────────── */

function AlertRow({ alert, meta }: { alert: Alert; meta: PriorityMeta }) {
  return (
    <div className={`flex items-stretch gap-3 bg-panel2/50 border ${meta.ring} rounded-lg p-3`}>
      <SubjectBoxes alert={alert} />
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium">{alert.title}</span>
          <span className="badge badge-muted text-[10px]">{alert.category}</span>
          {/* annunciate:false = chime/push/broadcast suppressed (spare DPU OR a
              balancing home core). "silenced" is the only accurate word here —
              do NOT infer "spare" from this flag. */}
          {alert.annunciate === false && (
            <span className="badge badge-muted text-[10px]">silenced</span>
          )}
          {alert.coreNum == null && <span className="text-[10px] text-muted">{alert.device}</span>}
        </div>
        <div className="text-xs text-muted mt-1 leading-relaxed">{alert.detail}</div>
        {/* v0.9.25 — feedback-loop: operator verdict feeds the labeled dataset */}
        <div className="mt-2">
          <AlertOutcomeButtons alertId={alert.id} />
        </div>
      </div>
    </div>
  );
}

function CountTile({ label, value, accent, isa }: { label: string; value: number; accent: string; isa?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3 text-center">
      <div className={`text-3xl font-bold tabular-nums ${accent}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-muted mt-1">
        {label}
        {isa && <span className="ml-1 normal-case tracking-normal opacity-70">{isa}</span>}
      </div>
    </div>
  );
}
