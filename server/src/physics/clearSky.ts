/**
 * v0.9.27 — Clear-sky PV physical model.
 *
 * Track C (physics-informed hybrid). Computes the **theoretical maximum
 * PV output** for a given site + time of day assuming a cloudless sky.
 * Combined with cell-temperature derating, this gives us the "what
 * SHOULD be possible right now" baseline that our Bayesian learner +
 * forecast can score themselves against.
 *
 * Pipeline:
 *
 *   1. **Solar position** (Spencer 1971) — declination + equation of
 *      time → solar elevation angle from site latitude + UTC datetime
 *   2. **Clear-sky GHI** (Haurwitz model — simple, fast, ±10% in
 *      practice) — function of cosine(zenith angle) only
 *   3. **POA irradiance** — project GHI onto the panel plane. For a
 *      roof-mounted array we approximate as horizontal (Eric's array is
 *      ~30° but the difference is small near solar noon)
 *   4. **Cell temperature** — NOCT-based estimator (T_cell = T_amb +
 *      (NOCT - 20)/800 × G) with ambient from weather
 *   5. **Pmax** — η × A × G_poa × (1 - α(T_cell - 25))
 *      where α = -0.0035/°C for crystalline silicon (typical)
 *
 * Eric's array:
 *   - 42 panels × 400 W = 16.8 kWp nameplate
 *   - Phoenix, AZ (lat 33.4484, lon -112.074)
 *   - Mounted ~30° tilt south-ish (typical for the latitude)
 *
 * The OUTPUT of this module is interpretable: "at this exact moment,
 * physics says we should be making 14.2 kW given the array's nameplate;
 * we're making 12.8, so 90% of physics-max." That's a much better
 * signal than "we're making 12.8 kW today" because it's normalized
 * against everything that could change (time of day, season, weather).
 */

/** Site & array constants for Eric's plant. Override at call site if
 *  you ever ship this to someone else. */
export interface SiteParams {
  lat: number;
  lon: number;
  /** Array nameplate power in W. */
  pNamplate: number;
  /** Array tilt from horizontal, degrees. 0 = flat, 90 = vertical. */
  tilt: number;
  /** Azimuth (degrees from north, clockwise). 180 = due south. */
  azimuth: number;
  /** NOCT — Nominal Operating Cell Temperature, °C. Typical silicon: 45-48°C. */
  noct: number;
  /** Temperature coefficient of Pmax, /°C. Crystalline silicon: -0.0035. */
  tempCoeff: number;
  /** System derate — wiring + inverter + soiling-clean baseline. 0..1. */
  derate: number;
}

export const PHOENIX_SITE: SiteParams = {
  lat: 33.4484,
  lon: -112.074,
  pNamplate: 16_800,  // 42 × 400 W
  tilt: 25,           // roof mount, approximate
  azimuth: 180,
  noct: 45,
  tempCoeff: -0.0035,
  derate: 0.85,
};

const DEG = Math.PI / 180;

/* ─── solar position (Spencer 1971) ──────────────────────────────── */

/** Returns the day-of-year (1-366) for a given Date in UTC. */
function doy(d: Date): number {
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
  const diff = d.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000);
}

/** Equation of time (minutes). Spencer 1971 Fourier series. */
function equationOfTime(d: Date): number {
  const B = (2 * Math.PI * (doy(d) - 1)) / 365;
  return 229.18 * (
    0.000075 +
    0.001868 * Math.cos(B) -
    0.032077 * Math.sin(B) -
    0.014615 * Math.cos(2 * B) -
    0.040849 * Math.sin(2 * B)
  );
}

/** Solar declination (degrees). */
function declination(d: Date): number {
  const B = (2 * Math.PI * (doy(d) - 1)) / 365;
  return (180 / Math.PI) * (
    0.006918 -
    0.399912 * Math.cos(B) +
    0.070257 * Math.sin(B) -
    0.006758 * Math.cos(2 * B) +
    0.000907 * Math.sin(2 * B) -
    0.002697 * Math.cos(3 * B) +
    0.001480 * Math.sin(3 * B)
  );
}

/** Solar hour angle (degrees). Negative before noon, positive after. */
function hourAngle(d: Date, lon: number): number {
  // True solar time = UTC time + 4 × lon (deg west of Greenwich is negative)
  //                  + equation of time correction (minutes)
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const tst = utcMin + 4 * lon + equationOfTime(d);
  return (tst / 4) - 180;   // degrees
}

export interface SolarPosition {
  elevation: number;       // degrees above horizon (negative = below)
  azimuth: number;         // degrees from north, clockwise
  cosZenith: number;       // 0..1 (or 0 if sun below horizon)
}

/** Solar position from site lat/lon + UTC time. */
export function solarPosition(d: Date, lat: number, lon: number): SolarPosition {
  const dec = declination(d) * DEG;
  const lat_ = lat * DEG;
  const ha = hourAngle(d, lon) * DEG;
  // Zenith angle: cos(z) = sin(lat)sin(dec) + cos(lat)cos(dec)cos(ha)
  const cosZ = Math.sin(lat_) * Math.sin(dec) +
               Math.cos(lat_) * Math.cos(dec) * Math.cos(ha);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const elevation = 90 - (zenith / DEG);
  // Azimuth (from north, clockwise) via standard formula
  const sinA = -Math.sin(ha) * Math.cos(dec) / Math.sin(zenith);
  const cosA = (Math.sin(dec) - Math.sin(lat_) * cosZ) /
               (Math.cos(lat_) * Math.sin(zenith));
  let az = Math.atan2(sinA, cosA) / DEG;
  if (az < 0) az += 360;
  return {
    elevation,
    azimuth: az,
    cosZenith: cosZ > 0 ? cosZ : 0,
  };
}

/* ─── clear-sky GHI (Haurwitz) ────────────────────────────────────── */

/**
 * Haurwitz clear-sky GHI model. Simple cosine-of-zenith × exponential
 * extinction. W/m², 0 at night. ±10% of more sophisticated models in
 * practice — fine for our scoring use case.
 */
export function clearSkyGHI(cosZenith: number): number {
  if (cosZenith <= 0) return 0;
  return 1098 * cosZenith * Math.exp(-0.057 / cosZenith);
}

/* ─── POA irradiance (simplified) ─────────────────────────────────── */

/**
 * Plane-of-array irradiance — what actually hits the tilted panels.
 * We use the isotropic-sky model approximation: GPOA ≈ GHI × cos(theta)/
 * cos(zenith), where theta is the angle between the panel normal and
 * the sun. For Eric's setup near solar noon, this is within a few %
 * of treating the array as horizontal — so for the noon-peak score
 * computation we can simplify substantially.
 */
export function plantOfArrayIrradiance(
  ghi: number,
  solarElevation: number,
  solarAzimuth: number,
  panelTilt: number,
  panelAzimuth: number,
): number {
  if (ghi <= 0 || solarElevation <= 0) return 0;
  const elev = solarElevation * DEG;
  const sunAz = solarAzimuth * DEG;
  const panelTiltR = panelTilt * DEG;
  const panelAzR = panelAzimuth * DEG;
  // cos(angle of incidence) on tilted panel
  const cosTheta = Math.sin(elev) * Math.cos(panelTiltR) +
                   Math.cos(elev) * Math.sin(panelTiltR) * Math.cos(sunAz - panelAzR);
  if (cosTheta <= 0) return 0;
  const cosZ = Math.sin(elev);
  if (cosZ < 0.05) return 0; // horizon clipping
  return ghi * (cosTheta / cosZ);
}

/* ─── cell temperature + Pmax ─────────────────────────────────────── */

/** Estimate cell temperature from POA irradiance + ambient. */
export function cellTemp(ambientC: number, poaIrradiance: number, noct: number): number {
  // NOCT formula: T_cell = T_amb + (NOCT - 20)/800 × G
  return ambientC + ((noct - 20) / 800) * poaIrradiance;
}

/** Compute theoretical Pmax (W) at the given moment. */
export interface PhysicsPmaxResult {
  ts: number;
  pMaxW: number;
  poaIrradiance: number;
  ghi: number;
  cellTempC: number;
  solarElevation: number;
  notes: string;
}

export function physicsPmax(
  ts: number,
  ambientC: number,
  site: SiteParams = PHOENIX_SITE,
): PhysicsPmaxResult {
  const d = new Date(ts);
  const sp = solarPosition(d, site.lat, site.lon);
  const ghi = clearSkyGHI(sp.cosZenith);
  const poa = plantOfArrayIrradiance(ghi, sp.elevation, sp.azimuth, site.tilt, site.azimuth);
  const tC = cellTemp(ambientC, poa, site.noct);
  // P = nameplate × derate × (POA / 1000) × (1 + α × (T_cell - 25))
  // (POA normalized to STC irradiance of 1000 W/m²)
  const tempFactor = 1 + site.tempCoeff * (tC - 25);
  const pMaxW = Math.max(0, site.pNamplate * site.derate * (poa / 1000) * tempFactor);
  return {
    ts,
    pMaxW,
    poaIrradiance: poa,
    ghi,
    cellTempC: tC,
    solarElevation: sp.elevation,
    notes: sp.elevation <= 0 ? 'night' : poa <= 0 ? 'sun-not-on-panel' : 'clear-sky',
  };
}

/**
 * Physics-vs-realized score: how much of theoretical-max are we actually
 * producing? 100% = clear sky, no soiling, no shade. <100% means cloud
 * cover, dust, dirt, or shade. The Bayesian/cloud-aware forecast SHOULD
 * predict around this realized fraction; if it doesn't, the forecast is
 * mis-tuned.
 */
export function physicsScore(realizedW: number, theoreticalW: number): number | null {
  if (theoreticalW <= 0) return null;
  return Math.max(0, Math.min(1, realizedW / theoreticalW));
}
