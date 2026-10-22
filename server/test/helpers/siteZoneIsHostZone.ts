/**
 * v1.191.0 (lane A) — import this FIRST in a test whose fixtures are written on the HOST clock
 * (`new Date(y, m, d, h)`, `setHours`, `getHours()` expectations).
 *
 * The code computes every local hour and date in the site zone (src/siteTime.ts), resolved once when
 * siteTime.ts loads: SITE_TIMEZONE, then TZ, then America/Phoenix. CI runners are UTC with TZ unset, so
 * there the site zone (America/Phoenix) and the host clock (UTC) differ, while on a developer machine
 * they usually agree. A test written against the host clock sets the site zone to the host's zone
 * before any module loads, so it keeps testing what it was written to test (plan 2.4: "a test that
 * implicitly relied on the runner's clock sets SITE_TIMEZONE; the code is not changed to suit it").
 * The site/host distinction itself is tested in siteTime.test.ts.
 */
process.env.SITE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export {};
