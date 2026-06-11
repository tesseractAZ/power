import { useEffect, useState } from 'react';
import { apiUrl } from '../api';

/**
 * v0.9.10 — "Refresh cloud presence" button. Replaces the v0.9.6 reboot
 * button after empirical probing proved SHP2 reboot isn't exposed by
 * EcoFlow's public IoT API (see scripts/probe-shp2-reboot-direct.ts).
 *
 * What it actually does: POSTs a documented no-op write that re-sends
 * the panel's CURRENT `backupReserveSoc` value back to itself. The
 * panel acknowledges the write through EcoFlow's cloud, which un-sticks
 * the "online on LAN but cloud says offline" zombie state that was the
 * original motivation for a reboot button.
 *
 * Safe to use at any time — no device state changes, no service
 * interruption. ~200 ms round-trip. 30-second cooldown to keep us
 * polite to EcoFlow's API.
 *
 * Same general design as the original RebootButton: confirmation modal,
 * server-enforced cooldown reflected in the disabled state, honest
 * surfacing of EcoFlow API responses.
 */

interface CooldownState {
  remainingMs: number;
  cooldownMs: number;
}

interface RefreshResponse {
  ok: boolean;
  code?: string;
  message?: string;
  durationMs?: number;
  rateLimited?: boolean;
  cooldownRemainingMs?: number;
}

export function RefreshCloudButton({ sn, deviceLabel = 'SHP2' }: { sn: string; deviceLabel?: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState<CooldownState>({ remainingMs: 0, cooldownMs: 0 });
  const [lastResult, setLastResult] = useState<RefreshResponse | null>(null);

  useEffect(() => {
    let live = true;
    const fetchCooldown = async () => {
      try {
        const r = await fetch(apiUrl(`api/device/refresh-cloud-cooldown?sn=${encodeURIComponent(sn)}`));
        if (!r.ok) return;
        const j = await r.json();
        if (!live) return;
        setCooldown({
          remainingMs: Number(j.remainingMs) || 0,
          cooldownMs: Number(j.cooldownMs) || 0,
        });
      } catch { /* ignore — cooldown is optional UX */ }
    };
    // v0.15.18 — fetch ONCE per mount; the 1 s local ticker below carries the
    // countdown. The old 5 s re-poll was the single noisiest request on the
    // server (~17k requests/day across open dashboards) for a value that only
    // changes when the user presses the button — and the action response
    // already returns the fresh cooldown.
    fetchCooldown();
    return () => { live = false; };
  }, [sn]);

  // Tick the displayed cooldown locally every second so the countdown is smooth.
  useEffect(() => {
    if (cooldown.remainingMs <= 0) return;
    const t = window.setInterval(() => {
      setCooldown((c) => ({ ...c, remainingMs: Math.max(0, c.remainingMs - 1000) }));
    }, 1000);
    return () => window.clearInterval(t);
  }, [cooldown.remainingMs]);

  const cooledDown = cooldown.remainingMs <= 0;

  const onConfirm = async () => {
    setBusy(true);
    setConfirming(false);
    try {
      const r = await fetch(apiUrl(`api/device/refresh-cloud/${encodeURIComponent(sn)}`), {
        method: 'POST',
      });
      const j = (await r.json()) as RefreshResponse;
      setLastResult(j);
      if (typeof j.cooldownRemainingMs === 'number') {
        setCooldown((c) => ({ ...c, remainingMs: j.cooldownRemainingMs! }));
      }
    } catch (e: any) {
      setLastResult({ ok: false, message: String(e?.message ?? e), code: 'network-error' });
    } finally {
      setBusy(false);
    }
  };

  const label = cooldown.remainingMs > 0
    ? `Refresh cloud (${Math.ceil(cooldown.remainingMs / 1000)}s)`
    : 'Refresh cloud';

  return (
    <>
      <button
        type="button"
        disabled={busy || !cooledDown}
        onClick={() => setConfirming(true)}
        className={`badge text-[10px] ${
          busy || !cooledDown ? 'badge-muted opacity-60 cursor-not-allowed' : 'badge-ok hover:bg-ok/25'
        }`}
        title={cooledDown
          ? `Force ${deviceLabel} to round-trip a no-op write through EcoFlow's cloud. Useful when the cloud says "offline" but the device is on your LAN. 30-second cooldown.`
          : `Wait ${Math.ceil(cooldown.remainingMs / 1000)} s before refreshing again.`
        }
      >
        {busy ? 'refreshing…' : label}
      </button>

      {lastResult && !lastResult.ok && (
        <div className="text-[10px] text-bad mt-1 leading-tight" title="The EcoFlow API returned an error.">
          ✕ {lastResult.message ?? 'failed'} {lastResult.code ? `(${lastResult.code})` : ''}
        </div>
      )}
      {lastResult?.ok && (
        <div className="text-[10px] text-ok mt-1 leading-tight">
          ✓ Cloud refreshed.
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setConfirming(false)}
          role="dialog"
        >
          <div
            className="bg-panel border border-line rounded-lg p-5 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-semibold mb-2">Refresh {deviceLabel} cloud presence?</div>
            <p className="text-sm text-muted mb-1 leading-relaxed">
              Sends a no-op write to <span className="font-mono text-xs">{sn}</span>
              {' '}— specifically, re-sends the current backup-reserve % back to itself, which
              forces a round-trip through EcoFlow's cloud without changing any state on the panel.
            </p>
            <p className="text-xs text-muted leading-relaxed">
              Use when the dashboard or the EcoFlow app says the panel is offline but it's actually
              working on your LAN ("EcoFlow zombie" state). The earlier "Reboot SHP2" button was
              removed in v0.9.10 — reboot isn't in EcoFlow's public IoT API. Audit-logged.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="badge badge-muted"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="badge badge-ok"
                onClick={onConfirm}
              >
                Refresh cloud
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
