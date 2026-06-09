/**
 * loadShedRegistry.ts — the operator-defined ALLOWLIST of loads the advisor may
 * ever recommend shedding.
 *
 * Safety posture (per the design review): this is an allowlist, not a blocklist.
 * The ONLY loads that can appear in a shed recommendation are the ones the
 * operator explicitly enumerated here. An empty list (the default) means the
 * advisor recommends nothing — the safe baseline. NEVER_SHED_KEYWORDS is used
 * solely to emit a startup WARNING flagging a suspicious allowlist entry for the
 * operator to confirm; it is NEVER a runtime gate (a keyword blocklist fails
 * open — one mislabeled `switch.garage_outlet` powering a CPAP would slip
 * through). The allowlist is the gate.
 *
 * Config format (LOAD_SHEDDING_SHED_ENTITIES env or /data add-on option):
 *   comma-separated entries of  entity_id:priority:label:estimated_watts[:shp2_ch]
 *   e.g.  switch.pool_pump:2:Pool pump:400:5,switch.irrigation:1:Irrigation:200
 *   priority: 1 = shed first (least important). shp2_ch: optional SHP2 circuit
 *   number to read authoritative measured watts from.
 */

export interface ShedCandidate {
  entityId: string;
  /** 1 = shed first (least important). */
  priority: number;
  label: string;
  /** Operator's fallback watt estimate when no measured value is available. */
  estimatedWatts: number;
  /** Optional SHP2 circuit number for authoritative measured watts. */
  shp2Ch: number | null;
  /** Non-null when the entity matched a protected keyword (advisory warning only). */
  flaggedKeyword: string | null;
}

/** Substring markers for loads that are dangerous to shed. WARNING-only — see file header. */
export const NEVER_SHED_KEYWORDS = [
  'well_pump', 'well pump', 'sump', 'medical', 'cpap', 'oxygen', 'ventilat',
  'security', 'alarm', 'camera', 'fridge', 'refriger', 'freezer',
  'network', 'router', 'modem', 'nas', 'server', 'furnace', 'heat_pump_aux',
];

function toInt(s: string | undefined, fallback: number): number {
  const n = Number((s ?? '').trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function toNum(s: string | undefined, fallback: number): number {
  const n = Number((s ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Pure parser for the allowlist string — the testable core. Skips malformed
 * entries (an entity_id must look like `domain.object`). Returns candidates
 * sorted shed-first (priority ascending, then higher estimated watts first so a
 * single high-draw circuit is preferred over several small ones within a tier).
 */
export function parseShedCandidates(raw: string | undefined | null): ShedCandidate[] {
  if (!raw) return [];
  const out: ShedCandidate[] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const seg = part.split(':');
    const entityId = (seg[0] ?? '').trim();
    if (!entityId.includes('.')) continue; // must be domain.object
    const priority = Math.max(1, toInt(seg[1], 1));
    const label = (seg[2] ?? '').trim() || entityId;
    const estimatedWatts = Math.max(0, toNum(seg[3], 0));
    const chRaw = (seg[4] ?? '').trim();
    const shp2Ch = chRaw !== '' && Number.isFinite(Number(chRaw)) ? Math.trunc(Number(chRaw)) : null;
    const hay = `${entityId} ${label}`.toLowerCase();
    const flaggedKeyword = NEVER_SHED_KEYWORDS.find((k) => hay.includes(k)) ?? null;
    out.push({ entityId, priority, label, estimatedWatts, shp2Ch, flaggedKeyword });
  }
  return out.sort((a, b) => a.priority - b.priority || b.estimatedWatts - a.estimatedWatts);
}

let candidates: ShedCandidate[] | null = null;

export function getShedCandidates(): ShedCandidate[] {
  if (candidates == null) {
    candidates = parseShedCandidates(process.env.LOAD_SHEDDING_SHED_ENTITIES);
  }
  return candidates;
}

/** Initialize once at boot, emitting the protected-keyword warnings. */
export function initShedRegistry(log: (m: string) => void): ShedCandidate[] {
  const c = getShedCandidates();
  for (const x of c) {
    if (x.flaggedKeyword) {
      log(
        `load-shed: WARNING — allowlisted entity "${x.entityId}" (${x.label}) matches protected ` +
          `keyword "${x.flaggedKeyword}". It will appear in shed RECOMMENDATIONS (advisory only — ` +
          `nothing is actuated). Confirm this load is genuinely safe to shed before wiring it to an ` +
          `automation.`,
      );
    }
  }
  log(`load-shed: registry loaded ${c.length} sheddable candidate(s)`);
  return c;
}

/** Test/reset hook. */
export function __resetShedRegistry(): void {
  candidates = null;
}
