#!/usr/bin/env node
/**
 * check-npm-audit.mjs — dependency vulnerability gate.
 *
 * WHY THIS EXISTS. GitHub is not alerting on this repository. `/dependabot/alerts`
 * and `/code-scanning/alerts` both return empty, consistent with GHAS being
 * unavailable on a private personal repo — the same limitation that made CodeQL a
 * self-contained CI job here rather than an alerting integration. So the only
 * security signal arriving today is a Dependabot *version* PR that happens to
 * carry a fix: that is how fastify 5.12.1 -> 5.12.3 (four GHSA advisories,
 * v1.133.2) reached this system. A vulnerable dependency that does NOT receive a
 * routine version bump would not surface at all.
 *
 * This closes that gap with a signal that does not depend on GHAS.
 *
 * POLICY, deliberately asymmetric:
 *   - PRODUCTION dependencies, high or critical  -> FAIL. Fastify serves the alarm
 *     API; a high in that tree is not a backlog item.
 *   - PRODUCTION moderate/low, and anything dev-only -> REPORT, do not fail.
 *     Dev-tree noise blocking an unrelated PR trains people to bypass the gate,
 *     which is worse than the finding.
 *
 * ESCAPE HATCH WITH AN EXPIRY. `scripts/npm-audit-allowlist.json` can waive a
 * specific advisory, but every entry MUST carry a reason and an `expires` date,
 * and an EXPIRED entry FAILS THE BUILD. An allowlist without expiry is how a
 * temporary exception becomes permanent silence — the exact failure mode this
 * codebase keeps finding elsewhere. A waiver for an advisory that is no longer
 * present is reported as stale so the file does not accumulate cruft.
 *
 * FAILS CLOSED. If `npm audit` cannot run (no lockfile, registry unreachable) this
 * exits non-zero with a message naming it as an infrastructure failure, not a
 * clean result. A check that passes when it could not run is not a check.
 *
 *   node scripts/check-npm-audit.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = join(ROOT, 'scripts', 'npm-audit-allowlist.json');
const PROJECTS = ['server', 'web'];
const FAIL_SEVERITIES = new Set(['high', 'critical']);

/** Today in ISO, injected so the expiry check is testable. */
const TODAY = process.env.NPM_AUDIT_TODAY ?? new Date().toISOString().slice(0, 10);

function loadAllowlist() {
  if (!existsSync(ALLOWLIST)) return {};
  let raw;
  try { raw = JSON.parse(readFileSync(ALLOWLIST, 'utf8')); }
  catch (e) { fail(`allowlist is not valid JSON: ${e.message}`); }
  const out = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (id.startsWith('$')) continue; // $schema / $comment
    if (!entry?.reason || !entry?.expires) {
      fail(`allowlist entry ${id} must carry both "reason" and "expires" — an undated waiver is permanent silence.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) fail(`allowlist entry ${id} has a malformed "expires" (want YYYY-MM-DD).`);
    out[id] = entry;
  }
  return out;
}

function fail(msg) { console.error(`check-npm-audit: ${msg}`); process.exit(1); }

/** Run npm audit and return its parsed report. Throws on anything unparseable. */
function audit(project, omitDev) {
  const cwd = join(ROOT, project);
  if (!existsSync(join(cwd, 'package-lock.json'))) throw new Error(`${project}: no package-lock.json`);
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
  let stdout;
  try {
    // npm audit exits non-zero WHEN VULNERABILITIES EXIST, so a throw here is not
    // itself an error — the payload on stdout is what matters.
    stdout = execFileSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    stdout = e.stdout;
    if (!stdout) throw new Error(`${project}: npm audit produced no output (${e.message})`);
  }
  let report;
  try { report = JSON.parse(stdout); }
  catch { throw new Error(`${project}: npm audit output was not JSON — treat as an infrastructure failure, not a pass`); }
  if (report.error) throw new Error(`${project}: npm audit reported ${report.error.code ?? 'an error'}: ${report.error.summary ?? ''}`);
  return report;
}

/** Advisory ids for one vulnerability entry, from its `via` chain. */
function advisoryIds(entry) {
  const ids = new Set();
  for (const v of entry.via ?? []) {
    if (typeof v === 'object' && v.url) {
      const m = /GHSA-[0-9a-z-]+/i.exec(v.url);
      if (m) ids.add(m[0]);
    }
  }
  return [...ids];
}

/**
 * The policy, isolated and pure so it can be proven to FIRE. Everything above is
 * plumbing; every judgement lives here.
 *
 * Returns 'fail' | 'waived' | 'note'.
 */
export function classify({ severity, ids, isProduction, allow, today }) {
  const sev = String(severity ?? 'unknown').toLowerCase();
  const waived = ids.filter((i) => allow[i]);
  const expired = waived.filter((i) => allow[i].expires < today);
  if (expired.length) return { verdict: 'fail', why: `waiver expired (${expired.join(', ')})` };
  if (waived.length) return { verdict: 'waived', why: waived.map((i) => `${i} until ${allow[i].expires}`).join(', ') };
  if (isProduction && FAIL_SEVERITIES.has(sev)) return { verdict: 'fail', why: `${sev} in production dependencies` };
  return { verdict: 'note', why: `${sev}${isProduction ? ' in production' : ' (dev only)'}` };
}

/**
 * Prove the gate can fire. Runs on every CI invocation BEFORE the real audit,
 * because this repository's recurring defect is a check that cannot fail and
 * therefore reads as healthy — a clean `npm audit` is indistinguishable from a
 * broken policy unless the policy is exercised against known inputs.
 */
function selfTest() {
  const allow = {
    'GHSA-live-0000-0000': { reason: 'x', expires: '2999-01-01' },
    'GHSA-dead-0000-0000': { reason: 'x', expires: '2000-01-01' },
  };
  const T = '2026-09-07';
  const cases = [
    ['critical in production blocks',      { severity: 'critical', ids: [],                        isProduction: true  }, 'fail'],
    ['high in production blocks',          { severity: 'high',     ids: [],                        isProduction: true  }, 'fail'],
    ['moderate in production only notes',  { severity: 'moderate', ids: [],                        isProduction: true  }, 'note'],
    ['low in production only notes',       { severity: 'low',      ids: [],                        isProduction: true  }, 'note'],
    ['critical in DEV only notes',         { severity: 'critical', ids: [],                        isProduction: false }, 'note'],
    ['unknown severity does not block',    { severity: undefined,  ids: [],                        isProduction: true  }, 'note'],
    ['live waiver suppresses a critical',  { severity: 'critical', ids: ['GHSA-live-0000-0000'],   isProduction: true  }, 'waived'],
    ['EXPIRED waiver blocks',              { severity: 'critical', ids: ['GHSA-dead-0000-0000'],   isProduction: true  }, 'fail'],
    ['expired waiver blocks even in dev',  { severity: 'low',      ids: ['GHSA-dead-0000-0000'],   isProduction: false }, 'fail'],
    ['expired beats live when both cited', { severity: 'high',     ids: ['GHSA-live-0000-0000', 'GHSA-dead-0000-0000'], isProduction: true }, 'fail'],
    ['unwaived id still blocks',           { severity: 'high',     ids: ['GHSA-xxxx-0000-0000'],   isProduction: true  }, 'fail'],
  ];
  let bad = 0;
  for (const [name, input, want] of cases) {
    const got = classify({ ...input, allow, today: T }).verdict;
    if (got !== want) { console.error(`  SELF-TEST FAIL: ${name} — expected ${want}, got ${got}`); bad++; }
  }
  if (bad) { console.error(`check-npm-audit: SELF-TEST FAILED (${bad}/${cases.length}) — the policy is broken; a clean audit below would mean nothing.`); process.exit(1); }
  console.log(`  self-test: ${cases.length}/${cases.length} — the gate fires on critical/high in production and on expired waivers\n`);
}

selfTest();
if (process.argv.includes('--self-test-only')) process.exit(0);

const allow = loadAllowlist();
const seenIds = new Set();
let blocking = 0;
let reported = 0;

for (const project of PROJECTS) {
  for (const omitDev of [true, false]) {
    const scope = omitDev ? 'production' : 'all (incl. dev)';
    let report;
    try { report = audit(project, omitDev); }
    catch (e) { fail(`${e.message}\n  This is an INFRASTRUCTURE failure, not a clean audit. Failing closed.`); }

    const vulns = Object.entries(report.vulnerabilities ?? {});
    if (vulns.length === 0) { console.log(`  ok    ${project} [${scope}] — no advisories`); continue; }

    for (const [name, entry] of vulns) {
      const sev = String(entry.severity ?? 'unknown').toLowerCase();
      const ids = advisoryIds(entry);
      ids.forEach((i) => seenIds.add(i));

      const fixable = entry.fixAvailable ? 'fix available' : 'NO FIX AVAILABLE';
      const { verdict, why } = classify({ severity: sev, ids, isProduction: omitDev, allow, today: TODAY });
      const tail = `${name} ${sev} (${fixable}) ${ids.join(' ') || '(no GHSA id in report)'} — ${why}`;
      if (verdict === 'fail') { blocking++; console.error(`  FAIL  ${project} [${scope}] ${tail}`); }
      else if (verdict === 'waived') { console.log(`  waived ${project} [${scope}] ${tail}`); }
      else { reported++; console.log(`  note  ${project} [${scope}] ${tail}`); }
    }
  }
}

const stale = Object.keys(allow).filter((id) => !seenIds.has(id));
if (stale.length) {
  console.log(`\n  stale waivers (advisory no longer present — remove from the allowlist): ${stale.join(', ')}`);
}

console.log('');
if (blocking > 0) {
  console.error(`check-npm-audit: FAILED — ${blocking} blocking finding(s) in production dependencies.`);
  console.error('Fix by upgrading, or add a DATED waiver to scripts/npm-audit-allowlist.json with a reason.');
  process.exit(1);
}
console.log(`check-npm-audit: OK — no blocking production advisories${reported ? ` (${reported} non-blocking note(s))` : ''}.`);
