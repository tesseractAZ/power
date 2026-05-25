/**
 * v0.9.25 — feedback-loop verdict buttons.
 *
 * One-tap ack/dismiss/failed on each alert, posted to the server's
 * outcome log. Used by the Default Alerts page + the Starfleet
 * Tactical station (which passes its own styling overrides).
 *
 * The whole point: every press is a labeled training example for
 * future model improvement. We're cheap and aggressive about asking
 * — three buttons inline, no confirmation modal.
 */

import { useState } from 'react';
import { apiUrl } from '../api';

export interface AlertOutcomeButtonsProps {
  alertId: string;
  /** Optional themed-button class. Default uses the existing .badge styles. */
  variant?: 'default' | 'starfleet';
  /** Optional callback after a successful submission. */
  onSubmitted?: (outcome: 'ack' | 'dismiss' | 'failed') => void;
}

type Outcome = 'ack' | 'dismiss' | 'failed';

export function AlertOutcomeButtons({ alertId, variant = 'default', onSubmitted }: AlertOutcomeButtonsProps) {
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
      <span className={variant === 'starfleet' ? 'sf-label' : 'text-[10px] text-muted'} style={
        variant === 'starfleet' ? { color: submitted === 'dismiss' ? '#8c7a5c' : '#6fb854' } : undefined
      }>
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
        variant={variant}
        busy={busy === 'ack'}
        onClick={() => submit('ack')}
      />
      <OutcomeBtn
        label="✕ False"
        title="Dismiss as false alarm — this alert is noise, don't trust this type as much"
        color="muted"
        variant={variant}
        busy={busy === 'dismiss'}
        onClick={() => submit('dismiss')}
      />
      <OutcomeBtn
        label="🔧 Failed"
        title="This alert preceded an ACTUAL hardware failure — strong positive label"
        color="bad"
        variant={variant}
        busy={busy === 'failed'}
        onClick={() => submit('failed')}
      />
      {error && <span className="text-[10px] text-bad ml-1">{error}</span>}
    </div>
  );
}

function OutcomeBtn({
  label, title, color, variant, busy, onClick,
}: {
  label: string;
  title: string;
  color: 'ok' | 'muted' | 'bad';
  variant: 'default' | 'starfleet';
  busy: boolean;
  onClick: () => void;
}) {
  if (variant === 'starfleet') {
    const bg = color === 'ok' ? '#6fb854' : color === 'bad' ? '#c4242a' : '#3a2c1a';
    const fg = color === 'muted' ? '#8c7a5c' : '#0a0806';
    return (
      <button
        type="button"
        title={title}
        disabled={busy}
        onClick={onClick}
        style={{
          background: busy ? '#3a2c1a' : `linear-gradient(180deg, ${bg} 0%, ${dim(bg)} 100%)`,
          color: fg,
          border: '1px solid #5a4520',
          borderRadius: 2,
          padding: '0.2rem 0.5rem',
          fontFamily: 'Antonio, sans-serif',
          fontWeight: 700,
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          cursor: busy ? 'not-allowed' : 'pointer',
        }}
      >
        {busy ? '…' : label}
      </button>
    );
  }
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

function dim(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * 0.6));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * 0.6));
  const b = Math.max(0, Math.round((n & 0xff) * 0.6));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
