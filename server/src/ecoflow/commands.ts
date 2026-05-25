import { ecoflow } from './rest.js';
import { appendWriteLog, type WriteOutcome } from '../writeLog.js';

/**
 * High-level write helpers.
 *
 * `sendCommand()` in rest.ts is the raw POST primitive; this module wraps
 * it with per-action shape constants, rate-limiting, and audit logging.
 * Originally introduced in v0.9.6 (with a best-guess reboot command),
 * pivoted in v0.9.10 to a documented no-op cloud-presence refresh after
 * empirical probing confirmed reboot is not in the public API.
 */

/** Per-(action,sn) rate-limit window. Each entry tracks the last-allowed ts. */
const rateLimitState = new Map<string, number>();

interface RateLimitOptions {
  /** Cooldown after a successful action. */
  cooldownMs: number;
}

/** Returns true if the action is allowed right now (and reserves the slot). */
function checkAndReserve(action: string, sn: string, opts: RateLimitOptions): boolean {
  const key = `${action}|${sn}`;
  const last = rateLimitState.get(key) ?? 0;
  const now = Date.now();
  if (now - last < opts.cooldownMs) return false;
  rateLimitState.set(key, now);
  return true;
}

/** How long until the user can retry this action — used for the UI button cooldown. */
export function cooldownRemainingMs(action: string, sn: string, cooldownMs: number): number {
  const last = rateLimitState.get(`${action}|${sn}`) ?? 0;
  return Math.max(0, last + cooldownMs - Date.now());
}

export interface CommandRequest {
  sn: string;
  body: Record<string, unknown>;
  source: { ip?: string; ua?: string };
}

export interface CommandResult {
  outcome: WriteOutcome;
  code?: string;
  message?: string;
  data?: unknown;
  durationMs: number;
  rateLimited?: boolean;
}

/**
 * Run a raw command + audit-log it. Used by both the typed helpers
 * below AND the debug send-command endpoint.
 */
async function runCommand(action: string, req: CommandRequest): Promise<CommandResult> {
  const t0 = Date.now();
  try {
    const data = await ecoflow.sendCommand(req.sn, req.body);
    const durationMs = Date.now() - t0;
    appendWriteLog({
      ts: Date.now(),
      action, sn: req.sn,
      params: req.body,
      source: req.source,
      outcome: 'success',
      code: '0',
      message: 'ok',
      durationMs,
    });
    return { outcome: 'success', code: '0', message: 'ok', data, durationMs };
  } catch (e: any) {
    const durationMs = Date.now() - t0;
    // Parse "EcoFlow API error <code>: <message>" if present.
    const m = /EcoFlow API error (\S+): (.*)/.exec(String(e?.message ?? e));
    const code = m?.[1] ?? 'local-error';
    const message = m?.[2] ?? String(e?.message ?? e);
    appendWriteLog({
      ts: Date.now(),
      action, sn: req.sn,
      params: req.body,
      source: req.source,
      outcome: 'failure',
      code, message, durationMs,
    });
    return { outcome: 'failure', code, message, durationMs };
  }
}

/* ─── SHP2 cloud-presence refresh ─────────────────────────────────────── */

/**
 * v0.9.10 — the v0.9.6 reboot button was retired here. Empirical probing
 * (see scripts/probe-shp2-reboot-direct.ts + CHANGELOG entries) showed
 * that SHP2 reboot is not exposed in EcoFlow's public IoT API: PD303_REBOOT,
 * PD303_APP_REBOOT, PD303_SYS_REBOOT, and the DPU-style cmdSet/cmdId shapes
 * all return error 8524 "invalid parameter." Reboot only exists via the
 * mobile app's private MQTT protobuf channel (cmdFunc=12).
 *
 * What we ARE able to do — and what actually solves the original "EcoFlow
 * zombie" problem (cloud says offline, LAN says online) — is a documented
 * **no-op write** that forces a round-trip through EcoFlow's cloud,
 * causing it to refresh its presence state for the device. The cheapest
 * such write is re-sending the current `backupReserveSoc` value: no state
 * actually changes, but the device + cloud both acknowledge the message.
 *
 * Cooldown is dropped from 5 min (reboot recovery time) to 30 s — this
 * action takes ~200 ms with no service disruption.
 */
export const REFRESH_COOLDOWN_MS = 30 * 1000;

export interface RefreshCloudRequest extends Omit<CommandRequest, 'body'> {
  /** Current backupReserveSoc to round-trip back (caller reads it from the snapshot). */
  currentReserveSoc: number;
}

export async function refreshShp2CloudPresence(req: RefreshCloudRequest): Promise<CommandResult> {
  if (!checkAndReserve('refresh-cloud', req.sn, { cooldownMs: REFRESH_COOLDOWN_MS })) {
    const remaining = cooldownRemainingMs('refresh-cloud', req.sn, REFRESH_COOLDOWN_MS);
    appendWriteLog({
      ts: Date.now(),
      action: 'refresh-cloud', sn: req.sn,
      source: req.source,
      outcome: 'failure',
      code: 'rate-limited',
      message: `cooldown ${Math.round(remaining / 1000)}s remaining`,
    });
    return {
      outcome: 'failure',
      code: 'rate-limited',
      message: `Wait ${Math.round(remaining / 1000)}s before refreshing again.`,
      durationMs: 0,
      rateLimited: true,
    };
  }
  // Sanity bound — backupReserveSoc is documented to live in [10, 50].
  // If the snapshot is stale/missing we'd rather fail loudly than write
  // a garbage value back to the panel.
  if (!Number.isInteger(req.currentReserveSoc) || req.currentReserveSoc < 10 || req.currentReserveSoc > 50) {
    return {
      outcome: 'failure',
      code: 'no-reserve-soc',
      message: `Can't refresh: current backupReserveSoc (${req.currentReserveSoc}) is out of range. Snapshot may be stale.`,
      durationMs: 0,
    };
  }
  return runCommand('refresh-cloud', {
    sn: req.sn,
    source: req.source,
    body: { cmdCode: 'PD303_APP_SET', params: { backupReserveSoc: req.currentReserveSoc } },
  });
}

/* ─── Debug: arbitrary command (admin-only) ──────────────────────────── */

/**
 * Send an arbitrary command. Caller passes the full body, we log it +
 * forward it. Useful for empirically discovering the right cmd shape for
 * undocumented operations. Throws if `WRITE_DEBUG_TOKEN` env isn't set
 * — keeps random web visitors from doing arbitrary writes.
 */
export async function debugSendCommand(req: CommandRequest): Promise<CommandResult> {
  return runCommand('send-command', req);
}

export function isWriteDebugEnabled(): boolean {
  return !!(process.env.WRITE_DEBUG_TOKEN && process.env.WRITE_DEBUG_TOKEN.length > 0);
}

export function checkWriteDebugToken(provided: string | undefined): boolean {
  const expected = process.env.WRITE_DEBUG_TOKEN;
  return !!expected && !!provided && expected === provided;
}
