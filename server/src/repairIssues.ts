import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection, DpuProjection } from './ecoflow/project.js';
import type { Alert } from './alerts.js';
import type { FleetDegradation, SoilingDecomposition, EquipmentHealth, ForecastSkillReport } from './analytics.js';
import { SPARE_DPU_SNS } from './shp2Membership.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

/**
 * Actionable maintenance items surfaced as repair issues.
 *
 * HA Core's Repair UI is integration-side (Python). This module ships
 * a REST endpoint + MQTT-discoverable `binary_sensor` for each active
 * repair so users can wire them into their own HA automations or
 * surface them in Lovelace cards. Each item has a stable id, severity,
 * and a step-by-step fix.
 *
 * Repair items are a curated SUBSET of alerts — only the ones where
 * the user can physically do something. "Cell imbalance" is a sensor
 * reading; "wash the east-facing panels" is a repair.
 */

export type RepairSeverity = 'critical' | 'warning' | 'info';

export interface RepairIssue {
  id: string;                  // stable id, machine-readable
  severity: RepairSeverity;
  title: string;               // short, scannable
  summary: string;             // 1-2 sentence diagnosis
  fixSteps: string[];          // ordered, actionable
  category: 'Cleaning' | 'Connectivity' | 'Hardware' | 'Configuration' | 'Storm' | 'Battery';
  estimatedTimeMinutes: number | null;
  // When the issue first surfaced (so HA can show "active for N hours")
  firstSeenAt: number;
}

export interface RepairIssuesReport {
  generatedAt: number;
  issues: RepairIssue[];
}

// Persistent "first-seen" map so the repair issue's age survives multiple
// fetches. v0.31.0 — and now across process restarts too: previously this lived
// only in memory, so every deploy/restart reset every repair's firstSeenAt to
// "now", making "active for N hours" always read ~0 right after a restart. It's
// loaded from a small JSON sidecar at boot and rewritten whenever a brand-new id
// is first tracked. (Distinct repair ids are bounded by device × issue-type, so
// the file stays small; entries are not age-pruned because firstSeenAt is the
// start of a possibly-long-running condition.)
const FIRST_SEEN_PATH = process.env.REPAIR_FIRST_SEEN_PATH
  ?? resolve(process.cwd(), config.dbPath, '..', 'repair-first-seen.json');

function loadFirstSeen(): Array<[string, number]> {
  try {
    if (!existsSync(FIRST_SEEN_PATH)) return [];
    const obj = JSON.parse(readFileSync(FIRST_SEEN_PATH, 'utf-8'));
    if (obj && typeof obj === 'object') {
      return Object.entries(obj).filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
    }
  } catch { /* best effort — a corrupt sidecar just resets ages */ }
  return [];
}

const firstSeenById = new Map<string, number>(loadFirstSeen());

function persistFirstSeen(): void {
  try {
    mkdirSync(dirname(FIRST_SEEN_PATH), { recursive: true });
    writeFileSync(FIRST_SEEN_PATH, JSON.stringify(Object.fromEntries(firstSeenById)));
  } catch (e: any) {
    console.error(`repairIssues: first-seen persist failed: ${e?.message ?? e}`);
  }
}

// v0.10.4 — known OFFLINE BENCH SPARES (Core4, Core5) are intentionally kept
// powered down, so their EcoFlow-offline state is expected — not actionable.
// Suppress cloud-offline repair cards for these SNs to stop false-positive
// "power-cycle / reseat Ethernet" warnings.
// v0.16.4 — the spare-SN allowlist now lives in shp2Membership.ts as the single
// source of truth (shared with the connectivity-alert cloud-offline gate in alerts.ts).

// v0.76.0 — peripheral-vs-core/SHP2 classification, mirrored from alerts.ts so the
// repair card's severity matches the alert engine's for the SAME offline event.
// alerts.ts (offline branch, ~line 321) derives offline severity as:
//     spare ? 'info' : isCore || isPanel ? 'warning' : 'info'
// where  isCore  = productName includes 'delta pro ultra'  (a battery Core/DPU)
//        isPanel = productName includes 'smart home panel'  (the SHP2)
// So Cores + the SHP2 are 'warning'; every other (peripheral) unit — the Smart
// Generator, WAVE 2, EVSE, etc. — is 'info'. This is a deliberately DUPLICATED
// predicate (not an import from alerts.ts) to avoid cross-file coupling while
// alerts.ts is being edited in parallel; keep it in sync with the SOURCE OF TRUTH
// in alerts.ts. The split is product-name based, exactly as alerts.ts does it.
function isCoreOrShp2(productName: string): boolean {
  const p = productName.toLowerCase();
  return p.includes('delta pro ultra') || p.includes('smart home panel');
}

function track(id: string, now: number): number {
  let ts = firstSeenById.get(id);
  if (ts == null) {
    ts = now;
    firstSeenById.set(id, ts);
    persistFirstSeen(); // v0.31.0 — survive restarts so "active for N hours" is real
  }
  return ts;
}

export interface RepairContext {
  devices: Record<string, DeviceSnapshot>;
  alerts: Alert[];
  degradation: FleetDegradation | null;
  soiling: SoilingDecomposition | null;
  equipmentHealth: EquipmentHealth | null;
  forecastSkill: ForecastSkillReport | null;
}

export function computeRepairIssues(ctx: RepairContext): RepairIssuesReport {
  const now = Date.now();
  const out: RepairIssue[] = [];

  // Cloud-offline devices (EcoFlow Cloud says offline) — actionable as a reconnect/power-cycle.
  for (const d of Object.values(ctx.devices)) {
    if (!d.online) {
      // v0.10.4 — skip intentionally-offline bench spares (Core4, Core5).
      if (SPARE_DPU_SNS.has(d.sn)) continue;
      const id = `cloud-offline-${d.sn}`;
      // v0.76.0 — severity must match the alert engine for the SAME offline event:
      // Cores + the SHP2 are 'warning'; peripherals (Smart Generator, WAVE 2, EVSE)
      // are 'info'. Previously this was hard-coded 'warning' for every device, so a
      // peripheral got a 'warning' repair card while alerts.ts classified it 'info'
      // — same event, two severities. Source of truth: alerts.ts offline branch.
      const offlineSeverity: RepairSeverity = isCoreOrShp2(d.productName) ? 'warning' : 'info';
      out.push({
        id,
        severity: offlineSeverity,
        title: `${d.deviceName} marked offline by EcoFlow`,
        summary: `${d.deviceName} (${d.sn}) is flagged offline by EcoFlow Cloud — it has lost its cloud (enhanced) connection. If the device still shows online on your router, a network/MQTT session reconnect or a power-cycle clears it.`,
        fixSteps: [
          `Confirm ${d.deviceName} is physically powered on.`,
          `On your router, verify the device's IP is currently active.`,
          `Power-cycle the device's network connection (yank + reseat Ethernet, or toggle WiFi).`,
          `Wait ~2 minutes; the dashboard should clear the offline state automatically.`,
          `If still offline, full power-cycle the device (off ≥30 s, then on).`,
        ],
        category: 'Connectivity',
        estimatedTimeMinutes: 5,
        firstSeenAt: track(id, now),
      });
    }
  }

  // Soiling above wash threshold.
  if (ctx.soiling) {
    // v0.76.0 — align the repair-card threshold to the soiling ALERT threshold so a
    // 12–15% soiling drop no longer produces an alert with no actionable repair card.
    // Source of truth: the soiling alert in analytics.ts (~line 1498) fires at
    // `dropPct >= 12` (with cleanDays >= 6). Was 15 here — too high — leaving the
    // 12–15% band alerted-but-uncardable. Keep the `>= 6` clean-days gate aligned too.
    const SOILING_CARD_DROP_PCT = 12; // mirror analytics.ts soiling alert threshold
    const perDpu = ctx.soiling.perDevice.filter(
      (d) => d.dropPct != null && d.dropPct >= SOILING_CARD_DROP_PCT && d.cleanDays >= 6,
    );
    if (perDpu.length > 0) {
      const id = 'wash-panels';
      const worst = perDpu.reduce((b, d) => ((d.dropPct ?? 0) > (b.dropPct ?? 0) ? d : b), perDpu[0]);
      const worstDrop = worst.dropPct ?? 0;
      out.push({
        id,
        severity: worstDrop >= 22 ? 'warning' : 'info',
        title: `Wash solar panels (~${worstDrop}% output drop on ${worst.device})`,
        summary: `Per-DPU soiling decomposition shows ${perDpu.length} array(s) producing ${worstDrop}%+ less than the clean-panel baseline. Most of this loss is recoverable with a wash. Per-hour breakdown points to which direction is worst-affected.`,
        fixSteps: [
          'Plan the wash for a cool morning before peak sun.',
          'Use a soft-bristled brush + plain water (no soap, no high-pressure).',
          'Focus on the worst-affected array(s) identified in the soiling decomposition table.',
          'Re-check the panel soiling report 3-5 clear days later — drop% should recover toward 0%.',
        ],
        category: 'Cleaning',
        estimatedTimeMinutes: 60,
        firstSeenAt: track(id, now),
      });
    }
  }

  // Peer-outlier degradation packs — recommend rebalance / inspection.
  if (ctx.degradation) {
    const outliers = ctx.degradation.packs.filter((p) => p.peerOutlier);
    for (const p of outliers) {
      const id = `peer-outlier-${p.sn}-${p.packNum}`;
      out.push({
        id,
        severity: 'warning',
        title: `Pack wearing fast: Core ${p.coreNum} · Pack ${p.packNum}`,
        summary: `This pack is fading at ${(p.peerFadeRatio ?? 1).toFixed(1)}× the fleet-median rate — the fastest-wearing pack in its peer group. ${p.summary}`,
        fixSteps: [
          'Open the Core and inspect the pack for visible damage (swelling, leakage, scorch marks).',
          'Verify the pack temperature in the dashboard is within band (target < 113°F).',
          'Check thermal-event counter to see if this pack has historic overheat events that explain the fade.',
          'If the pack is under EcoFlow warranty (≤3 yrs), file a warranty claim before EOL.',
          'If out of warranty, plan replacement timing using the projected EOL date in the degradation card.',
        ],
        category: 'Battery',
        estimatedTimeMinutes: 30,
        firstSeenAt: track(id, now),
      });
    }
  }

  // MPPT efficiency drift — actionable if drift > 3 pp.
  if (ctx.equipmentHealth) {
    for (const s of ctx.equipmentHealth.mpptStrings) {
      if (s.driftPctPts != null && s.driftPctPts < -3) {
        const id = `mppt-drift-${s.sn}-${s.string}`;
        out.push({
          id,
          severity: 'info',
          title: `MPPT efficiency drift: Core ${s.coreNum} ${s.string} string`,
          summary: `This MPPT string has lost ${Math.abs(s.driftPctPts)} percentage points of conversion efficiency vs its baseline (recent ${s.recentEffPct}% vs baseline ${s.baselineEffPct}%). Could be cabling resistance creep, MPPT heat damage, or panel-side degradation.`,
          fixSteps: [
            `Inspect MC4 connectors on the ${s.string} string for corrosion or loose seating.`,
            'Check the DPU MPPT temperature — if elevated, improve ventilation around the unit.',
            'Compare per-panel watts with a clamp meter; one underperforming panel can drag the string.',
            'If drift continues, file an EcoFlow warranty inquiry on the MPPT.',
          ],
          category: 'Hardware',
          estimatedTimeMinutes: 20,
          firstSeenAt: track(id, now),
        });
      }
    }
  }

  // Forecast skill — if model bias has drifted far from 1.0, the model is mis-calibrated.
  if (ctx.forecastSkill?.biasFactor != null) {
    const bias = ctx.forecastSkill.biasFactor;
    if (Math.abs(bias - 1) > 0.25) {
      const id = 'forecast-bias';
      out.push({
        id,
        severity: 'info',
        title: `Forecast model bias drift (×${bias.toFixed(2)})`,
        summary: `The learned GHI→PV model is systematically over- or under-predicting recent days (actual ÷ predicted = ${bias.toFixed(2)}). Often resolves itself as the model accumulates more data, but worth checking if it persists.`,
        fixSteps: [
          'Let the model accumulate another 7-14 days; new history will re-train per-hour coefficients.',
          'Verify weather coordinates (FORECAST_LAT/LON) point to the actual install location.',
          'Check the recorder DB for sample gaps; missing samples make the per-hour fit noisy.',
        ],
        category: 'Configuration',
        estimatedTimeMinutes: 10,
        firstSeenAt: track(id, now),
      });
    }
  }

  // Active NWS storm — convert to repair item.
  for (const a of ctx.alerts.filter((x) => x.id.startsWith('storm-'))) {
    const id = a.id;
    out.push({
      id,
      severity: a.severity === 'critical' ? 'critical' : 'warning',
      title: a.title,
      summary: a.detail,
      fixSteps: [
        'Pre-charge the backup pool to 100% via the EcoFlow app before onset.',
        'Verify essential circuits are on the SHP2 backup-priority list.',
        'If forecast predicts grid loss, set backup-reserve floor to a higher value (e.g. 30%).',
        'Charge any portable devices (laptops, phones, flashlights) ahead of the event.',
      ],
      category: 'Storm',
      estimatedTimeMinutes: 30,
      firstSeenAt: track(id, now),
    });
  }

  // Clean up firstSeenById entries for issues no longer active.
  const currentIds = new Set(out.map((i) => i.id));
  for (const id of [...firstSeenById.keys()]) {
    if (!currentIds.has(id)) firstSeenById.delete(id);
  }

  return { generatedAt: now, issues: out };
}
