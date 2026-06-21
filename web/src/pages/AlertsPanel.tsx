import { useEffect, useState } from 'react';
import type { Alert, ClearedAlert } from '../types';
import { fmtRel, fmtMins } from '../format';
import { SubjectBoxes } from '../cards/AlertParts';
// v0.11.0 — group + colour the alert list by ISA priority (Critical/High/Medium/Low).
import {
  priorityOf,
  priorityCounts,
  PRIORITY_META,
  ALARM_PRIORITY_ORDER,
  type PriorityMeta,
} from '../alertPriority';
import { AlertOutcomeButtons } from '../components/AlertOutcomeButtons';
import { apiUrl } from '../api';

interface NotifyStatus {
  channel: string;
  configured: boolean;
  minSeverity: string;
  notifyResolved: boolean;
  ntfyServer?: string;
  ntfyTopic?: string;
  tracked: number;
  sentSinceStart: number;
}

export function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  const counts = priorityCounts(alerts);
  // "Actionable" = anything above the advisory (Low / P4) tier.
  const actionable = alerts.filter((a) => priorityOf(a) !== 'low');

  return (
    <div className="space-y-4">
      {/* Summary — four ISA priority tiles */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>System alerts</span>
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
            All systems nominal — no Critical or High conditions across the fleet.
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
      <ClearedAlertsCard />
    </div>
  );
}

/* Recently-cleared log — the history of alerts that have come and gone. */
function ClearedAlertsCard() {
  const [cleared, setCleared] = useState<ClearedAlert[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(apiUrl('api/alerts/history'));
        if (r.ok && live) {
          const j = (await r.json()) as { cleared: ClearedAlert[] };
          setCleared(j.cleared ?? []);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Recently cleared</span>
        <span className="text-xs text-muted normal-case tracking-normal">{cleared.length} logged this session</span>
      </div>
      {cleared.length === 0 ? (
        <div className="text-sm text-muted leading-relaxed">
          No alerts have been raised and cleared since the server started. As conditions come and
          go, each is logged here — threshold and learned alike — with how long it lasted.
        </div>
      ) : (
        <div className="space-y-2">
          {cleared.map((ce, i) => (
            <ClearedRow key={`${ce.alert.id}-${ce.clearedAt}-${i}`} ce={ce} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClearedRow({ ce }: { ce: ClearedAlert }) {
  const a = ce.alert;
  return (
    <div className="flex items-stretch gap-3 bg-panel2/40 border border-line rounded-lg p-3">
      <SubjectBoxes alert={a} />
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium">{a.title}</span>
          <span className="badge badge-muted text-[10px]">{a.category}</span>
          {a.source === 'learned' && (
            <span className="badge text-[10px] bg-accent/15 text-accent border-accent/30">learned</span>
          )}
          <span className="badge badge-ok text-[10px]">cleared</span>
          {a.coreNum == null && <span className="text-[10px] text-muted">{a.device}</span>}
        </div>
        <div className="text-xs text-muted mt-1 leading-relaxed">{a.detail}</div>
        <div className="text-[11px] text-muted mt-1.5">
          raised {fmtRel(ce.raisedAt)} · cleared {fmtRel(ce.clearedAt)} · lasted{' '}
          {fmtMins(ce.durationMs / 60000)}
        </div>
      </div>
    </div>
  );
}

function NotificationCard() {
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [testState, setTestState] = useState<'idle' | 'sending' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const load = async () => {
    try {
      const r = await fetch(apiUrl('api/notify/status'));
      if (r.ok) setStatus(await r.json());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, []);

  const sendTest = async () => {
    setTestState('sending');
    setTestMsg('');
    try {
      const r = await fetch(apiUrl('api/notify/test'), { method: 'POST' });
      const j = await r.json();
      if (j.ok) {
        setTestState('ok');
        setTestMsg('Test notification sent.');
      } else {
        setTestState('fail');
        setTestMsg(j.error ?? 'Failed to send.');
      }
    } catch (e: any) {
      setTestState('fail');
      setTestMsg(String(e?.message ?? e));
    }
    setTimeout(() => setTestState('idle'), 6000);
  };

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Push notifications</span>
        {status && (
          <span className={`badge ${status.configured ? 'badge-ok' : 'badge-muted'}`}>
            {status.channel === 'none' ? 'disabled' : status.configured ? `${status.channel} · ready` : `${status.channel} · not configured`}
          </span>
        )}
      </div>
      {!status ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : status.channel === 'none' ? (
        <div className="text-sm text-muted leading-relaxed">
          Notifications are off. To enable: set <code className="text-accent">NOTIFY_CHANNEL=ntfy</code> in
          <code className="text-accent"> server/.env</code>, install the ntfy app, subscribe to your topic, and restart the server.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <Field label="Channel" value={status.channel} />
            <Field label="Min severity" value={status.minSeverity} />
            <Field label="Resolved alerts" value={status.notifyResolved ? 'notified' : 'muted'} />
            <Field label="Sent this session" value={String(status.sentSinceStart)} />
          </div>
          {status.channel === 'ntfy' && status.ntfyTopic && (
            <div className="text-[11px] text-muted mb-3 leading-relaxed">
              Subscribe in the ntfy app to topic <code className="text-accent">{status.ntfyTopic}</code>
              {status.ntfyServer && status.ntfyServer !== 'https://ntfy.sh' ? ` on ${status.ntfyServer}` : ' on ntfy.sh'}.
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={sendTest}
              disabled={testState === 'sending'}
              className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-50"
            >
              {testState === 'sending' ? 'sending…' : 'Send test notification'}
            </button>
            {testMsg && (
              <span className={`text-xs ${testState === 'ok' ? 'text-ok' : testState === 'fail' ? 'text-bad' : 'text-muted'}`}>
                {testMsg}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-lg p-2">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-sm font-medium mt-0.5 capitalize">{value}</div>
    </div>
  );
}

function AlertRow({ alert, meta }: { alert: Alert; meta: PriorityMeta }) {
  return (
    <div className={`flex items-stretch gap-3 bg-panel2/50 border ${meta.ring} rounded-lg p-3`}>
      <SubjectBoxes alert={alert} />
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium">{alert.title}</span>
          <span className="badge badge-muted text-[10px]">{alert.category}</span>
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
