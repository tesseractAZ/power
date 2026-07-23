import { request } from 'undici';

/* ═══════════════════════════════════════════════════════════════════════════
 * heartbeat.ts — out-of-band dead-man's switch (v1.43.0).
 *
 * Every alarm channel this panel owns — MQTT sensors, HA notifications, the
 * audible broadcast path — lives INSIDE the failure domain it reports on: if
 * the host dies, the container is OOM-killed, the kernel wedges, or the house
 * loses power, they all go quiet with no one to say so. The dead-man
 * inversion fixes that: the panel GETs an operator-configured heartbeat
 * receiver (healthchecks.io-style URL) on an interval, and when the pings
 * STOP, the EXTERNAL service notifies the operator from outside the failure
 * domain. This is the only alarm channel that survives total host failure.
 *
 * Design:
 *  - Only ever sends GET requests to the one configured URL; with no URL
 *    configured the module is fully inert — zero timers, zero sends.
 *  - The URL is a capability token (anyone who knows it can mark the check
 *    healthy), so it is secret-equivalent: it never appears in any log line —
 *    at most its host does. Error MESSAGES are equally off-limits (undici
 *    embeds the origin in them); only the error CLASS is logged.
 *  - A delivery failure is LOCAL information only. Internet-down ≠ host-down,
 *    and the external service's own grace period makes the dead-man decision —
 *    so failures raise no alert here; they are exposed via heartbeatStatus()
 *    for /api/health and nothing else.
 *  - State-transition logging only (log diet): one line when delivery starts
 *    failing, one when it is restored; repeats in the same state log nothing.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Total per-send budget. AbortSignal.timeout covers DNS + connect + TLS +
 *  headers + body in ONE bound, so a wedged socket cannot stall the chain
 *  (undici's default would wait ~5 min). */
export const HEARTBEAT_SEND_TIMEOUT_MS = 10_000;

/** Ping cadence: HEARTBEAT_INTERVAL_S, default 300 s, clamped to 60..3600 s.
 *  Clamped rather than rejected-to-default — an operator asking for 10 s wants
 *  fast, not silently the 5-min default. Pure + exported for tests. */
export function heartbeatIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 300_000;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 300_000;
  return Math.min(3600, Math.max(60, v)) * 1000;
}

/** Validate HEARTBEAT_URL. `url: null` + `reason: null` = unconfigured (the
 *  normal opt-out — not an error); `url: null` + reason = configured but
 *  rejected. The reason string is safe to log: it names at most the host,
 *  never the full URL. */
function parseHeartbeatUrl(raw: string | undefined): { url: string | null; reason: string | null } {
  const s = (raw ?? '').trim();
  if (s === '') return { url: null, reason: null };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { url: null, reason: 'is not a parseable URL' };
  }
  if (u.protocol !== 'https:') {
    return { url: null, reason: `must be https:// (got ${u.protocol.slice(0, -1)}, host ${u.host})` };
  }
  return { url: u.toString(), reason: null };
}

interface HeartbeatState {
  started: boolean;
  /** HEARTBEAT_URL was non-empty (even if rejected) — lets /api/health show
   *  "configured but disabled", which is a misconfiguration worth noticing. */
  urlConfigured: boolean;
  /** The validated URL, or null when unconfigured/rejected. Never exposed. */
  url: string | null;
  intervalMs: number;
  lastOkMs: number | null;
  lastErrMs: number | null;
  consecutiveFailures: number;
  /** Previous send outcome — the transition detector for the log diet.
   *  null = never sent, so a first-ever success logs nothing (there is no
   *  delivery to restore) while a first-ever failure does log. */
  lastOutcome: 'ok' | 'fail' | null;
  timer: ReturnType<typeof setTimeout> | null;
  log: (m: string) => void;
}

const fresh = (): HeartbeatState => ({
  started: false,
  urlConfigured: false,
  url: null,
  intervalMs: 300_000,
  lastOkMs: null,
  lastErrMs: null,
  consecutiveFailures: 0,
  lastOutcome: null,
  timer: null,
  log: () => {},
});

let st = fresh();

export interface HeartbeatStatus {
  enabled: boolean;
  url: boolean;                    // a URL is configured (never expose the URL itself — it is a capability token)
  lastOkMs: number | null;
  lastErrMs: number | null;
  consecutiveFailures: number;
}

export function heartbeatStatus(): HeartbeatStatus {
  return {
    enabled: st.url !== null,
    url: st.urlConfigured,
    lastOkMs: st.lastOkMs,
    lastErrMs: st.lastErrMs,
    consecutiveFailures: st.consecutiveFailures,
  };
}

/** Real sender: GET, 2xx = delivered. The body is drained (receivers answer a
 *  tiny "OK" we never read) so the socket returns to undici's pool. */
async function sendViaUndici(url: string): Promise<number> {
  const res = await request(url, {
    method: 'GET',
    signal: AbortSignal.timeout(HEARTBEAT_SEND_TIMEOUT_MS),
  });
  await res.body.dump();
  return res.statusCode;
}

/** One send + outcome bookkeeping. Never throws — a heartbeat failure must
 *  never take down the caller's timer chain. */
async function sendOnce(url: string, fetcher: (url: string) => Promise<number>): Promise<void> {
  let ok = false;
  let reason = '';
  try {
    const status = await fetcher(url);
    ok = status >= 200 && status < 300;
    // 3xx is NOT delivered: a redirect answer means the receiver never
    // registered the ping, and silently following one could leak the token.
    if (!ok) reason = `HTTP ${status}`;
  } catch (e) {
    // Class name only — undici error messages embed the origin/URL.
    reason = e instanceof Error ? e.name : typeof e;
  }
  const now = Date.now();
  if (ok) {
    if (st.consecutiveFailures > 0) {
      st.log(`heartbeat: delivery restored after ${st.consecutiveFailures} failures`);
    }
    st.lastOkMs = now;
    st.consecutiveFailures = 0;
  } else {
    if (st.lastOutcome !== 'fail') {
      st.log(`heartbeat: delivery failed (${reason}) — local signal only; the external grace period decides`);
    }
    st.lastErrMs = now;
    st.consecutiveFailures += 1;
  }
  st.lastOutcome = ok ? 'ok' : 'fail';
}

/** ±10 % jitter decorrelates this timer from the panel's other long-period
 *  timers (poll loops, digests) so sends never align into thundering herds. */
function nextDelayMs(): number {
  return Math.round(st.intervalMs * (0.9 + Math.random() * 0.2));
}

function scheduleNext(): void {
  st.timer = setTimeout(() => { void tick(); }, nextDelayMs());
  st.timer.unref();  // the heartbeat must never be what keeps the process alive
}

async function tick(): Promise<void> {
  if (st.url === null) return;  // reset mid-flight — stop the chain
  await sendOnce(st.url, sendViaUndici);
  scheduleNext();  // chain AFTER the send settles, so sends can never overlap
}

/** Idempotent; reads env once. Even when disabled the log fn is installed, so
 *  the single rejection warn (and test-hook sends) have somewhere to go. */
export function startHeartbeat(log: (m: string) => void): void {
  if (st.started) return;
  st.started = true;
  st.log = log;
  const raw = process.env.HEARTBEAT_URL;
  st.urlConfigured = (raw ?? '').trim() !== '';
  const parsed = parseHeartbeatUrl(raw);
  if (parsed.url === null) {
    // Unconfigured is the normal opt-out: fully inert AND silent (warning on
    // the default state would nag every operator who skips the feature).
    // Configured-but-rejected gets exactly ONE warn naming the reason.
    if (parsed.reason !== null) st.log(`heartbeat: disabled — HEARTBEAT_URL ${parsed.reason}`);
    return;
  }
  st.url = parsed.url;
  st.intervalMs = heartbeatIntervalMs(process.env.HEARTBEAT_INTERVAL_S);
  st.log(`heartbeat: enabled — GET to ${new URL(parsed.url).host} every ~${Math.round(st.intervalMs / 1000)} s`);
  void tick();  // immediate first send flips the external check green on boot
}

/** test-only — clear the timer and reset the holder between cases. */
export function _resetHeartbeatForTest(): void {
  if (st.timer !== null) clearTimeout(st.timer);
  st = fresh();
}

/** test-only — one send through an injected fetcher, no timers. Resolves the
 *  URL from state, falling back to env so the sender/state machine is testable
 *  without startHeartbeat() arming a live send. No-op when no valid URL exists
 *  anywhere — never sends to a fabricated one. */
export async function _sendOnceForTest(fetcher: (url: string) => Promise<number>): Promise<void> {
  const url = st.url ?? parseHeartbeatUrl(process.env.HEARTBEAT_URL).url;
  if (url === null) return;
  await sendOnce(url, fetcher);
}
