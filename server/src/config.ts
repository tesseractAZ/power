import 'dotenv/config';

/**
 * Runtime configuration. v0.9.0 refactor — secret env vars now use lazy
 * getters that throw on first ACCESS rather than at module-load time.
 * Previously `accessKey: need('ECOFLOW_ACCESS_KEY')` threw the moment
 * any file in the codebase imported `config.ts` — even tests or scripts
 * that never call the EcoFlow API. (v0.8.1's CI test gate caught this
 * the first time it ran; v0.8.2 patched it with dummy CI env vars.)
 *
 * Lazy getters fix the root cause: import-side-effect safe, validation
 * still fires loudly on first real use, no production behavior change.
 */

function lazyRequired(name: string): { get value(): string } {
  let cached: string | undefined;
  return {
    get value(): string {
      if (cached !== undefined) return cached;
      const v = process.env[name];
      if (!v) throw new Error(`Missing required env var: ${name}`);
      cached = v;
      return cached;
    },
  };
}

const _accessKey = lazyRequired('ECOFLOW_ACCESS_KEY');
const _secretKey = lazyRequired('ECOFLOW_SECRET_KEY');

export const config = {
  /** Throws on first access if ECOFLOW_ACCESS_KEY isn't set. */
  get accessKey(): string {
    return _accessKey.value;
  },
  /** Throws on first access if ECOFLOW_SECRET_KEY isn't set. */
  get secretKey(): string {
    return _secretKey.value;
  },
  apiHost: process.env.ECOFLOW_API_HOST ?? 'https://api-a.ecoflow.com',
  port: Number(process.env.PORT ?? 8787),
  // `::` makes Fastify listen dual-stack (IPv4 + IPv6 on one socket; Node
  // does NOT set IPV6_V6ONLY). `0.0.0.0` is IPv4 only — clients that resolve
  // a hostname to its IPv6 address (which macOS does by default for `.local`)
  // hit the host's IPv6 stack with no listener and the connection is RST'd.
  // Same fix as v0.3.1 applied to the telnet bind.
  host: process.env.HOST ?? '::',
  // v1.7.2 — when unset, default to an ABSOLUTE /data path inside the HA add-on
  // container (SUPERVISOR_TOKEN is always injected there) so a dropped DB_PATH
  // export can never silently redirect state writes to /app/data (cwd is
  // /app/server) — which the v1.7.2 AppArmor `deny /app/{,**} wal` rule would then
  // block, aborting startup. Outside the container (dev/tests) the relative
  // default is unchanged; every test sets DB_PATH explicitly regardless.
  dbPath: process.env.DB_PATH ?? (process.env.SUPERVISOR_TOKEN ? '/data/ecoflow.db' : '../data/ecoflow.db'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Location for solar weather forecasting (defaults to Phoenix, AZ).
  forecastLat: Number(process.env.FORECAST_LAT ?? 33.4484),
  forecastLon: Number(process.env.FORECAST_LON ?? -112.074),
  // Telnet control-room TUI — a menu-driven terminal view of the whole fleet.
  // Default host is `::` (Node dual-stack — accepts both IPv4 and IPv6 on one
  // socket; Node does NOT set IPV6_V6ONLY, so IPv4 still works via mapped
  // addresses). Listening only on `0.0.0.0` would silently break clients that
  // resolve `homeassistant.local` to its IPv6 address (which macOS does by
  // default) — they'd connect to the host's IPv6 stack and get a TCP RST.
  telnet: {
    enabled: process.env.TELNET_ENABLED !== '0',
    host: process.env.TELNET_HOST ?? '::',
    port: Number(process.env.TELNET_PORT ?? 2323),
  },
};
