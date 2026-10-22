/**
 * siteDefaults.ts — the placeholder site coordinates, the FORECAST_LAT / FORECAST_LON shipped
 * defaults (a city centroid, not a residence). The one copy of the literal in the server.
 *
 * v1.191.0 (S3c, lane C) — a leaf module with no imports and no side effects, so the physics
 * (physics/clearSky.ts) and the energy bridge (energyBridge.ts) can name the placeholder without
 * importing config.ts: config.ts reads the environment when it is first imported, and test helpers
 * import those two modules statically, before the environment their app imports read is set.
 * config.ts re-exports both names.
 */
export const DEFAULT_SITE_LAT = 33.4484;
export const DEFAULT_SITE_LON = -112.074;
