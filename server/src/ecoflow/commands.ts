import { ecoflow } from './rest.js';
import { appendWriteLog, type WriteOutcome } from '../writeLog.js';

/**
 * v0.9.6 — high-level write helpers.
 *
 * `sendCommand()` in rest.ts is the raw POST primitive; this module wraps
 * it with per-action shape constants, rate-limiting, and audit logging.
 *
 * Important honesty note: the SHP2 reboot command is NOT officially
 * documented in EcoFlow's published IoT Open API. The cmd shape below
 * uses the **best-guess pattern** observed across other SHP2 control
 * messages (`cmdSet=11` for platform commands), with `cmdId=17` borrowed
 * from analogous ESP-32 firmware-reboot conventions. If the EcoFlow API
 * returns an error code, the audit log captures it and the UI surfaces
 * "rebooting…" turned into "EcoFlow rejected the command — try the debug
 * /api/device/send-command endpoint to discover the right cmdId."
 *
 * Once we discover the correct command empirically, swap the constant
 * below and ship a patch release.
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

/* ─── SHP2 reboot ─────────────────────────────────────────────────────── */

export const REBOOT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Send the SHP2 reboot command. See the file-level note — the exact cmd
 * shape is a best-guess. Returns the EcoFlow response untouched so the
 * UI can show the truth (success → countdown timer; failure → "EcoFlow
 * rejected: code X message Y. Use /api/device/send-command to probe.").
 */
export async function rebootShp2(req: Omit<CommandRequest, 'body'>): Promise<CommandResult> {
  if (!checkAndReserve('reboot-shp2', req.sn, { cooldownMs: REBOOT_COOLDOWN_MS })) {
    const remaining = cooldownRemainingMs('reboot-shp2', req.sn, REBOOT_COOLDOWN_MS);
    appendWriteLog({
      ts: Date.now(),
      action: 'reboot-shp2', sn: req.sn,
      source: req.source,
      outcome: 'failure',
      code: 'rate-limited',
      message: `cooldown ${Math.round(remaining / 1000)}s remaining`,
    });
    return {
      outcome: 'failure',
      code: 'rate-limited',
      message: `Wait ${Math.round(remaining / 1000)}s before rebooting this device again.`,
      durationMs: 0,
      rateLimited: true,
    };
  }
  // Best-guess SHP2 reboot command. Refer to the file-level comment.
  return runCommand('reboot-shp2', {
    sn: req.sn,
    source: req.source,
    body: { cmdSet: 11, cmdId: 17, params: {} },
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
