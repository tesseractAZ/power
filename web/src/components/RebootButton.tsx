import { useEffect, useState } from 'react';
import { apiUrl } from '../api';

/**
 * v0.9.6 — Reboot SHP2 button + confirmation modal.
 *
 * First user-facing WRITE action. Stays cautious:
 *
 *   - Always behind a confirmation modal (explicit consent — modifying the
 *     device).
 *   - Disables itself for the server-side cooldown window (5 min) after
 *     each press, even if the click was a tab away.
 *   - Polls /api/device/reboot-cooldown on mount so a button rendered on
 *     a fresh page-load reflects any active cooldown from a previous tab.
 *   - Surfaces failure responses honestly — when EcoFlow rejects the
 *     command shape, the UI says so instead of pretending it succeeded.
 *
 * Designed to be reused for future write actions (boost reserve, skip EV,
 * etc.) — just clone with different label/action/cooldown.
 */

interface CooldownState {
  remainingMs: number;
  cooldownMs: number;
}

interface RebootResponse {
  ok: boolean;
  code?: string;
  message?: string;
  durationMs?: number;
  rateLimited?: boolean;
  cooldownRemainingMs?: number;
}

export function RebootButton({ sn, deviceLabel = 'SHP2' }: { sn: string; deviceLabel?: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState<CooldownState>({ remainingMs: 0, cooldownMs: 0 });
  const [lastResult, setLastResult] = useState<RebootResponse | null>(null);

  // Poll cooldown on mount + every 5s while a cooldown is active.
  useEffect(() => {
    let live = true;
    const fetchCooldown = async () => {
      try {
        const r = await fetch(apiUrl(`api/device/reboot-cooldown?sn=${encodeURIComponent(sn)}`));
        if (!r.ok) return;
        const j = await r.json();
        if (!live) return;
        setCooldown({
          remainingMs: Number(j.remainingMs) || 0,
          cooldownMs: Number(j.cooldownMs) || 0,
        });
      } catch { /* ignore — cooldown is optional UX */ }
    };
    fetchCooldown();
    const t = window.setInterval(fetchCooldown, 5000);
    return () => { live = false; window.clearInterval(t); };
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
      // v0.9.7 — the reboot endpoint takes its SN from the URL path and
      // expects NO body. Setting Content-Type: application/json with no body
      // makes Fastify's JSON parser reject the request (FST_ERR_CTP_EMPTY_JSON_BODY).
      // Drop the header — fetch sends none by default for bodiless POSTs.
      const r = await fetch(apiUrl(`api/device/reboot/${encodeURIComponent(sn)}`), {
        method: 'POST',
      });
      const j = (await r.json()) as RebootResponse;
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

  const cooldownLabel = cooldown.remainingMs > 0
    ? `Reboot ${deviceLabel} (cooldown ${Math.ceil(cooldown.remainingMs / 1000)}s)`
    : `Reboot ${deviceLabel}`;

  return (
    <>
      <button
        type="button"
        disabled={busy || !cooledDown}
        onClick={() => setConfirming(true)}
        className={`badge text-[10px] ${
          busy || !cooledDown ? 'badge-muted opacity-60 cursor-not-allowed' : 'badge-warn hover:bg-warn/25'
        }`}
        title={cooledDown
          ? `Send a reboot command to ${deviceLabel}. Cools down ~${Math.round(cooldown.cooldownMs / 60_000)} min after each use.`
          : `Wait ${Math.ceil(cooldown.remainingMs / 1000)} s before rebooting again.`
        }
      >
        {busy ? 'rebooting…' : cooldownLabel}
      </button>

      {lastResult && !lastResult.ok && (
        <div className="text-[10px] text-bad mt-1 leading-tight" title="The EcoFlow API returned an error. The command shape may need adjusting — see /api/device/send-command in DOCS.">
          ✕ {lastResult.message ?? 'failed'} {lastResult.code ? `(${lastResult.code})` : ''}
        </div>
      )}
      {lastResult?.ok && cooldown.remainingMs > 0 && (
        <div className="text-[10px] text-ok mt-1 leading-tight">
          ✓ Reboot sent — device will be unreachable for ~60 s.
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
            <div className="text-base font-semibold mb-2">Reboot {deviceLabel}?</div>
            <p className="text-sm text-muted mb-1 leading-relaxed">
              This sends the EcoFlow reboot command to <span className="font-mono text-xs">{sn}</span>.
              The device will be unreachable for ~60 seconds — the dashboard will show it offline
              briefly, then reconnect on its own.
            </p>
            <p className="text-xs text-muted leading-relaxed">
              Safe to use when the device is in the "EcoFlow zombie" state (cloud says offline but
              the device is on your LAN). Use sparingly otherwise. Audit-logged.
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
                className="badge badge-warn"
                onClick={onConfirm}
              >
                Reboot {deviceLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
