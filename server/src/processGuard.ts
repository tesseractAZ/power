/**
 * v0.60.0 — top-level process guard.
 *
 * The add-on crashed with `exit code 255` during the daily 13:00 Supervisor
 * maintenance window (CoreDNS plugin restart + AppArmor reload) — a transient
 * DNS/network bounce surfaced as an uncaught error and killed a CRITICAL power
 * monitor for ~2 min. This installs `uncaughtException` / `unhandledRejection`
 * handlers that SURVIVE a transient network/DNS error (logging LOUDLY so a masked
 * recurring fault stays visible) but RE-RAISE a genuinely fatal one, so we never
 * silently swallow a real bug.
 *
 * The transient classifier is shared with the MQTT cert-fetch retry
 * (ecoflow/mqtt.ts) so the two stay in sync.
 */
import { isTransientNetworkError } from './ecoflow/mqtt.js';

export type GuardDecision = 'survive' | 'fatal';
export type GuardKind = 'uncaughtException' | 'unhandledRejection';

/** Survive a transient network/DNS error (EAI_AGAIN/ENOTFOUND/ECONNREFUSED/
 *  ETIMEDOUT/timeout); everything else is fatal. Pure + exported for tests. */
export function classifyTopLevelError(e: unknown): GuardDecision {
  return isTransientNetworkError(e) ? 'survive' : 'fatal';
}

/** The handler body, factored out so it's unit-testable without registering real
 *  process listeners. Logs, decides, and calls onFatal for a fatal error; returns
 *  the decision. */
export function handleTopLevelError(
  e: unknown,
  kind: GuardKind,
  log: { error: (m: string) => void; fatal: (m: string) => void },
  onFatal: (e: unknown) => void,
): GuardDecision {
  const decision = classifyTopLevelError(e);
  const detail = (e as any)?.stack ?? (e as any)?.message ?? String(e);
  if (decision === 'survive') {
    // LOUD but non-fatal: a CoreDNS/AppArmor maintenance bounce must not kill the
    // monitor. Greppable prefix so a misclassified recurring fault is still findable.
    log.error(`process-guard: SURVIVED transient ${kind} (network/DNS, not exiting): ${detail}`);
  } else {
    log.fatal(`process-guard: FATAL ${kind}, exiting: ${detail}`);
    onFatal(e);
  }
  return decision;
}

/** Install the process-level guards. Call once at startup. opts.onFatal lets tests
 *  inject a non-exiting sink; default exits the process (the correct fatal action). */
export function installProcessGuards(
  log: { error: (m: string) => void; fatal: (m: string) => void },
  opts?: { onFatal?: (e: unknown) => void },
): void {
  const onFatal = opts?.onFatal ?? (() => process.exit(1));
  process.on('uncaughtException', (e) => handleTopLevelError(e, 'uncaughtException', log, onFatal));
  process.on('unhandledRejection', (reason) => handleTopLevelError(reason, 'unhandledRejection', log, onFatal));
}
