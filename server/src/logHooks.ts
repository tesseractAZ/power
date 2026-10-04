import { LogController } from 'fastify';

/**
 * v1.184.0 — the Fastify logger's pino `logMethod` hook, extracted so it can be tested.
 *
 * - A string containing "stream closed prematurely" is dropped (pre-existing, v0.x).
 * - A CLIENT HANG-UP is demoted from error to debug: when a browser or HA REST sensor closes the
 *   connection before a streamed response finishes, Fastify's stream path (end-of-stream) logs
 *   `premature close` at ERROR with the request id — 7 of the 10 error-level lines in the log ring
 *   on 2026-09-23, none of them a server fault. Demoted, not dropped: still there at debug.
 */

const PREMATURE = 'premature close';

/** True for the end-of-stream "premature close" a client disconnect produces. */
export function isClientHangup(args: readonly unknown[]): boolean {
  for (const a of args) {
    if (typeof a === 'string' && a === PREMATURE) return true;
    if (a && typeof a === 'object') {
      const o = a as { message?: unknown; err?: { message?: unknown } };
      if (o.message === PREMATURE || o.err?.message === PREMATURE) return true;
    }
  }
  return false;
}

type LogFn = (...a: unknown[]) => void;

export function logMethodHook(this: { debug: LogFn }, args: unknown[], method: LogFn, level: number): void {
  for (const a of args) {
    if (typeof a === 'string' && a.includes('stream closed prematurely')) return;
  }
  if (level >= 50 && isClientHangup(args)) {
    this.debug(...args);
    return;
  }
  method.apply(this, args as never);
}

/**
 * v1.187.10 (log review 10-03, C32) — the panel's Fastify server options, extracted so a test
 * builds the server exactly as index.ts does.
 *
 * Per-request logging stays OFF (v0.15.18: 'incoming request' + 'request completed' were 78 % of
 * journald volume). Fastify 5.12 deprecates the top-level `disableRequestLogging` option
 * (FSTDEP023, one non-JSON warning line per boot) and fastify@6 removes it; the supported form is a
 * LogController constructed with it. The onResponse hook in index.ts still logs 5xx at warn, 4xx
 * at debug and slow requests at info.
 */
export function panelFastifyOptions(level: string, stream?: { write(msg: string): void }) {
  return {
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level,
      // v1.184.0 — also demotes a client hang-up ("premature close") to debug.
      hooks: { logMethod: logMethodHook as never },
      ...(stream ? { stream } : {}),
    },
  };
}
