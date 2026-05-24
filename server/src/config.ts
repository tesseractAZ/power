import 'dotenv/config';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  accessKey: need('ECOFLOW_ACCESS_KEY'),
  secretKey: need('ECOFLOW_SECRET_KEY'),
  apiHost: process.env.ECOFLOW_API_HOST ?? 'https://api-a.ecoflow.com',
  port: Number(process.env.PORT ?? 8787),
  // `::` makes Fastify listen dual-stack (IPv4 + IPv6 on one socket; Node
  // does NOT set IPV6_V6ONLY). `0.0.0.0` is IPv4 only — clients that resolve
  // a hostname to its IPv6 address (which macOS does by default for `.local`)
  // hit the host's IPv6 stack with no listener and the connection is RST'd.
  // Same fix as v0.3.1 applied to the telnet bind.
  host: process.env.HOST ?? '::',
  dbPath: process.env.DB_PATH ?? '../data/ecoflow.db',
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
