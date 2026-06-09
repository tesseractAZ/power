/**
 * v0.9.25 — feedback-loop verdict buttons.
 *
 * One-tap ack/dismiss/failed on each alert, posted to the server's
 * outcome log. Used by the Alerts page.
 *
 * The whole point: every press is a labeled training example for
 * future model improvement. We're cheap and aggressive about asking
 * — three buttons inline, no confirmation modal.
 */

import { useState } from 'react';
import { apiUrl } from '../api';

export interface AlertOutcomeButtonsProps {
  alertId: string;
  /** Optional callback after a successful submission. */
  onSubmitted?: (outcome: 'ack' | 'dismiss' | 'failed') => void;
}

type Outcome = 'ack' | 'dismiss' | 'failed';

export function AlertOutcomeButtons({ alertId, onSubmitted }: AlertOutcomeButtonsProps) {
  const [submitted, setSubmitted] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (outcome: Outcome) => {
    setBusy(outcome);
    setError(null);
    try {
      const r = await fetch(apiUrl('api/alerts/outcome'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, outcome }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      setSubmitted(outcome);
      onSubmitted?.(outcome);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  if (submitted) {
    const label =
      submitted === 'ack' ? '✓ ACKNOWLEDGED' :
      submitted === 'dismiss' ? '✕ DISMISSED (false alarm)' :
      '🔧 LOGGED AS REAL FAILURE';
    return (
      <span className="text-[10px] text-muted">
        {label}
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <OutcomeBtn
        label="✓ Real"
        title="Acknowledge — this alert was real / I'm dealing with it"
        color="ok"
        busy={busy === 'ack'}
        onClick={() => submit('ack')}
      />
      <OutcomeBtn
        label="✕ False"
        title="Dismiss as false alarm — this alert is noise, don't trust this type as much"
        color="muted"
        busy={busy === 'dismiss'}
        onClick={() => submit('dismiss')}
      />
      <OutcomeBtn
        label="🔧 Failed"
        title="This alert preceded an ACTUAL hardware failure — strong positive label"
        color="bad"
        busy={busy === 'failed'}
        onClick={() => submit('failed')}
      />
      {error && <span className="text-[10px] text-bad ml-1">{error}</span>}
    </div>
  );
}

function OutcomeBtn({
  label, title, color, busy, onClick,
}: {
  label: string;
  title: string;
  color: 'ok' | 'muted' | 'bad';
  busy: boolean;
  onClick: () => void;
}) {
  const cls = color === 'ok' ? 'badge-ok' : color === 'bad' ? 'badge-bad' : 'badge-muted';
  return (
    <button
      type="button"
      title={title}
      disabled={busy}
      onClick={onClick}
      className={`badge ${cls} text-[9px] hover:opacity-100 ${busy ? 'opacity-50' : 'opacity-80'}`}
    >
      {busy ? '…' : label}
    </button>
  );
}
