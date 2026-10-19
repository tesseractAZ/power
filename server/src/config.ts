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

/** The LAN console's resolved transport settings (SSH). */
export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Where the ed25519 host key lives; generated on first start. */
  hostKeyPath: string;
  /** One line per deprecated alias that decided a value; the call site logs each once at boot. */
  deprecationNotes: string[];
}

/** The SSH port the add-on publishes (`ports:` in config.yaml); SSH_PORT's shipped default. */
export const SSH_DEFAULT_PORT = 2323;

/**
 * The LAN console is served over SSH. `TELNET_ENABLED` / `TELNET_PORT` are kept as
 * deprecated aliases of `SSH_ENABLED` / `SSH_PORT` (an option key is never renamed or
 * nested): Home Assistant merges every option default into the saved options, so an
 * alias is "unset" when it is at its shipped default, and the TELNET_* value applies
 * while the SSH_* one is. An install that only ever set TELNET_ENABLED comes up over
 * SSH, on the same port, with no option change.
 *
 *   enabled  — either option on turns the console on (bare env with neither exported
 *              stays ON, as `TELNET_ENABLED !== '0'` did); both off ⇒ /console only.
 *   port     — SSH_PORT, except while it is at its default and TELNET_PORT is not.
 *   host     — SSH_HOST, else TELNET_HOST, else `::`.
 *   hostKey  — SSH_HOST_KEY, else /data/ssh_host_ed25519_key.
 */
export function resolveSshConfig(env: NodeJS.ProcessEnv = process.env): SshConfig {
  const deprecationNotes: string[] = [];
  const sshOn = env.SSH_ENABLED !== '0';
  const telnetOn = env.TELNET_ENABLED === '1';
  const enabled = sshOn || telnetOn;
  if (!sshOn && telnetOn) {
    deprecationNotes.push('the console is on because the deprecated TELNET_ENABLED option is on; set SSH_ENABLED instead (TELNET_ENABLED and TELNET_PORT stay as aliases)');
  }
  const sshPort = Number(env.SSH_PORT ?? SSH_DEFAULT_PORT);
  const telnetPort = env.TELNET_PORT == null || env.TELNET_PORT === '' ? null : Number(env.TELNET_PORT);
  let port = sshPort;
  if (sshPort === SSH_DEFAULT_PORT && telnetPort != null && Number.isFinite(telnetPort) && telnetPort !== SSH_DEFAULT_PORT) {
    port = telnetPort;
    deprecationNotes.push(`SSH_PORT is at its default and the deprecated TELNET_PORT is ${telnetPort}: TELNET_PORT applies; set SSH_PORT instead`);
  }
  return {
    enabled,
    host: env.SSH_HOST ?? env.TELNET_HOST ?? '::',
    port,
    hostKeyPath: env.SSH_HOST_KEY ?? '/data/ssh_host_ed25519_key',
    deprecationNotes,
  };
}

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
  // Same fix as v0.3.1 applied to the LAN console bind.
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
  // SSH control-room TUI — a menu-driven terminal view of the whole fleet; see
  // resolveSshConfig() below for the option aliases. Default host is `::` (Node
  // dual-stack — accepts both IPv4 and IPv6 on one socket; Node does NOT set
  // IPV6_V6ONLY, so IPv4 still works via mapped addresses). Listening only on
  // `0.0.0.0` would silently break clients that resolve `homeassistant.local`
  // to its IPv6 address (which macOS does by default) — they'd connect to the
  // host's IPv6 stack and get a TCP RST.
  ssh: resolveSshConfig(),
};
