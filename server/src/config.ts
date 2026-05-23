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
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH ?? '../data/ecoflow.db',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Location for solar weather forecasting (defaults to Phoenix, AZ).
  forecastLat: Number(process.env.FORECAST_LAT ?? 33.4484),
  forecastLon: Number(process.env.FORECAST_LON ?? -112.074),
  // Telnet control-room TUI — a menu-driven terminal view of the whole fleet.
  telnet: {
    enabled: process.env.TELNET_ENABLED !== '0',
    host: process.env.TELNET_HOST ?? '0.0.0.0',
    port: Number(process.env.TELNET_PORT ?? 2323),
  },
};
